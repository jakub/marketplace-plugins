// The browser half of build.mjs's check: the view and state matrix, the page probes and the
// pass, fail and unknown aggregation. It loads the candidate's exact bytes from serve.mjs into
// Chromium through cdp.mjs. Node built-ins only.
//
//   runChecks({ buffer, inline, dir, media, skippedMedia, chromium, shots, tmp, deadlineMs })
//     -> Promise<{ result, reason, matrix, checks, copy, undriven, shots }>
//     matrix        one { view, state, ms, faults } per cell, ms the cell's wall time or null
//     buffer        the final Buffer build.mjs will write
//     media         the src values scan.mjs declared; skippedMedia the Inline absolute paths
//     chromium      the executable findChromium found
//     shots         a directory for the screenshots below, or null. The result's `shots` lists
//                   each file written there as { file, view, state, tile, y, height, scale }
//
// Screenshots. With a shots directory, each cell is captured after its probe, from scroll position
// 0, by Page.captureScreenshot clips of at most floor(SHOT_MAX / dsf) CSS px tall, so no tile is
// over SHOT_MAX device px, at y 0, then each tile's end, down to the page's scrollHeight. The first
// tile is `<w>-<scheme>-<state>.png`, later ones `.2.png`, `.3.png` and so on, so a page that fits
// in one tile gets the one file it always got. A clip at y 8192 on a 16,861 px page at 390 px and
// dsf 2 returned the true content on the real viewer, 2026-11-10. In the result's list, file is
// the name inside the directory, tile counts from 1, y and height are CSS px, and scale is the
// view's dsf. A tile joins the list once its file is written. The list holds each view's last
// attempt only, and a retry removes the files the attempt before it wrote. A cell whose listed
// tiles do not cover 0 to its page height without a gap, because a capture or a write failed or
// the run stopped, is unknown `tiles` (`<view> <state>: tiles cover 0-<y> of <h> px`), never a
// pass. A fault outranks it, as every unknown.
//   It never throws: every failure of its own lands in an unknown result. checks holds one
//   `browser` row, then one row per step name, in the order first reported: the base states'
//   rows, chart rows, and the interaction's steps and copy cases, named as below. Each row is
//   fail if any view failed it, then unknown, else pass, across every view and every time a view
//   reported it.
//
// Views. Document mode: 390x844 with mobile emulation at dsf 2 in light and dark, 1100x900 at
// dsf 1 in light, and 1440x900 at dsf 1 in light and dark, the scheme set through
// Emulation.setEmulatedMedia. Inline mode: 360 (dsf 2) and 728 (dsf 1),
// both without mobile emulation, because T3 renders an Inline page in an iframe, which lays out at
// its own width and ignores a viewport meta, where mobile emulation would lay a page without one
// out 980 px wide. Each is at height 80 so the content height is read from scrollHeight rather
// than from the viewport, in light and dark, with sample T3 theme variables. The variables arrive through
// Page.addScriptToEvaluateOnNewDocument as a constructed stylesheet in document.adoptedStyleSheets,
// which sits outside the DOM, so the bytes under test stay those served and the html and body
// probes see only the page's own styles. Emulation.setDefaultBackgroundColorOverride paints the
// host ground behind a transparent page. Each view runs in its own browser context, created with
// Target.createBrowserContext, createTarget and attachToTarget (flatten). Runtime, Log, Network,
// Page and Inspector are enabled before navigation. The probes run in an isolated world, so page
// script that replaces a builtin cannot bend them.
//
// Settle. Page.loadEventFired, then one evaluate that awaits document.fonts.ready, every eager
// image (complete, or a load or error event) and a detached copy of each lazy image and media
// element below, capped at 10 s, then two requestAnimationFrame calls. Settle never touches the
// page's own elements, their preload or their markup, since the recorded markup is compared. A
// loading="lazy" image that is not complete never starts loading far from the viewport or while
// not rendered, and decode() on it never settles, so its copy is new Image() with its crossOrigin
// and src, which loads eagerly. A video or audio element with no metadata and no error, as with
// preload="none", may never fetch its bytes while the check runs, so its copy is a fresh element
// of its tag with preload="metadata", its crossOrigin, and its src or a clone of each <source>
// child, awaited until loadedmetadata, an error on the copy, or an error on its last <source>,
// since an earlier <source> that fails hands over to the next. A src in skippedMedia gets no
// copy. The probe that follows reports media-decode for a lazy image whose copy decoded to 0 px
// wide and for a media element whose copy failed. When the cap expires, settle returns each eager
// image and each copy that neither loaded nor failed, and the view records each one as unknown
// `media-unsettled`, so bytes the check never read never pass.
//
// States, in this order. `initial`; `details-open`, with every native <details> opened and the
// page settled again, where a named group, whose members close each other, is probed once per
// member and the state ends with each group's first member open; `panes` and `chrome`, below; and
// on a Document page with kit hooks in any earlier state, `interaction`, probed after the
// interaction script and the copy check below, with <details> still open. A hook that first
// appears when <details> opens counts the same as one at load, so it needs a kit error or a
// response the script can drive. A kit page whose kit already logged an error gets the cell
// without the script, since its response is off.
//   `panes` runs, in both modes, on a page whose built bytes hold a tag with data-base-switch or a
// <figure> with the class pb-compare. `chrome` runs on a Document whose bytes hold a <body> with
// data-base-shell. Both are read from the bytes with scan.mjs, never from the DOM the page's script
// made, so a base whose script doesn't run can't skip its own check, and the required matrix cells
// follow the same read. A tag inside an HTML <template> is inert and counts for nothing. Each of
// the two runs in a page load of its own: navigate, settle, open every <details> as details-open
// leaves them, settle, then one module function, parts.mjs's panes(drive) or shell.mjs's
// chrome(drive), then every open <dialog> closed, scroll position 0, settle, the probe and the
// capture. interaction runs on the details-open load, as it always has, unless panes or chrome ran,
// when it gets a fresh load set up the same way. On a page whose bytes hold body[data-base-shell],
// the interaction script calls shell.mjs's counts(drive, model) after the initial response and
// after each step that moves a question between open, changed and kept, with a copy of its own
// record as model.
//   `undriven` lists every control outside the kit that the matrix did not drive: a button,
// select, textarea, input, contenteditable or tabindex that no fieldset[data-ask],
// textarea[data-note], data-respond or data-ask-summary holds. Kit controls join it, marked `kit`,
// only when the script did not run. A base control never joins it. A control is a base control
// only by the exact names the base's markup holds or its script makes, and only on a page whose
// bytes require the state that drives it, which drops it (panes: `[data-base-switch]
// [data-base-key] button` and `.plans-compare-switch button`; chrome: `button.plans-theme`,
// `button.plans-zoom-open`, `dialog.plans-zoom button.plans-zoom-size` and
// `button.plans-zoom-close`, `.plans-dock button.plans-dock-sections` and `dialog.plans-sheet
// button.plans-sheet-close`). Every other control joins it whatever its class, so an old page's
// own plans- control is listed as it always was, and a `.pb-table` scroller is always skipped. A
// base control that its state can't drive fails that state's step, a part-drive.
//
// Drive. Each module function gets one drive, built once per state load:
//   io                 { send(method, params), evaluate(expression), mouse(x, y) }: a raw command
//                      on the page's session, an expression in the isolated world, and a press at
//                      a viewport point with no aim
//   view               { name, width, height, dsf, mobile, scheme, small }, scheme being the
//                      emulated prefers-color-scheme
//   inline             whether the build is Inline
//   source             the built bytes, as a string
//   state              'panes', 'chrome' or 'interaction'
//   call(fn, ...args)  runs a self-contained in-page function in the isolated world, with JSON
//                      arguments, and returns its JSON value, awaited. globalThis.plansCheck =
//                      { source, model } is set there once per load first, model being
//                      parts.mjs's, and an argument that is drive.source is passed as a reference
//                      to plansCheck.source, so the bytes cross the pipe once per load.
//   click(spec)        real input through aim(). A base spec is { kind: 'base', selector, index }:
//                      a literal selector the module wrote and a document-order index, never a
//                      string the page chose. A missing control, or a point that lands on another
//                      element, presses nothing and throws a step failure.
//   key(name, mods)    a keyDown and keyUp on whatever has focus. name is Tab, Enter, Escape,
//                      Space, ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Home, End, PageUp or
//                      PageDown, and mods { shift, ctrl, alt, meta }.
//   probe()            this view's probes for this mode, the Inline height budget included, then
//                      chartFaults on a page whose bytes hold a chart, then the event stream. Each
//                      fault joins the state's cell, and the call returns all of them, as
//                      [{ kind, detail }]. It reads media state from the last settle.
//   settle()           fonts, images and media copies, then two frames, as after a load.
//   scrollHome()       scroll position 0.
//   openDetails(k)     opens every <details>, member k of each named group, and returns the
//                      largest group's size.
//   closeDialogs()     closes every open <dialog> with the isolated world's own close(), and
//                      returns how many it closed.
//   missed(e)          whether an error is a step failure, from click() or a module's own. Catch
//                      those, report the step failed, call closeDialogs() and go on. Rethrow the
//                      rest: a protocol error, a deadline or a lost target ends the view through
//                      the retry rule, and an error of the module's own is `checker-error`.
// panes and chrome return { faults, steps }, and counts one row or null. A step is a check row
// { name, result, detail }, result pass, fail or unknown: `panes: switch <n> <key>=<value> …`,
// `panes: switch <n> <key> arrow`, `panes: compare <n> before|after`, `chrome: theme
// light|dark|auto`, `chrome: zoom <n>`, `chrome: dock`, `chrome: sheet` or `interaction: base
// counts`, n counting from 1. A failed step is also the fault part-drive and an unknown one the
// unknown `drive`, each `<state> <target>: <detail>`, the target being the row's name after its
// `<prefix>: `. A step failure that escapes the function is one part-drive, `<state> walk:
// <message>`. Each returned fault joins the state's cell once, beside those probe() recorded.
// chartFaults returns faults, and may add rows named `chart: <caption, or chart <n>> (<traits>)`,
// told apart by their `name`. Those rows are not drive steps: their faults come from the oracle
// itself.
//
// Interaction script (Document pages with kit hooks). It reads a static model once from the DOM:
// the <title> text, the plans-build content, each fieldset[data-ask] with its id, its own legend
// text and its inputs as { value, type, defaultChecked, label }, and each textarea[data-note]'s
// name and starting value. A label is the text of the input's native labels in document order,
// joined by one space, without [data-hint] and [data-then] subtrees. From then on the check keeps
// its own record of checked state and kept flags, built only from the actions it performs, and
// never reads the kit's state. Every action is real CDP input, from the one inputs() helper the
// base states' drive.click and drive.key use too: the target is scrolled to the middle of the
// viewport, then mouseMoved, mousePressed and mouseReleased land at the center of its rect (of a
// label's first text line, for a label click), with mouse events in mobile views too. A click
// whose point hits another element fails the step. Tab is Input.dispatchKeyEvent, and a note is
// Input.insertText per line with an Enter key between lines. The steps, with the
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
// kit-error, part-error (a console line that starts with `plans-part: `, detailed by the rest of
// the line and joined to a cell once; unlike kit-error it never stops the interaction script),
// console-csp, request-outside, load-failed and http-status. From the DOM probe: media-decode,
// page-overflow, clipped, a-target, form and outbound-link (kit pages), srcset, poster, css-url,
// svg-href, svg-viewbox, svg-label, svg-wide, svg-text-small and chart-text-small (every Document
// view, and 360 in Inline), empty-title (Document only), media-undeclared, and in Inline mode
// inline-height, inline-kit-hook and inline-frame. The DOM probe also counts each kind of base
// part in WRITTEN in the live page against the built bytes, read as baseNeeds reads them: more in
// the page than in the bytes is part-error `markup: <n> <kind> in the page, <m> in the built
// bytes: base markup is written, never made by script`, since every base state and the chart
// oracle are read from the bytes, so a part only script makes has no check. From the base states: part-drive (a failed
// drive step), and what parts.mjs and shell.mjs
// return, such as chart-geometry, chart-overlap and base-state-budget. Chromium 155 prints no "Refused to" line for a CSP block, so
// console-csp also reads Log.entryAdded with source `security` and loadingFailed with
// blockedReason `csp`. css-url reads the declarations the CSSOM parsed, in document.styleSheets,
// document.adoptedStyleSheets and every [style], and the text the CSSOM keeps raw: custom
// properties and @property initial values. It tokenizes each value as CSS does, so only a url()
// function counts, never url() text inside a string or a comment, and escapes are decoded in the
// function's name and argument.
// SVG attributes are read as written: an escaped external url() there is a load the sandboxed page
// refuses, so load-failed reports it. clipped spares a box outside the root's width only when the
// nearest horizontal scroller on its containing-block chain can scroll every part of it into view,
// so a fixed or absolute box that escapes a scroller, and content past a scroller's start edge,
// still count. The box and the scroll range are compared in the scroller's own layout px: the
// box's viewport rect maps there through the scroller's effective zoom times the magnitude of the
// horizontal scale of every transform and scale property on it and its ancestors, so a scroller
// drawn larger or smaller than its layout box is read at the size it scrolls. When that chain
// mirrors the scroller, by an odd count of transforms whose x axis points left and negative scale
// x values, the map runs from the right edge of its drawn box, so a mirrored scroller is read in
// the direction it scrolls. svg-wide compares an SVG's drawn width with its parent's clientWidth
// the same way, in the parent's layout px and through the same magnitude, so a figure in a box
// drawn at another size, mirrored or not, is measured at the size that box holds it. Neither reads
// the individual rotate property. Shadow roots are not walked by any probe. In Inline mode the
// skipped absolute media paths raise no network or decode fault, since html_preview inlines them.
// chart-text-small reads each element holding a text node with a box inside [data-base-chart],
// outside SVG, at its computed font size times pxScale times visualViewport.scale.
// An SVG that is not rendered (getScreenCTM null, or no client rects) is skipped by svg-wide and
// svg-text-small, and SVG text size is font size times the CTM's vertical scale times
// visualViewport.scale, so a page without a viewport meta that mobile emulation shrinks shows its
// real on-screen size. The CTM already holds every transform and zoom above the text, and the
// computed font size holds neither, so that product needs no pxScale.
// Console messages and exceptions inside workers are not captured.
//
// Unknown versus fail. A launch or handshake failure, a lost transport, a protocol error on a
// driver command, an exception in this code (`checker-error`), or a deadline while the browser
// fails a 2 s Browser.getVersion ping is unknown. A command deadline, or a lost target, while the
// browser answers the ping is retried once in a fresh context: again is a fail, with the fault
// `deadline`, `target-crashed` or `target-detached` on that cell, and a pass on the retry is
// unknown `flaky`, never a pass. A target is lost when its session gets Inspector.targetCrashed,
// or Inspector.detached, which this check never causes while it listens, since a page cannot
// close its own tab. Chromium 155 answers none of the target's pending commands then, so the event
// ends every wait of the view, and it is kept as view state, so the view ends lost even when a
// command's reply, a success or an error, came in the same chunk just before the event. The
// browser-level Target.detachedFromTarget, which follows either event, is not read. The whole run
// has deadlineMs (180 s) and passing it is unknown `deadline`. However the run stops, runChecks
// waits for a launch still in flight (up to its 10 s handshake), closes the browser, waits for its
// own work to unwind and closes the server before it returns, so no Chromium process, profile,
// timer or screenshot write outlives it. A fault joins
// the record the moment it is measured, in the cell of the state being measured: a probe's faults
// before the cell's screenshot, an interaction fault and a copy verdict at their step, and the
// event stream's faults at the state's probe and when the view ends, finished or stopped, before
// its listener detaches, so an event that arrives during the last screenshot or the controls read
// counts in the last state. So a view that stops early, by an error, a retry, a failed screenshot
// or the deadline, keeps every fault it measured, and the error that stopped it is an unknown
// beside them. A cell with no fault is kept once its probe has run, and a cell that two attempts
// both reached holds the faults of both. The interaction steps and copy verdicts come from each
// view's last attempt.
// Aggregation: any fault gives fail, then any unknown gives unknown, else pass. A required matrix
// cell that is missing is unknown `incomplete`, the required states being initial, details-open,
// panes and chrome as the bytes require them, and interaction on a kit page. Each eager image or
// copy that settle left unresolved is unknown `media-unsettled`, one per view, state and element,
// and each unknown drive step is unknown `drive`.

