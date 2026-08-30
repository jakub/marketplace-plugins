// Release sanction policy: the deterministic half of flow's SHA-bound release path.
//
// A human approves ONE merge - this repository, this branch, this head SHA, this pull
// request number - by writing a sanction file with scripts/release-sanction.mjs. When a
// Codex session then runs the merge command, its publish guard re-derives the same facts
// from git and asks this module whether they still match. They usually do not, and that is
// the point: any movement of the branch retires the approval.
//
// A merge is the only thing a sanction can authorize. Publishing to crates.io, npm, PyPI or
// RubyGems is refused here whatever the file says, because there is no undo to fall back on
// when the approval turns out to have been for something else.
//
// Nothing here reads a file, runs git, or looks at the clock. The caller gathers the facts
// and passes them in, so the policy has one exit shape and can be tested without a
// repository. Parsing the command it was handed is the one exception, and it is still pure:
// the same string in gives the same verdict out.
//
// What an allow proves, stated so nobody reads more into it. Current-head equality means
// the head matches the approved SHA at the moment of the call. It does not prove the
// branch never moved in between: a head rewritten and restored verifies exactly like an
// untouched one. What it does buy is that ordinary movement - one more commit, a rebase,
// a switch to another branch, a dirty tree - invalidates the approval and forces a fresh
// human look at what is about to ship.
//
// Deny by default. Every predicate must hold, and anything absent, malformed, or of the
// wrong type is a denial that names the predicate which failed.

import { homedir } from 'node:os'
import { join } from 'node:path'

import { isRegistryOperation, mergeCommandFacts } from './hook-policy.mjs'

/** Bumped whenever the file's meaning changes. A sanction written for another version is refused, never guessed at. */
export const SANCTION_SCHEMA_VERSION = 1

/** Shared with the protected-file rule in hook-policy.mjs, which denies editor writes to this name. */
export const SANCTION_FILENAME = 'release-sanction.json'

/** The longest window a sanction may cover, from issue to expiry. Approval is for the next few minutes of work, not for the day. */
export const MAX_SANCTION_MS = 30 * 60 * 1000

/** How far ahead of the verifying clock a sanction may claim to have been issued. Two machines, two clocks. */
export const CLOCK_SKEW_MS = 2 * 60 * 1000

/** The one operation a sanction can authorize. Registry publication has no sanctioned path at all - the human runs it. */
export const MERGE_OPERATION_ID = 'gh-pr-merge'

// Written out rather than derived from the publication table, so that adding an op id there
// does not quietly make it approvable. A new sanctionable operation is an edit to this line.
export const SANCTIONABLE_OPERATION_IDS = [MERGE_OPERATION_ID]

/** Where the sanction lives, from an environment. Callers pass process.env; the module never reads it itself. */
export function sanctionPath(env) {
  const e = env && typeof env === 'object' ? env : {}
  const state = e.FLOW_STATE || join(e.HOME || homedir(), '.local', 'state', 'flow')
  return join(state, SANCTION_FILENAME)
}

