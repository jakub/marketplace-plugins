#!/usr/bin/env node
// gripe: Codex Stop adapter. Codex does not expose an actor id on PostToolUse, so tool
// evidence can be aggregated safely only at the parent-session level. This is deliberately
// not registered on SubagentStop: pretending the evidence can be attributed per actor
// would either lose it or cite one subagent's work to another.

import { buildCheckpointNote, updateCheckpointState } from '../../lib/checkpoint.mjs'
import { readHookEvent, safeId } from '../../lib/context.mjs'
import { loadGate } from '../../lib/gate.mjs'

async function main() {
  const { input, sessionId } = await readHookEvent()
  if (input.stop_hook_active) return

  const pending = (input.background_tasks || []).some((task) =>
    ['running', 'pending'].includes(String(task?.status).toLowerCase()),
  )
  if (pending) return

  // The event's own actor is ignored: see the note at the top of this file.
  const actor = 'main'
  if (!sessionId) return

  const gate = loadGate(sessionId, actor)
  const nudged = new Set(
    Object.entries(gate.fingerprints).filter(([, record]) => record.nudgedAt).map(([fp]) => fp),
  )
  const flags = ['--via checkpoint']
  const prompt = safeId(input.turn_id)
  if (prompt) flags.push(`--prompt ${prompt}`)

  const note = await updateCheckpointState(sessionId, actor, 'codex', (state) => {
    if (state.asked) return null
    const result = buildCheckpointNote(state, nudged, flags)
    if (result) state.asked = true
    return result
  })
  if (!note) return

  // Codex hook contract as of 2026-08-26: block on Stop creates a continuation prompt
  // rather than rejecting the turn.
  process.stdout.write(JSON.stringify({ decision: 'block', reason: note }))
}

main().catch(() => {})
