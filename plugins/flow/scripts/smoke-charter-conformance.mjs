#!/usr/bin/env node
// Conformance lint for the charter. charter/charter.md is host-neutral prose that marks a role
// with [[role:<id>]] instead of naming a mechanism, and charter/profiles/<host>.md binds every
// one of those ids under a "### role: <id>" heading. Seat roles also carry floors against the
// rankings table, and a binding under its floor is a defect of the same class as a missing one. The role grammar is the charter's alone, so
// nothing under skills/ may mark or rebind one. The budgets are assertions about what the hooks
// actually print, because a Claude SessionStart hook that prints past 10,000 characters has its
// payload swapped for a preview and the session runs on a fragment.
// The same checkers run over the broken cases at the bottom, built inline, so a green run also
// proves the checker can still fail.
// Run: node plugins/flow/scripts/smoke-charter-conformance.mjs

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CLAUDE_PART_BUDGET,
  CODEX_CHARTER_BYTE_BUDGET,
  CODEX_PROFILE_BYTE_BUDGET,
  NO_BINDINGS_NOTE,
} from '../lib/charter-payload.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHARTER = join(ROOT, 'charter')
const read = (...parts) => readFileSync(join(...parts), 'utf8').replace(/\r\n/g, '\n')

// A host name in the charter means a role got bound in the file every host reads. Three sections
// are exempt because their whole job is naming models and families.
const HOST_WORDS = ['Claude', 'Codex', 'Anthropic', 'OpenAI', 'AskUserQuestion', 'Explore', 'PushNotification', 'subagent', 'fork']
const ALLOWED_SECTIONS = ['Cross-Family Delegation', 'Model Rankings (as of 2026-08)', 'Rules of Engagement - Model Selection']

const MARKER = /\[\[role:([a-z][a-z0-9-]*)\]\]/g
const HEADING = /^### role: ([a-z][a-z0-9-]*)$/gm
const CANONICAL_MARKER = /^\[\[role:[a-z][a-z0-9-]*\]\]$/
const CANONICAL_HEADING = /^### role: [a-z][a-z0-9-]*$/

// Quotation, not markup. The charter and both profiles explain the grammar by writing
// `[[role:…]]` in a code span, and a scan that reads that as a marker fails a file for
// documenting itself. An HTML comment is the other direction: it reaches no session, so a
// commented-out heading binds nothing and a section whose whole body is a comment is empty.
// A fence closes only on a delimiter at least as long as the one that opened it, followed by
// nothing but whitespace. Fences come out before comments, so an unclosed <!-- inside an
// example cannot swallow the live text after it.
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*$[\s\S]*?^ {0,3}\1[ \t]*$/gm
const unfenced = (text) => text.replace(FENCE, '')
const uncommented = (text) => unfenced(text).replace(/<!--[\s\S]*?(?:-->|$)/g, '')
const quoteless = (text) => uncommented(text).replace(/`[^`\n]*`/g, '')
const repeats = (list) => [...new Set(list.filter((v, i) => list.indexOf(v) !== i))]
const idsOf = (re, text) => [...text.matchAll(new RegExp(re.source, re.flags))].map((m) => m[1])

// Everything that looks like an attempted marker or heading, canonical or not. A typo drops out
// of both extractors at once and the id sets still compare equal, so these run first.
const nearMisses = (text, opener, canonical) => [...text.matchAll(opener)]
  .map((hit) => {
    const close = hit[0].indexOf(']]')
    return close === -1 ? hit[0].split('\n')[0].slice(0, 40) : hit[0].slice(0, close + 2)
  })
  .filter((found) => !canonical.test(found))

// The marked set, plus everything wrong with it and with the bindings that answer it.
const roleProblems = (charterText, profiles) => {
  const problems = []
  const source = quoteless(uncommented(charterText))
  for (const miss of nearMisses(source, /\[\[\s*role[^\n]*/gi, CANONICAL_MARKER)) {
    problems.push(`the charter writes ${miss}, which is not a canonical [[role:<id>]] marker`)
  }
  const marked = idsOf(MARKER, source)
  for (const id of repeats(marked)) problems.push(`the charter marks role ${id} more than once`)
  if (marked.length === 0) problems.push('the charter marks no roles at all')

  for (const [name, raw] of Object.entries(profiles)) {
    const text = unfenced(uncommented(raw.replace(/\r\n/g, '\n')))
    for (const miss of nearMisses(text, /^ {0,3}###\s*role[^\n]*/gim, CANONICAL_HEADING)) {
      problems.push(`${name} writes "${miss}", which is not a canonical "### role: <id>" heading`)
    }
    const declared = idsOf(HEADING, text)
    for (const id of repeats(declared)) problems.push(`${name} declares role ${id} in more than one section`)
    const lines = text.split('\n')
    for (const [at, line] of lines.entries()) {
      if (!CANONICAL_HEADING.test(line)) continue
      const rest = lines.slice(at + 1)
      const end = rest.findIndex((next) => /^ {0,3}#{1,6} /.test(next))
      if (rest.slice(0, end === -1 ? undefined : end).join('\n').trim() === '') {
        problems.push(`${name} declares ${line.slice(4)} with an empty section, which binds nothing`)
      }
    }
    if (problems.length > 0) continue
    for (const id of marked) {
      if (!declared.includes(id)) problems.push(`${name} has no "### role: ${id}" section for a role the charter marks`)
    }
    for (const id of declared) {
      if (!marked.includes(id)) problems.push(`${name} declares role ${id}, which the charter never marks`)
    }
  }
  return { ids: new Set(marked), problems }
}

// A stage may name a role in prose, but a stage that marks or binds one is a second, competing
// definition for the same name. Takes the files as pairs so the negative case needs no directory.
const roleClaims = (files) => files.flatMap(([at, text]) => {
  const found = []
  const heading = /^ {0,3}### role: .*$/m.exec(text)
  if (heading) found.push(`${at} declares "${heading[0].trim()}"; roles are bound in charter/profiles only`)
  if (quoteless(text).includes('[[role:')) found.push(`${at} writes a [[role: marker; the role grammar is the charter's`)
  return found
})

