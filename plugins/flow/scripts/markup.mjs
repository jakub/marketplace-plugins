#!/usr/bin/env node
// markup.mjs: one annotated before/after comparison PNG for a pull request body. Both sides show
// the same crop; the after side gets a sketch-style loop around each change, a numbered badge and
// a curved arrow; the before side gets faint matching loops and hollow numbers; an optional legend
// lists the labels under the panels.
//
//   node markup.mjs --before b.png --after a.png --out out.png
//                   [--spec spec.json] [--auto] [--dump-regions] [--title "..."] [--legend]
//                   [--playwright <dir|package.json>]
//
// spec.json is `{ "title": "...", "crop": [x, y, w, h], "annotations": [{ "n": 1, "box": [x, y, w, h],
// "label": "..." }] }`, every box in after-image pixels, every key optional. Without a spec, or
// with --auto, the changed regions come from a pixel diff of the two images (channel delta above
// 40, 4 px cells, nearby regions merged until at most 8 remain, specks dropped), numbered in
// reading order. --dump-regions prints the annotated boxes as one JSON line, so a run can turn an
// --auto pass into a spec. --legend also writes <out without .png>.md, a markdown table of the
// numbers and labels for the PR body.
//
// The output is deterministic: the jitter is seeded from the input bytes, the spec text, the title
// and the mode, so the same inputs give the same bytes and a changed input gives a fresh but
// stable hand. The font is Caveat, shipped in ../assets/markup/ (see ../NOTICE).
//
// Rendering runs in headless Chromium through Playwright, which flow does not ship. The first of
// these that resolves `playwright` or `@playwright/test` wins:
//   1. --playwright <dir or package.json>
//   2. FLOW_MARKUP_PLAYWRIGHT, in the same form
//   3. Node's own resolution from the working directory upward
//   4. every git-tracked package.json in the working directory's repository whose directory has
//      node_modules/playwright or node_modules/@playwright/test, in ls-files order. That covers a
//      repository whose e2e package is nested, such as crates/trawl-web-ui/e2e.
// A pointer given by 1 or 2 that resolves nothing is an error, never a fall-through, because a
// silent fallback would render with a Playwright the caller did not choose.
//
// Exit codes: 0 rendered; 2 usage, or a spec that is not JSON or not the shape above; 3 no
// Playwright resolves, or its browser does not launch (Playwright's own message, which names the
// install command); 1 anything else, such as an unreadable or undecodable image.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FONT = path.join(HERE, '..', 'assets', 'markup', 'Caveat-wght.ttf')
const PACKAGES = ['playwright', '@playwright/test']
const USAGE = 'usage: node markup.mjs --before b.png --after a.png --out out.png [--spec spec.json] [--auto] [--dump-regions] [--title "..."] [--legend] [--playwright <dir|package.json>]'

class Exit extends Error { constructor(code, message) { super(message); this.code = code } }
const usage = (msg) => { throw new Exit(2, msg ? `markup: ${msg}\n${USAGE}` : USAGE) }

function parseArgs(argv) {
  const opts = { auto: false, legend: false }
  const valued = new Set(['--before', '--after', '--out', '--spec', '--title', '--playwright'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--auto') opts.auto = true
    else if (a === '--dump-regions') opts.dump = true
    else if (a === '--legend') opts.legend = true
    else if (a === '-h' || a === '--help') usage()
    else if (valued.has(a)) {
      if (i + 1 >= argv.length) usage(`${a} needs a value`)
      opts[a.slice(2)] = argv[++i]
    } else usage(`unknown argument ${a}`)
  }
  for (const k of ['before', 'after', 'out']) if (!opts[k]) usage(`--${k} is required`)
  return opts
}

/** The spec's annotations, or null under --auto, which reads only its title and crop. */
function validateSpec(spec, auto) {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) throw new Error('spec must be a JSON object')
  if (spec.crop !== undefined && spec.crop !== null && (!Array.isArray(spec.crop) || spec.crop.length !== 4 || !spec.crop.every(Number.isFinite))) {
    throw new Error('spec.crop must be [x, y, w, h]')
  }
  if (auto) return null
  const anns = spec.annotations ?? []
  if (!Array.isArray(anns)) throw new Error('spec.annotations must be an array')
  return anns.map((a, i) => {
    const box = a?.box
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) {
      throw new Error(`annotation ${i}: box must be [x, y, w, h] with positive w and h`)
    }
    return { n: Number.isInteger(a.n) ? a.n : i + 1, box, label: typeof a.label === 'string' ? a.label : '' }
  })
}

/** The require() an install answers through, from a directory or a package.json path. */
const requireAt = (pointer) => {
  const abs = path.resolve(pointer)
  let isDir = false
  try { isDir = statSync(abs).isDirectory() } catch {}
  return createRequire(isDir ? path.join(abs, 'package.json') : abs)
}
const loadFrom = (req) => {
  for (const name of PACKAGES) {
    let resolved
    try { resolved = req.resolve(name) } catch { continue }
    return { chromium: req(resolved).chromium, from: resolved }
  }
  return null
}

