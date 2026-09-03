#!/usr/bin/env node
// The transport seat is a mechanism only because its tool list is exact: the flow_delegate
// tools and ToolSearch to load them, nothing that reads a file, runs a shell, or spawns. This
// checks agents/bridge.md keeps that list and the verbatim-return rule, and proves the check
// still fails on an inline drift.
// Run: node plugins/flow/scripts/smoke-bridge-seat.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

console.log(`\nbridge seat: ALL PASS (${passed} checks)`)
