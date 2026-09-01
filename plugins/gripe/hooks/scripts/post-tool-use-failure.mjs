#!/usr/bin/env node
// gripe: PostToolUseFailure. Fires on the failures PostToolUse never sees. Nudges on
// repeats, not firsts: the first failure of a given shape is ordinary work, the second
// is a pattern. Every fingerprint it nudges on lands in the shared gate state so the
// Stop checkpoint does not cite the same fight a second time.
//
// Contract: read hook JSON on stdin, optionally emit hookSpecificOutput JSON, exit 0.

import { recordRepeatedFailure } from '../../lib/failure.mjs'
import { safeId } from '../../lib/context.mjs'

// Backstop blocklist of command prefixes too noisy to ever nudge on. The repeat gate is
// the primary mechanism; add here only when a specific tool proves it needs it.
const NOISY_PREFIXES = []

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input
  try { input = JSON.parse(raw) } catch { return }

  // An interrupt is the user pressing escape, not the tooling fighting the agent.
  if (input.is_interrupt) return
  if (!input.tool_name) return

  // The session id keys the shared gate state and lands in its filename, so an id outside
  // the safe alphabet counts as absent and the event is dropped rather than written to a
  // path of its own choosing.
  const sessionId = safeId(input.session_id)
  if (!sessionId) return

  const cmd = typeof input.tool_input?.command === 'string' ? input.tool_input.command : ''
  if (NOISY_PREFIXES.some((p) => cmd.startsWith(p))) return

  const actor = safeId(input.agent_id) ?? 'main'
  const note = recordRepeatedFailure({
    sessionId,
    actor,
    toolName: input.tool_name,
    error: input.error ?? '',
    promptId: input.prompt_id,
  })
  if (!note) return

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: note },
    }),
  )
}

// No process.exit(): an explicit exit can truncate stdout before the pipe drains, and a
// swallowed rejection already leaves the default exit code of 0.
main().catch(() => {})
