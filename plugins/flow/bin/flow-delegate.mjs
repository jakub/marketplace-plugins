#!/usr/bin/env node
// flow-delegate-launcher-epoch: 1
// Installed verbatim in ~/.local/bin. Node builtins only: this file must run
// without its source plugin. A registered Codex package directory and the exact
// manifest version select the bundle. No cache scan or caller-supplied root.
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const epoch = 1
export const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/
export const digest = (value) => createHash('sha256').update(value).digest('hex')
export function locations() {
  const home = process.env.HOME || homedir()
  const codexHome = process.env.CODEX_HOME || join(home, '.codex')
  if (!isAbsolute(home) || !isAbsolute(codexHome)) throw new Error('HOME and CODEX_HOME must be absolute')
  return { home: resolve(home), codexHome: resolve(codexHome), state: join(home, '.local/share/flow-delegate'), bin: join(home, '.local/bin') }
}

// Pin each directory before traversing the next component. Writes made by the
// installer use these descriptors too, so a renamed ancestor cannot redirect them.
export function directory(path, create = false) {
  let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    for (const part of resolve(path).split('/').filter(Boolean)) {
      const next = `/proc/self/fd/${fd}/${part}`
      if (create) {
        try { mkdirSync(next, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      const child = openSync(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      closeSync(fd)
      fd = child
    }
    return fd
  } catch (error) { closeSync(fd); throw error }
}
export const at = (fd, name) => `/proc/self/fd/${fd}/${name}`
export function regular(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw new Error('expected an owned regular file not writable by others')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
export function identity(root, includeBundle = true) {
  if (!isAbsolute(root) || realpathSync(root) !== root) throw new Error('plugin root must be canonical')
  const fd = directory(root)
  try {
    if (includeBundle) {
      try { lstatSync(at(fd, '.orphaned_at')); throw new Error('installed Flow cache slot is orphaned') } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const manifestDir = directory(join(root, '.codex-plugin'))
    let manifest
    try { manifest = JSON.parse(regular(at(manifestDir, 'plugin.json'))) } finally { closeSync(manifestDir) }
    if (manifest.name !== 'flow' || !versionPattern.test(manifest.version)) throw new Error('invalid Flow plugin identity')
    if (!includeBundle) return { version: manifest.version, root }
    const dist = directory(join(root, 'dist'))
    try { regular(at(dist, 'delegation.mjs')) } finally { closeSync(dist) }
    return { version: manifest.version, root }
  } finally { closeSync(fd) }
}
export const registrationName = (codexHome) => `${digest(codexHome)}.json`
export function packageAnchor(anchor, codexHome) {
  const parts = relative(join(codexHome, 'plugins/cache'), anchor).split('/')
  if (parts.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parts[0]) || parts[1] !== 'flow') throw new Error('expected an installed Codex Flow cache package')
  if (realpathSync(anchor) !== anchor) throw new Error('package anchor must be canonical')
  const fd = directory(anchor)
  try { if (fstatSync(fd).uid !== process.getuid()) throw new Error('package anchor must be owned') } finally { closeSync(fd) }
  return anchor
}
export function installedPackage(root, codexHome, version) {
  const anchor = packageAnchor(dirname(root), codexHome)
  const slot = basename(root)
  if (slot !== version && slot !== 'local') throw new Error('cache slot must match the Flow version or local')
  return { anchor, layout: slot === 'local' ? 'local' : 'versioned' }
}
export async function dispatch(args = process.argv.slice(2)) {
  const [flag, version, ...forwarded] = args
  if (flag !== '--flow-version' || !versionPattern.test(version || '')) throw new Error('expected --flow-version and an exact version')
  const paths = locations()
  const registry = directory(join(paths.state, 'registrations'))
  let registration
  try { registration = JSON.parse(regular(at(registry, registrationName(paths.codexHome)))) } finally { closeSync(registry) }
  if (registration.schema !== 1 || registration.codexHome !== paths.codexHome || !['versioned', 'local'].includes(registration.layout)) throw new Error('registration identity mismatch')
  const anchor = packageAnchor(registration.anchor, paths.codexHome)
  const current = identity(join(anchor, registration.layout === 'local' ? 'local' : version))
  if (current.version !== version) throw new Error('registered Flow version mismatch')
  const entry = join(current.root, 'dist/delegation.mjs')
  process.argv = [process.execPath, entry, ...forwarded]
  await import(pathToFileURL(entry).href)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await dispatch() } catch { console.error('flow-delegate: exact Flow registration unavailable or invalid; run the installed plugin entrypoint installer'); process.exitCode = 1 }
}
