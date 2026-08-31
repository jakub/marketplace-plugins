#!/usr/bin/env node
// Conformance lint for the seat contract. plugins/flow/seat-contract.md is the canonical,
// host-neutral doctrine every seat follows; a host wrapper such as agents/implementer.md states
// the mechanism claims only that host can make and then repeats the contract verbatim below the
// sentinel. This checks the real pair byte for byte, that the four sections are still there in
// order, and that Containment names no host, since every wrapper inherits that section unchanged.
// The contract lives at the plugin root because the loader validates agents/ recursively and warns
// on a file there with no frontmatter, and a tail cannot carry frontmatter.
// The same checker runs over one directory per way a pair goes wrong under
// scripts/fixtures/seat-contract/, so a green run also means the checker can still fail and says
// where.
// Run: node plugins/flow/scripts/smoke-seat-contract.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONTRACT_SECTIONS,
  SEAT_CONTRACT_SENTINEL,
  contractSection,
  mirrorProblems,
  renderedHeadings,
  universalContainment,
} from '../lib/seat-contract.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'scripts', 'fixtures', 'seat-contract')
const read = (...parts) => readFileSync(join(...parts), 'utf8')

// Copied from the BANNED list in scripts/smoke-stage-conformance.mjs, which does not export it.
// Same reason as there: a host name in a file every host reads means a rule got bound in the one
// place both hosts share. Keep the two lists in step.
const BANNED = [
  'claude',
  'codex',
  'anthropic',
  'openai',
  'askuserquestion',
  'apply_patch',
  'explore',
  'spawn_agent',
  'delegate_to_codex',
  'delegate_to_claude',
  'fork_turns',
  '$arguments',
]

// Whole tokens, any casing, with the boundaries spelled out rather than \b, because $ARGUMENTS
// opens on a character \b does not count as part of a word.
const escaped = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const bannedHits = (text) => BANNED.flatMap((word) => [
  ...text.matchAll(new RegExp(`(?<![\\w$])${escaped(word)}(?![\\w$])`, 'gi')),
].map((hit) => hit[0]))

let checks = 0
const ok = (line) => {
  checks++
  console.log(`  ok: ${line}`)
}

console.log('the real pair')
const contract = read(ROOT, 'seat-contract.md')
const implementer = read(ROOT, 'agents', 'implementer.md')

const problems = mirrorProblems({
  contractText: contract,
  mirrorText: implementer,
  mirrorName: 'agents/implementer.md',
})
assert.deepEqual(problems, [], problems.join('\n'))
ok('agents/implementer.md carries the contract byte for byte below one sentinel line')

// One assertion for four properties, because the heading list in file order carries all of them:
// every canonical section is present, in the canonical order, written once, and nothing else is a
// section. mirrorProblems() enforces the last two on its own; this says which four and in what
// order, which is the part a library that reads any contract cannot know.
// The list comes from renderedHeadings() and not from a scan for `## ` at column one, so this
// check and the rule cannot disagree about what a heading is. A private scan here would go blind
// to the indented and setext spellings in exactly the way the rule is written to catch.
const headings = renderedHeadings(contract).filter((heading) => heading.level <= 2)
assert.deepEqual(headings.map((heading) => heading.text), CONTRACT_SECTIONS, `the contract's headings read ${headings.map((heading) => heading.text).join('; ')}`)
assert.ok(headings.every((heading) => heading.canonical && heading.form === 'ATX'), 'a section heading is not written as a plain "## " line at column one')
ok(`the contract's ${headings.length} rendered headings are exactly the canonical set, in order, once each, no indented or setext spelling: ${headings.map((heading) => heading.text).join('; ')}`)

const containment = universalContainment(contract)
assert.ok(containment && containment.trim().length > 0, 'universalContainment() read no Containment section')
assert.ok(containment.startsWith('## Containment\n'), 'the Containment section does not start at its own heading')
ok(`Containment reads back as ${containment.length} characters, heading included`)

const leaks = new Set(bannedHits(containment))
assert.deepEqual([...leaks], [], `Containment names a host: ${[...leaks].join(', ')}`)
ok('Containment names no host and no host-only tool')

const sections = CONTRACT_SECTIONS.map((heading) => contractSection(contract, heading))
assert.ok(sections.every((section) => section !== null), 'contractSection() lost a section the file has')
assert.equal(contractSection(contract, 'Nothing Named This'), null, 'contractSection() invented a section')
ok('contractSection() reads each of the four and returns null for a heading the file lacks')

// The seat that gets one section at a time and the seat that gets the whole tail have to end up
// with the same bytes. The preamble plus the four extracted sections rebuild the file exactly,
// which is the only way to say that nothing in it hides from extraction.
const preamble = contract.slice(0, contract.indexOf(`## ${CONTRACT_SECTIONS[0]}`))
assert.equal(preamble + sections.join(''), contract, 'the four sections plus the preamble do not rebuild the contract, so some of it reaches no seat handed a section')
ok(`the preamble and the four sections rebuild all ${contract.length} characters, so nothing hides between them`)

assert.ok(!contract.includes(SEAT_CONTRACT_SENTINEL), 'the contract itself carries the sentinel, which belongs to mirrors alone')
ok('the sentinel lives in the mirror and not in the contract')

console.log('the checker can still fail')
// One directory per way a pair goes wrong, each valid except for the one defect, so a case that
// reports two problems is a fixture that drifted rather than a checker that got stricter.
const CASES = [
  {
    dir: 'one-char-drift',
    // The mirror's tail says "authov" where the contract says "author".
    match: /first difference at byte \d+/,
    count: 1,
  },
  {
    // The mirror is byte-identical, so the byte check has nothing to say. A second
    // "## Containment" after Reporting still reaches a seat that gets the whole tail and never
    // reaches one handed the section, and contractSection() returns the first match either way.
    dir: 'duplicate-heading',
    match: /writes "## Containment" 2 times, and a seat handed that section alone would read only the first/,
    count: 1,
  },
  {
    // Three spaces in from the margin. CommonMark still renders it as a heading, so a reader of
    // the whole tail gets a fifth section, and the extractor cannot start at a line spelled that
    // way. Mirror byte-identical again, so only the closure can catch it.
    dir: 'indented-heading',
    match: /renders "Hidden policy" as a level-2 indented ATX heading on line \d+/,
    count: 1,
  },
  {
    // The same hidden section with no # at all: a line of text with hyphens under it renders as a
    // level-2 heading. This is the spelling a scan for "## " is most blind to.
    dir: 'setext-heading',
    match: /renders "Hidden policy" as a level-2 setext heading on line \d+/,
    count: 1,
  },
]
for (const { dir, match, count } of CASES) {
  const at = join(FIXTURE, dir)
  const found = mirrorProblems({
    contractText: read(at, 'seat-contract.md'),
    mirrorText: read(at, 'implementer.md'),
    mirrorName: `${dir}/implementer.md`,
  })
  assert.ok(found.length > 0, `the checker passed ${dir}, a pair built to fail`)
  assert.equal(found.length, count, `${dir} reported ${found.length} problems, expected ${count}: ${found.join('; ')}`)
  assert.ok(found.some((problem) => match.test(problem)), `${dir} failed without naming the defect: ${found.join('; ')}`)
  ok(`the checker fails ${dir} and names the gap: ${found[0]}`)
}

console.log(`\nseat contract: ALL PASS (${checks} checks)`)
