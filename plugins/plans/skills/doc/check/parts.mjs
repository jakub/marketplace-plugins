// The browser check's half for the base parts: the parts model, the `panes` state's walk and the
// chart oracle. run.mjs calls it, and its header defines `drive` and the rules every function here
// keeps. Node built-ins only, and no import of run.mjs, which imports this file.
//
// In-page functions are serialized with toString and run in the check's isolated world, so each
// is a function declaration or an arrow function that uses only its own arguments, the page's DOM
// and globalThis.plansCheck = { source, model }, which run.mjs sets once per page load: the built
// bytes as a string and model below. The model is cached there as plansCheck.parts, so one load
// parses the bytes once.
//
//   model(source)            in-page. Parses the built bytes with DOMParser and returns
//     { switches: [{ i, n, ok, keys: [{ name, values, initial }], panes: [i], charts: [i] }],
//       panes: [{ i, box, when, terms: [[key, value]], within: [i] }], compares: [{ i, ok, pane }],
//       charts: [{ i, n, kind, caption, unit, stack, min, max, from, to, box, rows: [{ status,
//                  values }], items: [{ lane, start, end, span }], ok, lo, hi, shared, lanes }],
//       errors: [detail] }
//     i is the document-order index among [data-base-switch], [data-base-when], figure.pb-compare
//     or [data-base-chart], outside <template> and <noscript>, and n is i + 1, as the kit numbers
//     its log lines. A live element is the one at the same index in the page. box is the index of
//     the switch that holds the pane or chart, or null; within lists the panes of the same switch
//     that hold the pane. min and max are the stated bounds, lo and hi the scale the chart draws on
//     after its share group (ruling 3), from and to the timeline's domain, times UTC ms. ok is
//     false for a part with a markup error, whose detail is in errors as `<part>: <what>`, the part
//     being switch, compare, bars, timeline or markup. The model is this file's own reading of the
//     markup, built from parts.md and the rulings, and never from what the kit wrote.
//   panes(drive)             the `panes` state, below. Returns { faults, steps }.
//   chartFaults(source)      in-page, after every probe in every state of a page whose bytes hold
//                            a chart: the oracle, below. Returns faults and `chart: …` rows.
//   reveal(drive, paneIndex) clicks the terms of the pane at that model index, and of the panes
//                            that hold it, on their switch's buttons, settles, and returns whether
//                            the pane has a box. A click that misses throws the step failure
//                            drive.click throws, for the caller to catch with drive.missed.
//
// panes. The model's errors are part-error faults. Budget: a valid switch has as many combinations
// as the product of its keys' value counts, over 16 is base-state-budget `switch <n>: <k>
// combinations, limit 16`, and over 64 across the page is `page: <k> combinations, limit 64`;
// either one stops the walk before it starts. Otherwise, after a first probe of the state as it
// loaded, each valid switch in document order, with every other switch at its defaults: every
// combination of its own keys, values in written order, each reached by real clicks on the key
// buttons (the first one clicks a button even when nothing has to change), then for each key the
// pressed button clicked to focus it and ArrowRight pressed once, which must move focus to the next
// button, wrapping, and pick it; then clicks back to its defaults. A switch whose box sits in a
// named <details> member other than the first is walked with that member open. Then each valid
// compare, with its named <details> member open the same way, and one inside a hidden pane revealed
// through reveal(): where its content box is under 640 px its switch must show, and its before and
// after buttons are clicked in turn, each showing its own side alone; where it is 640 px or wider,
// no switch shows and both sides must. Last, the final display step puts every switch on its last
// combination, which the state's screenshot shows.
//   After each action the step settles and asserts that exactly the panes the model predicts have
// a box: every pane of a valid switch whose box has a box, unless a closed <details> between the
// pane and its box hides it. Then it probes. A named <details> group inside a pane or a compare
// side that the step revealed is probed once per member, last member first, ending on the first
// (ruling 11). A step
// row's result is its drive and its pane assertion; what the probes found joins the cell as its
// own faults, and the row's detail names the faults no earlier probe of the state found, so the
// step that first showed a fault says so. A failed step, a click that missed or a wrong pane, ends
// that part: the walk closes any dialog, tries to put the switch back at its defaults, leaves the
// switch out of later pane assertions and the final step, and goes on to the next part.
//
// The oracle. For each valid chart with a box: bars are matched by row and column, one drawn
// .plans-bar with a box per value cell, measured against its .plans-track's padding box; timeline
// marks by data-plans-item, one .plans-mark with a box per item, measured against the
// .plans-lane-row that holds it. A missing or extra mark is chart-geometry. The expected extent
// comes from the model's raw values: f(x) = (x - lo) / (hi - lo), a grouped bar from f(min(b, v))
// to f(max(b, v)) with b the zero clamped to [lo, hi], a stacked segment from f(sum before) to
// f(sum through), a point centred on f(t) and a span from f(start) to f(end), with f(t) = 0.5 over
// a zero-width domain, all mirrored in right-to-left. A drawn edge more than 1 CSS px from its
// expected edge is chart-geometry `<chart>: row <r> col <c> drawn <a>-<b> px, expected <x>-<y> px`
// (or `item <n>`), in px from the reference box's start. A chart with a negative value needs a
// zero line at f(0) in each track. Timeline bands follow the lanes in order of first use, each
// labelled with its lane's name, every lane row spans the first one's box, and each mark's row is
// replayed: first fit per band over the drawn boxes, by start then source order, overlap meaning
// more than 0.5 px, with no row left empty. Two marks of one chart, or two text boxes of one chart
// (its text nodes and a timeline's lane labels), that intersect by more than 0.5 CSS px on both
// axes are chart-overlap `<chart>: <a> and <b> intersect`. Each kind is reported at most 4 times
// per chart per call. Each chart measured gets the row `chart: <label> (<traits>)`, fail with its
// first fault or pass: label is the chart's caption (its table's <caption>, else its figure's
// <figcaption>), cut at 60 characters, or `chart <n>` when that is empty or another chart's
// too; traits are grouped, stacked or timeline, then negative, all-zero and shared as they hold.

