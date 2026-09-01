#!/usr/bin/env node
// gripe shim smoke. Each thing under test here has a way of failing that a green
// `gripe add` would hide: which install the resolver picks, what the process exits with
// when it cannot pick one, whether publishing a shim can ever downgrade it, and whether
// the running install can say what it is.
//
// Every synthetic home lives under one throwaway directory. Nothing here reads the real
// ~/.claude or ~/.codex, and nothing writes outside the temp tree.
//
// Usage: node plugins/gripe/scripts/smoke-shim.mjs

import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  boundedLine, compareVersions, main, normalizeRoot, parseCodexRegistration, parseStableVersion,
  resolveGripeRoot,
} from '../bin/shim.mjs'
import { pointShim, shimEpoch } from '../lib/shim.mjs'
import { installFacts } from '../lib/install.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = normalizeRoot(join(HERE, '..'))
const SHIM = join(PLUGIN, 'bin', 'shim.mjs')

// Forked back into by the ratchet's concurrency case; see the eight-writer check below.
if (process.env.GRIPE_SHIM_RATCHET_CHILD) {
  process.stdout.write(pointShim({
    sourcePath: process.env.GRIPE_SHIM_RATCHET_SOURCE,
    shimPath: process.env.GRIPE_SHIM_RATCHET_TARGET,
  }))
  process.exit(0)
}

// Forked back into by the fifo-manifest installFacts case. installFacts runs in-process
// everywhere else here; this case runs it in a child under a timeout so a regression to a
// blocking manifest read shows as a SIGTERM kill rather than hanging the whole suite.
if (process.env.GRIPE_FACTS_CHILD) {
  process.stdout.write(JSON.stringify(installFacts(process.env.GRIPE_FACTS_CHILD)))
  process.exit(0)
}

let checks = 0
let failures = 0
function check(name, ok, detail) {
  checks++
  if (ok) {
    console.log(`  ok: ${name}${detail ? ` - ${detail}` : ''}`)
  } else {
    failures++
    console.log(`  FAIL: ${name}${detail ? ` - ${detail}` : ''}`)
  }
}

const TMP = mkdtempSync(join(tmpdir(), 'gripe-shim-'))
let serial = 0

// ---------------------------------------------------------------- synthetic home builders

// The stub stands in for a real bin/gripe: it prints the root it was launched from and
// touches a marker, so a case can prove which install ran and, more importantly, that a
// refused resolution ran nothing at all.
const stubSource = (root) => [
  '#!/usr/bin/env node',
  `require('fs').writeFileSync(${JSON.stringify(join(root, 'ran'))}, process.argv.slice(2).join(' '))`,
  `console.log('ROOT=' + ${JSON.stringify(normalizeRoot(root))})`,
  'process.exitCode = Number(process.env.GRIPE_STUB_EXIT || 0)',
  '',
].join('\n')

function plantRoot(root) {
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'gripe'), stubSource(root), { mode: 0o755 })
  return normalizeRoot(root)
}

const ran = (root) => {
  try {
    statSync(join(root, 'ran'))
    return true
  } catch {
    return false
  }
}

function makeHome() {
  const home = join(TMP, `home-${++serial}`)
  mkdirSync(home, { recursive: true })
  return home
}

function claudeRegistry(home, value) {
  const dir = join(home, '.claude', 'plugins')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'installed_plugins.json'), typeof value === 'string' ? value : JSON.stringify(value))
}

const registry = (...entries) => ({ plugins: { 'gripe@jakub': entries } })
const entry = (installPath, version) => (version === undefined ? { installPath } : { installPath, version })
const claudeCacheDir = (home) => join(home, '.claude', 'plugins', 'cache')
const claudeInstall = (home, version, marketplace = 'jakub') =>
  plantRoot(join(claudeCacheDir(home), marketplace, 'gripe', version))

function codexConfig(home, contents) {
  const dir = join(home, '.codex')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.toml'), contents)
}

const codexCacheDir = (home) => join(home, '.codex', 'plugins', 'cache')
const codexInstall = (home, version, marketplace = 'jakub') =>
  plantRoot(join(codexCacheDir(home), marketplace, 'gripe', version))
const table = (enabled, marketplace = 'jakub') =>
  `[plugins."gripe@${marketplace}"]\nenabled = ${enabled}\n`

const resolveIn = (home, env = {}) => resolveGripeRoot({ env, home })

