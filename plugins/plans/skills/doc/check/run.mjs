// The browser half of build.mjs's check: the view and state matrix, the page probes and the
// pass, fail and unknown aggregation. It loads the candidate's exact bytes from serve.mjs into
// Chromium through cdp.mjs. Node built-ins only.
//
//   runChecks({ buffer, inline, dir, media, skippedMedia, chromium, shots, tmp, deadlineMs })
//     -> Promise<{ result, reason, matrix, checks, copy, undriven }>
//     buffer        the final Buffer build.mjs will write
//     media         the src values scan.mjs declared; skippedMedia the Inline absolute paths
//     chromium      the executable findChromium found
//     shots         a directory for `<w>-<scheme>-<state>.png`, or null
//   It never throws: every failure of its own lands in an unknown result. checks holds one
//   `browser` row, then one row per interaction step and copy case, named as below, each pass,
//   fail or unknown across the views that ran it.
//
// Views. Document mode: 390x844 with mobile emulation at dsf 2, and 1440x900 at dsf 1, each in
// light and dark through Emulation.setEmulatedMedia. Inline mode: 360 (mobile, dsf 2) and 728
// (dsf 1), each at height 80 so the content height is read from scrollHeight rather than from the
// viewport, in light and dark, with sample T3 theme variables. The variables arrive through
// Page.addScriptToEvaluateOnNewDocument as a constructed stylesheet in document.adoptedStyleSheets,
// which sits outside the DOM, so the bytes under test stay those served and the html and body
// probes see only the page's own styles. Emulation.setDefaultBackgroundColorOverride paints the
// host ground behind a transparent page. Each view runs in its own browser context, created with
// Target.createBrowserContext, createTarget and attachToTarget (flatten). Runtime, Log, Network,
// Page and Inspector are enabled before navigation. The probes run in an isolated world, so page
// script that replaces a builtin cannot bend them.
//
// Settle. Page.loadEventFired, then one evaluate that awaits document.fonts.ready, every eager
// image (complete, or a load or error event), every video and audio element with a source
// (readyState 1 or more, or an error), and two requestAnimationFrame calls, capped at 10 s.
//
// States. `initial`; `details-open`, with every native <details> opened and the page settled
// again; and on a Document page with kit hooks, `interaction`, probed after the interaction
// script and the copy check below, with <details> still open. A kit page whose kit already
// logged an error gets the cell without the script, since its response is off. `undriven` lists
// every control outside the kit: a button, select, textarea, input, contenteditable or tabindex
// that no fieldset[data-ask], textarea[data-note], data-respond or data-ask-summary holds. Kit
// controls join it, marked `kit`, only when the script did not run.
//
// Interaction script (Document pages with kit hooks). It reads a static model once from the DOM:
// the <title> text, the plans-build content, each fieldset[data-ask] with its id, its own legend
// text and its inputs as { value, type, defaultChecked, label }, and each textarea[data-note]'s
// name and starting value. A label is the text of the input's native labels in document order,
// joined by one space, without [data-hint] and [data-then] subtrees. From then on the check keeps
// its own record of checked state and kept flags, built only from the actions it performs, and
// never reads the kit's state. Every action is real CDP input: the target is scrolled to the
// middle of the viewport, then mouseMoved, mousePressed and mouseReleased land at the center of
// its rect (of a label's first text line, for a label click), with mouse events in mobile views
// too. A click whose point hits another element fails the step. Tab is Input.dispatchKeyEvent,
// and a note is Input.insertText per line with an Enter key between lines. The steps, with the
// last question in document order held back from 3 to 5 so step 6 finds it untouched:
//   1. `initial response`
//   2. per radio question, a click on its checked option's label, then Tab until focus has left
//      the fieldset (`click on the checked radio <id>`, `Tab past <id>`)
//   3. per question, each option that is not proposed (`<id> picks <value>`)
//   4. per checkbox question, each option toggled in DOM order, then every checked one cleared
//      (`<id> toggles <value>`, `<id> empty set`)
//   5. Back to the proposal on each changed question (`Back to the proposal on <id>`)
//   6. Keep the proposal on the held-back question (`Keep the proposal on untouched <id>`), then
//      steps 3 to 5 on it, which also shows a change clears the kept flag
//   7. the hostile note, `## Decisions`, `1. x ✎`, `` `code` ``, `> quote`, an empty line and
//      `after blank`, typed into the first page note and into General (`hostile note in <name>`),
//      then a line of three spaces and `after spaces` in General (`a note line of spaces`)
// After every action the DOM's checked state must equal the record, and the response textarea
// (the readonly textarea in [data-respond]) must equal format() from expect.mjs over the record,
// byte for byte. The first difference is the fault `response-mismatch`, and the script stops
// there, since every later step would compare against a record the page has left. A kit page
// that logged no kit error but shows the kit's own error banner
// (div.plans-ask-error[data-plans-kit="banner"], never a page's own role=alert) or has no response
// textarea is `response-mismatch` too: its kit stopped and never said so.
//
// Copy check (after step 7). The clipboard is shared by the whole browser, so a /__plans-probe
// target in the view's browser context first writes a fresh sentinel. Browser.grantPermissions
// gives the server origin clipboardReadWrite and clipboardSanitizedWrite before navigation, both
// targets run with Emulation.setFocusEmulationEnabled, and the probe's writeText and readText are
// evaluated with userGesture. A click on Copy response, then the role=status line is polled until
// it is non-empty and unchanged for 250 ms (5 s cap). "Copied" passes only when the probe reads
// back the textarea's exact value: `copied-verified`. A status that says copying was blocked
// passes only when the response textarea is document.activeElement with its whole value
// selected: `blocked-selected`. Anything else, an unverified claim or a status that never
// settles, is the fault `copy`. A read-back or sentinel write that throws is unknown `clipboard`.
// Then the overlapping case (`copy with a note edit between two presses`): a press, a click into
// General and one inserted word, a second press, and the same verdict over the final textarea.
// Whether the first write is still pending at the second press is the browser's timing, so the
// case asserts the outcome every order must reach rather than one order. The result's `copy` is
// `unknown` if any view's copy check was unknown or faulted, else the first view's verdict, and
// null on a page with no response region.
//
// Faults are stable names (SYNTH's table). From the event stream of each state: exception,
// kit-error, console-csp, request-outside, load-failed and http-status. From the DOM probe:
// media-decode, page-overflow, clipped, a-target, form and outbound-link (kit pages), srcset,
// poster, css-url, svg-href, svg-viewbox, svg-label, svg-wide, svg-text-small (390 and 360
// only), empty-title (Document only), media-undeclared, and in Inline mode inline-height,
// inline-kit-hook and inline-frame. Chromium 155 prints no "Refused to" line for a CSP block, so
// console-csp also reads Log.entryAdded with source `security` and loadingFailed with
// blockedReason `csp`. css-url reads the declarations the CSSOM parsed, in document.styleSheets,
// document.adoptedStyleSheets and every [style], so CSS escapes arrive decoded, and it decodes
// them itself in the text the CSSOM keeps raw: custom properties and @property initial values.
// SVG attributes are read as written: an escaped external url() there is a load the sandboxed
// page refuses, so load-failed reports it. Shadow roots are not walked by any probe. In Inline
// mode the skipped absolute media paths raise no network or decode fault, since html_preview
// inlines them. An SVG that is not rendered (getScreenCTM null, or no client rects) is skipped
// by svg-wide and svg-text-small, and SVG text size is font size times the CTM's vertical scale
// times visualViewport.scale, so a page without a viewport meta that mobile emulation shrinks
// shows its real on-screen size. Console messages and exceptions inside workers are not captured.
//
// Unknown versus fail. A launch or handshake failure, a lost transport, a protocol error on a
// driver command, an exception in this code (`checker-error`), or a deadline while the browser
// fails a 2 s Browser.getVersion ping is unknown. A command deadline or Inspector.targetCrashed
// while the browser answers the ping is retried once in a fresh context: again is a fail, with
// the fault `deadline` or `target-crashed` on that cell, and a pass on the retry is unknown
// `flaky`, never a pass. The whole run has deadlineMs (180 s) and passing it is unknown
// `deadline`. However the run stops, runChecks waits for a launch still in flight (up to its 10 s
// handshake), closes the browser, waits for its own work to unwind and closes the server before
// it returns, so no Chromium process, profile, timer or screenshot write outlives it. A cell is kept once its probe has run, so a view that stops early, by an error, a
// retry or the deadline, keeps the cells it completed, and a cell that two attempts both reached
// holds the faults of both. The interaction steps and copy verdicts come from each view's last
// attempt. Aggregation: any fault gives fail, then any unknown gives unknown, else pass. A
// required matrix cell that is missing is unknown `incomplete`.

