#!/usr/bin/env node
// Conformance lint for the pipeline stages. A stage is one SKILL.md and nothing else: it
// declares its own tool allowance, keeps model invocation off on both hosts, opens with
// host-neutral prose, and ends in a "## Host mechanics" section whose two subsections name the
// calls for each host. There is no command alias; the skill IS the invocation on both hosts.
//
// PIPELINE is the list, because a stage is a deliberate addition and three of them is the whole
// pipeline. A name here that has no directory fails, and so does a skill NOT listed here that
// carries a host-mechanics section - that second check is what stops a fourth stage being
// written and quietly never linted.
//
// The value is whether the skill is gated. `gated` is a stage: the human alone starts it, so
// model invocation is off on both hosts. `open` is babysit, the same document shape without the
// gate, because an issue run hands off to it. Which one a skill is gets asserted either way, so
// a stage cannot lose its gate and babysit cannot silently gain one.
//
// The same checker runs over the inline fixtures at the bottom, each valid but for the one
// defect it is named for, so a green run also proves the checker can still fail and fails for
// the reason claimed.
// Run: node plugins/flow/scripts/smoke-stage-conformance.mjs

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const lf = (text) => text.replace(/\r\n/g, '\n')
const read = (...parts) => {
  try { return lf(readFileSync(join(...parts), 'utf8')) } catch { return null }
}

const PIPELINE = { prep: 'gated', issue: 'gated', land: 'gated', babysit: 'open' }
const STAGES = Object.keys(PIPELINE)

const HOST_MECHANICS = '## Host mechanics'
const SUBSECTIONS = ['### Claude Code', '### Codex']
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/

// The two families, and the tools and call literals only one host has. Matched as whole tokens
// in any casing against the raw text, fences included: the neutral half is the file both hosts
// read, so a mechanism named there is a rule bound where only one host can honour it. There is
// no carve-out for naming a subsection either - the body says "your host's subsection".
const BANNED = [
  'claude', 'codex', 'anthropic', 'openai', 'askuserquestion', 'apply_patch',
  'explore', 'spawn_agent', 'delegate_to_codex', 'delegate_to_claude', 'fork_turns', '$arguments',
]
// Boundaries spelled out rather than \b, because $ARGUMENTS opens on a character \b does not
// count as part of a word.
const escaped = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const bannedHits = (text) => BANNED.flatMap((word) => [...text.matchAll(new RegExp(`(?<![\\w$])${escaped(word)}(?![\\w$])`, 'gi'))]
  .map((hit) => ({ word: hit[0], line: text.slice(0, hit.index).split('\n').length })))

const isHeading = (line) => /^#{1,6} /.test(line)
const blank = (lines) => lines.join('\n').trim() === ''

