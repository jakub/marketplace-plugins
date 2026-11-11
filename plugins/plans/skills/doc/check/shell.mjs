// The browser check's half for the page shell: the `chrome` state and the question counts. run.mjs
// calls it, and its header defines `drive` and the rules every function here keeps. Node built-ins
// only, and no import of run.mjs, which imports this file. parts.mjs's expose() makes a hidden
// zoom reachable, and its restore() puts the page back.
//
//   chrome(drive)          the `chrome` state on a Document whose bytes hold body[data-base-shell]:
//                          the theme switch, every zoom, the dock and the sections sheet. Returns
//                          { faults, steps }, every finding a step row, so a failed step is the
//                          fault part-drive `chrome <target>: <what failed>` through run.mjs.
//   counts(drive, model)   during the kit's `interaction` state on the same pages, after the
//                          initial response and after each step that moves a question between
//                          open, changed and kept. model is a copy of the interaction's own record,
//                          { title, build, questions: [{ id, legend, type, kept, options: [{ value,
//                          label, defaultChecked, checked }] }], notes: [{ name, text }] }. Returns
//                          one check row { name: 'interaction: base counts', result, detail }, or
//                          null for no row.
//
// What should exist comes from the built bytes, parsed in the page with DOMParser (plan()), never
// from what the shell's script made or a marker it set. So a shell that made nothing fails each
// step the bytes call for instead of passing with nothing to drive. Nothing inside a <noscript> or
// a <template> counts, since the scripted page holds neither's content as elements. The bytes call
// for:
//   - the theme switch, when they hold header.pb-mast
//   - one zoom per img in figure.pb-figure[data-base-zoom], in document order, less one inside a
//     fieldset[data-ask], or with a data-base-dpr that isn't a number over 0, each of which the
//     shell refuses with a part-error. A zoom button past that count fails its row too.
//   - the dock and the sheet, when a main > section[id] opens with an h2: those sections are the
//     rows, titled by the h2's text less a leading .num, whitespace collapsed, else the id
//   - a count on each row whose section holds a fieldset[data-ask], in the contents list and in
//     the sheet, and the page's total on the dock
// Controls are found by the script-made names in parts.md and the plan's contracts, and every
// action is drive.click or drive.key: real input under run.mjs's hit-test rule.
//
// chrome, in this order. Each step's first failure ends that step: it closes any open dialog and
// the walk goes on to the next part.
//   theme      the --plans-fb-* names tokens.css's dark block overrides (14), with their values in
//              its first :root block and in that dark block, read from
//              plugins/plans/skills/show/tokens.css on disk, never from the page. A click on the
//              switch, then light: the computed values on <html> equal the light ones and the
//              computed color-scheme is `light`. A click, then dark, the same against the dark
//              values and `dark`. A click, then auto: <html> has no data-plans-theme, and the
//              values equal those of the scheme the view emulates. Two more clicks, light then
//              dark, each checked again under its own row. A click that can't land ends the theme.
//   zoom n     the button's img must carry the src the bytes give zoom n. A zoom that a closed
//              <details>, a hidden switch pane or a compare's hidden side holds, nested in any
//              order, is made reachable through expose() first, and one it can't reach fails with
//              `revealing it: <the container that stayed hidden>`. Whatever the row's result,
//              restore() then puts back what expose() changed, after any open dialog is closed,
//              and a failure there fails a row that had passed. A click opens it: exactly one
//              open dialog, modal, showing that image, decoded. A click on Actual
//              size: the image's drawn width is its natural width over the ratio within 1 CSS px,
//              the ratio being data-base-dpr on the authored img, else natural width over its
//              width attribute, else 1. Close, then a second open and Escape: no dialog stays open
//              and focus is back on zoom n's button each time.
//   dock       scrolls the contents list (else the masthead, else the first row's section, as the
//              shell watches) just out of view, then the dock must show inside the viewport and
//              read `k/N title` for a listed section that is in view. A page too short to scroll
//              that far passes when the dock stays hidden. No reader can open its sheet there,
//              so the sheet row checks the sheet unopened: it exists, is closed and lists every
//              row in order.
//   sheet      with the dock showing, a click on Sections opens one modal dialog that is the sheet
//              and lists every row in order. A click on the last row (the first, when the dock
//              names the last) closes it and brings that section's top into view above the dock.
//              Then Close, and a second open and Escape: no dialog stays open and focus is back on
//              Sections each time.
//
// Forced dark and run.mjs. chrome() returns with <html data-plans-theme="dark">, the theme's last
// click. run.mjs then closes every dialog, scrolls to 0, settles, probes and captures on the same
// document, with no reload, so the state's probe and screenshot are of the page in forced dark:
// the 1100 view's only dark render, since its scheme is light. In the dark views forced dark shows
// what auto does. interaction gets a load of its own, in auto.
//
// counts reads the rows and the questions the bytes hold, and counts its own open questions from
// model: a question is answered when it is kept or any option's checked differs from its default,
// and every other question is open. Each row with questions must read `N open`, or `answered` when
// N is 0, in the contents list and in the sheet, and the dock the page's total. The kit writes its
// state as it handles the input, so the page gets 300 ms to settle, and a stale count fails. After
// a failure the row is not checked again on that load: it has already failed for the view.

