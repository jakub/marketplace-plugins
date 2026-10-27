// The prose-diff engine. build.mjs calls it at build time and replaces each
// `<div data-diff-before data-diff-after>` placeholder with the markup it returns, so a page ships
// no diff code. It is a pure ES module: no DOM, no I/O, Node built-ins only, and nothing here reads
// a file. The algorithm is ported from the proof layout prototype (layouts/proof/src.html:298-503).
//
// API
//   diff(before, after, {noteWords = 12}) -> {ops, coarse}
//     ops is the lossless operation list: {t: 'eq' | 'del' | 'ins', s} in document order, where
//     every `del` of a change comes before its `ins`. Concatenating the `eq` and `del` texts gives
//     `before` exactly, and the `eq` and `ins` texts give `after` exactly, down to a BOM, a CR, a
//     missing final newline or a U+2028. A `del` or `ins` from a coarse hunk carries `coarse: true`,
//     and `coarse` is true when any op does. noteWords is accepted so both calls take the same
//     options. It changes only what render() draws, never the ops.
//   render(ops, {noteWords = 12}) -> string
//     One `<div class="plans-diff">` holding static markup. noteWords is a non-negative integer,
//     and 0 turns margin notes off. All input text is escaped, so `<script>` or `"` in a document
//     comes out as text. Note numbers start at 1 in every call.
//   The ported stages are exported too: esc, tok, lcs, regions, cleanup, diffText, diffDoc, toItems,
//   toLines, toBlocks, inl, para and renderBlocks. CAP is the pair cap.
//
// Alignment. tok() splits text into newlines, whitespace runs, `**`, ASCII words (with any
// combining marks that follow) and single code points. diffDoc() aligns lines first, then refines
// each changed run of lines word by word. At each level lcs() trims the common prefix and suffix
// and runs a full LCS table on what is left. When that core holds more than CAP (4,000,000) pairs,
// the level gives up and emits the whole core as one cut and one insertion marked coarse, with no
// word-level refinement below it. cleanup() then folds small or blank equalities into the changes
// around them (the diff-match-patch semantic rule), so a rewrite reads as phrase-for-phrase swaps.
//
// Markdown subset. The renderer sets the after-text as markdown, line by line:
//   - front matter: a `---` block on the document's first line
//   - fenced code: ``` or ~~~, closed by the next fence line of either kind
//   - ATX headings `#` to `######`, thematic breaks (`---`, `***`, `___`)
//   - pipe tables: rows starting with `|`, with the separator row dropped
//   - blockquotes: one level of `>`, consecutive lines joined
//   - list items: `-`, `*`, `+`, `1.` or `1)`, one indent level per 2 leading spaces
//   - indented lines under a list item, one level per 3 leading spaces
//   - paragraphs, with soft-wrapped lines joined by a space
//   - inline: `code` and **bold** only
// Links, images, single-star emphasis, setext headings, nested quotes and raw HTML are not
// interpreted and show as their source text.
//
// Markup. The output uses only these classes, which marks.css and look.css style:
//   div.plans-diff  the whole block           del.plans-cut   a cut
//   ins.plans-new   new words                 span.plans-pil  a generated ¶ for a lost break
//   sup.plans-caret a numbered caret          span.plans-note a margin note
//   pre.plans-pre   front matter, code, a changed table or fence, a coarse hunk
//   .plans-coarse-label  the label before a coarse hunk's pre
//   p.plans-h1..6   headings                  p.plans-li      a list item
//   p.plans-ind     an indented line          div.plans-tw    a table wrapper
//   plans-i1..6     the indent level of a list item or indented line
// Paragraphs are bare `p`, a quote is `blockquote > p`, a rule is `hr`, and a block that only lost
// text is a bare `p`. A list item opens with a classless `span` holding its marker. Nothing carries
// a `style` attribute.
//
// Cuts. A cut of more than noteWords words becomes `sup.plans-caret` (‸ and its number) in the
// text, plus one `span.plans-note` (its number and the whole cut in a `del`) emitted right after
// the block that holds the caret, as a sibling inside div.plans-diff. look.css lifts that node
// into the outer column at 900 px and up, and anywhere else it sits below its block. A cut is
// never collapsed or truncated. A cut that holds a line break shows each run of breaks as a ¶.
// A deletion that is only whitespace and holds a line break, such as a paragraph merge, shows as
// one ¶. ¶ marks are generated span.plans-pil elements, never characters placed in the text, so a
// U+2029 in input stays text.
//
// Fallbacks. A changed table or a changed fence shows as pre.plans-pre with del and ins, with each
// run of cut line breaks shown as a ¶. Fences and tables are the one place the setter reads the
// before-text too, so a cut table, a cut fence, or fence lines cut around kept text take this
// fallback rather than being set as paragraphs or inline code. A coarse hunk shows as a .plans-coarse-label paragraph and
// a pre.plans-pre holding the whole cut and then the whole new text, widened to whole lines with
// the unchanged text around it. Margin notes never appear inside a pre.
//
// Limits.
//   - Words are ASCII. A non-Latin word aligns one code point at a time, which is correct but
//     noisier.
//   - A cut or insertion that is only whitespace and holds no line break is not marked, and an
//     insertion of a line break is not marked. The ops still hold both.
//   - Markdown state (an open fence, front matter, a list or a table) does not carry across a coarse
//     hunk. The text after the hunk is set as if it began a block.
//   - The LCS table is a Uint32Array of (n+1)(m+1) cells, at most about 16 MB at the cap.

