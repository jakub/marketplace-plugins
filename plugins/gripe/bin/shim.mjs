#!/usr/bin/env node
// gripe-shim-epoch: 1
//
// gripe shim. Installed at ~/.local/bin/gripe by whichever harness ran SessionStart last;
// resolves the plugin at exec time and is never a symlink to a versioned path, because
// both plugin caches keep every old version forever and a pinned path keeps silently
// running stale code against a newer database.
//
// One host installs the shim, both hosts share the database, so resolution is dual: the
// Claude registry and the Codex config are read on every run, independently, and the
// newest usable root wins whichever harness supplied it. Per-harness authority is the
// point. A readable manifest is authoritative for its own harness and for nothing else,
// so a Codex config saying "gripe is not installed here" can never veto Claude's outage
// fallback.
//
// Tiers, in order:
//   1. GRIPE_HOME, decided by key presence. Broken means stop, never fall through: a
//      typo'd development override must not file into the live database through
//      installed code.
//   2. The confirmed tier - a Claude registry entry, a Codex registration paired with a
//      cache directory. Both legs always run.
//   3. The fallback tier, only when the confirmed tier found nothing at all, and only for
//      a harness whose own manifest was unreadable.
//
// Self-contained on purpose: node builtins only, no import of the plugin's own lib, so a
// half-installed or version-skewed plugin cannot break the resolver that has to find it.

import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs'
import { basename, join, normalize, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const VERSION_RE = /^\d+\.\d+\.\d+$/
const SAFE_COMPONENT_RE = /^[A-Za-z0-9._-]+$/
const REGISTRY_KEY_RE = /^gripe@[A-Za-z0-9._-]+$/
// A registration table header, and only that shape: optional horizontal whitespace, the
// quoted `plugins."gripe@<marketplace>"` key, an optional trailing comment.
const CODEX_TABLE_RE = /^[ \t]*\[plugins\."gripe@([A-Za-z0-9._-]+)"\][ \t]*(?:#.*)?$/
// The one accepted enabled form: a bare `enabled` key set to a bare boolean, optional
// spaces and a trailing comment. Any other spelling of an enabled assignment is ambiguity.
const ENABLED_VALUE_RE = /^[ \t]*enabled[ \t]*=[ \t]*(true|false)[ \t]*(?:#.*)?$/
// TOML basic-string simple escapes. Only \u and \U can spell letters, but the standard set
// is decoded so a valid key reads as its real value.
const SIMPLE_ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

// Written as code points rather than as literals, because a source file carrying a raw
// NUL is a source file every tool downstream calls binary.
const NUL = String.fromCharCode(0)
const REPLACEMENT = String.fromCharCode(0xfffd)

const MANIFEST_CAP = 1024 * 1024
// No line in the plugin-table region of a real config is anywhere near this long. A file
// that has one is not a file a line scanner can be trusted on.
const LINE_CAP = 4096
const DIAGNOSTIC_CAP = 2048

// Every read on the resolution path opens non-blocking, so a FIFO or other special file
// planted at a manifest, config, or bin/gripe path can never hang the process; fstat then
// rejects anything that is not a regular file. The filing contract requires `gripe add` to
// return promptly whatever the filesystem holds, and a blocking open would break exactly
// that, so each read fails closed instead. Following a final symlink is harmless: the fd is
// non-blocking and fstat still sees the FIFO the link points at.
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK

/** Read a whole small file, or report it unreadable. Over the cap counts as unreadable. */
function readCapped(path, cap = MANIFEST_CAP) {
  let fd
  try {
    fd = openSync(path, READ_FLAGS)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > cap) return { ok: false }
    const buffer = Buffer.alloc(Number(stat.size))
    let offset = 0
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (read <= 0) break
      offset += read
    }
    return { ok: true, text: buffer.subarray(0, offset).toString('utf8') }
  } catch {
    return { ok: false }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* the read already decided the outcome */ }
    }
  }
}

/** A root is usable when its bin/gripe is a regular file this process can open. */
function usableRoot(root) {
  let fd
  try {
    fd = openSync(join(root, 'bin', 'gripe'), READ_FLAGS)
    return fstatSync(fd).isFile()
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* the read already decided the outcome */ }
    }
  }
}

