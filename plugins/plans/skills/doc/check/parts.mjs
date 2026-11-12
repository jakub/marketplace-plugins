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
//       panes: [{ i, box, when, terms: [[key, value]], within: [i] }],
//       compares: [{ i, ok, pane, charts: [i] }],
//       charts: [{ i, n, kind, caption, unit, stack, min, max, from, to, box, rows: [{ status,
//                  values }], items: [{ lane, start, end, span }], ok, lo, hi, shared, group,
//                  lanes, label }],
//       errors: [detail] }
//     i is the document-order index among [data-base-switch], [data-base-when], figure.pb-compare
//     or [data-base-chart], outside <template> and <noscript>, and n is i + 1, as the kit numbers
//     its log lines. A live element is the one at the same index in the page. box is the index of
//     the switch that holds the pane or chart, or null; within lists the panes of the same switch
//     that hold the pane. A compare's charts are those it is the nearest compare of, its pane the
//     pane that holds it. min and max are the stated bounds, lo and hi the scale the chart draws on
//     after its share group (ruling 3), shared the size of that group and group its index among
//     the page's groups, null for a chart in none, from and to the timeline's domain, times UTC
//     ms. label names the chart in the oracle's rows and faults, as its header says. ok is
//     false for a part with a markup error, whose detail is in errors as `<part>: <what>`, the part
//     being switch, compare, bars, timeline or markup. The model is this file's own reading of the
//     markup, built from parts.md and the rulings, and never from what the kit wrote.
//   panes(drive)             the `panes` state, below. Returns { faults, steps }.
//   chartFaults(source, readings)  in-page, after every probe in every state of a page whose
//                            bytes hold a chart: the oracle, below. Returns faults and `chart: …`
//                            rows. With readings true, the panes walk's call, it returns each
//                            measured bars chart's { i, box, tracks: [{ where, w }], even }
//                            instead, in CSS px, even being the oracle's own track rule.
//   expose(drive, target)    makes a target reachable whatever hides it, below. target is a base
//                            click spec without its kind, { selector, index }, and keep, the part
//                            whose walk reads it, or none. Returns { ok, changes, hidden }.
//   restore(drive, changes)  puts back what expose() changed. Returns { undone, failed }.
//   exposures(drive, track)  one part's or one chrome row's exposures, below. Returns { show,
//                            tap, read, unwind, size }.
//
// expose. Three containers can hide what the check clicks or measures: a closed <details>, such as
// a named group's member other than the open one; a pane of a switch whose pressed buttons don't
// match its terms; and the side a compare under 640 px doesn't show. They nest in any order and to
// any depth, around a part and inside one: between a switch's box and its key buttons or its
// panes, or between a pane and a chart. So the check never reveals a part as a whole. The element
// it clicks or measures is the target: a key button, a pane, a compare's figure, sides and switch
// buttons, a chart, a zoom button, a chrome control, the element the dock watches and each listed
// section. expose() reads the target's chain of containers from the page with hiders(), outermost
// first and the target itself included, and with the model for a pane's terms. An element shows
// when it has client rects and checkVisibility() holds, since a closed <details> skips its
// content with content-visibility rather than taking its boxes away. For each container that
// hides its content it clicks the controls that show it, with real input through drive.click: the
// details' summary (or the details itself, when the browser draws the summary), the key buttons
// for the pane's terms that aren't pressed, the compare switch's button for the side. Each control
// has a box by then, since the containers outside it already show and none inside them holds it:
// a details' summary is its own child; a compare's switch buttons are made by script in the
// figure, outside both sides; and no pane, details or compare sits between a key button and its
// switch's box, since the model refuses a switch with one there, whose keys go unclicked. A
// control without a box is not clicked: that container is the one that stayed hidden. After each
// container it settles and reads the chain again, and the container must now show. ok false names
// that container in hidden, as `<container> is hidden, and …` or `<container> stayed hidden after
// a click on its …`, with changes holding what was clicked so far; a caller makes it a failed row,
// so part-drive. A click that misses is the same, never a thrown step failure. Without keep the
// target itself must then show. changes lists each click as { kind, label, back, pane, open }:
// back is the base spec that undoes it, or null (a details, or a pane whose key had no single
// pressed button), pane is { s, j, from, to } for a key button, the switch's model index, the
// key's index and the values, else null, and open is { d, was } for a details, the indexes of the
// details it opened and of its group's member that was open (-1 for none), else null. restore()
// puts each change back, innermost first, settles, and returns the changes it undid with '' or
// what failed. It clicks each back, beside the control expose() clicked, since a key or a side
// needs the kit's handlers. A details goes back through the open property instead: the member it
// reopens can sit under a container that hides it, such as another switch's pane, and a put-back
// proves nothing about the reader, only returns state the check changed.
//   keep is { s } for a switch's walk and { c } for a compare's. Its own containers, the switch's
// panes or the compare's sides, are never exposed: expose() stops at the first one that hides,
// since the walk's condition decides it. An element is expected to have a box when each own
// container in its chain meets that condition, a pane's terms against the walk's record of its
// switch, a side under 640 px being the one the walk picked, and every other container in it
// shows: one chain, read once, gives both the exposure and the expectation.
//   exposures() keeps what one part's walk or one chrome row exposed. tap() exposes a control just
// before its click and returns '' or what failed, `revealing <what>: <hidden>`, or the click's own
// failure. read() reads a list of matches in one call and exposes, just before its reading, each
// one whose outermost hidden container isn't keep's own, then reads the rest again. Since every
// click and reading exposes its own target, one that a later exposure hid is exposed again.
// unwind() puts every change back once, at the part's or the row's end, innermost first.
//
// panes. The model's errors are part-error faults. Budget: a valid switch has as many combinations
// as the product of its keys' value counts, over 16 is base-state-budget `switch <n>: <k>
// combinations, limit 16`, and over 64 across the page is `page: <k> combinations, limit 64`;
// either one stops the walk before it starts. Otherwise, after a first probe of the state as it
// loaded, each valid switch in document order, with every other switch at its defaults: every
// combination of its own keys, values in written order, each reached by real clicks on the key
// buttons, each tapped (the first one clicks a button even when nothing has to change), then for
// each key the pressed button tapped to focus it and ArrowRight pressed once, which must move
// focus to the next button, wrapping, and pick it; then taps back to its defaults, and its
// exposures unwound. Then each valid compare: its figure exposed and measured; where its content
// box is under 640 px its switch must show, and its before and after buttons are tapped in turn,
// each showing its own side alone; where it is 640 px or wider, no switch shows and both sides
// must; then its exposures unwound. Last, the final display step taps each switch onto its last
// combination, asserts its panes while its exposures stand, and unwinds them, so the state's
// screenshot shows every container as it loaded and every switch on its last combination. The
// walk's record of each switch's values follows every key button a tap or a put-back clicked.
//   After each action the step settles and reads. A switch's step reads each of its panes, then
// each of its charts, through read() with keep the switch, and each must have a box exactly when
// its chain says; a compare's step does the same for its two sides and the charts it is the
// nearest compare of. An arrow step reads focus first, since a click in an exposure moves it.
// Then every pane of every walkable switch is read as it stands and held to its chain the same
// way, so a step that shows or hides another switch's pane fails. Then it probes, with the charts
// it exposed in reach of the oracle and the track readings. A named <details> group with a member
// inside a pane or a compare side that the step or its exposures revealed is probed once per
// member, last member first, and then put back to the member it had open (ruling 11). A step
// row's result is its drive and its box assertions; what the probes found joins the cell as its
// own faults, and the row's detail names the faults no earlier probe of the state found, so the
// step that first showed a fault says so. A failed step, a tap that missed or a wrong box, ends
// that part: the walk closes any dialog, tries to put the switch back at its defaults, leaves the
// switch out of later pane assertions and the final step, and goes on to the next part. A target
// that stays hidden fails its row: `revealing its <key>=<value> button: <hidden>` for a key,
// `revealing it: <hidden>` for both rows of a compare whose figure stayed hidden, `the pane
// "<when>": <hidden>` or `<chart>: <hidden>` for a reading, and `the final step: …` there.
//   A shared scale only holds if one value draws at one length across the panes. On a page with a
// share group of two or more charts, each step, after its probes, takes the oracle's track
// readings. At the end of the walk, two charts of one share group, each even within itself in
// every reading (the oracle's rule, which reports the uneven ones itself), whose boxes had the
// same width within 0.5 CSS px, must have had tracks within 1 CSS px of each other, or the later
// one in document order is chart-geometry `<chart>: row <r> col <k> track <a> px, and <other
// chart> in its share group has <b> px`.
//
// The oracle. For each valid chart with a box, from the model's rows and items, never the live
// ones: bars are matched by row and column, one drawn .plans-bar with a box per value cell,
// measured against its .plans-track's padding box; timeline marks by data-plans-item, one
// .plans-mark with a box per item, measured against the .plans-lane-row that holds it. A value cell
// or an item with no live counterpart, at the same row and column of the live table or the same
// index in the live list, is chart-geometry `<chart>: row <r> col <c> is not in the page's table`
// (or `item <n> is not in the page's list`), and so is a missing or extra mark. The expected extent
// comes from the model's raw values: f(x) = (x - lo) / (hi - lo), a grouped bar from f(min(b, v))
// to f(max(b, v)) with b the zero clamped to [lo, hi], a stacked segment from f(sum before) to
// f(sum through), a point centred on f(t) and a span from f(start) to f(end), with f(t) = 0.5 over
// a zero-width domain, all mirrored in right-to-left. A drawn edge more than 1 CSS px from its
// expected edge is chart-geometry `<chart>: row <r> col <c> drawn <a>-<b> px, expected <x>-<y> px`
// (or `item <n>`), in px from the reference box's start. Since each bar is measured against its
// own track, one value draws at one length only if every drawn track of a bars chart has one
// width: its widest and narrowest tracks, by computed width, more than 1 CSS px apart are
// chart-geometry `<chart>: row <r> col <k> track <a> px, and row <r> col <k> has <b> px`, naming
// the later of the two, in every state and view. Each track of a chart whose scale holds 0 needs
// one zero line, at f(0), and each track of one whose scale doesn't needs none. Timeline bands
// follow the lanes in order of first use, each labelled with its lane's name, every lane row spans the first one's box, and each mark's row is
// replayed: first fit per band over the drawn boxes, by start then source order, overlap meaning
// more than 0.5 px, with no row left empty. Two marks of one chart, or two text boxes of one chart
// (its text nodes and a timeline's lane labels), that intersect by more than 0.5 CSS px on both
// axes are chart-overlap `<chart>: <a> and <b> intersect`. Each kind is reported at most 4 times
// per chart per call. Each chart measured gets the row `chart: <label> (<traits>)`, fail with its
// first fault or pass, a pass naming the bars or marks it measured: label is the chart's caption (its table's <caption>, else its figure's
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
      // One walk from each of the key's buttons, the button itself included: a pane anywhere on it,
      // or a details or a compare below the box, is the key's one error. Those are the containers
      // hiders() knows, so none sits between a key button and the box of a switch that passes.
      let hold = null
      for (const b of bs) {
        for (let a = b, inside = true; a && !hold; a = a.parentElement) {
          if (a === box) inside = false
          if (a.matches('[data-base-when]') || (inside && a.matches('details, figure.pb-compare'))) hold = a
        }
      }
      if (hold && hold.matches('[data-base-when]')) no(`key "${name}" sits in a pane`)
      else if (hold) no(`key "${name}" sits inside a ${hold.localName === 'details' ? 'details' : 'compare'} in its switch`)
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
    return { i, ok, pane: paneOf(fig), charts: [] }
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
      from: null, to: null, box: boxEl ? boxes.indexOf(boxEl) : null, rows: [], items: [], ok: true, lo: null, hi: null, shared: 1, group: null, lanes: [] }
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
    const near = el.closest('figure.pb-compare')
    if (near) compares[compareEls.indexOf(near)].charts.push(i)
    return c
  })
  const captions = charts.map((c) => c.caption)
  for (const c of charts) c.label = c.caption && captions.indexOf(c.caption) === captions.lastIndexOf(c.caption) ? (c.caption.length > 60 ? c.caption.slice(0, 59) + '…' : c.caption) : `chart ${c.n}`

  // Share groups: valid bars charts in one switch with one non-empty unit and one layout, stacked
  // or side by side, since a row sum and a single value never compare bar for bar. The first
  // stated bound in the group is the group's, every other stated one must equal it, and with none
  // stated the group spans every member's values, or row sums when stacked, and 0 (ruling 3).
  const groups = []
  for (const c of charts) {
    if (c.kind !== 'bars' || !c.ok) continue
    c.vals = c.stack ? c.rows.map((r) => r.values.reduce((a, b) => a + b, 0)) : c.rows.flatMap((r) => r.values)
    const g = c.box !== null && c.unit ? groups.find((x) => x[0].box === c.box && x[0].unit === c.unit && x[0].stack === c.stack) : null
    if (g) g.push(c)
    else groups.push([c])
  }
  for (const [k, g] of groups.entries()) {
    const s0 = g.find((c) => c.min !== null), s1 = g.find((c) => c.max !== null)
    const lo = s0 ? s0.min : Math.min(...g.map((c) => Math.min(0, ...c.vals)))
    const hi = s1 ? s1.max : Math.max(...g.map((c) => Math.max(0, ...c.vals))) || (lo ? 0 : 1)
    for (const c of g) {
      c.shared = g.length
      c.group = k
      const bad = (what) => { c.ok = false; err(`bars: chart ${c.n} ${what}`) }
      if ((s0 && c.min !== null && c.min !== lo) || (s1 && c.max !== null && c.max !== hi)) bad('states a bound its share group contradicts')
      else if (!(lo < hi) || c.vals.some((v) => v < lo || v > hi)) bad(`has a ${c.stack ? 'row sum' : 'value'} outside ${lo} to ${hi}`)
      else { c.lo = lo; c.hi = hi }
      delete c.vals
    }
  }
  return { switches, panes, compares, charts, errors }
}