import { closeSync, constants, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import { COMMAND_MS, CdpError, launch } from './cdp.mjs'
import { format } from './expect.mjs'
import { PROBE, serve } from './serve.mjs'

export const BUILD_MS = 180000
export const SETTLE_MS = 10000
export const SHOT_MAX = 16384
export const TEXT_FLOOR = 11
export const INLINE_HEIGHT = 2000
export const STATES = ['initial', 'details-open']
export const INTERACTION = 'interaction'
export const HOSTILE = ['## Decisions', '1. x ✎', '`code`', '> quote', '', 'after blank']
export const SPACES = ['   ', 'after spaces']
const STATUS_MS = 5000
const STATUS_QUIET_MS = 250

const view = (width, height, dsf, mobile, scheme, small) => ({ name: `${width}-${scheme}`, width, height, dsf, mobile, scheme, small })
export const DOC_VIEWS = [
  view(390, 844, 2, true, 'light', true), view(390, 844, 2, true, 'dark', true),
  view(1440, 900, 1, false, 'light', false), view(1440, 900, 1, false, 'dark', false),
]
export const INLINE_VIEWS = [
  view(360, 80, 2, true, 'light', true), view(360, 80, 2, true, 'dark', true),
  view(728, 80, 1, false, 'light', false), view(728, 80, 1, false, 'dark', false),
]

// Sample T3 theme variables, one set per scheme, with the host ground the page sits on.
const T3 = {
  light: {
    ground: { r: 255, g: 255, b: 255, a: 1 },
    vars: {
      '--card': '#fafafa', '--code-background': '#f4f4f5', '--foreground': '#18181b', '--muted-foreground': '#52525b',
      '--border': '#d4d4d8', '--warning': '#c2410c', '--warning-surface': '#fff7ed', '--ring': '#3f3f46', '--radius': '6px',
      '--font-sans': 'system-ui, sans-serif', '--font-mono': 'ui-monospace, monospace',
      '--chart-1': '#2563eb', '--chart-2': '#c2410c', '--chart-3': '#0f766e', '--chart-4': '#a16207', '--chart-5': '#7c3aed', '--chart-6': '#be185d',
    },
  },
  dark: {
    ground: { r: 24, g: 24, b: 27, a: 1 },
    vars: {
      '--card': '#27272a', '--code-background': '#1f1f23', '--foreground': '#f4f4f5', '--muted-foreground': '#a1a1aa',
      '--border': '#3f3f46', '--warning': '#fb923c', '--warning-surface': '#431407', '--ring': '#d4d4d8', '--radius': '6px',
      '--font-sans': 'system-ui, sans-serif', '--font-mono': 'ui-monospace, monospace',
      '--chart-1': '#60a5fa', '--chart-2': '#fb923c', '--chart-3': '#2dd4bf', '--chart-4': '#facc15', '--chart-5': '#a78bfa', '--chart-6': '#f472b6',
    },
  },
}

const themeScript = (scheme) => {
  const css = `:root { ${Object.entries(T3[scheme].vars).map(([k, v]) => `${k}: ${v};`).join(' ')} }`
  return `(() => { const s = new CSSStyleSheet(); s.replaceSync(${JSON.stringify(css)}); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s] })()`
}

const clip = (s, n = 300) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/* ---------------------------------------------------------------- in-page code */

// Each of these is serialized with toString and run in the isolated world, so it may use only
// its own arguments and the page's DOM.

async function settle(capMs) {
  const once = (el, names, capture = false) => new Promise((r) => { for (const n of names) el.addEventListener(n, r, { once: true, capture }) })
  const waits = [document.fonts.ready]
  for (const img of document.images) {
    if (!img.complete && img.loading !== 'lazy') waits.push(once(img, ['load', 'error']))
  }
  for (const m of document.querySelectorAll('video, audio')) {
    if (m.readyState >= 1 || m.error || m.networkState === 0 || m.networkState === 3) continue
    waits.push(once(m, ['loadedmetadata', 'error'], true))
  }
  await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, capMs))])
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  return true
}

function openDetails() {
  const all = document.querySelectorAll('details')
  for (const d of all) d.open = true
  return all.length
}

