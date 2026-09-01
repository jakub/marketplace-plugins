#!/usr/bin/env node
// Conformance lint for the label tuple. skills/flow/label-contract.md is the only place the
// (name, color, description) triple is written down, and reconciliation copies all three into
// GitHub label metadata on every repo the pipeline touches. That is the one string set in this
// plugin with a blast radius outside the repo, and nothing else reviews it: a description that
// spells a slash command teaches every reader of every issue one host's vocabulary, and a
// description GitHub truncates is a contract nobody can read back.
//
// So the rules are mechanical. A label name is lowercase letters and hyphens; a color is six
// lowercase hex digits; one lane is one color; a description is non-empty, at most 100 Unicode
// code points, and holds no "/" at all, since every slash-command spelling in this file's
// history had one and a bare slash buys the descriptions nothing.
//
// The tuple itself lives only in the markdown. This script never writes a description string
// down, because a copy here would be a second source of truth that drifts silently and passes.
// It reads the table, and if the parse comes back short the run goes red rather than reporting
// that zero rows are all fine: a checker that matches nothing has to look like a failure.
//
// The same checker runs over the broken taxonomies at the bottom - one per way the tuple goes
// wrong, each built by mutating a mini taxonomy or the real file - so a green run also means
// the checker can still fail and says where.
// Run: node plugins/flow/scripts/smoke-label-contract.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT = join(ROOT, 'skills', 'flow', 'label-contract.md')

// Every value that shows up twice in a list. One line, so it lives here rather than in a
// library shared with lints that have nothing else in common with this one.
const repeats = (list) => [...new Set(list.filter((v, i) => list.indexOf(v) !== i))]

// The taxonomy is nine lifecycle labels and three type modifiers. The floors are what tells a
// failed parse apart from a passing file: below either one the checker reports the parse and
// checks nothing, so a renamed heading or a reformatted table reads red.
const LIFECYCLE_ROWS = 9
const MODIFIERS = 3
const HEADING = '## Taxonomy (the state machine)'
const MODIFIER_LEAD = /^Type modifiers\b/
const NAME = /^[a-z][a-z-]{1,48}$/
const COLOR = /^[0-9a-f]{6}$/
const DESCRIPTION_LIMIT = 100

// Fenced blocks are quotation: the state-machine diagram sits in one, directly under the
// heading. Inline code spans stay, unlike the binding engine's prose() view, because the table
// writes every name and color in backticks and stripping the spans would delete the tuple.
//
// An opening fence may carry an info string (```toml); a CLOSING fence may not - it is the
// delimiter run and only optional trailing whitespace, anchored. So ```still-code does not
// close a block: matching it as a close would let the taxonomy table leak out of an
// unterminated diagram fence and parse as if the block were properly closed, a green check on
// text that is actually all quotation. Leaving the block open instead drops the table, the
// parse comes back short, and the run goes red where it should.
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})/
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const unfenced = (lines) => {
  const kept = []
  let open = null
  for (const line of lines) {
    if (open === null) {
      const opener = OPEN_FENCE.exec(line)
      if (opener) open = opener[1]
      else kept.push(line)
      continue
    }
    const closer = CLOSE_FENCE.exec(line)
    if (closer && closer[1][0] === open[0] && closer[1].length >= open.length) open = null
  }
  return kept
}

// A row is a pipe line with six cells. The header and the |---| separator drop out by name and
// by shape, and anything else that is not six cells is not a row this file writes.
const SEPARATOR = /^:?-{3,}:?$/
const bare = (cell) => cell.replaceAll('`', '').trim()
const cellsOf = (line) => {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim())
}

export const parseTaxonomy = (text) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => line.trim() === HEADING)
  if (start === -1) return { rows: [], modifiers: [] }
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^ {0,3}## /.test(line))
  const section = unfenced(end === -1 ? rest : rest.slice(0, end))

  const rows = []
  for (const line of section) {
    const cells = cellsOf(line)
    if (cells === null || cells.length !== 6) continue
    if (cells.every((cell) => SEPARATOR.test(cell))) continue
    if (bare(cells[0]).toLowerCase() === 'label') continue
    rows.push({
      name: bare(cells[0]),
      lane: bare(cells[1]),
      color: bare(cells[2]),
      // The description is the published string, so it keeps whatever the cell holds. Only the
      // name and the color are unwrapped, because the table quotes those as code.
      description: cells[3],
      setBy: cells[4],
      clearedBy: cells[5],
    })
  }

  // The modifiers are one paragraph, not a table: the lead line, then the names and colors
  // until the paragraph ends. Anchoring on the lead keeps a stray backticked pair elsewhere in
  // the section from counting as a modifier.
  const lead = section.findIndex((line) => MODIFIER_LEAD.test(line.trim()))
  const paragraph = []
  for (let at = lead; lead !== -1 && at < section.length; at++) {
    if (section[at].trim() === '') break
    paragraph.push(section[at])
  }
  const modifiers = [...paragraph.join('\n').matchAll(/`([^`]+)`\s*\(`([^`]+)`\)/g)]
    .map((hit) => ({ name: hit[1].trim(), color: hit[2].trim() }))

  return { rows, modifiers }
}

