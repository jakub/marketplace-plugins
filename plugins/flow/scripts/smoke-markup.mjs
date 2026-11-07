#!/usr/bin/env node
// Smoke for scripts/markup.mjs, run as a child process from the repository root the way an agent
// runs it.
//
// The inputs are synthetic PNGs written here with node:zlib: a white 600x400 before, and the same
// with one solid red 80x40 rectangle as the after. The usage and spec cases always run, because
// markup.mjs decides them before it looks for Playwright. So do the discovery-trust cases: a
// throwaway repository holds a fake playwright that writes a marker file when it is loaded and
// whose chromium.launch throws. It must be skipped, and never loaded, when it is committed under
// node_modules, when its entry (by `main` or by a symlink) leaves node_modules, and when git can't
// say whether it is tracked; and it must be loaded when it is only present there, which proves
// the skip is about trust and not about where the module sits. The render cases need Playwright, which
// this repository does not ship: they run when markup.mjs resolves one by its own rules from the
// repository root (FLOW_MARKUP_PLAYWRIGHT included), and are skipped otherwise, with the reason on
// the last stdout line. With FLOW_MARKUP_PLAYWRIGHT set, an install that does not resolve or launch
// is a failure, not a skip, because the caller asked for the render cases by name.
//
// Run: node plugins/flow/scripts/smoke-markup.mjs
//      FLOW_MARKUP_PLAYWRIGHT=<dir|package.json> node plugins/flow/scripts/smoke-markup.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'markup.mjs')
const ROOT = join(HERE, '..', '..', '..')
let bad = 0
let checks = 0
const check = (name, ok, detail = '') => {
  checks += 1
  if (!ok) bad += 1
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` -> ${detail}`}`)
}

// ---- a minimal PNG encoder: 8-bit RGB, filter 0 on every row
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** A width x height PNG whose pixel at (x, y) is pixel(x, y) as [r, g, b]. */
const encodePng = (width, height, pixel) => {
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const RECT = { x: 300, y: 200, w: 80, h: 40 }
const inRect = (x, y) => x >= RECT.x && x < RECT.x + RECT.w && y >= RECT.y && y < RECT.y + RECT.h
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-markup-')))
const before = join(tmp, 'before.png')
const after = join(tmp, 'after.png')
writeFileSync(before, encodePng(600, 400, () => [255, 255, 255]))
writeFileSync(after, encodePng(600, 400, (x, y) => (inRect(x, y) ? [255, 0, 0] : [255, 255, 255])))

const run = (args, env = process.env) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env, timeout: 120_000 })
const io = ['--before', before, '--after', after]

console.log('usage errors exit 2')
{
  for (const [name, args] of [
    ['no arguments', []],
    ['an unknown flag', [...io, '--out', join(tmp, 'x.png'), '--wat']],
    ['a valued flag with no value', [...io, '--out']],
    ['no --out', io],
  ]) {
    const r = run(args)
    check(`${name}: exit 2 with the usage line`, r.status === 2 && r.stderr.includes('usage: node markup.mjs'), `${r.status} ${r.stderr}`)
  }
}

console.log('a bad spec exits 2 with a message, before any Playwright lookup')
{
  // No Playwright anywhere: a spec refusal must not depend on one being installed.
  const noPw = { ...process.env, FLOW_MARKUP_PLAYWRIGHT: join(tmp, 'no-such-install') }
  const malformed = join(tmp, 'malformed.json')
  writeFileSync(malformed, '{ "annotations": [ { "box": [1, 2, 3 ')
  const r = run([...io, '--spec', malformed, '--out', join(tmp, 'x.png')], noPw)
  check('a spec that is not JSON: exit 2, named as not JSON', r.status === 2 && r.stderr.includes('is not JSON'), `${r.status} ${r.stderr}`)
  const shape = join(tmp, 'shape.json')
  writeFileSync(shape, JSON.stringify({ annotations: [{ n: 1, box: [10, 10, 0, 5] }] }))
  const s = run([...io, '--spec', shape, '--out', join(tmp, 'x.png')], noPw)
  check('a box with zero width: exit 2, naming the annotation', s.status === 2 && s.stderr.includes('annotation 0: box must be'), `${s.status} ${s.stderr}`)
  const crop = join(tmp, 'crop.json')
  writeFileSync(crop, JSON.stringify({ crop: [0, 0, 10] }))
  const c = run([...io, '--auto', '--spec', crop, '--out', join(tmp, 'x.png')], noPw)
  check('a three-number crop, even under --auto: exit 2', c.status === 2 && c.stderr.includes('spec.crop must be'), `${c.status} ${c.stderr}`)
  for (const [name, bad] of [['zero width', [0, 0, 0, 100]], ['negative width', [0, 0, -10, 100]], ['zero height', [0, 0, 100, 0]], ['negative x', [-1, 0, 100, 100]]]) {
    writeFileSync(crop, JSON.stringify({ crop: bad }))
    const z = run([...io, '--spec', crop, '--out', join(tmp, 'x.png')], noPw)
    check(`a crop with ${name}: exit 2, naming the rule`, z.status === 2 && z.stderr.includes('positive w and h'), `${z.status} ${z.stderr}`)
  }
  const missing = run([...io, '--out', join(tmp, 'x.png')], noPw)
  check('a pointer that resolves no Playwright: exit 3, naming the pointer', missing.status === 3 && missing.stderr.includes('FLOW_MARKUP_PLAYWRIGHT points at'), `${missing.status} ${missing.stderr}`)
}

console.log('discovery trusts only an untracked install inside node_modules')
{
  const discoveryEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(tmp, 'none'), GIT_CONFIG_SYSTEM: join(tmp, 'none') }
  for (const key of ['FLOW_MARKUP_PLAYWRIGHT', 'NODE_PATH']) delete discoveryEnv[key]
  const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  // Code that writes the marker when it is loaded, and a chromium whose launch throws.
  const payload = (marker) => `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded')\n` +
    "module.exports = { chromium: { launch: async () => { throw new Error('fake playwright: no browser here') } } }\n"
  /**
   * A repository with a tracked pkg/package.json and a fake pkg/node_modules/playwright. `main` is
   * its package.json entry; `entry` is 'file' (a real index.js), 'payload' (no index.js, the entry
   * points at a root payload.cjs) or 'symlink' (index.js links to that payload.cjs). `track` adds
   * paths to the commit; `fakeGit` puts a git first on PATH whose ls-files fails; `markupEnv` adds
   * variables to markup's environment alone; `cwd` is where markup runs, relative to the repository.
   */
  const plant = (label, { main = 'index.js', entry = 'file', track = [], fakeGit = false, markupEnv = {}, cwd = '.' } = {}) => {
    const repo = join(tmp, label)
    const mod = join(repo, 'pkg', 'node_modules', 'playwright')
    const marker = join(tmp, `${label}.loaded`)
    mkdirSync(mod, { recursive: true })
    writeFileSync(join(repo, 'pkg', 'package.json'), '{ "name": "pkg", "private": true }\n')
    writeFileSync(join(mod, 'package.json'), `{ "name": "playwright", "version": "0.0.0", "main": ${JSON.stringify(main)} }\n`)
    if (entry === 'file') writeFileSync(join(mod, 'index.js'), payload(marker))
    else writeFileSync(join(repo, 'payload.cjs'), payload(marker))
    if (entry === 'symlink') symlinkSync('../../../payload.cjs', join(mod, 'index.js'))
    const git = (...args) => execFileSync(REAL_GIT, ['-C', repo, '-c', 'user.name=s', '-c', 'user.email=s@example.invalid', ...args], { env: discoveryEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-q')
    git('add', '-f', '--', 'pkg/package.json', ...track)
    git('commit', '-q', '-m', 'plant')
    let env = discoveryEnv
    if (fakeGit) {
      const bin = join(tmp, `${label}-bin`)
      mkdirSync(bin)
      writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a; do [ "$a" = ls-files ] && { echo 'fatal: fake git: ls-files is broken' >&2; exit 128; }; done\nexec ${REAL_GIT} "$@"\n`)
      chmodSync(join(bin, 'git'), 0o755)
      env = { ...discoveryEnv, PATH: `${bin}:${discoveryEnv.PATH}` }
    }
    const r = spawnSync(process.execPath, [SCRIPT, ...io, '--auto', '--out', join(tmp, `${label}.png`)], { cwd: join(repo, cwd), encoding: 'utf8', env: { ...env, ...markupEnv }, timeout: 120_000 })
    return { r, marker, modules: join(repo, 'pkg', 'node_modules') }
  }
  const skippedFor = (c, text) => {
    check(`${c.label}: exit 3`, c.r.status === 3, `${c.r.status} ${c.r.stderr}`)
    check(`${c.label}: stderr says ${text}`, c.r.stderr.includes(text), c.r.stderr)
    check(`${c.label}: the planted code never ran`, !existsSync(c.marker))
  }
  const tracked = { label: 'tracked', ...plant('tracked', { track: ['pkg/node_modules'] }) }
  skippedFor(tracked, 'named or under node_modules in')
  const escaped = { label: 'main outside node_modules', ...plant('escaped', { main: '../../../payload.cjs', entry: 'payload', track: ['pkg/node_modules', 'payload.cjs'] }) }
  skippedFor(escaped, 'named or under node_modules in')
  const linked = { label: 'entry symlinked outside node_modules', ...plant('linked', { entry: 'symlink', track: ['pkg/node_modules', 'payload.cjs'] }) }
  skippedFor(linked, 'named or under node_modules in')
  const blind = { label: 'git cannot answer', ...plant('blind', { fakeGit: true, cwd: 'pkg' }) }
  skippedFor(blind, 'git could not list')
  // git refuses a repository it distrusts, and that refusal must not read as "outside any repository".
  const distrusted = { label: 'git distrusts the repository', ...plant('distrusted', { track: ['pkg/node_modules'], markupEnv: { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }, cwd: 'pkg' }) }
  skippedFor(distrusted, 'git could not list')
  // pnpm: the playwright entry is an untracked install, and only a sibling playwright-core in the
  // store is committed. Checking the entry's own node_modules would miss it; the repository-wide
  // rule doesn't.
  {
    const repo = join(tmp, 'pnpm')
    const marker = join(tmp, 'pnpm.loaded')
    const store = join(repo, 'node_modules', '.pnpm')
    const entry = join(store, 'playwright@1', 'node_modules', 'playwright')
    const core = join(store, 'playwright-core@1', 'node_modules', 'playwright-core')
    mkdirSync(entry, { recursive: true })
    mkdirSync(core, { recursive: true })
    writeFileSync(join(repo, 'package.json'), '{ "name": "root", "private": true }\n')
    writeFileSync(join(entry, 'package.json'), '{ "name": "playwright", "version": "0.0.0", "main": "index.js" }\n')
    writeFileSync(join(entry, 'index.js'), "module.exports = require('playwright-core')\n")
    symlinkSync('../../playwright-core@1/node_modules/playwright-core', join(store, 'playwright@1', 'node_modules', 'playwright-core'))
    symlinkSync('.pnpm/playwright@1/node_modules/playwright', join(repo, 'node_modules', 'playwright'))
    writeFileSync(join(core, 'package.json'), '{ "name": "playwright-core", "version": "0.0.0", "main": "index.js" }\n')
    writeFileSync(join(core, 'index.js'), payload(marker))
    const git = (...args) => execFileSync(REAL_GIT, ['-C', repo, '-c', 'user.name=s', '-c', 'user.email=s@example.invalid', ...args], { env: discoveryEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-q')
    git('add', '-f', '--', 'package.json', 'node_modules/.pnpm/playwright-core@1')
    git('commit', '-q', '-m', 'plant')
    const r = spawnSync(process.execPath, [SCRIPT, ...io, '--auto', '--out', join(tmp, 'pnpm.png')], { cwd: repo, encoding: 'utf8', env: discoveryEnv, timeout: 120_000 })
    skippedFor({ label: 'pnpm sibling dependency committed', r, marker }, 'named or under node_modules in')
  }
  // Outside any repository the per-entry rule still holds: an entry that escapes node_modules is
  // skipped even though nothing there can be tracked.
  {
    const dir = join(tmp, 'loose')
    const marker = join(tmp, 'loose.loaded')
    const mod = join(dir, 'node_modules', 'playwright')
    mkdirSync(mod, { recursive: true })
    writeFileSync(join(mod, 'package.json'), '{ "name": "playwright", "version": "0.0.0", "main": "../../payload.cjs" }\n')
    writeFileSync(join(dir, 'payload.cjs'), payload(marker))
    const r = spawnSync(process.execPath, [SCRIPT, ...io, '--auto', '--out', join(tmp, 'loose.png')], { cwd: dir, encoding: 'utf8', env: discoveryEnv, timeout: 120_000 })
    skippedFor({ label: 'outside a repository, an entry outside node_modules', r, marker }, 'outside any node_modules')
  }
  // A checkout under a directory named node_modules, whose own committed package.json is named
  // playwright: Node's package self-reference resolves it, and its path does pass through a
  // node_modules, but one above the repository, not one inside it.
  {
    const repo = join(tmp, 'node_modules', 'selfref')
    const marker = join(tmp, 'selfref.loaded')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'package.json'), '{ "name": "playwright", "version": "0.0.0", "exports": "./payload.cjs" }\n')
    writeFileSync(join(repo, 'payload.cjs'), payload(marker))
    const git = (...args) => execFileSync(REAL_GIT, ['-C', repo, '-c', 'user.name=s', '-c', 'user.email=s@example.invalid', ...args], { env: discoveryEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-q')
    git('add', '--', 'package.json', 'payload.cjs')
    git('commit', '-q', '-m', 'plant')
    const r = spawnSync(process.execPath, [SCRIPT, ...io, '--auto', '--out', join(tmp, 'selfref.png')], { cwd: repo, encoding: 'utf8', env: discoveryEnv, timeout: 120_000 })
    skippedFor({ label: 'a self-referencing package under an outer node_modules', r, marker }, 'outside any node_modules')
  }
  // An outer repository commits a playwright, and a repository initialized inside its tree tracks
  // only its own package.json. Run from the inner one, its index sees no tracked node_modules, so
  // only asking every repository around each node_modules finds the committed bytes. Once with
  // the commit under an outer node_modules, once under the inner repository's own.
  for (const [label, rel] of [['nested under an outer node_modules', join('node_modules', 'project')], ['nested, the outer repository tracking the inner node_modules', 'project']]) {
    const outer = join(tmp, label.replace(/[^a-z]+/g, '-'))
    const inner = join(outer, rel)
    const mod = join(inner, 'node_modules', 'playwright')
    const marker = join(tmp, `${label.replace(/[^a-z]+/g, '-')}.loaded`)
    mkdirSync(mod, { recursive: true })
    writeFileSync(join(inner, 'package.json'), '{ "name": "project", "private": true }\n')
    writeFileSync(join(mod, 'package.json'), '{ "name": "playwright", "version": "0.0.0", "main": "index.js" }\n')
    writeFileSync(join(mod, 'index.js'), payload(marker))
    const gitAt = (dir, ...args) => execFileSync(REAL_GIT, ['-C', dir, '-c', 'user.name=s', '-c', 'user.email=s@example.invalid', ...args], { env: discoveryEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    gitAt(outer, 'init', '-q')
    gitAt(outer, 'add', '-f', '--', join(rel, 'node_modules'))
    gitAt(outer, 'commit', '-q', '-m', 'plant')
    gitAt(inner, 'init', '-q')
    gitAt(inner, 'add', '--', 'package.json')
    gitAt(inner, 'commit', '-q', '-m', 'inner')
    const r = spawnSync(process.execPath, [SCRIPT, ...io, '--auto', '--out', join(tmp, 'nested.png')], { cwd: inner, encoding: 'utf8', env: discoveryEnv, timeout: 120_000 })
    skippedFor({ label, r, marker }, 'git tracks files under')
  }
  // The inner repository's playwright is untracked everywhere, but it requires playwright-core,
  // and Node's resolution climbs to the one the outer repository committed in its node_modules.
  // Only checking every node_modules on the path, the outer one too, finds it.
  {
    const outer = join(tmp, 'nested-dependency')
    const inner = join(outer, 'node_modules', 'project')
    const mod = join(inner, 'node_modules', 'playwright')
    const core = join(outer, 'node_modules', 'playwright-core')
    const marker = join(tmp, 'nested-dependency.loaded')
    for (const d of [mod, core]) mkdirSync(d, { recursive: true })
    writeFileSync(join(inner, 'package.json'), '{ "name": "project", "private": true }\n')
    writeFileSync(join(mod, 'package.json'), '{ "name": "playwright", "version": "0.0.0", "main": "index.js" }\n')
    writeFileSync(join(mod, 'index.js'), "module.exports = require('playwright-core')\n")
    writeFileSync(join(core, 'package.json'), '{ "name": "playwright-core", "version": "0.0.0", "main": "index.js" }\n')
    writeFileSync(join(core, 'index.js'), payload(marker))
    const gitAt = (dir, ...args) => execFileSync(REAL_GIT, ['-C', dir, '-c', 'user.name=s', '-c', 'user.email=s@example.invalid', ...args], { env: discoveryEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    gitAt(outer, 'init', '-q')
    gitAt(outer, 'add', '-f', '--', join('node_modules', 'playwright-core'))
    gitAt(outer, 'commit', '-q', '-m', 'plant')
    gitAt(inner, 'init', '-q')
    gitAt(inner, 'add', '--', 'package.json')
    gitAt(inner, 'commit', '-q', '-m', 'inner')
    const r = spawnSync(process.execPath, [SCRIPT, ...io, '--auto', '--out', join(tmp, 'nested-dependency.png')], { cwd: inner, encoding: 'utf8', env: discoveryEnv, timeout: 120_000 })
    skippedFor({ label: 'nested, a dependency committed in the outer node_modules', r, marker }, 'git tracks files under')
  }
  const untracked = plant('untracked')
  check('untracked: the module is loaded (its marker is written)', existsSync(untracked.marker))
  check('untracked: exit 3 on its throwing launch', untracked.r.status === 3 && untracked.r.stderr.includes('did not launch: fake playwright: no browser here'), `${untracked.r.status} ${untracked.r.stderr}`)
}

let skipped = null
console.log('render cases')
{
  const out1 = join(tmp, 'one.png')
  const first = run([...io, '--auto', '--dump-regions', '--out', out1])
  if (first.status === 3 && !process.env.FLOW_MARKUP_PLAYWRIGHT) {
    skipped = first.stderr.trim().split('\n')[0]
    console.log(`  skipped: ${skipped}`)
  } else {
    check('--auto renders: exit 0', first.status === 0, `${first.status} ${first.stderr}`)
    check('--auto finds exactly one change', first.stdout.includes(', 1 change(s)'), first.stdout)
    const dumped = first.stdout.split('\n').find((l) => l.startsWith('['))
    let regions = null
    try { regions = JSON.parse(dumped) } catch {}
    check('--dump-regions names the red rectangle\'s box', JSON.stringify(regions) === JSON.stringify([{ n: 1, box: [RECT.x, RECT.y, RECT.w, RECT.h] }]), String(dumped))
    const bytes1 = existsSync(out1) ? readFileSync(out1) : Buffer.alloc(0)
    check('the output is a PNG', bytes1.subarray(0, 8).equals(PNG_SIGNATURE), bytes1.subarray(0, 8).toString('hex'))
    const out2 = join(tmp, 'two.png')
    const second = run([...io, '--auto', '--dump-regions', '--out', out2])
    check('a second run gives identical bytes', second.status === 0 && existsSync(out2) && readFileSync(out2).equals(bytes1), `${second.status} ${second.stderr}`)
    const spec = join(tmp, 'spec.json')
    writeFileSync(spec, JSON.stringify({ title: 'Smoke', annotations: [{ n: 1, box: [RECT.x, RECT.y, RECT.w, RECT.h], label: 'Red | box' }] }))
    const out3 = join(tmp, 'legend.png')
    const legend = run([...io, '--spec', spec, '--legend', '--out', out3])
    const md = join(tmp, 'legend.md')
    const text = existsSync(md) ? readFileSync(md, 'utf8') : ''
    check('--legend writes <out>.md with the escaped label', legend.status === 0 && text === '| # | Change |\n|---|---|\n| 1 | Red \\| box |\n', `${legend.status} ${legend.stderr} ${JSON.stringify(text)}`)
    // A change that grew the page: the after is taller, and the new control sits below the
    // before's last row, where a shared-area comparison would never look.
    const taller = join(tmp, 'taller.png')
    writeFileSync(taller, encodePng(600, 600, (x, y) => (x >= 300 && x < 380 && y >= 450 && y < 490 ? [255, 0, 0] : [255, 255, 255])))
    const out4 = join(tmp, 'grown.png')
    const grown = run(['--before', before, '--after', taller, '--auto', '--out', out4])
    check('a before and after of different sizes exits 2, naming both sizes, and writes nothing', grown.status === 2 && grown.stderr.includes('600x400') && grown.stderr.includes('600x600') && !existsSync(out4), `${grown.status} ${grown.stderr}`)
  }
}

rmSync(tmp, { recursive: true, force: true })
if (bad > 0) {
  console.log(`smoke-markup: ${bad} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(skipped === null
  ? `smoke-markup: ${checks} checks pass, render cases included`
  : `smoke-markup: ${checks} checks pass; render cases skipped, ${skipped.includes('no Playwright found') ? 'no Playwright resolves from the repository root' : 'the browser did not launch'} (set FLOW_MARKUP_PLAYWRIGHT to run them)`)