// Seat roles carry floors against the rankings table, and a profile binds each one to a model
// and an effort. The lint reads the first rankings-table model name in the section and the
// first effort word after it, and nothing else: a section may go on to name an escalation or
// a provider id, but the binding is the opening pair.
const CRITERIA = ['cheapness', 'intelligence', 'taste', 'effort', 'family', 'classifiers']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const NATIVE_FAMILY = { claude: 'anthropic', codex: 'openai' }
const familyOf = (model) => (model.startsWith('gpt-') ? 'openai' : 'anthropic')
const cells = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim())
const isRow = (line) => /^\|/.test(line) && !/^\|\s*-/.test(line)

// One row per model, columns read by the header's names so a reordered table still scores
// the right cell. A score written a/b is the score at default effort and at max effort. A
// model that appears twice is a defect, not a later row winning.
const rankings = (charterText) => {
  const rows = new Map()
  const problems = []
  const at = charterText.search(/^## Model Rankings/m)
  if (at === -1) return { rows, problems: ['the charter has no Model Rankings table'] }
  const lines = charterText.slice(at).split('\n## ')[0].split('\n').filter(isRow)
  const header = cells(lines[0] || '')
  const column = (name) => header.indexOf(name)
  for (const name of ['model', 'cheapness', 'intelligence', 'taste', 'classifiers']) {
    if (column(name) === -1) problems.push(`the Model Rankings table has no "${name}" column`)
  }
  if (problems.length > 0) return { rows, problems }
  const score = (text) => {
    const m = /^(\d+)(?:\/(\d+))?$/.exec(text || '')
    return m ? { base: Number(m[1]), max: Number(m[2] ?? m[1]) } : null
  }
  for (const line of lines.slice(1)) {
    const values = cells(line)
    const model = values[column('model')]
    if (rows.has(model)) {
      problems.push(`the Model Rankings table lists ${model} twice`)
      continue
    }
    rows.set(model, {
      cheapness: score(values[column('cheapness')]),
      intelligence: score(values[column('intelligence')]),
      taste: score(values[column('taste')]),
      classifiers: values[column('classifiers')] || null,
    })
  }
  return { rows, problems }
}

// One row per marked role, floors written "criterion >= n" or "criterion: value". A floor
// the parser cannot read is a floor that checks nothing, so every value is validated here.
const FLOOR_GRAMMAR = {
  cheapness: { op: '>=', ok: (v) => /^(?:10|\d)$/.test(v) },
  intelligence: { op: '>=', ok: (v) => /^(?:10|\d)$/.test(v) },
  taste: { op: '>=', ok: (v) => /^(?:10|\d)$/.test(v) },
  effort: { op: '>=', ok: (v) => EFFORTS.includes(v) },
  family: { op: ':', ok: (v) => ['other', 'native'].includes(v) },
  classifiers: { op: ':', ok: (v) => ['none', 'standard', 'strict'].includes(v) },
}
const floorsOf = (charterText) => {
  const roles = new Map()
  const problems = []
  for (const line of quoteless(uncommented(charterText)).split('\n').filter(isRow)) {
    const [role, floors] = cells(line)
    const id = /^\[\[role:([a-z][a-z0-9-]*)\]\]$/.exec(role || '')
    if (!id) continue
    const parsed = []
    for (const clause of (floors || '').split(',').map((part) => part.trim()).filter(Boolean)) {
      const m = /^([a-z]+)\s*(>=|:)\s*([a-z0-9]+)$/.exec(clause)
      const grammar = m && FLOOR_GRAMMAR[m[1]]
      if (!grammar) {
        problems.push(`role ${id[1]} declares the floor "${clause}", which names no known criterion`)
        continue
      }
      if (m[2] !== grammar.op) {
        problems.push(`role ${id[1]} declares the floor "${clause}", and ${m[1]} takes "${grammar.op}"`)
        continue
      }
      if (!grammar.ok(m[3])) {
        problems.push(`role ${id[1]} declares the floor "${clause}", and "${m[3]}" is not a value ${m[1]} can take`)
        continue
      }
      parsed.push({ criterion: m[1], value: m[3] })
    }
    if (parsed.length === 0) problems.push(`role ${id[1]} sits in the seat table and declares no floors`)
    roles.set(id[1], parsed)
  }
  return { roles, problems }
}

const sectionOf = (profileText, id) => {
  const lines = unfenced(uncommented(profileText)).split('\n')
  const at = lines.findIndex((line) => line === `### role: ${id}`)
  if (at === -1) return null
  const rest = lines.slice(at + 1)
  const end = rest.findIndex((line) => /^ {0,3}#{1,6} /.test(line))
  return rest.slice(0, end === -1 ? undefined : end).join('\n')
}

// The binding is the section's opening clause and nothing else: "`model` at <effort> effort",
// with "session effort" allowed for a host that cannot set effort per seat. Prose after the
// clause may name escalations, provider ids, or other models without moving the binding.
const OPENING = /^`?([a-z0-9][a-z0-9.-]*)`? at (low|medium|high|xhigh|max)(?: session)? effort\b/
const bindingOf = (section, models) => {
  const opening = section.split('\n').map((line) => line.trim()).find((line) => line.length > 0) || ''
  const m = OPENING.exec(opening)
  if (!m) return { problem: 'does not open with "`<model>` at <effort> effort"' }
  if (![...models].includes(m[1])) return { problem: `opens with ${m[1]}, which is not a model in the rankings table` }
  return { model: m[1], effort: m[2] }
}

const floorProblems = (charterText, profiles) => {
  const { rows: table, problems: tableProblems } = rankings(charterText)
  const { roles, problems: floorProblemsFound } = floorsOf(charterText)
  const problems = [...tableProblems, ...floorProblemsFound]
  if (tableProblems.length > 0) return { roles, problems }
  for (const [name, raw] of Object.entries(profiles)) {
    const host = name.replace(/\.md$/, '')
    for (const [id, floors] of roles) {
      if (floors.length === 0) continue
      const section = sectionOf(raw.replace(/\r\n/g, '\n'), id)
      if (section === null) continue
      const bound = bindingOf(section, table.keys())
      if (bound.problem) {
        problems.push(`${name} binds ${id} but the section ${bound.problem}`)
        continue
      }
      const row = table.get(bound.model)
      const effortRank = bound.effort ? EFFORTS.indexOf(bound.effort) : -1
      for (const { criterion, value } of floors) {
        if (criterion === 'effort') {
          if (!bound.effort) problems.push(`${name} binds ${id} to ${bound.model} with no effort, and the role floors effort at ${value}`)
          else if (effortRank < EFFORTS.indexOf(value)) problems.push(`${name} binds ${id} to ${bound.model} at ${bound.effort} effort, under the role's floor of ${value}`)
        } else if (criterion === 'family') {
          const native = NATIVE_FAMILY[host]
          const want = value === 'other' ? (native === 'openai' ? 'anthropic' : 'openai') : native
          if (familyOf(bound.model) !== want) problems.push(`${name} binds ${id} to ${bound.model}, which is not family: ${value} on the ${host} host`)
        } else if (criterion === 'classifiers') {
          if (row.classifiers !== value) problems.push(`${name} binds ${id} to ${bound.model}, whose classifiers are ${row.classifiers}, and the role floors classifiers: ${value}`)
        } else {
          const score = row[criterion]
          if (!score) { problems.push(`the rankings table gives ${bound.model} no ${criterion} score`); continue }
          const have = bound.effort === 'max' ? score.max : score.base
          if (have < Number(value)) problems.push(`${name} binds ${id} to ${bound.model} at ${bound.effort ?? 'unstated'} effort, scoring ${have} on ${criterion} under the role's floor of ${value}`)
        }
      }
    }
  }
  return { roles, problems }
}

// A role with floors that no stage names is a binding nothing spawns: the conductor picks a
// model on its own and the profile's decision is decoration. Takes the stage files as pairs.
const unusedRoles = (roles, stages) => [...roles]
  .filter(([, floors]) => floors.length > 0)
  .filter(([id]) => !stages.some(([, text]) => unfenced(uncommented(text)).includes('`' + id + '`')))
  .map(([id]) => `no stage names the seat role ${id}, so its binding spawns nothing`)

const markdownUnder = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => [join(entry.parentPath, entry.name).slice(ROOT.length + 1), readFileSync(join(entry.parentPath, entry.name), 'utf8')])

// Everything outside the allowlisted sections, quotation removed: naming a tool in backticks
// binds nothing, and the charter quotes cross-host literals like `delegate_to_codex` on purpose.
const hostLeaks = (charterText) => {
  const kept = []
  let allowed = false
  for (const line of quoteless(charterText).split('\n')) {
    const heading = /^## (.+)$/.exec(line)
    if (heading) allowed = ALLOWED_SECTIONS.includes(heading[1].trim())
    kept.push(allowed ? '' : line)
  }
  const text = kept.join('\n')
  return HOST_WORDS.flatMap((word) => [...text.matchAll(new RegExp(`\\b${word}\\b`, 'gi'))]
    .map((hit) => `the charter names "${hit[0]}" outside the allowlisted sections, on line ${text.slice(0, hit.index).split('\n').length}`))
}

const emit = (script, args, root) => execFileSync(process.execPath, [join(ROOT, 'hooks', 'scripts', script), ...args], {
  env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, PLUGIN_ROOT: root },
  encoding: 'utf8',
})