/** The canonical path of a directory, or null when it cannot be resolved. */
function realOrNull(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * A cache candidate's real binary must stay under the cache root it was scanned from. A
 * version directory symlinked out of the cache resolves to code the cache never vouched
 * for, and spawning it would run that code, so it is rejected. This confines only the two
 * plugin caches; GRIPE_HOME and the Claude manager registry are the user's own explicit
 * declarations and may point anywhere.
 */
function confinedBinary(root, confineReal) {
  const real = realOrNull(join(root, 'bin', 'gripe'))
  if (real === null) return false
  const prefix = confineReal.endsWith(sep) ? confineReal : confineReal + sep
  return real.startsWith(prefix)
}

/** Lexical only. realpath would make two names for one install look like two installs. */
export function normalizeRoot(path) {
  const clean = normalize(String(path))
  return clean.length > 1 && clean.endsWith(sep) ? clean.slice(0, -1) : clean
}

const safeComponent = (name) =>
  SAFE_COMPONENT_RE.test(name) && name !== '.' && name !== '..'

/** Stable releases only. A prerelease or a hash-named directory is not a version here. */
export function parseStableVersion(text) {
  if (typeof text !== 'string' || !VERSION_RE.test(text)) return null
  // BigInt because a cache directory is an untrusted name: 9007199254740993.0.0 and
  // 9007199254740992.0.1 are different versions and Number says they are not.
  return text.split('.').map((part) => BigInt(part))
}

/** Newest first. An unknown version sorts below every parsed one, and stays usable. */
export function compareVersions(a, b) {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? -1 : 1
  }
  return 0
}

/**
 * One total order over candidates: confirmed before fallback, then newest, then the
 * manager-supplied root before a cache-derived one, then Claude, then the root path as a
 * determinism tie-break so two identical installs never resolve differently run to run.
 */
export function compareCandidates(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier
  const byVersion = compareVersions(a.version, b.version)
  if (byVersion !== 0) return byVersion
  if (a.exact !== b.exact) return a.exact ? -1 : 1
  if (a.harness !== b.harness) return a.harness < b.harness ? -1 : 1
  if (a.root === b.root) return 0
  return a.root < b.root ? -1 : 1
}

function scanVersionDir(dir, base, confineReal) {
  const found = []
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return found
  }
  for (const name of names) {
    const version = parseStableVersion(name)
    if (version === null) continue
    const root = normalizeRoot(join(dir, name))
    if (usableRoot(root) && confinedBinary(root, confineReal)) found.push({ ...base, root, version })
  }
  return found
}

function scanCacheRoot(cacheRoot, base) {
  const found = []
  const confineReal = realOrNull(cacheRoot)
  if (confineReal === null) return found
  let marketplaces
  try {
    marketplaces = readdirSync(cacheRoot)
  } catch {
    return found
  }
  for (const marketplace of marketplaces) {
    if (!safeComponent(marketplace)) continue
    found.push(...scanVersionDir(join(cacheRoot, marketplace, 'gripe'), base, confineReal))
  }
  return found
}

/**
 * The Claude registry. Readable is authoritative for Claude even when its entries are
 * unusable; unreadable is an outage and opens the Claude cache fallback. Keys match
 * exactly, so `gripe-notes@jakub` is a different plugin and not a prefix hit. Scope is
 * deliberately not read: a user-scope and a project-scope install of the same version are
 * the same code, and filtering would invent an outage where there is none.
 */
export function readClaudeRegistry(home) {
  const path = join(home, '.claude', 'plugins', 'installed_plugins.json')
  // Per-harness containment: anything unexpected while reading Claude's registry counts as a
  // Claude outage (readable: false, cache fallback opens) and never propagates out of the
  // resolver, so Codex's already-collected candidates survive one harness's hostile bytes.
  const unreadable = { path, readable: false, candidates: [] }
  try {
    const raw = readCapped(path)
    if (!raw.ok) return unreadable
    let parsed
    try {
      parsed = JSON.parse(raw.text)
    } catch {
      return unreadable
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return unreadable
    }
    const candidates = []
    const table = parsed.plugins
    if (table !== null && typeof table === 'object' && !Array.isArray(table)) {
      for (const [key, entries] of Object.entries(table)) {
        if (!REGISTRY_KEY_RE.test(key)) continue
        for (const entry of Array.isArray(entries) ? entries : []) {
          const installPath = entry?.installPath
          if (typeof installPath !== 'string' || installPath === '') continue
          const root = normalizeRoot(installPath)
          if (!usableRoot(root)) continue
          const version = parseStableVersion(entry?.version) ?? parseStableVersion(basename(root))
          candidates.push({ root, version, exact: true, harness: 'claude', tier: 0 })
        }
      }
    }
    return { path, readable: true, candidates }
  } catch {
    return unreadable
  }
}

