// The seat contract has one author and several readers. plugins/flow/seat-contract.md is the
// host-neutral doctrine; a host wrapper states the mechanism claims only that host can make
// and then repeats the contract verbatim as its tail, because a seat reads the one file it
// was handed and gets no second fetch. This module owns the sentinel that marks where the
// copy starts, the section reader, and the byte comparison that keeps the copy honest.
//
// The contract sits at the plugin root and not under agents/, because the loader validates
// that directory recursively and warns on any file there without frontmatter. A tail cannot
// carry frontmatter, so the two rules cannot both hold in one place.
//
// Byte-equal is the whole point: a paraphrase drifts and nothing catches it, so the check
// refuses the ways a copy can look equal and not be. A tail may not open with frontmatter,
// and the contract may not hold an HTML comment, because a reader that strips comments would
// then act on text the byte check never compared. The section set is closed and each heading
// is written once, because a byte-perfect mirror of a duplicated heading still splits the two
// readers. See sectionShapeProblems() for how.

export const SEAT_CONTRACT_SENTINEL =
  '<!-- seat-contract: plugins/flow/seat-contract.md - byte-equal tail, edit the contract, not this copy -->'

// Written out rather than discovered, so adding or dropping a section is an edit here as
// well as in the contract, and the order is part of the assertion.
export const CONTRACT_SECTIONS = [
  'Containment',
  'Synchronous execution',
  'Scope and completion',
  'Reporting',
]

const CONTEXT = 40

// The heading grammar, mirrored from ATX_HEADING and SETEXT_UNDERLINE in
// scripts/lib/conformance.mjs, which owns the same problem for stage bindings. Two spellings
// render as a heading and a scan for `## ` at column one sees neither. An ATX heading may sit
// up to three spaces in from the margin and may separate its # run from the text with a tab. A
// setext heading is a line of text with nothing but - or = under it, also up to three spaces in,
// and it carries no # at all.
//
// One deliberate difference from the source: the ATX pattern also accepts a bare `##` line with
// nothing after it, which CommonMark renders as an empty level-2 heading. The stage engine only
// asks where a section ends and can skip it. Here an unrecognized rendered heading is the whole
// bug, so the grammar has to be at least as wide as the renderer.
const ATX = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)\s*$/