import { readFileSync } from 'node:fs'

import { expose, restore } from './parts.mjs'

const TOKENS = new URL('../../show/tokens.css', import.meta.url)
const THEME = 'button.plans-theme'
const ZOOM = 'button.plans-zoom-open'
const ZOOM_SIZE = 'dialog.plans-zoom button.plans-zoom-size'
const ZOOM_CLOSE = 'dialog.plans-zoom button.plans-zoom-close'
const SECTIONS = '.plans-dock button.plans-dock-sections'
const SHEET = 'dialog.plans-sheet'
const SHEET_ROW = 'dialog.plans-sheet a[href]'
const SHEET_CLOSE = 'dialog.plans-sheet button.plans-sheet-close'
// The cap on each wait for the page to answer an action: a dialog, a decode, a size, focus. Each
// lands within a few frames, so the cap is only ever spent by a step that fails, and a page with
// eight broken zooms then spends 8 s per view of the 180 s deadline.
const WAIT_MS = 1000
const COUNTS_MS = 300
const COUNTS = 'interaction: base counts'

/* ---------------------------------------------------------------- tokens.css */

let tokens = null
// tokens.css's fallbacks: { names, light, dark }, names being the --plans-fb-* names its dark block
// overrides, light and dark Maps of name to value with whitespace collapsed. Read once.
function fallbacks() {
  if (tokens) return tokens
  const css = readFileSync(TOKENS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const body = (at) => {
    const open = css.indexOf('{', at)
    for (let i = open, depth = 0; open !== -1 && i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
    }
    throw new Error(`${TOKENS.pathname}: a block opened at ${at} never closes`)
  }
  const decls = (text) => new Map([...text.matchAll(/(--plans-fb-[a-z0-9-]+)\s*:\s*([^;}]+)/g)].map(([, n, v]) => [n, v.trim().replace(/\s+/g, ' ')]))
  const root = css.search(/:root\s*\{/)
  const media = css.search(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/)
  if (root === -1 || media === -1 || root > media) throw new Error(`${TOKENS.pathname}: no :root block ahead of a prefers-color-scheme: dark block`)
  const light = decls(body(root)), dark = decls(body(media))
  const names = [...dark.keys()]
  const lost = names.filter((n) => !light.has(n))
  if (!names.length || lost.length) throw new Error(`${TOKENS.pathname}: the dark block overrides ${names.length} fallbacks, ${lost.length} without a light value`)
  return (tokens = { names, light, dark })
}

/* ---------------------------------------------------------------- in-page */

// What the built bytes call for, read with DOMParser: { mast, nav, rows: [{ id, title, asks }],
// asks: [id], zooms: [{ src, dpr, width }] }. asks in a row are indexes into asks. DOMParser parses
// with scripting off, so a <noscript>'s content is elements here and text in the scripted page:
// every read skips it, and a <template>'s, as parts.mjs's model does.
function plan(source) {
  const doc = new DOMParser().parseFromString(source, 'text/html')
  const all = (root, sel) => [...root.querySelectorAll(sel)].filter((el) => !el.closest('noscript, template'))
  const asks = all(doc, 'fieldset[data-ask]')
  const titleOf = (h) => {
    let t = ''
    for (const n of h.childNodes) if (!(n.nodeType === 1 && !t.trim() && n.matches('.num'))) t += n.textContent
    return t.replace(/\s+/g, ' ').trim()
  }
  const rows = []
  for (const s of all(doc, 'main > section[id]')) {
    const h = s.firstElementChild
    if (!s.id || !h || h.localName !== 'h2') continue
    rows.push({ id: s.id, title: titleOf(h) || s.id, asks: all(s, 'fieldset[data-ask]').map((f) => asks.indexOf(f)) })
  }
  const zooms = []
  for (const img of all(doc, 'figure.pb-figure[data-base-zoom] img')) {
    if (img.closest('fieldset[data-ask]')) continue
    const raw = img.getAttribute('data-base-dpr')
    const dpr = raw === null ? 0 : raw.trim() === '' ? NaN : Number(raw)
    if (raw !== null && !(Number.isFinite(dpr) && dpr > 0)) continue
    const w = parseInt(img.getAttribute('width'), 10)
    zooms.push({ src: img.getAttribute('src'), dpr, width: w > 0 ? w : 0 })
  }
  return { mast: all(doc, 'header.pb-mast').length > 0, nav: all(doc, '[data-base-contents]').length > 0, rows, asks: asks.map((f) => f.getAttribute('data-ask')), zooms }
}

function themeNow(names) {
  const html = document.documentElement
  const cs = getComputedStyle(html)
  const values = {}
  for (const n of names) values[n] = cs.getPropertyValue(n).trim().replace(/\s+/g, ' ')
  return { values, scheme: cs.getPropertyValue('color-scheme').trim(), forced: html.getAttribute('data-plans-theme') }
}

function count(selector) { return document.querySelectorAll(selector).length }

// Whether zoom i's button exists, and the src of its img.
function zoomSpot(selector, i) {
  const b = document.querySelectorAll(selector)[i]
  if (!b) return { missing: true }
  const img = b.querySelector('img')
  return { missing: false, src: img ? img.getAttribute('src') : null }
}

// After a click on zoom i: the open dialogs, and the image that shows the opener's src, decoded.
async function zoomOpened(selector, i, cap) {
  const opener = document.querySelectorAll(selector)[i]
  const pic = opener && opener.querySelector('img')
  const want = pic ? pic.currentSrc || pic.src : ''
  const end = Date.now() + cap
  for (;;) {
    const open = [...document.querySelectorAll('dialog[open]')]
    const g = open.length === 1 ? open[0] : null
    const img = g && [...g.querySelectorAll('img')].find((x) => (x.currentSrc || x.src) === want)
    const seen = { open: open.length, modal: !!g && g.matches(':modal'), img: !!img, decoded: false }
    if (img && img.complete && img.naturalWidth > 0) {
      seen.decoded = await img.decode().then(() => true, () => false)
      return seen
    }
    if (Date.now() > end) return seen
    await new Promise((r) => setTimeout(r, 20))
  }
}

// Actual size: polls until zoom i's image in the open dialog draws natural width / ratio wide,
// within 1 CSS px, or cap passes. dpr and width are the authored img's, 0 when absent.
async function zoomSized(selector, i, dpr, width, cap) {
  const opener = document.querySelectorAll(selector)[i]
  const pic = opener && opener.querySelector('img')
  const want = pic ? pic.currentSrc || pic.src : ''
  const g = document.querySelector('dialog[open]')
  const img = g && [...g.querySelectorAll('img')].find((x) => (x.currentSrc || x.src) === want)
  if (!img) return { img: false }
  const nw = img.naturalWidth
  const ratio = dpr > 0 ? dpr : width > 0 ? nw / width : 1
  const how = dpr > 0 ? 'data-base-dpr' : width > 0 ? 'the width attribute' : 'neither attribute'
  const end = Date.now() + cap
  for (;;) {
    const w = img.getBoundingClientRect().width
    if (Math.abs(w - nw / ratio) <= 1 || Date.now() > end) return { img: true, nw, ratio, how, want: nw / ratio, width: w }
    await new Promise((r) => setTimeout(r, 20))
  }
}

// Polls until no dialog is open and focus is on control i of selector, or cap passes.
async function closedTo(selector, i, cap) {
  const want = document.querySelectorAll(selector)[i]
  const label = (e) => (e ? e.localName + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : '') : 'nothing')
  const end = Date.now() + cap
  for (;;) {
    const open = document.querySelectorAll('dialog[open]').length
    const a = document.activeElement
    if (!open && want && a === want) return { ok: true }
    if (Date.now() > end) return { ok: false, open, active: a === document.body ? 'body' : label(a) }
    await new Promise((r) => setTimeout(r, 20))
  }
}

