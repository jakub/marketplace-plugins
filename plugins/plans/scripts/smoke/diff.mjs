// Prose diff: skills/doc/kit/diff.mjs rebuilds both inputs byte for byte from its ops, keeps a
// literal U+2029 as text, draws one ¶ for a paragraph merge, turns a cut over noteWords into a
// numbered caret and one margin note, falls back to pre.plans-pre for a changed table or fence,
// labels a hunk coarse past the pair cap after trimming, escapes its input, and writes no style
// attribute and no class outside the plans-* contract.

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CLASSES = new Set(['plans-diff', 'plans-cut', 'plans-new', 'plans-pil', 'plans-caret', 'plans-note', 'plans-pre',
  'plans-coarse-label', 'plans-h1', 'plans-h2', 'plans-h3', 'plans-h4', 'plans-h5', 'plans-h6', 'plans-li', 'plans-ind',
  'plans-tw', 'plans-i1', 'plans-i2', 'plans-i3', 'plans-i4', 'plans-i5', 'plans-i6'])
const TAGS = new Set(['div', 'p', 'span', 'del', 'ins', 'sup', 'b', 'strong', 'code', 'pre', 'blockquote', 'hr', 'table',
  'tr', 'th', 'td'])

const count = (s, needle) => s.split(needle).length - 1
const words = (n, from = 0) => Array.from({ length: n }, (_, i) => `w${from + i}x`).join(' ')
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i}\n`).join('')

export default async function ({ ROOT, check }) {
  const { diff, render, lcs, CAP } = await import(pathToFileURL(join(ROOT, 'plugins/plans/skills/doc/kit/diff.mjs')).href)
  const outs = []
  const run = (before, after, opts) => {
    const d = diff(before, after, opts)
    const html = render(d.ops, opts)
    outs.push(html)
    return { ...d, html }
  }
  const rebuilt = (ops, side) => ops.filter((o) => o.t === 'eq' || o.t === side).map((o) => o.s).join('')
  const same = (a, b) => Buffer.from(a, 'utf8').equals(Buffer.from(b, 'utf8'))

  // Reconstruction, byte for byte through Buffer equality.
  const pairs = {
    'BOM': ['﻿# Title\n\nBody text.\n', '﻿# Title\n\nBody text, changed.\n'],
    'BOM removed': ['﻿One line.\n', 'One line.\n'],
    'CRLF': ['First line\r\nsecond line\r\n\r\nNext paragraph.\r\n', 'First line\r\nsecond row\r\n\r\nNext para.\r\n'],
    'missing final newline': ['Alpha beta.\nGamma delta.\n', 'Alpha beta.\nGamma epsilon.'],
    'repeated whitespace': ['a   b\t\tc  \n\n\n\nd', 'a b  c\t\n\nd   '],
    'emoji': ['Thumbs 👍 ok 😀 and 👨‍👩‍👧 family.\n', 'Thumbs 👎 ok 😃 and 👨‍👩‍👦 family.\n'],
    'combining marks': ['The café is open. Ñ = Ñ.\n', 'The cafe is open. Ñ = Ǹ.\n'],
    'U+2028': ['one two three\n', 'one two three\n'],
    'U+2029': ['alpha beta gamma\n', 'alpha beta delta \n'],
    'empty to text': ['', 'Some text.\n'],
    'text to empty': ['Some text.\n', ''],
    'both empty': ['', ''],
    'identical': ['# Same\n\n- item\n\nText **bold** and `code`.\n', '# Same\n\n- item\n\nText **bold** and `code`.\n'],
    'many removed breaks': ['a\n\nb\n\n\nc\n\nd\n', 'a b c d\n'],
  }
  for (const [name, [before, after]] of Object.entries(pairs)) {
    const d = run(before, after)
    check(`reconstruction (${name}): eq+del rebuilds before`, same(rebuilt(d.ops, 'del'), before))
    check(`reconstruction (${name}): eq+ins rebuilds after`, same(rebuilt(d.ops, 'ins'), after))
    check(`reconstruction (${name}): rendered HTML is well-formed Unicode`, d.html.isWellFormed())
  }
  {
    const d = run(...pairs.identical)
    check('identical inputs give only eq ops', d.ops.every((o) => o.t === 'eq') && !d.coarse)
    check('identical inputs render no change marks', !/plans-(cut|new|pil|caret|note)/.test(d.html), d.html)
  }
  check('both-empty renders an empty diff block', render(diff('', '').ops) === '<div class="plans-diff"></div>')

  // A literal U+2029 is text, never a generated ¶.
  {
    const d = run('Keep alpha beta gamma.\n', 'Keep alpha beta delta.\n')
    check('a literal U+2029 renders as text', d.html.includes(' '), d.html)
    check('a literal U+2029 renders no plans-pil', !d.html.includes('plans-pil'), d.html)
    const cut = run('Keep this  and drop these words.\n', 'Keep this.\n')
    check('a U+2029 inside a cut renders no plans-pil', !cut.html.includes('plans-pil') && cut.html.includes(' '), cut.html)
  }

  // A pure paragraph merge draws exactly one ¶.
  {
    const d = run('First paragraph here.\n\nSecond paragraph here.\n', 'First paragraph here. Second paragraph here.\n')
    check('a pure paragraph merge renders exactly one plans-pil', count(d.html, 'class="plans-pil"') === 1, d.html)
  }

  // 12 words stay inline, 13 become a caret and one note, never collapsed.
  {
    const twelve = run(`Start ${words(12)} end.\n`, 'Start end.\n')
    check('a 12-word cut stays inline as del.plans-cut', twelve.html.includes('<del class="plans-cut">') &&
      !twelve.html.includes('plans-caret') && !twelve.html.includes('plans-note'), twelve.html)
    const thirteen = run(`Start ${words(13)} end.\n`, 'Start end.\n')
    check('a 13-word cut renders one numbered caret', count(thirteen.html, 'class="plans-caret"') === 1 &&
      thirteen.html.includes('‸<b>1</b></sup>'), thirteen.html)
    check('a 13-word cut renders one plans-note', count(thirteen.html, 'class="plans-note"') === 1, thirteen.html)
    check('the note holds the full cut text', thirteen.html.includes(`<span class="plans-note"><b>1</b> <del class="plans-cut">${words(13)} </del></span>`), thirteen.html)
    check('the note has no collapse control', !/<button|\shidden|aria-expanded|more words/.test(thirteen.html), thirteen.html)
    const wide = run(`Start ${words(13)} end.\n`, 'Start end.\n', { noteWords: 13 })
    check('noteWords moves the threshold', !wide.html.includes('plans-note'), wide.html)
  }

  // Note numbers restart at 1 in every render call.
  {
    // The kept paragraph between the cuts is longer than either cut, so cleanup keeps them apart.
    const kept = 'This kept paragraph runs longer than either cut beside it, so the semantic cleanup leaves the two cuts apart.'
    const before = `Para one ${words(14, 0)} tail.\n\n${kept}\n\nPara two ${words(14, 100)} tail.\n`
    const { ops } = diff(before, `Para one tail.\n\n${kept}\n\nPara two tail.\n`)
    const first = render(ops), second = render(ops)
    outs.push(first)
    const carets = (h) => [...h.matchAll(/‸<b>(\d+)<\/b>/g)].map((m) => m[1]).join(',')
    check('notes number 1 and 2 in one block', carets(first) === '1,2', carets(first))
    check('note numbering restarts per render call', carets(second) === '1,2', carets(second))
  }

  // Changed tables and fences fall back to pre.plans-pre; an unchanged table stays a table.
  {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |\n'
    const t = run(`Intro.\n\n${table}`, `Intro.\n\n${table.replace('| 2 |', '| 3 |')}`)
    check('a changed table falls back to pre.plans-pre', t.html.includes('<pre class="plans-pre">') && !t.html.includes('<table') &&
      /<pre class="plans-pre">[^]*<del class="plans-cut">2<\/del><ins class="plans-new">3<\/ins>/.test(t.html), t.html)
    const u = run(`Intro.\n\n${table}`, `Intro changed.\n\n${table}`)
    check('an unchanged table renders in div.plans-tw', u.html.includes('<div class="plans-tw" tabindex="0"><table>') && !u.html.includes('plans-pre'), u.html)
    const f = run('Text.\n\n```js\nconst a = 1\n```\n', 'Text.\n\n```js\nconst a = 2\n```\n')
    check('a changed fence falls back to pre.plans-pre', /<pre class="plans-pre">[^]*<del class="plans-cut">1<\/del><ins class="plans-new">2<\/ins>[^]*<\/pre>/.test(f.html), f.html)
  }

  // A table or fence on either side selects the fallback, including one that only the before text
  // holds, so a cut fence never parses as inline code and a cut table never becomes a paragraph.
  {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |\n'
    const inPre = (h, re) => [...h.matchAll(/<pre class="plans-pre">([^]*?)<\/pre>/g)].some((m) => re.test(m[1]))
    const cases = [
      ['deleted table', table, '', /<del class="plans-cut">\| a \| b \|/],
      ['added table', '', table, /<ins class="plans-new">\| a \| b \|/],
      ['deleted fence', 'Text.\n\n```js\nconst a = 1\n```\n', 'Text.\n', /<del class="plans-cut">[^<]*(<span [^>]*>¶<\/span>)? ```js/],
      ['added fence', 'Text.\n', 'Text.\n\n```js\nconst a = 1\n```\n', /<ins class="plans-new">\n?```js/],
      ['fence delimiters removed', '```\nhello\n```\n', 'hello\n', /<del class="plans-cut">```[^]*hello[^]*<del class="plans-cut">```/],
      ['fence delimiters added', 'hello\n', '```\nhello\n```\n', /<ins class="plans-new">```[^]*hello[^]*<ins class="plans-new">```/],
      ['table row removed', `${table}| 3 | 4 |\n`, table, /<del class="plans-cut">\| 3 \| 4 \|/],
      ['table row added', table, `${table}| 3 | 4 |\n`, /<ins class="plans-new">\| 3 \| 4 \|/],
    ]
    for (const [name, before, after, re] of cases) {
      const d = run(before, after)
      check(`${name}: eq+del rebuilds before`, same(rebuilt(d.ops, 'del'), before))
      check(`${name}: eq+ins rebuilds after`, same(rebuilt(d.ops, 'ins'), after))
      check(`${name}: falls back to pre.plans-pre with the change inside`, inPre(d.html, re), d.html)
      check(`${name}: renders no table, no code and no ¶ outside the pre`, !/<table|<code/.test(d.html) &&
        !d.html.replace(/<pre class="plans-pre">[^]*?<\/pre>/g, '').includes('plans-pil'), d.html)
    }
    const after = run(`Intro.\n\n${table}\nOutro stays a paragraph.\n`, 'Intro.\n\nOutro stays a paragraph.\n')
    check('a deleted table leaves the paragraph after it outside the pre', after.html.includes('<p>Outro stays a paragraph.</p>') &&
      inPre(after.html, /<del class="plans-cut">\| a \| b \|/), after.html)
    const fenced = run('Intro.\n\n```\ncode\n```\n\nOutro stays a paragraph.\n', 'Intro.\n\nOutro stays a paragraph.\n')
    check('a deleted fence leaves the paragraph after it outside the pre', fenced.html.includes('<p>Outro stays a paragraph.</p>') &&
      inPre(fenced.html, /<del class="plans-cut">```/), fenced.html)
  }

  // The pair cap applies after prefix and suffix trimming, at both levels.
  {
    const distinct = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`)
    check('the cap is 4,000,000 pairs', CAP === 4e6)
    check('a 2000x2000 core is at the cap and aligns in full', !lcs(distinct(2000, 'a'), distinct(2000, 'b')).some((o) => o.c))
    check('a 2000x2001 core is over the cap and coarse', lcs(distinct(2000, 'a'), distinct(2001, 'b')).some((o) => o.c))

    const prefix = lines(3000, 'shared')
    const small = run(`${prefix}tail old\n`, `${prefix}tail new\n`)
    check('a huge shared prefix with a small edit is not coarse (raw 3001x3001 lines)', !small.coarse && !small.html.includes('plans-coarse-label'))

    const big = run(`${prefix}${lines(2100, 'old')}`, `${prefix}${lines(2100, 'new')}`)
    check('a trimmed line core over the cap is coarse', big.coarse === true && big.ops.some((o) => o.coarse))
    check('a coarse line hunk is labelled', count(big.html, 'class="plans-coarse-label"') === 1, big.html.slice(0, 400))
    check('a coarse line hunk renders in pre.plans-pre', /<p class="plans-coarse-label">[^<]*<\/p><pre class="plans-pre">\n<del class="plans-cut">old line 0\n/.test(big.html))
    check('a coarse hunk rebuilds both inputs', same(rebuilt(big.ops, 'del'), `${prefix}${lines(2100, 'old')}`) &&
      same(rebuilt(big.ops, 'ins'), `${prefix}${lines(2100, 'new')}`))

    const para = run(`Lead.\n\nHead ${words(1500, 0)} foot.\n\nTail.\n`, `Lead.\n\nHead ${words(1500, 5000)} foot.\n\nTail.\n`)
    check('a trimmed word core over the cap is coarse', para.coarse === true, String(para.coarse))
    check('a coarse word hunk widens to whole lines', para.html.includes('<pre class="plans-pre">\nHead <del class="plans-cut">w0x') &&
      para.html.includes('</ins> foot.\n</pre>'), para.html.slice(0, 300))
    check('text around a coarse hunk is still set as markdown', para.html.startsWith('<div class="plans-diff"><p>Lead.</p><p class="plans-coarse-label">') &&
      para.html.endsWith('</pre><p>Tail.</p></div>'))
  }

  // Hostile markup comes out as text.
  {
    const before = '# <script>alert(1)</script>\n\nSay "hi" & <b>bold</b>\n\n| <img src=x onerror=alert(1)> | x |\n|---|---|\n| y | z |\n\n```\n<script>\n```\n'
    const after = '# <script>alert(2)</script>\n\nSay "bye" & <b>bold</b> <iframe>\n\n| <img src=x onerror=alert(1)> | x |\n|---|---|\n| y | <svg onload=1> |\n\n```\n<script src="//x">\n```\n'
    const long = `Keep <a href="x">this</a> ${words(14)} "quoted" <script>x()</script>.\n`
    const h = [run(before, after).html, run(long, 'Keep.\n').html, run(`${lines(2100, '<b>old')}`, `${lines(2100, '<i>new')}`).html].join('')
    const tags = [...new Set([...h.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase()))].filter((t) => !TAGS.has(t))
    check('hostile markup is escaped: only the engine\'s own tags appear', tags.length === 0, tags.join(' '))
    check('hostile markup is escaped: script text survives as text', h.includes('&lt;script&gt;alert(') && h.includes('&quot;quoted&quot;') && h.includes('&lt;img src=x onerror=alert(1)&gt;'))
  }

  // No style attribute, and only contract classes, in any output.
  const all = outs.join('\n')
  check('no style= in any output', !/\sstyle\s*=/i.test(all))
  const stray = [...new Set([...all.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)))].filter((c) => !CLASSES.has(c))
  check('only contract plans-* class names in any output', stray.length === 0, stray.join(' '))
  check('every output is one div.plans-diff', outs.every((h) => h.startsWith('<div class="plans-diff">') && h.endsWith('</div>')))
}
