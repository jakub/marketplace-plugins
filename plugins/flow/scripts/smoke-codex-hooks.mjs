#!/usr/bin/env node
// Focused Codex hook smoke tests. These exercise the Codex wire adapters separately
// from the existing Claude hook tests while asserting both use the same policy.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODEX_CHARTER_BYTE_BUDGET,
  CODEX_INLINE_BYTE_BUDGET,
  CODEX_PROFILE_BYTE_BUDGET,
  NO_BINDINGS_NOTE,
  profileBlock,
  readProfile,
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

// The Codex SessionStart payload is the charter, then a blank line, then the Codex binding
// profile. Building the expectation from the same lib the hook uses keeps this an equality
// check on the wiring, not a second copy of the block's shape.
const charterText = readFileSync(join(ROOT, 'charter', 'charter.md'), 'utf8')
const codexProfile = profileBlock(readProfile(ROOT, 'codex'))
const payload = execFileSync(
  process.execPath,
  [join(ROOT, 'hooks', 'scripts', 'inject-charter-codex.mjs')],
  { env: { ...process.env, PLUGIN_ROOT: ROOT }, encoding: 'utf8' },
)
assert.equal(payload, charterText + '\n' + codexProfile)
assert.match(payload, /<flow-charter>/)
assert.match(payload, /<\/flow-charter>/)
assert.match(payload, /<flow-profile host="codex" bindings="bound">/)
assert.ok(
  Buffer.byteLength(charterText) < CODEX_CHARTER_BYTE_BUDGET,
  `Flow charter exceeds the ${CODEX_CHARTER_BYTE_BUDGET}-byte Codex inline maintenance budget`,
)
assert.ok(
  Buffer.byteLength(codexProfile) <= CODEX_PROFILE_BYTE_BUDGET,
  `Codex binding profile exceeds the ${CODEX_PROFILE_BYTE_BUDGET}-byte budget`,
)
assert.ok(
  Buffer.byteLength(payload) < CODEX_INLINE_BYTE_BUDGET,
  `Codex SessionStart payload exceeds the ${CODEX_INLINE_BYTE_BUDGET}-byte inline maintenance budget`,
)

// A root with no charter/profiles/ directory still yields a block, and the block tells the
// session what it lost. This is the failure a silent read would hide. execFileSync throws on
// a non-zero exit, so reaching the assertions is itself the exit-0 check.
const bare = mkdtempSync(join(tmpdir(), 'flow-profile-'))
const missing = execFileSync(
  process.execPath,
  [join(ROOT, 'hooks', 'scripts', 'inject-profile.mjs'), 'codex'],
  { env: { ...process.env, CLAUDE_PLUGIN_ROOT: bare, PLUGIN_ROOT: bare }, encoding: 'utf8' },
)
assert.match(missing, /<flow-profile host="codex" bindings="none">/)
assert.ok(missing.includes(NO_BINDINGS_NOTE), 'a missing profile must carry the no-bindings note')
assert.match(missing, /<\/flow-profile>\n$/)

console.log('flow Codex hooks: ALL PASS')
