#!/usr/bin/env node
// Conformance lint for the charter. charter/charter.md is one file in two halves, split by one
// marker line: above it is doctrine for the orchestrator, below it are the rules every seat
// follows. A heading on the wrong side of that line is delivered to the wrong reader, and a
// second marker decides silently which text a seat gets. The budgets are assertions about what
// the hooks actually print, because a Claude SessionStart hook that prints past 10,000
// characters has its payload swapped for a preview and the session runs on a fragment.
// The same checker runs over broken cases built inline, so a green run also proves it can fail.
// Run: node plugins/flow/scripts/smoke-charter-conformance.mjs

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CLAUDE_HOOK_CAP,
  CLAUDE_PART_BUDGET,
  CODEX_INLINE_BYTE_BUDGET,
  SEAT_MARKER,
  seatPayload,
  splitCharter,
} from '../lib/charter-payload.mjs'
import { delegatedInstructions } from '../src/delegation/instructions.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Which half each required heading has to land in. A seat that never reads `## Hosts` cannot act
// on it, and a session that loses `## Seat Contract` from the seat half spawns seats with no rules.
const REQUIRED = [
  ['## Hosts', 'orchestrator'],
  ['## Rules of Engagement - Everything Else', 'seat'],
  ['## Seat Contract', 'seat'],
  ['## Gripes', 'seat'],
]

const charterProblems = (text) => {
  let halves
  try {
    halves = splitCharter(text)
  } catch (error) {
    return [error.message]
  }
  const out = []
  for (const [heading, side] of REQUIRED) {
    const other = side === 'seat' ? 'orchestrator' : 'seat'
    if (halves[side].split('\n').includes(heading)) continue
    out.push(halves[other].split('\n').includes(heading)
      ? `"${heading}" sits in the ${other} half, and it has to be in the ${side} half`
      : `the charter has no "${heading}" heading`)
  }
  if (text.includes('[[role:')) out.push('the charter writes a [[role:...]] marker, and role markers are gone')
  return out
}

const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }) : [])
  .filter((entry) => entry.isFile())
  .map((entry) => [join(entry.parentPath, entry.name).slice(ROOT.length + 1), readFileSync(join(entry.parentPath, entry.name), 'utf8')])

const roleMarkers = (files) => files
  .filter(([, body]) => body.includes('[[role:'))
  .map(([at]) => `${at} writes a [[role:...]] marker, and role markers are gone`)

const emit = (args, root, input = '', env = { CLAUDE_PLUGIN_ROOT: root, PLUGIN_ROOT: root }) => execFileSync(
  process.execPath,
  [join(ROOT, 'hooks', 'scripts', 'inject-charter.mjs'), ...args],
  { env: { ...process.env, ...env }, encoding: 'utf8', input },
)

let checks = 0
const ok = (line) => {
  checks += 1
  console.log(`  ok: ${line}`)
}

console.log('the real charter')
const charter = readFileSync(join(ROOT, 'charter', 'charter.md'), 'utf8').replace(/\r\n/g, '\n')
const problems = charterProblems(charter)
assert.deepEqual(problems, [], problems.join('\n'))
ok(`one seat marker, and all ${REQUIRED.length} required headings sit on the right side of it`)

const markers = ['skills', 'agents', 'commands'].flatMap((dir) => roleMarkers(filesUnder(join(ROOT, dir))))
assert.deepEqual(markers, [], markers.join('\n'))
ok('nothing under skills/, agents/ or commands/ writes a role marker')

assert.ok(!existsSync(join(ROOT, 'charter', 'profiles')), 'charter/profiles/ is back, and a host binds no roles any more')
ok('there is no charter/profiles/ directory')

console.log('the real emitters')
for (const part of ['1', '2']) {
  const half = emit(['session', 'claude', part], ROOT)
  assert.ok(half.length < CLAUDE_HOOK_CAP, `charter part ${part} is ${half.length} chars, over the ${CLAUDE_HOOK_CAP}-char hook cap`)
  assert.ok(!half.includes('flow-charter WARNING'), `charter part ${part} carries a budget warning`)
  ok(`charter part ${part} is ${half.length} chars, under ${CLAUDE_HOOK_CAP}, with no warning`)
}

const payload = seatPayload(charter)
const subagent = emit(['subagent', 'claude'], ROOT, JSON.stringify({ agent_type: 'claude' }))
assert.ok(subagent.length < CLAUDE_HOOK_CAP, `the subagent block is ${subagent.length} chars, over the ${CLAUDE_HOOK_CAP}-char hook cap`)
const parsed = JSON.parse(subagent)
assert.equal(parsed.hookSpecificOutput.hookEventName, 'SubagentStart')
assert.equal(parsed.hookSpecificOutput.additionalContext, payload, 'the subagent block is not the seat half')
ok(`a Claude subagent gets the ${payload.length}-character seat half as additionalContext, in ${subagent.length} chars of JSON`)

for (const agentType of ['Explore', 'fork']) {
  assert.equal(emit(['subagent', 'claude'], ROOT, JSON.stringify({ agent_type: agentType })), '', `${agentType} was handed the seat half`)
  const onCodex = JSON.parse(emit(['subagent', 'codex'], ROOT, JSON.stringify({ agent_type: agentType })))
  assert.equal(onCodex.hookSpecificOutput.additionalContext, payload, `Codex skipped ${agentType}, and it has no such mechanism to skip`)
  ok(`${agentType} is skipped on Claude and still delivered on Codex`)
}

