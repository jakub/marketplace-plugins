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
    // Both hosts run the same delegate/main.mjs: Claude by plugin-root path, Codex through the
    // bin/flow-delegate dispatcher on PATH, which resolves the cache copy named by --flow-version.
    const claudeDelegation = claude.mcpServers?.flow_delegate
    assert.equal(claudeDelegation?.command, 'node', 'flow Claude MCP runs under node')
    assert.deepEqual(claudeDelegation?.args, ['${CLAUDE_PLUGIN_ROOT}/delegate/main.mjs', 'mcp', '--host', 'claude'], 'flow Claude MCP runs the delegate server for its host')
    assert.ok(existsSync(join(pluginRoot, 'delegate', 'main.mjs')), 'flow delegate entry exists')
    assert.equal(claudeDelegation?.timeout, 7_500_000, 'flow Claude MCP timeout outlives the maximum job budget')
    const codexDelegation = readJson(join(pluginRoot, '.mcp.json')).flow_delegate
    assert.equal(codexDelegation.command, 'flow-delegate', 'flow Codex MCP uses the installed dispatcher')
    assert.ok(existsSync(join(pluginRoot, 'bin', 'flow-delegate')), 'flow Codex dispatcher exists')
    assert.deepEqual(codexDelegation.args.slice(0, 2), ['--flow-version', listed.version], 'flow Codex MCP pins the manifest version')
    assert.ok(!Object.hasOwn(codexDelegation, 'cwd'), 'flow Codex MCP inherits the host session cwd')
    assert.deepEqual(codexDelegation?.args?.slice(-2), ['--host', 'codex'], 'flow Codex MCP pins its host')
    assert.equal(codexDelegation?.tool_timeout_sec, 7_500, 'flow Codex MCP timeout outlives the maximum job budget')
    // Omitted cwd makes Codex start the dispatcher in the session directory, which is the server's
    // only root. CODEX_HOME selects the plugin cache the dispatcher reads, never workspace authority.
    assert.deepEqual(codexDelegation?.env_vars, ['CODEX_HOME'], 'flow Codex MCP forwards CODEX_HOME only')
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

// flow and gripe register Codex hooks. The set shrinking would mean a Codex manifest moved
// or was renamed without this test noticing; that is a failure, not an empty success. grill
// and unslop are deliberately outside it, shipping skills alone.
assert.ok(codexPlugins.length >= 2, `expected at least 2 Codex manifests, found ${codexPlugins.length}`)

console.log('parallel plugin manifests: ALL PASS')
