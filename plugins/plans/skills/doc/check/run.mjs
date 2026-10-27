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
//   It never throws: every failure of its own lands in an unknown result.
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
// again. The interaction state for Document pages with kit hooks is not driven yet, so on those
// pages every kit control is listed in `undriven` beside the controls outside the kit.
//
// Faults are stable names (SYNTH's table). From the event stream of each state: exception,
// kit-error, console-csp, request-outside, load-failed and http-status. From the DOM probe:
// media-decode, page-overflow, clipped, a-target, form and outbound-link (kit pages), srcset,
// poster, css-url, svg-href, svg-viewbox, svg-label, svg-wide, svg-text-small (390 and 360
// only), empty-title (Document only), media-undeclared, and in Inline mode inline-height,
// inline-kit-hook and inline-frame. Chromium 155 prints no "Refused to" line for a CSP block, so
// console-csp also reads Log.entryAdded with source `security` and loadingFailed with
// blockedReason `csp`. In Inline mode the skipped absolute media paths raise no network or decode
// fault, since html_preview inlines them. An SVG that is not rendered (getScreenCTM null, or no
// client rects) is skipped by svg-wide and svg-text-small, and SVG text size is font size times
// the CTM's vertical scale times visualViewport.scale, so a page without a viewport meta that
// mobile emulation shrinks shows its real on-screen size. Console messages and exceptions inside
// workers are not captured.
//
// Unknown versus fail. A launch or handshake failure, a lost transport, a protocol error on a
// driver command, an exception in this code (`checker-error`), or a deadline while the browser
// fails a 2 s Browser.getVersion ping is unknown. A command deadline or Inspector.targetCrashed
// while the browser answers the ping is retried once in a fresh context: again is a fail, with
// the fault `deadline` or `target-crashed` on that cell, and a pass on the retry is unknown
// `flaky`, never a pass. The whole run has deadlineMs (180 s) and passing it is unknown
// `deadline`. Aggregation: any fault gives fail, then any unknown gives unknown, else pass. A
// required matrix cell that is missing is unknown `incomplete`.

import { closeSync, constants, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import { COMMAND_MS, CdpError, launch } from './cdp.mjs'
import { serve } from './serve.mjs'

export const BUILD_MS = 180000
export const SETTLE_MS = 10000
export const SHOT_MAX = 16384
export const TEXT_FLOOR = 11
export const INLINE_HEIGHT = 2000
export const STATES = ['initial', 'details-open']

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
  const walk = (rules, where) => {
    for (const r of rules) {
      if (r.type === 3) {
        if (!/^data:/i.test(r.href)) add('css-url', null, `@import ${r.href} in ${where}`)
        try { if (r.styleSheet) walk(r.styleSheet.cssRules, where) } catch {}
      }
      if (r.style) cssFault(where, r.style.cssText)
      if (r.cssRules) walk(r.cssRules, where)
    }
  }
  for (const [i, sheet] of [...document.styleSheets].entries()) {
    const owner = sheet.ownerNode
    const where = owner ? `${desc(owner).split(' ')[0]} (stylesheet ${i + 1})` : `stylesheet ${i + 1}`
    // A sheet that cannot be read came from another origin, which request-outside already reports.
    let rules = null
    try { rules = sheet.cssRules } catch {}
    if (rules) walk(rules, where)
  }
  for (const el of document.querySelectorAll('[style]')) cssFault(`${desc(el).split(' ')[0]} style=""`, el.getAttribute('style'))

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

// Every control the matrix does not drive. On a page with kit hooks the kit's own controls are
// listed too, marked `kit`, until the interaction script drives them.
function controls() {
  const KIT = 'fieldset[data-ask], [data-respond], [data-ask-summary], textarea[data-note]'
  const out = []
  for (const el of document.querySelectorAll('button, select, textarea, input, [contenteditable], [tabindex]')) {
    if (!el.matches('button, select, textarea, input, [tabindex]') && el.getAttribute('contenteditable') === 'false') continue
    let s = el.localName
    if (el.id) s += '#' + el.id
    for (const a of ['type', 'name', 'value', 'tabindex', 'contenteditable']) if (el.hasAttribute(a)) s += `[${a}="${el.getAttribute(a)}"]`
    const t = (el.localName === 'button' ? el.textContent : '').trim().replace(/\s+/g, ' ')
    if (t) s += ` "${t.slice(0, 40)}"`
    out.push(el.closest(KIT) ? `kit ${s}` : s)
  }
  return out
}

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

/* ---------------------------------------------------------------- shots */

function writeShot(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644)
  try { for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off) } finally { closeSync(fd) }
}

/* ---------------------------------------------------------------- one view */