const codex = emit(['session', 'codex'], ROOT)
assert.equal(codex, charter, 'the Codex SessionStart payload is not the charter verbatim')
assert.ok(Buffer.byteLength(codex) < CODEX_INLINE_BYTE_BUDGET, `the Codex payload is ${Buffer.byteLength(codex)} bytes, over the ${CODEX_INLINE_BYTE_BUDGET}-byte inline budget`)
ok(`the Codex payload is the charter verbatim, ${Buffer.byteLength(codex)} bytes, under the inline budget`)

// A Codex process launched from a Claude shell inherits CLAUDE_PLUGIN_ROOT, which may name another
// install or nothing at all, so the declared host has to decide which root variable wins.
const divergent = emit(['session', 'codex'], ROOT, '', { PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_ROOT: join(tmpdir(), 'flow-no-such-root') })
assert.equal(divergent, charter, 'a Codex session read the charter from CLAUDE_PLUGIN_ROOT instead of PLUGIN_ROOT')
const divergentClaude = emit(['session', 'claude', '1'], ROOT, '', { CLAUDE_PLUGIN_ROOT: ROOT, PLUGIN_ROOT: join(tmpdir(), 'flow-no-such-root') })
assert.ok(divergentClaude.includes('# Flow Engineering Charter'), 'a Claude session read the charter from PLUGIN_ROOT instead of CLAUDE_PLUGIN_ROOT')
ok('each host reads its own root variable first when the two diverge')

// A charter with two marker lines cannot be split, and the hook must still exit 0 with nothing on
// stdout: a non-zero SubagentStart hook is a harness error in the seat's face, and the defect
// belongs in the conformance smoke, not in a seat's transcript.
{
  const brokenRoot = mkdtempSync(join(tmpdir(), 'flow-broken-charter-'))
  mkdirSync(join(brokenRoot, 'charter'))
  writeFileSync(join(brokenRoot, 'charter', 'charter.md'), charter.replace(SEAT_MARKER, `${SEAT_MARKER}\n${SEAT_MARKER}`))
  const run = spawnSync(process.execPath, [join(ROOT, 'hooks', 'scripts', 'inject-charter.mjs'), 'subagent', 'claude'], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: brokenRoot, PLUGIN_ROOT: brokenRoot }, encoding: 'utf8', input: '{"agent_type":"claude"}',
  })
  assert.equal(run.status, 0, `a broken charter made the subagent hook exit ${run.status}`)
  assert.equal(run.stdout, '', 'a broken charter still printed a payload')
  assert.ok(run.stderr.includes('exactly one seat-rules marker'), `the diagnostic did not name the marker: ${run.stderr}`)
  ok('a charter with two markers leaves the subagent hook at exit 0, empty stdout, and a stderr diagnostic')
}

// A delegated job gets the same bytes a native seat gets, from the same function. Nothing is
// reworded on the way, so there is nothing to drift.
const delegated = delegatedInstructions({ access: 'workspace-write' }, 'Codex')
assert.ok(delegated.includes(payload), 'the delegated preamble does not carry the seat half verbatim')
ok('a delegated job carries the same seat half, verbatim')

// An oversized charter has to reach the warning, or the cap arrives as a silent truncation.
const big = mkdtempSync(join(tmpdir(), 'flow-charter-conformance-'))
mkdirSync(join(big, 'charter'))
writeFileSync(join(big, 'charter', 'charter.md'), `${charter}\n## Padding\n${'x'.repeat(7000)}\n`)
const warned = emit(['session', 'claude', '1'], big)
assert.ok(/flow-charter WARNING: [^\n]*part 2 is \d+ chars/.test(warned), 'an oversized half printed no warning')
assert.ok(!emit(['session', 'claude', '2'], big).includes('WARNING'), 'the warning was printed twice')
ok(`a charter whose second half passes ${CLAUDE_PART_BUDGET} chars warns once, on part 1`)

console.log('the checker can still fail')
const moved = charter.replace('## Gripes\n', '').replace(SEAT_MARKER, `## Gripes\nMoved above the line.\n\n${SEAT_MARKER}`)
const CASES = [
  {
    label: 'a charter with two markers',
    problems: () => charterProblems(`${charter}\n${SEAT_MARKER}\n`),
    name: 'and carries 2',
  },
  {
    label: 'a charter with no marker',
    problems: () => charterProblems(charter.replace(SEAT_MARKER, '')),
    name: 'and carries 0',
  },
  {
    label: 'a charter that marks a role',
    problems: () => charterProblems(charter.replace('## Gripes', '## Gripes\n[[role:human-choice]]')),
    name: 'role markers are gone',
  },
  {
    label: 'a seat heading moved above the marker',
    problems: () => charterProblems(moved),
    name: '"## Gripes" sits in the orchestrator half',
  },
  {
    label: 'a stage that marks a role',
    problems: () => roleMarkers([['skills/mini-stage/SKILL.md', 'Spawn the [[role:mini-seat]].\n']]),
    name: 'skills/mini-stage/SKILL.md writes a [[role:...]] marker',
  },
]
for (const { label, problems: run, name } of CASES) {
  const found = run()
  assert.ok(found.length > 0, `the checker passed ${label}, a case built to fail`)
  assert.ok(found.some((problem) => problem.includes(name)), `${label} failed without naming "${name}": ${found.join('; ')}`)
  ok(`the checker fails ${label} and names the gap: ${found[0]}`)
}

console.log(`\ncharter conformance: ALL PASS (${checks} checks)`)
