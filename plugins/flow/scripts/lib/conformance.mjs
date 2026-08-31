// The conformance engine: one host-neutral source file marks ids with [[<keyword>:<id>]], and
// every profile beside it binds each of those ids under a "### <keyword>: <id>" heading, with
// prose under it. The stages use keyword "gate" and the charter uses "role"; nothing in here
// knows either word. Callers supply the keyword, the name the failure messages use for the
// source file, and the profile texts as read from disk: the comment stripping every binding
// check needs happens here, so no caller can do half of it.

// Every regex and pattern the checks need, derived from one keyword. Fresh objects per call:
// the global and sticky ones carry a lastIndex, so sharing them across scans would skip matches.
export const markerGrammar = (keyword) => ({
  // The two extractors. Both are silent about what they skip, which is why the near-miss
  // scanners below exist.
  marker: new RegExp(`\\[\\[${keyword}:([a-z][a-z0-9-]*)\\]\\]`, 'g'),
  profileHeading: new RegExp(`^### ${keyword}: ([a-z][a-z0-9-]*)$`, 'gm'),
  // Anything that looks like it was meant to be a marker or a heading, canonical or not. A typo
  // like [[gate:bad_id]] or a capitalized "### Gate:" drops out of both extractors at once and
  // the id comparison still comes back equal, so these run first and pre-empt it.
  // The near-miss opener ignores case and the spaces a human leaves around the keyword and the
  // colon, so "[[Gate:x]]", "[[ gate:x]]" and "[[gate : x]]" are all caught and reported rather
  // than skipped in silence. The heading scan also accepts up to three leading spaces, because
  // CommonMark still renders "   ### gate: x" as a heading and a scan anchored to column one
  // would let that binding hide from both it and the exact extractor. The canonical grammar
  // below is unchanged and stays exact.
  markerLike: new RegExp(`\\[\\[\\s*${keyword}`, 'gi'),
  canonicalMarker: new RegExp(`\\[\\[${keyword}:[a-z][a-z0-9-]*\\]\\]`, 'y'),
  headingLike: new RegExp(`^ {0,3}###\\s*${keyword}\\b.*$`, 'gim'),
  canonicalHeading: new RegExp(`^### ${keyword}: [a-z][a-z0-9-]*$`),
})

export const frontmatter = (text) => /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)

export const body = (text) => {
  const fm = frontmatter(text)
  return fm ? text.slice(fm[0].length) : text
}

// Fenced blocks and inline code are quotation, not markup. A source file explains its own marker
// and heading grammar by writing it out (`[[gate:<id>]]`), and a scanner that reads those as real
// markers fails the file for documenting itself. Vocabulary checks must not use this: a banned
// word inside a code fence is still that word in the shared file.
//
// The walk is line by line rather than one non-greedy regex over the whole text, because a fence
// has more forms than ```...```. CommonMark opens one on three or more backticks or tildes, up to
// three spaces in; it closes on a run of the same character at least as long with nothing after
// it, or on end of file. A regex that only pairs triple backticks leaks the contents of a tilde
// fence, of an unclosed fence, and of a longer fence that quotes a shorter run inside itself.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const unfenced = (text) => {
  const kept = []
  let open = null
  for (const line of text.split('\n')) {
    if (open === null) {
      const fence = FENCE_OPEN.exec(line)
      if (fence) {
        open = fence[1]
        continue
      }
      kept.push(line)
      continue
    }
    const close = FENCE_CLOSE.exec(line)
    if (close && close[1][0] === open[0] && close[1].length >= open.length) open = null
  }
  return kept.join('\n')
}

