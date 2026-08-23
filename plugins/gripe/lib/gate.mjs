// gripe: shared hook plumbing. Fingerprinting, target extraction, and the gate-state
// files that repetition-gated hooks share, so the error nudge and the Stop checkpoint
// see each other's work and one fingerprint cannot buy two interruptions.
//
// Deliberately free of node:sqlite: hooks that only touch state files must run, and
// exit 0, on a node too old for the storage module.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

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
    writeFileSync(gatePath(sessionId, actor), JSON.stringify(gate))
  } catch {
    // Losing gate state costs an extra nudge, which is annoying rather than wrong.
  }
}

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

/** What a tool call was aimed at, for repetition detection and observed-row templates. */
export function target(toolName, input) {
  if (!input || typeof input !== 'object') return null
  if (input.file_path) return String(input.file_path).slice(0, MAX_TARGET_LEN)
  if (input.command) {
    // Leading bare words only, stopping at the first argument. `gh run watch 123` and
    // `gh run watch --exit-status` are the same fight; `gh run list` is a different one,
    // so a flat two-token slice would wrongly merge them.
    const words = []
    for (const tok of String(input.command).trim().split(/\s+/)) {
      if (words.length === 3) break
      if (!/^[A-Za-z][\w.-]*$/.test(tok)) break
      words.push(tok)
    }
    return words.join(' ') || null
  }
  if (input.pattern) return String(input.pattern).slice(0, MAX_TARGET_LEN)
  return null
}
