// gripe: shared hook plumbing. Fingerprinting, target extraction, and the gate-state
// files that repetition-gated hooks share, so the error nudge and the Stop checkpoint
// see each other's work and one fingerprint cannot buy two interruptions.
//
// Deliberately free of node:sqlite: hooks that only touch state files must run, and
// exit 0, on a node too old for the storage module.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

// Mirrors store.mjs, which cannot be imported here without dragging in node:sqlite.
export const stateDir = () =>
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'gripe')

// Bound on any fingerprint or counter map; oldest entries evicted first, which loses
// old fights, not the current one.
export const MAX_COUNTER_KEYS = 400
// Targets become map keys and cited text; a huge glob pattern should not become either.
export const MAX_TARGET_LEN = 200

// Keyed by session id plus actor (`main` or a validated agent_id): every subagent in a
// fan-out shares its parent's session id, so a session-only key collides.
export const gatePath = (sessionId, actor) =>
  join(stateDir(), 'gate', `${sessionId}-${actor}.json`)

export function loadGate(sessionId, actor) {
  try {
    return { fingerprints: {}, ...JSON.parse(readFileSync(gatePath(sessionId, actor), 'utf8')) }
  } catch {
    return { fingerprints: {} } // missing or corrupt just means starting over
  }
}

export function saveGate(sessionId, actor, gate) {
  try {
    capKeys(gate.fingerprints, MAX_COUNTER_KEYS)
    mkdirSync(join(stateDir(), 'gate'), { recursive: true })
    atomicWrite(gatePath(sessionId, actor), JSON.stringify(gate))
  } catch {
    // Losing gate state costs an extra nudge, which is annoying rather than wrong.
  }
}

/** Write via temp file plus rename, so a concurrent reader never sees a torn file. */
export function atomicWrite(path, data) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

/**
 * A heredoc delimiter for the advertised filing recipe. Random per advertisement: a
 * fixed delimiter lets a hostile body close the heredoc early with a literal matching
 * line and run whatever follows as shell commands, auto-approved under the allowlist.
 * Attacker text is written before the delimiter exists, so it cannot contain it.
 */
export const heredocDelim = () => `GRIPE_${randomBytes(4).toString('hex')}`

/** Strip control characters from text that will be echoed in a hook's trusted voice. */
export const clean = (s) =>
  String(s).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()

/** Evict oldest keys past a bound; insertion order is preserved on plain objects. */
export function capKeys(map, max) {
  const keys = Object.keys(map)
  if (keys.length > max) {
    for (const k of keys.slice(0, keys.length - max)) delete map[k]
  }
}

/** Collapse an error string to something that matches again next time it happens. */
export function fingerprint(toolName, text) {
  const norm = String(text)
    .toLowerCase()
    .replace(/\/[^\s'"]+/g, '/P') // paths differ per run, the shape does not
    .replace(/\b[0-9a-f]{7,}\b/g, 'H') // shas, ids
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return `${toolName}::${norm}`
}

// A flag that takes a value hides the real command behind it and collapses unrelated
// work onto one churn key: every `sh -c "..."` became "sh", every `git -C <wt> ...`
// became "git", and a Codex `apply_patch` envelope produced no target at all. Unwrap
// the observed shapes; anything else keeps the plain leading-bare-words walk.
// Quoted and bare -c scripts are separate alternatives so trailing argv words after a
// quoted script do not defeat the match, and git's -C/-c values may be quoted paths
// with spaces. Both the inspected length and the unwrap depth are bounded: this runs
// on request-controlled input inside a hook timeout.
const SHELL_WRAP_QUOTED = /^(?:sh|bash|zsh|dash)\s+-l?c\s+(['"])([\s\S]*?)\1(?:\s|$)/
const SHELL_WRAP_BARE = /^(?:sh|bash|zsh|dash)\s+-l?c\s+([\s\S]+)$/
const GIT_GLOBALS = /^git((?:\s+(?:-C|-c)\s+(?:"[^"]*"|'[^']*'|\S+)|\s+(?:--no-pager|-P|-p))+)\s+/
const PATCH_TARGET = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m
const MAX_COMMAND_SCAN = 4096
const MAX_UNWRAP_DEPTH = 3

/** What a tool call was aimed at, for repetition detection and observed-row templates. */
export function target(toolName, input) {
  if (!input || typeof input !== 'object') return null
  if (input.file_path) return String(input.file_path).slice(0, MAX_TARGET_LEN)
  if (input.command) {
    let cmd = String(input.command).slice(0, MAX_COMMAND_SCAN).trim()
    // Codex apply_patch sends the whole envelope as the command; the fight is with the
    // first file it touches, not with the patch syntax.
    if (cmd.startsWith('*** Begin Patch')) {
      const patch = cmd.match(PATCH_TARGET)
      return patch ? patch[1].trim().slice(0, MAX_TARGET_LEN) : null
    }
    for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
      const quoted = cmd.match(SHELL_WRAP_QUOTED)
      const inner = quoted ? quoted[2] : cmd.match(SHELL_WRAP_BARE)?.[1]
      if (inner === undefined) break
      cmd = inner.trim()
    }
    cmd = cmd.replace(GIT_GLOBALS, 'git ')
    // Leading bare words only, stopping at the first argument. `gh run watch 123` and
    // `gh run watch --exit-status` are the same fight; `gh run list` is a different one,
    // so a flat two-token slice would wrongly merge them.
    const words = []
    for (const tok of cmd.split(/\s+/)) {
      if (words.length === 3) break
      if (!/^[A-Za-z][\w.-]*$/.test(tok)) break
      words.push(tok)
    }
    return words.join(' ') || null
  }
  if (input.pattern) return String(input.pattern).slice(0, MAX_TARGET_LEN)
  return null
}