export const CAP = 4e6

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

/* ---------------------------------------------------------------- alignment */

const TOK = /\n|[^\S\n]+|\*\*|(?:[A-Za-z0-9_'’]\p{M}*)+|[^\sA-Za-z0-9_'’]\p{M}*/gu

export function tok(s) {
  return s ? s.match(TOK) || [] : []
}

// Ops are {t: '=' | '-' | '+', s}, with c: true on the two ops of a core over CAP.
export function lcs(a, b) {
  const out = []
  const push = (t, s, c) => {
    const l = out[out.length - 1]
    if (l && l.t === t && !l.c === !c) l.s += s
    else out.push(c ? { t, s, c: true } : { t, s })
  }
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let q = 0
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++
  const A = a.slice(p, a.length - q), B = b.slice(p, b.length - q)
  for (let i = 0; i < p; i++) push('=', a[i])
  const n = A.length, m = B.length
  if (n && m && n * m <= CAP) {
    const W = m + 1, L = new Uint32Array((n + 1) * W)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1])
      }
    }
    let i = 0, j = 0
    while (i < n && j < m) {
      if (A[i] === B[j]) { push('=', A[i]); i++; j++ }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { push('-', A[i]); i++ }
      else { push('+', B[j]); j++ }
    }
    while (i < n) push('-', A[i++])
    while (j < m) push('+', B[j++])
  } else if (n && m) {
    push('-', A.join(''), true)
    push('+', B.join(''), true)
  } else {
    if (n) push('-', A.join(''))
    if (m) push('+', B.join(''))
  }
  for (let i = a.length - q; i < a.length; i++) push('=', a[i])
  return out
}

// Ops to regions: {eq} or {d, i}, with coarse: true when any op inside was coarse.
export function regions(ops) {
  const r = []
  for (const o of ops) {
    const l = r[r.length - 1]
    if (o.t === '=') {
      if (l && l.eq !== undefined) l.eq += o.s
      else r.push({ eq: o.s })
      continue
    }
    let e = l
    if (!e || e.eq !== undefined) { e = { d: '', i: '' }; r.push(e) }
    if (o.t === '-') e.d += o.s
    else e.i += o.s
    if (o.c) e.coarse = true
  }
  return r
}

// Fold an equality into the changes on both sides when it is no longer than the smaller of them,
// or blank. After a merge the scan resumes two places back, the leftmost equality whose neighbours
// changed, which gives the same result as the prototype's restart from the start.
export function cleanup(r) {
  let k = 1
  while (k < r.length - 1) {
    const e = r[k], a = r[k - 1], b = r[k + 1]
    if (e.eq !== undefined && a.eq === undefined && b.eq === undefined) {
      const lim = Math.min(Math.max(a.d.length, a.i.length), Math.max(b.d.length, b.i.length))
      if (e.eq.length <= lim || !/\S/.test(e.eq)) {
        const merged = { d: a.d + e.eq + b.d, i: a.i + e.eq + b.i }
        if (a.coarse || b.coarse) merged.coarse = true
        r.splice(k - 1, 3, merged)
        k = Math.max(1, k - 2)
        continue
      }
    }
    k++
  }
  return r
}

export function diffText(a, b) {
  return cleanup(regions(lcs(tok(a), tok(b))))
}

export function diffDoc(a, b) {
  const la = a.split(/(?<=\n)/), lb = b.split(/(?<=\n)/)
  const out = []
  let d = '', ins = ''
  const flush = () => {
    if (d || ins) {
      for (const o of lcs(tok(d), tok(ins))) out.push(o)
      d = ''
      ins = ''
    }
  }
  for (const o of lcs(la, lb)) {
    if (o.t === '=' || o.c) { flush(); out.push(o) }
    else if (o.t === '-') d += o.s
    else ins += o.s
  }
  flush()
  return cleanup(regions(out))
}

