#!/usr/bin/env node
// gripe: StopFailure. A turn that failed outright is unambiguous and needs no gate.
// Writes an observed row directly through the storage module. The body is the error
// plus a capped slice of error_details; last_assistant_message is never stored, because
// it can carry credentials or kilobytes of attacker-chosen text into durable storage.
//
// Contract: read hook JSON on stdin, write to the database, no output, always exit 0.

import { clean } from '../../lib/gate.mjs'

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input
  try { input = JSON.parse(raw) } catch { return }
  if (!input.session_id) return

  try {
    const [store, { captureContext, safeId }] = await Promise.all([
      import('../../lib/store.mjs'), import('../../lib/context.mjs'),
    ])
    const db = store.openStore()
    try {
      store.addGripe(db, {
        body:
          `Turn failed outright: ${clean(input.error ?? 'unknown error')}` +
          (input.error_details ? `. Details: ${clean(input.error_details).slice(0, 400)}` : ''),
        elicitation: 'observed',
        ...captureContext(),
        session_id: input.session_id,
        prompt_id: safeId(input.prompt_id),
        agent_id: safeId(input.agent_id),
        agent_type: safeId(input.agent_type),
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
