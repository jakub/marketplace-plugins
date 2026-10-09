// The runtime's small pure views, run in node with no DOM. The changes label (patch 0007): HtmlPlan.changesView takes the
// doc-changes attributes as getAttribute returns them, so an absent label reads "Proposed", an empty one draws none, any other
// value stays plain text, and zero counts hide the element. Quote links (patch 0008): HtmlPlan.safeHref passes http and https
// only, by the URL parser's reading of the scheme, and the link it feeds opens in the same frame after a state flush. The shipped
// vendored set holds no _blank and no claude.ai hand-over wording. Copy-out (patch 0009): the Respond sheet says "Copied" only
// after the browser confirms the copy, and otherwise selects the response for a copy by hand.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

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
}