// A trailing run of hashes closes an ATX heading and is not part of its text: `## Foo ##` is Foo.
const atxText = (rest) => (rest ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()

/**
 * Every heading a markdown renderer would find, in file order.
 *
 * Each entry carries the line index it starts on, the heading level, the heading text, the raw
 * line, and whether it is written in the one canonical form this contract allows, which is a
 * level-2 ATX heading at column one with a single space and one of the four section names.
 *
 * A setext heading reports the index of its text line, not its underline, because that is where
 * the section starts.
 *
 * The setext rule is why a contract may not carry frontmatter, and mirrorProblems() rejects that
 * separately: the closing `---` of a frontmatter block sits under a non-blank line, so this scan
 * would read the last frontmatter key as a level-2 heading.
 */
export function renderedHeadings(text) {
  const lines = text.split('\n')
  const found = []
  for (const [at, line] of lines.entries()) {
    const atx = ATX.exec(line)
    if (atx) {
      found.push({ at, level: atx[1].length, text: atxText(atx[2]), line, form: line.startsWith('#') ? 'ATX' : 'indented ATX' })
      continue
    }
    const underline = SETEXT_UNDERLINE.exec(line)
    const above = lines[at - 1]
    // An underline only makes a heading out of a paragraph line. Under a blank line it is a
    // thematic break, and under another heading it is a break too, so neither counts.
    if (!underline || above === undefined || above.trim() === '') continue
    if (ATX.test(above) || SETEXT_UNDERLINE.test(above)) continue
    found.push({ at: at - 1, level: underline[1].startsWith('=') ? 1 : 2, text: above.trim(), line: above, form: 'setext' })
  }
  return found.map((heading) => ({
    ...heading,
    canonical: heading.level === 2 && CONTRACT_SECTIONS.some((name) => heading.line === `## ${name}`),
  }))
}

// Where a section can start: a rendered heading at level 1 or 2. Deeper ATX headings are
// subsections and belong to the body of the section above them.
const isBoundary = (heading) => heading.level <= 2

/**
 * One `## <heading>` section of a contract: the heading line plus its body, up to the next
 * rendered level-1 or level-2 heading or the end of the file, or `null` when the heading is
 * not there.
 *
 * The section still has to start at a canonical `## <heading>` line, but it ends at any heading
 * a renderer would draw. Extraction and the closure check read the same grammar on purpose. If
 * extraction stopped only at column-zero `## `, an indented or setext heading could sit in a
 * contract that passes the closure and split what the two readers of this file believe.
 *
 * A section runs to the character before the next heading, blank separator line included, so
 * the four sections and the preamble concatenate back into the whole file. Joining the lines
 * alone drops one newline per boundary, because a blank separator line contributes only the
 * newline that ends the line above it, and four sections that do not add back up to the file
 * are four sections with a byte of the contract missing from all of them.
 */
export function contractSection(text, heading) {
  const lines = text.split('\n')
  const start = lines.indexOf(`## ${heading}`)
  if (start === -1) return null
  const next = renderedHeadings(text).find((found) => isBoundary(found) && found.at > start)
  if (!next) return lines.slice(start).join('\n')
  return `${lines.slice(start, next.at).join('\n')}\n`
}

/** The Containment section, the part every host binds a seat to without changing a word. */
export function universalContainment(text) {
  return contractSection(text, 'Containment')
}

// A one-line window into a mismatch. Newlines and tabs are escaped so a problem string stays
// one line in a test report.
const window = (text, at) => text.slice(at, at + CONTEXT).replace(/\n/g, '\\n').replace(/\t/g, '\\t')

const firstDifference = (a, b) => {
  const limit = Math.min(a.length, b.length)
  for (let i = 0; i < limit; i++) {
    if (a[i] !== b[i]) return i
  }
  return limit
}

// The contract's four sections have to be the whole set, each written once, in the one spelling
// the extractor can find.
//
// Two readers see this file differently and that is the whole hazard. A seat that gets the tail
// pasted in whole reads every section a renderer would draw. A seat handed one section at a time
// gets what contractSection() returns, which starts at a canonical `## <name>` line. So a second
// `## Containment` after Reporting reaches the first seat and never the second, and the byte
// check stays green the entire time, because the mirror copied the duplicate faithfully.
//
// Spelling is the same hazard wearing a different hat. `   ## Hidden policy`, three spaces in,
// renders as a heading and starts a section for a reader, while the extractor cannot start
// there, so that section's rules reach one seat and not the other. A setext heading, a line of
// text underlined with hyphens, does the same with no # at all. So the closure runs on the
// rendered heading list and rejects every level-1 and level-2 heading that is not one of the
// four canonical lines, whatever spelling it arrived in.
const sectionShapeProblems = (contractText) => {
  const found = renderedHeadings(contractText).filter(isBoundary)
  const problems = []
  for (const want of CONTRACT_SECTIONS) {
    const count = found.filter((heading) => heading.canonical && heading.text === want).length
    if (count === 1) continue
    problems.push(count === 0
      ? `the contract has no "## ${want}" section, and a seat handed that section alone would get nothing`
      : `the contract writes "## ${want}" ${count} times, and a seat handed that section alone would read only the first`)
  }
  for (const heading of found.filter((candidate) => !candidate.canonical)) {
    problems.push(`the contract renders "${heading.text}" as a level-${heading.level} ${heading.form} heading on line ${heading.at + 1}, and only the four canonical "## " lines at column one may start a section, so this one reaches a seat that reads the whole tail and no seat handed one section`)
  }
  return problems
}

/**
 * Everything wrong with one mirror of the contract, as sentences. An empty array is clean.
 *
 * The mirror carries its own host wrapper above the sentinel and the contract below it. The
 * tail starts at the first character after the sentinel line's newline and is compared with
 * `===`: no trimming, no whitespace forgiveness, because a copy that needs forgiveness is a
 * copy that has already drifted.
 */
export function mirrorProblems({ contractText, mirrorText, mirrorName }) {
  const problems = []
  const name = mirrorName ?? 'the mirror'

  if (contractText.startsWith('---\n')) {
    problems.push('the contract opens with frontmatter, and a file that is pasted in as a tail cannot carry any')
  }
  if (contractText.includes('<!--')) {
    problems.push('the contract holds an HTML comment, so a reader that strips comments sees text the byte check never compared')
  }
  if (contractText.includes('\r')) {
    problems.push('the contract holds a carriage return, and the comparison is byte-exact')
  }
  if (mirrorText.includes('\r')) {
    problems.push(`${name} holds a carriage return, and the comparison is byte-exact`)
  }
  problems.push(...sectionShapeProblems(contractText))
  if (problems.length > 0) return problems

  const lines = mirrorText.split('\n')
  const marks = lines.reduce((found, line, i) => (line === SEAT_CONTRACT_SENTINEL ? [...found, i] : found), [])
  if (marks.length !== 1) {
    problems.push(`${name} holds ${marks.length} sentinel lines, and a mirror needs exactly one`)
    return problems
  }
  const [mark] = marks

  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1)
    if (close === -1) {
      problems.push(`${name} opens frontmatter and never closes it`)
      return problems
    }
    if (mark < close) {
      problems.push(`${name} puts the sentinel on line ${mark + 1}, inside its frontmatter, which closes on line ${close + 1}`)
      return problems
    }
  }

  const tailStart = lines.slice(0, mark + 1).join('\n').length + 1
  const tail = mirrorText.slice(tailStart)
  if (tail === contractText) return problems

  const at = firstDifference(contractText, tail)
  const offset = Buffer.byteLength(contractText.slice(0, at), 'utf8')
  problems.push(
    `${name} has a tail that is not the contract: first difference at byte ${offset}, `
    + `where the contract reads "${window(contractText, at)}" and ${name} reads "${window(tail, at)}"`,
  )
  return problems
}
