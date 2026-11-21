// Seat smoke section: close-verdicts. Run via `node test/flow/smoke-seat.mjs` or directly.
import { assert, spawn, spawnSync, createHash, randomUUID, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, createServer, performance, DatabaseSync, tmpdir, dirname, join, fileURLToPath, pathToFileURL, PLUGIN, STORE, tmp, state, t3Home, store, wire, seatPolicy, RETENTION_MS, schemas, ok, sha256, mode, seats, INSTANCE, RECORD, SCHEMA, ENVELOPE_OK, racer, race, GUARD, guard, silent, denied, blocked, context, stopBlocked, MODELS, PERMISSION, SPELLING, call, stopCall, promptCall, preCall, EFFORT_OPTION, delegateInput, seatRecord, admit, admittedSeat, worktree, ACCESSES, boundSeat, seatCall, editCalls, indexEntries, SEAT_SCRIPT, jobs, seatCli, fakeCodexBin, OWN_HOOKS, installedRoot, FAKE_ROOT, treeDigest, DRIFTED_ROOT, snake, flowEntries, FOREIGN, codexState, codexSent, codexHooks, flowDigest, trustedCodex, T3_TABLES, T3_INDEXES, t3Store, t3, T3_SESSION, T3_OWNER, t3Time, taskIdOf, childThreadOf, runIdOf, t3TaskRow, t3RunRow, t3MessageRow, t3Forget, t3Seat, MESSAGE_OK, taskStatusOf, t3Status, closeSeat, oneRunTask, writerSeat, recordFiles, refusedClose, gitEnv, gitOut, canon, baseSha, headSha, linkedWt, gitWorktree, jobRecord, hookedSeat, guardedSeat, messageWith, rootedCodexSeat, holderGate, jobGate, stampGate, scanGate, heldChildren, heldAt, waitFor, leaseRacer, leaseRace, runSection } from './helpers.mjs'

