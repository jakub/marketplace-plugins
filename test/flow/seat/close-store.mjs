// Seat smoke section: close-store. Run via `node test/flow/smoke-seat.mjs` or directly.
import { assert, spawn, spawnSync, createHash, randomUUID, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, createServer, performance, DatabaseSync, tmpdir, dirname, join, fileURLToPath, pathToFileURL, PLUGIN, STORE, tmp, state, t3Home, store, wire, seatPolicy, RETENTION_MS, schemas, ok, sha256, mode, seats, INSTANCE, RECORD, SCHEMA, ENVELOPE_OK, racer, race, GUARD, guard, silent, denied, blocked, context, stopBlocked, MODELS, PERMISSION, SPELLING, call, stopCall, promptCall, preCall, EFFORT_OPTION, delegateInput, seatRecord, admit, admittedSeat, worktree, ACCESSES, boundSeat, seatCall, editCalls, indexEntries, SEAT_SCRIPT, jobs, seatCli, fakeCodexBin, OWN_HOOKS, installedRoot, FAKE_ROOT, treeDigest, DRIFTED_ROOT, snake, flowEntries, FOREIGN, codexState, codexSent, codexHooks, flowDigest, trustedCodex, T3_TABLES, T3_INDEXES, t3Store, t3, T3_SESSION, T3_OWNER, t3Time, taskIdOf, childThreadOf, runIdOf, t3TaskRow, t3RunRow, t3MessageRow, t3Forget, t3Seat, MESSAGE_OK, taskStatusOf, t3Status, closeSeat, oneRunTask, writerSeat, recordFiles, refusedClose, gitEnv, gitOut, canon, baseSha, headSha, linkedWt, gitWorktree, jobRecord, hookedSeat, guardedSeat, messageWith, rootedCodexSeat, holderGate, jobGate, stampGate, scanGate, heldChildren, heldAt, waitFor, leaseRacer, leaseRace, runSection } from './helpers.mjs'

