// Seat smoke section: trust-hooks. Run via `node test/flow/smoke-seat.mjs` or directly.
import { assert, spawn, spawnSync, createHash, randomUUID, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, createServer, performance, DatabaseSync, tmpdir, dirname, join, fileURLToPath, pathToFileURL, PLUGIN, STORE, tmp, state, t3Home, store, wire, seatPolicy, RETENTION_MS, schemas, ok, sha256, mode, seats, INSTANCE, RECORD, SCHEMA, ENVELOPE_OK, racer, race, GUARD, guard, silent, denied, blocked, context, stopBlocked, MODELS, PERMISSION, SPELLING, call, stopCall, promptCall, preCall, EFFORT_OPTION, delegateInput, seatRecord, admit, admittedSeat, worktree, ACCESSES, boundSeat, seatCall, editCalls, indexEntries, SEAT_SCRIPT, jobs, seatCli, fakeCodexBin, OWN_HOOKS, installedRoot, FAKE_ROOT, treeDigest, DRIFTED_ROOT, snake, flowEntries, FOREIGN, codexState, codexSent, codexHooks, flowDigest, trustedCodex, T3_TABLES, T3_INDEXES, t3Store, t3, T3_SESSION, T3_OWNER, t3Time, taskIdOf, childThreadOf, runIdOf, t3TaskRow, t3RunRow, t3MessageRow, t3Forget, t3Seat, MESSAGE_OK, taskStatusOf, t3Status, closeSeat, oneRunTask, writerSeat, recordFiles, refusedClose, gitEnv, gitOut, canon, baseSha, headSha, linkedWt, gitWorktree, jobRecord, hookedSeat, guardedSeat, messageWith, rootedCodexSeat, holderGate, jobGate, stampGate, scanGate, heldChildren, heldAt, waitFor, leaseRacer, leaseRace, runSection } from './helpers.mjs'