const cases = {
  'close-verdicts': () => {
    const verdict = (id, expected, pattern, what) => {
      const out = closeSeat(id)
      assert.deepEqual(Object.keys(out), ['ok', 'id', 'verdict', 'reasons', 'turn', 'result', 'servedModels', 'blocks', 'errors'], what)
      assert.equal(out.verdict, expected, `${what}: ${JSON.stringify(out.reasons)}`)
      if (pattern) assert.ok(out.reasons.some((reason) => pattern.test(reason)), `${what}: ${JSON.stringify(out.reasons)}`)
      assert.equal(store.readStamp(id, 'closed')?.verdict ?? null, existsSync(join(seats, id)) ? expected : null, what)
      return out
    }

    const valid = hookedSeat({})
    const out = verdict(valid.id, 'valid', null, 'valid')
    assert.deepEqual(out.result, ENVELOPE_OK)
    assert.deepEqual(out.servedModels, ['claude-opus-5-5'])
    assert.deepEqual([out.turn, out.blocks, out.errors, out.reasons], [1, 0, [], []])
    assert.deepEqual(store.readStamp(valid.id, 'closed').task, oneRunTask(valid.id, MESSAGE_OK))
    ok('valid: every stamp present and an intact result whose served models are the record\'s; the output carries the envelope and the closed stamp records the task T3\'s store holds')

    const invalid = hookedSeat({ outcome: 'blocked', blocks: 1, errors: ['$.status: not one of the allowed values'] })
    const inv = verdict(invalid.id, 'invalid', /last final message failed/, 'invalid')
    assert.deepEqual([inv.result, inv.blocks, inv.errors], [null, 1, ['$.status: not one of the allowed values']])
    const resumed = hookedSeat({ outcome: 'blocked', blocks: 1, errors: ['$: x'] })
    store.writeResult(resumed.id, 1, { envelope: ENVELOPE_OK, servedModels: ['claude-opus-5-5'], messageSha256: 'a'.repeat(64), at: new Date().toISOString() })
    verdict(resumed.id, 'invalid', null, 'an earlier valid result in a turn whose last stop failed')
    verdict(hookedSeat({ outcome: 'capped', blocks: 3, errors: ['$: x'] }).id, 'capped', /blocked 3 times/, 'capped')
    ok('invalid: the last stop of the last turn was blocked, an earlier valid result in that turn included; capped: the turn was capped')

    verdict(hookedSeat({ stamps: ['bound', 'receipt'] }).id, 'unknown', /admitted stamp is missing/, 'no admitted stamp')
    verdict(hookedSeat({ stamps: ['admitted', 'receipt'] }).id, 'unknown', /bound stamp is missing/, 'no bound stamp')
    verdict(hookedSeat({ stamps: ['admitted', 'bound'] }).id, 'unknown', /receipt stamp is missing/, 'no receipt stamp')
    const voided = hookedSeat({})
    store.stamp(voided.id, 'void', { reason: 'bound-lost-race' })
    verdict(voided.id, 'unknown', /void: bound-lost-race/, 'a void stamp beside a full set')
    verdict(hookedSeat({ digest: 'f'.repeat(64) }).id, 'unknown', /record changed after the bind/, 'a record digest mismatch')
    verdict(hookedSeat({ digest: 'f'.repeat(64), admittedDigest: 'e'.repeat(64) }).id, 'unknown', /record changed after the bind/, 'a bind and an admission that both pinned other bytes')
    verdict(hookedSeat({ admittedDigest: 'e'.repeat(64) }).id, 'unknown', /^the record changed between the admission and the bind$/, 'an admission that pinned other bytes than the bind')
    const unpinned = hookedSeat({ stamps: ['bound', 'receipt'] })
    assert.equal(store.stamp(unpinned.id, 'admitted', { toolUseId: 'toolu_x', clientRequestId: `flow-seat-${unpinned.id}` }), true)
    verdict(unpinned.id, 'unknown', /^the record changed between the admission and the bind$/, 'an admitted stamp with no recordDigest')
    const tampered = hookedSeat({})
    writeFileSync(join(seats, tampered.id, 'result-1.json'), JSON.stringify({ envelope: { ...ENVELOPE_OK, notes: 'edited' }, servedModels: ['claude-opus-5-5'] }))
    verdict(tampered.id, 'unknown', /does not match its recorded sha256/, 'a result sha mismatch')
    verdict(hookedSeat({ served: [] }).id, 'unknown', /no served model/, 'empty served models')
    const voidIndex = hookedSeat({})
    store.voidSession('claude', `s-${voidIndex.id}`, voidIndex.id, 'replayed-tag')
    verdict(voidIndex.id, 'unknown', /^session-index-void$/, 'a bound session whose index was voided')
    verdict(hookedSeat({ index: 'none' }).id, 'unknown', /^session-index-mismatch$/, 'a bound session with no index entry')
    const otherIndex = hookedSeat({ index: 'none' })
    store.indexSession('claude', `s-${otherIndex.id}`, { id: store.newId() })
    verdict(otherIndex.id, 'unknown', /^session-index-mismatch$/, 'a bound session whose index names another seat')
    verdict(hookedSeat({ outcome: null }).id, 'unknown', /no Stop was recorded/, 'no Stop')
    verdict(hookedSeat({ result: false }).id, 'unknown', /has no result/, 'a valid turn with no result file')
    const gone = hookedSeat({})
    rmSync(join(seats, gone.id, 'record.json'))
    verdict(gone.id, 'unknown', /missing or corrupt/, 'a missing record')
    const corrupt = hookedSeat({})
    writeFileSync(join(seats, corrupt.id, 'record.json'), '{"v": 1')
    verdict(corrupt.id, 'unknown', /missing or corrupt/, 'a corrupt record')
    verdict(store.newId(), 'unknown', /missing or corrupt/, 'an id with no record directory at all')
    ok('unknown: a missing admitted, bound or receipt stamp, any void stamp, a record digest the bind did not pin, an admission that pinned no digest or another one than the bind, a bound session whose index is void, missing or names another seat, a result whose sha256 does not match, no served model, no Stop, a valid turn with no result, or a missing or corrupt record')

    verdict(hookedSeat({ served: ['claude-sonnet-5-5'] }).id, 'model-mismatch', /served by claude-sonnet-5-5, not claude-opus-5-5/, 'served model mismatch')
    const bindRow = verdict(hookedSeat({ provider: 'codex', model: 'gpt-6-luna', boundModel: 'gpt-6-mini', served: ['gpt-6-luna'] }).id, 'model-mismatch', /^bound to gpt-6-mini, not gpt-6-luna$/, 'bind model mismatch')
    assert.deepEqual(bindRow.reasons, ['bound to gpt-6-mini, not gpt-6-luna'])
    verdict(hookedSeat({ boundModel: 'claude-sonnet-5-5', outcome: 'blocked', blocks: 1, errors: ['$: x'] }).id, 'model-mismatch', null, 'a mismatch outranks invalid')
    const both = hookedSeat({ served: ['claude-sonnet-5-5'] })
    store.stamp(both.id, 'void', { reason: 'r' })
    verdict(both.id, 'unknown', /void/, 'unknown outranks model-mismatch')
    ok('model-mismatch: a served model is not the record\'s expected one, or the model seen at the bind is not the record\'s (bound to), outranking invalid and outranked by unknown')
  },

  'close-review': () => {
    const covering = (extra = {}) => ({ ...ENVELOPE_OK, answer: { findings: [] }, coverage: { read: ['a.txt'], partial: ['./c.txt'], unopened: [], checksRun: [] }, ...extra })
    const reviewSeat = (envelope = covering(), fields = {}) => {
      const opened = seatCli(['open', '--access', 'review', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--base', baseSha, '--head', headSha])
      assert.equal(opened.ok, true, JSON.stringify(opened))
      return hookedSeat({ id: opened.id, envelope, ...fields })
    }
    // The task status of a review whose one run answered with the seat's final message.
    const closeReview = (seat) => closeSeat(seat.id, taskStatusOf(seat.id, { summary: seat.message }))

    const clean = reviewSeat()
    const path = store.readRecord(clean.id).record.reviewWorktree
    const out = closeReview(clean)
    assert.equal(out.verdict, 'valid', JSON.stringify(out.reasons))
    assert.equal(existsSync(path), false, 'close removed the review worktree')
    assert.ok(!gitOut(canon, 'worktree', 'list', '--porcelain').includes(path), 'git still lists the review worktree')
    const absolute = reviewSeat(covering({ coverage: { read: [], partial: [], unopened: [], checksRun: [] } }))
    const absPath = store.readRecord(absolute.id).record.reviewWorktree
    store.writeResult(absolute.id, 1, { envelope: covering({ coverage: { read: [join(absPath, 'a.txt')], partial: [], unopened: ['c.txt'], checksRun: [] } }), servedModels: ['claude-opus-5-5'], messageSha256: 'b'.repeat(64), at: new Date().toISOString() })
    assert.equal(closeReview(absolute).verdict, 'valid', 'an absolute coverage path inside the review worktree counts')
    ok('a review whose worktree stayed at the head and clean, whose canonical checkout did not move, and whose coverage lists every diffed file (read, partial or unopened, relative, ./ or absolute) is valid, and close removes its worktree')

    const moved = reviewSeat()
    spawnSync('git', ['-C', store.readRecord(moved.id).record.reviewWorktree, 'checkout', '-q', '--detach', baseSha])
    assert.equal(closeReview(moved).verdict, 'tree-moved')
    const dirty = reviewSeat()
    writeFileSync(join(store.readRecord(dirty.id).record.reviewWorktree, 'scratch.txt'), 'x')
    const dirtyOut = closeReview(dirty)
    assert.equal(dirtyOut.verdict, 'tree-moved')
    assert.ok(dirtyOut.reasons.some((reason) => /dirty/.test(reason)), JSON.stringify(dirtyOut.reasons))
    const canonical = reviewSeat()
    writeFileSync(join(canon, 'stray.txt'), 'x')
    const canonOut = closeReview(canonical)
    rmSync(join(canon, 'stray.txt'))
    assert.equal(canonOut.verdict, 'tree-moved')
    assert.ok(canonOut.reasons.some((reason) => /canonical checkout changed/.test(reason)), JSON.stringify(canonOut.reasons))
    assert.equal(closeReview(reviewSeat(covering(), { outcome: 'capped', blocks: 3, errors: ['$: x'] })).verdict, 'capped', 'a capped review with no envelope is not judged on coverage')
    const cappedMoved = reviewSeat(covering(), { outcome: 'capped', blocks: 3, errors: ['$: x'] })
    writeFileSync(join(store.readRecord(cappedMoved.id).record.reviewWorktree, 'scratch.txt'), 'x')
    assert.equal(closeReview(cappedMoved).verdict, 'tree-moved', 'tree-moved outranks capped')
    ok('tree-moved: the review worktree\'s HEAD moved, it is dirty, or the canonical checkout changed; it outranks capped')

    // The canonical checkout's HEAD is part of what a review pins: a detach or a commit that leaves
    // the tree as it was still moves it.
    const detached = reviewSeat()
    gitOut(canon, 'checkout', '-q', '--detach', 'HEAD')
    const detachedOut = closeReview(detached)
    gitOut(canon, 'checkout', '-q', 'main')
    assert.equal(detachedOut.verdict, 'tree-moved', JSON.stringify(detachedOut))
    assert.ok(detachedOut.reasons.some((reason) => /canonical checkout's HEAD/.test(reason)), JSON.stringify(detachedOut.reasons))
    const committed = reviewSeat()
    gitOut(canon, 'commit', '-q', '--allow-empty', '-m', 'empty')
    const committedOut = closeReview(committed)
    gitOut(canon, 'reset', '-q', '--soft', headSha)
    assert.equal(gitOut(canon, 'rev-parse', 'HEAD'), headSha)
    assert.equal(committedOut.verdict, 'tree-moved', JSON.stringify(committedOut))
    const record = store.readRecord(committed.id).record
    assert.deepEqual([record.canonicalSnapshot.head, record.canonicalSnapshot.branch], [headSha, 'refs/heads/main'])
    ok('a review records the canonical checkout\'s HEAD commit and branch, and reads tree-moved when either changed, the tree unchanged')

    // A land in another run pulls main in the canonical checkout. A review whose canonical branch
    // only fast-forwarded onto origin's live tip still closes valid, and every other move still
    // reads tree-moved, from the HEAD reason alone. origin is a local bare clone of canon, pusher a
    // clone that advances it without canon seeing, and each case starts from main at the head,
    // clean, with origin's main and canon's tracking ref at the head.
    const bare = join(tmp, 'origin.git')
    const pusher = join(tmp, 'pusher')
    gitOut(tmp, 'clone', '-q', '--bare', canon, bare)
    gitOut(tmp, 'clone', '-q', bare, pusher)
    gitOut(canon, 'remote', 'add', 'origin', bare)
    let pushes = 0
    const advanceOrigin = () => {
      gitOut(pusher, 'fetch', '-q', 'origin')
      gitOut(pusher, 'reset', '-q', '--hard', 'origin/main')
      writeFileSync(join(pusher, 'ff.txt'), `${++pushes}\n`)
      gitOut(pusher, 'add', 'ff.txt')
      gitOut(pusher, 'commit', '-q', '-m', `origin ${pushes}`)
      gitOut(pusher, 'push', '-q', 'origin', 'HEAD:main')
      return gitOut(pusher, 'rev-parse', 'HEAD')
    }
    const pullMain = () => gitOut(canon, 'pull', '-q', '--ff-only', 'origin', 'main')
    const resetFixture = () => {
      if (existsSync(`${bare}.away`)) renameSync(`${bare}.away`, bare)
      gitOut(bare, 'update-ref', 'refs/heads/main', headSha)
      gitOut(canon, 'remote', 'set-url', 'origin', bare)
      gitOut(canon, 'checkout', '-q', 'main')
      gitOut(canon, 'reset', '-q', '--hard', headSha)
      spawnSync('git', ['-C', canon, 'branch', '-q', '-D', 'side'], { env: gitEnv })
      gitOut(canon, 'fetch', '-q', 'origin')
      assert.equal(gitOut(canon, 'status', '--porcelain'), '')
      assert.equal(gitOut(canon, 'rev-parse', 'refs/remotes/origin/main'), headSha)
    }
    const headReason = (out) => out.reasons.find((reason) => /canonical checkout's HEAD moved/.test(reason))
    // A review opened on main at the head, after before() ran, the canonical checkout then moved by
    // move(), and the review closed with env added to seat.mjs's: tree-moved, with the HEAD reason
    // its only one and naming why (a pattern, or a function that builds one once move ran).
    const stillMoved = (label, move, why, { before = () => {}, env = {} } = {}) => {
      resetFixture()
      before()
      const seat = reviewSeat()
      move()
      const out = closeSeat(seat.id, taskStatusOf(seat.id, { summary: seat.message }), { env })
      const pattern = typeof why === 'function' ? why() : why
      assert.equal(out.verdict, 'tree-moved', `${label}: ${JSON.stringify(out)}`)
      assert.equal(out.reasons.length, 1, `${label}: ${JSON.stringify(out.reasons)}`)
      assert.match(headReason(out) ?? '', pattern, `${label}: ${JSON.stringify(out.reasons)}`)
      ok(`tree-moved: ${label}`)
    }

    resetFixture()
    const pulled = reviewSeat()
    assert.equal(store.readRecord(pulled.id).record.canonicalSnapshot.origin, createHash('sha256').update(bare).digest('hex'), 'a review records the sha256 of origin\'s URL, never the URL')
    const tip = advanceOrigin()
    pullMain()
    assert.equal(gitOut(canon, 'rev-parse', 'HEAD'), tip)
    assert.ok(existsSync(join(canon, 'ff.txt')), 'the pull moved the canonical tree')
    const pulledOut = closeReview(pulled)
    assert.deepEqual([pulledOut.verdict, pulledOut.reasons], ['valid', []], JSON.stringify(pulledOut))
    ok('canonical fast-forward onto origin\'s live tip: a review whose canonical main only pulled forward, as land does, onto the tip ls-remote reads, closes valid')

    resetFixture()
    const strayed = reviewSeat()
    advanceOrigin()
    pullMain()
    writeFileSync(join(canon, 'stray.txt'), 'x')
    const strayedOut = closeReview(strayed)
    rmSync(join(canon, 'stray.txt'))
    assert.deepEqual([strayedOut.verdict, strayedOut.reasons], ['tree-moved', ['the canonical checkout changed while the seat ran']], JSON.stringify(strayedOut))
    ok('tree-moved: a fast-forward onto origin\'s live tip that also changed the tree, from the snapshot reason alone')

    const NOT_THE_TIP = (sha) => new RegExp(`not a fast-forward onto origin's live tip: origin's refs/heads/main is ${sha}, not this HEAD`)
    stillMoved('a detach onto origin\'s live tip', () => {
      advanceOrigin()
      gitOut(canon, 'fetch', '-q', 'origin')
      gitOut(canon, 'checkout', '-q', '--detach', 'origin/main')
    }, /not a fast-forward onto origin's live tip: the branch is not the named branch open recorded/)
    stillMoved('a local commit', () => gitOut(canon, 'commit', '-q', '--allow-empty', '-m', 'local'), NOT_THE_TIP(headSha))
    stillMoved('a switch to another branch at origin\'s live tip', () => {
      advanceOrigin()
      gitOut(canon, 'fetch', '-q', 'origin')
      gitOut(canon, 'checkout', '-q', '-b', 'side', 'origin/main')
    }, /not a fast-forward onto origin's live tip: the branch is not the named branch open recorded/)
    stillMoved('a reset backwards, with origin\'s main moved back to match', () => {
      gitOut(bare, 'update-ref', 'refs/heads/main', baseSha)
      gitOut(canon, 'reset', '-q', '--hard', baseSha)
    }, /not a fast-forward onto origin's live tip: the HEAD at open is not an ancestor of this one/)
    stillMoved('a fast-forward onto origin\'s live tip plus a local commit', () => {
      advanceOrigin()
      pullMain()
      gitOut(canon, 'commit', '-q', '--allow-empty', '-m', 'local')
    }, () => NOT_THE_TIP(gitOut(bare, 'rev-parse', 'refs/heads/main')))
    stillMoved('a fast-forward onto a tracking ref forged with update-ref, not origin\'s live tip', () => {
      const forged = gitOut(canon, 'commit-tree', `${headSha}^{tree}`, '-p', headSha, '-m', 'forged')
      gitOut(canon, 'update-ref', 'refs/remotes/origin/main', forged)
      gitOut(canon, 'merge', '-q', '--ff-only', 'origin/main')
      assert.equal(gitOut(canon, 'rev-parse', 'HEAD'), forged)
    }, NOT_THE_TIP(headSha))
    stillMoved('a fast-forward onto origin\'s live tip, then origin unreadable', () => {
      advanceOrigin()
      pullMain()
      renameSync(bare, `${bare}.away`)
    }, /not a fast-forward onto origin's live tip: origin's refs\/heads\/main could not be read/)
    let ahead = null
    stillMoved('a fast-forward, then origin advanced to a tip the canonical checkout does not have', () => {
      advanceOrigin()
      pullMain()
      ahead = advanceOrigin()
      assert.notEqual(spawnSync('git', ['-C', canon, 'cat-file', '-e', `${ahead}^{commit}`], { env: gitEnv }).status, 0, 'the new tip is not in the canonical checkout')
    }, () => NOT_THE_TIP(ahead))
    const decoy = join(tmp, 'decoy.git')
    stillMoved('origin repointed between open and close at a repository whose tip is the new HEAD', () => {
      gitOut(tmp, 'clone', '-q', '--bare', bare, decoy)
      const planted = gitOut(canon, 'commit-tree', `${headSha}^{tree}`, '-p', headSha, '-m', 'planted')
      gitOut(canon, 'push', '-q', decoy, `${planted}:refs/heads/main`)
      gitOut(canon, 'remote', 'set-url', 'origin', decoy)
      pullMain()
      assert.equal(gitOut(canon, 'rev-parse', 'HEAD'), planted)
      assert.equal(gitOut(canon, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], planted, 'the decoy\'s tip is the new HEAD')
    }, /not a fast-forward onto origin's live tip: origin's URL is not the one open recorded$/)
    rmSync(decoy, { recursive: true, force: true })

    // A record from before origin was pinned has no origin key, and never passes.
    resetFixture()
    const legacyOpen = seatCli(['open', '--access', 'review', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--base', baseSha, '--head', headSha])
    const legacyPath = join(seats, legacyOpen.id, 'record.json')
    const legacyRecord = JSON.parse(readFileSync(legacyPath, 'utf8'))
    delete legacyRecord.canonicalSnapshot.origin
    writeFileSync(legacyPath, JSON.stringify(legacyRecord))
    const legacy = hookedSeat({ id: legacyOpen.id, envelope: covering() })
    advanceOrigin()
    pullMain()
    const legacyOut = closeReview(legacy)
    assert.equal(legacyOut.verdict, 'tree-moved', JSON.stringify(legacyOut))
    assert.match(headReason(legacyOut) ?? '', /not a fast-forward onto origin's live tip: open recorded no origin/, JSON.stringify(legacyOut.reasons))
    ok('tree-moved: a record opened before origin was pinned, then a fast-forward onto origin\'s live tip')

    // Over SSH, ls-remote runs ssh in batch mode with a connect timeout, no terminal prompt and no
    // askpass, so it fails rather than waits. A fake ssh first on PATH records how it ran and fails
    // as an unreachable host does.
    const fakeSshBin = join(tmp, 'fake-ssh-bin')
    const sshLog = join(tmp, 'fake-ssh.jsonl')
    mkdirSync(fakeSshBin, { recursive: true })
    writeFileSync(join(fakeSshBin, 'ssh'), `#!${process.execPath}
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify({ argv: process.argv.slice(2), prompt: process.env.GIT_TERMINAL_PROMPT ?? null, askpass: process.env.SSH_ASKPASS ?? null }) + '\\n')
process.stderr.write('ssh: Could not resolve hostname smoke.invalid\\n')
process.exit(255)
`)
    chmodSync(join(fakeSshBin, 'ssh'), 0o755)
    stillMoved('a fast-forward with an SSH origin that cannot be reached', () => {
      const local = gitOut(canon, 'commit-tree', `${headSha}^{tree}`, '-p', headSha, '-m', 'over ssh')
      gitOut(canon, 'merge', '-q', '--ff-only', local)
    }, /not a fast-forward onto origin's live tip: origin's refs\/heads\/main could not be read/, {
      before: () => gitOut(canon, 'remote', 'set-url', 'origin', 'ssh://smoke.invalid/r.git'),
      env: { PATH: `${fakeSshBin}:${trustedCodex.env.PATH}`, SSH_ASKPASS: '/usr/bin/false' },
    })
    const sshRuns = readFileSync(sshLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.ok(sshRuns.length > 0, 'ls-remote never ran ssh')
    for (const run of sshRuns) {
      assert.deepEqual(run.argv.slice(0, 4), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'], JSON.stringify(run))
      assert.ok(run.argv.includes('smoke.invalid'), JSON.stringify(run))
      assert.deepEqual([run.prompt, run.askpass], ['0', ''], JSON.stringify(run))
    }
    ok('ls-remote over SSH runs ssh with BatchMode=yes and ConnectTimeout=10, GIT_TERMINAL_PROMPT=0 and an empty SSH_ASKPASS, so an unreachable origin fails closed')

    resetFixture()
    gitOut(canon, 'remote', 'remove', 'origin')
    rmSync(bare, { recursive: true, force: true })
    rmSync(pusher, { recursive: true, force: true })
    assert.deepEqual([gitOut(canon, 'rev-parse', 'HEAD'), gitOut(canon, 'symbolic-ref', 'HEAD'), gitOut(canon, 'remote'), gitOut(canon, 'status', '--porcelain')], [headSha, 'refs/heads/main', '', ''])

    // close removes only the worktree its open added: the same path, the same admin directory, and
    // still listed by git. One moved away and replaced at that path by another is left in place.
    const swapped = reviewSeat()
    const swappedRecord = store.readRecord(swapped.id).record
    assert.equal(swappedRecord.reviewGitDir, realpathSync(gitOut(swappedRecord.reviewWorktree, 'rev-parse', '--absolute-git-dir')))
    const movedTo = join(tmp, `moved-${swapped.id}`)
    gitOut(canon, 'worktree', 'move', swappedRecord.reviewWorktree, movedTo)
    gitOut(canon, 'worktree', 'add', '-q', '--detach', swappedRecord.reviewWorktree, headSha)
    const swappedOut = closeReview(swapped)
    assert.ok(existsSync(swappedRecord.reviewWorktree), 'close removed a worktree it did not add')
    assert.ok(existsSync(movedTo), 'close touched the moved worktree')
    assert.ok(swappedOut.cleanupProblems?.some((problem) => /not the one this seat opened/.test(problem)), JSON.stringify(swappedOut))
    gitOut(canon, 'worktree', 'remove', '--force', swappedRecord.reviewWorktree)
    gitOut(canon, 'worktree', 'remove', '--force', movedTo)
    const plain = reviewSeat()
    const plainPath = store.readRecord(plain.id).record.reviewWorktree
    gitOut(canon, 'worktree', 'remove', '--force', plainPath)
    mkdirSync(plainPath)
    writeFileSync(join(plainPath, 'keep.txt'), 'x')
    const plainOut = closeReview(plain)
    assert.ok(existsSync(join(plainPath, 'keep.txt')), 'close removed a plain directory at the review path')
    assert.ok(plainOut.cleanupProblems?.length > 0, JSON.stringify(plainOut))
    rmSync(plainPath, { recursive: true })
    ok('close removes a review worktree only while its path, its admin directory and git\'s worktree list all still match what open recorded, and otherwise leaves the path alone and reports it in cleanupProblems')
  },

  'close-coverage-gap': () => {
    // A repository of its own whose pinned diff holds `a`, `a (b).md`, `src/x.rs` and twelve
    // more files, so a name with a parenthesized part and a gap past ten paths can both be read.
    const repo = gitWorktree('coverage-gap')
    writeFileSync(join(repo, 'README'), 'r\n')
    gitOut(repo, 'add', '-A')
    gitOut(repo, 'commit', '-q', '-m', 'base')
    const base = gitOut(repo, 'rev-parse', 'HEAD')
    const MANY = Array.from({ length: 12 }, (_, at) => `many/${String(at).padStart(2, '0')}.txt`)
    mkdirSync(join(repo, 'src'))
    mkdirSync(join(repo, 'many'))
    for (const file of ['a', 'a (b).md', 'src/x.rs', ...MANY]) writeFileSync(join(repo, file), `${file}\n`)
    gitOut(repo, 'add', '-A')
    gitOut(repo, 'commit', '-q', '-m', 'head')
    const head = gitOut(repo, 'rev-parse', 'HEAD')
    const envelopeOf = (read, partial = []) => ({ ...ENVELOPE_OK, answer: { findings: [] }, coverage: { read, partial, unopened: [], checksRun: [] } })
    const reviewSeat = (envelope, fields = {}) => {
      const opened = seatCli(['open', '--access', 'review', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--base', base, '--head', head], { cwd: repo })
      assert.equal(opened.ok, true, JSON.stringify(opened))
      return hookedSeat({ id: opened.id, envelope, ...fields })
    }
    const closeReview = (seat, fields = {}) => closeSeat(seat.id, taskStatusOf(seat.id, { summary: seat.message, ...fields }))
    const gapOf = (missing) => [`the coverage misses ${missing.length} file(s) in the pinned diff`, ...missing]

    const notes = closeReview(reviewSeat(envelopeOf(['a (b).md', ...MANY], ['src/x.rs (all changed hunks and surrounding evaluation paths)', 'a (whole file)'])))
    assert.deepEqual([notes.verdict, notes.reasons], ['valid', []], JSON.stringify(notes))
    ok('a review whose partial entries are written `path (note)` covers those paths and closes valid')

    const gapEnvelope = envelopeOf(['a', 'a (b).md', ...MANY])
    const gap = reviewSeat(gapEnvelope)
    const gapPath = store.readRecord(gap.id).record.reviewWorktree
    const gapOut = closeReview(gap)
    assert.equal(gapOut.verdict, 'coverage-gap', JSON.stringify(gapOut))
    assert.deepEqual(gapOut.reasons, gapOf(['src/x.rs']))
    assert.deepEqual(gapOut.result, gapEnvelope, 'a coverage-gap close returns the envelope as its result')
    assert.equal(store.readStamp(gap.id, 'closed').verdict, 'coverage-gap')
    assert.equal(existsSync(gapPath), false, 'close removed the coverage-gap review worktree')
    ok('a review missing one diffed file closes coverage-gap, with the envelope as result and the path in reasons')

    const wide = closeReview(reviewSeat(envelopeOf(['a'])))
    assert.equal(wide.verdict, 'coverage-gap', JSON.stringify(wide))
    assert.deepEqual(wide.reasons, gapOf(['a (b).md', ...MANY, 'src/x.rs'].sort()), 'the reasons list every missed path, past ten')
    ok('a coverage-gap lists one count reason, then every missed path, with no cap at ten')

    const exact = closeReview(reviewSeat(envelopeOf(['src/x.rs', ...MANY], ['a (b).md'])))
    assert.deepEqual([exact.verdict, exact.reasons], ['coverage-gap', gapOf(['a'])], JSON.stringify(exact))
    const noted = closeReview(reviewSeat(envelopeOf(['src/x.rs', ...MANY], ['a (b).md (n)'])))
    assert.deepEqual([noted.verdict, noted.reasons], ['coverage-gap', gapOf(['a'])], JSON.stringify(noted))
    const both = closeReview(reviewSeat(envelopeOf(['a', 'src/x.rs', ...MANY], ['a (b).md (n)'])))
    assert.deepEqual([both.verdict, both.reasons], ['valid', []], JSON.stringify(both))
    ok('`a (b).md` matches itself exactly and `a (b).md (n)` covers it, and neither covers a diffed `a`')

    const dirty = reviewSeat(gapEnvelope)
    writeFileSync(join(store.readRecord(dirty.id).record.reviewWorktree, 'scratch.txt'), 'x')
    const dirtyOut = closeReview(dirty)
    assert.deepEqual([dirtyOut.verdict, dirtyOut.reasons, dirtyOut.result], ['tree-moved', ['the review worktree is dirty'], null], JSON.stringify(dirtyOut))
    ok('a coverage gap with a dirty review worktree closes tree-moved, from the tree reason alone')

    const stale = reviewSeat(gapEnvelope)
    const staleOut = closeReview(stale, { summary: 'the run said something else' })
    assert.deepEqual([staleOut.verdict, staleOut.reasons, staleOut.result], ['unknown', ['stale-turn'], null], JSON.stringify(staleOut))
    assert.equal(store.readStamp(stale.id, 'closed').verdict, 'unknown')
    ok('a coverage gap whose T3 text is not the message Stop recorded closes unknown with stale-turn and a null result')

    const again = closeReview(gap)
    assert.deepEqual([again.verdict, again.reasons, again.result], ['coverage-gap', gapOf(['src/x.rs']), gapEnvelope], JSON.stringify(again))
    assert.equal(again.recorded, undefined)
    const thread = childThreadOf(gap.id)
    const later = closeSeat(gap.id, taskStatusOf(gap.id, { summary: gap.message, latestTerminalRunId: runIdOf(thread, 2), latestTerminalSummary: gap.message }))
    assert.deepEqual([later.verdict, later.reasons, later.result, later.recorded], ['unknown', ['stale-turn'], null, { verdict: 'coverage-gap', turn: 1 }], JSON.stringify(later))
    assert.equal(store.readStamp(gap.id, 'closed').verdict, 'coverage-gap', 'a repeated close rewrote the stamp')
    ok('a repeated close of a coverage-gap seat returns its result, and a later run on the same seat reads stale-turn with the stamp on record')
  },

  'close-rerun': () => {
    const writerWt = gitWorktree('close-rerun')
    const opened = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', writerWt])
    const seat = hookedSeat({ id: opened.id, envelope: { ...ENVELOPE_OK, commits: [{ sha: 'a'.repeat(40), subject: 'feat: x' }] } })
    // The seat's one run answered with its final message, so every status here carries it.
    const summary = seat.message
    const first = closeSeat(seat.id, taskStatusOf(seat.id, { summary }))
    assert.equal(first.verdict, 'valid')
    assert.equal(existsSync(join(jobs.leaseDirOf(writerWt), `${seat.id}.live`)), false, 'close dropped the writer\'s holder')
    store.writeState(seat.id, { ...store.readState(seat.id), outcome: 'blocked', blocks: 1 })
    const again = closeSeat(seat.id, taskStatusOf(seat.id, { status: 'failed', summary }))
    assert.equal(again.verdict, 'valid', 'a second close re-judged the seat')
    assert.deepEqual(store.readStamp(seat.id, 'closed').task, oneRunTask(seat.id, summary))
    ok('a second close prints the verdict and reasons on record, keeps the first close\'s task block, and the first close dropped the writer\'s lease holder')

    const resultPath = join(seats, seat.id, 'result-1.json')
    const stamped = store.readStamp(seat.id, 'closed')
    assert.equal(stamped.resultSha256, sha256(readFileSync(resultPath)), 'the closed stamp does not pin the result it judged')
    assert.equal(stamped.turn, 1)
    assert.deepEqual([again.reasons, again.result, again.turn, again.servedModels], [[], first.result, 1, ['claude-opus-5-5']], 'a second close did not return the result on record')
    store.writeResult(seat.id, 1, { envelope: { ...first.result, notes: 'rewritten after close' }, servedModels: ['claude-opus-5-5'], at: new Date().toISOString() })
    const third = closeSeat(seat.id, taskStatusOf(seat.id, { summary }))
    assert.equal(third.verdict, 'valid', 'the verdict on record changed')
    assert.equal(third.result, null, 'a result rewritten after the close was returned')
    assert.ok(third.reasons.includes('result-changed-after-close'), JSON.stringify(third.reasons))
    assert.deepEqual(store.readStamp(seat.id, 'closed'), stamped, 'a later close rewrote the closed stamp')
    assert.deepEqual(again, first, 'a second close with the result unchanged printed something else')
    const blockedTurn = hookedSeat({ outcome: 'blocked', blocks: 1, errors: ['$: x'] })
    store.writeResult(blockedTurn.id, 1, { envelope: ENVELOPE_OK, servedModels: ['claude-opus-5-5'], messageSha256: 'a'.repeat(64), at: new Date().toISOString() })
    const firstBlocked = closeSeat(blockedTurn.id)
    assert.equal(firstBlocked.verdict, 'invalid')
    assert.deepEqual(closeSeat(blockedTurn.id), firstBlocked, 'an invalid seat\'s unchanged earlier result read as changed after close')
    const noStop = hookedSeat({ outcome: null })
    const firstNoStop = closeSeat(noStop.id)
    assert.deepEqual(closeSeat(noStop.id), firstNoStop, 'a seat with no result read as changed after close')
    ok('the closed stamp pins the turn\'s result sha256 and the facts; a later close prints the same while the result\'s bytes match, whatever the verdict, and a null result with result-changed-after-close once they do not, the verdict unchanged')

    // Any of T3's four terminal task statuses closes: the verdict comes from the hooks.
    for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
      const each = hookedSeat({})
      const out = closeSeat(each.id, taskStatusOf(each.id, { status }))
      assert.deepEqual([out.verdict, store.readStamp(each.id, 'closed').task.status], ['valid', status], `${status}: ${JSON.stringify(out)}`)
    }
    ok('close records a seat whose task T3 ended completed, failed, cancelled or interrupted, and the stamp\'s task block keeps that status')

    for (const args of [['close'], ['close', 'xyz'], ['close', seat.id, '--x', '1'], ['close', seat.id, 'extra']]) {
      assert.equal(seatCli(args).error?.kind, 'BAD_REQUEST', args.join(' ').slice(0, 80))
    }
    ok('close refuses a missing or malformed seat id, and any argument but --abandon, with BAD_REQUEST')
  },

  'close-rerun-later-run': async () => {
    const KEYS = ['ok', 'id', 'verdict', 'reasons', 'turn', 'result', 'servedModels', 'blocks', 'errors']
    const stampPath = (id) => join(seats, id, 'closed.json')
    const laterRun = (id, ordinal, fields = {}) => taskStatusOf(id, { latestTerminalRunId: runIdOf(childThreadOf(id), ordinal), ...fields })
    // A seat closed valid on run 1, and the closed stamp's bytes as that close wrote them.
    const closedValid = () => {
      const seat = guardedSeat()
      const first = closeSeat(seat.id)
      assert.deepEqual([first.verdict, first.reasons], ['valid', []], JSON.stringify(first))
      return { ...seat, first, bytes: readFileSync(stampPath(seat.id)) }
    }
    const contradicted = (seat, status, what) => {
      const out = closeSeat(seat.id, status)
      assert.deepEqual(Object.keys(out), [...KEYS, 'recorded'], what)
      assert.deepEqual(out, { ...seat.first, verdict: 'unknown', reasons: ['stale-turn'], result: null, recorded: { verdict: 'valid', turn: 1 } }, `${what}: ${JSON.stringify(out)}`)
      assert.ok(readFileSync(stampPath(seat.id)).equals(seat.bytes), `${what} rewrote the closed stamp`)
    }

    const later = closedValid()
    contradicted(later, laterRun(later.id, 2, { latestTerminalSummary: messageWith('run 2, unhooked') }), 'a later close with a later run')
    ok('a closed seat\'s later close whose status names a later run than the stamp judged prints unknown (stale-turn) with no result and recorded {verdict, turn}, and the closed stamp stays byte-identical')

    // The parent's follow-up after the first close: even a recorded turn is a run the stamp did
    // not judge, and a later close never certifies it.
    const followed = closedValid()
    const key = followed.followUp()
    denied(seatCall('codex', followed.session, 'Bash', { command: 'ls' }, { turn_id: key }), /this seat was closed/, 'a tool call after the close')
    silent(followed.stop(messageWith('run 2 after the close'), key), 'turn 2 stop')
    contradicted(followed, laterRun(followed.id, 2, { latestTerminalSummary: messageWith('run 2 after the close') }), 'a later close after a recorded follow-up')
    ok('a later close after a follow-up the hooks recorded still reads stale-turn: the stamp judged run 1, not run 2')

    for (const [what, summary] of [['one byte changed', MESSAGE_OK.replace('"ok"', '"oK"')], ['null', null]]) {
      const seat = closedValid()
      contradicted(seat, taskStatusOf(seat.id, { summary }), `the same run with ${what}`)
    }
    ok('a later close on the same run whose text contradicts the message the stamp judged prints unknown (stale-turn) with recorded, the stamp unchanged')

    const same = closedValid()
    for (const status of [taskStatusOf(same.id), taskStatusOf(same.id, { status: 'failed', latestTerminalStatus: 'failed' })]) {
      assert.deepEqual(closeSeat(same.id, status), same.first, 'a later close on the run the stamp judged printed something else')
    }
    assert.ok(readFileSync(stampPath(same.id)).equals(same.bytes))
    ok('a later close on the run the stamp judged, with the text it judged, prints the stamp\'s valid verdict and result as before')

    // A valid stamp from before close recorded runId and messageSha256 reads as another run.
    const legacy = hookedSeat({})
    assert.equal(store.stamp(legacy.id, 'closed', { verdict: 'valid', reasons: [], turn: 1, resultSha256: store.readResult(legacy.id, 1).sha256, servedModels: [MODELS.claude], blocks: 0, errors: [] }), true)
    const legacyBytes = readFileSync(stampPath(legacy.id))
    const legacyOut = closeSeat(legacy.id)
    assert.deepEqual([legacyOut.verdict, legacyOut.reasons, legacyOut.result, legacyOut.recorded], ['unknown', ['stale-turn'], null, { verdict: 'valid', turn: 1 }], JSON.stringify(legacyOut))
    assert.ok(readFileSync(stampPath(legacy.id)).equals(legacyBytes))
    ok('a valid closed stamp written before close recorded the run it judged reads as another run: unknown (stale-turn) with recorded')

    // A stamp that certified nothing prints as before, whatever the status: invalid, unknown and
    // an abandon.
    const invalid = hookedSeat({ outcome: 'blocked', blocks: 1, errors: ['$: x'] })
    const invalidFirst = closeSeat(invalid.id)
    assert.equal(invalidFirst.verdict, 'invalid')
    const stale = guardedSeat()
    const staleFirst = closeSeat(stale.id, laterRun(stale.id, 2, { latestTerminalSummary: messageWith('run 2') }))
    assert.deepEqual([staleFirst.verdict, staleFirst.reasons], ['unknown', ['stale-turn']])
    for (const [seat, first] of [[invalid, invalidFirst], [stale, staleFirst]]) {
      const bytes = readFileSync(stampPath(seat.id))
      const out = closeSeat(seat.id, laterRun(seat.id, 3, { latestTerminalSummary: messageWith('run 3') }))
      assert.deepEqual(out, first, `a ${first.verdict} stamp printed something else on a later run`)
      assert.ok(readFileSync(stampPath(seat.id)).equals(bytes))
    }
    const abandonWt = gitWorktree('close-rerun-later-run-abandon')
    const abandoned = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', abandonWt])
    const abandonOut = seatCli(['close', abandoned.id, '--abandon'])
    const abandonBytes = readFileSync(stampPath(abandoned.id))
    assert.deepEqual(closeSeat(abandoned.id, laterRun(abandoned.id, 2)), abandonOut, 'an abandoned stamp printed something else on a later run')
    assert.ok(readFileSync(stampPath(abandoned.id)).equals(abandonBytes))
    ok('a later close of a seat closed invalid, unknown or abandoned prints the stamp\'s verdict as before, with no recorded key, whatever run the status names')

    // A review's later close reads the stamp, not the tree: the first close removed the worktree.
    const reviewOpened = seatCli(['open', '--access', 'review', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--base', baseSha, '--head', headSha])
    const review = hookedSeat({ id: reviewOpened.id, envelope: { ...ENVELOPE_OK, answer: { findings: [] }, coverage: { read: ['a.txt', 'c.txt'], partial: [], unopened: [], checksRun: [] } } })
    const reviewStatus = taskStatusOf(review.id, { summary: review.message })
    const reviewFirst = closeSeat(review.id, reviewStatus)
    assert.deepEqual([reviewFirst.verdict, existsSync(reviewOpened.reviewWorktree)], ['valid', false], JSON.stringify(reviewFirst))
    assert.deepEqual(closeSeat(review.id, reviewStatus), reviewFirst, 'a review\'s later close re-judged the removed worktree')
    const reviewLater = closeSeat(review.id, laterRun(review.id, 2, { latestTerminalSummary: messageWith('run 2') }))
    assert.deepEqual([reviewLater.verdict, reviewLater.reasons, reviewLater.recorded], ['unknown', ['stale-turn'], { verdict: 'valid', turn: 1 }], JSON.stringify(reviewLater))
    ok('a review\'s later close on its judged run prints valid without re-reading the removed worktree, and on a later run prints stale-turn with recorded')

    // Two first closes with one status: the first is held just after its stamp is linked, and the
    // second, which loses the stamp, prints the winner's record.
    const raced = guardedSeat()
    const gate = join(tmp, 'close-rerun-race')
    t3Status(raced.id)
    const winner = await heldAt([SEAT_SCRIPT, 'close', raced.id], gate, 'closed')
    const loser = closeSeat(raced.id)
    writeFileSync(`${gate}.go`, '')
    const won = await winner.done
    assert.equal(won.code, 0, won.out)
    assert.deepEqual([loser.verdict, loser.reasons, Object.hasOwn(loser, 'recorded')], ['valid', [], false], JSON.stringify(loser))
    assert.deepEqual(JSON.parse(won.out), loser, 'the racing closes printed different records')
    ok('two first closes on one status keep the write-once outcome: the one that loses the stamp prints the winner\'s valid record')
  },

  // The stale-turn cases run their seats through the real hooks, so the state close reads (turn,
  // turnKey, opened, messageSha256) holds the bytes the hooks write, and each task status is the
  // one T3 would answer for that history: the child's run 1 and its summary, and the latest
  // finished run's id, status and summary.
  // The stale-turn cases run their seats through the real hooks, so the state close reads (turn,
  // turnKey, opened, messageSha256) holds the bytes the hooks write, and each task status is the
  // one T3 would answer for that history: the child's run 1 and its summary, and the latest
  // finished run's id, status and summary.
  // The stale-turn cases run their seats through the real hooks, so the state close reads (turn,
  // turnKey, opened, messageSha256) holds the bytes the hooks write, and each task status is the
  // one T3 would answer for that history: the child's run 1 and its summary, and the latest
  // finished run's id, status and summary.
  // The stale-turn cases run their seats through the real hooks, so the state close reads (turn,
  // turnKey, opened, messageSha256) holds the bytes the hooks write, and each task status is the
  // one T3 would answer for that history: the child's run 1 and its summary, and the latest
  // finished run's id, status and summary.
  'close-stale-run': () => {
    // The incident: turn 1 recorded valid, then two more runs with every flow hook dark, the last
    // completing with an answer the hooks never saw.
    const seat = guardedSeat()
    const status = taskStatusOf(seat.id, { latestTerminalRunId: runIdOf(childThreadOf(seat.id), 3), latestTerminalSummary: messageWith('run 3, unhooked') })
    const out = closeSeat(seat.id, status)
    assert.deepEqual([out.verdict, out.reasons, out.result, out.turn], ['unknown', ['stale-turn'], null, 1], JSON.stringify(out))
    const stamped = store.readStamp(seat.id, 'closed')
    assert.deepEqual([stamped.verdict, stamped.reasons, stamped.runId, stamped.messageSha256], ['unknown', ['stale-turn'], status.latestTerminalRunId, sha256(MESSAGE_OK)])
    ok('a seat whose turn 1 is recorded valid closes unknown (stale-turn) with no result when T3\'s latest finished run is a later one with other text and no hook recorded it, and the closed stamp records that run and the digest it judged')
  },

  'close-later-run-recorded': () => {
    const seat = guardedSeat()
    const key = seat.followUp()
    const second = messageWith('run 2, recorded')
    silent(seat.stop(second, key), 'turn 2 stop')
    const out = closeSeat(seat.id, taskStatusOf(seat.id, { latestTerminalRunId: runIdOf(childThreadOf(seat.id), 2), latestTerminalSummary: second }))
    assert.deepEqual([out.verdict, out.reasons, out.turn, out.result], ['valid', [], 2, JSON.parse(second)], JSON.stringify(out))
    ok('a follow-up the hooks recorded closes valid on turn 2 when T3\'s latest run is run 2 with that turn\'s text, the summary still run 1\'s')
  },

  'close-later-run-duplicate-text': () => {
    const seat = guardedSeat()
    const key = seat.followUp()
    silent(seat.stop(MESSAGE_OK, key), 'turn 2 repeats turn 1')
    assert.deepEqual([store.readState(seat.id).turn, store.readState(seat.id).messageSha256], [2, sha256(MESSAGE_OK)])
    // T3 nulls latestTerminalSummary when it repeats the summary.
    const out = closeSeat(seat.id, taskStatusOf(seat.id, { latestTerminalRunId: runIdOf(childThreadOf(seat.id), 2), latestTerminalSummary: null }))
    assert.deepEqual([out.verdict, out.reasons, out.turn], ['valid', [], 2], JSON.stringify(out))
    ok('a recorded follow-up whose text repeats turn 1\'s closes valid on turn 2: T3 nulls latestTerminalSummary, and the summary is the recorded message')
  },

  'close-same-run': () => {
    const seat = guardedSeat()
    const out = closeSeat(seat.id)
    assert.deepEqual([out.verdict, out.reasons, out.turn, out.result], ['valid', [], 1, ENVELOPE_OK], JSON.stringify(out))
    const other = guardedSeat()
    const ignored = closeSeat(other.id, taskStatusOf(other.id, { latestTerminalSummary: messageWith('not the child run\'s summary') }))
    assert.deepEqual([ignored.verdict, ignored.reasons], ['valid', []], JSON.stringify(ignored))
    ok('a task whose latest run is the child run closes valid on the child run\'s summary, whatever latestTerminalSummary holds')
  },

  'close-same-run-raw-bytes': () => {
    for (const [what, message] of [
      ['a trailing newline', `${MESSAGE_OK}\n`], ['a fenced envelope', `\`\`\`json\n${MESSAGE_OK}\n\`\`\``], ['CRLF and spaces around it', `  ${MESSAGE_OK}\r\n`],
    ]) {
      const seat = guardedSeat(message)
      assert.deepEqual([store.readState(seat.id).outcome, store.readState(seat.id).messageSha256], ['valid', sha256(message)], `${what}: the hook did not record the raw message`)
      const out = closeSeat(seat.id, taskStatusOf(seat.id, { summary: message }))
      assert.deepEqual([out.verdict, out.reasons, out.result], ['valid', [], ENVELOPE_OK], `${what}: ${JSON.stringify(out)}`)
      const normalized = guardedSeat(message)
      const stale = closeSeat(normalized.id, taskStatusOf(normalized.id, { summary: MESSAGE_OK }))
      assert.deepEqual([stale.verdict, stale.reasons], ['unknown', ['stale-turn']], `${what} compared after normalizing`)
    }
    ok('a final message with a trailing newline, a fence, or CRLF and spaces closes valid against a summary of the same raw bytes, and stale-turn against the bare envelope: nothing is trimmed or unfenced')
  },

  'close-blocked-then-valid': () => {
    const seat = guardedSeat(null)
    stopBlocked(seat.stop('not an envelope', seat.first), 'the first final message fails')
    silent(seat.stop(MESSAGE_OK, seat.first), 'the resumed turn answers')
    assert.deepEqual([store.readState(seat.id).outcome, store.readState(seat.id).blocks], ['valid', 1])
    const out = closeSeat(seat.id)
    assert.deepEqual([out.verdict, out.reasons, out.turn, out.blocks, out.result], ['valid', [], 1, 1, ENVELOPE_OK], JSON.stringify(out))
    ok('a turn whose first final message was blocked and whose resumed answer passed closes valid on the run\'s summary, the resumed answer')
  },

  'close-same-run-mismatch': () => {
    for (const [what, summary] of [
      ['one byte changed', MESSAGE_OK.replace('"ok"', '"oK"')], ['one byte added', `${MESSAGE_OK} `], ['one byte dropped', MESSAGE_OK.slice(0, -1)], ['null', null],
    ]) {
      const seat = guardedSeat()
      const out = closeSeat(seat.id, taskStatusOf(seat.id, { summary }))
      assert.deepEqual([out.verdict, out.reasons, out.result], ['unknown', ['stale-turn'], null], `${what}: ${JSON.stringify(out)}`)
    }
    ok('a same-run summary one byte apart from the recorded message, or none, closes unknown (stale-turn)')
  },

  'close-failed-latest-run': () => {
    const errorText = 'Error: the provider exited with code 1'
    // A later run with no hook call that failed.
    for (const latestTerminalSummary of [null, errorText]) {
      const seat = guardedSeat()
      const out = closeSeat(seat.id, taskStatusOf(seat.id, { latestTerminalRunId: runIdOf(childThreadOf(seat.id), 2), latestTerminalStatus: 'failed', latestTerminalSummary }))
      assert.deepEqual([out.verdict, out.reasons, out.result], ['unknown', ['stale-turn'], null], `failed with ${latestTerminalSummary}: ${JSON.stringify(out)}`)
    }
    // A recorded turn 2 whose run T3 then reports ended otherwise: no text, whatever the summary
    // holds, so the opened key cannot vouch for it.
    for (const latestTerminalStatus of ['failed', 'cancelled', 'interrupted']) {
      for (const pick of ['null', 'error', 'the recorded text']) {
        const seat = guardedSeat()
        const key = seat.followUp()
        const second = messageWith(`run 2, then ${latestTerminalStatus}`)
        silent(seat.stop(second, key), 'turn 2 stop')
        const latestTerminalSummary = { null: null, error: errorText, 'the recorded text': second }[pick]
        const out = closeSeat(seat.id, taskStatusOf(seat.id, { latestTerminalRunId: runIdOf(childThreadOf(seat.id), 2), latestTerminalStatus, latestTerminalSummary }))
        assert.deepEqual([out.verdict, out.reasons], ['unknown', ['stale-turn']], `${latestTerminalStatus} with ${pick}: ${JSON.stringify(out)}`)
      }
    }
    ok('a latest run that ended failed, cancelled or interrupted gives no text, so close reads unknown (stale-turn) with a null summary, an error summary, or even the recorded text, hooked or not')
  },

  'close-ordinal-without-prompt': () => {
    for (const latestTerminalSummary of [null, MESSAGE_OK]) {
      const seat = guardedSeat()
      assert.equal(Object.hasOwn(store.readState(seat.id), 'opened'), false)
      const out = closeSeat(seat.id, taskStatusOf(seat.id, { latestTerminalRunId: runIdOf(childThreadOf(seat.id), 2), latestTerminalSummary }))
      assert.deepEqual([out.verdict, out.reasons, out.result], ['unknown', ['stale-turn'], null], `${latestTerminalSummary}: ${JSON.stringify(out)}`)
    }
    ok('a latest run past the child run with no follow-up prompt on record closes unknown (stale-turn), even when its text is turn 1\'s byte for byte')
  },

  'close-failed-then-retried': () => {
    // T3 run 2 failed with no stop: once after its prompt was recorded, once before any hook ran.
    // Run 3 is then flow's turn 2: a run ordinal is never a turn count.
    for (const run2 of ['prompt recorded', 'no hook']) {
      const seat = guardedSeat()
      if (run2 === 'prompt recorded') seat.followUp()
      const key = seat.followUp()
      const third = messageWith(`run 3 after a failed run 2 (${run2})`)
      silent(seat.stop(third, key), 'run 3 stop')
      assert.equal(store.readState(seat.id).turn, 2)
      const out = closeSeat(seat.id, taskStatusOf(seat.id, { latestTerminalRunId: runIdOf(childThreadOf(seat.id), 3), latestTerminalSummary: third }))
      assert.deepEqual([out.verdict, out.reasons, out.turn, out.result], ['valid', [], 2, JSON.parse(third)], `${run2}: ${JSON.stringify(out)}`)
    }
    ok('a failed run 2 followed by a hooked run 3 closes valid on flow turn 2, whether run 2\'s prompt was recorded or not')
  },

  'close-recorded-then-dark': () => {
    const seat = guardedSeat()
    const key = seat.followUp()
    silent(seat.stop(messageWith('run 2, recorded'), key), 'turn 2 stop')
    const out = closeSeat(seat.id, taskStatusOf(seat.id, { latestTerminalRunId: runIdOf(childThreadOf(seat.id), 3), latestTerminalSummary: messageWith('run 3, unhooked') }))
    assert.deepEqual([out.verdict, out.reasons, out.turn, out.result], ['unknown', ['stale-turn'], 2, null], JSON.stringify(out))
    ok('a recorded follow-up followed by an unhooked run with new text closes unknown (stale-turn): the opened key of turn 2 does not vouch for run 3')
  },

}

await runSection('close-verdicts', cases)
