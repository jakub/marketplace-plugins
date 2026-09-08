#!/usr/bin/env node
// flow-delegate-launcher-epoch: 1
// Installed verbatim in ~/.local/bin. Node builtins only: this file must run
// without its source plugin. A registered Codex package directory and the exact
// manifest version select the bundle. No cache scan or caller-supplied root.
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync, mkdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const epoch = 1
export const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/
export const digest = (value) => createHash('sha256').update(value).digest('hex')
export class SetupError extends Error {}
class BundleStartupError extends Error {}
export function diagnostic(error, fallback) {
  // Only messages assembled here are safe to print. JSON and bundle exceptions
  // can contain configuration values; never forward their message or stack.
  return (error instanceof SetupError ? error.message : fallback).replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 2048)
}
function canonicalBase(path, name) {
  if (!isAbsolute(path)) throw new SetupError(`${name} must be absolute`)
  try {
    const canonical = realpathSync(path)
    if (statSync(canonical).isDirectory()) return canonical
  } catch {}
  throw new SetupError(`${name} must name an existing directory: ${JSON.stringify(path)}; check the configured home and installed Flow cache before retrying`)
}
export function locations() {
  // HOME prefixes and the configured CODEX_HOME may be aliases. Resolve those
  // bases once; directory() still rejects symlink children underneath them.
  const home = canonicalBase(process.env.HOME || homedir(), 'HOME')
  const codexHome = canonicalBase(process.env.CODEX_HOME || join(home, '.codex'), 'CODEX_HOME')
  return { home, codexHome, state: join(home, '.local/share/flow-delegate'), bin: join(home, '.local/bin') }
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
      let child
      try { child = openSync(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) } catch (error) {
        const attempted = JSON.stringify(join(realpathSync(`/proc/self/fd/${fd}`), part))
        if (['ELOOP', 'ENOTDIR'].includes(error.code)) throw new SetupError(`${attempted} must be a real directory; replace the symlink or non-directory with a directory before retrying`)
        if (error.code === 'ENOENT') throw new SetupError(`${attempted} must exist as a real directory; restore the configured installation before retrying`)
        throw error
      }
      closeSync(fd)
      fd = child
    }
    return fd
  } catch (error) { closeSync(fd); throw error }
}
export const at = (fd, name) => `/proc/self/fd/${fd}/${name}`
function owned(fd, kind) {
  const stat = fstatSync(fd)
  const path = JSON.stringify(realpathSync(`/proc/self/fd/${fd}`))
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new SetupError(`expected a regular ${kind} at ${path}`)
  if (stat.uid !== process.getuid()) throw new SetupError(`${path} must be owned by uid ${process.getuid()}; restore ownership before retrying`)
  if (stat.mode & 0o022) throw new SetupError(`${path} is writable by group or others; remove those write permissions with chmod go-w before retrying`)
}
export const ownedDirectory = (fd) => owned(fd, 'directory')
export function regular(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    owned(fd, 'file')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
export function identity(root, includeBundle = true) {
  if (!isAbsolute(root) || realpathSync(root) !== root) throw new SetupError('plugin root must be canonical')
  const fd = directory(root)
  try {
    if (includeBundle) {
      try { lstatSync(at(fd, '.orphaned_at')); throw new SetupError('installed Flow cache slot is orphaned') } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const manifestDir = directory(join(root, '.codex-plugin'))
    let manifest
    try { manifest = JSON.parse(regular(at(manifestDir, 'plugin.json'))) } finally { closeSync(manifestDir) }
    if (manifest.name !== 'flow' || !versionPattern.test(manifest.version)) throw new SetupError('invalid Flow plugin identity')
    if (!includeBundle) return { version: manifest.version, root }
    const dist = directory(join(root, 'dist'))
    try { regular(at(dist, 'delegation.mjs')) } finally { closeSync(dist) }
    return { version: manifest.version, root }
  } finally { closeSync(fd) }
}
export const registrationName = (codexHome) => `${digest(codexHome)}.json`
function anchorSyntax(anchor, codexHome) {
  if (typeof anchor !== 'string' || !isAbsolute(anchor) || resolve(anchor) !== anchor) throw new SetupError('invalid registered package path')
  const parts = relative(join(codexHome, 'plugins/cache'), anchor).split('/')
  if (parts.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parts[0]) || parts[1] !== 'flow') throw new SetupError('expected an installed Codex Flow cache package')
}
export function validateRegistration(registration, codexHome) {
  if (!registration || registration.schema !== 1 || registration.codexHome !== codexHome || !['versioned', 'local'].includes(registration.layout)) throw new SetupError('registration identity mismatch')
  // Uninstall validates the recorded path without following a possibly removed
  // package. Only launch and installation require that package to exist.
  anchorSyntax(registration.anchor, codexHome)
}
export function packageAnchor(anchor, codexHome) {
  anchorSyntax(anchor, codexHome)
  if (realpathSync(anchor) !== anchor) throw new SetupError('package anchor must be canonical')
  const fd = directory(anchor)
  try { if (fstatSync(fd).uid !== process.getuid()) throw new SetupError(`package anchor ${JSON.stringify(anchor)} must be owned by uid ${process.getuid()}; restore ownership before retrying`) } finally { closeSync(fd) }
  return anchor
}
export function installedPackage(root, codexHome, version) {
  const anchor = packageAnchor(dirname(root), codexHome)
  const slot = basename(root)
  if (slot !== version && slot !== 'local') throw new SetupError('cache slot must match the Flow version or local')
  return { anchor, layout: slot === 'local' ? 'local' : 'versioned' }
}
export async function dispatch(args = process.argv.slice(2)) {
  const [flag, version, ...forwarded] = args
  if (flag !== '--flow-version' || !versionPattern.test(version || '')) throw new SetupError('expected --flow-version and an exact version')
  const paths = locations()
  const registry = directory(join(paths.state, 'registrations'))
  let registration
  try { registration = JSON.parse(regular(at(registry, registrationName(paths.codexHome)))) } finally { closeSync(registry) }
  validateRegistration(registration, paths.codexHome)
  const anchor = packageAnchor(registration.anchor, paths.codexHome)
  const current = identity(join(anchor, registration.layout === 'local' ? 'local' : version))
  if (current.version !== version) throw new SetupError('registered Flow version mismatch')
  const entry = join(current.root, 'dist/delegation.mjs')
  process.argv = [process.execPath, entry, ...forwarded]
  try { await import(pathToFileURL(entry).href) } catch { throw new BundleStartupError() }
}
function isEntrypoint() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
}
if (isEntrypoint()) {
  try { await dispatch() } catch (error) {
    const message = error instanceof BundleStartupError
      ? 'Flow bundle startup failed; inspect Flow startup configuration'
      : diagnostic(error, 'exact Flow registration unavailable or invalid; run the installed plugin entrypoint installer')
    console.error(`flow-delegate: ${message}`)
    process.exitCode = 1
  }
}