function probe(cfg) {
  const faults = []
  const SVGNS = 'http://www.w3.org/2000/svg'
  const XLINK = 'http://www.w3.org/1999/xlink'
  const HOOKS = '[data-ask], [data-note], [data-ask-summary], [data-respond]'
  const desc = (el) => {
    let s = el.localName
    if (el.id) s += '#' + el.id
    const c = el.getAttribute('class')
    if (c && c.trim()) s += '.' + c.trim().split(/\s+/).join('.')
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ')
    return t ? `${s} "${t.length > 40 ? t.slice(0, 39) + '…' : t}"` : s
  }
  const add = (kind, el, detail) => faults.push({ kind, detail: el ? (detail ? `${desc(el)}: ${detail}` : desc(el)) : detail })
  const root = document.documentElement
  const body = document.body
  const kitPage = !!document.querySelector(HOOKS)
  const cw = root.clientWidth

  for (const img of document.images) {
    const src = img.getAttribute('src')
    if (src !== null && cfg.skipped.includes(src)) continue
    if (img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src)) add('media-decode', img, `${src ?? img.currentSrc} decoded to 0 px wide`)
  }
  for (const m of document.querySelectorAll('video, audio')) {
    if (m.error) add('media-decode', m, `MediaError code ${m.error.code}${m.error.message ? ` (${m.error.message})` : ''}`)
  }

  if (root.scrollWidth > root.clientWidth) add('page-overflow', null, `the root's scrollWidth ${root.scrollWidth} is over its clientWidth ${root.clientWidth}`)

  const scroller = (el) => {
    for (let a = el.parentElement; a; a = a.parentElement) {
      const o = getComputedStyle(a).overflowX
      if (o === 'auto' || o === 'scroll') return true
    }
    return false
  }
  const clipped = []
  for (const el of body ? body.querySelectorAll('*') : []) {
    if (clipped.some((p) => p.contains(el))) continue
    if (getComputedStyle(el).visibility !== 'visible') continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const left = r.left + scrollX, right = r.right + scrollX
    if (left >= -0.5 && right <= cw + 0.5) continue
    if (scroller(el)) continue
    clipped.push(el)
    add('clipped', el, `spans ${Math.round(left)} to ${Math.round(right)} px, outside 0 to ${cw} px, with no horizontal scroller around it`)
  }

  for (const a of document.querySelectorAll('a[target]')) add('a-target', a, `target="${a.getAttribute('target')}"`)
  if (kitPage) {
    for (const f of document.querySelectorAll('form')) add('form', f, 'a page that asks questions holds a <form>')
    for (const a of document.querySelectorAll('a[href], area[href]')) {
      const h = a.getAttribute('href')
      if (!h.startsWith('#')) add('outbound-link', a, `href="${h}" on a page that asks questions`)
    }
  }
  for (const el of document.querySelectorAll('[srcset]')) add('srcset', el, `srcset="${el.getAttribute('srcset')}"`)
  for (const el of document.querySelectorAll('[poster]')) add('poster', el, `poster="${el.getAttribute('poster')}"`)

  const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))/gi
  const badUrls = (text) => {
    const out = []
    for (const m of text.matchAll(URL_RE)) {
      const v = (m[1] ?? m[2] ?? m[3] ?? '').trim()
      if (!/^data:/i.test(v) && !v.startsWith('#')) out.push(v)
    }
    return out
  }
  const cssFault = (where, text) => { for (const v of badUrls(text)) add('css-url', null, `url(${v}) in ${where}`) }
  // CSS escapes decoded as the tokenizer decodes them, so u\72l( reads as url(. The CSSOM
  // serializes a parsed declaration decoded, but keeps raw text for a custom property and an
  // @property initial-value, and a raw u\72l( there still loads through var().
  const unescape = (s) => s.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f]))/g, (_, hex, ch) => {
    if (ch !== undefined) return ch
    const n = parseInt(hex, 16)
    return n === 0 || (n >= 0xd800 && n <= 0xdfff) || n > 0x10ffff ? '�' : String.fromCodePoint(n)
  })
  // Every declaration of a CSSStyleDeclaration, as the CSSOM parsed it.
  const declFaults = (where, style) => {
    for (let i = 0; i < style.length; i++) {
      const p = style.item(i)
      const v = style.getPropertyValue(p)
      cssFault(where, p.startsWith('--') ? unescape(v) : v)
    }
  }
  const walk = (rules, where) => {
    for (const r of rules) {
      if (r.type === 3) {
        if (!/^data:/i.test(r.href)) add('css-url', null, `@import ${r.href} in ${where}`)
        try { if (r.styleSheet) walk(r.styleSheet.cssRules, where) } catch {}
      }
      if (r.style) declFaults(where, r.style)
      if (typeof r.initialValue === 'string') cssFault(where, unescape(r.initialValue))
      if (r.cssRules) walk(r.cssRules, where)
    }
  }
  const sheets = [...[...document.styleSheets].map((s, i) => [s, `stylesheet ${i + 1}`]), ...[...document.adoptedStyleSheets].map((s, i) => [s, `adopted stylesheet ${i + 1}`])]
  for (const [sheet, name] of sheets) {
    const owner = sheet.ownerNode
    const where = owner ? `${desc(owner).split(' ')[0]} (${name})` : name
    // A sheet that cannot be read came from another origin, which request-outside already reports.
    let rules = null
    try { rules = sheet.cssRules } catch {}
    if (rules) walk(rules, where)
  }
  // An element outside HTML, SVG and MathML has no .style, and its style attribute styles nothing.
  for (const el of document.querySelectorAll('[style]')) if (el.style) declFaults(`${desc(el).split(' ')[0]} style=""`, el.style)

  const svgEls = [...document.querySelectorAll('svg, svg *')].filter((el) => el.namespaceURI === SVGNS)
  for (const el of svgEls) {
    for (const a of el.attributes) {
      if (a.localName === 'href' && (a.namespaceURI === null || a.namespaceURI === XLINK) && !a.value.startsWith('#')) add('svg-href', el, `${a.name}="${a.value}"`)
      if (a.name !== 'style' && /url\(/i.test(a.value)) cssFault(`<${el.localName}> ${a.name}=""`, a.value)
    }
  }

  const outer = svgEls.filter((s) => s.localName === 'svg' && !(s.parentElement && s.parentElement.closest('svg')))
  const scale = window.visualViewport ? visualViewport.scale : 1
  for (const s of outer) {
    if (!s.hasAttribute('viewBox')) add('svg-viewbox', s, 'an outermost <svg> with no viewBox')
    const titled = [...s.children].some((c) => c.localName === 'title' && c.textContent.trim() !== '')
    const label = (s.getAttribute('aria-label') || '').trim()
    if (!titled && !label && s.getAttribute('aria-hidden') !== 'true') add('svg-label', s, 'no <title>, aria-label or aria-hidden="true"')
    if (!s.getScreenCTM() || s.getClientRects().length === 0) continue
    let p = s.parentElement
    while (p && /^(inline|contents)$/.test(getComputedStyle(p).display)) p = p.parentElement
    const w = s.getBoundingClientRect().width
    if (p && w > p.clientWidth + 0.5) add('svg-wide', s, `${Math.round(w)} px wide in a ${p.clientWidth} px <${p.localName}>`)
    if (!cfg.small) continue
    for (const t of s.querySelectorAll('text, tspan, textPath')) {
      if (![...t.childNodes].some((n) => n.nodeType === 3 && n.data.trim() !== '')) continue
      const m = t.getScreenCTM()
      if (!m || t.getClientRects().length === 0) continue
      const px = parseFloat(getComputedStyle(t).fontSize) * Math.hypot(m.c, m.d) * scale
      if (px < cfg.floor - 1e-3) add('svg-text-small', t, `renders at ${px.toFixed(1)} px, under ${cfg.floor} px`)
    }
  }

  if (!cfg.inline && document.title.trim() === '') add('empty-title', null, 'document.title is empty')

  for (const el of document.querySelectorAll('img[src], video[src], audio[src], source[src]')) {
    const src = el.getAttribute('src')
    if (/^(data|blob):/i.test(src)) continue
    if (!cfg.declared.includes(src)) add('media-undeclared', el, `src="${src}" is not in the source the builder read`)
  }

  const height = root.scrollHeight
  if (cfg.inline) {
    if (height > cfg.heightMax) add('inline-height', null, `the content is ${height} px tall, over the ${cfg.heightMax} px Inline budget`)
    for (const el of document.querySelectorAll(HOOKS)) add('inline-kit-hook', el, 'Inline output never holds the question kit')
    for (const el of [root, body].filter(Boolean)) {
      const cs = getComputedStyle(el)
      if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') add('inline-frame', null, `<${el.localName}> paints background ${cs.backgroundColor}`)
      if (cs.backgroundImage !== 'none') add('inline-frame', null, `<${el.localName}> paints a background image`)
      if (parseFloat(cs.paddingLeft) || parseFloat(cs.paddingRight)) add('inline-frame', null, `<${el.localName}> has horizontal padding ${cs.paddingLeft} ${cs.paddingRight}`)
    }
  }
  return { faults, kitPage, height, width: Math.max(root.scrollWidth, cw) }
}

