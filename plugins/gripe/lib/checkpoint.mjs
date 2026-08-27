// Harness-neutral checkpoint counters and policy. Claude fills this state from its
// transcript adapter; Codex fills it incrementally from PostToolUse events.

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  MAX_COUNTER_KEYS, atomicWrite, capKeys, clean, fingerprint, heredocDelim, stateDir, target,
} from './gate.mjs'

export const MIN_TOOL_CALLS = 15
export const CHURN_THRESHOLD = 3
export const REPEAT_THRESHOLD = 2
export const MAX_TOOL_NAMES = 4000
export const MAX_SCAN_BYTES = 4 * 1024 * 1024
const LOCK_ATTEMPTS = 200
const LOCK_WAIT_MS = 5
// A holder killed between open and unlink (harness timeout, interrupt) must not disable
// the checkpoint for the rest of the session. Any hold is milliseconds, so a lock this
// old is orphaned, not contended.
const LOCK_STALE_MS = 10_000

const statePath = (sessionId, actor, source) => {
  // Preserve the existing Claude filename. Codex is namespaced to avoid cross-harness
  // collisions if two runtimes happen to use the same session id.
  const prefix = source === 'claude' ? '' : `${source}-`
  return join(stateDir(), 'scan', `${prefix}${sessionId}-${actor}.json`)
}

export const freshCheckpointState = () => ({
  offset: 0,
  asked: false,
  toolCalls: 0,
  toolNames: {},
  failures: {},
  churn: {},
})

export function loadCheckpointState(sessionId, actor, source = 'claude') {
  try {
    return {
      ...freshCheckpointState(),
      ...JSON.parse(readFileSync(statePath(sessionId, actor, source), 'utf8')),
    }
  } catch {
    return freshCheckpointState()
  }
}

export function saveCheckpointState(sessionId, actor, source, state) {
  try {
    capKeys(state.toolNames, MAX_TOOL_NAMES)
    capKeys(state.failures, MAX_COUNTER_KEYS)
    capKeys(state.churn, MAX_COUNTER_KEYS)
    mkdirSync(join(stateDir(), 'scan'), { recursive: true })
    atomicWrite(statePath(sessionId, actor, source), JSON.stringify(state))
    return true
  } catch {
    // Gripe is advisory. Losing checkpoint state costs a nudge, never the agent's work.
    return false
  }
}

async function acquireCheckpointLock(sessionId, actor, source) {
  const dir = join(stateDir(), 'scan')
  const path = `${statePath(sessionId, actor, source)}.lock`
  try { mkdirSync(dir, { recursive: true }) } catch { return null }

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      return { fd: openSync(path, 'wx', 0o600), path }
    } catch (error) {
      if (error?.code !== 'EEXIST') return null
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
          // Rename before unlink: rename is atomic, so exactly one contender wins the
          // right to remove a stale lock, and a slow racer that statted the old file
          // cannot delete the fresh lock that replaced it.
          const tombstone = `${path}.stale.${process.pid}`
          renameSync(path, tombstone)
          unlinkSync(tombstone)
        }
      } catch {
        // Raced another process breaking or releasing the same lock; retry decides.
      }
      await sleep(LOCK_WAIT_MS)
    }
  }
  return null
}

/** Serialize one checkpoint read-modify-write across hook processes. */
export async function updateCheckpointState(sessionId, actor, source, update) {
  const lock = await acquireCheckpointLock(sessionId, actor, source)
  if (!lock) return null

  try {
    const state = loadCheckpointState(sessionId, actor, source)
    const result = update(state)
    return saveCheckpointState(sessionId, actor, source, state) ? result : null
  } catch {
    return null
  } finally {
    try {
      // Release only a lock this process still owns. If a breaker reclaimed it and a
      // successor holds the path, the inode differs and the unlink is skipped.
      if (fstatSync(lock.fd).ino === statSync(lock.path).ino) unlinkSync(lock.path)
    } catch {}
    try { closeSync(lock.fd) } catch {}
  }
}

export function observeToolResult(state, { toolName, toolId, toolInput, failureText = null }) {
  const name = String(toolName || 'unknown')
  state.toolCalls++
  if (toolId) state.toolNames[toolId] = name

  const aimedAt = target(name, toolInput)
  if (aimedAt) {
    const key = `${name} ${aimedAt}`
    const seen = state.churn[key] || { count: 0, tool: name, target: aimedAt }
    seen.count++
    state.churn[key] = seen
  }

  if (failureText !== null) {
    const fp = fingerprint(name, failureText)
    const seen = state.failures[fp] || { count: 0, tool: name, sample: String(failureText).slice(0, 120) }
    seen.count++
    state.failures[fp] = seen
  }

  // Not capped here: every write path ends in saveCheckpointState, which caps once.
  return state
}

export function buildCheckpointNote(state, nudged, flags) {
  const repeats = Object.entries(state.failures)
    .filter(([fp, failure]) => failure.count >= REPEAT_THRESHOLD && !nudged.has(fp))
    .map(([, failure]) => failure)
  const churned = Object.values(state.churn).filter((entry) => entry.count >= CHURN_THRESHOLD)

  if (!repeats.length && !churned.length) return null
  if (state.toolCalls < MIN_TOOL_CALLS) return null

  const cited = []
  for (const failure of repeats.slice(0, 2)) {
    cited.push(`${failure.tool} failed ${failure.count} times the same way (${clean(failure.sample)})`)
  }
  for (const entry of churned.slice(0, 2)) {
    cited.push(`${entry.tool} was aimed at "${clean(entry.target)}" ${entry.count} times`)
  }

  const d = heredocDelim()
  return [
    `gripe: this run, ${cited.join('; ')}.`,
    'If any of that was avoidable friction in the tooling or the workflow rather than ordinary',
    'work, file the specific problem:',
    '',
    `gripe add ${flags.join(' ')} <<'${d}'`,
    '<what you expected, what happened instead, what it cost>',
    d,
    '',
    'If it was just the work, carry on. No reply is expected and saying nothing costs nothing.',
  ].join('\n')
}