// Scrolls the element the dock watches 2 px above the viewport, then polls until the dock shows
// inside the viewport and reads `k/N title` for a row whose section is in view. watch is 'nav',
// 'mast' or 'section'.
async function dockShow(rows, watch, cap) {
  const el = watch === 'nav' ? document.querySelector('[data-base-contents]') : watch === 'mast' ? document.querySelector('header.pb-mast') : document.getElementById(rows[0].id)
  if (!el) return { ok: false, why: `the page has no ${watch === 'nav' ? 'nav[data-base-contents]' : watch === 'mast' ? 'header.pb-mast' : 'section #' + rows[0].id}` }
  const root = document.scrollingElement || document.documentElement
  const y = Math.ceil(el.getBoundingClientRect().bottom + scrollY) + 2
  const max = root.scrollHeight - innerHeight
  const dock = () => document.querySelector('.plans-dock')
  const shown = (d) => !!d && !d.hidden && d.checkVisibility()
  if (y > max) return { short: true, y, max, shown: shown(dock()) }
  scrollTo(0, y)
  const end = Date.now() + cap
  for (;;) {
    const d = dock()
    let why = ''
    if (!d) why = 'the page has no .plans-dock'
    else if (!shown(d)) why = 'the dock stays hidden'
    else {
      const r = d.getBoundingClientRect()
      const text = d.textContent.replace(/\s+/g, ' ').trim()
      const k = rows.findIndex((row, n) => text.includes(`${n + 1}/${rows.length} ${row.title}`))
      const s = k === -1 ? null : document.getElementById(rows[k].id)
      const sr = s && s.getBoundingClientRect()
      if (r.height <= 0 || r.top < -0.5 || r.bottom > innerHeight + 0.5) why = `the dock is drawn at ${Math.round(r.top)}-${Math.round(r.bottom)} px, outside the ${innerHeight} px viewport`
      else if (k === -1) why = `the dock reads ${JSON.stringify(text.slice(0, 120))}, which names no section as k/${rows.length} and its title`
      else if (!sr || sr.bottom <= 0 || sr.top >= innerHeight) why = `the dock names #${rows[k].id}, which is not in view`
      else return { ok: true, y, k, text, height: r.height }
    }
    if (Date.now() > end) return { ok: false, y, why }
    await new Promise((r) => setTimeout(r, 20))
  }
}