// Every control the matrix does not drive. The kit's own controls are listed too, marked `kit`,
// only when the interaction script did not drive them.
function controls(driven) {
  const KIT = 'fieldset[data-ask], [data-respond], [data-ask-summary], textarea[data-note]'
  const out = []
  for (const el of document.querySelectorAll('button, select, textarea, input, [contenteditable], [tabindex]')) {
    if (!el.matches('button, select, textarea, input, [tabindex]') && el.getAttribute('contenteditable') === 'false') continue
    const kit = !!el.closest(KIT)
    if (kit && driven) continue
    let s = el.localName
    if (el.id) s += '#' + el.id
    for (const a of ['type', 'name', 'value', 'tabindex', 'contenteditable']) if (el.hasAttribute(a)) s += `[${a}="${el.getAttribute(a)}"]`
    const t = (el.localName === 'button' ? el.textContent : '').trim().replace(/\s+/g, ' ')
    if (t) s += ` "${t.slice(0, 40)}"`
    out.push(kit ? `kit ${s}` : s)
  }
  return out
}

// The static model, read once per view after the kit started. Raw text only: expect.mjs
// normalizes and escapes it.
function readModel() {
  const own = (el) => {
    let s = ''
    for (const n of el.childNodes) {
      if (n.nodeType === 3) s += n.data
      else if (n.nodeType === 1 && !n.matches('[data-hint], [data-then]')) s += own(n)
    }
    return s
  }
  const titleEl = document.querySelector('title')
  const meta = document.querySelector('meta[name="plans-build"]')
  const questions = [...document.querySelectorAll('fieldset[data-ask]')].map((fs) => {
    const legend = [...fs.children].find((c) => c.localName === 'legend')
    const inputs = [...fs.querySelectorAll('input')]
    return {
      id: fs.getAttribute('data-ask'),
      legend: legend ? own(legend) : '',
      type: inputs.length ? inputs[0].type : '',
      options: inputs.map((i) => ({ value: i.getAttribute('value') ?? '', type: i.type, defaultChecked: i.defaultChecked, label: [...(i.labels ?? [])].map(own).join(' ') })),
    }
  })
  const notes = [...document.querySelectorAll('textarea[data-note]')].map((t) => ({ name: t.getAttribute('data-note'), text: t.value }))
  const respond = document.querySelector('[data-respond]')
  // The kit's own error banner, which ask.js creates and the builder refuses in authored markup.
  // A page's own role=alert is content and says nothing about the kit.
  const banner = !!document.querySelector('div.plans-ask-error[data-plans-kit="banner"]')
  const response = !!respond && !!respond.querySelector('textarea[readonly]')
  return { title: titleEl ? titleEl.textContent : '', build: meta ? meta.getAttribute('content') ?? '' : '', questions, notes, banner, response }
}

// The DOM facts each step is compared on: every option's checked, and the response textarea.
function readState() {
  const checked = [...document.querySelectorAll('fieldset[data-ask]')].map((fs) => [...fs.querySelectorAll('input')].map((i) => i.checked))
  const r = document.querySelector('[data-respond] textarea[readonly]')
  return { checked, response: r ? r.value : null }
}

// Finds one control, scrolls it to the middle of the viewport and returns the point a click
// lands on, with whether elementFromPoint there is the control or inside it.
function aim(spec) {
  const fss = document.querySelectorAll('fieldset[data-ask]')
  const input = () => fss[spec.q] && fss[spec.q].querySelectorAll('input')[spec.o]
  let el = null
  if (spec.kind === 'input') el = input()
  else if (spec.kind === 'label') el = input() && input().labels && input().labels[0]
  else if (spec.kind === 'keep') el = fss[spec.q] && fss[spec.q].querySelector('.plans-ask-keep')
  else if (spec.kind === 'note') el = document.querySelectorAll('textarea[data-note]')[spec.n]
  else if (spec.kind === 'general') el = document.querySelector('[data-respond] .plans-ask-general')
  else if (spec.kind === 'copy') el = document.querySelector('[data-respond] .plans-ask-copy')
  if (!el) return { error: `the page has no ${spec.kind} control for this step` }
  el.scrollIntoView({ block: 'center', inline: 'nearest' })
  let r = el.getBoundingClientRect()
  if (spec.kind === 'label') {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n; (n = walk.nextNode());) {
      if (n.data.trim() === '' || n.parentElement.closest('[data-hint], [data-then]')) continue
      const range = document.createRange()
      range.selectNodeContents(n)
      const first = range.getClientRects()[0]
      if (first && first.width > 0) { r = first; break }
    }
  }
  const x = r.left + r.width / 2, y = r.top + r.height / 2
  const hit = document.elementFromPoint(x, y)
  const name = (e) => e ? e.localName + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '') : 'nothing'
  return { x, y, ok: !!hit && (hit === el || el.contains(hit)), hit: name(hit), want: name(el) }
}

function focusInside(q) {
  const fs = document.querySelectorAll('fieldset[data-ask]')[q]
  return !!fs && fs.contains(document.activeElement)
}