function resolvePlaywright(opts, env) {
  const explicit = opts.playwright !== undefined ? ['--playwright', opts.playwright] : env.FLOW_MARKUP_PLAYWRIGHT ? ['FLOW_MARKUP_PLAYWRIGHT', env.FLOW_MARKUP_PLAYWRIGHT] : null
  if (explicit !== null) {
    const hit = loadFrom(requireAt(explicit[1]))
    if (hit === null) throw new Exit(3, `markup: ${explicit[0]} points at ${explicit[1]}, where neither ${PACKAGES.join(' nor ')} resolves`)
    return hit
  }
  const cwd = process.cwd()
  const fromCwd = loadFrom(createRequire(path.join(cwd, 'noop.js')))
  if (fromCwd !== null) return fromCwd
  let top = null
  try { top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
  if (top) {
    let listed = ''
    try { listed = execFileSync('git', ['-C', top, 'ls-files', '-z', '--', '*package.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }) } catch {}
    for (const rel of listed.split('\0').filter((p) => path.basename(p) === 'package.json')) {
      const dir = path.join(top, path.dirname(rel))
      if (!PACKAGES.some((name) => existsSync(path.join(dir, 'node_modules', name, 'package.json')))) continue
      const hit = loadFrom(createRequire(path.join(dir, 'package.json')))
      if (hit !== null) return hit
    }
  }
  throw new Exit(3, `markup: no Playwright found. Tried Node resolution of ${PACKAGES.join(' and ')} from ${cwd} upward` +
    `${top ? `, and every git-tracked package.json under ${top} with either in its node_modules` : ', and no git repository holds that directory'}. ` +
    'Point at an install with --playwright <dir|package.json> or FLOW_MARKUP_PLAYWRIGHT, or run `npm install @playwright/test && npx playwright install chromium` somewhere and point there.')
}

async function main(argv, env) {
  const opts = parseArgs(argv)
  let spec = null
  let specText = ''
  if (opts.spec) {
    specText = await fs.readFile(opts.spec, 'utf8')
    try { spec = JSON.parse(specText) } catch (error) { throw new Exit(2, `markup: ${opts.spec} is not JSON: ${error.message}`) }
  }
  let annotations = null
  try { if (spec !== null) annotations = validateSpec(spec, opts.auto) } catch (error) { throw new Exit(2, `markup: ${opts.spec}: ${error.message}`) }
  const title = opts.title ?? spec?.title ?? ''

  const [beforeBuf, afterBuf, fontBuf] = await Promise.all([fs.readFile(opts.before), fs.readFile(opts.after), fs.readFile(FONT)])

  // Seed the jitter from everything that shapes the output, so the same inputs
  // give the same bytes and a changed input gives a fresh but stable hand.
  const seedHash = createHash('sha256')
    .update(beforeBuf)
    .update(afterBuf)
    .update(specText)
    .update(title)
    .update(opts.auto ? 'auto' : 'spec')
    .digest()
  const seed = seedHash.readUInt32LE(0)

  const { chromium } = resolvePlaywright(opts, env)
  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-gpu', '--font-render-hinting=none', '--disable-lcd-text'],
    })
  } catch (error) { throw new Exit(3, `markup: the browser did not launch: ${error.message}`) }
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.setContent('<!doctype html><html><body></body></html>')
    const result = await page.evaluate(render, {
      before: `data:image/png;base64,${beforeBuf.toString('base64')}`,
      after: `data:image/png;base64,${afterBuf.toString('base64')}`,
      font: `data:font/ttf;base64,${fontBuf.toString('base64')}`,
      annotations,
      cropOverride: spec?.crop ?? null,
      title,
      seed,
    })
    if (errors.length) throw new Error(errors.join('\n'))
    const png = Buffer.from(result.png.slice(result.png.indexOf(',') + 1), 'base64')
    await fs.mkdir(path.dirname(path.resolve(opts.out)), { recursive: true })
    await fs.writeFile(opts.out, png)
    console.log(
      `${opts.out}: ${result.width}x${result.height}, ${(png.length / 1024).toFixed(0)} KiB, ` +
        `${result.layout}, crop ${result.crop.join(',')}, ${result.annotations.length} change(s)`,
    )
    if (opts.dump) console.log(JSON.stringify(result.annotations.map((a) => ({ n: a.n, box: a.box }))))
    if (opts.legend) {
      const rows = result.annotations.map((a) => `| ${a.n} | ${(a.label || '_describe the change_').replace(/\|/g, '\\|')} |`)
      const md = ['| # | Change |', '|---|---|', ...rows, ''].join('\n')
      const mdPath = opts.out.replace(/\.png$/i, '') + '.md'
      await fs.writeFile(mdPath, md)
      console.log(`${mdPath}:\n${md}`)
    }
  } finally {
    await browser.close()
  }
}