/* ---------------------------------------------------------------- the markdown setter */

// Items: '=' kept, '+' new, '-' an inline cut, 'n' a cut that becomes a margin note, 'p' a
// whitespace-only cut holding a line break, drawn as one ¶.
export function toItems(r, noteWords) {
  const items = []
  for (const x of r) {
    if (x.eq !== undefined) { if (x.eq) items.push({ t: '=', s: x.eq }); continue }
    if (/\S/.test(x.d)) {
      const w = (x.d.match(/\S+/g) || []).length
      items.push({ t: noteWords && w > noteWords ? 'n' : '-', s: x.d })
    } else if (x.d.includes('\n')) {
      items.push({ t: 'p', s: x.d })
    }
    if (x.i) items.push({ t: '+', s: x.i })
  }
  return items
}

// Lines of the after-text. Cuts stay on the line where they happened.
export function toLines(items) {
  const lines = []
  let cur = []
  for (const it of items) {
    if (it.t === '=' || it.t === '+') {
      const parts = it.s.split('\n')
      parts.forEach((p, ix) => {
        if (p) cur.push({ t: it.t, s: p })
        if (ix < parts.length - 1) { lines.push(cur); cur = [] }
      })
    } else cur.push(it)
  }
  lines.push(cur)
  return lines
}

const aft = (ln) => ln.filter((x) => x.t === '=' || x.t === '+').map((x) => x.s).join('')
const isCut = (x) => x.t === '-' || x.t === 'n' || x.t === 'p'
// The before-side lines a line of the after-text stands for: its kept text and its cuts.
const bef = (ln) => ln.filter((x) => x.t !== '+').map((x) => x.s).join('').split('\n')
const FENCE = /^\s*(```|~~~)/, ROW = /^\s*\|/
const structural = (s) => s.split('\n').some((l) => FENCE.test(l) || ROW.test(l))

// Cut table rows or fence lines at the head of a line go on a line of their own, so the structure
// takes the fallback and the after-text behind it keeps its own block.
function splitLead(ln) {
  let k = 0
  while (k < ln.length && isCut(ln[k])) k++
  const lead = ln.slice(0, k).map((x) => x.s).join('')
  return k && k < ln.length && lead.endsWith('\n') && structural(lead) ? [ln.slice(0, k), ln.slice(k)] : [ln]
}

function strip(ln, k) {
  const out = []
  for (const x of ln) {
    if (k > 0 && (x.t === '=' || x.t === '+')) {
      if (x.s.length <= k) { k -= x.s.length; continue }
      out.push({ t: x.t, s: x.s.slice(k) })
      k = 0
    } else out.push(x)
  }
  return out
}

// start is false for text that follows a coarse hunk, so front matter is read only at the top.
// Fences and tables are read from both sides: a fence stays open while either side is inside one,
// and a line is a table row when its after-text or any before-side line it holds starts with `|`.
export function toBlocks(lines, start = true) {
  const B = []
  let fa = false, fb = false, code = null, fm = false, blank = true
  const step = (ln, idx) => {
    const a = aft(ln), b = bef(ln), hasDel = ln.some(isCut), last = B[B.length - 1]
    let m
    if (start && idx === 0 && a.trim() === '---') { fm = true; B.push({ k: 'pre', lines: [ln] }); return }
    if (fm) { last.lines.push(ln); if (a.trim() === '---') fm = false; blank = false; return }
    const da = FENCE.test(a), db = b.filter((l) => FENCE.test(l)).length
    if (code || da || db) {
      if (code) code.lines.push(ln)
      else B.push((code = { k: 'pre', lines: [ln] }))
      if (da) fa = !fa
      if (db % 2) fb = !fb
      if (!fa && !fb) code = null
      blank = false
      return
    }
    if (ROW.test(a) || b.some((l) => ROW.test(l))) {
      if (last && last.k === 'table' && !blank) last.lines.push(ln)
      else B.push({ k: 'table', lines: [ln] })
      blank = !a.trim()
      return
    }
    if (!a.trim()) { if (hasDel) B.push({ k: 'gone', items: ln }); blank = true; return }
    if ((m = a.match(/^(#{1,6})\s+/))) { B.push({ k: 'h', lv: m[1].length, items: strip(ln, m[0].length) }); blank = false; return }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(a)) { B.push({ k: 'hr' }); blank = false; return }
    if ((m = a.match(/^>\s?/))) {
      const it = strip(ln, m[0].length)
      if (last && last.k === 'bq' && !blank) last.items.push({ t: '=', s: ' ' }, ...it)
      else B.push({ k: 'bq', items: it })
      blank = false
      return
    }
    if ((m = a.match(/^(\s*)([-*+]|\d+[.)])\s+/))) {
      B.push({ k: 'li', ind: Math.floor(m[1].length / 2), mk: m[2], items: strip(ln, m[0].length) })
      blank = false
      return
    }
    m = a.match(/^\s+/)
    const lead = m ? m[0].length : 0
    if (last && !blank && (last.k === 'p' || last.k === 'li' || last.k === 'ind')) {
      last.items.push({ t: '=', s: ' ' }, ...strip(ln, lead))
      blank = false
      return
    }
    if (lead && last && (last.k === 'li' || last.k === 'ind')) {
      B.push({ k: 'ind', ind: Math.max(1, Math.round(lead / 3)), items: strip(ln, lead) })
      blank = false
      return
    }
    B.push({ k: 'p', items: strip(ln, lead) })
    blank = false
  }
  lines.forEach((ln, idx) => { for (const part of splitLead(ln)) step(part, idx) })
  return B
}

// Inline `code` and **bold**, escaping everything else. st carries the open spans across calls.
export function inl(s, st) {
  let h = (st.b ? '<strong>' : '') + (st.c ? '<code>' : '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '`') { st.c = !st.c; h += st.c ? '<code>' : '</code>'; continue }
    if (!st.c && ch === '*' && s[i + 1] === '*') { st.b = !st.b; h += st.b ? '<strong>' : '</strong>'; i++; continue }
    h += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch
  }
  return h + (st.c ? '</code>' : '') + (st.b ? '</strong>' : '')
}