export const labelProblems = (text) => {
  const { rows, modifiers } = parseTaxonomy(text)
  if (rows.length < LIFECYCLE_ROWS || modifiers.length < MODIFIERS) {
    return [`the taxonomy did not parse: ${rows.length} table rows and ${modifiers.length} type `
      + `modifiers under "${HEADING}", at least ${LIFECYCLE_ROWS} and ${MODIFIERS} expected`]
  }

  const problems = []
  const lanes = new Map()
  for (const row of rows) {
    if (!NAME.test(row.name)) {
      problems.push(`label "${row.name}" is not a legal label name (${NAME.source})`)
    }
    if (!COLOR.test(row.color)) {
      problems.push(`label "${row.name}" carries color "${row.color}", which is not six lowercase hex digits`)
    }
    const points = [...row.description].length
    if (points === 0) problems.push(`label "${row.name}" has an empty description`)
    else if (points > DESCRIPTION_LIMIT) {
      problems.push(`label "${row.name}" has a description of ${points} code points, over the `
        + `${DESCRIPTION_LIMIT}-point ceiling`)
    }
    if (row.description.includes('/')) {
      problems.push(`label "${row.name}" has a description containing "/", which is how a host's `
        + `command spelling reaches GitHub: "${row.description}"`)
    }
    if (!lanes.has(row.lane)) lanes.set(row.lane, new Set())
    lanes.get(row.lane).add(row.color)
  }

  for (const modifier of modifiers) {
    if (!NAME.test(modifier.name)) {
      problems.push(`type modifier "${modifier.name}" is not a legal label name (${NAME.source})`)
    }
    if (!COLOR.test(modifier.color)) {
      problems.push(`type modifier "${modifier.name}" carries color "${modifier.color}", which is not six lowercase hex digits`)
    }
  }

  for (const name of repeats([...rows.map((row) => row.name), ...modifiers.map((m) => m.name)])) {
    problems.push(`label "${name}" appears more than once in the taxonomy`)
  }

  for (const [lane, colors] of lanes) {
    if (colors.size > 1) {
      problems.push(`lane "${lane}" carries ${colors.size} colors (${[...colors].sort().join(', ')}); one lane is one color`)
    }
  }

  return problems
}

let checks = 0
const ok = (line) => {
  checks++
  console.log(`  ok: ${line}`)
}

// Everything below runs on invocation. The two helpers above are exported so another script can
// read the tuple without re-parsing the markdown by hand.
console.log('the real contract')
const contract = readFileSync(CONTRACT, 'utf8')
const { rows, modifiers } = parseTaxonomy(contract)
assert.ok(rows.length >= LIFECYCLE_ROWS, `the taxonomy parsed ${rows.length} rows`)
assert.ok(modifiers.length >= MODIFIERS, `the taxonomy parsed ${modifiers.length} type modifiers`)
ok(`the taxonomy parses as ${rows.length} lifecycle rows and ${modifiers.length} type modifiers: ${rows.map((row) => row.name).join(', ')}`)

const problems = labelProblems(contract)
assert.deepEqual(problems, [], problems.join('\n'))
const longest = Math.max(...rows.map((row) => [...row.description].length))
ok(`every tuple validates: names, six-hex colors, one color per lane, and descriptions with no slash, the longest ${longest} of ${DESCRIPTION_LIMIT} code points`)

// The lane map is the reason a repaint is drift rather than a cosmetic change, so say what the
// file actually holds instead of asserting a color list this script would then have to own.
const lanes = new Map()
for (const row of rows) lanes.set(row.lane, row.color)
ok(`${lanes.size} lanes, one color each: ${[...lanes].map(([lane, color]) => `${lane} ${color}`).join(', ')}`)

