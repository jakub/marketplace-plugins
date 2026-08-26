#!/usr/bin/env node
// Cross-harness gripe hook smoke tests. All state lands in a throwaway directory and
// GRIPE_HOME prevents SessionStart behavior from pointing the user's live shim here.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureContext } from '../lib/context.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const stateHome = mkdtempSync(join(tmpdir(), 'gripe-hooks-'))
const env = { ...process.env, XDG_STATE_HOME: stateHome, GRIPE_HOME: ROOT }

function run(name, input) {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'hooks', 'scripts', name)],
    { input: JSON.stringify(input), encoding: 'utf8', env },
  )
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const output = result.stdout.trim()
  return output ? JSON.parse(output) : null
}

try {
  const previousClaudeId = process.env.CLAUDE_CODE_SESSION_ID
  const previousCodexId = process.env.CODEX_SESSION_ID
  delete process.env.CLAUDE_CODE_SESSION_ID
  process.env.CODEX_SESSION_ID = 'codex-env-session'
  assert.equal(captureContext().session_id, 'codex-env-session')
  if (previousClaudeId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = previousClaudeId
  if (previousCodexId === undefined) delete process.env.CODEX_SESSION_ID
  else process.env.CODEX_SESSION_ID = previousCodexId

  const failed = {
    session_id: 'codex-repeat',
    turn_id: 'turn-1',
    tool_name: 'Bash',
    tool_use_id: 'call-1',
    tool_input: { command: 'cargo test' },
    tool_response: { output: 'failed', metadata: { exit_code: 1 } },
  }
  assert.equal(run('post-tool-use-codex.mjs', failed), null)
  const repeat = run('post-tool-use-codex.mjs', { ...failed, tool_use_id: 'call-2' })
  assert.equal(repeat?.hookSpecificOutput?.hookEventName, 'PostToolUse')
  assert.match(repeat.hookSpecificOutput.additionalContext, /failed 2 times/)
  assert.equal(run('post-tool-use-codex.mjs', { ...failed, tool_use_id: 'call-3' }), null)

  const successful = {
    session_id: 'codex-checkpoint',
    turn_id: 'turn-2',
    tool_name: 'Bash',
    tool_input: { command: 'gh run watch 123' },
    tool_response: { output: 'complete', metadata: { exit_code: 0 } },
  }
  for (let i = 0; i < 15; i++) {
    assert.equal(run('post-tool-use-codex.mjs', { ...successful, tool_use_id: `call-${i}` }), null)
  }
  const checkpoint = run('stop-checkpoint-codex.mjs', {
    session_id: 'codex-checkpoint', turn_id: 'turn-2', hook_event_name: 'Stop',
  })
  assert.equal(checkpoint?.decision, 'block')
  assert.match(checkpoint.reason, /was aimed at "gh run watch" 15 times/)
  assert.equal(run('stop-checkpoint-codex.mjs', {
    session_id: 'codex-checkpoint', turn_id: 'turn-2', hook_event_name: 'Stop',
  }), null)

  const claudeFailure = {
    session_id: 'claude-repeat',
    prompt_id: 'prompt-1',
    tool_name: 'Bash',
    tool_input: { command: 'cargo test' },
    error: 'Process exited with code 1',
  }
  assert.equal(run('post-tool-use-failure.mjs', claudeFailure), null)
  const claudeRepeat = run('post-tool-use-failure.mjs', claudeFailure)
  assert.equal(claudeRepeat?.hookSpecificOutput?.hookEventName, 'PostToolUseFailure')
  assert.match(claudeRepeat.hookSpecificOutput.additionalContext, /failed 2 times/)

  const transcript = join(stateHome, 'claude-transcript.jsonl')
  const lines = []
  for (let i = 0; i < 15; i++) {
    lines.push(JSON.stringify({
      message: {
        content: [{
          type: 'tool_use', id: `tool-${i}`, name: 'Bash',
          input: { command: 'gh run watch 123' },
        }],
      },
    }))
  }
  writeFileSync(transcript, `${lines.join('\n')}\n`)
  const claudeCheckpoint = run('stop-checkpoint.mjs', {
    session_id: 'claude-checkpoint', prompt_id: 'prompt-2', transcript_path: transcript,
    hook_event_name: 'Stop',
  })
  assert.equal(claudeCheckpoint?.hookSpecificOutput?.hookEventName, 'Stop')
  assert.match(claudeCheckpoint.hookSpecificOutput.additionalContext, /15 times/)

  const subagentCheckpoint = run('stop-checkpoint.mjs', {
    session_id: 'claude-subagent', prompt_id: 'prompt-3', agent_id: 'agent-1',
    agent_transcript_path: transcript, hook_event_name: 'SubagentStop',
  })
  assert.equal(subagentCheckpoint?.hookSpecificOutput?.hookEventName, 'SubagentStop')
  assert.match(subagentCheckpoint.hookSpecificOutput.additionalContext, /--agent agent-1/)

  console.log('gripe cross-harness hooks: ALL PASS')
} finally {
  rmSync(stateHome, { recursive: true, force: true })
}
