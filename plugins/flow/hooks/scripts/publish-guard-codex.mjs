#!/usr/bin/env node
// Codex publish guard. Two jobs, and they are not the same job.
//
// 1. Codex cannot turn a PreToolUse hook result into an approval prompt: as of Codex CLI
//    0.149.1 an unsupported `ask` reads as a hook failure and the command runs anyway. So
//    publication fails closed here instead of asking.
// 2. A gate with no way through means a Codex session can never land anything, so there
//    is exactly one way through, and it is narrow. A human writes a release sanction
//    outside the session with scripts/release-sanction.mjs, naming a repository, a branch,
//    a head SHA, and the pull request they approve merging. This guard re-derives those
//    facts from git at the moment of the call, hands them to lib/release-sanction.mjs, and
//    lets exactly that merge past exactly once. This is the cron pattern: the model
//    proposes, deterministic code re-derives the conditions and decides.
//
// Publishing to a public registry is not on that path at all. crates.io, npm, PyPI and
// RubyGems have no real undo, so they stay a command the human types themselves, and a
// sanction file that claims to cover one is refused rather than honored.
//
// Trust posture, stated plainly rather than implied. Everything here runs as one uid, so a
// model with a shell can in principle produce the sanction file through some path this
// guard does not pattern-match. The commands that obviously write it are denied, the file
// is protected from the editor tools, and the sanction is spent on use, which is a
// guardrail against the unattended mistake and the injected instruction. It is not a
// sandbox, and a credential-owning service on a single-uid homelab would be theater.
//
// Two limits worth knowing before you trust a pass. The facts come from the session's cwd,
// so a publication command that changes directory first is still checked against the
// session's repository - the sanction's repo binding is as good as the session being in the
// repository it names. And equality is checked against the head as it stands now, not
// against the head's history.
//
// Ordinary work must not notice this file. Commands that publish nothing take one regex
// pass and no git calls; only a publication command pays for the four git reads.

import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { publishOperationsStrict, registryReason } from '../../lib/hook-policy.mjs'
import { releaseVerdict, sanctionPath } from '../../lib/release-sanction.mjs'
import { preToolDeny } from './wire.mjs'

const REGISTRY_TAIL =
  'Codex PreToolUse hooks cannot request confirmation, so direct publication is blocked. ' +
  'Run the publish command yourself after reviewing the version and package contents.'
const REGISTRY_MANUAL =
  'A release sanction does not cover this and never will: registry publication stays manual. ' +
  'Ask the human to run it in their own terminal.'
const MERGE_HEADLINE =
  'This merges a pull request on GitHub, which moves the branch everyone else builds on. ' +
  'Confirm the head SHA and the merge method are what you mean to land.'
const MERGE_TAIL =
  'Codex PreToolUse hooks cannot request confirmation, so the merge is blocked here. ' +
  'Land it yourself, or ask for a release sanction covering this exact head.'

const SANCTION = sanctionPath(process.env)
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

// The model may not write its own approval. These are the spellings that would do it
// through a shell: touching the sanction file by resolved path or by name, and running
// the approval helper. Deliberately narrow around the helper - it matches the helper's
// own verbs, so `git add plugins/flow/scripts/release-sanction.mjs` stays ordinary work.
const selfApproval = (command) => {
  if (command.includes(SANCTION)) return `it writes or reads ${SANCTION} directly`
  if (/\brelease-sanction\.json\b/.test(command)) return 'it names the release sanction file'
  if (/release-sanction\.mjs\b[^;&|]*\b(?:approve|revoke)\b/.test(command)) return 'it runs the release sanction helper'
  return null
}

// The four facts a sanction is checked against, read from the session's repository. Every
// git read is bounded twice over. This hook runs before each Bash call, so one hung git
// would stall the session; and hooks.json gives the whole hook 10 seconds, after which a
// timed-out hook is a hook that decided nothing. Four reads at two seconds fit inside that
// with room to spare, and a git that cannot answer in two seconds returns null, which denies.
const repoFacts = (cwd) => {
  const git = (...args) => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch {
      return null
    }
  }
  const originUrl = git('remote', 'get-url', 'origin')
  const status = git('status', '--porcelain')
  return {
    slug: originUrl ? (originUrl.replace(/\.git$/, '').match(/[:/]([^/:]+\/[^/]+)$/)?.[1] ?? null) : null,
    branch: git('symbolic-ref', '--quiet', '--short', 'HEAD'),
    head: git('rev-parse', 'HEAD'),
    dirty: status === null ? null : status !== '',
  }
}

