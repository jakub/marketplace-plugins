#!/usr/bin/env node
// Cross-harness unslop injection tests. The vendored skill is only read, never copied.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
function run(args, input = {}) {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'hooks', 'scripts', 'inject-unslop.mjs'), ...args],
    { input: JSON.stringify(input), encoding: 'utf8' },
  )
  assert.equal(result.error, undefined)
  return result
}

const claudeSession = run(['session', 'claude'])
const codexSession = run(['session', 'codex'])
assert.equal(claudeSession.status, 0)
assert.equal(codexSession.status, 0)
assert.equal(codexSession.stdout, claudeSession.stdout)
assert.match(codexSession.stdout, /^<unslop>/)
assert.ok(Buffer.byteLength(codexSession.stdout) < 10_000)

const codexSubagent = run(['subagent', 'codex'], { agent_type: 'general-purpose' })
assert.equal(codexSubagent.status, 0)
const output = JSON.parse(codexSubagent.stdout)
assert.equal(output.hookSpecificOutput.hookEventName, 'SubagentStart')
assert.match(output.hookSpecificOutput.additionalContext, /^<unslop>/)
assert.ok(Buffer.byteLength(codexSubagent.stdout) < 10_000)

assert.equal(run(['subagent', 'claude'], { agent_type: 'Explore' }).stdout, '')
assert.equal(run(['subagent', 'claude'], { agent_type: 'fork' }).stdout, '')
// Everything outside the skip set gets the rules, ad-hoc general-purpose spawns included.
assert.notEqual(run(['subagent', 'claude'], { agent_type: 'general-purpose' }).stdout, '')
// Every skip is justified by a Claude mechanism; a Codex seat with the same name gets
// the rules until a Codex capture proves the skip safe there too.
assert.notEqual(run(['subagent', 'codex'], { agent_type: 'Explore' }).stdout, '')
assert.notEqual(run(['subagent', 'codex'], { agent_type: 'fork' }).stdout, '')

const invalid = run(['session', 'other'])
assert.equal(invalid.status, 2)
assert.match(invalid.stderr, /expected source/)

console.log('unslop cross-harness hooks: ALL PASS')