// The text left of the first top-level `=` (a `=` inside quotes does not count), or null
// when the line is a comment, blank, or otherwise not an assignment.
function assignmentKey(line) {
  let basic = false
  let literal = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (basic) {
      if (c === '\\') { i++; continue }
      if (c === '"') basic = false
      continue
    }
    if (literal) {
      if (c === "'") literal = false
      continue
    }
    if (c === '"') { basic = true; continue }
    if (c === "'") { literal = true; continue }
    if (c === '=') return line.slice(0, i)
    if (c === '#') return null
  }
  return null
}

// The first dotted segment of a key, a `.` inside quotes ignored.
function firstSegment(key) {
  let basic = false
  let literal = false
  for (let i = 0; i < key.length; i++) {
    const c = key[i]
    if (basic) {
      if (c === '\\') { i++; continue }
      if (c === '"') basic = false
      continue
    }
    if (literal) {
      if (c === "'") literal = false
      continue
    }
    if (c === '"') { basic = true; continue }
    if (c === "'") { literal = true; continue }
    if (c === '.') return key.slice(0, i)
  }
  return key
}

// Decode a TOML basic string's contents, or null if an escape is malformed.
function decodeBasic(inner) {
  let out = ''
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') { out += inner[i]; continue }
    const next = inner[i + 1]
    if (next === 'u' || next === 'U') {
      const width = next === 'u' ? 4 : 8
      const hex = inner.slice(i + 2, i + 2 + width)
      if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) return null
      const scalar = Number.parseInt(hex, 16)
      // A TOML \u/\U escape must name a Unicode scalar value. A code point past U+10FFFF
      // (a `\U` can spell up to 0xFFFFFFFF) or in the surrogate range U+D800..U+DFFF is not
      // one, and String.fromCodePoint throws RangeError on it. An uncaught throw here would
      // escape readCodexRegistry and resolveGripeRoot and drop an otherwise-valid Claude
      // filing, so treat it as an undecodable escape (null): the key becomes ambiguous, the
      // table resolves to absence, and nothing throws.
      if (scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) return null
      out += String.fromCodePoint(scalar)
      i += 1 + width
      continue
    }
    const simple = SIMPLE_ESCAPES[next]
    if (simple === undefined) return null
    out += simple
    i += 1
  }
  return out
}

// How a key's first segment relates to the bare TOML key `enabled`:
//   'enabled'     - it normalizes to `enabled`, however spelled: bare, single-quoted
//                   (literal), or double-quoted with escapes. This is what lets
//                   `enabled.value = false` and `"enabled" = false` be recognized as enabled
//                   assignments the bare matcher would miss, and so treated as ambiguity.
//   'undecodable' - a double-quoted segment whose escapes do not decode (a malformed or
//                   out-of-range \u/\U). We cannot tell whether it spells `enabled`, so the
//                   table is ambiguous and must resolve to absence, never to the bare-table
//                   enabled default and never to a throw.
//   'other'       - it decodes to something that is plainly not `enabled`.
function keyEnabledness(key) {
  const segment = firstSegment(key).trim()
  if (segment === 'enabled') return 'enabled'
  if (segment.length >= 2 && segment.startsWith("'") && segment.endsWith("'")) {
    return segment.slice(1, -1) === 'enabled' ? 'enabled' : 'other'
  }
  if (segment.length >= 2 && segment.startsWith('"') && segment.endsWith('"')) {
    const decoded = decodeBasic(segment.slice(1, -1))
    if (decoded === null) return 'undecodable'
    return decoded === 'enabled' ? 'enabled' : 'other'
  }
  return 'other'
}

