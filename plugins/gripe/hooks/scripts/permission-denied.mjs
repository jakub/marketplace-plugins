#!/usr/bin/env node
// gripe: PermissionDenied. Writes an observed row directly, through the storage module
// and never a shell. The gate matters more here than anywhere: the user's own hooks deny
// by design, so a first denial is a guard working correctly. The fourth identical one
// means the agent kept trying and kept being stopped, which is real friction.
//
// The body is a template over tool_name, reason and a normalised target, never raw
// tool_input, which can carry credentials into durable storage.
//
// Contract: read hook JSON on stdin, write to the database, no output, always exit 0.

import { readHookEvent, safeId } from '../../lib/context.mjs'
import { clean, fingerprint, loadGate, saveGate, target } from '../../lib/gate.mjs'

// The fourth identical denial is friction; one through three are a guard doing its job.
const DENIAL_THRESHOLD = 4

async function main() {
  const { input, sessionId, actor } = await readHookEvent()
  if (!input.tool_name) return
  // Without a session id there is nothing to key the repeat gate on, so the event is dropped.
  if (!sessionId) return
  const aimedAt = target(input.tool_name, input.tool_input)
  // Search patterns can carry secrets the agent was hunting for. They stay in the
  // fingerprint, which lives in a short-lived local state file, but never in the durable
  // body; paths and command prefixes are low-risk and diagnostic, so those do.
  const storedTarget = input.tool_input?.pattern ? null : aimedAt

  const gate = loadGate(sessionId, actor)
  const fp = fingerprint(`deny:${input.tool_name}`, `${input.reason ?? ''} ${aimedAt ?? ''}`)
  const rec = gate.fingerprints[fp] ?? { count: 0 }
  rec.count++
  rec.lastSeen = Date.now()
  const file = rec.count >= DENIAL_THRESHOLD && !rec.filedAt
  if (file) rec.filedAt = Date.now()
  gate.fingerprints[fp] = rec
  saveGate(sessionId, actor, gate)
  if (!file) return

  try {
    const [store, { captureContext }] = await Promise.all([
      import('../../lib/store.mjs'), import('../../lib/context.mjs'),
    ])
    const db = store.openStore()
    try {
      store.addGripe(db, {
        body:
          `Permission denied ${rec.count} times in one session: ${clean(input.tool_name)}` +
          (storedTarget ? ` aimed at "${clean(storedTarget)}"` : '') +
          (input.reason ? `. Reason: ${clean(input.reason).slice(0, 300)}` : '') +
          `. The agent kept trying and kept being stopped, which points at a policy it does not understand or a policy that is wrong.`,
        elicitation: 'observed',
        ...captureContext(),
        session_id: sessionId,
        prompt_id: safeId(input.prompt_id),
        agent_id: actor === 'main' ? null : actor,
        agent_type: safeId(input.agent_type),
        trigger: safeId(input.tool_name),
      })
    } finally {
      db.close()
    }
  } catch (e) {
    process.stderr.write(`gripe: observed row skipped: ${String(e?.message ?? e).split('\n')[0]}\n`)
  }
}

// No process.exit(): a swallowed rejection already leaves the default exit code of 0.
main().catch(() => {})