// ---------------------------------------------------------------------------
// Everything below runs inside the page. page.evaluate serializes it, so it must
// stay self-contained: no reference to anything outside its own body.
// ---------------------------------------------------------------------------
async function render({ before, after, font, annotations, cropOverride, title, seed }) {
  const ACCENT = '#F2452E'
  const OUT_W = 1800 // target output width in px
  const MARGIN = 44
  const GUTTER = 36

  // --- seeded randomness ---------------------------------------------------
  let s = seed >>> 0
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const jit = (amp) => (rand() * 2 - 1) * amp

  // --- load inputs ---------------------------------------------------------
  const face = new FontFace('Caveat', `url(${font})`, { weight: '400 700' })
  await face.load()
  document.fonts.add(face)
  const load = (src) =>
    new Promise((res, rej) => {
      const im = new Image()
      im.onload = () => res(im)
      im.onerror = () => rej(new Error('cannot decode image'))
      im.src = src
    })
  const [imgB, imgA] = await Promise.all([load(before), load(after)])
  const pixels = (im) => {
    const c = document.createElement('canvas')
    c.width = im.naturalWidth
    c.height = im.naturalHeight
    const x = c.getContext('2d', { willReadFrequently: true })
    x.drawImage(im, 0, 0)
    return x.getImageData(0, 0, c.width, c.height)
  }
  const pxB = pixels(imgB)
  const pxA = pixels(imgA)
  const W = Math.min(pxA.width, pxB.width)
  const H = Math.min(pxA.height, pxB.height)
  // Pixel unit: 1 for DPR 1 screenshots, 2 for retina captures.
  const u = pxA.width >= 2200 ? 2 : 1

  // --- boxes ---------------------------------------------------------------
  const rectUnion = (a, b) => {
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
  }
  const gapBetween = (a, b) =>
    Math.max(Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w), Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h))

  function diffRegions() {
    const CELL = 4 * u
    const gw = Math.ceil(W / CELL)
    const gh = Math.ceil(H / CELL)
    const count = new Uint16Array(gw * gh)
    const a = pxA.data
    const b = pxB.data
    const THRESH = 40 // max channel delta; below this is antialiasing noise
    for (let y = 0; y < H; y++) {
      const rowA = y * pxA.width * 4
      const rowB = y * pxB.width * 4
      const gy = ((y / CELL) | 0) * gw
      for (let x = 0; x < W; x++) {
        const i = rowA + x * 4
        const j = rowB + x * 4
        const d = Math.max(Math.abs(a[i] - b[j]), Math.abs(a[i + 1] - b[j + 1]), Math.abs(a[i + 2] - b[j + 2]))
        if (d > THRESH) count[gy + ((x / CELL) | 0)]++
      }
    }
    // Connected components over "on" cells, joining cells within REACH cells.
    const REACH = 3
    const on = (i) => count[i] >= 2
    const label = new Int32Array(gw * gh).fill(-1)
    const comps = []
    for (let start = 0; start < gw * gh; start++) {
      if (!on(start) || label[start] >= 0) continue
      const id = comps.length
      const comp = { x0: 1e9, y0: 1e9, x1: -1, y1: -1, px: 0 }
      const stack = [start]
      label[start] = id
      while (stack.length) {
        const c = stack.pop()
        const cx = c % gw
        const cy = (c / gw) | 0
        comp.x0 = Math.min(comp.x0, cx)
        comp.y0 = Math.min(comp.y0, cy)
        comp.x1 = Math.max(comp.x1, cx)
        comp.y1 = Math.max(comp.y1, cy)
        comp.px += count[c]
        for (let dy = -REACH; dy <= REACH; dy++) {
          const ny = cy + dy
          if (ny < 0 || ny >= gh) continue
          for (let dx = -REACH; dx <= REACH; dx++) {
            const nx = cx + dx
            if (nx < 0 || nx >= gw) continue
            const n = ny * gw + nx
            if (on(n) && label[n] < 0) {
              label[n] = id
              stack.push(n)
            }
          }
        }
      }
      comps.push(comp)
    }
    let boxes = comps
      .filter((c) => c.px >= 24 * u * u)
      .map((c) => ({
        x: c.x0 * CELL,
        y: c.y0 * CELL,
        w: Math.min(W, (c.x1 + 1) * CELL) - c.x0 * CELL,
        h: Math.min(H, (c.y1 + 1) * CELL) - c.y0 * CELL,
      }))
    // Merge neighbours; widen the merge distance until the count is readable.
    let gap = 28 * u
    for (;;) {
      let merged = true
      while (merged) {
        merged = false
        outer: for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++)
            if (gapBetween(boxes[i], boxes[j]) <= gap) {
              boxes[i] = rectUnion(boxes[i], boxes[j])
              boxes.splice(j, 1)
              merged = true
              break outer
            }
      }
      if (boxes.length <= 8) break
      gap *= 1.6
    }
    return boxes
  }

  function readingOrder(boxes) {
    const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)
    const rows = []
    for (const b of sorted) {
      const row = rows.find((r) => {
        const top = Math.max(r.y, b.y)
        const bot = Math.min(r.y + r.h, b.y + b.h)
        return bot - top > 0.5 * Math.min(r.h, b.h)
      })
      if (row) {
        row.items.push(b)
        Object.assign(row, rectUnion(row, b))
      } else rows.push({ ...b, items: [b] })
    }
    return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x))
  }

  let anns
  if (annotations && annotations.length) {
    anns = annotations
      .map((a) => {
        const x = Math.max(0, Math.min(W - 1, a.box[0]))
        const y = Math.max(0, Math.min(H - 1, a.box[1]))
        const w = Math.max(1, Math.min(W - x, a.box[0] + a.box[2] - x))
        const h = Math.max(1, Math.min(H - y, a.box[1] + a.box[3] - y))
        return { n: a.n, label: a.label, x, y, w, h }
      })
      .sort((a, b) => a.n - b.n)
  } else {
    anns = readingOrder(diffRegions()).map((b, i) => ({ n: i + 1, label: '', ...b }))
  }

  // --- crop ----------------------------------------------------------------
  let crop
  if (!anns.length) crop = { x: 0, y: 0, w: W, h: H }
  else {
    const U = anns.reduce((acc, b) => rectUnion(acc, b))
    const pad = Math.min(170 * u, Math.max(64 * u, 0.22 * Math.max(U.w, U.h)))
    let x0 = U.x - pad
    let y0 = U.y - pad
    let x1 = U.x + U.w + pad
    let y1 = U.y + U.h + pad
    const grow = (lo, hi, min, max) => {
      const need = min - (hi - lo)
      if (need > 0) {
        lo -= need / 2
        hi += need / 2
      }
      if (lo < 0) [lo, hi] = [0, hi - lo]
      if (hi > max) [lo, hi] = [Math.max(0, lo - (hi - max)), max]
      return [lo, hi]
    }
    ;[x0, x1] = grow(x0, x1, Math.min(W, 560 * u), W)
    ;[y0, y1] = grow(y0, y1, Math.min(H, 320 * u), H)
    // Snap to an image edge when close, so the crop keeps its frame of reference.
    if (x0 < 0.07 * W) x0 = 0
    if (y0 < 0.07 * H) y0 = 0
    if (x1 > 0.93 * W) x1 = W
    if (y1 > 0.93 * H) y1 = H
    crop = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1) - Math.round(x0), h: Math.round(y1) - Math.round(y0) }
    if (crop.w * crop.h > 0.85 * W * H) crop = { x: 0, y: 0, w: W, h: H }
  }
  // Optional spec.crop [x, y, w, h] in after-image pixels overrides the computed crop.
  if (cropOverride) crop = { x: cropOverride[0], y: cropOverride[1], w: cropOverride[2], h: cropOverride[3] }

  // --- palette from the screenshot ----------------------------------------
  let lum = 0
  let nlum = 0
  for (let y = crop.y; y < crop.y + crop.h; y += 3)
    for (let x = crop.x; x < crop.x + crop.w; x += 3) {
      const i = (y * pxA.width + x) * 4
      lum += 0.2126 * pxA.data[i] + 0.7152 * pxA.data[i + 1] + 0.0722 * pxA.data[i + 2]
      nlum++
    }
  const dark = lum / nlum / 255 < 0.42
  const theme = dark
    ? { bg: '#14161B', panelEdge: 'rgba(255,255,255,0.14)', ink: '#E9E7E2', muted: '#9A9AA2', halo: 'rgba(10,12,16,0.78)', shadow: 'rgba(0,0,0,0.55)' }
    : { bg: '#F3F1EC', panelEdge: 'rgba(20,20,30,0.14)', ink: '#22232A', muted: '#6D6B66', halo: 'rgba(255,255,255,0.85)', shadow: 'rgba(40,30,20,0.16)' }

  // --- layout --------------------------------------------------------------
  // Side by side when the crop is portrait-ish or small enough to stay legible at half width.
  const sideBySide = crop.w / crop.h <= 1.2 || crop.w <= 640 * u
  const maxScale = 2 / u
  const fitW = sideBySide ? (OUT_W - 2 * MARGIN - GUTTER) / 2 : OUT_W - 2 * MARGIN
  const S = Math.min(maxScale, fitW / crop.w)
  const pw = Math.round(crop.w * S)
  const ph = Math.round(crop.h * S)
  const outW = sideBySide ? 2 * MARGIN + GUTTER + 2 * pw : 2 * MARGIN + pw

  const TITLE_H = title ? 78 : 0
  const LABEL_H = 44
  const legendItems = anns.filter((a) => a.label)
  const LEG_FONT = '600 38px Caveat'
  const LEG_R = 19
  const measure = document.createElement('canvas').getContext('2d')
  measure.font = LEG_FONT
  const legend = []
  let lx = MARGIN
  let ly = 0
  for (const a of legendItems) {
    const w = LEG_R * 2 + 14 + measure.measureText(a.label).width + 48
    if (lx + w > outW - MARGIN && lx > MARGIN) {
      lx = MARGIN
      ly += 54
    }
    legend.push({ a, x: lx, y: ly })
    lx += w
  }
  const LEGEND_H = legend.length ? ly + 54 + 26 : 0

  const top = MARGIN * 0.75 + TITLE_H
  const panels = sideBySide
    ? [
        { img: imgB, side: 'before', x: MARGIN, y: top + LABEL_H },
        { img: imgA, side: 'after', x: MARGIN + pw + GUTTER, y: top + LABEL_H },
      ]
    : [
        { img: imgB, side: 'before', x: MARGIN, y: top + LABEL_H },
        { img: imgA, side: 'after', x: MARGIN, y: top + LABEL_H + ph + GUTTER + LABEL_H },
      ]
  const panelsBottom = panels[1].y + ph
  const outH = Math.round(panelsBottom + (legend.length ? 30 + LEGEND_H : 0) + MARGIN * 0.8)

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = theme.bg
  ctx.fillRect(0, 0, outW, outH)

  const SANS = '"Inter", "Adwaita Sans", "Noto Sans", "Liberation Sans", sans-serif'
  if (title) {
    ctx.fillStyle = theme.ink
    ctx.font = `600 34px ${SANS}`
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(title, MARGIN, MARGIN * 0.75 + 40)
    // A short hand-drawn underline ties the title to the markup.
    const tw = Math.min(ctx.measureText(title).width, 260)
    ctx.save()
    ctx.strokeStyle = ACCENT
    ctx.lineCap = 'round'
    roughLine(ctx, MARGIN + 2, MARGIN * 0.75 + 56, MARGIN + tw, MARGIN * 0.75 + 53, 3.2, 2)
    ctx.restore()
  }

  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath()
    c.moveTo(x + r, y)
    c.arcTo(x + w, y, x + w, y + h, r)
    c.arcTo(x + w, y + h, x, y + h, r)
    c.arcTo(x, y + h, x, y, r)
    c.arcTo(x, y, x + w, y, r)
    c.closePath()
  }

  for (const p of panels) {
    // Label row
    ctx.font = `700 19px ${SANS}`
    ctx.textBaseline = 'middle'
    const label = p.side === 'before' ? 'BEFORE' : 'AFTER'
    ctx.letterSpacing = '2.5px'
    const lw = ctx.measureText(label).width
    const ly0 = p.y - LABEL_H / 2 - 4
    if (p.side === 'after') {
      ctx.fillStyle = ACCENT
      roundRectPath(ctx, p.x - 1, ly0 - 15, lw + 26, 30, 15)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.fillText(label, p.x + 12, ly0 + 1)
    } else {
      ctx.strokeStyle = theme.muted
      ctx.lineWidth = 1.5
      roundRectPath(ctx, p.x - 1, ly0 - 15, lw + 26, 30, 15)
      ctx.stroke()
      ctx.fillStyle = theme.muted
      ctx.fillText(label, p.x + 12, ly0 + 1)
    }
    ctx.letterSpacing = '0px'
    // Panel
    ctx.save()
    ctx.shadowColor = theme.shadow
    ctx.shadowBlur = 22
    ctx.shadowOffsetY = 6
    ctx.fillStyle = theme.bg
    roundRectPath(ctx, p.x, p.y, pw, ph, 10)
    ctx.fill()
    ctx.restore()
    ctx.save()
    roundRectPath(ctx, p.x, p.y, pw, ph, 10)
    ctx.clip()
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(p.img, crop.x, crop.y, crop.w, crop.h, p.x, p.y, pw, ph)
    ctx.restore()
    ctx.strokeStyle = theme.panelEdge
    ctx.lineWidth = 1.5
    roundRectPath(ctx, p.x + 0.75, p.y + 0.75, pw - 1.5, ph - 1.5, 10)
    ctx.stroke()
  }

  // --- sketch primitives ----------------------------------------------------
  function roughLine(c, x0, y0, x1, y1, width, passes) {
    const len = Math.hypot(x1 - x0, y1 - y0)
    const amp = Math.min(3, len * 0.012 + 0.6)
    for (let p = 0; p < passes; p++) {
      c.lineWidth = p === 0 ? width : width * 0.7
      c.globalAlpha = p === 0 ? 1 : 0.55
      const ax = x0 + jit(amp)
      const ay = y0 + jit(amp)
      const bx = x1 + jit(amp)
      const by = y1 + jit(amp)
      const mx = (ax + bx) / 2 + jit(amp * 1.4)
      const my = (ay + by) / 2 + jit(amp * 1.4)
      c.beginPath()
      c.moveTo(ax, ay)
      c.quadraticCurveTo(mx, my, bx, by)
      c.stroke()
    }
    c.globalAlpha = 1
  }

  // Points around a rounded rectangle, starting near the top-left corner.
  function loopPoints(r, radius, n) {
    const { x, y, w, h } = r
    const rad = Math.min(radius, w / 2, h / 2)
    const segs = [
      { len: w - 2 * rad, at: (t) => [x + rad + t * (w - 2 * rad), y] },
      { len: (Math.PI / 2) * rad, at: (t) => [x + w - rad + rad * Math.sin(t * Math.PI / 2), y + rad - rad * Math.cos(t * Math.PI / 2)] },
      { len: h - 2 * rad, at: (t) => [x + w, y + rad + t * (h - 2 * rad)] },
      { len: (Math.PI / 2) * rad, at: (t) => [x + w - rad + rad * Math.cos(t * Math.PI / 2), y + h - rad + rad * Math.sin(t * Math.PI / 2)] },
      { len: w - 2 * rad, at: (t) => [x + w - rad - t * (w - 2 * rad), y + h] },
      { len: (Math.PI / 2) * rad, at: (t) => [x + rad - rad * Math.sin(t * Math.PI / 2), y + h - rad + rad * Math.cos(t * Math.PI / 2)] },
      { len: h - 2 * rad, at: (t) => [x, y + h - rad - t * (h - 2 * rad)] },
      { len: (Math.PI / 2) * rad, at: (t) => [x + rad - rad * Math.cos(t * Math.PI / 2), y + rad - rad * Math.sin(t * Math.PI / 2)] },
    ]
    const total = segs.reduce((a, sg) => a + sg.len, 0)
    const pts = []
    for (let i = 0; i < n; i++) {
      let d = (i / n) * total
      for (const sg of segs) {
        if (d <= sg.len || sg === segs[segs.length - 1]) {
          pts.push(sg.at(sg.len ? Math.min(1, d / sg.len) : 0))
          break
        }
        d -= sg.len
      }
    }
    return pts
  }

  // A loose marker loop around a rect: wobbly, not quite closed, overshooting
  // its start like a pen that circled the thing twice.
  function roughLoop(c, r, width, passes, alpha) {
    const perim = 2 * (r.w + r.h)
    const n = Math.max(48, Math.round(perim / 9))
    for (let p = 0; p < passes; p++) {
      const amp = Math.min(3.2, 1.3 + perim * 0.0012) * (p === 0 ? 1 : 1.2)
      const grow = p === 0 ? 0 : 1.2 + rand() * 1.6
      const rr = { x: r.x - grow, y: r.y - grow, w: r.w + 2 * grow, h: r.h + 2 * grow }
      const base = loopPoints(rr, 18, n)
      const ph1 = rand() * Math.PI * 2
      const ph2 = rand() * Math.PI * 2
      const f1 = 2 + Math.floor(rand() * 2)
      const f2 = 5 + Math.floor(rand() * 3)
      const startAt = Math.floor(rand() * n * 0.15)
      const over = Math.round(n * (0.03 + rand() * 0.04))
      const cx = rr.x + rr.w / 2
      const cy = rr.y + rr.h / 2
      const pts = []
      for (let k = 0; k <= n + over; k++) {
        const i = (startAt + k) % n
        const [bx, by] = base[i]
        const t = (k / n) * Math.PI * 2
        // Radial offset: slow wobble plus a drift so the end misses the start.
        const off = amp * (0.7 * Math.sin(f1 * t + ph1) + 0.3 * Math.sin(f2 * t + ph2)) + (k / n) * amp * 0.9
        const dx = bx - cx
        const dy = by - cy
        const dl = Math.hypot(dx, dy) || 1
        // Use the box-edge normal, not the centre ray, so long edges stay straight.
        const nx = Math.abs(dx / rr.w) > Math.abs(dy / rr.h) ? Math.sign(dx) : (dx / dl) * 0.2
        const ny = Math.abs(dx / rr.w) > Math.abs(dy / rr.h) ? (dy / dl) * 0.2 : Math.sign(dy)
        pts.push([bx + nx * off, by + ny * off])
      }
      c.lineWidth = p === 0 ? width : width * 0.6
      c.globalAlpha = (p === 0 ? 1 : 0.5) * alpha
      c.beginPath()
      c.moveTo(pts[0][0], pts[0][1])
      for (let k = 1; k < pts.length - 1; k++) {
        const mx = (pts[k][0] + pts[k + 1][0]) / 2
        const my = (pts[k][1] + pts[k + 1][1]) / 2
        c.quadraticCurveTo(pts[k][0], pts[k][1], mx, my)
      }
      c.stroke()
    }
    c.globalAlpha = 1
  }

  function roughArrow(c, x0, y0, x1, y1, bend, width) {
    const len = Math.hypot(x1 - x0, y1 - y0)
    const nx = -(y1 - y0) / len
    const ny = (x1 - x0) / len
    const cxp = (x0 + x1) / 2 + nx * bend * len
    const cyp = (y0 + y1) / 2 + ny * bend * len
    for (let p = 0; p < 2; p++) {
      c.lineWidth = p === 0 ? width : width * 0.6
      c.globalAlpha = p === 0 ? 1 : 0.45
      c.beginPath()
      c.moveTo(x0 + jit(1.2), y0 + jit(1.2))
      c.quadraticCurveTo(cxp + jit(3), cyp + jit(3), x1 + jit(0.8), y1 + jit(0.8))
      c.stroke()
    }
    c.globalAlpha = 1
    // Head: two strokes along the curve's end tangent.
    const ang = Math.atan2(y1 - cyp, x1 - cxp)
    const hl = 17
    for (const side of [-1, 1]) {
      const a = ang + Math.PI + side * (0.5 + jit(0.08))
      const l = hl * (0.9 + rand() * 0.2)
      c.lineWidth = width
      c.beginPath()
      c.moveTo(x1, y1)
      c.quadraticCurveTo(
        x1 + Math.cos(a) * l * 0.5 + jit(1.2),
        y1 + Math.sin(a) * l * 0.5 + jit(1.2),
        x1 + Math.cos(a) * l,
        y1 + Math.sin(a) * l,
      )
      c.stroke()
    }
  }

  function badge(c, x, y, r, n, filled) {
    // Slightly irregular disc.
    const pts = []
    const ph = rand() * Math.PI * 2
    for (let i = 0; i < 28; i++) {
      const t = (i / 28) * Math.PI * 2
      const rr = r * (1 + 0.035 * Math.sin(2 * t + ph) + jit(0.012))
      pts.push([x + Math.cos(t) * rr, y + Math.sin(t) * rr])
    }
    const path = new Path2D()
    path.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2)
    for (let i = 1; i <= pts.length; i++) {
      const p0 = pts[i % pts.length]
      const p1 = pts[(i + 1) % pts.length]
      path.quadraticCurveTo(p0[0], p0[1], (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
    }
    path.closePath()
    c.save()
    if (filled) {
      c.shadowColor = 'rgba(0,0,0,0.28)'
      c.shadowBlur = 8
      c.shadowOffsetY = 2
      c.fillStyle = ACCENT
      c.fill(path)
      c.shadowColor = 'transparent'
      c.lineWidth = 3
      c.strokeStyle = '#fff'
      c.stroke(path)
      c.fillStyle = '#fff'
    } else {
      c.fillStyle = theme.halo
      c.fill(path)
      c.lineWidth = 2.5
      c.strokeStyle = ACCENT
      c.globalAlpha = 0.75
      c.stroke(path)
      c.fillStyle = ACCENT
    }
    c.font = `700 ${Math.round(r * 1.5)}px Caveat`
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText(String(n), x + 0.5, y + r * 0.04)
    c.restore()
  }

  // --- markup --------------------------------------------------------------
  const LOOP_PAD = 9
  const BADGE_R = 23
  const toPanel = (p, b) => ({
    x: p.x + (b.x - crop.x) * S - LOOP_PAD,
    y: p.y + (b.y - crop.y) * S - LOOP_PAD,
    w: b.w * S + 2 * LOOP_PAD,
    h: b.h * S + 2 * LOOP_PAD,
  })
  const afterP = panels[1]
  const beforeP = panels[0]
  const loopsA = anns.map((a) => toPanel(afterP, a))

  // How busy the after screenshot is under a disc (output coords): luminance spread.
  const busy = (cx, cy, r) => {
    const sx = Math.round(crop.x + (cx - afterP.x) / S)
    const sy = Math.round(crop.y + (cy - afterP.y) / S)
    const sr = Math.max(2, Math.round(r / S))
    let sum = 0
    let sum2 = 0
    let n = 0
    for (let y = sy - sr; y <= sy + sr; y += 2)
      for (let x = sx - sr; x <= sx + sr; x += 2) {
        if (x < 0 || y < 0 || x >= pxA.width || y >= pxA.height) continue
        const i = (y * pxA.width + x) * 4
        const l = 0.2126 * pxA.data[i] + 0.7152 * pxA.data[i + 1] + 0.0722 * pxA.data[i + 2]
        sum += l
        sum2 += l * l
        n++
      }
    if (!n) return 0
    const m = sum / n
    return Math.sqrt(Math.max(0, sum2 / n - m * m)) / 128
  }
  const circleRectDist = (cx, cy, r) => {
    const dx = Math.max(r.x - cx, 0, cx - (r.x + r.w))
    const dy = Math.max(r.y - cy, 0, cy - (r.y + r.h))
    return Math.hypot(dx, dy)
  }

  const placed = []
  const DIRS = [
    [1, -1, 0], [-1, -1, 0.04], [1, 0, 0.06], [-1, 0, 0.08],
    [0, -1, 0.1], [1, 1, 0.12], [-1, 1, 0.14], [0, 1, 0.16],
  ]
  for (let k = 0; k < anns.length; k++) {
    const L = loopsA[k]
    let best = null
    for (const dist of [76, 98, 126]) {
      for (const [dx, dy, pref] of DIRS) {
        const ex = dx > 0 ? L.x + L.w : dx < 0 ? L.x : L.x + L.w * (0.5 + jit(0.15))
        const ey = dy > 0 ? L.y + L.h : dy < 0 ? L.y : L.y + L.h / 2
        const norm = Math.hypot(dx, dy) || 1
        const cx = ex + (dx / norm) * dist * (dx && dy ? 0.85 : 1)
        const cy = ey + (dy / norm) * dist * (dx && dy ? 0.85 : 1)
        const m = BADGE_R + 6
        if (cx - m < afterP.x || cy - m < afterP.y || cx + m > afterP.x + pw || cy + m > afterP.y + ph) continue
        let score = pref + busy(cx, cy, BADGE_R) * 0.6 + (dist - 76) * 0.002
        for (let j = 0; j < loopsA.length; j++) {
          const d = circleRectDist(cx, cy, loopsA[j])
          if (d < BADGE_R + 10) score += j === k ? 4 : 3
        }
        for (const q of placed) {
          if (Math.hypot(q.cx - cx, q.cy - cy) < 2 * BADGE_R + 26) score += 5
        }
        if (!best || score < best.score) best = { cx, cy, score, ex, ey }
      }
    }
    if (!best) {
      // Nowhere outside fits: tuck the badge inside the loop's top-left corner.
      best = { cx: L.x + BADGE_R + 6, cy: L.y + BADGE_R + 6, inside: true }
    }
    placed.push({ k, ...best })
  }

  const drawWithHalo = (fn, width) => {
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const saved = s
    ctx.strokeStyle = theme.halo
    ctx.globalCompositeOperation = 'source-over'
    fn(width + 5, 0.55)
    s = saved // replay the same jitter for the ink pass
    ctx.strokeStyle = ACCENT
    fn(width, 1)
    ctx.restore()
  }

  // Before side: faint matching outlines and hollow numbers.
  for (let k = 0; k < anns.length; k++) {
    const L = toPanel(beforeP, anns[k])
    drawWithHalo((w, a) => roughLoop(ctx, L, w * 0.7, 1, a * 0.55), 3.4)
    const bp = placed[k]
    badge(ctx, bp.cx - afterP.x + beforeP.x, bp.cy - afterP.y + beforeP.y, BADGE_R * 0.78, anns[k].n, false)
  }
  // After side: full markup.
  for (let k = 0; k < anns.length; k++) {
    const L = loopsA[k]
    drawWithHalo((w, a) => {
      ctx.globalAlpha = a
      roughLoop(ctx, L, w, 2, a)
    }, 4)
  }
  for (const bp of placed) {
    if (bp.inside) continue
    const L = loopsA[bp.k]
    // Aim at the nearest point of the loop, stopping just short of it.
    const tx = Math.max(L.x, Math.min(L.x + L.w, bp.cx))
    const ty = Math.max(L.y, Math.min(L.y + L.h, bp.cy))
    const ang = Math.atan2(ty - bp.cy, tx - bp.cx)
    const sx = bp.cx + Math.cos(ang) * (BADGE_R + 7)
    const sy = bp.cy + Math.sin(ang) * (BADGE_R + 7)
    const ex = tx - Math.cos(ang) * 7
    const ey = ty - Math.sin(ang) * 7
    const bend = (rand() < 0.5 ? -1 : 1) * (0.22 + rand() * 0.1)
    drawWithHalo((w) => roughArrow(ctx, sx, sy, ex, ey, bend, w), 3.6)
  }
  for (const bp of placed) badge(ctx, bp.cx, bp.cy, BADGE_R, anns[bp.k].n, true)

  // --- legend --------------------------------------------------------------
  if (legend.length) {
    const ly0 = panelsBottom + 30 + 18
    for (const it of legend) {
      const cy = ly0 + it.y + LEG_R
      badge(ctx, it.x + LEG_R, cy, LEG_R, it.a.n, true)
      ctx.fillStyle = theme.ink
      ctx.font = LEG_FONT
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(it.a.label, it.x + LEG_R * 2 + 14, cy + 1)
    }
  }

  return {
    png: canvas.toDataURL('image/png'),
    width: outW,
    height: outH,
    layout: sideBySide ? 'side-by-side' : 'stacked',
    crop: [crop.x, crop.y, crop.w, crop.h],
    annotations: anns.map((a) => ({ n: a.n, label: a.label, box: [a.x, a.y, a.w, a.h] })),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main(process.argv.slice(2), process.env)
  } catch (error) {
    const code = error instanceof Exit ? error.code : 1
    process.stderr.write(`${error instanceof Exit ? error.message : `markup: ${error?.message ?? error}`}\n`)
    process.exitCode = code
  }
}