let checks = 0
const ok = (line) => {
  checks++
  console.log(`  ok: ${line}`)
}

console.log('the real charter')
const charter = read(CHARTER, 'charter.md')
const profiles = Object.fromEntries(readdirSync(join(CHARTER, 'profiles'))
  .filter((file) => file.endsWith('.md'))
  .map((file) => [file, read(CHARTER, 'profiles', file)]))
assert.deepEqual(Object.keys(profiles).sort(), ['claude.md', 'codex.md'])

const { ids, problems } = roleProblems(charter, profiles)
assert.deepEqual(problems, [], problems.join('\n'))
ok(`${ids.size} roles, and both profiles bind exactly those, each under prose: ${[...ids].join(', ')}`)

const missingSections = ALLOWED_SECTIONS.filter((name) => !charter.includes(`\n## ${name}\n`))
assert.deepEqual(missingSections, [], `an allowlisted section heading no longer exists: ${missingSections.join('; ')}`)
const leaks = hostLeaks(charter)
assert.deepEqual(leaks, [], leaks.join('\n'))
ok(`the charter names no host outside the ${ALLOWED_SECTIONS.length} allowlisted sections, all of which still exist`)

const claims = roleClaims(markdownUnder(join(ROOT, 'skills')))
assert.deepEqual(claims, [], claims.join('\n'))
ok('no file under skills/ marks or rebinds a charter role')

