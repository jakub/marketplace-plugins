// Acceptance captures for issue #28, against one live plans viewer URL of a page that plans:doc packed.
//
//   node capture.mjs [--stub-external] [--chromium PATH] [--] <url> <outdir>
//
// Drives headless Chromium through playwright and writes PNGs, one webm and capture.json into <outdir>, one fact per step:
//   1 an answer survives a reload             2 an in-page anchor click keeps the state
//   3 Back after the quote link restores it   4 reset keeps only the anchor
//   5 a copy the browser confirms, read back from the real clipboard
//   6 a forced copy failure that falls back to a selected textarea
//   7 the exact response headers of <url>, printed as text and rendered into a PNG
//   8 the page's img, video, audio and source src values, which publish rewrote to capability URLs
//   9 the plans:publish render check: 390x844 and 1440x900, light and dark, each loaded, with every claim open, and with
//     the Respond sheet open, capture attached before navigation
// plus walkthrough.webm, a recording of steps 1 to 4. A step that cannot apply to <url> is "pending", never a pass: step 8
// is pending when every media src is still a local relative path, as on a page that was never published.
//
// A capability URL is a secret. Every string that reaches a file or stdout goes through redact(): each base64url key of
// 22 characters in a URL, or anywhere it has a key's exact shape, becomes its first 4 characters and "…redacted". The
// rendered captures show redacted text only, a URL bar included, and the run ends by scanning every file it wrote for
// each key it saw. --stub-external answers the quote link's target with a local stub page instead of the network.
// Exit 0 when every step that applies passed, 1 when one failed or a key leaked, 2 on bad arguments.
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import http from 'node:http'
import https from 'node:https'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const USAGE = 'usage: node capture.mjs [--stub-external] [--chromium PATH] [--] <url> <outdir>'
let cli
try { cli = parseArgs({ strict: true, allowPositionals: true, options: { 'stub-external': { type: 'boolean' }, chromium: { type: 'string' }, help: { type: 'boolean' } } }) }
catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2) }
if (cli.values.help) { console.log(USAGE); process.exit(0) }
if (cli.positionals.length !== 2) { console.error(USAGE); process.exit(2) }
const [URL_ARG, OUT_ARG] = cli.positionals
let PAGE; try { PAGE = new URL(URL_ARG) } catch { console.error(`not a URL\n${USAGE}`); process.exit(2) }
if (!/^https?:$/.test(PAGE.protocol)) { console.error(`not an http or https URL\n${USAGE}`); process.exit(2) }
PAGE.hash = ''
const OUT = resolve(OUT_ARG); mkdirSync(OUT, { recursive: true })
const CHROMIUM = cli.values.chromium ?? '/usr/bin/chromium'
const PLAYWRIGHT = '/home/jakub/.npm/_npx/e41f203b7505f1fb/node_modules/'

/* ── redaction ── */
const SECRETS = new Set()
const KEY_SEGMENT = /^[A-Za-z0-9_-]{22}$/
const mask = (k) => `${k.slice(0, 4)}…redacted`
const RUN22 = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/g
const CAPABILITY_KEY = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{21}[AQgw](?![A-Za-z0-9_-])/g   // land-merge.mjs's shape of a plans key
/** Learns each 22-character path segment of a URL as a key, so every later occurrence of it is masked wherever it sits. */
const learn = (u) => { try { new URL(u).pathname.split('/').forEach((s) => { if (KEY_SEGMENT.test(s)) SECRETS.add(s) }) } catch {} }
function redact(s) {
  if (typeof s !== 'string') return s
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(PAGE.hostname)) s = s.split(PAGE.hostname).join('plans.<tailnet-host>')   // the public repo carries no private hostname
  for (const k of SECRETS) s = s.split(k).join(mask(k))
  s = s.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi, (u) => u.replace(RUN22, mask))   // any 22-run inside a URL
  s = s.replace(/(?<=(?:^|[^A-Za-z0-9_-])\/)[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/g, mask)   // a bare /<key> path
  return s.replace(CAPABILITY_KEY, mask)
}
const clean = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'string' ? redact(x) : x)))
const log = (...a) => console.log(...a.map((x) => redact(typeof x === 'string' ? x : JSON.stringify(x))))
const writeText = (name, text) => writeFileSync(join(OUT, name), redact(text))
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
learn(PAGE.href)

/* ── plain HTTP, outside the browser, never with a token ── */
function rawRequest(url, { method = 'GET', headers = {} } = {}) {
  const u = new URL(url); const lib = u.protocol === 'https:' ? https : http
  return new Promise((ok, fail) => {
    const q = lib.request(u, { method, headers: { 'user-agent': 'issue-28-capture', ...headers } }, (r) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => ok({ status: r.statusCode, statusText: r.statusMessage, httpVersion: r.httpVersion, rawHeaders: r.rawHeaders, headers: r.headers, body: Buffer.concat(chunks) }))
    })
    q.on('error', fail); q.setTimeout(30000, () => q.destroy(new Error('timeout'))); q.end()
  })
}