const cases = {
  'close-store-single-run': () => {
    const writerWt = gitWorktree('close-store-single-run')
    const seat = hookedSeat({ id: seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', writerWt]).id })
    const holder = join(jobs.leaseDirOf(writerWt), `${seat.id}.live`)
    assert.ok(existsSync(holder))
    const { taskId, thread } = t3Seat(seat.id, [{ texts: [seat.message] }])
    const out = seatCli(['close', seat.id])
    assert.deepEqual([out.verdict, out.reasons, out.turn, out.result], ['valid', [], 1, ENVELOPE_OK], JSON.stringify(out))
    const stamped = store.readStamp(seat.id, 'closed')
    assert.deepEqual(stamped.task, {
      taskId, ownerThreadId: T3_OWNER, childThreadId: thread, status: 'completed', childRunId: runIdOf(thread, 1), latestRunId: runIdOf(thread, 1),
      latestRunStatus: 'completed', latestTextSha256: sha256(seat.message), closerThreadId: null, t3Migration: 76,
    })
    assert.deepEqual([stamped.runId, stamped.messageSha256, Object.hasOwn(stamped, 'taskStatus')], [runIdOf(thread, 1), sha256(seat.message), false])
    assert.equal(existsSync(holder), false, 'close kept the writer\'s holder')
    ok('close <id> with nothing else closes a single-run seat valid from T3\'s store, and the closed stamp records the task block derived from its rows (childRunId, latestRunId, latestTextSha256 among them) and no task status')
  },

  'close-store-runs': () => {
    const derived = (id) => {
      const { runId, task } = store.readStamp(id, 'closed')
      return [runId, task.childRunId, task.latestRunId, task.latestRunStatus, task.latestTextSha256]
    }
    const closeAs = (seat, verdict, reasons, what) => {
      const out = seatCli(['close', seat.id])
      assert.deepEqual([out.verdict, out.reasons], [verdict, reasons], `${what}: ${JSON.stringify(out)}`)
      return out
    }
    const runOf = (id, ordinal) => runIdOf(childThreadOf(id), ordinal)

    // The dc elision: one run whose final message is not the text Stop recorded.
    const elided = '(design sheet elided in this local copy; full text in the T3 thread)'
    const dc = hookedSeat({})
    t3Seat(dc.id, [{ texts: [elided] }])
    closeAs(dc, 'unknown', ['stale-turn'], 'the dc elision')
    assert.deepEqual(derived(dc.id), [runOf(dc.id, 1), runOf(dc.id, 1), runOf(dc.id, 1), 'completed', sha256(elided)])
    ok('a run whose newest assistant message is not the text Stop recorded (the dc elision) closes unknown (stale-turn), and the stamp records that text\'s digest')

    // A follow-up the hooks recorded, then T3's run 2 completed with that turn's text.
    const second = messageWith('run 2, recorded')
    const followed = guardedSeat()
    silent(followed.stop(second, followed.followUp()), 'turn 2 stop')
    t3Seat(followed.id, [{ texts: [MESSAGE_OK] }, { texts: [second] }])
    assert.deepEqual([closeAs(followed, 'valid', [], 'a recorded follow-up').turn, derived(followed.id)], [2, [runOf(followed.id, 2), runOf(followed.id, 1), runOf(followed.id, 2), 'completed', sha256(second)]])
    const unprompted = guardedSeat()
    t3Seat(unprompted.id, [{ texts: [MESSAGE_OK] }, { texts: [MESSAGE_OK] }])
    closeAs(unprompted, 'unknown', ['stale-turn'], 'a completed follow-up with no opened key')
    assert.deepEqual(derived(unprompted.id), [runOf(unprompted.id, 2), runOf(unprompted.id, 1), runOf(unprompted.id, 2), 'completed', sha256(MESSAGE_OK)])
    const failed = guardedSeat()
    silent(failed.stop(second, failed.followUp()), 'turn 2 stop')
    t3Seat(failed.id, [{ texts: [MESSAGE_OK] }, { status: 'failed', texts: [second] }])
    closeAs(failed, 'unknown', ['stale-turn'], 'a failed follow-up')
    assert.deepEqual(derived(failed.id), [runOf(failed.id, 2), runOf(failed.id, 1), runOf(failed.id, 2), 'failed', null])
    ok('a completed follow-up run with an opened key closes valid on turn 2; the same run with no opened key, even with turn 1\'s text, and a failed follow-up holding the recorded text, close unknown (stale-turn)')

    // The pinned false-valid shapes: an opened key, and run 1's text the digest Stop recorded, so
    // a reader that dropped run 2 would certify run 1.
    const reopened = () => {
      const seat = guardedSeat()
      silent(seat.stop(MESSAGE_OK, seat.followUp()), 'turn 2 repeats turn 1')
      assert.deepEqual([Object.hasOwn(store.readState(seat.id), 'opened'), store.readState(seat.id).messageSha256], [true, sha256(MESSAGE_OK)])
      return seat
    }
    const unstarted = reopened()
    const { thread } = t3Seat(unstarted.id, [{ texts: [MESSAGE_OK] }, { startedAt: null }])
    t3MessageRow(thread, runOf(unstarted.id, 2), 'Look again at b.txt and answer again.', { role: 'user' })
    const pinned = [
      ['a later run with a message and no startedAt', unstarted, 'completed'],
      ['a later rolled_back run', reopened(), 'rolled_back', [{ texts: [MESSAGE_OK] }, { status: 'rolled_back', texts: [MESSAGE_OK] }]],
      ['a later run with startedAt and no message', reopened(), 'completed', [{ texts: [MESSAGE_OK] }, {}]],
    ]
    for (const [what, seat, status, runs] of pinned) {
      if (runs) t3Seat(seat.id, runs)
      closeAs(seat, 'unknown', ['stale-turn'], what)
      assert.deepEqual(derived(seat.id), [runOf(seat.id, 2), runOf(seat.id, 1), runOf(seat.id, 2), status, null], what)
    }
    ok('each pinned shape reads stale-turn with an opened key and run 1\'s text the recorded digest: a later run with a message but no startedAt, a later rolled_back run, a later run with startedAt but no message, and (above) a completed follow-up with no opened key')

    // Only a run with neither startedAt nor any message is dropped, and the child run is the
    // lowest that counts.
    const dropped = hookedSeat({})
    t3Seat(dropped.id, [{ texts: [MESSAGE_OK] }, { status: 'cancelled', startedAt: null }])
    closeAs(dropped, 'valid', [], 'a later run that never ran')
    assert.deepEqual(derived(dropped.id), [runOf(dropped.id, 1), runOf(dropped.id, 1), runOf(dropped.id, 1), 'completed', sha256(MESSAGE_OK)])
    const late = hookedSeat({})
    t3Seat(late.id, [{ status: 'cancelled', startedAt: null }, { texts: [MESSAGE_OK] }])
    closeAs(late, 'valid', [], 'a first run that never ran')
    assert.deepEqual(derived(late.id), [runOf(late.id, 2), runOf(late.id, 2), runOf(late.id, 2), 'completed', sha256(MESSAGE_OK)])
    ok('a run with neither startedAt nor a message is dropped, after the child run or before it, so the child run is the lowest run that ran')

    // A finished task with no run that ran still closes, so a writer's lease is released.
    const empty = writerSeat('close-store-runs-empty')
    t3Seat(empty.id, [{ status: 'cancelled', startedAt: null }])
    closeAs(empty, 'unknown', ['stale-turn'], 'a task with no run that ran')
    assert.deepEqual(derived(empty.id), [null, null, null, null, null])
    assert.equal(existsSync(empty.holder), false, 'the close kept the writer\'s holder')
    ok('a finished task with no run that ran closes unknown (stale-turn) with null run ids and no text, and releases the writer\'s lease holder')
  },

  'close-store-text-order': () => {
    const at = (second) => new Date(Date.UTC(2026, 10, 4, 13, 0, second)).toISOString()
    // A seat whose turn state holds final's digest, with one completed run and no messages yet.
    const seatWith = (final, fields = {}) => {
      const seat = hookedSeat({ message: final })
      const { thread } = t3Seat(seat.id, [{}], fields)
      return { ...seat, thread, run: runIdOf(thread, 1) }
    }
    const closeAs = (seat, verdict, reasons, what) => {
      const out = seatCli(['close', seat.id])
      assert.deepEqual([out.verdict, out.reasons], [verdict, reasons], `${what}: ${JSON.stringify(out)}`)
    }
    // Message ids are global in T3's store, so each carries its seat's id; tail sets its order.
    const idOf = (seat, tail) => `claudeAgent:native-item:${seat.id}-${tail}`
    const final = messageWith('the final answer')
    const older = messageWith('an older answer')

    // The b6463d44 shape: T3's turn items put the older text at the higher ordinal. The newest
    // message by created_at is the final one, though it was written first and its id sorts lower,
    // and the task's payload.result holds the older text.
    const shape = seatWith(final, { payload: { result: older } })
    t3MessageRow(shape.thread, shape.run, final, { at: at(10), messageId: idOf(shape, 'a') })
    t3MessageRow(shape.thread, shape.run, older, { at: at(5), messageId: idOf(shape, 'z') })
    t3MessageRow(shape.thread, shape.run, 'thinking about it', { at: at(7), messageId: idOf(shape, 'msg_1%3Athinking%3A1') })
    t3MessageRow(shape.thread, shape.run, 'Look again.', { role: 'user', at: at(20) })
    const item = (ordinal, text) => t3.prepare('insert into orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`turn-item:${randomUUID()}`, shape.thread, shape.run, ordinal, 'assistant_message', 'completed', at(30), JSON.stringify({ text }))
    item(1000510, final)
    item(1000511, older)
    closeAs(shape, 'valid', [], 'the b6463d44 shape')
    ok('the latest text is the newest assistant message by created_at, not the higher turn-item ordinal, the higher message id, the insertion order, payload.result, a newer user message or an older thinking row')

    const byUpdate = seatWith(final)
    t3MessageRow(byUpdate.thread, byUpdate.run, older, { at: at(10), updatedAt: at(11), messageId: idOf(byUpdate, 'z') })
    t3MessageRow(byUpdate.thread, byUpdate.run, final, { at: at(10), updatedAt: at(12), messageId: idOf(byUpdate, 'a') })
    closeAs(byUpdate, 'valid', [], 'one created_at, a later updated_at')
    const byId = seatWith(final)
    t3MessageRow(byId.thread, byId.run, final, { at: at(10), messageId: idOf(byId, 'b') })
    t3MessageRow(byId.thread, byId.run, older, { at: at(10), messageId: idOf(byId, 'a') })
    closeAs(byId, 'valid', [], 'one created_at and updated_at, a higher message id')
    ok('on one created_at the later updated_at wins, and on both the higher message_id')

    const thinking = seatWith(final)
    t3MessageRow(thinking.thread, thinking.run, final, { at: at(10) })
    t3MessageRow(thinking.thread, thinking.run, 'thinking after the answer', { at: at(11), messageId: idOf(thinking, 'msg_2%3Athinking%3A1') })
    closeAs(thinking, 'unknown', ['stale-turn'], 'a thinking row newer than the final message')
    ok('thinking rows are not filtered: one newer than the final message is the latest text, which can only read stale-turn')

    const wide = `résumé \u{1F600} "quoted" \\ back\tslash\n\u0001 `.repeat(400)
    const raw = seatWith(wide)
    t3MessageRow(raw.thread, raw.run, wide, { at: at(10) })
    closeAs(raw, 'valid', [], 'non-ASCII text, escapes and a control character')
    assert.equal(store.readStamp(raw.id, 'closed').task.latestTextSha256, sha256(wide))
    ok('a final message with non-ASCII text, JSON escapes and a control character is hashed as T3 stored it')
  },

  'close-store-not-terminal': () => {
    const seat = writerSeat('close-store-not-terminal')
    const refuse = (what, runs, task = {}) => {
      t3Seat(seat.id, runs, task)
      return refusedClose(seat, 'TASK_NOT_TERMINAL', what)
    }
    for (const status of ['preparing', 'queued', 'starting', 'running', 'waiting']) {
      const error = refuse(`a follow-up run ${status}`, [{ texts: [seat.message] }, { status }])
      assert.match(error.message, new RegExp(`a run in its thread is ${status}`))
    }
    refuse('a finished task whose one run is running', [{ status: 'running', texts: [seat.message] }])
    for (const status of ['idle', 'pending', 'running', 'waiting']) {
      const error = refuse(`a nested task ${status}`, [{ texts: [seat.message] }], { nested: ['completed', status] })
      assert.match(error.message, new RegExp(`a task it started is ${status}`))
    }
    for (const status of ['idle', 'pending', 'running', 'waiting']) {
      const error = refuse(`a task ${status} with no child thread yet`, [], { status, child: null })
      assert.match(error.message, new RegExp(`its task is ${status}`))
    }
    ok('a live follow-up run, a running run under a finished task row, a live nested task and a live task row (even one with no child thread yet) each refuse TASK_NOT_TERMINAL, writing nothing and keeping the writer\'s lease holder')

    t3Seat(seat.id, [{ texts: [seat.message] }], { nested: ['completed', 'failed', 'cancelled', 'interrupted'] })
    const out = seatCli(['close', seat.id])
    assert.deepEqual([out.verdict, existsSync(seat.holder)], ['valid', false], JSON.stringify(out))
    ok('once every run and nested task has ended, the same seat closes valid and drops its holder')
  },

  'close-store-moved': async () => {
    // T3 moves the task while close judges it: close is held after its first read and judge, a
    // follow-up run lands, and the second read must refuse rather than stamp the judged run valid.
    // A running run fails the read itself; a run that already completed fails only the comparison.
    const seat = writerSeat('close-store-moved')
    const moved = async (what, run, message) => {
      const { thread } = t3Seat(seat.id, [{ texts: [seat.message] }])
      const before = recordFiles(seat.id)
      const gate = join(tmp, `close-store-moved-${run.status}`)
      const held = await heldAt([SEAT_SCRIPT, 'close', seat.id], gate, 'reread')
      t3MessageRow(thread, t3RunRow(thread, 2, run), seat.message)
      writeFileSync(`${gate}.go`, '')
      const { code, out } = await held.done
      const refused = JSON.parse(out)
      assert.deepEqual([code === 0, refused.error?.kind], [false, 'TASK_NOT_TERMINAL'], `${what}: ${out}`)
      assert.match(refused.error.message, message, what)
      assert.deepEqual(recordFiles(seat.id), before, `${what} changed the record directory`)
      assert.equal(store.readStamp(seat.id, 'closed'), null, `${what} stamped the seat closed`)
      assert.ok(existsSync(seat.holder), `${what} released the writer's lease holder`)
    }
    await moved('a run started while close judged', { status: 'running' }, /a run in its thread is running/)
    await moved('a run started and completed while close judged', { status: 'completed' }, /changed while close judged/)
    ok('a follow-up run T3 adds while close judges, running or already completed, makes close refuse TASK_NOT_TERMINAL at its second read, writing nothing and keeping the lease holder')

    // A follow-up the hooks open while close judges, before T3 projects its run row: the store holds
    // still, and only the turn state the prompt hook wrote moves.
    const hooked = guardedSeat()
    t3Status(hooked.id)
    const gate = join(tmp, 'close-store-moved-hooked')
    const held = await heldAt([SEAT_SCRIPT, 'close', hooked.id], gate, 'reread')
    hooked.followUp()
    writeFileSync(`${gate}.go`, '')
    const hookedClose = await held.done
    const hookedOut = JSON.parse(hookedClose.out)
    assert.deepEqual([hookedClose.code === 0, hookedOut.error?.kind], [false, 'TASK_NOT_TERMINAL'], hookedClose.out)
    assert.match(hookedOut.error.message, /changed while close judged/)
    assert.equal(store.readStamp(hooked.id, 'closed'), null, 'the hooked follow-up close stamped the seat closed')
    ok('a follow-up prompt the hooks record while close judges, with T3\'s rows unchanged, makes close refuse TASK_NOT_TERMINAL and stamp nothing')

    t3Seat(seat.id, [{ texts: [seat.message] }])
    const out = seatCli(['close', seat.id])
    assert.deepEqual([out.verdict, existsSync(seat.holder)], ['valid', false], JSON.stringify(out))
    ok('with the store held still, the same seat closes valid')
  },

  'close-store-identity': () => {
    // Rows that carry flow-seat-<id> and must never count as the seat's task, each running, so a
    // match would read TASK_NOT_TERMINAL rather than pass unseen.
    const decoys = (id) => [
      ['thread-send', `node:delegated-task:command%3Amcp%3A${T3_SESSION}%3Athread-send%3Aflow-seat-${id}-critique`],
      ['provider-continuation', `node:delegated-task:provider-continuation%3Amessage%3Athread%253Adelegated-task%253Acommand%25253Amcp%25253A${T3_SESSION}%25253Adelegate-task%25253Aflow-seat-${id}`],
      ['a LIKE wildcard', `node:delegated-task:command%3Amcp%3A${T3_SESSION}%3Adelegate-taskX3Aflow-seat-${id}`],
      ['lower-case escapes', `node:delegated-task:command%3amcp%3a${T3_SESSION}%3adelegate-task%3aflow-seat-${id}`],
      ['an upper-case session', `node:delegated-task:command%3Amcp%3A${T3_SESSION.toUpperCase()}%3Adelegate-task%3Aflow-seat-${id}`],
      ['36 characters that are no uuid', `node:delegated-task:command%3Amcp%3A${T3_SESSION.replaceAll('-', '')}abcd%3Adelegate-task%3Aflow-seat-${id}`],
      ['an extra segment', `node:delegated-task:command%3Amcp%3A${T3_SESSION}%3Aextra%3Adelegate-task%3Aflow-seat-${id}`],
      ['another seat id inside', `node:delegated-task:command%3Amcp%3A${T3_SESSION}%3Adelegate-task%3Aflow-seat-${id}${id.slice(0, 1)}`],
    ]
    const plant = (id) => {
      for (const [, taskId] of decoys(id)) t3TaskRow(id, { taskId, child: childThreadOf(id), status: 'running' })
    }
    const seat = writerSeat('close-store-identity')
    t3Forget(seat.id)
    plant(seat.id)
    const notFound = refusedClose(seat, 'TASK_NOT_FOUND', 'decoys alone')
    assert.match(notFound.message, /--abandon/)
    assert.match(notFound.message, /T3CODE_HOME/)
    const { taskId } = t3Seat(seat.id, [{ texts: [seat.message] }])
    plant(seat.id)
    const out = seatCli(['close', seat.id])
    assert.deepEqual([out.verdict, store.readStamp(seat.id, 'closed').task.taskId], ['valid', taskId], JSON.stringify(out))
    ok(`no ${decoys(seat.id).map(([what]) => what).join(', ')} decoy row is the seat's task: with them alone close refuses TASK_NOT_FOUND, writing nothing, and beside the real row it closes valid on that row`)

    // No row for a seat whose child bound, nor for one whose call was admitted and never bound.
    const bound = writerSeat('close-store-identity-bound')
    const unbound = admittedSeat('claude')
    for (const [what, each] of [['a bound seat', bound], ['an admitted seat that never bound', { ...unbound, holder: null }]]) {
      t3Forget(each.id)
      refusedClose(each, 'TASK_NOT_FOUND', what, { kept: each.holder })
    }
    assert.equal(seatCli(['close', unbound.id, '--abandon']).verdict, 'unknown')
    ok('a seat with no row that fits refuses TASK_NOT_FOUND whether or not it bound, writing nothing, and the unbound one then closes with --abandon')

    // Two rows fit: unknown (task-ambiguous) above any other verdict, once both are finished.
    const OTHER = 'a1b2c3d4-0000-4000-8000-00000000beef'
    const twins = (seat) => {
      t3Seat(seat.id, [{ texts: [seat.message] }])
      const other = t3TaskRow(seat.id, { session: OTHER })
      const thread = childThreadOf(seat.id, OTHER)
      t3MessageRow(thread, t3RunRow(thread, 1), seat.message)
      return [taskIdOf(seat.id), other].sort()
    }
    const live = writerSeat('close-store-identity-live')
    twins(live)
    t3TaskRow(live.id, { session: 'c0ffee00-0000-4000-8000-000000000001', status: 'running' })
    refusedClose(live, 'TASK_NOT_TERMINAL', 'two finished rows and a running one')
    const both = writerSeat('close-store-identity-twins')
    const taskIds = twins(both)
    for (const [what, seat, ids] of [['a writer', both, taskIds], ['a mismatched seat', hookedSeat({ served: ['claude-sonnet-5-5'] }), null], ['a void seat', hookedSeat({}), null]]) {
      if (what === 'a void seat') store.stamp(seat.id, 'void', { reason: 'r' })
      const expected = ids ?? twins(seat)
      const twin = seatCli(['close', seat.id])
      assert.deepEqual([twin.verdict, twin.reasons, twin.result], ['unknown', ['task-ambiguous'], null], `${what}: ${JSON.stringify(twin)}`)
      const stamped = store.readStamp(seat.id, 'closed')
      assert.deepEqual([stamped.task, stamped.runId, stamped.verdict], [{ ambiguous: true, taskIds: expected }, null, 'unknown'], what)
    }
    assert.equal(existsSync(both.holder), false, 'an ambiguous close kept the writer\'s holder')
    ok('two rows that fit, one still running, refuse TASK_NOT_TERMINAL; two finished ones close unknown (task-ambiguous) above valid, model-mismatch and another unknown, stamp both task ids and no run, and release the writer\'s holder')

    // An exact-grammar row another call made by reusing the seat's clientRequestId from a session
    // the gate never saw: its prompt lacks the tag on line 1, so it is never the seat's, running or
    // finished, alone or beside the real row.
    const untagged = [['no tag', 'Review the diff.'], ['the tag on line 2', `Review the diff.\n${store.seatTag('0'.repeat(32))}`], ['the tag after text on line 1', `x${store.seatTag('0'.repeat(32))}`]]
    const reused = writerSeat('close-store-identity-reused')
    const plantReused = (status) => {
      for (const [n, [, prompt]] of untagged.entries()) {
        const session = `d0d0d0d0-0000-4000-8000-00000000000${n}`
        t3TaskRow(reused.id, { session, status, payload: { prompt: prompt.replace('0'.repeat(32), reused.id) } })
        const thread = childThreadOf(reused.id, session)
        t3MessageRow(thread, t3RunRow(thread, 1), reused.message)
      }
    }
    t3Forget(reused.id)
    plantReused('completed')
    refusedClose(reused, 'TASK_NOT_FOUND', 'reused clientRequestId rows alone')
    const real = t3Seat(reused.id, [{ texts: [reused.message] }])
    plantReused('running')
    const reusedOut = seatCli(['close', reused.id])
    assert.deepEqual([reusedOut.verdict, store.readStamp(reused.id, 'closed').task.taskId], ['valid', real.taskId], JSON.stringify(reusedOut))
    ok(`an exact-grammar row whose prompt has ${untagged.map(([what]) => what).join(', ')} is not the seat's: alone, finished, close refuses TASK_NOT_FOUND, and running beside the real row it neither blocks nor makes the close ambiguous`)
  },

  'close-store-refusals': () => {
    const writer = writerSeat('close-store-refusals')
    const covering = { ...ENVELOPE_OK, answer: { findings: [] }, coverage: { read: ['a.txt', 'c.txt'], partial: [], unopened: [], checksRun: [] } }
    const opened = seatCli(['open', '--access', 'review', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--base', baseSha, '--head', headSha])
    const review = { ...hookedSeat({ id: opened.id, envelope: covering }), holder: opened.reviewWorktree }
    // The homes of their own: none, a relative one, a directory or a non-database where the store
    // belongs, a store missing a column or a table, and one a writer holds locked.
    const home = (name) => join(tmp, 't3-homes', name)
    mkdirSync(home('empty'), { recursive: true })
    mkdirSync(join(home('directory'), 'userdata', 'statev2.sqlite'), { recursive: true })
    mkdirSync(join(home('junk'), 'userdata'), { recursive: true })
    writeFileSync(join(home('junk'), 'userdata', 'statev2.sqlite'), 'not a database, '.repeat(64))
    t3Store(home('no-ordinal'), { without: ['orchestration_v2_projection_runs.ordinal'] }).close()
    t3Store(home('no-migrations'), { without: ['effect_sql_migrations'] }).close()
    const elsewhere = [
      ['a T3CODE_HOME with no store', home('empty'), 'T3_STORE', { cause: 'missing' }],
      ['a relative T3CODE_HOME', 't3', 'T3_STORE', { cause: 'missing' }],
      ['a directory where the store belongs', home('directory'), 'T3_STORE', { cause: 'missing' }],
      ['a file that is no database', home('junk'), 'T3_STORE', { cause: 'missing', code: 26 }],
      ['a store without runs.ordinal', home('no-ordinal'), 'T3_STORE', { cause: 'schema', missing: ['orchestration_v2_projection_runs.ordinal'] }],
      ['a store without effect_sql_migrations', home('no-migrations'), 'T3_STORE', { cause: 'schema', missing: ['effect_sql_migrations'] }],
    ]
    // What the shared store holds for the seat: rows close reads as a value T3 doesn't write.
    const values = (seat) => {
      const thread = childThreadOf(seat.id)
      const run = (fields, message = {}) => () => {
        t3Seat(seat.id, [])
        t3MessageRow(thread, t3RunRow(thread, 1, fields), seat.message, message)
      }
      return [
        ['a run status outside T3\'s', () => t3Seat(seat.id, [{ status: 'done', texts: [seat.message] }])],
        ['a task status outside T3\'s', () => t3Seat(seat.id, [{ texts: [seat.message] }], { status: 'Completed' })],
        ['a nested task status outside T3\'s', () => t3Seat(seat.id, [{ texts: [seat.message] }], { nested: ['stopped'] })],
        ['a finished task with no child thread', () => t3Seat(seat.id, [], { child: null })],
        ['a child thread not named after the task', () => t3Seat(seat.id, [], { child: childThreadOf(seat.id, T3_SESSION.replace('0b6c', '1b6c')) })],
        ['a run id whose thread is not encoded', run({ runId: `run:thread:${thread}:ordinal:1` })],
        ['a run id whose ordinal is not its column', run({ runId: runIdOf(thread, 2) })],
        ['a run payload that is no JSON', run({ payloadJson: '{"startedAt":' })],
        ['a run payload that is no object', run({ payloadJson: '[]' })],
        ['a message payload that is no object', run({}, { payloadJson: 'null' })],
        ['a task payload that is no object', () => {
          t3Seat(seat.id, [{ texts: [seat.message] }])
          t3.prepare('update orchestration_v2_projection_subagents set payload_json = ? where subagent_id = ?').run('[]', taskIdOf(seat.id))
        }],
        ['a task prompt that is no string', () => t3Seat(seat.id, [{ texts: [seat.message] }], { payload: { prompt: 7 } })],
        ['a message payload with no text', run({}, { payloadJson: JSON.stringify({ role: 'assistant' }) })],
        ['a message text that is no string', run({}, { payloadJson: JSON.stringify({ role: 'assistant', text: 7 }) })],
        ['a message time with other precision', run({}, { at: '2026-11-04T12:00:00Z' })],
        ['an updated_at with other precision', run({}, { updatedAt: '2026-11-04T12:00:00.0001Z' })],
        // node:sqlite throws ERR_OUT_OF_RANGE reading an integer past JavaScript's safe range.
        ['a run ordinal past 2^53', () => {
          t3Seat(seat.id, [])
          t3RunRow(thread, 9223372036854775807n, { payloadJson: JSON.stringify({ startedAt: t3Time() }) })
        }],
      ]
    }
    for (const seat of [writer, review]) {
      t3Seat(seat.id, [{ texts: [seat.message] }])
      for (const [what, t3Home, kind, details] of elsewhere) {
        const error = refusedClose(seat, kind, what, { options: { env: { T3CODE_HOME: t3Home } } })
        assert.deepEqual(error.details, details, what)
      }
      for (const [what, arrange] of values(seat)) {
        arrange()
        assert.deepEqual(refusedClose(seat, 'T3_STORE', what).details, { cause: 'value' }, what)
      }
      // A migration id past 2^53, written on a connection of its own: the id is its rowid, and a
      // connection whose last insert rowid is past the safe range throws on every later run().
      t3Seat(seat.id, [{ texts: [seat.message] }])
      const huge = new DatabaseSync(join(t3Home, 'userdata', 'statev2.sqlite'))
      huge.exec("insert into effect_sql_migrations (migration_id, name) values (9223372036854775807, 'past-safe')")
      try {
        assert.deepEqual(refusedClose(seat, 'T3_STORE', 'a migration id past 2^53').details, { cause: 'value' })
      } finally { huge.exec('delete from effect_sql_migrations where migration_id = 9223372036854775807'); huge.close() }
      // A writer holding the store locked past close's 2 s busy timeout.
      const locker = t3Store(home(`busy-${seat.id}`))
      t3Seat(seat.id, [{ texts: [seat.message] }], { db: locker })
      locker.exec("pragma locking_mode = exclusive; begin exclusive; insert into effect_sql_migrations (migration_id, name) values (77, 'held')")
      try {
        const error = refusedClose(seat, 'T3_STORE_BUSY', 'a store a writer holds locked', { options: { env: { T3CODE_HOME: home(`busy-${seat.id}`) } } })
        assert.deepEqual(error.details, { code: 5 })
      } finally { locker.exec('rollback'); locker.close() }
      assert.equal(closeSeat(seat.id, taskStatusOf(seat.id, { summary: seat.message })).verdict, 'valid')
      assert.equal(existsSync(seat.holder), false, `the retry kept ${seat.holder}`)
    }
    assert.deepEqual([readdirSync(home('empty')), existsSync(join(canon, 't3'))], [[], false], 'close created a store directory')
    assert.ok(!gitOut(canon, 'worktree', 'list', '--porcelain').includes(opened.reviewWorktree), 'git still lists the review worktree')
    ok(`a missing store (${elsewhere.slice(0, 4).map(([what]) => what).join(', ')}) refuses T3_STORE missing, a dropped column or table T3_STORE schema naming it, ${values(writer).length} values T3 doesn't write T3_STORE value, a migration id past 2^53 T3_STORE value, and a held write lock T3_STORE_BUSY; each changes no file of the record, keeps the writer's lease holder and the review worktree, and names no path and no SQLite text, close creates no store directory, and a retry against the store closes both seats valid`)

    // With T3CODE_HOME unset or empty, the store is ~/.t3's.
    const fakeHome = join(tmp, 'fake-home')
    mkdirSync(fakeHome)
    for (const value of ['', undefined]) {
      const seat = hookedSeat({})
      const env = { HOME: fakeHome, T3CODE_HOME: value }
      assert.deepEqual(refusedClose(seat, 'T3_STORE', `T3CODE_HOME ${JSON.stringify(value)} and no ~/.t3`, { kept: null, options: { env } }).details, { cause: 'missing' })
      const db = t3Store(join(fakeHome, '.t3'))
      t3Seat(seat.id, [{ texts: [seat.message] }], { db })
      db.close()
      assert.equal(seatCli(['close', seat.id], { env }).verdict, 'valid', `T3CODE_HOME ${JSON.stringify(value)}`)
      rmSync(join(fakeHome, '.t3'), { recursive: true })
    }
    ok('with T3CODE_HOME unset or empty, close reads ~/.t3/userdata/statev2.sqlite, and refuses T3_STORE missing when there is none')
  },

  'close-store-interface': () => {
    const writer = writerSeat('close-store-interface')
    t3Seat(writer.id, [{ texts: [writer.message] }])
    const before = recordFiles(writer.id)
    const removed = seatCli(['close', writer.id, '--task-status', '-'], { input: JSON.stringify(taskStatusOf(writer.id)) })
    assert.deepEqual([removed.error?.kind, recordFiles(writer.id), existsSync(writer.holder)], ['BAD_REQUEST', before, true], JSON.stringify(removed))
    assert.match(removed.error.message, /^Unknown argument/)
    ok('close refuses the removed status flag as an unknown argument, BAD_REQUEST, writing nothing and keeping the holder')

    // A seat whose call was admitted and made no task closes with --abandon and no store at all.
    const at = gitWorktree('close-store-interface-abandon')
    const unbound = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', at])
    silent(guard('pre', 'claude', preCall('claude', randomUUID(), SPELLING.claude, delegateInput(store.readRecord(unbound.id).record, unbound.id))), 'the parent\'s gate')
    const nowhere = join(tmp, 'no-t3-home')
    const abandoned = seatCli(['close', unbound.id, '--abandon'], { env: { T3CODE_HOME: nowhere } })
    assert.deepEqual([abandoned.verdict, abandoned.reasons, store.readStamp(unbound.id, 'closed').task, existsSync(nowhere)], ['unknown', ['abandoned-before-bind'], null, false], JSON.stringify(abandoned))
    assert.equal(existsSync(join(jobs.leaseDirOf(at), `${unbound.id}.live`)), false, 'abandon kept the holder')
    ok('close --abandon never reads the store: with no T3 home at all it records unknown (abandoned-before-bind) with task null and drops the holder')

    // A takeover: a thread other than the one that made the call closes the seat.
    const closer = 'f00dfeed-0000-4000-8000-00000000c105'
    const taken = seatCli(['close', writer.id], { env: { T3CODE_THREAD_ID: closer } })
    assert.deepEqual([taken.verdict, existsSync(writer.holder)], ['valid', false], JSON.stringify(taken))
    assert.deepEqual(store.readStamp(writer.id, 'closed').task, oneRunTask(writer.id, writer.message, { closerThreadId: closer }))
    assert.notEqual(closer, T3_OWNER)
    ok('a closer whose T3CODE_THREAD_ID is not the owning thread closes normally, and the stamp records the owner and the closer')

    for (const [what, value, recorded] of [
      ['unset', undefined, null], ['empty', '', null], ['a control character', 'thread\u0001x', null], ['257 bytes', 't'.repeat(257), null],
      ['258 bytes of 129 two-byte characters', 'é'.repeat(129), null], ['exactly 256 bytes', 't'.repeat(256), 't'.repeat(256)],
    ]) {
      const seat = hookedSeat({})
      assert.equal(closeSeat(seat.id, taskStatusOf(seat.id), { env: { T3CODE_THREAD_ID: value } }).verdict, 'valid', what)
      assert.equal(store.readStamp(seat.id, 'closed').task.closerThreadId, recorded, what)
    }
    ok('the closer thread is recorded only as 1 to 256 bytes with no control character, and is null otherwise')
  },

  'close-store-repeat': () => {
    const stampPath = (id) => join(seats, id, 'closed.json')
    const closedValid = () => {
      const seat = hookedSeat({})
      const rows = t3Seat(seat.id, [{ texts: [seat.message] }])
      const first = seatCli(['close', seat.id])
      assert.deepEqual([first.verdict, first.reasons], ['valid', []], JSON.stringify(first))
      return { ...seat, ...rows, first, bytes: readFileSync(stampPath(seat.id)) }
    }
    const later = closedValid()
    // T3 runs the child again after the close, with no hook on record, here with the same text.
    t3MessageRow(later.thread, t3RunRow(later.thread, 2), later.message)
    const again = seatCli(['close', later.id])
    assert.deepEqual(again, { ...later.first, verdict: 'unknown', reasons: ['stale-turn'], result: null, recorded: { verdict: 'valid', turn: 1 } }, JSON.stringify(again))
    assert.ok(readFileSync(stampPath(later.id)).equals(later.bytes), 'the repeated close rewrote the stamp')
    assert.deepEqual(store.readStamp(later.id, 'closed').task, oneRunTask(later.id, later.message))
    ok('a repeated close after T3 added a completed run prints unknown (stale-turn) with recorded {verdict, turn}, the stamp and its task block unchanged')

    const doubled = closedValid()
    const thread = childThreadOf(doubled.id, 'a1b2c3d4-0000-4000-8000-00000000beef')
    t3TaskRow(doubled.id, { session: 'a1b2c3d4-0000-4000-8000-00000000beef' })
    t3MessageRow(thread, t3RunRow(thread, 1), doubled.message)
    const twin = seatCli(['close', doubled.id])
    assert.deepEqual([twin.verdict, twin.reasons, twin.result, twin.recorded], ['unknown', ['task-ambiguous'], null, { verdict: 'valid', turn: 1 }], JSON.stringify(twin))
    assert.ok(readFileSync(stampPath(doubled.id)).equals(doubled.bytes))
    ok('a repeated close that finds a second task for the seat prints unknown (task-ambiguous) with recorded, the stamp unchanged')

    const pruned = closedValid()
    t3Forget(pruned.id)
    assert.equal(seatCli(['close', pruned.id]).error?.kind, 'TASK_NOT_FOUND')
    assert.ok(readFileSync(stampPath(pruned.id)).equals(pruned.bytes))
    ok('a repeated close after T3 pruned the task refuses TASK_NOT_FOUND, the stamp unchanged')
  },

  'close-abandon': () => {
    // A writer seat the parent's gate admitted, whose delegate_task call then made no task.
    const openWriter = (name) => {
      const at = gitWorktree(name)
      const opened = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', at])
      assert.equal(opened.ok, true, JSON.stringify(opened))
      silent(guard('pre', 'claude', preCall('claude', randomUUID(), SPELLING.claude, delegateInput(store.readRecord(opened.id).record, opened.id))), `${name}: the parent's gate`)
      assert.notEqual(store.readStamp(opened.id, 'admitted'), null, `${name} was not admitted`)
      return { id: opened.id, at, holder: join(jobs.leaseDirOf(at), `${opened.id}.live`) }
    }
    const writer = openWriter('close-abandon')
    assert.ok(existsSync(writer.holder))
    for (const args of [['--abandon', '--x', '1'], ['--x', '1', '--abandon'], ['--abandon', '--abandon'], ['--abandon', 'x']]) {
      const refused = seatCli(['close', writer.id, ...args])
      assert.equal(refused.error?.kind, 'BAD_REQUEST', `${args.join(' ')}: ${JSON.stringify(refused)}`)
      assert.equal(store.readStamp(writer.id, 'closed'), null, `${args.join(' ')} stamped the seat closed`)
      assert.ok(existsSync(writer.holder), `${args.join(' ')} dropped the holder`)
    }
    ok('close takes --abandon alone: beside another flag, twice or with a value it is BAD_REQUEST, writing nothing and keeping the holder')

    const abandoned = seatCli(['close', writer.id, '--abandon'])
    const expected = { ok: true, id: writer.id, verdict: 'unknown', reasons: ['abandoned-before-bind'], turn: null, result: null, servedModels: [], blocks: 0, errors: [] }
    assert.deepEqual(abandoned, expected)
    const stamped = store.readStamp(writer.id, 'closed')
    assert.deepEqual({ ...stamped, at: undefined }, { at: undefined, verdict: 'unknown', reasons: ['abandoned-before-bind'], abandoned: true, task: null, turn: null, resultSha256: null, servedModels: [], blocks: 0, errors: [] })
    assert.equal(existsSync(writer.holder), false, 'abandon kept the writer\'s holder')
    const taker = jobRecord(writer.at, 'queued')
    jobs.acquireLease(taker)
    jobs.releaseLease(taker)
    assert.deepEqual(seatCli(['close', writer.id, '--abandon']), expected, 'a second abandon does not print what the first recorded')
    ok('close --abandon of an admitted seat with no bound stamp records unknown (abandoned-before-bind), drops the writer\'s holder, and a write job then takes the worktree; a second abandon prints the record')

    for (const host of ['claude', 'codex']) {
      const session = randomUUID()
      const text = context(guard('prompt', host, promptCall(host, session, store.seatTag(writer.id))), `${host} late bind`)
      assert.match(text, /void seat/)
      assert.match(text, /record-closed/)
      assert.deepEqual(store.readIndex(host, session), { id: writer.id, void: 'record-closed' })
      denied(seatCall(host, session, 'Bash', { command: 'ls' }), /void seat \(record-closed\)/, `${host} tool call of a late child`)
    }
    assert.equal(store.readStamp(writer.id, 'bound'), null, 'a closed record was bound')
    ok('a child that starts after its seat was abandoned binds nothing: its session is a void seat (record-closed) and its tool calls are denied, on both hosts')

    const bound = openWriter('close-abandon-bound')
    context(guard('prompt', 'claude', promptCall('claude', randomUUID(), store.seatTag(bound.id))), 'bind')
    assert.notEqual(store.readStamp(bound.id, 'bound'), null)
    const refused = seatCli(['close', bound.id, '--abandon'])
    assert.equal(refused.error?.kind, 'BAD_REQUEST', JSON.stringify(refused))
    assert.match(refused.error.message, /a bound seat closes from T3's store/i)
    assert.equal(store.readStamp(bound.id, 'closed'), null, 'abandon stamped a bound seat closed')
    assert.ok(existsSync(bound.holder), 'abandon dropped a bound seat\'s holder')
    assert.equal(closeSeat(bound.id).verdict, 'unknown')
    assert.equal(existsSync(bound.holder), false)
    ok('close --abandon refuses a bound seat with BAD_REQUEST, writing nothing and keeping its holder; close with its task status still closes it')

    const review = seatCli(['open', '--access', 'review', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--base', baseSha, '--head', headSha])
    assert.equal(review.ok, true, JSON.stringify(review))
    assert.equal(seatCli(['close', review.id, '--abandon']).verdict, 'unknown')
    assert.equal(existsSync(review.reviewWorktree), false, 'abandon left the review worktree')
    assert.ok(!gitOut(canon, 'worktree', 'list', '--porcelain').includes(review.reviewWorktree), 'git still lists the review worktree')
    ok('close --abandon removes a review seat\'s worktree as close does')
  },

  'close-abandon-race': async () => {
    // Abandon writes its closed stamp, then reads the bound stamp again; a bind reads the closed
    // stamp, then writes its bound stamp. Both orders of the two writes are run.
    const contested = async (name) => {
      const at = gitWorktree(name)
      const opened = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', at])
      silent(guard('pre', 'claude', preCall('claude', randomUUID(), SPELLING.claude, delegateInput(store.readRecord(opened.id).record, opened.id))), `${name}: the parent's gate`)
      const session = randomUUID()
      const binding = await heldAt([GUARD, 'prompt', 'claude'], join(tmp, `${name}-bind`), 'bound', promptCall('claude', session, store.seatTag(opened.id)))
      return { id: opened.id, at, session, binding, bindGate: join(tmp, `${name}-bind`), holder: join(jobs.leaseDirOf(at), `${opened.id}.live`) }
    }

    // The bound stamp lands between abandon's closed stamp and its second read.
    const raced = await contested('abandon-raced')
    const abandoning = await heldAt([SEAT_SCRIPT, 'close', raced.id, '--abandon'], join(tmp, 'abandon-raced-close'), 'closed')
    writeFileSync(`${raced.bindGate}.go`, '')
    const bind = await raced.binding.done
    assert.equal(bind.code, 0)
    assert.match(JSON.parse(bind.out).hookSpecificOutput.additionalContext, new RegExp(`Seat ${raced.id}:`), 'the held bind did not bind')
    writeFileSync(join(tmp, 'abandon-raced-close.go'), '')
    const racedOut = await abandoning.done
    const out = JSON.parse(racedOut.out)
    assert.equal(racedOut.code, 0, racedOut.out)
    assert.deepEqual([out.verdict, out.reasons], ['unknown', ['abandon-raced-bind']])
    assert.equal(out.cleanupProblems?.length, 1, racedOut.out)
    assert.match(out.cleanupProblems[0], /bound/)
    assert.ok(existsSync(raced.holder), 'abandon dropped the holder of a seat a bind raced')
    assert.throws(() => jobs.acquireLease(jobRecord(raced.at, 'queued')), (error) => error.kind === 'WORKSPACE_BUSY' && error.details?.seatId === raced.id)
    denied(seatCall('claude', raced.session, 'Bash', { command: 'ls' }), /this seat was closed/, 'the raced child\'s next call')
    ok('a bind whose bound stamp lands between abandon\'s closed stamp and its second read: abandon reports abandon-raced-bind and keeps the writer\'s holder, which a write job still respects, and the child\'s calls are denied')

    const settled = closeSeat(raced.id)
    assert.deepEqual([settled.verdict, settled.reasons], ['unknown', ['abandon-raced-bind']])
    assert.equal(existsSync(raced.holder), false, 'close with the task status kept the holder')
    const taker = jobRecord(raced.at, 'queued')
    jobs.acquireLease(taker)
    jobs.releaseLease(taker)
    ok('close with the raced seat\'s task status prints the abandon on record and drops the holder, and a write job then takes the worktree')

    // The bound stamp lands after abandon finished: the holder is gone, and the child is held by the
    // closed stamp alone.
    const late = await contested('abandon-late')
    const lateOut = seatCli(['close', late.id, '--abandon'])
    assert.deepEqual([lateOut.verdict, lateOut.reasons, lateOut.cleanupProblems], ['unknown', ['abandoned-before-bind'], undefined])
    assert.equal(existsSync(late.holder), false)
    writeFileSync(`${late.bindGate}.go`, '')
    assert.equal((await late.binding.done).code, 0)
    assert.notEqual(store.readStamp(late.id, 'bound'), null, 'the held bind did not bind')
    denied(seatCall('claude', late.session, 'Bash', { command: 'ls' }), /this seat was closed/, 'the late child\'s first call')
    denied(seatCall('claude', late.session, 'Write', { file_path: join(late.at, 'x.txt'), content: 'x' }), /this seat was closed/, 'the late child\'s write')
    ok('a bind whose bound stamp lands after abandon\'s second read finds the holder dropped, and every call of its child is denied by the closed stamp that was on disk first')
  },

  'close-result-models': () => {
    const model = 'claude-opus-5-5'
    const cases = [
      [{ served: [], models: [model] }, 'unknown', ["turn 1's result names no served model"]],
      [{ served: [7], models: [model] }, 'unknown', ["turn 1's result names no served model"]],
      [{ served: [model], models: [] }, 'valid', []],
      [{ served: [model, 'claude-sonnet-5-5'], models: [model] }, 'model-mismatch', ['served by claude-sonnet-5-5, not claude-opus-5-5']],
      [{ served: [model], models: [model, 'claude-sonnet-5-5'] }, 'model-mismatch', ['served by claude-sonnet-5-5, not claude-opus-5-5']],
    ]
    for (const [fields, verdict, reasons] of cases) {
      const seat = hookedSeat(fields)
      const out = closeSeat(seat.id)
      assert.equal(out.verdict, verdict, `${JSON.stringify(fields)}: ${JSON.stringify(out)}`)
      assert.deepEqual(out.reasons, reasons, JSON.stringify(fields))
    }
    ok('close reads a valid turn whose result names no served model of its own as unknown, whatever earlier stops saw, and a model other than the record\'s expected one in the result or in any stop as model-mismatch')
  },

  'close-router-exact': () => {
    const ROUTER = 'accounts/fireworks/routers/glm-5p3-us'
    const SERVED = 'accounts/fireworks/models/glm-5p3'
    const record = { providerInstanceId: 'glm', model: ROUTER, expectedServedModel: SERVED }
    const rows = [
      ['the declared concrete id alone', { served: [SERVED] }, 'valid', []],
      ['the router id alone', { served: [ROUTER] }, 'model-mismatch', [`served by ${ROUTER}, not ${SERVED}`]],
      ['the declared id and the router id', { served: [SERVED, ROUTER] }, 'model-mismatch', [`served by ${ROUTER}, not ${SERVED}`]],
      ['the router id at an earlier stop', { served: [SERVED], models: [ROUTER, SERVED] }, 'model-mismatch', [`served by ${ROUTER}, not ${SERVED}`]],
      ['another model', { served: ['accounts/fireworks/models/glm-5p3-flash'] }, 'model-mismatch', [`served by accounts/fireworks/models/glm-5p3-flash, not ${SERVED}`]],
    ]
    for (const [what, fields, verdict, reasons] of rows) {
      const out = closeSeat(hookedSeat({ record, ...fields }).id)
      assert.deepEqual([out.verdict, out.reasons], [verdict, reasons], `${what}: ${JSON.stringify(out)}`)
      assert.deepEqual(out.servedModels, [...new Set([...(fields.models ?? fields.served), ...fields.served])], `${what}: servedModels is not the raw set`)
    }
    ok('a router seat is valid served by its declared concrete id alone; the router id alone, beside the declared id, at an earlier stop, or another id reads model-mismatch, and servedModels stays the raw ids')
  },

  'close-bind-versus-served': () => {
    const ROUTER = 'accounts/fireworks/routers/glm-5p3-us'
    const SERVED = 'accounts/fireworks/models/glm-5p3'
    const record = { providerInstanceId: 'glm', model: ROUTER, expectedServedModel: SERVED }
    const valid = closeSeat(hookedSeat({ record, boundModel: ROUTER, served: [SERVED] }).id)
    assert.deepEqual([valid.verdict, valid.reasons], ['valid', []], JSON.stringify(valid))
    ok('a seat bound to the model it asked for and served by the one it expects is valid, the two ids apart')

    const bind = closeSeat(hookedSeat({ record, boundModel: SERVED, served: [SERVED] }).id)
    assert.deepEqual([bind.verdict, bind.reasons], ['model-mismatch', [`bound to ${SERVED}, not ${ROUTER}`]], JSON.stringify(bind))
    const both = closeSeat(hookedSeat({ record, boundModel: 'other-bind', models: ['m-y', SERVED], served: [SERVED, 'm-z', 'm-y'] }).id)
    assert.deepEqual([both.verdict, both.reasons], ['model-mismatch', ['bound to other-bind, not ' + ROUTER, `served by m-y, not ${SERVED}`, `served by m-z, not ${SERVED}`]], JSON.stringify(both))
    assert.deepEqual(both.servedModels, ['m-y', SERVED, 'm-z'])
    ok('a bind to another model reads `bound to <X>, not <model>`, judged against the model asked for; with unexpected served ids too, the bind reason comes first, then one `served by` reason per distinct id in first-seen order')
  },

  'prune-void-index': () => {
    const now = Date.now()
    const oldTime = (now - RETENTION_MS - 60_000) / 1000
    store.voidSession('claude', 'prune-old-null', null, 'tag-not-on-line-1')
    utimesSync(store.indexPath('claude', 'prune-old-null'), oldTime, oldTime)
    store.voidSession('codex', 'prune-recent-null', null, 'tag-not-on-line-1')
    const recentTime = (now - RETENTION_MS + 60_000) / 1000
    utimesSync(store.indexPath('codex', 'prune-recent-null'), recentTime, recentTime)
    const keep = store.writeRecord(RECORD(), null).id
    store.voidSession('claude', 'prune-old-named', keep, 'permission-mode-not-allowed')
    utimesSync(store.indexPath('claude', 'prune-old-named'), oldTime, oldTime)
    store.indexSession('codex', 'prune-old-bound', { id: keep })
    utimesSync(store.indexPath('codex', 'prune-old-bound'), oldTime, oldTime)
    writeFileSync(store.indexPath('claude', 'prune-old-garbled'), 'not json')
    utimesSync(store.indexPath('claude', 'prune-old-garbled'), oldTime, oldTime)
    store.pruneSeats(now)
    assert.equal(store.readIndex('claude', 'prune-old-null'), null, 'an old void entry naming no seat stayed')
    assert.deepEqual(store.readIndex('codex', 'prune-recent-null'), { id: null, void: 'tag-not-on-line-1' })
    assert.deepEqual(store.readIndex('claude', 'prune-old-named'), { id: keep, void: 'permission-mode-not-allowed' })
    assert.deepEqual(store.readIndex('codex', 'prune-old-bound'), { id: keep })
    assert.deepEqual(store.readIndex('claude', 'prune-old-garbled'), { id: null, void: 'index-unreadable' })
    ok('pruneSeats removes a void index entry that names no seat once it is older than RETENTION_MS, and keeps a recent one, one naming a seat whose record stays, and an unreadable one')
  },

  'prune-open': () => {
    const old = new Date(Date.now() - RETENTION_MS - 60_000).toISOString()
    const stale = store.writeRecord(RECORD(), null).id
    store.stamp(stale, 'closed', { at: old, verdict: 'valid', reasons: [] })
    const unclosed = store.writeRecord(RECORD({ createdAt: old }), null).id
    assert.equal(seatCli(['open', '--access', 'read-only', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high']).ok, true)
    assert.equal(existsSync(join(seats, stale)), false, 'open did not prune a record closed past retention')
    assert.ok(store.readRecord(unclosed), 'open pruned an unclosed record')
    ok('open prunes records closed longer ago than RETENTION_MS first, and keeps an unclosed one however old')
  },

}

await runSection('close-store', cases)
