#!/usr/bin/env node
// gripe shim. Installed at ~/.local/bin/gripe by the SessionStart hook; resolves the
// plugin at exec time and is never a symlink to a versioned path, because the plugin
// cache keeps every old version forever and a pinned path keeps silently running stale
// code against a newer database.
//
// Resolution order: $GRIPE_HOME (the development override), then whatever version the
// plugin manager says is installed, then a semver-aware scan of the cache. The scan
// compares numerically, because a lexical sort ships 0.9.0 forever once 0.10.0 exists.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

function fromRegistry() {
  try {
    const reg = JSON.parse(
      readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'))
    for (const [key, entries] of Object.entries(reg.plugins ?? {})) {
      if (!key.startsWith('gripe@')) continue
      for (const e of entries ?? []) {
        if (e?.installPath && existsSync(join(e.installPath, 'bin', 'gripe'))) return e.installPath
      }
    }
  } catch {}
  return null
}

function fromCacheScan() {
  try {
    const base = join(homedir(), '.claude', 'plugins', 'cache', 'jakub', 'gripe')
    const versions = readdirSync(base)
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => {
        const A = a.split('.').map(Number)
        const B = b.split('.').map(Number)
        return A[0] - B[0] || A[1] - B[1] || A[2] - B[2]
      })
    for (let i = versions.length - 1; i >= 0; i--) {
      const p = join(base, versions[i])
      if (existsSync(join(p, 'bin', 'gripe'))) return p
    }
  } catch {}
  return null
}

function resolveRoot() {
  const home = process.env.GRIPE_HOME
  if (home && existsSync(join(home, 'bin', 'gripe'))) return home
  return fromRegistry() ?? fromCacheScan()
}

const root = resolveRoot()
if (!root) {
  process.stderr.write('gripe: no installation found (set GRIPE_HOME or install gripe@jakub)\n')
  process.exit(0) // invariant 1: a missing tool must not fail an agent's run
}
const r = spawnSync(process.execPath, [join(root, 'bin', 'gripe'), ...process.argv.slice(2)], {
  stdio: 'inherit',
})
process.exit(r.status ?? 0)
