/* plans-kit:parts.js */
/* Content parts (parts.md). A part writes only when the reader acts or a resize changes a result. */
(() => {
'use strict'
const said = new Set()
const fault = (part, what, s = 'plans-part: ' + part + ': ' + what) => said.has(s) || (said.add(s), console.error(s))
const NAME = /^[a-z][a-z0-9-]*$/
const DEC = /^-?\d+(\.\d+)?$/
const add = (to, tag) => to.appendChild(document.createElement(tag))
const hook = el => el.querySelector('[data-ask], [data-note], [data-ask-summary], [data-respond]')
const asked = el => el.closest('fieldset[data-ask]')
const pct = f => f * 100 + '%'
const press = (b, on) => { if (b.getAttribute('aria-pressed') !== '' + on) b.setAttribute('aria-pressed', on) }
const jobs = new Map()
const ro = new ResizeObserver(es => { for (const fn of new Set(es.map(e => jobs.get(e.target)))) fn() })
const watch = (fn, ...els) => els.forEach(el => { jobs.set(el, fn); ro.observe(el) })
const bind = (bs, pick) => bs.forEach((b, i) => {
  b.addEventListener('click', () => pick(b))
  b.addEventListener('keydown', e => {
    const j = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: -1 }[e.key]
    if (j === undefined) return
    e.preventDefault()
    const to = bs.at(j % bs.length)
    to.focus()
    pick(to)
  })
})

const switches = () => document.querySelectorAll('[data-base-switch]').forEach((box, n) => {
  const no = [], keys = [], panes = []
  if (box.parentElement.closest('[data-base-switch]') || box.querySelector('[data-base-switch]') || asked(box)) no.push('nests in a switch or a question')
  for (const g of box.querySelectorAll('[data-base-key]')) {
    const name = g.dataset.baseKey, bs = [...g.querySelectorAll('button')], vs = bs.map(b => b.value)
    const on = bs.filter(b => b.getAttribute('aria-pressed') === 'true')
    if (!NAME.test(name) || keys.some(k => k.name === name) || g.closest('[data-base-when]') || !vs[1] || !vs.every(v => NAME.test(v)) || new Set(vs).size < vs.length || bs.some(b => !b.disabled) || on.length !== 1) {
      no.push('key "' + name + '" needs a unique name outside panes, 2+ disabled buttons, unique values, one pressed')
    }
    keys.push({ name, bs, vs, v: on[0]?.value })
  }
  if (!keys.length || keys[2]) no.push('needs 1 or 2 keys')
  for (const p of box.querySelectorAll('[data-base-when]')) {
    const raw = p.dataset.baseWhen, terms = raw.split(' ').map(t => t.split('='))
    if (p.hidden || hook(p) || terms.some(([k, v, x]) => x !== undefined || !keys.find(y => y.name === k)?.vs.includes(v) || terms.filter(t => t[0] === k)[1])) {
      no.push('pane "' + raw + '" needs key=value terms and no hidden or question')
    }
    panes.push({ p, terms })
  }
  if (!panes.length) no.push('has no pane')
  if (no.length) return no.forEach(e => fault('switch', 'switch ' + (n + 1) + ' ' + e))
  const state = new Map(keys.map(k => [k.name, k.v]))
  const apply = () => {
    for (const k of keys) for (const b of k.bs) press(b, state.get(k.name) === b.value)
    for (const { p, terms } of panes) {
      const show = terms.every(([k, v]) => state.get(k) === v)
      if (p.hidden === show) p.toggleAttribute('hidden', !show)
    }
  }
  apply()
  for (const k of keys) {
    bind(k.bs, b => { if (state.get(k.name) !== b.value) { state.set(k.name, b.value); apply() } })
    for (const b of k.bs) b.removeAttribute('disabled')
  }
})

const compares = () => document.querySelectorAll('.pb-compare').forEach((fig, n) => {
  const sides = ['before', 'after'].map(s => [...fig.children].find(c => c.matches('.pb-side') && c.dataset.baseSide === s))
  const heads = sides.map(s => s?.querySelector('h1, h2, h3, h4, h5, h6'))
  if (fig.localName !== 'figure' || !fig.querySelector(':scope > figcaption') || !heads.every(Boolean) || sides.some(hook) || asked(fig)) {
    return fault('compare', 'compare ' + (n + 1) + ' needs a figcaption and headed before and after sides, no question')
  }
  const sw = document.createElement('div')
  sw.className = 'plans-compare-switch'
  const bs = heads.map((h, i) => {
    const b = add(sw, 'button')
    b.setAttribute('type', 'button')
    b.dataset.plansSide = i ? 'after' : 'before'
    b.textContent = h.textContent.trim()
    return b
  })
  const pick = b => {
    if (fig.dataset.plansSide !== b.dataset.plansSide) fig.dataset.plansSide = b.dataset.plansSide
    for (const x of bs) press(x, x === b)
  }
  bind(bs, pick)
  pick(bs[1])
  fig.prepend(sw)
})

const tables = () => document.querySelectorAll('.pb-table').forEach((box, n) => {
  const t = box.firstElementChild, name = t?.caption?.textContent.trim()
  if (box.children[1] || t?.localName !== 'table' || !name || asked(box)) return fault('table', 'table ' + (n + 1) + ' needs one captioned <table>, outside any question')
  let over = false
  watch(() => {
    if (over === (over = box.scrollWidth > box.clientWidth)) return
    if (over) { box.setAttribute('role', 'region'); box.setAttribute('tabindex', '0'); box.setAttribute('aria-label', name) }
    else { box.removeAttribute('role'); box.removeAttribute('tabindex'); box.removeAttribute('aria-label') }
  }, box, t)
})

const charts = () => {
  const bars = []
  document.querySelectorAll('[data-base-chart]').forEach((el, n) => {
    const kind = el.dataset.baseChart
    const bad = what => fault(kind === 'timeline' ? kind : 'bars', 'chart ' + (n + 1) + ' ' + what)
    if (hook(el) || asked(el) || el.parentElement.closest('[data-base-chart]') || el.querySelector('[data-base-chart]')) bad('holds a question, sits in one, or nests')
    else if (kind === 'bars' && el.localName === 'table') bars.push(readBars(el, bad))
    else if (kind === 'timeline' && el.localName === 'ol') timeline(el, bad)
    else bad('needs bars on a <table> or timeline on an <ol>')
  })
  drawBars(bars.filter(Boolean))
}

const readBars = (table, bad) => {
  const stack = 'baseStack' in table.dataset
  const [min, max] = [table.dataset.baseMin, table.dataset.baseMax].map(v => v == null ? null : DEC.test(v) ? +v : NaN)
  const rows = [...table.tBodies].flatMap(b => [...b.rows]).map(tr => {
    const tds = [...tr.cells].slice(1)
    return { tr, tds, values: tds.map((td, d) => (d = td.querySelectorAll('data'))[1] || !DEC.test(d[0]?.value) ? NaN : +d[0].value) }
  })
  const cols = rows[0]?.tds.length
  const odd = rows.findIndex(({ tr, tds, values }) => tr.cells[0]?.localName !== 'th' || tds.length !== cols || tds.some(c => c.localName !== 'td') || values.some(v => !(v >= (stack ? 0 : -Infinity))))
  if (Number.isNaN(min) || Number.isNaN(max) || (stack && min)) return bad('needs decimal bounds, and min 0 if stacked')
  if (!(cols >= 1 && cols <= 6)) return bad('needs rows of 1 to 6 values')
  if (odd >= 0) return bad('row ' + (odd + 1) + ' needs a <th> and ' + cols + ' <td>, each one decimal <data value>' + (stack ? ', 0 or more' : ''))
  if (cols > 1 && table.tHead?.rows[0]?.cells.length !== cols + 1) return bad('needs a thead cell over each column')
  const vals = stack ? rows.map(r => r.values.reduce((a, b) => a + b)) : rows.flatMap(r => r.values)
  return { bad, rows, cols, stack, min, max, vals, lo: Math.min(0, ...vals), hi: Math.max(0, ...vals), unit: table.dataset.baseUnit, box: table.closest('[data-base-switch]') }
}

const drawBars = list => {
  const groups = []
  for (const c of list) {
    const g = c.box && c.unit && groups.find(x => x[0].box === c.box && x[0].unit === c.unit)
    g ? g.push(c) : groups.push([c])
  }
  for (const g of groups) {
    const [s0, s1] = ['min', 'max'].map(k => g.find(c => c[k] !== null))
    const lo = s0 ? s0.min : Math.min(...g.map(c => c.lo))
    const hi = s1 ? s1.max : Math.max(...g.map(c => c.hi)) || (lo ? 0 : 1)
    const f = x => (x - lo) / (hi - lo), base = Math.min(Math.max(0, lo), hi)
    for (const c of g) {
      if ((s0 && c.min !== null && c.min !== lo) || (s1 && c.max !== null && c.max !== hi)) c.bad('states a bound its share group contradicts')
      else if (!(lo < hi) || c.vals.some(v => v < lo || v > hi)) c.bad('has a ' + (c.stack ? 'row sum' : 'value') + ' outside ' + lo + ' to ' + hi)
      else for (const { tds, values } of c.rows) {
        let sum = 0
        tds.forEach((td, i) => {
          const [a, b] = c.stack ? [sum, sum += values[i]] : [Math.min(base, values[i]), Math.max(base, values[i])]
          const track = add(td, 'span'), zero = lo <= 0 && hi >= 0 && add(track, 'span'), bar = add(track, 'span')
          track.className = 'plans-track'
          track.setAttribute('aria-hidden', 'true')
          if (zero) { zero.className = 'plans-zero'; zero.style.insetInlineStart = pct(f(0)) }
          bar.className = 'plans-bar'
          if (c.cols > 1) bar.dataset.plansSeries = i + 1
          bar.style.insetInlineStart = pct(f(a))
          bar.style.inlineSize = pct(f(b) - f(a))
        })
      }
    }
  }
}

// The round trip refuses a day that Date.parse rolls over, such as 2026-02-30.
const when = s => {
  const iso = s?.length === 10 ? s + 'T00:00:00Z' : s, t = Date.parse(iso)
  return /^\d{4}(-\d\d){2}T\d\d(:\d\d){2}Z$/.test(iso) && t === t && new Date(t).toISOString().slice(0, 19) + 'Z' === iso ? t : NaN
}

// A mark takes the first row of its lane's band where it meets no earlier mark, by start then
// source. That is in px, so it reruns on resize.
const timeline = (ol, bad) => {
  const items = [...ol.children].map((li, i) => {
    const ts = [...li.querySelectorAll('time')].map(t => when(t.dateTime))
    return { i, li, ts, lane: li.dataset.baseLane?.trim(), a: ts[0], b: ts.at(-1), span: ts.length > 1 }
  })
  const [from, to] = [ol.dataset.baseFrom, ol.dataset.baseTo].map((a, k) => a != null ? when(a) : Math[k ? 'max' : 'min'](...items.map(x => k ? x.b : x.a)))
  const odd = items.find(x => !x.lane || !x.ts.length || x.ts.length > 2 || !(x.a <= x.b))
  if (odd) return bad('item ' + (odd.i + 1) + ' needs a lane and one or two real <time datetime> in order')
  if (!items.length || !(from <= to) || items.some(x => x.a < from || x.b > to)) return bad('needs items, inside real bounds')
  const f = t => to === from ? 0.5 : (t - from) / (to - from)
  const lanes = [...new Set(items.map(x => x.lane))]
  const track = document.createElement('div')
  track.className = 'plans-track'
  track.setAttribute('aria-hidden', 'true')
  const bands = lanes.map(name => {
    const lane = add(track, 'div'), label = add(lane, 'span'), rows = add(lane, 'div')
    lane.className = 'plans-lane'
    label.className = 'plans-lane-name'
    rows.className = 'plans-lane-rows'
    label.textContent = name
    add(rows, 'div').className = 'plans-lane-row'
    return { rows, marks: [], placed: '' }
  })
  for (const x of items) {
    const k = lanes.indexOf(x.lane), m = x.m = add(bands[k].rows.firstChild, 'span')
    m.className = 'plans-mark'
    m.dataset.plansItem = x.i
    m.dataset.plansKind = x.span ? 'span' : 'point'
    m.dataset.plansLane = k
    if (x.li.dataset.baseStatus === 'changed') m.dataset.plansStatus = 'changed'
    m.style.insetInlineStart = pct(f(x.a))
    if (x.span) m.style.inlineSize = pct(f(x.b) - f(x.a))
    bands[k].marks.push(x)
  }
  for (const band of bands) band.marks.sort((p, q) => p.a - q.a)
  const pack = () => {
    const w = bands[0].rows.firstChild.getBoundingClientRect().width, pw = items.find(x => !x.span)?.m.offsetWidth ?? 0
    if (w > 0) for (const band of bands) {
      const used = [], rows = band.rows.children
      const want = band.marks.map(x => {
        const l = f(x.a) * w - (x.span ? 0 : pw / 2), r = x.span ? Math.max(f(x.b) * w, l + 1) : l + pw
        let k = 0
        while (used[k]?.some(([p, q]) => Math.min(q, r) - Math.max(p, l) > 0.5)) k++
        used[k] = [...used[k] ?? [], [l, r]]
        return k
      }).join()
      if (want === band.placed) continue
      band.placed = want
      while (!rows[used.length - 1]) add(band.rows, 'div').className = 'plans-lane-row'
      band.marks.forEach((x, j) => { const row = rows[want.split(',')[j]]; if (x.m.parentNode !== row) row.append(x.m) })
      while (rows[used.length]) rows[used.length].remove()
    }
  }
  ol.before(track)
  pack()
  watch(pack, track)
}

const run = () => { switches(); compares(); tables(); charts() }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true })
else run()
})()
