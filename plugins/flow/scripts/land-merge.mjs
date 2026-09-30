#!/usr/bin/env node
// land-merge.mjs <pr> <expected-head-sha>
//
// The only merge, on either host. The caller passes the pull request and the head its gates ran
// against, and nothing else is taken from the conversation: the repository comes from origin, and
// the pull request must read back open, not a draft, at exactly that head, based on the default
// branch, with no auto-merge armed and no merge queue on the base. Reading the head here and
// pinning to that alone would only prove the pull request held still during this run; the head
// has to be the gated one. The merge is `gh pr merge --squash --match-head-commit <head>`, so
// GitHub re-checks the head itself, and the outcome is proven by re-reading the pull request's
// url, state, head and base rather than trusted from gh's exit code.
//
// Exit 0 is a merge this run can prove, described on stdout. Exit 1 with `land-merge: refused,`
// on stderr is a clean refusal: nothing merged. Any other exit 1 is an outcome that cannot be
// proven either way (a lost response, an armed auto-merge or queue, a foreign merge of the same
// number), and a human looks before anything is retried. It refuses outright under FLOW_CRON_JOB.
// A cooperative guardrail at one uid: it makes the ordinary path re-derive every fact, and a
// retarget between the last re-read and the merge is a race no client can close.

import { fileURLToPath } from 'node:url'

import { execCapture, ghRunner, parseObject, runExecutor } from '../lib/gh-exec.mjs'
import { allowedHostsFrom, identityOfRemote, prUrlMismatch } from '../lib/remote-identity.mjs'

const SHA = /^[0-9a-f]{40}$/
const USAGE = 'usage: land-merge.mjs <pull-request-number> <expected-head-sha>\n'
const QUEUE_QUERY = 'query($owner: String!, $name: String!, $base: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: $base) { id } } }'

/**
 * Decide and merge. Returns { code, stdout, stderr } rather than exiting. `runGh(args, { timeoutMs })`
 * is injected; `env` is read for FLOW_CRON_JOB and FLOW_GH_HOSTS.
 */
