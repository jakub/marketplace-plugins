#!/usr/bin/env node
// Charter delivery, through the real hook script and the real hook registrations: the session
// gets the whole charter under one hook's cap or a refusal with no tag, every seat gets the same
// seat half, Claude skips Explore and fork, and a broken charter never fails a hook.
// Run: node plugins/flow/scripts/smoke-charter.mjs

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SEAT_MARKER, seatPayload } from '../lib/charter-payload.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CAP = 9_500
const charter = readFileSync(join(ROOT, 'charter', 'charter.md'), 'utf8')
const scratch = mkdtempSync(join(tmpdir(), 'flow-smoke-charter-'))
let checks = 0
const ok = (line) => { checks += 1; console.log(`  ok: ${line}`) }

const inject = (args, { input = '', env = { CLAUDE_PLUGIN_ROOT: ROOT, PLUGIN_ROOT: ROOT } } = {}) => {
  const run = spawnSync(process.execPath, [join(ROOT, 'hooks', 'scripts', 'inject-charter.mjs'), ...args], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: '', PLUGIN_ROOT: '', ...env }, input, encoding: 'utf8',
  })
  assert.equal(run.status, 0, `inject-charter ${args.join(' ')} exited ${run.status}: ${run.stderr}`)
  return run
}
const rootWith = (name, text) => {
  mkdirSync(join(scratch, name, 'charter'), { recursive: true })
  writeFileSync(join(scratch, name, 'charter', 'charter.md'), text)
  return join(scratch, name)
}
const seatOf = (stdout) => JSON.parse(stdout).hookSpecificOutput

