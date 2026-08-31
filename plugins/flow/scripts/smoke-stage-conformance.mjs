#!/usr/bin/env node
// Conformance lint for every stage in the plugin. A stage is any directory under skills/ that
// holds a profiles/ subdirectory: its host-neutral prose in SKILL.md and the per-host profiles
// beside it have to name the same gates, the stage body has to stay free of host names and of
// the tool literals only one host has, the Codex agent metadata has to keep implicit invocation
// off, and commands/<stage>.md has to stay a thin alias that declares the same tool allowance as
// the Claude profile. Discovery means a stage added later is linted without editing this file.
// The checks run at two layers over scripts/fixtures/stage-conformance/: the binding engine over
// the three broken skill-and-profile pairs, and the whole per-stage checker over the miniature
// plugin roots beside them, each valid except for one defect. So a green run also means the
// checker can still fail and says why.
// Run: node plugins/flow/scripts/smoke-stage-conformance.mjs

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bindingProblems, body, frontmatter, uncommented } from './lib/conformance.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'scripts', 'fixtures', 'stage-conformance')
const read = (...parts) => readFileSync(join(...parts), 'utf8')
const readOrNull = (...parts) => {
  try {
    return read(...parts)
  } catch {
    return null
  }
}
const isDir = (...parts) => {
  try {
    return statSync(join(...parts)).isDirectory()
  } catch {
    return false
  }
}

// A host name in the stage body means a gate got bound in the one file both hosts share. The
// list covers the two families, the tools and call literals only one of them has, and the
// argument placeholder only one of them substitutes. This check reads the raw body and never the
// engine's prose() view: a host name inside a code fence is still a host name in the shared file.
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
const HOSTS = ['claude.md', 'codex.md']
const ALLOWED_TOOLS = /^allowed-tools:.*$/m

// Whole tokens, any casing. The boundaries are spelled out instead of \b because $ARGUMENTS
// opens on a character \b does not treat as part of the word, and because a trailing dot or
// hyphen has to still count: "claude.md" and "codex-cli" name a host as plainly as the bare
// word does.
const escaped = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const bannedHits = (text) => BANNED.flatMap((word) => [
  ...text.matchAll(new RegExp(`(?<![\\w$])${escaped(word)}(?![\\w$])`, 'gi')),
].map((hit) => hit[0]))

// The sentence both shipped aliases carry, with the stage name substituted. Pointing at the two
// files is the alias's whole job, so the lint wants the instruction that performs it and not the
// two paths on their own: an alias whose only mention of them sits inside an HTML comment routes
// nowhere, and a pair of substring searches called that a pass.
const routeSentence = (name) => 'Read `${CLAUDE_PLUGIN_ROOT}/skills/' + name + '/profiles/claude.md` first, '
  + 'then `${CLAUDE_PLUGIN_ROOT}/skills/' + name + '/SKILL.md`.'

// agents/openai.yaml has a known two-level shape: the top-level keys "interface:" and "policy:",
// each holding indented scalars. This reads the policy block alone and takes only the keys at its
// own indentation, so text one level deeper cannot answer for it. The check this replaced matched
// allow_implicit_invocation: false anywhere in the file, which a description written as a block
// scalar can satisfy while "policy: allow_implicit_invocation: true" sits below it. A file that
// does not fit the shape is a problem in its own right, never a pass.
const indentOf = (line) => /^[ \t]*/.exec(line)[0].length
const policyScalar = (text, key) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => /^policy:[ \t]*$/.test(line))
  if (start === -1) return { problem: 'has no top-level "policy:" block' }
  const block = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue
    if (/^\S/.test(line)) break
    block.push(line)
  }
  if (block.length === 0) return { problem: 'has an empty "policy:" block' }
  const depth = indentOf(block[0])
  if (block.some((line) => indentOf(line) < depth)) {
    return { problem: 'has a "policy:" block whose keys do not line up' }
  }
  const scalar = new RegExp(`^[ \\t]*${key}:[ \\t]*(\\S*)[ \\t]*$`)
  const hits = block.filter((line) => indentOf(line) === depth).map((line) => scalar.exec(line)).filter(Boolean)
  if (hits.length === 0) return { problem: `sets no ${key} directly under "policy:"` }
  if (hits.length > 1) return { problem: `sets ${key} ${hits.length} times under "policy:"` }
  return { value: hits[0][1] }
}

