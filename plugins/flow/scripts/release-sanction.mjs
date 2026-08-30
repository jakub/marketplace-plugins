#!/usr/bin/env node
// The human half of flow's SHA-bound release path. You run this. The model does not, and
// its guards deny the commands that would let it try.
//
// A Codex session cannot be asked to confirm a merge from a hook, so it asks you instead:
// repository, branch, base, head SHA, and which pull request it wants to land. You look at what is
// about to ship and run `approve` here in your own terminal. The session then runs
// scripts/land-merge.mjs, which claims what you wrote, checks it against the pull request as
// GitHub reports it, and merges once if every fact still matches. Anything else, including
// the same merge after one more commit, is refused and comes back to you.
//
// Merging is all this approves. There is no --op that lets a session push to crates.io, npm,
// PyPI or RubyGems, because none of those can be taken back afterwards.
//
// Writes are atomic (temp file, then rename) and mode 0600, so a half-written sanction is
// never readable as a whole one.

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { isRegistryOperation, PUBLISH_OPERATION_IDS } from '../lib/hook-policy.mjs'
import {
  MAX_SANCTION_MS,
  MERGE_OPERATION_ID,
  SANCTIONABLE_OPERATION_IDS,
  SANCTION_SCHEMA_VERSION,
  sanctionPath,
} from '../lib/release-sanction.mjs'

const MAX_TTL_MINUTES = MAX_SANCTION_MS / 60_000

const USAGE = `flow release sanction - your approval of one specific merge.

  release-sanction.mjs approve --repo <[host/]owner/name> --branch <branch> --head <40-char sha>
                               --pr <number> --op ${MERGE_OPERATION_ID}
                               [--base <branch>] [--ttl-minutes <1-${MAX_TTL_MINUTES}>]
  release-sanction.mjs revoke

Operation ids you can approve: ${SANCTIONABLE_OPERATION_IDS.join(', ')}
--pr is required for ${MERGE_OPERATION_ID}: the approval covers one pull request, and
land-merge.mjs refuses to merge any other number with it.

Run this yourself, in your own terminal, outside the agent session. The session's publish
guard denies any command that writes the sanction file or runs this helper, because a model
that can approve its own release is not being gated at all.

The sanction file, which FLOW_STATE moves:
  ${sanctionPath(process.env)}
It is readable only by you and expires after ${MAX_TTL_MINUTES} minutes at the latest.
land-merge.mjs claims the file before it checks anything, so an attempt spends the approval
whether it passes or fails - a merge that gets refused does not leave a sanction behind, and
you approve again once you have seen why it failed.`

const die = (message) => {
  process.stderr.write(`${message}\n\n${USAGE}\n`)
  process.exit(2)
}

// Scheduled jobs run unattended, which is the one situation where nobody is looking at
// what ships. There is no approval to give, so there is nothing to write.
if (process.env.FLOW_CRON_JOB) {
  die(`refusing to write a release sanction: FLOW_CRON_JOB=${process.env.FLOW_CRON_JOB} means this is an unattended job, and a sanction is a person saying yes.`)
}

const argv = process.argv.slice(2)
const action = argv[0]
if (action === '--help' || action === '-h' || action === undefined) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(action === undefined ? 2 : 0)
}
if (action !== 'approve' && action !== 'revoke') die(`unknown action ${JSON.stringify(action)}.`)

const path = sanctionPath(process.env)

if (action === 'revoke') {
  if (argv.length > 1) die('revoke takes no options.')
  try {
    rmSync(path)
    process.stdout.write(`revoked ${path}\n`)
  } catch (error) {
    if (error?.code !== 'ENOENT') die(`could not remove ${path}: ${error?.message || error}`)
    process.stdout.write(`no sanction on file at ${path}\n`)
  }
  process.exit(0)
}

const opts = { op: [] }
for (let i = 1; i < argv.length; i += 2) {
  const flag = argv[i]
  const value = argv[i + 1]
  if (!/^--(repo|branch|base|head|pr|op|ttl-minutes)$/.test(flag)) die(`unknown or misplaced option ${JSON.stringify(flag)}.`)
  if (value === undefined || value.startsWith('--')) die(`${flag} needs a value.`)
  if (flag === '--op') opts.op.push(value)
  else opts[flag.slice(2)] = value
}