try {
  assert.equal(charter.split('\n').filter((line) => line.trimEnd() === SEAT_MARKER).length, 1)
  ok('the charter carries exactly one seat marker')

  // The issue's routing lines. Each routing check reports why a text fails, so the controls below
  // can prove that reverting either line, or the whole file to its pre-plans form, is caught.
  const SHOW_LINE = 'When structure or visuals beat prose, pick a tier with `plans:show` if installed, else sketch.'
  const KEEP_TAIL = 'Publish HTML, video and large image sets with `plans:publish --keep`, because a PR outlives any TTL, and say the link is tailnet-only.'
  const routingFailures = (text) => {
    const lines = text.split('\n').map((line) => line.trimEnd())
    return [
      !lines.includes(SHOW_LINE) && 'the plans:show sentence is missing',
      !lines.some((line) => line.endsWith(KEEP_TAIL)) && 'the plans:publish --keep line is missing',
      text.includes('the artifact publisher') && 'the artifact publisher still appears',
    ].filter(Boolean)
  }
  assert.deepEqual(routingFailures(charter), [], 'the charter lost a plans routing line')
  ok('the charter routes visuals through plans:show and keeps through plans:publish --keep, and never names the artifact publisher')

  const reverted = {
    'the show line': charter.replace(SHOW_LINE, 'When structure or visuals beat prose, publish HTML through the artifact publisher and hand back the URL.'),
    'the keep line': charter.replace(KEEP_TAIL, "Publish HTML, video and large image sets with the artifact publisher's `--keep`, because a PR outlives any TTL, and say the link is tailnet-only."),
  }
  for (const [name, text] of Object.entries(reverted)) {
    assert.notEqual(text, charter, `the control for ${name} changed nothing`)
    assert.notDeepEqual(routingFailures(text), [], `reverting ${name} still passed the routing checks`)
  }
  ok('reverting either routing line, in memory, fails the routing checks')

  // The base blob is read from git at run time, so a tree without history skips only this control.
  const base = spawnSync('git', ['-C', ROOT, 'show', 'bfd53e8:./charter/charter.md'], { encoding: 'utf8' })
  if (base.status === 0 && base.stdout.includes(SEAT_MARKER)) {
    assert.notDeepEqual(routingFailures(base.stdout), [], 'the bfd53e8 charter passed the routing checks')
    ok('the pre-plans charter at bfd53e8 fails the routing checks')
  } else {
    console.log('  skip: the bfd53e8 negative control needs that commit in git history, and this tree has none')
  }

  for (const host of ['claude', 'codex']) {
    const { stdout } = inject(['session', host])
    assert.equal(stdout, charter, `the ${host} session payload is not the charter verbatim`)
    assert.ok(stdout.startsWith('<flow-charter>'), `the ${host} session payload does not open with the tag`)
    assert.ok(stdout.length <= CAP, `the ${host} session payload is ${stdout.length} characters, over ${CAP}`)
    ok(`a ${host} session gets the whole charter, ${stdout.length} characters, under ${CAP}`)
  }

  for (const [file, variable, host] of [['hooks.json', 'CLAUDE_PLUGIN_ROOT', 'claude'], ['codex.json', 'PLUGIN_ROOT', 'codex']]) {
    const { hooks } = JSON.parse(readFileSync(join(ROOT, 'hooks', file), 'utf8'))
    const commands = (event) => (hooks[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command))
      .filter((command) => command.includes('inject-charter.mjs'))
    assert.deepEqual(commands('SessionStart'), [`node "\${${variable}}/hooks/scripts/inject-charter.mjs" session ${host}`])
    assert.deepEqual(commands('SubagentStart'), [`node "\${${variable}}/hooks/scripts/inject-charter.mjs" subagent ${host}`])
    ok(`hooks/${file} registers one session and one subagent charter hook`)
  }

  // Codex keys a hook's trust by its position and hashes its command string, so a group inserted
  // ahead of these, or an edited command, silently untrusts a hook a human already trusted. This
  // table is literal, copied from hooks/codex.json before the seat guard was added, and is never
  // regenerated from the file: a new group goes after these, never between them.
  const CODEX_TRUSTED = {
    'PreToolUse:0:0': 'node "${PLUGIN_ROOT}/hooks/scripts/no-backlog-guard.mjs"',
    'PreToolUse:0:1': 'node "${PLUGIN_ROOT}/hooks/scripts/git-guard.mjs"',
    'PreToolUse:0:2': 'node "${PLUGIN_ROOT}/hooks/scripts/publish-guard-codex.mjs"',
    'PreToolUse:1:0': 'node "${PLUGIN_ROOT}/hooks/scripts/protect-files-codex.mjs"',
    'SessionStart:0:0': 'node "${PLUGIN_ROOT}/hooks/scripts/inject-charter.mjs" session codex',
    'SessionStart:1:0': 'node "${PLUGIN_ROOT}/scripts/install-delegate.mjs" install',
    'SubagentStart:0:0': 'node "${PLUGIN_ROOT}/hooks/scripts/inject-charter.mjs" subagent codex',
  }
  const codexHooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'codex.json'), 'utf8')).hooks
  for (const [key, command] of Object.entries(CODEX_TRUSTED)) {
    const [event, group, handler] = key.split(':')
    assert.equal(codexHooks[event]?.[Number(group)]?.hooks?.[Number(handler)]?.command, command, `hooks/codex.json moved or changed ${key}`)
  }
  assert.equal(codexHooks.PreToolUse[0].matcher, 'Bash')
  assert.equal(codexHooks.PreToolUse[1].matcher, 'apply_patch|Edit|Write')
  assert.equal(codexHooks.PreToolUse[0].hooks.length, 3)
  ok(`hooks/codex.json keeps all ${Object.keys(CODEX_TRUSTED).length} trusted hooks at their positions with their command strings`)

  // Codex caps a hook's additionalContext by this limit, in tokens; the seat context inlines the
  // answer schema while the whole context stays within 6000 bytes, which no tokenizer counts as
  // more than 6000 tokens, so the prompt hook asks for more than the default.
  const promptLimit = { claude: {}, codex: { additionalContextLimit: 6000 } }
  for (const [file, variable, host, matcher] of [['hooks.json', 'CLAUDE_PLUGIN_ROOT', 'claude', '*'], ['codex.json', 'PLUGIN_ROOT', 'codex', '.*']]) {
    const { hooks } = JSON.parse(readFileSync(join(ROOT, 'hooks', file), 'utf8'))
    const command = (mode) => `node "\${${variable}}/hooks/scripts/seat-guard.mjs" ${mode} ${host}`
    const seatGroups = (event) => (hooks[event] ?? []).filter((group) => group.hooks.some((hook) => hook.command.includes('seat-guard.mjs')))
    const pre = hooks.PreToolUse.at(-1)
    assert.deepEqual(seatGroups('PreToolUse'), [pre], `hooks/${file}: the seat guard is not the last PreToolUse group alone`)
    assert.deepEqual(pre, { matcher, hooks: [{ type: 'command', command: command('pre'), timeout: 10 }] })
    assert.deepEqual(hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: command('prompt'), timeout: 10, ...promptLimit[host] }] }])
    assert.deepEqual(hooks.Stop, [{ hooks: [{ type: 'command', command: command('stop'), timeout: 30 }] }])
    for (const event of Object.keys(hooks).filter((name) => !['PreToolUse', 'UserPromptSubmit', 'Stop'].includes(name))) {
      assert.deepEqual(seatGroups(event), [], `hooks/${file} registers the seat guard on ${event}`)
    }
    ok(`hooks/${file} registers the seat guard as the last PreToolUse group, matcher ${JSON.stringify(matcher)}, on UserPromptSubmit${host === 'codex' ? ' with a 6000-token context limit' : ''}, and on Stop with a 30 s timeout`)
  }

  const seat = seatPayload(charter)
  for (const host of ['claude', 'codex']) {
    for (const input of [JSON.stringify({ agent_type: 'general-purpose' }), '{']) {
      const answer = seatOf(inject(['subagent', host], { input }).stdout)
      assert.equal(answer.hookEventName, 'SubagentStart')
      assert.equal(answer.additionalContext, seat, `a ${host} seat did not get seatPayload() verbatim`)
    }
  }
  assert.ok(seat.startsWith('<flow-charter scope="seat">') && seat.endsWith('</flow-charter>\n') && !seat.includes('## Hosts'))
  // Read off the file here rather than through seatPayload(), so a helper that drops a section
  // cannot pass: everything below the marker, less the whole-file closing tag, arrives verbatim.
  const below = charter.slice(charter.indexOf(SEAT_MARKER) + SEAT_MARKER.length).trim().replace(/<\/flow-charter>$/, '').trim()
  assert.ok(below.includes('## Rules of Engagement') && below.includes('## Seat Contract'), 'the seat half lost a heading this smoke expects')
  assert.ok(seat.includes(`\n${below}\n</flow-charter>\n`), 'the seat payload is not the whole charter below the marker')
  ok('a seat on either host gets seatPayload(), the whole half below the marker, even from an unreadable body')

  for (const agent_type of ['Explore', 'fork']) {
    const input = JSON.stringify({ agent_type })
    assert.equal(inject(['subagent', 'claude'], { input }).stdout, '', `Claude handed ${agent_type} the seat half`)
    assert.equal(seatOf(inject(['subagent', 'codex'], { input }).stdout).additionalContext, seat, `Codex skipped ${agent_type}`)
  }
  ok('Explore and fork are skipped on Claude and delivered on Codex')

  const elsewhere = join(scratch, 'no-such-root')
  assert.equal(inject(['session', 'codex'], { env: { PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_ROOT: elsewhere } }).stdout, charter)
  assert.equal(inject(['session', 'claude'], { env: { CLAUDE_PLUGIN_ROOT: ROOT, PLUGIN_ROOT: elsewhere } }).stdout, charter)
  ok('each host reads its own root variable first')

  const oversize = rootWith('oversize', `${charter}\n${'x'.repeat(Math.max(1, 9_800 - charter.length + 1))}\n`)
  for (const host of ['claude', 'codex']) {
    const { stdout } = inject(['session', host], { env: { CLAUDE_PLUGIN_ROOT: oversize, PLUGIN_ROOT: oversize } })
    assert.match(stdout, /^<!-- flow charter refused: charter\/charter\.md is \d+ characters, over the 9800 /)
    assert.ok(!stdout.includes('<flow-charter'), `the ${host} refusal still carries a charter tag`)
  }
  ok('a charter over 9,800 characters is refused with one comment and no tag, on both hosts')

  const broken = rootWith('two-markers', charter.replace(SEAT_MARKER, `${SEAT_MARKER}\n${SEAT_MARKER}`))
  const run = inject(['subagent', 'claude'], { input: '{}', env: { CLAUDE_PLUGIN_ROOT: broken } })
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /exactly one seat-rules marker/)
  const missing = inject(['session', 'claude'], { env: { CLAUDE_PLUGIN_ROOT: join(scratch, 'missing') } })
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /cannot read the charter/)
  ok('a broken or missing charter exits 0 with empty stdout and a stderr diagnostic')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\ncharter delivery: ALL PASS (${checks} checks)`)
