#!/usr/bin/env node
// Conformance lint for the charter: the host-neutral prose in charter/charter.md marks roles
// with [[role:<id>]], and the profiles beside it bind every one of those ids for their host.
// The charter also has to stay free of host names outside the three sections that name models
// on purpose, and the roles have to stay charter-only, so a stage never rebinds one. The same
// checker functions run over the broken cases under scripts/fixtures/charter-conformance/, one
// directory per way the set can go wrong, plus a couple built in memory, so a green run also
// means the checker can still fail.
// Run: node plugins/flow/scripts/smoke-charter-conformance.mjs

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CLAUDE_PART_BUDGET, NO_BINDINGS_NOTE } from '../lib/charter-payload.mjs'
import { bindingProblems, body, prose } from './lib/conformance.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHARTER = join(ROOT, 'charter')
const FIXTURE = join(ROOT, 'scripts', 'fixtures', 'charter-conformance')
const read = (...parts) => readFileSync(join(...parts), 'utf8')
const lf = (text) => text.replace(/\r\n/g, '\n')

// The roles the charter marks. Written out rather than counted, so adding or dropping one is
// an edit here as well as in the charter and both profiles.
const ROLES = [
  'sub-seat',
  'orchestrator-model',
  'pipeline-entry',
  'artifact-publish',
  'context-inheritance',
  'search-seat',
  'gripe-cli',
]

// A host name in the charter means a role got bound in the file every host reads. Three
// sections are exempt because their whole job is naming models and families: the delegation
// tools are host-specific by definition, and the model table and its rules of engagement rank
// named models. Everywhere else, the mechanism belongs in a profile.
const HOST_WORDS = [
  'Claude',
  'Codex',
  'Anthropic',
  'OpenAI',
  'AskUserQuestion',
  'Explore',
  'PushNotification',
  'subagent',
  'fork',
]
const ALLOWED_SECTIONS = [
  'Cross-Family Delegation',
  'Model Rankings (as of 2026-08)',
  'Rules of Engagement - Model Selection',
]

// The one sentence the human copies into their own outer instructions, so a session that gets
// the charter without a profile says so instead of guessing at mechanisms.
const POINTER = 'If a <flow-charter> block is present without a matching <flow-profile> block, '
  + 'say so before substantive engineering work and do not run the flow pipeline stages.'

