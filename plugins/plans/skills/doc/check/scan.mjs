// The narrow lexical reader build.mjs uses to find what it rewrites. It is first-party and written
// from the WHATWG tokenizer's data state, not ported from any tokenizer. It builds no tree and
// reports only what the builder needs:
//
//   scan(html) -> { tokens }
//     tokens in document order, each with byte-free string offsets [start, end) into html:
//       { type: 'comment', start, end, raw }
//       { type: 'start', name, start, end, attrs: [{ name, value, odd }], selfClosing }
//       { type: 'end', name, start, end }
//       { type: 'raw', name, start, end }   the text inside a raw-text element
//   lineOf(html, offset) -> the 1-based line number of offset
//
// What it reads:
//   - comments: `<!--` up to the first `-->` or `--!>`, plus the abrupt `<!-->` and `<!--->`
//   - bogus comments: `<!` (doctype and CDATA included) and `<?` up to the first `>`, and `</`
//     followed by a non-letter
//   - start and end tags, with double-quoted, single-quoted and unquoted attribute values. Names are
//     lowercased. A later duplicate attribute is kept in attrs, as the browser drops it, so callers
//     read the first. A tag that reaches the end of input is dropped, as the browser drops it.
//   - the raw-text elements script, style, textarea, title, xmp, iframe, noembed, noframes,
//     noscript and plaintext. Script text follows the escaped and double-escaped states, so
//     `<!--<script>` hides a `</script>` exactly as it does in the browser.
//   - character references in attribute values: decimal and hex numeric references, and the five
//     named ones &amp; &lt; &gt; &quot; &apos; with their semicolon. Any other named reference, a
//     named one without its semicolon, and a numeric one the browser would remap (zero, a
//     surrogate, past U+10FFFF, or U+0080 to U+009F) set `odd: true` on the attribute and are
//     left undecoded. A caller that needs the browser's exact value refuses an odd attribute.
//
// Limits. Foreign content is not modelled: inside inline SVG or MathML, style, script and title
// are still read as raw text, and a CDATA section is read as a bogus comment. Both make the scanner
// see less markup than the browser, never more, so a marker or placeholder it finds is one the
// browser also parses as markup. The browser check cross-checks the media it declares.

const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext'])
const WS = new Set(['\t', '\n', '\f', '\r', ' '])
const ALPHA = /[A-Za-z]/
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function lineOf(html, offset) {
  let n = 1
  for (let i = html.indexOf('\n'); i !== -1 && i < offset; i = html.indexOf('\n', i + 1)) n++
  return n
}

function decode(v) {
  let odd = false
  const value = v.replace(/&(#[xX][0-9A-Fa-f]+;?|#[0-9]+;?|[A-Za-z][A-Za-z0-9]*;?)?/g, (m, body) => {
    if (!body) return m
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const digits = body.slice(hex ? 2 : 1).replace(/;$/, '')
      const cp = parseInt(digits, hex ? 16 : 10)
      if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || (cp >= 0x80 && cp <= 0x9f)) { odd = true; return m }
      return String.fromCodePoint(cp)
    }
    if (body.endsWith(';') && Object.hasOwn(NAMED, body.slice(0, -1))) return NAMED[body.slice(0, -1)]
    odd = true
    return m
  })
  return { value, odd }
}

// Reads a tag from the character after its name. Returns { attrs, selfClosing, end } or null when
// the input ends inside the tag.
function readAttrs(s, i) {
  const attrs = []
  const n = s.length
  for (;;) {
    while (i < n && (WS.has(s[i]) || (s[i] === '/' && s[i + 1] !== '>'))) i++
    if (i >= n) return null
    if (s[i] === '>') return { attrs, selfClosing: false, end: i + 1 }
    if (s[i] === '/' && s[i + 1] === '>') return { attrs, selfClosing: true, end: i + 2 }
    // An attribute name. A leading `=` belongs to the name.
    const a = i
    i++
    while (i < n && !WS.has(s[i]) && s[i] !== '/' && s[i] !== '>' && s[i] !== '=') i++
    const name = s.slice(a, i).toLowerCase()
    while (i < n && WS.has(s[i])) i++
    if (s[i] !== '=') { attrs.push({ name, value: '', odd: false }); continue }
    i++
    while (i < n && WS.has(s[i])) i++
    if (i >= n) return null
    let raw
    if (s[i] === '"' || s[i] === "'") {
      const close = s.indexOf(s[i], i + 1)
      if (close === -1) return null
      raw = s.slice(i + 1, close)
      i = close + 1
    } else {
      const b = i
      while (i < n && !WS.has(s[i]) && s[i] !== '>') i++
      raw = s.slice(b, i)
    }
    attrs.push({ name, ...decode(raw) })
  }
}