// A cut's text split at each run of line breaks. The renderer joins the parts with a generated ¶.
export function para(s) {
  return s.split(/(?:\r?\n)+/)
}

const PIL = '<span class="plans-pil" title="paragraph break, removed">¶</span>'
const cutText = (s, st) => para(s).map((p) => inl(p, st)).join(PIL)

function rItems(items, ctx) {
  let h = ''
  for (const x of items) {
    if (!x.s) continue
    if (x.t === '=') { h += inl(x.s, ctx.A); inl(x.s, ctx.B) }
    else if (x.t === '+') h += /\S/.test(x.s) ? `<ins class="plans-new">${inl(x.s, ctx.A)}</ins>` : inl(x.s, ctx.A)
    else if (x.t === '-') h += `<del class="plans-cut">${cutText(x.s, ctx.B)}</del>`
    else if (x.t === 'p') h += PIL
    else {
      const n = ++ctx.chap.n
      ctx.notes.push(`<span class="plans-note"><b>${n}</b> <del class="plans-cut">${cutText(x.s, ctx.B)}</del></span>`)
      h += `<sup class="plans-caret" title="cut passage ${n}">‸<b>${n}</b></sup>`
    }
  }
  return h
}

function preLine(ln) {
  return ln.map((x) => {
    if (x.t === '+') return `<ins class="plans-new">${esc(x.s)}</ins>`
    if (x.t === '-' || x.t === 'n') return `<del class="plans-cut">${para(x.s).map(esc).join(` ${PIL} `)}</del>`
    if (x.t === 'p') return PIL
    return esc(x.s)
  }).join('')
}

// The HTML parser drops one newline right after <pre>, so every pre opens with one.
const pre = (body) => `<pre class="plans-pre">\n${body}</pre>`

function cells(row) {
  const t = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  return t.split(/(?<!\\)\|/).map((c) => c.trim())
}

const indent = (n) => `plans-i${Math.min(6, Math.max(1, n))}`

export function renderBlocks(B, chap) {
  let h = ''
  for (const b of B) {
    const ctx = { A: { c: false, b: false }, B: { c: false, b: false }, notes: [], chap }
    switch (b.k) {
      case 'h': h += `<p class="plans-h${b.lv}">${rItems(b.items, ctx)}</p>`; break
      case 'p': h += `<p>${rItems(b.items, ctx)}</p>`; break
      case 'li': {
        const mk = /\d/.test(b.mk) ? esc(b.mk) : '•'
        h += `<p class="plans-li${b.ind ? ' ' + indent(b.ind) : ''}"><span>${mk} </span>${rItems(b.items, ctx)}</p>`
        break
      }
      case 'ind': h += `<p class="plans-ind ${indent(b.ind)}">${rItems(b.items, ctx)}</p>`; break
      case 'bq': h += `<blockquote><p>${rItems(b.items, ctx)}</p></blockquote>`; break
      case 'gone': h += `<p>${rItems(b.items, ctx)}</p>`; break
      case 'hr': h += '<hr>'; break
      case 'pre': h += pre(b.lines.map(preLine).join('\n')); break
      case 'table': {
        const clean = b.lines.every((ln) => ln.every((x) => x.t === '='))
        if (!clean) { h += pre(b.lines.map(preLine).join('\n')); break }
        const rows = b.lines.map(aft).filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map(cells)
        h += '<div class="plans-tw" tabindex="0"><table>' + rows.map((r, ri) => {
          const tg = ri === 0 ? 'th' : 'td'
          return '<tr>' + r.map((c) => `<${tg}>${inl(c, { c: false, b: false })}</${tg}>`).join('') + '</tr>'
        }).join('') + '</table></div>'
        break
      }
    }
    h += ctx.notes.join('')
  }
  return h
}

