// Release sanction policy: the deterministic half of flow's SHA-bound release path.
//
// A human approves ONE publication - this repository, this branch, this head SHA, these
// operation ids - by writing a sanction file with scripts/release-sanction.mjs. When a
// Codex session then runs the publication command, its publish guard re-derives the same
// facts from git and asks this module whether they still match. They usually do not, and
// that is the point: any movement of the branch retires the approval.
//
// Nothing here reads a file, runs git, or looks at the clock. The caller gathers the
// facts and passes them in, so the policy has one exit shape and can be tested without a
// repository. Same posture as hook-policy.mjs: adapters own I/O, this owns the verdict.
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

/** Bumped whenever the file's meaning changes. A sanction written for another version is refused, never guessed at. */
export const SANCTION_SCHEMA_VERSION = 1

/** Shared with the protected-file rule in hook-policy.mjs, which denies editor writes to this name. */
export const SANCTION_FILENAME = 'release-sanction.json'

/** The longest a sanction may still be good for. Approval is for the next few minutes of work, not for the day. */
export const MAX_SANCTION_MS = 30 * 60 * 1000

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
 * Decide whether a sanction authorizes this publication right now.
 *
 * @param {object} args
 * @param {string[]} args.operations op ids the command performs, from publishOperations()
 * @param {object|null} args.sanction the parsed sanction file, or null when absent or unreadable
 * @param {{slug: string|null, branch: string|null, head: string|null, dirty: boolean|null}} args.repo
 *        facts read from git at the moment of the call; null for anything git could not answer
 * @param {number} args.nowMs wall clock at verification time
 * @returns {{allowed: boolean, reason: string}} reason names the failed predicate on a denial
 */
export function releaseVerdict({ operations, sanction, repo, nowMs } = {}) {
  const deny = (reason) => ({ allowed: false, reason })

  if (!Array.isArray(operations) || operations.length === 0) {
    return deny('no publication operation was named, so there is nothing to authorize')
  }
  if (!operations.every(isText)) return deny('the operation ids to authorize are not all names')

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
  if (nowMs >= expiresAt) return deny(`the sanction expired at ${show(sanction.expiresAt)}; ask for a fresh one`)
  // A far-future expiry is either a hand-edited file or a helper that was not the one we
  // ship. Either way it is a standing permission, which is the thing this path exists to
  // avoid, so the window is re-checked here rather than trusted from the file.
  if (expiresAt - nowMs > MAX_SANCTION_MS) {
    return deny(`the sanction runs until ${show(sanction.expiresAt)}, more than 30 minutes out; approval is good for one short window, not a standing permission`)
  }

  return {
    allowed: true,
    reason: `sanction covers ${operations.join(', ')} on ${repo.slug} ${repo.branch} at ${repo.head.slice(0, 12)}`,
  }
}
