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