/**
 * Claim the sanction, then check it. The obvious order is the wrong one: verify first and
 * rename afterwards, and two Bash calls can read the same file, both pass, and both be
 * allowed before either rename lands. Renaming first makes the rename the lock, because
 * exactly one process can move a file. Whoever gets it holds the only copy and checks that
 * copy; everyone else is denied on the spot.
 *
 * The cost is that a claim is spent whatever the verdict says. A merge that fails a
 * predicate does not put the approval back, and the human writes a fresh one. That is the
 * safe direction to fail: the alternative is an approval that survives being wrong.
 */
const spendSanction = ({ command, operations, cwd }) => {
  const claim = `${SANCTION}.claim.${process.pid}.${stamp()}`
  try {
    renameSync(SANCTION, claim)
  } catch (error) {
    return error?.code === 'ENOENT'
      ? 'no release sanction is on file (the human writes one with scripts/release-sanction.mjs), or another command claimed it first'
      : `the sanction could not be claimed (${String(error?.code || error?.message || error).slice(0, 80)}), and an approval that cannot be spent is not honored`
  }

  const tombstone = (verdict) => {
    // Bookkeeping, not enforcement: the claim path is already outside the path this guard
    // reads, so the approval is spent either way. The rename just says how it went.
    try { renameSync(claim, join(dirname(SANCTION), `release-sanction.${verdict}.${stamp()}`)) } catch {}
  }

  let sanction = null
  try { sanction = JSON.parse(readFileSync(claim, 'utf8')) } catch { sanction = null }

  const verdict = releaseVerdict({ operations, command, sanction, repo: repoFacts(cwd), nowMs: Date.now() })
  tombstone(verdict.allowed ? 'consumed' : 'denied')
  return verdict.allowed ? null : `${verdict.reason}. That attempt spent the sanction, so this needs a fresh one`
}

const decide = (input) => {
  const command = input?.tool_input?.command
  if (typeof command !== 'string') {
    return 'flow: Codex sent a Bash call without an inspectable command; refusing an operation whose publication status cannot be verified.'
  }

  const forged = selfApproval(command)
  if (forged) {
    return `flow: this command is refused because ${forged}. A release sanction is the human's approval ` +
      'of one specific head SHA, so the session that wants to publish never writes it. Ask the human ' +
      'to run scripts/release-sanction.mjs in their own terminal, and tell them the repository, ' +
      'branch, head SHA, pull request number, and operation you need approved.'
  }

  const operations = publishOperationsStrict(command)
  if (operations.length === 0) return null

  // A registry publication keeps the exact wording this guard has always used, and it does
  // not reach the sanction path at all - no claim, no file read, nothing to spend.
  const registry = registryReason(operations)
  if (registry) return `${registry} ${REGISTRY_TAIL}\n${REGISTRY_MANUAL}`

  const refuse = (why) =>
    `${MERGE_HEADLINE} ${MERGE_TAIL}\nRelease sanction: ${why}. The human approves a merge by running ` +
    '`node <flow>/scripts/release-sanction.mjs approve --repo <owner/name> --branch <branch> ' +
    '--head <sha> --pr <number> --op gh-pr-merge` in their own terminal; relay what you need, ' +
    'do not run it yourself.'

  // Scheduled jobs read untrusted text and nobody is watching them, so the release path
  // is simply off there. An injected instruction cannot set this variable, the same
  // reasoning git-guard's cron mode rests on. Checked before the claim: an unattended job
  // must not be able to burn a sanction the human wrote for their own session.
  if (process.env.FLOW_CRON_JOB) {
    return refuse('scheduled jobs cannot publish at all, and a sanction does not change that')
  }

  const cwd = typeof input?.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd()
  const denial = spendSanction({ command, operations, cwd })
  return denial === null ? null : refuse(denial)
}

let raw = ''
for await (const chunk of process.stdin) raw += chunk
let input
try { input = JSON.parse(raw) } catch { input = null }

const denial = decide(input)
if (denial !== null) process.stdout.write(JSON.stringify(preToolDeny(denial)))