import { closeSync, constants, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import { COMMAND_MS, CdpError, launch } from './cdp.mjs'
import { format } from './expect.mjs'
import * as parts from './parts.mjs'
import { attr, scan } from './scan.mjs'
import { PROBE, serve } from './serve.mjs'
import * as shell from './shell.mjs'

export const BUILD_MS = 180000
export const SETTLE_MS = 10000
export const SHOT_MAX = 16384
export const TEXT_FLOOR = 11
export const INLINE_HEIGHT = 2000
export const STATES = ['initial', 'details-open']
export const PANES = 'panes'
export const CHROME = 'chrome'
export const INTERACTION = 'interaction'
export const HOSTILE = ['## Decisions', '1. x ✎', '`code`', '> quote', '', 'after blank']
export const SPACES = ['   ', 'after spaces']
const STATUS_MS = 5000
const STATUS_QUIET_MS = 250

const view = (width, height, dsf, mobile, scheme, small) => ({ name: `${width}-${scheme}`, width, height, dsf, mobile, scheme, small })
// Every Document view is small: a narrow grid cell at 1100 or 1440 is narrower than a phone column.
export const DOC_VIEWS = [
  view(390, 844, 2, true, 'light', true), view(390, 844, 2, true, 'dark', true),
  view(1100, 900, 1, false, 'light', true),
  view(1440, 900, 1, false, 'light', true), view(1440, 900, 1, false, 'dark', true),
]
export const INLINE_VIEWS = [
  view(360, 80, 2, false, 'light', true), view(360, 80, 2, false, 'dark', true),
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

// Returns { lazyBroken, mediaBroken, unsettled }: the src URLs of lazy images whose eager copy
// decoded to 0 px wide; { key, detail } for each media element whose copy failed, keyed as the
// probe keys it; and a description of each eager image and copy still unresolved at the cap.
async function settle(capMs, skipped) {
  const once = (el, names) => new Promise((r) => { for (const n of names) el.addEventListener(n, r, { once: true }) })
  const waits = [document.fonts.ready]
  // A lazy image far from the viewport, or not rendered, never starts loading, and decode() on it
  // never settles. Each one not yet complete is loaded through a detached eager copy with its
  // crossOrigin and src, which leaves the page's own markup untouched.
  const eager = [], copies = []
  for (const img of document.images) {
    if (img.complete) continue
    if (img.loading !== 'lazy') { eager.push(img); waits.push(once(img, ['load', 'error'])); continue }
    const src = img.getAttribute('src')
    if (src !== null && skipped.includes(src)) continue
    const copy = new Image()
    copy.crossOrigin = img.crossOrigin
    copy.src = img.src
    copies.push({ copy, src })
    waits.push(once(copy, ['load', 'error']))
  }
  // A video or audio element with no metadata, as with preload="none", may never fetch its bytes.
  // Each one is loaded through a detached copy of its tag with preload="metadata", its crossOrigin
  // and its src, or a clone of each <source> child when it has no src, as the resource selection
  // algorithm picks one or the other. A failed <source> fires error at itself and hands over to
  // the next, so only an error on the copy or on its last <source> ends the wait.
  const media = []
  for (const m of document.querySelectorAll('video, audio')) {
    if (m.readyState >= 1 || m.error) continue
    const sources = m.hasAttribute('src') ? [] : [...m.children].filter((c) => c.localName === 'source')
    const srcs = m.hasAttribute('src') ? [m.getAttribute('src')] : sources.map((s) => s.getAttribute('src') ?? '')
    if (!srcs.length || srcs.some((s) => skipped.includes(s))) continue
    const copy = document.createElement(m.localName)
    copy.preload = 'metadata'
    copy.crossOrigin = m.crossOrigin
    const clones = sources.map((s) => s.cloneNode(true))
    const entry = { copy, srcs, tag: m.localName, key: `<${m.localName}> ${m.hasAttribute('src') ? m.src : sources.map((s) => s.src).join(' ')}`, state: null }
    waits.push(new Promise((r) => {
      copy.addEventListener('loadedmetadata', () => { entry.state = 'loaded'; r() }, { once: true })
      copy.addEventListener('error', (e) => { if (e.target === copy || e.target === clones.at(-1)) { entry.state = 'failed'; r() } }, { capture: true })
    }))
    if (m.hasAttribute('src')) copy.src = m.getAttribute('src')
    else copy.append(...clones)
    media.push(entry)
  }
  await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, capMs))])
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const failed = (e) => e.copy.error
    ? `MediaError code ${e.copy.error.code}${e.copy.error.message ? ` (${e.copy.error.message})` : ''}`
    : 'no <source> could be loaded'
  return {
    lazyBroken: copies.filter((c) => c.copy.complete && c.copy.naturalWidth === 0).map((c) => c.copy.src),
    mediaBroken: media.filter((e) => e.state === 'failed').map((e) => ({ key: e.key, detail: `${e.srcs.join(' ')}: ${failed(e)}, in a copy loaded with preload="metadata" since the element had loaded no metadata` })),
    unsettled: [
      ...eager.filter((i) => !i.complete).map((i) => `<img> ${i.getAttribute('src') ?? i.currentSrc}`),
      ...copies.filter((c) => !c.copy.complete).map((c) => `the eager copy of <img loading="lazy"> ${c.src ?? c.copy.src}`),
      ...media.filter((e) => e.state === null).map((e) => `the preload="metadata" copy of <${e.tag}> ${e.srcs.join(' ')}`),
    ],
  }
}

