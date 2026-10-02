#!/usr/bin/env node
// gripe: PostToolUseFailure. Fires on the failures PostToolUse never sees. Nudges on
// repeats, not firsts: the first failure of a given shape is ordinary work, the second
// is a pattern. Every fingerprint it nudges on lands in the shared gate state so the
// Stop checkpoint does not cite the same fight a second time.
//
// Claude only. Codex has no failure event, and its PostToolUse carries no reliable exit
// status, so the Codex adapter records targets and never runs this policy.
//
// Contract: read hook JSON on stdin, optionally emit hookSpecificOutput JSON, exit 0.

import { readHookEvent, safeId } from '../../lib/context.mjs'
import { clean, fingerprint, heredocDelim, loadGate, saveGate } from '../../lib/gate.mjs'

const REPEAT_THRESHOLD = 2

async function main() {
  const { input, sessionId, actor } = await readHookEvent()

  // An interrupt is the user pressing escape, not the tooling fighting the agent.
  if (input.is_interrupt) return
  if (!input.tool_name) return

  // The session id keys the shared gate state, so without one the event is dropped.
  if (!sessionId) return

  const gate = loadGate(sessionId, actor)
  const fp = fingerprint(input.tool_name, input.error ?? '')
  const rec = gate.fingerprints[fp] ?? { count: 0 }
  rec.count++
  rec.lastSeen = Date.now()
  // Once per fingerprint, so a retry loop asks once rather than forty times.
  const nudge = rec.count >= REPEAT_THRESHOLD && !rec.nudgedAt
  if (nudge) rec.nudgedAt = Date.now()
  gate.fingerprints[fp] = rec
  saveGate(sessionId, actor, gate)
  if (!nudge) return

  const flags = ['--via error_nudge']
  const trigger = safeId(input.tool_name)
  const prompt = safeId(input.prompt_id)
  if (trigger) flags.push(`--trigger ${trigger}`)
  if (prompt) flags.push(`--prompt ${prompt}`)
  if (actor !== 'main') flags.push(`--agent ${actor}`)

  const d = heredocDelim()
  const note = [
    `gripe: ${clean(input.tool_name)} has now failed ${rec.count} times with the same error shape.`,
    'If that is avoidable friction in the tooling or the workflow rather than ordinary work,',
    'file the specific problem:',
    '',
    `gripe add ${flags.join(' ')} <<'${d}'`,
    '<what you expected, what happened instead, what it cost>',
    d,
    '',
    'If it is just the work, carry on. No reply is expected and saying nothing costs nothing.',
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