try {
  console.log('resolver: the confirmed tier')

  {
    // The live skew on this machine, 2026-08-31: Claude registered 0.2.0, Codex cached
    // 0.2.1. Newest wins across harnesses or the whole dual read was pointless.
    const home = makeHome()
    const claude = claudeInstall(home, '0.2.0')
    claudeRegistry(home, registry(entry(claude, '0.2.0')))
    codexConfig(home, table('true'))
    const codex = codexInstall(home, '0.2.1')
    check('1. claude 0.2.0 exact vs codex 0.2.1 enabled resolves codex',
      resolveIn(home).root === codex, resolveIn(home).root)
  }

  {
    const home = makeHome()
    const claude = claudeInstall(home, '0.3.0')
    claudeRegistry(home, registry(entry(claude, '0.3.0')))
    codexConfig(home, table('true'))
    codexInstall(home, '0.2.1')
    check('2. the same skew reversed resolves claude 0.3.0', resolveIn(home).root === claude)
  }

  {
    const home = makeHome()
    const claude = claudeInstall(home, '0.4.0')
    claudeRegistry(home, registry(entry(claude, '0.4.0')))
    codexConfig(home, table('true'))
    codexInstall(home, '0.4.0')
    check('3. equal versions prefer the manager-supplied root over the cache-derived one',
      resolveIn(home).root === claude)
  }

  {
    // A readable registry with no gripe entry means uninstalled, so Claude's stale cache
    // must not answer. It says nothing at all about the Codex install.
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    claudeInstall(home, '0.9.0')
    codexConfig(home, table('true'))
    const codex = codexInstall(home, '0.2.1')
    check('4. readable-empty claude registry blocks only the claude cache',
      resolveIn(home).root === codex, resolveIn(home).root)
  }

  {
    // The mirror image, and the reason the veto is per-harness: a Codex config that says
    // "not installed here" cannot reach across and cancel Claude's outage fallback.
    const home = makeHome()
    codexConfig(home, table('false'))
    codexInstall(home, '0.4.0')
    const claude = claudeInstall(home, '0.1.0')
    check('5. enabled = false blocks only the codex cache, claude falls back to 0.1.0',
      resolveIn(home).root === claude, resolveIn(home).root)
  }

  {
    const home = makeHome()
    claudeInstall(home, '0.9.0')
    const codex = codexInstall(home, '0.10.0')
    check('6. both manifests unreadable, the highest cache across both wins numerically',
      resolveIn(home).root === codex, resolveIn(home).root)
  }

  {
    // Dated live evidence: codex-cli 0.151.0, config read 2026-08-31, every plugins table
    // carries an explicit boolean. The bare-table branch is therefore unreachable today,
    // and pinned here because bare-as-absent would silently drop a real registration.
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, '[plugins."gripe@jakub"]\n')
    const codex = codexInstall(home, '0.2.1')
    check('7. a bare table is a registration and resolves', resolveIn(home).root === codex)
  }

  {
    // R5: the flip side of the malformed-line class. A genuinely well-formed OTHER key
    // (`priority = 2`) is ignored exactly as before, so the bare table with no `enabled` key
    // still counts as the registration and resolves enabled. Closing the malformed class must
    // not sweep a clean non-enabled key into absence.
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, '[plugins."gripe@jakub"]\npriority = 2\n')
    const codex = codexInstall(home, '0.2.1')
    check('7b. a well-formed non-enabled key leaves the bare table enabled',
      resolveIn(home).root === codex, resolveIn(home).root)
  }

  {
    // And a well-formed other key alongside an explicit `enabled = true` still resolves: the
    // other key is ignored and the exact bare toggle sets enabledness.
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, '[plugins."gripe@jakub"]\npriority = 2\nenabled = true\n')
    const codex = codexInstall(home, '0.2.1')
    check('7c. a well-formed other key next to `enabled = true` resolves',
      resolveIn(home).root === codex, resolveIn(home).root)
  }

  const absenceCases = [
    ['8. the same table twice is absence', `${table('true')}\n${table('true')}`],
    ['9. two marketplaces are absence', `${table('true')}\n${table('true', 'other')}`],
    ['10a. enabled = "true" is absence', '[plugins."gripe@jakub"]\nenabled = "true"\n'],
    ['10b. enabled = 1 is absence', '[plugins."gripe@jakub"]\nenabled = 1\n'],
    ['10c. a duplicate enabled key is absence', '[plugins."gripe@jakub"]\nenabled = true\nenabled = true\n'],
    ['23a. a `..` marketplace is rejected', '[plugins."gripe@.."]\nenabled = true\n'],
    ['23b. an `a/b` marketplace is rejected', '[plugins."gripe@a/b"]\nenabled = true\n'],
    // F7: a disable written in any form a real TOML parser reads as `enabled = false` must
    // never be scanned as the enabled default. Basic-string escapes and dotted keys both
    // spell an enabled key the old literal matcher missed, so they are ambiguity -> absence.
    ['F7a. a basic-escape enabled key set false is absence', '[plugins."gripe@jakub"]\n"\\u0065nabled" = false\n'],
    ['F7b. a dotted enabled key is absence', '[plugins."gripe@jakub"]\nenabled.value = false\n'],
    ['F7c. a quoted enabled key set false is absence', '[plugins."gripe@jakub"]\n"enabled" = false\n'],
    // G3: a \U escape naming a code point past U+10FFFF is undecodable, so the key is
    // ambiguity, not a silently-skipped non-enabled key. It must resolve to absence, and it
    // must never throw RangeError out of String.fromCodePoint and abort the whole resolve.
    ['G3a. a hostile out-of-range \\U escape key is absence, not a throw',
      '[plugins."gripe@jakub"]\n"\\UFFFFFFFFnabled" = false\n'],
    // R3: a key that opens a quoted string it never closes is malformed, not a
    // non-assignment. The old scanner returned null for it and skipped it like a blank line,
    // so the table fell through to the bare-table enabled default - a broken disable read as
    // enabled, the fail-open direction the design forbids. Both an unterminated quote and a
    // dangling escape that swallows the closing quote resolve to absence now.
    ['R3a. an unterminated basic-string key is absence', '[plugins."gripe@jakub"]\n"enabled = false\n'],
    ['R3b. a dangling-escape key that swallows its close is absence',
      '[plugins."gripe@jakub"]\n"enabled\\" = false\n'],
    // R5: the malformed-line class, closed structurally. The scanner now whitelists a
    // well-formed `key = value` (a clean bare, basic, or literal key with a real top-level
    // `=`) and treats every other non-blank, non-comment line as malformed -> ambiguity ->
    // absence. These are the shapes reviewers kept finding one at a time; the fix is the
    // whitelist, not this list. A half-finished `enabled` line must read as absence, never
    // fall through to the bare-table enabled default.
    ['R5a. a bare `enabled` with no `=` is absence', '[plugins."gripe@jakub"]\nenabled\n'],
    ['R5b. `"enabled"x = false` is absence', '[plugins."gripe@jakub"]\n"enabled"x = false\n'],
    ['R5c. `enabled! = false` is absence', '[plugins."gripe@jakub"]\nenabled! = false\n'],
    ['R5d. `enabled other = false` is absence', '[plugins."gripe@jakub"]\nenabled other = false\n'],
    ["R5e. `'enabled'x = false` is absence", '[plugins."gripe@jakub"]\n\'enabled\'x = false\n'],
    ['R5f. a trailing-backslash quoted key is absence', '[plugins."gripe@jakub"]\n"enabled\\\n'],
    ['R5g. a bare word then a comment, no `=`, is absence', '[plugins."gripe@jakub"]\nenabled # yes\n'],
    ['R5h. an `=` with an empty key is absence', '[plugins."gripe@jakub"]\n = false\n'],
    // R5 round-5: the recognizer is now a positive whitelist, so an OTHER key stays ignored
    // ONLY when its value is a fully recognized conservative scalar. An empty, junk, or
    // bracket-shaped value, a dotted or escaped key, or a bracket line that is not a clean
    // table header all fail closed to absence rather than leaking the bare-table enabled
    // default. Every input a reviewer surfaced across rounds 4-5 is pinned here.
    ['R5i. `priority =` with an empty value is absence', '[plugins."gripe@jakub"]\npriority =\n'],
    ['R5j. `priority = @` is absence', '[plugins."gripe@jakub"]\npriority = @\n'],
    ['R5k. `priority = ]` is absence', '[plugins."gripe@jakub"]\npriority = ]\n'],
    ['R5l. a dotted, bad-escape other key is absence', '[plugins."gripe@jakub"]\nfoo."bad\\q" = 1\n'],
    ['R5m. a dotted, out-of-range-escape other key is absence',
      '[plugins."gripe@jakub"]\npriority."\\UFFFFFFFF" = 1\n'],
    ['R5n. a quoted key with a raw control char is absence',
      `[plugins."gripe@jakub"]\n"en${String.fromCharCode(1)}abled" = false\n`],
    ['R5o. a bare `[` line inside the table is absence, not a silent end',
      '[plugins."gripe@jakub"]\nenabled = true\n[\n'],
    ['R5p. a bracket line with trailing junk is absence',
      '[plugins."gripe@jakub"]\nenabled = true\n[other]x\n'],
  ]
  for (const [name, contents] of absenceCases) {
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, contents)
    codexInstall(home, '0.2.1')
    codexInstall(home, '0.2.1', 'other')
    let root
    let threw = null
    try {
      root = resolveIn(home).root
    } catch (error) {
      threw = String(error?.message ?? error)
    }
    check(name, threw === null && root === null, threw ?? root)
  }

  {
    // G3: one harness's hostile bytes must never sink the other. The same out-of-range \U
    // escape that used to throw out of resolveGripeRoot sits in the codex config, but a valid
    // Claude 1.0.0 registry is present: the codex table decodes to absence and Claude still
    // resolves, so add stays exit-0-and-files-when-anything-resolves.
    const home = makeHome()
    const claude = claudeInstall(home, '1.0.0')
    claudeRegistry(home, registry(entry(claude, '1.0.0')))
    codexConfig(home, '[plugins."gripe@jakub"]\n"\\UFFFFFFFFnabled" = false\n')
    let root
    let threw = null
    try {
      root = resolveIn(home).root
    } catch (error) {
      threw = String(error?.message ?? error)
    }
    check('G3b. a hostile codex \\U escape never sinks a valid claude filing',
      threw === null && root === claude, threw ?? root)
  }

  {
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, table('true'))
    for (const name of ['0.3.0-rc.1', 'latest', '0.3', '1.2.3.4', 'v1.2.3', '.hidden', '0.2.0']) {
      plantRoot(join(codexCacheDir(home), 'jakub', 'gripe', name))
    }
    check('11. prerelease and malformed cache names are not versions',
      resolveIn(home).root === normalizeRoot(join(codexCacheDir(home), 'jakub', 'gripe', '0.2.0')),
      resolveIn(home).root)
  }

  {
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, table('true'))
    mkdirSync(join(codexCacheDir(home), 'jakub', 'gripe', '0.9.0'), { recursive: true })
    const good = codexInstall(home, '0.2.0')
    check('12. a semver directory with no bin/gripe is skipped for the next best',
      resolveIn(home).root === good, resolveIn(home).root)
  }

  {
    // The entry is real, the tree it names is gone. That is still a readable registry, so
    // Claude is uninstalled-with-a-stale-entry and its cache stays blocked.
    const home = makeHome()
    claudeRegistry(home, registry(entry(join(home, 'deleted', 'gripe'), '9.9.9')))
    claudeInstall(home, '0.7.0')
    const resolved = resolveIn(home)
    check('13. a registry entry at a deleted path is absence, not an outage',
      resolved.root === null, resolved.root)
  }

  {
    const home = makeHome()
    const claude = plantRoot(join(claudeCacheDir(home), 'jakub', 'gripe', '1.4.0'))
    claudeRegistry(home, registry(entry(claude, 'nightly')))
    codexConfig(home, table('true'))
    codexInstall(home, '1.3.0')
    check('14a. a junk registry version falls back to the path basename',
      resolveIn(home).root === claude, resolveIn(home).root)
  }

  {
    const home = makeHome()
    const claude = plantRoot(join(home, 'checkout'))
    claudeRegistry(home, registry(entry(claude, 'nightly')))
    const resolved = resolveIn(home)
    check('14b. an unknown version still resolves when it is the only candidate',
      resolved.root === claude && resolved.candidates[0]?.version === null, resolved.root)
  }

  console.log('resolver: hostile and oversized manifests')

  const hostileCases = [
    ['15a. a 200 KiB unterminated line is absence', `${table('true')}${'x'.repeat(200 * 1024)}`, null],
    ['15b. a header inside a multi-line string is absence',
      `motd = """\n[plugins."gripe@jakub"]\nenabled = true\n"""\n`, null],
    ['15c. a NUL byte is absence', `${table('true')}${String.fromCharCode(0)}`, null],
    ['15d. invalid UTF-8 is absence', null, null],
    ['15e. CRLF around a real table resolves', table('true').replace(/\n/g, '\r\n'), 'resolved'],
    ['15f. whitespace and a trailing comment on the header resolves',
      '  [plugins."gripe@jakub"]  # registered\n  enabled = true # on\n', 'resolved'],
  ]
  for (const [name, contents, expect] of hostileCases) {
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    const codex = codexInstall(home, '0.2.1')
    if (contents === null) {
      // Bytes that are not UTF-8 at all: the read turns them into replacement characters,
      // which is exactly the signal the scanner refuses to guess past.
      mkdirSync(join(home, '.codex'), { recursive: true })
      writeFileSync(join(home, '.codex', 'config.toml'),
        Buffer.concat([Buffer.from(table('true')), Buffer.from([0xff, 0xfe, 0xfd])]))
    } else {
      codexConfig(home, contents)
    }
    let root
    let threw = null
    try {
      root = resolveIn(home).root
    } catch (error) {
      threw = String(error?.message ?? error)
    }
    check(name, threw === null && root === (expect === 'resolved' ? codex : null), threw ?? root)
  }

  {
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, `${table('true')}${'#'.repeat(2 * 1024 * 1024)}\n`)
    const codex = codexInstall(home, '0.6.0')
    // Human-ratified 2026-09-01: a config too big to read is an outage, not an answer,
    // so the fallback runs. The line cap never gets a look at this file.
    check('16a. a 2 MiB codex config is unreadable and the codex cache fallback runs',
      resolveIn(home).root === codex, resolveIn(home).root)
  }

  {
    const home = makeHome()
    claudeRegistry(home, `{"plugins":{}}${' '.repeat(2 * 1024 * 1024)}`)
    const claude = claudeInstall(home, '0.6.0')
    codexConfig(home, table('false'))
    check('16b. a 2 MiB claude registry is unreadable and the claude cache fallback runs',
      resolveIn(home).root === claude, resolveIn(home).root)
  }

  {
    const home = makeHome()
    claudeRegistry(home, '{"plugins": {')
    const claude = claudeInstall(home, '0.5.0')
    codexConfig(home, table('false'))
    check('17. malformed registry JSON is an outage and the claude fallback runs',
      resolveIn(home).root === claude, resolveIn(home).root)
  }

  {
    const home = makeHome()
    const elsewhereName = `codex-elsewhere-${serial}`
    const elsewhere = join(TMP, elsewhereName)
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'config.toml'), table('true'))
    const codex = plantRoot(join(elsewhere, 'plugins', 'cache', 'jakub', 'gripe', '0.8.0'))
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, table('false'))
    codexInstall(home, '9.9.9')
    const absolute = resolveIn(home, { CODEX_HOME: elsewhere })
    check('18a. CODEX_HOME redirects both the config read and the cache scan',
      absolute.root === codex, absolute.root)

    const cwd = process.cwd()
    process.chdir(TMP)
    const relative = resolveIn(home, { CODEX_HOME: `./${elsewhereName}` })
    process.chdir(cwd)
    check('18b. a relative CODEX_HOME resolves once and is recorded absolute',
      relative.root === codex && relative.surfaces.some((surface) => surface === join(elsewhere, 'config.toml')),
      relative.surfaces.join(' '))
  }

  console.log('resolver: the override and the total miss')

  {
    const home = makeHome()
    const override = plantRoot(join(TMP, `override-${serial}`))
    claudeRegistry(home, registry(entry(claudeInstall(home, '9.9.9'), '9.9.9')))
    const resolved = resolveIn(home, { GRIPE_HOME: override })
    check('19. a valid GRIPE_HOME beats every install and reads no registry',
      resolved.root === override && resolved.surfaces.length === 1,
      resolved.surfaces.join(' '))
  }

  {
    const home = makeHome()
    const installed = claudeInstall(home, '1.0.0')
    claudeRegistry(home, registry(entry(installed, '1.0.0')))
    const broken = join(TMP, `broken-override-${serial}`)
    mkdirSync(broken, { recursive: true })
    for (const [label, value] of [['broken', broken], ['empty', '']]) {
      const resolved = resolveIn(home, { GRIPE_HOME: value })
      check(`20a. a ${label} GRIPE_HOME stops instead of falling through`,
        resolved.root === null && resolved.error === 'override', resolved.error)
    }
    let stderr = ''
    const code = main({
      argv: ['add'],
      env: { GRIPE_HOME: broken },
      home,
      spawn: () => { throw new Error('the shim spawned something under a broken override') },
      stderr: (text) => { stderr += text },
    })
    check('20b. the broken-override diagnostic names GRIPE_HOME and nothing else',
      code === 0 && stderr.includes('GRIPE_HOME') && !stderr.includes('installed_plugins')
        && !ran(installed),
      JSON.stringify(stderr))
  }

  {
    const home = makeHome()
    let stderr = ''
    const code = main({
      argv: ['dump'],
      env: {},
      home,
      spawn: () => { throw new Error('the shim spawned something with no root') },
      stderr: (text) => { stderr += text },
    })
    const surfaces = resolveIn(home).surfaces
    check('21. the total miss names every surface checked, in one bounded line',
      code === 1
      && surfaces.length === 4
      && surfaces.every((surface) => stderr.includes(surface))
      && Buffer.byteLength(stderr) <= 2048
      && stderr.endsWith('\n')
      && stderr.indexOf('\n') === stderr.length - 1,
      JSON.stringify(stderr))
  }

  {
    // F8: a readable, enabled codex table with an empty cache is a confirmed scan that
    // found nothing. The cache root it scanned belongs in the miss diagnostic, not only in
    // the unreadable-config fallback branch that the both-unreadable miss happens to hit.
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, table('true'))
    const codexCache = codexCacheDir(home)
    let stderr = ''
    const code = main({
      argv: ['dump'],
      env: {},
      home,
      spawn: () => { throw new Error('the shim spawned something with no root') },
      stderr: (text) => { stderr += text },
    })
    check('F8. a confirmed but empty codex cache is named in the miss diagnostic',
      code === 1 && resolveIn(home).surfaces.includes(codexCache) && stderr.includes(codexCache),
      JSON.stringify(stderr))
  }

  {
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, table('true'))
    const older = plantRoot(join(codexCacheDir(home), 'jakub', 'gripe', '9007199254740992.0.1'))
    const newer = plantRoot(join(codexCacheDir(home), 'jakub', 'gripe', '9007199254740993.0.0'))
    check('22. version components compare as BigInt, past 2^53',
      resolveIn(home).root === newer && resolveIn(home).root !== older, resolveIn(home).root)
  }

  {
    const home = makeHome()
    const first = plantRoot(join(home, 'a-install'))
    const second = plantRoot(join(home, 'b-install'))
    claudeRegistry(home, registry(entry(first, '2.0.0'), entry(second, '2.0.0')))
    const once = resolveIn(home).root
    const twice = resolveIn(home).root
    check('23c. an equal-version tie at two paths is broken deterministically',
      once === twice && once === first, `${once} then ${twice}`)
  }

  console.log('resolver: cache confinement')

  {
    // A version directory inside the cache that is a symlink to a payload outside it. Its
    // realpath escapes the cache root, so the confined scan must reject it and fall to the
    // real 0.2.0 install even though the escaping name (9.9.9) sorts higher.
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, table('true'))
    const outside = plantRoot(join(TMP, `f1-escape-${serial}`))
    const versionDir = join(codexCacheDir(home), 'jakub', 'gripe', '9.9.9')
    mkdirSync(dirname(versionDir), { recursive: true })
    symlinkSync(outside, versionDir)
    const good = codexInstall(home, '0.2.0')
    check('F1a. a cache version dir symlinked outside its root is rejected',
      resolveIn(home).root === good, resolveIn(home).root)
  }

  {
    // The user's explicit override is not a cache candidate and stays exempt: GRIPE_HOME
    // may point anywhere, cache root or not.
    const home = makeHome()
    const override = plantRoot(join(TMP, `f1-override-${serial}`))
    claudeRegistry(home, { plugins: {} })
    check('F1b. GRIPE_HOME outside any cache still resolves',
      resolveIn(home, { GRIPE_HOME: override }).root === override, override)
  }

  {
    // FIX 2 (round 5): the round-4 version-name confinement realpath'd the version dir and only
    // required bin/gripe to stay under the cache root, so a real 0.6.0 dir whose bin/gripe is a
    // symlink to 0.5.0's binary - both inside the cache - ranked as 0.6.0 while it would spawn
    // 0.5.0. That is a version spoof / forced rollback: the executed binary did not belong to
    // the ranked version. confinedBinary now also requires realpath(bin/gripe) to equal
    // <versionDir>/bin/gripe, so the cross-version symlink is rejected and the real 0.5.0 wins,
    // ranked and spawned as itself. (This construction PASSED before the fix; it must now fail.)
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, table('true'))
    const real = codexInstall(home, '0.5.0')
    const sixBin = join(codexCacheDir(home), 'jakub', 'gripe', '0.6.0', 'bin')
    mkdirSync(sixBin, { recursive: true })
    symlinkSync(join(real, 'bin', 'gripe'), join(sixBin, 'gripe'))
    const resolved = resolveIn(home)
    const canonical = realpathSync(join(real, 'bin', 'gripe'))
    const spoofed = resolved.candidates.some((candidate) => candidate.root.endsWith('0.6.0'))
    let spawnedTarget = null
    const code = main({
      argv: ['add'],
      env: {},
      home,
      spawn: (execPath, args) => { spawnedTarget = args[0]; return { status: 0 } },
      stderr: () => {},
    })
    check('F2c. a cross-version in-cache bin symlink is rejected, the real 0.5.0 wins and spawns',
      code === 0 && !spoofed && resolved.root === real
      && resolved.bin === canonical && spawnedTarget === canonical,
      `root ${resolved.root} spoofed=${spoofed} bin ${resolved.bin} spawned ${spawnedTarget}`)
  }

  {
    // F2: confinement must cover every traversed component, not just the version root and its
    // bin. The marketplace `spoof` is a symlink out of the cache; outside/gripe/9.9.9 is a
    // symlink back to a real 0.1.0 inside the cache. Round 3 realpath'd the version root, its
    // bin, and bin/gripe, all of which resolve inside the cache, so 9.9.9 was admitted and
    // ranked as 9.9.9 while its canonical binary was 0.1.0 - a version spoof / forced rollback.
    // The version dir's canonical path must now equal `<realCache>/<marketplace>/gripe/<name>`,
    // so the spoof's realpath (`.../inside/gripe/0.1.0`, name and marketplace both wrong) is
    // rejected and the real 0.1.0 wins, ranked by its true version. Both manifests are absent,
    // so the fallback tier walks the codex cache across all marketplaces.
    const home = makeHome()
    const real010 = codexInstall(home, '0.1.0', 'inside')
    const outside = join(TMP, `f2-outside-${++serial}`)
    mkdirSync(join(outside, 'gripe'), { recursive: true })
    symlinkSync(real010, join(outside, 'gripe', '9.9.9'))
    mkdirSync(codexCacheDir(home), { recursive: true })
    symlinkSync(outside, join(codexCacheDir(home), 'spoof'))
    const resolved = resolveIn(home)
    const spoofed = resolved.candidates.some((candidate) => candidate.root.endsWith('9.9.9'))
    check('F2a. a symlinked-out marketplace escape is rejected, the real 0.1.0 wins by true version',
      resolved.root === real010 && !spoofed, `${resolved.root} spoofed=${spoofed}`)
  }

  {
    // F2: a normal cache candidate at its true canonical location still resolves and ranks by
    // its real version. The exact-location check must not reject a legitimate real install.
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, table('true'))
    const codex = codexInstall(home, '0.7.0')
    const resolved = resolveIn(home)
    check('F2b. a real cache candidate resolves and ranks by its true version',
      resolved.root === codex && resolved.candidates[0]?.version?.join('.') === '0.7.0',
      `${resolved.root} ${resolved.candidates[0]?.version?.join('.')}`)
  }

  {
    const long = 'a'.repeat(4000)
    const line = boundedLine(`${long}\nsecond line`)
    check('bounded diagnostics: one line, one newline, at most 2048 bytes',
      Buffer.byteLength(line) <= 2048 && line.endsWith('\n')
      && line.indexOf('\n') === line.length - 1 && !line.includes(String.fromCharCode(7)),
      `${Buffer.byteLength(line)} bytes`)
  }

  check('version parsing admits leading zeros and compares them numerically',
    compareVersions(parseStableVersion('01.2.3'), parseStableVersion('1.2.4')) > 0
    && parseStableVersion('1.2.3-rc1') === null && parseStableVersion('1.2') === null)

  check('an unrecognized codex table shape reports no registration',
    parseCodexRegistration('[plugins."flow@jakub"]\nenabled = true\n').registered === false
    && parseCodexRegistration(table('true')).enabled === true)

  console.log('the honesty split')

  const filingHome = makeHome()
  const filingRoot = claudeInstall(filingHome, '1.1.0')
  claudeRegistry(filingHome, registry(entry(filingRoot, '1.1.0')))
  const enoent = () => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), status: null })
  const neverSpawn = () => { throw new Error('the shim spawned something it should not have') }

  const OUTCOMES = [
    { name: 'spawn error (ENOENT)', home: filingHome, spawn: enoent, honest: 1, diagnostic: /ENOENT/ },
    {
      name: 'an error alongside a status (the error wins)',
      home: filingHome,
      spawn: () => ({ ...enoent(), status: 3 }),
      honest: 1,
      diagnostic: /ENOENT/,
    },
    {
      name: 'a signal, named and never turned into 128+n',
      home: filingHome,
      spawn: () => ({ status: null, signal: 'SIGKILL' }),
      honest: 1,
      diagnostic: /SIGKILL/,
    },
    { name: 'a real child status of 7', home: filingHome, spawn: () => ({ status: 7 }), honest: 7, diagnostic: null },
    { name: 'a real child status of 0', home: filingHome, spawn: () => ({ status: 0 }), honest: 0, diagnostic: null },
    { name: 'no installation at all', home: makeHome(), spawn: neverSpawn, honest: 1, diagnostic: /no installation/ },
    { name: 'the resolver throwing', home: 42, spawn: neverSpawn, honest: 1, diagnostic: /resolution failed/ },
  ]

  // A getter that flags any read of process.stdin. The shim must not so much as touch it:
  // a synchronous read on an inherited pipe never returns, and a hung `gripe add` stops
  // the agent that called it.
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')
  let stdinTouched = false
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    get() {
      stdinTouched = true
      return stdinDescriptor.get.call(process)
    },
  })

  try {
    for (const outcome of OUTCOMES) {
      const observed = []
      let ok = true
      for (const argv of [[], ['add'], ['doctor'], ['dump']]) {
        const filing = argv.length === 0 || argv[0] === 'add'
        let stderr = ''
        let stdio = null
        const code = main({
          argv,
          env: {},
          home: outcome.home,
          spawn: (execPath, args, options) => {
            stdio = options?.stdio
            return outcome.spawn()
          },
          stderr: (text) => { stderr += text },
        })
        const expected = filing ? 0 : outcome.honest
        observed.push(`[${argv.join(' ')}] ${code}`)
        if (code !== expected) ok = false
        if (stdio !== null && stdio !== 'inherit') ok = false
        if (outcome.diagnostic === null) {
          // A real exit code is the child's own report; a second line from the shim would
          // be noise on top of it.
          if (stderr !== '') ok = false
        } else if (
          !outcome.diagnostic.test(stderr) || !stderr.endsWith('\n')
          || stderr.indexOf('\n') !== stderr.length - 1 || Buffer.byteLength(stderr) > 2048
        ) {
          ok = false
        }
      }
      check(`exit matrix: ${outcome.name}`, ok, observed.join(', '))
    }
  } finally {
    Object.defineProperty(process, 'stdin', stdinDescriptor)
  }
  check('the shim never touches process.stdin', !stdinTouched)

  console.log('the honesty split, end to end')

  const liveHome = makeHome()
  const liveRoot = claudeInstall(liveHome, '1.2.0')
  claudeRegistry(liveHome, registry(entry(liveRoot, '1.2.0')))
  const cleanEnv = (home, extra = {}) => ({ PATH: process.env.PATH, HOME: home, ...extra })

  const runShim = (argv, env) =>
    spawnSync(process.execPath, [SHIM, ...argv], { encoding: 'utf8', env })

  {
    const missHome = makeHome()
    const started = process.hrtime.bigint()
    const child = spawn(process.execPath, [SHIM, 'add'], {
      env: cleanEnv(missHome),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // stdin stays open and empty for the child's whole life. A shim that reads it hangs
    // here, which is the failure this case exists to catch.
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timed out') }, 10_000)
      child.on('close', (status) => { clearTimeout(timer); resolve(status) })
    })
    child.stdin.destroy()
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    check('add on a total miss exits 0 with an open unwritten stdin pipe',
      code === 0 && ms < 10_000, `exit ${code} after ${Math.round(ms)}ms`)
  }

  {
    const missHome = makeHome()
    const result = runShim(['doctor'], cleanEnv(missHome))
    check('doctor on a total miss exits 1 and says what it checked',
      result.status === 1 && result.stderr.includes('no installation found'),
      JSON.stringify(result.stderr))
  }

  {
    const link = join(TMP, `gripe-link-${++serial}`)
    symlinkSync(SHIM, link)
    const override = plantRoot(join(TMP, `symlink-target-${serial}`))
    const result = spawnSync(process.execPath, [link, 'add', 'hello'], {
      encoding: 'utf8',
      env: cleanEnv(liveHome, { GRIPE_HOME: override }),
    })
    check('an invocation through a symlink still runs',
      result.status === 0 && result.stdout.includes(`ROOT=${override}`) && ran(override),
      JSON.stringify(result.stdout.trim()))
  }

  {
    const result = runShim(['dump'], cleanEnv(liveHome, { GRIPE_STUB_EXIT: '7' }))
    check('a human command passes a real child status through',
      result.status === 7 && result.stderr === '', `exit ${result.status}`)
  }

  {
    const result = runShim(['add'], cleanEnv(liveHome, { GRIPE_STUB_EXIT: '7' }))
    check('filing swallows the same status', result.status === 0, `exit ${result.status}`)
  }

  console.log('the epoch ratchet')

  const withMarker = (epoch, tail = 'console.log(1)') =>
    `#!/usr/bin/env node\n// gripe-shim-epoch: ${epoch}\n${tail}\n`
  const source = join(TMP, 'ratchet-source.mjs')
  writeFileSync(source, withMarker(1))
  const ratchetDir = join(TMP, 'ratchet')
  mkdirSync(ratchetDir, { recursive: true })
  let target = 0
  const nextTarget = () => join(ratchetDir, `shim-${++target}`)

  {
    const shimPath = nextTarget()
    const action = pointShim({ sourcePath: source, shimPath })
    check('a missing shim is written, executable',
      action === 'written' && readFileSync(shimPath, 'utf8') === withMarker(1)
      && (statSync(shimPath).mode & 0o777) === 0o755,
      `${action}, mode ${(statSync(shimPath).mode & 0o777).toString(8)}`)
  }

  {
    const shimPath = nextTarget()
    writeFileSync(shimPath, withMarker(1))
    // A correctly published shim is 0755; writeFileSync honours umask, so pin the mode.
    chmodSync(shimPath, 0o755)
    check('a byte-identical shim is left alone', pointShim({ sourcePath: source, shimPath }) === 'unchanged')
  }

  {
    // F6: a symlink whose target holds the source bytes is not a runnable shim. The dest
    // entry must become a regular 0755 file, not stay a symlink.
    const shimPath = nextTarget()
    const twin = join(TMP, 'f6-twin.mjs')
    writeFileSync(twin, withMarker(1))
    symlinkSync(twin, shimPath)
    const action = pointShim({ sourcePath: source, shimPath })
    const stat = lstatSync(shimPath)
    check('F6a. a symlink with the source bytes is rewritten to a regular 0755 file',
      action === 'written' && stat.isFile() && (stat.mode & 0o777) === 0o755
      && readFileSync(shimPath, 'utf8') === withMarker(1), action)
  }

  {
    // F6: an identical file at the wrong mode advertises a command that cannot run, so it
    // is rewritten rather than skipped.
    const shimPath = nextTarget()
    writeFileSync(shimPath, withMarker(1))
    chmodSync(shimPath, 0o644)
    const action = pointShim({ sourcePath: source, shimPath })
    check('F6b. an identical 0644 file is rewritten 0755',
      action === 'written' && (statSync(shimPath).mode & 0o777) === 0o755, action)
  }

  {
    const shimPath = nextTarget()
    writeFileSync(shimPath, withMarker(0))
    const action = pointShim({ sourcePath: source, shimPath })
    check('a lower epoch is upgraded',
      action === 'written' && readFileSync(shimPath, 'utf8') === withMarker(1), action)
  }

  {
    const shimPath = nextTarget()
    writeFileSync(shimPath, withMarker(1, 'console.log("drifted")'))
    const action = pointShim({ sourcePath: source, shimPath })
    check('equal-epoch byte drift is repaired',
      action === 'written' && readFileSync(shimPath, 'utf8') === withMarker(1), action)
  }

  {
    const shimPath = nextTarget()
    const newer = withMarker(2, 'console.log("from the future")')
    writeFileSync(shimPath, newer)
    const action = pointShim({ sourcePath: source, shimPath })
    check('a strictly higher epoch is kept, byte for byte',
      action === 'kept-newer' && readFileSync(shimPath, 'utf8') === newer, action)
  }

  {
    // G2: kept-newer must still leave a command PATH can run. A higher-epoch destination that
    // is a symlink pinned to an external target is re-materialized as a regular 0755 file
    // holding those same higher-epoch bytes, and still reports kept-newer.
    const shimPath = nextTarget()
    const twin = join(TMP, `g2a-twin-${++serial}.mjs`)
    const higher = withMarker(4, 'console.log("newer via symlink")')
    writeFileSync(twin, higher)
    symlinkSync(twin, shimPath)
    const action = pointShim({ sourcePath: source, shimPath })
    const stat = lstatSync(shimPath)
    check('G2a. a higher-epoch symlink dest becomes a regular 0755 file, bytes kept',
      action === 'kept-newer' && stat.isFile() && (stat.mode & 0o777) === 0o755
      && readFileSync(shimPath, 'utf8') === higher, `${action}, mode ${(stat.mode & 0o777).toString(8)}`)
  }

  {
    // G2: a higher-epoch destination at 0644 advertises a command that cannot run. Its bytes
    // are preserved, but the mode is fixed to 0755, and it still reports kept-newer.
    const shimPath = nextTarget()
    const higher = withMarker(5, 'console.log("newer at 0644")')
    writeFileSync(shimPath, higher)
    chmodSync(shimPath, 0o644)
    const action = pointShim({ sourcePath: source, shimPath })
    const stat = lstatSync(shimPath)
    check('G2b. a higher-epoch 0644 dest is re-materialized 0755, bytes unchanged',
      action === 'kept-newer' && stat.isFile() && (stat.mode & 0o777) === 0o755
      && readFileSync(shimPath, 'utf8') === higher, `${action}, mode ${(stat.mode & 0o777).toString(8)}`)
  }

  {
    // R2: materializeKeptNewer must report 'failed', not 'kept-newer', when the re-materialize
    // does not land. The destination is a symlink to higher-epoch bytes, so classify keeps it
    // and tries to re-materialize a runnable regular 0755 file. Its parent directory is read
    // only, so every temp create fails and the entry stays a symlink: the regular-0755
    // postcondition is unmet, and reporting kept-newer over a command PATH cannot run would be
    // a false success. The caller must surface the failure so a later SessionStart retries.
    const dir = join(TMP, `r2-readonly-${++serial}`)
    mkdirSync(dir, { recursive: true })
    const shimPath = join(dir, 'shim')
    const twin = join(TMP, `r2-twin-${serial}.mjs`)
    writeFileSync(twin, withMarker(9, 'console.log("newer")'))
    symlinkSync(twin, shimPath)
    chmodSync(dir, 0o555)
    let action = null
    let threw = null
    try {
      action = pointShim({ sourcePath: source, shimPath })
    } catch (error) {
      threw = String(error?.message ?? error)
    } finally {
      chmodSync(dir, 0o755)
    }
    const link = lstatSync(shimPath)
    check('R2. a failed re-materialize of a higher-epoch entry reports failed, not kept-newer',
      threw === null && action === 'failed' && link.isSymbolicLink(),
      threw ?? `${action}, ${link.isSymbolicLink() ? 'still a symlink' : 'not a symlink'}`)
  }

  {
    const shimPath = nextTarget()
    writeFileSync(shimPath, withMarker('banana'))
    const action = pointShim({ sourcePath: source, shimPath })
    check('an unparseable marker is overwritten, so corruption repairs itself',
      action === 'written' && readFileSync(shimPath, 'utf8') === withMarker(1), action)
  }

  {
    const shimPath = nextTarget()
    mkdirSync(shimPath, { recursive: true })
    let threw = null
    let action = null
    try {
      action = pointShim({ sourcePath: source, shimPath })
    } catch (error) {
      threw = String(error?.message ?? error)
    }
    check('a directory at the shim path fails without throwing',
      threw === null && action === 'failed', threw ?? action)
  }

  {
    const shimPath = nextTarget()
    const unversioned = join(TMP, 'ratchet-unversioned.mjs')
    writeFileSync(unversioned, '#!/usr/bin/env node\nconsole.log(1)\n')
    const action = pointShim({ sourcePath: unversioned, shimPath })
    let exists = true
    try {
      statSync(shimPath)
    } catch {
      exists = false
    }
    check('a source with no marker is refused and nothing is written',
      action === 'refused' && !exists, action)
  }

  {
    const shimPath = nextTarget()
    const contenders = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        env: {
          ...process.env,
          GRIPE_SHIM_RATCHET_CHILD: '1',
          GRIPE_SHIM_RATCHET_SOURCE: source,
          GRIPE_SHIM_RATCHET_TARGET: shimPath,
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let out = ''
      child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk })
      child.on('close', () => resolve(out))
    })))
    const leftovers = readdirSync(ratchetDir).filter((name) => name.endsWith('.tmp'))
    check('eight concurrent writers leave the source bytes and no temp files',
      readFileSync(shimPath, 'utf8') === withMarker(1) && leftovers.length === 0
      && contenders.every((action) => action === 'written' || action === 'unchanged'),
      contenders.join(','))
  }

  {
    // F4: a higher epoch that lands on disk between the initial classify and the pre-rename
    // re-read must not be downgraded. This is deterministic, not a speed race. A source that
    // reads as epoch 1 classifies the epoch-0 destination as 'write', so pointShim writes its
    // temp; the beforeRecheck seam then plants epoch-3 bytes at the destination immediately
    // before the pre-rename re-read. The lock-free guard must observe epoch 3 and report
    // 'kept-newer' without renaming its stale epoch-1 temp over the newer file. A pointShim
    // with no re-read would rename anyway and report 'written' - the downgrade this guards.
    const raceShim = nextTarget()
    writeFileSync(raceShim, withMarker(0))
    chmodSync(raceShim, 0o755)
    const higher = withMarker(3, 'console.log("from the future")')
    const action = pointShim({
      sourcePath: source,
      shimPath: raceShim,
      beforeRecheck: () => { writeFileSync(raceShim, higher); chmodSync(raceShim, 0o755) },
    })
    const finalEpoch = shimEpoch(readFileSync(raceShim, 'utf8'))
    check('F4. an epoch that rises to strictly-higher before the pre-rename re-read is kept',
      action === 'kept-newer' && finalEpoch === 3 && readFileSync(raceShim, 'utf8') === higher,
      `${action}, epoch ${finalEpoch}`)
  }

  {
    const shimPath = nextTarget()
    // A symlink at the shim path is replaced as a directory entry, never written through.
    const decoy = join(TMP, 'ratchet-decoy')
    writeFileSync(decoy, 'decoy\n')
    symlinkSync(decoy, shimPath)
    const action = pointShim({ sourcePath: source, shimPath })
    check('a symlink at the shim path is replaced, not followed',
      action === 'written' && readFileSync(shimPath, 'utf8') === withMarker(1)
      && readFileSync(decoy, 'utf8') === 'decoy\n', action)
  }

  check('shimEpoch: absent, doubled, and out-of-range markers all read null',
    shimEpoch('console.log(1)') === null
    && shimEpoch(`${withMarker(1)}// gripe-shim-epoch: 2\n`) === null
    && shimEpoch('// gripe-shim-epoch: 1234567890123\n') === null
    && shimEpoch('  //  gripe-shim-epoch:  0  \n') === 0
    && shimEpoch(withMarker(1).replace(/\n/g, '\r\n')) === 1)

  console.log('special files never hang')

  // A FIFO with no writer blocks a plain open forever. Every read on the resolution and
  // publication paths must open non-blocking and reject it, or `gripe add` hangs and the
  // filing contract is broken. Each case runs the real file under a timeout: a hang shows
  // as a SIGTERM kill, a fix as a prompt exit.
  const mkfifo = (path) => spawnSync('mkfifo', [path]).status === 0

  {
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    mkdirSync(join(home, '.codex'), { recursive: true })
    const made = mkfifo(join(home, '.codex', 'config.toml'))
    const result = spawnSync(process.execPath, [SHIM, 'add'], {
      encoding: 'utf8', env: cleanEnv(home), timeout: 8000,
    })
    check('F3a. gripe add with a fifo codex config exits 0 without hanging',
      made && result.signal !== 'SIGTERM' && result.status === 0,
      `${result.status} ${result.signal ?? ''}`)
  }

  {
    const home = makeHome()
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
    const made = mkfifo(join(home, '.claude', 'plugins', 'installed_plugins.json'))
    codexConfig(home, table('false'))
    const result = spawnSync(process.execPath, [SHIM, 'add'], {
      encoding: 'utf8', env: cleanEnv(home), timeout: 8000,
    })
    check('F3b. gripe add with a fifo claude registry exits 0 without hanging',
      made && result.signal !== 'SIGTERM' && result.status === 0,
      `${result.status} ${result.signal ?? ''}`)
  }

  {
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    mkdirSync(join(home, '.codex'), { recursive: true })
    const made = mkfifo(join(home, '.codex', 'config.toml'))
    const result = spawnSync(process.execPath, [SHIM, 'doctor'], {
      encoding: 'utf8', env: cleanEnv(home), timeout: 8000,
    })
    check('F3c. a fifo codex config reads unreadable and a non-filing command still reports',
      made && result.signal !== 'SIGTERM' && result.status === 1
      && result.stderr.includes('no installation found'),
      `${result.status} ${result.signal ?? ''}`)
  }

  {
    // usableRoot opens the candidate bin/gripe; a fifo there must not block either.
    const home = makeHome()
    claudeRegistry(home, { plugins: {} })
    codexConfig(home, table('true'))
    const bin = join(codexCacheDir(home), 'jakub', 'gripe', '0.2.0', 'bin')
    mkdirSync(bin, { recursive: true })
    const made = mkfifo(join(bin, 'gripe'))
    const result = spawnSync(process.execPath, [SHIM, 'doctor'], {
      encoding: 'utf8', env: cleanEnv(home), timeout: 8000,
    })
    check('F3d. a fifo bin/gripe is not a usable root and never blocks',
      made && result.signal !== 'SIGTERM' && result.status === 1
      && result.stderr.includes('no installation found'),
      `${result.status} ${result.signal ?? ''}`)
  }

  {
    // The publication path: a fifo at the shim path must not hang pointShim, and the fifo
    // is replaced by a regular file like any other stale entry.
    const shimPath = join(ratchetDir, 'fifo-shim')
    const made = mkfifo(shimPath)
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        GRIPE_SHIM_RATCHET_CHILD: '1',
        GRIPE_SHIM_RATCHET_SOURCE: source,
        GRIPE_SHIM_RATCHET_TARGET: shimPath,
      },
      stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 8000,
    })
    check('F3e. pointShim over a fifo shim path never hangs and replaces it',
      made && child.signal !== 'SIGTERM' && child.stdout.trim() === 'written'
      && lstatSync(shimPath).isFile() && readFileSync(shimPath, 'utf8') === withMarker(1),
      `${child.stdout.trim()} ${child.signal ?? ''}`)
  }

  {
    // R1: a fifo at the SOURCE path (a corrupted or partial install) must not hang pointShim.
    // The source read now goes through the same capped non-blocking helper as the destination,
    // so a non-regular source fails closed to 'failed' promptly instead of blocking on the
    // open and stalling every SessionStart to its hook timeout. Run under a timeout: a hang
    // shows as SIGTERM, the fix as a prompt 'failed' with nothing written at the target.
    const sourceFifo = join(ratchetDir, 'fifo-source')
    const made = mkfifo(sourceFifo)
    const shimPath = join(ratchetDir, 'fifo-source-target')
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        GRIPE_SHIM_RATCHET_CHILD: '1',
        GRIPE_SHIM_RATCHET_SOURCE: sourceFifo,
        GRIPE_SHIM_RATCHET_TARGET: shimPath,
      },
      stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 8000,
    })
    let exists = true
    try {
      statSync(shimPath)
    } catch {
      exists = false
    }
    check('F3f. pointShim over a fifo source path fails closed without hanging',
      made && child.signal !== 'SIGTERM' && child.stdout.trim() === 'failed' && !exists,
      `${child.stdout.trim()} ${child.signal ?? ''}`)
  }

  console.log('structure and install identity')

  {
    const text = readFileSync(SHIM, 'utf8')
    const markers = text.split('\n').filter((line) => /^[ \t]*\/\/[ \t]*gripe-shim-epoch:/.test(line))
    check('bin/shim.mjs carries exactly one parseable epoch marker',
      markers.length === 1 && shimEpoch(text) === 1, markers.join(' | '))
    const specifiers = [
      ...text.matchAll(/(?:^|\s)import\s[^'"\n]*from\s*['"]([^'"]+)['"]/g),
      ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g),
    ].map((hit) => hit[1])
    check('bin/shim.mjs imports node builtins only',
      specifiers.length > 0 && specifiers.every((specifier) => specifier.startsWith('node:')),
      specifiers.join(' '))
  }

  {
    const facts = (root) => installFacts(pathToFileURL(join(root, 'bin', 'gripe')).href)
    // The last directory component is what a plugin cache names an install, so a case
    // that wants the manifest to be the only possible source names it something else.
    const build = (name, manifests, version = 'unversioned') => {
      const root = join(TMP, 'facts', name, version)
      mkdirSync(join(root, 'bin'), { recursive: true })
      for (const [directory, contents] of Object.entries(manifests)) {
        mkdirSync(join(root, directory), { recursive: true })
        writeFileSync(join(root, directory, 'plugin.json'), contents)
      }
      return root
    }

    const claudeManifest = build('claude', { '.claude-plugin': '{"version":"1.5.0"}' })
    check('installFacts: the claude manifest supplies the version',
      facts(claudeManifest).plugin_version === '1.5.0'
      && facts(claudeManifest).plugin_root === normalizeRoot(claudeManifest))

    const codexManifest = build('codex', { '.codex-plugin': '{"version":"1.6.0"}' })
    check('installFacts: a missing claude manifest falls through to the codex one',
      facts(codexManifest).plugin_version === '1.6.0')

    const malformed = build('malformed', { '.claude-plugin': '{"version":' }, '2.1.0')
    check('installFacts: malformed JSON falls back to the cache directory name',
      facts(malformed).plugin_version === '2.1.0', facts(malformed).plugin_root)

    const nonSemver = build('nonsemver', { '.claude-plugin': '{"version":"nightly"}' }, '2.2.0')
    check('installFacts: a non-semver manifest version loses to a semver directory name',
      facts(nonSemver).plugin_version === '2.2.0')

    const neither = join(TMP, 'facts', 'neither')
    mkdirSync(join(neither, 'bin'), { recursive: true })
    const bare = facts(neither)
    check('installFacts: with neither, the version is null and the root is still reported',
      bare.plugin_version === null && bare.plugin_root === normalizeRoot(neither), bare.plugin_root)

    // A fifo (or other special file) at a manifest path used to hang installFacts on a blocking
    // readFileSync, before doctor could report identity or health, and the surrounding try/catch
    // could not catch a read that never returns. The capped non-blocking read rejects a
    // non-regular manifest, so the version falls through to null and the call returns promptly.
    // Run in a child under a timeout: a hang shows as SIGTERM, the fix as a prompt null.
    const fifoRoot = join(TMP, 'facts', 'fifo-manifest')
    mkdirSync(join(fifoRoot, 'bin'), { recursive: true })
    mkdirSync(join(fifoRoot, '.claude-plugin'), { recursive: true })
    const madeFactsFifo = mkfifo(join(fifoRoot, '.claude-plugin', 'plugin.json'))
    const factsChild = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, GRIPE_FACTS_CHILD: pathToFileURL(join(fifoRoot, 'bin', 'gripe')).href },
      encoding: 'utf8', timeout: 8000,
    })
    let factsOut = {}
    try {
      factsOut = JSON.parse(factsChild.stdout)
    } catch { /* the check below reports the raw output */ }
    check('installFacts: a fifo manifest reads unreadable without hanging, version null',
      madeFactsFifo && factsChild.signal !== 'SIGTERM'
      && factsOut.plugin_version === null && factsOut.plugin_root === normalizeRoot(fifoRoot),
      `${factsChild.stdout.trim()} ${factsChild.signal ?? ''}`)
  }

  {
    const stateHome = join(TMP, 'doctor-state')
    mkdirSync(stateHome, { recursive: true })
    const result = spawnSync(process.execPath, [join(PLUGIN, 'bin', 'gripe'), 'doctor'], {
      encoding: 'utf8',
      env: { ...process.env, XDG_STATE_HOME: stateHome },
    })
    let report = {}
    try {
      report = JSON.parse(result.stdout)
    } catch { /* the check below reports the raw output */ }
    // Read by key, never by position: doctor's report is a JSON object and a capture that
    // depends on field order is a capture that breaks on the next field added.
    const declared = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version
    check('gripe doctor names the running install and keeps its health verdict',
      result.status === 0
      && report.plugin_root === PLUGIN
      && report.plugin_version === declared
      && /^\d+\.\d+\.\d+$/.test(declared)
      && report.healthy === true,
      `${report.plugin_root} @ ${report.plugin_version}`)
  }

  console.log(`\ngripe shim: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} (${checks} checks)`)
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

process.exitCode = failures === 0 ? 0 : 1
