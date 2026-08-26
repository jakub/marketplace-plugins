#!/usr/bin/env node
// gripe: Codex PostToolUse adapter. Codex has no PostToolUseFailure event, so this
// observes every completed tool call, updates the harness-neutral checkpoint state,
// and applies the same repeat-gated failure policy used by Claude's failure hook.

import { loadCheckpointState, observeToolResult, saveCheckpointState } from '../../lib/checkpoint.mjs'
import { safeId } from '../../lib/context.mjs'
import { recordRepeatedFailure } from '../../lib/failure.mjs'

const boundedJson = (value) => {
  try { return JSON.stringify(value ?? '').slice(0, 4000) } catch { return String(value).slice(0, 4000) }
}

function failureText(response) {
  if (!response || typeof response !== 'object') return null

  if (
    response.isError === true || response.is_error === true || response.ok === false ||
    response.success === false || response.status === 'error' || response.status === 'failed' ||
    response.metadata?.status === 'error' || response.metadata?.status === 'failed'
  ) return boundedJson(response)

  const exitCodes = [
    response.exit_code, response.exitCode, response.metadata?.exit_code,
    response.metadata?.exitCode,
  ]
  if (exitCodes.some((code) => Number.isInteger(code) && code !== 0)) return boundedJson(response)
  return null
}

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

  const failed = failureText(input.tool_response)
  const state = loadCheckpointState(sessionId, actor, 'codex')
  observeToolResult(state, {
    toolName,
    toolId: safeId(input.tool_use_id) ?? safeId(input.tool_call_id),
    toolInput: input.tool_input,
    failureText: failed,
  })
  saveCheckpointState(sessionId, actor, 'codex', state)

  if (failed === null || input.is_interrupt) return
  const note = recordRepeatedFailure({
    sessionId,
    actor,
    toolName,
    error: failed,
    promptId: input.turn_id,
  })
  if (!note) return

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note },
  }))
}

main().catch(() => {})
