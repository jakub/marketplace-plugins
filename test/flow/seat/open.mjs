// Seat smoke section: open. Run via `node test/flow/smoke-seat.mjs` or directly.
import { assert, spawn, spawnSync, createHash, randomUUID, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, createServer, performance, DatabaseSync, tmpdir, dirname, join, fileURLToPath, pathToFileURL, PLUGIN, STORE, tmp, state, t3Home, store, wire, seatPolicy, RETENTION_MS, schemas, ok, sha256, mode, seats, INSTANCE, RECORD, SCHEMA, ENVELOPE_OK, racer, race, GUARD, guard, silent, denied, blocked, context, stopBlocked, MODELS, PERMISSION, SPELLING, call, stopCall, promptCall, preCall, EFFORT_OPTION, delegateInput, seatRecord, admit, admittedSeat, worktree, ACCESSES, boundSeat, seatCall, editCalls, indexEntries, SEAT_SCRIPT, jobs, seatCli, fakeCodexBin, OWN_HOOKS, installedRoot, FAKE_ROOT, treeDigest, DRIFTED_ROOT, snake, flowEntries, FOREIGN, codexState, codexSent, codexHooks, flowDigest, trustedCodex, T3_TABLES, T3_INDEXES, t3Store, t3, T3_SESSION, T3_OWNER, t3Time, taskIdOf, childThreadOf, runIdOf, t3TaskRow, t3RunRow, t3MessageRow, t3Forget, t3Seat, MESSAGE_OK, taskStatusOf, t3Status, closeSeat, oneRunTask, writerSeat, recordFiles, refusedClose, gitEnv, gitOut, canon, baseSha, headSha, linkedWt, gitWorktree, jobRecord, hookedSeat, guardedSeat, messageWith, rootedCodexSeat, holderGate, jobGate, stampGate, scanGate, heldChildren, heldAt, waitFor, leaseRacer, leaseRace, runSection } from './helpers.mjs'

