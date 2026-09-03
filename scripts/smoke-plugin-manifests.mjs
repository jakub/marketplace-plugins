#!/usr/bin/env node
// Validate the Claude and Codex plugin manifests and every registered hook command path.
// Versions and descriptions are derived from the marketplace manifest, not pinned here: the
// invariant is that a plugin's Claude manifest, its Codex manifest when it has one, and its
// marketplace entry all agree. The version is what both plugin managers name a cache directory
// after; the description is what a human reads in a listing, and it forked once unwatched.
// A release of a dual-harness plugin is those three edits and nothing else - the marketplace
// manifest carries no catalog version, because no software reads one.

import assert from 'node:assert/strict'
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

assert.ok(marketplace.plugins.length > 0, 'marketplace lists plugins')
const codexPlugins = []

for (const listed of marketplace.plugins) {
  const { name } = listed
  const pluginRoot = join(ROOT, 'plugins', name)
  const claude = readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'))
  assert.equal(claude.version, listed.version, `${name} Claude version matches marketplace`)
  assert.equal(claude.description, listed.description, `${name} Claude description matches marketplace`)
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

  // Every ${CLAUDE_PLUGIN_ROOT} path Claude will run has to resolve inside the plugin. Claude
  // finds hooks/hooks.json by convention, so the file's presence is the registration.
  const claudeHooks = join(pluginRoot, 'hooks', 'hooks.json')
  if (existsSync(claudeHooks)) {
    for (const [event, groups] of Object.entries(readJson(claudeHooks).hooks)) {
      for (const group of groups) {
        for (const handler of group.hooks) {
          assert.equal(handler.type, 'command', `${name} Claude ${event} handler is a command`)
          const match = handler.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"' ]+)/)
          assert.ok(match, `${name} Claude command uses CLAUDE_PLUGIN_ROOT: ${handler.command}`)
          assert.ok(existsSync(join(pluginRoot, match[1])), `${name} Claude command target ${match[1]}`)
        }
      }
    }
  }

  // Codex finds skills/*/SKILL.md on its own, so a plugin that ships nothing but skills needs
  // no Codex manifest and does not carry one. Hooks and MCP servers are the other way round:
  // Codex reads them only out of .codex-plugin/plugin.json, so a plugin that registers either
  // one without that manifest silently loses it on Codex.
  const registersOnCodex = existsSync(join(pluginRoot, 'hooks', 'codex.json')) ||
    existsSync(join(pluginRoot, '.mcp.json'))
  const codexManifest = join(pluginRoot, '.codex-plugin', 'plugin.json')
  const skillsRoot = join(pluginRoot, 'skills')
  const skills = existsSync(skillsRoot)
    ? readdirSync(skillsRoot).filter((dir) => existsSync(join(skillsRoot, dir, 'SKILL.md')))
    : []

  if (!existsSync(codexManifest)) {
    assert.ok(!registersOnCodex, `${name} registers Codex hooks or an MCP server and needs a Codex manifest`)
    assert.ok(skills.length > 0, `${name} has no Codex manifest, so skills are all it can contribute there`)
    continue
  }

  codexPlugins.push(name)
  const codex = readJson(codexManifest)
  assert.equal(codex.version, listed.version, `${name} Codex version matches marketplace`)
  assert.equal(codex.description, listed.description, `${name} Codex description matches marketplace`)
  assert.ok(
    codex.hooks !== undefined || codex.mcpServers !== undefined,
    `${name} Codex manifest registers hooks or an MCP server; skills alone need no manifest`,
  )
  if (codex.hooks === undefined) continue

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

// flow, gripe and unslop all register Codex hooks. The set shrinking would mean a Codex
// manifest moved or was renamed without this test noticing; that is a failure, not an empty
// success. grill is deliberately outside it, shipping skills alone.
assert.ok(codexPlugins.length >= 3, `expected at least 3 Codex manifests, found ${codexPlugins.length}`)

console.log('parallel plugin manifests: ALL PASS')