const WALK = { perSwitch: 16, perPage: 64 }
const clip = (s, n = 120) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/* ---------------------------------------------------------------- in-page */

export function model(source) {
  const doc = new DOMParser().parseFromString(source, 'text/html')
  const NAME = /^[a-z][a-z0-9-]*$/
  const DEC = /^-?\d+(\.\d+)?$/
  const HOOKS = '[data-ask], [data-note], [data-ask-summary], [data-respond]'
  // The names script makes (parts.md, CONTRACTS.md "Script-made names" and the as-built notes).
  // 0.2.0's own plans- names are never refused (ruling 6).
  const MADE_CLASS = ['plans-compare-switch', 'plans-track', 'plans-bar', 'plans-zero', 'plans-lane', 'plans-lane-name',
    'plans-lane-rows', 'plans-lane-row', 'plans-mark', 'plans-theme', 'plans-rows', 'plans-row', 'plans-row-title',
    'plans-chip', 'plans-row-count', 'plans-open', 'plans-dock', 'plans-dock-where', 'plans-dock-count',
    'plans-dock-sections', 'plans-sheet', 'plans-sheet-close', 'plans-zoom-open', 'plans-zoom', 'plans-zoom-img',
    'plans-zoom-size', 'plans-zoom-close']
  const MADE_ATTR = ['data-plans-side', 'data-plans-series', 'data-plans-item', 'data-plans-kind', 'data-plans-lane',
    'data-plans-status', 'data-plans-theme', 'data-plans-theme-rules']
  const errors = []
  const err = (d) => { if (!errors.includes(d)) errors.push(d) }
  // A parser with scripting off reads <noscript> content as markup, which the live page never has.
  const all = (sel, root = doc) => [...root.querySelectorAll(sel)].filter((el) => !el.closest('noscript'))
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
  const asked = (el) => !!el.closest('fieldset[data-ask]') || !!el.querySelector(HOOKS)

  for (const el of all('*')) {
    if (el.closest('meta[name="plans-build"], [data-plans-kit], div.plans-diff')) continue
    for (const c of el.classList) if (MADE_CLASS.includes(c)) err(`markup: <${el.localName}> carries ${c}`)
    for (const a of el.attributes) if (MADE_ATTR.includes(a.name)) err(`markup: <${el.localName}> carries ${a.name}`)
  }

  const boxes = all('[data-base-switch]'), paneEls = all('[data-base-when]')
  const compareEls = all('figure.pb-compare'), chartEls = all('[data-base-chart]')
  const paneOf = (el) => { const p = el.parentElement && el.parentElement.closest('[data-base-when]'); return p ? paneEls.indexOf(p) : null }
  const panes = paneEls.map((p, i) => ({ i, box: null, when: p.getAttribute('data-base-when'), terms: [], within: [] }))

  const switches = boxes.map((box, i) => {
    const s = { i, n: i + 1, ok: true, keys: [], panes: [], charts: [] }
    const no = (what) => { s.ok = false; err(`switch: switch ${s.n} ${what}`) }
    if ((box.parentElement && box.parentElement.closest('[data-base-switch]')) || box.querySelector('[data-base-switch]')) no('nests in another switch')
    if (box.closest('fieldset[data-ask]')) no('sits in a question')
    const groups = all('[data-base-key]', box)
    if (groups.length < 1 || groups.length > 2) no(`has ${groups.length} keys, not 1 or 2`)
    for (const g of groups) {
      const name = g.getAttribute('data-base-key')
      const bs = all('button', g), values = bs.map((b) => b.getAttribute('value') ?? '')
      const on = bs.filter((b) => b.getAttribute('aria-pressed') === 'true')
      if (!NAME.test(name)) no(`key "${name}" needs a name that matches [a-z][a-z0-9-]*`)
      else if (s.keys.some((k) => k.name === name)) no(`key "${name}" is named twice`)
      if (g.closest('[data-base-when]')) no(`key "${name}" sits in a pane`)
      if (values.length < 2) no(`key "${name}" has ${values.length} buttons, not 2 or more`)
      if (values.some((v) => !NAME.test(v))) no(`key "${name}" has a button value that does not match [a-z][a-z0-9-]*`)
      if (new Set(values).size < values.length) no(`key "${name}" repeats a value`)
      if (bs.some((b) => !b.hasAttribute('disabled'))) no(`key "${name}" has a button written without disabled`)
      if (on.length !== 1) no(`key "${name}" has ${on.length} buttons with aria-pressed="true", not 1`)
      s.keys.push({ name, values, initial: on.length === 1 ? on[0].getAttribute('value') : values[0] })
    }
    for (const el of all('[data-base-when]', box)) {
      const p = panes[paneEls.indexOf(el)]
      p.box = i
      s.panes.push(p.i)
      for (let a = paneOf(el); a !== null; a = paneOf(paneEls[a])) if (box.contains(paneEls[a])) p.within.push(a)
      const terms = p.when.split(' ').map((t) => t.split('='))
      const seen = []
      let why = ''
      for (const t of terms) {
        const key = s.keys.find((k) => k.name === t[0])
        if (t.length !== 2) why = 'needs key=value terms separated by single spaces'
        else if (!key) why = `names key "${t[0]}", which its switch does not have`
        else if (!key.values.includes(t[1])) why = `names value "${t[1]}", which key "${t[0]}" does not have`
        else if (seen.includes(t[0])) why = `names key "${t[0]}" twice`
        if (why) break
        seen.push(t[0])
      }
      if (!why && el.hasAttribute('hidden')) why = 'is written hidden'
      if (!why && el.querySelector(HOOKS)) why = 'holds a question'
      if (why) no(`pane "${p.when}" ${why}`)
      else p.terms = terms
    }
    if (!s.panes.length) no('has no pane')
    return s
  })
  for (const p of panes) if (p.box === null) err(`switch: pane "${p.when}" sits outside any switch`)
  for (const g of all('[data-base-key]')) if (!g.closest('[data-base-switch]')) err(`switch: key "${g.getAttribute('data-base-key')}" sits outside any switch`)

  const compares = compareEls.map((fig, i) => {
    const kids = [...fig.children]
    const sides = ['before', 'after'].map((side) => kids.find((c) => c.classList.contains('pb-side') && c.getAttribute('data-base-side') === side))
    const ok = kids.some((c) => c.localName === 'figcaption') && sides.every((x) => x && x.querySelector('h1, h2, h3, h4, h5, h6'))
      && !sides.some((x) => x && x.querySelector(HOOKS)) && !fig.closest('fieldset[data-ask]')
    if (!ok) err(`compare: compare ${i + 1} needs a figcaption, and a before and an after .pb-side, each with a heading and no question`)
    return { i, ok, pane: paneOf(fig) }
  })
  for (const el of all('.pb-compare')) if (el.localName !== 'figure') err(`compare: <${el.localName}> carries pb-compare, which only a <figure> may`)

  // YYYY-MM-DD at UTC midnight, or YYYY-MM-DDTHH:mm:ssZ. The fields must round-trip, so a day that
  // doesn't exist, which Date.parse rolls over, is refused (ruling 5).
  const when = (s) => {
    const m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d):(\d\d)Z)?$/.exec(s ?? '')
    if (!m) return NaN
    const [y, mo, d, h, mi, se] = m.slice(1).map((x) => (x === undefined ? 0 : +x))
    const t = new Date(0)
    t.setUTCFullYear(y, mo - 1, d)
    t.setUTCHours(h, mi, se, 0)
    const back = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds()]
    return back.join() === [y, mo, d, h, mi, se].join() ? t.getTime() : NaN
  }
  const dec = (v) => (DEC.test(v ?? '') && Number.isFinite(+v) ? +v : NaN)

  const charts = chartEls.map((el, i) => {
    const kind = el.getAttribute('data-base-chart'), n = i + 1
    const fig = el.parentElement && el.parentElement.closest('figure')
    const caption = el.localName === 'table' && el.caption ? text(el.caption) : fig ? text([...fig.children].find((c) => c.localName === 'figcaption')) : ''
    const boxEl = el.closest('[data-base-switch]')
    const c = { i, n, kind, caption, unit: el.getAttribute('data-base-unit') || null, stack: el.hasAttribute('data-base-stack'), min: null, max: null,
      from: null, to: null, box: boxEl ? boxes.indexOf(boxEl) : null, rows: [], items: [], ok: true, lo: null, hi: null, shared: 1, lanes: [] }
    const bad = (what) => { if (c.ok) { c.ok = false; err(`${kind === 'timeline' ? 'timeline' : 'bars'}: chart ${n} ${what}`) } }
    if (asked(el) || (el.parentElement && el.parentElement.closest('[data-base-chart]')) || el.querySelector('[data-base-chart]')) bad('holds a question, sits in one, or nests in a chart')
    else if (kind === 'bars' && el.localName === 'table') {
      const bound = (a) => (el.hasAttribute(a) ? dec(el.getAttribute(a)) : null)
      c.min = bound('data-base-min')
      c.max = bound('data-base-max')
      const trs = [...el.tBodies].flatMap((b) => [...b.rows])
      c.rows = trs.map((tr) => ({
        status: tr.getAttribute('data-base-status'),
        values: [...tr.cells].slice(1).map((td) => { const d = td.querySelectorAll('data'); return td.localName === 'td' && d.length === 1 ? dec(d[0].getAttribute('value')) : NaN }),
      }))
      const cols = c.rows.length ? c.rows[0].values.length : 0
      const odd = trs.findIndex((tr, r) => !tr.cells[0] || tr.cells[0].localName !== 'th' || c.rows[r].values.length !== cols || c.rows[r].values.some((v) => Number.isNaN(v) || (c.stack && v < 0)))
      if (Number.isNaN(c.min) || Number.isNaN(c.max)) bad('needs decimal data-base-min and data-base-max')
      else if (c.stack && c.min !== null && c.min !== 0) bad('is stacked, so its data-base-min is 0 or absent')
      else if (!(cols >= 1 && cols <= 6)) bad('needs body rows of 1 to 6 values')
      else if (odd >= 0) bad(`row ${odd + 1} needs a <th> and ${cols} <td>, each with one decimal <data value>${c.stack ? ' of 0 or more' : ''}`)
      else if (cols > 1 && !(el.tHead && el.tHead.rows[0] && el.tHead.rows[0].cells.length === cols + 1)) bad('needs a thead cell over each column')
    } else if (kind === 'timeline' && el.localName === 'ol') {
      const items = [...el.children].map((li) => ({ li, ts: [...li.querySelectorAll('time')].map((t) => when(t.getAttribute('datetime'))), lane: (li.getAttribute('data-base-lane') ?? '').trim() }))
      const odd = items.findIndex((x) => !x.lane || !x.ts.length || x.ts.length > 2 || x.ts.some(Number.isNaN) || !(x.ts[0] <= x.ts.at(-1)))
      const bound = (a) => (el.hasAttribute(a) ? when(el.getAttribute(a)) : null)
      if (odd >= 0) bad(`item ${odd + 1} needs a data-base-lane and one or two <time datetime> in order, each YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ`)
      else if (!items.length) bad('has no items')
      else {
        c.items = items.map((x) => ({ lane: x.lane, start: x.ts[0], end: x.ts.at(-1), span: x.ts.length > 1 }))
        c.from = bound('data-base-from') ?? Math.min(...c.items.map((x) => x.start))
        c.to = bound('data-base-to') ?? Math.max(...c.items.map((x) => x.end))
        c.lanes = [...new Set(c.items.map((x) => x.lane))]
        if (!(c.from <= c.to) || c.items.some((x) => x.start < c.from || x.end > c.to)) bad('needs real data-base-from and data-base-to bounds that hold every item')
      }
    } else bad('needs bars on a <table> or timeline on an <ol>')
    if (c.box !== null) switches[c.box].charts.push(i)
    return c
  })

  // Share groups: valid bars charts in one switch with one non-empty unit. The first stated bound
  // in the group is the group's, every other stated one must equal it, and with none stated the
  // group spans every member's values, or row sums when stacked, and 0 (ruling 3).
  const groups = []
  for (const c of charts) {
    if (c.kind !== 'bars' || !c.ok) continue
    c.vals = c.stack ? c.rows.map((r) => r.values.reduce((a, b) => a + b, 0)) : c.rows.flatMap((r) => r.values)
    const g = c.box !== null && c.unit ? groups.find((x) => x[0].box === c.box && x[0].unit === c.unit) : null
    if (g) g.push(c)
    else groups.push([c])
  }
  for (const g of groups) {
    const s0 = g.find((c) => c.min !== null), s1 = g.find((c) => c.max !== null)
    const lo = s0 ? s0.min : Math.min(...g.map((c) => Math.min(0, ...c.vals)))
    const hi = s1 ? s1.max : Math.max(...g.map((c) => Math.max(0, ...c.vals))) || (lo ? 0 : 1)
    for (const c of g) {
      c.shared = g.length
      const bad = (what) => { c.ok = false; err(`bars: chart ${c.n} ${what}`) }
      if ((s0 && c.min !== null && c.min !== lo) || (s1 && c.max !== null && c.max !== hi)) bad('states a bound its share group contradicts')
      else if (!(lo < hi) || c.vals.some((v) => v < lo || v > hi)) bad(`has a ${c.stack ? 'row sum' : 'value'} outside ${lo} to ${hi}`)
      else { c.lo = lo; c.hi = hi }
      delete c.vals
    }
  }
  return { switches, panes, compares, charts, errors }
}

