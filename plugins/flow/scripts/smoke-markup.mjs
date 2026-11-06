#!/usr/bin/env node
// Smoke for scripts/markup.mjs, run as a child process from the repository root the way an agent
// runs it.
//
// The inputs are synthetic PNGs written here with node:zlib: a white 600x400 before, and the same
// with one solid red 80x40 rectangle as the after. The usage and spec cases always run, because
// markup.mjs decides them before it looks for Playwright. So do the discovery-trust cases: a
// throwaway repository holds a fake playwright that writes a marker file when it is loaded and
// whose chromium.launch throws, once committed under node_modules (it must be skipped and never
// loaded) and once only present there (it must be loaded, proving the skip is about tracking and
// not about where the module sits). The render cases need Playwright, which
// this repository does not ship: they run when markup.mjs resolves one by its own rules from the
// repository root (FLOW_MARKUP_PLAYWRIGHT included), and are skipped otherwise, with the reason on
// the last stdout line. With FLOW_MARKUP_PLAYWRIGHT set, an install that does not resolve or launch
// is a failure, not a skip, because the caller asked for the render cases by name.
//
// Run: node plugins/flow/scripts/smoke-markup.mjs
//      FLOW_MARKUP_PLAYWRIGHT=<dir|package.json> node plugins/flow/scripts/smoke-markup.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  const missing = run([...io, '--out', join(tmp, 'x.png')], noPw)
  check('a pointer that resolves no Playwright: exit 3, naming the pointer', missing.status === 3 && missing.stderr.includes('FLOW_MARKUP_PLAYWRIGHT points at'), `${missing.status} ${missing.stderr}`)
}

console.log('discovery skips a playwright committed under node_modules, and loads an untracked one')
{
  const discoveryEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(tmp, 'none'), GIT_CONFIG_SYSTEM: join(tmp, 'none') }
  for (const key of ['FLOW_MARKUP_PLAYWRIGHT', 'NODE_PATH']) delete discoveryEnv[key]
  /** A repository with a tracked pkg/package.json and a fake pkg/node_modules/playwright, committed or not. */
  const plant = (label, { trackModules }) => {
    const repo = join(tmp, label)
    const mod = join(repo, 'pkg', 'node_modules', 'playwright')
    const marker = join(tmp, `${label}.loaded`)
    mkdirSync(mod, { recursive: true })
    writeFileSync(join(repo, 'pkg', 'package.json'), '{ "name": "pkg", "private": true }\n')
    writeFileSync(join(mod, 'package.json'), '{ "name": "playwright", "version": "0.0.0", "main": "index.js" }\n')
    writeFileSync(join(mod, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded')\n` +
      "module.exports = { chromium: { launch: async () => { throw new Error('fake playwright: no browser here') } } }\n")
    const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=s', '-c', 'user.email=s@example.invalid', ...args], { env: discoveryEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-q')
    git('add', '-f', '--', 'pkg/package.json', ...(trackModules ? ['pkg/node_modules'] : []))
    git('commit', '-q', '-m', 'plant')
    const r = spawnSync(process.execPath, [SCRIPT, ...io, '--auto', '--out', join(tmp, `${label}.png`)], { cwd: repo, encoding: 'utf8', env: discoveryEnv, timeout: 120_000 })
    return { r, marker, modules: join(repo, 'pkg', 'node_modules') }
  }
  const tracked = plant('tracked', { trackModules: true })
  check('tracked: exit 3', tracked.r.status === 3, `${tracked.r.status} ${tracked.r.stderr}`)
  check('tracked: stderr names the skipped node_modules', tracked.r.stderr.includes(`Skipped, because git tracks files under them: ${tracked.modules}`), tracked.r.stderr)
  check('tracked: the planted module never ran', !existsSync(tracked.marker))
  const untracked = plant('untracked', { trackModules: false })
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
