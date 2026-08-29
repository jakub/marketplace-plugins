#!/usr/bin/env node
// Conformance lint for the land stage: the host-neutral prose in skills/land-stage/SKILL.md
// and the per-host profiles beside it have to name the same gates, the stage has to stay free
// of host names, and commands/land.md has to stay a thin alias. The same checker runs over
// the broken fixtures under scripts/fixtures/stage-conformance/, so a green run means the
// checker can still fail. Run: node plugins/flow/scripts/smoke-stage-conformance.mjs

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

// The checker itself. Both the real stage and the fixtures go through this one function.
const stageProblems = (skill, profiles) => {
  const problems = []
  const marked = ids(GATE_MARKER, body(skill))
  const gates = new Set(marked)
  if (marked.length === 0) problems.push('the stage marks no gates at all')
  for (const id of gates) {
    if (marked.filter((m) => m === id).length > 1) problems.push(`the stage marks gate ${id} more than once`)
  }
  for (const [name, text] of Object.entries(profiles)) {
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
assert.equal(landAllowance, profileAllowance)
ok('the alias and the Claude profile declare the same allowed-tools line')

console.log('the Codex agent metadata')
const agent = read(STAGE, 'agents', 'openai.yaml')
assert.match(agent, /^\s*allow_implicit_invocation:\s*false\s*$/m, 'agents/openai.yaml must disable implicit invocation')
ok('agents/openai.yaml sets allow_implicit_invocation: false')

console.log('the negative fixtures')
const fixture = stageProblems(read(FIXTURE, 'SKILL.md'), profilesIn(FIXTURE))
assert.ok(fixture.problems.length > 0, 'the checker passed a fixture built to fail')
assert.ok(
  fixture.problems.some((p) => p.includes('mini-close')),
  `the fixture failure never names the missing gate: ${fixture.problems.join('; ')}`,
)
ok(`the checker fails the fixture and names the gap: ${fixture.problems[0]}`)

console.log(`\nland stage conformance: ALL PASS (${checks} checks)`)
