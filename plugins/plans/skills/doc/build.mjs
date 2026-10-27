#!/usr/bin/env node
// The plans:doc builder and checker. It inlines the kit at a page's `<!-- plans:kit -->` marker,
// expands prose-diff placeholders into static marks, stamps a build id, checks the result and
// writes it atomically beside the input. SKILL.md documents the CLI for agents. This header is the
// spec. Node built-ins only.
//
//   node build.mjs [--inline] [--out FILE] [--shots DIR] [--json] [--] INPUT
//
// Arguments. An unknown flag (`--help` included, and `--flag=value` forms), a flag given twice, a
// missing or dash-led value, no input, a second input or a bare `-` exits 2 with the usage line on
// stderr and nothing on stdout.
//
// Input. INPUT ends in `.html` and is a regular file, opened once with O_NOFOLLOW, so a symlink is
// refused. Its bytes must be strict UTF-8, and a BOM is kept as text.
//
// Output. `<stem>.built.html` (Document mode) or `<stem>.inline.html` (`--inline`) in INPUT's
// directory. A relative `--out` resolves against INPUT's directory, not the working directory.
// `--out` must sit directly in that directory, end in `.html`, and differ from INPUT by path and by
// device and inode, so a hard link to INPUT is refused. An existing output that is a symlink or not
// a regular file is refused. The bytes go to `.<out>.<random hex>.tmp`, opened `wx`, then fsync,
// then rename over the output. The temp file is unlinked on every error path, in the SIGINT,
// SIGTERM and SIGHUP handlers, and on exit. An existing output's other hard links keep the old
// bytes, because the rename replaces the name rather than writing through it.
//
// Assembly. The marker is replaced, in order, by `<meta name="plans-build" content="">`, one
// `<style data-plans-kit>` and, in Document mode only, one `<script data-plans-kit>`. Document mode
// inlines tokens.css, look.css, marks.css, ask.css and ask.js, always: the kit does nothing on a
// page without hooks. Inline mode inlines tokens.css and marks.css only. Every inlined text opens
// with `/* plans-kit:<file> */`. The kit files carry that line themselves. tokens.css doesn't,
// because plans:show pastes it whole into hand-written Inline output, so the builder adds it.
// Each `<div data-diff-before="a.md" data-diff-after="b.md" [data-diff-notes="12"]></div>` is
// replaced by kit/diff.mjs's static markup, keeping the placeholder's id, class and aria-*
// attributes on the outer div.plans-diff.
//
// Build id. SHA-256 over the assembled UTF-8 bytes with the meta's content empty, written as full
// hex into that content. The digest is SHA-256 of the final bytes, which are one Buffer: the
// browser check reads those bytes and the same Buffer is written. Nothing is reread.
//
// Refusals, each exit 1 with one line per fault on stderr and nothing written:
//   - INPUT missing, not `.html`, a symlink, not a regular file, or not UTF-8
//   - the `--out` rules above
//   - no marker comment, more than one, a marker text inside a raw-text element or another
//     comment, or a marker outside the first `<head>` ... `</head>`
//   - input that already holds built kit code: a `plans-build` meta, a `data-plans-kit`
//     attribute, or a `/* plans-kit:<kit file> */` line
//   - a kit file that holds `</script`, `</style` or `<!--` in any case, or lacks its header line
//     (kitRefusals)
//   - a malformed diff placeholder: not an empty div, an attribute other than the three data-diff
//     ones, id, class and aria-*, a duplicate attribute, a value with an entity the scanner can't
//     decode exactly, a missing side, data-diff-notes not an integer from 1 to 10000, a name that
//     is not a bare sibling file name, or a file that is a symlink, not a regular file, over
//     524,288 bytes or not UTF-8. Each distinct file is read once.
//   - a media `src` on img, video, audio or source holding a named entity other than the five the
//     scanner decodes
//   - in Inline mode, any kit hook (data-ask, data-note, data-ask-summary, data-respond), or
//     output over 500,000 UTF-8 bytes
//
// The browser check. After the static checks pass, check/run.mjs loads the exact final Buffer,
// served from memory by check/serve.mjs, in Chromium through check/cdp.mjs, across its view and
// state matrix. A pass writes the file and exits 0. A fault writes nothing and exits 1, with one
// line per distinct fault naming its kind and the cells it appeared in. An unknown, which includes
// no Chromium at all (`no-chromium`), writes the complete file and exits 3, which is never a pass.
// The browser and the server are closed, and Chromium's profile removed, before the write, on
// every path; a signal mid-check kills Chromium's process group and removes the profile and the
// temp file before the exit.
//
// Exit codes: 0 written and every check passed, 1 a fault with nothing written, 2 usage, 3 written
// with the browser result unknown.
//
// `--json` prints one object on stdout: result (pass | fail | unknown), reason {kind, detail},
// buildId, digest, out, bytes, matrix [{view, state, faults[]}], checks [{name, result, detail}],
// copy (copied-verified | blocked-selected | unknown | null), undriven [] and skippedMedia [].
// digest and bytes are null unless the file was written. Human lines go to stderr.
//
// `--shots DIR` resolves a relative DIR against INPUT's directory, as `--out` does, creates it,
// and writes `result.json` there with the build id and the result, on fail too, plus one full-page
// `<w>-<scheme>-<state>.png` per matrix cell the browser check reached, capped at 16384 px.
//
// The module exports its pure helpers for smoke imports and runs the CLI only when it is the entry
// point: kitRefusals(name, text), readKit(), assemble(text, opts), KIT_FILES and the limits.

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { render, diff } from './kit/diff.mjs'
import { attr, lineOf, scan } from './check/scan.mjs'
import { findChromium } from './check/cdp.mjs'
import { runChecks } from './check/run.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export const MARKER = '<!-- plans:kit -->'
export const META_EMPTY = '<meta name="plans-build" content="">'
export const DIFF_MAX = 524288
export const INLINE_MAX = 500000
export const NOTES_DEFAULT = 12
export const NOTES_MAX = 10000
export const HOOKS = ['data-ask', 'data-note', 'data-ask-summary', 'data-respond']
export const KIT_FILES = {
  'tokens.css': join(HERE, '..', 'show', 'tokens.css'),
  'look.css': join(HERE, 'kit', 'look.css'),
  'marks.css': join(HERE, 'kit', 'marks.css'),
  'ask.css': join(HERE, 'kit', 'ask.css'),
  'ask.js': join(HERE, 'kit', 'ask.js'),
}
const USAGE = 'usage: build.mjs [--inline] [--out FILE] [--shots DIR] [--json] [--] INPUT'
const MEDIA_TAGS = new Set(['img', 'video', 'audio', 'source'])
const RAW_NAMES = { script: '<script>', style: '<style>', title: '<title>', textarea: '<textarea>' }

