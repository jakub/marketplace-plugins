#!/usr/bin/env node
// Validate the parallel Claude/Codex plugin manifests and every registered command path.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const marketplace = readJson(join(ROOT, '.claude-plugin', 'marketplace.json'))
const expected = new Map([
  ['flow', '0.20.0'],
  ['gripe', '0.2.0'],
  ['unslop', '0.4.0'],
])
const CODEX_EVENTS = new Set([
  'PermissionRequest', 'PostCompact', 'PostToolUse', 'PreCompact', 'PreToolUse',
  'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit',
])

assert.equal(marketplace.metadata.version, '0.29.0')
for (const [name, version] of expected) {
  const pluginRoot = join(ROOT, 'plugins', name)
  const claude = readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'))
  const codex = readJson(join(pluginRoot, '.codex-plugin', 'plugin.json'))
  const listed = marketplace.plugins.find((entry) => entry.name === name)

  assert.equal(claude.version, version, `${name} Claude version`)
  assert.equal(codex.version, version, `${name} Codex version`)
  assert.equal(listed?.version, version, `${name} marketplace version`)

  const hooksPath = join(pluginRoot, codex.hooks)
  assert.ok(existsSync(hooksPath), `${name} Codex hooks path`)
  const config = readJson(hooksPath)
  for (const [event, groups] of Object.entries(config.hooks)) {
    assert.ok(CODEX_EVENTS.has(event), `${name} uses supported Codex event ${event}`)
    for (const group of groups) {
      for (const handler of group.hooks) {
        assert.equal(handler.type, 'command')
        const match = handler.command.match(/\$\{PLUGIN_ROOT\}\/([^" ]+)/)
        assert.ok(match, `${name} command uses PLUGIN_ROOT: ${handler.command}`)
        assert.ok(existsSync(join(pluginRoot, match[1])), `${name} command target ${match[1]}`)
      }
    }
  }
}

console.log('parallel plugin manifests: ALL PASS')