const profilesIn = (dir) => Object.fromEntries(
  readdirSync(join(dir, 'profiles'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => [f, read(dir, 'profiles', f)]),
)

// An HTML comment reaches no session: the hook prints the profile verbatim and the model reads
// it as markup, so "<!-- TODO -->" under a heading binds exactly as much as a blank line. A
// commented-out "### role: x" line is the same nothing, so it must not count as a binding
// either. The unterminated alternative closes on end-of-body, because text after an opener
// nobody closed is inside the comment too.
const uncommented = (text) => text.replace(/<!--[\s\S]*?(?:-->|$)/g, '')

// The one preprocessing point. Every profile check reads what comes out of here, so heading
// discovery and the body checks work off the same comment-free text. Strip per-section instead
// and a whole role block wrapped in one comment passes both: the hidden heading answers the
// parity check, and its body minus the opening delimiter reads as prose.
const readable = (profiles) => Object.fromEntries(
  Object.entries(profiles).map(([name, text]) => [name, uncommented(lf(text))]),
)

// The shared engine, bound to the charter's vocabulary.
const charterProblems = (charter, profiles) => bindingProblems({
  keyword: 'role',
  sourceName: 'the charter',
  sourceText: charter,
  profiles: readable(profiles),
})

// Everything outside the allowlisted sections, with fences and inline code removed. Unlike the
// stage lint this reads the engine's prose() view on purpose: the charter names cross-host
// literals like `delegate_to_codex` in backticks, and quoting a tool name binds nothing.
const scannable = (charter) => {
  const kept = []
  let allowed = false
  for (const line of prose(body(lf(charter))).split('\n')) {
    const heading = /^## (.+)$/.exec(line)
    if (heading) allowed = ALLOWED_SECTIONS.includes(heading[1].trim())
    kept.push(allowed ? '' : line)
  }
  return kept.join('\n')
}

// Fail closed: an allowlisted heading that no longer exists would silently exempt nothing, or
// worse, exempt the wrong text after a rename.
const missingSections = (charter) => {
  const headings = [...body(lf(charter)).matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
  return ALLOWED_SECTIONS.filter((name) => !headings.includes(name))
}

const hostLeaks = (charter) => {
  const text = scannable(charter)
  const problems = []
  for (const word of HOST_WORDS) {
    for (const hit of text.matchAll(new RegExp(`\\b${word}\\b`, 'gi'))) {
      const line = text.slice(0, hit.index).split('\n').length - 1
      problems.push(`the charter names "${hit[0]}" outside the allowlisted sections: "${text.split('\n')[line].trim()}"`)
    }
  }
  return problems
}

// The role grammar is the charter's alone. A stage may name a role in prose, but a stage
// profile that declares "### role: x" is a second, competing binding for the same name.
const stageRoleClaims = (root) => {
  const problems = []
  const skills = join(root, 'skills')
  for (const skill of readdirSync(skills, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const at = join(skills, skill.name)
    let entries = []
    try {
      entries = readdirSync(join(at, 'profiles')).filter((f) => f.endsWith('.md'))
    } catch { entries = [] }
    for (const file of entries) {
      const heading = /^### role: .*$/m.exec(read(at, 'profiles', file))
      if (heading) {
        problems.push(`skills/${skill.name}/profiles/${file} declares "${heading[0]}"; roles are bound in charter/profiles only`)
      }
    }
    try {
      if (read(at, 'SKILL.md').includes('[[role:')) {
        problems.push(`skills/${skill.name}/SKILL.md writes a [[role: marker; the role grammar is the charter's`)
      }
    } catch { /* a skill without a SKILL.md is not this lint's problem */ }
  }
  return problems
}

// Where a role section stops. An ATX heading ends it, and so does a setext one: a line of text
// with nothing but = or - under it renders as a heading too, so a scan that only knows about #
// would swallow the next section's title and its body and call the empty section above it full.
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)\s*$/
const endsSection = (rest, at) => /^#{1,6} /.test(rest[at])
  || (rest[at].trim() !== '' && SETEXT_UNDERLINE.test(rest[at + 1] ?? ''))

// A heading with nothing under it binds nothing, and the engine's set comparison cannot see it.
const emptyBindings = (profiles) => Object.entries(readable(profiles)).flatMap(([name, text]) => {
  const lines = text.split('\n')
  const problems = []
  for (const [at, line] of lines.entries()) {
    const heading = /^### role: ([a-z][a-z0-9-]*)$/.exec(line)
    if (!heading) continue
    const rest = lines.slice(at + 1)
    const end = rest.findIndex((_, i) => endsSection(rest, i))
    const section = end === -1 ? rest : rest.slice(0, end)
    if (section.join('\n').trim() === '') {
      problems.push(`${name} declares role ${heading[1]} with an empty section`)
    }
  }
  return problems
})

const emit = (script, args, root) => execFileSync(
  process.execPath,
  [join(ROOT, 'hooks', 'scripts', script), ...args],
  { env: { ...process.env, CLAUDE_PLUGIN_ROOT: root }, encoding: 'utf8' },
)

let checks = 0
const ok = (line) => {
  checks++
  console.log(`  ok: ${line}`)
}

console.log('the real charter')
const charter = read(CHARTER, 'charter.md')
const profiles = profilesIn(CHARTER)
assert.deepEqual(Object.keys(profiles).sort(), ['claude.md', 'codex.md'])
const { ids: roles, problems } = charterProblems(charter, profiles)
assert.deepEqual(problems, [], problems.join('\n'))
ok(`${roles.size} roles, and both profiles bind exactly those: ${[...roles].join(', ')}`)

assert.deepEqual([...roles].sort(), [...ROLES].sort())
ok('the marked roles are exactly the expected set')

assert.deepEqual(missingSections(charter), [], 'an allowlisted section heading no longer exists in the charter')
ok(`all ${ALLOWED_SECTIONS.length} allowlisted sections still exist: ${ALLOWED_SECTIONS.join('; ')}`)

const leaks = hostLeaks(charter)
assert.deepEqual(leaks, [], leaks.join('\n'))
ok('the charter names no host outside the allowlisted sections')

assert.ok(charter.includes('<flow-profile>'), 'the charter must name the <flow-profile> tag it tells a session to look for')
ok('the charter names the <flow-profile> tag in its presence paragraph')

const claims = stageRoleClaims(ROOT)
assert.deepEqual(claims, [], claims.join('\n'))
ok('no stage marks or rebinds a charter role')

const empty = emptyBindings(profiles)
assert.deepEqual(empty, [], empty.join('\n'))
ok('every role section in both profiles carries prose')

console.log('the real emitters')
// The budgets are assertions about what the hooks actually print, not about the source files:
// each half carries a continuation comment the charter itself does not.
for (const part of ['1', '2']) {
  const half = emit('inject-charter.mjs', [part], ROOT)
  assert.ok(
    half.length < CLAUDE_PART_BUDGET,
    `charter part ${part} is ${half.length} chars, over the ${CLAUDE_PART_BUDGET}-char per-hook budget`,
  )
  assert.ok(!half.includes('flow-charter WARNING'), `charter part ${part} carries a budget warning`)
  ok(`charter part ${part} is ${half.length} chars, under ${CLAUDE_PART_BUDGET}, with no warning`)
}

const profile = emit('inject-profile.mjs', [], ROOT)
assert.ok(
  profile.length < CLAUDE_PART_BUDGET,
  `the profile block is ${profile.length} chars, over the ${CLAUDE_PART_BUDGET}-char per-hook budget`,
)
assert.match(profile, /<flow-profile host="claude" bindings="bound">/)
assert.match(profile, /<\/flow-profile>\n$/)
ok(`the Claude profile block is ${profile.length} chars and reports bindings="bound"`)

// A root with no charter/profiles/ still emits a block and exits 0: execFileSync throws on a
// non-zero exit, so reaching the assertions is the exit check.
const bare = mkdtempSync(join(tmpdir(), 'flow-charter-conformance-'))
const missing = emit('inject-profile.mjs', [], bare)
assert.match(missing, /<flow-profile host="claude" bindings="none">/)
assert.ok(missing.includes(NO_BINDINGS_NOTE), 'a missing profile must carry the no-bindings note')
ok('a root with no profiles emits bindings="none" and the no-bindings note')

console.log('the setup pointer')
const skill = read(ROOT, 'skills', 'flow', 'SKILL.md')
assert.ok(skill.includes(POINTER), 'skills/flow/SKILL.md no longer carries the exact presence sentence')
ok('the flow skill carries the presence sentence verbatim')

console.log('the negative fixtures')
// One directory per way the set can be wrong, plus the cases whose whole content is a few lines
// of profile text and would make a directory dishonest about what is under test. Each case names
// the substrings its failure has to contain, so a checker that fails for some unrelated reason
// does not count as proof.
const bindings = (at) => charterProblems(read(at, 'charter.md'), profilesIn(at)).problems
const CASES = [
  {
    dir: 'missing-binding',
    run: bindings,
    names: ['codex.md has no "### role: mini-publish" section for a role the charter marks'],
  },
  {
    dir: 'malformed-marker',
    run: bindings,
    names: ['[[role:Bad_Id]]', 'not a canonical [[role:<id>]] marker'],
  },
  {
    dir: 'host-leak',
    run: (at) => hostLeaks(read(at, 'charter.md')),
    names: ['Anthropic', 'the leak this case exists to catch'],
    count: 1,
  },
  {
    dir: 'stage-role-redefinition',
    run: stageRoleClaims,
    names: [
      'skills/mini-stage/profiles/claude.md declares "### role: mini-seat"',
      'skills/mini-stage/SKILL.md writes a [[role: marker',
    ],
  },
  {
    // A whole role block inside one comment. Nothing here binds mini-publish, so the parity
    // check has to report it missing rather than counting the hidden heading as a declaration.
    label: 'commented-out-heading',
    run: () => charterProblems(
      'The charter marks [[role:mini-seat]] and [[role:mini-publish]].\n',
      {
        'hidden.md': [
          '### role: mini-seat',
          'The seat that does the work.',
          '',
          '<!--',
          '### role: mini-publish',
          'Bind this once the CLI resolves here.',
          '-->',
          '',
        ].join('\n'),
      },
    ).problems,
    names: ['hidden.md has no "### role: mini-publish" section for a role the charter marks'],
    count: 1,
  },
  {
    // The near miss the old substring scan walked straight past: right shape, wrong case. It
    // matches neither extractor, so without this the id sets still compare equal and the
    // charter marks a role no profile can bind.
    label: 'miscased-marker',
    run: () => charterProblems(
      'The charter marks [[Role:mini-seat]].\n',
      { 'mini.md': '### role: mini-seat\nThe seat that does the work.\n' },
    ).problems,
    names: ['[[Role:mini-seat]]', 'not a canonical [[role:<id>]] marker'],
    count: 1,
  },
  {
    // Underlined text is a heading, so the mini-seat section really is empty. A scan that only
    // stops at # reads the next section's title and body as mini-seat's binding.
    label: 'setext-masked-empty',
    run: () => emptyBindings({ 'setext.md': [
      '### role: mini-seat',
      '',
      'Bindings',
      '--------',
      '',
      'The seat that does the work.',
      '',
    ].join('\n') }),
    names: ['setext.md declares role mini-seat with an empty section'],
    count: 1,
  },
  {
    label: 'commented-out-binding',
    run: () => emptyBindings({ 'commented.md': [
      '### role: mini-seat',
      '<!-- TODO -->',
      '',
      '### role: mini-publish',
      '<!-- TODO:',
      'bind this once the CLI resolves here',
      '-->',
      '',
      '### role: mini-search',
      'A read-only seat.',
      '',
    ].join('\n') }),
    names: [
      'commented.md declares role mini-seat with an empty section',
      'commented.md declares role mini-publish with an empty section',
    ],
    count: 2,
  },
]
for (const { dir, label, run, names, count } of CASES) {
  const which = dir ?? label
  const found = dir ? run(join(FIXTURE, dir)) : run()
  assert.ok(found.length > 0, `the checker passed ${which}, a case built to fail`)
  if (count !== undefined) {
    assert.equal(found.length, count, `${which} reported ${found.length} problems, expected ${count}: ${found.join('; ')}`)
  }
  for (const name of names) {
    assert.ok(
      found.some((p) => p.includes(name)),
      `${which} failed without naming "${name}": ${found.join('; ')}`,
    )
  }
  ok(`the checker fails ${which} and names the gap: ${found[0]}`)
}

console.log(`\ncharter conformance: ALL PASS (${checks} checks)`)