/**
 * A line scanner, not a TOML parser. It recognizes one shape of table header and one
 * shape of `enabled` value; everything else about the file is somebody else's business.
 * The cost of that is honesty about its blind spot: a header can hide inside a multi-line
 * string, so a file holding multi-line string delimiters at all reports no registration
 * rather than a guess. Ambiguity is absence, in every direction.
 *
 * The table is the registration and `enabled` is the toggle, so a bare table counts as
 * enabled. That branch is dead code against Codex CLI 0.151.0, read 2026-08-31: every
 * live table carries an explicit boolean. It is here because the opposite default would
 * silently drop a real registration the day Codex stops writing one.
 */
export function parseCodexRegistration(text) {
  const absent = { registered: false }
  // A NUL or a replacement character means these bytes are not the UTF-8 text the
  // scanner thinks it is reading.
  if (text.includes(NUL) || text.includes(REPLACEMENT)) return absent
  if (text.includes('"""') || text.includes("'''")) return absent
  const tables = []
  let current = null
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.length > LINE_CAP) return absent
    if (/^[ \t]*\[/.test(line)) {
      const header = CODEX_TABLE_RE.exec(line)
      if (header && safeComponent(header[1])) {
        current = { marketplace: header[1], enabled: undefined, invalid: false }
        tables.push(current)
      } else {
        current = null
      }
      continue
    }
    if (current === null) continue
    const key = assignmentKey(line)
    if (key === null) continue
    const kind = keyEnabledness(key)
    if (kind === 'other') continue
    // An undecodable key could be an `enabled` toggle we cannot read, so it is ambiguity: mark
    // the table invalid and drop the whole registration to absence.
    if (kind === 'undecodable') { current.invalid = true; continue }
    // The line is an enabled assignment in some form. Only the exact bare form sets the
    // toggle; a quoted, escaped, dotted, non-boolean, or duplicate one is ambiguity, which
    // marks the table invalid and drops the whole registration to absence.
    const value = ENABLED_VALUE_RE.exec(line)
    if (!value || current.enabled !== undefined) current.invalid = true
    else current.enabled = value[1] === 'true'
  }
  if (tables.length !== 1 || tables[0].invalid) return absent
  return { registered: true, marketplace: tables[0].marketplace, enabled: tables[0].enabled ?? true }
}

/**
 * The Codex registration. Same authority rule as Claude's: readable is authoritative for
 * Codex alone. Over the cap is an outage and not an answer, so the fallback may still run.
 */
export function readCodexRegistry({ env, home }) {
  const codexHome = normalizeRoot(env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, '.codex'))
  const path = join(codexHome, 'config.toml')
  const cacheRoot = join(codexHome, 'plugins', 'cache')
  // Per-harness containment: anything unexpected while reading Codex's config counts as a
  // Codex outage (readable: false, cache fallback opens) and never propagates out of the
  // resolver, so Claude's already-collected candidates survive one harness's hostile bytes.
  const unreadable = { codexHome, path, cacheRoot, readable: false, scannedCache: false, candidates: [] }
  try {
    const raw = readCapped(path)
    if (!raw.ok) return unreadable
    const registration = parseCodexRegistration(raw.text)
    if (!registration.registered || registration.enabled === false) {
      return { codexHome, path, cacheRoot, readable: true, scannedCache: false, candidates: [] }
    }
    // The confirmed scan consulted the cache root, so it is a resolution surface even when it
    // turns up empty; scannedCache tells the caller to record it in the miss diagnostic.
    const confineReal = realOrNull(cacheRoot)
    const dir = join(cacheRoot, registration.marketplace, 'gripe')
    return {
      codexHome,
      path,
      cacheRoot,
      readable: true,
      scannedCache: true,
      candidates: confineReal === null
        ? []
        : scanVersionDir(dir, { exact: false, harness: 'codex', tier: 0 }, confineReal),
    }
  } catch {
    return unreadable
  }
}

/**
 * Resolve the root to run. Returns the winning root, every candidate in rank order, and
 * the surfaces actually consulted, which is what the total-miss diagnostic reports.
 */