// Polls the role=status line until it is non-empty and unchanged for quietMs, or capMs passes.
async function statusSettled(capMs, quietMs) {
  const el = document.querySelector('[data-respond] [role="status"]')
  if (!el) return { text: null }
  const end = Date.now() + capMs
  let last = el.textContent, since = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 25))
    const now = el.textContent
    if (now !== last) { last = now; since = Date.now() }
    if (now.trim() !== '' && Date.now() - since >= quietMs) return { text: now }
    if (Date.now() > end) return { text: now, late: true }
  }
}

function selectionSpans() {
  const t = document.querySelector('[data-respond] textarea[readonly]')
  return { active: !!t && document.activeElement === t, start: t ? t.selectionStart : -1, end: t ? t.selectionEnd : -1, length: t ? t.value.length : -1, value: t ? t.value : null }
}

function scrollHome() { scrollTo(0, 0); return true }

const call = (fn, ...args) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`

/* ---------------------------------------------------------------- events */

function eventFaults(origin, skipped, refused) {
  const urls = new Map()
  const skip = (url) => {
    try {
      const u = new URL(url)
      return u.origin === origin && skipped.has(decodeURIComponent(u.pathname))
    } catch { return false }
  }
  const why = (url) => {
    try {
      const u = new URL(url)
      if (u.origin !== origin) return ''
      const r = refused.get(decodeURIComponent(u.pathname).slice(1))
      return r ? ` (not served: the src ${r})` : ''
    } catch { return '' }
  }
  return (ev, add) => {
    const p = ev.params
    switch (ev.method) {
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails
        add('exception', clip(d.exception?.description ?? d.text ?? 'an uncaught exception'))
        break
      }
      case 'Runtime.consoleAPICalled': {
        const text = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
        if (text.startsWith('plans-kit:')) add('kit-error', clip(text))
        if (text.startsWith('Refused to')) add('console-csp', clip(text))
        break
      }
      case 'Log.entryAdded': {
        const e = p.entry
        if (e.source === 'security' || e.text.startsWith('Refused to')) add('console-csp', clip(e.text))
        break
      }
      case 'Network.requestWillBeSent': {
        const url = p.request.url
        urls.set(p.requestId, url)
        let ok = false
        try {
          const u = new URL(url)
          ok = u.protocol === 'data:' || u.protocol === 'blob:' || u.origin === origin
        } catch {}
        if (!ok) add('request-outside', clip(url, 200))
        break
      }
      case 'Network.responseReceived': {
        const r = p.response
        if (r.status >= 400 && !skip(r.url)) add('http-status', clip(`${r.url.startsWith(origin) ? r.url.slice(origin.length) : r.url} answered ${r.status}${why(r.url)}`))
        break
      }
      case 'Network.loadingFailed': {
        const url = urls.get(p.requestId) ?? '(unknown URL)'
        if (p.blockedReason === 'csp') add('console-csp', clip(`${url} was blocked by the CSP`, 200))
        if (!p.canceled && !skip(url)) add('load-failed', clip(`${url.startsWith(origin) ? url.slice(origin.length) : url}: ${p.errorText || p.blockedReason || 'failed'}`))
        break
      }
    }
  }
}

/* ---------------------------------------------------------------- interaction */

// The first line where two strings part, for a mismatch detail.
function firstDiff(want, got) {
  const a = want.split('\n'), b = got.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}: expected ${JSON.stringify(a[i] ?? '(end)')}, the page has ${JSON.stringify(b[i] ?? '(end)')}`
  }
  return 'the strings differ'
}

class Mismatch extends Error {}

// A /__plans-probe target in the view's browser context, for clipboard read-back. It holds no
// page script, so the evaluations below run in a document nothing on the candidate can reach.
async function clipboardProbe(browser, browserContextId, origin, stopped) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params = {}) => browser.send(method, params, sessionId)
  let resolveLoad
  const loaded = new Promise((r) => { resolveLoad = r })
  const listener = (m) => { if (m.method === 'Page.loadEventFired') resolveLoad() }
  browser.on(sessionId, listener)
  try {
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const nav = await send('Page.navigate', { url: origin + PROBE })
    if (nav.errorText) throw new CdpError('protocol', `Page.navigate to ${PROBE} failed: ${nav.errorText}`)
    let timer
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new CdpError('timeout', `${PROBE} did not load within ${COMMAND_MS} ms`)), COMMAND_MS) })
    await Promise.race([loaded, late, stopped]).finally(() => clearTimeout(timer))
  } finally {
    browser.off(sessionId, listener)
  }
  // Returns { ok, value } or { ok: false, error } when the page call threw.
  const probeEval = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) return { ok: false, error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
    return { ok: true, value: r.result.value }
  }
  return {
    write: (text) => probeEval(`navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => true)`),
    read: () => probeEval('navigator.clipboard.readText()'),
    close: () => browser.send('Target.closeTarget', { targetId }).catch(() => {}),
  }
}

