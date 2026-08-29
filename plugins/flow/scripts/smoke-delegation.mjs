#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { AppServerClient } from '../src/delegation/app-server.mjs'
import { captureProcessDescendants, providerScopeName, providerScopeRunning, scopedProviderCommand, signalProviderScope } from '../src/delegation/containment.mjs'
import { JobStore, processStartToken } from '../src/delegation/store.mjs'
import { assertRoute, capabilitiesForHost, HOST_CAPABILITIES_SCHEMA_VERSION, HOST_CAPABILITY_ASSURANCES } from '../src/delegation/contracts.mjs'

assert.equal(process.platform, 'linux', 'smoke-delegation requires the Linux Codex host and systemd-scope contract')

// deps/node_modules is gitignored, so a clone and every installed copy of the plugin lack
// the MCP SDK. This client speaks the stdio transport directly instead: newline-delimited
// JSON-RPC 2.0 on the server's stdin and stdout. It covers only what the smoke drives -
// initialize, tools/list, tools/call with progress, and a roots/list answer.
const PROTOCOL_VERSION = '2025-06-18'

class McpStdioClient {
  constructor({ command, args, cwd, env, roots }) {
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.roots = roots
    this.child = null
    this.exited = null
    this.pending = new Map()
    this.progress = new Map()
    this.buffer = ''
    this.stderr = ''
    this.nextId = 1
    this.nextToken = 1
  }