export function resolveGripeRoot({ env = process.env, home = homedir() } = {}) {
  const checked = {
    override: null, claudeRegistry: null, claudeCache: null, codexConfig: null, codexCache: null,
  }
  const result = (extra) => {
    const surfaces = [
      checked.override, checked.claudeRegistry, checked.claudeCache,
      checked.codexConfig, checked.codexCache,
    ].filter((surface) => surface !== null)
    return { root: null, error: null, candidates: [], surfaces: [...new Set(surfaces)], ...extra }
  }

  if (Object.hasOwn(env, 'GRIPE_HOME')) {
    const raw = typeof env.GRIPE_HOME === 'string' ? env.GRIPE_HOME : ''
    checked.override = raw === '' ? 'GRIPE_HOME (empty)' : normalizeRoot(raw)
    if (raw !== '' && usableRoot(normalizeRoot(raw))) {
      const root = normalizeRoot(resolve(raw))
      return result({
        root,
        candidates: [{ root, version: null, exact: true, harness: 'override', tier: 0 }],
      })
    }
    return result({ error: 'override', overridePath: raw })
  }

  const claude = readClaudeRegistry(home)
  checked.claudeRegistry = claude.path
  const codex = readCodexRegistry({ env, home })
  checked.codexConfig = codex.path
  // A confirmed, enabled Codex scan consulted its cache root even when it found nothing, so
  // record that surface here rather than only in the unreadable-config fallback below.
  if (codex.scannedCache) checked.codexCache = codex.cacheRoot
  const candidates = [...claude.candidates, ...codex.candidates]

  if (candidates.length === 0) {
    if (!claude.readable) {
      checked.claudeCache = join(home, '.claude', 'plugins', 'cache')
      candidates.push(...scanCacheRoot(checked.claudeCache, { exact: false, harness: 'claude', tier: 1 }))
    }
    if (!codex.readable) {
      checked.codexCache = codex.cacheRoot
      candidates.push(...scanCacheRoot(checked.codexCache, { exact: false, harness: 'codex', tier: 1 }))
    }
  }

  candidates.sort(compareCandidates)
  return result({ root: candidates[0]?.root ?? null, candidates })
}

function capBytes(text, limit) {
  if (Buffer.byteLength(text) <= limit) return text
  const points = [...text]
  let low = 0
  let high = points.length
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (Buffer.byteLength(points.slice(0, middle).join('')) <= limit) low = middle
    else high = middle - 1
  }
  return points.slice(0, low).join('')
}

/** One line, one newline, no control characters, no stack trace, bounded. */
export function boundedLine(text) {
  const flat = [...String(text)]
    .map((character) => {
      const point = character.codePointAt(0)
      return point < 0x20 || point === 0x7f ? ' ' : character
    })
    .join('')
  return `${capBytes(`gripe: ${flat}`, DIAGNOSTIC_CAP - 1)}\n`
}

/**
 * The honesty split. Filing is `gripe add` and bare `gripe`, exactly: `--foo add` is a
 * malformed human command and not a free one. Filing exits 0 whatever went wrong, because
 * a missing complaint log must never fail an agent's run. Every other command reports the
 * truth, and a real child status passes through untouched.
 *
 * stdin is never read, never drained, never even referenced: a synchronous read on an
 * inherited pipe can block forever, and a filing command that hangs is worse than one
 * that files nothing.
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
    const resolved = resolveGripeRoot({ env, home })
    if (resolved.error === 'override') {
      return fail(`GRIPE_HOME is set to "${resolved.overridePath}" but its bin/gripe is not a readable file; refusing to fall through to an installed gripe`)
    }
    if (resolved.root === null) {
      return fail(`no installation found (set GRIPE_HOME or install gripe@jakub); checked: ${resolved.surfaces.join(', ')}`)
    }
    const target = join(resolved.root, 'bin', 'gripe')
    const child = spawn(process.execPath, [target, ...argv], { stdio: 'inherit' })
    // An exec failure beats a status: spawnSync reports both, and only the error is real.
    if (child?.error) return fail(`cannot run ${target}: ${child.error.code ?? child.error.message}`)
    if (typeof child?.status !== 'number') {
      return fail(`gripe was killed by ${child?.signal ?? 'an unknown signal'}`)
    }
    // The child owns its own stderr, so a real exit code gets no second opinion here.
    return filing ? 0 : child.status
  } catch (error) {
    return fail(`resolution failed: ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

// Importing this file must not run it, so the smoke can exercise the helpers. A failed
// comparison runs: a CLI that silently no-ops is the worse failure of the two.
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return true
  }
}

if (invokedDirectly()) {
  // process.exitCode, not process.exit: the diagnostic goes to a pipe often enough, and
  // an explicit exit can truncate it. Nothing keeps the loop alive once spawnSync returns.
  process.exitCode = main()
}
