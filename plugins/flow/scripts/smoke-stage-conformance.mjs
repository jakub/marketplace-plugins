#!/usr/bin/env node
// Conformance lint for the land stage: the host-neutral prose in skills/land-stage/SKILL.md
// and the per-host profiles beside it have to name the same gates, the stage has to stay free
// of host names, and commands/land.md has to stay a thin alias. The same checker runs over the
// broken pairs under scripts/fixtures/stage-conformance/, one directory per way the pair can
// go wrong, so a green run also means the checker can still fail and says why.
// Run: node plugins/flow/scripts/smoke-stage-conformance.mjs

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STAGE = join(ROOT, 'skills', 'land-stage')
const FIXTURE = join(ROOT, 'scripts', 'fixtures', 'stage-conformance')
const read = (...parts) => readFileSync(join(...parts), 'utf8')

// A host name in the stage body means a gate got bound in the one file both hosts share.
const BANNED = ['claude', 'codex', 'anthropic', 'openai', 'askuserquestion', 'apply_patch']
const GATE_MARKER = /\[\[gate:([a-z][a-z0-9-]*)\]\]/g
const PROFILE_GATE = /^### gate: ([a-z][a-z0-9-]*)$/gm
const ALLOWED_TOOLS = /^allowed-tools:.*$/m

// Anything that looks like it was meant to be a gate, canonical or not. The two extractors
// above are silent about what they skip, so a typo like [[gate:bad_id]] or a capitalized
// "### Gate:" drops out of both sets at once and the comparison still comes back equal. The
// near-miss scan runs first and its failures pre-empt the comparison, which means nothing
// once the grammar is broken.
const MARKER_LIKE = '[[gate'
const CANONICAL_MARKER = /\[\[gate:[a-z][a-z0-9-]*\]\]/y
const HEADING_LIKE = /^###\s*gate\b.*$/gim
const CANONICAL_HEADING = /^### gate: [a-z][a-z0-9-]*$/