const cases = {
  'trust-list': () => {
    const { dir, env } = codexState([...flowEntries(), ...FOREIGN])
    const out = seatCli(['trust'], { env })
    assert.deepEqual(Object.keys(out), ['ok', 'keys', 'digest', 'wrote'])
    assert.equal(out.wrote, false)
    assert.equal(out.digest, flowDigest(flowEntries()), 'the listed digest is not the hooksDigest open records')
    const expected = flowEntries().map(({ key, command, trustStatus, currentHash }) => ({ key, command, trustStatus, currentHash })).sort((a, b) => (a.key < b.key ? -1 : 1))
    assert.deepEqual(out.keys, expected)
    assert.equal(out.keys.length, 10)
    const sent = codexSent(dir)
    assert.deepEqual(sent.map((message) => message.method), ['initialize', 'initialized', 'hooks/list'])
    assert.equal(sent[0].params.capabilities.experimentalApi, true)
    assert.deepEqual(sent[2].params, { cwds: [canon] })
    ok('trust lists flow\'s own Codex hook keys alone, each with its command, trust status and hash, and their digest, through initialize, initialized and hooks/list for the canonical checkout, and writes nothing')
  },

  'trust-write': () => {
    const { dir, env } = codexState([...flowEntries(), ...FOREIGN])
    const listed = seatCli(['trust'], { env })
    const out = seatCli(['trust', '--write', '--expect', listed.digest], { env })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.wrote, true)
    assert.equal(out.digest, listed.digest)
    assert.ok(out.keys.every((key) => key.trustStatus === 'trusted'))
    const sent = codexSent(dir)
    assert.deepEqual(sent.map((message) => message.method), ['initialize', 'initialized', 'hooks/list', 'initialize', 'initialized', 'hooks/list', 'config/batchWrite', 'hooks/list'])
    const { edits } = sent[6].params
    const flow = flowEntries()
    assert.deepEqual(edits, [{ keyPath: 'hooks.state', value: Object.fromEntries(flow.map(({ key, currentHash }) => [key, { trusted_hash: currentHash }])), mergeStrategy: 'upsert' }])
    assert.deepEqual(Object.keys(edits[0].value).sort(), flow.map(({ key }) => key).sort())
    for (const foreign of FOREIGN) assert.equal(Object.hasOwn(edits[0].value, foreign.key), false, `${foreign.key} was written`)
    for (const foreign of FOREIGN) assert.equal(codexHooks(dir).find((hook) => hook.key === foreign.key).trustStatus, 'untrusted')
    ok('trust --write upserts hooks.state for flow\'s keys alone, each as its current hash, leaves another plugin\'s and a user\'s hook (one running a flow script included) untouched, and reads the keys back trusted')

    const ignored = codexState([...flowEntries(), ...FOREIGN], { ignoreWrites: true })
    const refused = seatCli(['trust', '--write', '--expect', flowDigest(flowEntries())], { env: ignored.env })
    assert.equal(refused.error.kind, 'HOOKS_UNTRUSTED')
    assert.equal(refused.error.details.keys.length, 10)
    ok('trust --write fails HOOKS_UNTRUSTED when a key does not read trusted after the write')

    // The write is bound to the list the human saw: a hook whose hash moved since then, or a digest
    // from anywhere else, refuses HOOKS_CHANGED before anything is written.
    const moving = codexState([...flowEntries(), ...FOREIGN])
    const seen = seatCli(['trust'], { env: moving.env })
    const hooks = codexHooks(moving.dir)
    const target = hooks.find((hook) => hook.key === seen.keys[0].key)
    target.currentHash = `sha256:${'e'.repeat(64)}`
    writeFileSync(join(moving.dir, 'hooks.json'), JSON.stringify({ hooks, ignoreWrites: false }))
    const changed = seatCli(['trust', '--write', '--expect', seen.digest], { env: moving.env })
    assert.equal(changed.error?.kind, 'HOOKS_CHANGED', JSON.stringify(changed))
    assert.equal(changed.error.details.expected, seen.digest)
    assert.equal(changed.error.details.digest, flowDigest(hooks.filter((hook) => seen.keys.some(({ key }) => key === hook.key))))
    assert.ok(!codexSent(moving.dir).some((message) => message.method === 'config/batchWrite'), 'a changed list was written')
    assert.equal(codexHooks(moving.dir).find((hook) => hook.key === target.key).trustStatus, 'untrusted')
    const wrongDigest = seatCli(['trust', '--write', '--expect', 'f'.repeat(64)], { env: moving.env })
    assert.equal(wrongDigest.error?.kind, 'HOOKS_CHANGED')
    assert.ok(!codexSent(moving.dir).some((message) => message.method === 'config/batchWrite'), 'a wrong digest was written')
    for (const args of [['trust', '--write'], ['trust', '--expect', seen.digest], ['trust', '--write', '--expect', 'xyz'], ['trust', '--write', '--expect']]) {
      const bad = codexState([...flowEntries(), ...FOREIGN])
      assert.equal(seatCli(args, { env: bad.env }).error?.kind, 'BAD_REQUEST', args.join(' '))
      assert.deepEqual(codexSent(bad.dir), [], `${args.join(' ')} reached Codex`)
    }
    ok('trust --write needs --expect with the digest trust listed, and refuses HOOKS_CHANGED, writing nothing, when the hooks listed now have another digest')

    // Flow's keys are this copy's plugin id, flow@jakub from the checkout's manifest, from one root
    // whose hooks/codex.json is byte for byte this copy's, wherever that root is. Another plugin id
    // is not flow, whatever its commands and hooks file look like.
    const elsewhere = installedRoot('elsewhere')
    const lookalikes = [...flowEntries({ pluginId: 'flow@other', root: installedRoot('other') }), ...flowEntries({ pluginId: 'evil@x', root: elsewhere }),
      ...flowEntries({ pluginId: 'evil@here' })]
    const mixed = codexState([...flowEntries(), ...lookalikes])
    const mixedList = seatCli(['trust'], { env: mixed.env })
    assert.equal(mixedList.ok, true, JSON.stringify(mixedList))
    assert.deepEqual(mixedList.keys.map(({ key }) => key).sort(), flowEntries().map(({ key }) => key).sort())
    assert.equal(seatCli(['trust', '--write', '--expect', mixedList.digest], { env: mixed.env }).ok, true)
    const mixedEdits = codexSent(mixed.dir).find((message) => message.method === 'config/batchWrite').params.edits[0].value
    assert.deepEqual(Object.keys(mixedEdits).sort(), flowEntries().map(({ key }) => key).sort())
    for (const hook of codexHooks(mixed.dir).filter((entry) => entry.pluginId !== 'flow@jakub')) assert.equal(hook.trustStatus, 'untrusted', hook.key)
    for (const [what, alone] of [['flow@other with this copy\'s commands and hooks file', flowEntries({ pluginId: 'flow@other', root: installedRoot('other') })],
      ['a foreign plugin with this copy\'s commands and hooks file', flowEntries({ pluginId: 'evil@x', root: elsewhere })]]) {
      const only = codexState(alone)
      const listed = seatCli(['trust'], { env: only.env })
      assert.equal(listed.error?.kind, 'HOOKS_MISMATCH', `${what}: ${JSON.stringify(listed)}`)
      assert.equal(listed.error.details.pluginId, 'flow@jakub')
      const written = seatCli(['trust', '--write', '--expect', flowDigest(alone)], { env: only.env })
      assert.equal(written.error?.kind, 'HOOKS_MISMATCH', `${what}: ${JSON.stringify(written)}`)
      assert.ok(!codexSent(only.dir).some((message) => message.method === 'config/batchWrite'), `trust wrote ${what}`)
      assert.ok(codexHooks(only.dir).every((hook) => hook.trustStatus === 'untrusted'), `${what} was trusted`)
    }
    ok('trust selects only this copy\'s plugin id: flow@other or a foreign plugin with flow\'s commands and a byte-identical hooks file under another root is never listed or written, and alone it reads HOOKS_MISMATCH')

    const own = codexState(flowEntries({ root: realpathSync(PLUGIN) }))
    assert.equal(seatCli(['trust'], { env: own.env }).ok, true, 'this copy\'s own root')
    ok('the copy trust runs from may be the copy Codex installed: entries rooted at this checkout list as flow\'s too')
  },

  'trust-mismatch': () => {
    for (const [what, hooks] of [
      ['an install without the seat guard', [...flowEntries({ trusted: true, drop: 'seat-guard.mjs' }), ...FOREIGN]],
      ['one handler missing', flowEntries({ trusted: true, drop: 'install-delegate.mjs' })],
      ['the handlers split across two copies', [...flowEntries({ trusted: true, drop: 'seat-guard.mjs' }),
        ...flowEntries({ trusted: true, pluginId: 'flow@fork', root: '/home/u/fork/flow' }).filter((hook) => hook.command.includes('seat-guard.mjs'))]],
      ['two plugins under one root', [...flowEntries({ trusted: true, drop: 'seat-guard.mjs' }),
        ...flowEntries({ trusted: true, pluginId: 'flow@fork' }).filter((hook) => hook.command.includes('seat-guard.mjs'))]],
      ['a key from another hooks file', flowEntries({ trusted: true }).map((hook, at) => (at === 0 ? { ...hook, key: hook.key.replace('hooks/codex.json', 'hooks/hooks.json') } : hook))],
      ['one plugin with two roots', [...flowEntries({ trusted: true, drop: 'seat-guard.mjs' }),
        ...flowEntries({ trusted: true, root: installedRoot('second') }).filter((hook) => hook.command.includes('seat-guard.mjs'))]],
      ['a hooks/codex.json that differs by one byte', flowEntries({ trusted: true, root: DRIFTED_ROOT })],
      ['a sourcePath under another root than the command', flowEntries({ trusted: true, root: DRIFTED_ROOT }).map((hook) => ({ ...hook, sourcePath: `${FAKE_ROOT}/hooks/codex.json` }))],
      ['no sourcePath', flowEntries({ trusted: true }).map(({ sourcePath, ...hook }) => hook)],
      ['a root with no hooks file', flowEntries({ trusted: true, root: join(tmp, 'codex-home', 'nowhere') })],
      ['no flow at all', FOREIGN],
    ]) {
      for (const args of [['trust'], ['trust', '--write', '--expect', flowDigest(hooks)]]) {
        const { dir, env } = codexState(hooks)
        const out = seatCli(args, { env })
        assert.equal(out.error?.kind, 'HOOKS_MISMATCH', `${what} ${args.join(' ')}: ${JSON.stringify(out)}`)
        assert.equal(out.error.details.expected, 10)
        assert.ok(!codexSent(dir).some((message) => message.method === 'config/batchWrite'), `${what}: a mismatch wrote trust`)
      }
    }
    const noCodex = join(tmp, 'no-codex-bin')
    mkdirSync(noCodex, { recursive: true })
    symlinkSync(spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), join(noCodex, 'git'))
    assert.equal(seatCli(['trust'], { env: { PATH: noCodex } }).error.kind, 'PROVIDER_NOT_INSTALLED')
    assert.equal(seatCli(['trust', '--extra'], { env: trustedCodex.env }).error.kind, 'BAD_REQUEST')
    ok('trust and trust --write refuse HOOKS_MISMATCH, writing nothing, unless Codex lists exactly one hook per flow handler from one root whose hooks/codex.json, the entries\' sourcePath, is byte for byte this copy\'s; no codex on PATH is PROVIDER_NOT_INSTALLED')
  },

  'trust-open': () => {
    const args = (provider, access = 'read-only', extra = []) => ['open', '--access', access, '--provider', provider, '--model', MODELS[provider], '--effort', 'high', ...extra]
    const records = () => (existsSync(seats) ? readdirSync(seats).filter((name) => /^[0-9a-f]{32}$/.test(name)).sort() : [])
    const untrustedFlow = flowEntries()
    const { dir, env } = codexState([...untrustedFlow, ...FOREIGN])
    const before = records()
    const refused = seatCli(args('codex'), { env })
    assert.equal(refused.error.kind, 'HOOKS_UNTRUSTED')
    assert.equal(refused.error.details.hooksDigest, flowDigest(untrustedFlow))
    assert.equal(refused.error.details.keys.length, 10)
    assert.ok(!codexSent(dir).some((message) => message.method === 'config/batchWrite'), 'open wrote trust')
    const writerWt = gitWorktree('trust-open-writer')
    assert.equal(seatCli(args('codex', 'workspace-write', ['--worktree', writerWt]), { env }).error.kind, 'HOOKS_UNTRUSTED')
    assert.equal(existsSync(jobs.leaseDirOf(writerWt)), false, 'a refused Codex writer left its lease holder')
    const reviewsBefore = gitOut(canon, 'worktree', 'list', '--porcelain')
    assert.equal(seatCli(args('codex', 'review', ['--base', baseSha, '--head', headSha]), { env }).error.kind, 'HOOKS_UNTRUSTED')
    assert.equal(gitOut(canon, 'worktree', 'list', '--porcelain'), reviewsBefore, 'a refused Codex review left its worktree')
    assert.deepEqual(records(), before, 'a refused Codex seat left a record')
    ok('open refuses a Codex seat HOOKS_UNTRUSTED, with the digest of flow\'s keys and hashes, while a flow hook is untrusted, writes no trust, and leaves no writer\'s holder or review\'s worktree behind')

    const disabled = flowEntries({ trusted: true }).map((hook, at) => (at === 0 ? { ...hook, enabled: false } : hook))
    assert.equal(seatCli(args('codex'), { env: codexState(disabled).env }).error.kind, 'HOOKS_UNTRUSTED', 'a disabled flow hook')
    const modified = flowEntries({ trusted: true }).map((hook, at) => (at === 1 ? { ...hook, trustStatus: 'modified' } : hook))
    assert.equal(seatCli(args('codex'), { env: codexState(modified).env }).error.kind, 'HOOKS_UNTRUSTED', 'a modified flow hook')
    const mismatch = seatCli(args('codex'), { env: codexState(flowEntries({ trusted: true, drop: 'seat-guard.mjs' })).env })
    assert.deepEqual([mismatch.error.kind, mismatch.error.details.cause], ['HOOKS_UNTRUSTED', 'HOOKS_MISMATCH'])
    const drifted = seatCli(args('codex'), { env: codexState(flowEntries({ trusted: true, root: DRIFTED_ROOT })).env })
    assert.deepEqual([drifted.error.kind, drifted.error.details.cause], ['HOOKS_UNTRUSTED', 'HOOKS_MISMATCH'])
    const otherId = seatCli(args('codex'), { env: codexState(flowEntries({ trusted: true, pluginId: 'flow@other' })).env })
    assert.deepEqual([otherId.error.kind, otherId.error.details.cause], ['HOOKS_UNTRUSTED', 'HOOKS_MISMATCH'])
    const noCodex = join(tmp, 'no-codex-open-bin')
    mkdirSync(noCodex, { recursive: true })
    symlinkSync(spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), join(noCodex, 'git'))
    const missing = seatCli(args('codex'), { env: { PATH: noCodex } })
    assert.deepEqual([missing.error.kind, missing.error.details.cause], ['HOOKS_UNTRUSTED', 'PROVIDER_NOT_INSTALLED'])
    ok('a disabled or modified flow hook, an install that does not match this flow (a missing handler, a hooks file one byte apart, another plugin id), or no codex on PATH also refuses a Codex seat HOOKS_UNTRUSTED')

    const trusted = codexState([...flowEntries({ trusted: true }), ...FOREIGN])
    assert.notEqual(FAKE_ROOT, realpathSync(PLUGIN))
    const opened = seatCli(args('codex'), { env: trusted.env })
    assert.equal(opened.ok, true, JSON.stringify(opened))
    assert.equal(store.readRecord(opened.id).record.hooksDigest, flowDigest(flowEntries({ trusted: true })))
    const claude = codexState(flowEntries())
    assert.equal(seatCli(args('claude'), { env: claude.env }).ok, true)
    assert.deepEqual(codexSent(claude.dir), [], 'a Claude seat read Codex trust')
    assert.equal(store.readRecord(seatCli(args('claude'), { env: claude.env }).id).record.hooksDigest, null)
    ok('a Codex seat opens from this checkout\'s seat.mjs once every hook of the flow Codex installed under another root reads trusted, and records the hooks digest; a Claude seat never reads Codex trust and records none')
  },

  'trust-identity': () => {
    // A copy of this flow at path, with a marketplace manifest beside it when one is given.
    const copyAt = (path, manifest) => {
      cpSync(PLUGIN, path, { recursive: true })
      if (manifest) {
        mkdirSync(join(path, '..', '..', '.claude-plugin'), { recursive: true })
        writeFileSync(join(path, '..', '..', '.claude-plugin', 'marketplace.json'), JSON.stringify(manifest))
      }
      return join(path, 'scripts', 'seat.mjs')
    }
    const listedAs = (script, pluginId) => {
      const { dir, env } = codexState([...flowEntries({ pluginId: 'flow@jakub' }), ...(pluginId === 'flow@jakub' ? [] : flowEntries({ pluginId }))])
      const out = seatCli(['trust'], { env, script })
      return { out, dir, keys: out.ok ? [...new Set(out.keys.map(({ key }) => key.split(':')[0]))] : null }
    }

    const cached = copyAt(join(tmp, 'identity', 'claude-home', 'plugins', 'cache', 'other', 'flow', '1.2.3'))
    assert.deepEqual(listedAs(cached, 'flow@other').keys, ['flow@other'])
    const cachedAlone = seatCli(['trust'], { env: codexState(flowEntries()).env, script: cached })
    assert.deepEqual([cachedAlone.error?.kind, cachedAlone.error?.details.pluginId], ['HOOKS_MISMATCH', 'flow@other'])
    ok('a copy in a plugin cache, <home>/plugins/cache/<marketplace>/flow/<version>, reads its plugin id from that path: flow@other selects flow@other and not flow@jakub')

    const mine = copyAt(join(tmp, 'identity', 'mine', 'plugins', 'flow'), { name: 'mine', plugins: [{ name: 'flow', source: './plugins/flow' }] })
    assert.deepEqual(listedAs(mine, 'flow@mine').keys, ['flow@mine'])
    ok('a source checkout reads its plugin id from its marketplace manifest: a manifest named mine selects flow@mine and not flow@jakub')

    for (const [what, script] of [
      ['no manifest', copyAt(join(tmp, 'identity', 'bare', 'plugins', 'flow'))],
      ['a manifest whose flow is another directory', copyAt(join(tmp, 'identity', 'moved', 'plugins', 'flow'), { name: 'jakub', plugins: [{ name: 'flow', source: './plugins/elsewhere' }] })],
      ['a manifest with no name', copyAt(join(tmp, 'identity', 'nameless', 'plugins', 'flow'), { plugins: [{ name: 'flow', source: './plugins/flow' }] })],
    ]) {
      const { dir, env } = codexState(flowEntries({ trusted: true }))
      const listed = seatCli(['trust'], { env, script })
      assert.equal(listed.error?.kind, 'HOOKS_MISMATCH', `${what}: ${JSON.stringify(listed)}`)
      assert.equal(seatCli(['trust', '--write', '--expect', flowDigest(flowEntries({ trusted: true }))], { env, script }).error?.kind, 'HOOKS_MISMATCH', what)
      assert.ok(!codexSent(dir).some((message) => message.method === 'config/batchWrite'), `${what}: trust was written`)
      const refused = seatCli(['open', '--access', 'read-only', '--provider', 'codex', '--model', MODELS.codex, '--effort', 'high'], { env, script })
      assert.deepEqual([refused.error?.kind, refused.error?.details.cause], ['HOOKS_UNTRUSTED', 'HOOKS_MISMATCH'], what)
    }
    ok('a source copy whose marketplace manifest is missing, names no marketplace, or names another directory as flow names no plugin id: trust and open fail closed, and nothing is written')
  },

  // B at open: a Codex seat records the flow plugin root Codex lists its hooks under and a digest
  // of everything in it, taken before and after the trust read. Each case has its own root and
  // its own fake Codex state, so FAKE_ROOT is never touched.
  // B at open: a Codex seat records the flow plugin root Codex lists its hooks under and a digest
  // of everything in it, taken before and after the trust read. Each case has its own root and
  // its own fake Codex state, so FAKE_ROOT is never touched.
  'open-hooks-entry-types': async () => {
    const args = (access = 'read-only', extra = []) => ['open', '--access', access, '--provider', 'codex', '--model', MODELS.codex, '--effort', 'high', ...extra]
    const records = () => (existsSync(seats) ? readdirSync(seats).filter((name) => /^[0-9a-f]{32}$/.test(name)).sort() : [])
    // A Codex install of this flow with more in it than its hooks file, as a real one has.
    const fullRoot = (name) => {
      const root = installedRoot(name)
      mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
      mkdirSync(join(root, 'empty'))
      writeFileSync(join(root, 'scripts', 'seat.mjs'), '// seat\n')
      writeFileSync(join(root, 'scripts', 'lib', 'x.mjs'), 'export {}\n')
      writeFileSync(join(root, '.codex-plugin.json'), '{}\n')
      return root
    }
    const root = fullRoot('entry-plain')
    const codex = codexState(flowEntries({ trusted: true, root }))
    const opened = seatCli(args(), { env: codex.env })
    assert.equal(opened.ok, true, JSON.stringify(opened))
    const { record } = store.readRecord(opened.id)
    assert.notEqual(root, realpathSync(PLUGIN))
    assert.deepEqual([record.codexPluginRoot, record.codexPluginDigest, record.hooksDigest], [root, treeDigest(root), flowDigest(flowEntries({ trusted: true, root }))])
    assert.deepEqual(codexSent(codex.dir).map(({ method }) => method), ['initialize', 'initialized', 'hooks/list', 'initialize', 'initialized', 'hooks/list'], 'the root was not listed and the trust read in a second session')
    const claude = store.readRecord(seatCli(['open', '--access', 'read-only', '--provider', 'claude', '--model', MODELS.claude, '--effort', 'high']).id).record
    assert.deepEqual([Object.hasOwn(claude, 'codexPluginRoot'), Object.hasOwn(claude, 'codexPluginDigest')], [false, false])
    ok('a Codex seat records the root Codex listed its flow hooks under, apart from this checkout, and the digest of every regular file and directory in it, empty and nested ones and dotfiles included, reading the root and then the trust in two App Server sessions; a Claude seat records neither key')

    // Each odd root refuses open HOOKS_MISMATCH for every access, writing nothing: no record, no
    // writer's holder, no review worktree, and no trust.
    let made = 0
    const refuses = (bad, what, allAccess = false) => {
      const lanes = allAccess
        ? [['read-only', []], ['workspace-write', ['--worktree', gitWorktree(`open-hooks-entry-${made++}`)]], ['review', ['--base', baseSha, '--head', headSha]]]
        : [['read-only', []]]
      for (const [access, extra] of lanes) {
        const { dir, env } = codexState(flowEntries({ trusted: true, root: bad }))
        const before = [records(), gitOut(canon, 'worktree', 'list', '--porcelain')]
        const out = seatCli(args(access, extra), { env, timeout: 30_000 })
        assert.equal(out.error?.kind, 'HOOKS_MISMATCH', `${what}, ${access}: ${JSON.stringify(out)}`)
        assert.equal(out.error.details?.codexPluginRoot, bad, what)
        assert.deepEqual([records(), gitOut(canon, 'worktree', 'list', '--porcelain')], before, `${what}, ${access}: the refused open left a record or a review worktree`)
        if (access === 'workspace-write') assert.equal(existsSync(jobs.leaseDirOf(extra[1])), false, `${what}: the refused writer left its lease holder`)
        assert.ok(!codexSent(dir).some((message) => message.method === 'config/batchWrite'), `${what}: open wrote trust`)
      }
    }
    const fileLink = fullRoot('entry-file-link')
    symlinkSync(join(fileLink, 'hooks', 'codex.json'), join(fileLink, 'scripts', 'hooks.json'))
    refuses(fileLink, 'a symlink to a file in the root', true)
    const dirLink = fullRoot('entry-dir-link')
    symlinkSync(join(dirLink, 'scripts'), join(dirLink, 'tools'))
    refuses(dirLink, 'a symlink to a directory in the root')
    const dangling = fullRoot('entry-dangling')
    symlinkSync(join(dangling, 'nowhere'), join(dangling, 'scripts', 'gone.mjs'))
    refuses(dangling, 'a dangling symlink')
    const real = fullRoot('entry-root-real')
    const linkedRoot = join(dirname(real), '9.9.8')
    symlinkSync(real, linkedRoot)
    refuses(linkedRoot, 'a root that is itself a symlink')
    const socketRoot = fullRoot('entry-socket')
    const server = createServer()
    const prevCwd = process.cwd()
    process.chdir(socketRoot)
    try { await new Promise((resolve, reject) => server.once('error', reject).listen('s', resolve)) } finally { process.chdir(prevCwd) }
    try { refuses(socketRoot, 'a unix socket in the root') } finally { await new Promise((resolve) => server.close(resolve)) }
    const fifoRoot = fullRoot('entry-fifo')
    const fifo = spawnSync('mkfifo', [join(fifoRoot, 'scripts', 'pipe')])
    if (fifo.status === 0) refuses(fifoRoot, 'a FIFO in the root, which is never opened for a read that would block')
    ok(`open refuses a Codex seat HOOKS_MISMATCH, for every access and writing nothing, when the root is a symlink or holds a symlink to a file, a directory or nothing, a unix socket${fifo.status === 0 ? ' or a FIFO' : ' (no mkfifo here, so no FIFO)'}`)

    if (process.getuid?.() === 0) ok('unreadable entries are not checked as root, which reads them anyway')
    else {
      const unreadableFile = fullRoot('entry-unreadable-file')
      const unreadableDir = fullRoot('entry-unreadable-dir')
      chmodSync(join(unreadableFile, 'scripts', 'seat.mjs'), 0o000)
      chmodSync(join(unreadableDir, 'scripts', 'lib'), 0o000)
      try {
        refuses(unreadableFile, 'an unreadable file')
        refuses(unreadableDir, 'an unreadable directory')
      } finally {
        chmodSync(join(unreadableFile, 'scripts', 'seat.mjs'), 0o644)
        chmodSync(join(unreadableDir, 'scripts', 'lib'), 0o755)
      }
      ok('open refuses a Codex seat HOOKS_MISMATCH, writing nothing, when the root holds a file or a directory it cannot read')
    }
  },

  'open-hooks-race': () => {
    const args = (access = 'read-only', extra = []) => ['open', '--access', access, '--provider', 'codex', '--model', MODELS.codex, '--effort', 'high', ...extra]
    const records = () => (existsSync(seats) ? readdirSync(seats).filter((name) => /^[0-9a-f]{32}$/.test(name)).sort() : [])
    let made = 0
    // An open whose Codex does step on its n-th hooks/list, refused kind for every access, with
    // nothing written.
    const refused = (root, onList, kind, what, allAccess = false) => {
      const lanes = allAccess
        ? [['read-only', []], ['workspace-write', ['--worktree', gitWorktree(`open-hooks-race-${made++}`)]], ['review', ['--base', baseSha, '--head', headSha]]]
        : [['read-only', []]]
      for (const [access, extra] of lanes) {
        const { dir, env } = codexState(flowEntries({ trusted: true, root }), { onList })
        const before = [records(), gitOut(canon, 'worktree', 'list', '--porcelain')]
        const out = seatCli(args(access, extra), { env })
        assert.equal(out.error?.kind, kind, `${what}, ${access}: ${JSON.stringify(out)}`)
        assert.deepEqual([records(), gitOut(canon, 'worktree', 'list', '--porcelain')], before, `${what}, ${access}: the refused open left a record or a review worktree`)
        if (access === 'workspace-write') assert.equal(existsSync(jobs.leaseDirOf(extra[1])), false, `${what}: the refused writer left its lease holder`)
        assert.deepEqual(codexSent(dir).map(({ method }) => method), ['initialize', 'initialized', 'hooks/list', 'initialize', 'initialized', 'hooks/list'], what)
      }
    }
    const byte = installedRoot('race-byte')
    writeFileSync(join(byte, 'README.md'), 'flow\n')
    refused(byte, { 2: { append: [join(byte, 'README.md'), 'x'] } }, 'HOOKS_CHANGED', 'a non-hook byte changed before the trust read answered', true)
    const added = installedRoot('race-added')
    refused(added, { 2: { append: [join(added, 'NEW'), 'x'] } }, 'HOOKS_CHANGED', 'a file added before the trust read answered')
    const moved = installedRoot('race-moved')
    refused(moved, { 2: { hooks: flowEntries({ trusted: true, root: installedRoot('race-moved-to') }) } }, 'HOOKS_CHANGED', 'a trust read that lists another root')
    ok('open refuses a Codex seat HOOKS_CHANGED, for every access and writing nothing, when a byte of the root changes or a file is added between the first digest and the trust read, or when the trust read lists flow under another root')

    const untrusting = installedRoot('race-untrusted')
    refused(untrusting, { 2: { hooks: flowEntries({ root: untrusting }) } }, 'HOOKS_UNTRUSTED', 'a trust read that reads untrusted')
    const early = installedRoot('race-early')
    writeFileSync(join(early, 'README.md'), 'flow\n')
    const { env } = codexState(flowEntries({ trusted: true, root: early }), { onList: { 1: { append: [join(early, 'README.md'), 'x'] } } })
    const opened = seatCli(args(), { env })
    assert.equal(opened.ok, true, JSON.stringify(opened))
    assert.equal(store.readRecord(opened.id).record.codexPluginDigest, treeDigest(early))
    ok('the trust comes from the second hooks/list, so one that reads untrusted refuses HOOKS_UNTRUSTED; a change before the first digest is no race, and the record holds the digest of the root as changed')
  },

  // B at close: Codex untrusts every flow hook when any file of the plugin changes and then skips
  // them without a word, so a Codex seat whose plugin root no longer holds what open digested may
  // have run unguarded, and an otherwise valid close reads unknown (hooks-changed).
  // B at close: Codex untrusts every flow hook when any file of the plugin changes and then skips
  // them without a word, so a Codex seat whose plugin root no longer holds what open digested may
  // have run unguarded, and an otherwise valid close reads unknown (hooks-changed).
  'close-hooks-changed': () => {
    const README = (seat) => join(seat.root, 'README.md')
    const changes = [
      ['one non-hook byte appended', (root) => writeFileSync(join(root, 'README.md'), 'flow\nx')],
      ['one non-hook byte changed', (root) => writeFileSync(join(root, 'README.md'), 'flaw\n')],
      ['a file added', (root) => writeFileSync(join(root, 'scripts', 'new.mjs'), '')],
      ['an empty directory added', (root) => mkdirSync(join(root, 'empty'))],
      ['a file removed', (root) => rmSync(join(root, 'scripts', 'seat.mjs'))],
      ['a file renamed', (root) => renameSync(join(root, 'scripts', 'seat.mjs'), join(root, 'scripts', 'moved.mjs'))],
    ]
    changes.forEach(([what, change], at) => {
      const seat = rootedCodexSeat(`close-hooks-changed-${at}`)
      assert.notEqual(seat.root, realpathSync(PLUGIN))
      change(seat.root)
      const out = closeSeat(seat.id)
      assert.deepEqual([out.verdict, out.reasons, out.result, out.turn], ['unknown', ['hooks-changed'], null, 1], `${what}: ${JSON.stringify(out)}`)
      assert.deepEqual([store.readStamp(seat.id, 'closed').verdict, store.readStamp(seat.id, 'closed').reasons], ['unknown', ['hooks-changed']])
    })
    ok('a Codex seat whose plugin root, apart from this checkout, gained, lost, renamed or changed a non-hook file or directory between open and close closes unknown (hooks-changed) with no result')

    // The two scans at close: a tree that changes between them reads hooks-changed even though
    // the first scan matched what open recorded.
    const scanned = rootedCodexSeat('close-hooks-changed-scan')
    const scanOut = closeSeat(scanned.id, taskStatusOf(scanned.id), { nodeArgs: ['--import', pathToFileURL(scanGate).href], env: { SCAN_ROOT: scanned.root } })
    assert.equal(readFileSync(README(scanned), 'utf8'), 'flow\nx', 'the scan gate never fired, so close scanned the root once')
    assert.deepEqual([scanOut.verdict, scanOut.reasons], ['unknown', ['hooks-changed']], JSON.stringify(scanOut))
    ok('close scans the root twice in a row, and a root that changes between the scans reads hooks-changed')

    // A later close after a valid first close checks the root again, and never rewrites the stamp.
    const later = rootedCodexSeat('close-hooks-changed-later')
    const first = closeSeat(later.id)
    assert.equal(first.verdict, 'valid', JSON.stringify(first))
    const bytes = readFileSync(join(seats, later.id, 'closed.json'))
    writeFileSync(README(later), 'flow\nx')
    const again = closeSeat(later.id)
    assert.deepEqual(again, { ...first, verdict: 'unknown', reasons: ['hooks-changed'], result: null, recorded: { verdict: 'valid', turn: 1 } }, JSON.stringify(again))
    assert.ok(readFileSync(join(seats, later.id, 'closed.json')).equals(bytes), 'the later close rewrote the closed stamp')
    ok('a later close of a seat closed valid reads hooks-changed with recorded once its root changed, the closed stamp byte-identical')

    // The check is endpoint drift: a change restored byte for byte before close is not seen.
    const restored = rootedCodexSeat('close-hooks-changed-restored')
    writeFileSync(README(restored), 'flow\nx')
    writeFileSync(README(restored), 'flow\n')
    assert.equal(closeSeat(restored.id).verdict, 'valid')
    ok('a root changed and then restored byte for byte before close closes valid: the documented endpoint-drift limit')
  },

  'close-hooks-missing': () => {
    const gone = rootedCodexSeat('close-hooks-missing')
    rmSync(gone.root, { recursive: true })
    const goneOut = closeSeat(gone.id)
    assert.deepEqual([goneOut.verdict, goneOut.reasons, goneOut.result], ['unknown', ['hooks-changed'], null], JSON.stringify(goneOut))
    // The same bytes behind a symlink are no longer the root open digested.
    const linked = rootedCodexSeat('close-hooks-missing-link')
    const copy = `${linked.root}-copy`
    cpSync(linked.root, copy, { recursive: true })
    rmSync(linked.root, { recursive: true })
    symlinkSync(copy, linked.root)
    assert.equal(treeDigest(copy), store.readRecord(linked.id).record.codexPluginDigest)
    const linkedOut = closeSeat(linked.id)
    assert.deepEqual([linkedOut.verdict, linkedOut.reasons], ['unknown', ['hooks-changed']], JSON.stringify(linkedOut))
    ok('a Codex seat whose plugin root is gone at close, or became a symlink to the same bytes, closes unknown (hooks-changed)')
  },

  'close-hooks-unchanged': () => {
    const seat = rootedCodexSeat('close-hooks-unchanged')
    const out = closeSeat(seat.id)
    assert.deepEqual([out.verdict, out.reasons, out.turn, out.result], ['valid', [], 1, ENVELOPE_OK], JSON.stringify(out))
    // The same through the real hooks, with a recorded follow-up.
    const hooked = rootedCodexSeat('close-hooks-unchanged-hooked', { hooks: true })
    const run = guardedSeat(MESSAGE_OK, { id: hooked.id })
    const key = run.followUp()
    const second = messageWith('turn 2 on an unchanged root')
    silent(run.stop(second, key), 'turn 2 stop')
    const followed = closeSeat(hooked.id, taskStatusOf(hooked.id, { latestTerminalRunId: runIdOf(childThreadOf(hooked.id), 2), latestTerminalSummary: second }))
    assert.deepEqual([followed.verdict, followed.reasons, followed.turn], ['valid', [], 2], JSON.stringify(followed))
    ok('a Codex seat whose plugin root holds at close exactly what open digested closes on its turn as before, through the store or the real hooks')
  },

  'close-hooks-legacy-record': () => {
    // A Codex record from before open recorded the root carries neither key, and closes as before.
    const legacy = hookedSeat({ provider: 'codex' })
    assert.equal(Object.hasOwn(store.readRecord(legacy.id).record, 'codexPluginRoot'), false)
    assert.deepEqual([closeSeat(legacy.id).verdict], ['valid'])
    // One key alone or a malformed value is no legacy record.
    const root = installedRoot('close-hooks-legacy')
    const digest = treeDigest(root)
    for (const [what, fields] of [
      ['the root alone', { codexPluginRoot: root }], ['the digest alone', { codexPluginDigest: digest }], ['a digest that is no sha256', { codexPluginRoot: root, codexPluginDigest: 'x' }],
      ['a relative root', { codexPluginRoot: 'plugins/flow', codexPluginDigest: digest }], ['a root that is no string', { codexPluginRoot: 7, codexPluginDigest: digest }],
      ['both null', { codexPluginRoot: null, codexPluginDigest: null }],
    ]) {
      const out = closeSeat(hookedSeat({ provider: 'codex', record: fields }).id)
      assert.deepEqual([out.verdict, out.reasons], ['unknown', ['hooks-changed']], `${what}: ${JSON.stringify(out)}`)
    }
    assert.equal(closeSeat(hookedSeat({ provider: 'codex', record: { codexPluginRoot: root, codexPluginDigest: digest } }).id).verdict, 'valid', 'both keys, matching')
    ok('a Codex record without codexPluginRoot and codexPluginDigest closes as before; one with only one of them, or a malformed one, closes unknown (hooks-changed)')
  },

  'close-hooks-claude-ignored': () => {
    const root = installedRoot('close-hooks-claude')
    for (const [what, fields] of [['no keys', {}], ['a root that is gone', { codexPluginRoot: join(tmp, 'nowhere'), codexPluginDigest: 'f'.repeat(64) }], ['the root alone', { codexPluginRoot: root }]]) {
      const out = closeSeat(hookedSeat({ provider: 'claude', record: fields }).id)
      assert.deepEqual([out.verdict, out.reasons], ['valid', []], `${what}: ${JSON.stringify(out)}`)
    }
    const opened = seatCli(['open', '--access', 'read-only', '--provider', 'claude', '--model', MODELS.claude, '--effort', 'high'])
    assert.equal(Object.hasOwn(store.readRecord(opened.id).record, 'codexPluginRoot'), false)
    assert.equal(closeSeat(hookedSeat({ id: opened.id }).id).verdict, 'valid')
    ok('a Claude seat records no plugin root and checks none at close, whatever its record carries')
  },

  'close-both-reasons': () => {
    const laterRun = (id) => taskStatusOf(id, { latestTerminalRunId: runIdOf(childThreadOf(id), 2), latestTerminalSummary: messageWith('run 2, unhooked') })
    const first = rootedCodexSeat('close-both-first')
    writeFileSync(join(first.root, 'README.md'), 'flow\nx')
    const out = closeSeat(first.id, laterRun(first.id))
    assert.deepEqual([out.verdict, out.reasons, out.result], ['unknown', ['stale-turn', 'hooks-changed'], null], JSON.stringify(out))
    assert.deepEqual(closeSeat(first.id, laterRun(first.id)), out, 'a later close of the seat printed something else')

    const repeated = rootedCodexSeat('close-both-repeated')
    assert.equal(closeSeat(repeated.id).verdict, 'valid')
    writeFileSync(join(repeated.root, 'README.md'), 'flow\nx')
    const again = closeSeat(repeated.id, laterRun(repeated.id))
    assert.deepEqual([again.verdict, again.reasons, again.result, again.recorded], ['unknown', out.reasons, null, { verdict: 'valid', turn: 1 }], JSON.stringify(again))
    ok('when stale-turn and hooks-changed both hold, close reads unknown with both reasons in that order, on a first close and on a later close of a seat closed valid alike')
  },

}

await runSection('trust-hooks', cases)
