// Seat smoke section: bind-guard. Run via `node test/flow/smoke-seat.mjs` or directly.
import { assert, spawn, spawnSync, createHash, randomUUID, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, createServer, performance, DatabaseSync, tmpdir, dirname, join, fileURLToPath, pathToFileURL, PLUGIN, STORE, tmp, state, t3Home, store, wire, seatPolicy, RETENTION_MS, schemas, ok, sha256, mode, seats, INSTANCE, RECORD, SCHEMA, ENVELOPE_OK, racer, race, GUARD, guard, silent, denied, blocked, context, stopBlocked, MODELS, PERMISSION, SPELLING, call, stopCall, promptCall, preCall, EFFORT_OPTION, delegateInput, seatRecord, admit, admittedSeat, worktree, ACCESSES, boundSeat, seatCall, editCalls, indexEntries, SEAT_SCRIPT, jobs, seatCli, fakeCodexBin, OWN_HOOKS, installedRoot, FAKE_ROOT, treeDigest, DRIFTED_ROOT, snake, flowEntries, FOREIGN, codexState, codexSent, codexHooks, flowDigest, trustedCodex, T3_TABLES, T3_INDEXES, t3Store, t3, T3_SESSION, T3_OWNER, t3Time, taskIdOf, childThreadOf, runIdOf, t3TaskRow, t3RunRow, t3MessageRow, t3Forget, t3Seat, MESSAGE_OK, taskStatusOf, t3Status, closeSeat, oneRunTask, writerSeat, recordFiles, refusedClose, gitEnv, gitOut, canon, baseSha, headSha, linkedWt, gitWorktree, jobRecord, hookedSeat, guardedSeat, messageWith, rootedCodexSeat, holderGate, jobGate, stampGate, scanGate, heldChildren, heldAt, waitFor, leaseRacer, leaseRace, runSection } from './helpers.mjs'