const cases = {
  'open-access': () => {
    const read = seatCli(['open', '--access', 'read-only', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high'])
    assert.deepEqual(Object.keys(read), ['ok', 'id', 'tag', 'clientRequestId', 'runtimeMode', 'provider', 'providerInstanceId', 'model', 'expectedServedModel', 'effort', 'worktree', 'reviewWorktree'])
    assert.equal(read.ok, true)
    assert.match(read.id, /^[0-9a-f]{32}$/)
    assert.equal(read.tag, `<flow-seat id=${read.id}>`)
    assert.equal(read.clientRequestId, `flow-seat-${read.id}`)
    assert.deepEqual({ ...read, id: undefined, tag: undefined, clientRequestId: undefined }, {
      ok: true, id: undefined, tag: undefined, clientRequestId: undefined, runtimeMode: 'auto', provider: 'claude', providerInstanceId: 'claudeAgent',
      model: 'claude-opus-5-5', expectedServedModel: 'claude-opus-5-5', effort: 'high', worktree: canon, reviewWorktree: null,
    })
    const loaded = store.readRecord(read.id)
    assert.deepEqual(Object.keys(loaded.record), [
      'v', 'id', 'createdAt', 'access', 'repoRoot', 'worktree', 'reviewWorktree', 'reviewGitDir', 'baseSha', 'headSha', 'provider', 'providerInstanceId',
      'model', 'expectedServedModel', 'effort', 'runtimeMode', 'canonicalSnapshot', 'hooksDigest', 'schemaSha256',
    ])
    assert.deepEqual({ ...loaded.record, createdAt: undefined }, {
      v: 1, id: read.id, createdAt: undefined, access: 'read-only', repoRoot: canon, worktree: canon, reviewWorktree: null, baseSha: null, headSha: null,
      reviewGitDir: null, provider: 'claude', providerInstanceId: 'claudeAgent', model: 'claude-opus-5-5', expectedServedModel: 'claude-opus-5-5', effort: 'high',
      runtimeMode: 'auto', canonicalSnapshot: null, hooksDigest: null, schemaSha256: null,
    })
    assert.equal(loaded.schema, null)
    ok('a read-only seat opens in the working directory\'s worktree: the output names its id, tag, clientRequestId flow-seat-<id>, runtimeMode auto, provider, instance, model, expected served model, effort and worktree in that order, and the record holds the same with no schema')

    const schemaFile = join(tmp, 'answer-schema.json')
    writeFileSync(schemaFile, JSON.stringify(SCHEMA))
    const linked = seatCli(['open', '--access', 'read-only', '--provider', 'codex', '--model', 'gpt-6-luna', '--effort', 'medium', '--worktree', join(linkedWt, 'sub'), '--schema', schemaFile])
    assert.equal(linked.worktree, linkedWt)
    const linkedRecord = store.readRecord(linked.id)
    assert.deepEqual([linked.providerInstanceId, linked.expectedServedModel], ['codex', 'gpt-6-luna'])
    assert.deepEqual([linkedRecord.record.providerInstanceId, linkedRecord.record.expectedServedModel], ['codex', 'gpt-6-luna'])
    assert.equal(linkedRecord.record.repoRoot, canon, 'the canonical checkout of a linked worktree is the main worktree')
    assert.equal(linkedRecord.record.worktree, linkedWt)
    assert.deepEqual(linkedRecord.schema, SCHEMA)
    ok('--worktree inside a linked worktree opens at that worktree\'s top level, with the main worktree as the canonical checkout, and --schema is stored as the answer schema; a codex seat defaults to instance codex and its own model')

    const writer = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', linkedWt])
    assert.equal(writer.worktree, linkedWt)
    assert.deepEqual(readdirSync(jobs.leaseDirOf(linkedWt)), [`${writer.id}.live`], 'the writer holds the worktree\'s lease directory under its seat id, live')
    assert.equal(store.readRecord(writer.id).record.access, 'workspace-write')
    closeSeat(writer.id)
    assert.equal(existsSync(jobs.leaseDirOf(linkedWt)), false, 'close dropped the holder and the empty lease directory')
    ok('a writer seat writes its holder file into the worktree\'s lease directory, and close drops it')
  },

  'open-custom-instance': () => {
    const ROUTER = 'accounts/fireworks/routers/glm-5p3-us'
    const SERVED = 'accounts/fireworks/models/glm-5p3'
    const glm = seatCli(['open', '--access', 'read-only', '--provider', 'claude', '--provider-instance-id', 'glm', '--model', ROUTER, '--expected-served-model', SERVED, '--effort', 'high'])
    assert.equal(glm.ok, true, JSON.stringify(glm))
    assert.deepEqual([glm.provider, glm.providerInstanceId, glm.model, glm.expectedServedModel, glm.effort], ['claude', 'glm', ROUTER, SERVED, 'high'])
    const { record } = store.readRecord(glm.id)
    assert.deepEqual([record.provider, record.providerInstanceId, record.model, record.expectedServedModel], ['claude', 'glm', ROUTER, SERVED])
    for (const key of ['endpoint', 'baseUrl', 'credential', 'apiKey', 'family', 'vendor']) assert.equal(Object.hasOwn(record, key), false, key)
    ok('a claude-family seat opens on a custom instance with a router model and a distinct expected served model, and the record stores the two ids exactly, with no endpoint, credential or vendor')

    const exact = (id) => seatCli(['open', '--access', 'read-only', '--provider', 'claude', '--provider-instance-id', id, '--model', 'claude-opus-5-5', '--effort', 'high'])
    for (const id of ['Glm', 'glm ', ' glm', 'glm/US', 'é'.repeat(64)]) {
      const out = exact(id)
      assert.equal(out.ok, true, `${JSON.stringify(id)}: ${JSON.stringify(out)}`)
      assert.equal(out.providerInstanceId, id)
      assert.equal(store.readRecord(out.id).record.providerInstanceId, id, `${JSON.stringify(id)} was trimmed or normalized`)
    }
    const decomposed = 'e\u0301'
    assert.equal(store.readRecord(exact(decomposed).id).record.providerInstanceId, decomposed, 'a decomposed id was normalized')
    assert.equal(Buffer.byteLength('é'.repeat(64)), 128)
    ok('an instance id is stored exactly as given, case, spaces and decomposition kept, up to 128 UTF-8 bytes of multibyte text')

    const claudeExpected = seatCli(['open', '--access', 'read-only', '--provider', 'claude', '--model', 'claude-opus-5-5', '--expected-served-model', 'claude-opus-5-5-20261001', '--effort', 'high'])
    assert.deepEqual([claudeExpected.providerInstanceId, claudeExpected.expectedServedModel], ['claudeAgent', 'claude-opus-5-5-20261001'])
    ok('a claude seat on its default instance may expect a served id other than the one it asks for')
  },

  'open-review': () => {
    const review = seatCli(['open', '--access', 'review', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--base', 'main~1', '--head', 'main'])
    const path = join(canon, '.flow-worktrees', `review-${review.id}`)
    assert.equal(review.worktree, path)
    assert.equal(review.reviewWorktree, path)
    assert.equal(gitOut(path, 'rev-parse', 'HEAD'), headSha, 'the review worktree is at the head')
    assert.equal(spawnSync('git', ['-C', path, 'symbolic-ref', '-q', 'HEAD']).status, 1, 'the review worktree is detached')
    const { record, schema } = store.readRecord(review.id)
    assert.deepEqual([record.baseSha, record.headSha, record.repoRoot, record.worktree, record.reviewWorktree], [baseSha, headSha, canon, path, path])
    assert.deepEqual(schema, schemas.FINDINGS_SCHEMA)
    assert.deepEqual(Object.keys(record.canonicalSnapshot).sort(), ['branch', 'cached', 'diff', 'head', 'origin', 'status', 'untracked'])
    assert.equal(record.canonicalSnapshot.origin, null, 'a canonical checkout with no origin records null')
    assert.equal(record.reviewGitDir, realpathSync(gitOut(path, 'rev-parse', '--absolute-git-dir')))
    assert.equal(gitOut(canon, 'status', '--porcelain'), '', 'the review worktree shows nowhere in the canonical checkout')
    ok('a review seat resolves --base and --head to SHAs, adds a detached worktree at the head under .flow-worktrees/review-<id>, answers in the findings schema, and records a canonical snapshot with HEAD, branch and origin and the review worktree\'s git directory')

    const byWorktree = seatCli(['open', '--access', 'review', '--provider', 'codex', '--model', 'gpt-6-luna', '--effort', 'high', '--worktree', linkedWt, '--base', 'HEAD~1', '--head', 'HEAD'])
    assert.equal(store.readRecord(byWorktree.id).record.headSha, gitOut(linkedWt, 'rev-parse', 'HEAD'), '--worktree names where the revisions resolve')
    assert.ok(byWorktree.reviewWorktree.startsWith(join(canon, '.flow-worktrees', 'review-')), 'the review worktree lives under the canonical checkout')
    ok('a review seat resolves its revisions in --worktree and still adds its worktree under the canonical checkout')
  },

  'open-exclude': () => {
    // Outside the claim, a repository's exclude file need not hold /.flow-worktrees/. A repository
    // with canon's two commits, whose info directory is gone or whose exclude lacks the line.
    const reviewRepo = (name) => {
      const path = gitWorktree(name)
      for (const [file, text] of [['a.txt', 'a\n'], ['b.txt', 'b\n']]) writeFileSync(join(path, file), text)
      gitOut(path, 'add', '-A')
      gitOut(path, 'commit', '-q', '-m', 'base')
      const base = gitOut(path, 'rev-parse', 'HEAD')
      writeFileSync(join(path, 'a.txt'), 'a2\n')
      writeFileSync(join(path, 'c.txt'), 'c\n')
      gitOut(path, 'add', '-A')
      gitOut(path, 'commit', '-q', '-m', 'head')
      return { path, base, head: gitOut(path, 'rev-parse', 'HEAD') }
    }
    const openReview = (repo) => {
      const out = seatCli(['open', '--access', 'review', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--base', repo.base, '--head', repo.head], { cwd: repo.path })
      assert.equal(out.ok, true, JSON.stringify(out))
      return out
    }
    const exclude = (repo) => readFileSync(join(repo.path, '.git', 'info', 'exclude'), 'utf8')

    // A symlinked info directory would carry the append to a file outside the repository.
    const linked = reviewRepo('exclude-linked-info')
    const outside = mkdtempSync(join(tmp, 'outside-info-'))
    writeFileSync(join(outside, 'exclude'), 'outside\n')
    rmSync(join(linked.path, '.git', 'info'), { recursive: true, force: true })
    symlinkSync(outside, join(linked.path, '.git', 'info'))
    const refusedLink = seatCli(['open', '--access', 'review', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--base', linked.base, '--head', linked.head], { cwd: linked.path })
    assert.equal(refusedLink.ok, false, 'a review seat opened through a symlinked .git/info')
    assert.equal(refusedLink.error.kind, 'GIT_REF')
    assert.equal(readFileSync(join(outside, 'exclude'), 'utf8'), 'outside\n', 'open wrote through a symlinked .git/info')
    ok('open refuses a review seat whose .git/info is a symlink and writes nothing through it')

    const bare = reviewRepo('exclude-no-info')
    rmSync(join(bare.path, '.git', 'info'), { recursive: true })
    openReview(bare)
    assert.equal(exclude(bare), '/.flow-worktrees/\n', 'open did not create info/exclude with the line')
    const unterminated = reviewRepo('exclude-unterminated')
    writeFileSync(join(unterminated.path, '.git', 'info', 'exclude'), '*.log')
    openReview(unterminated)
    openReview(unterminated)
    assert.equal(exclude(unterminated), '*.log\n/.flow-worktrees/\n', 'open did not append the line once, on a line of its own')
    ok('a review seat\'s open adds /.flow-worktrees/ to the repository\'s exclude file once, creating info/ when it is missing')

    // Two review seats overlap in one repository: the second's worktree must not move the first's
    // canonical snapshot, nor the first's removal at close the second's.
    const repo = reviewRepo('exclude-overlap')
    const envelope = { ...ENVELOPE_OK, answer: { findings: [] }, coverage: { read: ['a.txt', 'c.txt'], partial: [], unopened: [], checksRun: [] } }
    const first = hookedSeat({ id: openReview(repo).id, envelope })
    const second = hookedSeat({ id: openReview(repo).id, envelope })
    assert.equal(gitOut(repo.path, 'status', '--porcelain'), '', 'a review worktree shows in the canonical checkout')
    for (const seat of [first, second]) {
      const out = closeSeat(seat.id, taskStatusOf(seat.id, { summary: seat.message }))
      assert.deepEqual([out.verdict, out.reasons], ['valid', []], JSON.stringify(out))
    }
    ok('two overlapping review seats in a repository whose exclude lacked the line each close valid, neither reading the other\'s worktree as tree-moved')
  },

  'open-refusals': () => {
    const base = ['--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high']
    const before = () => [existsSync(seats) ? readdirSync(seats).filter((name) => /^[0-9a-f]{32}$/.test(name)).sort() : [], gitOut(canon, 'worktree', 'list', '--porcelain')]
    const snapshot = before()
    const refusals = [
      [['open'], 'BAD_REQUEST'], [['open', '--access', 'admin', ...base], 'BAD_REQUEST'],
      [['open', '--access', 'read-only', '--provider', 'gemini', '--model', 'm', '--effort', 'high'], 'BAD_REQUEST'],
      [['open', '--access', 'read-only', '--provider', 'claude', '--model', 'a b', '--effort', 'high'], 'BAD_REQUEST'],
      [['open', '--access', 'read-only', '--provider', 'claude', '--model', 'm', '--effort', 'HIGH'], 'BAD_REQUEST'],
      [['open', '--access', 'read-only', ...base, '--worktree', 'relative/path'], 'BAD_REQUEST'],
      [['open', '--access', 'read-only', ...base, '--worktree', join(tmp, 'no-such-dir')], 'BAD_REQUEST'],
      [['open', '--access', 'read-only', ...base, '--worktree', tmp], 'BAD_REQUEST'],
      [['open', '--access', 'read-only', ...base, '--base', 'HEAD~1', '--head', 'HEAD'], 'BAD_REQUEST'],
      [['open', '--access', 'workspace-write', ...base], 'BAD_REQUEST'],
      [['open', '--access', 'read-only', ...base, '--color', 'red'], 'BAD_REQUEST'],
      [['open', '--access', 'read-only', '--access', 'review', ...base], 'BAD_REQUEST'],
      [['open', '--access', 'read-only', ...base, '--worktree'], 'BAD_REQUEST'],
      [['open', '--access', 'review', ...base, '--base', 'HEAD~1'], 'GIT_REF'],
      [['open', '--access', 'review', ...base, '--base', 'no-such-ref', '--head', 'HEAD'], 'GIT_REF'],
      [['open', '--access', 'review', ...base, '--base', '--output=x', '--head', 'HEAD'], 'GIT_REF'],
      [['open', '--access', 'review', ...base, '--base', 'HEAD~1', '--head', 'HEAD', '--schema', join(tmp, 'answer-schema.json')], 'BAD_SCHEMA'],
      [['bogus'], 'BAD_REQUEST'],
    ]
    for (const [args, kind] of refusals) {
      const out = seatCli(args)
      assert.equal(out.ok, false, args.join(' '))
      assert.deepEqual(Object.keys(out), ['ok', 'error'])
      assert.equal(out.error.kind, kind, `${args.join(' ')}: ${out.error.message}`)
      assert.equal(typeof out.error.message, 'string')
    }
    const spaced = join(tmp, 'has space', 'repo')
    mkdirSync(spaced, { recursive: true })
    gitOut(spaced, 'init', '-q')
    const unaddressable = seatCli(['open', '--access', 'workspace-write', ...base, '--worktree', spaced])
    assert.equal(unaddressable.ok, false, 'a writer whose worktree path is not a plain shell word opened')
    assert.equal(unaddressable.error.kind, 'BAD_REQUEST')
    assert.match(unaddressable.error.message, /plain shell word/)
    assert.deepEqual(before(), snapshot, 'a refused open left a record or a worktree behind')
    ok('open refuses a writer whose worktree path is not a plain shell word, since its git writes could never name it after -C')
    ok('open refuses a bad access, provider, model or effort, a relative, missing or non-repository --worktree, revisions off a review, a writer with no --worktree, an unknown, repeated or valueless flag (BAD_REQUEST), a review with a missing or unresolvable revision (GIT_REF) or with --schema (BAD_SCHEMA), and leaves no record or worktree behind')

    const schemaCase = (name, bytes) => {
      const file = join(tmp, `schema-${name}.json`)
      writeFileSync(file, bytes)
      return seatCli(['open', '--access', 'read-only', ...base, '--schema', file])
    }
    const padded = (size) => {
      const shell = { type: 'object', description: '' }
      const text = JSON.stringify({ ...shell, description: 'x'.repeat(size - JSON.stringify(shell).length) })
      assert.equal(Buffer.byteLength(text), size)
      return text
    }
    assert.equal(schemaCase('cap', padded(16 * 1024)).ok, true, 'a schema of exactly 16 KiB')
    for (const [name, bytes] of [
      ['over', padded(16 * 1024 + 1)], ['not-json', '{"type": '], ['array', '[]'], ['not-object-type', '{"type": "string"}'],
      ['unchecked', '{"type": "object", "patternProperties": {}}'],
    ]) {
      const out = schemaCase(name, bytes)
      assert.equal(out.ok, false, name)
      assert.equal(out.error.kind, 'BAD_SCHEMA', `${name}: ${out.error.message}`)
    }
    for (const path of ['relative.json', join(tmp, 'no-such-schema.json')]) assert.equal(seatCli(['open', '--access', 'read-only', ...base, '--schema', path]).error.kind, 'BAD_SCHEMA')
    ok('--schema is admitted up to 16 KiB under outputSchema\'s keyword rules, and a larger, unparsable, non-object, unchecked-keyword, relative or missing one is BAD_SCHEMA')

    // An identity refusal comes before open prunes or creates anything: a record closed past
    // retention is still there after, and no record, lease holder, worktree or exclude line is new.
    const stale = store.writeRecord(RECORD(), null).id
    store.stamp(stale, 'closed', { at: new Date(Date.now() - RETENTION_MS - 60_000).toISOString(), verdict: 'valid', reasons: [] })
    const identityWt = gitWorktree('open-identity')
    rmSync(join(identityWt, '.git', 'info', 'exclude'), { force: true })
    const leases = () => (existsSync(join(state, 'leases')) ? readdirSync(join(state, 'leases')).sort() : [])
    const exclude = (path) => (existsSync(join(path, '.git', 'info', 'exclude')) ? readFileSync(join(path, '.git', 'info', 'exclude'), 'utf8') : null)
    const world = () => [before(), leases(), exclude(canon), exclude(identityWt), gitOut(identityWt, 'worktree', 'list', '--porcelain'), existsSync(join(seats, stale))]
    const identityBefore = world()
    const claude = ['--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high']
    const codex = ['--provider', 'codex', '--model', 'gpt-6-luna', '--effort', 'high']
    const refusedIdentity = [
      [[...claude, '--provider-instance-id', ''], /--provider-instance-id must be/],
      [[...claude, '--provider-instance-id', 'a'.repeat(129)], /--provider-instance-id must be/],
      [[...claude, '--provider-instance-id', `${'é'.repeat(64)}a`], /--provider-instance-id must be/],
      [[...claude, '--provider-instance-id', 'gl\tm'], /--provider-instance-id must be/],
      [[...claude, '--provider-instance-id', 'glm\n'], /--provider-instance-id must be/],
      [[...claude, '--provider-instance-id', 'glm\u007f'], /--provider-instance-id must be/],
      [[...claude, '--provider-instance-id', 'glm\u0085'], /--provider-instance-id must be/],
      [[...claude, '--expected-served-model', ''], /--expected-served-model must be a model id/],
      [[...claude, '--expected-served-model', 'a b'], /--expected-served-model must be a model id/],
      [[...claude, '--expected-served-model', '-x'], /--expected-served-model must be a model id/],
      [[...claude, '--provider-instance-id', 'glm', '--provider-instance-id', 'glm'], /given twice/],
      [[...claude, '--expected-served-model'], /needs a value/],
      [[...claude, '--provider-instance-id', 'codex'], /claude seat cannot run on provider instance codex/],
      [[...codex, '--provider-instance-id', 'claudeAgent'], /codex seat cannot run on provider instance claudeAgent/],
      [[...codex, '--provider-instance-id', 'codex-work'], /codex seat runs on provider instance codex alone/],
      [[...codex, '--provider-instance-id', 'Codex'], /codex seat runs on provider instance codex alone/],
      [[...codex, '--expected-served-model', 'gpt-6-mini'], /codex seat's expectedServedModel must be its model/],
      [[...codex, '--provider-instance-id', 'codex', '--expected-served-model', 'gpt-6-mini'], /codex seat's expectedServedModel must be its model/],
    ]
    for (const [flags, pattern] of refusedIdentity) {
      for (const access of [['read-only'], ['workspace-write', '--worktree', identityWt], ['review', '--worktree', identityWt, '--base', 'HEAD', '--head', 'HEAD']]) {
        const out = seatCli(['open', '--access', ...access, ...flags])
        assert.equal(out.ok, false, `${access[0]} ${JSON.stringify(flags)}`)
        assert.equal(out.error.kind, 'BAD_REQUEST', `${access[0]} ${JSON.stringify(flags)}: ${out.error.message}`)
        assert.match(out.error.message, pattern, `${access[0]} ${JSON.stringify(flags)}`)
      }
    }
    assert.deepEqual(world(), identityBefore, 'an identity refusal pruned, created or changed something')
    assert.ok(store.readRecord(stale), 'an identity refusal pruned a record')
    // The next open would prune it, and the cases after this one count seat directories.
    rmSync(join(seats, stale), { recursive: true })
    ok('open refuses BAD_REQUEST an empty, 129-byte or control-character instance id, an empty or malformed expected id, a repeated or valueless flag, a claude seat on instance codex, and a codex seat on any other instance or expecting another model, for every access, before it prunes or creates any record, lease holder, worktree or exclude line')
  },

  'open-context-budget': () => {
    // The seat context repeats the record's paths, and a writer's repeats its worktree three times
    // and the repository once, so a path of about 1.6 KB cannot be delivered under the 6000-byte
    // hook budget even with the schema left out by path.
    const LIMIT = 6000
    const base = ['--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high']
    const chain = (name, parts) => {
      const path = join(tmp, 'long', name, ...Array.from({ length: parts }, (_, at) => `${at}${'d'.repeat(199)}`))
      mkdirSync(path, { recursive: true })
      gitOut(path, 'init', '-q')
      return realpathSync(path)
    }
    const seatDirs = () => (existsSync(seats) ? readdirSync(seats).filter((name) => /^[0-9a-f]{32}$/.test(name)).sort() : [])

    const tooLong = chain('too-long', 8)
    assert.ok(tooLong.length > 1600, `${tooLong.length}`)
    const dirsBefore = seatDirs()
    const refused = seatCli(['open', '--access', 'workspace-write', ...base, '--worktree', tooLong])
    assert.equal(refused.ok, false, 'a seat whose context cannot fit the hook budget opened')
    assert.equal(refused.error.kind, 'BAD_REQUEST')
    assert.match(refused.error.message, /longer than the 6000-byte hook budget; use shorter paths/)
    assert.deepEqual(seatDirs(), dirsBefore, 'the refused open left a seat directory behind')
    assert.equal(existsSync(jobs.leaseDirOf(tooLong)), false, 'the refused open left a lease holder behind')
    assert.throws(() => seatPolicy.seatContext({ ...RECORD({ access: 'workspace-write' }), worktree: tooLong, repoRoot: tooLong }, SCHEMA, '/s/schema.json'), { code: 'CONTEXT_TOO_LONG' })
    ok('open refuses a writer whose long paths make the context past 6000 bytes, BAD_REQUEST, leaving no seat record and no lease holder')

    const fitting = chain('fitting', 4)
    const schemaFile = join(tmp, 'long-answer-schema.json')
    writeFileSync(schemaFile, JSON.stringify({ ...SCHEMA, description: 'a'.repeat(LIMIT) }))
    const opened = seatCli(['open', '--access', 'workspace-write', ...base, '--worktree', fitting, '--schema', schemaFile])
    assert.equal(opened.ok, true, JSON.stringify(opened))
    const loaded = store.readRecord(opened.id)
    const path = join(seats, opened.id, 'schema.json')
    const text = seatPolicy.seatContext(loaded.record, loaded.schema, path)
    assert.ok(Buffer.byteLength(text) <= LIMIT && Buffer.byteLength(text) > LIMIT - 2000, `${Buffer.byteLength(text)} bytes`)
    assert.ok(text.includes(path) && !text.includes('aaaaaaaaaa'), 'the long-path context did not name the schema file in place of the schema')
    assert.match(text, /Read that file before you write your final message/)
    ok('a writer with long paths whose fallback context still fits opens, and its context, with the schema left out by path, is at most 6000 bytes')

    const normal = seatCli(['open', '--access', 'read-only', ...base])
    assert.equal(normal.ok, true)
    ok('a normal open still works')
  },

  'review-context-instruction': () => {
    // A review seat's context carries the reviewer instruction every review route shares, whole,
    // and its bytes count in the same 6000-byte budget as the rest: inline schema first, the schema
    // named by path when the inline form is over, a refusal when even that is over. A path length
    // is found by measuring the context, never assumed.
    const LIMIT = 6000
    const bytes = (text) => Buffer.byteLength(text)
    const inlineSchema = JSON.stringify(schemas.FINDINGS_SCHEMA)
    const schemaPath = '/s/schema.json'
    const review = (length) => {
      const repoRoot = `/${'r'.repeat(length)}`
      const id = store.newId()
      return { ...seatRecord('claude', { access: 'review', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }), id, repoRoot, worktree: `${repoRoot}/.flow-worktrees/review-${id}` }
    }
    const contextOf = (length) => seatPolicy.seatContext(review(length), schemas.FINDINGS_SCHEMA, schemaPath)
    const refused = (length) => {
      try { contextOf(length); return false } catch (error) {
        assert.equal(error.code, 'CONTEXT_TOO_LONG', `${length}: ${error.message}`)
        return true
      }
    }

    const normal = contextOf(1)
    assert.ok(normal.includes(schemas.REVIEW_INSTRUCTION), 'a normal review context lacks the reviewer instruction')
    assert.ok(normal.includes(inlineSchema), 'a normal review context lacks the inline findings schema')
    assert.ok(bytes(normal) <= LIMIT, `${bytes(normal)} bytes`)
    assert.ok(bytes(schemas.REVIEW_INSTRUCTION) > 1000, 'the reviewer instruction is not the one being measured')
    ok('a review seat\'s context holds the whole reviewer instruction and the inline findings schema within 6000 bytes')

    // The shortest repository path that pushes the inline form over the budget: the schema leaves
    // by path, the instruction stays whole.
    let named = 1
    while (!refused(named) && contextOf(named).includes(inlineSchema)) named++
    assert.equal(refused(named), false, 'the fallback never had a length where it fit')
    const fallback = contextOf(named)
    assert.ok(bytes(fallback) <= LIMIT && bytes(fallback) > LIMIT - 2000, `${bytes(fallback)} bytes`)
    assert.ok(fallback.includes(schemas.REVIEW_INSTRUCTION), 'the fallback context cut the reviewer instruction')
    assert.ok(fallback.includes(schemaPath) && !fallback.includes(inlineSchema) && !fallback.includes('"additionalProperties"'), 'the fallback did not name the schema in place of its JSON')
    assert.match(fallback, /Read that file before you write your final message/)
    assert.ok(contextOf(named - 1).includes(inlineSchema), 'the length before the fallback did not hold the inline schema')
    ok('a review seat whose inline form is over 6000 bytes keeps the whole instruction, names the schema by path and still fits')

    // The shortest path past which even the fallback cannot fit: the instruction is not cut to make room.
    let past = named
    while (!refused(past)) past++
    assert.ok(past > named, 'the refusal and the fallback share a length')
    assert.equal(refused(past - 1), false, `${past - 1} should still fit`)
    assert.ok(bytes(contextOf(past - 1)) <= LIMIT)
    assert.throws(() => seatPolicy.seatContext(review(past), schemas.FINDINGS_SCHEMA, schemaPath), { code: 'CONTEXT_TOO_LONG' })
    ok('a review seat whose fallback context is still over 6000 bytes throws CONTEXT_TOO_LONG, never a cut instruction')

    // Only a review seat is told to review.
    const readOnly = seatPolicy.seatContext({ ...seatRecord('claude'), id: store.newId(), access: 'read-only', worktree: '/r/w' }, SCHEMA, schemaPath)
    const writer = seatPolicy.seatContext({ ...seatRecord('claude'), id: store.newId(), access: 'workspace-write', worktree: '/r/w' }, SCHEMA, schemaPath)
    for (const [what, text] of [['read-only', readOnly], ['workspace-write', writer]]) {
      assert.ok(!text.includes(schemas.REVIEW_INSTRUCTION) && !text.includes('adversarial code reviewer'), `a ${what} context carries the reviewer instruction`)
    }
    ok('read-only and workspace-write contexts do not carry the reviewer instruction')

    // seat.mjs open maps the throw to a refusal for a review seat as it does for a writer, and
    // takes its review worktree back.
    const base = ['--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high']
    // The repository path runs past the length measured above, where the policy itself refuses.
    const long = join(tmp, 'long', 'review-too-long', ...Array.from({ length: Math.ceil(past / 200) + 1 }, (_, at) => `${at}${'d'.repeat(199)}`))
    assert.ok(long.length > past, `${long.length} <= ${past}`)
    mkdirSync(long, { recursive: true })
    gitOut(long, 'init', '-q')
    writeFileSync(join(long, 'a.txt'), 'a\n')
    gitOut(long, 'add', '-A')
    gitOut(long, 'commit', '-q', '-m', 'base')
    const seatDirs = () => (existsSync(seats) ? readdirSync(seats).filter((name) => /^[0-9a-f]{32}$/.test(name)).sort() : [])
    const dirsBefore = seatDirs()
    const out = seatCli(['open', '--access', 'review', ...base, '--base', 'HEAD', '--head', 'HEAD'], { cwd: long })
    assert.equal(out.ok, false, 'a review seat whose context cannot fit the hook budget opened')
    assert.equal(out.error.kind, 'BAD_REQUEST')
    assert.match(out.error.message, /longer than the 6000-byte hook budget; use shorter paths/)
    assert.deepEqual(seatDirs(), dirsBefore, 'the refused review open left a seat directory behind')
    assert.equal(gitOut(long, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 1, 'the refused review open left its review worktree behind')
    ok('open refuses a review seat whose long paths make the context past 6000 bytes, BAD_REQUEST, leaving no seat record and no review worktree')
  },

  'open-lease': async () => {
    // A live write job holds the worktree: the seat is refused and leaves no holder behind.
    const held = gitWorktree('lease-job')
    const job = jobRecord(held, 'queued')
    jobs.acquireLease(job)
    const touched = statSync(jobs.leaseDirOf(held)).mtimeMs
    const refused = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', held])
    assert.deepEqual(refused.error, { kind: 'WORKSPACE_BUSY', message: `Write job ${job.id} holds this worktree.`, details: { jobId: job.id } })
    assert.deepEqual(readdirSync(jobs.leaseDirOf(held)), [job.id])
    assert.equal(statSync(jobs.leaseDirOf(held)).mtimeMs, touched, 'a seat refused up front wrote into the lease directory')
    jobs.releaseLease(job)
    const readOnly = seatCli(['open', '--access', 'read-only', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', held])
    assert.equal(readOnly.ok, true, 'a read-only seat takes no lease')
    ok('open refuses a writer seat with WORKSPACE_BUSY while a live flow_delegate write job holds the worktree, before it writes anything there')

    // A write job that takes the lease after the seat's first look but before its holder lands:
    // the seat process is held at its holder write while the job takes the lease, then let go.
    const window = gitWorktree('lease-window')
    const gate = join(tmp, 'holder-gate')
    const gated = spawn(process.execPath, ['--import', pathToFileURL(holderGate).href, SEAT_SCRIPT, 'open', '--access', 'workspace-write', '--provider', 'claude',
      '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', window], { cwd: canon, env: { ...process.env, SEAT_GATE: gate }, stdio: ['ignore', 'pipe', 'inherit'] })
    let printed = ''
    gated.stdout.on('data', (chunk) => { printed += chunk })
    const finished = new Promise((resolve) => gated.on('close', resolve))
    for (const end = Date.now() + 15_000; !existsSync(`${gate}.waiting`);) {
      if (Date.now() > end) throw new Error('the seat never reached its holder write')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const late = jobRecord(window, 'queued')
    jobs.acquireLease(late)
    writeFileSync(`${gate}.go`, '')
    assert.equal(await finished, 1)
    assert.deepEqual(JSON.parse(printed).error, { kind: 'WORKSPACE_BUSY', message: `Write job ${late.id} holds this worktree.`, details: { jobId: late.id } })
    assert.deepEqual(readdirSync(jobs.leaseDirOf(window)), [late.id], 'the seat left its holder beside the job')
    jobs.releaseLease(late)
    ok('a write job that takes the lease between the seat\'s first look and its holder write is seen when the seat looks again, and the seat backs out')

    // An ended job's leftover lease file does not stop a seat.
    const stale = gitWorktree('lease-stale')
    const ended = jobRecord(stale, 'succeeded')
    jobs.acquireLease(ended)
    const seat = seatCli(['open', '--access', 'workspace-write', '--provider', 'codex', '--model', 'gpt-6-luna', '--effort', 'high', '--worktree', stale])
    assert.equal(seat.ok, true, JSON.stringify(seat))
    ok('a leftover lease file of an ended job whose provider group is gone does not refuse a writer seat')

    // An unclosed seat holds the worktree against a write job, and its close releases it.
    assert.throws(() => jobs.acquireLease(jobRecord(stale, 'queued')), (error) => error.kind === 'WORKSPACE_BUSY' && error.details?.seatId === seat.id)
    const second = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', stale])
    assert.equal(second.ok, true, 'writer seats share a worktree')
    closeSeat(seat.id)
    assert.throws(() => jobs.acquireLease(jobRecord(stale, 'queued')), (error) => error.details?.seatId === second.id, 'the second seat still holds it')
    closeSeat(second.id)
    const taker = jobRecord(stale, 'queued')
    jobs.acquireLease(taker)
    assert.deepEqual(readdirSync(jobs.leaseDirOf(stale)), [taker.id])
    jobs.releaseLease(taker)
    ok('a write job is refused WORKSPACE_BUSY, naming the seat, while any writer seat on the worktree is unclosed, and takes the lease once every one is closed')

    // A holder file whose record is not written yet (an open in progress) holds; a closed seat's
    // leftover holder is dropped by the next write job.
    const pending = gitWorktree('lease-pending')
    const pendingId = store.newId()
    mkdirSync(jobs.leaseDirOf(pending), { recursive: true })
    writeFileSync(join(jobs.leaseDirOf(pending), pendingId), '')
    assert.throws(() => jobs.acquireLease(jobRecord(pending, 'queued')), (error) => error.details?.seatId === pendingId)
    store.writeRecord(RECORD({ id: pendingId, access: 'workspace-write', worktree: pending }), null)
    store.stamp(pendingId, 'closed', { verdict: 'unknown', reasons: [] })
    const after = jobRecord(pending, 'queued')
    jobs.acquireLease(after)
    assert.deepEqual(readdirSync(jobs.leaseDirOf(pending)), [after.id], 'a closed seat\'s leftover holder was not dropped')
    jobs.releaseLease(after)
    ok('a holder whose seat record is not yet written refuses a write job, and a closed seat\'s leftover holder is dropped and the job takes the lease')

    // A close that died after its closed stamp and before it dropped the holder leaves a closed
    // record with a live holder. Once the record ages past retention, prune must drop the holder
    // with it: a holder with no record reads as a live seat's, and holds the worktree forever.
    const interrupted = gitWorktree('lease-interrupted')
    const orphan = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', interrupted])
    assert.equal(orphan.ok, true, JSON.stringify(orphan))
    const longAgo = new Date(Date.now() - RETENTION_MS - 60_000).toISOString()
    assert.equal(store.stamp(orphan.id, 'closed', { at: longAgo, verdict: 'unknown', reasons: [] }), true)
    assert.deepEqual(readdirSync(jobs.leaseDirOf(interrupted)), [`${orphan.id}.live`])
    const sweeper = seatCli(['open', '--access', 'read-only', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', interrupted])
    assert.equal(sweeper.ok, true, JSON.stringify(sweeper))
    assert.equal(store.readRecord(orphan.id), null, 'the closed record past retention was not pruned')
    assert.equal(existsSync(jobs.leaseDirOf(interrupted)), false, "prune left the closed seat's holder behind")
    const unblocked = jobRecord(interrupted, 'queued')
    jobs.acquireLease(unblocked)
    jobs.releaseLease(unblocked)
    ok("prune drops a closed record's leftover lease holder before the record, so a close that died between its stamp and its drop no longer blocks the worktree once the record ages out")

    // A lease directory prune cannot read (here a file where the directory should be, so lstat
    // under it fails ENOTDIR) keeps the record instead of aborting every open with INTERNAL.
    const unreadable = gitWorktree('lease-unreadable')
    const stuck = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', unreadable])
    assert.equal(stuck.ok, true, JSON.stringify(stuck))
    assert.equal(store.stamp(stuck.id, 'closed', { at: longAgo, verdict: 'unknown', reasons: [] }), true)
    rmSync(jobs.leaseDirOf(unreadable), { recursive: true, force: true })
    writeFileSync(jobs.leaseDirOf(unreadable), '')
    const survives = seatCli(['open', '--access', 'read-only', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', unreadable])
    assert.equal(survives.ok, true, `an unreadable lease directory aborted open: ${JSON.stringify(survives)}`)
    assert.notEqual(store.readRecord(stuck.id), null, 'prune removed a record whose holder it could not check')
    rmSync(jobs.leaseDirOf(unreadable), { force: true })
    ok('a lease directory prune cannot read keeps the record and does not abort open')

    // close reports a writer holder it could not remove or confirm gone, so the parent knows the
    // worktree may still read busy to flow_delegate.
    const lost = gitWorktree('lease-cleanup')
    const lostSeat = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', lost])
    assert.equal(lostSeat.ok, true, JSON.stringify(lostSeat))
    rmSync(jobs.leaseDirOf(lost), { recursive: true, force: true })
    writeFileSync(jobs.leaseDirOf(lost), '')
    const lostClose = seatCli(['close', lostSeat.id, '--abandon'])
    rmSync(jobs.leaseDirOf(lost), { force: true })
    assert.equal(lostClose.ok, true, JSON.stringify(lostClose))
    assert.ok((lostClose.cleanupProblems ?? []).some((problem) => /lease holder/.test(problem)), `close hid a failed holder cleanup: ${JSON.stringify(lostClose)}`)
    ok('close reports a writer lease holder it could not remove or confirm gone in cleanupProblems')

    // A holder whose open died before the record: past the minute it is abandoned and dropped. A
    // holder with a record holds however old it is, and one inside the minute still holds.
    const abandoned = gitWorktree('lease-abandoned')
    const stale61 = new Date(Date.now() - 61_000)
    const holderAt = (id, when) => {
      mkdirSync(jobs.leaseDirOf(abandoned), { recursive: true })
      writeFileSync(join(jobs.leaseDirOf(abandoned), id), '')
      utimesSync(join(jobs.leaseDirOf(abandoned), id), when, when)
    }
    const takeAndRelease = () => {
      const job = jobRecord(abandoned, 'queued')
      jobs.acquireLease(job)
      assert.deepEqual(readdirSync(jobs.leaseDirOf(abandoned)), [job.id])
      jobs.releaseLease(job)
    }
    const deadId = store.newId()
    holderAt(deadId, stale61)
    takeAndRelease()
    const youngId = store.newId()
    holderAt(youngId, new Date(Date.now() - 50_000))
    assert.throws(() => jobs.acquireLease(jobRecord(abandoned, 'queued')), (error) => error.kind === 'WORKSPACE_BUSY' && error.details?.seatId === youngId)
    utimesSync(join(jobs.leaseDirOf(abandoned), youngId), stale61, stale61)
    takeAndRelease()
    const liveId = store.newId()
    holderAt(liveId, stale61)
    store.writeRecord(RECORD({ id: liveId, access: 'workspace-write', worktree: abandoned }), null)
    assert.throws(() => jobs.acquireLease(jobRecord(abandoned, 'queued')), (error) => error.kind === 'WORKSPACE_BUSY' && error.details?.seatId === liveId)
    assert.deepEqual(readdirSync(jobs.leaseDirOf(abandoned)), [liveId])
    store.stamp(liveId, 'closed', { verdict: 'valid', reasons: [] })
    takeAndRelease()
    ok('a holder with no seat record is held for a minute after its write, as an open in flight, and then dropped as abandoned so a write job takes the lease; a holder with a record holds however old it is')

    // An open stalled past the minute between its holder and its record: a write job drops the
    // holder and takes the lease, so the seat must not open on a worktree it no longer holds.
    const stalled = gitWorktree('lease-stalled')
    const recordGate = join(tmp, 'record-gate')
    const stalledOpen = spawn(process.execPath, ['--import', pathToFileURL(holderGate).href, SEAT_SCRIPT, 'open', '--access', 'workspace-write', '--provider', 'claude',
      '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', stalled], { cwd: canon, env: { ...process.env, SEAT_GATE: recordGate, SEAT_GATE_AT: 'record' }, stdio: ['ignore', 'pipe', 'inherit'] })
    let heldOut = ''
    stalledOpen.stdout.on('data', (chunk) => { heldOut += chunk })
    const heldDone = new Promise((resolve) => stalledOpen.on('close', resolve))
    for (const end = Date.now() + 15_000; !existsSync(`${recordGate}.waiting`);) {
      if (Date.now() > end) throw new Error('the seat never reached its record write')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const [stalledId] = readdirSync(jobs.leaseDirOf(stalled))
    utimesSync(join(jobs.leaseDirOf(stalled), stalledId), stale61, stale61)
    const overtaker = jobRecord(stalled, 'queued')
    jobs.acquireLease(overtaker)
    writeFileSync(`${recordGate}.go`, '')
    assert.equal(await heldDone, 1)
    assert.equal(JSON.parse(heldOut).error?.kind, 'WORKSPACE_BUSY', heldOut)
    assert.deepEqual(readdirSync(jobs.leaseDirOf(stalled)), [overtaker.id])
    assert.ok(store.readStamp(stalledId, 'void'), 'the stalled seat\'s record was not voided')
    assert.equal(store.readStamp(stalledId, 'closed')?.verdict, 'unknown', 'the stalled seat\'s record was not closed')
    jobs.releaseLease(overtaker)
    ok('an open whose holder was dropped as abandoned before its record went in refuses WORKSPACE_BUSY and voids and closes the record it wrote')

    // Seats and write jobs racing for one worktree: never a seat and a job both.
    for (let round = 0; round < 2; round++) {
      const contested = gitWorktree(`lease-race-${round}`)
      const results = await leaseRace(contested, 2, 2)
      const seatsWon = results.filter((line) => line.startsWith('seat ok'))
      const jobsWon = results.filter((line) => line.startsWith('job ok'))
      assert.ok(results.every((line) => /^(?:seat|job) (?:ok|WORKSPACE_BUSY)/.test(line)), results.join(' | '))
      assert.ok(jobsWon.length <= 1, `round ${round}: two jobs took one lease`)
      assert.ok(seatsWon.length === 0 || jobsWon.length === 0, `round ${round}: a seat and a job both took the worktree: ${results.join(' | ')}`)
      assert.ok(seatsWon.length + jobsWon.length > 0, `round ${round}: nobody took the worktree`)
      const names = readdirSync(jobs.leaseDirOf(contested)).sort()
      const expected = jobsWon.length ? [jobsWon[0].split(' ')[2]] : seatsWon.map((line) => `${line.split(' ')[2]}.live`).sort()
      assert.deepEqual(names, expected, `round ${round}: the lease directory names exactly the winners`)
    }
    ok('two rounds of two writer seats racing two write jobs for one worktree never let a seat and a job both in, and the lease directory names exactly the winners')
  },

  'open-lease-takeover': async () => {
    // A seat open held at its record write with its pending holder past the minute, and a write job
    // held at the rename that takes that holder over, both having looked. Each order of release is
    // run, and the two renames of the one pending holder decide it: exactly one side goes on.
    const stale = new Date(Date.now() - 61_000)
    const takeover = async (name, seatFirst) => {
      const contested = gitWorktree(`lease-takeover-${name}`)
      const seatGate = join(tmp, `takeover-seat-${name}`)
      const jobGateAt = join(tmp, `takeover-job-${name}`)
      const opening = spawn(process.execPath, ['--import', pathToFileURL(holderGate).href, SEAT_SCRIPT, 'open', '--access', 'workspace-write', '--provider', 'claude',
        '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', contested], { cwd: canon, env: { ...process.env, SEAT_GATE: seatGate, SEAT_GATE_AT: 'record' }, stdio: ['ignore', 'pipe', 'inherit'] })
      let seatOut = ''
      opening.stdout.on('data', (chunk) => { seatOut += chunk })
      const seatDone = new Promise((resolve) => opening.on('close', resolve))
      await waitFor(`${seatGate}.waiting`, 'the seat never reached its record write')
      const [seatId] = readdirSync(jobs.leaseDirOf(contested))
      utimesSync(join(jobs.leaseDirOf(contested), seatId), stale, stale)
      const round = mkdtempSync(join(tmp, 'takeover-'))
      const taking = spawn(process.execPath, ['--import', pathToFileURL(jobGate).href, leaseRacer, 'job', contested, join(round, 'ready'), join(round, 'go'), PLUGIN],
        { env: { ...process.env, JOB_GATE: jobGateAt }, stdio: ['ignore', 'pipe', 'inherit'] })
      let jobOut = ''
      taking.stdout.on('data', (chunk) => { jobOut += chunk })
      const jobDone = new Promise((resolve) => taking.on('close', resolve))
      writeFileSync(join(round, 'go'), '')
      await waitFor(`${jobGateAt}.waiting`, 'the job never reached its takeover rename')
      const release = async (gate, done) => { writeFileSync(`${gate}.go`, ''); return done }
      if (seatFirst) {
        await release(seatGate, seatDone)
        await release(jobGateAt, jobDone)
      } else {
        await release(jobGateAt, jobDone)
        await release(seatGate, seatDone)
      }
      return { contested, seatId, seat: JSON.parse(seatOut), job: jobOut.trim() }
    }

    const jobWins = await takeover('job-first', false)
    assert.match(jobWins.job, /^job ok /, jobWins.job)
    assert.equal(jobWins.seat.error?.kind, 'WORKSPACE_BUSY', JSON.stringify(jobWins.seat))
    assert.deepEqual(readdirSync(jobs.leaseDirOf(jobWins.contested)), [jobWins.job.split(' ')[2]])
    assert.ok(store.readStamp(jobWins.seatId, 'void'), 'the seat that lost the holder did not void its record')
    assert.equal(store.readStamp(jobWins.seatId, 'closed')?.verdict, 'unknown')
    ok('a job that renames a stale pending holder before the seat renames it live takes the lease, and the seat refuses WORKSPACE_BUSY and voids and closes its record')

    const seatWins = await takeover('seat-first', true)
    assert.equal(seatWins.seat.ok, true, JSON.stringify(seatWins.seat))
    assert.equal(seatWins.job, 'job WORKSPACE_BUSY')
    assert.deepEqual(readdirSync(jobs.leaseDirOf(seatWins.contested)), [`${seatWins.seatId}.live`])
    assert.equal(store.readStamp(seatWins.seatId, 'void'), null)
    closeSeat(seatWins.seatId)
    const after = jobRecord(seatWins.contested, 'queued')
    jobs.acquireLease(after)
    jobs.releaseLease(after)
    ok('a seat that renames its pending holder live before a job that judged it stale renames it keeps the worktree: the job finds no holder to take, looks again and refuses WORKSPACE_BUSY until the seat closes')

    // A live holder holds however old it is; a taken file a dead job left behind is dropped.
    const leftovers = gitWorktree('lease-leftovers')
    const dir = jobs.leaseDirOf(leftovers)
    const liveId = store.writeRecord(RECORD({ access: 'workspace-write', worktree: leftovers }), null).id
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${liveId}.live`), '')
    utimesSync(join(dir, `${liveId}.live`), stale, stale)
    assert.throws(() => jobs.acquireLease(jobRecord(leftovers, 'queued')), (error) => error.kind === 'WORKSPACE_BUSY' && error.details?.seatId === liveId)
    store.stamp(liveId, 'closed', { verdict: 'valid', reasons: [] })
    writeFileSync(join(dir, `${store.newId()}.taken-${randomUUID()}`), '')
    const taker = jobRecord(leftovers, 'queued')
    jobs.acquireLease(taker)
    assert.deepEqual(readdirSync(dir), [taker.id])
    jobs.releaseLease(taker)
    ok('a live holder keeps write jobs out past the minute until its seat is closed, and a closed seat\'s live holder and a dead takeover\'s taken file are dropped')
  },

  'open-undo': () => {
    // A PATH with git and bash but no tar: the worktree goes in, then the canonical snapshot fails.
    const bin = join(tmp, 'no-tar-bin')
    mkdirSync(bin, { recursive: true })
    for (const tool of ['git', 'bash', 'sort']) {
      const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
      symlinkSync(found, join(bin, tool))
    }
    const worktrees = () => gitOut(canon, 'worktree', 'list', '--porcelain')
    const reviews = () => (existsSync(join(canon, '.flow-worktrees')) ? readdirSync(join(canon, '.flow-worktrees')).sort() : [])
    const before = [worktrees(), reviews()]
    const out = seatCli(['open', '--access', 'review', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--base', baseSha, '--head', headSha], { env: { PATH: bin } })
    assert.deepEqual(out.error, { kind: 'GIT_REF', message: 'The canonical checkout could not be snapshotted.' })
    assert.deepEqual([worktrees(), reviews()], before, 'the refused open left its review worktree behind')
    ok('an open refused after its review worktree went in removes that worktree again')
  },

}

await runSection('open', cases)
