#!/usr/bin/env node
// Cross-harness gripe hook smoke tests: the real hook scripts on stdin. All state lands in a
// throwaway directory, and GRIPE_HOME keeps SessionStart from publishing over the user's shim.

import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { captureContext } from '../lib/context.mjs'
import { target } from '../lib/gate.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const stateHome = mkdtempSync(join(tmpdir(), 'gripe-hooks-'))
const env = { ...process.env, XDG_STATE_HOME: stateHome, GRIPE_HOME: ROOT }
const script = (name) => join(ROOT, 'hooks', 'scripts', name)
const parsed = (stdout) => (stdout.trim() ? JSON.parse(stdout) : null)

function run(name, input) {
  const result = spawnSync(process.execPath, [script(name)], { input: JSON.stringify(input), encoding: 'utf8', env })
  assert.equal(result.status, 0, result.stderr)
  return parsed(result.stdout)
}

// Rejects on a non-zero exit, so twenty of these in parallel also prove every hook exited 0.
async function runAsync(name, input) {
  const pending = promisify(execFile)(process.execPath, [script(name)], { env })
  pending.child.stdin.end(JSON.stringify(input))
  return parsed((await pending).stdout)
}

// Every file the hooks have written so far, so a test can assert that a hostile id wrote
// nothing anywhere rather than guessing where it would have landed.
const filesUnder = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort()

