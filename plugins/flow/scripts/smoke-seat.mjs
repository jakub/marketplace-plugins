#!/usr/bin/env node
// Smoke for T3 seats: the seat store in lib/seat-store.mjs and the answer shapes the seat guard
// prints through hooks/scripts/wire.mjs. The state directory is a temp directory named by
// FLOW_DELEGATION_STATE_DIR, and the races run as separate node processes released together, so
// the write-once claims are tested against real concurrent link(2) calls, not a single event loop.
// Cases are grouped by prefix (store-*, wire-*); --case-prefix <p> runs only the cases whose name
// starts with p, and no match is a failure rather than a vacuous pass.
// Run: node plugins/flow/scripts/smoke-seat.mjs [--case-prefix <p>]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

const cases = {
  'wire-shapes': () => {
    assert.deepEqual(wire.promptContext('seat facts'), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'seat facts' } })
    assert.equal(JSON.stringify(wire.promptContext('a')), '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"a"}}')
    assert.deepEqual(wire.stopBlock('$.status: missing'), { decision: 'block', reason: '$.status: missing' })
    assert.equal(JSON.stringify(wire.stopBlock('r')), '{"decision":"block","reason":"r"}')
    ok('promptContext and stopBlock print exactly the UserPromptSubmit context and Stop block shapes, with no extra keys')
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
    ok('a session id outside [A-Za-z0-9._-]{1,128} or an unknown host is refused before it reaches a filename')

    const session = '5d6d6ca0-12f6-4c6c-ab13-40be7c324794'
    const path = store.indexPath('codex', session)
    assert.equal(path, join(seats, 'by-session', sha256(`codex\0${session}`)))
    assert.notEqual(store.indexPath('claude', session), path, 'the host is part of the key')
    assert.equal(store.readIndex('codex', session), null)
    assert.equal(store.indexSession('codex', session, { id: '../x' }), false)
    assert.equal(store.indexSession('codex', session, { id }), true)
    assert.equal(store.indexSession('codex', session, { id: store.newId() }), false)
    assert.deepEqual(store.readIndex('codex', session), { id })
    assert.equal(store.readIndex('claude', session), null)
    ok('the session index lives at sha256(host NUL session), is created once, and reads back {id}')
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