// Runs the interaction script and the copy check in one view. io: { send, evaluate, browser,
// browserContextId, origin, stopped }. Records steps in rec.steps, copy verdicts in rec.copies and
// clipboard unknowns in rec.unknowns, and returns the faults for the interaction cell.
async function interact(io, rec, viewName) {
  const { send, evaluate } = io
  const faults = []
  const s = await evaluate(call(readModel))
  // runView skips this script when the kit logged an error, so a page that reaches here with the
  // kit's banner, or without a filled response region, has a kit that stopped and never said so.
  if (s.banner || !s.response) {
    const detail = s.banner
      ? 'initial response: the page shows the kit\'s error banner, but no kit error was logged'
      : 'initial response: the page has kit hooks, but no kit error was logged and the response region holds no response textarea'
    rec.steps.push({ name: 'initial response', result: 'fail', detail, view: viewName })
    rec.copies.push('unknown')
    return { faults: [{ kind: 'response-mismatch', detail }], driven: false }
  }
  const model = {
    title: s.title, build: s.build,
    questions: s.questions.map((q) => ({ id: q.id, legend: q.legend, type: q.type, kept: false, options: q.options.map((o) => ({ value: o.value, label: o.label, defaultChecked: o.defaultChecked, checked: o.defaultChecked })) })),
    notes: [...s.notes.map((n) => ({ name: n.name, text: n.text })), { name: 'General', text: '' }],
  }
  const general = model.notes[model.notes.length - 1]
  const step = (name, result, detail = '') => rec.steps.push({ name, result, detail, view: viewName })
  let current = 'initial response'

  const mouse = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
  const click = async (spec, name) => {
    const a = await evaluate(call(aim, spec))
    if (a.error) throw new Mismatch(`${name}: ${a.error}`)
    if (!a.ok) throw new Mismatch(`${name}: a click at the center of ${a.want} (${Math.round(a.x)}, ${Math.round(a.y)}) lands on ${a.hit}`)
    await mouse(a.x, a.y)
  }
  const key = async (k, code, vk, text) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  }
  const verify = async (name) => {
    const got = await evaluate(call(readState))
    for (const [qi, q] of model.questions.entries()) {
      for (const [oi, o] of q.options.entries()) {
        if (got.checked[qi]?.[oi] !== o.checked) throw new Mismatch(`${name}: option ${o.value} of question ${q.id} is ${got.checked[qi]?.[oi] ? '' : 'not '}checked in the DOM, but the check's record says ${o.checked ? 'checked' : 'unchecked'}`)
      }
    }
    const want = format(model)
    if (got.response === null) throw new Mismatch(`${name}: the page has no response textarea`)
    if (got.response !== want) throw new Mismatch(`${name}: the response differs from the independent formatter, ${firstDiff(want, got.response)}`)
  }
  const run = async (name, act) => {
    current = name
    await act()
    await verify(name)
    step(name, 'pass')
  }

  const pickOption = (q, o) => async () => {
    await click({ kind: 'input', q: model.questions.indexOf(q), o: q.options.indexOf(o) }, `${q.id} ${o.value}`)
    if (q.type === 'radio') {
      if (o.checked) return
      for (const x of q.options) x.checked = x === o
    } else o.checked = !o.checked
    q.kept = false
  }
  const changed = (q) => q.options.some((o) => o.checked !== o.defaultChecked)
  const keep = (q) => async () => {
    await click({ kind: 'keep', q: model.questions.indexOf(q) }, `the proposal button of ${q.id}`)
    for (const o of q.options) o.checked = o.defaultChecked
    q.kept = true
  }
  const exercise = async (qs) => {
    for (const q of qs) for (const o of q.options) if (!o.defaultChecked) await run(`${q.id} picks ${o.value}`, pickOption(q, o))
    for (const q of qs) {
      if (q.type !== 'checkbox') continue
      for (const o of q.options) await run(`${q.id} toggles ${o.value}`, pickOption(q, o))
      for (const o of q.options) if (o.checked) await run(`${q.id} empty set`, pickOption(q, o))
      if (!q.options.some((o) => o.checked)) step(`${q.id} empty set`, 'pass')
    }
    for (const q of qs) if (changed(q)) await run(`Back to the proposal on ${q.id}`, keep(q))
  }
  // A click into a textarea puts the caret under the pointer, so Ctrl+End moves it to the end.
  const focusEnd = async (spec, name) => {
    await click(spec, name)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  }
  const typeLines = async (spec, note, lines, name) => {
    current = name
    await focusEnd(spec, name)
    for (const [i, line] of lines.entries()) {
      if (i > 0 || note.text !== '') {
        await key('Enter', 'Enter', 13, '\r')
        note.text += '\n'
        await verify(`${name}, Enter`)
      }
      if (line !== '') {
        await send('Input.insertText', { text: line })
        note.text += line
        await verify(`${name}, ${JSON.stringify(line)}`)
      }
    }
    step(name, 'pass')
  }

  try {
    await verify('initial response')
    step('initial response', 'pass')
    for (const [qi, q] of model.questions.entries()) {
      if (q.type !== 'radio') continue
      const o = q.options.find((x) => x.defaultChecked)
      if (!o) continue
      await run(`click on the checked radio ${q.id}`, () => click({ kind: 'label', q: qi, o: q.options.indexOf(o) }, `the label of ${q.id} ${o.value}`))
      // The label click leaves focus on the radio, so the Tab presses go into and then past it.
      const cap = q.options.length + 4
      let tabs = 0
      current = `Tab past ${q.id}`
      if (!(await evaluate(call(focusInside, qi)))) throw new Mismatch(`Tab past ${q.id}: the click on the checked label left focus outside the question`)
      while (tabs < cap && (await evaluate(call(focusInside, qi)))) { await key('Tab', 'Tab', 9); tabs++ }
      if (await evaluate(call(focusInside, qi))) throw new Mismatch(`Tab past ${q.id}: focus is still inside the question after ${cap} Tab presses`)
      await verify(`Tab past ${q.id}`)
      step(`Tab past ${q.id}`, 'pass', `${tabs} Tab presses`)
    }
    const held = model.questions[model.questions.length - 1]
    await exercise(model.questions.slice(0, -1))
    if (held) {
      await run(`Keep the proposal on untouched ${held.id}`, keep(held))
      await exercise([held])
    }
    const firstNote = s.notes.length ? model.notes[0] : null
    if (firstNote) await typeLines({ kind: 'note', n: 0 }, firstNote, HOSTILE, `hostile note in ${firstNote.name}`)
    await typeLines({ kind: 'general' }, general, HOSTILE, 'hostile note in General')
    await typeLines({ kind: 'general' }, general, SPACES, 'a note line of spaces')
  } catch (e) {
    if (!(e instanceof Mismatch)) throw e
    step(current, 'fail', e.message)
    faults.push({ kind: 'response-mismatch', detail: e.message })
    rec.copies.push('unknown')
    return { faults, driven: true }
  }

  // The copy check, single press then the overlapping case.
  const probe = await clipboardProbe(io.browser, io.browserContextId, io.origin, io.stopped)
  try {
    const verdict = async (name, press) => {
      const sentinel = `plans-check sentinel ${Math.random().toString(36).slice(2)}`
      const w = await probe.write(sentinel)
      if (!w.ok) return { unknown: `${name}: the probe could not write the clipboard (${clip(w.error, 200)})` }
      await press()
      const st = await evaluate(call(statusSettled, STATUS_MS, STATUS_QUIET_MS))
      if (st.text === null) return { fault: `${name}: the response region has no role=status line` }
      const text = st.text.trim()
      if (st.late) return { fault: `${name}: the status line did not settle within ${STATUS_MS} ms (it reads ${JSON.stringify(clip(text, 80))})` }
      if (text === 'Copied') {
        const sel = await evaluate(call(selectionSpans))
        const r = await probe.read()
        if (!r.ok) return { unknown: `${name}: the clipboard read-back threw (${clip(r.error, 200)})` }
        if (r.value === sel.value) return { pass: 'copied-verified' }
        return { fault: `${name}: the page says "Copied", but the clipboard holds ${r.value === sentinel ? 'the check\'s sentinel, so nothing was copied' : JSON.stringify(clip(r.value, 80))}` }
      }
      if (/blocked/i.test(text)) {
        const sel = await evaluate(call(selectionSpans))
        if (sel.active && sel.start === 0 && sel.end === sel.length) return { pass: 'blocked-selected' }
        return { fault: `${name}: the page says copying was blocked, but ${sel.active ? `the selection is ${sel.start} to ${sel.end} of ${sel.length}` : 'the response textarea does not have focus'}` }
      }
      return { fault: `${name}: after the press the status line reads ${JSON.stringify(clip(text, 120))}` }
    }
    const pressCopy = () => click({ kind: 'copy' }, 'Copy response')
    const cases = [
      ['copy after one press', pressCopy],
      ['copy with a note edit between two presses', async () => {
        await pressCopy()
        await focusEnd({ kind: 'general' }, 'the General note')
        await send('Input.insertText', { text: ' edited' })
        general.text += ' edited'
        await pressCopy()
      }],
    ]
    for (const [name, press] of cases) {
      let v
      try {
        v = await verdict(name, press)
        if (!v.unknown) await verify(name)
      } catch (e) {
        if (!(e instanceof Mismatch)) throw e
        step(name, 'fail', e.message)
        faults.push({ kind: 'response-mismatch', detail: e.message })
        rec.copies.push('unknown')
        break
      }
      if (v.pass) { step(name, 'pass', v.pass); rec.copies.push(v.pass) }
      else if (v.unknown) { step(name, 'unknown', v.unknown); rec.unknowns.push({ kind: 'clipboard', detail: `${viewName}: ${v.unknown}` }); rec.copies.push('unknown') }
      else { step(name, 'fail', v.fault); faults.push({ kind: 'copy', detail: v.fault }); rec.copies.push('unknown') }
    }
  } finally {
    await probe.close()
  }
  return { faults, driven: true }
}