const header = (name) => `/* plans-kit:${name} */`

// The refusals for one kit file's text, as inlined. An empty list means it may be inlined.
export function kitRefusals(name, text) {
  const out = []
  if (!text.startsWith(header(name) + '\n')) out.push(`kit file ${name} does not open with its ${header(name)} line`)
  for (const bad of ['</script', '</style', '<!--']) {
    if (text.toLowerCase().includes(bad)) out.push(`kit file ${name} contains ${bad}`)
  }
  return out
}

// The kit texts as inlined, keyed by file name. tokens.css gains its header line here.
export function readKit(files = KIT_FILES) {
  const kit = {}
  for (const [name, path] of Object.entries(files)) {
    const text = readText(path, Infinity).text
    kit[name] = name === 'tokens.css' && !text.startsWith(header(name)) ? `${header(name)}\n${text}` : text
  }
  return kit
}

class Refusal extends Error {
  constructor(kind, message) { super(message); this.kind = kind }
}

// Reads one file through O_NOFOLLOW and a fatal UTF-8 decode. Throws a Refusal with kind.
function readText(path, max, kind = 'input') {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    if (e.code === 'ELOOP') throw new Refusal(kind, 'is a symlink')
    if (e.code === 'ENOENT') throw new Refusal(kind, 'does not exist')
    throw new Refusal(kind, `cannot be opened (${e.code ?? 'error'})`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Refusal(kind, 'is not a regular file')
    if (st.size > max) throw new Refusal(kind, `is ${st.size} bytes, over the ${max}-byte limit`)
    const chunks = []
    let total = 0
    const cap = Number.isFinite(max) ? max + 1 : Infinity
    for (;;) {
      const buf = Buffer.allocUnsafe(65536)
      const got = readSync(fd, buf, 0, buf.length, null)
      if (got === 0) break
      chunks.push(buf.subarray(0, got))
      total += got
      if (total >= cap) throw new Refusal(kind, `is over the ${max}-byte limit`)
    }
    const bytes = Buffer.concat(chunks, total)
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw new Refusal(kind, 'is not valid UTF-8')
    }
    return { text, stat: st }
  } finally {
    closeSync(fd)
  }
}

