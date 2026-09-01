#!/usr/bin/env node
// Conformance lint for the seat contract. plugins/flow/seat-contract.md is the canonical,
// host-neutral doctrine every seat follows; agents/implementer.md states the mechanism claims
// only a Claude seat can make and then repeats the contract verbatim below the sentinel. Byte
// for byte is the whole point: a paraphrase drifts and nothing catches it.
// Run: node plugins/flow/scripts/smoke-seat-contract.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SEAT_CONTRACT_SENTINEL, mirrorTail, universalContainment } from '../lib/seat-contract.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts) => readFileSync(join(...parts), 'utf8')

let checks = 0
const ok = (line) => {
  checks++
  console.log(`  ok: ${line}`)
}

const contract = read(ROOT, 'seat-contract.md')
const implementer = read(ROOT, 'agents', 'implementer.md')

assert.equal(mirrorTail(implementer), contract, 'agents/implementer.md has a tail that is not the contract')
ok(`agents/implementer.md carries all ${contract.length} characters of the contract below one sentinel line`)

assert.ok(!contract.includes(SEAT_CONTRACT_SENTINEL), 'the contract itself carries the sentinel, which belongs to mirrors alone')
ok('the sentinel lives in the mirror and not in the contract')

// The section a delegated seat is handed on its own: it has to start at its own heading and
// stop before the next one, or a payload built from it drags in doctrine meant for a seat
// working a whole issue.
const containment = universalContainment(contract)
assert.ok(containment && containment.trim().length > 0, 'universalContainment() read no Containment section')
assert.ok(containment.startsWith('## Containment\n'), 'the Containment section does not start at its own heading')
assert.ok(!containment.includes('\n## '), 'the Containment section runs on into the next section')
ok(`Containment reads back as ${containment.length} characters, heading included, and stops at the next section`)

// The mirror with one character changed in its tail, everything else untouched. The byte
// comparison is the only thing that can see it, so this is what proves the comparison is live.
const drifted = implementer.replace('not a narrative it will trust', 'not a narrative it will trusv')
assert.notEqual(drifted, implementer, 'the drift case changed nothing, so it proves nothing')
assert.ok(mirrorTail(drifted) !== contract, 'a one-character drift in the tail read as equal to the contract')
ok('a one-character drift in the mirror fails the byte comparison')

console.log(`\nseat contract: ALL PASS (${checks} checks)`)