const cases = {
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
      assert.ok(text.includes(`\`answer\` must match this JSON Schema:\n${JSON.stringify(SCHEMA)}`), 'the bind did not carry the answer schema')
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
    ok(`a tagged first prompt binds on Claude (permission_mode ${PERMISSION.claude}) and Codex (${PERMISSION.codex}): index and bound stamp written, the override, envelope and answer schema injected, and the first seat call stamps the receipt once`)

    const writer = admittedSeat('claude', { access: 'workspace-write', worktree: '/r/.flow-worktrees/w' })
    const writerText = context(guard('prompt', 'claude', promptCall('claude', randomUUID(), writer.tag)), 'writer bind')
    assert.ok(writerText.includes('git -C /r/.flow-worktrees/w commit -m <message> -- <paths>'), writerText)
    assert.match(writerText, /"commits": \[\{"sha": "<sha>", "subject": "<subject>"\}\]\}/)
    const review = admittedSeat('codex', { access: 'review', worktree: '/r/.flow-worktrees/review-x', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) })
    const reviewText = context(guard('prompt', 'codex', promptCall('codex', randomUUID(), review.tag)), 'review bind')
    assert.ok(reviewText.includes(`base ${'a'.repeat(40)}, head ${'b'.repeat(40)}`), reviewText)
    assert.ok(!reviewText.includes('commits'), 'a review was told to report commits')
    const bare = seatRecord('claude')
    const { id: bareId } = store.writeRecord(bare, null)
    assert.equal(admit(bareId), true)
    const bareText = context(guard('prompt', 'claude', promptCall('claude', randomUUID(), store.seatTag(bareId))), 'schemaless bind')
    assert.match(bareText, /this seat has no answer schema/)
    ok('a writer seat is told its worktree, the git -C commit form and the commits field; a review seat its base and head; a seat with no schema is told so')
  },

  'bind-schema-budget': () => {
    // Codex delivers the prompt hook's context under a 6000-token limit, so the seat context inlines
    // the answer schema only while the whole context is at most 6000 UTF-8 bytes.
    const LIMIT = 6000
    const bindWith = (host, description) => {
      const schema = { ...SCHEMA, description }
      const record = seatRecord(host)
      const { id } = store.writeRecord(record, schema)
      assert.equal(admit(id), true)
      return { id, schema, text: context(guard('prompt', host, promptCall(host, randomUUID(), store.seatTag(id))), `${host} bind`) }
    }
    for (const host of ['claude', 'codex']) {
      const small = bindWith(host, '')
      assert.ok(small.text.endsWith(`\`answer\` must match this JSON Schema:\n${JSON.stringify(small.schema)}`), small.text)
      // Every seat id and path in the fixture has one length, so the context grows byte for byte
      // with the description from here.
      const room = LIMIT - Buffer.byteLength(small.text)
      const fits = bindWith(host, 'a'.repeat(room))
      assert.equal(Buffer.byteLength(fits.text), LIMIT)
      assert.ok(fits.text.endsWith(JSON.stringify(fits.schema)), 'a context of exactly 6000 bytes did not inline the schema')
      ok(`${host}: a small schema is inlined, and so is one that brings the context to exactly ${LIMIT} bytes`)

      for (const [what, description] of [['one byte over', 'a'.repeat(room + 1)], ['multi-byte, under 6000 characters', 'é'.repeat(room)]]) {
        const big = bindWith(host, description)
        const path = join(seats, big.id, 'schema.json')
        assert.ok(!big.text.includes(description), `${what}: the schema was inlined`)
        assert.ok(Buffer.byteLength(big.text) <= LIMIT, `${what}: the context is ${Buffer.byteLength(big.text)} bytes`)
        assert.ok(big.text.includes(path), `${what}: the context does not name ${path}: ${big.text}`)
        assert.match(big.text, /Read that file before you write your final message/)
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), big.schema, `${what}: the path named is not the record's schema`)
        if (what.startsWith('multi')) assert.ok(`${small.text}${description}`.length <= LIMIT, 'the multi-byte fixture is not under 6000 characters')
      }
      ok(`${host}: a schema that would take the context past ${LIMIT} bytes, by one byte or in multi-byte characters under ${LIMIT} characters, is replaced by the record's schema.json path, and the context stays within ${LIMIT} bytes`)
    }
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

    // T3 0.1.11 delivers a delegate_task task to the child behind a provenance banner and an empty line.
    for (const host of ['claude', 'codex']) {
      const { id, tag } = admittedSeat(host)
      const session = randomUUID()
      const body = `[T3 Code: the agent in T3 thread "${randomUUID()}" sent this message, not the user.]\n\n${tag}\nWorktree: none`
      assert.match(context(guard('prompt', host, promptCall(host, session, body)), `${host} banner bind`), new RegExp(`Seat ${id}:`))
      assert.deepEqual(store.readIndex(host, session), { id })
      assert.equal(store.readStamp(id, 'bound').sessionId, session)
    }
    ok('a tag on line 1 of the task behind T3\'s provenance banner binds on Claude and Codex')
  },

  'echoed-tag-of-bound-seat-ignored': () => {
    // T3 names a delegated task by its text when it has no title, so a t3_thread_send wake hands
    // the parent a task-notification that quotes the child's task, seat tag and all. This is the
    // body observed on 2026-10-23: one wake with the title absent, so the child's task text sits
    // inside the parentheses. The tag opens line 1 after the "(", line 2 is the task's second line
    // followed by the closing ")" and the status, and line 3 opens the fenced json result.
    const notification = (tag) => {
      const taskId = `node:delegated-task:command%3Amcp%3A${randomUUID()}%3Athread-send%3A${randomUUID()}`
      return `Delegated task ${taskId} (${tag}\nWorktree: /home/u/repo/.flow-worktrees/repo-issue-1) [completed]:\n\`\`\`json`
    }
    const listing = (id) => [readdirSync(seats).sort(), readdirSync(join(seats, id)).sort(), indexEntries()]
    const turnKey = (host, key) => (host === 'claude' ? { prompt_id: key } : { turn_id: key })
    const voided = (host, session, body, what) => {
      assert.match(context(guard('prompt', host, promptCall(host, session, body)), what), /tag-not-on-line-1/, what)
      assert.deepEqual(store.readIndex(host, session), { id: null, void: 'tag-not-on-line-1' }, what)
    }
    for (const host of ['claude', 'codex']) {
      const child = boundSeat(host, 'read-only')
      const tag = store.seatTag(child.id)
      // The fixture has to keep the observed position: the tag on line 1, after text, never a whole line.
      const observed = notification(tag).split('\n')
      assert.equal(observed.length, 3, 'the observed notification has three lines')
      assert.ok(observed[0].endsWith(` (${tag}`) && observed[0].startsWith('Delegated task '), 'the tag sits on line 1 after the opening parenthesis')
      assert.notEqual(observed[0].trim(), tag, 'line 1 is not a whole tag')
      assert.ok(!observed[1].includes(tag) && !observed[2].includes(tag), 'the tag appears on line 1 only')
      assert.match(observed[1], /^Worktree: .*\) \[completed\]:$/)
      assert.equal(observed[2], '```json')
      for (const [what, body] of [['observed notification', notification(tag)], ['tag alone on line 2', `The child finished.\n${tag}`]]) {
        const parent = randomUUID()
        const before = listing(child.id)
        silent(guard('prompt', host, promptCall(host, parent, body)), `${host} ${what}`)
        assert.equal(store.readIndex(host, parent), null, `${host} ${what}: the waking session was indexed`)
        assert.equal(store.readStamp(child.id, 'void'), null, `${host} ${what}: the child's record was voided`)
        assert.deepEqual(listing(child.id), before, `${host} ${what}: seat state changed`)
        assert.deepEqual(store.readIndex(host, child.session), { id: child.id }, `${host} ${what}: the child's binding moved`)
        silent(guard('pre', host, preCall(host, parent, 'Bash', { command: 'git status' })), `${host} ${what}: the parent's next tool call`)
      }
      ok(`${host}: a prompt that quotes the tag of a seat bound to another session, inside a T3 task-notification or alone on line 2, is an ordinary prompt: no answer, no index entry, no void stamp, no seat state written`)

      // Controls: anything short of every displaced tag naming a seat bound elsewhere voids as today.
      const unbound = admittedSeat(host)
      voided(host, randomUUID(), `The child finished.\n${unbound.tag}`, `${host} unbound admitted seat`)
      assert.equal(store.readStamp(unbound.id, 'void'), null, `${host}: a quoted unbound tag stamped its record void`)
      voided(host, randomUUID(), notification(store.seatTag(store.newId())), `${host} absent seat`)
      const malformed = store.writeRecord(seatRecord(host), SCHEMA).id
      assert.equal(store.stamp(malformed, 'bound', { sessionId: child.session }), true)
      voided(host, randomUUID(), `x\n${store.seatTag(malformed)}`, `${host} bound stamp without a host`)
      const self = boundSeat(host, 'read-only')
      voided(host, self.session, notification(store.seatTag(self.id)), `${host} the seat's own session`)
      voided(host, randomUUID(), `${notification(tag)}\n${store.seatTag(store.newId())}`, `${host} bound elsewhere plus an absent seat`)
      const fresh = admittedSeat(host)
      voided(host, randomUUID(), `${fresh.tag}\n${notification(tag)}`, `${host} a line-1 tag with an echo below it`)
      assert.equal(store.readStamp(fresh.id, 'bound'), null, `${host}: a line-1 tag with extras bound its seat`)
      assert.equal(store.readStamp(child.id, 'void'), null, `${host}: a control voided the child's record`)
      ok(`${host}: a quoted tag of an unbound or absent seat, of a seat whose bound stamp names no host, of the seat this session holds, or beside an absent seat's tag voids as today, and so does a line-1 tag with an echo below it`)

      // A parent that is itself a bound seat gets its follow-up turn recorded, as for any untagged prompt.
      const parent = boundSeat(host, 'read-only')
      const key = randomUUID()
      silent(guard('prompt', host, promptCall(host, parent.session, notification(tag), turnKey(host, key))), `${host} bound parent`)
      assert.equal(store.readState(parent.id).opened, key, `${host}: the bound parent's turn was not recorded`)
      assert.deepEqual(store.readIndex(host, parent.session), { id: parent.id })
      ok(`${host}: a bound seat woken by another seat's echo records the turn it opens and stays bound`)
    }
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
      // A file where the index directory belongs fails every index write with ENOTDIR, even for
      // root, which permission bits would not stop.
      const byId = join(seats, 'by-session')
      const aside = `${byId}.aside`
      mkdirSync(byId, { recursive: true })
      renameSync(byId, aside)
      writeFileSync(byId, '')
      let run
      try { run = guard('prompt', host, promptCall(host, randomUUID(), tag)) } finally { rmSync(byId, { force: true }); renameSync(aside, byId) }
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

  'bind-admission-digest': () => {
    const voidBind = (host, id, reason, what) => {
      const session = randomUUID()
      const text = context(guard('prompt', host, promptCall(host, session, store.seatTag(id))), what)
      assert.match(text, /void seat/, what)
      assert.ok(text.includes(reason), `${what}: ${text}`)
      assert.deepEqual(store.readIndex(host, session), { id, void: reason }, what)
      assert.equal(store.readStamp(id, 'bound'), null, `${what}: the record was bound`)
      assert.equal(store.readStamp(id, 'void').reason, reason, what)
      denied(guard('pre', host, preCall(host, session, 'Bash', { command: 'pwd' })), new RegExp(`void seat \\(${reason}\\)`), `${what}: a child call`)
      denied(guard('pre', host, preCall(host, session, 'Read', { file_path: '/r/a' })), /void seat/, `${what}: a child read`)
      assert.equal(store.readStamp(id, 'receipt'), null, `${what}: a void seat stamped a receipt`)
    }
    for (const host of ['claude', 'codex']) {
      // The parent's own gate admits the record, which is then rewritten to the same fields in
      // other bytes: the digest the admission pinned no longer matches.
      const record = seatRecord(host)
      const { id } = store.writeRecord(record, SCHEMA)
      silent(guard('pre', host, preCall(host, randomUUID(), SPELLING[host], delegateInput(record, id))), `${host} admission`)
      const admitted = store.readStamp(id, 'admitted').recordDigest
      const path = join(seats, id, 'record.json')
      writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))))
      assert.notEqual(store.readRecord(id).digest, admitted)
      voidBind(host, id, 'admission-digest-mismatch', `${host} a record rewritten after its admission`)

      const edited = store.writeRecord(seatRecord(host), SCHEMA).id
      assert.equal(admit(edited), true)
      const editedPath = join(seats, edited, 'record.json')
      writeFileSync(editedPath, JSON.stringify({ ...JSON.parse(readFileSync(editedPath, 'utf8')), effort: 'low' }, null, 2) + '\n')
      voidBind(host, edited, 'admission-digest-mismatch', `${host} a record whose effort changed after its admission`)

      const unpinned = store.writeRecord(seatRecord(host), SCHEMA).id
      assert.equal(store.stamp(unpinned, 'admitted', { toolUseId: 'toolu_parent', clientRequestId: `flow-seat-${unpinned}` }), true)
      voidBind(host, unpinned, 'admission-digest-mismatch', `${host} an admitted stamp with no recordDigest`)

      const other = store.writeRecord(seatRecord(host), SCHEMA).id
      assert.equal(admit(other, { recordDigest: 'f'.repeat(64) }), true)
      voidBind(host, other, 'admission-digest-mismatch', `${host} an admitted stamp pinning other bytes`)
    }
    ok('a bind whose record bytes are not the ones the admitted stamp pinned, rewritten after the gate admitted it or admitted with no or another recordDigest, is void on both hosts: no bound stamp, and every later child call denied')
  },

  'bind-custom-host': () => {
    const glm = { providerInstanceId: 'glm', model: 'accounts/fireworks/routers/glm-5p3-us', expectedServedModel: 'accounts/fireworks/models/glm-5p3' }
    const record = seatRecord('claude', glm)
    const { id, digest } = store.writeRecord(record, SCHEMA)
    silent(guard('pre', 'codex', preCall('codex', randomUUID(), SPELLING.codex, delegateInput(record, id))), 'a Codex parent admits a glm seat')
    const session = randomUUID()
    const text = context(guard('prompt', 'claude', promptCall('claude', session, store.seatTag(id))), 'glm bind on claude')
    assert.match(text, new RegExp(`Seat ${id}:`))
    assert.deepEqual(store.readIndex('claude', session), { id })
    assert.equal(store.readStamp(id, 'bound').recordDigest, digest)
    silent(guard('pre', 'claude', preCall('claude', session, 'Bash', { command: 'pwd' })), 'the glm seat\'s first call')
    ok('a claude-family seat on a custom instance binds on a Claude host, whichever host admitted it')

    const off = admittedSeat('claude', glm)
    const codexSession = randomUUID()
    assert.match(context(guard('prompt', 'codex', promptCall('codex', codexSession, off.tag)), 'glm bind on codex'), /host-mismatch/)
    assert.deepEqual(store.readIndex('codex', codexSession), { id: off.id, void: 'host-mismatch' })
    assert.equal(store.readStamp(off.id, 'bound'), null)
    ok('a claude-family seat on a custom instance started on a Codex host is void (host-mismatch): its provider names the host, not the vendor')
  },

  'bind-context-routing-private': () => {
    // The seat context names the provider family and the model the call asked for; the instance
    // and the expected served id are routing facts the seat has no use for, so two records apart
    // only in those read the same context, whether the schema is inlined or named by path.
    const id = store.newId()
    const plain = { ...seatRecord('claude', { model: 'accounts/fireworks/routers/glm-5p3-us' }), id }
    const routed = { ...plain, providerInstanceId: 'routed-instance-7', expectedServedModel: 'accounts/fireworks/models/glm-5p3' }
    const big = { ...SCHEMA, description: 'b'.repeat(7000) }
    for (const [schema, what] of [[SCHEMA, 'inline'], [big, 'by path'], [null, 'none']]) {
      const a = seatPolicy.seatContext(plain, schema, '/s/schema.json')
      const b = seatPolicy.seatContext(routed, schema, '/s/schema.json')
      assert.equal(b, a, `${what}: the context differs`)
      assert.ok(!b.includes('routed-instance-7') && !b.includes('accounts/fireworks/models/glm-5p3'), `${what}: the context names a routing fact`)
    }
    assert.ok(seatPolicy.seatContext(routed, big, '/s/schema.json').includes('/s/schema.json'), 'the big schema was not named by path')
    assert.match(seatPolicy.seatContext(routed, SCHEMA, '/s/schema.json'), /Claude Code declines MCP elicitations in this seat/, 'a claude record\'s context lacks the elicitation clause')
    ok('seatContext is byte for byte the same for records apart only in instance and expected served id, with an inline schema, a schema named by path and none')

    const seat = admittedSeat('claude', { providerInstanceId: 'routed-instance-7', model: 'accounts/fireworks/routers/glm-5p3-us', expectedServedModel: 'accounts/fireworks/models/glm-5p3' })
    const text = context(guard('prompt', 'claude', promptCall('claude', randomUUID(), seat.tag)), 'routed bind')
    assert.match(text, new RegExp(`Seat ${seat.id}:`))
    assert.ok(!text.includes('routed-instance-7'), 'the bind context names the instance')
    assert.ok(!text.includes('accounts/fireworks/models/glm-5p3'), 'the bind context names the expected served id')
    ok('a real bind of a routed seat injects neither its instance id nor its expected served id')
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
      ['cd /r && git push --force-with-lease', /\(no git push\)/], ['bash -c "git push"', /\(no git push\)/], ['\\git push', /\(no git push\)/],
      ['/usr/bin/git -c x=y push', /\(no git push\)/],
      ['gh auth status --show-token', /\(gh reads only\)/], ['gh auth status -t', /\(gh reads only\)/], ['gh auth status -ht github.com', /\(gh reads only\)/],
      ['gh auth --show-token=true status', /\(gh reads only\)/], ['gh --show-token=true auth status', /\(gh reads only\)/], ['gh -t auth status', /\(gh reads only\)/],
      ['gh pr create --title t --body b', /\(gh reads only\)/], [['gh -R o/r pr', 'merge 3'].join(' '), /\(gh reads only\)/], ['gh issue comment 4 --body x', /\(gh reads only\)/],
      ['gh release create v1', /\(gh reads only\)/], ['gh repo delete o/r --yes', /\(gh reads only\)/],
      ['gh pr checkout 3', /\(gh reads only\)/], ['gh secret set TOKEN', /\(gh reads only\)/], ['gh variable set X', /\(gh reads only\)/],
      ['gh run rerun 12', /\(gh reads only\)/], ['gh run cancel 12', /\(gh reads only\)/], ['gh workflow run ci.yml', /\(gh reads only\)/],
      ['gh label create bug', /\(gh reads only\)/], ['gh auth token', /\(gh reads only\)/], ['gh co 3', /\(gh reads only\)/], ['gh', /\(gh reads only\)/],
      ['gh pr "view" 3', /\(gh reads only\)/],
      ['gh api -X POST repos/o/r/issues', /\(gh reads only\)/], ['gh api --method=PATCH repos/o/r', /\(gh reads only\)/], ['gh api --method DELETE repos/o/r', /\(gh reads only\)/],
      ['gh api repos/o/r/issues -f title=x', /\(gh reads only\)/], ['gh api graphql -F n=1', /\(gh reads only\)/], ['gh api repos/o/r --input body.json', /\(gh reads only\)/],
      ['gh api repos/o/r --raw-field=a=b', /\(gh reads only\)/], ['gh api -X "POST" repos/o/r', /\(gh reads only\)/],
      ['git remote add up https://x/y', /\(git (?:read|write) allowlist\)/], ['git submodule update --init', /\(git (?:read|write) allowlist\)/],
      ['git update-index --assume-unchanged a.txt', /\(git (?:read|write) allowlist\)/], ['git co main', /\(git (?:read|write) allowlist\)/],
      ['git config user.name x', /\(git (?:read|write) allowlist\)/], ['git clone https://x/y', /\(git (?:read|write) allowlist\)/],
      ['git init /tmp/x', /\(git (?:read|write) allowlist\)/], ['git branch new-one', /\(git (?:read|write) allowlist\)/],
    ]
    const allowed = [
      'echo "git push"', 'echo \'codex exec\'', 'printf "%s" "gh pr create"', 'cat <<\'E\'\ngit push\ngh pr create\nE', 'ls -la', 'node --version',
      'git status', 'git log --oneline -5', 'git diff HEAD~1', 'git show HEAD', 'git branch --show-current', 'git branch -a', 'git branch --contains HEAD',
      'git branch --list "feat/*"', 'git tag', 'git tag -l "v*"', 'git remote', 'git remote -v', 'git config --get user.name', 'git config --list',
      'git worktree list', 'git reflog', 'git reflog show HEAD', 'git --version', 'git -C /r rev-parse HEAD', 'git ls-files', 'git rev-list --count HEAD',
      'gh pr view 3', 'gh pr list --search "create"', 'gh pr checks 3', 'gh pr diff 3', 'gh issue view 4 --comments', 'gh run view 12 --log', 'gh workflow list',
      'gh release list', 'gh repo view o/r', 'gh label list', 'gh gist list', 'gh search prs --author x', 'gh auth status', 'gh --version', 'gh -R o/r pr view 3',
      'gh api repos/o/r/pulls', 'gh api repos/x', 'gh api -X GET repos/o/r', 'gh api --method get repos/o/r', 'gh api "repos/o/r/pulls?per_page=1&page=2"',
    ]
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { session } = boundSeat(host, access)
        for (const [command, pattern] of refused) denied(seatCall(host, session, 'Bash', { command }), pattern, `${host} ${access} ${command}`)
        for (const command of allowed) silent(seatCall(host, session, 'Bash', { command }), `${host} ${access} ${command}`)
        denied(seatCall(host, session, 'Bash', { command: 7 }), /\(shell\)/, `${host} ${access} an unreadable command`)
      }
    }
    ok('every seat on both hosts is denied git push, any gh but its reads (pr checkout, secret, run rerun, workflow run, label create and gh api with a non-GET method or a field included), and any git off the read allowlist (remote add, submodule, update-index, an alias); git and gh reads run')
  },

  'bash-gh-api-clusters': () => {
    const refused = ['gh api -iXDELETE repos/o/r', 'gh api -if title=x repos/o/r/issues', 'gh api -XPOST repos/o/r', 'gh api -XGET repos/o/r', 'gh api repos/o/r -iFx=1']
    const allowed = ['gh api -i repos/o/r', 'gh api -X GET -i repos/o/r', 'gh api --paginate repos/o/r/pulls', 'gh api -H "Accept: x" repos/o/r']
    for (const host of ['claude', 'codex']) {
      const { session } = boundSeat(host, 'read-only')
      for (const command of refused) denied(seatCall(host, session, 'Bash', { command }), /\(gh api separate flags\)/, `${host} ${command}`)
      for (const command of allowed) silent(seatCall(host, session, 'Bash', { command }), `${host} ${command}`)
    }
    ok('a gh api call with clustered short flags (-iXDELETE, -if, -XPOST, even -XGET) is denied in every seat; each flag written apart runs')
  },

  'bash-model-cli': () => {
    const refused = [
      'codex exec "fix it"', 'claude -p "hi"', 'flow-delegate --help', '/home/u/.local/bin/flow-delegate run', 'X=1 codex', '\\codex exec',
      'env X=1 codex', 'env -i PATH=/bin codex', 'exec codex', 'nohup codex exec x', 'timeout 5 codex', 'timeout -s KILL 5m claude -p x',
      'nice -n 5 codex', 'xargs -n1 codex < list', 'npx codex', 'npx -y @openai/codex@latest exec x', 'bunx codex', 'pnpx codex', 'npm exec codex', 'npm x codex',
      'npm exec -- codex', 'npx -c codex', 'sh -c \'claude -p x\'', 'bash -c "codex exec"', 'zsh -c "codex exec"', 'bash -lc codex', 'eval "codex exec"',
      'ls && codex exec x', 'ls | codex', 'ls\ncodex', 'builtin codex', 'env -S codex\\ exec',
    ]
    const allowed = ['which codex', 'ls dir/codex', 'echo codex', 'cat codex.md', 'grep -r claude .', 'type flow-delegate', 'echo "$(which codex)"', 'git log --grep codex', 'command -v codex', 'command -pv claude']
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { session } = boundSeat(host, access)
        for (const command of refused) denied(seatCall(host, session, 'Bash', { command }), /\(no model through the shell\)/, `${host} ${access} ${command}`)
        for (const command of allowed) silent(seatCall(host, session, 'Bash', { command }), `${host} ${access} ${command}`)
      }
    }
    ok('claude, codex and flow-delegate are denied in command position, behind env, exec, nohup, timeout, nice, xargs, builtin, npx, bunx, pnpx, npm exec and a shell, and in a string a shell or eval runs; which codex, command -v codex, ls dir/codex and echo codex run')
  },

  'bash-seat-executor': () => {
    const script = join(PLUGIN, 'scripts', 'seat.mjs')
    const refused = [
      `node ${script} open --access read-only --provider claude --model m --effort high`, `node ${script} close ${'a'.repeat(32)}`,
      'node scripts/seat.mjs trust', 'node --no-warnings ./seat.mjs close x', `env FOO=1 node ${script} close x`, 'cd /x && node seat.mjs open',
      `bash -c "node ${script} close x"`, `timeout 30 /usr/bin/node ${script} trust --write`,
    ]
    const allowed = [`cat ${script}`, `node ${join(PLUGIN, 'scripts', 'smoke-seat.mjs')} --case-prefix x`, 'node -e 1', 'grep -n seat.mjs README.md', 'node scripts/seat.mjsx']
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { session } = boundSeat(host, access)
        for (const command of refused) denied(seatCall(host, session, 'Bash', { command }), /\(no seat executor\)/, `${host} ${access} ${command}`)
        for (const command of allowed) silent(seatCall(host, session, 'Bash', { command }), `${host} ${access} ${command}`)
      }
    }
    ok('no seat runs node on a script named seat.mjs, by any path and behind a wrapper or a shell string, so a seat neither opens nor closes a seat; reading the file or running another script is allowed')
  },

  'bash-background': () => {
    const refused = [
      'sleep 60 &', 'npm test & echo started', 'make&', 'nohup node server.js &', 'nohup node server.js > out.log 2>&1 &', '(sleep 5; ls) &',
      'bash -c \'sleep 9 &\'', 'setsid node server.js', 'setsid -f ls', 'ls; disown', 'env setsid ls', 'sudo setsid ls',
      'coproc git push origin HEAD', 'coproc codex exec t', 'coproc sleep 60', 'ls; coproc { sleep 60; }', 'env coproc ls',
    ]
    const allowed = [
      'ls && echo ok', 'ls 2>&1 | head', 'ls &>/dev/null', 'ls >&2', 'cat <&0', 'ls |& cat', 'echo "a & b"', 'gh api "repos/o/r/pulls?a=1&b=2"',
      'nohup node -e 1', 'cat <<\'E\'\nrun me &\nE', 'echo a\\&b',
    ]
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { session } = boundSeat(host, access)
        for (const command of refused) denied(seatCall(host, session, 'Bash', { command }), /\(no background\)/, `${host} ${access} ${command}`)
        for (const command of allowed) silent(seatCall(host, session, 'Bash', { command }), `${host} ${access} ${command}`)
        denied(seatCall(host, session, 'Bash', { command: 'npm test', run_in_background: true }), /\(no background\)/, `${host} ${access} run_in_background`)
        silent(seatCall(host, session, 'Bash', { command: 'npm test', run_in_background: false }), `${host} ${access} run_in_background false`)
      }
    }
    ok('every seat is denied a lone & (in a string a shell runs too), setsid, disown, coproc and Bash run_in_background; &&, 2>&1, &>, >&2, <&0, |& and an & in quoted text or a heredoc body run, and nohup runs as a wrapper in the foreground')
  },

  'bash-not-writer': () => {
    const refused = [
      'git commit -m x -- a.txt', `git -C ${worktree} commit -m x -- a.txt`, 'git add a.txt', `git -C ${worktree} add a.txt`, 'git checkout main', 'git switch -c x',
      'git restore a.txt', 'git reset --hard', 'git branch -D x', 'git branch --move a b', 'git branch -df x', 'git tag v1', 'git fetch', 'git pull',
      'git config user.name x', 'git config set user.name x', 'git config --unset user.name', 'git config user.name', 'git worktree add ../x',
      'git update-ref refs/heads/x HEAD', 'git clean -n', 'git remote show origin', 'git reflog expire --all', 'git apply p.diff',
    ]
    const allowed = ['git status', 'git log', 'git diff', 'git show HEAD', 'git branch', 'git branch -a', 'git config --get user.name', 'git config --list', 'git -C /r rev-parse HEAD', `git -C ${worktree} log -1`]
    for (const host of ['claude', 'codex']) {
      for (const access of ['read-only', 'review']) {
        const { session } = boundSeat(host, access)
        for (const command of refused) denied(seatCall(host, session, 'Bash', { command }), new RegExp(`\\(git read allowlist\\): .* this ${access} seat writes nothing`), `${host} ${access} ${command}`)
        for (const command of allowed) silent(seatCall(host, session, 'Bash', { command }), `${host} ${access} ${command}`)
      }
    }
    ok('a read-only or review seat runs only the git read allowlist, -C or not, and is denied every other subcommand, including a config read without --get or --list')
  },

  'bash-wrappers': () => {
    const refused = [
      ['sudo codex exec x', /\(no model/], ['sudo -u root -- git push', /\(no git push\)/], ['sudo -E X=1 claude -p x', /\(no model/],
      ['command codex', /\(no model/], ['command -p git push', /\(no git push\)/], ['time -p codex', /\(no model/], ['/usr/bin/time -f %e -o t.log codex', /\(no model/],
      ['stdbuf -oL -e 0 codex exec x', /\(no model/], ['builtin command git push', /\(no git push\)/], ['builtin exec gh pr create', /\(gh reads only\)/],
      ['env -S git\\ push', /\(no git push\)/], ['nice -n 5 timeout 9 env git push', /\(no git push\)/], ['xargs -I {} git push', /\(no git push\)/],
    ]
    const allowed = ['command -v codex', 'command -V git', 'command -pv claude', 'sudo -l', 'time -p ls', 'stdbuf -oL git log', 'builtin cd /tmp', 'env', 'nohup']
    for (const host of ['claude', 'codex']) {
      for (const access of ['read-only', 'workspace-write']) {
        const { session } = boundSeat(host, access)
        for (const [command, pattern] of refused) denied(seatCall(host, session, 'Bash', { command }), pattern, `${host} ${access} ${command}`)
        for (const command of allowed) silent(seatCall(host, session, 'Bash', { command }), `${host} ${access} ${command}`)
      }
    }
    ok('sudo, command, builtin, time, stdbuf, env (-S included), nice, timeout and xargs are followed, chained, to the command they run; command -v is a lookup')
  },

  'bash-keywords': () => {
    const push = /\(no git push\)/
    const model = /\(no model/
    const refused = [
      ['(git push origin HEAD)', push], ['( git push )', push], ['{ git push; }', push], ['if git push; then :; fi', push], ['while codex exec x; do :; done', model],
      ['until git push; do :; done', push], ['if :; then git push; else :; fi', push], ['if :; then :; else git push; fi', push], ['if :; then :; elif git push; then :; fi', push], ['for x in a; do git push; done', push],
      ['! git push', push], ['watch git push', push], ['watch -n 5 git push', push], ['eval git push', push],
      ['find . -exec git push \\;', push], ['find . -execdir codex exec x +', model], ['find . -ok git push \\;', push], ['find . -okdir git push {} +', push],
      ['find . -exec env git push \\;', push], ['nice find . -exec git push \\;', push],
    ]
    const allowed = [
      'if test -f x; then cat x; fi', '(cd /tmp && ls)', '(git status)', '( git log -1 )', '{ ls; }', "find . -name '*.mjs' -exec grep -l stateDir {} +", 'find . -exec echo {} \\;', 'find . -exec node -e 1 {} + -name seat.mjs',
      'watch -n1 ls', 'watch -n 1 git status', 'eval ls', 'while read x; do echo $x; done', '! test -f x', 'echo if then git push',
    ]
    for (const host of ['claude', 'codex']) {
      for (const access of ['read-only', 'workspace-write']) {
        const { session } = boundSeat(host, access)
        for (const [command, pattern] of refused) denied(seatCall(host, session, 'Bash', { command }), pattern, `${host} ${access} ${command}`)
        for (const command of allowed) silent(seatCall(host, session, 'Bash', { command }), `${host} ${access} ${command}`)
      }
    }
    ok('the command word is read past if, then, else, elif, do, while, until, !, a group\'s ( or { and watch and eval, and into the command after find -exec, -execdir, -ok or -okdir; a command that merely sits in the keyword\'s place runs')
  },

  'bash-git-overrides': () => {
    const config = /\(git configuration\)/
    const output = /\(git output\)/
    const refused = [
      ['git -c core.pager=x log', config], ['git -c diff.external=x diff', config], ['git -ccore.pager=x log', config],
      ['git --config-env=core.pager=P log', config], ['git --config-env core.pager=P show', config], ['git -c x=y', config],
      ['GIT_PAGER=x git log', config], ['GIT_EXTERNAL_DIFF=x git diff', config], ['export GIT_EXTERNAL_DIFF=x; git diff', config],
      ['export GIT_DIR; git log', config], ['env GIT_CONFIG_COUNT=1 git status', config], ['GIT_CONFIG_PARAMETERS="x" git log', config],
      ['git log --output=/tmp/x', output], ['git diff --output /tmp/x', output], ['git show --outp=/tmp/x HEAD', output],
      ['git diff --ext-diff', output], ['git log -p --ext-diff', output], [`git -C ${worktree} diff --ext-diff`, output],
      ['git grep -O less x', output], ['git grep -Oless x', output], ['git grep -nO x', output], ['git grep --open-files-in-pager=less x', output], ['git grep --open x', output],
    ]
    const allowed = ['git diff --no-ext-diff', 'echo $GIT_DIR; git log', 'git log --oneline', 'git diff --output-indicator-new=+ HEAD', 'GIT_X=1 ls', `git -C ${worktree} log -1`,
      "git log 'HEAD~1'", 'git log "HEAD~$N"', "git diff '--stat'", 'git log --grep="fix it"', "gh api 'repos/o/r/pulls'", 'gh api "repos/$REPO/pulls"', 'git grep -n x']
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { session } = boundSeat(host, access)
        for (const [command, pattern] of refused) denied(seatCall(host, session, 'Bash', { command }), pattern, `${host} ${access} ${command}`)
        for (const command of allowed) silent(seatCall(host, session, 'Bash', { command }), `${host} ${access} ${command}`)
      }
    }
    ok('every seat, reads included, is denied git with -c, --config-env, a GIT_* variable set or exported in the same command, --output, --ext-diff, -O or --open-files-in-pager (or an abbreviation); a $GIT_* reference and --no-ext-diff run')
  },

  'bash-stash': () => {
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { session } = boundSeat(host, access)
        for (const command of ['git stash', 'git stash list', 'git stash pop', `git -C ${worktree} stash`, `git -C ${worktree} stash push -m x -- a.txt`, 'git stash show -p']) {
          denied(seatCall(host, session, 'Bash', { command }), /\(no git stash\)/, `${host} ${access} ${command}`)
        }
      }
    }
    ok('git stash is denied in every seat, list and -C writer forms included, because every worktree of the repository shares the stash stack')
  },

  'bash-accepted-gaps': () => {
    // The class-B forms this guardrail does not catch, asserted allowed so that the gap stays
    // explicit and a change to it is deliberate. Native seats run Bash under the same posture.
    const accepted = [
      "'git' push origin HEAD", 'g\\it push', "$'\\x67\\x69\\x74' push", '/usr/bin/g[i]t push', '{g..g}it push',
      "source /dev/stdin <<< 'git push'", 'echo "$(git push)"', 'printf x > /outside/file',
    ]
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { session } = boundSeat(host, access)
        for (const command of accepted) silent(seatCall(host, session, 'Bash', { command }), `${host} ${access} accepted gap ${command}`)
      }
    }
    ok('the accepted gaps stay allowed in every seat: a quoted, escaped, ANSI-C, globbed or brace-built command word, source from stdin, a command substitution, and a Bash write outside the worktree')
  },

  'bash-writer': () => {
    const escaped = worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const form = (sub) => new RegExp(`\\(git -C the worktree\\): a git write in this seat runs only as \`git -C ${escaped} ${sub}`)
    const commitForm = form('commit -m <message> -- <paths>`')
    const byPath = /\(commit by path\)/
    const addByPath = /\(add by path\)/
    const refused = [
      ['git commit -m x', commitForm],
      ['git commit -m x -- a.txt', commitForm],
      [`cd ${worktree} && git add a.txt`, form('add \\.\\.\\.`')],
      [`git -C ${worktree}/ add a.txt`, form('add')], [`git -C ${worktree}-x add a.txt`, form('add')],
      [`git -C "${worktree}" add a.txt`, /\(git -C the worktree\)|\(git write allowlist\)/],
      [`git -C ${worktree} --git-dir=/x commit -m x -- a.txt`, commitForm], [`git -C ${worktree} --work-tree /x add a.txt`, form('add')],
      [`git -C ${worktree} -C ${worktree} add a.txt`, form('add')], [`git -C ${worktree} -c user.name=x commit -m x -- a.txt`, /\(git configuration\)/],
      [`GIT_DIR=/x/.git git -C ${worktree} commit -m x -- a.txt`, /\(git configuration\)/], [`export GIT_WORK_TREE=/x; git -C ${worktree} add a.txt`, /\(git configuration\)/],
      [`git -C ${worktree} commit -m x`, byPath], [`git -C ${worktree} commit -m "a b"`, byPath], [`git -C ${worktree} commit -am x -- a.txt`, byPath],
      [`git -C ${worktree} commit --all -m x`, byPath], [`git -C ${worktree} commit -m "a b" --`, byPath], [`git -C ${worktree} commit -m "a b" -a`, byPath],
      [`git -C ${worktree} commit --pathspec-from-file=list -m x`, byPath], [`git -C ${worktree} commit -m "x" -i a.txt`, byPath],
      [`git -C ${worktree} commit --include -m x -- owned.txt`, byPath], [`git -C ${worktree} commit -i -m x -- owned.txt`, byPath],
      [`git -C ${worktree} commit --incl -m x -- owned.txt`, byPath], [`git -C ${worktree} commit --mess x`, byPath], [`git -C ${worktree} commit --amend --no-edit`, byPath],
      [`git -C ${worktree} commit -m x >/tmp/commit.log`, byPath], [`git -C ${worktree} commit -m x 2>/tmp/err`, byPath],
      [`git -C ${worktree} commit -m x > /tmp/commit.log`, byPath], [`git -C ${worktree} commit -m x >>log`, byPath],
      [`git -C ${worktree} commit -m x &>log`, byPath], [`git -C ${worktree} commit -m x >&log`, byPath], [`git -C ${worktree} commit -m x <in`, byPath],
      [`git -C ${worktree} commit -m x 2>&-`, byPath], [`git -C ${worktree} commit -F - <<'E'\nfeat: x\nE`, byPath], [`git -C ${worktree} commit -m x >`, byPath],
      [`git -C ${worktree} add -A`, addByPath], [`git -C ${worktree} add --all`, addByPath], [`git -C ${worktree} add -u`, addByPath], [`git -C ${worktree} add --update`, addByPath],
      [`git -C ${worktree} add --renormalize`, addByPath], [`git -C ${worktree} add --no-ignore-removal`, addByPath], [`git -C ${worktree} add -fA`, addByPath],
      [`git -C ${worktree} add -A --`, addByPath], [`git -C ${worktree} add --upd`, addByPath],
      [`git -C ${worktree} apply --unsafe-paths p.diff`, /\(git apply in place\)/], [`git -C ${worktree} apply --directory=sub p.diff`, /\(git apply in place\)/],
      [`git -C ${worktree} apply --directory sub p.diff`, /\(git apply in place\)/], [`git -C ${worktree} apply --unsafe p.diff`, /\(git apply in place\)/],
      [`git -C ${worktree} push`, /\(no git push\)/],
    ]
    const allowlist = /\(git write allowlist\)/
    for (const command of [
      `git -C ${worktree} config --global user.name x`, `git -C ${worktree} config --file /tmp/x a.b c`, `git -C ${worktree} config user.name x`,
      `git -C ${worktree} worktree add ../x`, `git -C ${worktree} clone https://x/y`, `git -C ${worktree} init`, `git -C ${worktree} bundle create /tmp/b HEAD`,
      `git -C ${worktree} format-patch -o /tmp HEAD~1`, `git -C ${worktree} switch main`,
      `git -C ${worktree} checkout main`, `git -C ${worktree} branch -D old`, `git -C ${worktree} remote add up https://x/y`, `git -C ${worktree} reset --hard`,
      'git remote add up https://x/y', 'git submodule update', 'git update-index --assume-unchanged a.txt', 'git co main',
    ]) refused.push([command, allowlist])
    refused.push([`git -C ${worktree} archive --output=/tmp/a.tar HEAD`, /\(git output\)/])
    const allowed = [
      `git -C ${worktree} commit -m x -- a.txt`, `git -C ${worktree} commit -m "feat: x y" a.txt b.txt`, `git -C ${worktree} commit -F msg.txt -- a.txt`,
      `git -C ${worktree} commit -m "feat: x y" -- a.txt`, `git -C ${worktree} commit -m x --amend -- a.txt`, `git -C ${worktree} commit -mi -- a.txt`,
      `git -C ${worktree} commit -m x -- a.txt 2>&1 | tee log`, `git -C ${worktree} commit -F - -- a.txt <<'E'\nfeat: x\nE`,
      `git -C ${worktree} commit -m "$(cat <<'E'\nfeat: x\nE\n)" -- a.txt`,
      `git -C ${worktree} add a.txt`, `git -C ${worktree} add -- a.txt`, `git -C ${worktree} add -A -- a.txt`, `git -C ${worktree} add -u sub`,
      `git -C ${worktree} rm a.txt`, `git -C ${worktree} mv a.txt b.txt`,
      `git -C ${worktree} restore --staged a.txt`, `git -C ${worktree} apply p.diff`, `git -C ${worktree} apply --check p.diff`, `git -C ${worktree} remote -v`,
      'git status', 'git log --oneline', `git -C ${worktree} diff`, 'git branch',
    ]
    for (const host of ['claude', 'codex']) {
      const { session } = boundSeat(host, 'workspace-write')
      for (const [command, pattern] of refused) denied(seatCall(host, session, 'Bash', { command }), pattern, `${host} ${command}`)
      for (const command of allowed) silent(seatCall(host, session, 'Bash', { command }), `${host} ${command}`)
    }
    ok('a writer seat runs add, rm, mv, commit, restore and apply only as git -C <worktree realpath> with no override, commits only named paths (no -a, -i, --include, --amend without paths or abbreviation of them, and no redirection target read as a path), stages with -A, -u, --renormalize or --no-ignore-removal only beside named paths, applies with no --unsafe-paths or --directory, and is denied every other non-read git subcommand, config writes in any scope included')
  },

  'question-denied': () => {
    const NAMES = ['AskUserQuestion', 'request_user_input', 'request_user_input_async']
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { id, session } = boundSeat(host, access)
        assert.equal(store.readStamp(id, 'receipt'), null)
        denied(seatCall(host, session, NAMES[0], { questions: [] }), /\(no human questions\)/, `${host} ${access} ${NAMES[0]}`)
        assert.equal(store.readStamp(id, 'receipt')?.tool, NAMES[0], `${host} ${access}: the first deny did not stamp the receipt`)
        for (const name of NAMES.slice(1)) denied(seatCall(host, session, name, { questions: [] }), /\(no human questions\)/, `${host} ${access} ${name}`)
      }
      for (const name of NAMES) silent(guard('pre', host, preCall(host, randomUUID(), name, { questions: [] })), `${host} non-seat ${name}`)
    }
    ok('AskUserQuestion, request_user_input and request_user_input_async are denied in every seat on both hosts, the first deny stamps the receipt, and a session that is no seat gets no answer')

    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { id, session } = boundSeat(host, access)
        assert.equal(store.stamp(id, 'closed', { verdict: 'valid', reasons: [] }), true)
        for (const name of NAMES) denied(seatCall(host, session, name, {}), /this seat was closed/, `${host} ${access} ${name} after close`)
      }
      const { id } = store.writeRecord(seatRecord(host), SCHEMA)
      const session = randomUUID()
      context(guard('prompt', host, promptCall(host, session, `${store.seatTag(id)}\nwork`)), `${host} void bind`)
      for (const name of NAMES) denied(guard('pre', host, preCall(host, session, name, {})), /void seat/, `${host} void ${name}`)
    }
    ok('a closed seat and a void seat keep their own deny reason for a question call: the question rule comes after them')
  },

  'question-context': () => {
    const SENTENCE = 'Do not ask the human. When input you need is missing, report it and the incomplete work in the envelope.'
    const CLAUSE = 'Claude Code declines MCP elicitations in this seat; do not retry one to obtain approval.'
    for (const provider of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const record = { ...seatRecord(provider), id: store.newId(), access, worktree: '/r/w', ...(access === 'review' ? { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) } : {}) }
        for (const schema of [SCHEMA, null]) {
          const text = seatPolicy.seatContext(record, schema, '/s/schema.json')
          assert.ok(text.startsWith('The orchestrator half of the flow charter does not apply in this session'), text)
          assert.ok(text.includes(SENTENCE), `${provider} ${access}: no host-neutral sentence`)
          assert.equal(text.includes(CLAUSE), provider === 'claude', `${provider} ${access}: the Claude clause is ${provider === 'claude' ? 'missing' : 'present'}`)
          assert.ok(Buffer.byteLength(text) < 6000, `${provider} ${access}: ${Buffer.byteLength(text)} bytes`)
          assert.ok(text.indexOf(SENTENCE) < text.indexOf('Your final message is one JSON object'), 'the sentence follows the envelope paragraph')
        }
      }
    }
    ok('seatContext carries the no-human-questions sentence for every access, the Claude elicitation clause for claude records alone, starts with the orchestrator sentence and stays under 6000 bytes')
  },

  'resources-denied': () => {
    const NAMES = ['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { id, session } = boundSeat(host, access)
        assert.equal(store.readStamp(id, 'receipt'), null)
        denied(seatCall(host, session, NAMES[0], {}), /\(MCP resources\)/, `${host} ${access} ${NAMES[0]}`)
        assert.equal(store.readStamp(id, 'receipt')?.tool, NAMES[0], `${host} ${access}: the first deny did not stamp the receipt`)
        for (const name of NAMES.slice(1)) denied(seatCall(host, session, name, {}), /\(MCP resources\)/, `${host} ${access} ${name}`)
        assert.equal(store.readStamp(id, 'receipt')?.tool, NAMES[0], `${host} ${access}: a later call replaced the receipt`)
      }
    }
    for (const access of ACCESSES) {
      const record = { ...seatRecord('claude'), id: store.newId(), access, worktree, repoRoot: worktree }
      for (const name of NAMES) {
        const reason = seatPolicy.toolProblem({ record, toolName: name, toolInput: {}, cwd: worktree }, { patchPaths: () => null })
        assert.match(reason ?? '', /\(MCP resources\)/, `toolProblem ${access} ${name}`)
        assert.ok(reason.includes(name), `toolProblem ${access} ${name}: the reason does not name the tool`)
      }
    }
    for (const host of ['claude', 'codex']) {
      const { id, session } = boundSeat(host, 'read-only')
      denied(seatCall(host, session, NAMES[3], {}), /\(MCP resources\)/, `${host} first-call resource`)
      assert.equal(store.readStamp(id, 'receipt')?.tool, NAMES[3], `${host}: a resource call as the first pre call did not stamp the receipt`)
      denied(seatCall(host, session, NAMES[1], {}), /\(MCP resources\)/, `${host} second-call resource`)
      silent(seatCall(host, session, 'Read', { file_path: '/r/a' }), `${host} Read after a resource deny`)
      assert.equal(store.readStamp(id, 'receipt')?.tool, NAMES[3], `${host}: a later call replaced the receipt`)
    }
    ok('ListMcpResourcesTool, ReadMcpResourceTool, ReadMcpResourceDirTool, list_mcp_resources, list_mcp_resource_templates and read_mcp_resource are denied in every seat on both hosts under the MCP resources label, toolProblem says so for every access, and a resource call as the first pre call stamps the receipt, which a later call does not replace')
  },

  'resources-outside': () => {
    const NAMES = ['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']
    const fresh = join(tmp, 'resources-outside-state')
    for (const host of ['claude', 'codex']) {
      for (const name of NAMES) silent(guard('pre', host, preCall(host, randomUUID(), name, {}), { env: { FLOW_DELEGATION_STATE_DIR: fresh } }), `${host} non-seat ${name}`)
    }
    assert.equal(existsSync(fresh), false, 'a non-seat resource call wrote seat state')
    ok('a session that is no seat gets no answer for any of the six resource tool names on either host, and writes no state')
  },

  'resources-precedence': () => {
    const NAMES = ['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { id, session } = boundSeat(host, access)
        denied(seatCall(host, session, 'mcp__x__read_mcp_resource', {}), /\(MCP allowlist\)/, `${host} ${access} mcp__x__read_mcp_resource`)
        denied(seatCall(host, session, 'Agent', { prompt: 'x' }), /\(no spawns\)/, `${host} ${access} Agent`)
        denied(seatCall(host, session, 'AskUserQuestion', { questions: [] }), /\(no human questions\)/, `${host} ${access} AskUserQuestion`)
        for (const name of ['Read', 'Grep', 'ToolSearch', 'TaskOutput']) silent(seatCall(host, session, name, { file_path: '/r/a' }), `${host} ${access} ${name}`)
        assert.equal(store.stamp(id, 'closed', { verdict: 'valid', reasons: [] }), true)
        for (const name of NAMES) denied(seatCall(host, session, name, {}), /this seat was closed/, `${host} ${access} ${name} after close`)
      }
      const { id } = store.writeRecord(seatRecord(host), SCHEMA)
      const session = randomUUID()
      context(guard('prompt', host, promptCall(host, session, `${store.seatTag(id)}\nwork`)), `${host} void bind`)
      for (const name of NAMES) denied(guard('pre', host, preCall(host, session, name, {})), /void seat/, `${host} void ${name}`)
    }
    ok('a closed seat and a void seat keep their own deny reason for a resource call, mcp__x__read_mcp_resource keeps the MCP allowlist label, Agent and AskUserQuestion keep theirs, and Read, Grep, ToolSearch and TaskOutput stay allowed')
  },

  'closed-seat': () => {
    for (const host of ['claude', 'codex']) {
      for (const access of ACCESSES) {
        const { id, session } = boundSeat(host, access)
        silent(seatCall(host, session, 'Bash', { command: 'ls' }), `${host} ${access} open seat`)
        assert.equal(store.stamp(id, 'closed', { verdict: 'valid', reasons: [] }), true)
        for (const [name, input] of [['Bash', { command: 'ls' }], ['Read', { file_path: join(worktree, 'a.txt') }], ['Grep', { pattern: 'x' }], ['mcp__claude_ai_Context7__query-docs', { query: 'x' }]]) {
          denied(seatCall(host, session, name, input), /this seat was closed/, `${host} ${access} ${name} after close`)
        }
      }
    }
    ok('once a seat carries a closed stamp, every tool call in its session is denied, reads and allowlisted MCP included')
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
    // The builtins a hook process loaded, from process.moduleLoadList in an ESM preload: unlike the
    // resolve hook above, it sees the loads process.getBuiltinModule makes, which is how seat-store.mjs
    // reaches node:crypto. Each child writes its own trace file, and the file must parse to a
    // non-empty array of strings, so a trace that saw nothing fails instead of passing.
    const moduleTrace = join(tmp, 'fastpath-modules.mjs')
    writeFileSync(moduleTrace, `import { writeFileSync } from 'node:fs'
process.on('exit', () => { writeFileSync(process.env.SEAT_MODULES, JSON.stringify(process.moduleLoadList)) })
`)
    const builtins = (mode, host, input, childEnv) => {
      const out = join(tmp, `fastpath-modules-${randomUUID()}.json`)
      const run = guard(mode, host, input, { env: { ...childEnv, SEAT_MODULES: out }, nodeArgs: ['--import', pathToFileURL(moduleTrace).href] })
      assert.ok(existsSync(out), `${mode} ${host}: the module trace was never written`)
      const list = JSON.parse(readFileSync(out, 'utf8'))
      assert.ok(Array.isArray(list) && list.length > 0 && list.every((entry) => typeof entry === 'string'), `${mode} ${host}: the module trace is not a non-empty array of strings`)
      return Object.assign(list, { run })
    }
    // The positive control: a real bind of an admitted seat, in a state directory of its own, loads
    // node:crypto and shows it as NativeModule crypto, so the absence asserted below means something.
    for (const host of ['claude', 'codex']) {
      const control = join(tmp, `fastpath-control-${host}`)
      const outer = process.env.FLOW_DELEGATION_STATE_DIR
      process.env.FLOW_DELEGATION_STATE_DIR = control
      let seat
      try { seat = admittedSeat(host, { access: 'read-only', worktree, repoRoot: worktree }) } finally { if (outer === undefined) delete process.env.FLOW_DELEGATION_STATE_DIR; else process.env.FLOW_DELEGATION_STATE_DIR = outer }
      const bound = builtins('prompt', host, promptCall(host, randomUUID(), seat.tag), { FLOW_DELEGATION_STATE_DIR: control })
      context(bound.run, `${host} control bind`)
      assert.ok(bound.includes('NativeModule crypto'), `${host}: the seat-path bind never showed NativeModule crypto, so the trace proves nothing`)
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
      assert.ok(!loaded('stop', host, stopCall(host, session, 'done', randomUUID())).includes('seat-policy.mjs'), 'a non-seat stop loaded the policy')
      const nonSeat = builtins('pre', host, preCall(host, session, 'Read', { file_path: '/r/a' }), env)
      silent(nonSeat.run, `${host} non-seat Read traced`)
      assert.deepEqual(nonSeat.filter((entry) => /crypto/i.test(entry)), [], 'a non-seat tool call loaded node:crypto')
      const plain = { task: 'Summarise the README.', role: 'general', runtimeMode: 'auto', target: { providerInstanceId: 'codex', model: MODELS.codex } }
      assert.ok(loaded('pre', host, preCall(host, session, SPELLING[host], plain)).includes('seat-policy.mjs'), 'the delegate_task gate never loaded the policy, so the trace proves nothing')
    }
    assert.equal(existsSync(fresh), false, 'a non-seat session wrote seat state')
    ok('a non-seat session on either host, with or without a tag-like string, an unreadable body, or an untagged delegate_task, gets no answer, writes no state, never loads node:crypto, and never loads seat-policy.mjs outside the gate')
  },

}

await runSection('bind-guard', cases)