const MEDIA_TYPES = ['text/html', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'video/mp4', 'video/webm']
const PLANSD_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src data:; media-src 'self' data: blob:; worker-src blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const ISSUE_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src data:; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'"
const R = { url: PAGE.href, startedAt: new Date().toISOString(), steps: {} }
const step = (n, name, status, fact) => { R.steps[n] = { name, ...fact, status }; log(`${status.toUpperCase().padEnd(7)} ${n} ${name}`) }

/* ── 7 and 8 first, over plain HTTP: they need no browser, and they teach redact() the attachment keys ── */
const first = await rawRequest(PAGE.href)
const html = first.body.toString('utf8')
const srcs = [...html.matchAll(/<(img|video|audio|source)\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map((m) => ({ tag: m[1].toLowerCase(), src: (m[2] ?? m[3] ?? m[4]).replace(/&amp;/g, '&') }))
srcs.forEach((s) => { try { const u = new URL(s.src, PAGE); if (u.origin === PAGE.origin) learn(u.href) } catch {} })

const { chromium } = createRequire(PLAYWRIGHT)('playwright')
// Playwright adds --disable-ipc-flooding-protection, which switches off the navigation throttle a shipped browser has.
const browser = await chromium.launch({ executablePath: CHROMIUM, ignoreDefaultArgs: ['--disable-ipc-flooding-protection'] })
const viewCtx = await browser.newContext({ viewport: { width: 1480, height: 900 }, deviceScaleFactor: 1 })
const view = await viewCtx.newPage()
/** Renders a capture: a URL bar with the redacted URL, a title, facts, then the screenshot. Every text is redacted. */
async function framed(file, png, { url, title, lines = [], body = '' }) {
  await view.setContent(`<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: #f4f3ef; color: #1c1b19; }
    .bar { display: flex; gap: 10px; align-items: center; padding: 10px 14px; background: #e4e2dc; border-bottom: 1px solid #cfccc4; }
    .bar i { width: 11px; height: 11px; border-radius: 50%; background: #c9c5bb; display: inline-block; }
    .url { flex: 1; font: 13px ui-monospace, monospace; background: #fff; border-radius: 6px; padding: 5px 10px; word-break: break-all; }
    h1 { font-size: 17px; margin: 14px 16px 6px; } ul { margin: 0 16px 12px; padding-left: 18px; } li { font: 12.5px ui-monospace, monospace; word-break: break-all; }
    .shot { margin: 0 16px 16px; } .shot img { border: 1px solid #cfccc4; max-width: 100%; display: block; }
    pre { margin: 0 16px 16px; padding: 12px 14px; background: #fff; border: 1px solid #cfccc4; font: 12.5px/1.5 ui-monospace, monospace; white-space: pre-wrap; word-break: break-all; }
    table { margin: 0 16px 16px; border-collapse: collapse; font: 12.5px ui-monospace, monospace; } td, th { border: 1px solid #cfccc4; padding: 4px 8px; text-align: left; vertical-align: top; } .pass { background: #dff1e6; } .fail { background: #f8dcd8; } .pending { background: #f3ecd2; }
  </style><div class="bar"><i></i><i></i><i></i><span class="url">${esc(redact(url ?? ''))}</span></div>
  <h1>${esc(redact(title))}</h1>${lines.length ? `<ul>${lines.map((l) => `<li>${esc(redact(l))}</li>`).join('')}</ul>` : ''}${body}
  ${png ? `<div class="shot"><img src="data:image/png;base64,${png.toString('base64')}"></div>` : ''}`)
  await view.waitForFunction(() => [...document.images].every((i) => i.complete))
  await view.screenshot({ path: join(OUT, file), fullPage: true })
}

/* ── page helpers ── */
const ready = (page) => page.waitForFunction(() => document.documentElement.dataset.nwReady === '1', null, { timeout: 30000 })
const pause = (page, ms) => page.waitForTimeout(ms)
const hashOf = (page) => page.evaluate(() => location.hash)
const decoded = (page) => page.evaluate(() => { const d = HtmlPlan.fragment.decode(location.hash); return { answers: d.state?.answers ?? null, anchor: d.anchor, problem: d.problem } })
const payloadOf = (h) => (h.startsWith('#pl1.') ? h.slice(1).split('~')[0] : null)
/** The page's decisions in order: id, its first radio group, the default and one other value. */
const asksOf = (page) => page.evaluate(() => [...document.querySelectorAll('doc-ask[id]')].map((a) => { const rs = [...a.querySelectorAll('input[type=radio]')]; const name = rs[0]?.name; const def = rs.find((r) => r.defaultChecked)?.value ?? null; return { id: a.id, name, def, other: rs.find((r) => r.name === name && !r.defaultChecked)?.value ?? null } }).filter((a) => a.name && a.other))
const checkedOf = (page, name) => page.evaluate((n) => document.querySelector(`doc-ask input[name="${CSS.escape(n)}"]:checked`)?.value ?? null, name)
/** A caption on the recording only; screenshots hide it. pointer-events: none, so it never takes a click. */
const caption = (page, text) => page.evaluate((t) => { let c = document.getElementById('__capture_caption'); if (!c) { c = document.createElement('div'); c.id = '__capture_caption'; c.style.cssText = 'position:fixed;left:12px;top:12px;z-index:2147483647;pointer-events:none;background:#1c1b19;color:#fff;font:600 15px system-ui,sans-serif;padding:7px 12px;border-radius:8px;opacity:.92'; document.documentElement.append(c) } c.textContent = 'capture.mjs · ' + t }, text).catch(() => {})
const shoot = async (page, opts = {}) => { await page.evaluate(() => { const c = document.getElementById('__capture_caption'); if (c) c.style.display = 'none' }).catch(() => {}); const b = await page.screenshot(opts); await page.evaluate(() => { const c = document.getElementById('__capture_caption'); if (c) c.style.display = '' }).catch(() => {}); return b }
function watch(ctx, page) {
  const log = { console: [], pageErrors: [], failedRequests: [], badResponses: [], mediaResponses: [] }
  page.on('console', (m) => log.console.push({ type: m.type(), text: m.text(), page: page.url().replace(/#.*/, ''), source: m.location()?.url || null }))
  page.on('pageerror', (e) => log.pageErrors.push(`${e.message} (on ${page.url().replace(/#.*/, '')})`))
  page.on('requestfailed', (q) => log.failedRequests.push({ url: q.url(), type: q.resourceType(), error: q.failure()?.errorText ?? null }))
  page.on('response', (r) => { const t = r.request().resourceType(); if (t === 'image' || t === 'media') log.mediaResponses.push({ url: r.url(), status: r.status() }); if (r.status() >= 400) log.badResponses.push({ url: r.url(), status: r.status(), type: t }) })
  return log
}
const cspHook = (ctx) => ctx.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`Refused to (securitypolicyviolation) ${e.violatedDirective} ${e.blockedURI}`)))
const revealAsk = (page, id) => page.evaluate((i) => { const a = document.getElementById(i); a.closest('doc-plan')?._reveal?.(a); a.scrollIntoView({ block: 'center' }) }, id)

let failed = false
try {
  /* ── 7: the exact response headers ── */
  {
    const lines = [`${first.httpVersion === '2.0' ? 'HTTP/2' : 'HTTP/' + first.httpVersion} ${first.status} ${first.statusText ?? ''}`.trim()]
    for (let i = 0; i < first.rawHeaders.length; i += 2) lines.push(`${first.rawHeaders[i]}: ${first.rawHeaders[i + 1]}`)
    const text = `GET ${PAGE.pathname} HTTP/1.1\nHost: ${PAGE.host}\n(no Authorization header)\n\n${lines.join('\n')}\n`
    writeText('7-headers.txt', text)
    const h = first.headers, csp = h['content-security-policy'] ?? null
    const fact = { request: `GET ${PAGE.pathname}`, httpStatus: first.status, headers: lines.slice(1), contentType: h['content-type'] ?? null, cacheControl: h['cache-control'] ?? null, csp,
      cspEqualsPlansdSource: csp === PLANSD_CSP, cspEqualsIssueText: csp === ISSUE_CSP, sandboxed: /(^|;)\s*sandbox allow-scripts\s*(;|$)/.test(csp ?? ''), sameOriginAllowed: /allow-same-origin/.test(csp ?? '') }
    const pass = first.status === 200 && fact.contentType === 'text/html; charset=utf-8' && /no-store/.test(fact.cacheControl ?? '') && fact.sandboxed && !fact.sameOriginAllowed
    await framed('7-headers.png', null, { url: PAGE.href, title: '7 · The exact response to an unauthenticated GET of the page', lines: [`status ${first.status}`, `CSP equals plansd's artifactCSP: ${fact.cspEqualsPlansdSource}`, `CSP equals issue #28's quoted CSP: ${fact.cspEqualsIssueText}`], body: `<pre>${esc(redact(text))}</pre>` })
    step(7, 'the exact response headers, CSP in particular', pass ? 'pass' : 'fail', fact)
  }

  /* ── 8: the attachments, rewritten to capability URLs ── */
  {
    const rows = []
    for (const s of srcs) {
      let u = null; try { u = new URL(s.src, PAGE) } catch {}
      const literal = !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(s.src)
      const row = { tag: s.tag, src: s.src, literalRelativePath: literal, resolved: u?.href ?? null, capability: !!u && !literal && u.origin === PAGE.origin && /^\/[A-Za-z0-9_-]{22}$/.test(u.pathname) }
      if (row.capability) {
        const head = await rawRequest(u.href, { method: 'HEAD' }).catch((e) => ({ error: e.message }))
        row.head = { status: head.status ?? null, contentType: head.headers?.['content-type'] ?? null, acceptRanges: head.headers?.['accept-ranges'] ?? null, csp: !!head.headers?.['content-security-policy'], error: head.error ?? null }
        if (s.tag === 'video' || s.tag === 'audio' || s.tag === 'source') { const rg = await rawRequest(u.href, { headers: { range: 'bytes=0-1' } }).catch((e) => ({ error: e.message })); row.range = { status: rg.status ?? null, contentRange: rg.headers?.['content-range'] ?? null } }
      }
      rows.push(row)
    }
    const allLocal = rows.length > 0 && rows.every((r) => r.literalRelativePath)
    const pass = rows.length > 0 && rows.every((r) => r.capability && r.head?.status === 200 && MEDIA_TYPES.includes(r.head.contentType) && (!r.range || r.range.status === 206))
    const status = allLocal ? 'pending' : pass ? 'pass' : 'fail'
    const table = `<table><tr><th>tag</th><th>src in the served page</th><th>capability URL</th><th>HEAD</th><th>type</th><th>Range 0-1</th></tr>${rows.map((r) => `<tr class="${r.capability ? 'pass' : allLocal ? 'pending' : 'fail'}"><td>${r.tag}</td><td>${esc(redact(r.src))}</td><td>${r.capability}</td><td>${r.head?.status ?? '—'}</td><td>${esc(r.head?.contentType ?? '—')}</td><td>${r.range?.status ?? '—'}</td></tr>`).join('')}</table>`
    await framed('8-attachments.png', null, { url: PAGE.href, title: `8 · Media src values in the served page: ${status}`, lines: allLocal ? ['every src is still a local relative path: this page was not published through the plans CLI, so the rewrite cannot be shown here'] : [], body: table })
    step(8, 'the attachments rewritten to capability URLs', status, { attachments: rows, ...(allLocal ? { pendingReason: 'every media src is a literal relative path; the page was not published through the plans CLI' } : {}) })
  }

  /* ── 1 to 4, recorded ── */
  const vdir = join(OUT, '.video-tmp'); rmSync(vdir, { recursive: true, force: true })
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: vdir, size: { width: 1440, height: 900 } } })
    await cspHook(ctx); const popups = []; ctx.on('page', (p) => popups.push(p))
    const page = await ctx.newPage(); const wl = watch(ctx, page)
    if (cli.values['stub-external']) await ctx.route((u) => u.origin !== PAGE.origin, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>external stub</title><h1>external page (stub)</h1>' }))
    await page.goto(PAGE.href); await ready(page); await caption(page, 'loaded'); await pause(page, 900)
    const asks = await asksOf(page); if (asks.length < 2) throw new Error(`the page has ${asks.length} answerable decisions; steps 1 and 2 need two`)
    const [A, B] = asks

    // 1. an answer survives a reload
    await revealAsk(page, A.id); await caption(page, `1 · answer “${A.id}”: ${A.other}`); await pause(page, 700)
    await page.locator(`doc-ask#${A.id} input[name="${A.name}"][value="${A.other}"]`).check()
    await page.waitForFunction(([n, v]) => HtmlPlan.fragment.decode(location.hash).state?.answers?.[n] === v, [A.name, A.other])
    await pause(page, 700)
    const h1 = await hashOf(page), d1 = await decoded(page), before1 = await shoot(page)
    await caption(page, '1 · reload'); await pause(page, 500)
    await page.reload(); await ready(page); await revealAsk(page, A.id); await caption(page, '1 · after reload'); await pause(page, 900)
    const after1 = { checked: await checkedOf(page, A.name), hash: await hashOf(page) }
    const s1 = d1.answers?.[A.name] === A.other && after1.checked === A.other && after1.hash === h1
    await framed('1-answer-before-reload.png', before1, { url: page.url().replace(/#.*/, '') + h1, title: `1 · Before reload: decision “${A.id}” answered “${A.other}” (default “${A.def}”)`, lines: [`fragment decodes to answers.${A.name} = ${JSON.stringify(d1.answers?.[A.name])}`] })
    await framed('1-answer-after-reload.png', await shoot(page), { url: page.url(), title: `1 · After reload: “${A.id}” still reads “${after1.checked}”`, lines: [`same fragment as before the reload: ${after1.hash === h1}`] })
    step(1, 'an answer survives a reload', s1 ? 'pass' : 'fail', { decision: A, fragmentBefore: h1, decodedBefore: d1, afterReload: after1 })

    // 2. an in-page anchor click keeps the state
    const h2a = await hashOf(page), hist2a = await page.evaluate(() => history.length)
    await page.evaluate(() => scrollTo(0, 0)); await caption(page, `2 · click the contents link to “${B.id}”`); await pause(page, 700)
    const link = page.locator(`.nw-toc.rail a[href="#${B.id}"]`)
    const via = (await link.count()) && (await link.first().isVisible()) ? 'contents rail' : 'in-page link'
    if (via === 'contents rail') await link.first().click()
    else await page.evaluate((id) => { const a = document.createElement('a'); a.href = '#' + id; a.textContent = 'capture link'; document.querySelector('main').prepend(a); a.click(); a.remove() }, B.id)
    await pause(page, 900)
    const h2b = await hashOf(page), d2 = await decoded(page)
    const after2 = { samePayload: payloadOf(h2b) === payloadOf(h2a), anchor: d2.anchor, historyLength: [hist2a, await page.evaluate(() => history.length)], answerKept: (await checkedOf(page, A.name)) === A.other,
      targetInView: await page.evaluate((id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight }, B.id), via }
    const s2 = after2.samePayload && after2.anchor === B.id && after2.historyLength[0] === after2.historyLength[1] && after2.answerKept && after2.targetInView
    await framed('2-anchor-click.png', await shoot(page), { url: page.url(), title: `2 · After the ${via} click to “${B.id}”: payload unchanged, anchor rewritten`, lines: [`payload unchanged: ${after2.samePayload}`, `anchor: ${after2.anchor}`, `history.length ${after2.historyLength.join(' → ')}`] })
    step(2, 'an in-page anchor click keeps the state', s2 ? 'pass' : 'fail', { before: h2a, after: h2b, ...after2 })

    // 3. Back after the quote link restores the state
    await page.evaluate(() => { const d = document.querySelector('details.thread'); if (d) d.open = true; document.querySelector('doc-quote .q-at a[href]')?.scrollIntoView({ block: 'center' }) })
    const q = await page.evaluate(() => { const a = document.querySelector('doc-quote .q-at a[href]'); return a && { href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') } })
    if (!q) throw new Error('the page has no quote link')
    await caption(page, '3 · follow the quote link'); await pause(page, 900)
    const h3a = await hashOf(page), popupsBefore = popups.length
    await page.locator('doc-quote .q-at a[href]').first().click()
    await page.waitForURL((u) => u.href.startsWith(q.href.replace(/#.*/, '')), { timeout: 30000 }); await page.waitForLoadState('domcontentloaded')
    await caption(page, '3 · on the quote target; now Back'); await pause(page, 1500)
    const away = { url: page.url(), sameFrame: true, newPages: popups.length - popupsBefore, stubbed: !!cli.values['stub-external'] }
    const awayShot = await shoot(page)
    await page.goBack(); await ready(page); await caption(page, '3 · after Back'); await pause(page, 1200)
    const h3b = await hashOf(page)
    const back = { samePayload: payloadOf(h3b) === payloadOf(h3a) && !!payloadOf(h3b), answer: await checkedOf(page, A.name), anchor: (await decoded(page)).anchor, pageUrlBase: page.url().replace(/#.*/, '') === PAGE.href }
    const s3 = q.target === null && /noopener/.test(q.rel ?? '') && /noreferrer/.test(q.rel ?? '') && away.newPages === 0 && back.samePayload && back.answer === A.other && back.pageUrlBase
    await framed('3-quote-link-away.png', awayShot, { url: away.url, title: `3 · The quote link opened in the same tab${away.stubbed ? ' (target stubbed)' : ''}`, lines: [`href ${q.href}`, `target ${q.target}`, `rel ${q.rel}`, `new pages ${away.newPages}`] })
    await framed('3-back-restored.png', await shoot(page), { url: page.url(), title: `3 · After Back: the state is restored, “${A.id}” reads “${back.answer}”`, lines: [`payload equal to the one before the link: ${back.samePayload}`, `anchor ${back.anchor}`] })
    step(3, 'Back after the quote link restores the state', s3 ? 'pass' : 'fail', { link: q, before: h3a, away, after: h3b, ...back })

    // 4. reset keeps only the anchor
    const anchorBefore = (await decoded(page)).anchor
    await page.locator('.nw-respond').click(); await page.locator('.nw-sheet').waitFor(); await caption(page, '4 · Respond, then Reset twice'); await pause(page, 1200)
    const resetBtn = page.locator('.nw-sheet .nw-btn.danger'); await resetBtn.click(); await pause(page, 600); await resetBtn.click()
    const h4a = await hashOf(page); await pause(page, 900); const h4b = await hashOf(page)
    await caption(page, '4 · after Reset'); await pause(page, 600)
    const resetShot = await shoot(page)
    await page.reload(); await ready(page); await caption(page, '4 · after Reset and reload'); await pause(page, 1000)
    // The reload scrolls to the anchor, and a decision in view for a moment is marked seen again, so after the reload the
    // fragment can hold that one seen flag. What reset must clear is every answer, comment, draft and strike.
    const st4 = await page.evaluate(() => { const d = HtmlPlan.fragment.decode(location.hash).state; return d && { answers: Object.keys(d.answers).length, comments: Object.keys(d.comments).length, drafts: Object.keys(d.drafts).length, strikes: Object.keys(d.strikes).length, seen: Object.keys(d.seen) } })
    const after4 = { hashAtReset: h4a, hashLater: h4b, anchorBefore, afterReload: { hash: await hashOf(page), checked: await checkedOf(page, A.name), state: st4 } }
    const want = anchorBefore ? '#' + encodeURIComponent(anchorBefore) : ''
    const s4 = h4a === want && h4b === want && after4.afterReload.checked === A.def && (!st4 || (!st4.answers && !st4.comments && !st4.drafts && !st4.strikes && st4.seen.every((k) => k === anchorBefore)))
    await framed('4-reset.png', resetShot, { url: page.url().replace(/#.*/, '') + h4a, title: `4 · After Reset: the URL keeps only the anchor “${anchorBefore}”`, lines: [`hash at reset ${JSON.stringify(h4a)}`, `hash 900 ms later ${JSON.stringify(h4b)}`, `after reload “${A.id}” reads its default “${after4.afterReload.checked}”`] })
    step(4, 'reset keeps only the anchor', s4 ? 'pass' : 'fail', after4)

    const onPage = (m) => m.page === PAGE.href
    R.walkthroughConsole = { errorsOnThePage: wl.console.filter((m) => m.type === 'error' && onPage(m)), errorsOnTheQuoteTarget: wl.console.filter((m) => m.type === 'error' && !onPage(m)), pageErrors: wl.pageErrors, refused: wl.console.filter((m) => /Refused to/.test(m.text)) }
    const video = page.video(); await ctx.close()
    renameSync(await video.path(), join(OUT, 'walkthrough.webm')); rmSync(vdir, { recursive: true, force: true })
  }

  /* ── 5: a copy the browser confirms, read back from the real clipboard ── */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await cspHook(ctx)
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: PAGE.origin })
    // The viewer page is sandboxed with an opaque origin, so the read-back runs in a plain page of the same origin and context.
    const READER = new URL('/__capture_clipboard_reader__', PAGE.origin).href
    await ctx.route(READER, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>clipboard read-back</title><body style="margin:0;font:13px/1.5 ui-monospace,monospace"><pre id="out" style="margin:0;padding:14px;white-space:pre-wrap"></pre>' }))
    const page = await ctx.newPage(); const wl = watch(ctx, page)
    await page.goto(PAGE.href); await ready(page)
    await page.evaluate(() => { window.__copy = []; const w = navigator.clipboard?.writeText?.bind(navigator.clipboard); if (w) navigator.clipboard.writeText = (t) => w(t).then((v) => { window.__copy.push('writeText resolved'); return v }, (e) => { window.__copy.push('writeText rejected: ' + e.name); throw e }); const x = document.execCommand.bind(document); document.execCommand = (c, ...a) => { const r = x(c, ...a); window.__copy.push(`execCommand(${c}) returned ${r}`); return r } })
    await page.locator('.nw-respond').click(); await page.locator('.nw-sheet textarea.nw-out').waitFor()
    await page.getByRole('button', { name: 'Copy response' }).click()
    await page.waitForFunction(() => document.querySelector('.nw-send-state')?.textContent === 'Copied', null, { timeout: 5000 }).catch(() => {})
    const shown = await page.evaluate(() => ({ state: document.querySelector('.nw-send-state')?.textContent ?? '', value: document.querySelector('textarea.nw-out').value, readonly: document.querySelector('textarea.nw-out').readOnly, path: window.__copy }))
    const sheetShot = await page.locator('.nw-sheet').screenshot()
    const reader = await ctx.newPage(); await reader.goto(READER); await reader.bringToFront()
    const clip = await reader.evaluate(() => navigator.clipboard.readText().then((t) => ({ ok: true, text: t }), (e) => ({ ok: false, text: '', error: e.name + ': ' + e.message })))
    await reader.evaluate((t) => { document.getElementById('out').textContent = t }, redact(clip.text))
    const clipShot = await reader.screenshot({ fullPage: true })
    const s5 = shown.state === 'Copied' && shown.readonly && clip.ok && clip.text === shown.value && shown.value.startsWith('# Re: ')
    await framed('5-copy-copied.png', sheetShot, { url: page.url(), title: '5 · Copy response: the sheet says “Copied” after the browser confirmed it', lines: [`state ${JSON.stringify(shown.state)}`, `copy path ${shown.path.join(', ')}`] })
    await framed('5-clipboard-readback.png', clipShot, { url: READER, title: `5 · The real clipboard, read back in the same browser context: equal to the response ${clip.text === shown.value}`, lines: [`${clip.text.length} characters`, clip.ok ? 'navigator.clipboard.readText() resolved' : `readText failed: ${clip.error}`] })
    step(5, 'a successful copy, with the clipboard read back', s5 ? 'pass' : 'fail', { state: shown.state, copyPath: shown.path, readonly: shown.readonly, responseLength: shown.value.length, clipboard: clip, clipboardEqualsResponse: clip.text === shown.value, errors: wl.pageErrors })
    await ctx.close()
  }

  /* ── 6: a forced copy failure falls back to a selected textarea ── */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); await cspHook(ctx)
    const page = await ctx.newPage(); const wl = watch(ctx, page)
    await page.goto(PAGE.href); await ready(page)
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } }); document.execCommand = () => false })
    await page.locator('.nw-respond').click(); await page.locator('.nw-sheet textarea.nw-out').waitFor()
    await page.getByRole('button', { name: 'Copy response' }).click()
    await page.waitForFunction(() => document.querySelector('.nw-sheet .hint.warn'), null, { timeout: 5000 }).catch(() => {})
    await pause(page, 300)
    const f = await page.evaluate(() => { const ta = document.querySelector('textarea.nw-out'); return { state: document.querySelector('.nw-send-state')?.textContent ?? '', copiedShown: document.body.innerText.includes('Copied'), focused: document.activeElement === ta, selection: [ta.selectionStart, ta.selectionEnd, ta.value.length], hint: document.querySelector('.nw-sheet .hint')?.textContent ?? null } })
    const s6 = !f.state && !f.copiedShown && f.focused && f.selection[0] === 0 && f.selection[1] === f.selection[2] && /could not copy/.test(f.hint ?? '')
    await framed('6-copy-failed-390.png', await page.locator('.nw-sheet').screenshot(), { url: page.url(), title: '6 · Forced failure (writeText rejects, execCommand returns false): no “Copied”, the response is selected', lines: [`focused ${f.focused}`, `selection ${f.selection.join(' / ')}`, `hint ${f.hint}`] })
    step(6, 'a forced copy failure falls back to selection', s6 ? 'pass' : 'fail', { ...f, errors: wl.pageErrors })
    await ctx.close()
  }

  /* ── 9: the render-check matrix of plans:publish ── */
  {
    const cells = []
    for (const [w, h] of [[390, 844], [1440, 900]]) for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme }); await cspHook(ctx)
      const page = await ctx.newPage(); const wl = watch(ctx, page)   // attached before the first navigation
      await page.goto(PAGE.href); await ready(page)
      for (const viewName of ['load', 'claims-open', 'respond-open']) {
        if (viewName === 'claims-open') { for (let i = 0; i < 50; i++) { const row = page.locator('doc-plan doc-claim:not(.open) > .pl-row').first(); if (!(await row.count())) break; await row.click() } await pause(page, 400) }
        if (viewName === 'respond-open') { await page.locator('.nw-respond').click(); await page.locator('.nw-sheet').waitFor(); await pause(page, 300) }
        const mark = { console: wl.console.length, pageErrors: wl.pageErrors.length, failedRequests: wl.failedRequests.length, badResponses: wl.badResponses.length }
        // Let every image and media element settle: loaded, failed, or 10 s gone.
        await page.evaluate(() => Promise.all([...document.querySelectorAll('img')].map((i) => (i.complete ? null : new Promise((ok) => { i.addEventListener('load', ok, { once: true }); i.addEventListener('error', ok, { once: true }) }))).concat(
          [...document.querySelectorAll('video, audio')].map((v) => (v.readyState >= 1 || v.error ? null : new Promise((ok) => { v.addEventListener('loadedmetadata', ok, { once: true }); v.addEventListener('error', ok, { once: true }) })))).map((p) => Promise.race([p, new Promise((ok) => setTimeout(ok, 10000))]))))
        const m = await page.evaluate(() => {
          const de = document.documentElement, vw = de.clientWidth
          const describe = (el) => { const r = el.getBoundingClientRect(); return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.classList.length ? '.' + [...el.classList].join('.') : ''} [${Math.round(r.left)}, ${Math.round(r.right)}] of ${vw}` }
          // An element is clipped when its box runs past the nearest ancestor that hides horizontal overflow, or past the
          // viewport, with no horizontal scroller between that the reader can reach. Text the runtime cuts on purpose, with
          // text-overflow: ellipsis on the clipping box, is listed apart: the reader sees the ellipsis.
          const verdict = (el, r) => {
            for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
              const cs = getComputedStyle(p), o = cs.overflowX
              if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth) return null
              if (o === 'hidden' || o === 'clip') { const pr = p.getBoundingClientRect(); if (r.left < pr.left - 1 || r.right > pr.right + 1) return cs.textOverflow === 'ellipsis' ? 'ellipsis' : 'clipped'; }
            }
            return r.left < -1 || r.right > vw + 1 ? 'clipped' : null
          }
          const clipped = [], ellipsis = []
          for (const el of document.body.querySelectorAll('*')) {
            if (el.id === '__capture_caption' || clipped.some((c) => c.el.contains(el)) || ellipsis.some((c) => c.el.contains(el))) continue
            const r = el.getBoundingClientRect(); if (r.width <= 1 || r.height <= 1) continue
            const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || +cs.opacity === 0) continue
            const v = verdict(el, r); if (v) (v === 'ellipsis' ? ellipsis : clipped).push({ el, text: describe(el) })
          }
          const media = [...document.querySelectorAll('img')].map((i) => ({ tag: 'img', src: i.currentSrc || i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0, settled: i.complete, natural: [i.naturalWidth, i.naturalHeight] }))
            .concat([...document.querySelectorAll('video, audio')].map((v) => ({ tag: v.tagName.toLowerCase(), src: v.currentSrc || v.getAttribute('src'), ok: !v.error && v.readyState >= 1, settled: v.readyState >= 1 || !!v.error, readyState: v.readyState, error: v.error ? `${v.error.code} ${v.error.message}` : null })))
          return { rootOverflow: de.scrollWidth > vw, scrollWidth: de.scrollWidth, clientWidth: vw, clipped: clipped.map((c) => c.text), ellipsis: ellipsis.map((c) => c.text), media }
        })
        const since = (k) => wl[k].slice(mark[k])
        const all = { console: wl.console, pageErrors: wl.pageErrors, failedRequests: wl.failedRequests, badResponses: wl.badResponses }
        const refused = all.console.filter((c) => /Refused to/.test(c.text)).map((c) => c.text)
        const consoleErrors = all.console.filter((c) => c.type === 'error' && !/Refused to/.test(c.text)).map((c) => c.text)
        const mediaFailures = m.media.filter((x) => !x.ok).map((x) => `${x.tag} ${x.src}: ${x.settled ? (x.error ?? 'did not decode') : 'did not load within 10 s'}`)
          .concat(all.badResponses.filter((b) => b.type === 'image' || b.type === 'media').map((b) => `${b.url}: HTTP ${b.status}`))
          .concat(all.failedRequests.filter((f) => (f.type === 'image' || f.type === 'media') && !(f.error === 'net::ERR_ABORTED' && m.media.some((x) => x.ok && x.src === f.url))).map((f) => `${f.url}: ${f.error}`))
        const cell = { viewport: `${w}x${h}`, scheme, view: viewName, rootOverflow: m.rootOverflow, scrollWidth: m.scrollWidth, clientWidth: m.clientWidth, clipped: m.clipped, truncatedWithEllipsis: m.ellipsis, refusedTo: refused, uncaughtErrors: all.pageErrors, consoleErrors, mediaFailures,
          media: m.media, mediaResponses: wl.mediaResponses.map((x) => `${x.status} ${x.url}`), failedRequests: all.failedRequests, newSinceLastView: { console: since('console').length, pageErrors: since('pageErrors').length, failedRequests: since('failedRequests').length } }
        cell.pass = !cell.rootOverflow && !cell.clipped.length && !refused.length && !all.pageErrors.length && !mediaFailures.length
        cell.screenshot = `9-${w}x${h}-${scheme}-${viewName}.png`
        writeFileSync(join(OUT, cell.screenshot), await shoot(page, { fullPage: viewName === 'claims-open' }))
        cells.push(cell)
      }
      await ctx.close()
    }
    const ok = (b) => (b ? 'pass' : 'fail')
    const table = `<table><tr><th>viewport</th><th>scheme</th><th>view</th><th>root overflow</th><th>clipped</th><th>ellipsis</th><th>CSP “Refused to”</th><th>uncaught errors</th><th>media failures</th><th>media responses</th><th>result</th></tr>${cells.map((c) => `<tr class="${ok(c.pass)}"><td>${c.viewport}</td><td>${c.scheme}</td><td>${c.view}</td><td>${c.rootOverflow ? `yes (${c.scrollWidth} > ${c.clientWidth})` : 'no'}</td><td>${esc(c.clipped.join('; ') || 'none')}</td><td>${c.truncatedWithEllipsis.length}</td><td>${c.refusedTo.length}</td><td>${c.uncaughtErrors.length}</td><td>${esc(redact(c.mediaFailures.join('; ') || 'none'))}</td><td>${esc(redact([...new Set(c.mediaResponses.map((r) => r.split(' ')[0]))].join(', ') || 'none'))}</td><td>${ok(c.pass)}</td></tr>`).join('')}</table>`
    const pass = cells.every((c) => c.pass)
    await framed('9-render-matrix.png', null, { url: PAGE.href, title: `9 · Render check (plans:publish): ${cells.filter((c) => c.pass).length} of ${cells.length} cells pass`, lines: ['capture attached before navigation · prefers-color-scheme emulated · 206 is healthy · console errors other than “Refused to” are listed in capture.json'], body: table })
    step(9, 'the render-check matrix of plans:publish', pass ? 'pass' : 'fail', { cells })
  }
} catch (e) {
  R.error = String(e?.stack ?? e); failed = true; log(`ERROR ${R.error}`)
} finally { await browser.close() }

/* ── write, then prove no key reached a file ── */
R.finishedAt = new Date().toISOString(); R.chromium = CHROMIUM
const statuses = Object.values(R.steps).map((s) => s.status)
R.summary = { pass: statuses.filter((s) => s === 'pass').length, fail: statuses.filter((s) => s === 'fail').length, pending: statuses.filter((s) => s === 'pending').length, missing: [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((n) => !R.steps[n]) }
const scan = () => { const leaks = []; for (const f of readdirSync(OUT, { recursive: true })) { let b; try { b = readFileSync(join(OUT, f)) } catch { continue } for (const k of SECRETS) if (b.includes(k)) leaks.push(String(f)) } return leaks }
writeFileSync(join(OUT, 'capture.json'), JSON.stringify(clean(R), null, 1) + '\n')
R.redaction = { keysSeen: SECRETS.size, filesScanned: readdirSync(OUT, { recursive: true }).length, leaks: scan() }
writeFileSync(join(OUT, 'capture.json'), JSON.stringify(clean(R), null, 1) + '\n')
const leaks = scan()
log(`summary ${JSON.stringify(R.summary)} · redaction: ${R.redaction.keysSeen} key(s) seen, ${leaks.length} leak(s)`)
process.exit(failed || leaks.length || R.summary.fail || R.summary.missing.length ? 1 : 0)
