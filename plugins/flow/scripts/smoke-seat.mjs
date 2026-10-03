#!/usr/bin/env node
// Smoke for T3 seats: the seat store in lib/seat-store.mjs, the answer shapes the seat guard
// prints through hooks/scripts/wire.mjs, and the seat guard itself, run as a real hook process with
// a fixture call on stdin shaped like the calls Claude Code 2.1.288 and Codex 0.160.0 sent live.
// The state directory is a temp directory named by FLOW_DELEGATION_STATE_DIR, and the races run as
// separate node processes released together, so the write-once claims are tested against real
// concurrent link(2) calls, not a single event loop.
// Cases are grouped by prefix (store-*, wire-*, admit-*, bind-*, spawn-*, mcp-*, edit-*, bash-*,
// fastpath-*); the containment families run against a real temp git repository as the worktree.
// --case-prefix <p>
// runs only the cases whose name starts with p, and no match is a failure rather than a vacuous
// pass. fastpath-latency prints the measured p50 cost of the catch-all hook and asserts no bound.
// Run: node plugins/flow/scripts/smoke-seat.mjs [--case-prefix <p>]
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const STORE = join(PLUGIN, 'lib', 'seat-store.mjs')
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-smoke-seat-')))
const state = join(tmp, 'state')
process.env.FLOW_DELEGATION_STATE_DIR = state
const store = await import(pathToFileURL(STORE).href)
const wire = await import(pathToFileURL(join(PLUGIN, 'hooks', 'scripts', 'wire.mjs')).href)
const { RETENTION_MS } = await import(pathToFileURL(join(PLUGIN, 'lib', 'state-dir.mjs')).href)

const argv = process.argv.slice(2)
const prefixAt = argv.indexOf('--case-prefix')
const prefix = prefixAt >= 0 ? argv[prefixAt + 1] ?? '' : ''

let checks = 0
const ok = (line) => { checks++; console.log(`  ok: ${line}`) }
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const mode = (path) => statSync(path).mode & 0o777
const seats = join(state, 'seats')
const RECORD = (fields = {}) => ({
  v: 1, createdAt: new Date().toISOString(), access: 'read-only', repoRoot: '/r', worktree: '/r', reviewWorktree: null,
  baseSha: null, headSha: null, provider: 'claude', model: 'claude-opus-5-5', effort: 'high', runtimeMode: 'auto',
  canonicalSnapshot: null, hooksDigest: null, ...fields,
})
const SCHEMA = { type: 'object', required: ['x'], properties: { x: { type: 'string' } } }

// One racer: wait for the go file, then make one write-once claim and print whether it won.
const racer = join(tmp, 'racer.mjs')
writeFileSync(racer, `import { existsSync, writeFileSync } from 'node:fs'
const store = await import(process.env.SEAT_STORE_URL)
const [kind, id, session, ready, go, label] = process.argv.slice(2)
writeFileSync(ready, '')
const nap = new Int32Array(new SharedArrayBuffer(4))
while (!existsSync(go)) Atomics.wait(nap, 0, 0, 1)
const won = kind === 'stamp' ? store.stamp(id, 'bound', { sessionId: label }) : store.indexSession('claude', session, { id })
process.stdout.write(JSON.stringify({ won, label }))
`)
async function race(kind, id, session, count) {
  const round = mkdtempSync(join(tmp, 'race-'))
  const go = join(round, 'go')
  const runs = Array.from({ length: count }, (_, at) => {
    const child = spawn(process.execPath, [racer, kind, id, session, join(round, `ready-${at}`), go, `racer-${at}`],
      { env: { ...process.env, SEAT_STORE_URL: pathToFileURL(STORE).href }, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    return new Promise((resolve, reject) => child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`racer exit ${code}`)))))
  })
  for (const end = Date.now() + 15_000; readdirSync(round).filter((f) => f.startsWith('ready-')).length < count;) {
    if (Date.now() > end) throw new Error('racers never became ready')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  writeFileSync(go, '')
  return Promise.all(runs)
}

// The seat guard as the host runs it: one process per call, the call as JSON on stdin. It must
// exit 0 on every path; an answer is one JSON document on stdout, and an allow prints nothing.
const GUARD = join(PLUGIN, 'hooks', 'scripts', 'seat-guard.mjs')
function guard(mode, host, input, { env = {}, nodeArgs = [] } = {}) {
  const run = spawnSync(process.execPath, [...nodeArgs, GUARD, mode, host], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env },
  })
  assert.equal(run.status, 0, `seat-guard ${mode} ${host} exited ${run.status}: ${run.stderr}`)
  return { stdout: run.stdout, stderr: run.stderr, answer: run.stdout ? JSON.parse(run.stdout) : null }
}
const silent = (run, what) => assert.equal(run.stdout, '', `${what}: expected no answer, got ${run.stdout}`)
function denied(run, pattern, what) {
  assert.deepEqual(Object.keys(run.answer ?? {}), ['hookSpecificOutput'], `${what}: expected a deny, got ${run.stdout}`)
  const out = run.answer.hookSpecificOutput
  assert.deepEqual(Object.keys(out), ['hookEventName', 'permissionDecision', 'permissionDecisionReason'], what)
  assert.equal(out.hookEventName, 'PreToolUse', what)
  assert.equal(out.permissionDecision, 'deny', what)
  if (pattern) assert.match(out.permissionDecisionReason, pattern, what)
}
function blocked(run, pattern, what) {
  assert.deepEqual(run.answer, { decision: 'block', reason: run.answer?.reason }, `${what}: expected a prompt block, got ${run.stdout}`)
  assert.equal(typeof run.answer.reason, 'string', what)
  if (pattern) assert.match(run.answer.reason, pattern, what)
}
function context(run, what) {
  assert.deepEqual(Object.keys(run.answer ?? {}), ['hookSpecificOutput'], `${what}: expected context, got ${run.stdout}`)
  const out = run.answer.hookSpecificOutput
  assert.deepEqual(Object.keys(out), ['hookEventName', 'additionalContext'], what)
  assert.equal(out.hookEventName, 'UserPromptSubmit', what)
  return out.additionalContext
}

// Fixture calls, shaped like the ones the cp0 pin hook logged from live T3 children: Claude sends
// prompt_id and, on PreToolUse, effort; Codex sends turn_id and model. tool_input is an object.
const MODELS = { claude: 'claude-opus-5-5', codex: 'gpt-6-luna' }
const PERMISSION = { claude: 'auto', codex: 'default' }
const SPELLING = { claude: 'mcp__t3-code__delegate_task', codex: 'mcp__t3_code__delegate_task' }
const INSTANCE = { claude: 'claudeAgent', codex: 'codex' }
function call(host, session, fields) {
  const base = host === 'claude'
    ? { session_id: session, transcript_path: `/home/u/.claude/projects/-home-u-repo/${session}.jsonl`, cwd: '/home/u/repo', prompt_id: randomUUID(), permission_mode: PERMISSION.claude }
    : { session_id: session, turn_id: randomUUID(), transcript_path: `/home/u/.codex/sessions/2026/10/03/rollout-${session}.jsonl`, cwd: '/home/u/repo', model: MODELS.codex, permission_mode: PERMISSION.codex }
  return { ...base, ...fields }
}
const promptCall = (host, session, prompt, fields = {}) => call(host, session, { hook_event_name: 'UserPromptSubmit', prompt, ...fields })
const preCall = (host, session, toolName, toolInput, fields = {}) => call(host, session, {
  ...(host === 'claude' ? { effort: { level: 'medium' } } : {}),
  hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput,
  tool_use_id: host === 'claude' ? `toolu_${randomUUID().replaceAll('-', '')}` : `exec-${randomUUID()}`, ...fields,
})
// A delegate_task call for a record, as the delegate skill tells a parent to make it.
const delegateInput = (record, id, fields = {}) => ({
  task: `${store.seatTag(id)}\nWorktree: ${record.worktree}\nRead the diff and answer in the flow envelope.`,
  role: 'general', runtimeMode: record.runtimeMode,
  target: { providerInstanceId: INSTANCE[record.provider], model: record.model }, mode: 'async', ...fields,
})
const seatRecord = (provider, fields = {}) => RECORD({ provider, model: MODELS[provider], ...fields })
// A record the parent has opened and its gate has admitted, ready for the child to bind.
function admittedSeat(provider, fields = {}) {
  const record = seatRecord(provider, fields)
  const { id, digest } = store.writeRecord(record, SCHEMA)
  assert.equal(store.stamp(id, 'admitted', { toolUseId: 'toolu_parent' }), true)
  return { id, digest, record: { ...record, id }, tag: store.seatTag(id) }
}
// The containment cases share one real git repository as the seat's worktree; tmp is a realpath,
// so the worktree path is one too, as seat open records it.
const worktree = join(tmp, 'wt')
mkdirSync(worktree, { recursive: true })
assert.equal(spawnSync('git', ['init', '-q', worktree]).status, 0, 'git init')
const ACCESSES = ['read-only', 'workspace-write', 'review']
// A seat bound on host with the given access, its worktree the shared repository.
function boundSeat(host, access) {
  const { id, tag } = admittedSeat(host, { access, worktree, repoRoot: worktree })
  const session = randomUUID()
  context(guard('prompt', host, promptCall(host, session, tag)), `${host} ${access} bind`)
  return { id, session }
}
// One tool call in a bound seat. A cwd field given as undefined drops cwd from the call.
const seatCall = (host, session, name, input, fields = {}) => {
  const body = preCall(host, session, name, input, fields)
  if ('cwd' in fields && fields.cwd === undefined) delete body.cwd
  return guard('pre', host, body)
}
// One target as each edit tool names it: Claude's Edit, Write and NotebookEdit, and Codex's patch.
const editCalls = (target) => [
  ['Edit', { file_path: target, old_string: 'a', new_string: 'b' }],
  ['Write', { file_path: target, content: 'x' }],
  ['NotebookEdit', { notebook_path: target, new_source: 'x' }],
  ['apply_patch', { command: `*** Begin Patch\n*** Add File: ${target}\n+x\n*** End Patch` }],
]
const indexEntries = () => (existsSync(join(seats, 'by-session')) ? readdirSync(join(seats, 'by-session')).sort() : [])
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
}

