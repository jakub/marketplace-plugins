#!/usr/bin/env node
// Cross-harness gripe hook smoke tests. All state lands in a throwaway directory and
// GRIPE_HOME prevents SessionStart behavior from pointing the user's live shim here.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureContext } from '../lib/context.mjs'
import { target } from '../lib/gate.mjs'

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

function runAsync(name, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'hooks', 'scripts', name)], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status) => {
      try {
        assert.equal(status, 0, stderr)
        const output = stdout.trim()
        resolve(output ? JSON.parse(output) : null)
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

try {
  // Target extraction: wrapper shells and git's value-taking globals must not collapse
  // unrelated work onto one churn key, and apply_patch must aim at its first file.
  assert.equal(target('Bash', { command: 'sh -c "exit 7"' }), 'exit')
  assert.equal(target('Bash', { command: "bash -lc 'gh run watch 123'" }), 'gh run watch')
  assert.equal(target('Bash', { command: 'git -C /some/worktree diff --stat' }), 'git diff')
  assert.equal(target('Bash', { command: 'git status' }), 'git status')
  assert.equal(target('Bash', { command: 'gh run list' }), 'gh run list')
  assert.equal(
    target('apply_patch', { command: '*** Begin Patch\n*** Update File: src/x.mjs\n@@\n-a\n+b\n*** End Patch' }),
    'src/x.mjs',
  )

  const previousClaudeId = process.env.CLAUDE_CODE_SESSION_ID
  const previousCodexId = process.env.CODEX_SESSION_ID
  delete process.env.CLAUDE_CODE_SESSION_ID
  process.env.CODEX_SESSION_ID = 'codex-env-session'
  assert.equal(captureContext().session_id, 'codex-env-session')
  if (previousClaudeId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = previousClaudeId
  if (previousCodexId === undefined) delete process.env.CODEX_SESSION_ID
  else process.env.CODEX_SESSION_ID = previousCodexId

  const codexSubagent = run('subagent-start.mjs', {
    agent_id: 'codex-agent', turn_id: 'codex-turn',
  })
  assert.match(
    codexSubagent?.hookSpecificOutput?.additionalContext,
    /gripe add --agent codex-agent --prompt codex-turn/,
  )
  const claudeSubagent = run('subagent-start.mjs', {
    agent_id: 'claude-agent', prompt_id: 'claude-prompt', turn_id: 'ignored-turn',
  })
  assert.match(
    claudeSubagent?.hookSpecificOutput?.additionalContext,
    /gripe add --agent claude-agent --prompt claude-prompt/,
  )
  assert.doesNotMatch(claudeSubagent.hookSpecificOutput.additionalContext, /ignored-turn/)

  // Sanitized golden shape captured from Codex CLI 0.149.1 on 2026-08-26. The command
  // exited 7, but PostToolUse supplied no exit status, so this must not trigger a false
  // repeat-failure nudge. It still contributes tool-target evidence to the checkpoint.
  const failed = JSON.parse(readFileSync(
    join(ROOT, 'scripts', 'fixtures', 'codex-cli-0.149.1-post-tool-use-failed.json'),
    'utf8',
  ))
  for (let i = 0; i < 15; i++) {
    assert.equal(run('post-tool-use-codex.mjs', {
      ...failed,
      session_id: 'codex-checkpoint',
      tool_use_id: `call-${i}`,
    }), null)
  }
  const checkpoint = run('stop-checkpoint-codex.mjs', {
    session_id: 'codex-checkpoint', turn_id: 'turn-2', hook_event_name: 'Stop',
  })
  assert.equal(checkpoint?.decision, 'block')
  // The fixture command is `sh -c "exit 7"`; the citation must name the unwrapped
  // inner command, not the wrapper shell.
  assert.match(checkpoint.reason, /was aimed at "exit" 15 times/)
  assert.doesNotMatch(checkpoint.reason, /failed 15 times/)
  assert.equal(run('stop-checkpoint-codex.mjs', {
    session_id: 'codex-checkpoint', turn_id: 'turn-2', hook_event_name: 'Stop',
  }), null)

  const concurrent = await Promise.all(Array.from({ length: 20 }, (_, i) => runAsync(
    'post-tool-use-codex.mjs',
    {
      ...failed,
      session_id: 'codex-concurrent',
      tool_use_id: `concurrent-${i}`,
    },
  )))
  assert.deepEqual(concurrent, Array(20).fill(null))
  const concurrentCheckpoint = run('stop-checkpoint-codex.mjs', {
    session_id: 'codex-concurrent', turn_id: 'turn-concurrent', hook_event_name: 'Stop',
  })
  assert.match(concurrentCheckpoint?.reason, /was aimed at .* 20 times/)

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
