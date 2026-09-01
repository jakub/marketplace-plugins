#!/usr/bin/env node
// Conformance lint for the pipeline stages. A stage is one SKILL.md: host-neutral prose first,
// then a final "## Host mechanics" section whose two subsections name the seats, models and
// calls for each host. The alias under commands/ is a routing line and nothing else, and the
// stage's agents/openai.yaml keeps implicit invocation off, because a stage that merges, opens
// issues or spawns write seats must never start itself.
//
// Stages are found by structure, not by name: every skills/*-stage/ directory is one, so a
// stage added later is linted without an edit here. The same checker runs over the inline
// fixtures at the bottom, each valid but for the one defect it is named for, so a green run
// also proves the checker can still fail and fails for the reason claimed.
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
const stageProblems = ({ name, skill, alias, openai }) => {
  const problems = []
  const at = `skills/${name}/SKILL.md`
  if (skill === null) return [`${at} does not exist`]

  const fm = FRONTMATTER.exec(skill)
  if (!fm) problems.push(`${at} has no frontmatter, so the loader cannot read the stage's name`)
  else if (!/^disable-model-invocation: true$/m.test(fm[1])) {
    problems.push(`${at} does not set "disable-model-invocation: true", so the model could start the stage itself`)
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

  if (openai === null) problems.push(`skills/${name}/agents/openai.yaml does not exist`)
  else if (!/^\s*allow_implicit_invocation: false$/m.test(openai)) {
    problems.push(`skills/${name}/agents/openai.yaml does not set "allow_implicit_invocation: false", so the stage can start itself`)
  }

  const short = name.replace(/-stage$/, '')
  const to = `commands/${short}.md`
  if (alias === null) return [...problems, `${to} does not exist`]
  const aliasFm = FRONTMATTER.exec(alias)
  if (!aliasFm) problems.push(`${to} has no frontmatter, so it declares no tools`)
  else if (!/^allowed-tools: \S/m.test(aliasFm[1])) {
    problems.push(`${to} carries no "allowed-tools:" line, so the alias runs on whatever the session happens to allow`)
  }
  const blocks = alias.slice(aliasFm ? aliasFm[0].length : 0).split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  if (blocks.length !== 2 || !blocks[0].startsWith('# ') || blocks[0].includes('\n')) {
    problems.push(`${to} has ${blocks.length} blocks below its frontmatter, and an alias is one "# " heading plus one routing sentence`)
  } else {
    for (const want of [`skills/${name}/SKILL.md`, '$ARGUMENTS']) {
      if (!blocks[1].includes(want)) problems.push(`${to} routes without naming ${want}`)
    }
    if (isHeading(blocks[1])) problems.push(`${to} writes a second heading where its routing sentence belongs`)
  }
  return problems
}

let checks = 0
const ok = (line) => {
  checks++
  console.log(`  ok: ${line}`)
}

console.log('the real stages')
const stages = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.endsWith('-stage'))
  .map((entry) => entry.name)
  .sort()
assert.ok(stages.length >= 3, `found ${stages.length} stages under skills/, expected at least the three pipeline stages`)
ok(`${stages.length} stages found by structure: ${stages.join(', ')}`)

for (const name of stages) {
  const problems = stageProblems({
    name,
    skill: read(ROOT, 'skills', name, 'SKILL.md'),
    alias: read(ROOT, 'commands', `${name.replace(/-stage$/, '')}.md`),
    openai: read(ROOT, 'skills', name, 'agents', 'openai.yaml'),
  })
  assert.deepEqual(problems, [], `${name}:\n${problems.join('\n')}`)
  ok(`${name}: neutral body, two host subsections with prose, implicit invocation off, and a one-line alias`)
}

console.log('the checker can still fail')
// One valid mini stage, mutated one way per case. Building the broken files from the good one
// is what makes each case honest about its single defect: everything but the named edit is the
// shape the real stages have.
const SKILL = `---
name: mini-stage
description: A miniature stage, for the lint alone.
disable-model-invocation: true
---

# mini-stage

Do the work, then read your host's subsection for the calls.

## Host mechanics

### Claude Code

The mechanism here.

### Codex

The mechanism there.
`
const ALIAS = `---
description: A miniature alias.
allowed-tools: Bash(git:*), Read
---

# /flow:mini - the miniature stage

The stage lives in the \`mini-stage\` skill. Read \`\${CLAUDE_PLUGIN_ROOT}/skills/mini-stage/SKILL.md\` and execute it against $ARGUMENTS.
`
const YAML = 'interface:\n  display_name: "Mini Stage"\npolicy:\n  allow_implicit_invocation: false\n'
const mini = (edits = {}) => stageProblems({ name: 'mini-stage', skill: SKILL, alias: ALIAS, openai: YAML, ...edits })

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
    label: 'alias with extra prose',
    problems: () => mini({ alias: `${ALIAS}\nAnd one more thing the alias wanted to say.\n` }),
    names: ['has 3 blocks below its frontmatter'],
  },
  {
    label: 'alias with no allowed-tools',
    problems: () => mini({ alias: ALIAS.replace(/^allowed-tools: .*\n/m, '') }),
    names: ['carries no "allowed-tools:" line'],
  },
  {
    label: 'alias that names no stage file',
    problems: () => mini({ alias: ALIAS.replace('skills/mini-stage/SKILL.md', 'skills/other-stage/SKILL.md') }),
    names: ['routes without naming skills/mini-stage/SKILL.md'],
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