// The offset of the `</name` that ends a raw-text element whose text starts at i, or -1.
function rawEnd(s, name, i) {
  const re = new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'ig')
  if (name !== 'script') {
    re.lastIndex = i
    const m = re.exec(s)
    return m ? m.index : -1
  }
  // Script data, with the escaped and double-escaped states.
  const open = /<script[\t\n\f\r />]/iy
  let state = 'data'
  while (i < s.length) {
    const lt = state === 'data' ? s.indexOf('<', i) : searchFirst(s, i, state)
    if (lt === -1) return -1
    if (s.startsWith('-->', lt)) { state = 'data'; i = lt + 3; continue }
    re.lastIndex = lt
    const m = re.exec(s)
    if (m && m.index === lt) {
      if (state === 'double') { state = 'escaped'; i = lt + 2; continue }
      return lt
    }
    if (state === 'data' && s.startsWith('<!--', lt)) { state = 'escaped'; i = lt + 2; continue }
    open.lastIndex = lt
    if (state === 'escaped' && open.test(s)) { state = 'double'; i = lt + 7; continue }
    i = lt + 1
  }
  return -1
}

// In the escaped states the next interesting place is a `<` or the `-->` that ends the escape.
function searchFirst(s, i, state) {
  const lt = s.indexOf('<', i), dash = s.indexOf('-->', i)
  if (lt === -1) return dash
  if (dash === -1) return lt
  return Math.min(lt, dash)
}

export function scan(html) {
  const s = String(html)
  const n = s.length
  const tokens = []
  let i = 0
  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt === -1) break
    i = lt
    if (s.startsWith('<!--', i)) {
      let end
      if (s.startsWith('<!-->', i)) end = i + 5
      else if (s.startsWith('<!--->', i)) end = i + 6
      else {
        const a = s.indexOf('-->', i + 4), b = s.indexOf('--!>', i + 4)
        if (a === -1 && b === -1) end = n
        else if (b === -1 || (a !== -1 && a < b)) end = a + 3
        else end = b + 4
      }
      tokens.push({ type: 'comment', start: i, end, raw: s.slice(i, end) })
      i = end
      continue
    }
    if (s[i + 1] === '!' || s[i + 1] === '?') {
      const gt = s.indexOf('>', i + 2)
      const end = gt === -1 ? n : gt + 1
      tokens.push({ type: 'comment', start: i, end, raw: s.slice(i, end) })
      i = end
      continue
    }
    if (s[i + 1] === '/') {
      if (s[i + 2] === '>') { i += 3; continue }
      if (!ALPHA.test(s[i + 2] ?? '')) {
        const gt = s.indexOf('>', i + 2)
        const end = gt === -1 ? n : gt + 1
        tokens.push({ type: 'comment', start: i, end, raw: s.slice(i, end) })
        i = end
        continue
      }
      let j = i + 2
      while (j < n && !WS.has(s[j]) && s[j] !== '/' && s[j] !== '>') j++
      const name = s.slice(i + 2, j).toLowerCase()
      const t = readAttrs(s, j)
      if (!t) break
      tokens.push({ type: 'end', name, start: i, end: t.end })
      i = t.end
      continue
    }
    if (!ALPHA.test(s[i + 1] ?? '')) { i++; continue }
    let j = i + 1
    while (j < n && !WS.has(s[j]) && s[j] !== '/' && s[j] !== '>') j++
    const name = s.slice(i + 1, j).toLowerCase()
    const t = readAttrs(s, j)
    if (!t) break
    tokens.push({ type: 'start', name, start: i, end: t.end, attrs: t.attrs, selfClosing: t.selfClosing })
    i = t.end
    if (RAW.has(name)) {
      const stop = name === 'plaintext' ? -1 : rawEnd(s, name, i)
      const end = stop === -1 ? n : stop
      tokens.push({ type: 'raw', name, start: i, end })
      i = end
    }
  }
  return { tokens }
}

// The first value of an attribute, or undefined.
export function attr(token, name) {
  return token.attrs?.find((a) => a.name === name)
}