// The oracle. Its header is above, with the file's.
export function chartFaults(source) {
  const pc = globalThis.plansCheck
  const m = pc.parts || (pc.parts = pc.model(source))
  const out = m.errors.map((detail) => ({ kind: 'part-error', detail }))
  const rows = []
  const has = (el) => !!el && el.getClientRects().length > 0
  const els = document.querySelectorAll('[data-base-chart]')
  const px = (v) => v.toFixed(1)
  // An element's padding box in viewport px, with the viewport px per CSS px.
  const inner = (el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
    const s = el.offsetWidth ? r.width / el.offsetWidth : 1
    const bl = parseFloat(cs.borderLeftWidth) * s, br = parseFloat(cs.borderRightWidth) * s
    return { l: r.left + bl, w: r.width - bl - br, top: r.top, s, rtl: cs.direction === 'rtl' }
  }
  // Viewport x of the fractions a <= b of a box, mirrored in right-to-left.
  const span = (box, a, b) => (box.rtl ? [box.l + box.w * (1 - b), box.l + box.w * (1 - a)] : [box.l + box.w * a, box.l + box.w * b])
  const hit = (p, q) => Math.min(p.right, q.right) - Math.max(p.left, q.left) > 0.5 && Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 0.5
  const captions = m.charts.map((c) => c.caption)
  for (const c of m.charts) {
    const el = els[c.i]
    if (!c.ok || !has(el)) continue
    const label = c.caption && captions.indexOf(c.caption) === captions.lastIndexOf(c.caption) ? (c.caption.length > 60 ? c.caption.slice(0, 59) + '…' : c.caption) : `chart ${c.n}`
    const mine = [], count = { 'chart-geometry': 0, 'chart-overlap': 0 }
    const add = (kind, what) => { if (count[kind]++ < 4) mine.push({ kind, detail: `${label}: ${what}` }) }
    const geo = (what) => add('chart-geometry', what)
    // An edge more than 1 CSS px off, in px from the box's start.
    const edges = (where, box, got, want) => {
      if (Math.abs(got[0] - want[0]) <= box.s + 1e-6 && Math.abs(got[1] - want[1]) <= box.s + 1e-6) return
      const at = (x) => px((x - box.l) / box.s)
      geo(`${where} drawn ${at(got[0])}-${at(got[1])} px, expected ${at(want[0])}-${at(want[1])} px`)
    }
    const marks = []
    let traits
    if (c.kind === 'bars') {
      const values = c.rows.flatMap((r) => r.values)
      traits = [c.stack ? 'stacked' : 'grouped', ...(values.some((v) => v < 0) ? ['negative'] : []), ...(values.every((v) => v === 0) ? ['all-zero'] : []), ...(c.shared > 1 ? ['shared'] : [])]
      const f = (x) => (x - c.lo) / (c.hi - c.lo), base = Math.min(Math.max(0, c.lo), c.hi)
      const trs = [...el.tBodies].flatMap((b) => [...b.rows])
      let matched = 0
      trs.forEach((tr, r) => {
        let sum = 0
        ;[...tr.cells].slice(1).forEach((td, k) => {
          const v = c.rows[r].values[k]
          const [a, b] = c.stack ? [sum, (sum += v)] : [Math.min(base, v), Math.max(base, v)]
          const where = `row ${r + 1} col ${k + 1}`
          const bars = [...td.querySelectorAll('.plans-bar')].filter(has)
          matched += bars.length
          const track = bars.length === 1 && bars[0].parentElement.closest('.plans-track')
          if (bars.length !== 1) return geo(`${where} has ${bars.length} drawn bars, expected 1`)
          if (!track || !td.contains(track)) return geo(`${where} has its drawn bar outside a track in its cell`)
          const box = inner(track), rect = bars[0].getBoundingClientRect()
          edges(where, box, [rect.left, rect.right], span(box, f(a), f(b)))
          marks.push({ name: `the bar at ${where}`, rect })
          if (c.lo < 0) {
            const zero = [...track.querySelectorAll('.plans-zero')].filter(has)
            const z = zero.length === 1 && zero[0].getBoundingClientRect()
            const want = span(box, f(0), f(0))[0]
            if (!z) geo(`${where} has ${zero.length} zero lines, expected 1`)
            else if (Math.abs((z.left + z.right) / 2 - want) > box.s + 1e-6) geo(`${where} zero line drawn at ${px(((z.left + z.right) / 2 - box.l) / box.s)} px, expected ${px((want - box.l) / box.s)} px`)
          }
        })
      })
      const drawn = [...el.querySelectorAll('.plans-bar')].filter(has).length
      if (drawn > matched) geo(`${drawn - matched} drawn bars outside its value cells`)
    } else {
      traits = ['timeline']
      const f = (t) => (c.to === c.from ? 0.5 : (t - c.from) / (c.to - c.from))
      const track = el.previousElementSibling && el.previousElementSibling.matches('div.plans-track') ? el.previousElementSibling : null
      const bands = track ? [...track.children].filter((b) => b.matches('.plans-lane')) : []
      if (!track) geo('has no drawn track just before its list')
      else if (bands.length !== c.lanes.length) geo(`has ${bands.length} lane bands, expected ${c.lanes.length}`)
      const found = track ? [...track.querySelectorAll('.plans-mark')].filter(has) : []
      const byItem = new Map()
      for (const mk of found) {
        const j = mk.getAttribute('data-plans-item')
        const k = /^(0|[1-9]\d*)$/.test(j ?? '') && +j < c.items.length ? +j : -1
        if (!byItem.has(k)) byItem.set(k, [])
        byItem.get(k).push(mk)
      }
      if (byItem.has(-1)) geo(`${byItem.get(-1).length} drawn marks name no item`)
      const rowsOf = (band) => [...band.querySelectorAll('.plans-lane-row')]
      const first = bands.length && rowsOf(bands[0])[0] ? inner(rowsOf(bands[0])[0]) : null
      bands.forEach((band, k) => {
        const name = band.querySelector('.plans-lane-name')
        if (c.lanes[k] !== undefined && (name ? name.textContent.trim() : '') !== c.lanes[k]) geo(`lane ${k + 1} is labelled "${name ? name.textContent.trim() : ''}", expected "${c.lanes[k]}"`)
        rowsOf(band).forEach((row, r) => {
          const b = inner(row)
          if (first && (Math.abs(b.l - first.l) > first.s + 1e-6 || Math.abs(b.w - first.w) > first.s + 1e-6)) edges(`lane ${k + 1} row ${r + 1}`, first, [b.l, b.l + b.w], [first.l, first.l + first.w])
        })
      })
      // Each band's marks with their drawn boxes, for the packing replay.
      const placed = bands.map(() => [])
      c.items.forEach((it, j) => {
        const where = `item ${j + 1}`
        const list = byItem.get(j) ?? []
        if (list.length !== 1) return geo(`${where} has ${list.length} drawn marks, expected 1`)
        const mk = list[0], row = mk.parentElement && mk.parentElement.closest('.plans-lane-row')
        const lane = c.lanes.indexOf(it.lane), band = mk.closest('.plans-lane')
        if (!row || bands.indexOf(band) !== lane) return geo(`${where} drawn in lane ${bands.indexOf(band) + 1}, expected lane ${lane + 1}`)
        const box = inner(row), rect = mk.getBoundingClientRect()
        if (it.span) edges(where, box, [rect.left, rect.right], span(box, f(it.start), f(it.end)))
        else {
          const [x] = span(box, f(it.start), f(it.start)), half = (rect.right - rect.left) / 2
          edges(where, box, [rect.left, rect.right], [x - half, x + half])
        }
        marks.push({ name: `the mark of item ${j + 1}`, rect })
        placed[lane].push({ j, start: it.start, row: rowsOf(band).indexOf(row), l: rect.left, r: rect.right })
      })
      placed.forEach((list, k) => {
        if (!bands[k]) return
        const used = []
        list.sort((p, q) => p.start - q.start || p.j - q.j)
        for (const p of list) {
          let r = 0
          while (used[r] && used[r].some((q) => Math.min(q.r, p.r) - Math.max(q.l, p.l) > 0.5)) r++
          ;(used[r] = used[r] || []).push(p)
          if (p.row !== r) geo(`item ${p.j + 1} drawn in row ${p.row + 1} of lane ${k + 1}, expected row ${r + 1}`)
        }
        const n = rowsOf(bands[k]).length
        if (list.length === c.items.filter((it) => it.lane === c.lanes[k]).length && n !== used.length) geo(`lane ${k + 1} has ${n} rows, expected ${used.length}`)
      })
    }
    for (let a = 0; a < marks.length; a++) for (let b = a + 1; b < marks.length; b++) if (hit(marks[a].rect, marks[b].rect)) add('chart-overlap', `${marks[a].name} and ${marks[b].name} intersect`)
    // Text boxes: each text node's line boxes, the chart's own and a timeline's lane labels.
    const texts = []
    const lanes = c.kind === 'timeline' && el.previousElementSibling && el.previousElementSibling.matches('div.plans-track') ? [...el.previousElementSibling.querySelectorAll('.plans-lane-name')] : []
    for (const root of [el, ...lanes]) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if (t.data.trim() === '' || !t.parentElement || getComputedStyle(t.parentElement).visibility !== 'visible') continue
        const range = document.createRange()
        range.selectNodeContents(t)
        const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
        if (rects.length) texts.push({ name: JSON.stringify(t.data.trim().replace(/\s+/g, ' ').slice(0, 30)), rects })
      }
    }
    for (let a = 0; a < texts.length; a++) {
      for (let b = a + 1; b < texts.length; b++) {
        if (texts[a].rects.some((p) => texts[b].rects.some((q) => hit(p, q)))) add('chart-overlap', `${texts[a].name} and ${texts[b].name} intersect`)
      }
    }
    out.push(...mine)
    const n = c.kind === 'bars' ? `${c.rows.length * (c.rows[0] ? c.rows[0].values.length : 0)} bars` : `${c.items.length} marks`
    rows.push({ name: `chart: ${label} (${traits.join(', ')})`, result: mine.length ? 'fail' : 'pass', detail: mine.length ? mine[0].detail : `${n} within 1 px of their values, no overlap` })
  }
  return [...out, ...rows]
}