/* ---------------------------------------------------------------- shots */

function writeShot(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644)
  try { for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off) } finally { closeSync(fd) }
}

/* ---------------------------------------------------------------- one view */

// One view. rec: { cells, steps, copies, unknowns }, filled as the view runs, so a retry starts
// from a fresh one.
async function runView(browser, ctx, v, rec) {
  const { browserContextId } = await browser.send('Target.createBrowserContext', { disposeOnDetach: true })
  try {
    if (!ctx.inline) await browser.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: ctx.origin, browserContextId })
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
    const events = []
    const waiters = []
    let crash
    const crashed = new Promise((_, reject) => { crash = reject })
    crashed.catch(() => {})
    const listener = (m) => {
      events.push(m)
      if (m.method === 'Inspector.targetCrashed') crash(new CdpError('crashed', 'the page crashed (Inspector.targetCrashed)'))
      for (const w of [...waiters]) if (w.method === m.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m) }
    }
    browser.on(sessionId, listener)
    const send = (method, params = {}) => Promise.race([browser.send(method, params, sessionId), crashed])
    const waitFor = (method) => {
      let timer
      const got = new Promise((resolve) => waiters.push({ method, resolve }))
      const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new CdpError('timeout', `${method} did not arrive within ${COMMAND_MS} ms`)), COMMAND_MS) })
      return Promise.race([got, late, crashed, ctx.stopped]).finally(() => clearTimeout(timer))
    }
    let world = null
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, contextId: world, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(`a page probe threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
      return r.result.value
    }
    try {
      for (const d of ['Runtime', 'Log', 'Network', 'Page', 'Inspector']) await send(`${d}.enable`)
      await send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dsf, mobile: v.mobile })
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v.scheme }] })
      if (ctx.inline) {
        await send('Page.addScriptToEvaluateOnNewDocument', { source: themeScript(v.scheme) })
        await send('Emulation.setDefaultBackgroundColorOverride', { color: T3[v.scheme].ground })
      } else {
        await send('Emulation.setFocusEmulationEnabled', { enabled: true })
      }
      const loaded = waitFor('Page.loadEventFired')
      // Awaited below; marked handled now so a navigation that throws leaves no stray rejection.
      loaded.catch(() => {})
      const nav = await send('Page.navigate', { url: ctx.url })
      if (nav.errorText) throw new CdpError('protocol', `Page.navigate to the viewer double failed: ${nav.errorText}`)
      await loaded
      ;({ executionContextId: world } = await send('Page.createIsolatedWorld', { frameId: nav.frameId, worldName: 'plans-check' }))
      await evaluate(call(settle, SETTLE_MS))

      const add = eventFaults(ctx.origin, ctx.skipped, ctx.refused)
      let seen = 0
      let kitPage = false
      let driven = false
      for (const state of [...STATES, INTERACTION]) {
        const faults = []
        const push = (kind, detail) => faults.push({ kind, detail })
        if (state === 'details-open') {
          await evaluate(call(openDetails))
          await evaluate(call(settle, SETTLE_MS))
        }
        if (state === INTERACTION) {
          if (ctx.inline || !kitPage) break
          ctx.kitDoc = true
          // A kit that already logged an error has turned its response off: nothing to drive.
          const kitFailed = rec.cells.some((c) => c.view === v.name && c.faults.some((f) => f.kind === 'kit-error'))
          if (!kitFailed) {
            const got = await interact({ send, evaluate, browser, browserContextId, origin: ctx.origin, stopped: ctx.stopped }, rec, v.name)
            faults.push(...got.faults)
            driven = got.driven
          }
          await evaluate(call(scrollHome))
          await evaluate(call(settle, SETTLE_MS))
        }
        const got = await evaluate(call(probe, { inline: ctx.inline, small: v.small, floor: TEXT_FLOOR, heightMax: INLINE_HEIGHT, declared: ctx.declared, skipped: ctx.skippedList }))
        if (state === 'initial') kitPage = got.kitPage
        for (; seen < events.length; seen++) add(events[seen], push)
        faults.push(...got.faults)
        if (ctx.shots) {
          const w = Math.min(Math.ceil(got.width), Math.floor(SHOT_MAX / v.dsf))
          const h = Math.min(Math.ceil(got.height), Math.floor(SHOT_MAX / v.dsf))
          const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } })
          writeShot(join(ctx.shots, `${v.width}-${v.scheme}-${state}.png`), Buffer.from(data, 'base64'))
        }
        const unique = new Map()
        for (const f of faults) unique.set(`${f.kind}\0${f.detail}`, f)
        rec.cells.push({ view: v.name, state, faults: [...unique.values()] })
      }
      if (ctx.undriven === null) ctx.undriven = await evaluate(call(controls, driven))
    } finally {
      browser.off(sessionId, listener)
    }
  } finally {
    try { await browser.send('Target.disposeBrowserContext', { browserContextId }, undefined, { timeout: 5000 }) } catch {}
  }
}

const hang = (e) => e instanceof CdpError && (e.kind === 'timeout' || e.kind === 'crashed')

// One view with the retry rule. Each attempt's record joins recs before it runs, so runChecks
// sees the cells it completed even when the attempt, or the whole run, stops early. Returns
// { flaky } or throws for an unknown.
const freshRec = () => ({ cells: [], steps: [], copies: [], unknowns: [] })
async function viewWithRetry(browser, ctx, v, recs) {
  const attempt = () => { const r = freshRec(); recs.push(r); return r }
  try {
    await runView(browser, ctx, v, attempt())
    return { flaky: null }
  } catch (e) {
    if (!hang(e)) throw e
    if (!(await browser.ping())) throw new CdpError('deadline', `${v.name}: ${e.message}, and the browser stopped answering`)
    const again = attempt()
    try {
      await runView(browser, ctx, v, again)
      return { flaky: `${v.name}: ${e.message} once, then passed on a retry` }
    } catch (e2) {
      if (!hang(e2)) throw e2
      if (!(await browser.ping())) throw new CdpError('deadline', `${v.name}: ${e2.message}, and the browser stopped answering`)
      const all = [...STATES, INTERACTION]
      const state = all[again.cells.length] ?? all[all.length - 1]
      again.cells.push({ view: v.name, state, faults: [{ kind: e2.kind === 'crashed' ? 'target-crashed' : 'deadline', detail: `${e2.message}, twice, in a browser that still answers` }] })
      return { flaky: null }
    }
  }
}

// The matrix from every attempt of every view: one cell per view and state, in the order first
// reached, holding each distinct fault any attempt saw there.
function mergeCells(recsPerView) {
  const cells = new Map()
  for (const recs of recsPerView) {
    for (const rec of recs) {
      for (const c of rec.cells) {
        const key = `${c.view}/${c.state}`
        if (!cells.has(key)) cells.set(key, { view: c.view, state: c.state, faults: new Map() })
        for (const f of c.faults) cells.get(key).faults.set(`${f.kind}\0${f.detail}`, f)
      }
    }
  }
  return [...cells.values()].map((c) => ({ view: c.view, state: c.state, faults: [...c.faults.values()] }))
}

const unknownOf = (e) => {
  if (e instanceof CdpError) return { kind: e.kind === 'timeout' ? 'deadline' : e.kind, detail: e.message }
  return { kind: 'checker-error', detail: clip(e?.stack ?? String(e), 600) }
}

export async function runChecks({ buffer, inline = false, dir, media = [], skippedMedia = [], chromium, shots = null, tmp, deadlineMs = BUILD_MS }) {
  const views = inline ? INLINE_VIEWS : DOC_VIEWS
  const out = { result: 'unknown', reason: null, matrix: [], checks: [], copy: null, undriven: [] }
  const unknowns = []
  let timer, stop
  // One { recs, flaky } per view, with every attempt's record, filled as the views run and read
  // after the run stops.
  const runs = []
  // The server and the browser are owned as promises from the moment they are asked for, so the
  // cleanup below reaches one that is still starting. stopped rejects when the run stops, which
  // ends every wait of the work that no CDP reply ends, and halted keeps it from starting more.
  let serving = null, launching = null, halted = false
  const ctx = {
    inline, shots, undriven: null, kitDoc: false,
    declared: [...new Set(media.map((m) => (typeof m === 'string' ? m : m.src)))],
    skippedList: [...skippedMedia], skipped: new Set(skippedMedia),
    stopped: new Promise((_, reject) => { stop = reject }),
  }
  ctx.stopped.catch(() => {})
  const work = (async () => {
    if (shots) mkdirSync(shots, { recursive: true })
    serving = serve({ html: buffer, dir, media: ctx.declared, skipped: ctx.skippedList })
    const server = await serving
    ctx.url = server.url
    ctx.origin = server.origin
    ctx.refused = new Map(server.refused.map((r) => [r.src, r.reason]))
    if (halted) return
    launching = launch(chromium, { tmp })
    const browser = await launching
    for (const v of views) {
      if (halted) return
      const run = { recs: [], flaky: null }
      runs.push(run)
      run.flaky = (await viewWithRetry(browser, ctx, v, run.recs)).flaky
    }
  })()
  work.catch(() => {})
  const owned = async (p) => { try { return p ? await p : null } catch { return null } }
  try {
    await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new CdpError('deadline', `the browser check passed its ${deadlineMs} ms deadline`)), deadlineMs) })])
  } catch (e) {
    unknowns.push(unknownOf(e))
  } finally {
    // Stop the work, close the browser (a launch in flight is waited for, up to its handshake),
    // wait for the work to unwind, then close the server. Nothing the run started outlives it.
    clearTimeout(timer)
    halted = true
    stop(new CdpError('deadline', 'the browser check stopped'))
    const browser = await owned(launching)
    try { if (browser) await browser.close() } catch (e) { unknowns.push(unknownOf(e)) }
    await work.catch(() => {})
    const server = await owned(serving)
    try { if (server) await server.close() } catch (e) { unknowns.push(unknownOf(e)) }
  }

  out.undriven = ctx.undriven ?? []
  out.matrix = mergeCells(runs.map((r) => r.recs))
  const last = runs.map((r) => r.recs.at(-1) ?? freshRec())
  const steps = last.flatMap((r) => r.steps)
  const copies = last.flatMap((r) => r.copies)
  // Each view's own unknowns, then its flaky retry, in view order, and the run's own error last.
  unknowns.unshift(...runs.flatMap((r, i) => [...last[i].unknowns, ...(r.flaky ? [{ kind: 'flaky', detail: r.flaky }] : [])]))
  const have = new Set(out.matrix.map((c) => `${c.view}/${c.state}`))
  const required = ctx.kitDoc ? [...STATES, INTERACTION] : STATES
  const missing = views.flatMap((v) => required.map((s) => `${v.name}/${s}`)).filter((k) => !have.has(k))
  if (missing.length && !unknowns.length) unknowns.push({ kind: 'incomplete', detail: `matrix cells not checked: ${missing.join(', ')}` })
  const faults = out.matrix.flatMap((c) => c.faults)
  if (faults.length) {
    out.result = 'fail'
    out.reason = { kind: faults[0].kind, detail: faults[0].detail }
  } else if (unknowns.length) {
    out.result = 'unknown'
    out.reason = unknowns[0]
  } else {
    out.result = 'pass'
  }
  const cells = out.matrix.length
  out.checks.push({
    name: 'browser',
    result: out.result,
    detail: out.result === 'pass' ? `${cells} cells, no faults` : out.result === 'fail' ? `${faults.length} faults in ${cells} cells` : `${out.reason.kind}: ${out.reason.detail}`,
  })
  for (const u of unknowns.slice(out.result === 'unknown' ? 1 : 0)) out.checks.push({ name: 'browser', result: 'unknown', detail: `${u.kind}: ${u.detail}` })
  // One row per step name across the views: fail if any view failed it, then unknown, else pass.
  const byName = new Map()
  for (const st of steps) {
    if (!byName.has(st.name)) byName.set(st.name, [])
    byName.get(st.name).push(st)
  }
  for (const [name, list] of byName) {
    const worst = list.find((x) => x.result === 'fail') ?? list.find((x) => x.result === 'unknown') ?? list[0]
    const detail = worst.result === 'pass' ? `${list.map((x) => x.view).join(', ')}${worst.detail ? `: ${worst.detail}` : ''}` : `${worst.view}: ${worst.detail}`
    out.checks.push({ name: `interaction: ${name}`, result: worst.result, detail })
  }
  if (copies.length) out.copy = copies.includes('unknown') ? 'unknown' : copies[0]
  return out
}
