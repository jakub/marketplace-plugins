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
// The approval is a release sanction: a file the human writes with scripts/release-sanction.mjs
// in their own terminal, naming one repository, one branch, one head SHA, one base and one pull
// request. It is claimed with rename() before anything is read out of it, so two concurrent runs
// cannot both spend it. Whoever moves the file owns the approval; the other gets ENOENT and stops.
//
// Claiming first means a failed attempt spends the approval too. That is the safe direction to
// fail: the alternative is an approval that survives being wrong. Read the denial, fix what it
// names, and ask the human for a fresh sanction.
//
// A cooperative guardrail, not a security boundary. Everything here runs as one uid. A
// determined model with a shell could ignore this program and substitute its own gh, call the
// GitHub API with the token, or curl the merge endpoint, and nothing in flow could stop it.
// What this program is for is the ordinary case and the casual injected instruction: it makes
// the normal land path re-derive every fact and refuse the moment one does not match, so a
// merge of the wrong pull request, of a head nobody saw, onto a base nobody was shown, does not
// happen by accident. `--match-head-commit` is the one check that runs on GitHub's side rather
// than on the machine asking for the merge; there is no matching flag for the base, so a
// retarget between the last re-read and the merge is an unclosable client-side race.
//
// Hardening that keeps the ordinary path honest. Every gh call pins `--repo host/owner/repo`,
// derived from the origin remote, and the child environment has GH_REPO and GH_HOST removed, so
// a stray or injected redirect cannot point gh at a different repository than the one the
// sanction covers. After the pull request is read, its url is checked against that same
// derived identity before anything is authorized. If the base carries a merge queue, or the
// pull request already has auto-merge armed, the executor refuses rather than leave an armed
// future merge behind: it only ever performs an immediate squash-merge.

import { execFileSync } from 'node:child_process'
import { accessSync, constants, readFileSync, renameSync } from 'node:fs'
import { dirname, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MERGE_OPERATION_ID, releaseVerdict, sanctionPath } from '../lib/release-sanction.mjs'

const READ_TIMEOUT_MS = 60_000
const MERGE_TIMEOUT_MS = 120_000
const GIT_TIMEOUT_MS = 5_000

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

