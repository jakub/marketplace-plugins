// Shared harness and fixtures for test/flow/seat/*.mjs. Each section runs in its own Node
// process via test/flow/smoke-seat.mjs, so every section gets its own temp directory, state dir,
// T3 fixture database, git repos, and fake codex binary.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugins', 'flow')
const STORE = join(PLUGIN, 'lib', 'seat-store.mjs')
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-smoke-seat-')))
const state = join(tmp, 'state')
process.env.FLOW_DELEGATION_STATE_DIR = state
// close reads T3's store from T3CODE_HOME, and a session inside T3 carries the live home and its own
// thread id, so every process this smoke spawns reads the fixture store below and names no closer
// thread unless a case gives one.
const t3Home = join(tmp, 't3')
process.env.T3CODE_HOME = t3Home
delete process.env.T3CODE_THREAD_ID
const store = await import(pathToFileURL(STORE).href)
const wire = await import(pathToFileURL(join(PLUGIN, 'hooks', 'scripts', 'wire.mjs')).href)
const seatPolicy = await import(pathToFileURL(join(PLUGIN, 'lib', 'seat-policy.mjs')).href)
const { RETENTION_MS } = await import(pathToFileURL(join(PLUGIN, 'lib', 'state-dir.mjs')).href)
const schemas = await import(pathToFileURL(join(PLUGIN, 'delegate', 'schema.mjs')).href)

