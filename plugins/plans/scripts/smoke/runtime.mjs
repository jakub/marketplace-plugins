// The runtime's small pure views, run in node with no DOM. The changes label (patch 0007): HtmlPlan.changesView takes the
// doc-changes attributes as getAttribute returns them, so an absent label reads "Proposed", an empty one draws none, any other
// value stays plain text, and zero counts hide the element. Quote links (patch 0008): HtmlPlan.safeHref passes http and https
// only, by the URL parser's reading of the scheme, and the link it feeds opens in the same frame after a state flush. The shipped
// vendored set holds no _blank and no claude.ai hand-over wording. Copy-out (patch 0009): the Respond sheet says "Copied" only
// after the browser confirms the copy, and otherwise selects the response for a copy by hand. Fragment writes (patch 0004):
// save() writes each change at once while a budget of history writes lasts, then leaves one trailing write, and the
// budget holds writes far under the browsers' own limits.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createContext, runInContext } from 'node:vm'

const RUNTIME = 'plugins/plans/skills/doc/runtime'

export default async function ({ ROOT, check }) {
  const file = join(ROOT, RUNTIME, 'htmlplan.js')
  const source = readFileSync(file, 'utf8')
  createRequire(import.meta.url)(file)
  const NW = globalThis.HtmlPlan

  // The changes label.
  const view = NW?.changesView
  check('HtmlPlan.changesView is exported above the DOM boundary', typeof view === 'function')
  if (typeof view === 'function') {
    const counts = { new: '5', changed: '4', deleted: '1' }
    const parts = [['add', 5, '+', 'new'], ['mod', 4, '~', 'changed'], ['del', 1, '−', 'deleted']]
    check('an absent label reads "Proposed"', isDeepStrictEqual(view({ ...counts, label: null }), { hidden: false, label: 'Proposed', total: 10, parts }))
    check('a missing label key also reads "Proposed"', view(counts).label === 'Proposed')
    check('a custom label is kept as written', view({ ...counts, label: 'Landed' }).label === 'Landed')
    check('an empty label draws no label', view({ ...counts, label: '' }).label === '' && !view({ ...counts, label: '' }).hidden)
    const markup = '<img src=x onerror=alert(1)>&amp;'
    check('a label that looks like markup stays the same text', view({ ...counts, label: markup }).label === markup)
    check('zero counts are left out', isDeepStrictEqual(view({ new: '2', changed: '0', deleted: null, label: null }).parts, [['add', 2, '+', 'new']]))
    for (const [name, attrs] of [['no counts', {}], ['all zero', { new: '0', changed: '0', deleted: '0' }], ['negative and junk', { new: '-3', changed: 'x', deleted: '' }]]) {
      const v = view({ ...attrs, label: 'Landed' })
      check(`${name}: the element is hidden`, v.hidden === true && v.total === 0 && v.parts.length === 0)
    }
  }
  const define = source.match(/define\('doc-changes', \(el\) => \{\n([\s\S]*?)\n\}\);/)?.[1] ?? ''
  check('doc-changes reads the label with getAttribute and draws it with h(), never as HTML',
    /label: el\.getAttribute\('label'\)/.test(define) && /h\('span', \{ class: 'ch-tag' \}, v\.label\)/.test(define) && !/html:|innerHTML/.test(define), define)

  // Quote links.
  const safe = NW?.safeHref
  check('HtmlPlan.safeHref is exported above the DOM boundary', typeof safe === 'function')
  if (typeof safe === 'function') {
    for (const [href, want] of [['https://example.com/a?b=c#d', 'https://example.com/a?b=c#d'], ['http://example.com', 'http://example.com/'],
      ['HTTPS://Example.COM/x', 'https://example.com/x'], [' https://example.com/ ', 'https://example.com/']]) {
      check(`safeHref passes ${JSON.stringify(href)}`, safe(href) === want, String(safe(href)))
    }
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', '\tjavascript:alert(1)', 'java\nscript:alert(1)',
      'java\tscript:alert(1)', '\x01javascript:alert(1)', 'data:text/html,<b>x</b>', 'DATA:text/html;base64,PGI+', 'vbscript:x', 'file:///etc/passwd',
      'blob:https://example.com/0', 'ftp://example.com/', 'mailto:a@example.com', '/relative/path', 'relative', '#anchor', '//example.com/x', '', null, undefined, 42]) {
      check(`safeHref rejects ${JSON.stringify(href) ?? String(href)}`, safe(href) === null, String(safe(href)))
    }
  }
  const quote = source.match(/define\('doc-quote', \(el\) => \{\n([\s\S]*?)\n\}\);/)?.[1] ?? ''
  const anchor = quote.match(/h\('a', \{([^}]*)\}/)?.[1] ?? ''
  check('a quote link goes through safeHref, has no target, and is rel="noopener noreferrer"',
    /NW\.safeHref\(href\)/.test(quote) && /href: link/.test(anchor) && !/target/.test(anchor) && /rel: 'noopener noreferrer'/.test(anchor), anchor)
  check('a quote link flushes the state before it navigates', /onclick: \(\) => flushState\(\)/.test(anchor), anchor)
  check('the runtime never names _top or _parent and never calls window.open', !/_top|_parent|window\.open/.test(source))

  // The shipped vendored set: every file under skills/doc but the first-party SKILL.md.
  const doc = join(ROOT, 'plugins/plans/skills/doc')
  const vendored = readdirSync(doc, { recursive: true }).filter((f) => f !== 'SKILL.md' && statSync(join(doc, f)).isFile()).sort()
  check('the vendored set is the six ledger files', vendored.length === 6, vendored.join(' '))
  const hits = (re) => vendored.flatMap((f) => readFileSync(join(doc, f), 'utf8').split('\n').map((l, i) => re.test(l) ? `${f}:${i + 1}` : null).filter(Boolean))
  // Claude is matched case-sensitively, as a word, so the lowercase upstream URL (claude-plugins-community) stays allowed.
  for (const [name, re] of [['_blank', /_blank/], ['"Artifact tool"', /Artifact tool/], ['"--artifact"', /--artifact/], ['Claude', /\bClaude\b/]]) {
    const h = hits(re); check(`the vendored set never says ${name}`, h.length === 0, h.join(' '))
  }

  // Copy-out (patch 0009). No DOM runs here, so these hold the source to the contract; the browser check shows it working.
  const copyText = source.match(/\nasync function copyText\(text, ta\) \{\n([\s\S]*?)\n\}\n/)?.[1] ?? ''
  check('copyText is true only when writeText resolves or execCommand(\'copy\') returns true inside a try',
    /try \{ await navigator\.clipboard\.writeText\(text\); return true; \} catch \{\}/.test(copyText) &&
    /try \{[^\n]*return document\.execCommand\('copy'\) === true; \} catch \{ return false; \}/.test(copyText), copyText)
  const respond = source.match(/\nfunction openResponse\(\) \{\n([\s\S]*?)\n\}\n/)?.[1] ?? ''
  check('the Respond sheet shows the response in a readonly textarea', /h\('textarea', \{ class: 'nw-out', readonly: true[^}]*\}\); out\.value = r\.md;/.test(respond) && /openSheet\('Your response', \[list, hint, out\]/.test(respond))
  check('"Copied" appears only on the confirmed branch', (source.match(/'Copied/g) || []).length === 2 &&
    /if \(await copyText\(r\.md, out\)\) \{ state\.textContent = 'Copied'; toast\('Copied'\); return; \}/.test(respond))
  check('a failed copy focuses and selects the textarea and says how to copy by hand',
    /return; \}\n\s*out\.focus\(\{ preventScroll: true \}\); out\.select\(\);[^\n]*\n\s*hint\.textContent = 'The page could not copy\./.test(respond))
  check('the dead Send path is gone', !/liveOn|\bsend\b = null/.test(source))

  // Reading mode (patch 0010), held to the source: the browser check shows the page.
  const fn = (name) => source.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`))?.[1] ?? ''
  const boot = fn('boot')
  const decide = boot.indexOf("readOnly = document.body.dataset.feedback === 'off'")
  check('boot decides reading mode first, before any block is built', decide >= 0 && boot.slice(0, decide).trim() === '' && decide < boot.indexOf('upgradeAll();'))
  check('reading mode drops every restored map', /if \(readOnly\) \{ document\.body\.classList\.add\('nw-read'\); S\.loaded = null; S\.comments = dict\(\); S\.drafts = dict\(\); S\.strikes = dict\(\); S\.seen = dict\(\); \}/.test(boot))
  check('the Respond bar and the seen marks are drawn only outside reading mode', /\n {2}if \(!readOnly\) \{\n {4}bar = h\('div', \{ class: 'nw-bar' \}/.test(boot) && /if \(!readOnly && 'IntersectionObserver' in window\)/.test(boot) && !/feedbackOff/.test(source))
  check('flushState writes no payload in reading mode', /NW\.fragment\.encode\(readOnly \? null : persisted\(\), urlAnchor\)/.test(fn('flushState')))
  check('a pasted payload does not reload a reading-mode page', /if \(!readOnly && \(d\.state \|\| d\.problem\)\) \{ location\.reload\(\); return; \}/.test(fn('followFragment')))
  for (const [name, first] of [['openComment', 'if (readOnly) return;'], ['commentable', 'if (readOnly) return () => {};'], ['openResponse', 'if (readOnly) return;']]) {
    check(`${name} does nothing in reading mode`, fn(name).trimStart().startsWith(first), fn(name).slice(0, 80))
  }
  check('markSeen does nothing in reading mode', /function markSeen\(ask\) \{ if \(readOnly \|\|/.test(source))
  check('strikes, call-row comments and draft and schema edits are not drawn in reading mode',
    /if \(!readOnly\) row\.append\(acts\);/.test(source) && /readOnly \? null : btnEdit, readOnly \? null : btnRevert/.test(source) &&
    /if \(!readOnly\) body\.addEventListener\('dblclick'/.test(source) && /readOnly \? '' : btn\('Edit'/.test(source))
  const sites = [...source.matchAll(/^.*openComment\(\{.*$/gm)].map((m) => m[0]).filter((l) => !/^function openComment/.test(l))
  check('every other direct openComment call site is gated or reached only through a gated control',
    sites.length === 9 &&sites.every((l) => /readOnly/.test(l) || /const (open|doComment) = /.test(l) || /^ {6}openComment\(\{ key, label: `\$\{secLabel\(el\)\} › diagram/.test(l)), sites.join('\n'))

  // State maps (patch 0004). Every map the runtime keeps or restores has no prototype, and writeAnswers reads own properties
  // only, so a control named toString keeps its default under a payload that does not name it. The shipped writeAnswers runs
  // here as cut from the source, on fake controls.
  check('the state maps, the defaults, the persisted answers and the reading-mode reset are created with no prototype',
    /\nconst dict = \(\) => Object\.create\(null\);/.test(source) && /\nconst S = \{ defaults: dict\(\), comments: dict\(\), drafts: dict\(\), strikes: dict\(\), seen: dict\(\), loaded: null \};/.test(source) &&
    /\nfunction readAnswers\(\) \{\n  const out = dict\(\);/.test(source) && /const ans = readAnswers\(\), answers = dict\(\);/.test(source) &&
    (source.match(/S\.comments = dict\(\); S\.drafts = dict\(\); S\.strikes = dict\(\); S\.seen = dict\(\);/g) || []).length === 2 && !/S\.(comments|drafts|strikes|seen) = \{\}/.test(source),
    (source.match(/[^\n]*(S\.comments = |const out = |answers = )[^\n]*/g) || []).map((l) => l.trim().slice(0, 100)).join(' | '))
  const wa = source.match(/\nfunction writeAnswers\(ans\) \{\n[\s\S]*?\n\}\n/)?.[0] ?? ''
  check('writeAnswers can be cut from the runtime', wa.length > 0)
  if (wa) {
    const control = (name, value) => ({ name, type: 'text', value, dataset: {}, matches: () => false })
    const write = (ans) => { const cs = [control('toString', 'default'), control('x', 'default'), control('constructor', 'default'), control('__proto__', 'default')]
      runInContext(wa + ';writeAnswers(ans)', createContext({ ans, controls: () => cs, $$: () => [] })); return cs.map((c) => `${c.name}=${c.value}`).join(' ') }
    const restored = NW.fragment.decode('#pl1.' + Buffer.from(JSON.stringify({ answers: { x: 'changed' } }), 'utf8').toString('base64url')).state.answers
    check('a restored payload that names one control leaves a control named toString, constructor or __proto__ at its default',
      write(restored) === 'toString=default x=changed constructor=default __proto__=default', write(restored))
    check('writeAnswers reads own properties only, whatever map it is handed', write({ x: 'changed' }) === 'toString=default x=changed constructor=default __proto__=default', write({ x: 'changed' }))
    check('a restored answer for a control named toString is written', write(NW.fragment.decode('#pl1.' + Buffer.from(JSON.stringify({ answers: { toString: 'mine' } }), 'utf8').toString('base64url')).state.answers) === 'toString=mine x=default constructor=default __proto__=default')
    // A reload of a page whose control named __proto__ was changed: the persisted answers (a map with no prototype, as
    // persisted() builds) go through encode into the URL, and decode hands them back to writeAnswers.
    const answers = Object.create(null); answers.__proto__ = 'mine'
    const saved = NW.fragment.encode({ answers }, null)
    const reloaded = saved.hash === null ? null : NW.fragment.decode(saved.hash)
    check('a changed control named __proto__ survives a reload', reloaded?.problem === null && write(reloaded.state.answers) === 'toString=default x=default constructor=default __proto__=mine' &&
      Object.getPrototypeOf({}) === Object.prototype, JSON.stringify(reloaded))
  }

  // Maps keyed by a name a block's text chooses (patch 0013): a flow node, a sequence actor, a machine state, trace or grid
  // cell, the layouts' per-id tables and the language tables have no prototype, so constructor or __proto__ is an ordinary name
  // and nothing a block says reaches Object.prototype. The DOM-side maps are held to the source.
  const fl = NW.parseFlow('constructor -> toString\n__proto__ = Label [pill]\n  detail line')
  check('a flow names nodes constructor, toString and __proto__ with no error', fl.errors.length === 0 && isDeepStrictEqual(fl.order, ['constructor', 'toString', '__proto__']), JSON.stringify({ errors: fl.errors, order: fl.order }))
  check('the flow node map has no prototype and the __proto__ node is its own entry', Object.getPrototypeOf(fl.nodes) === null && fl.nodes.__proto__?.shape === 'pill' && isDeepStrictEqual(fl.nodes.__proto__?.detail, ['detail line']))
  check('a node named __proto__ writes nothing onto Object.prototype', ({}).label === undefined && ({}).shape === undefined && ({}).detail === undefined && ({}).sub === undefined)
  const lf = NW.layoutFlow(fl)
  check('the flow layout places every node and routes the edge', Object.getPrototypeOf(lf.boxes) === null && fl.order.every((id) => Number.isFinite(lf.boxes[id]?.x) && Number.isFinite(lf.boxes[id]?.y)) && lf.routes.length === 1, JSON.stringify(Object.keys(lf.boxes)))
  check('a flow grid cell named constructor is one cell', NW.parseFlow('| constructor | __proto__ |\nconstructor -> __proto__').errors.length === 0)
  check('a port key that spells an inherited name (constructo + r) routes its edge', NW.layoutFlow(NW.parseFlow('dir LR\nconstructo -> valueO')).routes.length === 1)
  const sq = NW.parseSeq('participants: constructor "C"\nconstructor -> toString : hi\n__proto__ -> valueOf')
  check('a sequence names actors constructor, toString, __proto__ and valueOf once each', sq.errors.length === 0 && isDeepStrictEqual(sq.actors.map((a) => a.id), ['constructor', 'toString', '__proto__', 'valueOf']) && sq.actors[0].label === 'C', JSON.stringify(sq))
  const mc = NW.parseMachine('machine m initial __proto__\nstate __proto__\nstate constructor final\n__proto__ -go-> constructor\ntrace constructor: go')
  check('a machine names states __proto__ and constructor and a trace constructor with no error', mc.errors.length === 0 && isDeepStrictEqual(mc.order, ['__proto__', 'constructor']) && isDeepStrictEqual(Object.keys(mc.traces), ['constructor']), JSON.stringify({ errors: mc.errors, order: mc.order, traces: mc.traces }))
  check('the machine state and trace maps have no prototype, and a state named __proto__ writes nothing onto Object.prototype', Object.getPrototypeOf(mc.states) === null && Object.getPrototypeOf(mc.traces) === null && ({}).final === undefined && ({}).bind === undefined)
  for (const dir of ['LR', 'TB']) { const lm = NW.layoutMachine(mc, dir); check(`the ${dir} machine layout places both states`, Object.getPrototypeOf(lm.pos) === null && mc.order.every((id) => lm.pos[id]?.every(Number.isFinite)), JSON.stringify(lm.pos)) }
  const mg = NW.parseMachine('machine m initial __proto__\n| __proto__ | constructor |\n__proto__ -go-> constructor\nstate constructor final')
  check('a machine grid cell named __proto__ is one cell, placed by the grid layout', mg.errors.length === 0 && mg.order.every((id) => NW.layoutMachine(mg).pos[id]?.every(Number.isFinite)), JSON.stringify(mg.errors))
  check('langOf returns the name it was given for an inherited name, and an alias still resolves', NW.langOf('constructor') === 'constructor' && NW.langOf('toString') === 'tostring' && NW.langOf('ts') === 'js')
  check('highlight treats lang="constructor" as an unknown language', NW.highlight('x = 1', 'constructor') === NW.highlight('x = 1', 'nope') && typeof NW.highlight('x', 'hasOwnProperty') === 'string')
  check('dict is defined with the utilities, before the parsers that use it', source.indexOf('\nconst dict = () => Object.create(null);') > 0 && source.indexOf('\nconst dict = ') < source.indexOf('NW.parseFlow = '))
  for (const [what, re] of [
    ['the keyword and alias tables', /\nconst KW = \{\n  __proto__: null,\n  js: /, /\nconst LANG_ALIAS = \{ __proto__: null, ts: 'js'/],
    ['the played traces and the machines by name', /\nconst lastPlay = dict\(\);/, /\nconst machines = dict\(\);/],
    ['a flow\'s node templates', /const templates = dict\(\); \$\$\(':scope > template\[data-node\]/],
    ['a schema\'s entity cards', /const cards = dict\(\);\n/],
    ['a call tree\'s excerpts and touched files', /const excerpts = dict\(\); \$\$\(':scope > script\[data-excerpt\]'/, /const f = dict\(\); m\.walk\(/],
    ['a machine\'s node and event elements', /nodeEls = dict\(\), curDir = null;/, /\n    nodeEls = dict\(\);\n/, /const evBtns = dict\(\); evNames\.forEach/],
    ['the mock frame table', /\{ __proto__: null, phone: 390, browser: 1024, terminal: 640, desktop: 900, none: 600 \}\[frame\] \|\| 800\)/],
    ['the quote via table', /const viaTxt = \{ __proto__: null, prompt: 'prompt'/],
  ]) check(`${what} ${re.length ? 'have' : 'has'} no prototype`, (Array.isArray(re) ? re : [re]).every((r) => r.test(source)))
  check('no map keyed by a page-chosen name is a plain object literal', !/const (idx|cards|excerpts|templates|lastPlay|machines|evBtns|under|prevPos|portList) = \{\}/.test(source) && !/(nodeEls|cells|boxes|layer|pos|depth|seen) = \{\}/.test(source) && /const state = dict\(\); const back = new Set\(\);/.test(source) && !/states: \{\}|nodes: \{\}|traces: \{\}/.test(source), (source.match(/[^\n]*(const (idx|cards|excerpts|templates|lastPlay|machines|evBtns|under|prevPos|portList) = \{\}|states: \{\}|nodes: \{\}|traces: \{\})[^\n]*/g) || []).map((l) => l.trim().slice(0, 90)).join(' | '))

  // Fragment writes (patch 0004). The shipped save() and flushState() run here as cut from the source, on a fake clock,
  // timers, location and history, with persisted() reduced to one textarea answer. The browser check shows the same in Chromium.
  const block = source.match(/\nlet saveT, lastWrite[^\n]*\n[\s\S]*?\n(?=\/\*\* What the fragment carries)/)?.[0] ?? ''
  check('the save and flushState code can be cut from the runtime', /\nfunction save\(\)/.test(block) && /\nfunction flushState\(\)/.test(block), block.slice(0, 80))
  const page = () => {
    const env = { now: 1000, timers: [], seq: 0, writes: [], drop: false, answer: '', notes: 0 }
    const location = { hash: '', get href() { return 'https://plans.example/p/x' + this.hash } }
    const ctx = createContext({
      NW, location, urlAnchor: null, performance: { now: () => env.now }, Date: { now: () => env.now },
      setTimeout: (fn, ms) => { env.timers.push({ id: ++env.seq, at: env.now + Math.max(0, ms), fn }); return env.seq },
      clearTimeout: (id) => { env.timers = env.timers.filter((t) => t.id !== id) },
      history: { state: null, replaceState: (s, t, url) => { env.writes.push(env.now); if (!env.drop) location.hash = url.includes('#') ? '#' + url.split('#')[1] : '' } },
      persisted: () => ({ answers: env.answer ? { note: env.answer } : {} }), refreshChrome: () => {}, openResponse: () => {},
      h: () => ({ remove: () => { env.notes-- } }), document: { body: { append: () => { env.notes++ } } },
    })
    const api = runInContext(block + ';({ save, flushState })', ctx)
    const advance = (ms) => {
      const end = env.now + ms
      for (let t; (t = env.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]);) { env.timers = env.timers.filter((x) => x !== t); env.now = t.at; t.fn() }
      env.now = end
    }
    return { env, advance, change: (v) => { env.answer = v; api.save() }, flush: api.flushState, inUrl: () => NW.fragment.decode(location.hash).state?.answers?.note ?? null }
  }
  if (/\nfunction save\(\)/.test(block)) {
    let p = page(); p.change('older'); p.change('newer')
    check('two changes in the same instant are both written at once', p.inUrl() === 'newer' && p.env.writes.length === 2 && p.env.timers.length === 0, JSON.stringify({ inUrl: p.inUrl(), writes: p.env.writes.length }))

    p = page(); for (let i = 1; i <= 10; i++) p.change('a' + i)
    const burst = { written: p.env.writes.length, inUrl: p.inUrl() }
    for (let i = 11; i <= 15; i++) p.change('a' + i)
    const spent = { written: p.env.writes.length, inUrl: p.inUrl(), timers: p.env.timers.length, wait: p.env.timers[0]?.at - p.env.now }
    p.advance(250)
    check('ten changes are written at once, and with the budget spent the rest wait for one trailing write within 250 ms',
      burst.written === 10 && burst.inUrl === 'a10' && spent.written === 10 && spent.inUrl === 'a10' && spent.timers === 1 && spent.wait > 0 && spent.wait <= 250 &&
      p.env.writes.length === 11 && p.inUrl() === 'a15' && p.env.timers.length === 0, JSON.stringify({ burst, spent, after: { written: p.env.writes.length, inUrl: p.inUrl() } }))
    p.advance(10000); for (let i = 1; i <= 11; i++) p.change('b' + i)
    check('ten idle seconds refill the budget to ten writes and no more', p.env.writes.length === 21 && p.inUrl() === 'b10' && p.env.timers.length === 1, String(p.env.writes.length))

    // A change every 5 ms for 30 s: never more than 50 writes in any 10 s, the URL never more than 250 ms behind (the age of
    // the oldest change it does not hold yet), and the last change written.
    p = page(); const made = []; let worstLag = 0
    for (let i = 1; i <= 6000; i++) {
      made[i] = p.env.now; p.change('c' + i)
      const k = Number(p.inUrl()?.slice(1) ?? 0); if (k < i) worstLag = Math.max(worstLag, p.env.now - made[k + 1])
      p.advance(5)
    }
    p.advance(250)
    const w = p.env.writes, peak = w.reduce((m, t) => Math.max(m, w.filter((u) => u >= t && u < t + 10000).length), 0)
    check('a change every 5 ms for 30 s makes at most 50 writes in any 10 s, lags at most 250 ms, and ends with the last change written',
      peak <= 50 && worstLag <= 250 && p.inUrl() === 'c6000' && p.env.timers.length === 0, JSON.stringify({ writes: w.length, peak, worstLag, inUrl: p.inUrl() }))

    p = page(); for (let i = 1; i <= 12; i++) p.change('d' + i)
    const pending = p.env.timers.length; p.env.answer = ''; p.flush(); const atFlush = { hash: p.env.writes.length }
    p.advance(2000)
    check('flushState writes at once over a spent budget and cancels the pending trailing write, as reset needs',
      pending === 1 && p.inUrl() === null && p.env.timers.length === 0 && p.env.writes.length === atFlush.hash && p.env.writes.length === 11, JSON.stringify({ pending, writes: p.env.writes.length }))

    p = page(); p.env.drop = true; p.change('dropped')
    const dropped = { inUrl: p.inUrl(), notes: p.env.notes, writes: p.env.writes.length }
    p.env.drop = false; p.change('landed')
    check('a write the browser drops raises the note, and the next write that lands clears it',
      dropped.inUrl === null && dropped.notes === 1 && dropped.writes === 1 && p.inUrl() === 'landed' && p.env.notes === 0, JSON.stringify({ dropped, after: { inUrl: p.inUrl(), notes: p.env.notes } }))
  }
}