const cases = {
  'wire-shapes': () => {
    assert.deepEqual(wire.promptContext('seat facts'), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'seat facts' } })
    assert.equal(JSON.stringify(wire.promptContext('a')), '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"a"}}')
    assert.deepEqual(wire.stopBlock('$.status: missing'), { decision: 'block', reason: '$.status: missing' })
    assert.equal(JSON.stringify(wire.stopBlock('r')), '{"decision":"block","reason":"r"}')
    assert.equal(JSON.stringify(wire.promptBlock('r')), '{"decision":"block","reason":"r"}')
    ok('promptContext, promptBlock and stopBlock print exactly the UserPromptSubmit context, UserPromptSubmit block and Stop block shapes, with no extra keys')
  },

  'store-tag': () => {
    const id = store.newId()
    assert.match(id, /^[0-9a-f]{32}$/)
    assert.notEqual(store.newId(), id)
    const tag = store.seatTag(id)
    assert.equal(tag, `<flow-seat id=${id}>`)
    assert.deepEqual(store.parseTag(tag), { id })
    assert.deepEqual(store.parseTag(`${tag}\nReview the diff.\nThen answer.`), { id })
    for (const bad of ['abc', id.toUpperCase(), `${id}0`, id.slice(1), `${id.slice(0, 31)}g`, '../../../../etc/passwd', '']) {
      assert.throws(() => store.seatTag(bad))
    }
    assert.throws(() => store.seatTag(undefined))
    ok('newId is 32 lowercase hex, seatTag refuses anything else, and the tag round-trips through parseTag with or without a body')

    const other = store.newId()
    const VOID = { void: 'tag-not-on-line-1' }
    assert.deepEqual(store.parseTag(`do the work\n${tag}`), VOID, 'a valid tag on line 2')
    assert.deepEqual(store.parseTag(`${tag}\nbody\n<flow-seat id=${other}>`), VOID, 'a second tag below a valid line 1')
    assert.deepEqual(store.parseTag(`please ${tag}\nbody`), VOID, 'line 1 holding more than the tag')
    assert.deepEqual(store.parseTag(`${tag} \nbody`), VOID, 'trailing space after the tag')
    assert.deepEqual(store.parseTag(`${tag}\r\nbody`), VOID, 'a CR ending line 1')
    assert.deepEqual(store.parseTag(`\n${tag}`), VOID, 'an empty line 1')
    ok('a well-formed tag anywhere but as the whole of line 1 voids the seat, including a valid line 1 with a second tag below it')

    for (const malformed of [
      `<flow-seat id=${id.toUpperCase()}>`, `<flow-seat id=${id.slice(1)}>`, `<flow-seat id=${id}0>`, `<flow-seat id="${id}">`,
      `<flow-seat id=${id} role=writer>`, `<flow-seat  id=${id}>`, '<flow-seat id=../x>', '<flow-seat >', `<flow-seat id=${id}`,
    ]) {
      assert.equal(store.parseTag(`${malformed}\nbody`), null, malformed)
      assert.equal(store.parseTag(`body\n${malformed}`), null, malformed)
    }
    for (const plain of ['', 'just a prompt', '<flow-seat', null, undefined, 42, { id }]) assert.equal(store.parseTag(plain), null)
    ok('a malformed id or extra attribute is not a tag on any line, and a non-string prompt or plain text is no seat')
  },

  'store-record': () => {
    const record = RECORD()
    const { id, digest } = store.writeRecord(record, SCHEMA)
    assert.match(id, /^[0-9a-f]{32}$/)
    const bytes = readFileSync(join(seats, id, 'record.json'))
    assert.equal(digest, sha256(bytes))
    const schemaBytes = readFileSync(join(seats, id, 'schema.json'))
    const read = store.readRecord(id)
    assert.deepEqual(read.record, { ...record, id, schemaSha256: sha256(schemaBytes) })
    assert.deepEqual(read.schema, SCHEMA)
    assert.equal(read.digest, digest)
    assert.equal(store.readRecord(id).digest, digest, 'a second read hashes the same bytes')
    assert.equal(store.seatDir(id), join(seats, id))
    ok('writeRecord stores the record with its id and schema digest, and readRecord returns it, the schema, and a stable sha256 of the record bytes')

    const chosen = store.newId()
    assert.deepEqual(store.writeRecord(RECORD({ id: chosen }), null).id, chosen)
    assert.equal(store.readRecord(chosen).schema, null)
    assert.equal(store.readRecord(chosen).record.schemaSha256, null)
    assert.equal(existsSync(join(seats, chosen, 'schema.json')), false)
    assert.throws(() => store.writeRecord(RECORD({ id: chosen }), SCHEMA), /EEXIST/)
    assert.equal(store.readRecord(chosen).schema, null, 'the refused rewrite changed the record')
    assert.throws(() => store.writeRecord(RECORD({ id: '../escape' }), null))
    ok('a record keeps a caller id, carries no schema when given none, and is never written twice')

    assert.equal(store.readRecord(store.newId()), null)
    for (const bad of ['../x', 'a/b', '', id.toUpperCase(), undefined]) {
      assert.equal(store.readRecord(bad), null)
      assert.equal(store.seatDir(bad), null)
    }
    const tampered = store.writeRecord(RECORD(), SCHEMA).id
    writeFileSync(join(seats, tampered, 'schema.json'), JSON.stringify({ type: 'object' }))
    assert.equal(store.readRecord(tampered), null, 'a schema that no longer matches schemaSha256')
    const corrupt = store.writeRecord(RECORD(), null).id
    writeFileSync(join(seats, corrupt, 'record.json'), '{"v":1,')
    assert.equal(store.readRecord(corrupt), null, 'an unparsable record')
    const renamed = store.writeRecord(RECORD(), null).id
    writeFileSync(join(seats, renamed, 'record.json'), JSON.stringify({ ...RECORD(), id: store.newId(), schemaSha256: null }))
    assert.equal(store.readRecord(renamed), null, 'a record naming another id')
    ok('readRecord is null for an unknown or invalid id, a changed schema snapshot, an unparsable record, and a record naming another id')
  },

  'store-stamp': () => {
    const { id } = store.writeRecord(RECORD(), null)
    assert.equal(store.readStamp(id, 'admitted'), null)
    assert.equal(store.stamp(id, 'admitted', { toolUseId: 'u1' }), true)
    const first = readFileSync(join(seats, id, 'admitted.json'), 'utf8')
    const admitted = store.readStamp(id, 'admitted')
    assert.equal(admitted.toolUseId, 'u1')
    assert.ok(Number.isFinite(Date.parse(admitted.at)))
    assert.equal(store.stamp(id, 'admitted', { toolUseId: 'u2' }), false)
    assert.equal(readFileSync(join(seats, id, 'admitted.json'), 'utf8'), first, 'the losing write changed the stamp')
    assert.equal(store.stamp(id, 'closed', { at: '2020-01-01T00:00:00.000Z', verdict: 'valid' }), true)
    assert.equal(store.readStamp(id, 'closed').at, '2020-01-01T00:00:00.000Z')
    assert.deepEqual(readdirSync(join(seats, id)).sort(), ['admitted.json', 'closed.json', 'record.json'], 'a temp file was left behind')
    ok('a stamp is written once with its time: a second write returns false and leaves the first content byte for byte, and a caller time wins')

    assert.equal(store.stamp(store.newId(), 'bound', {}), false, 'a stamp on a record that does not exist')
    assert.equal(store.stamp('../x', 'bound', {}), false)
    assert.throws(() => store.stamp(id, '../record', {}))
    assert.throws(() => store.readStamp(id, 'record'))
    ok('a stamp on a missing record or an invalid id is refused, and an unknown stamp name throws')
  },

  'store-race': async () => {
    for (let round = 0; round < 3; round++) {
      const { id } = store.writeRecord(RECORD(), null)
      const results = await race('stamp', id, 'unused', 6)
      const winners = results.filter((result) => result.won)
      assert.equal(winners.length, 1, JSON.stringify(results))
      assert.equal(store.readStamp(id, 'bound').sessionId, winners[0].label)
    }
    ok('six processes racing one stamp, three rounds: exactly one wins each time and the stamp holds its content')

    for (let round = 0; round < 3; round++) {
      const { id } = store.writeRecord(RECORD(), null)
      const session = `race-${round}-${store.newId()}`
      const results = await race('index', id, session, 6)
      assert.equal(results.filter((result) => result.won).length, 1, JSON.stringify(results))
      assert.deepEqual(store.readIndex('claude', session), { id })
    }
    assert.deepEqual(readdirSync(join(seats, 'by-session')).filter((f) => f.startsWith('.')), [], 'a racer left a temp file behind')
    ok('six processes racing one session index, three rounds: exactly one creates it')
  },

  'store-session': () => {
    const { id } = store.writeRecord(RECORD(), null)
    const tooLong = 'a'.repeat(129)
    const entries = () => (existsSync(join(seats, 'by-session')) ? readdirSync(join(seats, 'by-session')).sort() : [])
    const before = entries()
    for (const bad of ['../x', 'a/b', '', tooLong, 'a b', 'a\0b', '..\\x', undefined, 7]) {
      assert.equal(store.indexPath('claude', bad), null, String(bad))
      assert.equal(store.indexSession('claude', bad, { id }), false)
      assert.equal(store.voidSession('claude', bad, id, 'x'), false)
      assert.equal(store.readIndex('claude', bad), null)
    }
    for (const host of ['', 'other', 'claude\0', undefined]) assert.equal(store.indexPath(host, 's1'), null)
    assert.ok(store.indexPath('claude', 'a'.repeat(128)))
    assert.deepEqual(entries(), before, 'a refused session reached the filesystem')
    for (const dots of ['.', '..', '...']) assert.equal(store.indexPath('codex', dots), join(seats, 'by-session', `codex-${dots}`))
    ok('a session id outside [A-Za-z0-9._-]{1,128} or an unknown host is refused before it reaches a filename, and a dotted id stays one name below by-session')

    const session = '5d6d6ca0-12f6-4c6c-ab13-40be7c324794'
    const path = store.indexPath('codex', session)
    assert.equal(path, join(seats, 'by-session', `codex-${session}`))
    assert.notEqual(store.indexPath('claude', session), path, 'the host is part of the key')
    assert.equal(store.readIndex('codex', session), null)
    assert.equal(store.indexSession('codex', session, { id: '../x' }), false)
    assert.equal(store.indexSession('codex', session, { id }), true)
    assert.equal(store.indexSession('codex', session, { id: store.newId() }), false)
    assert.deepEqual(store.readIndex('codex', session), { id })
    assert.equal(store.readIndex('claude', session), null)
    ok('the session index lives at <host>-<session>, is created once, and reads back {id}')
  },

  'store-void': () => {
    const { id } = store.writeRecord(RECORD(), null)
    const session = 'void-bound'
    assert.equal(store.indexSession('claude', session, { id }), true)
    assert.equal(store.voidSession('claude', session, id, 'bound-lost-race'), true)
    assert.deepEqual(store.readIndex('claude', session), { id, void: 'bound-lost-race' })
    assert.equal(store.indexSession('claude', session, { id }), false, 'a void session was rebound')
    assert.equal(store.voidSession('claude', 'void-fresh', null, 'tag-not-on-line-1'), true)
    assert.deepEqual(store.readIndex('claude', 'void-fresh'), { id: null, void: 'tag-not-on-line-1' })
    assert.equal(store.voidSession('claude', 'void-bad', '../x', 'r'), false)
    ok('voidSession replaces a bound entry or creates one with no id, and a void session cannot be rebound')

    writeFileSync(store.indexPath('claude', 'corrupt'), '{"id":')
    assert.deepEqual(store.readIndex('claude', 'corrupt'), { id: null, void: 'index-unreadable' })
    writeFileSync(store.indexPath('claude', 'wrong-id'), JSON.stringify({ id: '../x' }))
    assert.deepEqual(store.readIndex('claude', 'wrong-id'), { id: null, void: 'index-unreadable' })
    ok('an index entry that exists but cannot be read reads as void, never as no seat')
  },

  'store-state-result': () => {
    const { id } = store.writeRecord(RECORD(), null)
    assert.equal(store.readState(id), null)
    const turn = { turn: 1, turnKey: 'p1', blocks: 0, outcome: 'blocked', errors: ['$.status: missing'], stops: 1 }
    store.writeState(id, turn)
    assert.deepEqual(store.readState(id), turn)
    store.writeState(id, { ...turn, blocks: 1 })
    assert.equal(store.readState(id).blocks, 1)
    assert.throws(() => store.writeState('../x', turn))
    assert.throws(() => store.writeState(store.newId(), turn), /ENOENT/)
    ok('turn state round-trips and is replaced whole, and a write for a bad or missing seat throws')

    const body = { envelope: { status: 'done', answer: { x: 'y' } }, servedModels: ['claude-opus-5-5'], at: new Date().toISOString() }
    const digest = store.writeResult(id, 1, body)
    const bytes = readFileSync(join(seats, id, 'result-1.json'))
    assert.equal(digest, sha256(bytes))
    assert.equal(readFileSync(join(seats, id, 'result-1.sha256'), 'utf8'), `${digest}\n`)
    assert.deepEqual(store.readResult(id, 1), { body, sha256: digest, intact: true })
    assert.equal(store.readResult(id, 2), null)
    for (const n of [0, -1, 1.5, '1']) {
      assert.equal(store.readResult(id, n), null)
      assert.throws(() => store.writeResult(id, n, body))
    }
    writeFileSync(join(seats, id, 'result-1.json'), JSON.stringify({ ...body, servedModels: ['other'] }))
    assert.equal(store.readResult(id, 1).intact, false, 'a changed result')
    store.writeResult(id, 3, body)
    rmSync(join(seats, id, 'result-3.sha256'))
    assert.equal(store.readResult(id, 3).intact, false, 'a result without its sha256')
    ok('writeResult returns the sha256 of the bytes it wrote and records it beside them; readResult reports a changed or unsealed result as not intact')
  },

  'store-prune': () => {
    // The cases above leave records behind; prune over a directory of only this case's records.
    rmSync(seats, { recursive: true, force: true })
    const now = Date.now()
    const old = new Date(now - RETENTION_MS - 60_000).toISOString()
    const recent = new Date(now - RETENTION_MS + 60_000).toISOString()
    const oldClosed = store.writeRecord(RECORD({ createdAt: old }), SCHEMA).id
    store.stamp(oldClosed, 'admitted', { at: old })
    store.stamp(oldClosed, 'closed', { at: old, verdict: 'valid' })
    store.indexSession('claude', 'old-closed', { id: oldClosed })
    store.voidSession('codex', 'old-closed-void', oldClosed, 'r')
    const recentClosed = store.writeRecord(RECORD({ createdAt: old }), null).id
    store.stamp(recentClosed, 'closed', { at: recent, verdict: 'valid' })
    store.indexSession('claude', 'recent-closed', { id: recentClosed })
    const admittedOpen = store.writeRecord(RECORD({ createdAt: old }), null).id
    store.stamp(admittedOpen, 'admitted', { at: old })
    store.stamp(admittedOpen, 'bound', { at: old, sessionId: 'admitted-open' })
    store.indexSession('claude', 'admitted-open', { id: admittedOpen })
    const badTime = store.writeRecord(RECORD({ createdAt: old }), null).id
    store.stamp(badTime, 'closed', { at: 'not a time' })
    store.voidSession('claude', 'no-id', null, 'tag-not-on-line-1')

    const { removed, retained } = store.pruneSeats(now)
    assert.deepEqual(removed, [oldClosed])
    assert.deepEqual(retained.sort(), [recentClosed, admittedOpen, badTime].sort())
    assert.equal(existsSync(join(seats, oldClosed)), false)
    assert.equal(store.readIndex('claude', 'old-closed'), null)
    assert.equal(store.readIndex('codex', 'old-closed-void'), null)
    assert.deepEqual(store.readIndex('claude', 'recent-closed'), { id: recentClosed })
    assert.deepEqual(store.readIndex('claude', 'admitted-open'), { id: admittedOpen })
    assert.deepEqual(store.readIndex('claude', 'no-id'), { id: null, void: 'tag-not-on-line-1' })
    assert.ok(store.readRecord(admittedOpen))
    assert.deepEqual(store.pruneSeats(now), { removed: [], retained: retained })
    ok('pruneSeats removes only a record closed longer ago than RETENTION_MS, with its index entries, and keeps a recent close, an admitted record never closed however old, and an unreadable close time')
  },

  'store-modes': () => {
    const { id } = store.writeRecord(RECORD(), SCHEMA)
    store.stamp(id, 'admitted', {})
    store.indexSession('claude', 'modes', { id })
    store.voidSession('codex', 'modes', id, 'r')
    store.writeState(id, { turn: 1 })
    store.writeResult(id, 1, { at: 'x' })
    for (const dir of [seats, join(seats, id), join(seats, 'by-session')]) assert.equal(mode(dir), 0o700, dir)
    for (const file of ['record.json', 'schema.json', 'admitted.json', 'state.json', 'result-1.json', 'result-1.sha256']) {
      assert.equal(mode(join(seats, id, file)), 0o600, file)
    }
    assert.equal(mode(store.indexPath('claude', 'modes')), 0o600)
    assert.equal(mode(store.indexPath('codex', 'modes')), 0o600)
    ok('every seat directory is 0700 and every record, stamp, state, result and index file is 0600')
  },
  'admit-tagged': () => {
    const before = indexEntries()
    for (const host of ['claude', 'codex']) {
      for (const spelling of Object.values(SPELLING)) {
        for (const provider of ['claude', 'codex']) {
          const record = seatRecord(provider)
          const { id } = store.writeRecord(record, SCHEMA)
          const parent = randomUUID()
          const first = preCall(host, parent, spelling, delegateInput(record, id))
          silent(guard('pre', host, first), `${host} ${spelling} ${provider}`)
          assert.equal(store.readStamp(id, 'admitted').toolUseId, first.tool_use_id)
          denied(guard('pre', host, preCall(host, parent, spelling, delegateInput(record, id))), /already admitted/, 'a second admission')
          assert.equal(store.readStamp(id, 'admitted').toolUseId, first.tool_use_id, 'the refused admission changed the stamp')
        }
      }
    }
    assert.deepEqual(indexEntries(), before, 'admission indexed the parent session as a seat')
    ok('a tagged delegate_task matching its record is admitted once, under both T3 spellings, on both hosts, for both providers; a second admission is denied')
  },

  'admit-runtime-mode': () => {
    const record = seatRecord('claude')
    const { id } = store.writeRecord(record, SCHEMA)
    for (const host of ['claude', 'codex']) {
      for (const runtimeMode of [undefined, null, 'inherit']) {
        const tagged = delegateInput(record, id, { runtimeMode })
        const untagged = { ...tagged, task: 'Summarise the README.' }
        if (runtimeMode === undefined) { delete tagged.runtimeMode; delete untagged.runtimeMode }
        denied(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], tagged)), /names runtimeMode/, `tagged ${runtimeMode}`)
        denied(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], untagged)), /names runtimeMode/, `untagged ${runtimeMode}`)
      }
    }
    assert.equal(store.readStamp(id, 'admitted'), null, 'a refused call admitted the record')
    ok('a delegate_task call whose runtimeMode is missing, null or inherit is denied on both hosts, tagged or not, and admits nothing')

    const before = readdirSync(seats).sort()
    for (const host of ['claude', 'codex']) {
      for (const runtimeMode of ['auto', 'full-access']) {
        const plain = { task: 'Summarise the README.', role: 'general', runtimeMode, target: { providerInstanceId: 'codex', model: MODELS.codex } }
        silent(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], plain)), `untagged ${runtimeMode}`)
      }
    }
    assert.deepEqual(readdirSync(seats).sort(), before, 'an untagged call wrote seat state')
    ok('an untagged delegate_task call naming its runtimeMode is allowed and writes nothing')
  },

  'admit-mismatch': () => {
    const record = seatRecord('claude')
    const { id } = store.writeRecord(record, SCHEMA)
    const host = 'claude'
    const variants = [
      [{ target: { providerInstanceId: 'codex', model: record.model } }, /provider must be "claude"/],
      [{ target: { providerInstanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } }, /model must be "claude-opus-5-5"/],
      [{ runtimeMode: 'full-access' }, /runtimeMode must be "auto"/],
      [{ runtimeMode: 'full-access', target: { providerInstanceId: 'codex', model: MODELS.codex } }, /runtimeMode must be "auto"; provider must be "claude"; model must be/],
      [{ role: 'reviewer' }, /role "general"/],
      [{ role: undefined }, /role "general"/],
      [{ target: { providerInstanceId: 'openai', model: record.model } }, /neither claudeAgent nor codex/],
    ]
    for (const [fields, pattern] of variants) {
      denied(guard('pre', host, preCall(host, randomUUID(), SPELLING.claude, delegateInput(record, id, fields))), pattern, JSON.stringify(fields))
      assert.equal(store.readStamp(id, 'admitted'), null, `${JSON.stringify(fields)} admitted the record`)
    }
    silent(guard('pre', host, preCall(host, randomUUID(), SPELLING.claude, delegateInput(record, id))), 'the matching call after the refusals')
    assert.ok(store.readStamp(id, 'admitted'))
    ok('a tagged call whose provider, model, runtimeMode or role differs from the record is denied and admits nothing; the matching call is still admitted after')
  },

  'admit-tag-line': () => {
    const record = seatRecord('codex')
    const { id } = store.writeRecord(record, SCHEMA)
    const tag = store.seatTag(id)
    for (const task of [`Do the work.\n${tag}`, `please ${tag}\nDo the work.`, `${tag} \nDo the work.`, `${tag}\nbody\n${tag}`]) {
      for (const host of ['claude', 'codex']) {
        denied(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], delegateInput(record, id, { task }))), /not as the whole of line 1/, JSON.stringify(task))
      }
    }
    assert.equal(store.readStamp(id, 'admitted'), null)
    ok('a seat tag anywhere but alone on line 1 is denied on both hosts and admits nothing')
  },

  'admit-unreadable': () => {
    const record = seatRecord('claude')
    const { id } = store.writeRecord(record, SCHEMA)
    const good = delegateInput(record, id)
    const variants = [
      ['tool_input a JSON string', JSON.stringify(good), /could not be read/],
      ['tool_input null', null, /could not be read/],
      ['tool_input an array', [good], /could not be read/],
      ['tool_input missing', undefined, /could not be read/],
      ['runtimeMode a number', { ...good, runtimeMode: 1 }, /runtimeMode is not a string/],
      ['task missing', { ...good, task: undefined }, /task is not a string/],
      ['task an array', { ...good, task: [good.task] }, /task is not a string/],
      ['target missing', { ...good, target: undefined }, /target.providerInstanceId or target.model could not be read/],
      ['target a string', { ...good, target: 'claudeAgent' }, /could not be read/],
      ['providerInstanceId a number', { ...good, target: { providerInstanceId: 1, model: record.model } }, /could not be read/],
      ['model missing', { ...good, target: { providerInstanceId: 'claudeAgent' } }, /could not be read/],
      ['no record for the tag', { ...good, task: `${store.seatTag(store.newId())}\nwork` }, /no readable seat record/],
    ]
    for (const host of ['claude', 'codex']) {
      for (const [what, toolInput, pattern] of variants) {
        const input = preCall(host, randomUUID(), SPELLING[host], toolInput)
        if (toolInput === undefined) delete input.tool_input
        denied(guard('pre', host, input), pattern, `${host}: ${what}`)
      }
    }
    assert.equal(store.readStamp(id, 'admitted'), null)
    ok('a delegate_task call with an unreadable tool_input, runtimeMode, task or target, or a tag naming no record, is denied on both hosts')
  },

  'admit-race': async () => {
    const record = seatRecord('claude')
    const { id } = store.writeRecord(record, SCHEMA)
    const runs = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [GUARD, 'pre', 'claude'], { stdio: ['pipe', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.on('data', (chunk) => { out += chunk })
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`seat-guard exit ${code}`))))
      child.stdin.end(JSON.stringify(preCall('claude', randomUUID(), SPELLING.claude, delegateInput(record, id))))
    }))
    const outs = await Promise.all(runs)
    assert.equal(outs.filter((out) => out === '').length, 1, JSON.stringify(outs))
    for (const out of outs.filter(Boolean)) assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /admitted/)
    ok('six concurrent admissions of one record: exactly one is allowed and the rest are denied')
  },

  'bind-happy': () => {
    for (const host of ['claude', 'codex']) {
      const { id, digest, tag } = admittedSeat(host)
      const session = randomUUID()
      const prompt = promptCall(host, session, `${tag}\nWorktree: /r\nRead the diff.`)
      const text = context(guard('prompt', host, prompt), `${host} bind`)
      assert.ok(text.startsWith('The orchestrator half of the flow charter does not apply in this session'), text)
      assert.match(text, new RegExp(`Seat ${id}:`))
      assert.match(text, /"status": "done" \| "partial" \| "blocked"/)
      assert.match(text, /"checksRun": \[\]/)
      assert.ok(!text.includes('<flow-charter'), 'the bind re-sent the charter')
      assert.deepEqual(store.readIndex(host, session), { id })
      const bound = store.readStamp(id, 'bound')
      assert.deepEqual({ ...bound, at: undefined }, {
        at: undefined, sessionId: session, host, permissionMode: PERMISSION[host], cwd: '/home/u/repo', recordDigest: digest,
        ...(host === 'codex' ? { model: MODELS.codex } : {}),
      })
      assert.equal(store.readStamp(id, 'void'), null)

      assert.equal(store.readStamp(id, 'receipt'), null)
      silent(guard('pre', host, preCall(host, session, 'Bash', { command: 'pwd' })), `${host} first seat call`)
      const receipt = store.readStamp(id, 'receipt')
      assert.equal(receipt.tool, 'Bash')
      silent(guard('pre', host, preCall(host, session, 'Read', { file_path: '/r/README.md' })), `${host} second seat call`)
      assert.deepEqual(store.readStamp(id, 'receipt'), receipt, 'a later call rewrote the receipt')
    }
    ok(`a tagged first prompt binds on Claude (permission_mode ${PERMISSION.claude}) and Codex (${PERMISSION.codex}): index and bound stamp written, the override and envelope injected, and the first seat call stamps the receipt once`)

    const writer = admittedSeat('claude', { access: 'workspace-write', worktree: '/r/.flow-worktrees/w' })
    const writerText = context(guard('prompt', 'claude', promptCall('claude', randomUUID(), writer.tag)), 'writer bind')
    assert.ok(writerText.includes('git -C /r/.flow-worktrees/w commit -- <paths>'), writerText)
    assert.match(writerText, /"commits": \[\{"sha": "", "subject": ""\}\]/)
    const review = admittedSeat('codex', { access: 'review', worktree: '/r/.flow-worktrees/review-x', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) })
    const reviewText = context(guard('prompt', 'codex', promptCall('codex', randomUUID(), review.tag)), 'review bind')
    assert.ok(reviewText.includes(`base ${'a'.repeat(40)}, head ${'b'.repeat(40)}`), reviewText)
    assert.ok(!reviewText.includes('commits'), 'a review was told to report commits')
    ok('a writer seat is told its worktree, the git -C commit form and the commits field; a review seat its base and head')
  },

  'bind-not-admitted': () => {
    for (const host of ['claude', 'codex']) {
      const { id } = store.writeRecord(seatRecord(host), SCHEMA)
      const session = randomUUID()
      const text = context(guard('prompt', host, promptCall(host, session, `${store.seatTag(id)}\nwork`)), `${host} unadmitted`)
      assert.match(text, /void seat/)
      assert.match(text, /not-admitted/)
      assert.deepEqual(store.readIndex(host, session), { id, void: 'not-admitted' })
      assert.equal(store.readStamp(id, 'void').reason, 'not-admitted')
      assert.equal(store.readStamp(id, 'bound'), null)
      denied(guard('pre', host, preCall(host, session, 'Bash', { command: 'pwd' })), /void seat \(not-admitted\)/, `${host} void seat call`)
      denied(guard('pre', host, preCall(host, session, 'Read', { file_path: '/r/a' })), /void seat/, `${host} void seat read`)
      assert.equal(store.readStamp(id, 'receipt'), null, 'a void seat stamped a receipt')
    }
    ok('a tag whose record was never admitted voids the session on both hosts: void index and stamp, no bound stamp, and every tool call denied')
  },

  'bind-replay': () => {
    for (const host of ['claude', 'codex']) {
      const { id, tag } = admittedSeat(host)
      const first = randomUUID()
      const second = randomUUID()
      context(guard('prompt', host, promptCall(host, first, tag)), 'first bind')
      const text = context(guard('prompt', host, promptCall(host, second, tag)), 'replay')
      assert.match(text, /void seat/)
      assert.deepEqual(store.readIndex(host, second), { id, void: 'already-bound' })
      assert.deepEqual(store.readIndex(host, first), { id })
      assert.equal(store.readStamp(id, 'bound').sessionId, first)
      assert.equal(store.readStamp(id, 'void'), null, 'the replay voided the record the first session holds')
      denied(guard('pre', host, preCall(host, second, 'Bash', { command: 'pwd' })), /void seat/, 'the replayed session')
      silent(guard('pre', host, preCall(host, first, 'Bash', { command: 'pwd' })), 'the bound session')
    }
    ok('a seat tag replayed in a second session voids that session alone: the first binding stays in place and the record carries no void stamp, on both hosts')
  },

  'bind-invalid-session': () => {
    for (const host of ['claude', 'codex']) {
      for (const session of ['../../etc/passwd', 'a b', '', 'x'.repeat(129), undefined, 42]) {
        const { id, tag } = admittedSeat(host)
        const before = indexEntries()
        const input = promptCall(host, session, tag)
        if (session === undefined) delete input.session_id
        blocked(guard('prompt', host, input), /could not be recorded for this session \(session-id-invalid\)/, `${host} session ${JSON.stringify(session)}`)
        assert.deepEqual(indexEntries(), before, 'an invalid session id reached the index')
        assert.equal(store.readStamp(id, 'void').reason, 'session-id-invalid')
        assert.equal(store.readStamp(id, 'bound'), null)
      }
    }
    ok('a session id that fails validation refuses the prompt, since no index can hold the session, voids the record and writes no index entry, on both hosts')
  },

  'bind-permission-mode': () => {
    const refused = { claude: ['bypassPermissions', 'default', 'plan', 'acceptEdits', 'AUTO', undefined, 1], codex: ['bypassPermissions', 'auto', 'dangerFullAccess', undefined] }
    for (const [host, modes] of Object.entries(refused)) {
      for (const permissionMode of modes) {
        const { id, tag } = admittedSeat(host)
        const session = randomUUID()
        const input = promptCall(host, session, tag, { permission_mode: permissionMode })
        if (permissionMode === undefined) delete input.permission_mode
        assert.match(context(guard('prompt', host, input), `${host} ${permissionMode}`), /permission-mode-not-allowed/)
        assert.deepEqual(store.readIndex(host, session), { id, void: 'permission-mode-not-allowed' })
        assert.equal(store.readStamp(id, 'bound'), null)
      }
    }
    ok('a permission_mode outside the host\'s set (Claude auto, Codex default) voids the seat: bypassPermissions, another mode, a wrong case, or none')
  },

  'bind-tag-line': () => {
    for (const host of ['claude', 'codex']) {
      const { id, tag } = admittedSeat(host)
      const session = randomUUID()
      const text = context(guard('prompt', host, promptCall(host, session, `Please do this.\n${tag}`)), `${host} tag below line 1`)
      assert.match(text, /tag-not-on-line-1/)
      assert.deepEqual(store.readIndex(host, session), { id: null, void: 'tag-not-on-line-1' })
      assert.equal(store.readStamp(id, 'bound'), null)
      denied(guard('pre', host, preCall(host, session, 'Bash', { command: 'pwd' })), /void seat/, 'the voided session')
    }
    ok('a seat tag below line 1 voids the session with no record named, and every tool call is denied')
  },

  'bind-record-faults': () => {
    for (const host of ['claude', 'codex']) {
      const missing = store.newId()
      const session = randomUUID()
      assert.match(context(guard('prompt', host, promptCall(host, session, store.seatTag(missing))), 'no record'), /record-missing/)
      assert.deepEqual(store.readIndex(host, session), { id: missing, void: 'record-missing' })
      assert.equal(existsSync(join(seats, missing)), false, 'a void stamp created a record directory')
    }
    const other = admittedSeat('codex')
    const session = randomUUID()
    assert.match(context(guard('prompt', 'claude', promptCall('claude', session, other.tag)), 'host mismatch'), /host-mismatch/)
    assert.deepEqual(store.readIndex('claude', session), { id: other.id, void: 'host-mismatch' })
    ok('a tag naming no record voids the session without creating one, and a Codex record bound from a Claude session is void')

    for (const host of ['claude', 'codex']) {
      const { id, tag } = admittedSeat(host)
      const bound = randomUUID()
      context(guard('prompt', host, promptCall(host, bound, tag)), 'bind')
      for (const [what, input] of [
        ['tool_input a string', preCall(host, bound, 'Bash', JSON.stringify({ command: 'pwd' }))],
        ['tool_input null', preCall(host, bound, 'Bash', null)],
        ['tool_name missing', preCall(host, bound, undefined, { command: 'pwd' })],
      ]) denied(guard('pre', host, input), /could not be read/, `${host}: ${what}`)
      assert.equal(store.readStamp(id, 'receipt'), null, 'an unreadable call stamped the receipt')
      writeFileSync(join(seats, id, 'record.json'), '{"v":1,')
      denied(guard('pre', host, preCall(host, bound, 'Bash', { command: 'pwd' })), /missing or corrupt/, `${host}: corrupt record`)
      rmSync(join(seats, id), { recursive: true, force: true })
      denied(guard('pre', host, preCall(host, bound, 'Read', { file_path: '/r/a' })), /missing or corrupt/, `${host}: removed record`)
    }
    ok('in a bound seat, an unreadable tool call and a missing or corrupt record are denied on both hosts, before any receipt')
  },

  'bind-unindexed': () => {
    for (const host of ['claude', 'codex']) {
      const { id, tag } = admittedSeat(host)
      const byId = join(seats, 'by-session')
      mkdirSync(byId, { recursive: true })
      chmodSync(byId, 0o500)
      let run
      try { run = guard('prompt', host, promptCall(host, randomUUID(), tag)) } finally { chmodSync(byId, 0o700) }
      blocked(run, /could not be recorded for this session \(bind-failed\)/, `${host} unwritable index`)
      assert.equal(store.readStamp(id, 'bound'), null)
      assert.equal(store.readStamp(id, 'void').reason, 'bind-failed')

      const voided = randomUUID()
      context(guard('prompt', host, promptCall(host, voided, tag)), `${host} the record, retried`)
      assert.deepEqual(store.readIndex(host, voided), { id, void: 'record-void' })
      denied(guard('pre', host, preCall(host, voided, 'Read', { file_path: '/r/a' })), /void seat \(record-void\)/, `${host} a session holding a void index`)
    }
    ok('a tagged prompt whose session index cannot be written is refused rather than run with no seat, on both hosts; a session that holds a void index has every call denied')
  },

  'bind-record-void': () => {
    for (const host of ['claude', 'codex']) {
      const { id, tag } = admittedSeat(host)
      const first = randomUUID()
      assert.match(context(guard('prompt', host, promptCall(host, first, tag, { permission_mode: 'bypassPermissions' })), 'bad mode'), /permission-mode-not-allowed/)
      assert.equal(store.readStamp(id, 'void').reason, 'permission-mode-not-allowed')
      const fresh = randomUUID()
      const text = context(guard('prompt', host, promptCall(host, fresh, tag)), `${host} replay with an allowed mode`)
      assert.match(text, /void seat/)
      assert.match(text, /record-void/)
      assert.deepEqual(store.readIndex(host, fresh), { id, void: 'record-void' })
      assert.equal(store.readStamp(id, 'bound'), null, 'a voided record was bound')
      assert.equal(store.readStamp(id, 'void').reason, 'permission-mode-not-allowed', 'the replay rewrote the void stamp')
    }
    ok('a record voided by a failed first bind stays void: its tag replayed in a fresh session with an allowed mode binds nothing, on both hosts')
  },

  'spawn-names': () => {
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { session } = boundSeat(host, access)
        for (const name of ['Agent', 'Task', 'Workflow', 'collaborationspawn_agent', 'spawn_agent', 'collaborationsend_input']) {
          denied(seatCall(host, session, name, { prompt: 'do it' }), /\(no spawns\)/, `${host} ${access} ${name}`)
        }
        for (const name of ['Read', 'Grep', 'ToolSearch', 'TaskOutput']) silent(seatCall(host, session, name, { file_path: '/r/a' }), `${host} ${access} ${name}`)
      }
    }
    ok('Agent, Task, Workflow, any *spawn_agent and any collaboration* tool are denied in every seat on both hosts, and Read, Grep, ToolSearch and TaskOutput are not')
  },

  'mcp-allowlist': () => {
    const refused = [
      'mcp__t3-code__delegate_task', 'mcp__t3_code__delegate_task', 'mcp__t3_code__orchestrator_capabilities',
      'mcp__plugin_flow_flow_delegate__delegate_to_codex', 'mcp__plugin_flow_flow_delegate__delegate_to_claude',
      'mcp__flow_delegate__delegate_to_claude', 'mcp__flow_delegate__delegate_to_codex', 'mcp__new__thing',
      'mcp__claude_ai_Context7__query-docs-extra',
    ]
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { session } = boundSeat(host, access)
        for (const name of refused) denied(seatCall(host, session, name, {}), /\(MCP allowlist\)/, `${host} ${access} ${name}`)
        for (const name of ['mcp__claude_ai_Context7__query-docs', 'mcp__claude_ai_Context7__resolve-library-id']) {
          silent(seatCall(host, session, name, { libraryName: 'node' }), `${host} ${access} ${name}`)
        }
      }
    }
    ok('every MCP tool is denied in every seat on both hosts, T3\'s delegate_task under both spellings and flow_delegate under both included, except Context7\'s query-docs and resolve-library-id')

    const record = seatRecord('claude')
    const { id } = store.writeRecord(record, SCHEMA)
    const { session } = boundSeat('claude', 'workspace-write')
    denied(seatCall('claude', session, SPELLING.claude, delegateInput(record, id)), /\(MCP allowlist\)/, 'a seat delegating')
    assert.equal(store.readStamp(id, 'admitted'), null, 'a seat\'s delegate_task admitted a record')
    ok('a seat\'s own delegate_task for an admissible record is denied and admits nothing')
  },

  'edit-not-writer': () => {
    for (const host of ['claude', 'codex']) {
      for (const access of ['read-only', 'review']) {
        const { session } = boundSeat(host, access)
        for (const [name, input] of editCalls(join(worktree, 'a.txt'))) {
          denied(seatCall(host, session, name, input, { cwd: worktree }), new RegExp(`\\(no edits\\): this ${access} seat`), `${host} ${access} ${name}`)
        }
      }
    }
    ok('a read-only or review seat is denied Edit, Write, NotebookEdit and apply_patch inside its own worktree, on both hosts')
  },

  'edit-writer': () => {
    const outside = mkdtempSync(join(tmp, 'outside-'))
    const sibling = `${worktree}-x`
    mkdirSync(sibling, { recursive: true })
    mkdirSync(join(worktree, 'src'), { recursive: true })
    symlinkSync(outside, join(worktree, 'escape'))
    symlinkSync(join(outside, 'not-yet'), join(worktree, 'dangling'))
    symlinkSync(join(worktree, 'src'), join(worktree, 'inner'))
    for (const host of ['claude', 'codex']) {
      const { session } = boundSeat(host, 'workspace-write')
      const allowed = [
        join(worktree, 'a.txt'), join(worktree, 'src', 'new', 'deep.txt'), join(worktree, 'inner', 'b.txt'),
        `${worktree}/src/../c.txt`, join(worktree, 'src', '.gitignore'),
      ]
      for (const target of allowed) {
        for (const [name, input] of editCalls(target)) silent(seatCall(host, session, name, input, { cwd: worktree }), `${host} ${name} ${target}`)
      }
      const outsideTargets = [
        join(sibling, 'a.txt'), join(worktree, 'escape', 'x.txt'), `${worktree}/escape/../x.txt`, join(worktree, 'dangling'),
        `${worktree}/missing/../../x.txt`, `${worktree}/missing/../escape/x.txt`, join(outside, 'a.txt'), '/etc/passwd',
      ]
      for (const target of outsideTargets) {
        for (const [name, input] of editCalls(target)) {
          denied(seatCall(host, session, name, input, { cwd: worktree }), /\(edits inside the worktree\)/, `${host} ${name} ${target}`)
        }
      }
      for (const target of [join(worktree, '.git', 'config'), join(worktree, '.git'), join(worktree, 'src', '.git', 'x'), `${worktree}/inner/../.git/HEAD`]) {
        for (const [name, input] of editCalls(target)) denied(seatCall(host, session, name, input, { cwd: worktree }), /\(no \.git edits\)/, `${host} ${name} ${target}`)
      }
    }
    ok('a writer seat edits inside its worktree, through an inner symlink or a not-yet-made directory, and is denied a sibling with the worktree as its prefix, a symlink or dangling symlink out, a `..` past a missing directory, and any .git segment')
  },

  'edit-patch': () => {
    const { session } = boundSeat('codex', 'workspace-write')
    const patch = (...lines) => ({ command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') })
    silent(seatCall('codex', session, 'apply_patch', patch('*** Add File: rel/a.txt', '+x'), { cwd: worktree }), 'a relative target inside')
    silent(seatCall('codex', session, 'apply_patch', patch('*** Update File: b.txt', '@@', '-a', '+b', '*** Move to: c.txt'), { cwd: join(worktree, 'src') }), 'a move inside')
    denied(seatCall('codex', session, 'apply_patch', patch('*** Add File: rel/a.txt', '+x'), { cwd: tmp }), /\(edits inside the worktree\)/, 'a relative target from a cwd outside')
    denied(seatCall('codex', session, 'apply_patch', patch('*** Add File: a.txt', '+x', '*** Add File: ../outside.txt', '+y'), { cwd: worktree }), /\(edits inside the worktree\)/, 'a second target outside')
    denied(seatCall('codex', session, 'apply_patch', patch('*** Update File: a.txt', '*** Move to: ../moved.txt'), { cwd: worktree }), /\(edits inside the worktree\)/, 'a move outside')
    denied(seatCall('codex', session, 'apply_patch', patch('*** Add File: rel/a.txt', '+x'), { cwd: undefined }), /\(edits inside the worktree\)/, 'a relative target with no cwd')
    for (const [what, input] of [
      ['an unlisted directive', patch('*** Rename File: a.txt', '*** Add File: b.txt', '+x')],
      ['no End Patch', { command: '*** Begin Patch\n*** Add File: a.txt\n+x' }],
      ['no target', patch()],
      ['no command', {}],
      ['a command that is not a string', { command: ['*** Begin Patch'] }],
      ['a benign file_path beside an unreadable patch', { file_path: join(worktree, 'a.txt'), command: '*** Begin Patch\n*** Add File: ../x' }],
      ['an empty file_path', { file_path: '' }],
    ]) denied(seatCall('codex', session, 'apply_patch', input, { cwd: worktree }), /\(edit targets\)/, what)
    denied(seatCall('codex', session, 'Write', { file_path: join(worktree, 'a.txt'), command: patch('*** Add File: ../x.txt', '+x').command }, { cwd: worktree }), /\(edits inside the worktree\)/, 'a patch riding beside a benign file_path')
    ok('a Codex writer\'s apply_patch resolves relative targets against the hook\'s cwd, allows targets and moves inside, and is denied any target outside or an envelope whose targets cannot all be read')
  },

  'bash-every-seat': () => {
    const refused = [
      ['git push', /\(no git push\)/], ['git push origin HEAD', /\(no git push\)/], [`git -C ${worktree} push`, /\(no git push\)/],
      ['cd /r && git push --force-with-lease', /\(no git push\)/], ['bash -c "git push"', /\(no git push\)/], ['echo $(git push)', /\(no git push\)/],
      ['/usr/bin/git -c x=y push', /\(no git push\)/], ['git "push"', /\(git\)/],
      ['gh pr create --title t --body b', /\(no gh mutations\)/], [['gh -R o/r pr', 'merge 3'].join(' '), /\(no gh mutations\)/], ['gh issue comment 4 --body x', /\(no gh mutations\)/],
      ['gh release create v1', /\(no gh mutations\)/], ['gh repo delete o/r --yes', /\(no gh mutations\)/],
      ['gh api -X POST repos/o/r/issues', /\(no gh mutations\)/], ['gh api --method=PATCH repos/o/r', /\(no gh mutations\)/], ['gh api -XDELETE repos/o/r', /\(no gh mutations\)/],
      ['gh api repos/o/r/issues -f title=x', /\(no gh mutations\)/], ['gh api graphql -F n=1', /\(no gh mutations\)/], ['gh api repos/o/r --input body.json', /\(no gh mutations\)/],
      ['gh api repos/o/r --raw-field=a=b', /\(no gh mutations\)/], ['gh api -X "POST" repos/o/r', /\(no gh mutations\)/],
      ['codex exec "fix it"', /\(no model through the shell\)/], ['claude -p "hi"', /\(no model through the shell\)/], ['flow-delegate --help', /\(no model through the shell\)/],
      ['/home/u/.local/bin/flow-delegate run', /\(no model through the shell\)/], ['npx codex', /\(no model through the shell\)/], ['sh -c \'claude -p x\'', /\(no model through the shell\)/],
    ]
    const allowed = [
      'echo "git push"', 'echo \'codex exec\'', 'printf "%s" "gh pr create"', 'cat <<\'E\'\ngit push\ngh pr create\nE', 'git status', 'git log --oneline -5', 'git diff HEAD~1',
      'gh pr view 3', 'gh pr list --search "create"', 'gh api repos/o/r/pulls', 'gh api -X GET repos/o/r', 'gh api --method get repos/o/r', 'ls -la', 'node --version',
    ]
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { session } = boundSeat(host, access)
        for (const [command, pattern] of refused) denied(seatCall(host, session, 'Bash', { command }), pattern, `${host} ${access} ${command}`)
        for (const command of allowed) silent(seatCall(host, session, 'Bash', { command }), `${host} ${access} ${command}`)
        denied(seatCall(host, session, 'Bash', { command: 7 }), /\(shell\)/, `${host} ${access} an unreadable command`)
      }
    }
    ok('every seat on both hosts is denied git push, gh mutations including gh api with a non-GET method or a field, and the claude, codex and flow-delegate commands; prose naming them in quotes or a heredoc, and plain reads, are allowed')
  },

  'bash-not-writer': () => {
    const refused = [
      'git commit -m x -- a.txt', `git -C ${worktree} commit -m x -- a.txt`, 'git add a.txt', 'git checkout main', 'git switch -c x', 'git restore a.txt',
      'git reset --hard', 'git branch -D x', 'git branch --move a b', 'git branch -df x', 'git stash', 'git tag v1', 'git fetch', 'git pull',
      'git config user.name x', 'git config set user.name x', 'git config --unset user.name', 'git worktree add ../x', 'git update-ref refs/heads/x HEAD', 'git clean -n',
    ]
    const allowed = ['git status', 'git log', 'git diff', 'git show HEAD', 'git branch', 'git branch -a', 'git config --get user.name', 'git config user.name', 'git config --list', 'git -C /r rev-parse HEAD']
    for (const host of ['claude', 'codex']) {
      for (const access of ['read-only', 'review']) {
        const { session } = boundSeat(host, access)
        for (const command of refused) denied(seatCall(host, session, 'Bash', { command }), new RegExp(`\\(no git writes\\): .* this ${access} seat writes nothing`), `${host} ${access} ${command}`)
        for (const command of allowed) silent(seatCall(host, session, 'Bash', { command }), `${host} ${access} ${command}`)
      }
    }
    ok('a read-only or review seat is denied every listed git write, -C or not, and allowed git status, log, diff, show, a branch listing and a config read')
  },

  'bash-writer': () => {
    const escaped = worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const form = (sub) => new RegExp(`\\(git -C the worktree\\): a git write in this seat runs only as \`git -C ${escaped} ${sub}`)
    const commitForm = form('commit -m <message> -- <paths>`')
    const refused = [
      ['git commit -m x', commitForm],
      ['git commit -m x -- a.txt', commitForm],
      [`cd ${worktree} && git add a.txt`, form('add \\.\\.\\.`')],
      [`git -C ${worktree}/ add a.txt`, form('add')], [`git -C ${worktree}-x add a.txt`, form('add')], [`git -C "${worktree}" add a.txt`, form('add')],
      [`git -C ${worktree} --git-dir=/x commit -m x -- a.txt`, commitForm], [`git -C ${worktree} --work-tree /x add a.txt`, form('add')],
      [`git -C ${worktree} -C ${worktree} add a.txt`, form('add')], [`git -C ${worktree} -c user.name=x commit -m x -- a.txt`, commitForm],
      [`GIT_DIR=/x/.git git -C ${worktree} commit -m x -- a.txt`, commitForm], [`export GIT_WORK_TREE=/x; git -C ${worktree} add a.txt`, form('add')],
      [`git -C ${worktree} commit -m x`, /\(commit by path\)/], [`git -C ${worktree} commit -am x -- a.txt`, /\(commit by path\)/],
      [`git -C ${worktree} commit --all -m x`, /\(commit by path\)/], [`git -C ${worktree} commit -m "a b" --`, /\(commit by path\)/],
      [`git -C ${worktree} commit --pathspec-from-file=list -m x`, /\(commit by path\)/],
      [`git -C ${worktree} push`, /\(no git push\)/],
    ]
    const allowed = [
      `git -C ${worktree} commit -m x -- a.txt`, `git -C ${worktree} commit -m "feat: x y" a.txt b.txt`, `git -C ${worktree} commit -F msg.txt -- "a b.txt"`,
      `git -C ${worktree} commit -m x --amend -- a.txt`, `git -C ${worktree} add a.txt`, `git -C ${worktree} branch -D old`, `git -C ${worktree} config user.name x`,
      'git status', 'git log --oneline', `git -C ${worktree} diff`, 'git branch',
    ]
    for (const host of ['claude', 'codex']) {
      const { session } = boundSeat(host, 'workspace-write')
      for (const [command, pattern] of refused) denied(seatCall(host, session, 'Bash', { command }), pattern, `${host} ${command}`)
      for (const command of allowed) silent(seatCall(host, session, 'Bash', { command }), `${host} ${command}`)
    }
    ok('a writer seat runs git writes only as git -C <worktree realpath> with no --git-dir, --work-tree, second -C, -c or GIT_DIR-style variable, and commits only named paths; a bare write is denied with the allowed form named')
  },

  'fastpath-silent': () => {
    const fresh = join(tmp, 'fastpath-state')
    const env = { FLOW_DELEGATION_STATE_DIR: fresh }
    const trace = join(tmp, 'fastpath-trace.mjs')
    const traceLog = join(tmp, 'fastpath-trace.log')
    writeFileSync(trace, `import { appendFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) { const found = next(specifier, context); appendFileSync(process.env.SEAT_TRACE, found.url + '\\n'); return found } })
`)
    const loaded = (mode, host, input) => {
      rmSync(traceLog, { force: true })
      silent(guard(mode, host, input, { env: { ...env, SEAT_TRACE: traceLog }, nodeArgs: ['--import', pathToFileURL(trace).href] }), `${mode} ${host} traced`)
      return readFileSync(traceLog, 'utf8')
    }
    for (const host of ['claude', 'codex']) {
      const session = randomUUID()
      const calls = [
        ['prompt', promptCall(host, session, 'Run the prep scouts for issue 12.')],
        ['prompt', promptCall(host, session, 'Explain what <flow-seat id=xyz> means.')],
        ['pre', preCall(host, session, 'Bash', { command: 'git status' })],
        ['pre', preCall(host, session, 'Read', { file_path: '/home/u/repo/README.md' })],
        ['pre', preCall(host, session, host === 'claude' ? 'mcp__claude_ai_Context7__resolve-library-id' : 'mcp__t3_code__task_status', { libraryName: 'node' },
          host === 'claude' ? { mcp_server: { name: 'claude.ai Context7', source: 'claudeai' } } : {})],
        ['pre', preCall(host, session, host === 'claude' ? 'Edit' : 'apply_patch', host === 'claude' ? { file_path: '/home/u/repo/a', old_string: 'a', new_string: 'b' } : { command: '*** Begin Patch\n*** Add File: a\n+x\n*** End Patch' })],
        ['stop', call(host, session, { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' })],
      ]
      for (const [mode, input] of calls) silent(guard(mode, host, input, { env }), `${host} ${mode} ${input.tool_name ?? ''}`)
      for (const mode of ['prompt', 'pre', 'stop']) {
        for (const body of ['', '{', 'null', '[]', '"text"', '{"session_id":']) silent(guard(mode, host, body, { env }), `${host} ${mode} unreadable ${JSON.stringify(body)}`)
      }
      assert.ok(!loaded('pre', host, preCall(host, session, 'Bash', { command: 'pwd' })).includes('seat-policy.mjs'), 'a non-seat tool call loaded the policy')
      assert.ok(!loaded('prompt', host, promptCall(host, session, 'plain prompt')).includes('seat-policy.mjs'), 'a plain prompt loaded the policy')
      assert.ok(!loaded('pre', host, preCall(host, session, 'Read', { file_path: '/r/a' })).includes('node:crypto'), 'a non-seat tool call loaded node:crypto')
      const plain = { task: 'Summarise the README.', role: 'general', runtimeMode: 'auto', target: { providerInstanceId: 'codex', model: MODELS.codex } }
      assert.ok(loaded('pre', host, preCall(host, session, SPELLING[host], plain)).includes('seat-policy.mjs'), 'the delegate_task gate never loaded the policy, so the trace proves nothing')
    }
    assert.equal(existsSync(fresh), false, 'a non-seat session wrote seat state')
    ok('a non-seat session on either host, with or without a tag-like string, an unreadable body, or an untagged delegate_task, gets no answer, writes no state, never loads node:crypto, and never loads seat-policy.mjs outside the gate')
  },

  'fastpath-latency': () => {
    const N = 30
    const env = { ...process.env, FLOW_DELEGATION_STATE_DIR: join(tmp, 'latency-state') }
    const input = JSON.stringify(preCall('claude', randomUUID(), 'Bash', { command: 'git status' }))
    const time = (args) => {
      const started = performance.now()
      const run = spawnSync(process.execPath, args, { input, encoding: 'utf8', env })
      assert.equal(run.status, 0)
      assert.equal(run.stdout, '')
      return performance.now() - started
    }
    time(['-e', '']); time([GUARD, 'pre', 'claude'])
    const baseline = []
    const hook = []
    for (let i = 0; i < N; i++) {
      baseline.push(time(['-e', '']))
      hook.push(time([GUARD, 'pre', 'claude']))
    }
    const [b, h] = [median(baseline), median(hook)]
    console.log(`  fastpath p50 over ${N} runs: seat-guard pre ${h.toFixed(1)} ms, node -e '' ${b.toFixed(1)} ms, added ${(h - b).toFixed(1)} ms`)
    ok('measured the non-seat PreToolUse cost against a bare node start (no bound asserted)')
  },
}

const selected = Object.keys(cases).filter((name) => name.startsWith(prefix))
try {
  if (selected.length === 0) throw new Error(`no case matches --case-prefix ${JSON.stringify(prefix)}`)
  for (const name of selected) {
    console.log(name)
    await cases[name]()
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\nsmoke-seat: ALL PASS (${checks} checks, ${selected.length} cases)`)