// The model, and each key button's index among the live `[data-base-key] button`, by switch, key
// and value.
function prep(source) {
  const pc = globalThis.plansCheck
  const m = pc.parts || (pc.parts = pc.model(source))
  const keyButtons = [...document.querySelectorAll('[data-base-key] button')]
  const boxes = document.querySelectorAll('[data-base-switch]')
  const buttons = m.switches.map((s) => {
    const groups = boxes[s.i] ? boxes[s.i].querySelectorAll('[data-base-key]') : []
    return s.keys.map((k, j) => (groups[j] ? [...groups[j].querySelectorAll('button')].map((b) => keyButtons.indexOf(b)) : []))
  })
  const count = (sel) => document.querySelectorAll(sel).length
  return { m, buttons, live: [count('[data-base-switch]'), count('[data-base-when]'), count('figure.pb-compare'), count('[data-base-chart]')] }
}

// Which panes, compare sides and switch boxes have a box, which panes a closed <details> inside
// their box hides, the largest named <details> group with a member in each pane and each side, and
// the focused key button. sides holds each compare's before and after, in document order.
function look() {
  const has = (el) => !!el && el.getClientRects().length > 0
  const size = (name) => [...document.querySelectorAll('details')].filter((d) => d.getAttribute('name') === name).length
  const group = (el) => Math.max(0, ...[...new Set([...el.querySelectorAll('details')].map((d) => d.getAttribute('name')).filter(Boolean))].map(size))
  return {
    panes: [...document.querySelectorAll('[data-base-when]')].map((p) => {
      let blocked = false
      for (let a = p.parentElement; a && !a.matches('[data-base-switch]'); a = a.parentElement) if (a.localName === 'details' && !a.open) blocked = true
      return { shown: has(p), blocked, group: group(p) }
    }),
    sides: [...document.querySelectorAll('figure.pb-compare')].flatMap((fig) => ['before', 'after'].map((s) => {
      const side = [...fig.children].find((c) => c.classList.contains('pb-side') && c.getAttribute('data-base-side') === s)
      return { shown: has(side), group: side ? group(side) : 0 }
    })),
    boxes: [...document.querySelectorAll('[data-base-switch]')].map(has),
    focus: [...document.querySelectorAll('[data-base-key] button')].indexOf(document.activeElement),
  }
}

