#!/usr/bin/env node
// The only thing in flow that merges a pull request from inside an agent session.
//
// This is the same shape as scripts/lint-actions.mjs: the model proposes, deterministic code
// re-derives the conditions from fresh state and decides. The session runs
// `node <flow>/scripts/land-merge.mjs <pr-number>` and that number is the whole of what this
// program takes from its caller. Everything else it needs - which repository, which branch,
// which head, whether the pull request is open, whether it is a draft, what it targets - it
// reads for itself from the origin remote and from GitHub.
//
// The approval is a release sanction: a file the human writes with scripts/release-sanction.mjs
// in their own terminal, naming one repository, one branch, one head SHA and one pull request.
// It is claimed with rename() before anything is read out of it, so two concurrent runs cannot
// both spend it. Whoever moves the file owns the approval; the other gets ENOENT and stops.
//
// Claiming first means a failed attempt spends the approval too. That is the safe direction to
// fail: the alternative is an approval that survives being wrong. Read the denial, fix what it
// names, and ask the human for a fresh sanction.
//
// Why this exists at all. The Codex publish guard used to authorize the merge by parsing the
// merge command out of shell text and matching its flags against the sanction. That put a
// string parser on the trust boundary, and one spelling it read differently from bash was a
// merge nobody approved. Now the guard's merge classification is a coarse tripwire that denies
// and points here, and the merge runs from an argv array this file builds - no shell, no word
// splitting, no quoting to get wrong.
//
// What an allow proves is stated in lib/release-sanction.mjs. In short: the pull request looks
// exactly the way it looked when the human said yes. `--match-head-commit` then makes GitHub
// refuse the merge if the head moved between this check and the call, which is the one check
// that runs on GitHub's side rather than on the machine asking for the merge.

import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { MERGE_OPERATION_ID, releaseVerdict, sanctionPath } from '../lib/release-sanction.mjs'

// Resolved through PATH like any other tool. FLOW_GH_BIN exists so the smoke test can point
// this at a fake `gh` and assert what was actually run; it is not a production knob.
const GH = process.env.FLOW_GH_BIN || 'gh'
const READ_TIMEOUT_MS = 60_000
const MERGE_TIMEOUT_MS = 120_000

const SANCTION = sanctionPath(process.env)
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

const USAGE = `land-merge.mjs <pull-request-number>

Merges one pull request, once, against a release sanction the human wrote with
release-sanction.mjs. The number is the only thing this takes from you: the repository, the
branch, the head SHA, the pull request state and the merge target are all re-read here and
checked against the approval before anything lands.

  sanction: ${SANCTION}
`

let claim = null

/** Move the claim aside under a name nothing reads, recording how the attempt went. */
const tombstone = (verdict) => {
  if (claim === null) return
  try { renameSync(claim, join(dirname(SANCTION), `release-sanction.${verdict}.${stamp()}`)) } catch {}
  claim = null
}

/** Stop, spending the claim if one is held. Every exit after the claim goes through here. */
const refuse = (reason) => {
  tombstone('denied')
  process.stderr.write(`land-merge: refused, ${reason}\n`)
  process.exit(1)
}

const run = (bin, args, timeout) =>
  execFileSync(bin, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const tryRun = (bin, args, timeout) => {
  try { return run(bin, args, timeout) } catch { return null }
}

const parseJson = (text) => {
  if (text === null) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch { return null }
}

// Scheduled jobs run unattended, and a merge is the one thing nobody should discover after the
// fact. An injected instruction cannot set this variable, which is the same reasoning
// git-guard's cron mode rests on. Checked before the claim: an unattended job must not be able
// to burn a sanction the human wrote for their own session.
if (process.env.FLOW_CRON_JOB) {
  process.stderr.write(
    `land-merge: refused, FLOW_CRON_JOB=${process.env.FLOW_CRON_JOB} means nobody is watching this run, ` +
    'and a merge is not something an unattended job does\n',
  )
  process.exit(1)
}

// An unreadable argument never reaches the sanction, so a typo costs nothing. Everything past
// this point spends the approval, pass or fail.
const argv = process.argv.slice(2)
if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
  process.stdout.write(USAGE)
  process.exit(0)
}
if (argv.length !== 1) {
  process.stderr.write(`land-merge: expected one argument, the pull request number.\n\n${USAGE}`)
  process.exit(2)
}
const prNumber = Number(argv[0])
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  process.stderr.write(`land-merge: ${JSON.stringify(argv[0])} is not a pull request number.\n\n${USAGE}`)
  process.exit(2)
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
      `--pr ${prNumber} --op ${MERGE_OPERATION_ID}` + '` in their own terminal'
    : `the sanction could not be claimed (${String(error?.code || error?.message || error).slice(0, 80)}), ` +
      'and an approval that cannot be spent is not honored'
  process.stderr.write(`land-merge: refused, ${detail}\n`)
  process.exit(1)
}

let sanction = null
try { sanction = JSON.parse(readFileSync(claim, 'utf8')) } catch { sanction = null }

const originUrl = tryRun('git', ['remote', 'get-url', 'origin'], 5_000)
const slug = originUrl ? (originUrl.replace(/\.git$/, '').match(/[:/]([^/:]+\/[^/]+)$/)?.[1] ?? null) : null
if (slug === null) {
  refuse('this directory has no readable origin remote, so there is no repository to check the sanction against')
}

const view = parseJson(tryRun(
  GH,
  ['pr', 'view', String(prNumber), '--json', 'headRefOid,headRefName,state,isDraft,baseRefName,url'],
  READ_TIMEOUT_MS,
))
if (view === null) refuse(`\`gh pr view ${prNumber}\` gave no readable JSON, so the live state of the pull request is unknown`)

const repoView = parseJson(tryRun(GH, ['repo', 'view', slug, '--json', 'defaultBranchRef'], READ_TIMEOUT_MS))
const defaultBranch = repoView?.defaultBranchRef?.name ?? null

const verdict = releaseVerdict({
  operations: [MERGE_OPERATION_ID],
  sanction,
  pr: {
    slug,
    number: prNumber,
    branch: view.headRefName ?? null,
    head: view.headRefOid ?? null,
    state: view.state ?? null,
    isDraft: view.isDraft ?? null,
    base: view.baseRefName ?? null,
    defaultBranch,
  },
  nowMs: Date.now(),
})
if (!verdict.allowed) refuse(`${verdict.reason}. That attempt spent the sanction, so this needs a fresh one`)

// argv, not a shell line. There is no quoting to get wrong and nothing for a later reader to
// re-parse. --match-head-commit is GitHub's own re-check of the SHA that was just verified.
let mergeFailure = null
try {
  run(GH, ['pr', 'merge', String(prNumber), '--squash', '--match-head-commit', sanction.head], MERGE_TIMEOUT_MS)
} catch (error) {
  mergeFailure = String(error?.stderr || error?.message || error).trim().split('\n')[0].slice(0, 200)
}
if (mergeFailure !== null) refuse(`\`gh pr merge\` failed: ${mergeFailure}`)

const after = parseJson(tryRun(GH, ['pr', 'view', String(prNumber), '--json', 'state'], READ_TIMEOUT_MS))
if (after?.state !== 'MERGED') {
  refuse(
    `\`gh pr merge\` reported success but #${prNumber} reads back as ${JSON.stringify(after?.state ?? null)} ` +
    'rather than MERGED. The merge may still have landed - look at the pull request before doing anything else',
  )
}

tombstone('consumed')
process.stdout.write(`land-merge: merged #${prNumber} on ${slug} as a squash of ${sanction.head.slice(0, 12)}\n`)
process.exit(0)
