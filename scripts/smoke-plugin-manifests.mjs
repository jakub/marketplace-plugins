#!/usr/bin/env node
// Validate the parallel Claude/Codex plugin manifests and every registered command path.
// Versions are derived from the marketplace manifest, not pinned here: the invariant is
// that every listed plugin's Claude manifest, Codex manifest (when present), and
// marketplace entry agree, so a release stays the four documented edits.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const marketplace = readJson(join(ROOT, '.claude-plugin', 'marketplace.json'))
const CODEX_EVENTS = new Set([
  'PermissionRequest', 'PostCompact', 'PostToolUse', 'PreCompact', 'PreToolUse',
  'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit',
])

assert.match(marketplace.metadata.version, /^\d+\.\d+\.\d+$/, 'catalog version is semver')
assert.ok(marketplace.plugins.length > 0, 'marketplace lists plugins')
const codexPlugins = []

for (const listed of marketplace.plugins) {
  const { name } = listed
  const pluginRoot = join(ROOT, 'plugins', name)
  const claude = readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'))
  assert.equal(claude.version, listed.version, `${name} Claude version matches marketplace`)
  if (name === 'flow') {
    const claudeDelegation = claude.mcpServers?.flow_delegate
    assert.deepEqual(claudeDelegation?.args?.slice(-2), ['--host', 'claude'], 'flow Claude MCP pins its host')
    assert.equal(claudeDelegation?.timeout, 7_500_000, 'flow Claude MCP timeout outlives the maximum job budget')
    const codexDelegation = readJson(join(pluginRoot, '.mcp.json')).flow_delegate
    assert.deepEqual(codexDelegation?.args?.slice(-2), ['--host', 'codex'], 'flow Codex MCP pins its host')
    assert.equal(codexDelegation?.tool_timeout_sec, 7_500, 'flow Codex MCP timeout outlives the maximum job budget')
    // Codex hands a stdio MCP server a curated environment (HOME, PATH, TERM and a few more), and
    // systemd-run --user needs the runtime dir to find the user bus. Without the first two, every
    // provider scope fails with CONTAINMENT_UNAVAILABLE and the Codex host cannot delegate at all.
    // PWD is the shell's cwd when the human launched codex, and it is the only host-derived
    // workspace signal Codex 0.151 gives a plugin MCP server: the client advertises no roots
    // capability and Codex sets no project-dir variable, so without PWD every tool call fails
    // with NO_ROOTS.
    assert.deepEqual(codexDelegation?.env_vars, ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'PWD'], 'flow Codex MCP passes the user-bus environment and the launch cwd through')
  }

  const codexManifest = join(pluginRoot, '.codex-plugin', 'plugin.json')
  if (!existsSync(codexManifest)) continue
  codexPlugins.push(name)
  const codex = readJson(codexManifest)
  assert.equal(codex.version, listed.version, `${name} Codex version matches marketplace`)

  // Codex finds skills/*/SKILL.md on its own, so a skills-only plugin registers no hooks
  // and needs no key for them. What it must not be is empty: a Codex manifest that
  // registers nothing and ships no skill contributes nothing, and is a typo.
  if (codex.hooks === undefined) {
    const skillsRoot = join(pluginRoot, 'skills')
    const skills = existsSync(skillsRoot)
      ? readdirSync(skillsRoot).filter((dir) => existsSync(join(skillsRoot, dir, 'SKILL.md')))
      : []
    assert.ok(skills.length > 0, `${name} Codex manifest without hooks ships at least one skill`)
    continue
  }

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

// The dual-harness set shrinking to zero would mean the Codex manifests moved or were
// renamed without this test noticing; that is a failure, not an empty success.
assert.ok(codexPlugins.length >= 4, `expected at least 4 Codex-capable plugins, found ${codexPlugins.length}`)
assert.ok(codexPlugins.includes('grill'), 'grill carries a Codex manifest')

// The catalog version must move whenever the plugin set or a listed version moves.
// Parity alone cannot prove that, so compare against main's committed manifest when
// the ref is available; without one (shallow CI clone) the check is skipped.
let baseline = null
try {
  baseline = JSON.parse(execFileSync(
    'git', ['-C', ROOT, 'show', 'main:.claude-plugin/marketplace.json'], { encoding: 'utf8' },
  ))
} catch {}
if (baseline && baseline.metadata.version !== marketplace.metadata.version) {
  // Catalog already bumped relative to main; nothing further to prove.
} else if (baseline) {
  const drifted = marketplace.plugins.length !== baseline.plugins.length ||
    marketplace.plugins.some((entry) =>
      baseline.plugins.find((b) => b.name === entry.name)?.version !== entry.version)
  assert.ok(!drifted, 'a listed plugin version changed against main but the catalog version did not move')
}

console.log('parallel plugin manifests: ALL PASS')