// The member of its named <details> group that the i-th match of sel sits in, or 0. sel is a
// literal the walk wrote.
function memberOf(sel, i) {
  const box = document.querySelectorAll(sel)[i]
  const d = box && box.closest('details')
  const name = d && d.getAttribute('name')
  return name ? [...document.querySelectorAll('details')].filter((x) => x.getAttribute('name') === name).indexOf(d) : 0
}

// A compare's state: whether it and each side have a box, its content width, its switch and the
// switch's buttons as indexes among the live `.plans-compare-switch button`, and the pane holding it.
function compareLook(i) {
  const has = (el) => !!el && el.getClientRects().length > 0
  const fig = document.querySelectorAll('figure.pb-compare')[i]
  if (!fig) return null
  const kids = [...fig.children]
  const side = (s) => kids.find((c) => c.classList.contains('pb-side') && c.getAttribute('data-base-side') === s)
  const sw = kids.find((c) => c.classList.contains('plans-compare-switch'))
  const all = [...document.querySelectorAll('.plans-compare-switch button')]
  const button = (s) => (sw ? all.indexOf([...sw.children].find((b) => b.localName === 'button' && b.getAttribute('data-plans-side') === s)) : -1)
  const cs = getComputedStyle(fig)
  const width = fig.getBoundingClientRect().width - ['borderLeftWidth', 'borderRightWidth', 'paddingLeft', 'paddingRight'].reduce((t, k) => t + parseFloat(cs[k]), 0)
  const pane = fig.closest('[data-base-when]')
  return {
    shown: has(fig), width, made: !!sw, sw: has(sw), before: has(side('before')), after: has(side('after')),
    buttons: { before: button('before'), after: button('after') },
    pane: pane ? [...document.querySelectorAll('[data-base-when]')].indexOf(pane) : null,
  }
}

