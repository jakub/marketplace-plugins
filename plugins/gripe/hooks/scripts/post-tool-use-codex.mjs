#!/usr/bin/env node
// gripe: Codex PostToolUse adapter. This folds every completed tool call into bounded
// checkpoint state without parsing Codex's unstable transcript format.

import { observeToolResult, updateCheckpointState } from '../../lib/checkpoint.mjs'
import { safeId } from '../../lib/context.mjs'

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk

  let input
  try { input = JSON.parse(raw) } catch { return }

  const sessionId = safeId(input.session_id)
  // PostToolUse does not identify a subagent actor. Keep all Codex evidence in the
  // parent-session bucket even if a future payload happens to add an unrelated agent_id.
  const actor = 'main'
  const toolName = String(input.tool_name || '')
  if (!sessionId || !toolName) return

  updateCheckpointState(sessionId, actor, 'codex', (state) => {
    observeToolResult(state, {
      toolName,
      toolId: safeId(input.tool_use_id) ?? safeId(input.tool_call_id),
      toolInput: input.tool_input,
      // Codex CLI 0.149.1 (2026-08-26) supplied tool_response: "" for a Bash command
      // that exited 7. The documented field is model-facing output, not stable result
      // metadata, so do not infer failure from prose or guessed object keys.
      failureText: null,
    })
  })
}

main().catch(() => {})
