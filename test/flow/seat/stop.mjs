// Seat smoke section: stop. Run via `node test/flow/smoke-seat.mjs` or directly.
import { assert, spawn, spawnSync, createHash, randomUUID, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, createServer, performance, DatabaseSync, tmpdir, dirname, join, fileURLToPath, pathToFileURL, PLUGIN, STORE, tmp, state, t3Home, store, wire, seatPolicy, RETENTION_MS, schemas, ok, sha256, mode, seats, INSTANCE, RECORD, SCHEMA, ENVELOPE_OK, racer, race, GUARD, guard, silent, denied, blocked, context, stopBlocked, MODELS, PERMISSION, SPELLING, call, stopCall, promptCall, preCall, EFFORT_OPTION, delegateInput, seatRecord, admit, admittedSeat, worktree, ACCESSES, boundSeat, seatCall, editCalls, indexEntries, SEAT_SCRIPT, jobs, seatCli, fakeCodexBin, OWN_HOOKS, installedRoot, FAKE_ROOT, treeDigest, DRIFTED_ROOT, snake, flowEntries, FOREIGN, codexState, codexSent, codexHooks, flowDigest, trustedCodex, T3_TABLES, T3_INDEXES, t3Store, t3, T3_SESSION, T3_OWNER, t3Time, taskIdOf, childThreadOf, runIdOf, t3TaskRow, t3RunRow, t3MessageRow, t3Forget, t3Seat, MESSAGE_OK, taskStatusOf, t3Status, closeSeat, oneRunTask, writerSeat, recordFiles, refusedClose, gitEnv, gitOut, canon, baseSha, headSha, linkedWt, gitWorktree, jobRecord, hookedSeat, guardedSeat, messageWith, rootedCodexSeat, holderGate, jobGate, stampGate, scanGate, heldChildren, heldAt, waitFor, leaseRacer, leaseRace, runSection } from './helpers.mjs'

