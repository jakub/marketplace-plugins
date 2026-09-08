#!/usr/bin/env node
// Install once before the first Codex session. SessionStart maintains existing
// installs, but Codex starts MCP before running that hook. No bootstrap polling.
// One HOME-wide lock covers the shared executable and every CODEX_HOME mapping.
// Register the installed package directory once. Versioned upgrades need no hook
// before launch. A different package directory requires explicit uninstall first.
// A crashed installer leaves a lock and fails closed until the owner removes it.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { at, directory, epoch, identity, installedPackage, locations, regular, registrationName } from '../bin/flow-delegate.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const action = process.argv[2]
const paths = locations()
const sourcePath = join(root, 'bin/flow-delegate.mjs')
const launcherName = 'flow-delegate'
function ownedDirectory(fd) {
  const stat = fstatSync(fd)
  if (stat.uid !== process.getuid() || (stat.mode & 0o022)) throw new Error('installer directories must be owned and not writable by others')
}
function optional(path) {
  try { return regular(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
function launcherEpoch(bytes) {
  if (!bytes) return null
  const match = bytes.toString().match(/^#!\/usr\/bin\/env node\n\/\/ flow-delegate-launcher-epoch: ([1-9]\d*)\n/)
  if (!match) throw new Error('refusing to replace an unrelated flow-delegate executable')
  return Number(match[1])
}
function atomic(fd, name, bytes, mode) {
  // Reject links even though rename would replace, rather than follow, them.
  const target = at(fd, name)
  optional(target)
  const temp = at(fd, `.${name}.${randomUUID()}`)
  const file = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try {
    try { writeFileSync(file, bytes); fsyncSync(file) } finally { closeSync(file) }
    renameSync(temp, target); fsyncSync(fd)
  } finally {
    try { unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
async function acquire(fd) {
  const lock = at(fd, 'install.lock')
  const deadline = Date.now() + 4000
  while (true) {
    try { mkdirSync(lock, { mode: 0o700 }); return () => rmdirSync(lock) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try { if (!lstatSync(lock).isDirectory()) throw new Error('invalid installer lock') } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      if (Date.now() >= deadline) throw new Error('entrypoint installation lock is busy; inspect a stale lock before removing it')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}
async function main() {
  if (!['install', 'uninstall'].includes(action)) throw new Error('usage: install-delegate.mjs install|uninstall')
  const current = identity(root, action === 'install')
  const selected = installedPackage(root, paths.codexHome, current.version)
  if (action === 'install' && !(process.env.PATH || '').split(':').some(path => path.startsWith('/') && resolve(path) === paths.bin)) {
    console.error(`flow-delegate installer: add ${paths.bin} to the Codex host PATH before starting a session`)
  }
  const state = directory(paths.state, true)
  try {
    ownedDirectory(state)
    const unlock = await acquire(state)
    try {
      const registry = directory(join(paths.state, 'registrations'), true)
      const bin = directory(paths.bin, true)
      try {
        ownedDirectory(registry); ownedDirectory(bin)
        const name = registrationName(paths.codexHome)
        const existingBytes = optional(at(registry, name))
        const existing = existingBytes ? JSON.parse(existingBytes) : null
        if (existing && (existing.schema !== 1 || existing.codexHome !== paths.codexHome || existing.anchor !== selected.anchor || existing.layout !== selected.layout)) throw new Error('this Codex home is registered to another package; uninstall that registration first')
        const launcher = optional(at(bin, launcherName))
        const installedEpoch = launcherEpoch(launcher)
        if (action === 'install') {
          const source = regular(sourcePath)
          if (launcherEpoch(source) !== epoch) throw new Error('launcher protocol marker mismatch')
          if (installedEpoch === epoch && launcher && !launcher.equals(source)) throw new Error('same-epoch launcher content differs; update the protocol epoch before replacing it')
          if (installedEpoch === null || installedEpoch < epoch) atomic(bin, launcherName, source, 0o755)
          atomic(registry, name, JSON.stringify({ schema: 1, codexHome: paths.codexHome, ...selected }) + '\n', 0o600)
        } else if (existing) {
          // Preserve all other homes and versions. Unknown registry entries also
          // prevent launcher removal; uninstall never claims foreign state.
          unlinkSync(at(registry, name)); fsyncSync(registry)
          if (readdirSync(at(registry, '.')).length === 0 && installedEpoch !== null) unlinkSync(at(bin, launcherName))
        }
      } finally { closeSync(registry); closeSync(bin) }
    } finally { unlock() }
  } finally { closeSync(state) }
}
try { await main() } catch (error) { console.error(`flow-delegate installer: ${error.message}`); process.exitCode = 1 }