const floors = floorProblems(charter, profiles)
assert.deepEqual(floors.problems, [], floors.problems.join('\n'))
const floored = [...floors.roles].filter(([, list]) => list.length > 0).map(([id]) => id)
assert.ok(floored.length > 0, 'the charter declares no seat-role floors')
ok(`${floored.length} seat roles carry floors, and both profiles bind each one at or above its floor`)
const unused = unusedRoles(floors.roles, markdownUnder(join(ROOT, 'skills')).filter(([at]) => /^skills\/[^/]+-stage\/SKILL\.md$/.test(at)))
assert.deepEqual(unused, [], unused.join('\n'))
ok('every seat role with floors is named by at least one stage body')

console.log('the real emitters')
for (const part of ['1', '2']) {
  const half = emit('inject-charter.mjs', [part], ROOT)
  assert.ok(half.length < CLAUDE_PART_BUDGET, `charter part ${part} is ${half.length} chars, over the ${CLAUDE_PART_BUDGET}-char per-hook budget`)
  assert.ok(!half.includes('flow-charter WARNING'), `charter part ${part} carries a budget warning`)
  ok(`charter part ${part} is ${half.length} chars, under ${CLAUDE_PART_BUDGET}, with no warning`)
}

const profile = emit('inject-profile.mjs', [], ROOT)
assert.ok(profile.length < CLAUDE_PART_BUDGET, `the profile block is ${profile.length} chars, over the ${CLAUDE_PART_BUDGET}-char per-hook budget`)
assert.match(profile, /<flow-profile host="claude" bindings="bound">/)
ok(`the Claude profile block is ${profile.length} chars and reports bindings="bound"`)

