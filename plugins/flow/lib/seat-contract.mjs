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
// refuses the two ways a copy can look equal and not be. A tail may not open with
// frontmatter, and the contract may not hold an HTML comment, because a reader that strips
// comments would then act on text the byte check never compared.

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

/**
 * One `## <heading>` section of a contract: the heading line plus its body, up to the next
 * `## ` line or the end of the file, or `null` when the heading is not there.
 *
 * The trailing newline is kept, so a caller can compare or concatenate sections without
 * guessing where the boundary went.
 */
export function contractSection(text, heading) {
  const lines = text.split('\n')
  const start = lines.indexOf(`## ${heading}`)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
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