/* ---------------------------------------------------------------- the API */

export function diff(before, after, opts = {}) {
  if (typeof before !== 'string' || typeof after !== 'string') throw new TypeError('diff: before and after must be strings')
  noteLimit(opts)
  const ops = []
  let coarse = false
  for (const x of diffDoc(before, after)) {
    if (x.eq !== undefined) { if (x.eq) ops.push({ t: 'eq', s: x.eq }); continue }
    if (x.coarse) coarse = true
    const c = x.coarse ? { coarse: true } : {}
    if (x.d) ops.push({ t: 'del', s: x.d, ...c })
    if (x.i) ops.push({ t: 'ins', s: x.i, ...c })
  }
  return { ops, coarse }
}

function noteLimit({ noteWords = 12 } = {}) {
  if (!Number.isInteger(noteWords) || noteWords < 0) throw new RangeError('noteWords must be a non-negative integer')
  return noteWords
}

const COARSE_LABEL = '<p class="plans-coarse-label">Coarse comparison: this passage changed too much to align word by word, so it shows the whole cut text, then the whole new text.</p>'

function coarseBlock(seg) {
  const body = seg.map((x) => x.eq !== undefined
    ? esc(x.eq)
    : (x.d ? `<del class="plans-cut">${esc(x.d)}</del>` : '') + (x.i ? `<ins class="plans-new">${esc(x.i)}</ins>` : '')).join('')
  return COARSE_LABEL + pre(body)
}

export function render(ops, opts = {}) {
  const noteWords = noteLimit(opts)
  if (!Array.isArray(ops)) throw new TypeError('render: ops must be an array')
  const r = []
  for (const o of ops) {
    if (!o || typeof o.s !== 'string' || !['eq', 'del', 'ins'].includes(o.t)) throw new TypeError('render: bad op')
    if (!o.s) continue
    const l = r[r.length - 1]
    if (o.t === 'eq') {
      if (l && l.eq !== undefined) l.eq += o.s
      else r.push({ eq: o.s })
      continue
    }
    let e = l
    if (!e || e.eq !== undefined) { e = { d: '', i: '' }; r.push(e) }
    if (o.t === 'del') e.d += o.s
    else e.i += o.s
    if (o.coarse) e.coarse = true
  }

  const chap = { n: 0 }
  let h = '', run = [], start = true
  const flushRun = () => {
    if (run.some((x) => (x.eq ?? x.d + x.i))) {
      h += renderBlocks(toBlocks(toLines(toItems(run, noteWords)), start), chap)
      start = false
    }
    run = []
  }
  for (let k = 0; k < r.length; k++) {
    const x = r[k]
    if (!x.coarse) { run.push(x); continue }
    // Widen the hunk back to the start of its first line and forward to the end of its last.
    const seg = []
    while (run.length) {
      const l = run[run.length - 1]
      if (l.eq !== undefined) {
        const cut = l.eq.lastIndexOf('\n') + 1
        if (cut > 0) {
          if (cut < l.eq.length) { seg.unshift({ eq: l.eq.slice(cut) }); l.eq = l.eq.slice(0, cut) }
          break
        }
      }
      seg.unshift(run.pop())
    }
    flushRun()
    seg.push(x)
    while (k + 1 < r.length) {
      const nx = r[k + 1]
      if (nx.eq !== undefined) {
        const cut = nx.eq.indexOf('\n') + 1
        if (cut > 0) {
          seg.push({ eq: nx.eq.slice(0, cut) })
          nx.eq = nx.eq.slice(cut)
          if (!nx.eq) k++
          break
        }
      }
      seg.push(nx)
      k++
    }
    h += coarseBlock(seg)
    start = false
  }
  flushRun()
  return `<div class="plans-diff">${h}</div>`
}