const escAttr = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const bareName = (n) => n !== '' && n !== '.' && n !== '..' && !/[/\\\0]/.test(n)

// Assembles a page from its text. Pure apart from opts.readSibling, which reads one diff input by
// bare name and returns its text or throws a Refusal.
//   opts: { inline, kit, readSibling }
//   -> { faults: [{kind, line, message}], buffer, buildId, media: [{tag, src, line}], skippedMedia }
// buffer and buildId are null when there is any fault.
export function assemble(text, { inline = false, kit, readSibling }) {
  const faults = []
  const fault = (kind, offset, message) => faults.push({ kind, line: offset == null ? null : lineOf(text, offset), message })
  const kitNames = inline ? ['tokens.css', 'marks.css'] : ['tokens.css', 'look.css', 'marks.css', 'ask.css', 'ask.js']
  for (const name of kitNames) for (const m of kitRefusals(name, kit[name] ?? '')) fault('kit-file', null, m)

  // Built code already in the input.
  for (const name of Object.keys(KIT_FILES)) {
    const at = text.indexOf(header(name))
    if (at !== -1) fault('built', at, `holds the kit line ${header(name)}: build from the source page, not from a built one`)
  }

  const { tokens } = scan(text)

  // The marker.
  const comments = tokens.filter((t) => t.type === 'comment' && t.raw === MARKER)
  const headStart = tokens.findIndex((t) => t.type === 'start' && t.name === 'head')
  const headEnd = headStart === -1 ? -1 : tokens.findIndex((t, k) => k > headStart && t.type === 'end' && t.name === 'head')
  const rawOccurrences = []
  for (let at = text.indexOf(MARKER); at !== -1; at = text.indexOf(MARKER, at + 1)) rawOccurrences.push(at)
  for (const at of rawOccurrences) {
    if (comments.some((c) => c.start === at)) continue
    const raw = tokens.find((t) => t.type === 'raw' && t.start <= at && at < t.end)
    if (raw) { fault('marker', at, `the ${MARKER} marker sits inside ${RAW_NAMES[raw.name] ?? `<${raw.name}>`}`); continue }
    const inComment = tokens.find((t) => t.type === 'comment' && t.start < at && at < t.end)
    if (inComment) { fault('marker', at, `the ${MARKER} marker sits inside another comment`); continue }
    fault('marker', at, `the ${MARKER} marker sits inside a tag`)
  }
  if (rawOccurrences.length === 0) fault('marker', null, `no ${MARKER} marker: put exactly one in <head>`)
  if (comments.length > 1) for (const c of comments.slice(1)) fault('marker', c.start, `the ${MARKER} marker appears ${comments.length} times`)
  let marker = null
  if (comments.length === 1) {
    marker = comments[0]
    const ix = tokens.indexOf(marker)
    if (headStart === -1 || headEnd === -1 || ix < headStart || ix > headEnd) {
      fault('marker', marker.start, `the ${MARKER} marker must sit between <head> and </head>`)
    }
  }

  // Start tags: built-code markers, kit hooks, media and diff placeholders.
  const placeholders = []
  const media = [], skippedMedia = []
  tokens.forEach((t, k) => {
    if (t.type !== 'start') return
    if (t.name === 'meta' && attr(t, 'name')?.value.toLowerCase() === 'plans-build') {
      fault('built', t.start, 'holds a plans-build meta: build from the source page, not from a built one')
    }
    if (attr(t, 'data-plans-kit')) fault('built', t.start, `holds a data-plans-kit attribute on <${t.name}>: build from the source page`)
    if (inline) for (const h of HOOKS) if (attr(t, h)) fault('inline-hook', t.start, `kit hook ${h} on <${t.name}>: Inline output never holds the question kit`)
    if (MEDIA_TAGS.has(t.name)) {
      const src = attr(t, 'src')
      if (src) {
        if (src.odd) fault('media', t.start, `<${t.name}> src holds a character reference the CLI may read differently: write the path literally`)
        else {
          media.push({ tag: t.name, src: src.value, line: lineOf(text, t.start) })
          if (inline && src.value.startsWith('/')) skippedMedia.push(src.value)
        }
      }
    }
    if (t.attrs.some((a) => a.name.startsWith('data-diff-'))) placeholders.push({ t, k })
  })

  const replacements = []
  const cache = new Map()
  const read = (name) => {
    if (!cache.has(name)) {
      try { cache.set(name, { text: readSibling(name) }) } catch (e) { cache.set(name, { error: e }) }
    }
    return cache.get(name)
  }
  for (const { t, k } of placeholders) {
    const bad = (m) => fault('diff', t.start, `diff placeholder: ${m}`)
    if (t.name !== 'div') { bad(`data-diff-* attributes belong on an empty <div>, not <${t.name}>`); continue }
    const next = tokens[k + 1]
    if (!next || next.type !== 'end' || next.name !== 'div' || next.start !== t.end) { bad('the <div> must be empty and closed by </div> right after its start tag'); continue }
    let ok = true
    const seen = new Set()
    for (const a of t.attrs) {
      if (seen.has(a.name)) { bad(`duplicate attribute ${a.name}`); ok = false }
      seen.add(a.name)
      if (!['data-diff-before', 'data-diff-after', 'data-diff-notes', 'id', 'class'].includes(a.name) && !a.name.startsWith('aria-')) {
        bad(`attribute ${a.name} is not allowed: use data-diff-before, data-diff-after, data-diff-notes, id, class or aria-*`); ok = false
      }
      if (a.odd) { bad(`attribute ${a.name} holds a character reference the builder can't decode exactly`); ok = false }
    }
    const before = attr(t, 'data-diff-before'), after = attr(t, 'data-diff-after'), notes = attr(t, 'data-diff-notes')
    if (!before || !after) { bad('it needs both data-diff-before and data-diff-after'); continue }
    let noteWords = NOTES_DEFAULT
    if (notes) {
      if (!/^[1-9][0-9]*$/.test(notes.value) || Number(notes.value) > NOTES_MAX) { bad(`data-diff-notes="${notes.value}" must be an integer from 1 to ${NOTES_MAX}`); ok = false }
      else noteWords = Number(notes.value)
    }
    const sides = []
    for (const side of [before, after]) {
      if (!bareName(side.value)) { bad(`${side.name}="${side.value}" must be a bare file name beside the page, with no directory part`); ok = false; continue }
      const got = read(side.value)
      if (got.error) { bad(`${side.value} ${got.error instanceof Refusal ? got.error.message : 'cannot be read'}`); ok = false; continue }
      sides.push(got.text)
    }
    if (!ok) continue
    const html = render(diff(sides[0], sides[1], { noteWords }).ops, { noteWords })
    const cls = attr(t, 'class')?.value.trim()
    let open = `<div class="plans-diff${cls ? ' ' + escAttr(cls) : ''}"`
    for (const a of t.attrs) if (a.name === 'id' || a.name.startsWith('aria-')) open += ` ${a.name}="${escAttr(a.value)}"`
    open += '>'
    const PREFIX = '<div class="plans-diff">'
    replacements.push({ start: t.start, end: next.end, parts: [open + html.slice(PREFIX.length)] })
  }

  if (faults.length) return { faults, buffer: null, buildId: null, media, skippedMedia }

  const style = `<style data-plans-kit>\n${kitNames.filter((n) => n.endsWith('.css')).map((n) => kit[n].replace(/\n?$/, '\n')).join('')}</style>`
  const script = inline ? '' : `\n<script data-plans-kit>\n${kit['ask.js'].replace(/\n?$/, '\n')}</script>`
  replacements.push({ start: marker.start, end: marker.end, parts: [null, `\n${style}${script}`] })
  replacements.sort((a, b) => a.start - b.start)

  // The pieces in order. null stands for the build meta, so the id is hashed with it empty and the
  // final bytes differ from the hashed ones only in its content.
  const pieces = []
  let at = 0
  for (const r of replacements) {
    pieces.push(text.slice(at, r.start), ...r.parts)
    at = r.end
  }
  pieces.push(text.slice(at))
  const glue = (meta) => pieces.map((p) => (p === null ? meta : p)).join('')
  const buildId = createHash('sha256').update(Buffer.from(glue(META_EMPTY), 'utf8')).digest('hex')
  const buffer = Buffer.from(glue(`<meta name="plans-build" content="${buildId}">`), 'utf8')
  if (inline && buffer.length > INLINE_MAX) {
    return { faults: [{ kind: 'inline-size', line: null, message: `Inline output is ${buffer.length} UTF-8 bytes, over the ${INLINE_MAX}-byte budget: make it a Document` }], buffer: null, buildId, media, skippedMedia }
  }
  return { faults, buffer, buildId, media, skippedMedia }
}

