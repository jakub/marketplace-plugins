#!/usr/bin/env node
// Conformance lint for the seat contract. agents/seat-contract.md is the canonical, host-neutral
// doctrine every seat follows; a host wrapper such as agents/implementer.md states the mechanism
// claims only that host can make and then repeats the contract verbatim below the sentinel. This
// checks the real pair byte for byte, that the four sections are still there in order, and that
// Containment names no host, since that is the section every wrapper inherits unchanged.
// The same checker runs over scripts/fixtures/seat-contract/one-char-drift/, a pair whose tail is
// off by one character, so a green run also means the checker can still fail and says where.
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
const contract = read(ROOT, 'agents', 'seat-contract.md')
const implementer = read(ROOT, 'agents', 'implementer.md')

const problems = mirrorProblems({
  contractText: contract,
  mirrorText: implementer,
  mirrorName: 'agents/implementer.md',
})
assert.deepEqual(problems, [], problems.join('\n'))
ok('agents/implementer.md carries the contract byte for byte below one sentinel line')

const headings = CONTRACT_SECTIONS.map((heading) => ({ heading, at: contract.indexOf(`\n## ${heading}\n`) }))
for (const { heading, at } of headings) {
  assert.notEqual(at, -1, `the contract has no "## ${heading}" section`)
}
const order = headings.map(({ at }) => at)
assert.deepEqual([...order].sort((a, b) => a - b), order, `the contract's sections run out of order: ${CONTRACT_SECTIONS.join(', ')}`)
ok(`all ${CONTRACT_SECTIONS.length} sections are present in order: ${CONTRACT_SECTIONS.join('; ')}`)

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

assert.ok(!contract.includes(SEAT_CONTRACT_SENTINEL), 'the contract itself carries the sentinel, which belongs to mirrors alone')
ok('the sentinel lives in the mirror and not in the contract')

console.log('the checker can still fail')
const at = join(FIXTURE, 'one-char-drift')
const found = mirrorProblems({
  contractText: read(at, 'seat-contract.md'),
  mirrorText: read(at, 'implementer.md'),
  mirrorName: 'one-char-drift/implementer.md',
})
assert.ok(found.length > 0, 'the checker passed one-char-drift, a pair built to fail')
assert.equal(found.length, 1, `one-char-drift reported ${found.length} problems, expected 1: ${found.join('; ')}`)
assert.match(found[0], /first difference at byte \d+/, `one-char-drift failed without naming the byte offset: ${found[0]}`)
ok(`the checker fails one-char-drift and names the gap: ${found[0]}`)

console.log(`\nseat contract: ALL PASS (${checks} checks)`)