const frontmatter = (text) => /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
const body = (text) => {
  const fm = frontmatter(text)
  return fm ? text.slice(fm[0].length) : text
}
const ids = (re, text) => [...text.matchAll(re)].map((m) => m[1])
const profilesIn = (dir) => Object.fromEntries(
  readdirSync(join(dir, 'profiles'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => [f, read(dir, 'profiles', f)]),
)
const repeats = (list) => [...new Set(list.filter((v, i) => list.indexOf(v) !== i))]

// Fenced blocks and inline code are quotation, not markup. Both files explain the marker and
// heading grammar by writing it out (`[[gate:<id>]]`), and a scanner that reads those as real
// gates fails the stage for documenting itself. The banned-host-name check deliberately does
// not use this: a host name inside a code fence is still a host name in the shared file.
const prose = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')

// Every [[gate substring that the canonical marker regex would not match, as written.
const badMarkers = (text) => {
  const found = []
  for (let at = text.indexOf(MARKER_LIKE); at !== -1; at = text.indexOf(MARKER_LIKE, at + 1)) {
    CANONICAL_MARKER.lastIndex = at
    if (CANONICAL_MARKER.test(text)) continue
    const line = text.slice(at).split('\n')[0]
    const close = line.indexOf(']]')
    found.push(close === -1 ? line.slice(0, 40) : line.slice(0, close + 2))
  }
  return found
}

// Every "### gate"-ish heading, in any casing or spacing, that is not the canonical form.
const badHeadings = (text) => [...text.matchAll(HEADING_LIKE)]
  .map((m) => m[0])
  .filter((line) => !CANONICAL_HEADING.test(line))

// The checker itself. Both the real stage and the fixtures go through this one function.
// Grammar and duplication come first: once a marker or a heading is off-grammar, the two id
// sets are comparing whatever survived the extractors, and equal sets mean nothing.
const stageProblems = (skill, profiles) => {
  const problems = []
  const stage = prose(body(skill))
  const marked = ids(GATE_MARKER, stage)
  const bound = Object.fromEntries(Object.entries(profiles).map(([name, text]) => [name, prose(text)]))

  for (const marker of badMarkers(stage)) {
    problems.push(`the stage writes ${marker}, which is not a canonical [[gate:<id>]] marker`)
  }
  for (const id of repeats(marked)) problems.push(`the stage marks gate ${id} more than once`)
  for (const [name, text] of Object.entries(bound)) {
    for (const heading of badHeadings(text)) {
      problems.push(`${name} writes "${heading}", which is not a canonical "### gate: <id>" heading`)
    }
    for (const id of repeats(ids(PROFILE_GATE, text))) {
      problems.push(`${name} declares gate ${id} in more than one section`)
    }
  }

  const gates = new Set(marked)
  if (problems.length > 0) return { gates, problems }
  if (marked.length === 0) problems.push('the stage marks no gates at all')

  for (const [name, text] of Object.entries(bound)) {
    const declared = new Set(ids(PROFILE_GATE, text))
    for (const id of gates) {
      if (!declared.has(id)) problems.push(`${name} has no "### gate: ${id}" section for a gate the stage marks`)
    }
    for (const id of declared) {
      if (!gates.has(id)) problems.push(`${name} declares gate ${id}, which the stage never marks`)
    }
  }
  return { gates, problems }
}

let checks = 0
const ok = (line) => {
  checks++
  console.log(`  ok: ${line}`)
}

console.log('the real stage')
const skill = read(STAGE, 'SKILL.md')
const profiles = profilesIn(STAGE)
assert.deepEqual(Object.keys(profiles).sort(), ['claude.md', 'codex.md'])
const { gates, problems } = stageProblems(skill, profiles)
assert.deepEqual(problems, [], problems.join('\n'))
ok(`${gates.size} gates, and both profiles bind exactly those: ${[...gates].join(', ')}`)

const stageBody = body(skill).toLowerCase()
const leaked = BANNED.filter((word) => stageBody.includes(word))
assert.deepEqual(leaked, [], `host names leaked into the stage body: ${leaked.join(', ')}`)
ok('the stage body names no host')

console.log('the alias command')
const land = read(ROOT, 'commands', 'land.md')
const landBody = body(land)
assert.ok(!landBody.includes('[[gate:'), 'commands/land.md carries gate markers; the gates live in the skill')
ok('commands/land.md carries no gate markers')

const headings = landBody.split('\n').filter((line) => /^##/.test(line))
assert.ok(headings.length <= 1, `commands/land.md has ${headings.length} "##" headings; an alias needs at most one`)
ok(`commands/land.md has ${headings.length} "##" heading(s)`)

const landAllowance = ALLOWED_TOOLS.exec(frontmatter(land)?.[1] ?? '')?.[0]
const profileAllowance = ALLOWED_TOOLS.exec(profiles['claude.md'])?.[0]
assert.ok(landAllowance, 'commands/land.md declares no allowed-tools')
assert.ok(profileAllowance, 'profiles/claude.md declares no allowed-tools')
assert.equal(landAllowance, profileAllowance)
ok('the alias and the Claude profile declare the same allowed-tools line')

console.log('the Codex agent metadata')
const agent = read(STAGE, 'agents', 'openai.yaml')
assert.match(agent, /^\s*allow_implicit_invocation:\s*false\s*$/m, 'agents/openai.yaml must disable implicit invocation')
ok('agents/openai.yaml sets allow_implicit_invocation: false')

console.log('the negative fixtures')
// One directory per way the pair can be wrong. Each case names the substrings its failure
// has to contain, so a checker that fails for some unrelated reason does not count as proof.
const CASES = [
  { dir: 'missing-binding', names: ['mini.md has no "### gate: mini-close" section'] },
  { dir: 'malformed-marker', names: ['[[gate:bad_id]]', 'not a canonical [[gate:<id>]] marker'] },
  {
    dir: 'bad-headings',
    names: ['declares gate mini-open in more than one section', '### Gate: mini-close', 'not a canonical "### gate: <id>" heading'],
  },
]
for (const { dir, names } of CASES) {
  const at = join(FIXTURE, dir)
  const fixture = stageProblems(read(at, 'SKILL.md'), profilesIn(at))
  assert.ok(fixture.problems.length > 0, `the checker passed ${dir}, a fixture built to fail`)
  for (const name of names) {
    assert.ok(
      fixture.problems.some((p) => p.includes(name)),
      `${dir} failed without naming "${name}": ${fixture.problems.join('; ')}`,
    )
  }
  ok(`the checker fails ${dir} and names the gap: ${fixture.problems[0]}`)
}

console.log(`\nland stage conformance: ALL PASS (${checks} checks)`)
