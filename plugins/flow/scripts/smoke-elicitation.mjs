#!/usr/bin/env node
// Smoke for the elicitation guard: hooks/scripts/elicitation-guard.mjs run as a real hook process,
// one process per call with the call as JSON on stdin, shaped like the Elicitation input Claude Code
// 2.1.309 and 2.1.310 sent live. The state directory is a temp directory named by
// FLOW_DELEGATION_STATE_DIR, and every seat fixture is written through the real lib/seat-store.mjs.
// Cases are grouped by prefix: seat-* (every seat state and mode declines), outside-* (non-members
// and unreadable identity get nothing), shape-*, trace-* (module loads, from process.moduleLoadList
// in an --import preload), fault-* (smoke-only preloads that break the member path), gripe-* (a fake
// gripe first on PATH, absent and hanging variants) and state-* (a decline never writes the seat).
// Every run's PATH holds only a scratch bin directory, so no real gripe is ever filed.
// The temp directory comes from os.tmpdir(), so TMPDIR moves it.
// Run: node plugins/flow/scripts/smoke-elicitation.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = join(PLUGIN, 'hooks', 'scripts', 'elicitation-guard.mjs')
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-smoke-elicitation-')))
const state = join(tmp, 'state')
process.env.FLOW_DELEGATION_STATE_DIR = state
const store = await import(pathToFileURL(join(PLUGIN, 'lib', 'seat-store.mjs')).href)
const wire = await import(pathToFileURL(join(PLUGIN, 'hooks', 'scripts', 'wire.mjs')).href)

let checks = 0
const ok = (line) => { checks++; console.log(`  ok: ${line}`) }
const DECLINE = { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'decline' } }
const DECLINE_TEXT = JSON.stringify(DECLINE)
const MODES = ['form', 'url', undefined, 'bogus']
const RECORD = (fields = {}) => ({
  v: 1, createdAt: new Date().toISOString(), access: 'read-only', repoRoot: '/r', worktree: '/r', reviewWorktree: null,
  baseSha: null, headSha: null, provider: 'claude', providerInstanceId: 'claudeAgent', model: 'claude-opus-5-5',
  expectedServedModel: 'claude-opus-5-5', effort: 'high', runtimeMode: 'auto', canonicalSnapshot: null, hooksDigest: null, ...fields,
})

// An empty bin directory: the PATH every run gets unless a case puts a fake gripe on it.
const emptyBin = join(tmp, 'empty-bin')
mkdirSync(emptyBin)
const work = join(tmp, 'cwd')
mkdirSync(work)

// The input Claude Code sends, with every field it carries. A mode or server given as undefined
// drops the key; one not given at all gets the default.
function call(sessionId, options = {}) {
  const { mode: _mode, server: _server, ...fields } = options
  const mode = 'mode' in options ? options.mode : 'form'
  const server = 'server' in options ? options.server : 'scratch'
  const input = {
    session_id: sessionId, transcript_path: join(tmp, 'transcript.jsonl'), cwd: work, hook_event_name: 'Elicitation',
    mcp_server_name: server, message: 'Please confirm', mode, elicitation_id: `el-${randomUUID()}`,
    requested_schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, prompt_id: randomUUID(), ...fields,
  }
  if (mode === undefined) delete input.mode
  if (server === undefined) delete input.mcp_server_name
  return input
}

function guard(input, { env = {}, nodeArgs = [] } = {}) {
  const started = performance.now()
  const run = spawnSync(process.execPath, [...nodeArgs, GUARD], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', cwd: work, timeout: 20_000,
    env: { ...process.env, PATH: emptyBin, ...env },
  })
  const ms = performance.now() - started
  assert.equal(run.error, undefined, `guard did not run: ${run.error}`)
  assert.equal(run.signal, null, `guard died on ${run.signal}: ${run.stderr}`)
  return { ...run, ms }
}
// A decline is the exact shape with exit 0, or exit 2 with anything on stdout. Exit 1 never is.
function declined(run, what) {
  assert.notEqual(run.status, 1, `${what}: exit 1 is not a decline: ${run.stderr}`)
  assert.ok((run.stdout === DECLINE_TEXT && run.status === 0) || run.status === 2,
    `${what}: expected a decline, got status ${run.status} stdout ${JSON.stringify(run.stdout)} stderr ${run.stderr}`)
}
function exactDecline(run, what) {
  assert.equal(run.status, 0, `${what}: exit ${run.status}: ${run.stderr}`)
  assert.equal(run.stdout, DECLINE_TEXT, what)
}
function silent(run, what) {
  assert.equal(run.status, 0, `${what}: exit ${run.status}: ${run.stderr}`)
  assert.equal(run.stdout, '', `${what}: expected no answer, got ${run.stdout}`)
}