const SHA = /^[0-9a-f]{40}$/
const isSha = (v) => typeof v === 'string' && SHA.test(v)
const isText = (v) => typeof v === 'string' && v.trim() !== ''
// Sanction contents are human-written but still land inside a denial message the model
// reads, so anything echoed back is bounded first.
const show = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
  return s.length > 60 ? `${s.slice(0, 60)}...` : s
}
const millis = (v) => {
  if (!isText(v)) return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

// Does the command merge the pull request the sanction names, and only that one?
//
// A sanction used to authorize "a merge, on this branch, at this head", which is weaker than
// it reads: one approval, one head, but any pull request the session cared to name, in any
// repository `gh` could be pointed at. So the binding is spelled out here. One publication
// operation, one `gh pr merge`, one target, and that target is the sanctioned number. The
// command must pass `--squash` and `--match-head-commit <sanctioned head>`, which makes
// GitHub itself refuse the merge if the branch moved between approval and call. That is a
// second check on top of the head comparison in this file, and it is the one that runs on
// GitHub's side, after this guard has already said yes. Anything that redirects the merge
// somewhere else, or hands it powers the approval did not, denies.
//
// Returns the reason it does not bind, or null when it binds.
function mergeBinding({ command, operations, sanction }) {
  if (operations.length !== 1) {
    return `the command performs ${operations.length} publication operations (${operations.join(', ')}) and a merge is approved on its own`
  }
  if (!Number.isInteger(sanction.prNumber) || sanction.prNumber <= 0) {
    return `the sanction names no pull request number (found ${show(sanction.prNumber)}); approve with --pr <number>`
  }
  if (!isText(command)) return 'the merge command could not be read back, so it cannot be matched to the sanction'

  const { invocations, disqualifiers } = mergeCommandFacts(command)
  if (disqualifiers.length > 0) {
    return `the merge command uses ${disqualifiers.join(', ')}, and a sanctioned merge takes none of those - they change which pull request lands or what the merge is allowed to override`
  }
  if (invocations.length !== 1) {
    return invocations.length === 0
      ? 'the command was classified as a merge but no `gh pr merge` could be parsed out of it'
      : `the command runs ${invocations.length} merges, and a sanction approves exactly one`
  }

  const [merge] = invocations
  if (merge.targets.length !== 1) {
    return merge.targets.length === 0
      ? `the merge names no pull request, so it would take whatever the current branch resolves to; name #${sanction.prNumber} explicitly`
      : `the merge names ${merge.targets.length} targets (${merge.targets.map(show).join(', ')}) and the sanction covers #${sanction.prNumber}`
  }
  const target = merge.targets[0]
  const url = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(target)
  const targetNumber = url ? Number(url[2]) : (/^#?\d+$/.test(target) ? Number(target.replace('#', '')) : null)
  if (url && url[1] !== sanction.repo) {
    return `the merge points at ${show(url[1])} and the sanction is for ${show(sanction.repo)}`
  }
  if (targetNumber === null) {
    return `the merge target ${show(target)} is not a pull request number, and a sanction is bound to #${sanction.prNumber}`
  }
  if (targetNumber !== sanction.prNumber) {
    return `the merge is for #${targetNumber} and the sanction covers #${sanction.prNumber}`
  }

  if (!merge.squash) return 'the merge does not pass --squash, and the sanctioned merge method is a squash'
  if (!isSha(merge.matchHead)) {
    return `the merge passes no readable --match-head-commit (found ${show(merge.matchHead)}); it takes the full 40-character sanctioned SHA`
  }
  if (merge.matchHead !== sanction.head) {
    return `the merge passes --match-head-commit ${merge.matchHead.slice(0, 12)} and the sanction approved ${sanction.head.slice(0, 12)}`
  }
  return null
}

/**
 * Decide whether a sanction authorizes this publication right now.
 *
 * @param {object} args
 * @param {string[]} args.operations op ids the command performs, from publishOperationsStrict()
 * @param {string} args.command the command as the guard received it, parsed here to check that
 *        the merge it runs is the merge the sanction names
 * @param {object|null} args.sanction the parsed sanction file, or null when absent or unreadable
 * @param {{slug: string|null, branch: string|null, head: string|null, dirty: boolean|null}} args.repo
 *        facts read from git at the moment of the call; null for anything git could not answer
 * @param {number} args.nowMs wall clock at verification time
 * @returns {{allowed: boolean, reason: string}} reason names the failed predicate on a denial
 */
export function releaseVerdict({ operations, command, sanction, repo, nowMs } = {}) {
  const deny = (reason) => ({ allowed: false, reason })

  if (!Array.isArray(operations) || operations.length === 0) {
    return deny('no publication operation was named, so there is nothing to authorize')
  }
  if (!operations.every(isText)) return deny('the operation ids to authorize are not all names')

  // Registry publication is outside this path entirely. There is no version of "the model
  // asked and a file said yes" that makes a crates.io release reversible, so the answer is
  // the human's own terminal and nothing else.
  const registry = operations.filter(isRegistryOperation)
  if (registry.length > 0) {
    return deny(`${registry.join(', ')} publishes to a public registry, and registry publication is never sanctioned - run it yourself`)
  }

  if (!sanction || typeof sanction !== 'object' || Array.isArray(sanction)) {
    return deny('no release sanction is on file (the human writes one with scripts/release-sanction.mjs)')
  }
  if (sanction.schema !== SANCTION_SCHEMA_VERSION) {
    return deny(`the sanction declares schema ${show(sanction.schema)} and this guard reads schema ${SANCTION_SCHEMA_VERSION}`)
  }

  if (!repo || typeof repo !== 'object') return deny('no repository facts were gathered to check the sanction against')
  if (!isText(repo.slug)) return deny('the current repository has no readable owner/name slug, so the sanction cannot be matched to it')
  if (!isText(sanction.repo)) return deny(`the sanction names no repository (found ${show(sanction.repo)})`)
  if (sanction.repo !== repo.slug) return deny(`the sanction is for repository ${show(sanction.repo)} and this is ${show(repo.slug)}`)

  if (!isText(repo.branch)) return deny('HEAD is not on a branch here, and a sanction approves a named branch')
  if (!isText(sanction.branch)) return deny(`the sanction names no branch (found ${show(sanction.branch)})`)
  if (sanction.branch !== repo.branch) return deny(`the sanction is for branch ${show(sanction.branch)} and this is ${show(repo.branch)}`)

  if (!isSha(sanction.head)) return deny(`the sanction head ${show(sanction.head)} is not a 40-character lowercase SHA`)
  if (!isSha(repo.head)) return deny('the current head could not be read as a 40-character lowercase SHA')
  if (sanction.head !== repo.head) {
    return deny(`the head has moved: the sanction approved ${sanction.head.slice(0, 12)} and this tree is at ${repo.head.slice(0, 12)}`)
  }

  if (repo.dirty !== false) {
    return deny(repo.dirty === true
      ? 'the working tree is dirty, so what would ship is not what was approved'
      : 'the working tree state could not be read, so it cannot be shown clean')
  }

  if (!Array.isArray(sanction.operations) || !sanction.operations.every(isText)) {
    return deny('the sanction lists no operations, so it authorizes nothing')
  }
  const sanctionedRegistry = sanction.operations.filter(isRegistryOperation)
  if (sanctionedRegistry.length > 0) {
    return deny(`the sanction claims to cover ${sanctionedRegistry.map(show).join(', ')}, and no sanction covers registry publication`)
  }
  const missing = operations.filter((op) => !sanction.operations.includes(op))
  if (missing.length > 0) {
    return deny(`the sanction does not cover ${missing.map(show).join(', ')} (it covers ${sanction.operations.map(show).join(', ')})`)
  }

  if (!Number.isFinite(nowMs)) return deny('the verification time is not a readable clock value')
  const issuedAt = millis(sanction.issuedAt)
  const expiresAt = millis(sanction.expiresAt)
  if (issuedAt === null) return deny(`the sanction issue time ${show(sanction.issuedAt)} is not a readable timestamp`)
  if (expiresAt === null) return deny(`the sanction expiry ${show(sanction.expiresAt)} is not a readable timestamp`)
  if (expiresAt <= issuedAt) return deny('the sanction expires no later than it was issued')
  // Three predicates, and each one closes a different hole. A sanction issued in the future
  // is a clock that was moved or a file that was written by hand, and either way the window
  // it claims is not the window it gets; two minutes is the allowance for two machines that
  // disagree slightly. An expiry already past is spent. And the window is measured from
  // issue, not from now, because measuring from now lets a backdated issue time carry a
  // half-hour of fresh approval forever.
  if (issuedAt > nowMs + CLOCK_SKEW_MS) {
    return deny(`the sanction says it was issued at ${show(sanction.issuedAt)}, which is in the future; a sanction cannot approve work before it exists`)
  }
  if (nowMs >= expiresAt) return deny(`the sanction expired at ${show(sanction.expiresAt)}; ask for a fresh one`)
  if (expiresAt - issuedAt > MAX_SANCTION_MS) {
    return deny(`the sanction covers ${show(sanction.issuedAt)} to ${show(sanction.expiresAt)}, more than 30 minutes; approval is good for one short window, not a standing permission`)
  }

  if (operations.includes(MERGE_OPERATION_ID)) {
    const bound = mergeBinding({ command, operations, sanction })
    if (bound) return deny(bound)
  }

  return {
    allowed: true,
    reason: `sanction covers ${operations.join(', ')} on ${repo.slug} ${repo.branch} at ${repo.head.slice(0, 12)}`,
  }
}