const usageFor = (sanction) => `land-merge.mjs <pull-request-number>

Merges one pull request, once, against a release sanction the human wrote with
release-sanction.mjs. The number is the only thing this takes from you: the host, the
repository, the branch, the head SHA, the pull request state and the merge target are all
re-read here and checked against the approval before anything lands.

  sanction: ${sanction}
`

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
 * environment, the working directory, an injected gh runner and a clock, and returns a
 * { code, stdout, stderr } result instead of exiting. That is what lets the smoke drive it in
 * process with a fake gh across the module boundary, rather than selecting a binary through an
 * environment variable that a session could also set.
 *
 * @param {object} args
 * @param {string[]} args.argv the argument vector after the script name
 * @param {Record<string,string|undefined>} args.env
 * @param {string} args.cwd where the origin remote is read from
 * @param {(ghArgs: string[], timeoutMs: number) => {code: number, stdout: string, stderr: string}} args.runGh
 * @param {number} args.nowMs wall clock at verification time
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function landMerge({ argv, env, cwd, runGh, nowMs }) {
  const SANCTION = sanctionPath(env)
  const stateDir = dirname(SANCTION)
  const USAGE = usageFor(SANCTION)

  let claim = null
  const tombstone = (verdict) => {
    if (claim === null) return
    try { renameSync(claim, join(stateDir, `release-sanction.${verdict}.${stamp()}`)) } catch {}
    claim = null
  }
  const refuse = (reason, verdict = 'denied') => {
    tombstone(verdict)
    return { code: 1, stdout: '', stderr: `land-merge: refused, ${reason}\n` }
  }
  const ghJson = (ghArgs, timeout) => {
    const result = runGh(ghArgs, timeout)
    return result.code === 0 ? parseJson(result.stdout) : null
  }

  // Scheduled jobs run unattended, and a merge is the one thing nobody should discover after
  // the fact. An injected instruction cannot set this variable, which is the same reasoning
  // git-guard's cron mode rests on. Checked before the claim: an unattended job must not be
  // able to burn a sanction the human wrote for their own session.
  if (env.FLOW_CRON_JOB) {
    return {
      code: 1, stdout: '',
      stderr: `land-merge: refused, FLOW_CRON_JOB=${env.FLOW_CRON_JOB} means nobody is watching this run, ` +
        'and a merge is not something an unattended job does\n',
    }
  }

  // An unreadable argument never reaches the sanction, so a typo costs nothing. Everything past
  // the claim spends the approval, pass or fail.
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

  // The claim is the lock. Exactly one process can move a file, so exactly one run can hold the
  // approval, and it holds the only copy.
  const candidate = `${SANCTION}.claim.${process.pid}.${stamp()}`
  try {
    renameSync(SANCTION, candidate)
    claim = candidate
  } catch (error) {
    const detail = error?.code === 'ENOENT'
      ? 'no release sanction is on file, or another run claimed it first. The human writes one by running ' +
        '`node <flow>/scripts/release-sanction.mjs approve --repo <owner/name> --branch <branch> --head <sha> ' +
        `--base <branch> --pr ${prNumber} --op ${MERGE_OPERATION_ID}` + '` in their own terminal'
      : `the sanction could not be claimed (${String(error?.code || error?.message || error).slice(0, 80)}), ` +
        'and an approval that cannot be spent is not honored'
    return { code: 1, stdout: '', stderr: `land-merge: refused, ${detail}\n` }
  }

  let sanction = null
  try { sanction = JSON.parse(readFileSync(claim, 'utf8')) } catch { sanction = null }

  const identity = identityOfRemote(tryGit(['remote', 'get-url', 'origin'], cwd))
  if (identity === null) {
    return refuse('this directory has no readable origin remote, so there is no repository to check the sanction against')
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

  const repoView = ghJson(['repo', 'view', identity.full, '--json', 'defaultBranchRef'], READ_TIMEOUT_MS)
  const defaultBranch = repoView?.defaultBranchRef?.name ?? null

  const verdict = releaseVerdict({
    operations: [MERGE_OPERATION_ID],
    sanction,
    pr: {
      slug: identity.slug,
      host: identity.host,
      number: prNumber,
      branch: view.headRefName ?? null,
      head: view.headRefOid ?? null,
      state: view.state ?? null,
      isDraft: view.isDraft ?? null,
      base: view.baseRefName ?? null,
      defaultBranch,
    },
    nowMs,
  })
  if (!verdict.allowed) return refuse(`${verdict.reason}. That attempt spent the sanction, so this needs a fresh one`)

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
      '-f', `query=${MERGE_QUEUE_QUERY}`, '-f', `owner=${identity.owner}`, '-f', `name=${identity.repo}`, '-f', `base=${view.baseRefName}`],
    READ_TIMEOUT_MS,
  )
  if (queue === null) {
    return refuse(`the merge-queue status of ${view.baseRefName} could not be read, and the executor will not merge without knowing whether a queue is required`)
  }
  if (queue?.data?.repository?.mergeQueue != null) {
    return refuse(`${identity.slug} uses a merge queue on ${view.baseRefName}. The executor only performs immediate squash-merges, ` +
      'so land this pull request through the queue by hand')
  }

  // One more read of the base and head, right before the merge, to shrink the retarget window.
  // It cannot close it: a retarget after this read but before GitHub acts is the unclosable
  // client-side race the header describes.
  const recheck = ghJson(['pr', 'view', String(prNumber), '--repo', identity.full, '--json', 'baseRefName,headRefOid'], READ_TIMEOUT_MS)
  if (recheck === null) return refuse('the pull request could not be re-read immediately before the merge')
  if (recheck.baseRefName !== sanction.expectedBase) {
    return refuse(`#${prNumber} was retargeted to ${JSON.stringify(recheck.baseRefName ?? null)} after the check; the sanction approved a merge onto ${JSON.stringify(sanction.expectedBase ?? null)}`)
  }
  if (recheck.headRefOid !== sanction.head) {
    return refuse(`the head of #${prNumber} moved between the check and the merge; the sanction approved ${String(sanction.head).slice(0, 12)}`)
  }

  // argv, not a shell line. There is no quoting to get wrong and nothing for a later reader to
  // re-parse. --match-head-commit is GitHub's own re-check of the SHA that was just verified.
  const mergeResult = runGh(
    ['pr', 'merge', String(prNumber), '--repo', identity.full, '--squash', '--match-head-commit', sanction.head],
    MERGE_TIMEOUT_MS,
  )
  const mergeFailure = mergeResult.code !== 0
    ? String(mergeResult.stderr || mergeResult.stdout || `exit ${mergeResult.code}`).trim().split('\n')[0].slice(0, 200)
    : null

  // Always re-read, even on a nonzero exit: a lost response does not prove the merge failed.
  // Three terminal states come out of this read, and they are not the same claim about the
  // world. Confirmed MERGED consumes the sanction. Confirmed still-open, or any other readable
  // state, is a denial. An unreadable read is UNKNOWN - the merge may or may not have landed,
  // and saying "denied" there would be a lie.
  const after = ghJson(['pr', 'view', String(prNumber), '--repo', identity.full, '--json', 'state'], READ_TIMEOUT_MS)
  if (after === null || typeof after.state !== 'string') {
    tombstone('unknown')
    return {
      code: 1, stdout: '',
      stderr: `land-merge: could not confirm whether #${prNumber} merged` +
        (mergeFailure ? ` (\`gh pr merge\` said: ${mergeFailure})` : '') +
        '. The merge may or may not have landed - look at the pull request before doing anything else. ' +
        'The sanction is spent either way, so a fresh one is needed to try again.\n',
    }
  }
  if (after.state === 'MERGED') {
    tombstone('consumed')
    return {
      code: 0,
      stdout: `land-merge: merged #${prNumber} on ${identity.full} as a squash of ${String(sanction.head).slice(0, 12)}\n`,
      stderr: '',
    }
  }
  return refuse(
    mergeFailure !== null
      ? `\`gh pr merge\` failed: ${mergeFailure}`
      : `\`gh pr merge\` reported success but #${prNumber} reads back as ${JSON.stringify(after.state)} ` +
        'rather than MERGED. The merge may still have landed - look at the pull request before doing anything else',
  )
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
  const result = landMerge({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), runGh, nowMs: Date.now() })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.code)
}