export function landMerge({ argv, env, cwd, runGh }) {
  const refuse = (reason) => ({ code: 1, stdout: '', stderr: `land-merge: refused, ${reason}\n` })
  const unproven = (text) => ({ code: 1, stdout: '', stderr: `land-merge: ${text} Look at the pull request before doing anything else, and do not re-run this blindly.\n` })
  const ghJson = (args, timeoutMs) => { const r = runGh(args, { timeoutMs }); return r.code === 0 ? parseObject(r.stdout) : null }

  if (env.FLOW_CRON_JOB) return refuse(`FLOW_CRON_JOB=${env.FLOW_CRON_JOB} means nobody is watching this run, and an unattended job does not merge`)
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { code: 0, stdout: USAGE, stderr: '' }
  if (argv.length !== 2) return refuse(`expected the pull request number and the head SHA the gates ran against.\n\n${USAGE}`)
  const pr = Number(argv[0])
  if (!/^[0-9]+$/.test(argv[0]) || pr <= 0) return refuse(`${JSON.stringify(argv[0])} is not a pull request number.\n\n${USAGE}`)
  const expected = argv[1]
  if (!SHA.test(expected)) return refuse(`${JSON.stringify(expected)} is not a full 40-character lowercase commit SHA.\n\n${USAGE}`)

  const origin = execCapture('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeoutMs: 5_000 })
  const remote = identityOfRemote(origin.code === 0 ? origin.stdout.trim() : '', { purpose: 'merge in', allowedHosts: allowedHostsFrom(env) })
  if (remote.identity === undefined) return refuse(remote.refusal)
  const id = remote.identity
  const view = (fields) => ghJson(['pr', 'view', String(pr), '--repo', id.full, '--json', fields], 60_000)
  const queueOn = (base) => ghJson(['api', 'graphql', '--hostname', id.host, '-f', `query=${QUEUE_QUERY}`, '-f', `owner=${id.owner}`, '-f', `name=${id.repo}`, '-f', `base=${base}`], 60_000)

  const first = view('headRefOid,state,isDraft,baseRefName,url,autoMergeRequest')
  if (first === null) return refuse(`gh pr view ${pr} gave no readable JSON, so the live state of the pull request is unknown`)
  if (prUrlMismatch(first.url, id, pr) !== null) return refuse(`the pull request GitHub returned (${JSON.stringify(first.url ?? null)}) is not #${pr} of ${id.full}, so the read was redirected`)
  if (first.state !== 'OPEN') return refuse(`#${pr} is ${JSON.stringify(first.state ?? null)}, and only an open pull request is merged`)
  if (first.isDraft !== false) return refuse(first.isDraft === true ? `#${pr} is a draft` : `the draft status of #${pr} could not be read, so it cannot be shown ready`)
  const head = first.headRefOid
  if (!SHA.test(String(head))) return refuse(`the head of #${pr} did not read back as a 40-character SHA (found ${JSON.stringify(head ?? null)})`)
  if (head !== expected) return refuse(`head moved (expected ${expected}, GitHub reports ${head}); run the gates again against the new head and land that`)
  const base = first.baseRefName
  if (typeof base !== 'string' || base.trim() === '') return refuse(`the base branch of #${pr} could not be read`)
  const defaultBranch = ghJson(['repo', 'view', id.full, '--json', 'defaultBranchRef'], 60_000)?.defaultBranchRef?.name
  if (typeof defaultBranch !== 'string' || defaultBranch === '') return refuse('the repository default branch could not be read, so the merge target cannot be checked')
  if (base !== defaultBranch) return refuse(`#${pr} targets ${JSON.stringify(base)} and the default branch is ${JSON.stringify(defaultBranch)}; land the parent first or retarget`)
  if (first.autoMergeRequest != null) return refuse(`#${pr} already has auto-merge armed; this only performs an immediate squash-merge, so cancel it first or let it run`)
  const queue = queueOn(base)
  if (queue === null) return refuse(`the merge-queue status of ${base} could not be read, and this will not merge without knowing whether a queue is required`)
  if (queue.data?.repository?.mergeQueue != null) return refuse(`${id.slug} uses a merge queue on ${base}; land it through the queue by hand`)

  // One more read right before the merge, to shrink the retarget window it cannot close.
  const recheck = view('baseRefName,headRefOid')
  if (recheck === null) return refuse('the pull request could not be re-read immediately before the merge')
  if (recheck.baseRefName !== base) return refuse(`#${pr} was retargeted to ${JSON.stringify(recheck.baseRefName ?? null)} mid-run; it was read as targeting ${JSON.stringify(base)}`)
  if (recheck.headRefOid !== head) return refuse(`the head of #${pr} moved mid-run (read ${head.slice(0, 12)}, now ${String(recheck.headRefOid ?? '').slice(0, 12) || 'unreadable'}); re-run the gates`)

  const merge = runGh(['pr', 'merge', String(pr), '--repo', id.full, '--squash', '--match-head-commit', head], { timeoutMs: 120_000 })
  const failure = merge.code === 0 ? null : String(merge.stderr || merge.stdout || `exit ${merge.code}`).trim().split('\n')[0].slice(0, 200)
  const said = failure === null ? '' : ` (gh pr merge said: ${failure})`

  // Always re-read: a lost response does not prove the merge failed, and MERGED alone does not prove
  // this run merged what it verified, because a foreign merge of the same number is MERGED too.
  const after = view('state,headRefOid,baseRefName,url,autoMergeRequest')
  if (after === null || typeof after.state !== 'string') return unproven(`could not confirm whether #${pr} merged${said}; it may or may not have landed.`)
  if (after.state === 'MERGED') {
    if (prUrlMismatch(after.url, id, pr) === null && after.headRefOid === head && after.baseRefName === base) {
      return { code: 0, stdout: `land-merge: merged #${pr} on ${id.full} as a squash of ${head.slice(0, 12)}\n`, stderr: '' }
    }
    return unproven(`#${pr} reads back MERGED, but its url, head or base no longer match the verified merge (head ${JSON.stringify(after.headRefOid ?? null)}, base ${JSON.stringify(after.baseRefName ?? null)}); someone else may have merged it, so do not treat it as this merge.`)
  }
  // Not merged. Only a clean OPEN with nothing armed and a failure from gh is a refusal; an armed
  // auto-merge or queue may still land it, and anything else is inconsistent.
  if (after.autoMergeRequest != null) return unproven(`#${pr} is not merged, but it now has auto-merge armed${said}, so it may still land on its own.`)
  const queueAfter = queueOn(after.baseRefName ?? base)
  if (queueAfter === null || queueAfter.data?.repository?.mergeQueue != null) {
    return unproven(`#${pr} is not merged, and its base's merge-queue status is ${queueAfter === null ? 'unreadable' : 'armed'}${said}, so it may be queued to land later.`)
  }
  if (after.state === 'OPEN' && failure !== null) return refuse(`gh pr merge failed: ${failure}`)
  return unproven(`could not confirm the merge of #${pr}: gh pr merge ${failure === null ? 'reported success' : `said: ${failure}`}, but the pull request reads back ${JSON.stringify(after.state)} rather than MERGED.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runExecutor(landMerge({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), runGh: ghRunner(process.env) }))
}