// Opens every <details>. Members of a named group (one non-empty name) close each other, so only
// the k-th member of each group opens, and the return value is the largest group's size: the
// number of passes that open every member once.
function openDetails(k) {
  const groups = new Map()
  for (const d of document.querySelectorAll('details')) {
    const name = d.getAttribute('name')
    if (!name) { d.open = true; continue }
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(d)
  }
  let passes = 1
  for (const members of groups.values()) {
    passes = Math.max(passes, members.length)
    if (k < members.length) members[k].open = true
  }
  return passes
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
    else if (!img.complete && img.loading === 'lazy' && cfg.lazyBroken.includes(img.src)) add('media-decode', img, `${src} decoded to 0 px wide, loaded eagerly since it is loading="lazy"`)
  }
  for (const m of document.querySelectorAll('video, audio')) {
    // Skipped as settle skips it: the server never admits a skipped src, so its error is expected.
    const srcs = m.hasAttribute('src') ? [m.getAttribute('src')] : [...m.children].filter((c) => c.localName === 'source').map((s) => s.getAttribute('src') ?? '')
    if (srcs.some((s) => cfg.skipped.includes(s))) continue
    if (m.error) { add('media-decode', m, `MediaError code ${m.error.code}${m.error.message ? ` (${m.error.message})` : ''}`); continue }
    if (m.readyState >= 1) continue
    // Keyed as settle keys its copy: the tag, then the resolved src or each <source> child's.
    const key = `<${m.localName}> ${m.hasAttribute('src') ? m.src : [...m.children].filter((c) => c.localName === 'source').map((s) => s.src).join(' ')}`
    const broken = cfg.mediaBroken.find((b) => b.key === key)
    if (broken) add('media-decode', m, broken.detail)
  }

  if (root.scrollWidth > root.clientWidth) add('page-overflow', null, `the root's scrollWidth ${root.scrollWidth} is over its clientWidth ${root.clientWidth}`)

  // Whether scrolling can bring every part of el's box r into view. The nearest horizontal scroller
  // on el's containing-block chain decides, since it clips el to its scrollport. A fixed box's
  // containing block is the viewport unless an ancestor holds fixed boxes, and an absolute box's
  // is its nearest positioned ancestor, so a scroller between either one and its containing block
  // doesn't count. The viewport takes the root's overflow, or body's when the root's is visible,
  // and its scrolling is page-overflow's to report. A scroller's range ends at its start edge, so
  // content past that edge is never in reach.
  const rootStyle = getComputedStyle(root)
  const viewportBody = rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible' ? body : null
  const words = (v) => v.split(/[\s,]+/)
  // An ancestor that holds fixed boxes, and absolute ones, from its computed style. A cause this
  // misses only reports more.
  const holdsFixed = (cs) => cs.transform !== 'none' || cs.translate !== 'none' || cs.rotate !== 'none' || cs.scale !== 'none'
    || cs.perspective !== 'none' || cs.filter !== 'none' || cs.backdropFilter !== 'none'
    || words(cs.contain).some((w) => ['layout', 'paint', 'strict', 'content'].includes(w))
    || words(cs.containerType).some((w) => w === 'size' || w === 'inline-size')
    || words(cs.willChange).some((w) => ['transform', 'translate', 'rotate', 'scale', 'perspective', 'filter', 'backdrop-filter'].includes(w))
  const containingBlock = (x) => {
    const pos = getComputedStyle(x).position
    for (let a = x.parentElement; a; a = a.parentElement) {
      if (pos !== 'absolute' && pos !== 'fixed') return a
      const cs = getComputedStyle(a)
      if (holdsFixed(cs) || (pos === 'absolute' && cs.position !== 'static')) return a
    }
    return null
  }
  // How many viewport px one of x's own layout px spans horizontally: its effective zoom, times
  // the length of the x axis of every transform and scale on it and on its ancestors. Layout px
  // are what clientWidth, scrollLeft and scrollWidth measure, before zoom and transforms, while
  // getBoundingClientRect is after both. It is computed rather than measured, because offsetWidth
  // is snapped to whole px, which a long scroll range multiplies, and ResizeObserver reports
  // nothing in a closed <details> or a skipped content-visibility subtree. It is a distance, never
  // negative, so a mirrored box spans as many px as one drawn the right way round, and mirrored()
  // gives the direction. A perspective projection is not a scale, and this reads none from it,
  // and neither function reads the individual rotate property.
  const pxScale = (x) => {
    let s = x.currentCSSZoom
    for (let a = x; a; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.transform !== 'none') { const m = new DOMMatrixReadOnly(cs.transform); s *= Math.hypot(m.m11, m.m12) }
      if (cs.scale !== 'none') s *= Math.abs(parseFloat(cs.scale))
    }
    return s
  }
  // Whether x's own layout x axis points left on screen, so its left border edge is drawn at the
  // right of its box: an odd count, on it and on its ancestors, of transforms whose x axis points
  // left (m11 under 0, as in scaleX(-1) or rotate(180deg)) and scale properties with a negative x.
  const mirrored = (x) => {
    let m = false
    for (let a = x; a; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.transform !== 'none' && new DOMMatrixReadOnly(cs.transform).m11 < 0) m = !m
      if (cs.scale !== 'none' && parseFloat(cs.scale) < 0) m = !m
    }
    return m
  }
  const reachable = (el, r) => {
    for (let a = containingBlock(el); a; a = containingBlock(a)) {
      if (a === root || a === viewportBody) continue
      const cs = getComputedStyle(a)
      if ((cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') || cs.display === 'inline' || cs.display === 'contents') continue
      // The range and r meet in a's own layout px: r maps there from a's left border edge on
      // screen, through a's scale. A mirrored a draws that edge at the right of its box, and a
      // screen x further left is further from it.
      const scale = pxScale(a)
      const box = a.getBoundingClientRect()
      const [left, right] = mirrored(a)
        ? [(box.right - r.right) / scale, (box.right - r.left) / scale]
        : [(r.left - box.left) / scale, (r.right - box.left) / scale]
      // scrollLeft counts up from 0 where the start edge is the left, and down from 0 where it is
      // the right, so the scrollable range's left end sits at start either way.
      const flipped = cs.writingMode === 'horizontal-tb' ? cs.direction === 'rtl' : /-rl$/.test(cs.writingMode)
      const start = flipped ? a.clientLeft + a.clientWidth - a.scrollLeft - a.scrollWidth : a.clientLeft - a.scrollLeft
      return left >= start - 0.5 && right <= start + a.scrollWidth + 0.5
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
    if (reachable(el, r)) continue
    clipped.push(el)
    add('clipped', el, `spans ${Math.round(left)} to ${Math.round(right)} px, outside 0 to ${cw} px, where no horizontal scroller can bring it into view`)
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

  // The argument of every url() function in CSS text, read as the CSS tokenizer reads it. url()
  // text inside a string or a comment is not a function, nor is a name joined to a number, a hash
  // or an at-keyword, and escapes are decoded in the name and the argument, so u\72l( reads as
  // url(. The CSSOM serializes a parsed declaration decoded, but keeps raw text for a custom
  // property and an @property initial-value, and a raw u\72l( there still loads through var().
  const cssUrls = (text) => {
    const out = []
    const n = text.length
    let i = 0
    const nl = (c) => c === '\n' || c === '\r' || c === '\f'
    const ws = (c) => c === ' ' || c === '\t' || nl(c)
    const nameChar = (c) => c !== undefined && (/[\w-]/.test(c) || c.charCodeAt(0) >= 0x80)
    const escapeAt = (j) => text[j] === '\\' && j + 1 < n && !nl(text[j + 1])
    // At a valid escape: consumes it and returns the code point it stands for.
    const escape = () => {
      const hex = /^[0-9a-fA-F]{1,6}/.exec(text.slice(i + 1, i + 7))
      if (!hex) {
        const cp = text.codePointAt(i + 1)
        i += cp > 0xffff ? 3 : 2
        return String.fromCodePoint(cp)
      }
      i += 1 + hex[0].length
      if (text[i] === '\r' && text[i + 1] === '\n') i += 2
      else if (ws(text[i])) i++
      const cp = parseInt(hex[0], 16)
      return cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff ? '\ufffd' : String.fromCodePoint(cp)
    }
    const name = () => {
      let s = ''
      for (;;) {
        if (nameChar(text[i])) s += text[i++]
        else if (escapeAt(i)) s += escape()
        else return s
      }
    }
    // At a quote: consumes the string and returns its value. A newline ends a string unclosed.
    const string = () => {
      const q = text[i++]
      let s = ''
      while (i < n && text[i] !== q && !nl(text[i])) {
        if (text[i] !== '\\') s += text[i++]
        else if (i + 1 >= n) i++
        else if (nl(text[i + 1])) i += text[i + 1] === '\r' && text[i + 2] === '\n' ? 3 : 2
        else s += escape()
      }
      if (text[i] === q) i++
      return s
    }
    while (i < n) {
      const c = text[i]
      if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        i = end === -1 ? n : end + 2
      } else if (c === '"' || c === "'") string()
      else if (c === '#' || c === '@') { i++; name() }
      else if (nameChar(c) || escapeAt(i)) {
        // A digit is a name character, so a number and its unit, as in 1url(, stay one name.
        if (!/^[uU][rR][lL]$/.test(name()) || text[i] !== '(') continue
        i++
        while (ws(text[i])) i++
        let v = ''
        if (text[i] === '"' || text[i] === "'") v = string()
        else while (i < n && text[i] !== ')') v += escapeAt(i) ? escape() : text[i++]
        out.push(v.trim())
      } else i++
    }
    return out
  }
  const cssFault = (where, text) => {
    for (const v of cssUrls(text)) if (!/^data:/i.test(v) && !v.startsWith('#')) add('css-url', null, `url(${v}) in ${where}`)
  }
  // Every declaration of a CSSStyleDeclaration, as the CSSOM parsed it.
  const declFaults = (where, style) => {
    for (let i = 0; i < style.length; i++) cssFault(where, style.getPropertyValue(style.item(i)))
  }
  const walk = (rules, where) => {
    for (const r of rules) {
      if (r.type === 3) {
        if (!/^data:/i.test(r.href)) add('css-url', null, `@import ${r.href} in ${where}`)
        try { if (r.styleSheet) walk(r.styleSheet.cssRules, where) } catch {}
      }
      if (r.style) declFaults(where, r.style)
      if (typeof r.initialValue === 'string') cssFault(where, r.initialValue)
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
    // The drawn width meets clientWidth in p's own layout px, through p's scale, so a box drawn at
    // another size than its layout box holds the figure at the size it is drawn.
    const w = p ? s.getBoundingClientRect().width / pxScale(p) : 0
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
  // Chart text, once per element that holds a text node with a box. SVG text inside a chart is
  // svg-text-small's, so it is not read twice.
  if (cfg.small) {
    const seen = new Set()
    for (const chart of document.querySelectorAll('[data-base-chart]')) {
      const walker = document.createTreeWalker(chart, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement
        if (!el || seen.has(el) || n.data.trim() === '' || el.namespaceURI === SVGNS) continue
        const r = document.createRange()
        r.selectNodeContents(n)
        if (r.getClientRects().length === 0) continue
        seen.add(el)
        const px = parseFloat(getComputedStyle(el).fontSize) * pxScale(el) * scale
        if (px < cfg.floor - 1e-3) add('chart-text-small', el, `renders at ${px.toFixed(1)} px, under ${cfg.floor} px`)
      }
    }
  }

  if (!cfg.inline && document.title.trim() === '') add('empty-title', null, 'document.title is empty')

  for (const el of document.querySelectorAll('img[src], video[src], audio[src], source[src]')) {
    const src = el.getAttribute('src')
    if (/^(data|blob):/i.test(src)) continue
    if (!cfg.declared.includes(src)) add('media-undeclared', el, `src="${src}" is not in the source the builder read`)
  }

  // A base part is written in the page: one its script made has no check, since every base state
  // is read from the built bytes. querySelectorAll never reaches a <template>'s content, and the
  // bytes' read skips it too.
  for (const [kind, m] of Object.entries(cfg.written)) {
    const n = document.querySelectorAll(kind).length
    if (n > m) add('part-error', null, `markup: ${n} ${kind} in the page, ${m} in the built bytes: base markup is written, never made by script`)
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
// only when the interaction script did not drive them. A base control is never listed: it is one
// of the exact names the base's markup holds or its script makes, below, on a page whose bytes
// require the state that drives it (`base`: { panes, chrome }). Any other control is listed,
// whatever its class, so an old page's own plans- control is listed as it always was. A .pb-table
// scroller is always skipped.
function controls(driven, base) {
  const KIT = 'fieldset[data-ask], [data-respond], [data-ask-summary], textarea[data-note]'
  const PANES = '[data-base-switch] [data-base-key] button, .plans-compare-switch button'
  const CHROME = 'button.plans-theme, button.plans-zoom-open, dialog.plans-zoom button.plans-zoom-size, dialog.plans-zoom button.plans-zoom-close, .plans-dock button.plans-dock-sections, dialog.plans-sheet button.plans-sheet-close'
  const list = []
  for (const el of document.querySelectorAll('button, select, textarea, input, [contenteditable], [tabindex]')) {
    if (!el.matches('button, select, textarea, input, [tabindex]') && el.getAttribute('contenteditable') === 'false') continue
    const kit = !!el.closest(KIT)
    if (kit && driven) continue
    if (!kit && (el.matches('.pb-table') || (base.panes && el.matches(PANES)) || (base.chrome && el.matches(CHROME)))) continue
    let s = el.localName
    if (el.id) s += '#' + el.id
    for (const a of ['type', 'name', 'value', 'tabindex', 'contenteditable']) if (el.hasAttribute(a)) s += `[${a}="${el.getAttribute(a)}"]`
    const t = (el.localName === 'button' ? el.textContent : '').trim().replace(/\s+/g, ' ')
    if (t) s += ` "${t.slice(0, 40)}"`
    list.push(kit ? `kit ${s}` : s)
  }
  return list
}

// Closes every open <dialog> through the isolated world's own close(), which page script can't
// replace, and returns how many it closed.
function closeDialogs() {
  const open = [...document.querySelectorAll('dialog[open]')]
  for (const d of open) d.close()
  return open.length
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
// lands on, with whether elementFromPoint there is the control or inside it. A `base` spec names
// its control by a literal selector the check wrote and a document-order index, never by a string
// the page chose.
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
  else if (spec.kind === 'base') el = document.querySelectorAll(spec.selector)[spec.index]
  if (spec.kind === 'base' && !el) return { error: `the page has no ${spec.selector} at index ${spec.index}` }
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
  // The serve.mjs refusal behind a failed local request. build.mjs refuses every src the double
  // would refuse before the check starts, so from the builder this names only a file that changed
  // between that check and the double's own read.
  const why = (url) => {
    try {
      const u = new URL(url)
      if (u.origin !== origin) return ''
      const r = refused.get(decodeURIComponent(u.pathname).split('/').filter((s) => s !== '').join('/'))
      return r ? ` (not served: the src "${r.src}" ${r.reason})` : ''
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
        if (text.startsWith('plans-part: ')) add('part-error', clip(text.slice('plans-part: '.length)))
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

// A step that failed where the page sits: a control that isn't there, a click whose point lands on
// another element, or a response that differs. Every other error is the checker's own.
class Mismatch extends Error {}

// The keys real input can press: [key, code, virtual key code, text]. Text goes with a keyDown
// only without Ctrl, Alt or Meta.
const KEYS = {
  Tab: ['Tab', 'Tab', 9], Enter: ['Enter', 'Enter', 13, '\r'], Escape: ['Escape', 'Escape', 27], Space: [' ', 'Space', 32, ' '],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowRight: ['ArrowRight', 'ArrowRight', 39],
  ArrowDown: ['ArrowDown', 'ArrowDown', 40], Home: ['Home', 'Home', 36], End: ['End', 'End', 35], PageUp: ['PageUp', 'PageUp', 33],
  PageDown: ['PageDown', 'PageDown', 34],
}
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

// Real input on one page session, shared by the kit interaction and the base states, so both keep
// one rule. A click aims at the center of its target, or of a label's first text line, through
// aim(), and the element at that point must be the target or inside it: otherwise the click is a
// Mismatch and nothing is pressed. mouseMoved, mousePressed and mouseReleased land there, with
// mouse events in mobile views too. A key is an Input.dispatchKeyEvent keyDown and keyUp pair,
// which goes to whatever has focus. io: { send, evaluate }.
function inputs({ send, evaluate }) {
  const mouse = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
  // name, when given, opens the Mismatch message.
  const click = async (spec, name) => {
    const at = name ? `${name}: ` : ''
    const a = await evaluate(call(aim, spec))
    if (a.error) throw new Mismatch(`${at}${a.error}`)
    if (!a.ok) throw new Mismatch(`${at}a click at the center of ${a.want} (${Math.round(a.x)}, ${Math.round(a.y)}) lands on ${a.hit}`)
    await mouse(a.x, a.y)
  }
  // mods: { shift, ctrl, alt, meta }, each a boolean.
  const key = async (name, mods = {}) => {
    if (!Object.hasOwn(KEYS, name)) throw new Error(`no key named ${name}`)
    const [k, code, vk, text] = KEYS[name]
    const m = Object.entries(MODIFIERS).reduce((s, [n, bit]) => (mods[n] ? s | bit : s), 0)
    const params = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(m ? { modifiers: m } : {}) }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(text && !(m & 7) ? { text, unmodifiedText: text } : {}) })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
  return { mouse, click, key }
}

// The kinds of base part the probe counts in the live page, by the selector it counts with.
const WRITTEN = ['[data-base-chart]', '[data-base-switch]', 'figure.pb-compare', 'body[data-base-shell]', '[data-base-contents]']

// The base states a page requires, read from its built bytes with scan.mjs, never from what its
// script made, so a base whose script doesn't run can't skip its own check. A tag inside an HTML
// <template> is inert and counts for nothing. panes: a tag with data-base-switch, or a <figure>
// with the class token pb-compare. chrome: a Document whose <body> start tag carries
// data-base-shell (the parser joins a second <body> tag's attributes to the first). charts: a tag
// with data-base-chart, which turns chartFaults on. written: how many of each WRITTEN kind the
// bytes hold, body[data-base-shell] being 1 when any <body> start tag carries it.
function baseNeeds(source, inline) {
  const need = { panes: false, chrome: false, charts: false, written: Object.fromEntries(WRITTEN.map((k) => [k, 0])) }
  for (const t of scan(source).tokens) {
    if (t.type !== 'start' || t.template) continue
    const n = need.written
    if (attr(t, 'data-base-switch')) { need.panes = true; n['[data-base-switch]']++ }
    if (t.name === 'figure' && (attr(t, 'class')?.value ?? '').split(/[\t\n\f\r ]+/).includes('pb-compare')) { need.panes = true; n['figure.pb-compare']++ }
    if (attr(t, 'data-base-chart')) { need.charts = true; n['[data-base-chart]']++ }
    if (attr(t, 'data-base-contents')) n['[data-base-contents]']++
    if (t.name === 'body' && attr(t, 'data-base-shell')) {
      n['body[data-base-shell]'] = 1
      if (!inline) need.chrome = true
    }
  }
  return need
}

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

// Runs the interaction script and the copy check in one view. io: { send, evaluate, fault, input,
// counts, browser, browserContextId, origin, stopped }, with input from inputs() and counts null or
// an async (model) => Promise<void> that compares the base's question counts with a copy of the
// script's own record. Counts runs after the initial response and after each step that moves a
// question between open, changed and kept. Records steps in rec.steps, copy verdicts in
// rec.copies, clipboard unknowns in rec.unknowns and each fault through io.fault the moment it is
// measured, and returns whether it drove the kit.
async function interact(io, rec, viewName) {
  const { send, evaluate, fault } = io
  const { click, key } = io.input
  const s = await evaluate(call(readModel))
  const step = (name, result, detail = '') => rec.steps.push({ name: `${INTERACTION}: ${name}`, result, detail, view: viewName })
  // runView skips this script when the kit logged an error, so a page that reaches here with the
  // kit's banner, or without a filled response region, has a kit that stopped and never said so.
  if (s.banner || !s.response) {
    const detail = s.banner
      ? 'initial response: the page shows the kit\'s error banner, but no kit error was logged'
      : 'initial response: the page has kit hooks, but no kit error was logged and the response region holds no response textarea'
    step('initial response', 'fail', detail)
    fault('response-mismatch', detail)
    rec.copies.push('unknown')
    return false
  }
  const model = {
    title: s.title, build: s.build,
    questions: s.questions.map((q) => ({ id: q.id, legend: q.legend, type: q.type, kept: false, options: q.options.map((o) => ({ value: o.value, label: o.label, defaultChecked: o.defaultChecked, checked: o.defaultChecked })) })),
    notes: [...s.notes.map((n) => ({ name: n.name, text: n.text })), { name: 'General', text: '' }],
  }
  const general = model.notes[model.notes.length - 1]
  let current = 'initial response'

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
  const changed = (q) => q.options.some((o) => o.checked !== o.defaultChecked)
  // Each question's place in the record: kept, changed or open.
  const places = () => model.questions.map((q) => (q.kept ? 'kept' : changed(q) ? 'changed' : 'open')).join(' ')
  const counted = async () => { if (io.counts) await io.counts(structuredClone(model)) }
  const run = async (name, act) => {
    current = name
    const before = places()
    await act()
    await verify(name)
    step(name, 'pass')
    if (places() !== before) await counted()
  }

  const pickOption = (q, o) => async () => {
    await click({ kind: 'input', q: model.questions.indexOf(q), o: q.options.indexOf(o) }, `${q.id} ${o.value}`)
    if (q.type === 'radio') {
      if (o.checked) return
      for (const x of q.options) x.checked = x === o
    } else o.checked = !o.checked
    q.kept = false
  }
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
    await key('End', { ctrl: true })
  }
  const typeLines = async (spec, note, lines, name) => {
    current = name
    await focusEnd(spec, name)
    for (const [i, line] of lines.entries()) {
      if (i > 0 || note.text !== '') {
        await key('Enter')
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
    await counted()
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
      while (tabs < cap && (await evaluate(call(focusInside, qi)))) { await key('Tab'); tabs++ }
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
    fault('response-mismatch', e.message)
    rec.copies.push('unknown')
    return true
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
      try {
        const v = await verdict(name, press)
        // The verdict is recorded before the response check, which may stop the view.
        if (v.pass) { step(name, 'pass', v.pass); rec.copies.push(v.pass) }
        else if (v.unknown) { step(name, 'unknown', v.unknown); rec.unknowns.push({ kind: 'clipboard', detail: `${viewName}: ${v.unknown}` }); rec.copies.push('unknown') }
        else { step(name, 'fail', v.fault); fault('copy', v.fault); rec.copies.push('unknown') }
        if (!v.unknown) await verify(name)
      } catch (e) {
        if (!(e instanceof Mismatch)) throw e
        step(name, 'fail', e.message)
        fault('response-mismatch', e.message)
        rec.copies.push('unknown')
        break
      }
    }
  } finally {
    await probe.close()
  }
  return true
}

/* ---------------------------------------------------------------- shots */

// A write that fails after the open removes its partial file, so only whole PNGs reach the
// directory.
function writeShot(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644)
  try {
    try { for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off) } finally { closeSync(fd) }
  } catch (e) {
    try { unlinkSync(path) } catch {}
    throw e
  }
}

// The cells of one attempt whose tiles do not cover 0 to the page's height, as `tiles` unknowns.
function tileGaps(rec) {
  return rec.planned.flatMap((p) => {
    let covered = 0
    for (const t of rec.shots.filter((s) => s.view === p.view && s.state === p.state).sort((a, b) => a.y - b.y)) {
      if (t.y > covered) break
      covered = Math.max(covered, t.y + t.height)
    }
    return covered < p.height ? [{ kind: 'tiles', detail: `${p.view} ${p.state}: tiles cover 0-${covered} of ${p.height} px` }] : []
  })
}

/* ---------------------------------------------------------------- one view */

// The cell of one state in one attempt's record, made the first time a fault or a probe needs it.
function cellOf(rec, view, state) {
  let cell = rec.cells.find((c) => c.state === state)
  if (!cell) rec.cells.push((cell = { view, state, faults: [] }))
  return cell
}

// One view. rec: { cells, steps, copies, unknowns, state }, filled as the view runs, so a retry
// starts from a fresh one. rec.state is the state being measured, whose cell a fault joins.
async function runView(browser, ctx, v, rec) {
  // A cell's ms runs from the end of the state before it, or from the view's start for the first.
  let since = Date.now()
  const { browserContextId } = await browser.send('Target.createBrowserContext', { disposeOnDetach: true })
  try {
    if (!ctx.inline) await browser.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: ctx.origin, browserContextId })
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
    const events = []
    const waiters = []
    // The page's target is lost once Chromium says it crashed or detached this session, which this
    // view never does while its listener is on. Chromium answers no command that is pending then,
    // so `gone` ends every wait of the view at once. `lost` keeps the cause as view state, and it
    // decides how the view ends even when a command's reply reached the view before the event did.
    let lost = null, lose
    const gone = new Promise((_, reject) => { lose = reject })
    gone.catch(() => {})
    const listener = (m) => {
      events.push(m)
      if (!lost && m.method === 'Inspector.targetCrashed') lose((lost = new CdpError('crashed', 'the page crashed (Inspector.targetCrashed)')))
      if (!lost && m.method === 'Inspector.detached') lose((lost = new CdpError('detached', `the page's target detached (Inspector.detached: ${m.params?.reason ?? 'no reason'})`)))
      for (const w of [...waiters]) if (w.method === m.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m) }
    }
    browser.on(sessionId, listener)
    const send = (method, params = {}) => Promise.race([browser.send(method, params, sessionId), gone])
    const waitFor = (method) => {
      let timer
      const got = new Promise((resolve) => waiters.push({ method, resolve }))
      const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new CdpError('timeout', `${method} did not arrive within ${COMMAND_MS} ms`)), COMMAND_MS) })
      return Promise.race([got, late, gone, ctx.stopped]).finally(() => clearTimeout(timer))
    }
    let world = null
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, contextId: world, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(`a page probe threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
      return r.result.value
    }
    // A fault joins rec the moment it is measured. Events wait in `events` until the state's probe,
    // or until the view ends, whichever comes first.
    // A part logs each fault once, but its line joins a cell once even if it comes again.
    const fault = (kind, detail) => {
      const cell = cellOf(rec, v.name, rec.state)
      if (kind === 'part-error' && cell.faults.some((f) => f.kind === kind && f.detail === detail)) return
      cell.faults.push({ kind, detail })
    }
    // A fault that a probe, a module or the controls read measured joins its state's cell once,
    // however many of them report it. measured is reset as each state starts.
    let measured = new Set()
    const record = (f) => {
      const key = f.kind + '\0' + f.detail
      if (!measured.has(key)) { measured.add(key); fault(f.kind, f.detail) }
    }
    const add = eventFaults(ctx.origin, ctx.skipped, ctx.refused)
    let drained = 0
    // Moves the events that arrived since the last drain into the state's cell, and returns the
    // faults they made.
    const drain = () => {
      const out = []
      for (; drained < events.length; drained++) {
        add(events[drained], (kind, detail) => { out.push({ kind, detail }); measured.add(kind + '\0' + detail); fault(kind, detail) })
      }
      return out
    }
    const unknown = (kind, detail) => { if (!rec.unknowns.some((u) => u.kind === kind && u.detail === detail)) rec.unknowns.push({ kind, detail }) }
    let settled = null
    // Media the settle cap cut off was never read, so its state can't pass.
    const unsettled = (state) => { for (const u of settled.unsettled) unknown('media-unsettled', `${v.name} ${state}: ${u} neither loaded nor failed within ${SETTLE_MS} ms`) }
    // Counts page loads. Chromium 155 gave the isolated world the same execution context id on
    // every load of a view, so the id can't tell one load from the next.
    let loads = 0
    // One page load: navigate, a fresh isolated world, and settle.
    const load = async () => {
      loads++
      const loaded = waitFor('Page.loadEventFired')
      // Awaited below; marked handled now so a navigation that throws leaves no stray rejection.
      loaded.catch(() => {})
      const nav = await send('Page.navigate', { url: ctx.url })
      if (nav.errorText) throw new CdpError('protocol', `Page.navigate to the viewer double failed: ${nav.errorText}`)
      await loaded
      ;({ executionContextId: world } = await send('Page.createIsolatedWorld', { frameId: nav.frameId, worldName: 'plans-check' }))
      settled = await evaluate(call(settle, SETTLE_MS, ctx.skippedList))
    }
    // Module code runs in the isolated world, where globalThis.plansCheck = { source, model } is
    // set once per page load before the first module call: the built bytes and parts.mjs's model.
    // An argument that is the source itself is passed as a reference to it, so the bytes cross the
    // pipe once per load however often a module passes drive.source.
    let installed = 0
    const inWorld = async (fn, args) => {
      if (installed !== loads) {
        await evaluate(`globalThis.plansCheck = { source: ${JSON.stringify(ctx.source)}, model: (${parts.model.toString()}) }, true`)
        installed = loads
      }
      const arg = (a) => (a === ctx.source ? 'globalThis.plansCheck.source' : a === undefined ? 'undefined' : JSON.stringify(a))
      return evaluate(`(${fn.toString()})(${args.map(arg).join(', ')})`)
    }
    // Check rows from a module, each joined to rec.steps under this view. With derive, a failed row
    // is also the fault part-drive and an unknown row the unknown `drive`, each detailed
    // `<state> <target>: <detail>`, the target being the row's name after its `<prefix>: `.
    const take = (rows, derive) => {
      for (const r of rows ?? []) {
        const result = ['pass', 'fail', 'unknown'].includes(r.result) ? r.result : 'fail'
        rec.steps.push({ name: r.name, result, detail: r.detail ?? '', view: v.name })
        if (!derive || result === 'pass') continue
        const at = r.name.indexOf(': ')
        const what = `${rec.state} ${at === -1 ? r.name : r.name.slice(at + 2)}: ${r.detail ?? ''}`
        if (result === 'fail') record({ kind: 'part-drive', detail: what })
        else unknown('drive', `${v.name} ${what}`)
      }
    }
    let kitPage = false
    // The state's probe, then the chart oracle on a page whose bytes hold a chart, then the event
    // stream. Each fault joins the state's cell, and each row chartFaults returns joins rec.steps.
    // Returns the probe's result and the faults this call measured.
    const measure = async () => {
      const got = await evaluate(call(probe, { inline: ctx.inline, small: v.small, floor: TEXT_FLOOR, heightMax: INLINE_HEIGHT, declared: ctx.declared, skipped: ctx.skippedList, lazyBroken: settled.lazyBroken, mediaBroken: settled.mediaBroken, written: ctx.written }))
      // Hooks in any measured state make it a kit page. A hook that appears when <details> opens
      // needs a kit error, or the response and interaction checks, as much as one at load.
      if (got.kitPage) kitPage = true
      const charts = ctx.charts ? await inWorld(parts.chartFaults, [ctx.source]) : []
      const events = drain()
      const faults = [...got.faults, ...charts.filter((x) => typeof x?.name !== 'string')]
      take(charts.filter((x) => typeof x?.name === 'string'), false)
      for (const f of faults) record(f)
      return { got, faults: [...events, ...faults] }
    }
    const input = inputs({ send, evaluate })
    // The drive a module gets, built once per state load. run.mjs's header says what each member
    // does.
    const driveFor = (state) => ({
      io: { send, evaluate, mouse: input.mouse },
      view: { ...v }, inline: ctx.inline, source: ctx.source, state,
      call: (fn, ...args) => inWorld(fn, args),
      click: (spec) => input.click(spec),
      key: (name, mods) => input.key(name, mods),
      probe: async () => (await measure()).faults,
      settle: async () => { settled = await evaluate(call(settle, SETTLE_MS, ctx.skippedList)); unsettled(state) },
      scrollHome: async () => { await evaluate(call(scrollHome)) },
      openDetails: (k) => evaluate(call(openDetails, k)),
      closeDialogs: () => evaluate(call(closeDialogs)),
      missed: (e) => e instanceof Mismatch,
    })
    // One base state's module function, its rows taken as drive rows and its faults recorded. A
    // step failure it lets escape is one part-drive for the state; any other error is the
    // checker's own and ends the view.
    const runModule = async (state, fn) => {
      let r
      try { r = await fn() } catch (e) {
        if (!(e instanceof Mismatch)) throw e
        record({ kind: 'part-drive', detail: `${state} walk: ${e.message}` })
        return
      }
      take(r?.steps, true)
      for (const f of r?.faults ?? []) record(f)
    }
    // The interaction's counts hook on a shell page: shell.mjs's row, if any, as a drive row.
    const countsFor = (drive) => async (model) => {
      let row
      try { row = await shell.counts(drive, model) } catch (e) {
        if (!(e instanceof Mismatch)) throw e
        row = { name: `${INTERACTION}: base counts`, result: 'fail', detail: e.message }
      }
      if (row) take([row], true)
    }
    try {
      for (const d of ['Runtime', 'Log', 'Network', 'Page', 'Inspector']) await send(`${d}.enable`)
      await send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dsf, mobile: v.mobile })
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v.scheme }] })
      if (ctx.inline) {
        await send('Page.addScriptToEvaluateOnNewDocument', { source: themeScript(v.scheme) })
        await send('Emulation.setDefaultBackgroundColorOverride', { color: T3[v.scheme].ground })
        // T3 sizes its iframe to the content, so the frame never shows a scrollbar that would take
        // width from the page, as a classic one does in a window 80 px tall.
        await send('Emulation.setScrollbarsHidden', { hidden: true })
      } else {
        await send('Emulation.setFocusEmulationEnabled', { enabled: true })
      }
      await load()

      let driven = false
      // Set once a base state has driven the page, so interaction then starts from a fresh load.
      let fresh = false
      for (const state of [...STATES, ...(ctx.panes ? [PANES] : []), ...(ctx.chrome ? [CHROME] : []), INTERACTION]) {
        if (state === INTERACTION && (ctx.inline || !kitPage)) break
        rec.state = state
        measured = new Set()
        if (state === PANES || state === CHROME || (state === INTERACTION && fresh)) {
          await load()
          drain()
          await evaluate(call(openDetails, 0))
          settled = await evaluate(call(settle, SETTLE_MS, ctx.skippedList))
        }
        let got
        if (state === PANES || state === CHROME) {
          fresh = true
          const drive = driveFor(state)
          await runModule(state, () => (state === PANES ? parts.panes(drive) : shell.chrome(drive)))
          await evaluate(call(closeDialogs))
          await evaluate(call(scrollHome))
          settled = await evaluate(call(settle, SETTLE_MS, ctx.skippedList))
          unsettled(state)
          ;({ got } = await measure())
        } else {
          // details-open probes once per member of the largest named <details> group, last member
          // first, so the state ends, is captured and is driven with each group's first member open.
          const passes = state === 'details-open' ? await evaluate(call(openDetails, 0)) : 1
          for (let k = passes - 1; k >= 0; k--) {
            if (state === 'details-open') {
              await evaluate(call(openDetails, k))
              settled = await evaluate(call(settle, SETTLE_MS, ctx.skippedList))
            }
            if (state === INTERACTION) {
              ctx.kitDoc = true
              // A kit that already logged an error has turned its response off: nothing to drive.
              const kitFailed = rec.cells.some((c) => c.view === v.name && c.faults.some((f) => f.kind === 'kit-error'))
              if (!kitFailed) {
                const counts = ctx.chrome ? countsFor(driveFor(INTERACTION)) : null
                driven = await interact({ send, evaluate, fault, input, counts, browser, browserContextId, origin: ctx.origin, stopped: ctx.stopped }, rec, v.name)
              }
              await evaluate(call(scrollHome))
              settled = await evaluate(call(settle, SETTLE_MS, ctx.skippedList))
            }
            unsettled(state)
            ;({ got } = await measure())
          }
        }
        // The cell is in rec before its screenshot, so a capture or write that fails keeps it.
        const cell = cellOf(rec, v.name, state)
        if (ctx.shots) {
          // Tiles by clip offset from scroll position 0, each at most SHOT_MAX device px tall. The
          // plan joins rec before the first capture, so a tile that never lands leaves a gap that
          // runChecks reads, and each tile joins rec.shots only once its file is written.
          await evaluate(call(scrollHome))
          const tile = Math.floor(SHOT_MAX / v.dsf)
          const w = Math.min(Math.ceil(got.width), tile)
          const h = Math.ceil(got.height)
          rec.planned.push({ view: v.name, state, height: h })
          let y = 0, n = 1
          do {
            const height = Math.min(tile, h - y)
            const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width: w, height, scale: 1 } })
            const file = `${v.name}-${state}${n === 1 ? '' : `.${n}`}.png`
            writeShot(join(ctx.shots, file), Buffer.from(data, 'base64'))
            rec.shots.push({ file, view: v.name, state, tile: n, y, height, scale: v.dsf })
            y += height
            n++
          } while (y < h)
        }
        cell.ms = Date.now() - since
        since = Date.now()
      }
      if (ctx.undriven === null) ctx.undriven = await evaluate(call(controls, driven, { panes: ctx.panes, chrome: ctx.chrome }))
    } catch (e) {
      // A lost target ends the view through the retry rule, whatever error it caused first.
      throw lost ?? e
    } finally {
      // Events that arrived after the last drain, while the last screenshot or the controls read
      // was pending or before an error stopped the view, are measured faults of the state it ended
      // in. They are drained before the listener goes, on success and on failure alike.
      drain()
      browser.off(sessionId, listener)
    }
    // No await stands between the last command's reply and the listener's removal, so a crash or
    // detach that came in the same chunk as that reply, after it, is in `lost` by now.
    if (lost) throw lost
  } finally {
    try { await browser.send('Target.disposeBrowserContext', { browserContextId }, undefined, { timeout: 5000 }) } catch {}
  }
}

// The view errors the retry rule covers, with the fault each one is when it happens twice.
const HANG = { timeout: 'deadline', crashed: 'target-crashed', detached: 'target-detached' }
const hang = (e) => e instanceof CdpError && Object.hasOwn(HANG, e.kind)

// One view with the retry rule. Each attempt's record joins recs before it runs, so runChecks
// sees every fault it measured even when the attempt, or the whole run, stops early. Returns
// { flaky } or throws for an unknown.
// rec.planned and rec.shots are the attempt's screenshot plan and the files it wrote. A retry first
// removes the files the attempt before it wrote, so the directory and the manifest both hold one
// attempt's set.
const freshRec = () => ({ cells: [], steps: [], copies: [], unknowns: [], planned: [], shots: [], state: STATES[0] })
async function viewWithRetry(browser, ctx, v, recs) {
  const attempt = () => { const r = freshRec(); recs.push(r); return r }
  try {
    await runView(browser, ctx, v, attempt())
    return { flaky: null }
  } catch (e) {
    if (!hang(e)) throw e
    if (!(await browser.ping())) throw new CdpError('deadline', `${v.name}: ${e.message}, and the browser stopped answering`)
    if (ctx.shots) for (const s of recs.at(-1).shots) { try { unlinkSync(join(ctx.shots, s.file)) } catch {} }
    const again = attempt()
    try {
      await runView(browser, ctx, v, again)
      return { flaky: `${v.name}: ${e.message} once, then passed on a retry` }
    } catch (e2) {
      if (!hang(e2)) throw e2
      if (!(await browser.ping())) throw new CdpError('deadline', `${v.name}: ${e2.message}, and the browser stopped answering`)
      cellOf(again, v.name, again.state).faults.push({ kind: HANG[e2.kind], detail: `${e2.message}, twice, in a browser that still answers` })
      return { flaky: null }
    }
  }
}

// The matrix from every attempt of every view: one cell per view and state, in the order first
// reached, holding each distinct fault any attempt saw there, and the ms of the last attempt that
// finished the state, or null when none did.
function mergeCells(recsPerView) {
  const cells = new Map()
  for (const recs of recsPerView) {
    for (const rec of recs) {
      for (const c of rec.cells) {
        const key = `${c.view}/${c.state}`
        if (!cells.has(key)) cells.set(key, { view: c.view, state: c.state, ms: null, faults: new Map() })
        if (c.ms !== undefined) cells.get(key).ms = c.ms
        for (const f of c.faults) cells.get(key).faults.set(`${f.kind}\0${f.detail}`, f)
      }
    }
  }
  return [...cells.values()].map((c) => ({ view: c.view, state: c.state, ms: c.ms, faults: [...c.faults.values()] }))
}

const unknownOf = (e) => {
  if (e instanceof CdpError) return { kind: e.kind === 'timeout' ? 'deadline' : e.kind, detail: e.message }
  return { kind: 'checker-error', detail: clip(e?.stack ?? String(e), 600) }
}

export async function runChecks({ buffer, inline = false, dir, media = [], skippedMedia = [], chromium, shots = null, tmp, deadlineMs = BUILD_MS }) {
  const views = inline ? INLINE_VIEWS : DOC_VIEWS
  const out = { result: 'unknown', reason: null, matrix: [], checks: [], copy: null, undriven: [], shots: [] }
  const unknowns = []
  let timer, stop
  // One { recs, flaky } per view, with every attempt's record, filled as the views run and read
  // after the run stops.
  const runs = []
  // The server and the browser are owned as promises from the moment they are asked for, so the
  // cleanup below reaches one that is still starting. stopped rejects when the run stops, which
  // ends every wait of the work that no CDP reply ends, and halted keeps it from starting more.
  let serving = null, launching = null, halted = false
  // String(), unlike toString(), never throws, so a missing buffer still ends as an unknown below.
  const source = String(buffer)
  const ctx = {
    inline, shots, undriven: null, kitDoc: false, source, ...baseNeeds(source, inline),
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
    ctx.refused = new Map(server.refused.filter((r) => r.path !== null).map((r) => [r.path, r]))
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
  out.shots = last.flatMap((r) => r.shots)
  // Each view's own unknowns and tile gaps, then its flaky retry, in view order, and the run's own
  // error last.
  unknowns.unshift(...runs.flatMap((r, i) => [...last[i].unknowns, ...tileGaps(last[i]), ...(r.flaky ? [{ kind: 'flaky', detail: r.flaky }] : [])]))
  const have = new Set(out.matrix.map((c) => `${c.view}/${c.state}`))
  const required = [...STATES, ...(ctx.panes ? [PANES] : []), ...(ctx.chrome ? [CHROME] : []), ...(ctx.kitDoc ? [INTERACTION] : [])]
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
  // One row per step name across the views and every time a view reported it: fail if any report
  // failed, then unknown, else pass, with each view named once.
  const byName = new Map()
  for (const st of steps) {
    if (!byName.has(st.name)) byName.set(st.name, [])
    byName.get(st.name).push(st)
  }
  for (const [name, list] of byName) {
    const worst = list.find((x) => x.result === 'fail') ?? list.find((x) => x.result === 'unknown') ?? list[0]
    const detail = worst.result === 'pass' ? `${[...new Set(list.map((x) => x.view))].join(', ')}${worst.detail ? `: ${worst.detail}` : ''}` : `${worst.view}: ${worst.detail}`
    out.checks.push({ name, result: worst.result, detail })
  }
  if (copies.length) out.copy = copies.includes('unknown') ? 'unknown' : copies[0]
  return out
}
