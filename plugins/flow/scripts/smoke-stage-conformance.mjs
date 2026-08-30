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

import { bindingProblems, body, frontmatter } from './lib/conformance.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STAGE = join(ROOT, 'skills', 'land-stage')
const FIXTURE = join(ROOT, 'scripts', 'fixtures', 'stage-conformance')
const read = (...parts) => readFileSync(join(...parts), 'utf8')

// A host name in the stage body means a gate got bound in the one file both hosts share. This
// check reads the raw body, never the engine's prose() view: a host name inside a code fence is
// still a host name in the shared file.
const BANNED = ['claude', 'codex', 'anthropic', 'openai', 'askuserquestion', 'apply_patch']
const ALLOWED_TOOLS = /^allowed-tools:.*$/m

const profilesIn = (dir) => Object.fromEntries(
  readdirSync(join(dir, 'profiles'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => [f, read(dir, 'profiles', f)]),
)

// The shared engine, bound to this stage's vocabulary. Both the real stage and the fixtures go
// through it, so a green run also means the checker can still fail and says why.
const stageProblems = (skill, profiles) => bindingProblems({
  keyword: 'gate',
  sourceName: 'the stage',
  sourceText: skill,
  profiles,
})

let checks = 0
const ok = (line) => {
  checks++
  console.log(`  ok: ${line}`)
}

console.log('the real stage')
const skill = read(STAGE, 'SKILL.md')
const profiles = profilesIn(STAGE)
assert.deepEqual(Object.keys(profiles).sort(), ['claude.md', 'codex.md'])
const { ids: gates, problems } = stageProblems(skill, profiles)
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
