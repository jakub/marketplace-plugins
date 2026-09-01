#!/usr/bin/env node
// The only thing in flow that merges a pull request from inside an agent session.
//
// This is the same shape as scripts/lint-actions.mjs: the model proposes, deterministic code
// re-derives the conditions from fresh state and decides. The session runs
// `node <flow>/scripts/land-merge.mjs <pr-number>` and that number is the whole of what this
// program takes from its caller. Everything else it needs - which host, which repository,
// which branch, which head, whether the pull request is open, whether it is a draft, what it
// targets - it reads for itself from the origin remote and from GitHub.
//
// The authorization is the human's explicit request to land this pull request plus the stage's
// own gates, and there is nothing else: no approval file, no ceremony. What this adds over a raw
// `gh pr merge` is that nothing about the merge is taken from the conversation: the facts are
// re-derived, the merge is pinned to the head that was just verified, and the outcome is
// proven by re-reading rather than inferred from an exit code.
//
// A cooperative guardrail, not a security boundary. Everything here runs as one uid. A
// determined model with a shell could ignore this program and substitute its own gh, call the
// GitHub API with the token, or curl the merge endpoint, and nothing in flow could stop it.
// What this program is for is the ordinary case and the accident: it makes the normal land
// path re-derive every fact and refuse the moment one does not match, so a merge of the wrong
// pull request, of a head nobody saw, onto a base nobody was shown, does not happen by
// mistake. `--match-head-commit` is the one check that runs on GitHub's side rather than on
// the machine asking for the merge; there is no matching flag for the base, so a retarget
// between the last re-read and the merge is an unclosable client-side race.
//
// One accepted race, stated so nobody rediscovers it: two attended sessions asked to land the
// same pull request can both exit 0. If the second session's merge call fails because the
// first already landed it, the confirming read still shows MERGED at the verified head and
// base, and this program reports success - deliberately, because a lost merge response with a
// real landed merge must read as success, and the two cases are indistinguishable from here.
// What landed is exactly the head both sessions verified, so the cost is double-claimed
// credit and an idempotent second cleanup, not a wrong merge.
//
// Hardening that keeps the ordinary path honest. Every gh call pins `--repo host/owner/repo`,
// derived from the origin remote, and the child environment has GH_REPO and GH_HOST removed, so
// a stray or injected redirect cannot point gh at a different repository than the one this
// directory works on. After the pull request is read, its url is checked against that same
// derived identity before anything else runs. If the base carries a merge queue, or the
// pull request already has auto-merge armed, the executor refuses rather than leave an armed
// future merge behind: it only ever performs an immediate squash-merge.

import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const READ_TIMEOUT_MS = 60_000
const MERGE_TIMEOUT_MS = 120_000
const GIT_TIMEOUT_MS = 5_000

const USAGE = `land-merge.mjs <pull-request-number>

Merges one pull request, once. The number is the only thing this takes from you: the host,
the repository, the branch, the head SHA, the pull request state and the merge target are all
re-read from the origin remote and GitHub, the merge is pinned to that verified head with
--match-head-commit, and the outcome is confirmed by re-reading the pull request.
`

const SHA = /^[0-9a-f]{40}$/

/** Read git output, or null when git fails. Reads are host-neutral and need no config. */
const tryGit = (args, cwd) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch { return null }
}

const parseJson = (text) => {
  if (typeof text !== 'string') return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch { return null }
}

// git@host:owner/repo, ssh://git@host/owner/repo, https://host/owner/repo - keep the host.
const identityOfRemote = (url) => {
  if (typeof url !== 'string' || url.trim() === '') return null
  const s = url.trim().replace(/\.git$/, '')
  let m = s.match(/^[^@\s]+@([^:/\s]+):([^/\s]+)\/([^/\s]+)$/)
  if (!m) m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+)$/i)
  if (!m) return null
  const [, host, owner, repo] = m
  return { host, owner, repo, slug: `${owner}/${repo}`, full: `${host}/${owner}/${repo}` }
}

// The url GitHub returns on a pull request read, e.g. https://github.com/owner/repo/pull/12.
const identityOfPrUrl = (url) => {
  const m = String(url).match(/^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/i)
  if (!m) return null
  const [, host, owner, repo] = m
  return { host, owner, repo }
}

const sameIdentity = (a, b) =>
  a != null && b != null &&
  a.host.toLowerCase() === b.host.toLowerCase() &&
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.repo.toLowerCase() === b.repo.toLowerCase()