console.log('the checker can still fail')
// Two sources for the broken cases. A mini taxonomy, written out once below and mutated one
// cell per case, covers the defects that live in a single row. The structural cases mutate the
// real file instead, because a stored copy of it with one cell changed would rot the day the
// real taxonomy grows a row. Every case asserts the problem count as well as the reason, so a
// case that drifts into a second defect reads as a failure and not as extra proof.
const MINI = `# Mini label contract

A taxonomy that is legal in every cell. Each case below changes exactly one of them, and the
smoke requires that one problem and no other. Nothing loads this at runtime.

## Taxonomy (the state machine)

| label | lane | color | description (verbatim) | set by | cleared by |
|---|---|---|---|---|---|
| \`mini-triage\` | intake | \`fbca04\` | Untriaged intake; exits only through the prep stage | human | the prep stage |
| \`mini-found\` | intake | \`fbca04\` | Hunter quarantine: verified and deduped, not human-reviewed | hunters | the prep stage |
| \`mini-ready\` | staging | \`0e8a16\` | Design-hardened per the contract; eligible for the issue stage | the prep stage | the issue stage |
| \`mini-active\` | active | \`1d76db\` | Claimed by an issue stage run: assignee + this label | the issue stage | the land stage |
| \`mini-info\` | blocked | \`b60205\` | Blocked on an answer only the human has | prep escalation | human answer |
| \`mini-human\` | blocked | \`b60205\` | Escalated: a real blocker survived the fix loop | the issue stage | human review |
| \`mini-rebase\` | blocked | \`b60205\` | Worktree conflicts with moved main | the issue stage | human rebase |
| \`mini-wontfix\` | buried | \`6e6e6e\` | Buried by human decision; agents never resurrect | human | human |
| \`mini-deferred\` | buried | \`6e6e6e\` | Consciously parked; agents never resurrect | human | human |

Type modifiers - orthogonal, stack with anything, stock colors and descriptions:
\`mini-bug\` (\`d73a4a\`), \`mini-enhancement\` (\`a2eeef\`), \`mini-documentation\` (\`0075ca\`).

## Rules

- Every open issue carries exactly one lifecycle label.
- The taxonomy is closed: the table plus the three modifiers is the whole legal set.
`
const mutate = (label, source, from, to) => {
  const text = source.replace(from, to)
  assert.notEqual(text, source, `${label} changed nothing in its source, so it proves nothing`)
  return text
}
const mini = (label, from, to) => mutate(label, MINI, from, to)
const CASES = [
  {
    // One description past the 100-code-point ceiling: GitHub accepts it and truncates it, so
    // no reviewer ever reads the end of it.
    label: 'over-long description',
    text: () => mini('the over-long case', 'Design-hardened per the contract; eligible for the issue stage',
      'Design-hardened per the contract and eligible for the issue stage, with every reason it got there spelled out at length'),
    name: 'has a description of 119 code points, over the 100-point ceiling',
    count: 1,
  },
  {
    // A description that still spells one host's slash command, which reconciliation would
    // publish into label metadata every reader of every issue sees.
    label: 'slash command in a description',
    text: () => mini('the slash-command case', 'exits only through the prep stage', 'exits only through /flow:prep'),
    name: 'has a description containing "/"',
    count: 1,
  },
  {
    // Six characters that read like a color and are not one. The row sits alone in its lane, so
    // the one-lane-one-color rule stays quiet and only the hex check can report it.
    label: 'color that is not hex',
    text: () => mini('the bad-color case', '`0e8a16`', '`0e8a1g`'),
    name: 'carries color "0e8a1g", which is not six lowercase hex digits',
    count: 1,
  },
  {
    // Two rows under one name, lane and color untouched, so one label would be written twice
    // with two different descriptions and the last write would win.
    label: 'duplicate label name',
    text: () => mini('the duplicate-name case', '`mini-rebase`', '`mini-human`'),
    name: 'label "mini-human" appears more than once in the taxonomy',
    count: 1,
  },
  {
    // The real file with the first blocked-lane row repainted. Both colors are legal hex and
    // every name is untouched, so nothing but the one-lane-one-color rule can catch it, and
    // reconciliation would happily paint two labels of one lane two colors.
    label: 'lane-color conflict',
    text: () => mutate('the lane-color case', contract, '`b60205`', '`b6020a`'),
    name: 'carries 2 colors (b60205, b6020a); one lane is one color',
    count: 1,
  },
  {
    // The real file with every table row deleted, heading and modifier line intact. A parser
    // that shrugs at zero rows would report no problems and read green forever.
    label: 'no table at all',
    text: () => mutate('the empty-table case', contract, /^\|.*$/gm, ''),
    name: '0 table rows and 3 type modifiers',
    count: 1,
  },
  {
    // The real file with the diagram's closing fence turned into ```still-code, an opener
    // shape a close may not carry. A prefix-only fence match would read it as a close, let the
    // whole table out of the still-open block, and parse nine rows off quotation - green on
    // text where nothing after the heading is real. The anchored close leaves the fence open,
    // drops the table and the modifiers, and the parse comes back short.
    label: 'non-closing fence',
    text: () => mutate('the non-closing-fence case', contract, '(never resurrected by agents)\n```',
      '(never resurrected by agents)\n```still-code'),
    name: 'did not parse: 0 table rows and 0 type modifiers',
    count: 1,
  },
]
assert.deepEqual(labelProblems(MINI), [], 'the mini taxonomy every case mutates is itself broken')
ok('the mini taxonomy the cases mutate passes clean')
for (const { label, text, name, count } of CASES) {
  const found = labelProblems(text())
  assert.ok(found.length > 0, `the checker passed ${label}, a case built to fail`)
  assert.equal(found.length, count, `${label} reported ${found.length} problems, expected ${count}: ${found.join('; ')}`)
  assert.ok(found.some((problem) => problem.includes(name)), `${label} failed without naming "${name}": ${found.join('; ')}`)
  ok(`the checker fails ${label} and names the defect: ${found[0]}`)
}

console.log(`\nlabel contract: ALL PASS (${checks} checks)`)
