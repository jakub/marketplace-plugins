#!/usr/bin/env node
// gripe: PostToolUseFailure. Fires on the failures PostToolUse never sees. Nudges on
// repeats, not firsts: the first failure of a given shape is ordinary work, the second
// is a pattern. Every fingerprint it nudges on lands in the shared gate state so the
// Stop checkpoint does not cite the same fight a second time.
//
// Contract: read hook JSON on stdin, optionally emit hookSpecificOutput JSON, exit 0.

import { clean, fingerprint, heredocDelim, loadGate, saveGate } from '../../lib/gate.mjs'
import { safeId } from '../../lib/context.mjs'

// The second identical failure is a pattern; the first is ordinary work.
const REPEAT_THRESHOLD = 2

// Backstop blocklist of command prefixes too noisy to ever nudge on. The repeat gate is
// the primary mechanism; add here only when a specific tool proves it needs it.
const NOISY_PREFIXES = []

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input
  try { input = JSON.parse(raw) } catch { return }

  // An interrupt is jakub pressing escape, not the tooling fighting the agent.
  if (input.is_interrupt) return
  if (!input.session_id || !input.tool_name) return

  const cmd = typeof input.tool_input?.command === 'string' ? input.tool_input.command : ''
  if (NOISY_PREFIXES.some((p) => cmd.startsWith(p))) return

  const actor = safeId(input.agent_id) ?? 'main'
  const gate = loadGate(input.session_id, actor)
  const fp = fingerprint(input.tool_name, input.error ?? '')
  const rec = gate.fingerprints[fp] ?? { count: 0 }
  rec.count++
  rec.lastSeen = Date.now()

  // Once per fingerprint per session: a retry loop asks once, not forty times.
  const nudge = rec.count >= REPEAT_THRESHOLD && !rec.nudgedAt
  if (nudge) rec.nudgedAt = Date.now()
  gate.fingerprints[fp] = rec
  saveGate(input.session_id, actor, gate)
  if (!nudge) return

  const flags = [`--via error_nudge`]
  const trigger = safeId(input.tool_name)
  const prompt = safeId(input.prompt_id)
  const agent = actor === 'main' ? null : actor
  if (trigger) flags.push(`--trigger ${trigger}`)
  if (prompt) flags.push(`--prompt ${prompt}`)
  if (agent) flags.push(`--agent ${agent}`)

  const d = heredocDelim() // random per advertisement; a fixed delimiter is an injection path
  const note = [
    `gripe: ${clean(input.tool_name)} has now failed ${rec.count} times with the same error shape.`,
    `If that is avoidable friction in the tooling or the workflow rather than ordinary work,`,
    `file the specific problem:`,
    ``,
    `gripe add ${flags.join(' ')} <<'${d}'`,
    `<what you expected, what happened instead, what it cost>`,
    d,
    ``,
    `If it is just the work, carry on. No reply is expected and saying nothing costs nothing.`,
  ].join('\n')

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: note },
    }),
  )
}

// No process.exit(): an explicit exit can truncate stdout before the pipe drains, and a
// swallowed rejection already leaves the default exit code of 0.
main().catch(() => {})
