#!/usr/bin/env node
// Bump one plugin's version across every manifest that carries it:
//   - .claude-plugin/marketplace.json
//   - plugins/<name>/.claude-plugin/plugin.json
//   - plugins/<name>/.codex-plugin/plugin.json (when present)
//   - plugins/<name>/.antigravity-plugin/plugin.json (when present)
//   - plugins/flow/.mcp.json --flow-version pin (for flow)
//
// Run only when the human explicitly asks to bump a version.
// Usage: node scripts/bump-version.mjs [--dry-run] <plugin> <X.Y.Z>

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = 'usage: node scripts/bump-version.mjs [--dry-run] <plugin> <X.Y.Z>'
const SEMVER = /^\d+\.\d+\.\d+$/

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const pos = args.filter((a) => a !== '--dry-run')
if (pos.length !== 2 || !SEMVER.test(pos[1])) {
  process.stderr.write(`${USAGE}\n`)
  process.exit(2)
}

const [name, version] = pos
const marketPath = join(ROOT, '.claude-plugin', 'marketplace.json')
const market = JSON.parse(readFileSync(marketPath, 'utf8'))
const entry = market.plugins.find((p) => p.name === name)
if (!entry) {
  process.stderr.write(`bump-version: unknown plugin ${JSON.stringify(name)}\n`)
  process.exit(1)
}

const pluginRoot = join(ROOT, 'plugins', name)
const updates = []

const queueJson = (path, mutate) => {
  const obj = JSON.parse(readFileSync(path, 'utf8'))
  mutate(obj)
  updates.push({ path, text: `${JSON.stringify(obj, null, 2)}\n` })
}

queueJson(marketPath, (m) => {
  m.plugins.find((p) => p.name === name).version = version
})
for (const rel of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.antigravity-plugin/plugin.json']) {
  const p = join(pluginRoot, rel)
  if (existsSync(p)) queueJson(p, (obj) => { obj.version = version })
}
if (name === 'flow') {
  const mcpPath = join(pluginRoot, '.mcp.json')
  queueJson(mcpPath, (obj) => {
    const a = obj.flow_delegate?.args
    const idx = Array.isArray(a) ? a.indexOf('--flow-version') : -1
    if (idx === -1 || idx + 1 >= a.length) throw new Error('flow/.mcp.json is missing --flow-version')
    a[idx + 1] = version
  })
}

for (const u of updates) {
  if (!dryRun) writeFileSync(u.path, u.text)
  console.log(`${dryRun ? '[dry-run] ' : ''}${relative(ROOT, u.path)} -> ${version}`)
}
