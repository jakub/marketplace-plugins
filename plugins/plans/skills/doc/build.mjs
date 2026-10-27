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
// Input. INPUT ends in `.html` and is a regular file, opened once with O_NOFOLLOW and O_NONBLOCK
// and then checked with fstat, so a symlink is refused and a FIFO is refused without blocking the
// open. Diff inputs are opened the same way. INPUT's bytes must be strict UTF-8, and a BOM is
// kept as text.
//
// Output. `<stem>.built.html` (Document mode) or `<stem>.inline.html` (`--inline`) in INPUT's
// directory. A relative `--out` resolves against INPUT's directory, not the working directory.
// `--out` must sit directly in that directory, end in `.html`, and differ from INPUT by path and by
// device and inode, so a hard link to INPUT is refused. An existing output that is a symlink or not
// a regular file is refused. The bytes go to `.<out>.<random hex>.tmp`, opened `wx`, then fsync,
// then rename over the output. The temp file is unlinked on every error path, in the SIGINT,
// SIGTERM and SIGHUP handlers, and on exit. An existing output's other hard links keep the old
// bytes, because the rename replaces the name rather than writing through it. Every file the
// builder writes, in INPUT's directory or in --shots DIR, is written this way: no existing file is
// ever opened for writing.
//
// Directory identity. The builder opens INPUT's directory, and --shots DIR when given, once each
// as an O_DIRECTORY descriptor held for the whole run, and reaches every name in them through that
// descriptor: INPUT, the diff inputs, the output checks, each temp file and its rename, the
// screenshots, result.json and every cleanup. Node has no openat or renameat, so on Linux the path
// is /proc/self/fd/<fd>/<name>, used only after /proc/self/fd/<fd> shows the descriptor's device
// and inode. The kernel resolves that path through the descriptor, so renaming the directory, or
// putting a symlink at its old path, after the build starts changes nothing: the files land in
// the directory INPUT was read from, and `out` keeps naming the path as given. Where
// /proc/self/fd is missing (macOS), each name is reached by the directory's path after a stat
// shows the same device and inode, and the step fails with EPINNED when it doesn't. A swap that
// lands between that stat and the open, rename or unlink after it still redirects that one step:
// that window is open on macOS only. The media the browser check serves are read by path on
// every platform.
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
//   - INPUT missing, not `.html`, a symlink, not a regular file (a FIFO included), or not UTF-8
//   - the `--out` rules above
//   - no marker comment, more than one, a marker text inside a raw-text element, a CDATA section
//     or another comment, a marker inside a `<template>` or inside SVG or MathML content, or a
//     marker outside the first `<head>` ... `</head>`. The one marker must be a live comment in
//     HTML content.
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
//   - in Document mode, a viewport that may not lay the page out at the device's width (kind
//     `viewport`). Without width=device-width a phone, and the 390 px views, lay the page out 980 px
//     wide, so page-overflow and clipped mean little there. The Plans viewer serves a Document
//     top-level, so a reader's phone sees the same. Inline mode doesn't need it, because T3 renders
//     an Inline page in an iframe. The rule is static and strict, because Chromium applies only the
//     last viewport meta and the last value of each key, and reads a list that isn't plain pairs
//     loosely (`width=device-width; foo width x=980` lays out 980 px wide). So the page needs
//     exactly one `<meta name="viewport">` outside a template, its name matched case-insensitively
//     but untrimmed as Chromium matches it, whose content is `key=value` pairs separated by spaces,
//     commas or semicolons, with at least one width, every width `device-width`, and any
//     initial-scale or maximum-scale a number of at least 1. A smaller scale widens the layout too:
//     0.5 lays the page out 780 px wide. Measured in Chromium 155 at 390 px, 2026-10-27.
//   - in Inline mode, any kit hook (data-ask, data-note, data-ask-summary, data-respond), or
//     output over 500,000 UTF-8 bytes
//   - SVG or MathML content check/scan.mjs can't follow (kind `foreign`): markup inside an SVG
//     title, desc or foreignObject or a MathML text element, or an end tag that closes no open
//     foreign element. scan.mjs's header says why.
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
// with the result unknown, from the browser check or from a --shots write below.
//
// `--json` prints one object on stdout: result (pass | fail | unknown), reason {kind, detail},
// buildId, digest, out, bytes, matrix [{view, state, faults[]}], checks [{name, result, detail}],
// copy (copied-verified | blocked-selected | unknown | null), undriven [] and skippedMedia [].
// digest and bytes are null unless the file was written. Human lines go to stderr.
//
// `--shots DIR` resolves a relative DIR against INPUT's directory, as `--out` does, creates it,
// and writes `result.json` there with the build id and the result, on fail too, plus one full-page
// `<w>-<scheme>-<state>.png` per matrix cell the browser check reached, capped at 16384 px. A DIR
// that can't be created is a `write` refusal, with no result.json. result.json gets its own temp
// file and rename. The browser check writes its PNGs into a fresh `.plans-shots.<random hex>.tmp`
// directory inside DIR, and the builder renames each into DIR, then removes that directory, which
// the signal and exit handlers also remove. A hard link or symlink at any of those names keeps its
// old target. Those writes finish before the verdict is printed, and a failed one, a PNG rename or
// result.json, is never a pass: it adds a `write` check that fails, and a build that would pass
// becomes unknown with reason kind `write` and exits 3, because the HTML is already written by
// then. A failed build stays exit 1. result.json records the result after any failed PNG; its own
// failure shows only in the printed result and the exit code.
//
// The module exports its pure helpers for smoke imports and runs the CLI only when it is the entry
// point: kitRefusals(name, text), readKit(), assemble(text, opts), pinDir(path, procRoot),
// KIT_FILES and the limits.

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
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
// A viewport content list of plain key=value pairs, with spaces, commas or semicolons between
// pairs and spaces around `=`, as Chromium separates them. Anything else is refused, not guessed.
const VIEWPORT_PAIRS = /^[ \t\n\r,;]*(?:[^ \t\n\r,;=]+[ \t\n\r]*=[ \t\n\r]*[^ \t\n\r,;=]+(?:[ \t\n\r,;]+|$))+$/
const VIEWPORT_PAIR = /([^ \t\n\r,;=]+)[ \t\n\r]*=[ \t\n\r]*([^ \t\n\r,;=]+)/g
const SCALE = /^(?:\d+\.?\d*|\.\d+)$/
const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">'
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
// O_NONBLOCK makes the open of a FIFO return at once, so fstat can refuse it. It changes nothing
// for the read of a regular file.
function readText(path, max, kind = 'input') {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
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

  const { tokens, unsure } = scan(text)

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
    if (tokens.some((t) => t.type === 'cdata' && t.start < at && at < t.end)) { fault('marker', at, `the ${MARKER} marker sits inside a CDATA section, which the browser keeps as text`); continue }
    fault('marker', at, `the ${MARKER} marker sits inside a tag`)
  }
  if (rawOccurrences.length === 0) fault('marker', null, `no ${MARKER} marker: put exactly one in <head>`)
  if (comments.length > 1) for (const c of comments.slice(1)) fault('marker', c.start, `the ${MARKER} marker appears ${comments.length} times`)
  for (const c of comments) {
    if (c.template) fault('marker', c.start, `the ${MARKER} marker sits inside a <template>, whose content never runs: put it in <head> itself`)
    if (c.foreign) fault('marker', c.start, `the ${MARKER} marker sits inside <svg> or <math> content: put it in <head>, outside any figure`)
  }
  let marker = null
  if (comments.length === 1) {
    marker = comments[0]
    const ix = tokens.indexOf(marker)
    if (headStart === -1 || headEnd === -1 || ix < headStart || ix > headEnd) {
      fault('marker', marker.start, `the ${MARKER} marker must sit between <head> and </head>`)
    }
  }

  // The viewport, in Document mode. The header gives the rule and why it is strict.
  if (!inline) {
    const metas = tokens.filter((t) => t.type === 'start' && t.name === 'meta' && !t.template && attr(t, 'name')?.value.toLowerCase() === 'viewport')
    if (metas.length === 0) fault('viewport', null, `no viewport meta with width=device-width: put ${VIEWPORT_META} in <head>, or the page lays out 980 px wide on a phone`)
    if (metas.length > 1) fault('viewport', metas[1].start, `${metas.length} viewport metas: Chromium applies only the last one, so a later meta can override width=device-width. Keep one: ${VIEWPORT_META}`)
    if (metas.length === 1) {
      const t = metas[0], content = attr(t, 'content')
      const say = (m) => fault('viewport', t.start, `viewport content "${content?.value ?? ''}" ${m}: write ${VIEWPORT_META}, or the page may lay out wider than a phone's screen`)
      if (content?.odd) say('holds a character reference the builder can\'t decode exactly')
      else if (!VIEWPORT_PAIRS.test(content?.value ?? '')) say('is not a plain list of key=value pairs, and Chromium reads a loose list in ways that can set another width')
      else {
        const pairs = [...content.value.matchAll(VIEWPORT_PAIR)].map(([, k, v]) => [k.toLowerCase(), v])
        const widths = pairs.filter(([k]) => k === 'width').map(([, v]) => v)
        const others = widths.filter((v) => v.toLowerCase() !== 'device-width')
        if (widths.length === 0) say('sets no width=device-width')
        else if (others.length) say(`sets ${others.map((v) => `width=${v}`).join(' and ')}${others.length < widths.length ? ' as well as width=device-width, and Chromium applies the last width' : ', not width=device-width'}`)
        for (const [k, v] of pairs) {
          if ((k === 'initial-scale' || k === 'maximum-scale') && !(SCALE.test(v) && Number(v) >= 1)) say(`sets ${k}=${v}, and a scale that is not a number of at least 1 widens the layout`)
        }
      }
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

  // Foreign content the scanner can't follow, after the specific faults so those lead.
  for (const u of unsure) fault('foreign', u.start, u.message)

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

// What the builder made and has not yet renamed into place: temp files and the screenshot staging
// directory, each as the path it was created through. The signal and exit handlers remove
// whatever is left.
const scratch = new Set()
function dropScratch() {
  for (const p of scratch) { try { rmSync(p, { recursive: true, force: true }) } catch {} }
  scratch.clear()
}

const hex = () => randomBytes(6).toString('hex')

// A directory pinned by identity: an O_DIRECTORY descriptor held open for the rest of the run, and
// at(name), the path that reaches one name inside it, or the directory itself with no name. Where
// procRoot/<fd> shows the descriptor's own device and inode (Linux), that path goes through
// procRoot/<fd>, which the kernel resolves through the descriptor. Elsewhere at() stats the
// directory's path first, throws code EPINNED when the path names another directory now, and
// returns the plain path. The header says what that leaves open.
export function pinDir(path, procRoot = '/proc/self/fd') {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK)
  const { dev, ino } = fstatSync(fd)
  const proc = `${procRoot}/${fd}`
  let viaProc = false
  try {
    const st = statSync(proc)
    viaProc = st.dev === dev && st.ino === ino
  } catch {}
  const at = (name = '') => {
    if (viaProc) return name ? `${proc}/${name}` : proc
    let st = null
    try { st = statSync(path) } catch {}
    if (!st || st.dev !== dev || st.ino !== ino) {
      throw Object.assign(new Error(`${path} is no longer the directory the build started in`), { code: 'EPINNED' })
    }
    return name ? join(path, name) : path
  }
  return { fd, path, viaProc, at }
}

const syncDir = (dir) => { try { fsyncSync(dir.fd) } catch {} }

// Writes bytes to name in a pinned directory through a fresh `.<name>.<random hex>.tmp`, then
// renames it over the name. An existing file there, or a hard link or symlink at that name, is
// replaced, never written through.
function replaceFile(dir, name, bytes) {
  const tmp = dir.at(`.${name}.${hex()}.tmp`)
  const fd = openSync(tmp, 'wx', 0o644)
  scratch.add(tmp)
  try {
    try {
      for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, dir.at(name))
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  } finally {
    scratch.delete(tmp)
  }
  syncDir(dir)
}

// A fresh directory inside the pinned shots directory for the browser check's PNGs, pinned too.
function stageShots(dir) {
  const name = `.plans-shots.${hex()}.tmp`
  const path = dir.at(name)
  mkdirSync(path, 0o700)
  scratch.add(path)
  return { name, path, pin: pinDir(path) }
}

// Renames every staged PNG into the shots directory, then removes the staging directory. Returns
// one message per screenshot it could not put in place.
function settleShots(dir, staging) {
  const lost = []
  let names = []
  try { names = readdirSync(staging.pin.at()) } catch (e) {
    lost.push(`cannot read the staged screenshots in ${join(dir.path, staging.name)} (${e.code ?? 'error'})`)
  }
  for (const name of names) {
    try { renameSync(staging.pin.at(name), dir.at(name)) } catch (e) {
      lost.push(`cannot write ${join(dir.path, name)} (${e.code ?? 'error'})`)
    }
  }
  for (const m of lost) process.stderr.write(`build.mjs: ${m}\n`)
  closeSync(staging.pin.fd)
  try { rmSync(dir.at(staging.name), { recursive: true, force: true }) } catch {}
  scratch.delete(staging.path)
  syncDir(dir)
  return lost
}

// The output path for an input, or a Refusal. inDir is the input's pinned directory.
function outputPath(input, inputStat, outArg, inline, inDir) {
  const dir = dirname(input)
  const out = outArg === null
    ? join(dir, basename(input).replace(/\.html$/, '') + (inline ? '.inline.html' : '.built.html'))
    : resolve(dir, outArg)
  if (dirname(out) !== dir) throw new Refusal('out', `--out ${outArg} must sit directly in the input's directory ${dir}`)
  if (!out.endsWith('.html')) throw new Refusal('out', `--out ${outArg} must end in .html`)
  if (out === input) throw new Refusal('out', `--out ${outArg} is the input`)
  let st = null
  try { st = lstatSync(inDir.at(basename(out))) } catch (e) { if (e.code !== 'ENOENT') throw new Refusal('out', `the output ${out} cannot be checked (${e.code ?? 'error'})`) }
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

  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { dropScratch(); process.exit(128 + n) })
  process.on('exit', dropScratch)

  const result = { result: 'fail', reason: null, buildId: null, digest: null, out: null, bytes: null, matrix: [], checks: [], copy: null, undriven: [], skippedMedia: [] }
  const input = resolve(opts.input)
  let shots = null
  const shotsLost = []
  // Finishes the --shots writes, lets a failed one change the result as the header says, then
  // prints the result.
  const finish = (code) => {
    const lost = (detail) => {
      result.checks.push({ name: 'write', result: 'fail', detail })
      if (code !== 0) return
      code = 3
      result.result = 'unknown'
      result.reason = { kind: 'write', detail }
      process.stderr.write(`build.mjs: the --shots evidence is incomplete, so the result is unknown. Exit 3 is never a pass.\n`)
    }
    for (const m of shotsLost) lost(m)
    if (shots) {
      const receipt = Buffer.from(JSON.stringify({ buildId: result.buildId, result: result.result, reason: result.reason }, null, 2) + '\n', 'utf8')
      try { replaceFile(shots, 'result.json', receipt) } catch (e) {
        const m = `cannot write ${join(shots.path, 'result.json')} (${e.code ?? 'error'})`
        process.stderr.write(`build.mjs: ${m}\n`)
        lost(m)
      }
    }
    if (opts.json) process.stdout.write(JSON.stringify(result) + '\n')
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

  if (opts.shots !== null) {
    const dir = resolve(dirname(input), opts.shots)
    try {
      mkdirSync(dir, { recursive: true })
      shots = pinDir(dir)
    } catch (e) {
      return refuse([{ kind: 'write', line: null, message: `cannot create the --shots directory ${dir} (${e.code ?? 'error'})` }])
    }
  }

  let inDir, source, out, kit
  try {
    if (!input.endsWith('.html')) throw new Refusal('input', 'must end in .html')
    try { inDir = pinDir(dirname(input)) } catch (e) {
      throw new Refusal('input', e.code === 'ENOENT' ? 'does not exist' : `cannot be opened (${e.code ?? 'error'})`)
    }
    let path
    try { path = inDir.at(basename(input)) } catch (e) { throw new Refusal('input', `cannot be opened (${e.code})`) }
    source = readText(path, Infinity)
    out = outputPath(input, source.stat, opts.out, opts.inline, inDir)
    result.out = out
  } catch (e) {
    if (!(e instanceof Refusal)) throw e
    return refuse([{ kind: e.kind, line: null, message: e.kind === 'input' ? `the input ${e.message}` : e.message }])
  }
  try { kit = readKit() } catch (e) {
    return refuse([{ kind: 'kit-file', line: null, message: `a kit file cannot be read: ${e.message}` }])
  }

  const dir = dirname(input)
  const readSibling = (name) => readText(inDir.at(name), DIFF_MAX, 'diff').text
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
    let staging = null, stagedAt = null
    if (shots) {
      try {
        staging = stageShots(shots)
        stagedAt = staging.pin.at()
      } catch (e) {
        return refuse([{ kind: 'write', line: null, message: `cannot create a staging directory in ${shots.path} (${e.code ?? 'error'})` }])
      }
    }
    process.stderr.write(`build.mjs: checking ${basename(out)} in ${found.path}\n`)
    browser = await runChecks({ buffer: built.buffer, inline: opts.inline, dir, media: built.media, skippedMedia: built.skippedMedia, chromium: found.path, shots: stagedAt })
    if (staging) shotsLost.push(...settleShots(shots, staging))
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
    replaceFile(inDir, basename(out), built.buffer)
  } catch (e) {
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