// --repo is either owner/name, which defaults the host to github.com, or host/owner/name for a
// GitHub Enterprise remote. The host is normalized to lowercase and recorded, because the
// executor matches it against the host it reads out of the origin remote: a sanction for
// github.com/acme/widget must not authorize a merge on a GHE host carrying the same slug.
const repoParts = (opts.repo || '').split('/')
if (!repoParts.every((part) => part !== '' && !/\s/.test(part)) || (repoParts.length !== 2 && repoParts.length !== 3)) {
  die('--repo must be owner/name (host defaults to github.com) or host/owner/name for a GitHub Enterprise remote.')
}
const host = repoParts.length === 3 ? repoParts[0].toLowerCase() : 'github.com'
const slug = repoParts.slice(-2).join('/')
if (!opts.branch) die('--branch is required: a sanction approves one branch.')
// The base the merge lands on. Flow lands on main across this whole system - the land stage
// switches to main and retargets stacked children onto main - so main is the default here, and
// the stage assumes main throughout. A repository that renamed its default branch is out of
// scope for this stage.
const base = opts.base || 'main'
if (!/^[0-9a-f]{40}$/.test(opts.head || '')) die('--head must be the full 40-character lowercase SHA, as `git rev-parse HEAD` prints it.')
if (opts.op.length === 0) die('at least one --op is required: a sanction approves named operations, not publication in general.')
for (const op of opts.op) {
  // Registry ids are refused before "unknown id" is, so the message is the reason rather
  // than a typo hint for a command that was never going to be approvable.
  if (isRegistryOperation(op)) {
    die(`${op} publishes to a public registry, and registry publication stays manual: nothing you write here will let a session run it. Publish it yourself once you are happy with the build.`)
  }
  if (!PUBLISH_OPERATION_IDS.includes(op)) die(`unknown operation ${JSON.stringify(op)}. Known ids: ${PUBLISH_OPERATION_IDS.join(', ')}.`)
  if (!SANCTIONABLE_OPERATION_IDS.includes(op)) die(`${op} is not a sanctionable operation. Approvable ids: ${SANCTIONABLE_OPERATION_IDS.join(', ')}.`)
}

const pr = opts.pr === undefined ? null : Number(opts.pr)
if (opts.op.includes(MERGE_OPERATION_ID)) {
  if (!Number.isInteger(pr) || pr <= 0) {
    die(`--pr <number> is required for ${MERGE_OPERATION_ID}: the approval names one pull request, and the guard refuses a merge command that targets any other.`)
  }
} else if (pr !== null) {
  die('--pr only means something for a merge.')
}

const ttl = opts['ttl-minutes'] === undefined ? MAX_TTL_MINUTES : Number(opts['ttl-minutes'])
if (!Number.isFinite(ttl) || ttl < 1 || ttl > MAX_TTL_MINUTES) die(`--ttl-minutes must be between 1 and ${MAX_TTL_MINUTES}.`)

const issued = new Date()
const sanction = {
  schema: SANCTION_SCHEMA_VERSION,
  host,
  repo: slug,
  branch: opts.branch,
  expectedBase: base,
  head: opts.head,
  operations: [...new Set(opts.op)],
  issuedAt: issued.toISOString(),
  expiresAt: new Date(issued.getTime() + ttl * 60_000).toISOString(),
}
if (pr !== null) sanction.prNumber = pr

mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
const temp = `${path}.tmp.${process.pid}`
// The mode option only applies when the temp file is created, so set it again before the
// rename: a leftover temp file from a crashed run must not hand its permissions over.
writeFileSync(temp, `${JSON.stringify(sanction, null, 2)}\n`, { mode: 0o600 })
chmodSync(temp, 0o600)
renameSync(temp, path)

process.stdout.write(
  `approved ${sanction.operations.join(', ')}${pr === null ? '' : ` of #${pr}`} on ${sanction.host}/${sanction.repo} ` +
  `${sanction.branch} onto ${sanction.expectedBase} at ${sanction.head.slice(0, 12)}\n` +
  `  sanction: ${path}\n` +
  `  expires:  ${sanction.expiresAt} (${ttl} minutes)\n` +
  '  one attempt, and only while the head still matches. A refused attempt spends it too.\n' +
  (pr === null ? '' : `  the session's command is: node <flow>/scripts/land-merge.mjs ${pr}\n`),
)
