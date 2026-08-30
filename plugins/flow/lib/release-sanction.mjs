// Release sanction policy: the deterministic half of flow's SHA-bound release path.
//
// A human approves ONE merge - this repository, this branch, this head SHA, this pull
// request number - by writing a sanction file with scripts/release-sanction.mjs. The only
// thing that can spend it is scripts/land-merge.mjs, which claims the file, reads the pull
// request's live state out of GitHub, and asks this module whether the approval still
// describes what is about to land. It usually does not, and that is the point: one more
// commit on the branch retires the approval.
//
// This module never reads the command that asked for the merge. It used to, and matching a
// human-written approval against a shell string was the weakest link in the whole path: the
// guard had to out-parse every spelling a shell accepts, forever, and one miss was a merge
// nobody approved. Now the caller performs the merge itself with an argv array, so there is
// no command text to be fooled by, and the facts below come from GitHub rather than from
// whatever the session typed.
//
// A merge is the only thing a sanction can authorize. Publishing to crates.io, npm, PyPI or
// RubyGems is refused here whatever the file says, because there is no undo to fall back on
// when the approval turns out to have been for something else.
//
// Nothing here reads a file, runs a command, or looks at the clock. The caller gathers the
// facts and passes them in, so the policy is pure and can be tested without a repository, a
// network, or a GitHub account.
//
// What an allow proves, stated so nobody reads more into it. Head equality means the pull
// request's head matches the approved SHA at the moment of the call. It does not prove the
// branch never moved in between: a head rewritten and restored verifies exactly like an
// untouched one. What it does buy is that ordinary movement - one more commit, a rebase, a
// retargeted base, a converted draft - invalidates the approval and forces a fresh human
// look at what is about to ship.
//
// This is a cooperative guardrail, not a security boundary. Everything runs as one uid, so a
// determined model with a shell could substitute gh, use curl, or call the GitHub API with
// the token directly, and none of the checks below would ever see it. What the checks stop is
// the accident and the casual injected instruction: a merge of the wrong pull request, of a
// head the human never saw, onto a base they were not shown. The base check is the clearest
// example of the limit. The caller re-reads the base right before it merges, but a retarget
// that lands between that read and GitHub's own merge is an unclosable race on the client
// side; only GitHub could close it, and it does not offer a base-match flag the way it offers
// --match-head-commit for the head.
//
// Deny by default. Every predicate must hold, and anything absent, malformed, or of the
// wrong type is a denial that names the predicate which failed.

import { homedir } from 'node:os'
import { join } from 'node:path'

import { isRegistryOperation } from './hook-policy.mjs'

/**
 * Bumped whenever the file's meaning changes. A sanction written for another version is
 * refused, never guessed at. `expectedBase` was added within schema 1: it is a new required
 * field, which is safe because a sanction lives at most 30 minutes and is single-use, so no
 * old file survives to be read by a newer verifier.
 */
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

/**
 * Decide whether a sanction authorizes merging this pull request right now.
 *
 * @param {object} args
 * @param {string[]} args.operations op ids the caller is about to perform. The executor passes
 *        exactly [MERGE_OPERATION_ID]; anything else is checked and refused here.
 * @param {object|null} args.sanction the parsed sanction file, or null when absent or unreadable
 * @param {object} args.pr live facts, read from GitHub rather than from the session
 * @param {string|null} args.pr.slug owner/name derived from the origin remote
 * @param {string|null} [args.pr.host] the remote host derived from the origin remote, for the reason string
 * @param {number|null} args.pr.number the pull request the caller was asked to merge
 * @param {string|null} args.pr.branch headRefName
 * @param {string|null} args.pr.head headRefOid
 * @param {string|null} args.pr.state OPEN, CLOSED or MERGED
 * @param {boolean|null} args.pr.isDraft isDraft
 * @param {string|null} args.pr.base baseRefName
 * @param {string|null} args.pr.defaultBranch the repository's default branch
 * @param {number} args.nowMs wall clock at verification time
 * @returns {{allowed: boolean, reason: string}} reason names the failed predicate on a denial
 */
