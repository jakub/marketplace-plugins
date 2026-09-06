#!/usr/bin/env node
// The transport seat is a mechanism only because its tool list is exact: the flow_delegate
// tools and ToolSearch to load them, nothing that reads a file, runs a shell, or spawns. This
// checks the tool list, verbatim-return rule, fixed transport defaults and native spawn hook.
// Exercise caller overrides and malformed installs without starting a model or delegation.
// Run: node plugins/flow/scripts/smoke-bridge-seat.mjs

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWED = [
  'ToolSearch',
  'mcp__plugin_flow_flow_delegate__delegate_to_codex',
  'mcp__plugin_flow_flow_delegate__delegation_cancel',
  'mcp__plugin_flow_flow_delegate__delegation_continue',
  'mcp__plugin_flow_flow_delegate__delegation_events',
  'mcp__plugin_flow_flow_delegate__delegation_result',
  'mcp__plugin_flow_flow_delegate__delegation_status',
  'mcp__plugin_flow_flow_delegate__delegation_steer',
]

const problems = (text) => {
  const out = []
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!frontmatter) return ['the definition has no frontmatter']
  if (!/^model: sonnet$/m.test(frontmatter[1])) out.push('the transport model must be sonnet')
  if (!/^effort: low$/m.test(frontmatter[1])) out.push('the transport effort must be low')
  const toolsLine = frontmatter[1].split('\n').find((line) => line.startsWith('tools:'))
  if (!toolsLine) return ['the frontmatter has no tools: line, so the seat inherits every tool']
  const tools = toolsLine.slice(6).split(',').map((tool) => tool.trim()).filter(Boolean)
  for (const tool of tools) if (!ALLOWED.includes(tool)) out.push(`tools: carries ${tool}, which is not a flow_delegate tool`)
  for (const tool of ALLOWED) if (!tools.includes(tool)) out.push(`tools: lacks ${tool}`)
  if (!/verbatim/.test(text)) out.push('the body never says the envelope is returned verbatim')
  if (!/[Nn]ever summari[sz]e/.test(text)) out.push('the body never forbids summarising the result')
  return out
}

let passed = 0
const ok = (message) => { passed += 1; console.log(`  ok: ${message}`) }

const real = readFileSync(join(ROOT, 'agents', 'bridge.md'), 'utf8')
assert.deepEqual(problems(real), [], problems(real).join('\n'))
ok(`agents/bridge.md lists exactly the ${ALLOWED.length} transport tools and returns the envelope verbatim`)

const withBash = real.replace('tools: ToolSearch,', 'tools: Bash, ToolSearch,')
assert.deepEqual(problems(withBash), ['tools: carries Bash, which is not a flow_delegate tool'])
ok('the checker fails a seat that gains a shell and names the tool')

const withoutRule = real.replaceAll('verbatim', 'as-is')
assert.ok(problems(withoutRule).some((p) => p.includes('verbatim')), 'the checker must notice the verbatim rule is gone')
ok('the checker fails a seat whose body drops the verbatim rule')

for (const [before, after, reason] of [
  ['model: sonnet', 'model: inherit', 'the transport model must be sonnet'],
  ['model: sonnet\n', '', 'the transport model must be sonnet'],
  ['effort: low', 'effort: high', 'the transport effort must be low'],
  ['effort: low\n', '', 'the transport effort must be low'],
]) {
  assert.deepEqual(problems(real.replace(before, after)), [reason])
}
ok('inherited models and missing or expensive transport settings fail conformance')

const runHook = (input, root = ROOT) => {
  const run = spawnSync(process.execPath, [join(root, 'hooks/scripts/bridge-model.mjs')], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout.trim() ? JSON.parse(run.stdout) : null
}
const call = {
  hook_event_name: 'PreToolUse', tool_name: 'Agent',
  tool_input: {
    subagent_type: 'flow:bridge', model: 'fable',
    prompt: '{"model":"gpt-6-astra","effort":"high","delivery":"attached"}',
    description: 'Run the coding worker', run_in_background: true,
  },
}
for (const model of ['fable', 'opus', 'inherit', undefined]) {
  const input = { ...call.tool_input, model }
  const result = runHook({ ...call, tool_input: input })
  assert.deepEqual(result, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', updatedInput: { ...input, model: 'sonnet' },
    },
  })
}
ok('native overrides and omitted models become sonnet without changing worker arguments or granting permission')

for (const input of [
  '', '{broken', null, {},
  { ...call, tool_input: { ...call.tool_input, model: 'sonnet' } },
  { ...call, tool_input: { ...call.tool_input, subagent_type: 'flow:implementer' } },
  { ...call, tool_input: { ...call.tool_input, subagent_type: 'other:bridge' } },
  { ...call, tool_name: 'Workflow' },
  { ...call, tool_name: 'mcp__plugin_flow_flow_delegate__delegate_to_codex' },
  { ...call, hook_event_name: 'PostToolUse' },
]) assert.equal(runHook(input), null)
ok('other seats, direct worker calls, Workflow and malformed hook events are untouched')

const root = mkdtempSync(join(tmpdir(), 'flow-bridge-binding-'))
try {
  mkdirSync(join(root, 'hooks/scripts'), { recursive: true })
  mkdirSync(join(root, 'agents'))
  for (const file of ['bridge-model.mjs', 'wire.mjs']) {
    copyFileSync(join(ROOT, 'hooks/scripts', file), join(root, 'hooks/scripts', file))
  }
  for (const definition of [null, real.replace('model: sonnet\n', ''), real.replace('model: sonnet', 'model: inherit')]) {
    if (definition !== null) writeFileSync(join(root, 'agents/bridge.md'), definition)
    const result = runHook(call, root).hookSpecificOutput
    assert.equal(result.permissionDecision, 'deny')
    assert.match(result.permissionDecisionReason, /explicit model/)
  }
  writeFileSync(join(root, 'agents/bridge.md'), real.replace('model: sonnet', 'model: opus'))
  assert.equal(runHook(call, root).hookSpecificOutput.updatedInput.model, 'opus')
  ok('the hook reads the shipped definition and denies a missing or unbound definition')
} finally { rmSync(root, { recursive: true, force: true }) }

const registration = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8'))
const bindings = registration.hooks.PreToolUse.filter((entry) => entry.hooks.some((hook) => hook.command.includes('/bridge-model.mjs')))
assert.equal(bindings.length, 1)
assert.equal(bindings[0].matcher, 'Agent')
assert.ok(!readFileSync(join(ROOT, 'hooks/codex.json'), 'utf8').includes('bridge-model.mjs'))
ok('the model hook is registered once for Claude Agent calls and never for Codex')

console.log(`\nbridge seat: ALL PASS (${passed} checks)`)
