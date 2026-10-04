#!/usr/bin/env node
// Smoke for T3 seats: the seat store in lib/seat-store.mjs, the answer shapes the seat guard
// prints through hooks/scripts/wire.mjs, and the seat guard itself, run as a real hook process with
// a fixture call on stdin shaped like the calls Claude Code 2.1.288 and Codex 0.160.0 sent live.
// The state directory is a temp directory named by FLOW_DELEGATION_STATE_DIR, and the races run as
// separate node processes released together, so the write-once claims are tested against real
// concurrent link(2) calls, not a single event loop.
// Cases are grouped by prefix (store-*, wire-*, admit-*, bind-*, spawn-*, mcp-*, edit-*, bash-*, closed-*,
// stop-*, open-*, close-*, prune-*, trust-*, fastpath-*); the containment families run against a
// real temp git repository as the worktree, the executor families (open-*, close-*, prune-open,
// trust-*) run scripts/seat.mjs as a process against a real canonical checkout with a linked
// worktree and a fake codex first on PATH that speaks the App Server's JSON-RPC, and
// stop-timeout spends the full CHECK_SECONDS on a schema check that never ends. open-lease races
// writer seats against flow_delegate write jobs as separate processes released together.
// --case-prefix <p>
// runs only the cases whose name starts with p, and no match is a failure rather than a vacuous
// pass. fastpath-latency prints the measured p50 cost of the catch-all hook and asserts no bound.
// Run: node plugins/flow/scripts/smoke-seat.mjs [--case-prefix <p>]
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
const seatPolicy = await import(pathToFileURL(join(PLUGIN, 'lib', 'seat-policy.mjs')).href)
const { RETENTION_MS } = await import(pathToFileURL(join(PLUGIN, 'lib', 'state-dir.mjs')).href)
const schemas = await import(pathToFileURL(join(PLUGIN, 'delegate', 'schema.mjs')).href)

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
// A final message that passes for a read-only or review seat with SCHEMA as its answer schema.
const ENVELOPE_OK = { status: 'done', coverage: { read: ['a.txt'], partial: [], unopened: ['b.txt'], checksRun: ['node --test'] }, notes: '', answer: { x: 'ok' } }

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