export function releaseVerdict({ operations, sanction, pr, nowMs } = {}) {
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
    return deny('the release sanction could not be read as an object')
  }
  if (sanction.schema !== SANCTION_SCHEMA_VERSION) {
    return deny(`the sanction declares schema ${show(sanction.schema)} and this reader is schema ${SANCTION_SCHEMA_VERSION}`)
  }

  if (!pr || typeof pr !== 'object') return deny('no pull request facts were gathered to check the sanction against')

  if (!isText(pr.slug)) return deny('this directory has no readable owner/name slug, so the sanction cannot be matched to it')
  if (!isText(sanction.repo)) return deny(`the sanction names no repository (found ${show(sanction.repo)})`)
  if (sanction.repo !== pr.slug) return deny(`the sanction is for repository ${show(sanction.repo)} and this is ${show(pr.slug)}`)

  if (!Number.isInteger(pr.number) || pr.number <= 0) {
    return deny(`${show(pr.number)} is not a pull request number`)
  }
  if (!Number.isInteger(sanction.prNumber) || sanction.prNumber <= 0) {
    return deny(`the sanction names no pull request number (found ${show(sanction.prNumber)}); approve with --pr <number>`)
  }
  if (sanction.prNumber !== pr.number) {
    return deny(`the sanction covers #${sanction.prNumber} and this run was asked to merge #${pr.number}`)
  }

  if (!isText(pr.branch)) return deny(`#${pr.number} has no readable head branch name`)
  if (!isText(sanction.branch)) return deny(`the sanction names no branch (found ${show(sanction.branch)})`)
  if (sanction.branch !== pr.branch) {
    return deny(`the sanction is for branch ${show(sanction.branch)} and #${pr.number} is from ${show(pr.branch)}`)
  }

  if (!isSha(sanction.head)) return deny(`the sanction head ${show(sanction.head)} is not a 40-character lowercase SHA`)
  if (!isSha(pr.head)) return deny(`the head of #${pr.number} did not read back as a 40-character lowercase SHA (found ${show(pr.head)})`)
  if (sanction.head !== pr.head) {
    return deny(`the head has moved: the sanction approved ${sanction.head.slice(0, 12)} and #${pr.number} is now at ${pr.head.slice(0, 12)}`)
  }

  // Three facts about the pull request itself, none of which a session can talk this module
  // out of. A closed or already merged one has nothing to land, a draft is by definition not
  // finished, and a base other than the default branch means the merge would land somewhere
  // the human was not shown when they approved it.
  if (pr.state !== 'OPEN') return deny(`#${pr.number} is ${show(pr.state)} on GitHub, and only an open pull request can be merged`)
  if (pr.isDraft !== false) {
    return deny(pr.isDraft === true
      ? `#${pr.number} is a draft; mark it ready for review before it lands`
      : `the draft status of #${pr.number} could not be read, so it cannot be shown ready`)
  }
  if (!isText(pr.defaultBranch)) return deny('the repository default branch could not be read, so the merge target cannot be checked')
  if (!isText(pr.base)) return deny(`the base branch of #${pr.number} could not be read`)
  if (pr.base !== pr.defaultBranch) {
    return deny(`#${pr.number} targets ${show(pr.base)} and the default branch is ${show(pr.defaultBranch)}; a sanctioned merge lands on the default branch`)
  }
  // The human names the base they approved. It has to equal the default branch above, so this
  // is redundant on a well-behaved pull request, but it makes the approval say out loud what
  // it lands on, and it catches a retarget the human never looked at.
  if (!isText(sanction.expectedBase)) return deny(`the sanction names no expected base branch (found ${show(sanction.expectedBase)}); approve with --base <branch>`)
  if (sanction.expectedBase !== pr.base) {
    return deny(`the sanction approved a merge onto ${show(sanction.expectedBase)} and #${pr.number} now targets ${show(pr.base)}`)
  }

  if (!Array.isArray(sanction.operations) || sanction.operations.length === 0 || !sanction.operations.every(isText)) {
    return deny('the sanction lists no operations, so it authorizes nothing')
  }
  const sanctionedRegistry = sanction.operations.filter(isRegistryOperation)
  if (sanctionedRegistry.length > 0) {
    return deny(`the sanction claims to cover ${sanctionedRegistry.map(show).join(', ')}, and no sanction covers registry publication`)
  }
  const beyondMerge = sanction.operations.filter((op) => op !== MERGE_OPERATION_ID)
  if (beyondMerge.length > 0) {
    return deny(`the sanction also covers ${beyondMerge.map(show).join(', ')}, and a merge is approved on its own`)
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

  const where = isText(pr.host) ? `${pr.host}/${pr.slug}` : pr.slug
  return {
    allowed: true,
    reason: `sanction covers ${operations.join(', ')} of #${pr.number} on ${where} ${pr.branch} onto ${pr.base} at ${pr.head.slice(0, 12)}`,
  }
}
