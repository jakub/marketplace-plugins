// Seat smoke section: store-admit. Run via `node test/flow/smoke-seat.mjs` or directly.
import { assert, spawn, spawnSync, createHash, randomUUID, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, createServer, performance, DatabaseSync, tmpdir, dirname, join, fileURLToPath, pathToFileURL, PLUGIN, STORE, tmp, state, t3Home, store, wire, seatPolicy, RETENTION_MS, schemas, ok, sha256, mode, seats, INSTANCE, RECORD, SCHEMA, ENVELOPE_OK, racer, race, GUARD, guard, silent, denied, blocked, context, stopBlocked, MODELS, PERMISSION, SPELLING, call, stopCall, promptCall, preCall, EFFORT_OPTION, delegateInput, seatRecord, admit, admittedSeat, worktree, ACCESSES, boundSeat, seatCall, editCalls, indexEntries, SEAT_SCRIPT, jobs, seatCli, fakeCodexBin, OWN_HOOKS, installedRoot, FAKE_ROOT, treeDigest, DRIFTED_ROOT, snake, flowEntries, FOREIGN, codexState, codexSent, codexHooks, flowDigest, trustedCodex, T3_TABLES, T3_INDEXES, t3Store, t3, T3_SESSION, T3_OWNER, t3Time, taskIdOf, childThreadOf, runIdOf, t3TaskRow, t3RunRow, t3MessageRow, t3Forget, t3Seat, MESSAGE_OK, taskStatusOf, t3Status, closeSeat, oneRunTask, writerSeat, recordFiles, refusedClose, gitEnv, gitOut, canon, baseSha, headSha, linkedWt, gitWorktree, jobRecord, hookedSeat, guardedSeat, messageWith, rootedCodexSeat, holderGate, jobGate, stampGate, scanGate, heldChildren, heldAt, waitFor, leaseRacer, leaseRace, runSection } from './helpers.mjs'

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
    const DISPLACED = (...ids) => ({ ...VOID, displaced: ids })
    assert.deepEqual(store.parseTag(`do the work\n${tag}`), DISPLACED(id), 'a valid tag on line 2')
    assert.deepEqual(store.parseTag(`${tag}\nbody\n<flow-seat id=${other}>`), VOID, 'a second tag below a valid line 1')
    assert.deepEqual(store.parseTag(`${tag}\nbody\n${tag}`), VOID, 'the line-1 tag repeated below it')
    assert.deepEqual(store.parseTag(`please ${tag}\nbody`), DISPLACED(id), 'line 1 holding more than the tag')
    assert.deepEqual(store.parseTag(`${tag} \nbody`), DISPLACED(id), 'trailing space after the tag')
    assert.deepEqual(store.parseTag(`${tag}\r\nbody`), DISPLACED(id), 'a CR ending line 1')
    assert.deepEqual(store.parseTag(`\n${tag}`), DISPLACED(id), 'an empty line 1')
    assert.deepEqual(store.parseTag(`a ${store.seatTag(other)} b ${tag}\n${tag}\n<flow-seat id=${other}>`), DISPLACED(other, id), 'two ids, each repeated')
    for (const prompt of [`do the work\n${tag}`, `${tag}\nbody\n${store.seatTag(other)}`]) {
      assert.equal(Object.hasOwn(store.parseTag(prompt), 'id'), false, `a void result carries an id: ${prompt}`)
    }
    ok('a well-formed tag anywhere but as the whole of line 1 voids the seat, including a valid line 1 with a second tag below it; without a line-1 tag the void names every distinct displaced id in order, never as id')

    for (const malformed of [
      `<flow-seat id=${id.toUpperCase()}>`, `<flow-seat id=${id.slice(1)}>`, `<flow-seat id=${id}0>`, `<flow-seat id="${id}">`,
      `<flow-seat id=${id} role=writer>`, `<flow-seat  id=${id}>`, '<flow-seat id=../x>', '<flow-seat >', `<flow-seat id=${id}`,
    ]) {
      assert.equal(store.parseTag(`${malformed}\nbody`), null, malformed)
      assert.equal(store.parseTag(`body\n${malformed}`), null, malformed)
    }
    for (const plain of ['', 'just a prompt', '<flow-seat', null, undefined, 42, { id }]) assert.equal(store.parseTag(plain), null)
    ok('a malformed id or extra attribute is not a tag on any line, and a non-string prompt or plain text is no seat')

    const banner = `[T3 Code: the agent in T3 thread "${randomUUID()}" sent this message, not the user.]`
    assert.deepEqual(store.parseDeliveredTag(`${banner}\n\n${tag}\nWorktree: none`), { id }, 'T3 banner then the tag')
    assert.deepEqual(store.parseTag(`${banner}\n\n${tag}\nWorktree: none`), DISPLACED(id), 'parseTag never strips the banner')
    assert.deepEqual(store.parseDeliveredTag(`${tag}\nbody`), { id }, 'no banner')
    assert.deepEqual(store.parseDeliveredTag(`${banner}\n\nplain prompt`), null, 'banner with no tag')
    assert.deepEqual(store.parseDeliveredTag(`${banner}\n\n${tag}\nbody\n${store.seatTag(other)}`), VOID, 'banner, tag, second tag')
    for (const near of [
      `${banner}\n${tag}`, `${banner}\n\n\n${tag}`, `${banner}\n\n${banner}\n\n${tag}`, ` ${banner}\n\n${tag}`, `${banner}\r\n\r\n${tag}`,
      `[T3 Code: the agent in T3 thread "${randomUUID().toUpperCase()}" sent this message, not the user.]\n\n${tag}`,
      `[T3 Code: the agent in T3 thread "not-a-uuid" sent this message, not the user.]\n\n${tag}`,
      `[T3 Code: the user in T3 thread "${randomUUID()}" sent this message.]\n\n${tag}`,
      `please\n\n${tag}`,
    ]) {
      assert.deepEqual(store.parseDeliveredTag(near), DISPLACED(id), JSON.stringify(near))
    }
    ok('parseDeliveredTag drops exactly one T3 provenance banner and its empty line before reading line 1; a near-miss banner or any other prefix still voids')
  },

  'store-schema-path': () => {
    // open measures the seat context with the schema path the prompt hook will inject, so the two
    // must be one absolute spelling even under a relative FLOW_DELEGATION_STATE_DIR.
    const probe = `const s = await import(${JSON.stringify(pathToFileURL(join(PLUGIN, 'lib', 'seat-store.mjs')).href)}); process.stdout.write(s.schemaPath('0123456789abcdef0123456789abcdef'))`
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: tmp, env: { ...process.env, FLOW_DELEGATION_STATE_DIR: 'rel-state' }, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout, join(realpathSync(tmp), 'rel-state', 'seats', '0123456789abcdef0123456789abcdef', 'schema.json'))
    ok('schemaPath is absolute under a relative state directory, so open and the prompt hook measure the same context')
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
    for (let round = 0; round < 1; round++) {
      const { id } = store.writeRecord(RECORD(), null)
      const results = await race('stamp', id, 'unused', 4)
      const winners = results.filter((result) => result.won)
      assert.equal(winners.length, 1, JSON.stringify(results))
      assert.equal(store.readStamp(id, 'bound').sessionId, winners[0].label)
    }
    ok('six processes racing one stamp, three rounds: exactly one wins each time and the stamp holds its content')

    for (let round = 0; round < 1; round++) {
      const { id } = store.writeRecord(RECORD(), null)
      const session = `race-${round}-${store.newId()}`
      const results = await race('index', id, session, 4)
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
    const corrupt = store.writeRecord(RECORD({ createdAt: old }), null).id
    store.stamp(corrupt, 'closed', { at: old, verdict: 'valid' })
    writeFileSync(join(seats, corrupt, 'record.json'), '{"v":1,')

    const { removed, retained } = store.pruneSeats(now)
    assert.deepEqual(removed, [oldClosed])
    assert.deepEqual(retained.sort(), [recentClosed, admittedOpen, badTime, corrupt].sort())
    assert.ok(existsSync(join(seats, corrupt)), 'prune removed a closed record whose record.json it could not read')
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

    // T3 builds the task id from clientRequestId, so an untagged call reusing a seat's would make a
    // task row close reads as the seat's.
    for (const host of ['claude', 'codex']) {
      for (const clientRequestId of [`flow-seat-${id}`, 'flow-seat-anything']) {
        const reuse = { task: 'Summarise the README.', role: 'general', runtimeMode: 'auto', target: { providerInstanceId: 'codex', model: MODELS.codex }, clientRequestId }
        denied(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], reuse)), /reserved for the seat call/, `untagged ${clientRequestId}`)
      }
    }
    assert.equal(store.readStamp(id, 'admitted'), null, 'an untagged call reusing the seat\'s clientRequestId admitted the record')
    assert.deepEqual(readdirSync(seats).sort(), before, 'an untagged call reusing a seat clientRequestId wrote seat state')
    ok('an untagged delegate_task call naming a flow-seat- clientRequestId is denied on both hosts and admits nothing')
  },

  'admit-mismatch': () => {
    const record = seatRecord('claude')
    const { id } = store.writeRecord(record, SCHEMA)
    const host = 'claude'
    const variants = [
      [{ target: { providerInstanceId: 'codex', model: record.model } }, /target\.providerInstanceId must be "claudeAgent"/],
      [{ target: { providerInstanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } }, /model must be "claude-opus-5-5"/],
      [{ runtimeMode: 'full-access' }, /runtimeMode must be "auto"/],
      [{ runtimeMode: 'full-access', target: { providerInstanceId: 'codex', model: MODELS.codex } }, /runtimeMode must be "auto"; target\.providerInstanceId must be "claudeAgent"; model must be/],
      [{ role: 'reviewer' }, /role "general"/],
      [{ role: undefined }, /role "general"/],
      [{ target: { providerInstanceId: 'openai', model: record.model } }, /target\.providerInstanceId must be "claudeAgent"/],
    ]
    for (const [fields, pattern] of variants) {
      const run = guard('pre', host, preCall(host, randomUUID(), SPELLING.claude, delegateInput(record, id, fields)))
      denied(run, pattern, JSON.stringify(fields))
      assert.doesNotMatch(run.answer.hookSpecificOutput.permissionDecisionReason, /neither claudeAgent nor codex/)
      assert.equal(store.readStamp(id, 'admitted'), null, `${JSON.stringify(fields)} admitted the record`)
    }
    silent(guard('pre', host, preCall(host, randomUUID(), SPELLING.claude, delegateInput(record, id))), 'the matching call after the refusals')
    assert.ok(store.readStamp(id, 'admitted'))
    ok('a tagged call whose provider instance, model, runtimeMode or role differs from the record is denied, naming the record\'s instance rather than a family, and admits nothing; the matching call is still admitted after')
  },

  'admit-effort': () => {
    for (const host of ['claude', 'codex']) {
      for (const provider of ['claude', 'codex']) {
        const own = EFFORT_OPTION[provider]
        const other = EFFORT_OPTION[provider === 'claude' ? 'codex' : 'claude']
        const target = (options) => ({ target: { providerInstanceId: INSTANCE[provider], model: MODELS[provider], ...(options === undefined ? {} : { options }) } })
        const refused = [
          undefined, null, [], {}, 'high', [{ id: own, value: 'low' }], { [own]: 'low' }, [{ id: other, value: 'high' }], { [other]: 'high' },
          [{ id: own, value: 'high' }, { id: own, value: 'high' }], [{ id: own }], [{ value: 'high' }],
        ]
        const record = seatRecord(provider)
        const { id } = store.writeRecord(record, SCHEMA)
        for (const options of refused) {
          denied(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], delegateInput(record, id, target(options)))),
            new RegExp(`target\\.options ${own} must be "high"`), `${host} ${provider} ${JSON.stringify(options)}`)
          assert.equal(store.readStamp(id, 'admitted'), null, `${host} ${provider} ${JSON.stringify(options)} admitted the record`)
        }
        silent(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], delegateInput(record, id, target({ [own]: 'high', other: 'x' })))), `${host} ${provider} record form`)
        assert.ok(store.readStamp(id, 'admitted'), 'the record form did not admit')
        const array = store.writeRecord(record, SCHEMA).id
        silent(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], delegateInput(record, array, target([{ id: 'model', value: 'x' }, { id: own, value: 'high' }])))), `${host} ${provider} array form`)
        assert.ok(store.readStamp(array, 'admitted'), 'the array form did not admit')
      }
    }
    ok('a tagged call is admitted only with the record\'s effort in target.options under the provider\'s option id (effort on Claude, reasoningEffort on Codex), as an array of {id, value} or a record; a missing, different, duplicated or other-provider effort is denied')
  },

  'admit-client-request-id': () => {
    for (const host of ['claude', 'codex']) {
      const record = seatRecord('codex')
      const { id } = store.writeRecord(record, SCHEMA)
      const other = store.newId()
      for (const clientRequestId of [undefined, null, '', 7, id, `flow-seat-${other}`, `flow-seat-${id.toUpperCase()}`, `flow-seat-${id} `, `x-flow-seat-${id}`]) {
        const input = delegateInput(record, id, { clientRequestId })
        if (clientRequestId === undefined) delete input.clientRequestId
        denied(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], input)), new RegExp(`clientRequestId must be "flow-seat-${id}"`), `${host} ${JSON.stringify(clientRequestId)}`)
        assert.equal(store.readStamp(id, 'admitted'), null, `${JSON.stringify(clientRequestId)} admitted the record`)
      }
      const call = preCall(host, randomUUID(), SPELLING[host], delegateInput(record, id))
      silent(guard('pre', host, call), `${host} matching clientRequestId`)
      const stamped = store.readStamp(id, 'admitted')
      assert.deepEqual(Object.keys(stamped), ['at', 'toolUseId', 'clientRequestId', 'recordDigest'])
      assert.deepEqual(stamped, { at: stamped.at, toolUseId: call.tool_use_id, clientRequestId: `flow-seat-${id}`, recordDigest: store.readRecord(id).digest })
    }
    ok('a tagged call is admitted only with clientRequestId exactly flow-seat-<id>, and the admitted stamp records it beside the tool use id and the digest of the record it admitted')
  },

  'admit-instance-exact': () => {
    const glm = { providerInstanceId: 'glm', model: 'accounts/fireworks/routers/glm-5p3-us', expectedServedModel: 'accounts/fireworks/models/glm-5p3' }
    for (const host of ['claude', 'codex']) {
      for (const spelling of Object.values(SPELLING)) {
        for (const form of ['array', 'object']) {
          for (const fields of [{}, glm]) {
            const record = seatRecord('claude', fields)
            const { id } = store.writeRecord(record, SCHEMA)
            const options = form === 'array' ? [{ id: 'effort', value: 'high' }] : { effort: 'high' }
            const input = delegateInput(record, id, { target: { providerInstanceId: record.providerInstanceId, model: record.model, options } })
            silent(guard('pre', host, preCall(host, randomUUID(), spelling, input)), `${host} ${spelling} ${form} ${record.providerInstanceId}`)
            assert.equal(store.readStamp(id, 'admitted').recordDigest, store.readRecord(id).digest)
          }
        }
      }
    }
    ok('a tagged call naming exactly the record\'s instance, claudeAgent or a custom one, is admitted from both parent hosts, under both T3 spellings, with options as an array or an object')

    for (const [fields, refused] of [
      [glm, ['GLM', 'Glm', 'glm ', ' glm', 'glm\u200b', 'claudeAgent', 'codex', '']],
      [{}, ['claudeagent', 'ClaudeAgent', 'claudeAgent ', ' claudeAgent', 'glm', 'codex']],
    ]) {
      const record = seatRecord('claude', fields)
      const { id } = store.writeRecord(record, SCHEMA)
      for (const host of ['claude', 'codex']) {
        for (const providerInstanceId of refused) {
          const input = delegateInput(record, id, { target: { providerInstanceId, model: record.model, options: { effort: 'high' } } })
          denied(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], input)), new RegExp(`target\\.providerInstanceId must be ${JSON.stringify(record.providerInstanceId)}`), `${host} ${JSON.stringify(providerInstanceId)}`)
          assert.equal(store.readStamp(id, 'admitted'), null, `${JSON.stringify(providerInstanceId)} admitted the record`)
        }
      }
    }
    ok('an instance id that differs from the record\'s in case, by a trailing or leading space or an invisible character, or names another instance, is denied on both hosts and admits nothing')
  },

  'admit-custom-effort': () => {
    const record = seatRecord('claude', { providerInstanceId: 'glm', model: 'accounts/fireworks/routers/glm-5p3-us', expectedServedModel: 'accounts/fireworks/models/glm-5p3' })
    for (const host of ['claude', 'codex']) {
      const { id } = store.writeRecord(record, SCHEMA)
      for (const options of [[{ id: 'reasoningEffort', value: 'high' }], { reasoningEffort: 'high' }, []]) {
        const input = delegateInput(record, id, { target: { providerInstanceId: 'glm', model: record.model, options } })
        denied(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], input)), /target\.options effort must be "high"/, `${host} ${JSON.stringify(options)}`)
        assert.equal(store.readStamp(id, 'admitted'), null)
      }
      silent(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], delegateInput(record, id))), `${host} effort`)
      assert.ok(store.readStamp(id, 'admitted'))
    }
    ok('a claude-family seat on a custom instance carries its effort under effort, the claude family\'s option: effort admits, and reasoningEffort alone is denied')
  },

  'record-identity-required': () => {
    // A record that lacks a field the identity rule reads, or was edited into a combination open
    // refuses, as an older flow or a hand edit leaves it: readRecord still reads it, and every
    // stage that judges a seat refuses it.
    const broken = {
      'no providerInstanceId': (record) => { delete record.providerInstanceId },
      'no expectedServedModel': (record) => { delete record.expectedServedModel },
      'an empty providerInstanceId': (record) => { record.providerInstanceId = '' },
      'a null expectedServedModel': (record) => { record.expectedServedModel = null },
      'no effort': (record) => { delete record.effort },
      'no runtimeMode': (record) => { delete record.runtimeMode },
      'an unknown provider': (record) => { record.provider = 'gemini' },
      'a claude seat on instance codex': (record) => { record.providerInstanceId = 'codex' },
      'a codex seat on a custom instance': (record) => { Object.assign(record, { provider: 'codex', model: MODELS.codex, providerInstanceId: 'codex-work', expectedServedModel: MODELS.codex }) },
      'a codex seat expecting another model': (record) => { Object.assign(record, { provider: 'codex', model: MODELS.codex, providerInstanceId: 'codex', expectedServedModel: 'gpt-6-mini' }) },
    }
    for (const [what, edit] of Object.entries(broken)) {
      const record = seatRecord('claude')
      edit(record)
      const { id } = store.writeRecord(record, SCHEMA)
      assert.ok(store.readRecord(id), `${what}: readRecord refused the record, so cleanup could not read it`)
      for (const host of ['claude', 'codex']) {
        const input = delegateInput(record, id, { target: { providerInstanceId: record.providerInstanceId ?? 'claudeAgent', model: record.model ?? 'x', options: { effort: 'high', reasoningEffort: 'high' } } })
        if (input.runtimeMode === undefined) input.runtimeMode = 'auto'
        denied(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], input)), /fails the seat identity rule/, `${host} ${what}`)
      }
      assert.equal(store.readStamp(id, 'admitted'), null, `${what} was admitted`)
    }
    ok('admission denies a record missing providerInstanceId, expectedServedModel, effort or runtimeMode, or holding a provider, instance or expected id open refuses, on both hosts, and admits nothing')

    for (const [what, edit] of Object.entries(broken)) {
      const record = seatRecord('claude')
      edit(record)
      const { id } = store.writeRecord(record, SCHEMA)
      assert.equal(admit(id), true)
      const host = record.provider === 'codex' ? 'codex' : 'claude'
      const session = randomUUID()
      assert.match(context(guard('prompt', host, promptCall(host, session, store.seatTag(id))), `${what} bind`), /record-identity-invalid/, what)
      assert.deepEqual(store.readIndex(host, session), { id, void: 'record-identity-invalid' }, what)
      assert.equal(store.readStamp(id, 'bound'), null, `${what} was bound`)
      denied(guard('pre', host, preCall(host, session, 'Bash', { command: 'pwd' })), /void seat \(record-identity-invalid\)/, `${what} child call`)
    }
    ok('a bind of such a record, admitted with its own digest, is void (record-identity-invalid): no bound stamp, and every child call denied')

    // A seat open made, stripped of a field after it, as a record an older flow wrote reads:
    // close judges it unknown and still releases what open took.
    const strip = (id, field) => {
      const path = join(seats, id, 'record.json')
      const record = JSON.parse(readFileSync(path, 'utf8'))
      delete record[field]
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
      assert.ok(store.readRecord(id), 'the stripped record is unreadable')
    }
    const writerWt = gitWorktree('identity-writer')
    const writer = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', writerWt])
    const holder = join(jobs.leaseDirOf(writerWt), `${writer.id}.live`)
    assert.ok(existsSync(holder))
    strip(writer.id, 'providerInstanceId')
    const writerRecord = store.readRecord(writer.id).record
    denied(guard('pre', 'claude', preCall('claude', randomUUID(), SPELLING.claude, delegateInput({ ...writerRecord, providerInstanceId: 'claudeAgent' }, writer.id))), /fails the seat identity rule/, 'the stripped writer\'s admission')
    hookedSeat({ id: writer.id })
    const writerOut = closeSeat(writer.id)
    assert.deepEqual([writerOut.verdict, writerOut.reasons], ['unknown', ['the seat record fails the seat identity rule: providerInstanceId must be 1 to 128 UTF-8 bytes with no control character']], JSON.stringify(writerOut))
    assert.equal(existsSync(holder), false, 'close kept the stripped writer\'s lease holder')
    const taker = jobRecord(writerWt, 'queued')
    jobs.acquireLease(taker)
    jobs.releaseLease(taker)

    const review = seatCli(['open', '--access', 'review', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--base', baseSha, '--head', headSha])
    strip(review.id, 'expectedServedModel')
    hookedSeat({ id: review.id })
    const reviewOut = closeSeat(review.id)
    assert.deepEqual([reviewOut.verdict, reviewOut.reasons], ['unknown', ['the seat record fails the seat identity rule: expectedServedModel must be a model id']], JSON.stringify(reviewOut))
    assert.equal(existsSync(review.reviewWorktree), false, 'close kept the stripped review\'s worktree')
    assert.ok(!gitOut(canon, 'worktree', 'list', '--porcelain').includes(review.reviewWorktree), 'git still lists the stripped review\'s worktree')
    ok('close of a seat open made and later stripped of providerInstanceId or expectedServedModel is unknown with the identity reason, and still drops the writer\'s lease holder and removes the review worktree')

    const abandonWt = gitWorktree('identity-abandon')
    const unbound = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', abandonWt])
    strip(unbound.id, 'expectedServedModel')
    const abandoned = seatCli(['close', unbound.id, '--abandon'])
    assert.deepEqual([abandoned.verdict, abandoned.reasons, abandoned.cleanupProblems], ['unknown', ['abandoned-before-bind'], undefined], JSON.stringify(abandoned))
    assert.equal(existsSync(join(jobs.leaseDirOf(abandonWt), `${unbound.id}.live`)), false, 'abandon kept the stripped writer\'s holder')
    const unboundReview = seatCli(['open', '--access', 'review', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--base', baseSha, '--head', headSha])
    strip(unboundReview.id, 'providerInstanceId')
    assert.equal(seatCli(['close', unboundReview.id, '--abandon']).verdict, 'unknown')
    assert.equal(existsSync(unboundReview.reviewWorktree), false, 'abandon kept the stripped review\'s worktree')
    ok('close --abandon of an unbound seat stripped of a field records unknown and still drops its lease holder and review worktree')
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

}

await runSection('store-admit', cases)