const cases = {
  'stop-envelope-schema': () => {
    for (const access of ACCESSES) {
      const schema = schemas.envelopeSchema(access)
      assert.equal(schemas.schemaProblem(schema), null, `the ${access} envelope schema uses a keyword the checker cannot check`)
      assert.deepEqual(schemas.validate(schema, access === 'workspace-write' ? { ...ENVELOPE_OK, commits: [] } : ENVELOPE_OK), [])
      assert.deepEqual(schema.required.includes('commits'), access === 'workspace-write')
    }
    ok('envelopeSchema is admitted by schemaProblem for every access, takes the fixture envelope, and requires commits of a writer alone')
  },

  'stop-valid': () => {
    for (const host of ['claude', 'codex']) {
      const { id, session } = boundSeat(host, 'read-only')
      const key = randomUUID()
      silent(guard('stop', host, stopCall(host, session, JSON.stringify(ENVELOPE_OK), key)), `${host} valid answer`)
      const messageSha256 = sha256(JSON.stringify(ENVELOPE_OK))
      assert.deepEqual(store.readState(id), { turn: 1, turnKey: key, blocks: 0, outcome: 'valid', errors: [], stops: 1, messageSha256, models: host === 'codex' ? [MODELS.codex] : [] })
      const result = store.readResult(id, 1)
      assert.equal(result.intact, true)
      assert.deepEqual(result.body.envelope, ENVELOPE_OK)
      assert.equal(result.body.messageSha256, messageSha256)
      assert.deepEqual(result.body.servedModels, host === 'codex' ? [MODELS.codex] : [], `${host} served models`)
      assert.ok(Number.isFinite(Date.parse(result.body.at)))
      assert.equal(readFileSync(join(seats, id, 'result-1.sha256'), 'utf8').trim(), sha256(readFileSync(join(seats, id, 'result-1.json'))))
    }
    ok('a valid final message writes result-1.json, its sha256 and a valid turn state, on both hosts; a Claude transcript that cannot be read serves no model')

    const writer = boundSeat('codex', 'workspace-write')
    const commits = [{ sha: 'a'.repeat(40), subject: 'feat: x' }]
    const noCommits = stopBlocked(guard('stop', 'codex', stopCall('codex', writer.session, JSON.stringify(ENVELOPE_OK), randomUUID())), 'writer without commits')
    assert.match(noCommits, /^\$: missing the required property "commits"$/m)
    assert.match(noCommits, /"commits": \[\{"sha": "<sha>", "subject": "<subject>"\}\]\}$/)
    silent(guard('stop', 'codex', stopCall('codex', writer.session, JSON.stringify({ ...ENVELOPE_OK, commits }), randomUUID())), 'writer with commits')
    assert.deepEqual(store.readResult(writer.id, 2).body.envelope.commits, commits)
    ok('a writer seat\'s envelope requires commits, and one that lists them is recorded')

    const bare = seatRecord('codex', { access: 'read-only', worktree, repoRoot: worktree })
    const { id: bareId } = store.writeRecord(bare, null)
    assert.equal(admit(bareId), true)
    const bareSession = randomUUID()
    context(guard('prompt', 'codex', promptCall('codex', bareSession, store.seatTag(bareId))), 'schemaless bind')
    silent(guard('stop', 'codex', stopCall('codex', bareSession, JSON.stringify({ ...ENVELOPE_OK, answer: [1, 'any'] }), randomUUID())), 'schemaless answer')
    assert.deepEqual(store.readResult(bareId, 1).body.envelope.answer, [1, 'any'])
    ok('a seat with no answer schema takes any answer inside a valid envelope')
  },

  'stop-fenced': () => {
    const { id, session } = boundSeat('claude', 'read-only')
    const body = JSON.stringify(ENVELOPE_OK, null, 2)
    silent(guard('stop', 'claude', stopCall('claude', session, `\`\`\`json\n${body}\n\`\`\``, randomUUID())), 'a fenced answer')
    assert.deepEqual(store.readResult(id, 1).body.envelope, ENVELOPE_OK)
    silent(guard('stop', 'claude', stopCall('claude', session, `\n\`\`\`\n${body}\n\`\`\`\n`, randomUUID())), 'a bare fence with blank lines around it')
    assert.deepEqual(store.readResult(id, 2).body.envelope, ENVELOPE_OK)
    for (const [what, message] of [
      ['text before the fence', `Here it is:\n\`\`\`json\n${body}\n\`\`\``],
      ['two fenced blocks', `\`\`\`json\n${body}\n\`\`\`\n\`\`\`json\n${body}\n\`\`\``],
      ['JSON followed by prose', `${body}\nDone.`],
    ]) {
      assert.match(stopBlocked(guard('stop', 'claude', stopCall('claude', session, message, randomUUID())), what), /^\$: the final message is not one JSON object/m, what)
    }
    ok('one fenced block wrapping the whole message is read as the answer; text around it, a second block or trailing prose is blocked')
  },

  'stop-invalid': () => {
    const cases = [
      ['a message that is not JSON', 'All done! The diff looks fine.', [/^\$: the final message is not one JSON object/m]],
      ['a JSON array', '[1, 2]', [/^\$: the final message is JSON but not one object$/m]],
      ['an envelope that breaks its schema', JSON.stringify({ status: 'finished', coverage: { read: [1] }, answer: { x: 'ok' }, extra: true }), [
        /^\$\.status: not one of the allowed values$/m, /^\$\.coverage: missing the required property "partial"$/m,
        /^\$\.coverage\.read\[0\]: expected string$/m, /^\$: missing the required property "notes"$/m, /^\$\.extra: not a property the schema allows$/m,
      ]],
      ['an answer that breaks the answer schema', JSON.stringify({ ...ENVELOPE_OK, answer: { x: 1 } }), [/^\$\.answer\.x: expected string$/m]],
      ['an answer that is missing', JSON.stringify({ ...ENVELOPE_OK, answer: undefined }), [/^\$: missing the required property "answer"$/m]],
    ]
    for (const host of ['claude', 'codex']) {
      for (const [what, message, patterns] of cases) {
        const { id, session } = boundSeat(host, 'review')
        const key = randomUUID()
        const reason = stopBlocked(guard('stop', host, stopCall(host, session, message, key)), `${host} ${what}`)
        for (const pattern of patterns) assert.match(reason, pattern, `${host} ${what}`)
        const lines = reason.split('\n')
        assert.match(lines[0], /^flow seat: your final message is not a valid flow envelope \(block 1 of 3\)/)
        assert.match(lines.at(-1), /^Your final message is one JSON object, alone or as the whole of one fenced block: \{"status"/)
        assert.ok(lines.slice(1, -1).every((line) => /^\$\S*: /.test(line)) && lines.length - 2 <= 10, `${host} ${what}: ${reason}`)
        const state = store.readState(id)
        assert.deepEqual({ ...state, errors: undefined }, { turn: 1, turnKey: key, blocks: 1, outcome: 'blocked', errors: undefined, stops: 1, messageSha256: sha256(message), models: host === 'codex' ? [MODELS.codex] : [] })
        assert.deepEqual(state.errors, lines.slice(1, -1))
        assert.equal(store.readResult(id, 1), null)
      }
    }
    const { session } = boundSeat('claude', 'read-only')
    const many = JSON.stringify({ ...ENVELOPE_OK, coverage: { read: Array.from({ length: 14 }, (_, i) => i), partial: [], unopened: [], checksRun: [] } })
    assert.equal(stopBlocked(guard('stop', 'claude', stopCall('claude', session, many, randomUUID())), 'many problems').split('\n').length, 12)
    ok('a final message that is not JSON, not one object, or breaks the envelope or the answer schema is blocked with its `path: problem` lines (at most 10) and the envelope reminder, and records the turn blocked with no result, on both hosts')
  },

  'stop-cap': () => {
    for (const host of ['claude', 'codex']) {
      const { id, session } = boundSeat(host, 'read-only')
      const key = randomUUID()
      for (const n of [1, 2, 3]) {
        assert.match(stopBlocked(guard('stop', host, stopCall(host, session, `not json ${n}`, key)), `${host} stop ${n}`), new RegExp(`\\(block ${n} of 3\\)`))
        assert.equal(store.readState(id).blocks, n)
      }
      silent(guard('stop', host, stopCall(host, session, 'not json 4', key)), `${host} the fourth failing stop`)
      const capped = store.readState(id)
      assert.deepEqual({ ...capped, errors: undefined }, { turn: 1, turnKey: key, blocks: 3, outcome: 'capped', errors: undefined, stops: 4, messageSha256: sha256('not json 4'), models: host === 'codex' ? [MODELS.codex] : [] })
      silent(guard('stop', host, stopCall(host, session, 'not json 4', key)), `${host} the same message after the cap`)
      assert.deepEqual(store.readState(id), capped, 'the same message after the cap changed the state')
      silent(guard('stop', host, stopCall(host, session, 'not json 5', key)), `${host} a changed failing message after the cap`)
      assert.deepEqual({ ...store.readState(id), errors: undefined }, { ...capped, errors: undefined, stops: 5, messageSha256: sha256('not json 5') })
      assert.equal(store.readResult(id, 1), null, 'a capped turn took a result')
    }
    ok('three failing stops in a turn are blocked, the fourth is let through and records the turn capped with 3 blocks, the same message again changes nothing, and a changed failing one stays capped without a block, on both hosts')
  },

  'stop-turns': () => {
    for (const host of ['claude', 'codex']) {
      const { id, session } = boundSeat(host, 'read-only')
      const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()]
      stopBlocked(guard('stop', host, stopCall(host, session, 'nope', first)), `${host} turn 1 block 1`)
      stopBlocked(guard('stop', host, stopCall(host, session, 'nope', first)), `${host} turn 1 block 2`)
      assert.match(stopBlocked(guard('stop', host, stopCall(host, session, 'nope', second)), `${host} turn 2`), /\(block 1 of 3\)/)
      assert.deepEqual({ ...store.readState(id), errors: undefined }, { turn: 2, turnKey: second, blocks: 1, outcome: 'blocked', errors: undefined, stops: 1, messageSha256: sha256('nope'), models: host === 'codex' ? [MODELS.codex] : [] })
      silent(guard('stop', host, stopCall(host, session, JSON.stringify(ENVELOPE_OK), second)), `${host} turn 2 valid`)
      assert.equal(store.readResult(id, 2).intact, true)
      assert.equal(store.readResult(id, 1), null)

      const settled = store.readState(id)
      const resultBytes = readFileSync(join(seats, id, 'result-2.json'))
      silent(guard('stop', host, stopCall(host, session, JSON.stringify(ENVELOPE_OK), second)), `${host} turn 2 the same answer again`)
      assert.deepEqual(store.readState(id), settled, 'the same message in a valid turn changed the state')
      assert.deepEqual(readFileSync(join(seats, id, 'result-2.json')), resultBytes, 'the same message in a valid turn rewrote the result')

      assert.match(stopBlocked(guard('stop', host, stopCall(host, session, 'nope', third)), `${host} turn 3`), /\(block 1 of 3\)/)
      assert.equal(store.readState(id).turn, 3)
      const keyless = stopCall(host, session, 'nope', null)
      assert.match(stopBlocked(guard('stop', host, keyless), `${host} a stop with no turn key`), /\(block 2 of 3\)/)
      assert.equal(store.readState(id).turn, 3, 'a stop with no turn key started a turn')
    }
    ok('a new turn key starts the next turn with its blocks reset, the same final message in a turn that already has a valid result is left alone, and a stop with no turn key counts against the current turn, on both hosts')
  },

  'stop-continuation': () => {
    // A seat run through the hooks as T3 runs it: the bind prompt opens turn 1, a tool call, a valid
    // stop; then the parent's follow-up prompt opens turn 2. Codex names its model at every call,
    // so the served models are on record without a transcript.
    const host = 'codex'
    const message = JSON.stringify(ENVELOPE_OK)
    const firstTurn = () => {
      const { id, tag } = admittedSeat(host)
      const session = randomUUID()
      const key = randomUUID()
      context(guard('prompt', host, promptCall(host, session, tag, { turn_id: key })), 'bind')
      silent(guard('pre', host, preCall(host, session, 'Bash', { command: 'ls' }, { turn_id: key })), 'receipt')
      silent(guard('stop', host, stopCall(host, session, message, key)), 'turn 1 stop')
      assert.equal(store.readState(id).outcome, 'valid')
      assert.equal(Object.hasOwn(store.readState(id), 'opened'), false, 'the bind prompt recorded an opened turn')
      return { id, session }
    }
    const followUp = (seat) => {
      const key = randomUUID()
      silent(guard('prompt', host, promptCall(host, seat.session, 'Look again at b.txt and answer again.', { turn_id: key })), 'follow-up prompt')
      assert.equal(store.readState(seat.id).opened, key, 'the follow-up prompt did not record its turn')
      return key
    }

    const unanswered = firstTurn()
    followUp(unanswered)
    const out = closeSeat(unanswered.id)
    assert.deepEqual([out.verdict, out.reasons, out.result], ['unknown', ['turn-without-result'], null], JSON.stringify(out))
    ok('a follow-up prompt in a bound seat records the turn it opens, and close reads a seat whose latest opened turn has no stop as unknown (turn-without-result), not as the earlier turn\'s valid result')

    // A follow-up turn that cannot be recorded does not run: a directory where state.json belongs
    // fails the write for any user.
    const unrecorded = firstTurn()
    const statePath = join(seats, unrecorded.id, 'state.json')
    const stateBytes = readFileSync(statePath)
    rmSync(statePath)
    mkdirSync(statePath)
    let run
    try { run = guard('prompt', host, promptCall(host, unrecorded.session, 'Look again.', { turn_id: randomUUID() })) } finally { rmSync(statePath, { recursive: true }); writeFileSync(statePath, stateBytes) }
    blocked(run, /could not be recorded/, 'unrecordable follow-up')
    ok('a follow-up prompt whose turn cannot be recorded is blocked, so close never judges an unrecorded turn by the earlier result')

    const answered = firstTurn()
    const key = followUp(answered)
    silent(guard('stop', host, stopCall(host, answered.session, message, key)), 'turn 2 stop')
    const valid = closeSeat(answered.id)
    assert.deepEqual([valid.verdict, valid.turn], ['valid', 2], JSON.stringify(valid))

    const failing = firstTurn()
    const failingKey = followUp(failing)
    stopBlocked(guard('stop', host, stopCall(host, failing.session, 'not an envelope', failingKey)), 'turn 2 fails')
    const invalid = closeSeat(failing.id)
    assert.deepEqual([invalid.verdict, invalid.turn], ['invalid', 2], JSON.stringify(invalid))
    ok('a follow-up turn that stopped is judged on its own result: valid when its stop recorded one, invalid when its last stop was blocked')

    // Claude names the turn by prompt_id, and the opened key survives the stops that follow.
    const claude = boundSeat('claude', 'read-only')
    const promptId = randomUUID()
    silent(guard('prompt', 'claude', promptCall('claude', claude.session, 'And the tests?', { prompt_id: promptId })), 'claude follow-up')
    assert.equal(store.readState(claude.id).opened, promptId)
    silent(guard('stop', 'claude', stopCall('claude', claude.session, message, promptId)), 'claude turn stop')
    assert.deepEqual([store.readState(claude.id).opened, store.readState(claude.id).turnKey], [promptId, promptId])
    // A void seat's session and a session with no seat record nothing.
    const voidSession = randomUUID()
    context(guard('prompt', host, promptCall(host, voidSession, `x\n${store.seatTag(store.newId())}`)), 'void bind')
    const before = readdirSync(seats).sort()
    silent(guard('prompt', host, promptCall(host, voidSession, 'carry on')), 'void follow-up')
    silent(guard('prompt', host, promptCall(host, randomUUID(), 'carry on')), 'non-seat prompt')
    assert.deepEqual(readdirSync(seats).sort(), before, 'a void or non-seat prompt wrote seat state')
    ok('on Claude the follow-up is keyed by prompt_id and kept across its stops; a void seat or a non-seat session records nothing')
  },

  'stop-resumed': () => {
    for (const host of ['claude', 'codex']) {
      const { id, session } = boundSeat(host, 'read-only')
      const key = randomUUID()
      silent(guard('stop', host, stopCall(host, session, JSON.stringify(ENVELOPE_OK), key)), `${host} first valid answer`)
      const changed = { ...ENVELOPE_OK, notes: 'resumed and changed', answer: { x: 'second' } }
      silent(guard('stop', host, stopCall(host, session, JSON.stringify(changed), key)), `${host} a changed valid answer in the same turn`)
      const replaced = store.readResult(id, 1)
      assert.equal(replaced.intact, true)
      assert.deepEqual(replaced.body.envelope, changed, `${host}: a changed valid message did not replace the result`)
      assert.equal(replaced.body.messageSha256, sha256(JSON.stringify(changed)))
      assert.deepEqual({ ...store.readState(id), errors: undefined }, { turn: 1, turnKey: key, blocks: 0, outcome: 'valid', errors: undefined, stops: 2, messageSha256: sha256(JSON.stringify(changed)), models: host === 'codex' ? [MODELS.codex] : [] })

      const reason = stopBlocked(guard('stop', host, stopCall(host, session, 'resumed, then broke the answer', key)), `${host} a changed failing message after a valid one`)
      assert.match(reason, /\(block 1 of 3\)/)
      const after = store.readState(id)
      assert.equal(after.outcome, 'blocked', `${host}: the turn's last message failed, so the turn reads blocked`)
      assert.equal(after.blocks, 1)
      stopBlocked(guard('stop', host, stopCall(host, session, 'still broken', key)), `${host} block 2`)
      stopBlocked(guard('stop', host, stopCall(host, session, 'still broken 2', key)), `${host} block 3`)
      silent(guard('stop', host, stopCall(host, session, 'still broken 3', key)), `${host} capped`)
      assert.equal(store.readState(id).outcome, 'capped')
      silent(guard('stop', host, stopCall(host, session, JSON.stringify(ENVELOPE_OK), key)), `${host} a changed valid message after the cap`)
      assert.equal(store.readState(id).outcome, 'valid', `${host}: a valid last message after the cap reads valid`)
      assert.deepEqual(store.readResult(id, 1).body.envelope, ENVELOPE_OK)
    }
    ok('a turn resumed after it settled checks a changed final message again: a valid one replaces the result, a failing one blocks against the turn\'s cap and leaves the turn blocked or capped, and a valid one after that reads valid again, on both hosts')
  },

  'stop-state-unwritten': () => {
    // A turn with a valid answer on record, resumed by another Stop hook, stops again with a changed
    // failing message whose state cannot be written: a directory where state.json belongs fails the
    // write for any user. The earlier valid state must not stand for close.
    const host = 'codex'
    const { id, tag } = admittedSeat(host)
    const session = randomUUID()
    const key = randomUUID()
    context(guard('prompt', host, promptCall(host, session, tag, { turn_id: key })), 'bind')
    silent(guard('pre', host, preCall(host, session, 'Bash', { command: 'ls' }, { turn_id: key })), 'receipt')
    silent(guard('stop', host, stopCall(host, session, JSON.stringify(ENVELOPE_OK), key)), 'a valid first stop')
    assert.equal(store.readStamp(id, 'void'), null, 'a valid stop voided the record')
    const statePath = join(seats, id, 'state.json')
    const stateBytes = readFileSync(statePath)
    rmSync(statePath)
    mkdirSync(statePath)
    let run
    try { run = guard('stop', host, stopCall(host, session, 'resumed, then broke the answer', key)) } finally { rmSync(statePath, { recursive: true }); writeFileSync(statePath, stateBytes) }
    silent(run, 'a stop whose state cannot be written')
    assert.match(run.stderr, /^seat-guard: stop: /m, 'the failed write was not logged')
    assert.equal(store.readStamp(id, 'void')?.reason, 'stop-state-unwritten', 'the record was not stamped void')
    assert.equal(store.readState(id).outcome, 'valid', 'the restored state no longer reads the earlier valid stop')
    const out = closeSeat(id)
    assert.equal(out.verdict, 'unknown', JSON.stringify(out))
    assert.ok(out.reasons.some((reason) => /stop-state-unwritten/.test(reason)), JSON.stringify(out.reasons))
    ok('a stop that cannot write its turn state stamps the record void (stop-state-unwritten), so close reads unknown rather than the earlier valid stop')
  },

  'stop-timeout': () => {
    const schema = { type: 'object', required: ['x'], properties: { x: { type: 'string', pattern: '^(a+)+$' } } }
    const record = seatRecord('claude', { access: 'read-only', worktree, repoRoot: worktree })
    const { id } = store.writeRecord(record, schema)
    assert.equal(admit(id), true)
    const session = randomUUID()
    context(guard('prompt', 'claude', promptCall('claude', session, store.seatTag(id))), 'bind')
    const started = performance.now()
    const reason = stopBlocked(guard('stop', 'claude', stopCall('claude', session, JSON.stringify({ ...ENVELOPE_OK, answer: { x: `${'a'.repeat(40)}!` } }), randomUUID())), 'a check that never ends')
    const took = performance.now() - started
    assert.match(reason, /^\$\.answer: the schema check did not finish in 10 seconds$/m)
    assert.equal(store.readState(id).outcome, 'blocked')
    assert.equal(store.readResult(id, 1), null)
    assert.ok(took >= 10_000 && took < 30_000, `the stop took ${took} ms`)
    ok(`an answer whose schema check runs past CHECK_SECONDS is a failed stop, blocked with the timeout line, inside the 30 s hook timeout (${(took / 1000).toFixed(1)} s)`)
  },

  'stop-served-models': () => {
    const { id, session } = boundSeat('codex', 'read-only')
    silent(guard('stop', 'codex', stopCall('codex', session, JSON.stringify(ENVELOPE_OK), randomUUID(), { model: 'gpt-6-astra' })), 'codex served model')
    assert.deepEqual(store.readResult(id, 1).body.servedModels, ['gpt-6-astra'])
    ok('a Codex seat\'s served model is the model its Stop call names')

    const claude = boundSeat('claude', 'read-only')
    const boundAt = Date.parse(store.readStamp(claude.id, 'bound').at)
    const at = (offset) => new Date(boundAt + offset).toISOString()
    const transcript = join(tmp, `${claude.session}.jsonl`)
    const entry = (fields) => JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', cwd: worktree, sessionId: claude.session, version: '2.1.288', uuid: randomUUID(), ...fields })
    writeFileSync(transcript, [
      entry({ type: 'assistant', timestamp: at(-60_000), message: { role: 'assistant', model: 'claude-before-bind', content: [] } }),
      entry({ type: 'user', timestamp: at(10), promptId: randomUUID(), message: { role: 'user', content: 'task' } }),
      entry({ type: 'assistant', timestamp: at(20), message: { role: 'assistant', model: MODELS.claude, content: [{ type: 'text', text: 'working' }] } }),
      entry({ type: 'assistant', timestamp: at(30), message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }),
      entry({ type: 'assistant', timestamp: at(40), sessionId: randomUUID(), message: { role: 'assistant', model: 'claude-other-session', content: [] } }),
      '{"type":"assistant", torn line',
      entry({ type: 'assistant', timestamp: at(50), message: { role: 'assistant', model: 'claude-haiku-5', content: [] } }),
      entry({ type: 'assistant', timestamp: at(60), message: { role: 'assistant', model: MODELS.claude, content: [] } }),
      JSON.stringify({ type: 'last-prompt', leafUuid: randomUUID(), sessionId: claude.session }),
    ].join('\n'))
    silent(guard('stop', 'claude', stopCall('claude', claude.session, JSON.stringify(ENVELOPE_OK), randomUUID(), { transcript_path: transcript })), 'claude served models')
    assert.deepEqual(store.readResult(claude.id, 1).body.servedModels, [MODELS.claude, 'claude-haiku-5'])
    ok('a Claude seat\'s served models are every assistant message.model its transcript records for the session since the bind, in first-seen order, with <synthetic>, other sessions, earlier entries and torn lines left out')

    // Every stop adds the models it saw to the seat's cumulative set, a stop on a settled turn with
    // the same message included, and close judges the whole set across turns.
    const received = (seat, host) => assert.equal(store.stamp(seat.id, 'receipt', { tool: 'Bash' }), true, `${host} receipt`)
    const earlier = boundSeat('codex', 'read-only')
    received(earlier, 'codex')
    silent(guard('stop', 'codex', stopCall('codex', earlier.session, JSON.stringify(ENVELOPE_OK), randomUUID(), { model: 'gpt-6-mini' })), 'turn 1 on another model')
    silent(guard('stop', 'codex', stopCall('codex', earlier.session, JSON.stringify({ ...ENVELOPE_OK, notes: 'turn 2' }), randomUUID())), 'turn 2 on the record\'s model')
    assert.deepEqual(store.readState(earlier.id).models, ['gpt-6-mini', MODELS.codex])
    const earlierOut = closeSeat(earlier.id)
    assert.equal(earlierOut.verdict, 'model-mismatch', JSON.stringify(earlierOut))
    assert.ok(earlierOut.reasons.some((reason) => /gpt-6-mini/.test(reason)), JSON.stringify(earlierOut.reasons))

    const repeated = boundSeat('codex', 'read-only')
    received(repeated, 'codex')
    const repeatKey = randomUUID()
    silent(guard('stop', 'codex', stopCall('codex', repeated.session, JSON.stringify(ENVELOPE_OK), repeatKey)), 'a valid stop')
    silent(guard('stop', 'codex', stopCall('codex', repeated.session, JSON.stringify(ENVELOPE_OK), repeatKey, { model: 'gpt-6-mini' })), 'the same message again, on another model')
    assert.deepEqual(store.readState(repeated.id).models, [MODELS.codex, 'gpt-6-mini'])
    assert.equal(closeSeat(repeated.id).verdict, 'model-mismatch', 'a model seen on a repeated stop was dropped')

    const replaced = boundSeat('codex', 'read-only')
    received(replaced, 'codex')
    const replacedKey = randomUUID()
    silent(guard('stop', 'codex', stopCall('codex', replaced.session, JSON.stringify(ENVELOPE_OK), replacedKey, { model: 'gpt-6-mini' })), 'a valid stop on another model')
    silent(guard('stop', 'codex', stopCall('codex', replaced.session, JSON.stringify({ ...ENVELOPE_OK, notes: 'changed' }), replacedKey)), 'a changed valid stop on the record\'s model')
    assert.deepEqual(store.readResult(replaced.id, 1).body.servedModels, [MODELS.codex])
    assert.equal(closeSeat(replaced.id).verdict, 'model-mismatch', 'a changed message dropped the model of the result it replaced')

    const unseen = boundSeat('claude', 'read-only')
    received(unseen, 'claude')
    silent(guard('stop', 'claude', stopCall('claude', unseen.session, JSON.stringify(ENVELOPE_OK), randomUUID())), 'a Claude stop with no readable transcript')
    const unseenOut = closeSeat(unseen.id)
    assert.equal(unseenOut.verdict, 'unknown', JSON.stringify(unseenOut))
    assert.ok(unseenOut.reasons.some((reason) => /no served model/.test(reason)), JSON.stringify(unseenOut.reasons))

    const fine = boundSeat('codex', 'read-only')
    received(fine, 'codex')
    silent(guard('stop', 'codex', stopCall('codex', fine.session, JSON.stringify(ENVELOPE_OK), randomUUID())), 'a valid stop')
    silent(guard('stop', 'codex', stopCall('codex', fine.session, messageWith('turn 2'), randomUUID())), 'turn 2')
    const fineOut = closeSeat(fine.id, taskStatusOf(fine.id, { summary: messageWith('turn 2') }))
    assert.deepEqual([fineOut.verdict, fineOut.servedModels], ['valid', [MODELS.codex]], JSON.stringify(fineOut))
    ok('every stop adds the models it saw to a cumulative set in the turn state, a repeated message on a settled turn included, and close reads model-mismatch when any turn saw another model, unknown when none was seen, and valid when every one is the record\'s')
  },

  'stop-void': () => {
    for (const host of ['claude', 'codex']) {
      const { id, tag } = admittedSeat(host)
      const session = randomUUID()
      assert.match(context(guard('prompt', host, promptCall(host, session, tag, { permission_mode: 'bypassPermissions' })), 'void bind'), /void seat/)
      silent(guard('stop', host, stopCall(host, session, 'not an envelope', randomUUID())), `${host} void seat stop`)
      assert.equal(store.readState(id), null, 'a void seat wrote turn state')
    }
    ok('a void seat\'s stop is never blocked and records nothing, on both hosts')
  },

  'stop-non-seat': () => {
    const fresh = join(tmp, 'stop-non-seat-state')
    for (const host of ['claude', 'codex']) {
      silent(guard('stop', host, stopCall(host, randomUUID(), 'plain prose, no envelope', randomUUID()), { env: { FLOW_DELEGATION_STATE_DIR: fresh } }), `${host} non-seat stop`)
      silent(guard('stop', host, stopCall(host, '../escape', 'x', randomUUID()), { env: { FLOW_DELEGATION_STATE_DIR: fresh } }), `${host} invalid session id`)
    }
    assert.equal(existsSync(fresh), false, 'a non-seat stop wrote seat state')
    ok('a non-seat session\'s stop, or one whose session id fails validation, gets no answer and writes nothing, on both hosts')
  },

}

await runSection('stop', cases)
