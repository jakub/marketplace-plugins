#!/usr/bin/env node
// gripe: PostToolUseFailure. Fires on the failures PostToolUse never sees. Nudges on
// repeats, not firsts: the first failure of a given shape is ordinary work, the second
// is a pattern. Every fingerprint it nudges on lands in the shared gate state so the
// Stop checkpoint does not cite the same fight a second time.
//
// Contract: read hook JSON on stdin, optionally emit hookSpecificOutput JSON, exit 0.

import { recordRepeatedFailure } from '../../lib/failure.mjs'
import { readHookEvent } from '../../lib/context.mjs'

async function main() {
  const { input, sessionId, actor } = await readHookEvent()

  // An interrupt is the user pressing escape, not the tooling fighting the agent.
  if (input.is_interrupt) return
  if (!input.tool_name) return

  // The session id keys the shared gate state, so without one the event is dropped.
  if (!sessionId) return
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