function hasPane(i) {
  const p = document.querySelectorAll('[data-base-when]')[i]
  return !!p && p.getClientRects().length > 0
}

/* ---------------------------------------------------------------- Node */

const KEY = '[data-base-key] button'
const SIDE = '.plans-compare-switch button'

export async function panes(drive) {
  const faults = [], steps = []
  const { m, buttons, live } = await drive.call(prep, drive.source)
  for (const detail of m.errors) faults.push({ kind: 'part-error', detail })
  const built = [m.switches.length, m.panes.length, m.compares.length, m.charts.length]
  if (live.join() !== built.join()) {
    steps.push({ name: 'panes: page', result: 'fail', detail: `the live page holds ${live.join(', ')} switches, panes, compares and charts, and the built bytes ${built.join(', ')}` })
    return { faults, steps }
  }
  const walkable = m.switches.filter((s) => s.ok)
  const combos = (s) => s.keys.reduce((p, k) => p * k.values.length, 1)
  for (const s of walkable) if (combos(s) > WALK.perSwitch) faults.push({ kind: 'base-state-budget', detail: `switch ${s.n}: ${combos(s)} combinations, limit ${WALK.perSwitch}` })
  const total = walkable.reduce((t, s) => t + combos(s), 0)
  if (total > WALK.perPage) faults.push({ kind: 'base-state-budget', detail: `page: ${total} combinations, limit ${WALK.perPage}` })
  if (faults.some((f) => f.kind === 'base-state-budget')) return { faults, steps }

  // The check's own record of each switch's values, from the clicks it made.
  const cur = new Map(walkable.map((s) => [s.i, s.keys.map((k) => k.initial)]))
  const broken = new Set()
  const seen = new Set()
  let prev = await drive.call(look)
  const rowName = (s, vals) => `panes: switch ${s.n} ${s.keys.map((k, j) => `${k.name}=${vals[j]}`).join(' ')}`
  const press = async (s, j, value) => {
    await drive.click({ kind: 'base', selector: KEY, index: buttons[s.i][j][s.keys[j].values.indexOf(value)] })
    cur.get(s.i)[j] = value
  }
  // Clicks s's buttons to reach vals. With force, a step that changes nothing still clicks once.
  const reach = async (s, vals, force = false) => {
    let clicked = false
    for (const [j, v] of vals.entries()) if (cur.get(s.i)[j] !== v) { await press(s, j, v); clicked = true }
    if (force && !clicked) await press(s, 0, vals[0])
  }
  const shows = (s, p) => [p, ...m.panes[p].within].every((x) => m.panes[x].terms.every(([k, v]) => cur.get(s.i)[s.keys.findIndex((key) => key.name === k)] === v))
  // Each pane a valid switch's terms decide, against the model and the record.
  const verify = (now) => {
    const wrong = []
    for (const s of walkable) {
      if (broken.has(s.i) || !now.boxes[s.i]) continue
      for (const p of s.panes) {
        const got = now.panes[p], want = shows(s, p)
        if (!got.blocked && got.shown !== want) wrong.push(`the pane "${m.panes[p].when}" ${got.shown ? 'has a box' : 'has no box'}, but the model ${want ? 'shows' : 'hides'} it`)
      }
    }
    return wrong
  }
  // The probes of one step, named <details> groups in panes and compare sides it revealed probed
  // member by member. Returns the faults no earlier probe of this state found, for the row's detail.
  const probeStep = async (now) => {
    const fresh = []
    const run = async () => { for (const f of await drive.probe()) { const k = `${f.kind}\0${f.detail}`; if (!seen.has(k)) { seen.add(k); fresh.push(f) } } }
    const revealed = (list, was) => list.filter((x, i) => x.shown && !was[i].shown)
    const group = Math.max(0, ...[...revealed(now.panes, prev.panes), ...revealed(now.sides, prev.sides)].map((x) => x.group))
    if (group > 1) {
      for (let k = group - 1; k >= 1; k--) { await drive.openDetails(k); await drive.settle(); await run() }
      await drive.openDetails(0)
      await drive.settle()
    }
    await run()
    prev = now
    return fresh.length ? `new in this step: ${fresh.slice(0, 3).map((f) => `${f.kind} (${clip(f.detail, 100)})`).join('; ')}` : ''
  }
  // One step: act, settle, assert the panes and anything `extra` asserts, probe. Returns whether
  // it passed. A miss is a failed row and closes any dialog; anything else is the checker's own.
  const step = async (name, act, extra = () => '') => {
    try {
      await act()
      await drive.settle()
      const now = await drive.call(look)
      const wrong = [...verify(now), await extra(now)].filter(Boolean)
      const found = await probeStep(now)
      steps.push({ name, result: wrong.length ? 'fail' : 'pass', detail: wrong.length ? wrong.join('; ') : found })
      return !wrong.length
    } catch (e) {
      if (!drive.missed(e)) throw e
      steps.push({ name, result: 'fail', detail: e.message })
      await drive.closeDialogs()
      return false
    }
  }
  // After a failed step: back to the defaults, and the switch leaves later assertions.
  const giveUp = async (s) => {
    broken.add(s.i)
    try { await reach(s, s.keys.map((k) => k.initial)) } catch (e) { if (!drive.missed(e)) throw e }
  }

  await probeStep(prev)
  for (const s of walkable) {
    const member = await drive.call(memberOf, '[data-base-switch]', s.i)
    if (member > 0) { await drive.openDetails(member); await drive.settle(); prev = await drive.call(look) }
    let ok = true
    const all = s.keys.reduce((list, k) => list.flatMap((vals) => k.values.map((v) => [...vals, v])), [[]])
    for (const vals of all) if (ok) ok = await step(rowName(s, vals), () => reach(s, vals, true))
    for (const [j, k] of s.keys.entries()) {
      if (!ok) break
      const at = k.values.indexOf(cur.get(s.i)[j]), next = k.values[(at + 1) % k.values.length]
      const target = buttons[s.i][j][(at + 1) % k.values.length]
      const on = (focus) => { const v = buttons[s.i][j].indexOf(focus); return v === -1 ? 'off this key' : `on the "${k.values[v]}" button` }
      ok = await step(`panes: switch ${s.n} ${k.name} arrow`, async () => {
        await press(s, j, k.values[at])
        await drive.key('ArrowRight')
        cur.get(s.i)[j] = next
      }, (now) => (now.focus === target ? '' : `ArrowRight from "${k.values[at]}" left focus ${on(now.focus)}, not on the "${next}" button`))
    }
    if (!ok) await giveUp(s)
    else {
      try { await reach(s, s.keys.map((k) => k.initial)) } catch (e) {
        if (!drive.missed(e)) throw e
        steps.push({ name: rowName(s, s.keys.map((k) => k.initial)), result: 'fail', detail: `back to the defaults: ${e.message}` })
        await giveUp(s)
      }
    }
    if (member > 0) { await drive.openDetails(0); await drive.settle() }
    prev = await drive.call(look)
  }

  // One compare. It returns at the first failed step, so the walk goes on to the next part.
  const driveCompare = async (c) => {
    const n = c.i + 1
    const rows = (detail) => { for (const side of ['before', 'after']) steps.push({ name: `panes: compare ${n} ${side}`, result: 'fail', detail }) }
    let info = await drive.call(compareLook, c.i)
    // A compare in a hidden pane: reveal() clicks that pane's terms, and the record follows.
    const s = c.pane !== null ? walkable.find((x) => x.i === m.panes[c.pane].box) : null
    if (info && !info.shown && s && !broken.has(s.i)) {
      try {
        await reveal(drive, c.pane)
        for (const x of [c.pane, ...m.panes[c.pane].within]) for (const [k, v] of m.panes[x].terms) cur.get(s.i)[s.keys.findIndex((key) => key.name === k)] = v
      } catch (e) {
        if (!drive.missed(e)) throw e
        steps.push({ name: `panes: compare ${n} before`, result: 'fail', detail: `revealing its pane: ${e.message}` })
        await drive.closeDialogs()
        return giveUp(s)
      }
      info = await drive.call(compareLook, c.i)
    }
    if (!info || !info.shown) return rows('the compare has no box to drive')
    // Under 640 px of content box the switch shows and one side at a time; at 640 and up, both
    // sides and no switch. Within a pixel of 640 the check follows the switch.
    const narrow = info.width < 639 || (info.width <= 641 && info.sw)
    if (narrow !== info.sw) return rows(`the compare is ${info.width.toFixed(1)} px wide, ${narrow ? 'under 640, and shows no switch' : '640 or more, and still shows its switch'}`)
    const sides = (want) => async () => {
      info = await drive.call(compareLook, c.i)
      const word = (b) => (b ? 'has a box' : 'has no box')
      return info.before === want.before && info.after === want.after ? '' : `before ${word(info.before)} and after ${word(info.after)}, expected ${want.before ? 'shown' : 'hidden'} and ${want.after ? 'shown' : 'hidden'}`
    }
    for (const side of ['before', 'after']) {
      const act = narrow ? () => drive.click({ kind: 'base', selector: SIDE, index: info.buttons[side] }) : async () => {}
      if (!(await step(`panes: compare ${n} ${side}`, act, sides(narrow ? { before: side === 'before', after: side === 'after' } : { before: true, after: true })))) return
    }
  }
  for (const c of m.compares.filter((x) => x.ok)) {
    const member = await drive.call(memberOf, 'figure.pb-compare', c.i)
    if (member > 0) { await drive.openDetails(member); await drive.settle() }
    await driveCompare(c)
    if (member > 0) { await drive.openDetails(0); await drive.settle() }
    prev = await drive.call(look)
  }

  // The final display step: every switch on its last combination.
  const last = walkable.filter((s) => !broken.has(s.i))
  if (last.length) {
    const missed = new Map()
    for (const s of last) {
      try { await reach(s, s.keys.map((k) => k.values.at(-1)), true) } catch (e) {
        if (!drive.missed(e)) throw e
        missed.set(s.i, e.message)
        broken.add(s.i)
      }
    }
    await drive.closeDialogs()
    await drive.settle()
    const now = await drive.call(look)
    const found = await probeStep(now)
    for (const s of last) {
      const name = rowName(s, s.keys.map((k) => k.values.at(-1)))
      if (missed.has(s.i)) { steps.push({ name, result: 'fail', detail: `the final step: ${missed.get(s.i)}` }); continue }
      const wrong = verify({ ...now, boxes: now.boxes.map((b, i) => b && i === s.i) })
      steps.push({ name, result: wrong.length ? 'fail' : 'pass', detail: wrong.length ? `the final step: ${wrong.join('; ')}` : found })
    }
  }
  return { faults, steps }
}

export async function reveal(drive, paneIndex) {
  const { m, buttons } = await drive.call(prep, drive.source)
  const p = m.panes[paneIndex]
  const s = p && p.box !== null ? m.switches[p.box] : null
  if (s && s.ok) {
    for (const x of [...p.within].reverse().concat(paneIndex)) {
      for (const [k, v] of m.panes[x].terms) {
        const j = s.keys.findIndex((key) => key.name === k)
        await drive.click({ kind: 'base', selector: KEY, index: buttons[s.i][j][s.keys[j].values.indexOf(v)] })
      }
    }
    await drive.settle()
  }
  return drive.call(hasPane, paneIndex)
}