// Seat fixtures, one fresh session per call, each written through the store as the hooks write it.
const sid = () => `s-${randomUUID()}`
const SEATS = {
  bound() {
    const session = sid()
    const { id, digest } = store.writeRecord(RECORD())
    assert.equal(store.indexSession('claude', session, { id }), true)
    assert.equal(store.stamp(id, 'bound', { sessionId: session, host: 'claude', permissionMode: 'auto', cwd: work, recordDigest: digest }), true)
    return { session, id }
  },
  void() {
    const session = sid()
    const { id } = store.writeRecord(RECORD())
    store.stamp(id, 'void', { reason: 'smoke' })
    assert.equal(store.voidSession('claude', session, id, 'smoke'), true)
    return { session, id }
  },
  closed() {
    const seat = SEATS.bound()
    assert.equal(store.stamp(seat.id, 'closed', { verdict: 'valid' }), true)
    return seat
  },
  'missing-record'() {
    const session = sid()
    const id = store.newId()
    assert.equal(store.indexSession('claude', session, { id }), true)
    assert.equal(store.readRecord(id), null)
    return { session, id }
  },
  'corrupt-index'() {
    const session = sid()
    const path = store.indexPath('claude', session)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.from([0x00, 0xff, 0x7b, 0xfe, 0x22, 0x0a]))
    assert.deepEqual(store.readIndex('claude', session), { id: null, void: 'index-unreadable' })
    return { session, id: null }
  },
}

// Every file under dir, relative, with its bytes.
function snapshot(dir) {
  const files = {}
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else files[relative(dir, path)] = readFileSync(path).toString('base64')
    }
  }
  if (existsSync(dir)) walk(dir)
  return files
}

// Smoke-only preloads, passed with --import. None of them is a switch in the guard.
const preload = (name, text) => {
  const path = join(tmp, name)
  writeFileSync(path, text)
  return ['--import', pathToFileURL(path).href]
}
const TRACE = preload('trace.mjs', `import { writeFileSync } from 'node:fs'
process.on('exit', () => {
  const list = process.moduleLoadList
  writeFileSync(process.env.TRACE_OUT, Array.isArray(list) ? JSON.stringify(list) : 'no-moduleLoadList')
})
`)
const STDOUT_THROWS = preload('stdout-throws.mjs', `process.stdout.write = () => { throw new Error('smoke: stdout.write fault') }
`)
const IMPORT_THROWS = preload('import-throws.mjs', `import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:child_process') throw new Error('smoke: child_process import fault')
  return next(specifier, context)
} })
`)
const SPAWN_THROWS = preload('spawn-throws.mjs', `import { createRequire, syncBuiltinESMExports } from 'node:module'
const childProcess = createRequire(import.meta.url)('node:child_process')
childProcess.spawn = () => { throw new Error('smoke: spawn fault') }
syncBuiltinESMExports()
`)