const profilesIn = (dir) => Object.fromEntries(
  readdirSync(join(dir, 'profiles'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => [f, read(dir, 'profiles', f)]),
)

// The shared engine, bound to the stage vocabulary. The real stages, the plugin-shaped fixtures
// and the bare fixture pairs all go through it.
const stageBindings = (skill, profiles) => bindingProblems({
  keyword: 'gate',
  sourceName: 'the stage',
  sourceText: skill,
  profiles,
})

// Every stage in a plugin root, by directory name. The profiles/ directory is what makes a skill
// a stage: skills/flow has no profiles and is not one.
const discoverStages = (root) => readdirSync(join(root, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && isDir(root, 'skills', entry.name, 'profiles'))
  .map((entry) => entry.name)
  .sort()

// One stage, every check, as a list of problems naming the stage and the defect. Nothing throws
// on a missing file: a stage that is half there has to report that, not crash the lint.
const stageProblems = (root, name) => {
  const at = join(root, 'skills', name)
  const problems = []
  const command = `commands/${name.replace(/-stage$/, '')}.md`

  if (!name.endsWith('-stage')) {
    problems.push(`skills/${name} holds profiles/, so it is a stage, but its name does not end in "-stage"`)
  }

  const skill = readOrNull(at, 'SKILL.md')
  if (skill === null) {
    problems.push(`skills/${name} has profiles/ but no SKILL.md`)
    return { ids: new Set(), problems }
  }

  const profiles = profilesIn(at)
  for (const host of HOSTS) {
    if (!(host in profiles)) problems.push(`skills/${name}/profiles has no ${host}`)
  }
  for (const extra of Object.keys(profiles).filter((f) => !HOSTS.includes(f))) {
    problems.push(`skills/${name}/profiles holds ${extra}, which is neither claude.md nor codex.md`)
  }

  const { ids, problems: bindings } = stageBindings(skill, profiles)
  for (const problem of bindings) problems.push(`skills/${name}: ${problem}`)

  for (const hit of new Set(bannedHits(body(skill)))) {
    problems.push(`skills/${name}/SKILL.md writes "${hit}"; the shared stage body names no host`)
  }

  const agent = readOrNull(at, 'agents', 'openai.yaml')
  if (agent === null) {
    problems.push(`skills/${name}/agents/openai.yaml does not exist`)
  } else {
    const { value, problem } = policyScalar(agent, 'allow_implicit_invocation')
    if (problem) {
      problems.push(`skills/${name}/agents/openai.yaml ${problem}`)
    } else if (value !== 'false') {
      problems.push(
        `skills/${name}/agents/openai.yaml sets allow_implicit_invocation: ${value || '(nothing)'} `
        + 'under policy:, not false, so the stage can start itself',
      )
    }
  }

  const alias = readOrNull(root, ...command.split('/'))
  if (alias === null) {
    problems.push(`${command} does not exist, so skills/${name} has no alias`)
    return { ids, problems }
  }
  const aliasBody = body(alias)
  if (aliasBody.includes('[[gate:')) {
    problems.push(`${command} carries gate markers; the gates live in the skill`)
  }
  const headings = aliasBody.split('\n').filter((line) => /^##/.test(line))
  if (headings.length > 1) {
    problems.push(`${command} has ${headings.length} "##" headings; an alias needs at most one`)
  }
  // Comments come out before the sentence search, and a run of whitespace collapses to one space,
  // so a wrapped line still reads as the same sentence and a commented-out one reads as nothing.
  const routing = uncommented(aliasBody).replace(/\s+/g, ' ')
  if (!routing.includes(routeSentence(name))) {
    problems.push(`${command} never routes to the stage: an alias has to say "${routeSentence(name)}"`)
  }
  const aliasAllowance = ALLOWED_TOOLS.exec(frontmatter(alias)?.[1] ?? '')?.[0]
  const profileAllowance = ALLOWED_TOOLS.exec(profiles['claude.md'] ?? '')?.[0]
  if (!aliasAllowance) problems.push(`${command} declares no allowed-tools`)
  if (!profileAllowance) problems.push(`skills/${name}/profiles/claude.md declares no allowed-tools`)
  if (aliasAllowance && profileAllowance && aliasAllowance !== profileAllowance) {
    problems.push(
      `${command} and skills/${name}/profiles/claude.md declare different allowed-tools lines: `
      + `"${aliasAllowance}" against "${profileAllowance}"`,
    )
  }

  return { ids, problems }
}

let checks = 0
const ok = (line) => {
  checks++
  console.log(`  ok: ${line}`)
}

console.log('the real stages')
const stages = discoverStages(ROOT)
assert.ok(stages.length > 0, 'no directory under skills/ holds a profiles/ subdirectory, so the lint checked nothing')
ok(`discovery found ${stages.length} stage(s): ${stages.join(', ')}`)

for (const name of stages) {
  const { ids, problems } = stageProblems(ROOT, name)
  assert.deepEqual(problems, [], problems.join('\n'))
  ok(`skills/${name}: ${ids.size} gates bound by both profiles, a host-free body, and a matching alias`)
}

console.log('the negative fixtures, at the engine')
// One directory per way a skill-and-profile pair can be wrong, checked through the engine alone.
// Each case names the substrings its failure has to contain, so a checker that fails for some
// unrelated reason does not count as proof.
const PAIR_CASES = [
  { dir: 'missing-binding', names: ['mini.md has no "### gate: mini-close" section'] },
  { dir: 'malformed-marker', names: ['[[gate:bad_id]]', 'not a canonical [[gate:<id>]] marker'] },
  {
    dir: 'bad-headings',
    names: ['declares gate mini-open in more than one section', '### Gate: mini-close', 'not a canonical "### gate: <id>" heading'],
  },
]
for (const { dir, names } of PAIR_CASES) {
  const at = join(FIXTURE, dir)
  const found = stageBindings(read(at, 'SKILL.md'), profilesIn(at)).problems
  assert.ok(found.length > 0, `the checker passed ${dir}, a case built to fail`)
  for (const name of names) {
    assert.ok(
      found.some((p) => p.includes(name)),
      `${dir} failed without naming "${name}": ${found.join('; ')}`,
    )
  }
  ok(`the engine fails ${dir} and names the gap: ${found[0]}`)
}

console.log('the negative fixtures, at the plugin root')
// One miniature plugin root per way the files around a stage can be wrong. Each is valid in
// every other respect, so the count says the defect under test is the only thing reported.
const ROOT_CASES = [
  {
    dir: 'alias-drift',
    names: ['commands/mini.md and skills/mini-stage/profiles/claude.md declare different allowed-tools lines'],
    count: 1,
  },
  { dir: 'host-leak', names: ['skills/mini-stage/SKILL.md writes "fork_turns"'], count: 1 },
  { dir: 'missing-host-profile', names: ['skills/mini-stage/profiles has no codex.md'], count: 1 },
  {
    dir: 'implicit-invocation-enabled',
    names: ['skills/mini-stage/agents/openai.yaml sets allow_implicit_invocation: true under policy:, not false'],
    count: 1,
  },
  {
    // The same defect, hidden: the true value sits under policy: while the string a whole-file
    // scan looks for sits inside an interface description written as a block scalar.
    dir: 'implicit-invocation-shadowed',
    names: ['skills/mini-stage/agents/openai.yaml sets allow_implicit_invocation: true under policy:, not false'],
    count: 1,
  },
  {
    // Both paths appear in the alias, inside an HTML comment, so nothing tells the session to
    // read them.
    dir: 'alias-comment-only',
    names: ['commands/mini.md never routes to the stage: an alias has to say "Read `${CLAUDE_PLUGIN_ROOT}/skills/mini-stage/profiles/claude.md` first, then `${CLAUDE_PLUGIN_ROOT}/skills/mini-stage/SKILL.md`."'],
    count: 1,
  },
]
for (const { dir, names, count } of ROOT_CASES) {
  const at = join(FIXTURE, dir)
  const inside = discoverStages(at)
  assert.deepEqual(inside, ['mini-stage'], `${dir} holds stages ${inside.join(', ')}, expected mini-stage alone`)
  const found = inside.flatMap((name) => stageProblems(at, name).problems)
  assert.ok(found.length > 0, `the checker passed ${dir}, a case built to fail`)
  assert.equal(found.length, count, `${dir} reported ${found.length} problems, expected ${count}: ${found.join('; ')}`)
  for (const name of names) {
    assert.ok(
      found.some((p) => p.includes(name)),
      `${dir} failed without naming "${name}": ${found.join('; ')}`,
    )
  }
  ok(`the checker fails ${dir} and names the gap: ${found[0]}`)
}

console.log(`\nstage conformance: ALL PASS (${checks} checks)`)
