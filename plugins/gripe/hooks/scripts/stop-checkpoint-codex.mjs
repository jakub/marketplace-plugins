#!/usr/bin/env node
// gripe: Codex Stop adapter. Codex does not expose an actor id on PostToolUse, so tool
// evidence can be aggregated safely only at the parent-session level. This is deliberately
// not registered on SubagentStop: pretending the evidence can be attributed per actor
// would either lose it or cite one subagent's work to another.

import { buildCheckpointNote, loadCheckpointState, saveCheckpointState } from '../../lib/checkpoint.mjs'
import { safeId } from '../../lib/context.mjs'
import { loadGate } from '../../lib/gate.mjs'

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk

  let input
  try { input = JSON.parse(raw) } catch { return }
  if (input.stop_hook_active) return

  const pending = (input.background_tasks || []).some((task) =>
    ['running', 'pending'].includes(String(task?.status).toLowerCase()),
  )
  if (pending) return

  const sessionId = safeId(input.session_id)
  const actor = 'main'
  if (!sessionId) return

  const state = loadCheckpointState(sessionId, actor, 'codex')
  if (state.asked) return

  const gate = loadGate(sessionId, actor)
  const nudged = new Set(
    Object.entries(gate.fingerprints).filter(([, record]) => record.nudgedAt).map(([fp]) => fp),
  )
  const flags = ['--via checkpoint']
  const prompt = safeId(input.turn_id)
  if (prompt) flags.push(`--prompt ${prompt}`)

  const note = buildCheckpointNote(state, nudged, flags)
  if (note) state.asked = true
  saveCheckpointState(sessionId, actor, 'codex', state)
  if (!note) return

  process.stdout.write(JSON.stringify({ decision: 'block', reason: note }))
}

main().catch(() => {})