// A fake gripe first on PATH: it writes its argv, CLAUDE_CODE_SESSION_ID and cwd to out, through a
// rename so a poller never reads half a file. With pidFile it records its pid and then hangs.
function fakeGripe(name, { pidFile = null } = {}) {
  const bin = join(tmp, name)
  mkdirSync(bin)
  const out = join(tmp, `${name}.json`)
  const script = join(bin, 'gripe')
  writeFileSync(script, `#!${process.execPath}
const { renameSync, writeFileSync } = require('node:fs')
${pidFile ? `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
setTimeout(() => {}, 30_000)` : `writeFileSync(${JSON.stringify(`${out}.tmp`)}, JSON.stringify({ argv: process.argv.slice(2), sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null, cwd: process.cwd() }))
renameSync(${JSON.stringify(`${out}.tmp`)}, ${JSON.stringify(out)})`}
`, { mode: 0o755 })
  return { bin, out }
}
async function waitFor(path, what, ms = 10_000) {
  for (const end = Date.now() + ms; !existsSync(path);) {
    if (Date.now() > end) throw new Error(`${what}: ${path} never appeared`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return readFileSync(path, 'utf8')
}

const cases = {
  'seat-states-and-modes': () => {
    for (const [name, make] of Object.entries(SEATS)) {
      for (const mode of MODES) {
        const { session } = make()
        exactDecline(guard(call(session, { mode })), `${name} seat, mode ${mode ?? '(absent)'}`)
      }
    }
    ok(`bound, void, closed, missing-record and corrupt-index seats each print the exact decline and exit 0 for mode form, url, absent and bogus (${Object.keys(SEATS).length * MODES.length} runs)`)
  },

  'outside-non-member': () => {
    silent(guard(call(sid())), 'no index entry')
    const codexOnly = sid()
    const { id } = store.writeRecord(RECORD({ provider: 'codex', providerInstanceId: 'codex', model: 'gpt-6-luna', expectedServedModel: 'gpt-6-luna' }))
    assert.equal(store.indexSession('codex', codexOnly, { id }), true)
    assert.ok(existsSync(store.indexPath('codex', codexOnly)))
    silent(guard(call(codexOnly)), 'codex index only')
    ok('a session with no claude index entry, including one whose codex-<sid> entry exists, gets no answer and exit 0')
  },

  'outside-identity-unknown': () => {
    for (const body of ['', '{', 'null', '[]', '"text"']) silent(guard(body), `body ${JSON.stringify(body)}`)
    const missing = call('x')
    delete missing.session_id
    silent(guard(missing), 'session_id missing')
    for (const session of ['../x', 'a'.repeat(129), 7, null]) {
      assert.equal(store.indexPath('claude', session), null)
      silent(guard(call(session)), `session_id ${JSON.stringify(session).slice(0, 20)}`)
    }
    ok('unreadable bodies and a missing, traversal, 129-character or non-string session_id get no answer and exit 0')
  },

  'shape-decline': () => {
    assert.deepEqual(wire.elicitationDecline(), DECLINE)
    assert.equal(JSON.stringify(wire.elicitationDecline()), '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"decline"}}')
    const run = guard(call(SEATS.bound().session))
    assert.equal(run.stdout, JSON.stringify(DECLINE))
    ok('elicitationDecline() deep-equals the literal shape, and the guard prints exactly its JSON')
  },

  'trace-child-process-load': () => {
    const traced = (input, what) => {
      const out = join(tmp, `trace-${randomUUID()}.json`)
      const run = guard(input, { nodeArgs: TRACE, env: { TRACE_OUT: out } })
      const text = readFileSync(out, 'utf8')
      assert.notEqual(text, 'no-moduleLoadList', `${what}: process.moduleLoadList is missing, so the trace proves nothing`)
      const list = JSON.parse(text)
      assert.ok(list.length > 0, `${what}: empty module list`)
      return { run, childProcess: list.filter((entry) => /child_process/.test(entry)) }
    }
    const seat = traced(call(SEATS.bound().session), 'seat')
    exactDecline(seat.run, 'traced seat run')
    assert.ok(seat.childProcess.length > 0, 'seat path: node:child_process was never loaded, so the trace cannot see it')
    const outside = [
      ['no index entry', call(sid())],
      ['unreadable body', '{'],
      ['invalid session_id', call('../x')],
    ]
    for (const [what, input] of outside) {
      const { run, childProcess } = traced(input, what)
      silent(run, `traced ${what}`)
      assert.deepEqual(childProcess, [], `${what}: loaded ${childProcess.join(', ')}`)
    }
    ok(`the seat path loads node:child_process (${seat.childProcess.join(', ')}), and no non-member or identity-unknown run does`)
  },

  'fault-stdout-write-throws': () => {
    const run = guard(call(SEATS.bound().session), { nodeArgs: STDOUT_THROWS })
    assert.equal(run.status, 2, `expected exit 2, got ${run.status}: ${run.stderr}`)
    declined(run, 'stdout.write throws')
    silent(guard(call(sid()), { nodeArgs: STDOUT_THROWS }), 'stdout.write fault, non-member')
    ok('a throwing stdout.write on the seat path exits 2, and changes nothing for a non-member')
  },

  'fault-child-process-import-throws': () => {
    const run = guard(call(SEATS.bound().session), { nodeArgs: IMPORT_THROWS })
    declined(run, 'child_process import throws')
    // The guard as written answers exit 2 here; anything else means the fault never fired.
    assert.equal(run.status, 2, `the import fault did not fire: ${run.stdout}`)
    silent(guard(call(sid()), { nodeArgs: IMPORT_THROWS }), 'import fault, non-member')
    ok('a node:child_process resolve that throws still declines, and changes nothing for a non-member')
  },

  'fault-spawn-throws': () => {
    const run = guard(call(SEATS.bound().session), { nodeArgs: SPAWN_THROWS })
    declined(run, 'spawn throws')
    assert.equal(run.status, 2, `the spawn fault did not fire: ${run.stdout}`)
    silent(guard(call(sid()), { nodeArgs: SPAWN_THROWS }), 'spawn fault, non-member')
    ok('a spawn that throws still declines, and changes nothing for a non-member')
  },

  'gripe-argv-and-env': async () => {
    const CANARY = { message: 'CANARY-MESSAGE-7f3a', url: 'https://canary.invalid/CANARY-URL-91b2', schema: 'CANARY-SCHEMA-4c0d', elicitation: 'CANARY-ELICITATION-e55e' }
    const names = [
      ['plain', 'context7.docs_v2-x', 'context7.docs_v2-x'],
      ['spaces and slashes', 'my server/with\\slashes:here', 'my_server_with_slashes_here'],
      ['unicode', 'sérveur-ü🙂', 's_rveur-___'],
      ['over 64', `a b/é🙂${'x'.repeat(80)}`, `a_b_${'_'.repeat(3)}${'x'.repeat(57)}`],
      ['missing', undefined, '(unnamed)'],
      ['empty', '', '(unnamed)'],
      ['not a string', 42, '(unnamed)'],
    ]
    for (const [what, server, expected] of names) {
      assert.ok(expected === '(unnamed)' || expected.length <= 64, `${what}: bad fixture`)
      const fake = fakeGripe(`gripe-${randomUUID()}`)
      const { session, id } = SEATS.bound()
      const input = call(session, {
        server, message: CANARY.message, url: CANARY.url, mode: 'url', elicitation_id: CANARY.elicitation,
        requested_schema: { type: 'object', description: CANARY.schema },
      })
      exactDecline(guard(input, { env: { PATH: fake.bin } }), `gripe ${what}`)
      const seen = JSON.parse(await waitFor(fake.out, `gripe ${what}`))
      assert.deepEqual(seen.argv, ['add', '--trigger', 'flow-seat-elicitation', `flow seat declined an MCP elicitation from server ${expected}`], what)
      assert.equal(seen.argv.length, 4, what)
      const argv = seen.argv.join('\n')
      for (const canary of [...Object.values(CANARY), id]) assert.ok(!argv.includes(canary), `${what}: ${canary} reached gripe's argv`)
      assert.equal(seen.sessionId, session, what)
      assert.equal(realpathSync(seen.cwd), work, what)
    }
    ok(`gripe gets exactly add --trigger flow-seat-elicitation <body> with the sanitized server name (${names.length} names), no canary or seat id, the input session_id as CLAUDE_CODE_SESSION_ID and the guard's cwd`)
  },

  'gripe-absent': () => {
    assert.deepEqual(readdirSync(emptyBin), [])
    exactDecline(guard(call(SEATS.bound().session), { env: { PATH: emptyBin } }), 'gripe absent')
    ok('with no gripe on PATH the guard still prints the exact decline and exits 0')
  },

  'gripe-hanging': async () => {
    const pidFile = join(tmp, `hang-${randomUUID()}.pid`)
    const fake = fakeGripe(`gripe-hang-${randomUUID()}`, { pidFile })
    let pid = null
    try {
      const run = guard(call(SEATS.bound().session), { env: { PATH: fake.bin } })
      exactDecline(run, 'gripe hangs')
      assert.ok(run.ms < 2000, `guard took ${run.ms.toFixed(0)} ms with a hanging gripe`)
      pid = Number(await waitFor(pidFile, 'hanging gripe'))
      assert.ok(Number.isSafeInteger(pid) && pid > 0)
      process.kill(pid, 0)
      ok(`a gripe that hangs for 30 s leaves the decline intact and the guard exits in ${run.ms.toFixed(0)} ms`)
    } finally {
      if (pid !== null) try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  },

  'state-untouched': () => {
    for (const [name, make] of Object.entries(SEATS)) {
      const { session } = make()
      const before = snapshot(state)
      exactDecline(guard(call(session)), `${name} seat`)
      assert.deepEqual(snapshot(state), before, `${name}: the decline changed the state directory`)
    }
    ok('a decline leaves every file in the state directory, and its bytes, as they were, for every seat state')
  },
}

try {
  for (const [name, run] of Object.entries(cases)) {
    console.log(name)
    await run()
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\nsmoke-elicitation: ALL PASS (${checks} checks, ${Object.keys(cases).length} cases)`)
