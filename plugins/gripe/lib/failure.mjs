// Harness-neutral repeated-failure policy. Adapters decide how a harness represents a
// failed tool result and how the returned note enters that harness's context.

import { clean, fingerprint, heredocDelim, loadGate, saveGate } from './gate.mjs'
import { safeId } from './context.mjs'

const REPEAT_THRESHOLD = 2

export function recordRepeatedFailure({ sessionId, actor = 'main', toolName, error, promptId }) {
  if (!sessionId || !toolName) return null

  const gate = loadGate(sessionId, actor)
  const fp = fingerprint(toolName, error ?? '')
  const rec = gate.fingerprints[fp] ?? { count: 0 }
  rec.count++
  rec.lastSeen = Date.now()

  const nudge = rec.count >= REPEAT_THRESHOLD && !rec.nudgedAt
  if (nudge) rec.nudgedAt = Date.now()
  gate.fingerprints[fp] = rec
  saveGate(sessionId, actor, gate)
  if (!nudge) return null

  const flags = ['--via error_nudge']
  const trigger = safeId(toolName)
  const prompt = safeId(promptId)
  if (trigger) flags.push(`--trigger ${trigger}`)
  if (prompt) flags.push(`--prompt ${prompt}`)
  if (actor !== 'main') flags.push(`--agent ${actor}`)

  const d = heredocDelim()
  return [
    `gripe: ${clean(toolName)} has now failed ${rec.count} times with the same error shape.`,
    'If that is avoidable friction in the tooling or the workflow rather than ordinary work,',
    'file the specific problem:',
    '',
    `gripe add ${flags.join(' ')} <<'${d}'`,
    '<what you expected, what happened instead, what it cost>',
    d,
    '',
    'If it is just the work, carry on. No reply is expected and saying nothing costs nothing.',
  ].join('\n')
}