// The oracle. Its header is above, with the file's. With readings true it returns the track
// readings the panes walk compares across a share group instead of faults and rows.
export function chartFaults(source, readings = false) {
  const pc = globalThis.plansCheck
  const m = pc.parts || (pc.parts = pc.model(source))
  const out = m.errors.map((detail) => ({ kind: 'part-error', detail }))
  const rows = [], read = []
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
  for (const c of m.charts) {
    const el = els[c.i]
    if (!c.ok || !has(el) || (readings && c.kind !== 'bars')) continue
    const label = c.label
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
    let traits, measured = 0
    if (c.kind === 'bars') {
      const values = c.rows.flatMap((r) => r.values)
      traits = [c.stack ? 'stacked' : 'grouped', ...(values.some((v) => v < 0) ? ['negative'] : []), ...(values.every((v) => v === 0) ? ['all-zero'] : []), ...(c.shared > 1 ? ['shared'] : [])]
      const f = (x) => (x - c.lo) / (c.hi - c.lo), base = Math.min(Math.max(0, c.lo), c.hi)
      // Each track's zero lines: one where the scale holds 0, as parts.md says, and none elsewhere.
      const zeros = c.lo <= 0 && c.hi >= 0 ? 1 : 0
      const trs = [...el.tBodies].flatMap((b) => [...b.rows])
      // One value draws at one length only if every drawn track of the chart has one width: the
      // widest and the narrowest more than 1 CSS px apart is the chart's one fault, naming the
      // later of the two. Widths are read from computed style, in CSS px.
      const tracks = []
      trs.forEach((tr, r) => [...tr.cells].slice(1).forEach((td, k) => {
        for (const t of td.querySelectorAll('.plans-track')) if (has(t)) tracks.push({ where: `row ${r + 1} col ${k + 1}`, w: parseFloat(getComputedStyle(t).width) })
      }))
      let lo = 0, hi = 0
      tracks.forEach((t, k) => { if (t.w < tracks[lo].w) lo = k; if (t.w > tracks[hi].w) hi = k })
      const even = !tracks.length || tracks[hi].w - tracks[lo].w <= 1
      if (readings) {
        if (tracks.length) read.push({ i: c.i, box: parseFloat(getComputedStyle(el).width), tracks, even })
        continue
      }
      if (!even) {
        const [a, b] = [tracks[Math.min(lo, hi)], tracks[Math.max(lo, hi)]]
        geo(`${b.where} track ${px(b.w)} px, and ${a.where} has ${px(a.w)} px`)
      }
      let matched = 0
      c.rows.forEach((row, r) => {
        let sum = 0
        row.values.forEach((v, k) => {
          const [a, b] = c.stack ? [sum, (sum += v)] : [Math.min(base, v), Math.max(base, v)]
          const where = `row ${r + 1} col ${k + 1}`
          const td = trs[r] && trs[r].cells[k + 1]
          if (!td) return geo(`${where} is not in the page's table`)
          const bars = [...td.querySelectorAll('.plans-bar')].filter(has)
          matched += bars.length
          const track = bars.length === 1 && bars[0].parentElement.closest('.plans-track')
          if (bars.length !== 1) return geo(`${where} has ${bars.length} drawn bars, expected 1`)
          if (!track || !td.contains(track)) return geo(`${where} has its drawn bar outside a track in its cell`)
          const box = inner(track), rect = bars[0].getBoundingClientRect()
          edges(where, box, [rect.left, rect.right], span(box, f(a), f(b)))
          measured++
          marks.push({ name: `the bar at ${where}`, rect })
          const zero = [...track.querySelectorAll('.plans-zero')].filter(has)
          if (zero.length !== zeros) geo(`${where} has ${zero.length} zero lines, expected ${zeros}`)
          else if (zeros) {
            const z = zero[0].getBoundingClientRect(), want = span(box, f(0), f(0))[0]
            if (Math.abs((z.left + z.right) / 2 - want) > box.s + 1e-6) geo(`${where} zero line drawn at ${px(((z.left + z.right) / 2 - box.l) / box.s)} px, expected ${px((want - box.l) / box.s)} px`)
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
      const lis = [...el.children]
      c.items.forEach((it, j) => {
        const where = `item ${j + 1}`
        if (!lis[j]) return geo(`${where} is not in the page's list`)
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
        measured++
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
    const n = `${measured} ${c.kind === 'bars' ? 'bars' : 'marks'}`
    rows.push({ name: `chart: ${label} (${traits.join(', ')})`, result: mine.length ? 'fail' : 'pass', detail: mine.length ? mine[0].detail : `${n} within 1 px of their values, no overlap` })
  }
  return readings ? read : [...out, ...rows]
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

// The key button that has focus, as its index among the live `[data-base-key] button`, or -1.
function focusKey() { return [...document.querySelectorAll('[data-base-key] button')].indexOf(document.activeElement) }

// The named <details> groups with a member inside the given panes, by index among
// [data-base-when], or compare sides, by index among `figure.pb-compare > .pb-side`. With arg
// null, returns { size, open }: the largest group's size and the index of each group's open
// member by name, -1 for none. With a number k, opens member k of each group that has one. With an
// open map, puts each group back to that member.
function members(paneIdx, sideIdx, arg) {
  const panes = document.querySelectorAll('[data-base-when]')
  const sides = document.querySelectorAll('figure.pb-compare > .pb-side')
  const regions = [...paneIdx.map((i) => panes[i]), ...sideIdx.map((i) => sides[i])].filter(Boolean)
  const names = [...new Set(regions.flatMap((r) => [...r.querySelectorAll('details')].map((d) => d.getAttribute('name')).filter(Boolean)))]
  const all = [...document.querySelectorAll('details')]
  const group = (name) => all.filter((d) => d.getAttribute('name') === name)
  if (arg === null) return { size: Math.max(0, ...names.map((n) => group(n).length)), open: Object.fromEntries(names.map((n) => [n, group(n).findIndex((d) => d.open)])) }
  for (const n of names) {
    const ms = group(n)
    const k = typeof arg === 'number' ? arg : arg[n] ?? -1
    if (k >= 0 && k < ms.length) ms[k].open = true
    else if (typeof arg !== 'number') for (const d of ms) d.open = false
  }
  return null
}

// A compare's state: whether it has a box, its content width, whether its switch has one, the
// switch's buttons as indexes among the live `.plans-compare-switch button`, and its before and
// after sides as indexes among `figure.pb-compare > .pb-side`.
function compareLook(i) {
  const has = (el) => !!el && el.getClientRects().length > 0 && el.checkVisibility()
  const fig = document.querySelectorAll('figure.pb-compare')[i]
  if (!fig) return null
  const kids = [...fig.children]
  const side = (s) => kids.find((c) => c.classList.contains('pb-side') && c.getAttribute('data-base-side') === s)
  const sw = kids.find((c) => c.classList.contains('plans-compare-switch'))
  const all = [...document.querySelectorAll('.plans-compare-switch button')]
  const sideEls = [...document.querySelectorAll('figure.pb-compare > .pb-side')]
  const button = (s) => (sw ? all.indexOf([...sw.children].find((b) => b.localName === 'button' && b.getAttribute('data-plans-side') === s)) : -1)
  const cs = getComputedStyle(fig)
  const width = fig.getBoundingClientRect().width - ['borderLeftWidth', 'borderRightWidth', 'paddingLeft', 'paddingRight'].reduce((t, k) => t + parseFloat(cs[k]), 0)
  return { shown: has(fig), width, made: !!sw, sw: has(sw), buttons: { before: button('before'), after: button('after') },
    sides: { before: sideEls.indexOf(side('before')), after: sideEls.indexOf(side('after')) } }
}

// The containers that can hide a match of sel, outermost first, the element itself included: a
// <details> whose own summary doesn't hold the element, a [data-base-when] pane, and a compare's
// .pb-side. Each comes with whether it shows its content now, the controls that show it, each a
// base click spec with whether it has a box, and back, the spec that puts it as it was, or null.
// A details' control is its summary, or the details itself when it has none, whose box is then the
// browser's own summary; it has no back, and carries d, its index among the page's details, and
// was, the index of the member of its group that was open, or -1. A pane's controls are the key buttons its terms name that aren't
// pressed, each with the one pressed now as back, and the pane carries s, its switch's model
// index, and p, its own. A side's control is its button in the compare's switch, back the button
// of the side the compare showed, and the side carries c, its compare's index, and side, before or
// after. Returns { shown, chain } for match which, a list of them for a list of indexes, or one
// for every match when which is null; null for an index the page has no match at. An element or a
// pane or side shows when it has client rects and checkVisibility() holds. sel is a literal the
// caller wrote.
function hiders(sel, which) {
  const pc = globalThis.plansCheck
  const m = pc.parts || (pc.parts = pc.model(pc.source))
  const has = (x) => !!x && x.getClientRects().length > 0 && x.checkVisibility()
  const all = (s, root = document) => [...root.querySelectorAll(s)]
  const SUMMARY = 'details > summary:first-of-type', KEY = '[data-base-key] button', SIDE = '.plans-compare-switch button'
  const summaries = all(SUMMARY), details = all('details'), keys = all(KEY), sides = all(SIDE)
  const panes = all('[data-base-when]'), boxes = all('[data-base-switch]'), figs = all('figure.pb-compare')
  const spec = (selector, list, x) => (list.indexOf(x) < 0 ? null : { selector, index: list.indexOf(x) })
  const summaryOf = (d) => [...d.children].find((c) => c.localName === 'summary')
  const read = (el) => {
    const chain = []
    for (let a = el; a; a = a.parentElement) {
      if (a.localName === 'details') {
        const s = summaryOf(a)
        if (s && s.contains(el)) continue
        const name = a.getAttribute('name')
        const group = name ? details.filter((d) => d.getAttribute('name') === name) : [a]
        const was = group.find((d) => d.open && d !== a)
        chain.unshift({ kind: 'details', label: name ? `member ${group.indexOf(a) + 1} of the details group "${name}"` : `details ${details.indexOf(a) + 1}`, shown: a.open,
          controls: [{ what: s ? 'summary' : 'details', spec: s ? spec(SUMMARY, summaries, s) : spec('details', details, a), box: has(s || a) }],
          back: null, d: details.indexOf(a), was: details.indexOf(was) })
      } else if (a.matches('[data-base-when]')) {
        const p = m.panes[panes.indexOf(a)], s = p && p.box !== null ? m.switches[p.box] : null
        const groups = s && boxes[s.i] ? all('[data-base-key]', boxes[s.i]) : []
        const button = (j, v) => (groups[j] ? all('button', groups[j])[s.keys[j].values.indexOf(v)] : undefined)
        const controls = []
        for (const [key, v] of s && s.ok ? p.terms : []) {
          const j = s.keys.findIndex((x) => x.name === key)
          const on = groups[j] ? all('button[aria-pressed="true"]', groups[j]) : []
          const from = on.length === 1 ? on[0].getAttribute('value') : null
          if (from === v) continue
          const b = button(j, v)
          controls.push({ what: `${key}=${v} button`, spec: spec(KEY, keys, b), box: has(b), back: from === null ? null : spec(KEY, keys, button(j, from)), pane: { s: s.i, j, from, to: v } })
        }
        chain.unshift({ kind: 'pane', label: `the pane "${a.getAttribute('data-base-when')}"${s ? ` of switch ${s.n}` : ''}`, shown: has(a), ok: !!s && s.ok, s: s ? s.i : null, p: panes.indexOf(a), controls })
      } else if (a.matches('.pb-side') && a.parentElement && a.parentElement.matches('figure.pb-compare')) {
        const fig = a.parentElement
        const sw = [...fig.children].find((c) => c.classList.contains('plans-compare-switch'))
        const button = (side) => (sw ? [...sw.children].find((b) => b.localName === 'button' && b.getAttribute('data-plans-side') === side) : undefined)
        const side = a.getAttribute('data-base-side'), was = fig.getAttribute('data-plans-side')
        chain.unshift({ kind: 'side', label: `the ${side} side of compare ${figs.indexOf(fig) + 1}`, shown: has(a), c: figs.indexOf(fig), side,
          controls: [{ what: 'switch button', spec: spec(SIDE, sides, button(side)), box: has(button(side)) }],
          back: was && was !== side ? spec(SIDE, sides, button(was)) : null })
      }
    }
    return { shown: has(el), chain }
  }
  const els = all(sel)
  if (which === null) return els.map(read)
  if (Array.isArray(which)) return which.map((i) => (els[i] ? read(els[i]) : null))
  return els[which] ? read(els[which]) : null
}

/* ---------------------------------------------------------------- Node */

const KEY = '[data-base-key] button'
const SIDE = '.plans-compare-switch button'
const PANE = '[data-base-when]'
const SIDE_EL = 'figure.pb-compare > .pb-side'
const CHART = '[data-base-chart]'
const FIG = 'figure.pb-compare'

// Whether a container in a chain is the part's own, whose walk's condition decides whether it
// shows: a pane of the switch keep.s, or a side of the compare keep.c.
const ownOf = (keep, c) => !!keep && ((c.kind === 'pane' && c.s === keep.s) || (c.kind === 'side' && c.c === keep.c))

// The readings chartFaults(source, true) made at each step, as a Map of chart index to [{ box,
// tracks, even }]. Whether a chart's tracks are even within it is the oracle's rule, which also
// reports the uneven ones, so here a chart even in every reading is held to each earlier even
// chart of its share group, in document order, at the same box width within 0.5 px, and its first
// track more than 1 px off a track of the other is its one fault.
function shareFaults(m, widths) {
  const faults = []
  const w = (t) => t.w.toFixed(1)
  const even = (c) => widths.has(c.i) && widths.get(c.i).every((r) => r.even)
  for (const c of m.charts) {
    let off = null
    for (const o of m.charts) {
      if (off || o.i >= c.i || !even(c) || !even(o) || o.group !== c.group) continue
      for (const a of widths.get(c.i)) {
        for (const b of widths.get(o.i)) {
          if (Math.abs(a.box - b.box) > 0.5) continue
          for (const t of a.tracks) {
            const u = b.tracks.find((u) => Math.abs(t.w - u.w) > 1)
            if (u) { off = { o, t, u }; break }
          }
          if (off) break
        }
        if (off) break
      }
    }
    if (off) faults.push({ kind: 'chart-geometry', detail: `${c.label}: ${off.t.where} track ${w(off.t)} px, and ${off.o.label} in its share group has ${w(off.u)} px` })
  }
  return faults
}

// Makes the target reachable whatever hides it, and returns what it changed. Its header is above,
// with the file's.
export async function expose(drive, target) {
  const changes = []
  const no = (what) => ({ ok: false, changes, hidden: what })
  let at = await drive.call(hiders, target.selector, target.index)
  if (!at) return { ...no(`the page has no ${target.selector} at index ${target.index}`), missing: true }
  for (let k = 0; k < at.chain.length; k++) {
    const c = at.chain[k]
    if (c.shown) continue
    if (ownOf(target.keep, c)) return { ok: true, changes }
    if (c.kind === 'pane' && !c.ok) return no(`${c.label} is hidden, and its switch has a markup error`)
    if (!c.controls.length) return no(`${c.label} is hidden, though its switch's pressed buttons match its terms`)
    for (const x of c.controls) {
      if (!x.spec || !x.box) return no(`${c.label} is hidden, and ${x.spec ? `its ${x.what} has no box` : `it has no ${x.what}`}`)
      try { await drive.click({ kind: 'base', ...x.spec }) } catch (e) {
        if (!drive.missed(e)) throw e
        return no(`${c.label}: ${e.message}`)
      }
      changes.push({ kind: c.kind, label: c.label, back: x.pane ? x.back : c.back, pane: x.pane ?? null, open: c.kind === 'details' ? { d: c.d, was: c.was } : null })
    }
    await drive.settle()
    at = await drive.call(hiders, target.selector, target.index)
    if (!at || !at.chain[k].shown) return no(`${c.label} stayed hidden after a click on its ${c.controls.map((x) => x.what).join(' and ')}`)
  }
  if (!target.keep && !at.shown) return no('no details, pane or compare side hides it, and it has no box')
  return { ok: true, changes }
}

// In-page: closes details d and opens details was, unless was is -1. Returns '' or what is missing.
function reopen(d, was) {
  const all = [...document.querySelectorAll('details')]
  if (!all[d] || (was >= 0 && !all[was])) return `the page has no details at index ${all[d] ? was : d}`
  all[d].open = false
  if (was >= 0) all[was].open = true
  return ''
}

// Puts back what expose() changed, innermost first. Returns { undone, failed }: the changes it put
// back, and '' or what failed.
export async function restore(drive, changes) {
  const undone = []
  for (const ch of [...changes].reverse()) {
    if (ch.open) {
      const missing = await drive.call(reopen, ch.open.d, ch.open.was)
      if (missing) return { undone, failed: `putting back ${ch.label}: ${missing}` }
    } else if (ch.back) {
      try { await drive.click({ kind: 'base', ...ch.back }) } catch (e) {
        if (!drive.missed(e)) throw e
        return { undone, failed: `putting back ${ch.label}: ${e.message}` }
      }
    }
    undone.push(ch)
  }
  if (changes.length) await drive.settle()
  return { undone, failed: '' }
}

// One part's exposures, or one chrome row's. Its header is above, with the file's.
export function exposures(drive, track = () => {}) {
  const changes = []
  const show = async (target) => {
    const ex = await expose(drive, target)
    changes.push(...ex.changes)
    track(ex.changes, false)
    return ex
  }
  return {
    show,
    get size() { return changes.length },
    // Exposes a control and clicks it. Returns '' or what failed.
    async tap(target, what) {
      const ex = await show(target)
      if (!ex.ok) return ex.missing ? ex.hidden : `revealing ${what}: ${ex.hidden}`
      try { await drive.click({ kind: 'base', selector: target.selector, index: target.index }) } catch (e) {
        if (!drive.missed(e)) throw e
        return e.message
      }
      return ''
    },
    // Reads the matches of selector at the indexes in list, with hiders(), exposing each one whose
    // outermost hidden container isn't keep's own just before its reading, and then reading the
    // rest again. Returns [{ at, fail }], at being the reading and fail '' or what stayed hidden.
    async read(selector, list, keep) {
      const got = await drive.call(hiders, selector, list)
      const out = []
      for (const [n, index] of list.entries()) {
        let at = got[n]
        const first = at && at.chain.find((c) => !c.shown)
        if (first && !ownOf(keep, first)) {
          const ex = await show({ selector, index, keep })
          if (!ex.ok) { out.push({ at, fail: ex.hidden }); continue }
          at = await drive.call(hiders, selector, index)
          if (ex.changes.length && n + 1 < list.length) got.splice(n + 1, list.length, ...(await drive.call(hiders, selector, list.slice(n + 1))))
        }
        out.push({ at, fail: at ? '' : `the page has no ${selector} at index ${index}` })
      }
      return out
    },
    // Puts back every change, innermost first. Returns '' or what failed.
    async unwind() {
      const r = await restore(drive, changes.splice(0))
      track(r.undone, true)
      return r.failed
    },
  }
}

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

  // The check's own record of each switch's values, from the clicks it made, exposures and their
  // put-backs included.
  const cur = new Map(walkable.map((s) => [s.i, s.keys.map((k) => k.initial)]))
  const track = (changes, back) => { for (const ch of changes) if (ch.pane && cur.has(ch.pane.s) && (!back || ch.back)) cur.get(ch.pane.s)[ch.pane.j] = back ? ch.pane.from : ch.pane.to }
  const broken = new Set()
  const seen = new Set()
  const shared = m.charts.some((c) => c.ok && c.kind === 'bars' && c.shared > 1), widths = new Map()
  // The compare being walked: whether it is under 640 px, and the side the walk last picked.
  let walking = null
  // An own container's condition: a pane's terms against the record of its switch, and a side of
  // the compare being walked, which under 640 px shows only when the walk picked it.
  const cond = (c) => (c.kind === 'pane'
    ? m.panes[c.p].terms.every(([k, v]) => cur.get(c.s)[m.switches[c.s].keys.findIndex((x) => x.name === k)] === v)
    : !walking.narrow || c.side === walking.picked)
  // Whether a reading should have a box: each of keep's own containers in its chain meets its
  // condition, and every other container shows.
  const wants = (at, keep) => at.chain.every((c) => (ownOf(keep, c) ? cond(c) : c.shown))
  const word = (b) => (b ? 'has a box' : 'has no box')
  const paneWrong = (p, got, want) => `the pane "${m.panes[p].when}" ${word(got)}, but the model ${want ? 'shows' : 'hides'} it`
  // Every pane and compare side as it stands, each with its chain.
  const pageRead = async () => ({ panes: await drive.call(hiders, PANE, null), sides: await drive.call(hiders, SIDE_EL, null) })
  // The panes of each walkable switch that hasn't failed, or of switch only, held to wants() as
  // they stand.
  const verify = (now, only = null) => {
    const wrong = []
    for (const s of walkable) {
      if (broken.has(s.i) || (only !== null && s.i !== only)) continue
      for (const p of s.panes) {
        const want = wants(now.panes[p], { s: s.i })
        if (now.panes[p].shown !== want) wrong.push(paneWrong(p, now.panes[p].shown, want))
      }
    }
    return wrong
  }
  // A part's charts, each exposed with keep its part, held to wants(), and left reachable for the
  // step's probes: the oracle and the track readings.
  const readCharts = async (ex, list, keep) => {
    const wrong = []
    for (const [n, r] of (await ex.read(CHART, list, keep)).entries()) {
      const c = m.charts[list[n]]
      if (r.fail) wrong.push(`${c.label}: ${r.fail}`)
      else if (r.at.shown !== wants(r.at, keep)) wrong.push(`${c.label} ${word(r.at.shown)}, but the model ${r.at.shown ? 'hides' : 'shows'} it`)
    }
    return wrong
  }
  // A switch's panes, each exposed with keep the switch and held to wants(), then its charts.
  const readSwitch = async (ex, s, charts = true) => {
    const keep = { s: s.i }, wrong = []
    for (const [n, r] of (await ex.read(PANE, s.panes, keep)).entries()) {
      const p = s.panes[n]
      if (r.fail) wrong.push(`the pane "${m.panes[p].when}": ${r.fail}`)
      else if (r.at.shown !== wants(r.at, keep)) wrong.push(paneWrong(p, r.at.shown, !r.at.shown))
    }
    return charts ? [...wrong, ...(await readCharts(ex, s.charts, keep))] : wrong
  }
  let prev = await pageRead()
  const rowName = (s, vals) => `panes: switch ${s.n} ${s.keys.map((k, j) => `${k.name}=${vals[j]}`).join(' ')}`
  // A key button, exposed and clicked. Returns '' or what failed.
  const press = async (ex, s, j, value) => {
    const miss = await ex.tap({ selector: KEY, index: buttons[s.i][j][s.keys[j].values.indexOf(value)] }, `its ${s.keys[j].name}=${value} button`)
    if (!miss) cur.get(s.i)[j] = value
    return miss
  }
  // Clicks s's buttons to reach vals. With force, a step that changes nothing still clicks once.
  const reach = async (ex, s, vals, force = false) => {
    let clicked = false
    for (const [j, v] of vals.entries()) {
      if (cur.get(s.i)[j] === v) continue
      const miss = await press(ex, s, j, v)
      if (miss) return miss
      clicked = true
    }
    return force && !clicked ? press(ex, s, 0, vals[0]) : ''
  }
  // The probes of one step. Each named <details> group with a member in a pane or a compare side
  // the step revealed is probed member by member, last first, then put back as it was. Returns
  // the faults no earlier probe of this state found, for the row's detail.
  const probeStep = async (now) => {
    const fresh = []
    const run = async () => { for (const f of await drive.probe()) { const k = `${f.kind}\0${f.detail}`; if (!seen.has(k)) { seen.add(k); fresh.push(f) } } }
    const revealed = (list, was) => list.flatMap((x, i) => (x.shown && !(was[i] && was[i].shown) ? [i] : []))
    const inPanes = revealed(now.panes, prev.panes), inSides = revealed(now.sides, prev.sides)
    const g = inPanes.length || inSides.length ? await drive.call(members, inPanes, inSides, null) : { size: 0 }
    if (g.size > 1) {
      for (let k = g.size - 1; k >= 1; k--) { await drive.call(members, inPanes, inSides, k); await drive.settle(); await run() }
      await drive.call(members, inPanes, inSides, g.open)
      await drive.settle()
    }
    await run()
    if (shared) for (const t of await drive.call(chartFaults, drive.source, true)) widths.set(t.i, [...(widths.get(t.i) ?? []), t])
    prev = now
    return fresh.length ? `new in this step: ${fresh.slice(0, 3).map((f) => `${f.kind} (${clip(f.detail, 100)})`).join('; ')}` : ''
  }
  // One step: act, which returns '' or what failed, settle, the part's own reading, which returns
  // what it found wrong, every walkable switch's panes as they stand, then the probes. Returns
  // whether it passed. A failed act closes any dialog; an error that isn't a step failure is the
  // checker's own.
  const step = async (name, act, read) => {
    try {
      const miss = await act()
      if (miss) {
        steps.push({ name, result: 'fail', detail: miss })
        await drive.closeDialogs()
        return false
      }
      await drive.settle()
      const own = await read()
      const now = await pageRead()
      const wrong = [...new Set([...own, ...verify(now)])]
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
  const giveUp = async (ex, s) => {
    broken.add(s.i)
    await reach(ex, s, s.keys.map((k) => k.initial))
  }

  await probeStep(prev)
  for (const s of walkable) {
    const ex = exposures(drive, track)
    const all = s.keys.reduce((list, k) => list.flatMap((vals) => k.values.map((v) => [...vals, v])), [[]])
    let ok = true
    for (const vals of all) if (ok) ok = await step(rowName(s, vals), () => reach(ex, s, vals, true), () => readSwitch(ex, s))
    for (const [j, k] of s.keys.entries()) {
      if (!ok) break
      const at = k.values.indexOf(cur.get(s.i)[j]), next = k.values[(at + 1) % k.values.length]
      const target = buttons[s.i][j][(at + 1) % k.values.length]
      const on = (focus) => { const v = buttons[s.i][j].indexOf(focus); return v === -1 ? 'off this key' : `on the "${k.values[v]}" button` }
      ok = await step(`panes: switch ${s.n} ${k.name} arrow`, async () => {
        const miss = await press(ex, s, j, k.values[at])
        if (miss) return miss
        await drive.key('ArrowRight')
        cur.get(s.i)[j] = next
        return ''
      }, async () => {
        // Focus first: an exposure's click moves it.
        const focus = await drive.call(focusKey)
        const moved = focus === target ? [] : [`ArrowRight from "${k.values[at]}" left focus ${on(focus)}, not on the "${next}" button`]
        return [...moved, ...(await readSwitch(ex, s))]
      })
    }
    if (!ok) await giveUp(ex, s)
    else {
      const miss = await reach(ex, s, s.keys.map((k) => k.initial))
      if (miss) {
        steps.push({ name: rowName(s, s.keys.map((k) => k.initial)), result: 'fail', detail: `back to the defaults: ${miss}` })
        await giveUp(ex, s)
      }
    }
    const failed = await ex.unwind()
    if (failed) steps.push({ name: rowName(s, s.keys.map((k) => k.initial)), result: 'fail', detail: `after its walk, ${failed}` })
    prev = await pageRead()
  }

  // One compare: its figure exposed and measured, then its sides. It returns at the first failed
  // step, so the walk goes on to the next part.
  const driveCompare = async (c, ex) => {
    const n = c.i + 1
    const rows = (detail) => { for (const side of ['before', 'after']) steps.push({ name: `panes: compare ${n} ${side}`, result: 'fail', detail }) }
    const fig = await ex.show({ selector: FIG, index: c.i })
    if (!fig.ok) return rows(`revealing it: ${fig.hidden}`)
    const info = await drive.call(compareLook, c.i)
    if (!info || !info.shown) return rows('the compare has no box to drive')
    // Under 640 px of content box the switch shows and one side at a time; at 640 and up, both
    // sides and no switch. Within a pixel of 640 the check follows the switch.
    const narrow = info.width < 639 || (info.width <= 641 && info.sw)
    if (narrow !== info.sw) return rows(`the compare is ${info.width.toFixed(1)} px wide, ${narrow ? 'under 640, and shows no switch' : '640 or more, and still shows its switch'}`)
    walking = { narrow, picked: null }
    const keep = { c: c.i }
    const sides = async () => {
      const [b, a] = await ex.read(SIDE_EL, [info.sides.before, info.sides.after], keep)
      const fail = [b, a].filter((r) => r.fail).map((r) => r.fail)
      if (fail.length) return fail
      const want = { before: wants(b.at, keep), after: wants(a.at, keep) }
      const wrong = b.at.shown === want.before && a.at.shown === want.after ? []
        : [`before ${word(b.at.shown)} and after ${word(a.at.shown)}, expected ${want.before ? 'shown' : 'hidden'} and ${want.after ? 'shown' : 'hidden'}`]
      return [...wrong, ...(await readCharts(ex, c.charts, keep))]
    }
    for (const side of ['before', 'after']) {
      const act = narrow ? async () => {
        const miss = await ex.tap({ selector: SIDE, index: info.buttons[side] }, `its ${side} button`)
        if (!miss) walking.picked = side
        return miss
      } : async () => ''
      if (!(await step(`panes: compare ${n} ${side}`, act, sides))) return
    }
  }
  for (const c of m.compares.filter((x) => x.ok)) {
    const ex = exposures(drive, track)
    await driveCompare(c, ex)
    walking = null
    const failed = await ex.unwind()
    if (failed) steps.push({ name: `panes: compare ${c.i + 1} after`, result: 'fail', detail: `after its walk, ${failed}` })
    prev = await pageRead()
  }

  // The final display step: every switch on its last combination through exposed key buttons,
  // its panes read while its exposures stand, then put back. The state's screenshot shows the
  // page with every container as it loaded and every switch on its last combination.
  const last = walkable.filter((s) => !broken.has(s.i))
  if (last.length) {
    const missed = new Map(), wrongAt = new Map()
    for (const s of last) {
      const ex = exposures(drive, track)
      const miss = await reach(ex, s, s.keys.map((k) => k.values.at(-1)), true)
      if (miss) missed.set(s.i, miss)
      else {
        await drive.settle()
        wrongAt.set(s.i, await readSwitch(ex, s, false))
      }
      const failed = await ex.unwind()
      if (failed && !missed.has(s.i)) missed.set(s.i, failed)
      if (missed.has(s.i)) broken.add(s.i)
    }
    await drive.closeDialogs()
    await drive.settle()
    const now = await pageRead()
    const found = await probeStep(now)
    for (const s of last) {
      const name = rowName(s, s.keys.map((k) => k.values.at(-1)))
      if (missed.has(s.i)) { steps.push({ name, result: 'fail', detail: `the final step: ${missed.get(s.i)}` }); continue }
      const wrong = [...new Set([...(wrongAt.get(s.i) ?? []), ...verify(now, s.i)])]
      steps.push({ name, result: wrong.length ? 'fail' : 'pass', detail: wrong.length ? `the final step: ${wrong.join('; ')}` : found })
    }
  }
  faults.push(...shareFaults(m, widths))
  return { faults, steps }
}
