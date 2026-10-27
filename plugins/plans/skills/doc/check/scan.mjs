// The narrow lexical reader build.mjs uses to find what it rewrites. It is first-party and written
// from the WHATWG tokenizer's data state, not ported from any tokenizer. It builds no tree and
// reports only what the builder needs:
//
//   scan(html) -> { tokens, unsure }
//     tokens in document order, each with byte-free string offsets [start, end) into html, plus
//     `foreign` (true when it starts while SVG or MathML elements are open) and `template` (how
//     many HTML <template> elements are open where it starts):
//       { type: 'comment', start, end, raw }
//       { type: 'start', name, start, end, attrs: [{ name, value, odd }], selfClosing }
//       { type: 'end', name, start, end }
//       { type: 'raw', name, start, end }   the text inside a raw-text element
//       { type: 'cdata', start, end }       a CDATA section in foreign content, which is text
//     unsure: [{ start, message }], the constructs this reader can't follow, as described below.
//     A caller refuses a page that has any.
//   lineOf(html, offset) -> the 1-based line number of offset
//
// What it reads:
//   - comments: `<!--` up to the first `-->` or `--!>`, plus the abrupt `<!-->` and `<!--->`
//   - bogus comments: `<!` (doctype included, and CDATA in HTML content) and `<?` up to the first
//     `>`, and `</` followed by a non-letter. A `>` inside a quoted doctype identifier ends the
//     doctype here too, because the tokenizer treats it as an abrupt identifier and ends the doctype
//     (checked against Chromium 155 on 2026-10-27)
//   - start and end tags, with double-quoted, single-quoted and unquoted attribute values. Names are
//     lowercased. A later duplicate attribute is kept in attrs, as the browser drops it, so callers
//     read the first. A tag that reaches the end of input is dropped, as the browser drops it.
//   - in HTML content, the raw-text elements script, style, textarea, title, xmp, iframe, noembed,
//     noframes, noscript and plaintext. Script text follows the escaped and double-escaped states, so
//     `<!--<script>` hides a `</script>` exactly as it does in the browser.
//   - character references in attribute values: decimal and hex numeric references, and the five
//     named ones &amp; &lt; &gt; &quot; &apos; with their semicolon. Any other named reference, a
//     named one without its semicolon, and a numeric one the browser would remap (zero, a
//     surrogate, past U+10FFFF, or U+0080 to U+009F) set `odd: true` on the attribute and are
//     left undecoded. A caller that needs the browser's exact value refuses an odd attribute.
//
// Foreign content. Inside <svg> and <math> the tokenizer behaves differently, and neither reading
// more markup than the browser nor less is safe: more accepts a marker the browser keeps as text,
// and less misses a live plans-build meta or kit hook. So the reader models what the tokenizer
// depends on, and refuses what only the tree builder could settle. It keeps a stack of the open
// foreign elements, from an <svg> or <math> start tag read in HTML content until the end tag that
// closes it. Each element takes its parent's namespace, so <math> inside <svg> is an SVG element,
// and the one exception is an <svg> directly inside a MathML <annotation-xml>, which starts SVG.
// While that stack is not empty:
//   - script, style, textarea, title and the other raw-text names are ordinary elements, so their
//     text is read as markup, as the browser reads it
//   - `<![CDATA[` up to the first `]]>` is a cdata token, which is text. In HTML content it stays
//     a bogus comment up to the first `>`
//   - a start tag in the WHATWG breakout list (b, big, blockquote, body, br, center, code, dd,
//     div, dl, dt, em, embed, h1 to h6, head, hr, i, img, li, listing, menu, meta, nobr, ol, p,
//     pre, ruby, s, small, span, strong, strike, sub, sup, table, tt, u, ul, var, and font with a
//     color, face or size attribute), and an end tag </p> or </br>, closes the foreign elements
//     down to the nearest integration point, or all of them, and is then read as HTML
//   - an end tag closes the nearest open foreign element with its name and everything above it
//   - an end tag that matches no open foreign element goes to the HTML tree builder, which may
//     ignore it or may close the <svg> with an HTML ancestor. That depends on elements this reader
//     doesn't track, so it is unsure
//   - inside an HTML integration point (SVG title, desc and foreignObject, and a MathML
//     annotation-xml with encoding text/html or application/xhtml+xml) and a MathML text
//     integration point (mi, mo, mn, ms and mtext), any start tag except mglyph and malignmark in
//     the text points is parsed as HTML, with the tree builder's implied end tags and scopes. A
//     start tag there is unsure, and is still read as HTML, raw text included, for the tokens it
//     reports. Text and comments there are fine, so a figure's <title> and <desc> stay plain text.
// diagrams.md already bans <foreignObject> for layout, and no guide puts markup in a title or a
// desc. The model treats <svg> and <math> as the in-body insertion mode does, which also holds in
// tables, where they are foster-parented, and in <select> in Chromium 155. It doesn't model
// framesets. Checked against Chromium 155's parsed DOM on 2026-10-27, over the 44 breakout names,
// font with a color, 54 other tag names and 59 constructs, with no case where this reader accepts
// what the browser parses differently.
//
// Templates. `template` counts the HTML <template> start tags not yet closed by </template>. A
// <template> in foreign content is an ordinary foreign element and doesn't count. Content inside
// a template is inert, so a caller can refuse what it needs live.