try {
  // Target extraction: wrapper shells and git's value-taking globals must not collapse
  // unrelated work onto one churn key, and apply_patch must aim at its first file.
  assert.equal(target('Bash', { command: 'sh -c "exit 7"' }), 'exit')
  assert.equal(target('Bash', { command: "bash -lc 'gh run watch 123'" }), 'gh run watch')
  assert.equal(target('Bash', { command: 'sh -c "gh pr view 9" argv0' }), 'gh pr view')
  assert.equal(target('Bash', { command: 'git -C /some/worktree diff --stat' }), 'git diff')
  assert.equal(target('Bash', { command: 'git -C "/tmp/work tree" status' }), 'git status')
  assert.equal(target('Bash', { command: 'gh run list' }), 'gh run list')
  assert.equal(
    target('apply_patch', { command: '*** Begin Patch\n*** Update File: src/x.mjs\n@@\n-a\n+b\n*** End Patch' }),
    'src/x.mjs',
  )
  // Bounded work on hostile input: deep wrapper nesting must return fast, not spin.
  const started = process.hrtime.bigint()
  target('Bash', { command: `${'sh -c '.repeat(20000)}true` })
  assert.ok(process.hrtime.bigint() - started < 500_000_000n, 'target() spent >500ms on nested wrappers')

  // A self-reported row keys to the Codex session when no Claude id is set. The hooks run
  // with `env`, copied above, so changing process.env here reaches nothing else.
  delete process.env.CLAUDE_CODE_SESSION_ID
  process.env.CODEX_SESSION_ID = 'codex-env-session'
  assert.equal(captureContext().session_id, 'codex-env-session')

  // SubagentStart bakes attribution into the recipe: Codex sends turn_id, Claude prompt_id.
  const codexSubagent = run('subagent-start.mjs', { agent_id: 'codex-agent', turn_id: 'codex-turn' })
  assert.match(codexSubagent?.hookSpecificOutput?.additionalContext, /gripe add --agent codex-agent --prompt codex-turn/)
  const claudeSubagent = run('subagent-start.mjs', {
    agent_id: 'claude-agent', prompt_id: 'claude-prompt', turn_id: 'ignored-turn',
  })
  assert.match(claudeSubagent?.hookSpecificOutput?.additionalContext, /gripe add --agent claude-agent --prompt claude-prompt/)
  assert.doesNotMatch(claudeSubagent.hookSpecificOutput.additionalContext, /ignored-turn/)

  // Sanitized golden shape captured from Codex CLI 0.149.1 on 2026-08-26. The command
  // exited 7, but PostToolUse supplied no exit status, so this must not trigger a false
  // repeat-failure nudge. It still contributes tool-target evidence to the checkpoint.
  const failed = JSON.parse(readFileSync(join(ROOT, 'scripts', 'fixtures', 'codex-cli-0.149.1-post-tool-use-failed.json'), 'utf8'))
  for (let i = 0; i < 15; i++) {
    assert.equal(run('post-tool-use-codex.mjs', { ...failed, session_id: 'codex-checkpoint', tool_use_id: `call-${i}` }), null)
  }
  const stop = { session_id: 'codex-checkpoint', turn_id: 'turn-2', hook_event_name: 'Stop' }
  const checkpoint = run('stop-checkpoint-codex.mjs', stop)
  assert.equal(checkpoint?.decision, 'block')
  // The citation names the unwrapped inner command, not the wrapper shell.
  assert.match(checkpoint.reason, /was aimed at "exit" 15 times/)
  assert.doesNotMatch(checkpoint.reason, /failed 15 times/)
  assert.equal(run('stop-checkpoint-codex.mjs', stop), null, 'the checkpoint asked twice in one session')

  // A lock orphaned by a killed holder must be broken by age, not honored forever.
  const scanDir = join(stateHome, 'gripe', 'scan')
  mkdirSync(scanDir, { recursive: true })
  const staleLock = join(scanDir, 'codex-codex-stale-main.json.lock')
  writeFileSync(staleLock, '')
  const past = (Date.now() - 60_000) / 1000
  utimesSync(staleLock, past, past)
  assert.equal(run('post-tool-use-codex.mjs', { ...failed, session_id: 'codex-stale', tool_use_id: 'stale-0' }), null)
  assert.ok(!existsSync(staleLock), 'stale lock was not broken')
  assert.ok(existsSync(join(scanDir, 'codex-codex-stale-main.json')), 'no checkpoint state after breaking the lock')

  // Twenty concurrent PostToolUse hooks on one session must not drop each other's counts.
  const concurrent = await Promise.all(Array.from({ length: 20 }, (_, i) => runAsync(
    'post-tool-use-codex.mjs', { ...failed, session_id: 'codex-concurrent', tool_use_id: `concurrent-${i}` },
  )))
  assert.deepEqual(concurrent, Array(20).fill(null))
  const concurrentCheckpoint = run('stop-checkpoint-codex.mjs', {
    session_id: 'codex-concurrent', turn_id: 'turn-concurrent', hook_event_name: 'Stop',
  })
  assert.match(concurrentCheckpoint?.reason, /was aimed at .* 20 times/)

  // Claude's error nudge fires on the second identical failure, and only once.
  const claudeFailure = {
    session_id: 'claude-repeat', prompt_id: 'prompt-1', tool_name: 'Bash',
    tool_input: { command: 'cargo test' }, error: 'Process exited with code 1',
  }
  assert.equal(run('post-tool-use-failure.mjs', claudeFailure), null)
  const claudeRepeat = run('post-tool-use-failure.mjs', claudeFailure)
  assert.equal(claudeRepeat?.hookSpecificOutput?.hookEventName, 'PostToolUseFailure')
  assert.match(claudeRepeat.hookSpecificOutput.additionalContext, /failed 2 times/)
  assert.match(claudeRepeat.hookSpecificOutput.additionalContext, /--via error_nudge --trigger Bash --prompt prompt-1/)
  assert.equal(run('post-tool-use-failure.mjs', claudeFailure), null, 'the nudge fired twice for one fingerprint')

  // Claude's checkpoint reads the transcript, for Stop and for SubagentStop.
  const transcript = join(stateHome, 'claude-transcript.jsonl')
  const toolUse = (i) => JSON.stringify({
    message: { content: [{ type: 'tool_use', id: `tool-${i}`, name: 'Bash', input: { command: 'gh run watch 123' } }] },
  })
  writeFileSync(transcript, `${Array.from({ length: 15 }, (_, i) => toolUse(i)).join('\n')}\n`)
  const claudeCheckpoint = run('stop-checkpoint.mjs', {
    session_id: 'claude-checkpoint', prompt_id: 'prompt-2', transcript_path: transcript, hook_event_name: 'Stop',
  })
  assert.equal(claudeCheckpoint?.hookSpecificOutput?.hookEventName, 'Stop')
  assert.match(claudeCheckpoint.hookSpecificOutput.additionalContext, /15 times/)
  const subagentCheckpoint = run('stop-checkpoint.mjs', {
    session_id: 'claude-subagent', prompt_id: 'prompt-3', agent_id: 'agent-1',
    agent_transcript_path: transcript, hook_event_name: 'SubagentStop',
  })
  assert.equal(subagentCheckpoint?.hookSpecificOutput?.hookEventName, 'SubagentStop')
  assert.match(subagentCheckpoint.hookSpecificOutput.additionalContext, /--agent agent-1/)

  // The harness picks the session id and gripe puts it in a gate filename. Before the
  // Claude adapters validated it, "../../x" wrote <state home>/x-main.json, two directories
  // above the gate. An id outside the safe alphabet now counts as absent, so the event is
  // dropped and nothing is written at all.
  const beforeTraversal = filesUnder(stateHome)
  const hostileId = '../../x'
  assert.equal(run('post-tool-use-failure.mjs', {
    session_id: hostileId, tool_name: 'Bash', tool_input: { command: 'ls' }, error: 'boom',
  }), null)
  assert.equal(run('stop-checkpoint.mjs', { session_id: hostileId, transcript_path: transcript, hook_event_name: 'Stop' }), null)
  assert.deepEqual(filesUnder(stateHome), beforeTraversal, 'an unsafe session id wrote a file')

  // StopFailure is the observed lane: a templated row that never stores the last message.
  run('stop-failure.mjs', { session_id: 'claude-failed', error: 'rate limit', last_assistant_message: 'sk-SECRET' })
  process.env.XDG_STATE_HOME = stateHome
  const store = await import('../lib/store.mjs')
  const db = store.openStore()
  const rows = db.prepare("SELECT elicitation, body FROM gripes WHERE session_id = 'claude-failed'").all()
  db.close()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].elicitation, 'observed')
  assert.match(rows[0].body, /rate limit/)
  assert.doesNotMatch(rows[0].body, /SECRET/)

  console.log('gripe cross-harness hooks: ALL PASS')
} finally {
  rmSync(stateHome, { recursive: true, force: true })
}