// Codex takes one payload and measures it in tokens, so these are maintenance budgets rather
// than hard limits: spilling is the runtime fallback, not the target.
const codex = emit('inject-charter-codex.mjs', [], ROOT)
// lastIndexOf, because the charter's own presence paragraph names the <flow-profile> tag.
const codexProfile = codex.slice(codex.lastIndexOf('<flow-profile host="codex"'))
assert.ok(Buffer.byteLength(charter) < CODEX_CHARTER_BYTE_BUDGET, `the charter is ${Buffer.byteLength(charter)} bytes, over the ${CODEX_CHARTER_BYTE_BUDGET}-byte Codex budget`)
assert.ok(Buffer.byteLength(codexProfile) < CODEX_PROFILE_BYTE_BUDGET, `the Codex profile block is ${Buffer.byteLength(codexProfile)} bytes, over the ${CODEX_PROFILE_BYTE_BUDGET}-byte budget`)
ok(`the Codex payload is ${Buffer.byteLength(charter)} bytes of charter and ${Buffer.byteLength(codexProfile)} bytes of profile, both under budget`)

// A root with no charter/profiles/ still emits a block and exits 0: execFileSync throws on a
// non-zero exit, so reaching the assertions is the exit check.
const bare = mkdtempSync(join(tmpdir(), 'flow-charter-conformance-'))
const missing = emit('inject-profile.mjs', [], bare)
assert.match(missing, /<flow-profile host="claude" bindings="none">/)
assert.ok(missing.includes(NO_BINDINGS_NOTE), 'a missing profile must carry the no-bindings note')
ok('a root with no profiles emits bindings="none" and the no-bindings note')

// A two-model rankings table and one role, for the floor cases below.
const MINI = (floor, binding) => [
  '## Model Rankings (as of 2026-08)\n\n| model | cheapness | intelligence | taste | classifiers |\n|---|---|---|---|---|\n| mini-cheap | 9 | 4/7 | 4 | standard |\n| gpt-mini | 7 | 8 | 5 | none |\n\n'
  + '## Rules of Engagement - Model Selection\n\n| role | floors | what it is for |\n|---|---|---|\n| [[role:mini-seat]] | ' + floor + ' | a seat |\n',
  { 'claude.md': '### role: mini-seat\n\n' + binding + '\n' },
]
const fencedComment = roleProblems('The charter marks [[role:mini-seat]].\n',
  { 'mini.md': 'For example:\n\n```markdown\n<!-- an example that never closes\n```\n\n### role: mini-seat\n\n`gpt-mini` at high effort.\n' }).problems
