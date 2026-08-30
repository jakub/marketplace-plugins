// The conformance engine: one host-neutral source file marks ids with [[<keyword>:<id>]], and
// every profile beside it binds each of those ids under a "### <keyword>: <id>" heading. The
// land stage uses keyword "gate"; nothing in here knows that word. Callers supply the keyword,
// the name the failure messages use for the source file, and the profile texts.

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
  markerLike: `[[${keyword}`,
  canonicalMarker: new RegExp(`\\[\\[${keyword}:[a-z][a-z0-9-]*\\]\\]`, 'y'),
  headingLike: new RegExp(`^###\\s*${keyword}\\b.*$`, 'gim'),
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
export const prose = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')

export const repeats = (list) => [...new Set(list.filter((v, i) => list.indexOf(v) !== i))]

const idsOf = (re, text) => [...text.matchAll(re)].map((m) => m[1])

// Every markerLike substring that the canonical marker regex would not match, as written.
const badMarkers = (text, { markerLike, canonicalMarker }) => {
  const found = []
  for (let at = text.indexOf(markerLike); at !== -1; at = text.indexOf(markerLike, at + 1)) {
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

// The checker. Grammar and duplication come first: once a marker or a heading is off-grammar,
// the two id sets are comparing whatever survived the extractors, and equal sets mean nothing.
export const bindingProblems = ({ keyword, sourceName, sourceText, profiles }) => {
  const lf = (text) => text.replace(/\r\n/g, '\n')
  const g = markerGrammar(keyword)
  const problems = []
  const source = prose(body(lf(sourceText)))
  const marked = idsOf(g.marker, source)
  const bound = Object.fromEntries(
    Object.entries(profiles).map(([name, text]) => [name, prose(lf(text))]),
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