  async start() {
    this.child = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.receive(chunk))
    // Drain stderr so a chatty server cannot fill the pipe and stall, and keep the tail
    // for the failure message when the server dies mid-request.
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000) })
    this.exited = new Promise((resolve) => this.child.on('exit', (code, signal) => {
      const reason = new Error(`MCP server exited early (code ${code}, signal ${signal})\n${this.stderr}`)
      for (const entry of this.pending.values()) entry.fail(reason)
      this.pending.clear()
      resolve()
    }))
    this.child.on('error', (error) => {
      for (const entry of this.pending.values()) entry.fail(error)
      this.pending.clear()
    })

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: 'flow-smoke', version: '1.0.0' },
    })
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
  }

  send(message) {
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  receive(chunk) {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.dispatch(JSON.parse(line))
      newline = this.buffer.indexOf('\n')
    }
  }

  dispatch(message) {
    if (message.method && message.id !== undefined) return this.answer(message)
    if (message.method) return this.notified(message)
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    if (message.error) entry.fail(new Error(`${entry.method} failed: ${message.error.code} ${message.error.message}`))
    else entry.succeed(message.result)
  }

  answer(message) {
    if (message.method === 'roots/list') {
      this.send({ jsonrpc: '2.0', id: message.id, result: { roots: this.roots } })
    } else if (message.method === 'ping') {
      this.send({ jsonrpc: '2.0', id: message.id, result: {} })
    } else {
      this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unhandled request ${message.method}` } })
    }
  }

  notified(message) {
    if (message.method !== 'notifications/progress') return
    const entry = this.progress.get(message.params?.progressToken)
    if (!entry) return
    entry.onprogress(message.params)
    entry.extend()
  }

  request(method, params, { timeout = 60_000, onprogress = null } = {}) {
    const id = this.nextId++
    const body = { ...params }
    let token = null
    if (onprogress) {
      token = `progress-${this.nextToken++}`
      body._meta = { ...body._meta, progressToken: token }
    }
    return new Promise((resolve, reject) => {
      let timer = null
      const clear = () => {
        if (timer) clearTimeout(timer)
        if (token !== null) this.progress.delete(token)
      }
      const arm = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          this.pending.delete(id)
          clear()
          reject(new Error(`${method} timed out after ${timeout}ms\n${this.stderr}`))
        }, timeout)
      }
      this.pending.set(id, {
        method,
        succeed: (result) => { clear(); resolve(result) },
        fail: (error) => { clear(); reject(error) },
      })
      if (token !== null) this.progress.set(token, { onprogress, extend: arm })
      arm()
      this.send({ jsonrpc: '2.0', id, method, params: body })
    })
  }

  listTools() {
    return this.request('tools/list', {})
  }

  callTool(name, args, options = {}) {
    return this.request('tools/call', { name, arguments: args }, options)
  }

  async close() {
    if (!this.child) return
    this.child.stdin.end()
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 5_000)
    await this.exited
    clearTimeout(kill)
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(root, 'dist', 'delegation.mjs')
const temp = mkdtempSync(join(tmpdir(), 'flow-delegation-smoke-'))
const repo = join(temp, 'repo')
const nestedDir = join(repo, 'nested')
const fake = join(temp, 'fake-codex.mjs')
const opener = join(temp, 'open-store.mjs')

// The migration race is a cross-process one: several Node processes opening the same fresh
// database, not several promises inside one. Node startup jitter alone spreads the children
// far enough apart to miss the collision, so each one spins until a shared wall-clock start
// before it opens the store. Then it exits, and a nonzero code is a failed migration.
writeFileSync(opener, `import { JobStore } from ${JSON.stringify(pathToFileURL(join(root, 'src', 'delegation', 'store.mjs')).href)}
const startAt = Number(process.argv[3])
while (Date.now() < startAt) {}
new JobStore(process.argv[2]).close()
`)

writeFileSync(fake, `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
if (process.argv[2] === '--version') { console.log('codex-cli 0.150.1'); process.exit(0) }
const mode = process.env.FLOW_FAKE_MODE || 'happy'
// Real Codex re-execs its own binary inside the sandbox namespace, so the profile must
// grant the provider executable; the fake stands in for that binary here.
let selfPath = process.argv[1]
try { selfPath = realpathSync(selfPath) } catch {}
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let active = null
let threadConfig = null
let experimentalApi = false
let done = false
let timer = null
const finish = (status = 'completed', output = null) => {
  if (done || !active) return
  done = true
  if (timer) clearTimeout(timer)
  const text = output ?? (mode === 'bad-schema'
    ? JSON.stringify({ wrong: 1 })
    : mode === 'good-schema'
      ? JSON.stringify({ answer: 'yes' })
    : mode === 'review'
      ? JSON.stringify({ findings: [{ severity: 'high', confidence: 95, title: 'Race', file: 'a.txt', line: 1, detail: 'The write is not synchronized.', systemic: false }] })
      : 'OK from fake Codex')
  if (status === 'completed') {
    say({ method: 'item/agentMessage/delta', params: { threadId: active.threadId, turnId: active.turnId, itemId: 'item-1', delta: text } })
    say({ method: 'item/completed', params: { threadId: active.threadId, turnId: active.turnId, completedAtMs: Date.now(), item: { type: 'agentMessage', id: 'item-1', text, phase: null, memoryCitation: null, delivery: null } } })
  }
  say({ method: 'thread/tokenUsage/updated', params: { threadId: active.threadId, turnId: active.turnId, tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 16 }, last: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 16 }, modelContextWindow: 1000 } } })
  say({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, items: status === 'completed' ? [{ type: 'agentMessage', id: 'item-1', text, phase: null, memoryCitation: null, delivery: null }] : [], itemsView: { type: 'full' }, status, error: null, startedAt: 1, completedAt: 2, durationMs: 10 } } })
}
// The turn thread/read reports for a stale job. Each recovery-* mode is one branch of the
// fold: still running, interrupted, completed with nothing to show, and a status this Codex
// version never had.
const recoveredTurn = () => {
  const status = mode === 'recovery-in-progress' ? 'inProgress'
    : mode === 'recovery-interrupted' ? 'interrupted'
    : mode === 'recovery-odd' ? 'somethingNew'
    : 'completed'
  const items = status === 'completed' && mode !== 'recovery-empty'
    ? [{ type: 'agentMessage', id: 'i', text: 'RECOVERED', phase: null, memoryCitation: null, delivery: null }]
    : []
  const ended = status !== 'inProgress'
  return { id: 'recovered', items, itemsView: { type: 'full' }, status, error: null, startedAt: 1, completedAt: ended ? 2 : null, durationMs: ended ? 1 : null }
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  const answer = (result) => say({ id: message.id, result })
  if (message.id === 900 && !message.method) finish('failed', '')
  else if (message.id === 902 && !message.method) {
    if (message.result?.permissions && Object.keys(message.result.permissions).length === 0) finish('failed', '')
    else process.exit(18)
  }
  else if (message.method === 'initialize') {
    experimentalApi = message.params.capabilities?.experimentalApi === true
    if (mode === 'initialize-error') say({ id: message.id, error: { code: -32603, message: 'initialization failed' } })
    else answer({ userAgent: 'fake' })
  }
  else if (message.method === 'initialized') {
    if (mode === 'malformed-protocol') process.stdout.write('not-json\\n')
    if (mode === 'stdin-closed') {
      process.stdin.destroy()
      say({ method: 'fake/stdinClosed', params: {} })
      setTimeout(() => process.exit(0), 1000)
    }
  }
  else if (message.method === 'mcpServerStatus/list') {
    const inventory = message.params.threadId
      ? (mode !== 'mcp-leak'
          && threadConfig?.['features.plugins'] === false
          && threadConfig?.['features.apps'] === false
          && threadConfig?.mcp_servers?.standalone?.enabled === false
        ? [{ name: 'standalone', pluginId: null, tools: {}, runtimeStatus: 'disabled', authStatus: 'unsupported', resources: [], resourceTemplates: [] }]
        : [{ name: 'leaked', pluginId: null, tools: { mutate: {} }, runtimeStatus: 'connected', authStatus: 'unsupported', resources: [], resourceTemplates: [] }])
      : [
          { name: 'flow_delegate', pluginId: 'flow@jakub', tools: { delegation_status: {} }, runtimeStatus: null, authStatus: 'unsupported', resources: [], resourceTemplates: [] },
          { name: 'codex_apps', pluginId: null, tools: { 'sites.delete_site': {} }, runtimeStatus: null, authStatus: 'unsupported', resources: [], resourceTemplates: [] },
          { name: 'standalone', pluginId: null, tools: { mutate: {} }, runtimeStatus: null, authStatus: 'unsupported', resources: [], resourceTemplates: [] },
        ]
    answer({ data: inventory, nextCursor: null })
  }
  else if (message.method === 'permissionProfile/list') {
    if (!experimentalApi) say({ id: message.id, error: { code: -32602, message: 'experimental API disabled' } })
    else answer({ data: [{ id: ':read-only', description: 'read', allowed: true }], nextCursor: null })
  }
  else if (message.method === 'thread/start') {
    threadConfig = message.params.config
    const doctorProbe = message.params.serviceName === 'flow-delegation-doctor'
    const expectedAccess = doctorProbe ? 'read' : process.env.FLOW_DELEGATION_ACCESS === 'workspace-write' ? 'write' : 'read'
    const workspaceKey = doctorProbe ? process.cwd() : process.env.FLOW_DELEGATION_WORKSPACE_KEY
    const filesystem = threadConfig?.permissions?.flow_delegation?.filesystem
    if (mode === 'provider-error') {
      say({ id: message.id, error: { code: -32603, message: 'account test@example.invalid failed at /home/test/private/provider.json' } })
    } else if (!experimentalApi
      || message.params.permissions !== 'flow_delegation'
      || message.params.sandbox !== undefined
      || filesystem?.[':minimal'] !== 'read'
      || filesystem?.['/'] !== undefined
      || filesystem?.[':root'] !== undefined
      || filesystem?.[workspaceKey] !== expectedAccess
      || (!doctorProbe && filesystem?.[process.env.TMPDIR] !== 'write')
      || (expectedAccess === 'write' && filesystem?.[workspaceKey + '/.git'] !== 'read')
      || filesystem?.[selfPath] !== 'read'
      || threadConfig?.permissions?.flow_delegation?.network?.enabled !== false
      || (!doctorProbe && !message.params.developerInstructions?.includes('<flow-charter>'))
      || (!doctorProbe && !message.params.developerInstructions?.includes('Do not start subagents'))) {
      say({ id: message.id, error: { code: -32602, message: 'missing restricted Flow delegation profile' } })
    } else if (mode === 'profile' && !message.params.developerInstructions.includes('authorized defensive research')) {
      say({ id: message.id, error: { code: -32602, message: 'missing defensive profile' } })
    } else answer({ thread: { id: 'thread-test' }, activePermissionProfile: { id: 'flow_delegation', extends: null } })
  }
  else if (message.method === 'thread/resume') {
    threadConfig = message.params.config
    if (message.params.permissions !== 'flow_delegation' || message.params.sandbox !== undefined) {
      say({ id: message.id, error: { code: -32602, message: 'resume lost restricted Flow delegation profile' } })
    } else answer({ thread: { id: message.params.threadId }, activePermissionProfile: { id: 'flow_delegation', extends: null } })
  }
  else if (message.method === 'turn/start') {
    if (message.params.permissions !== undefined || message.params.sandboxPolicy !== undefined) {
      say({ id: message.id, error: { code: -32602, message: 'turn replaced sticky permissions' } })
      return
    }
    done = false
    active = { threadId: message.params.threadId, turnId: 'turn-' + Date.now() }
    if (mode === 'accepted-crash') {
      say({ method: 'turn/started', params: { threadId: active.threadId, turn: { id: active.turnId, items: [], itemsView: { type: 'full' }, status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null } } })
      setTimeout(() => process.exit(17), 20)
      return
    }
    answer({ turn: { id: active.turnId, items: [], itemsView: { type: 'full' }, status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null } })
    say({ method: 'turn/started', params: { threadId: active.threadId, turn: { id: active.turnId, items: [], itemsView: { type: 'full' }, status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null } } })
    if (mode === 'midturn-crash') {
      setTimeout(() => process.exit(19), 20)
      return
    }
    if (mode === 'detached-command') {
      const writer = "setTimeout(() => require('node:fs').writeFileSync('codex-detached-survivor', 'bad'), 1000)"
      const daemon = "require('node:child_process').spawn(process.execPath, ['-e', " + JSON.stringify(writer)
        + "], { cwd: process.cwd(), stdio: 'ignore', detached: true }).unref()"
      spawn(process.execPath, ['-e', daemon], { cwd: process.cwd(), stdio: 'ignore', detached: true }).unref()
    }
    if (mode === 'approval') {
      timer = setTimeout(() => say({ method: 'item/commandExecution/requestApproval', id: 900, params: { threadId: active.threadId, turnId: active.turnId, itemId: 'command-1' } }), 20)
    } else if (mode === 'permissions-approval') {
      timer = setTimeout(() => say({ method: 'item/permissions/requestApproval', id: 902, params: { threadId: active.threadId, turnId: active.turnId, itemId: 'permissions-1', cwd: process.cwd(), permissions: { network: { enabled: true } }, startedAtMs: Date.now() } }), 20)
    } else if (mode === 'failed-turn') {
      timer = setTimeout(() => {
        const error = { message: 'model gpt-private invalid for account test@example.invalid at /home/test/private/config.json' }
        say({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, items: [], itemsView: { type: 'full' }, status: 'failed', error, startedAt: 1, completedAt: 2, durationMs: 10 } } })
      }, 20)
    } else if (mode === 'command-failure') {
      timer = setTimeout(() => {
        say({ method: 'item/completed', params: { threadId: active.threadId, turnId: active.turnId, completedAtMs: Date.now(), item: { type: 'commandExecution', id: 'cmd-1', command: 'true', exitCode: 0, status: 'completed' } } })
        say({ method: 'item/completed', params: { threadId: active.threadId, turnId: active.turnId, completedAtMs: Date.now(), item: { type: 'commandExecution', id: 'cmd-2', command: 'git diff', exitCode: 1, status: 'failed' } } })
        say({ method: 'item/completed', params: { threadId: active.threadId, turnId: active.turnId, completedAtMs: Date.now(), item: { type: 'commandExecution', id: 'cmd-3', command: 'bwrapped', exitCode: 127, status: 'completed' } } })
        finish()
      }, 20)
    } else timer = setTimeout(() => finish(), mode === 'slow' || mode === 'steer' ? 2500 : 20)
  } else if (message.method === 'turn/interrupt') { answer({}); finish('interrupted', '') }
  else if (message.method === 'turn/steer') { answer({}); finish('completed', 'STEERED: ' + message.params.input[0].text) }
  else if (message.method === 'model/list') answer({ data: [{ id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'Luna' }], nextCursor: null })
  else if (message.method === 'account/read') answer({ account: { type: 'chatgpt', email: 'test@example.invalid', planType: 'test' }, requiresOpenaiAuth: true })
  else if (message.method === 'thread/read') answer({ thread: { id: message.params.threadId, turns: [recoveredTurn()] } })
  else answer({})
})
`)
chmodSync(fake, 0o755)
mkdirSync(repo)
execFileSync('git', ['init', '-q'], { cwd: repo })
execFileSync('git', ['config', 'user.name', 'Flow test'], { cwd: repo })
execFileSync('git', ['config', 'user.email', 'flow@example.invalid'], { cwd: repo })
writeFileSync(join(repo, 'a.txt'), 'one\n')
execFileSync('git', ['add', 'a.txt'], { cwd: repo })
execFileSync('git', ['commit', '-qm', 'first'], { cwd: repo })
writeFileSync(join(repo, 'a.txt'), 'two\n')
execFileSync('git', ['commit', '-qam', 'second'], { cwd: repo })
mkdirSync(nestedDir)

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const state = (name) => join(temp, `state-${name}`)
const cli = (args, { input = '', mode = 'happy', stateDir = state('default'), extraEnv = {}, host = 'claude' } = {}) => {
  // Every CLI command requires --host: the caller's own family decides the route, so there is
  // no default. Callers that need a different host pass it in args and keep it; host: null
  // leaves the flag off so the missing-host rejection itself can be tested.
  const hosted = host === null || args.includes('--host') ? args : [...args, '--host', host]
  const output = execFileSync(process.execPath, [bundle, 'cli', ...hosted, '--state-dir', stateDir], {
    cwd: repo,
    input,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, FLOW_DELEGATION_CODEX_BIN: fake, FLOW_FAKE_MODE: mode, ...extraEnv },
  })
  return JSON.parse(output)
}
const runArgs = ['run', '--host', 'claude', '--cwd', repo, '--model', 'gpt-5.6-luna', '--effort', 'low', '--time-budget-seconds', '30']
const waitFor = async (jobId, stateDir, wanted = null) => {
  for (let i = 0; i < 80; i++) {
    const result = cli(['result', jobId], { stateDir })
    if (['succeeded', 'failed', 'cancelled', 'unknown', 'awaiting_approval', 'quarantined'].includes(result.status)) {
      if (wanted) assert.equal(result.status, wanted)
      return result
    }
    await delay(100)
  }
  assert.fail(`job ${jobId} did not finish`)
}
const jobCount = (stateDir) => {
  const store = new JobStore(stateDir)
  try { return store.db.prepare('SELECT COUNT(*) AS jobs FROM jobs').get().jobs } finally { store.close() }
}
const openStoreInChild = (stateDir, startAt) => new Promise((resolve) => {
  const child = spawn(process.execPath, [opener, stateDir, String(startAt)], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('exit', (code) => resolve({ code, stderr }))
})

try {
  console.log('task and typed output')
  const happy = cli(runArgs, { input: 'Reply with OK', stateDir: state('happy') })
  assert.equal(happy.status, 'succeeded', JSON.stringify(happy))
  assert.equal(happy.output, 'OK from fake Codex')
  assert.equal(happy.model, 'gpt-5.6-luna')
  assert.equal(happy.serviceTier, 'default')
  assert.ok(happy.threadId && happy.turnId)
  assert.equal(happy.commandFailures, 0)
  const happyEvents = cli(['events', happy.jobId, '--after', '0', '--limit', '1000'], { stateDir: state('happy') })
  assert.deepEqual(happyEvents.map((event) => event.seq), happyEvents.map((_, index) => index + 1))
  const happyDb = new DatabaseSync(join(state('happy'), 'jobs.sqlite3'), { readOnly: true })
  assert.equal(happyDb.prepare('SELECT prompt FROM jobs WHERE id=?').get(happy.jobId).prompt, null)
  happyDb.close()
  // A succeeded turn whose commands failed must say so in the envelope: this is the only
  // signal separating a real green from a provider answering with a broken shell.
  const brokenShell = cli(runArgs, { input: 'Run commands', mode: 'command-failure', stateDir: state('command-failure') })
  assert.equal(brokenShell.status, 'succeeded')
  assert.equal(brokenShell.commandFailures, 2, JSON.stringify(brokenShell))
  const initializeError = cli(runArgs, {
    input: 'Initialization failure', mode: 'initialize-error', stateDir: state('initialize-error'),
  })
  assert.equal(initializeError.status, 'failed')
  assert.equal(initializeError.error.kind, 'APP_SERVER_ERROR')
  assert.equal(providerScopeRunning(providerScopeName(initializeError.jobId)), false)

  const schemaFile = join(temp, 'schema.json')
  writeFileSync(schemaFile, JSON.stringify({ type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } }))
  const good = cli([...runArgs, '--schema-file', schemaFile], { input: 'Return JSON', mode: 'good-schema', stateDir: state('schema-good') })
  assert.equal(good.status, 'succeeded')
  assert.deepEqual(good.structured, { answer: 'yes' })
  const bad = cli([...runArgs, '--schema-file', schemaFile], { input: 'Return JSON', mode: 'bad-schema', stateDir: state('schema-bad') })
  assert.equal(bad.status, 'failed')
  assert.equal(bad.error.kind, 'SCHEMA_OUTPUT')
  const badWrite = cli([...runArgs, '--access', 'workspace-write', '--schema-file', schemaFile], { input: 'Return JSON', mode: 'bad-schema', stateDir: state('schema-bad-write') })
  assert.equal(badWrite.status, 'failed')
  assert.equal(badWrite.error.kind, 'SCHEMA_OUTPUT')
  const falseSchemaFile = join(temp, 'false-schema.json')
  writeFileSync(falseSchemaFile, 'false')
  const rejectedByBooleanSchema = cli([...runArgs, '--schema-file', falseSchemaFile], { input: 'Return anything', stateDir: state('schema-false') })
  assert.equal(rejectedByBooleanSchema.status, 'failed')
  assert.equal(rejectedByBooleanSchema.error.kind, 'BAD_SCHEMA')
  assert.equal(jobCount(state('schema-false')), 0)
  const incompleteSchemaFile = join(temp, 'incomplete-schema.json')
  writeFileSync(incompleteSchemaFile, JSON.stringify({ type: 'object', properties: { answer: { const: 'yes' } } }))
  const incompleteSchema = cli([...runArgs, '--schema-file', incompleteSchemaFile], { input: 'Return JSON', stateDir: state('schema-incomplete') })
  assert.equal(incompleteSchema.status, 'failed')
  assert.equal(incompleteSchema.error.kind, 'BAD_SCHEMA')
  assert.match(incompleteSchema.error.message, /additionalProperties/)
  assert.equal(jobCount(state('schema-incomplete')), 0)
  const untypedSchemaFile = join(temp, 'untyped-schema.json')
  writeFileSync(untypedSchemaFile, JSON.stringify({
    type: 'object', additionalProperties: false, required: ['answer'],
    properties: { answer: { const: 'yes' } },
  }))
  const untypedSchema = cli([...runArgs, '--schema-file', untypedSchemaFile], { input: 'Return JSON', stateDir: state('schema-untyped') })
  assert.equal(untypedSchema.status, 'failed')
  assert.equal(untypedSchema.error.kind, 'BAD_SCHEMA')
  assert.match(untypedSchema.error.message, /explicit type/)
  assert.equal(jobCount(state('schema-untyped')), 0)
  const constrainedRefSchemaFile = join(temp, 'constrained-ref-schema.json')
  writeFileSync(constrainedRefSchemaFile, JSON.stringify({
    type: 'object', additionalProperties: false, required: ['answer'],
    properties: { answer: { $ref: '#/$defs/answer', minLength: 1 } },
    $defs: { answer: { type: 'string' } },
  }))
  const constrainedRefSchema = cli([...runArgs, '--schema-file', constrainedRefSchemaFile], { input: 'Return JSON', stateDir: state('schema-constrained-ref') })
  assert.equal(constrainedRefSchema.status, 'failed')
  assert.equal(constrainedRefSchema.error.kind, 'BAD_SCHEMA')
  assert.match(constrainedRefSchema.error.message, /explicit type/)
  assert.equal(jobCount(state('schema-constrained-ref')), 0)
  const constrainedAnyOfSchemaFile = join(temp, 'constrained-any-of-schema.json')
  writeFileSync(constrainedAnyOfSchemaFile, JSON.stringify({
    type: 'object', additionalProperties: false, required: ['answer'],
    properties: { answer: { anyOf: [{ type: 'string' }, { type: 'null' }], minLength: 1 } },
  }))
  const constrainedAnyOfSchema = cli([...runArgs, '--schema-file', constrainedAnyOfSchemaFile], { input: 'Return JSON', stateDir: state('schema-constrained-any-of') })
  assert.equal(constrainedAnyOfSchema.status, 'failed')
  assert.equal(constrainedAnyOfSchema.error.kind, 'BAD_SCHEMA')
  assert.match(constrainedAnyOfSchema.error.message, /explicit type/)
  assert.equal(jobCount(state('schema-constrained-any-of')), 0)
  const unsupportedApplicatorSchemaFile = join(temp, 'unsupported-applicator-schema.json')
  writeFileSync(unsupportedApplicatorSchemaFile, JSON.stringify({
    type: 'object', additionalProperties: false, required: ['answer'],
    properties: { answer: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
  }))
  const unsupportedApplicatorSchema = cli([...runArgs, '--schema-file', unsupportedApplicatorSchemaFile], { input: 'Return JSON', stateDir: state('schema-unsupported-applicator') })
  assert.equal(unsupportedApplicatorSchema.status, 'failed')
  assert.equal(unsupportedApplicatorSchema.error.kind, 'BAD_SCHEMA')
  assert.match(unsupportedApplicatorSchema.error.message, /unsupported oneOf/)
  assert.equal(jobCount(state('schema-unsupported-applicator')), 0)

  const profile = cli([...runArgs, '--profile', 'defensive-security'], { input: 'Profile test', mode: 'profile', stateDir: state('profile') })
  assert.equal(profile.status, 'succeeded')

  console.log('immutable structured review')
  const reviewState = state('review')
  const review = cli([...runArgs, '--mode', 'adversarial-review', '--base', 'HEAD~1'], { mode: 'review', stateDir: reviewState })
  assert.equal(review.status, 'succeeded')
  assert.equal(review.findings[0].title, 'Race')
  const db = new DatabaseSync(join(reviewState, 'jobs.sqlite3'), { readOnly: true })
  const row = db.prepare('SELECT base_sha, head_sha, output_schema_json FROM jobs WHERE id=?').get(review.jobId)
  db.close()
  assert.match(row.base_sha, /^[0-9a-f]{40}$/)
  assert.match(row.head_sha, /^[0-9a-f]{40}$/)
  assert.ok(JSON.parse(row.output_schema_json).properties.findings)

  console.log('host capability inventory')
  const hostInventories = { claude: capabilitiesForHost('claude'), codex: capabilitiesForHost('codex') }
  const claudeIds = Object.keys(hostInventories.claude.capabilities)
  assert.ok(claudeIds.length > 0)
  assert.deepEqual(claudeIds.sort(), Object.keys(hostInventories.codex.capabilities).sort(), 'every capability id names both hosts')
  for (const [host, inventory] of Object.entries(hostInventories)) {
    assert.equal(inventory.schemaVersion, HOST_CAPABILITIES_SCHEMA_VERSION, host)
    assert.equal(inventory.schemaVersion, 1, host)
    assert.equal(inventory.host, host)
    assert.equal(typeof inventory.verifiedAgainst, 'string', host)
    assert.ok(inventory.verifiedAgainst.length > 0, host)
    for (const [id, entry] of Object.entries(inventory.capabilities)) {
      assert.equal(typeof entry.supported, 'boolean', `${host}/${id} supported`)
      assert.match(entry.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, `${host}/${id} verifiedAt`)
      assert.ok(!Number.isNaN(Date.parse(entry.verifiedAt)), `${host}/${id} verifiedAt is a real date`)
      assert.ok(HOST_CAPABILITY_ASSURANCES.includes(entry.assurance), `${host}/${id} assurance`)
      assert.equal(typeof entry.note, 'string', `${host}/${id} note`)
      assert.ok(entry.note.length > 0, `${host}/${id} note`)
    }
  }
  assert.throws(() => capabilitiesForHost('gemini'), (error) => error.kind === 'ROUTE_DENIED')
  // The inventory is a shared constant. One caller flipping an entry would lie to every later
  // reader in the process, so the deep freeze has to reject the write rather than ignore it.
  assert.throws(() => { hostInventories.claude.capabilities['hook-ask'].supported = false }, TypeError)
  assert.throws(() => { hostInventories.claude.capabilities.invented = {} }, TypeError)
  assert.throws(() => { hostInventories.codex.verifiedAgainst = 'forged' }, TypeError)
  assert.equal(capabilitiesForHost('claude').capabilities['hook-ask'].supported, true)

  console.log('route and nesting guards')
  assert.throws(
    () => assertRoute({ host: 'codex', target: 'codex', depth: 0 }),
    (error) => error.kind === 'SAME_FAMILY',
  )
  const nested = cli(runArgs, { input: 'x', stateDir: state('nested'), extraEnv: { FLOW_DELEGATION_DEPTH: '1' } })
  assert.equal(nested.status, 'failed')
  assert.equal(nested.error.kind, 'NESTED_DELEGATION')
  const invalidTargetState = state('invalid-target')
  const invalidTargetStore = new JobStore(invalidTargetState)
  const invalidTarget = invalidTargetStore.createJob({
    traceId: 'invalid-target', host: 'claude', target: 'other', depth: 0, mode: 'task', access: 'read-only',
    cwd: repo, workspaceKey: repo, model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'default',
    profile: 'standard', timeBudgetSeconds: 30, prompt: 'never start', outputSchema: null,
  })
  invalidTargetStore.close()
  const invalidWorker = spawnSync(process.execPath, [bundle, 'worker', '--job', invalidTarget.id, '--state-dir', invalidTargetState], {
    cwd: repo, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(invalidWorker.status, 1)
  const failedTargetStore = new JobStore(invalidTargetState)
  assert.equal(failedTargetStore.requireJob(invalidTarget.id).status, 'failed')
  assert.equal(failedTargetStore.requireJob(invalidTarget.id).error.kind, 'ROUTE_DENIED')
  failedTargetStore.close()
  const escape = join(repo, 'escape')
  symlinkSync(temp, escape, 'dir')
  const nestedRead = cli([...runArgs, '--cwd', nestedDir], { input: 'nested read', stateDir: state('nested-read') })
  assert.equal(nestedRead.status, 'failed')
  assert.equal(nestedRead.error.kind, 'OUTSIDE_ROOTS')
  const widenedWrite = cli([...runArgs, '--cwd', nestedDir, '--access', 'workspace-write'], { input: 'nested write', stateDir: state('nested-write') })
  assert.equal(widenedWrite.status, 'failed')
  assert.equal(widenedWrite.error.kind, 'OUTSIDE_ROOTS')

  console.log('redacted internal errors')
  const redactStore = new JobStore(state('redact'))
  const redactJob = redactStore.createJob({
    traceId: 't', host: 'claude', target: 'codex', depth: 0, mode: 'task', access: 'read-only',
    cwd: repo, workspaceKey: repo, model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'default',
    profile: 'default', timeBudgetSeconds: 30, prompt: 'x', outputSchema: null,
  })
  redactStore.recordInternalError(redactJob.id, new TypeError('stack detail stays in the journal'))
  assert.deepEqual(redactStore.events(redactJob.id).find((event) => event.type === 'internal.error').payload, { redacted: true })
  redactStore.close()
  const providerError = cli(runArgs, { input: 'fail before start', mode: 'provider-error', stateDir: state('provider-error') })
  assert.equal(providerError.status, 'failed')
  assert.equal(providerError.error.kind, 'APP_SERVER_ERROR')
  assert.equal(providerError.error.message, 'Codex App Server rejected a request.')
  assert.equal(providerError.error.details.code, -32603)
  assert.doesNotMatch(JSON.stringify(providerError), /test@example\.invalid|\/home\/test\/private/)
  const failedTurn = cli(runArgs, { input: 'fail in turn', mode: 'failed-turn', stateDir: state('failed-turn') })
  assert.equal(failedTurn.status, 'failed')
  assert.equal(failedTurn.error.kind, 'BAD_MODEL')
  assert.equal(failedTurn.error.message, 'Codex rejected the requested model.')
  assert.doesNotMatch(JSON.stringify(failedTurn), /test@example\.invalid|\/home\/test\/private|gpt-private/)
  const failedTurnDb = new DatabaseSync(join(state('failed-turn'), 'jobs.sqlite3'), { readOnly: true })
  const failedTurnJournal = failedTurnDb.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='internal.error'").get(failedTurn.jobId)
  failedTurnDb.close()
  assert.match(failedTurnJournal.payload_json, /test@example\.invalid|\/home\/test\/private|gpt-private/)
  assert.deepEqual(cli(['events', failedTurn.jobId], { stateDir: state('failed-turn') })
    .find((event) => event.type === 'internal.error').payload, { redacted: true })

  console.log('rejected requests never reach the job table')
  const noModelState = state('no-model')
  const noModel = cli(['run', '--cwd', repo, '--effort', 'low', '--time-budget-seconds', '30'], { input: 'x', stateDir: noModelState })
  assert.equal(noModel.status, 'failed')
  assert.equal(noModel.error.kind, 'BAD_REQUEST')
  assert.match(noModel.error.message, /model/)
  assert.equal(jobCount(noModelState), 0)
  const noHostState = state('no-host')
  const noHost = cli(['run', '--cwd', repo, '--model', 'gpt-5.6-luna', '--effort', 'low', '--time-budget-seconds', '30'], {
    input: 'x', stateDir: noHostState, host: null,
  })
  assert.equal(noHost.status, 'failed')
  assert.equal(noHost.error.kind, 'BAD_REQUEST')
  assert.match(noHost.error.message, /--host/)
  assert.equal(jobCount(noHostState), 0)
  const unsupportedLimitState = state('unsupported-limit')
  const unsupportedLimit = cli([...runArgs, '--max-turns', '2'], {
    input: 'x', stateDir: unsupportedLimitState,
  })
  assert.equal(unsupportedLimit.status, 'failed')
  assert.equal(unsupportedLimit.error.kind, 'LIMIT_UNSUPPORTED')
  assert.equal(jobCount(unsupportedLimitState), 0)
  const unknownHostState = state('unknown-host')
  const unknownHost = cli(['run', '--host', 'gemini', '--cwd', repo, '--model', 'gpt-5.6-luna', '--effort', 'low'], {
    input: 'x', stateDir: unknownHostState,
  })
  assert.equal(unknownHost.status, 'failed')
  assert.equal(unknownHost.error.kind, 'BAD_REQUEST')
  assert.equal(jobCount(unknownHostState), 0)

  console.log('writer lease, cancel, steer, and continuation')
  const leaseState = state('lease')
  const first = cli([...runArgs, '--access', 'workspace-write', '--detach'], { input: 'slow write', mode: 'slow', stateDir: leaseState })
  await delay(300)
  const activeContinuation = cli(['continue', first.jobId], { input: 'too early', stateDir: leaseState })
  assert.equal(activeContinuation.status, 'failed')
  assert.equal(activeContinuation.error.kind, 'JOB_STATE')
  const second = cli([...runArgs, '--access', 'workspace-write', '--detach'], { input: 'second write', mode: 'slow', stateDir: leaseState })
  const blocked = await waitFor(second.jobId, leaseState, 'failed')
  assert.equal(blocked.error.kind, 'WORKSPACE_BUSY')
  await waitFor(first.jobId, leaseState, 'succeeded')

  const cancelState = state('cancel')
  const cancellable = cli([...runArgs, '--detach'], { input: 'wait', mode: 'slow', stateDir: cancelState })
  await delay(300)
  cli(['cancel', cancellable.jobId], { stateDir: cancelState })
  await waitFor(cancellable.jobId, cancelState, 'cancelled')

  const queuedState = state('queued-cancel')
  const queuedStore = new JobStore(queuedState)
  const queued = queuedStore.createJob({
    traceId: 'queued-cancel', parentJobId: null, host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'read-only', delivery: 'detached', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'default', profile: 'standard',
    timeBudgetSeconds: 30, prompt: 'never start', outputSchema: null, baseSha: null, headSha: null,
  })
  const cancelledQueued = queuedStore.requestCancel(queued.id)
  assert.equal(cancelledQueued.status, 'cancelled')
  assert.equal(cancelledQueued.prompt, null)

  const missingIdentity = queuedStore.createJob({
    traceId: 'missing-identity', parentJobId: null, host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'read-only', delivery: 'detached', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'default', profile: 'standard',
    timeBudgetSeconds: 30, prompt: 'never start', outputSchema: null, baseSha: null, headSha: null,
  })
  assert.throws(() => queuedStore.claim(missingIdentity.id, process.pid, null), (error) => error.kind === 'WORKER_IDENTITY')

  const terminalRace = queuedStore.createJob({
    traceId: 'terminal-race', parentJobId: null, host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'read-only', delivery: 'detached', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'default', profile: 'standard',
    timeBudgetSeconds: 30, prompt: 'finish first', outputSchema: null, baseSha: null, headSha: null,
  })
  const claimedRace = queuedStore.claim(terminalRace.id, process.pid, processStartToken(process.pid))
  queuedStore.finish(terminalRace.id, 'succeeded', { output: 'done' })
  assert.equal(queuedStore.markReconciling(terminalRace.id, claimedRace.heartbeatAt), false)
  assert.equal(queuedStore.getJob(terminalRace.id).status, 'succeeded')
  queuedStore.close()

  const trackedPidFile = join(temp, 'tracked-descendant.pid')
  const trackedRootScript = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}); child.unref(); writeFileSync(${JSON.stringify(trackedPidFile)},String(child.pid)); setInterval(()=>{},1000)`
  const trackedRoot = spawn(process.execPath, ['-e', trackedRootScript], { detached: true, stdio: 'ignore' })
  let trackedPid = null
  try {
    for (let i = 0; i < 40 && !trackedPid; i++) {
      try { trackedPid = Number(readFileSync(trackedPidFile, 'utf8')) || null } catch {}
      if (!trackedPid) await delay(25)
    }
    assert.ok(trackedPid)
    const knownDescendants = new Map()
    for (let i = 0; i < 40 && !knownDescendants.has(trackedPid); i++) {
      captureProcessDescendants(trackedRoot.pid, knownDescendants)
      if (!knownDescendants.has(trackedPid)) await delay(25)
    }
    assert.ok(knownDescendants.has(trackedPid))
    captureProcessDescendants(trackedRoot.pid, knownDescendants, { freeze: true })
    let trackedState = ''
    for (let i = 0; i < 20 && !/^State:\s+T/m.test(trackedState); i++) {
      trackedState = readFileSync(`/proc/${trackedPid}/status`, 'utf8')
      if (!/^State:\s+T/m.test(trackedState)) await delay(25)
    }
    assert.match(trackedState, /^State:\s+T/m)
  } finally {
    if (!trackedPid) {
      try { trackedPid = Number(readFileSync(trackedPidFile, 'utf8')) || null } catch {}
    }
    if (trackedPid) try { process.kill(trackedPid, 'SIGKILL') } catch {}
    try { process.kill(-trackedRoot.pid, 'SIGKILL') } catch {}
  }

  const steerState = state('steer')
  const steerable = cli([...runArgs, '--detach'], { input: 'wait', mode: 'steer', stateDir: steerState })
  await delay(300)
  cli(['steer', steerable.jobId], { input: 'new direction', stateDir: steerState })
  const steered = await waitFor(steerable.jobId, steerState, 'succeeded')
  assert.equal(steered.output, 'STEERED: new direction')
  const steerDb = new DatabaseSync(join(steerState, 'jobs.sqlite3'), { readOnly: true })
  assert.equal(steerDb.prepare(`SELECT payload_json FROM controls WHERE job_id=? AND type='steer'`).get(steerable.jobId).payload_json, '{}')
  steerDb.close()

  const continued = cli(['continue', happy.jobId, '--host', 'claude'], { input: 'Continue', stateDir: state('happy') })
  assert.equal(continued.status, 'succeeded')
  assert.equal(continued.threadId, happy.threadId)

  console.log('duplicate worker claim')
  const duplicateState = state('duplicate-worker')
  const owned = cli([...runArgs, '--access', 'workspace-write', '--detach'], { input: 'slow write', mode: 'slow', stateDir: duplicateState })
  let beforeDuplicate = cli(['status', owned.jobId], { stateDir: duplicateState })
  for (let i = 0; i < 40 && beforeDuplicate.status !== 'running'; i++) {
    await delay(50)
    beforeDuplicate = cli(['status', owned.jobId], { stateDir: duplicateState })
  }
  assert.equal(beforeDuplicate.status, 'running')
  const duplicateWorker = spawnSync(process.execPath, [bundle, 'worker', '--job', owned.jobId, '--state-dir', duplicateState], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, FLOW_DELEGATION_CODEX_BIN: fake, FLOW_FAKE_MODE: 'slow' },
  })
  assert.equal(duplicateWorker.status, 1)
  const afterDuplicate = cli(['status', owned.jobId], { stateDir: duplicateState })
  assert.equal(afterDuplicate.status, beforeDuplicate.status)
  assert.equal(afterDuplicate.error, null)
  const duplicateDb = new DatabaseSync(join(duplicateState, 'jobs.sqlite3'), { readOnly: true })
  const heldLeases = duplicateDb.prepare('SELECT job_id FROM leases').all()
  duplicateDb.close()
  assert.deepEqual(heldLeases.map((lease) => lease.job_id), [owned.jobId])
  await waitFor(owned.jobId, duplicateState, 'succeeded')

  console.log('provider quarantine retains and safely releases a write lease')
  const quarantineState = state('quarantine')
  const quarantineStore = new JobStore(quarantineState)
  const quarantinedJob = quarantineStore.createJob({
    traceId: 'quarantined', parentJobId: null, host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'workspace-write', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'default', profile: 'standard',
    timeBudgetSeconds: 30, prompt: 'quarantine', outputSchema: null,
  })
  quarantineStore.claim(quarantinedJob.id, process.pid, processStartToken(process.pid))
  const provider = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  let providerToken = null
  for (let i = 0; i < 40 && !providerToken; i++) {
    providerToken = processStartToken(provider.pid)
    if (!providerToken) await delay(25)
  }
  assert.ok(providerToken)
  quarantineStore.setProviderProcess(quarantinedJob.id, {
    pid: provider.pid,
    startToken: providerToken,
    processes: [{ pid: provider.pid, startToken: providerToken }],
  })
  quarantineStore.quarantine(quarantinedJob.id, 'unknown', {
    error: { kind: 'PROVIDER_QUARANTINED', message: 'test quarantine', details: null },
  })
  quarantineStore.setProviderProcess(quarantinedJob.id, {
    pid: provider.pid,
    startToken: providerToken,
    scope: 'flow-delegation-test-quarantine.scope',
    processes: [{ pid: provider.pid, startToken: providerToken }],
  })
  assert.equal(quarantineStore.requireJob(quarantinedJob.id).providerScope, 'flow-delegation-test-quarantine.scope')
  const blockedJob = quarantineStore.createJob({
    traceId: 'quarantine-blocked', parentJobId: null, host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'workspace-write', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'default', profile: 'standard',
    timeBudgetSeconds: 30, prompt: 'blocked', outputSchema: null,
  })
  assert.throws(
    () => quarantineStore.claim(blockedJob.id, process.pid, processStartToken(process.pid)),
    (error) => error.kind === 'WORKSPACE_BUSY',
  )
  quarantineStore.close()
  const quarantined = cli(['status', quarantinedJob.id], { stateDir: quarantineState })
  assert.equal(quarantined.status, 'quarantined')
  assert.equal(quarantined.quarantine.resumeStatus, 'unknown')
  assert.equal(quarantined.quarantine.trackedProcesses, 1)
  const quarantineCancel = cli(['cancel', quarantinedJob.id], { stateDir: quarantineState })
  assert.equal(quarantineCancel.status, 'failed')
  assert.equal(quarantineCancel.error.kind, 'JOB_QUARANTINED')
  provider.kill('SIGKILL')
  await new Promise((resolve) => provider.once('exit', resolve))
  const released = cli(['status', quarantinedJob.id], { stateDir: quarantineState })
  assert.equal(released.status, 'unknown')
  assert.equal(released.quarantine, null)
  const releasedStore = new JobStore(quarantineState)
  assert.equal(releasedStore.db.prepare('SELECT COUNT(*) AS count FROM leases').get().count, 0)
  releasedStore.claim(blockedJob.id, process.pid, processStartToken(process.pid))
  releasedStore.finish(blockedJob.id, 'cancelled')
  releasedStore.close()

  console.log('stale workers quarantine live providers before recovery')
  const crashQuarantineState = state('crash-quarantine')
  const crashQuarantineStore = new JobStore(crashQuarantineState)
  const crashedJob = crashQuarantineStore.createJob({
    traceId: 'crash-quarantine', parentJobId: null, host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'workspace-write', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'default', profile: 'standard',
    timeBudgetSeconds: 30, prompt: 'recover after provider exit', outputSchema: null,
  })
  crashQuarantineStore.claim(crashedJob.id, process.pid, processStartToken(process.pid))
  crashQuarantineStore.setRunning(crashedJob.id, { threadId: 'thread-test', turnId: 'recovered', accepted: true })
  const orphanedScope = process.platform === 'linux' ? providerScopeName(crashedJob.id) : null
  const orphanedLaunch = scopedProviderCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], orphanedScope)
  const orphanedProvider = spawn(orphanedLaunch.command, orphanedLaunch.args, { stdio: 'ignore' })
  let orphanedToken = null
  for (let i = 0; i < 40 && !orphanedToken; i++) {
    orphanedToken = processStartToken(orphanedProvider.pid)
    if (!orphanedToken) await delay(25)
  }
  assert.ok(orphanedToken)
  if (orphanedScope) {
    for (let i = 0; i < 40 && !providerScopeRunning(orphanedScope); i++) await delay(25)
    assert.equal(providerScopeRunning(orphanedScope), true)
  }
  crashQuarantineStore.setProviderProcess(crashedJob.id, {
    pid: orphanedProvider.pid,
    startToken: orphanedToken,
    scope: orphanedScope,
    processes: [{ pid: orphanedProvider.pid, startToken: orphanedToken }],
  })
  crashQuarantineStore.db.prepare('UPDATE jobs SET worker_pid=99999999, heartbeat_at=0 WHERE id=?').run(crashedJob.id)
  crashQuarantineStore.close()
  const crashQuarantined = cli(['status', crashedJob.id], { stateDir: crashQuarantineState })
  assert.equal(crashQuarantined.status, 'quarantined')
  assert.equal(crashQuarantined.quarantine.resumeStatus, 'reconciling')
  if (orphanedScope) {
    assert.equal(crashQuarantined.quarantine.providerScope, orphanedScope)
    assert.equal(providerScopeRunning(orphanedScope), true)
  }
  const crashLeaseDb = new DatabaseSync(join(crashQuarantineState, 'jobs.sqlite3'), { readOnly: true })
  assert.equal(crashLeaseDb.prepare('SELECT COUNT(*) AS count FROM leases').get().count, 1)
  crashLeaseDb.close()
  if (orphanedScope) signalProviderScope(orphanedScope, 'SIGKILL')
  else orphanedProvider.kill('SIGKILL')
  await new Promise((resolve) => orphanedProvider.once('exit', resolve))
  const crashRecovered = cli(['status', crashedJob.id], { stateDir: crashQuarantineState })
  assert.equal(crashRecovered.status, 'succeeded')
  assert.equal(crashRecovered.output, 'RECOVERED')
  const crashReleasedDb = new DatabaseSync(join(crashQuarantineState, 'jobs.sqlite3'), { readOnly: true })
  assert.equal(crashReleasedDb.prepare('SELECT COUNT(*) AS count FROM leases').get().count, 0)
  crashReleasedDb.close()

  console.log('unexpected approval and stale-job recovery')
  const approval = cli(runArgs, { input: 'Ask for approval', mode: 'approval', stateDir: state('approval') })
  assert.equal(approval.status, 'awaiting_approval')
  assert.equal(approval.error.kind, 'APPROVAL_REQUIRED')
  const permissionsApproval = cli(runArgs, { input: 'Ask for permissions', mode: 'permissions-approval', stateDir: state('permissions-approval') })
  assert.equal(permissionsApproval.status, 'awaiting_approval')
  assert.equal(permissionsApproval.error.kind, 'APPROVAL_REQUIRED')
  assert.ok(permissionsApproval.usage?.total)

  const missingCodex = cli(runArgs, {
    input: 'cannot start', stateDir: state('missing-codex'),
    extraEnv: { FLOW_DELEGATION_CODEX_BIN: join(temp, 'codex-does-not-exist') },
  })
  assert.equal(missingCodex.status, 'failed')
  assert.equal(missingCodex.error.kind, 'CODEX_NOT_INSTALLED')

  const leakedMcp = cli(runArgs, { input: 'must not run', mode: 'mcp-leak', stateDir: state('mcp-leak') })
  assert.equal(leakedMcp.status, 'failed')
  assert.equal(leakedMcp.error.kind, 'MCP_ISOLATION')
  assert.equal(leakedMcp.threadId, null)

  const malformedProtocol = cli(runArgs, {
    input: 'must not run', mode: 'malformed-protocol', stateDir: state('malformed-protocol'),
  })
  assert.equal(malformedProtocol.status, 'failed')
  assert.equal(malformedProtocol.error.kind, 'APP_SERVER_PROTOCOL')

  const previousCodexBin = process.env.FLOW_DELEGATION_CODEX_BIN
  process.env.FLOW_DELEGATION_CODEX_BIN = fake
  let stdinClosed
  const stdinClosedNotice = new Promise((resolve) => { stdinClosed = resolve })
  const brokenStdinClient = new AppServerClient({
    cwd: repo,
    env: { FLOW_FAKE_MODE: 'stdin-closed' },
    onNotification: (method) => { if (method === 'fake/stdinClosed') stdinClosed() },
  })
  try {
    await brokenStdinClient.start()
    await stdinClosedNotice
    await assert.rejects(
      brokenStdinClient.request('account/read', {}, 2_000),
      (error) => error.kind === 'APP_SERVER_EXIT',
    )
  } finally {
    await brokenStdinClient.stop()
    if (previousCodexBin === undefined) delete process.env.FLOW_DELEGATION_CODEX_BIN
    else process.env.FLOW_DELEGATION_CODEX_BIN = previousCodexBin
  }

  const acceptedCrashState = state('accepted-crash')
  const acceptedCrash = cli([...runArgs, '--access', 'workspace-write'], {
    input: 'accepted before transport loss', mode: 'accepted-crash', stateDir: acceptedCrashState,
  })
  assert.equal(acceptedCrash.status, 'unknown')
  const acceptedCrashDb = new DatabaseSync(join(acceptedCrashState, 'jobs.sqlite3'), { readOnly: true })
  const acceptedCrashRow = acceptedCrashDb.prepare('SELECT native_turn_id, turn_accepted_at, prompt FROM jobs WHERE id=?').get(acceptedCrash.jobId)
  acceptedCrashDb.close()
  assert.ok(acceptedCrashRow.native_turn_id)
  assert.ok(acceptedCrashRow.turn_accepted_at)
  assert.equal(acceptedCrashRow.prompt, null)

  const midturnRead = cli(runArgs, { input: 'crash after acceptance', mode: 'midturn-crash', stateDir: state('midturn-read') })
  assert.equal(midturnRead.status, 'failed')
  assert.equal(midturnRead.error.kind, 'APP_SERVER_EXIT')
  const midturnWrite = cli([...runArgs, '--access', 'workspace-write'], { input: 'crash after write acceptance', mode: 'midturn-crash', stateDir: state('midturn-write') })
  assert.equal(midturnWrite.status, 'unknown')
  assert.equal(midturnWrite.error.kind, 'APP_SERVER_EXIT')

  if (process.platform === 'linux') {
    const detachedCommand = cli(runArgs, {
      input: 'start a detached command', mode: 'detached-command', stateDir: state('detached-command'),
    })
    assert.equal(detachedCommand.status, 'succeeded')
    await delay(1_200)
    assert.equal(existsSync(join(repo, 'codex-detached-survivor')), false)
  }

  const recoveryState = state('recovery')
  const recoverable = cli(runArgs, { input: 'complete', stateDir: recoveryState })
  const recoveryDb = new DatabaseSync(join(recoveryState, 'jobs.sqlite3'))
  recoveryDb.prepare(`UPDATE jobs SET status='running', output=NULL, structured_json=NULL, error_json=NULL,
    heartbeat_at=0, worker_pid=99999999, native_turn_id='recovered' WHERE id=?`).run(recoverable.jobId)
  recoveryDb.close()
  const recovered = cli(['status', recoverable.jobId], { stateDir: recoveryState })
  assert.equal(recovered.status, 'succeeded')
  assert.equal(recovered.output, 'RECOVERED')

  const reusedPidState = state('recovery-pid-reuse')
  const reusedPid = cli(runArgs, { input: 'complete', stateDir: reusedPidState })
  const reusedPidDb = new DatabaseSync(join(reusedPidState, 'jobs.sqlite3'))
  reusedPidDb.prepare(`UPDATE jobs SET status='running', output=NULL, structured_json=NULL, error_json=NULL,
    heartbeat_at=0, worker_pid=?, native_turn_id='recovered' WHERE id=?`).run(process.pid, reusedPid.jobId)
  const nextSeq = reusedPidDb.prepare('SELECT MAX(seq) + 1 AS seq FROM events WHERE job_id=?').get(reusedPid.jobId).seq
  reusedPidDb.prepare(`INSERT INTO events (job_id, seq, type, payload_json, created_at) VALUES (?, ?, 'job.starting', ?, ?)`).run(
    reusedPid.jobId, nextSeq, JSON.stringify({ pid: process.pid, startToken: 'reused-process-token' }), Date.now(),
  )
  reusedPidDb.close()
  const recoveredFromReusedPid = cli(['status', reusedPid.jobId], { stateDir: reusedPidState })
  assert.equal(recoveredFromReusedPid.status, 'succeeded')
  assert.equal(recoveredFromReusedPid.output, 'RECOVERED')

  const unknownState = state('recovery-unknown')
  const unknownWrite = cli([...runArgs, '--access', 'workspace-write'], { input: 'complete', stateDir: unknownState })
  const unknownDb = new DatabaseSync(join(unknownState, 'jobs.sqlite3'))
  unknownDb.prepare(`UPDATE jobs SET status='running', output=NULL, structured_json=NULL, error_json=NULL,
    heartbeat_at=0, worker_pid=99999999, native_turn_id='recovered', turn_accepted_at=1 WHERE id=?`).run(unknownWrite.jobId)
  unknownDb.close()
  const unknown = cli(['status', unknownWrite.jobId], { stateDir: unknownState, mode: 'recovery-in-progress' })
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.error.kind, 'RECOVERY_UNKNOWN')

  const missingTurnState = state('recovery-missing-turn')
  const missingTurn = cli(runArgs, { input: 'complete', stateDir: missingTurnState })
  const missingTurnDb = new DatabaseSync(join(missingTurnState, 'jobs.sqlite3'))
  missingTurnDb.prepare(`UPDATE jobs SET status='running', output=NULL, structured_json=NULL, error_json=NULL,
    heartbeat_at=0, worker_pid=99999999, native_turn_id=NULL, turn_accepted_at=NULL WHERE id=?`).run(missingTurn.jobId)
  missingTurnDb.close()
  const notMisattributed = cli(['status', missingTurn.jobId], { stateDir: missingTurnState })
  assert.equal(notMisattributed.status, 'unknown')
  assert.equal(notMisattributed.error.kind, 'RECOVERY_UNKNOWN')
  const unknownContinuation = cli(['continue', missingTurn.jobId], { input: 'unsafe continuation', stateDir: missingTurnState })
  assert.equal(unknownContinuation.status, 'failed')
  assert.equal(unknownContinuation.error.kind, 'UNKNOWN_JOB')

  console.log('recovered turn classification')
  const recoveredOutcome = (name, mode, { cancelRequested = false } = {}) => {
    const stateDir = state(name)
    const job = cli(runArgs, { input: 'complete', stateDir })
    const db = new DatabaseSync(join(stateDir, 'jobs.sqlite3'))
    db.prepare(`UPDATE jobs SET status='running', output=NULL, structured_json=NULL, error_json=NULL,
      heartbeat_at=0, worker_pid=99999999, native_turn_id='recovered' WHERE id=?`).run(job.jobId)
    if (cancelRequested) {
      db.prepare(`INSERT INTO controls (job_id, type, payload_json, created_at) VALUES (?, 'cancel', '{}', ?)`)
        .run(job.jobId, Date.now())
    }
    db.close()
    return cli(['status', job.jobId], { stateDir, mode })
  }
  const interruptedRecovery = recoveredOutcome('recovery-interrupted', 'recovery-interrupted')
  assert.equal(interruptedRecovery.status, 'failed')
  assert.equal(interruptedRecovery.error.kind, 'INTERRUPTED')
  const cancelledRecovery = recoveredOutcome('recovery-cancelled', 'recovery-interrupted', { cancelRequested: true })
  assert.equal(cancelledRecovery.status, 'cancelled')
  assert.equal(cancelledRecovery.error, null)
  const emptyRecovery = recoveredOutcome('recovery-empty', 'recovery-empty')
  assert.equal(emptyRecovery.status, 'failed')
  assert.equal(emptyRecovery.error.kind, 'EMPTY_OUTPUT')
  const oddRecovery = recoveredOutcome('recovery-odd', 'recovery-odd')
  assert.equal(oddRecovery.status, 'unknown')
  assert.equal(oddRecovery.error.kind, 'UNKNOWN_TURN')

  console.log('concurrent opens, retention, and the v1 upgrade')
  const raceState = state('migration-race')
  const raceStartAt = Date.now() + 1_500
  const raced = await Promise.all(Array.from({ length: 8 }, () => openStoreInChild(raceState, raceStartAt)))
  assert.deepEqual(raced.map((child) => child.code), raced.map(() => 0), raced.map((child) => child.stderr).join('\n'))

  const retentionState = state('retention')
  const retentionStore = new JobStore(retentionState)
  const seedJob = (traceId, extra = {}) => retentionStore.createJob({
    traceId, parentJobId: null, host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'read-only', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'default', profile: 'standard',
    timeBudgetSeconds: 30, prompt: 'retention', outputSchema: null, baseSha: null, headSha: null,
    ...extra,
  })
  const expired = seedJob('retention-expired')
  retentionStore.finish(expired.id, 'succeeded', { output: 'expired' })
  const recent = seedJob('retention-recent')
  retentionStore.finish(recent.id, 'succeeded', { output: 'recent' })
  const expiredParent = seedJob('retention-parent')
  retentionStore.finish(expiredParent.id, 'succeeded', { output: 'parent' })
  const liveChild = seedJob('retention-child', { parentJobId: expiredParent.id })
  const expiredActive = seedJob('retention-active')
  const ancient = Date.now() - 15 * 24 * 60 * 60 * 1_000
  retentionStore.db.prepare('UPDATE jobs SET updated_at=? WHERE id IN (?, ?)').run(ancient, expired.id, expiredParent.id)
  retentionStore.db.prepare(`UPDATE jobs SET status='running', updated_at=? WHERE id=?`).run(ancient, expiredActive.id)
  const tempRoot = join(retentionState, 'tmp')
  const expiredTemp = join(tempRoot, `${expired.id}-expired`)
  const recentTemp = join(tempRoot, `${recent.id}-terminal`)
  const activeTemp = join(tempRoot, `${expiredActive.id}-active`)
  mkdirSync(expiredTemp, { recursive: true })
  mkdirSync(recentTemp, { recursive: true })
  mkdirSync(activeTemp, { recursive: true })
  assert.ok(retentionStore.events(expired.id).length > 0)
  retentionStore.close()
  const pruned = new JobStore(retentionState)
  assert.equal(pruned.getJob(expired.id), null)
  assert.equal(pruned.db.prepare('SELECT COUNT(*) AS events FROM events WHERE job_id=?').get(expired.id).events, 0)
  assert.equal(pruned.getJob(recent.id).status, 'succeeded')
  assert.equal(pruned.getJob(expiredActive.id).status, 'running')
  assert.equal(pruned.getJob(expiredParent.id).status, 'succeeded')
  assert.equal(pruned.getJob(liveChild.id).parentJobId, expiredParent.id)
  assert.equal(existsSync(expiredTemp), false)
  assert.equal(existsSync(recentTemp), false)
  assert.equal(existsSync(activeTemp), true)
  rmSync(activeTemp, { recursive: true, force: true })
  pruned.close()

  // A v1 database from before the schema shed jobs.delivery and leases.heartbeat_at. The rows
  // are what matters: an upgrade that loses a job or its journal is worse than one that fails.
  const legacyState = state('legacy-v1')
  mkdirSync(legacyState, { recursive: true })
  const legacyDb = new DatabaseSync(join(legacyState, 'jobs.sqlite3'))
  legacyDb.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      parent_job_id TEXT REFERENCES jobs(id),
      host TEXT NOT NULL,
      target TEXT NOT NULL,
      depth INTEGER NOT NULL,
      mode TEXT NOT NULL,
      access TEXT NOT NULL,
      delivery TEXT NOT NULL,
      cwd TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      service_tier TEXT NOT NULL,
      profile TEXT NOT NULL,
      time_budget_seconds INTEGER NOT NULL,
      prompt TEXT,
      output_schema_json TEXT,
      base_sha TEXT,
      head_sha TEXT,
      native_thread_id TEXT,
      native_turn_id TEXT,
      turn_accepted_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('queued','starting','running','reconciling','succeeded','failed','cancelled','unknown','awaiting_approval')),
      worker_pid INTEGER,
      output TEXT,
      structured_json TEXT,
      usage_json TEXT,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );
    CREATE TABLE events (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (job_id, seq)
    );
    CREATE TABLE controls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      handled_at INTEGER
    );
    CREATE TABLE leases (
      workspace_key TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
      heartbeat_at INTEGER NOT NULL
    );
    CREATE INDEX jobs_status_idx ON jobs(status, heartbeat_at);
    CREATE INDEX controls_pending_idx ON controls(job_id, handled_at, id);
    PRAGMA user_version=1;
  `)
  const legacyAt = Date.now()
  legacyDb.prepare(`INSERT INTO jobs (
    id, trace_id, parent_job_id, host, target, depth, mode, access, delivery,
    cwd, workspace_key, model, effort, service_tier, profile, time_budget_seconds,
    prompt, status, created_at, updated_at, heartbeat_at
  ) VALUES ('legacy-job', 'legacy-trace', NULL, 'claude', 'codex', 0, 'task', 'workspace-write', 'detached',
    ?, ?, 'gpt-5.6-luna', 'low', 'default', 'standard', 900, 'legacy prompt', 'running', ?, ?, ?)`)
    .run(repo, repo, legacyAt, legacyAt, legacyAt)
  legacyDb.prepare(`INSERT INTO jobs (
    id, trace_id, parent_job_id, host, target, depth, mode, access, delivery,
    cwd, workspace_key, model, effort, service_tier, profile, time_budget_seconds,
    prompt, status, created_at, updated_at, heartbeat_at
  ) VALUES ('legacy-child', 'legacy-trace', 'legacy-job', 'claude', 'codex', 0, 'task', 'read-only', 'attached',
    ?, ?, 'gpt-5.6-luna', 'low', 'default', 'standard', 900, NULL, 'succeeded', ?, ?, ?)`)
    .run(repo, repo, legacyAt, legacyAt, legacyAt)
  legacyDb.prepare(`INSERT INTO events (job_id, seq, type, payload_json, created_at)
    VALUES ('legacy-job', 1, 'job.queued', '{"status":"queued"}', ?)`).run(legacyAt)
  legacyDb.prepare(`INSERT INTO leases (workspace_key, job_id, heartbeat_at) VALUES (?, 'legacy-job', ?)`)
    .run(repo, legacyAt)
  legacyDb.close()
  const upgraded = new JobStore(legacyState)
  const columnsOf = (table) => upgraded.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)
  assert.equal(upgraded.userVersion(), 5)
  assert.ok(!columnsOf('jobs').includes('delivery'))
  assert.ok(columnsOf('jobs').includes('max_turns'))
  assert.ok(columnsOf('jobs').includes('provider_processes_json'))
  assert.ok(columnsOf('jobs').includes('provider_scope'))
  assert.ok(!columnsOf('leases').includes('heartbeat_at'))
  const legacyJob = upgraded.getJob('legacy-job')
  assert.equal(legacyJob.status, 'running')
  assert.equal(legacyJob.model, 'gpt-5.6-luna')
  assert.equal(legacyJob.workspaceKey, repo)
  assert.equal(upgraded.getJob('legacy-child').parentJobId, 'legacy-job')
  assert.equal(upgraded.events('legacy-job').length, 1)
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS leases FROM leases').get().leases, 1)
  assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(), [])
  assert.ok(upgraded.db.prepare('PRAGMA index_list(jobs)').all()
    .some((index) => index.name === 'jobs_route_created_idx'))
  upgraded.close()

  const v3State = state('legacy-v3')
  const v3Seed = new JobStore(v3State)
  const v3Job = v3Seed.createJob({
    traceId: 'v3-job', parentJobId: null, host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'read-only', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'default', profile: 'standard',
    timeBudgetSeconds: 30, prompt: 'v3', outputSchema: null,
  })
  v3Seed.close()
  const v3Db = new DatabaseSync(join(v3State, 'jobs.sqlite3'))
  v3Db.exec('DROP INDEX jobs_route_created_idx; ALTER TABLE jobs DROP COLUMN provider_scope; PRAGMA user_version=3;')
  v3Db.close()
  const v3Upgraded = new JobStore(v3State)
  assert.equal(v3Upgraded.userVersion(), 5)
  assert.ok(v3Upgraded.db.prepare('PRAGMA table_info(jobs)').all().some((column) => column.name === 'provider_scope'))
  assert.ok(v3Upgraded.db.prepare('PRAGMA index_list(jobs)').all()
    .some((index) => index.name === 'jobs_route_created_idx'))
  assert.equal(v3Upgraded.getJob(v3Job.id).traceId, 'v3-job')
  v3Upgraded.close()

  console.log('MCP registration, roots, progress, and attached result')
  const mcpState = state('mcp')
  const client = new McpStdioClient({
    command: process.execPath,
    args: [bundle, 'mcp', '--host', 'claude', '--state-dir', mcpState],
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      FLOW_DELEGATION_CODEX_BIN: fake,
      FLOW_FAKE_MODE: 'happy',
    },
    roots: [{ uri: pathToFileURL(repo).href, name: 'repo' }],
  })
  await client.start()
  const tools = await client.listTools()
  const names = tools.tools.map((tool) => tool.name)
  for (const name of ['delegate_to_codex', 'delegation_status', 'delegation_result', 'delegation_events', 'delegation_list', 'delegation_cancel', 'delegation_steer', 'delegation_continue', 'delegation_models', 'delegation_doctor']) assert.ok(names.includes(name), name)
  const delegateTool = tools.tools.find((tool) => tool.name === 'delegate_to_codex')
  assert.equal(delegateTool.inputSchema.properties.maxTurns, undefined)
  assert.equal(delegateTool.inputSchema.properties.maxBudgetUsd, undefined)
  const escaped = await client.callTool(
    'delegate_to_codex',
    { mode: 'task', prompt: 'escape', cwd: temp, access: 'read-only', model: 'gpt-5.6-luna', effort: 'low', delivery: 'attached', timeBudgetSeconds: 30 },
  )
  assert.equal(escaped.isError, true)
  assert.equal(escaped.structuredContent.error.kind, 'OUTSIDE_ROOTS')
  const symlinkEscape = await client.callTool(
    'delegate_to_codex',
    { mode: 'task', prompt: 'symlink escape', cwd: escape, access: 'read-only', model: 'gpt-5.6-luna', effort: 'low', delivery: 'attached', timeBudgetSeconds: 30 },
  )
  assert.equal(symlinkEscape.isError, true)
  assert.equal(symlinkEscape.structuredContent.error.kind, 'OUTSIDE_ROOTS')
  // The roots exception for linked worktrees: a worktree the approved repository registered
  // is accepted even though it sits outside every client root, while a caller-writable .git
  // file pointing at the approved repository is not, because the repository never listed it.
  const linked = join(temp, 'linked-wt')
  execFileSync('git', ['worktree', 'add', '-q', linked], { cwd: repo })
  const linkedWrite = await client.callTool(
    'delegate_to_codex',
    { mode: 'task', prompt: 'linked worktree', cwd: linked, access: 'workspace-write', model: 'gpt-5.6-luna', effort: 'low', delivery: 'attached', timeBudgetSeconds: 30 },
    { timeout: 30_000 },
  )
  assert.equal(linkedWrite.isError, undefined)
  assert.equal(linkedWrite.structuredContent.job.status, 'succeeded')
  const forged = join(temp, 'forged')
  mkdirSync(forged)
  writeFileSync(join(forged, '.git'), `gitdir: ${join(repo, '.git')}\n`)
  const forgedRun = await client.callTool(
    'delegate_to_codex',
    { mode: 'task', prompt: 'forged gitfile', cwd: forged, access: 'read-only', model: 'gpt-5.6-luna', effort: 'low', delivery: 'attached', timeBudgetSeconds: 30 },
  )
  assert.equal(forgedRun.isError, true)
  assert.equal(forgedRun.structuredContent.error.kind, 'OUTSIDE_ROOTS')
  const progress = []
  const mcpResult = await client.callTool(
    'delegate_to_codex',
    { mode: 'task', prompt: 'MCP test', cwd: repo, access: 'read-only', model: 'gpt-5.6-luna', effort: 'low', delivery: 'attached', timeBudgetSeconds: 30 },
    { timeout: 30_000, onprogress: (event) => progress.push(event) },
  )
  assert.equal(mcpResult.isError, undefined)
  assert.equal(mcpResult.structuredContent.job.status, 'succeeded')
  assert.ok(progress.length > 0)
  const continuedProgress = []
  const mcpContinued = await client.callTool(
    'delegation_continue',
    { jobId: mcpResult.structuredContent.job.jobId, prompt: 'Continue over MCP', delivery: 'attached', timeBudgetSeconds: 30 },
    { timeout: 30_000, onprogress: (event) => continuedProgress.push(event) },
  )
  assert.equal(mcpContinued.isError, undefined)
  assert.equal(mcpContinued.structuredContent.ok, true)
  assert.equal(mcpContinued.structuredContent.job.status, 'succeeded')
  assert.equal(mcpContinued.structuredContent.job.threadId, mcpResult.structuredContent.job.threadId)
  assert.notEqual(mcpContinued.structuredContent.job.jobId, mcpResult.structuredContent.job.jobId)
  assert.ok(continuedProgress.length > 0)
  const firstPage = await client.callTool('delegation_list', { limit: 1 }, { timeout: 30_000 })
  assert.equal(firstPage.structuredContent.jobs.length, 1)
  assert.equal(firstPage.structuredContent.jobs[0].host, 'claude')
  assert.equal(firstPage.structuredContent.jobs[0].target, 'codex')
  assert.equal(Object.hasOwn(firstPage.structuredContent.jobs[0], 'prompt'), false)
  assert.equal(Object.hasOwn(firstPage.structuredContent.jobs[0], 'output'), false)
  assert.ok(firstPage.structuredContent.nextCursor)
  const secondPage = await client.callTool('delegation_list', {
    limit: 1,
    cursor: firstPage.structuredContent.nextCursor,
  }, { timeout: 30_000 })
  assert.equal(secondPage.structuredContent.jobs.length, 1)
  assert.notEqual(secondPage.structuredContent.jobs[0].jobId, firstPage.structuredContent.jobs[0].jobId)
  const mismatchedCursor = await client.callTool('delegation_list', {
    status: 'succeeded',
    limit: 1,
    cursor: firstPage.structuredContent.nextCursor,
  }, { timeout: 30_000 })
  assert.equal(mismatchedCursor.isError, true)
  assert.equal(mismatchedCursor.structuredContent.error.kind, 'BAD_REQUEST')
  const succeededPage = await client.callTool('delegation_list', { status: 'succeeded', limit: 100 }, { timeout: 30_000 })
  assert.ok(succeededPage.structuredContent.jobs.length >= 2)
  assert.ok(succeededPage.structuredContent.jobs.every((job) => job.status === 'succeeded'))

  const hiddenStore = new JobStore(mcpState)
  for (let index = 0; index < 33; index++) {
    const hiddenCwd = join(temp, `hidden-list-${index}`)
    mkdirSync(hiddenCwd)
    hiddenStore.createJob({
      traceId: `hidden-list-job-${index}`, host: 'claude', target: 'codex', depth: 0,
      mode: 'task', access: 'read-only', cwd: hiddenCwd, workspaceKey: hiddenCwd,
      model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'default', profile: 'standard',
      timeBudgetSeconds: 30, prompt: 'hidden', outputSchema: null,
    })
  }
  hiddenStore.createJob({
    traceId: 'other-route-list-job', host: 'codex', target: 'claude', depth: 0,
    mode: 'task', access: 'read-only', cwd: repo, workspaceKey: repo,
    model: 'sonnet', effort: 'low', serviceTier: 'default', profile: 'standard',
    timeBudgetSeconds: 30, prompt: 'other route', outputSchema: null,
  })
  hiddenStore.close()
  let hiddenCursor = null
  let firstHiddenCursor = null
  let hiddenPages = 0
  do {
    const hiddenPage = await client.callTool('delegation_list', {
      status: 'queued', limit: 100, ...(hiddenCursor ? { cursor: hiddenCursor } : {}),
    }, { timeout: 30_000 })
    assert.deepEqual(hiddenPage.structuredContent.jobs, [])
    hiddenCursor = hiddenPage.structuredContent.nextCursor
    if (!firstHiddenCursor) firstHiddenCursor = hiddenCursor
    hiddenPages++
  } while (hiddenCursor)
  assert.ok(hiddenPages >= 2)
  assert.ok(firstHiddenCursor)
  const hiddenJobId = JSON.parse(Buffer.from(firstHiddenCursor, 'base64url').toString('utf8')).id
  for (const [tool, input] of [
    ['delegation_status', { jobId: hiddenJobId }],
    ['delegation_result', { jobId: hiddenJobId }],
    ['delegation_events', { jobId: hiddenJobId }],
    ['delegation_steer', { jobId: hiddenJobId, text: 'hidden' }],
    ['delegation_continue', { jobId: hiddenJobId, prompt: 'hidden' }],
    ['delegation_cancel', { jobId: hiddenJobId }],
  ]) {
    const deniedHiddenJob = await client.callTool(tool, input, { timeout: 30_000 })
    assert.equal(deniedHiddenJob.isError, true, tool)
    assert.equal(deniedHiddenJob.structuredContent.error.kind, 'OUTSIDE_ROOTS', tool)
  }
  const modelResult = await client.callTool('delegation_models', { cwd: repo }, { timeout: 30_000 })
  assert.equal(modelResult.structuredContent.models[0].id, 'gpt-5.6-luna')
  const escapedModels = await client.callTool('delegation_models', { cwd: temp }, { timeout: 30_000 })
  assert.equal(escapedModels.isError, true)
  assert.equal(escapedModels.structuredContent.error.kind, 'OUTSIDE_ROOTS')
  const doctorResult = await client.callTool('delegation_doctor', { cwd: repo }, { timeout: 30_000 })
  assert.equal(doctorResult.structuredContent.ok, true)
  assert.equal(doctorResult.structuredContent.checks.workspace.ok, true)
  assert.equal(doctorResult.structuredContent.checks.containment.mode, 'systemd-scope')
  assert.equal(doctorResult.structuredContent.checks.mcpIsolation.ok, true)
  assert.equal(doctorResult.structuredContent.checks.restrictedPermissions.ok, true)
  assert.equal(doctorResult.structuredContent.checks.restrictedPermissions.profile, 'flow_delegation')
  assert.equal(doctorResult.structuredContent.mcp.client.name, 'flow-smoke')
  assert.equal(doctorResult.structuredContent.mcp.capabilities.roots.listChanged, true)
  const doctorHostCapabilities = doctorResult.structuredContent.hostCapabilities
  assert.equal(doctorHostCapabilities.schemaVersion, 1)
  assert.equal(doctorHostCapabilities.host, 'claude')
  assert.equal(doctorHostCapabilities.capabilities['hook-deny'].supported, true)
  assert.equal(doctorResult.structuredContent.checks.hostCapabilities, undefined, 'the inventory is a sibling of checks, not a check')
  // Unsupported entries are inventory, not failures. Doctor stays ok while they are present.
  assert.ok(Object.values(doctorHostCapabilities.capabilities).some((entry) => entry.supported === false))
  assert.equal(doctorResult.structuredContent.ok, true)
  await client.close()

  const noRootsClient = new McpStdioClient({
    command: process.execPath,
    args: [bundle, 'mcp', '--host', 'claude', '--state-dir', state('mcp-no-roots')],
    cwd: repo,
    env: {
      ...process.env,
      CODEX_PROJECT_DIR: '',
      CLAUDE_PROJECT_DIR: '',
      FLOW_DELEGATION_CODEX_BIN: fake,
      FLOW_FAKE_MODE: 'happy',
    },
    roots: [],
  })
  await noRootsClient.start()
  const noRootsDoctor = await noRootsClient.callTool('delegation_doctor', {}, { timeout: 30_000 })
  assert.equal(noRootsDoctor.isError, undefined)
  assert.equal(noRootsDoctor.structuredContent.ok, false)
  assert.equal(noRootsDoctor.structuredContent.checks.workspace.error.kind, 'NO_ROOTS')
  assert.equal(noRootsDoctor.structuredContent.checks.appServer.ok, true)
  const noRootsList = await noRootsClient.callTool('delegation_list', {}, { timeout: 30_000 })
  assert.equal(noRootsList.isError, true)
  assert.equal(noRootsList.structuredContent.error.kind, 'NO_ROOTS')
  await noRootsClient.close()

  const missingMcpHost = spawnSync(process.execPath, [bundle, 'mcp'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(missingMcpHost.status, 2)
  assert.match(missingMcpHost.stderr, /--host is required/)

  for (const entry of readdirSync(temp, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('state-')) continue
    const jobTempRoot = join(temp, entry.name, 'tmp')
    if (existsSync(jobTempRoot)) assert.deepEqual(readdirSync(jobTempRoot), [], `${entry.name} leaked a job temporary directory`)
  }

  console.log('smoke-delegation: ALL PASS')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