/* ---------------------------------------------------------------- the CLI */

class Usage extends Error {}

export function parseArgs(argv) {
  const o = { inline: false, json: false, out: null, shots: null, input: null }
  const seen = new Set()
  let rest = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!rest && a === '--') { rest = true; continue }
    if (a === '-') throw new Usage('a bare - is not an input: name an .html file')
    if (!rest && a.startsWith('-')) {
      if (seen.has(a)) throw new Usage(`${a} given twice`)
      seen.add(a)
      if (a === '--inline') o.inline = true
      else if (a === '--json') o.json = true
      else if (a === '--out' || a === '--shots') {
        const v = argv[i + 1]
        if (v === undefined || v === '' || v.startsWith('-')) throw new Usage(`${a} needs a value`)
        o[a.slice(2)] = v
        i++
      } else throw new Usage(`unknown flag ${a}`)
      continue
    }
    if (o.input !== null) throw new Usage('only one INPUT')
    o.input = a
  }
  if (o.input === null) throw new Usage('INPUT is missing')
  return o
}

let tempPath = null
function dropTemp() {
  if (tempPath === null) return
  try { unlinkSync(tempPath) } catch {}
  tempPath = null
}

function writeAtomic(out, buffer) {
  const tmp = join(dirname(out), `.${basename(out)}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', 0o644)
  tempPath = tmp
  try {
    for (let off = 0; off < buffer.length;) off += writeSync(fd, buffer, off, buffer.length - off)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, out)
  tempPath = null
  try {
    const d = openSync(dirname(out), constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(d) } finally { closeSync(d) }
  } catch {}
}

function writeResultJson(dir, result) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'result.json')
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644)
  try { writeSync(fd, JSON.stringify(result, null, 2) + '\n') } finally { closeSync(fd) }
}

// The output path for an input, or a Refusal.
function outputPath(input, inputStat, outArg, inline) {
  const dir = dirname(input)
  const out = outArg === null
    ? join(dir, basename(input).replace(/\.html$/, '') + (inline ? '.inline.html' : '.built.html'))
    : resolve(dir, outArg)
  if (dirname(out) !== dir) throw new Refusal('out', `--out ${outArg} must sit directly in the input's directory ${dir}`)
  if (!out.endsWith('.html')) throw new Refusal('out', `--out ${outArg} must end in .html`)
  if (out === input) throw new Refusal('out', `--out ${outArg} is the input`)
  let st = null
  try { st = lstatSync(out) } catch (e) { if (e.code !== 'ENOENT') throw new Refusal('out', `the output ${out} cannot be checked (${e.code ?? 'error'})`) }
  if (st) {
    if (st.isSymbolicLink()) throw new Refusal('out', `the output ${out} is a symlink`)
    if (!st.isFile()) throw new Refusal('out', `the output ${out} is not a regular file`)
    if (st.dev === inputStat.dev && st.ino === inputStat.ino) throw new Refusal('out', `the output ${out} is a hard link to the input`)
  }
  return out
}

async function main(argv) {
  let opts
  try { opts = parseArgs(argv) } catch (e) {
    if (!(e instanceof Usage)) throw e
    process.stderr.write(`build.mjs: ${e.message}\n${USAGE}\n`)
    return 2
  }

  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { dropTemp(); process.exit(128 + n) })
  process.on('exit', dropTemp)

  const result = { result: 'fail', reason: null, buildId: null, digest: null, out: null, bytes: null, matrix: [], checks: [], copy: null, undriven: [], skippedMedia: [] }
  const input = resolve(opts.input)
  const shots = opts.shots === null ? null : resolve(dirname(input), opts.shots)
  const finish = (code) => {
    if (opts.json) process.stdout.write(JSON.stringify(result) + '\n')
    if (shots) {
      try { writeResultJson(shots, { buildId: result.buildId, result: result.result, reason: result.reason }) } catch (e) {
        process.stderr.write(`build.mjs: cannot write ${join(shots, 'result.json')} (${e.code ?? 'error'})\n`)
      }
    }
    return code
  }
  const refuse = (faults) => {
    for (const f of faults) {
      process.stderr.write(`build.mjs: ${opts.input}${f.line ? `:${f.line}` : ''}: ${f.message}\n`)
      result.checks.push({ name: f.kind, result: 'fail', detail: f.message })
    }
    result.result = 'fail'
    result.reason = { kind: faults[0].kind, detail: faults[0].message }
    return finish(1)
  }

  let source, out, kit
  try {
    if (!input.endsWith('.html')) throw new Refusal('input', 'must end in .html')
    source = readText(input, Infinity)
    out = outputPath(input, source.stat, opts.out, opts.inline)
    result.out = out
  } catch (e) {
    if (!(e instanceof Refusal)) throw e
    return refuse([{ kind: e.kind, line: null, message: e.kind === 'input' ? `the input ${e.message}` : e.message }])
  }
  try { kit = readKit() } catch (e) {
    return refuse([{ kind: 'kit-file', line: null, message: `a kit file cannot be read: ${e.message}` }])
  }

  const dir = dirname(input)
  const readSibling = (name) => readText(join(dir, name), DIFF_MAX, 'diff').text
  const built = assemble(source.text, { inline: opts.inline, kit, readSibling })
  result.buildId = built.buildId
  result.skippedMedia = built.skippedMedia
  if (built.faults.length) return refuse(built.faults)
  result.checks.push({ name: 'static', result: 'pass', detail: '' })

  // The browser half, over the exact bytes that will be written.
  const found = findChromium(process.env, process.platform)
  let browser
  if (found.reason) {
    browser = { result: 'unknown', reason: found.reason, matrix: [], checks: [{ name: 'browser', result: 'unknown', detail: `${found.reason.kind}: ${found.reason.detail}` }], copy: null, undriven: [] }
  } else {
    process.stderr.write(`build.mjs: checking ${basename(out)} in ${found.path}\n`)
    browser = await runChecks({ buffer: built.buffer, inline: opts.inline, dir, media: built.media, skippedMedia: built.skippedMedia, chromium: found.path, shots })
  }
  result.matrix = browser.matrix
  result.checks.push(...browser.checks)
  result.copy = browser.copy
  result.undriven = browser.undriven
  for (const u of browser.undriven) process.stderr.write(`build.mjs: not driven: ${u}\n`)

  if (browser.result === 'fail') {
    const lines = new Map()
    for (const cell of browser.matrix) {
      for (const f of cell.faults) {
        const key = `${f.kind}: ${f.detail}`
        if (!lines.has(key)) lines.set(key, [])
        lines.get(key).push(`${cell.view} ${cell.state}`)
      }
    }
    for (const [line, cells] of lines) process.stderr.write(`build.mjs: ${opts.input}: ${line} [${cells.length === browser.matrix.length ? 'every cell' : cells.join(', ')}]\n`)
    process.stderr.write(`build.mjs: the browser check failed: nothing written\n`)
    result.result = 'fail'
    result.reason = browser.reason
    return finish(1)
  }

  try {
    writeAtomic(out, built.buffer)
  } catch (e) {
    dropTemp()
    return refuse([{ kind: 'write', line: null, message: `cannot write ${out} (${e.code ?? 'error'})` }])
  }
  result.result = browser.result
  result.reason = browser.reason
  result.digest = createHash('sha256').update(built.buffer).digest('hex')
  result.bytes = built.buffer.length
  process.stderr.write(`build.mjs: wrote ${out} (${built.buffer.length} bytes, build ${built.buildId.slice(0, 12)})\n`)
  if (browser.result === 'pass') return finish(0)
  process.stderr.write(`build.mjs: browser check unknown: ${browser.reason.kind}: ${browser.reason.detail}. Exit 3 is never a pass.\n`)
  return finish(3)
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
