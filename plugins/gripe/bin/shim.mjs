#!/usr/bin/env node
// gripe-shim-epoch: 2
//
// ~/.local/bin/gripe is a copy of this file rather than a symlink to a versioned path, so it
// finds the newest installed gripe at exec time across both plugin caches and runs that one.
// Node builtins only: this runs before any plugin root is known. Why it works this way, and
// what each exit code promises, is in docs/gripe/DESIGN.md.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A cache directory is named for its version, so dotted integers and nothing else. `latest`,
// `0.4.0-rc1`, and a hash-named checkout are not versions and never become candidates.
const VERSION_RE = /^\d+(?:\.\d+)*$/
// The install string for every plugin in this repo is `<plugin>@jakub` (see the repo root
// AGENTS.md), so our own gripe is always under `cache/jakub/gripe/<version>` on either harness.
// Scanning every marketplace directory would let a higher-numbered plugin that merely shares
// the name gripe, from a marketplace we never published to, win the sort and run against our
// database. A second marketplace here would be a deliberate rename, not a discovery.
const MARKETPLACES = ['jakub']
const DIAGNOSTIC_CAP = 2000

const listDir = (dir) => { try { return readdirSync(dir) } catch { return [] } }

/** The bin/gripe under a root, when that is a regular file. statSync never blocks on a FIFO. */
function binOf(root) {
  const bin = join(root, 'bin', 'gripe')
  try {
    return statSync(bin).isFile() ? bin : null
  } catch {
    return null
  }
}

/** Newest first, compared numerically, then by path so two equal versions always rank alike. */
function byNewest(a, b) {
  const width = Math.max(a.version.length, b.version.length)
  for (let i = 0; i < width; i++) {
    const left = a.version[i] ?? 0
    const right = b.version[i] ?? 0
    if (left !== right) return right - left
  }
  return a.bin < b.bin ? -1 : a.bin > b.bin ? 1 : 0
}

/** Our own `<cache>/jakub/gripe/<version>/bin/gripe` under one plugin cache root. */
function scanCache(cacheRoot) {
  const found = []
  for (const marketplace of MARKETPLACES) {
    const dir = join(cacheRoot, marketplace, 'gripe')
    for (const name of listDir(dir)) {
      if (!VERSION_RE.test(name)) continue
      const root = join(dir, name)
      // Claude Code stamps `.orphaned_at` into a version directory when it uninstalls that
      // version or supersedes it, then leaves the files there until a later sweep. Without
      // this skip, a rollback keeps running the version it rolled back from. Codex writes no
      // such marker, so there the stale directory has to be deleted; see docs/gripe/DESIGN.md.
      if (existsSync(join(root, '.orphaned_at'))) continue
      const bin = binOf(root)
      if (bin !== null) found.push({ version: name.split('.').map(Number), bin })
    }
  }
  return found
}

/**
 * The binary to run, or the one line to print instead. GRIPE_HOME is decided by key presence
 * and not by value: set and unusable stops the run instead of falling through, because a typo
 * in a development export that files into the live database through installed code has no
 * symptom at all. Otherwise both plugin caches are one list and the highest version wins,
 * whichever harness installed it, since that is the code the shared database matches.
 */
export function resolveGripeBin({ env = process.env, home = homedir() } = {}) {
  if (Object.hasOwn(env, 'GRIPE_HOME')) {
    const root = typeof env.GRIPE_HOME === 'string' ? env.GRIPE_HOME : ''
    const bin = root === '' ? null : binOf(root)
    if (bin !== null) return { bin, error: null }
    return {
      bin: null,
      error: `GRIPE_HOME is set to "${root}" but its bin/gripe is not a readable file; refusing to fall through to an installed gripe`,
    }
  }
  const caches = [
    join(home, '.claude', 'plugins', 'cache'),
    join(env.CODEX_HOME || join(home, '.codex'), 'plugins', 'cache'),
  ]
  const candidates = caches.flatMap(scanCache).sort(byNewest)
  if (candidates.length > 0) return { bin: candidates[0].bin, error: null }
  // Name the directories scanned and never the versions under them: a diagnostic that pastes
  // a hundred directory names into an agent's context is its own kind of failure.
  const scanned = caches.flatMap((root) => MARKETPLACES.map((m) => join(root, m, 'gripe')))
  return {
    bin: null,
    error: `no installation found (set GRIPE_HOME or install gripe@jakub); checked: ${scanned.join(', ')}`,
  }
}

/** One line, control characters flattened, no stack trace, bounded. */
const boundedLine = (message) => `gripe: ${[...String(message)]
  .map((c) => (c.codePointAt(0) < 0x20 || c.codePointAt(0) === 0x7f ? ' ' : c))
  .join('')
  .slice(0, DIAGNOSTIC_CAP)}\n`

/**
 * The honesty split. Filing is `gripe add` and bare `gripe`, exactly, and it exits 0 whatever
 * went wrong, because a missing complaint log must never fail an agent's run. Every other
 * command passes a real child status through and exits 1 when no child ran. stdin is never
 * read: a synchronous read on an inherited pipe can block forever, and a filing command that
 * hangs is worse than one that files nothing.
 */
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  home = homedir(),
  spawn = spawnSync,
  stderr = (text) => process.stderr.write(text),
} = {}) {
  const filing = argv.length === 0 || argv[0] === 'add'
  const fail = (message) => {
    stderr(boundedLine(message))
    return filing ? 0 : 1
  }
  try {
    const { bin, error } = resolveGripeBin({ env, home })
    if (error !== null) return fail(error)
    const child = spawn(process.execPath, [bin, ...argv], { stdio: 'inherit' })
    // An exec failure beats a status: spawnSync reports both, and only the error is real.
    if (child?.error) return fail(`cannot run ${bin}: ${child.error.code ?? child.error.message}`)
    if (typeof child?.status !== 'number') {
      return fail(`gripe was killed by ${child?.signal ?? 'an unknown signal'}`)
    }
    // The child owns its own stderr, so a real exit code gets no second opinion here.
    return filing ? 0 : child.status
  } catch (error) {
    return fail(`resolution failed: ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

// Importing this file must not run it, so the smoke can exercise the resolver. No argv[1] is
// no script path, which means an import; a path that cannot be realpath'd falls back to
// comparing the two strings.
function invokedDirectly() {
  const script = process.argv[1]
  if (typeof script !== 'string') return false
  const self = fileURLToPath(import.meta.url)
  try {
    return realpathSync(script) === realpathSync(self)
  } catch {
    return script === self
  }
}

if (invokedDirectly()) {
  // process.exitCode, not process.exit: the diagnostic goes to a pipe often enough, and an
  // explicit exit can truncate it. Nothing keeps the loop alive once spawnSync returns.
  process.exitCode = main()
}