const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext'])
const BREAKOUT = new Set(['b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre',
  'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var'])
const TEXT_POINTS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext'])
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

// Whether a foreign element is an HTML integration point (ip) or a MathML text integration point.
function point(ns, name, attrs) {
  if (ns === 'svg') return { ip: name === 'foreignobject' || name === 'desc' || name === 'title', text: false }
  const enc = attrs.find((a) => a.name === 'encoding')?.value.toLowerCase()
  return { ip: name === 'annotation-xml' && (enc === 'text/html' || enc === 'application/xhtml+xml'), text: TEXT_POINTS.has(name) }
}

const breaksOut = (name, attrs) => BREAKOUT.has(name) || (name === 'font' && attrs.some((a) => a.name === 'color' || a.name === 'face' || a.name === 'size'))

export function scan(html) {
  const s = String(html)
  const n = s.length
  const tokens = []
  const unsure = []
  const stack = []   // open foreign elements: { name, ns, ip, text }
  let template = 0
  const push = (t) => tokens.push({ ...t, foreign: stack.length > 0, template })
  // Pops foreign elements down to the nearest integration point, as a breakout does.
  const breakOut = () => { while (stack.length && !stack.at(-1).ip && !stack.at(-1).text) stack.pop() }
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
      push({ type: 'comment', start: i, end, raw: s.slice(i, end) })
      i = end
      continue
    }
    if (stack.length && s.startsWith('<![CDATA[', i)) {
      const close = s.indexOf(']]>', i + 9)
      const end = close === -1 ? n : close + 3
      push({ type: 'cdata', start: i, end })
      i = end
      continue
    }
    if (s[i + 1] === '!' || s[i + 1] === '?') {
      const gt = s.indexOf('>', i + 2)
      const end = gt === -1 ? n : gt + 1
      push({ type: 'comment', start: i, end, raw: s.slice(i, end) })
      i = end
      continue
    }
    if (s[i + 1] === '/') {
      if (s[i + 2] === '>') { i += 3; continue }
      if (!ALPHA.test(s[i + 2] ?? '')) {
        const gt = s.indexOf('>', i + 2)
        const end = gt === -1 ? n : gt + 1
        push({ type: 'comment', start: i, end, raw: s.slice(i, end) })
        i = end
        continue
      }
      let j = i + 2
      while (j < n && !WS.has(s[j]) && s[j] !== '/' && s[j] !== '>') j++
      const name = s.slice(i + 2, j).toLowerCase()
      const t = readAttrs(s, j)
      if (!t) break
      push({ type: 'end', name, start: i, end: t.end })
      if (stack.length) {
        if (name === 'p' || name === 'br') breakOut()
        else {
          let k = stack.length - 1
          while (k >= 0 && stack[k].name !== name) k--
          if (k >= 0) stack.length = k
          else unsure.push({ start: i, message: `the end tag </${name}> inside <${stack[0].name}> closes no open ${stack[0].ns === 'svg' ? 'SVG' : 'MathML'} element, so where the browser leaves foreign content can't be read: close every element inside it, and close it with </${stack[0].name}>` })
        }
      } else if (name === 'template' && template > 0) template--
      i = t.end
      continue
    }
    if (!ALPHA.test(s[i + 1] ?? '')) { i++; continue }
    let j = i + 1
    while (j < n && !WS.has(s[j]) && s[j] !== '/' && s[j] !== '>') j++
    const name = s.slice(i + 1, j).toLowerCase()
    const t = readAttrs(s, j)
    if (!t) break
    push({ type: 'start', name, start: i, end: t.end, attrs: t.attrs, selfClosing: t.selfClosing })
    i = t.end
    if (stack.length) {
      // The tree builder's dispatch: HTML rules in an integration point, else the foreign rules.
      const inPoint = (top) => top.ip || (top.text && name !== 'mglyph' && name !== 'malignmark')
      const top = stack.at(-1)
      if (!inPoint(top) && top.name === 'annotation-xml' && top.ns === 'math' && name === 'svg') {
        if (!t.selfClosing) stack.push({ name, ns: 'svg', ip: false, text: false })
        continue
      }
      if (!inPoint(top) && !breaksOut(name, t.attrs)) {
        // A foreign element, in its parent's namespace.
        if (!t.selfClosing) stack.push({ name, ns: top.ns, ...point(top.ns, name, t.attrs) })
        continue
      }
      if (!inPoint(top)) breakOut()
      if (stack.length) {
        unsure.push({ start: lt, message: `<${name}> inside <${stack.at(-1).name}> is parsed as HTML in an integration point, which this reader can't follow: keep only text in an SVG title, desc or foreignObject and in MathML text elements` })
      }
    }
    // HTML content, or HTML read inside an integration point.
    if (name === 'svg' || name === 'math') {
      if (!t.selfClosing) stack.push({ name, ns: name, ip: false, text: false })
      continue
    }
    if (name === 'template' && stack.length === 0) template++
    if (RAW.has(name)) {
      const stop = name === 'plaintext' ? -1 : rawEnd(s, name, i)
      const end = stop === -1 ? n : stop
      push({ type: 'raw', name, start: i, end })
      i = end
    }
  }
  return { tokens, unsure }
}

// The first value of an attribute, or undefined.
export function attr(token, name) {
  return token.attrs?.find((a) => a.name === name)
}
