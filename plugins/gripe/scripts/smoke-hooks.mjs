#!/usr/bin/env node
// Cross-harness gripe hook smoke tests: the real hook scripts on stdin. All state lands in a
// throwaway directory, and GRIPE_HOME keeps SessionStart from publishing over the user's shim.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureContext } from '../lib/context.mjs'

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

// Every file the hooks have written so far, so a test can assert that a hostile id wrote
// nothing anywhere rather than guessing where it would have landed.
const filesUnder = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort()

try {
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

  // The harness picks the session id and gripe puts it in a gate filename. Before the
  // Claude adapters validated it, "../../x" wrote <state home>/x-main.json, two directories
  // above the gate. An id outside the safe alphabet now counts as absent, so the event is
  // dropped and nothing is written at all.
  const beforeTraversal = filesUnder(stateHome)
  const hostileId = '../../x'
  assert.equal(run('post-tool-use-failure.mjs', {
    session_id: hostileId, tool_name: 'Bash', tool_input: { command: 'ls' }, error: 'boom',
  }), null)
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