assert.deepEqual(fencedComment, [], fencedComment.join('\n'))
ok('an unclosed comment inside a fenced example does not swallow the live binding after it')
const scoredAtMax = floorProblems(...MINI('intelligence >= 6', '`mini-cheap` at max effort.')).problems
assert.deepEqual(scoredAtMax, [], scoredAtMax.join('\n'))
ok('a 4/7 model bound at max effort meets an intelligence floor of 6')

console.log('the checker can still fail')
const CASES = [
  {
    label: 'a binding under its intelligence floor',
    problems: () => floorProblems(...MINI('intelligence >= 6', '`mini-cheap` at high effort.')).problems,
    name: "scoring 4 on intelligence under the role's floor of 6",
  },
  {
    label: 'a binding at too low an effort',
    problems: () => floorProblems(...MINI('effort >= high', '`gpt-mini` at medium effort.')).problems,
    name: "at medium effort, under the role's floor of high",
  },
  {
    label: 'an other-family role bound natively',
    problems: () => floorProblems(...MINI('family: other', '`mini-cheap` at high effort.')).problems,
    name: 'which is not family: other on the claude host',
  },
  {
    label: 'a classifier-free role bound to a classified model',
    problems: () => floorProblems(...MINI('classifiers: none', '`mini-cheap` at high effort.')).problems,
    name: 'whose classifiers are standard',
  },
  {
    label: 'a floor naming an unknown criterion',
    problems: () => floorProblems(...MINI('vibes >= 3', '`gpt-mini` at high effort.')).problems,
    name: 'names no known criterion',
  },
  {
    label: 'a binding that names no table model',
    problems: () => floorProblems(...MINI('intelligence >= 6', '`mini-vast` at high effort.')).problems,
    name: 'opens with mini-vast, which is not a model in the rankings table',
  },
  {
    // The first model mentioned is not the binding; the opening clause is. A section that
    // talks its way to a different model must fail, not pass as the model it mentioned first.
    label: 'a binding buried in prose after another model',
    problems: () => floorProblems(...MINI('intelligence >= 6', '`gpt-mini` is unavailable; use `mini-cheap` at high effort.')).problems,
    name: 'does not open with',
  },
  {
    label: 'a floor with a value its criterion cannot take',
    problems: () => floorProblems(...MINI('effort >= hihg', '`gpt-mini` at high effort.')).problems,
    name: 'is not a value effort can take',
  },
  {
    label: 'a floor with the wrong operator',
    problems: () => floorProblems(...MINI('family >= other', '`gpt-mini` at high effort.')).problems,
    name: 'family takes ":"',
  },
  {
    label: 'a rankings row listed twice',
    problems: () => floorProblems('## Model Rankings (as of 2026-08)\n\n| model | cheapness | intelligence | taste | classifiers |\n|---|---|---|---|---|\n| gpt-mini | 7 | 8 | 5 | none |\n| gpt-mini | 7 | 4 | 5 | none |\n', {}).problems,
    name: 'lists gpt-mini twice',
  },
  {
    label: 'a rankings table with a column reordered',
    // Same scores, columns swapped: the lint reads the header, so the floor still binds to intelligence.
    problems: () => floorProblems('## Model Rankings (as of 2026-08)\n\n| model | taste | intelligence | cheapness | classifiers |\n|---|---|---|---|---|\n| gpt-mini | 5 | 4 | 7 | none |\n\n## Rules of Engagement - Model Selection\n\n| role | floors | what it is for |\n|---|---|---|\n| [[role:mini-seat]] | intelligence >= 6 | a seat |\n', { 'claude.md': '### role: mini-seat\n\n`gpt-mini` at high effort.\n' }).problems,
    name: "scoring 4 on intelligence under the role's floor of 6",
  },
  {
    label: 'a seat-table role with no floors',
    problems: () => floorProblems(...MINI('', '`gpt-mini` at high effort.')).problems,
    name: 'declares no floors',
  },
  {
    label: 'a floored role named only inside a stage comment',
    problems: () => unusedRoles(new Map([['mini-seat', [{ criterion: 'taste', value: '5' }]]]), [['skills/mini-stage/SKILL.md', '<!-- spawn `mini-seat` -->\nSpawn the usual seat.\n']]),
    name: 'no stage names the seat role mini-seat',
  },
  {
    label: 'a floored role named only inside a fenced example',
    problems: () => unusedRoles(new Map([['mini-seat', [{ criterion: 'taste', value: '5' }]]]), [['skills/mini-stage/SKILL.md', 'Spawn the usual seat.\n\n```markdown\n- seat: `mini-seat`\n```\n']]),
    name: 'no stage names the seat role mini-seat',
  },
  {
    label: 'a four-backtick fence holding a three-backtick line',
    problems: () => unusedRoles(new Map([['mini-seat', [{ criterion: 'taste', value: '5' }]]]), [['skills/mini-stage/SKILL.md', 'Spawn the usual seat.\n\n````markdown\n```\n- seat: `mini-seat`\n````\n']]),
    name: 'no stage names the seat role mini-seat',
  },
  {
    label: 'a profile whose only binding sits in a fenced example',
    problems: () => roleProblems('The charter marks [[role:mini-seat]].\n',
      { 'mini.md': 'For example:\n\n```markdown\n### role: mini-seat\n\n`gpt-mini` at high effort.\n```\n' }).problems,
    name: 'mini.md has no "### role: mini-seat" section',
  },
  {
    label: 'a fence whose closing line carries trailing text',
    problems: () => unusedRoles(new Map([['mini-seat', [{ criterion: 'taste', value: '5' }]]]), [['skills/mini-stage/SKILL.md', 'Spawn the usual seat.\n\n```markdown\nexample\n``` explanation\n- seat: `mini-seat`\n```\n']]),
    name: 'no stage names the seat role mini-seat',
  },
  {
    label: 'a floored role no stage names',
    problems: () => unusedRoles(new Map([['mini-seat', [{ criterion: 'taste', value: '5' }]]]), [['skills/mini-stage/SKILL.md', 'Spawn the usual seat.\n']]),
    name: 'no stage names the seat role mini-seat',
  },
  {
    label: 'a role no profile binds',
    problems: () => roleProblems('The charter marks [[role:mini-seat]] and [[role:mini-publish]].\n',
      { 'mini.md': '### role: mini-seat\n\nThe seat that does the work.\n' }).problems,
    name: 'mini.md has no "### role: mini-publish" section for a role the charter marks',
  },
  {
    label: 'a binding the charter never marks',
    problems: () => roleProblems('The charter marks [[role:mini-seat]].\n',
      { 'mini.md': '### role: mini-seat\n\nThe seat.\n\n### role: mini-publish\n\nA role from nowhere.\n' }).problems,
    name: 'mini.md declares role mini-publish, which the charter never marks',
  },
  {
    // Right shape, wrong case. It matches neither extractor, so without the near-miss scan the
    // id sets still compare equal while the charter marks a role no profile can bind.
    label: 'a miscased marker',
    problems: () => roleProblems('The charter marks [[Role:mini-seat]].\n',
      { 'mini.md': '### role: mini-seat\n\nThe seat.\n' }).problems,
    name: 'which is not a canonical [[role:<id>]] marker',
  },
  {
    // A heading with nothing under it declares the id and binds none of it, and a section whose
    // whole body is an HTML comment reaches a session as exactly that much.
    label: 'an empty binding',
    problems: () => roleProblems('The charter marks [[role:mini-seat]].\n',
      { 'mini.md': '### role: mini-seat\n\n<!-- TODO: bind this once the CLI resolves here -->\n' }).problems,
    name: 'mini.md declares role: mini-seat with an empty section',
  },
  {
    label: 'a stage that rebinds a role',
    problems: () => roleClaims([['skills/mini-stage/SKILL.md', 'The seat runs [[role:mini-seat]].\n\n### role: mini-seat\n\nHere.\n']]),
    name: 'skills/mini-stage/SKILL.md declares "### role: mini-seat"',
  },
  {
    label: 'a host name outside the allowlisted sections',
    problems: () => hostLeaks('## Gripes\n\nOn Anthropic hosts the CLI resolves through the shell.\n'),
    name: 'the charter names "Anthropic" outside the allowlisted sections',
  },
]
for (const { label, problems: run, name } of CASES) {
  const found = run()
  assert.ok(found.length > 0, `the checker passed ${label}, a case built to fail`)
  assert.ok(found.some((problem) => problem.includes(name)), `${label} failed without naming "${name}": ${found.join('; ')}`)
  ok(`the checker fails ${label} and names the gap: ${found[0]}`)
}

console.log(`\ncharter conformance: ALL PASS (${checks} checks)`)