async function runView(browser, ctx, v, done) {
  const { browserContextId } = await browser.send('Target.createBrowserContext', { disposeOnDetach: true })
  try {
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
      return Promise.race([got, late, crashed]).finally(() => clearTimeout(timer))
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
      }
      const loaded = waitFor('Page.loadEventFired')
      const nav = await send('Page.navigate', { url: ctx.url })
      if (nav.errorText) throw new CdpError('protocol', `Page.navigate to the viewer double failed: ${nav.errorText}`)
      await loaded
      ;({ executionContextId: world } = await send('Page.createIsolatedWorld', { frameId: nav.frameId, worldName: 'plans-check' }))
      await evaluate(call(settle, SETTLE_MS))

      const add = eventFaults(ctx.origin, ctx.skipped, ctx.refused)
      let seen = 0
      for (const state of STATES) {
        if (state === 'details-open') {
          await evaluate(call(openDetails))
          await evaluate(call(settle, SETTLE_MS))
        }
        const got = await evaluate(call(probe, { inline: ctx.inline, small: v.small, floor: TEXT_FLOOR, heightMax: INLINE_HEIGHT, declared: ctx.declared, skipped: ctx.skippedList }))
        const faults = []
        const push = (kind, detail) => faults.push({ kind, detail })
        for (; seen < events.length; seen++) add(events[seen], push)
        faults.push(...got.faults)
        if (ctx.undriven === null) ctx.undriven = await evaluate(call(controls))
        if (ctx.shots) {
          const w = Math.min(Math.ceil(got.width), Math.floor(SHOT_MAX / v.dsf))
          const h = Math.min(Math.ceil(got.height), Math.floor(SHOT_MAX / v.dsf))
          const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } })
          writeShot(join(ctx.shots, `${v.width}-${v.scheme}-${state}.png`), Buffer.from(data, 'base64'))
        }
        const unique = new Map()
        for (const f of faults) unique.set(`${f.kind}\0${f.detail}`, f)
        done.push({ view: v.name, state, faults: [...unique.values()] })
      }
    } finally {
      browser.off(sessionId, listener)
    }
  } finally {
    try { await browser.send('Target.disposeBrowserContext', { browserContextId }, undefined, { timeout: 5000 }) } catch {}
  }
}

const hang = (e) => e instanceof CdpError && (e.kind === 'timeout' || e.kind === 'crashed')

// One view with the retry rule. Returns { cells, flaky } or throws for an unknown.
async function viewWithRetry(browser, ctx, v) {
  const first = []
  try {
    await runView(browser, ctx, v, first)
    return { cells: first, flaky: null }
  } catch (e) {
    if (!hang(e)) throw e
    if (!(await browser.ping())) throw new CdpError('deadline', `${v.name}: ${e.message}, and the browser stopped answering`)
    const again = []
    try {
      await runView(browser, ctx, v, again)
      return { cells: again, flaky: `${v.name}: ${e.message} once, then passed on a retry` }
    } catch (e2) {
      if (!hang(e2)) throw e2
      if (!(await browser.ping())) throw new CdpError('deadline', `${v.name}: ${e2.message}, and the browser stopped answering`)
      const state = STATES[again.length] ?? STATES[STATES.length - 1]
      again.push({ view: v.name, state, faults: [{ kind: e2.kind === 'crashed' ? 'target-crashed' : 'deadline', detail: `${e2.message}, twice, in a browser that still answers` }] })
      return { cells: again, flaky: null }
    }
  }
}

const unknownOf = (e) => {
  if (e instanceof CdpError) return { kind: e.kind === 'timeout' ? 'deadline' : e.kind, detail: e.message }
  return { kind: 'checker-error', detail: clip(e?.stack ?? String(e), 600) }
}

export async function runChecks({ buffer, inline = false, dir, media = [], skippedMedia = [], chromium, shots = null, tmp, deadlineMs = BUILD_MS }) {
  const views = inline ? INLINE_VIEWS : DOC_VIEWS
  const out = { result: 'unknown', reason: null, matrix: [], checks: [], copy: null, undriven: [] }
  const unknowns = []
  let server = null, browser = null, timer
  const ctx = {
    inline, shots, undriven: null,
    declared: [...new Set(media.map((m) => (typeof m === 'string' ? m : m.src)))],
    skippedList: [...skippedMedia], skipped: new Set(skippedMedia),
  }
  const work = (async () => {
    if (shots) mkdirSync(shots, { recursive: true })
    server = await serve({ html: buffer, dir, media: ctx.declared, skipped: ctx.skippedList })
    ctx.url = server.url
    ctx.origin = server.origin
    ctx.refused = new Map(server.refused.map((r) => [r.src, r.reason]))
    browser = await launch(chromium, { tmp })
    for (const v of views) {
      const { cells, flaky } = await viewWithRetry(browser, ctx, v)
      out.matrix.push(...cells)
      if (flaky) unknowns.push({ kind: 'flaky', detail: flaky })
    }
  })()
  work.catch(() => {})
  try {
    await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new CdpError('deadline', `the browser check passed its ${deadlineMs} ms deadline`)), deadlineMs) })])
  } catch (e) {
    unknowns.push(unknownOf(e))
  } finally {
    clearTimeout(timer)
    try { if (browser) await browser.close() } catch (e) { unknowns.push(unknownOf(e)) }
    try { if (server) await server.close() } catch (e) { unknowns.push(unknownOf(e)) }
  }

  out.undriven = ctx.undriven ?? []
  const have = new Set(out.matrix.map((c) => `${c.view}/${c.state}`))
  const missing = views.flatMap((v) => STATES.map((s) => `${v.name}/${s}`)).filter((k) => !have.has(k))
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
  return out
}