// Everything wrong with one stage, as sentences. An empty array is clean. Files arrive as text
// so the inline fixtures and the real tree go through exactly the same checks.
const stageProblems = ({ name, skill, openai, gate = 'gated' }) => {
  const problems = []
  const at = `skills/${name}/SKILL.md`
  if (skill === null) return [`${at} does not exist`]

  const fm = FRONTMATTER.exec(skill)
  if (!fm) problems.push(`${at} has no frontmatter, so the loader cannot read the stage's name`)
  else {
    const suppressed = /^disable-model-invocation: true$/m.test(fm[1])
    if (gate === 'gated' && !suppressed) {
      problems.push(`${at} does not set "disable-model-invocation: true", so the model could start the stage itself`)
    }
    if (gate === 'open' && suppressed) {
      problems.push(`${at} sets "disable-model-invocation: true", but this skill is handed off to mid-run and has to stay model-invocable`)
    }
    // The allowance used to live on a command alias. It is on the skill now, and a stage without
    // one runs on whatever the session happens to allow.
    if (!/^allowed-tools: \S/m.test(fm[1])) {
      problems.push(`${at} carries no "allowed-tools:" line, so the stage runs on whatever the session happens to allow`)
    }
    if (!new RegExp(`^name: ${name}$`, 'm').test(fm[1])) {
      problems.push(`${at} does not declare "name: ${name}", so the invocation and the directory disagree`)
    }
  }

  const lines = skill.split('\n')
  const marks = lines.map((line, i) => (line === HOST_MECHANICS ? i : -1)).filter((i) => i >= 0)
  if (marks.length !== 1) {
    problems.push(`${at} writes ${marks.length} "${HOST_MECHANICS}" headings at column one, and a stage needs exactly one`)
    return problems
  }
  const [mark] = marks

  // The tail: exactly the two subsections, in order, each with prose under it and no deeper
  // section of its own, and nothing else after them. A third "###" would be a mechanism no host
  // claims; a later "##" would be shared prose sitting below the host-specific half, where the
  // vocabulary scan above the line cannot see it.
  const tail = lines.slice(mark + 1)
  const headings = tail.map((line, i) => ({ line, i })).filter(({ line }) => isHeading(line))
  for (const { line } of headings.filter(({ line }) => /^#{1,2} /.test(line))) {
    problems.push(`${at} opens "${line}" after ${HOST_MECHANICS}, which has to be the last section`)
  }
  const subs = headings.filter(({ line }) => /^### /.test(line))
  const spelled = subs.map(({ line }) => line)
  if (spelled.join(' | ') !== SUBSECTIONS.join(' | ')) {
    problems.push(`${at} puts "${spelled.join('", "') || 'nothing'}" under ${HOST_MECHANICS}, expected "${SUBSECTIONS.join('", "')}" in that order`)
  }
  for (const { line, i } of subs) {
    const next = headings.find((heading) => heading.i > i)
    if (blank(tail.slice(i + 1, next ? next.i : undefined))) {
      problems.push(`${at} leaves "${line}" empty, and a host with no mechanics named is a host that cannot run the stage`)
    }
  }

  const body = skill.slice(fm ? fm[0].length : 0, lines.slice(0, mark).join('\n').length)
  for (const hit of bannedHits(body)) {
    problems.push(`${at}:${hit.line + (fm ? fm[0].split('\n').length - 1 : 0)} names "${hit.word}" above ${HOST_MECHANICS}, where the prose is the same on every host`)
  }

  const want = gate === 'gated' ? 'false' : 'true'
  if (openai === null) problems.push(`skills/${name}/agents/openai.yaml does not exist`)
  else if (!new RegExp(`^\\s*allow_implicit_invocation: ${want}$`, 'm').test(openai)) {
    problems.push(gate === 'gated'
      ? `skills/${name}/agents/openai.yaml does not set "allow_implicit_invocation: false", so the stage can start itself`
      : `skills/${name}/agents/openai.yaml does not set "allow_implicit_invocation: true", and this skill is handed off to mid-run`)
  }

  return problems
}

let checks = 0
const ok = (line) => {
  checks++
  console.log(`  ok: ${line}`)
}

console.log('the real stages')
for (const [name, gate] of Object.entries(PIPELINE)) {
  const problems = stageProblems({
    name,
    gate,
    skill: read(ROOT, 'skills', name, 'SKILL.md'),
    openai: read(ROOT, 'skills', name, 'agents', 'openai.yaml'),
  })
  assert.deepEqual(problems, [], `${name}:\n${problems.join('\n')}`)
  ok(`${name}: own allowance, neutral body, two host subsections with prose, ${gate === 'gated' ? 'model invocation off on both hosts' : 'model-invocable on both hosts for the hand-off'}`)
}

// Nothing else may quietly be a stage. A skill that carries a host-mechanics section and is not
// in STAGES is a fourth stage nobody registered, and every check above would skip it.
const unlisted = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !STAGES.includes(entry.name))
  .map((entry) => entry.name)
  .filter((name) => (read(ROOT, 'skills', name, 'SKILL.md') ?? '').includes(`\n${HOST_MECHANICS}\n`))
assert.deepEqual(unlisted, [],
  `these skills carry a "${HOST_MECHANICS}" section but are not in PIPELINE, so nothing lints them: ${unlisted.join(', ')}`)
ok(`no unlisted skill carries a ${HOST_MECHANICS} section`)

// The commands directory is gone on purpose: the skill is the invocation on both hosts.
assert.equal(read(ROOT, 'commands', 'prep.md'), null,
  'commands/prep.md is back; a command alias re-exposes a stage the model is not allowed to start')
ok('no command alias re-exposes a stage')

console.log('the checker can still fail')
// One valid mini stage, mutated one way per case. Building the broken files from the good one
// is what makes each case honest about its single defect: everything but the named edit is the
// shape the real stages have.
const SKILL = `---
name: mini
description: A miniature stage, for the lint alone.
disable-model-invocation: true
allowed-tools: Bash(git:*), Read
---

# mini

Do the work, then read your host's subsection for the calls.

## Host mechanics

### Claude Code

The mechanism here.

### Codex

The mechanism there.
`
const YAML = 'interface:\n  display_name: "Mini Stage"\npolicy:\n  allow_implicit_invocation: false\n'
const mini = (edits = {}) => stageProblems({ name: 'mini', skill: SKILL, openai: YAML, ...edits })

const CASES = [
  {
    label: 'no host-mechanics heading',
    problems: () => mini({ skill: SKILL.replace(`${HOST_MECHANICS}\n\n`, '') }),
    names: ['writes 0 "## Host mechanics" headings'],
  },
  {
    label: 'one subsection missing',
    problems: () => mini({ skill: SKILL.replace('\n### Codex\n\nThe mechanism there.\n', '') }),
    names: ['puts "### Claude Code" under ## Host mechanics'],
  },
  {
    label: 'empty subsection',
    problems: () => mini({ skill: SKILL.replace('The mechanism there.\n', '') }),
    names: ['leaves "### Codex" empty'],
  },
  {
    label: 'host word above the line',
    problems: () => mini({ skill: SKILL.replace('your host\'s subsection', 'the Codex subsection') }),
    names: ['names "Codex" above ## Host mechanics'],
  },
  {
    label: 'a third subsection',
    problems: () => mini({ skill: `${SKILL}\n### Some Other Host\n\nA mechanism no host claims.\n` }),
    names: ['"### Some Other Host"'],
  },
  {
    label: 'a section after host mechanics',
    problems: () => mini({ skill: `${SKILL}\n## Notes\n\nShared prose below the host half.\n` }),
    names: ['opens "## Notes" after ## Host mechanics'],
  },
  {
    label: 'implicit invocation left on',
    problems: () => mini({ openai: YAML.replace('false', 'true') }),
    names: ['so the stage can start itself'],
  },
  {
    label: 'a stage with no allowed-tools',
    problems: () => mini({ skill: SKILL.replace(/^allowed-tools: .*\n/m, '') }),
    names: ['carries no "allowed-tools:" line'],
  },
  {
    label: 'model invocation left on',
    problems: () => mini({ skill: SKILL.replace('disable-model-invocation: true\n', '') }),
    names: ['does not set "disable-model-invocation: true"'],
  },
  {
    label: 'an open skill that gates itself',
    problems: () => mini({ gate: 'open', openai: YAML.replace('false', 'true') }),
    names: ['has to stay model-invocable'],
  },
  {
    label: 'a name that disagrees with the directory',
    problems: () => mini({ skill: SKILL.replace('name: mini', 'name: mini-stage') }),
    names: ['does not declare "name: mini"'],
  },
]
assert.deepEqual(mini(), [], `the mini stage every case is built from is itself broken: ${mini().join('; ')}`)
ok('the mini stage the cases mutate passes clean')
for (const { label, problems, names } of CASES) {
  const found = problems()
  assert.equal(found.length, 1, `${label} reported ${found.length} problems, expected 1: ${found.join('; ')}`)
  for (const name of names) {
    assert.ok(found[0].includes(name), `${label} failed without naming "${name}": ${found[0]}`)
  }
  ok(`the checker fails ${label} and names it: ${found[0]}`)
}

console.log(`\nstage conformance: ALL PASS (${checks} checks)`)
