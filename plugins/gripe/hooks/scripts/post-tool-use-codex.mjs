#!/usr/bin/env node
// gripe: Codex PostToolUse adapter. This folds every completed tool call into bounded
// checkpoint state without parsing Codex's unstable transcript format.

import { observeToolResult, updateCheckpointState } from '../../lib/checkpoint.mjs'
import { readHookEvent } from '../../lib/context.mjs'

async function main() {
  const { input, sessionId } = await readHookEvent()

  // PostToolUse does not identify a subagent actor, so the event's own actor is ignored here:
  // all Codex evidence stays in the parent-session bucket even if a future payload happens to
  // add an unrelated agent_id.
  const actor = 'main'
  const toolName = String(input.tool_name || '')
  if (!sessionId || !toolName) return

  await updateCheckpointState(sessionId, actor, 'codex', (state) => {
    observeToolResult(state, {
      toolName,
      // No toolId: the tool_use_id map only serves Claude's transcript scanner, which
      // pairs a later tool_result with its call. Nothing on the Codex path reads it.
      toolInput: input.tool_input,
      // Codex CLI 0.149.1 (2026-08-26) supplied tool_response: "" for a Bash command
      // that exited 7. The documented field is model-facing output, not stable result
      // metadata, so do not infer failure from prose or guessed object keys.
      failureText: null,
    })
  })
}

main().catch(() => {})
