#!/usr/bin/env node
// Focused Codex hook smoke tests. These exercise the Codex wire adapters separately
// from the existing Claude hook tests while asserting both use the same policy.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const hook = (name, input = {}) => execFileSync(
  process.execPath,
  [join(ROOT, 'hooks', 'scripts', name)],
  { input: JSON.stringify(input), encoding: 'utf8' },
).trim()
const decision = (name, input) => {
  const output = hook(name, input)
  return output ? JSON.parse(output) : null
}
const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')

const protectedCases = [
  patch('*** Add File: .env', '+TOKEN=secret'),
  patch('*** Update File: src/main.mjs', '@@', '-old', '+new', '*** Update File: Cargo.lock', '@@', '-a', '+b'),
  patch('*** Update File: src/main.mjs', '*** Move to: dist/main.mjs', '@@', '-old', '+new'),
]
for (const command of protectedCases) {
  const output = decision('protect-files-codex.mjs', { tool_input: { command } })
  assert.equal(output?.hookSpecificOutput?.permissionDecision, 'deny')
}

const ordinary = decision('protect-files-codex.mjs', {
  tool_input: { command: patch('*** Add File: src/new.mjs', '+export const answer = 42') },
})
assert.equal(ordinary, null)

for (const command of [
  '*** Begin Patch\n*** Copy File: .env\n*** End Patch',
  '*** Begin Patch\n*** End Patch',
  '*** Begin Patch\n*** Add File: src/a.mjs\n+x',
]) {
  const output = decision('protect-files-codex.mjs', { tool_input: { command } })
  assert.equal(output?.hookSpecificOutput?.permissionDecision, 'deny')
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /enumerate every target/)
}

const publish = decision('publish-guard-codex.mjs', {
  tool_input: { command: 'cargo publish -p flow' },
})
assert.equal(publish?.hookSpecificOutput?.permissionDecision, 'deny')
assert.match(publish.hookSpecificOutput.permissionDecisionReason, /cannot request confirmation/)
assert.equal(decision('publish-guard-codex.mjs', {
  tool_input: { command: 'cargo publish --dry-run' },
}), null)
const mixedPublish = decision('publish-guard-codex.mjs', {
  tool_input: { command: 'cargo publish --dry-run && cargo publish' },
})
assert.equal(mixedPublish?.hookSpecificOutput?.permissionDecision, 'deny')

const charter = execFileSync(
  process.execPath,
  [join(ROOT, 'hooks', 'scripts', 'inject-charter-codex.mjs')],
  { env: { ...process.env, PLUGIN_ROOT: ROOT }, encoding: 'utf8' },
)
assert.equal(charter, readFileSync(join(ROOT, 'charter', 'charter.md'), 'utf8'))
assert.match(charter, /<flow-charter>/)
assert.match(charter, /<\/flow-charter>/)

console.log('flow Codex hooks: ALL PASS')