let checks = 0
const ok = (line) => { checks++; console.log(`  ok: ${line}`) }
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const mode = (path) => statSync(path).mode & 0o777
const seats = join(state, 'seats')
// T3's default provider instance for each host family, as seat open records it.
const INSTANCE = { claude: 'claudeAgent', codex: 'codex' }
// A record as seat open writes it. providerInstanceId follows the provider and expectedServedModel
// the model unless a case names them, so a Codex fixture is never cross-wired; a case about a
// record that lacks one deletes it.
const RECORD = (fields = {}) => {
  const record = {
    v: 1, createdAt: new Date().toISOString(), access: 'read-only', repoRoot: '/r', worktree: '/r', reviewWorktree: null,
    baseSha: null, headSha: null, provider: 'claude', model: 'claude-opus-5-5', effort: 'high', runtimeMode: 'auto',
    canonicalSnapshot: null, hooksDigest: null, ...fields,
  }
  return { providerInstanceId: INSTANCE[record.provider], expectedServedModel: record.model, ...record }
}
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
  target: { providerInstanceId: record.providerInstanceId, model: record.model, options: [{ id: EFFORT_OPTION[record.provider], value: record.effort }] }, mode: 'async', ...fields,
})
const seatRecord = (provider, fields = {}) => RECORD({ provider, model: MODELS[provider], ...fields })
// The admitted stamp the parent's gate writes, straight through the store: it pins the digest of
// the record as it is now, which the bind and close compare with the record's bytes.
const admit = (id, fields = {}) => store.stamp(id, 'admitted', { toolUseId: 'toolu_parent', clientRequestId: `flow-seat-${id}`, recordDigest: store.readRecord(id).digest, ...fields })
// A record the parent has opened and its gate has admitted, ready for the child to bind.
function admittedSeat(provider, fields = {}) {
  const record = seatRecord(provider, fields)
  const { id, digest } = store.writeRecord(record, SCHEMA)
  assert.equal(admit(id), true)
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
// input, a string or a Buffer, goes to its stdin; a run past timeout ms is killed and fails.
function seatCli(args, { cwd = canon, env = {}, script = SEAT_SCRIPT, input = undefined, nodeArgs = [], timeout = 0 } = {}) {
  const run = spawnSync(process.execPath, [...nodeArgs, script, ...args], { cwd, input, timeout, encoding: 'utf8', maxBuffer: 1 << 24, env: { ...process.env, ...trustedCodex.env, ...env } })
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
// command carrying the plugin root already expanded. The state's onList maps n to what the n-th
// hooks/list in that state directory does first, across processes: append [path, text] appends
// text to a file, and hooks answers with those entries in place of the state's.
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
  if (message.method === 'hooks/list') {
    appendFileSync(dir + '/lists', '.')
    const step = (state().onList ?? {})[readFileSync(dir + '/lists', 'utf8').length] ?? {}
    if (step.append) appendFileSync(step.append[0], step.append[1])
    return reply(message.id, { result: { data: [{ cwd: message.params.cwds[0], hooks: step.hooks ?? state().hooks, errors: [], warnings: [] }] } })
  }
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
// The digest open records for a Codex plugin root, computed here apart from seat.mjs, for a root of
// regular files and directories only: the sha256 of the JSON of every entry's [path, 'dir', null]
// or [path, 'file', sha256], the path relative to the root with '/' (the root itself ''), sorted
// by code unit.
function treeDigest(root) {
  const entries = [['', 'dir', null]]
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        entries.push([path, 'dir', null])
        walk(join(dir, entry.name), path)
      } else entries.push([path, 'file', sha256(readFileSync(join(dir, entry.name)))])
    }
  }
  walk(root, '')
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return sha256(JSON.stringify(entries))
}
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
function codexState(hooks, { ignoreWrites = false, onList = {} } = {}) {
  const dir = mkdtempSync(join(tmp, 'codex-state-'))
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks, ignoreWrites, onList }))
  return { dir, env: { PATH: `${fakeCodexBin}:${process.env.PATH}`, FAKE_CODEX_STATE: dir } }
}
const codexSent = (dir) => (existsSync(join(dir, 'sent.jsonl')) ? readFileSync(join(dir, 'sent.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
const codexHooks = (dir) => JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')).hooks
const flowDigest = (entries) => sha256(JSON.stringify(entries.map(({ key, currentHash }) => [key, currentHash]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
// Every open in the executor cases sees a Codex that trusts all of flow's hooks, unless a case
// names another state.
const trustedCodex = codexState([...flowEntries({ trusted: true }), ...FOREIGN])

// T3's store as close reads it: one fixture at <T3CODE_HOME>/userdata/statev2.sqlite, in WAL mode,
// with T3 0.1.6's own column lists at migration 76 for the tables close reads and for turn_items,
// which close must not read. This process writes it through one connection for the whole run, and
// every case's rows carry its seat's random id, so the cases stay apart. A case about a missing,
// changed or locked store makes a home of its own with t3Store.
const T3_TABLES = {
  orchestration_v2_projection_subagents: ['subagent_id TEXT PRIMARY KEY', 'thread_id TEXT NOT NULL', 'run_id TEXT', 'parent_node_id TEXT NOT NULL', 'provider TEXT NOT NULL',
    'provider_thread_id TEXT', 'child_thread_id TEXT', 'origin TEXT NOT NULL', 'status TEXT NOT NULL', 'started_at TEXT', 'completed_at TEXT', 'updated_at TEXT NOT NULL',
    'payload_json TEXT NOT NULL', 'driver TEXT', 'provider_instance_id TEXT', 'completion_delivery_state TEXT'],
  orchestration_v2_projection_runs: ['run_id TEXT PRIMARY KEY', 'thread_id TEXT NOT NULL', 'ordinal INTEGER NOT NULL', 'provider TEXT NOT NULL', 'provider_thread_id TEXT',
    'status TEXT NOT NULL', 'requested_at TEXT NOT NULL', 'completed_at TEXT', 'payload_json TEXT NOT NULL', 'provider_instance_id TEXT'],
  orchestration_v2_projection_messages: ['message_id TEXT PRIMARY KEY', 'thread_id TEXT NOT NULL', 'run_id TEXT', 'node_id TEXT', 'role TEXT NOT NULL', 'streaming INTEGER NOT NULL',
    'created_at TEXT NOT NULL', 'updated_at TEXT NOT NULL', 'payload_json TEXT NOT NULL'],
  orchestration_v2_projection_turn_items: ['turn_item_id TEXT PRIMARY KEY', 'thread_id TEXT NOT NULL', 'run_id TEXT', 'node_id TEXT', 'provider_thread_id TEXT', 'provider_turn_id TEXT',
    'parent_item_id TEXT', 'ordinal INTEGER NOT NULL', 'type TEXT NOT NULL', 'status TEXT NOT NULL', 'updated_at TEXT NOT NULL', 'payload_json TEXT NOT NULL'],
  effect_sql_migrations: ['migration_id integer PRIMARY KEY NOT NULL', 'created_at datetime NOT NULL DEFAULT current_timestamp', 'name VARCHAR(255) NOT NULL'],
}
const T3_INDEXES = [
  ['orchestration_v2_projection_subagents_child_thread_idx', 'orchestration_v2_projection_subagents', ['child_thread_id'], false],
  ['orchestration_v2_projection_runs_thread_ordinal_idx', 'orchestration_v2_projection_runs', ['thread_id', 'ordinal'], true],
  ['orchestration_v2_projection_messages_run_idx', 'orchestration_v2_projection_messages', ['run_id'], false],
]
// A T3 store under home, open for writing; without names the tables (`<table>`) and columns
// (`<table>.<column>`) it leaves out, with every index on them.
function t3Store(home, { without = [] } = {}) {
  mkdirSync(join(home, 'userdata'), { recursive: true })
  const db = new DatabaseSync(join(home, 'userdata', 'statev2.sqlite'))
  db.exec('pragma journal_mode = wal')
  const gone = (table, column) => without.includes(table) || without.includes(`${table}.${column}`)
  for (const [table, columns] of Object.entries(T3_TABLES)) {
    if (!without.includes(table)) db.exec(`CREATE TABLE ${table} (${columns.filter((column) => !gone(table, column.split(' ')[0])).join(', ')})`)
  }
  for (const [name, table, columns, unique] of T3_INDEXES) {
    if (!columns.some((column) => gone(table, column))) db.exec(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${table}(${columns.join(', ')})`)
  }
  if (!without.includes('effect_sql_migrations')) {
    for (const migration of [1, 76]) db.prepare('insert into effect_sql_migrations (migration_id, name) values (?, ?)').run(migration, `fixture_${migration}`)
  }
  return db
}
const t3 = t3Store(t3Home)
// The parent's MCP session and thread T3 names a seat's task after, and T3's 24-character times,
// one second apart in the order a case asks for them.
const T3_SESSION = '0b6c2f1e-7200-4f3f-b16b-3d1e5a9c8f20'
const T3_OWNER = '82505559-ef73-46d2-b19d-63c28130dee3'
let t3Clock = 0
const t3Time = () => new Date(Date.UTC(2026, 10, 4, 12) + ++t3Clock * 1000).toISOString()
const taskIdOf = (id, session = T3_SESSION) => `node:delegated-task:command%3Amcp%3A${session}%3Adelegate-task%3Aflow-seat-${id}`
const childThreadOf = (id, session = T3_SESSION) => `thread:delegated-task:command%3Amcp%3A${session}%3Adelegate-task%3Aflow-seat-${id}`
// T3 builds each run id from the child thread id, URL-encoded once more (so its `%` reads `%25`),
// and the run's ordinal.
const runIdOf = (thread, ordinal) => `run:thread:${encodeURIComponent(thread)}:ordinal:${ordinal}`
// One row as T3 writes it, with only what a case varies as options. A task row's owner is the
// thread that made the call, and a nested task's owner is the child thread it runs under. Its
// prompt is the seat call's, the seat tag alone on line 1, unless payload names another.
function t3TaskRow(id, { db = t3, session = T3_SESSION, taskId = taskIdOf(id, session), owner = T3_OWNER, child = childThreadOf(id, session), status = 'completed', payload = {} } = {}) {
  db.prepare('insert into orchestration_v2_projection_subagents (subagent_id, thread_id, run_id, parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json, driver, provider_instance_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(taskId, owner, `run:thread:${owner}:ordinal:1`, `node:run:${owner}:root`, 'claudeAgent', child, 'app_owned', status, t3Time(), JSON.stringify({ id: taskId, threadId: owner, childThreadId: child, status, prompt: `${store.seatTag(id)}\nReview the diff.`, ...payload }), 'claudeAgent', 'claudeAgent')
  return taskId
}
function t3RunRow(thread, ordinal, { db = t3, status = 'completed', startedAt = t3Time(), runId = runIdOf(thread, ordinal), payloadJson = null } = {}) {
  const payload = { id: runId, threadId: thread, ordinal, status, ...(startedAt === null ? {} : { startedAt }) }
  db.prepare('insert into orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) values (?, ?, ?, ?, ?, ?, ?)')
    .run(runId, thread, ordinal, 'claudeAgent', status, t3Time(), payloadJson ?? JSON.stringify(payload))
  return runId
}
function t3MessageRow(thread, runId, text, { db = t3, role = 'assistant', at = t3Time(), updatedAt = at, messageId = `claudeAgent:native-item:${randomUUID()}`, payloadJson = null } = {}) {
  db.prepare('insert into orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json) values (?, ?, ?, ?, 0, ?, ?, ?)')
    .run(messageId, thread, runId, role, at, updatedAt, payloadJson ?? JSON.stringify({ id: messageId, threadId: thread, runId, role, text }))
}
// Every row that names the seat id, task rows of any grammar and its nested tasks included.
function t3Forget(id, db = t3) {
  db.prepare('delete from orchestration_v2_projection_subagents where instr(subagent_id, ?) > 0 or instr(thread_id, ?) > 0').run(id, id)
  for (const table of ['runs', 'messages', 'turn_items']) db.prepare(`delete from orchestration_v2_projection_${table} where instr(thread_id, ?) > 0`).run(id)
}
// A seat's task as T3 records it, in place of the seat's rows: the task row (task's options), then
// runs 1, 2, ... each {status, startedAt, texts}, every text an assistant message of that run in
// order, and a nested task under the child thread for each status in nested. {taskId, thread}.
function t3Seat(id, runs = [{ texts: [MESSAGE_OK] }], { db = t3, nested = [], ...task } = {}) {
  t3Forget(id, db)
  const thread = childThreadOf(id, task.session)
  const taskId = t3TaskRow(id, { db, ...task })
  runs.forEach(({ texts = [], ...run }, at) => {
    const runId = t3RunRow(thread, at + 1, { db, ...run })
    for (const text of texts) t3MessageRow(thread, runId, text, { db })
  })
  for (const status of nested) {
    t3TaskRow(id, { db, taskId: `node:delegated-task:command%3Amcp%3A${randomUUID()}%3Adelegate-task%3Anested-${id}`, owner: thread, child: `thread:nested-${randomUUID()}`, status })
  }
  return { taskId, thread }
}

// A finished task as the fields of T3's task_status answer: by default the task ran once and that
// run completed with MESSAGE_OK as its final message, which is the summary. A case's fields replace
// these as given: nothing here makes a summary match the seat.
const MESSAGE_OK = JSON.stringify(ENVELOPE_OK)
const taskStatusOf = (id, fields = {}) => ({
  status: 'completed', latestTerminalRunId: runIdOf(childThreadOf(id), 1), latestTerminalStatus: 'completed', latestTerminalSummary: null, summary: MESSAGE_OK, ...fields,
})
// The store holding what a task status describes, in place of the seat's rows: the task row with
// its status, and runs 1 to n, n the ordinal of latestTerminalRunId, each started, run n ending
// latestTerminalStatus and the others completed. Run 1's final message is summary and run n's
// latestTerminalSummary ?? summary, as T3 0.1.6 nulls latestTerminalSummary when it repeats the
// summary; a null text writes no message.
function t3Status(id, status = taskStatusOf(id)) {
  const last = Number(/:ordinal:([0-9]+)$/.exec(status.latestTerminalRunId)[1])
  const texts = (text) => (text === null || text === undefined ? [] : [text])
  const runs = Array.from({ length: last }, (_, at) => ({ status: at === last - 1 ? status.latestTerminalStatus : 'completed', texts: [] }))
  runs[0].texts = texts(status.summary)
  if (last > 1) runs[last - 1].texts = texts(status.latestTerminalSummary ?? status.summary)
  return t3Seat(id, runs, { status: status.status })
}
// close as the delegate skill tells a parent to run it, the seat id alone, against the store
// holding the task status's rows.
function closeSeat(id, status = taskStatusOf(id), options = {}) {
  t3Status(id, status)
  return seatCli(['close', id], options)
}
// The task block close stamps for a seat whose one run completed with text as its final message.
const oneRunTask = (id, text, fields = {}) => {
  const thread = childThreadOf(id)
  return {
    taskId: taskIdOf(id), ownerThreadId: T3_OWNER, childThreadId: thread, status: 'completed', childRunId: runIdOf(thread, 1), latestRunId: runIdOf(thread, 1),
    latestRunStatus: 'completed', latestTextSha256: sha256(text), closerThreadId: null, t3Migration: 76, ...fields,
  }
}

// A writer seat open made in a worktree of its own, with turn 1 recorded valid through the store:
// hookedSeat's {id, message} and the path of its live lease holder.
function writerSeat(name, fields = {}) {
  const at = gitWorktree(name)
  const opened = seatCli(['open', '--access', 'workspace-write', '--provider', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--worktree', at])
  assert.equal(opened.ok, true, JSON.stringify(opened))
  return { ...hookedSeat({ id: opened.id, ...fields }), holder: join(jobs.leaseDirOf(at), `${opened.id}.live`) }
}
// Every file in a seat's record directory, by sha256.
const recordFiles = (id) => Object.fromEntries(readdirSync(join(seats, id)).sort().map((name) => [name, sha256(readFileSync(join(seats, id, name)))]))
// A close of seat that must refuse kind: it changes no file of the record, stamps nothing, keeps
// kept (the writer's holder or the review worktree), and its message names no path in this run's
// temp directory and no SQLite text. Returns the error.
function refusedClose(seat, kind, what, { kept = seat.holder, options = {} } = {}) {
  const before = recordFiles(seat.id)
  const refused = seatCli(['close', seat.id], options)
  assert.equal(refused.error?.kind, kind, `${what}: ${JSON.stringify(refused)}`)
  assert.deepEqual(recordFiles(seat.id), before, `${what} changed the record directory`)
  assert.equal(store.readStamp(seat.id, 'closed'), null, `${what} stamped the seat closed`)
  if (kept) assert.ok(existsSync(kept), `${what} released ${kept}`)
  assert.ok(!refused.error.message.includes(tmp) && !/database is locked|not a database|unable to open|no such/i.test(refused.error.message), `${what} leaked: ${refused.error.message}`)
  return refused.error
}

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
// with the record fields given unless id names one seat open wrote), the stamps listed, the
// admitted stamp pinning admittedDigest and the bound stamp digest (each the record's own by
// default), the bound session's index entry naming the seat (index 'own'; 'none' writes none),
// and turn 1 ending as outcome with models as the models seen serving it, the record's expected
// served model by default, with a result for a valid turn unless result is false. The turn's final
// message is message, the envelope as JSON by default, and its sha256 goes into the turn state and
// the result as Stop writes it; the returned message is what a task status's summary would carry.
function hookedSeat({ id = null, provider = 'claude', model = MODELS[provider], record = {}, stamps = ['admitted', 'bound', 'receipt'], digest = null, admittedDigest = null,
  boundModel = null, outcome = 'valid', blocks = 0, errors = [], served = [record.expectedServedModel ?? model], models = served, envelope = ENVELOPE_OK, result = true,
  index = 'own', message = JSON.stringify(envelope) } = {}) {
  const seatId = id ?? store.writeRecord(RECORD({ provider, model, worktree: canon, repoRoot: canon, ...record }), null).id
  const loaded = store.readRecord(seatId)
  const bound = { sessionId: `s-${seatId}`, host: provider, permissionMode: PERMISSION[provider], cwd: canon, recordDigest: digest ?? loaded.digest }
  if (boundModel) bound.model = boundModel
  const admitted = { toolUseId: 'toolu_x', clientRequestId: `flow-seat-${seatId}`, recordDigest: admittedDigest ?? loaded.digest }
  const bodies = { admitted, bound, receipt: { tool: 'Bash' } }
  for (const name of stamps) assert.equal(store.stamp(seatId, name, bodies[name]), true)
  if (index === 'own') assert.equal(store.indexSession(provider, bound.sessionId, { id: seatId }), true)
  if (outcome !== null) {
    const messageSha256 = sha256(message)
    store.writeState(seatId, { turn: 1, turnKey: 'k1', blocks, outcome, errors, stops: blocks + 1, messageSha256, models })
    if (outcome === 'valid' && result) store.writeResult(seatId, 1, { envelope, servedModels: served, messageSha256, at: new Date().toISOString() })
  }
  return { id: seatId, message }
}
// A Codex seat run through the real hooks, so its turn state holds the bytes the hooks write: the
// bind prompt opens turn 1, a tool call stamps the receipt, and a stop with message (none when it
// is null) ends the turn. stop(message, key) is another stop in the turn key names; followUp() is
// the parent's next message, a prompt that opens a turn, and returns that turn's key. With id, it
// admits the record seat open wrote rather than writing one.
function guardedSeat(message = MESSAGE_OK, { id = null } = {}) {
  const host = 'codex'
  const seat = id === null ? admittedSeat(host) : (assert.equal(admit(id), true), { id, tag: store.seatTag(id) })
  const session = randomUUID()
  const first = randomUUID()
  context(guard('prompt', host, promptCall(host, session, seat.tag, { turn_id: first })), 'bind')
  silent(guard('pre', host, preCall(host, session, 'Bash', { command: 'ls' }, { turn_id: first })), 'receipt')
  const stop = (text, key) => guard('stop', host, stopCall(host, session, text, key))
  if (message !== null) silent(stop(message, first), 'turn 1 stop')
  const followUp = () => {
    const key = randomUUID()
    silent(guard('prompt', host, promptCall(host, session, 'Look again at b.txt and answer again.', { turn_id: key })), 'follow-up prompt')
    return key
  }
  return { id: seat.id, session, first, stop, followUp }
}
// A final message that passes, other than MESSAGE_OK.
const messageWith = (notes) => JSON.stringify({ ...ENVELOPE_OK, notes })
// A read-only Codex seat that seat open made against a Codex install of its own, under name, which
// holds a README and a script beside the hooks file: {id, root, message}. With hooks false it has
// turn 1 recorded valid through the store; with hooks true the caller runs it through the hooks.
function rootedCodexSeat(name, { hooks = false } = {}) {
  const root = installedRoot(name)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'README.md'), 'flow\n')
  writeFileSync(join(root, 'scripts', 'seat.mjs'), '// seat\n')
  const opened = seatCli(['open', '--access', 'read-only', '--provider', 'codex', '--model', MODELS.codex, '--effort', 'high'], { env: codexState(flowEntries({ trusted: true, root })).env })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  assert.deepEqual([store.readRecord(opened.id).record.codexPluginRoot, store.readRecord(opened.id).record.codexPluginDigest], [root, treeDigest(root)])
  return { ...(hooks ? { id: opened.id, message: MESSAGE_OK } : hookedSeat({ id: opened.id, provider: 'codex' })), root }
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
// linked into place; with STAMP_GATE_AT=reread it holds close at its second look at T3's store,
// after it judged the seat and before it reads the task again. Each writes <STAMP_GATE>.waiting
// and waits for <STAMP_GATE>.go.
const stampGate = join(tmp, 'stamp-gate.mjs')
writeFileSync(stampGate, `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const realWrite = fs.writeFileSync
const realLink = fs.linkSync
const realStat = fs.statSync
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
} else if (process.env.STAMP_GATE_AT === 'reread') {
  let looks = 0
  fs.statSync = function (path, ...rest) {
    if (typeof path === 'string' && path.endsWith('/userdata/statev2.sqlite') && ++looks === 2) hold()
    return realStat.call(this, path, ...rest)
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
// Preloaded into seat.mjs close, test-only: when the readdir of SCAN_ROOT that starts its second
// scan of the root comes, it first appends a byte to SCAN_ROOT/README.md, so the first scan sees the
// tree open recorded and the second sees another.
const scanGate = join(tmp, 'scan-gate.mjs')
writeFileSync(scanGate, `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const real = fs.readdirSync
let scans = 0
fs.readdirSync = function (path, ...rest) {
  if (path === process.env.SCAN_ROOT && ++scans === 2) fs.appendFileSync(process.env.SCAN_ROOT + '/README.md', 'x')
  return real.call(this, path, ...rest)
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
export { assert, spawn, spawnSync, createHash, randomUUID, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, createServer, performance, DatabaseSync, tmpdir, dirname, join, fileURLToPath, pathToFileURL, PLUGIN, STORE, tmp, state, t3Home, store, wire, seatPolicy, RETENTION_MS, schemas, ok, sha256, mode, seats, INSTANCE, RECORD, SCHEMA, ENVELOPE_OK, racer, race, GUARD, guard, silent, denied, blocked, context, stopBlocked, MODELS, PERMISSION, SPELLING, call, stopCall, promptCall, preCall, EFFORT_OPTION, delegateInput, seatRecord, admit, admittedSeat, worktree, ACCESSES, boundSeat, seatCall, editCalls, indexEntries, SEAT_SCRIPT, jobs, seatCli, fakeCodexBin, OWN_HOOKS, installedRoot, FAKE_ROOT, treeDigest, DRIFTED_ROOT, snake, flowEntries, FOREIGN, codexState, codexSent, codexHooks, flowDigest, trustedCodex, T3_TABLES, T3_INDEXES, t3Store, t3, T3_SESSION, T3_OWNER, t3Time, taskIdOf, childThreadOf, runIdOf, t3TaskRow, t3RunRow, t3MessageRow, t3Forget, t3Seat, MESSAGE_OK, taskStatusOf, t3Status, closeSeat, oneRunTask, writerSeat, recordFiles, refusedClose, gitEnv, gitOut, canon, baseSha, headSha, linkedWt, gitWorktree, jobRecord, hookedSeat, guardedSeat, messageWith, rootedCodexSeat, holderGate, jobGate, stampGate, scanGate, heldChildren, heldAt, waitFor, leaseRacer, leaseRace }

export async function runSection(sectionName, cases) {
  const argv = process.argv.slice(2)
  const prefixAt = argv.indexOf('--case-prefix')
  const prefix = prefixAt >= 0 ? argv[prefixAt + 1] ?? '' : ''
  const selected = Object.keys(cases).filter((name) => name.startsWith(prefix))
  try {
    for (const name of selected) {
      console.log(name)
      await cases[name]()
    }
  } finally {
    for (const child of heldChildren) child.kill('SIGKILL')
    t3.close()
    rmSync(tmp, { recursive: true, force: true })
  }
  console.log(`__SECTION_SUMMARY__ ${JSON.stringify({ section: sectionName, checks, cases: selected.length })}`)
}
