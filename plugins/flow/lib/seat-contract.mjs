// The seat contract has one author and several readers. plugins/flow/seat-contract.md is the
// host-neutral doctrine; a host wrapper states the mechanism claims only that host can make
// and then repeats the contract verbatim as its tail, because a seat reads the one file it
// was handed and gets no second fetch. This module owns the sentinel that marks where the
// copy starts, the tail split, and the one section a delegated seat is handed on its own.
//
// The contract sits at the plugin root and not under agents/, because the loader validates
// that directory recursively and warns on any file there without frontmatter. A tail cannot
// carry frontmatter, so the two rules cannot both hold in one place.

export const SEAT_CONTRACT_SENTINEL =
  '<!-- seat-contract: plugins/flow/seat-contract.md - byte-equal tail, edit the contract, not this copy -->'

/**
 * Everything after the sentinel line in a wrapper, or `null` when the wrapper does not carry
 * exactly one sentinel.
 *
 * The tail starts at the first character after the sentinel line's newline, so the caller can
 * compare it with the contract using `===`: no trimming, no whitespace forgiveness, because a
 * copy that needs forgiveness is a copy that has already drifted.
 */
export function mirrorTail(text) {
  const lines = text.split('\n')
  const marks = lines.filter((line) => line === SEAT_CONTRACT_SENTINEL).length
  if (marks !== 1) return null
  const at = lines.indexOf(SEAT_CONTRACT_SENTINEL)
  return text.slice(lines.slice(0, at + 1).join('\n').length + 1)
}

/**
 * The Containment section, heading included: the part every host binds a seat to without
 * changing a word, and the only section the delegation bundle carries.
 *
 * The section runs from its own `## Containment` line to the character before the next `## `
 * line, so a seat handed the section alone reads the same bytes as a seat handed the whole
 * tail. Returns `null` when the contract has no such heading.
 */
export function universalContainment(text) {
  const lines = text.split('\n')
  const start = lines.indexOf('## Containment')
  if (start === -1) return null
  const next = lines.findIndex((line, at) => at > start && line.startsWith('## '))
  if (next === -1) return lines.slice(start).join('\n')
  return `${lines.slice(start, next).join('\n')}\n`
}