function stopBlocked(run, what) {
  assert.deepEqual(run.answer, { decision: 'block', reason: run.answer?.reason }, `${what}: expected a stop block, got ${run.stdout}`)
  assert.equal(typeof run.answer.reason, 'string', what)
  return run.answer.reason
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
// A Stop call: Claude names its turn by prompt_id and Codex by turn_id; key null drops it.
const stopCall = (host, session, message, key, fields = {}) => {
  const body = call(host, session, { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: message, ...fields })
  const field = host === 'claude' ? 'prompt_id' : 'turn_id'
  if (key === null) delete body[field]
  else body[field] = key
  if (host === 'claude') Object.assign(body, { effort: { level: 'medium' }, background_tasks: [], session_crons: [] })
  return body
}
const promptCall = (host, session, prompt, fields = {}) => call(host, session, { hook_event_name: 'UserPromptSubmit', prompt, ...fields })
const preCall = (host, session, toolName, toolInput, fields = {}) => call(host, session, {
  ...(host === 'claude' ? { effort: { level: 'medium' } } : {}),
  hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput,
  tool_use_id: host === 'claude' ? `toolu_${randomUUID().replaceAll('-', '')}` : `exec-${randomUUID()}`, ...fields,
})
// A delegate_task call for a record, as the delegate skill tells a parent to make it.
// The effort rides in target.options under the option id orchestrator_capabilities advertises.
const EFFORT_OPTION = { claude: 'effort', codex: 'reasoningEffort' }
const delegateInput = (record, id, fields = {}) => ({
  task: `${store.seatTag(id)}\nWorktree: ${record.worktree}\nRead the diff and answer in the flow envelope.`,
  role: 'general', runtimeMode: record.runtimeMode, clientRequestId: `flow-seat-${id}`,
  target: { providerInstanceId: INSTANCE[record.provider], model: record.model, options: [{ id: EFFORT_OPTION[record.provider], value: record.effort }] }, mode: 'async', ...fields,
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

// The seat executor, scripts/seat.mjs, as the parent runs it: one process per call, one JSON line
// out, exit 0 when ok and 1 when refused. It runs in the canonical checkout unless a case says
// otherwise, against the same state directory as the store.
const SEAT_SCRIPT = join(PLUGIN, 'scripts', 'seat.mjs')
const jobs = await import(pathToFileURL(join(PLUGIN, 'delegate', 'jobs.mjs')).href)
function seatCli(args, { cwd = canon, env = {}, script = SEAT_SCRIPT } = {}) {
  const run = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...trustedCodex.env, ...env } })
  const lines = run.stdout.split('\n').filter(Boolean)
  assert.equal(lines.length, 1, `seat.mjs ${args[0]} printed ${JSON.stringify(run.stdout)} ${run.stderr}`)
  const out = JSON.parse(lines[0])
  assert.equal(run.status, out.ok ? 0 : 1, `seat.mjs ${args[0]} exit ${run.status}`)
  return out
}
// A fake `codex` first on PATH for the trust cases: an App Server peer over stdio that answers
// initialize, hooks/list from <FAKE_CODEX_STATE>/hooks.json and config/batchWrite, applying an
// upsert into hooks.state the way Codex does (a key whose trusted_hash is its current hash reads
// trusted), unless the state says to ignore writes. It records every message it is sent in
// sent.jsonl. The hook entries take the shape codex 0.160.0's hooks/list answered with live, the
// command carrying the plugin root already expanded.
const fakeCodexBin = join(tmp, 'fake-codex-bin')
mkdirSync(fakeCodexBin, { recursive: true })
writeFileSync(join(fakeCodexBin, 'codex'), `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const dir = process.env.FAKE_CODEX_STATE
if (process.argv[2] !== 'app-server' || process.argv[3] !== '--stdio') { process.stderr.write('fake codex: unexpected argv'); process.exit(2) }
const state = () => JSON.parse(readFileSync(dir + '/hooks.json', 'utf8'))
const reply = (id, body) => process.stdout.write(JSON.stringify({ id, ...body }) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  appendFileSync(dir + '/sent.jsonl', JSON.stringify(message) + '\\n')
  if (message.id === undefined) return
  if (message.method === 'initialize') return reply(message.id, { result: { userAgent: 'fake-codex/0.160.0' } })
  if (message.method === 'hooks/list') return reply(message.id, { result: { data: [{ cwd: message.params.cwds[0], hooks: state().hooks, errors: [], warnings: [] }] } })
  if (message.method === 'config/batchWrite') {
    const now = state()
    if (!now.ignoreWrites) {
      for (const edit of message.params.edits) {
        if (edit.keyPath !== 'hooks.state' || edit.mergeStrategy !== 'upsert') continue
        for (const [key, value] of Object.entries(edit.value)) {
          const hook = now.hooks.find((entry) => entry.key === key)
          if (hook && value.trusted_hash === hook.currentHash) hook.trustStatus = 'trusted'
        }
      }
    }
    writeFileSync(dir + '/hooks.json', JSON.stringify(now))
    return reply(message.id, { result: { status: 'ok', version: '1', filePath: '/fake/config.toml' } })
  }
  reply(message.id, { error: { code: -32601, message: 'fake codex does not know ' + message.method } })
})
`)
chmodSync(join(fakeCodexBin, 'codex'), 0o755)
// Codex lists flow's hooks under the root of the flow copy it installed, which is not the copy a
// Claude session runs seat.mjs from. installedRoot makes such a root, holding a hooks/codex.json of
// the given bytes (this copy's unless a case says otherwise), and the entries carry FAKE_ROOT, a
// Codex install of this flow apart from this checkout, so every trust and open case is the
// cross-host one.
const OWN_HOOKS = readFileSync(join(PLUGIN, 'hooks', 'codex.json'))
function installedRoot(name, bytes = OWN_HOOKS) {
  const root = join(tmp, 'codex-home', name, 'plugins', 'cache', 'jakub', 'flow', '9.9.9')
  mkdirSync(join(root, 'hooks'), { recursive: true })
  writeFileSync(join(root, 'hooks', 'codex.json'), bytes)
  return root
}
const FAKE_ROOT = installedRoot('codex')
// A Codex install whose hooks/codex.json is this copy's with its final newline a space: one byte
// apart and the same JSON.
assert.equal(OWN_HOOKS.at(-1), 0x0a)
const DRIFTED_ROOT = installedRoot('drifted', Buffer.concat([OWN_HOOKS.subarray(0, -1), Buffer.from(' ')]))
const snake = (event) => event.replace(/[A-Z]/g, (c, at) => `${at ? '_' : ''}${c.toLowerCase()}`)
// hooks/list entries for this copy of flow's hooks/codex.json, each untrusted or trusted, under
// pluginId and root; drop removes the handlers whose command includes it.
function flowEntries({ trusted = false, pluginId = 'flow@jakub', root = FAKE_ROOT, drop = null } = {}) {
  const events = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'codex.json'), 'utf8')).hooks
  const entries = []
  for (const [event, groups] of Object.entries(events)) {
    groups.forEach((group, g) => group.hooks.forEach((handler, h) => {
      if (drop && handler.command.includes(drop)) return
      const command = handler.command.replaceAll('${PLUGIN_ROOT}', root)
      entries.push({ key: `${pluginId}:hooks/codex.json:${snake(event)}:${g}:${h}`, command, handlerType: 'command', async: false, currentHash: `sha256:${sha256(command)}`,
        displayOrder: entries.length, enabled: true, eventName: event[0].toLowerCase() + event.slice(1), isManaged: false, matcher: group.matcher ?? null,
        pluginId, source: 'plugin', sourcePath: `${root}/hooks/codex.json`, timeoutSec: handler.timeout, trustStatus: trusted ? 'trusted' : 'untrusted' })
    }))
  }
  return entries
}
// Hooks that are not flow's: another plugin's, and a user hook that runs a flow script by path.
const FOREIGN = [
  { key: 'gripe@jakub:hooks/codex.json:stop:0:0', command: 'node "/home/u/.codex/plugins/cache/jakub/gripe/1.0.0/hooks/scripts/stop.mjs"', handlerType: 'command', currentHash: 'sha256:g', enabled: true, pluginId: 'gripe@jakub', source: 'plugin', trustStatus: 'untrusted' },
  { key: '/home/u/.codex/hooks.json:pre_tool_use:0:0', command: `node "${FAKE_ROOT}/hooks/scripts/seat-guard.mjs" pre codex`, handlerType: 'command', currentHash: 'sha256:u', enabled: true, pluginId: null, source: 'user', trustStatus: 'untrusted' },
]
// A fake Codex state directory holding hooks, and the environment that puts the fake first on PATH.
function codexState(hooks, { ignoreWrites = false } = {}) {
  const dir = mkdtempSync(join(tmp, 'codex-state-'))
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks, ignoreWrites }))
  return { dir, env: { PATH: `${fakeCodexBin}:${process.env.PATH}`, FAKE_CODEX_STATE: dir } }
}
const codexSent = (dir) => (existsSync(join(dir, 'sent.jsonl')) ? readFileSync(join(dir, 'sent.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
const codexHooks = (dir) => JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')).hooks
const flowDigest = (entries) => sha256(JSON.stringify(entries.map(({ key, currentHash }) => [key, currentHash]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
// Every open in the executor cases sees a Codex that trusts all of flow's hooks, unless a case
// names another state.
const trustedCodex = codexState([...flowEntries({ trusted: true }), ...FOREIGN])

// A finished task_status answer for the seat's own task: T3 builds the task id from the call's
// clientRequestId, URL-encoded.
const taskStatusOf = (id, fields = {}) => ({ status: 'completed', taskId: `thread-1:delegate-task%3Aflow-seat-${id}`, ...fields })
const closeSeat = (id, taskStatus = taskStatusOf(id)) => seatCli(['close', id, '--task-status', JSON.stringify(taskStatus)])

// The executor's repositories: a canonical checkout with two commits (base adds a.txt, b.txt and
// sub/x.txt; head changes a.txt and adds c.txt), which keeps .flow-worktrees/ in its exclude file
// as the issue claim does, and a linked worktree of it outside it.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'smoke',
  GIT_AUTHOR_EMAIL: 'smoke@example.invalid', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid' }
const gitOut = (cwd, ...args) => {
  const run = spawnSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`)
  return run.stdout.trim()
}
const canon = join(tmp, 'canon')
mkdirSync(join(canon, 'sub'), { recursive: true })
gitOut(canon, 'init', '-q', '-b', 'main')
writeFileSync(join(canon, '.git', 'info', 'exclude'), '/.flow-worktrees/\n')
for (const [file, text] of [['a.txt', 'a\n'], ['b.txt', 'b\n'], ['sub/x.txt', 'x\n']]) writeFileSync(join(canon, file), text)
gitOut(canon, 'add', '-A')
gitOut(canon, 'commit', '-q', '-m', 'base')
const baseSha = gitOut(canon, 'rev-parse', 'HEAD')
writeFileSync(join(canon, 'a.txt'), 'a2\n')
writeFileSync(join(canon, 'c.txt'), 'c\n')
gitOut(canon, 'add', '-A')
gitOut(canon, 'commit', '-q', '-m', 'head')
const headSha = gitOut(canon, 'rev-parse', 'HEAD')
const linkedWt = join(tmp, 'linked')
gitOut(canon, 'worktree', 'add', '-q', '-b', 'linked', linkedWt)
// A fresh repository of its own, for a case that needs a worktree no other case touches.
const gitWorktree = (name) => {
  const path = join(tmp, 'repos', name)
  mkdirSync(path, { recursive: true })
  gitOut(path, 'init', '-q')
  return path
}
// A flow_delegate write job's record: queued (live, inside its grace) or ended with no provider
// group on record (gone).
function jobRecord(worktree, status) {
  const ended = status !== 'queued'
  const job = { id: randomUUID(), access: 'workspace-write', worktree, status, createdAt: new Date().toISOString(), endedAt: ended ? new Date().toISOString() : null }
  mkdirSync(jobs.jobDir(job.id), { recursive: true })
  jobs.writeJob(job)
  return job
}
// A seat the hooks ran in, written straight through the store: the record (a new read-only one
// unless id names one seat open wrote), the stamps listed, the bound stamp pinning digest, the
// bound session's index entry naming the seat (index 'own'; 'none' writes none), and turn 1
// ending as outcome with models as the models seen serving it, with a result for a valid turn
// unless result is false.
function hookedSeat({ id = null, provider = 'claude', model = MODELS[provider], stamps = ['admitted', 'bound', 'receipt'], digest = null, boundModel = null,
  outcome = 'valid', blocks = 0, errors = [], served = [model], models = served, envelope = ENVELOPE_OK, result = true, index = 'own' } = {}) {
  const seatId = id ?? store.writeRecord(RECORD({ provider, model, worktree: canon, repoRoot: canon }), null).id
  const loaded = store.readRecord(seatId)
  const bound = { sessionId: `s-${seatId}`, host: provider, permissionMode: PERMISSION[provider], cwd: canon, recordDigest: digest ?? loaded.digest }
  if (boundModel) bound.model = boundModel
  const bodies = { admitted: { toolUseId: 'toolu_x' }, bound, receipt: { tool: 'Bash' } }
  for (const name of stamps) assert.equal(store.stamp(seatId, name, bodies[name]), true)
  if (index === 'own') assert.equal(store.indexSession(provider, bound.sessionId, { id: seatId }), true)
  if (outcome !== null) {
    store.writeState(seatId, { turn: 1, turnKey: 'k1', blocks, outcome, errors, stops: blocks + 1, messageSha256: 'c'.repeat(64), models })
    if (outcome === 'valid' && result) store.writeResult(seatId, 1, { envelope, servedModels: served, messageSha256: 'c'.repeat(64), at: new Date().toISOString() })
  }
  return { id: seatId }
}
// Preloaded into a seat process: it holds the process at the write of its lease holder file, or
// with SEAT_GATE_AT=record at the write of its record's temp file, until <SEAT_GATE>.go exists,
// having written <SEAT_GATE>.waiting, so a case can act in that window.
const holderGate = join(tmp, 'holder-gate.mjs')
writeFileSync(holderGate, `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const real = fs.writeFileSync
const at = process.env.SEAT_GATE_AT === 'record' ? /\\/seats\\/[0-9a-f]{32}\\/\\.record\\.json\\./ : /\\/leases\\/[0-9a-f]{64}\\/[0-9a-f]{32}$/
fs.writeFileSync = function (path, ...rest) {
  if (typeof path === 'string' && at.test(path)) {
    real(process.env.SEAT_GATE + '.waiting', '')
    const nap = new Int32Array(new SharedArrayBuffer(4))
    while (!fs.existsSync(process.env.SEAT_GATE + '.go')) Atomics.wait(nap, 0, 0, 5)
  }
  return real.call(this, path, ...rest)
}
syncBuiltinESMExports()
`)
// Preloaded into a write job's process: it holds the process at its first rename of a pending
// seat holder <lease dir>/<seat id>, the takeover of a holder it judged abandoned, until
// <JOB_GATE>.go exists, having written <JOB_GATE>.waiting.
const jobGate = join(tmp, 'job-gate.mjs')
writeFileSync(jobGate, `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const real = fs.renameSync
fs.renameSync = function (from, ...rest) {
  if (typeof from === 'string' && /\\/leases\\/[0-9a-f]{64}\\/[0-9a-f]{32}$/.test(from)) {
    fs.writeFileSync(process.env.JOB_GATE + '.waiting', '')
    const nap = new Int32Array(new SharedArrayBuffer(4))
    while (!fs.existsSync(process.env.JOB_GATE + '.go')) Atomics.wait(nap, 0, 0, 5)
  }
  return real.call(this, from, ...rest)
}
syncBuiltinESMExports()
`)
// Preloaded into a seat guard or seat.mjs process: with STAMP_GATE_AT=bound it holds the process at
// the write of a bound stamp's temp file, after the bind read every stamp and before its bound
// stamp exists; with STAMP_GATE_AT=closed it holds the process just after the closed stamp is
// linked into place. Either way it writes <STAMP_GATE>.waiting and waits for <STAMP_GATE>.go.
const stampGate = join(tmp, 'stamp-gate.mjs')
writeFileSync(stampGate, `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const realWrite = fs.writeFileSync
const realLink = fs.linkSync
const hold = () => {
  realWrite(process.env.STAMP_GATE + '.waiting', '')
  const nap = new Int32Array(new SharedArrayBuffer(4))
  while (!fs.existsSync(process.env.STAMP_GATE + '.go')) Atomics.wait(nap, 0, 0, 5)
}
if (process.env.STAMP_GATE_AT === 'bound') {
  fs.writeFileSync = function (path, ...rest) {
    if (typeof path === 'string' && /\\/seats\\/[0-9a-f]{32}\\/\\.bound\\.json\\./.test(path)) hold()
    return realWrite.call(this, path, ...rest)
  }
} else {
  fs.linkSync = function (from, to, ...rest) {
    const out = realLink.call(this, from, to, ...rest)
    if (typeof to === 'string' && /\\/seats\\/[0-9a-f]{32}\\/closed\\.json$/.test(to)) hold()
    return out
  }
}
syncBuiltinESMExports()
`)
// A process run under stampGate, returned once it is held at the gate: done resolves to its exit
// code and stdout after the case writes <gate>.go. One still held when the run ends is killed, so
// a failing case cannot leave it waiting forever.
const heldChildren = new Set()
async function heldAt(args, gate, at, input = null) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(stampGate).href, ...args], {
    cwd: canon, env: { ...process.env, STAMP_GATE: gate, STAMP_GATE_AT: at }, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'inherit'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  if (input !== null) child.stdin.end(JSON.stringify(input))
  heldChildren.add(child)
  const done = new Promise((resolve) => child.on('close', (code) => { heldChildren.delete(child); resolve({ code, out }) }))
  await waitFor(`${gate}.waiting`, `the process never reached the ${at} gate`)
  return { done }
}
async function waitFor(path, what) {
  for (const end = Date.now() + 15_000; !existsSync(path);) {
    if (Date.now() > end) throw new Error(what)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
// Writer seats and write jobs racing for one worktree, released together: each racer loads what
// it needs, says it is ready, waits for the go file, then makes its one attempt and prints
// `seat ok <id>`, `job ok <id>`, or the kind it was refused with.
const leaseRacer = join(tmp, 'lease-racer.mjs')
writeFileSync(leaseRacer, `import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const [kind, worktree, ready, go, plugin] = process.argv.slice(2)
const jobs = await import(pathToFileURL(plugin + '/delegate/jobs.mjs').href)
await import(pathToFileURL(plugin + '/lib/seat-store.mjs').href)
let job
if (kind === 'job') {
  job = { id: randomUUID(), access: 'workspace-write', worktree, status: 'queued', createdAt: new Date().toISOString(), endedAt: null }
  mkdirSync(jobs.jobDir(job.id), { recursive: true })
  jobs.writeJob(job)
}
writeFileSync(ready, '')
const nap = new Int32Array(new SharedArrayBuffer(4))
while (!existsSync(go)) Atomics.wait(nap, 0, 0, 1)
if (kind === 'job') {
  try { jobs.acquireLease(job); process.stdout.write('job ok ' + job.id) } catch (error) { process.stdout.write('job ' + (error.kind ?? error.message)) }
} else {
  const lines = []
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true }
  process.argv = [process.argv[0], plugin + '/scripts/seat.mjs', 'open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', worktree]
  await import(pathToFileURL(plugin + '/scripts/seat.mjs').href)
  const out = JSON.parse(lines.join(''))
  process.exitCode = 0
  process.stderr.write(out.ok ? 'seat ok ' + out.id : 'seat ' + out.error.kind)
}
`)
async function leaseRace(worktree, seatCount, jobCount) {
  const round = mkdtempSync(join(tmp, 'lease-race-'))
  const go = join(round, 'go')
  const kinds = [...Array(seatCount).fill('seat'), ...Array(jobCount).fill('job')]
  const runs = kinds.map((kind, at) => {
    const child = spawn(process.execPath, [leaseRacer, kind, worktree, join(round, `ready-${at}`), go, PLUGIN], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    return new Promise((resolve, reject) => child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`racer exit ${code}: ${out}`)))))
  })
  for (const end = Date.now() + 15_000; readdirSync(round).filter((f) => f.startsWith('ready-')).length < kinds.length;) {
    if (Date.now() > end) throw new Error('lease racers never became ready')
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
      assert.deepEqual(store.readStamp(id, 'admitted'), { at: store.readStamp(id, 'admitted').at, toolUseId: call.tool_use_id, clientRequestId: `flow-seat-${id}` })
    }
    ok('a tagged call is admitted only with clientRequestId exactly flow-seat-<id>, and the admitted stamp records it beside the tool use id')
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
    assert.equal(store.stamp(bareId, 'admitted', {}), true)
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
      assert.equal(store.stamp(id, 'admitted', {}), true)
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
      `node ${script} open --access read-only --provider claude --model m --effort high`, `node ${script} close ${'a'.repeat(32)} --task-status '{}'`,
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
    assert.equal(store.stamp(bareId, 'admitted', {}), true)
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
    assert.equal(store.stamp(id, 'admitted', {}), true)
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
    silent(guard('stop', 'codex', stopCall('codex', fine.session, JSON.stringify({ ...ENVELOPE_OK, notes: 'turn 2' }), randomUUID())), 'turn 2')
    const fineOut = closeSeat(fine.id)
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

  'open-access': () => {
    const read = seatCli(['open', '--access', 'read-only', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high'])
    assert.deepEqual(Object.keys(read), ['ok', 'id', 'tag', 'clientRequestId', 'runtimeMode', 'provider', 'model', 'effort', 'worktree', 'reviewWorktree'])
    assert.equal(read.ok, true)
    assert.match(read.id, /^[0-9a-f]{32}$/)
    assert.equal(read.tag, `<flow-seat id=${read.id}>`)
    assert.equal(read.clientRequestId, `flow-seat-${read.id}`)
    assert.deepEqual({ ...read, id: undefined, tag: undefined, clientRequestId: undefined }, { ok: true, id: undefined, tag: undefined, clientRequestId: undefined, runtimeMode: 'auto', provider: 'claude', model: 'claude-opus-5-5', effort: 'high', worktree: canon, reviewWorktree: null })
    const loaded = store.readRecord(read.id)
    assert.deepEqual({ ...loaded.record, createdAt: undefined }, {
      v: 1, id: read.id, createdAt: undefined, access: 'read-only', repoRoot: canon, worktree: canon, reviewWorktree: null, baseSha: null, headSha: null,
      reviewGitDir: null, provider: 'claude', model: 'claude-opus-5-5', effort: 'high', runtimeMode: 'auto', canonicalSnapshot: null, hooksDigest: null, schemaSha256: null,
    })
    assert.equal(loaded.schema, null)
    ok('a read-only seat opens in the working directory\'s worktree: the output names its id, tag, clientRequestId flow-seat-<id>, runtimeMode auto, model, effort and worktree, and the record holds the same with no schema')

    const schemaFile = join(tmp, 'answer-schema.json')
    writeFileSync(schemaFile, JSON.stringify(SCHEMA))
    const linked = seatCli(['open', '--access', 'read-only', '--provider', 'codex', '--model', 'gpt-6-luna', '--effort', 'medium', '--worktree', join(linkedWt, 'sub'), '--schema', schemaFile])
    assert.equal(linked.worktree, linkedWt)
    const linkedRecord = store.readRecord(linked.id)
    assert.equal(linkedRecord.record.repoRoot, canon, 'the canonical checkout of a linked worktree is the main worktree')
    assert.equal(linkedRecord.record.worktree, linkedWt)
    assert.deepEqual(linkedRecord.schema, SCHEMA)
    ok('--worktree inside a linked worktree opens at that worktree\'s top level, with the main worktree as the canonical checkout, and --schema is stored as the answer schema')

    const writer = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', linkedWt])
    assert.equal(writer.worktree, linkedWt)
    assert.deepEqual(readdirSync(jobs.leaseDirOf(linkedWt)), [`${writer.id}.live`], 'the writer holds the worktree\'s lease directory under its seat id, live')
    assert.equal(store.readRecord(writer.id).record.access, 'workspace-write')
    closeSeat(writer.id)
    assert.equal(existsSync(jobs.leaseDirOf(linkedWt)), false, 'close dropped the holder and the empty lease directory')
    ok('a writer seat writes its holder file into the worktree\'s lease directory, and close drops it')
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
    assert.deepEqual(Object.keys(record.canonicalSnapshot).sort(), ['branch', 'cached', 'diff', 'head', 'status', 'untracked'])
    assert.equal(record.reviewGitDir, realpathSync(gitOut(path, 'rev-parse', '--absolute-git-dir')))
    assert.equal(gitOut(canon, 'status', '--porcelain'), '', 'the review worktree shows nowhere in the canonical checkout')
    ok('a review seat resolves --base and --head to SHAs, adds a detached worktree at the head under .flow-worktrees/review-<id>, answers in the findings schema, and records a canonical snapshot with HEAD and branch and the review worktree\'s git directory')

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
      const out = closeSeat(seat.id)
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
    for (let round = 0; round < 6; round++) {
      const contested = gitWorktree(`lease-race-${round}`)
      const results = await leaseRace(contested, 3, 3)
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
    ok('six rounds of three writer seats racing three write jobs for one worktree never let a seat and a job both in, and the lease directory names exactly the winners')
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
    assert.deepEqual(store.readStamp(valid.id, 'closed').taskStatus, taskStatusOf(valid.id))
    ok('valid: every stamp present and an intact result whose served models are the record\'s; the output carries the envelope and the closed stamp records the task status')

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
    ok('unknown: a missing admitted, bound or receipt stamp, any void stamp, a record digest the bind did not pin, a bound session whose index is void, missing or names another seat, a result whose sha256 does not match, no served model, no Stop, a valid turn with no result, or a missing or corrupt record')

    verdict(hookedSeat({ served: ['claude-sonnet-5-5'] }).id, 'model-mismatch', /served by claude-sonnet-5-5, not claude-opus-5-5/, 'served model mismatch')
    verdict(hookedSeat({ provider: 'codex', model: 'gpt-6-luna', boundModel: 'gpt-6-mini', served: ['gpt-6-luna'] }).id, 'model-mismatch', /gpt-6-mini/, 'bind model mismatch')
    verdict(hookedSeat({ boundModel: 'claude-sonnet-5-5', outcome: 'blocked', blocks: 1, errors: ['$: x'] }).id, 'model-mismatch', null, 'a mismatch outranks invalid')
    const both = hookedSeat({ served: ['claude-sonnet-5-5'] })
    store.stamp(both.id, 'void', { reason: 'r' })
    verdict(both.id, 'unknown', /void/, 'unknown outranks model-mismatch')
    ok('model-mismatch: a served model or the model seen at the bind is not the record\'s, outranking invalid and outranked by unknown')
  },

  'close-review': () => {
    const covering = (extra = {}) => ({ ...ENVELOPE_OK, answer: { findings: [] }, coverage: { read: ['a.txt'], partial: ['./c.txt'], unopened: [], checksRun: [] }, ...extra })
    const reviewSeat = (envelope = covering(), fields = {}) => {
      const opened = seatCli(['open', '--access', 'review', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--base', baseSha, '--head', headSha])
      assert.equal(opened.ok, true, JSON.stringify(opened))
      return hookedSeat({ id: opened.id, envelope, ...fields })
    }

    const clean = reviewSeat()
    const path = store.readRecord(clean.id).record.reviewWorktree
    const out = closeSeat(clean.id)
    assert.equal(out.verdict, 'valid', JSON.stringify(out.reasons))
    assert.equal(existsSync(path), false, 'close removed the review worktree')
    assert.ok(!gitOut(canon, 'worktree', 'list', '--porcelain').includes(path), 'git still lists the review worktree')
    const absolute = reviewSeat(covering({ coverage: { read: [], partial: [], unopened: [], checksRun: [] } }))
    const absPath = store.readRecord(absolute.id).record.reviewWorktree
    store.writeResult(absolute.id, 1, { envelope: covering({ coverage: { read: [join(absPath, 'a.txt')], partial: [], unopened: ['c.txt'], checksRun: [] } }), servedModels: ['claude-opus-5-5'], messageSha256: 'b'.repeat(64), at: new Date().toISOString() })
    assert.equal(closeSeat(absolute.id).verdict, 'valid', 'an absolute coverage path inside the review worktree counts')
    ok('a review whose worktree stayed at the head and clean, whose canonical checkout did not move, and whose coverage lists every diffed file (read, partial or unopened, relative, ./ or absolute) is valid, and close removes its worktree')

    const moved = reviewSeat()
    spawnSync('git', ['-C', store.readRecord(moved.id).record.reviewWorktree, 'checkout', '-q', '--detach', baseSha])
    assert.equal(closeSeat(moved.id).verdict, 'tree-moved')
    const dirty = reviewSeat()
    writeFileSync(join(store.readRecord(dirty.id).record.reviewWorktree, 'scratch.txt'), 'x')
    const dirtyOut = closeSeat(dirty.id)
    assert.equal(dirtyOut.verdict, 'tree-moved')
    assert.ok(dirtyOut.reasons.some((reason) => /dirty/.test(reason)), JSON.stringify(dirtyOut.reasons))
    const canonical = reviewSeat()
    writeFileSync(join(canon, 'stray.txt'), 'x')
    const canonOut = closeSeat(canonical.id)
    rmSync(join(canon, 'stray.txt'))
    assert.equal(canonOut.verdict, 'tree-moved')
    assert.ok(canonOut.reasons.some((reason) => /canonical checkout changed/.test(reason)), JSON.stringify(canonOut.reasons))
    const partial = reviewSeat(covering({ coverage: { read: ['a.txt'], partial: [], unopened: [], checksRun: [] } }))
    const partialOut = closeSeat(partial.id)
    assert.equal(partialOut.verdict, 'tree-moved')
    assert.ok(partialOut.reasons.some((reason) => /coverage misses 1 file\(s\) in the pinned diff: c\.txt/.test(reason)), JSON.stringify(partialOut.reasons))
    assert.equal(closeSeat(reviewSeat(covering(), { outcome: 'capped', blocks: 3, errors: ['$: x'] }).id).verdict, 'capped', 'a capped review with no envelope is not judged on coverage')
    const cappedMoved = reviewSeat(covering(), { outcome: 'capped', blocks: 3, errors: ['$: x'] })
    writeFileSync(join(store.readRecord(cappedMoved.id).record.reviewWorktree, 'scratch.txt'), 'x')
    assert.equal(closeSeat(cappedMoved.id).verdict, 'tree-moved', 'tree-moved outranks capped')
    ok('tree-moved: the review worktree\'s HEAD moved, it is dirty, the canonical checkout changed, or the coverage misses a diffed file; it outranks capped')

    // The canonical checkout's HEAD is part of what a review pins: a detach or a commit that leaves
    // the tree as it was still moves it.
    const detached = reviewSeat()
    gitOut(canon, 'checkout', '-q', '--detach', 'HEAD')
    const detachedOut = closeSeat(detached.id)
    gitOut(canon, 'checkout', '-q', 'main')
    assert.equal(detachedOut.verdict, 'tree-moved', JSON.stringify(detachedOut))
    assert.ok(detachedOut.reasons.some((reason) => /canonical checkout's HEAD/.test(reason)), JSON.stringify(detachedOut.reasons))
    const committed = reviewSeat()
    gitOut(canon, 'commit', '-q', '--allow-empty', '-m', 'empty')
    const committedOut = closeSeat(committed.id)
    gitOut(canon, 'reset', '-q', '--soft', headSha)
    assert.equal(gitOut(canon, 'rev-parse', 'HEAD'), headSha)
    assert.equal(committedOut.verdict, 'tree-moved', JSON.stringify(committedOut))
    const record = store.readRecord(committed.id).record
    assert.deepEqual([record.canonicalSnapshot.head, record.canonicalSnapshot.branch], [headSha, 'refs/heads/main'])
    ok('a review records the canonical checkout\'s HEAD commit and branch, and reads tree-moved when either changed, the tree unchanged')

    // close removes only the worktree its open added: the same path, the same admin directory, and
    // still listed by git. One moved away and replaced at that path by another is left in place.
    const swapped = reviewSeat()
    const swappedRecord = store.readRecord(swapped.id).record
    assert.equal(swappedRecord.reviewGitDir, realpathSync(gitOut(swappedRecord.reviewWorktree, 'rev-parse', '--absolute-git-dir')))
    const movedTo = join(tmp, `moved-${swapped.id}`)
    gitOut(canon, 'worktree', 'move', swappedRecord.reviewWorktree, movedTo)
    gitOut(canon, 'worktree', 'add', '-q', '--detach', swappedRecord.reviewWorktree, headSha)
    const swappedOut = closeSeat(swapped.id)
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
    const plainOut = closeSeat(plain.id)
    assert.ok(existsSync(join(plainPath, 'keep.txt')), 'close removed a plain directory at the review path')
    assert.ok(plainOut.cleanupProblems?.length > 0, JSON.stringify(plainOut))
    rmSync(plainPath, { recursive: true })
    ok('close removes a review worktree only while its path, its admin directory and git\'s worktree list all still match what open recorded, and otherwise leaves the path alone and reports it in cleanupProblems')
  },

  'close-rerun': () => {
    const writerWt = gitWorktree('close-rerun')
    const opened = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', writerWt])
    const seat = hookedSeat({ id: opened.id, envelope: { ...ENVELOPE_OK, commits: [{ sha: 'a'.repeat(40), subject: 'feat: x' }] } })
    const first = closeSeat(seat.id, taskStatusOf(seat.id, { run: 1 }))
    assert.equal(first.verdict, 'valid')
    assert.equal(existsSync(join(jobs.leaseDirOf(writerWt), `${seat.id}.live`)), false, 'close dropped the writer\'s holder')
    store.writeState(seat.id, { ...store.readState(seat.id), outcome: 'blocked', blocks: 1 })
    const again = closeSeat(seat.id, taskStatusOf(seat.id, { status: 'failed', run: 2 }))
    assert.equal(again.verdict, 'valid', 'a second close re-judged the seat')
    assert.deepEqual(store.readStamp(seat.id, 'closed').taskStatus, taskStatusOf(seat.id, { run: 1 }))
    ok('a second close prints the verdict and reasons on record, keeps the first task status, and the first close dropped the writer\'s lease holder')

    const resultPath = join(seats, seat.id, 'result-1.json')
    const stamped = store.readStamp(seat.id, 'closed')
    assert.equal(stamped.resultSha256, sha256(readFileSync(resultPath)), 'the closed stamp does not pin the result it judged')
    assert.equal(stamped.turn, 1)
    assert.deepEqual([again.reasons, again.result, again.turn, again.servedModels], [[], first.result, 1, ['claude-opus-5-5']], 'a second close did not return the result on record')
    store.writeResult(seat.id, 1, { envelope: { ...first.result, notes: 'rewritten after close' }, servedModels: ['claude-opus-5-5'], at: new Date().toISOString() })
    const third = closeSeat(seat.id)
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

    // close records a seat T3 reports finished, and nothing else: a running task, a child still
    // working or waiting on its own children, or a status that is not one of T3's terminal ones.
    const runningWt = gitWorktree('close-running')
    const running = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', runningWt])
    hookedSeat({ id: running.id })
    for (const status of [{ status: 'running' }, {}, null, [], 'completed', { status: 'completed', workState: 'working' },
      { status: 'failed', workState: 'waiting_for_children' }, { status: 'cancelled', hasPendingChildRuns: true }, { status: 'Completed' }]) {
      const refused = closeSeat(running.id, status)
      assert.equal(refused.error?.kind, 'TASK_NOT_TERMINAL', `${JSON.stringify(status)}: ${JSON.stringify(refused)}`)
      assert.equal(store.readStamp(running.id, 'closed'), null, `${JSON.stringify(status)} stamped the seat closed`)
      assert.ok(existsSync(join(jobs.leaseDirOf(runningWt), `${running.id}.live`)), `${JSON.stringify(status)} dropped the writer's holder`)
    }
    for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
      const each = hookedSeat({})
      assert.equal(closeSeat(each.id, taskStatusOf(each.id, { status, workState: 'result_available', hasPendingChildRuns: false })).ok, true, status)
    }
    assert.equal(closeSeat(running.id, taskStatusOf(running.id, { workState: 'result_available', hasPendingChildRuns: false })).verdict, 'valid')
    assert.equal(existsSync(join(jobs.leaseDirOf(runningWt), `${running.id}.live`)), false)
    ok('close refuses TASK_NOT_TERMINAL, writing nothing and keeping the lease, unless the task status is an object whose status is completed, failed, cancelled or interrupted, whose workState is not working or waiting_for_children, and with no pending child runs')

    for (const [args, kind] of [
      [['close'], 'BAD_REQUEST'], [['close', 'xyz', '--task-status', '{}'], 'BAD_REQUEST'], [['close', seat.id], 'BAD_REQUEST'],
      [['close', seat.id, '--task-status', 'not json'], 'BAD_REQUEST'], [['close', seat.id, '--task-status', '{}', '--x', '1'], 'BAD_REQUEST'],
      [['close', seat.id, '--task-status', JSON.stringify('x'.repeat(70_000))], 'BAD_REQUEST'],
    ]) assert.equal(seatCli(args).error?.kind, kind, args.join(' ').slice(0, 80))
    ok('close refuses a missing or malformed seat id, a missing, unparsable or oversized --task-status, and an unknown flag, with BAD_REQUEST')
  },

  'close-task-match': () => {
    const writerWt = gitWorktree('close-task-match')
    const opened = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', writerWt])
    const seat = hookedSeat({ id: opened.id })
    const another = store.newId()
    for (const status of [
      { status: 'completed' }, taskStatusOf(seat.id, { taskId: 7 }), taskStatusOf(seat.id, { taskId: `thread-1:delegate-task%3Aflow-seat-${another}` }),
      taskStatusOf(seat.id, { taskId: `thread-1:delegate-task%3A${seat.id}` }), taskStatusOf(seat.id, { taskId: 'task-1' }),
    ]) {
      const refused = closeSeat(seat.id, status)
      assert.equal(refused.error?.kind, 'TASK_MISMATCH', `${JSON.stringify(status)}: ${JSON.stringify(refused)}`)
      assert.match(refused.error.message, new RegExp(`flow-seat-${seat.id}`))
      assert.equal(store.readStamp(seat.id, 'closed'), null, `${JSON.stringify(status)} stamped the seat closed`)
      assert.ok(existsSync(join(jobs.leaseDirOf(writerWt), `${seat.id}.live`)), `${JSON.stringify(status)} dropped the writer's holder`)
    }
    ok('close refuses TASK_MISMATCH, writing nothing and keeping the lease, when the task status of an admitted seat carries no taskId naming flow-seat-<id>')

    for (const taskId of [`thread-1:delegate-task:flow-seat-${seat.id}`, `thread-1%3Adelegate-task%3Aflow%2Dseat%2D${seat.id}`]) {
      const each = hookedSeat({})
      assert.equal(closeSeat(each.id, taskStatusOf(each.id, { taskId: taskId.replace(seat.id, each.id) })).verdict, 'valid', taskId)
    }
    assert.equal(closeSeat(seat.id).verdict, 'valid')
    const unadmitted = hookedSeat({ stamps: [], index: 'none', outcome: null })
    const closed = closeSeat(unadmitted.id, { status: 'cancelled', taskId: 'whatever' })
    assert.deepEqual([closed.ok, closed.verdict], [true, 'unknown'], JSON.stringify(closed))
    ok('close accepts the seat\'s own task id, plain or URL-encoded, and closes a seat that was never admitted on any finished task status, as unknown')
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
    for (const args of [['--abandon', '--task-status', JSON.stringify(taskStatusOf(writer.id))], ['--task-status', JSON.stringify(taskStatusOf(writer.id)), '--abandon'], ['--abandon', '--abandon'], ['--abandon', 'x']]) {
      const refused = seatCli(['close', writer.id, ...args])
      assert.equal(refused.error?.kind, 'BAD_REQUEST', `${args.join(' ')}: ${JSON.stringify(refused)}`)
      assert.equal(store.readStamp(writer.id, 'closed'), null, `${args.join(' ')} stamped the seat closed`)
      assert.ok(existsSync(writer.holder), `${args.join(' ')} dropped the holder`)
    }
    ok('close takes --abandon alone: beside --task-status, twice or with a value it is BAD_REQUEST, writing nothing and keeping the holder')

    const abandoned = seatCli(['close', writer.id, '--abandon'])
    const expected = { ok: true, id: writer.id, verdict: 'unknown', reasons: ['abandoned-before-bind'], turn: null, result: null, servedModels: [], blocks: 0, errors: [] }
    assert.deepEqual(abandoned, expected)
    const stamped = store.readStamp(writer.id, 'closed')
    assert.deepEqual({ ...stamped, at: undefined }, { at: undefined, verdict: 'unknown', reasons: ['abandoned-before-bind'], abandoned: true, taskStatus: null, turn: null, resultSha256: null, servedModels: [], blocks: 0, errors: [] })
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
    assert.match(refused.error.message, /a bound seat closes with its task status/i)
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
      [{ served: [], models: [model] }, 'unknown', /turn 1's result names no served model/],
      [{ served: [7], models: [model] }, 'unknown', /turn 1's result names no served model/],
      [{ served: [model], models: [] }, 'valid', null],
      [{ served: [model, 'claude-sonnet-5-5'], models: [model] }, 'model-mismatch', /claude-sonnet-5-5/],
      [{ served: [model], models: [model, 'claude-sonnet-5-5'] }, 'model-mismatch', /claude-sonnet-5-5/],
    ]
    for (const [fields, verdict, reason] of cases) {
      const seat = hookedSeat(fields)
      const out = closeSeat(seat.id)
      assert.equal(out.verdict, verdict, `${JSON.stringify(fields)}: ${JSON.stringify(out)}`)
      if (reason) assert.match(out.reasons.join(' '), reason)
    }
    ok('close reads a valid turn whose result names no served model of its own as unknown, whatever earlier stops saw, and a model other than the record\'s in the result or in any stop as model-mismatch')
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
      assert.ok(!loaded('stop', host, stopCall(host, session, 'done', randomUUID())).includes('seat-policy.mjs'), 'a non-seat stop loaded the policy')
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
  for (const child of heldChildren) child.kill('SIGKILL')
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\nsmoke-seat: ALL PASS (${checks} checks, ${selected.length} cases)`)