// Inline code by delimiter run, the way CommonMark reads it: a run of N backticks opens a span
// that ends at the next run of exactly N, and a run that never finds its match is literal text.
// Writing an example with two backticks is how a document quotes something that itself contains a
// backtick, so ``allowed-tools: `x` `` is one span. A scan that only pairs single backticks drops
// the two delimiters and leaves the quoted line standing as prose, which is how a quoted example
// came back as a live declaration.
const spanless = (text) => {
  const runs = [...text.matchAll(/`+/g)].map((hit) => ({ at: hit.index, len: hit[0].length }))
  let kept = ''
  let copied = 0
  let i = 0
  while (i < runs.length) {
    const open = runs[i]
    const close = runs.findIndex((run, j) => j > i && run.len === open.len)
    if (close === -1) {
      i++
      continue
    }
    kept += text.slice(copied, open.at)
    copied = runs[close].at + runs[close].len
    i = close + 1
  }
  return kept + text.slice(copied)
}

export const prose = (text) => spanless(unfenced(text))

// An HTML comment reaches no session: the hook prints the profile verbatim and the model reads
// it as markup, so "<!-- TODO -->" under a heading binds exactly as much as a blank line. A
// commented-out "### <keyword>: x" line is the same nothing, so it must not count as a binding
// either. The unterminated alternative closes on end of text, because text after an opener
// nobody closed is inside the comment too.
export const uncommented = (text) => text.replace(/<!--[\s\S]*?(?:-->|$)/g, '')

export const repeats = (list) => [...new Set(list.filter((v, i) => list.indexOf(v) !== i))]

const idsOf = (re, text) => [...text.matchAll(re)].map((m) => m[1])

// Every marker-like opener the canonical marker regex would not match, as written. The scan
// finds where a marker was attempted; the sticky canonical test at that same offset decides
// whether the attempt succeeded.
const badMarkers = (text, { markerLike, canonicalMarker }) => {
  const found = []
  for (const hit of text.matchAll(markerLike)) {
    const at = hit.index
    canonicalMarker.lastIndex = at
    if (canonicalMarker.test(text)) continue
    const line = text.slice(at).split('\n')[0]
    const close = line.indexOf(']]')
    found.push(close === -1 ? line.slice(0, 40) : line.slice(0, close + 2))
  }
  return found
}

// Every heading-ish line, in any casing or spacing, that is not the canonical form.
const badHeadings = (text, { headingLike, canonicalHeading }) => [...text.matchAll(headingLike)]
  .map((m) => m[0])
  .filter((line) => !canonicalHeading.test(line))

// Where a binding section stops. An ATX heading ends it, and so does a setext one: a line of
// text with nothing but = or - under it renders as a heading too, so a scan that only knows
// about # would swallow the next section's title and its body and call the empty section above
// it full. Both forms may sit up to three spaces in from the margin and still render. The
// separator after the # run is a space or a tab, because CommonMark accepts either, and a scan
// that demands a space reads "##\tBindings" as prose and calls the empty section above it full.
const ATX_HEADING = /^ {0,3}#{1,6}[ \t]/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)\s*$/
const endsSection = (rest, at) => ATX_HEADING.test(rest[at])
  || (rest[at].trim() !== '' && SETEXT_UNDERLINE.test(rest[at + 1] ?? ''))

// A heading with nothing under it binds nothing, and the id comparison below cannot see it: the
// id is declared either way. This reads the comment-free text and not the prose() view, because
// a section whose whole body is a fenced command still binds its id.
const emptyBindings = (keyword, text) => {
  const canonical = new RegExp(`^### ${keyword}: ([a-z][a-z0-9-]*)$`)
  const lines = text.split('\n')
  const empty = []
  for (const [at, line] of lines.entries()) {
    const heading = canonical.exec(line)
    if (!heading) continue
    const rest = lines.slice(at + 1)
    const end = rest.findIndex((_, i) => endsSection(rest, i))
    const section = end === -1 ? rest : rest.slice(0, end)
    if (section.join('\n').trim() === '') empty.push(heading[1])
  }
  return empty
}

// The checker. Grammar, duplication and empty sections come first: once a marker or a heading is
// off-grammar, the two id sets are comparing whatever survived the extractors, and equal sets
// mean nothing.
export const bindingProblems = ({ keyword, sourceName, sourceText, profiles }) => {
  const lf = (text) => text.replace(/\r\n/g, '\n')
  const g = markerGrammar(keyword)
  const problems = []
  const source = prose(body(lf(sourceText)))
  const marked = idsOf(g.marker, source)
  // The one preprocessing point for profiles. Heading discovery and the empty-section scan read
  // the same comment-free text, so a whole binding wrapped in one comment cannot pass both by
  // answering the parity check with a hidden heading and the emptiness check with its own body.
  const readable = Object.fromEntries(
    Object.entries(profiles).map(([name, text]) => [name, uncommented(lf(text))]),
  )
  const bound = Object.fromEntries(
    Object.entries(readable).map(([name, text]) => [name, prose(text)]),
  )

  for (const marker of badMarkers(source, g)) {
    problems.push(`${sourceName} writes ${marker}, which is not a canonical [[${keyword}:<id>]] marker`)
  }
  for (const id of repeats(marked)) problems.push(`${sourceName} marks ${keyword} ${id} more than once`)
  for (const [name, text] of Object.entries(bound)) {
    for (const heading of badHeadings(text, g)) {
      problems.push(`${name} writes "${heading}", which is not a canonical "### ${keyword}: <id>" heading`)
    }
    for (const id of repeats(idsOf(g.profileHeading, text))) {
      problems.push(`${name} declares ${keyword} ${id} in more than one section`)
    }
    for (const id of emptyBindings(keyword, readable[name])) {
      problems.push(`${name} declares ${keyword} ${id} with an empty section`)
    }
  }

  const ids = new Set(marked)
  if (problems.length > 0) return { ids, problems }
  if (marked.length === 0) problems.push(`${sourceName} marks no ${keyword}s at all`)

  for (const [name, text] of Object.entries(bound)) {
    const declared = new Set(idsOf(g.profileHeading, text))
    for (const id of ids) {
      if (!declared.has(id)) {
        problems.push(`${name} has no "### ${keyword}: ${id}" section for a ${keyword} ${sourceName} marks`)
      }
    }
    for (const id of declared) {
      if (!ids.has(id)) problems.push(`${name} declares ${keyword} ${id}, which ${sourceName} never marks`)
    }
  }
  return { ids, problems }
}
