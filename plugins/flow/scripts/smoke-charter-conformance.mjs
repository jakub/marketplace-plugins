#!/usr/bin/env node
// Conformance lint for the charter. charter/charter.md is host-neutral prose that marks a role
// with [[role:<id>]] instead of naming a mechanism, and charter/profiles/<host>.md binds every
// one of those ids under a "### role: <id>" heading. The role grammar is the charter's alone, so
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
const quoteless = (text) => text
  .replace(/^ {0,3}(```|~~~)[\s\S]*?^ {0,3}\1[^\n]*$/gm, '')
  .replace(/`[^`\n]*`/g, '')
const uncommented = (text) => text.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
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
    const text = uncommented(raw.replace(/\r\n/g, '\n'))
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

console.log('the checker can still fail')
const CASES = [
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
