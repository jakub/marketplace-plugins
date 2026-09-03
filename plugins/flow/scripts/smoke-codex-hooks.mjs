#!/usr/bin/env node
// Focused Codex hook smoke tests. These exercise the Codex wire adapters separately
// from the existing Claude hook tests while asserting both use the same policy.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODEX_CHARTER_BYTE_BUDGET,
  CODEX_INLINE_BYTE_BUDGET,
  seatPayload,
} from '../lib/charter-payload.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const rawHook = (name, input) => execFileSync(
  process.execPath,
  [join(ROOT, 'hooks', 'scripts', name)],
  { input, encoding: 'utf8' },
).trim()
const hook = (name, input = {}) => rawHook(name, JSON.stringify(input))
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

// CRLF is a line ending, not tampering: an ordinary CRLF envelope passes, a protected
// target inside one is still caught.
assert.equal(decision('protect-files-codex.mjs', {
  tool_input: { command: patch('*** Add File: src/win.mjs', '+ok').replaceAll('\n', '\r\n') },
}), null)
assert.equal(decision('protect-files-codex.mjs', {
  tool_input: { command: patch('*** Add File: .env', '+TOKEN=x').replaceAll('\n', '\r\n') },
})?.hookSpecificOutput?.permissionDecision, 'deny')

// An alias route with a plain file_path is checked directly, not treated as a patch.
assert.equal(decision('protect-files-codex.mjs', {
  tool_input: { file_path: '.env' },
})?.hookSpecificOutput?.permissionDecision, 'deny')
assert.equal(decision('protect-files-codex.mjs', {
  tool_input: { file_path: 'src/ok.mjs' },
}), null)

// A benign file_path must not vouch for a patch riding in the same envelope, and two
// deniable fields still produce exactly one valid decision.
assert.equal(decision('protect-files-codex.mjs', {
  tool_input: { file_path: 'src/ok.mjs', command: patch('*** Add File: .env', '+TOKEN=x') },
})?.hookSpecificOutput?.permissionDecision, 'deny')
assert.equal(decision('protect-files-codex.mjs', {
  tool_input: { file_path: '.env', command: patch('*** Add File: .env.production', '+TOKEN=x') },
})?.hookSpecificOutput?.permissionDecision, 'deny')
assert.equal(decision('protect-files-codex.mjs', {
  tool_input: {},
})?.hookSpecificOutput?.permissionDecision, 'deny')

for (const command of [
  '*** Begin Patch\n*** Copy File: .env\n*** End Patch',
  '*** Begin Patch\n*** Remove: .env\n*** Add File: src/a.mjs\n+x\n*** End Patch',
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
assert.equal(decision('publish-guard-codex.mjs', {
  tool_input: { command: 'npm publish \\\n  --dry-run' },
}), null)
assert.equal(decision('publish-guard-codex.mjs', {
  tool_input: { command: 'npm publish 2>&1 --dry-run' },
}), null)
const mixedPublish = decision('publish-guard-codex.mjs', {
  tool_input: { command: 'cargo publish --dry-run && cargo publish' },
})
assert.equal(mixedPublish?.hookSpecificOutput?.permissionDecision, 'deny')
for (const output of [
  decision('publish-guard-codex.mjs', {}),
  JSON.parse(rawHook('publish-guard-codex.mjs', '{')),
]) {
  assert.equal(output?.hookSpecificOutput?.permissionDecision, 'deny')
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /without an inspectable command/)
}

// Codex takes the whole charter in one SessionStart write, and the seat half again at the start
// of every subagent. Both registrations live in hooks/codex.json; these run the same script the
// same way, so this is an equality check on the wiring rather than a second copy of the shape.
const charterText = readFileSync(join(ROOT, 'charter', 'charter.md'), 'utf8')
const inject = (args, input = '') => execFileSync(
  process.execPath,
  [join(ROOT, 'hooks', 'scripts', 'inject-charter.mjs'), ...args],
  { env: { ...process.env, PLUGIN_ROOT: ROOT }, encoding: 'utf8', input },
)

const registered = JSON.parse(readFileSync(join(ROOT, 'hooks', 'codex.json'), 'utf8')).hooks
for (const [event, args, limit] of [['SessionStart', 'session codex', 8000], ['SubagentStart', 'subagent codex', 3000]]) {
  const entry = registered[event]?.[0]?.hooks?.[0]
  assert.ok(entry, `hooks/codex.json registers no ${event} charter hook`)
  assert.equal(entry.command, `node "\${PLUGIN_ROOT}/hooks/scripts/inject-charter.mjs" ${args}`)
  assert.equal(entry.additionalContextLimit, limit)
}

const payload = inject(['session', 'codex'])
assert.equal(payload, charterText)
assert.match(payload, /<flow-charter>/)
assert.match(payload, /<\/flow-charter>/)
assert.ok(
  Buffer.byteLength(charterText) < CODEX_CHARTER_BYTE_BUDGET,
  `Flow charter exceeds the ${CODEX_CHARTER_BYTE_BUDGET}-byte Codex inline maintenance budget`,
)
assert.ok(
  Buffer.byteLength(payload) < CODEX_INLINE_BYTE_BUDGET,
  `Codex SessionStart payload exceeds the ${CODEX_INLINE_BYTE_BUDGET}-byte inline maintenance budget`,
)

// Codex has no Explore type and no context-copying fork, so there is nothing to skip: every
// subagent gets the seat half, whatever it calls itself, and an unparseable body still delivers.
const seat = seatPayload(charterText)
for (const input of [JSON.stringify({ agent_type: 'Explore' }), JSON.stringify({ agent_type: 'fork' }), JSON.stringify({}), '{']) {
  const answer = JSON.parse(inject(['subagent', 'codex'], input))
  assert.equal(answer.hookSpecificOutput.hookEventName, 'SubagentStart')
  assert.equal(answer.hookSpecificOutput.additionalContext, seat)
}

console.log('flow Codex hooks: ALL PASS')
