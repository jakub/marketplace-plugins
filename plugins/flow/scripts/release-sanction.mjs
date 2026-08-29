#!/usr/bin/env node
// The human half of flow's SHA-bound release path. You run this. The model does not, and
// its guards deny the commands that would let it try.
//
// A Codex session cannot be asked to confirm a publication from a hook, so it asks you
// instead: repository, branch, head SHA, and which operation it wants to run. You look at
// what is about to ship, run `approve` here in your own terminal, and the session's
// publish guard lets exactly that operation through, once, for the next few minutes and
// only while the head still matches. Anything else, including the same operation after one
// more commit, is denied and comes back to you.
//
// Writes are atomic (temp file, then rename) and mode 0600, so a half-written sanction is
// never readable as a whole one.

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { PUBLISH_OPERATION_IDS } from '../lib/hook-policy.mjs'
import { MAX_SANCTION_MS, SANCTION_SCHEMA_VERSION, sanctionPath } from '../lib/release-sanction.mjs'

const MAX_TTL_MINUTES = MAX_SANCTION_MS / 60_000

const USAGE = `flow release sanction - your approval of one specific publication.

  release-sanction.mjs approve --repo <owner/name> --branch <branch> --head <40-char sha>
                               --op <id> [--op <id>...] [--ttl-minutes <1-${MAX_TTL_MINUTES}>]
  release-sanction.mjs revoke

Operation ids: ${PUBLISH_OPERATION_IDS.join(', ')}

Run this yourself, in your own terminal, outside the agent session. The session's publish
guard denies any command that writes the sanction file or runs this helper, because a model
that can approve its own release is not being gated at all.

The sanction file, which FLOW_STATE moves:
  ${sanctionPath(process.env)}
It is readable only by you, expires after ${MAX_TTL_MINUTES} minutes at the latest, and is
consumed the first time the guard honors it. The guard also re-checks the head SHA at that
moment, so an approval never survives the branch moving.`

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
  if (!/^--(repo|branch|head|op|ttl-minutes)$/.test(flag)) die(`unknown or misplaced option ${JSON.stringify(flag)}.`)
  if (value === undefined || value.startsWith('--')) die(`${flag} needs a value.`)
  if (flag === '--op') opts.op.push(value)
  else opts[flag.slice(2)] = value
}

if (!/^[^\s/]+\/[^\s/]+$/.test(opts.repo || '')) die('--repo must be the owner/name slug, as `gh repo view` prints it.')
if (!opts.branch) die('--branch is required: a sanction approves one branch.')
if (!/^[0-9a-f]{40}$/.test(opts.head || '')) die('--head must be the full 40-character lowercase SHA, as `git rev-parse HEAD` prints it.')
if (opts.op.length === 0) die('at least one --op is required: a sanction approves named operations, not publication in general.')
for (const op of opts.op) {
  if (!PUBLISH_OPERATION_IDS.includes(op)) die(`unknown operation ${JSON.stringify(op)}. Known ids: ${PUBLISH_OPERATION_IDS.join(', ')}.`)
}

const ttl = opts['ttl-minutes'] === undefined ? MAX_TTL_MINUTES : Number(opts['ttl-minutes'])
if (!Number.isFinite(ttl) || ttl < 1 || ttl > MAX_TTL_MINUTES) die(`--ttl-minutes must be between 1 and ${MAX_TTL_MINUTES}.`)

const issued = new Date()
const sanction = {
  schema: SANCTION_SCHEMA_VERSION,
  repo: opts.repo,
  branch: opts.branch,
  head: opts.head,
  operations: [...new Set(opts.op)],
  issuedAt: issued.toISOString(),
  expiresAt: new Date(issued.getTime() + ttl * 60_000).toISOString(),
}

mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
const temp = `${path}.tmp.${process.pid}`
// The mode option only applies when the temp file is created, so set it again before the
// rename: a leftover temp file from a crashed run must not hand its permissions over.
writeFileSync(temp, `${JSON.stringify(sanction, null, 2)}\n`, { mode: 0o600 })
chmodSync(temp, 0o600)
renameSync(temp, path)

process.stdout.write(
  `approved ${sanction.operations.join(', ')} on ${sanction.repo} ${sanction.branch} at ${sanction.head.slice(0, 12)}\n` +
  `  sanction: ${path}\n` +
  `  expires:  ${sanction.expiresAt} (${ttl} minutes)\n` +
  '  one use, and only while the head still matches.\n',
)