// After a click on Sections: polls for one open dialog that is the sheet, and returns its rows.
async function sheetOpen(sheet, cap) {
  const end = Date.now() + cap
  for (;;) {
    const open = [...document.querySelectorAll('dialog[open]')]
    const g = open.length === 1 ? open[0] : null
    if ((g && g.matches(':modal')) || Date.now() > end) {
      return { open: open.length, modal: !!g && g.matches(':modal'), sheet: !!g && g.matches(sheet), hrefs: g ? [...g.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')) : [] }
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}

// The sheet as it stands, for a page whose dock can't show: whether it exists and is open, and
// its rows.
function sheetRows(sheet) {
  const g = document.querySelector(sheet)
  return { exists: !!g, open: !!g && g.open, hrefs: g ? [...g.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')) : [] }
}

// After a click on a sheet row: polls until no dialog is open and section id's top is in view
// above the dock, or cap passes.
async function jumped(id, cap) {
  const s = document.getElementById(id)
  if (!s) return { ok: false, why: `the page has no section #${id}` }
  const end = Date.now() + cap
  for (;;) {
    const open = document.querySelectorAll('dialog[open]').length
    const d = document.querySelector('.plans-dock')
    const limit = innerHeight - (d && !d.hidden && d.checkVisibility() ? d.getBoundingClientRect().height : 0)
    const top = s.getBoundingClientRect().top
    if (!open && top >= -2 && top < limit) return { ok: true, top }
    if (Date.now() > end) return { ok: false, why: open ? `${open} dialog${open === 1 ? '' : 's'} still open` : `section #${id} starts at ${Math.round(top)} px, outside 0-${Math.round(limit)} px above the dock` }
    await new Promise((r) => setTimeout(r, 20))
  }
}

// Polls until every count reads as want says, or cap passes, and returns what differs. want:
// { nav, rows: [{ id, text }], total }. nav says whether the bytes hold a contents list.
async function countsNow(want, cap) {
  const clean = (s) => s.replace(/\s+/g, ' ').trim()
  const end = Date.now() + cap
  for (;;) {
    const bad = []
    const lists = [['contents', want.nav ? document.querySelector('[data-base-contents]') : null], ['sheet', document.querySelector('dialog.plans-sheet')]]
    for (const [where, l] of lists) {
      if (where === 'contents' && !want.nav) continue
      if (!l) { bad.push(`the page has no ${where === 'sheet' ? 'dialog.plans-sheet' : 'nav[data-base-contents]'}`); continue }
      for (const r of want.rows) {
        const a = [...l.querySelectorAll('a[href]')].find((x) => x.getAttribute('href') === '#' + r.id)
        const c = a && a.querySelector('.plans-row-count')
        const got = c ? clean(c.textContent) : null
        if (!a) bad.push(`the ${where} has no row for #${r.id}`)
        else if (got !== r.text) bad.push(`the ${where} row #${r.id} reads ${got === null ? 'no count' : JSON.stringify(got)}, not "${r.text}"`)
      }
    }
    const c = document.querySelector('.plans-dock .plans-dock-count')
    const got = c ? clean(c.textContent) : null
    if (got !== want.total) bad.push(`the dock reads ${got === null ? 'no count' : JSON.stringify(got)}, not "${want.total}"`)
    if (!bad.length || Date.now() > end) return bad
    await new Promise((r) => setTimeout(r, 20))
  }
}

/* ---------------------------------------------------------------- chrome */

const fail = (detail) => ({ result: 'fail', detail })
const pass = (detail) => ({ result: 'pass', detail })

// One row named `chrome: <target>`. fn returns { result, detail }; a step failure that drive
// throws fails the row, and any other error is the checker's own and goes up. A row that doesn't
// pass closes every open dialog, so the next part starts clean.
async function step(drive, steps, target, fn) {
  let r
  try { r = await fn() } catch (e) {
    if (!drive.missed(e)) throw e
    r = fail(e.message)
  }
  steps.push({ name: `chrome: ${target}`, result: r.result, detail: r.detail })
  if (r.result !== 'pass') await drive.closeDialogs()
  return r
}

async function themeClick(drive, t, mode) {
  await drive.click({ kind: 'base', selector: THEME, index: 0 })
  const now = await drive.call(themeNow, t.names)
  const scheme = mode === 'auto' ? drive.view.scheme : mode
  const bad = t.names.filter((n) => now.values[n] !== t[scheme].get(n)).map((n) => `${n} is ${JSON.stringify(now.values[n])}, tokens.css's ${scheme} value is ${t[scheme].get(n)}`)
  if (bad.length > 3) bad.splice(3, bad.length, `and ${bad.length - 3} more of the ${t.names.length}`)
  if (mode === 'auto' && now.forced !== null) bad.unshift(`<html> still carries data-plans-theme="${now.forced}"`)
  if (mode !== 'auto' && now.scheme !== mode) bad.unshift(`color-scheme on <html> is "${now.scheme}", not "${mode}"`)
  if (bad.length) return fail(`after the click, ${bad.join('; ')}`)
  return pass(mode === 'auto'
    ? `no data-plans-theme, and the ${t.names.length} fallbacks are tokens.css's ${scheme} values, the view's scheme`
    : `the ${t.names.length} fallbacks are tokens.css's ${mode} values, and color-scheme is ${mode}`)
}

// Zoom n: made reachable, driven, then put back.
async function zoomStep(drive, z, i) {
  const n = i + 1
  const spot = await drive.call(zoomSpot, ZOOM, i)
  if (spot.missing) return fail(`the page has no ${ZOOM} at index ${i}, and the bytes hold zoomable image ${z.src}`)
  if (spot.src !== z.src) return fail(`the button holds the img ${JSON.stringify(spot.src)}, and zoomable image ${n} in the bytes is ${JSON.stringify(z.src)}`)
  const ex = await expose(drive, { selector: ZOOM, index: i })
  let r
  try { r = ex.ok ? await zoomDrive(drive, z, i) : fail(`revealing it: ${ex.hidden}`) } catch (e) {
    if (!drive.missed(e)) throw e
    r = fail(e.message)
  }
  if (!ex.changes.length) return r
  if (r.result !== 'pass') await drive.closeDialogs()
  const back = await restore(drive, ex.changes)
  return back.failed && r.result === 'pass' ? fail(`after the zoom, ${back.failed}`) : r
}

// Zoom i's dialog: open, Actual size, Close, a second open and Escape.
async function zoomDrive(drive, z, i) {
  await drive.click({ kind: 'base', selector: ZOOM, index: i })
  const o = await drive.call(zoomOpened, ZOOM, i, WAIT_MS)
  if (o.open !== 1 || !o.modal || !o.img || !o.decoded) {
    return fail(`after a click, ${o.open !== 1 ? `${o.open} dialogs are open, not 1` : !o.modal ? 'the open dialog is not modal' : !o.img ? `the open dialog shows no image with the opener's src` : 'its image did not decode'}`)
  }
  await drive.click({ kind: 'base', selector: ZOOM_SIZE, index: 0 })
  const s = await drive.call(zoomSized, ZOOM, i, z.dpr, z.width, WAIT_MS)
  if (!s.img) return fail('after Actual size, the open dialog shows no image with the opener\'s src')
  const round = (x) => Math.round(x * 100) / 100
  if (Math.abs(s.width - s.want) > 1) return fail(`actual size draws the image ${round(s.width)} px wide, not ${round(s.want)} (natural ${s.nw} over ratio ${round(s.ratio)}, from ${s.how})`)

  await drive.click({ kind: 'base', selector: ZOOM_CLOSE, index: 0 })
  const c = await drive.call(closedTo, ZOOM, i, WAIT_MS)
  if (!c.ok) return fail(`after Close, ${c.open ? `${c.open} dialog${c.open === 1 ? ' is' : 's are'} still open` : `focus is on ${c.active}, not the zoom button`}`)
  await drive.click({ kind: 'base', selector: ZOOM, index: i })
  const again = await drive.call(zoomOpened, ZOOM, i, WAIT_MS)
  if (again.open !== 1 || !again.modal) return fail(`a second click opens ${again.open} dialogs${again.open === 1 ? ', not modal' : ''}`)
  await drive.key('Escape')
  const e = await drive.call(closedTo, ZOOM, i, WAIT_MS)
  if (!e.ok) return fail(`after Escape, ${e.open ? `${e.open} dialog${e.open === 1 ? ' is' : 's are'} still open` : `focus is on ${e.active}, not the zoom button`}`)
  return pass(`actual size ${round(s.width)} px (natural ${s.nw} over ${round(s.ratio)}, from ${s.how}); Close and Escape return focus`)
}

// The sheet, from the dock: open, follow a row, then Close and Escape.
async function sheetStep(drive, p, watch) {
  const rows = p.rows
  const d = await drive.call(dockShow, rows, watch, WAIT_MS)
  const want = rows.map((r) => '#' + r.id)
  if (d.short) {
    const g = await drive.call(sheetRows, SHEET)
    if (!g.exists) return fail(`the page has no ${SHEET}`)
    if (g.open) return fail('the sheet is open before anyone opened it')
    if (g.hrefs.join(' ') !== want.join(' ')) return fail(`the sheet's rows link ${g.hrefs.join(' ') || 'nothing'}, and the bytes list ${want.join(' ')}`)
    return pass(`not opened: the page can't scroll to y ${d.y} (it ends at ${d.max}), so the dock never shows and no reader can open it; it holds the ${rows.length} rows in order`)
  }
  if (!d.ok) return fail(`the dock never showed to open it: ${d.why}`)
  await drive.click({ kind: 'base', selector: SECTIONS, index: 0 })
  const s = await drive.call(sheetOpen, SHEET, WAIT_MS)
  if (s.open !== 1 || !s.modal || !s.sheet) return fail(`after a click on Sections, ${s.open !== 1 ? `${s.open} dialogs are open, not 1` : !s.modal ? 'the open dialog is not modal' : `the open dialog is not ${SHEET}`}`)
  if (s.hrefs.join(' ') !== want.join(' ')) return fail(`the sheet's rows link ${s.hrefs.join(' ') || 'nothing'}, and the bytes list ${want.join(' ')}`)
  const t = d.k === rows.length - 1 ? 0 : rows.length - 1
  await drive.click({ kind: 'base', selector: SHEET_ROW, index: t })
  const j = await drive.call(jumped, rows[t].id, WAIT_MS)
  if (!j.ok) return fail(`after a click on row ${t + 1} (#${rows[t].id}), ${j.why}`)

  for (const how of ['Close', 'Escape']) {
    const again = await drive.call(dockShow, rows, watch, WAIT_MS)
    if (!again.ok) return fail(`before ${how}, the dock never showed again: ${again.why ?? `the page ends at ${again.max}`}`)
    await drive.click({ kind: 'base', selector: SECTIONS, index: 0 })
    const o = await drive.call(sheetOpen, SHEET, WAIT_MS)
    if (o.open !== 1 || !o.modal || !o.sheet) return fail(`a second click on Sections, for ${how}, leaves ${o.open} dialogs open${o.open === 1 ? `, ${o.modal ? 'not the sheet' : 'not modal'}` : ''}`)
    if (how === 'Close') await drive.click({ kind: 'base', selector: SHEET_CLOSE, index: 0 })
    else await drive.key('Escape')
    const c = await drive.call(closedTo, SECTIONS, 0, WAIT_MS)
    if (!c.ok) return fail(`after ${how}, ${c.open ? `${c.open} dialog${c.open === 1 ? ' is' : 's are'} still open` : `focus is on ${c.active}, not Sections`}`)
  }
  return pass(`row ${t + 1} closed the sheet and brought #${rows[t].id} into view at ${Math.round(j.top)} px; Close and Escape return focus to Sections`)
}

export async function chrome(drive) {
  const steps = []
  const p = await drive.call(plan, drive.source)
  const run = (target, fn) => step(drive, steps, target, fn)

  if (p.mast) {
    const t = fallbacks()
    for (const mode of ['light', 'dark', 'auto', 'light', 'dark']) {
      const r = await run(`theme ${mode}`, () => themeClick(drive, t, mode))
      // A click that couldn't land leaves the cycle where it was, so the rest would test nothing.
      if (r.result === 'fail' && /^(the page has no|a click at the center)/.test(r.detail)) break
    }
  }

  for (const [i, z] of p.zooms.entries()) await run(`zoom ${i + 1}`, () => zoomStep(drive, z, i))
  const made = await drive.call(count, ZOOM)
  for (let i = p.zooms.length; i < made; i++) steps.push({ name: `chrome: zoom ${i + 1}`, result: 'fail', detail: `the page made ${made} zoom buttons, and the bytes hold ${p.zooms.length} zoomable images` })

  if (p.rows.length) {
    const watch = p.nav ? 'nav' : p.mast ? 'mast' : 'section'
    await run('dock', async () => {
      const d = await drive.call(dockShow, p.rows, watch, WAIT_MS)
      if (d.short) return d.shown ? fail(`the page can't scroll its ${watch} out of view (y ${d.y}, it ends at ${d.max}), yet the dock shows`) : pass(`the page can't scroll its ${watch} out of view (y ${d.y}, it ends at ${d.max}), and the dock stays hidden`)
      return d.ok ? pass(`at y ${d.y} the dock reads ${JSON.stringify(d.text.slice(0, 120))}`) : fail(`at y ${d.y}, ${d.why}`)
    })
    await run('sheet', () => sheetStep(drive, p, watch))
  }
  return { faults: [], steps }
}

/* ---------------------------------------------------------------- counts */

// Per load: the plan, and whether counts has failed on it.
const loads = new WeakMap()

export async function counts(drive, model) {
  let memo = loads.get(drive)
  if (!memo) loads.set(drive, (memo = { plan: await drive.call(plan, drive.source), failed: false }))
  const p = memo.plan
  if (memo.failed || !model.questions.length || !p.rows.length) return null
  const ids = model.questions.map((q) => q.id)
  if (ids.join('\n') !== p.asks.join('\n')) return { name: COUNTS, result: 'unknown', detail: `the bytes hold the questions ${p.asks.join(' ')}, and the interaction's model ${ids.join(' ')}` }
  const open = model.questions.map((q) => !(q.kept || q.options.some((o) => o.checked !== o.defaultChecked)))
  const text = (k) => (k ? `${k} open` : 'answered')
  const want = {
    nav: p.nav,
    rows: p.rows.filter((r) => r.asks.length).map((r) => ({ id: r.id, text: text(r.asks.filter((k) => open[k]).length) })),
    total: text(open.filter(Boolean).length),
  }
  const answered = open.filter((x) => !x).length
  const bad = await drive.call(countsNow, want, COUNTS_MS)
  if (bad.length) {
    memo.failed = true
    return { name: COUNTS, result: 'fail', detail: `with ${answered} of ${open.length} answered, ${bad.slice(0, 3).join('; ')}${bad.length > 3 ? `; and ${bad.length - 3} more` : ''}` }
  }
  return { name: COUNTS, result: 'pass', detail: `the dock and ${want.rows.length} row${want.rows.length === 1 ? '' : 's'} match each step, the last with ${answered} of ${open.length} answered` }
}
