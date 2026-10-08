// gripe: shared hook plumbing. Fingerprinting and the gate-state files that hold the
// error nudge to one interruption per fingerprint.
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