const MERGE_QUEUE_QUERY =
  'query($owner: String!, $name: String!, $base: String!) { ' +
  'repository(owner: $owner, name: $name) { mergeQueue(branch: $base) { id } } }'

/**
 * Decide and perform the merge. Pure of process globals: it takes the argument vector, the
 * environment, the working directory and an injected gh runner, and returns a
 * { code, stdout, stderr } result instead of exiting. That is what lets the smoke drive it in
 * process with a fake gh across the module boundary, rather than selecting a binary through an
 * environment variable that a session could also set.
 *
 * @param {object} args
 * @param {string[]} args.argv the argument vector after the script name
 * @param {Record<string,string|undefined>} args.env
 * @param {string} args.cwd where the origin remote is read from
 * @param {(ghArgs: string[], timeoutMs: number) => {code: number, stdout: string, stderr: string}} args.runGh
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function landMerge({ argv, env, cwd, runGh }) {
  const refuse = (reason) => ({ code: 1, stdout: '', stderr: `land-merge: refused, ${reason}\n` })
  const ghJson = (ghArgs, timeout) => {
    const result = runGh(ghArgs, timeout)
    return result.code === 0 ? parseJson(result.stdout) : null
  }

  // Scheduled jobs run unattended, and a merge is the one thing nobody should discover after
  // the fact. An injected instruction cannot set this variable, which is the same reasoning
  // git-guard's cron mode rests on.
  if (env.FLOW_CRON_JOB) {
    return refuse(`FLOW_CRON_JOB=${env.FLOW_CRON_JOB} means nobody is watching this run, ` +
      'and a merge is not something an unattended job does')
  }

  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { code: 0, stdout: USAGE, stderr: '' }
  }
  if (argv.length !== 1) {
    return { code: 2, stdout: '', stderr: `land-merge: expected one argument, the pull request number.\n\n${USAGE}` }
  }
  const prNumber = Number(argv[0])
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { code: 2, stdout: '', stderr: `land-merge: ${JSON.stringify(argv[0])} is not a pull request number.\n\n${USAGE}` }
  }

  const identity = identityOfRemote(tryGit(['remote', 'get-url', 'origin'], cwd))
  if (identity === null) {
    return refuse('this directory has no readable origin remote, so there is no repository to merge in')
  }

  const view = ghJson(
    ['pr', 'view', String(prNumber), '--repo', identity.full,
      '--json', 'headRefOid,headRefName,state,isDraft,baseRefName,url,autoMergeRequest'],
    READ_TIMEOUT_MS,
  )
  if (view === null) return refuse(`\`gh pr view ${prNumber}\` gave no readable JSON, so the live state of the pull request is unknown`)

  // The pull request GitHub answered with must be the one the origin remote names. This is the
  // second lock on the repository, after pinning --repo: a redirect that somehow got past the
  // pin still cannot pass a url that names a different host, owner or repo.
  if (!sameIdentity(identityOfPrUrl(view.url), identity)) {
    return refuse(`the pull request GitHub returned (${JSON.stringify(view.url ?? null)}) is not ${identity.full}, so the read was redirected`)
  }

  // The facts this run binds to. Everything after this point - the pre-merge recheck, the
  // merge's --match-head-commit, and the post-merge confirmation - compares against these,
  // so any movement between the human's request and the mutation is a refusal.
  if (view.state !== 'OPEN') return refuse(`#${prNumber} is ${JSON.stringify(view.state ?? null)} on GitHub, and only an open pull request can be merged`)
  if (view.isDraft !== false) {
    return refuse(view.isDraft === true
      ? `#${prNumber} is a draft; mark it ready for review before it lands`
      : `the draft status of #${prNumber} could not be read, so it cannot be shown ready`)
  }
  const head = view.headRefOid
  if (typeof head !== 'string' || !SHA.test(head)) {
    return refuse(`the head of #${prNumber} did not read back as a 40-character lowercase SHA (found ${JSON.stringify(view.headRefOid ?? null)})`)
  }
  const base = view.baseRefName
  if (typeof base !== 'string' || base.trim() === '') return refuse(`the base branch of #${prNumber} could not be read`)

  // A base other than the default branch means the merge would land somewhere other than
  // where landed work lives - a stacked pull request, which the stage retargets first.
  const repoView = ghJson(['repo', 'view', identity.full, '--json', 'defaultBranchRef'], READ_TIMEOUT_MS)
  const defaultBranch = repoView?.defaultBranchRef?.name ?? null
  if (typeof defaultBranch !== 'string' || defaultBranch.trim() === '') {
    return refuse('the repository default branch could not be read, so the merge target cannot be checked')
  }
  if (base !== defaultBranch) {
    return refuse(`#${prNumber} targets ${JSON.stringify(base)} and the default branch is ${JSON.stringify(defaultBranch)}; land the parent first or retarget`)
  }

  // Never leave an armed future merge behind. Auto-merge already set on the pull request would
  // land it later, out of sight; a merge queue on the base means gh would enqueue rather than
  // merge now. The executor only performs an immediate squash-merge, so both are a refusal, not
  // a thing to work around.
  if (view.autoMergeRequest != null) {
    return refuse(`#${prNumber} already has auto-merge armed. The executor only performs an immediate squash-merge, ` +
      'so cancel the auto-merge first and land it here, or let the armed merge run on its own')
  }
  const queue = ghJson(
    ['api', 'graphql', '--hostname', identity.host,
      '-f', `query=${MERGE_QUEUE_QUERY}`, '-f', `owner=${identity.owner}`, '-f', `name=${identity.repo}`, '-f', `base=${base}`],
    READ_TIMEOUT_MS,
  )
  if (queue === null) {
    return refuse(`the merge-queue status of ${base} could not be read, and the executor will not merge without knowing whether a queue is required`)
  }
  if (queue?.data?.repository?.mergeQueue != null) {
    return refuse(`${identity.slug} uses a merge queue on ${base}. The executor only performs immediate squash-merges, ` +
      'so land this pull request through the queue by hand')
  }

  // One more read of the base and head, right before the merge, to shrink the retarget window.
  // It cannot close it: a retarget after this read but before GitHub acts is the unclosable
  // client-side race the header describes. A moved head here is not a race to ride out - it
  // means the pull request changed under the run, and the gates saw a different commit.
  const recheck = ghJson(['pr', 'view', String(prNumber), '--repo', identity.full, '--json', 'baseRefName,headRefOid'], READ_TIMEOUT_MS)
  if (recheck === null) return refuse('the pull request could not be re-read immediately before the merge')
  if (recheck.baseRefName !== base) {
    return refuse(`#${prNumber} was retargeted to ${JSON.stringify(recheck.baseRefName ?? null)} mid-run; it was read as targeting ${JSON.stringify(base)}`)
  }
  if (recheck.headRefOid !== head) {
    return refuse(`the head of #${prNumber} moved mid-run (read ${head.slice(0, 12)}, now ${String(recheck.headRefOid ?? '').slice(0, 12) || 'unreadable'}); re-run the gates against the new head`)
  }

  // argv, not a shell line. There is no quoting to get wrong and nothing for a later reader to
  // re-parse. --match-head-commit is GitHub's own re-check of the SHA that was just verified.
  const mergeResult = runGh(
    ['pr', 'merge', String(prNumber), '--repo', identity.full, '--squash', '--match-head-commit', head],
    MERGE_TIMEOUT_MS,
  )
  const mergeFailure = mergeResult.code !== 0
    ? String(mergeResult.stderr || mergeResult.stdout || `exit ${mergeResult.code}`).trim().split('\n')[0].slice(0, 200)
    : null

  // Always re-read, even on a nonzero exit: a lost response does not prove the merge failed. This
  // read pulls the same identity-bearing fields as the first one, because "MERGED" alone does not
  // prove we merged what was verified - a concurrent foreign merge of the same number is also
  // MERGED. An unreadable read is UNKNOWN; saying "denied" there would be a lie.
  const after = ghJson(
    ['pr', 'view', String(prNumber), '--repo', identity.full,
      '--json', 'state,headRefOid,baseRefName,url,autoMergeRequest'],
    READ_TIMEOUT_MS,
  )
  if (after === null || typeof after.state !== 'string') {
    return {
      code: 1, stdout: '',
      stderr: `land-merge: could not confirm whether #${prNumber} merged` +
        (mergeFailure ? ` (\`gh pr merge\` said: ${mergeFailure})` : '') +
        '. The merge may or may not have landed - look at the pull request before doing anything else.\n',
    }
  }

  // A MERGED pull request is our success only if it is still the merge this run verified:
  // same host-qualified repository, same head, same base. If any of those moved, someone else
  // merged this number while we were working, and claiming it as our merge would be wrong.
  if (after.state === 'MERGED') {
    const ours = sameIdentity(identityOfPrUrl(after.url), identity) &&
      after.headRefOid === head &&
      after.baseRefName === base
    if (ours) {
      return {
        code: 0,
        stdout: `land-merge: merged #${prNumber} on ${identity.full} as a squash of ${head.slice(0, 12)}\n`,
        stderr: '',
      }
    }
    return {
      code: 1, stdout: '',
      stderr: `land-merge: #${prNumber} reads back MERGED, but its repository, head or base no longer matches the ` +
        `verified merge (url ${JSON.stringify(after.url ?? null)}, head ${JSON.stringify(after.headRefOid ?? null)}, ` +
        `base ${JSON.stringify(after.baseRefName ?? null)}). Someone else may have merged this number - look at the ` +
        'pull request before doing anything else, and do not treat this as your merge.\n',
    }
  }

  // Not MERGED. A readable non-MERGED state after the merge call is not automatically a clean
  // failure: the call may have armed an auto-merge or enqueued the pull request, or its response
  // may have been lost. Re-read the arm-able state. An armed auto-merge, an armed or unreadable
  // merge queue, or any other inconsistency is UNKNOWN, because the merge may still land and a
  // blind retry would be wrong. Only a clean OPEN with nothing armed and an authoritative
  // rejection from gh is a failure.
  const verifyByHand = 'Look at the pull request before doing anything else, and do not re-run this blindly.'
  if (after.autoMergeRequest != null) {
    return {
      code: 1, stdout: '',
      stderr: `land-merge: #${prNumber} is not merged, but it now has auto-merge armed` +
        (mergeFailure ? ` (\`gh pr merge\` said: ${mergeFailure})` : '') +
        `. It may still land on its own. ${verifyByHand}\n`,
    }
  }
  const queueAfter = ghJson(
    ['api', 'graphql', '--hostname', identity.host,
      '-f', `query=${MERGE_QUEUE_QUERY}`, '-f', `owner=${identity.owner}`, '-f', `name=${identity.repo}`,
      '-f', `base=${after.baseRefName ?? base}`],
    READ_TIMEOUT_MS,
  )
  if (queueAfter === null || queueAfter?.data?.repository?.mergeQueue != null) {
    return {
      code: 1, stdout: '',
      stderr: `land-merge: #${prNumber} is not merged, and its base branch's merge-queue status is ` +
        `${queueAfter === null ? 'unreadable' : 'armed'}` +
        (mergeFailure ? ` (\`gh pr merge\` said: ${mergeFailure})` : '') +
        `. The merge may be queued to land later. ${verifyByHand}\n`,
    }
  }
  if (after.state === 'OPEN' && mergeFailure !== null) {
    return refuse(`\`gh pr merge\` failed: ${mergeFailure}`)
  }
  // Nothing armed, yet the pull request is not MERGED and gh either reported success or left it in
  // a state other than a clean OPEN. That is inconsistent, not an authoritative rejection.
  return {
    code: 1, stdout: '',
    stderr: `land-merge: could not confirm the merge of #${prNumber}: \`gh pr merge\` ` +
      (mergeFailure ? `said: ${mergeFailure}` : 'reported success') +
      `, but the pull request reads back as ${JSON.stringify(after.state)} rather than MERGED. ${verifyByHand}\n`,
  }
}

// ------------------------------------------------------------------------------- CLI entry
//
// The production runner resolves a real gh from PATH once, at startup, and remembers the
// absolute path. At same-uid this is cooperative, not tamper-proof: whoever can set PATH could
// put a different gh first, the same way they could ignore this program entirely. What the
// one-time absolute resolution buys is that a PATH change mid-run cannot swap the binary, and
// there is no env var whose only job is to select the gh this program trusts.

const resolveGh = () => {
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'gh')
    try { accessSync(candidate, constants.X_OK); return candidate } catch {}
  }
  return 'gh'
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const ghBin = resolveGh()
  const ghEnv = { ...process.env }
  delete ghEnv.GH_REPO
  delete ghEnv.GH_HOST
  const runGh = (ghArgs, timeoutMs) => {
    try {
      const stdout = execFileSync(ghBin, ghArgs, {
        encoding: 'utf8', timeout: timeoutMs, env: ghEnv, stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { code: 0, stdout: String(stdout), stderr: '' }
    } catch (error) {
      return { code: error?.status ?? 1, stdout: String(error?.stdout || ''), stderr: String(error?.stderr || error?.message || error) }
    }
  }
  const result = landMerge({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), runGh })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.code)
}
