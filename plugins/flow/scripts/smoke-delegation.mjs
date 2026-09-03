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
import { assertRoute, capabilitiesForHost, capabilityDrift, HOST_CAPABILITIES_SCHEMA_VERSION, HOST_CAPABILITY_ASSURANCES } from '../src/delegation/contracts.mjs'
import { universalContainment } from '../lib/seat-contract.mjs'
import { charterSection } from '../lib/charter-payload.mjs'
import { DELEGATED_CHARTER_HEADING } from '../src/delegation/instructions.mjs'
import { McpStdioClient } from './mcp-stdio-client.mjs'

assert.equal(process.platform, 'linux', 'smoke-delegation requires the Linux Codex host and systemd-scope contract')

// deps/node_modules is gitignored, so a clone and every installed copy of the plugin lack
// the MCP SDK. This client speaks the stdio transport directly instead: newline-delimited
// JSON-RPC 2.0 on the server's stdin and stdout. It covers only what the smoke drives -
// initialize, tools/list, tools/call with progress, and a roots/list answer. Every call in
// this file goes through it, because the MCP server is the only way into the service.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(root, 'dist', 'delegation.mjs')
const temp = mkdtempSync(join(tmpdir(), 'flow-delegation-smoke-'))
const repo = join(temp, 'repo')
const nestedDir = join(repo, 'nested')
const fake = join(temp, 'fake-codex.mjs')
const opener = join(temp, 'open-store.mjs')
const instructionsOut = join(temp, 'developer-instructions.txt')

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
import { realpathSync, writeFileSync } from 'node:fs'
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
    // A job carries the charter's engineering-rules section once, ahead of the seat block,
    // and no binding profile: the section names no role, so there is nothing to bind.
    const instructions = message.params.developerInstructions || ''
    // capture-instructions dumps what the bundle actually sent, so the smoke can assert on the
    // built payload instead of re-rendering it from src, where no esbuild define applies.
    if (mode === 'capture-instructions' && !doctorProbe) writeFileSync(${JSON.stringify(instructionsOut)}, instructions)
    const charterOk = (instructions.match(/<flow-charter /g) || []).length === 1
      && !instructions.includes('<flow-profile')
      && instructions.indexOf('</flow-charter>') < instructions.indexOf('<delegated-seat>')
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
      || (!doctorProbe && !message.params.developerInstructions?.includes('<flow-charter scope="delegated-seat">'))
      || (!doctorProbe && !message.params.developerInstructions?.includes('Do not start subagents'))) {
      say({ id: message.id, error: { code: -32602, message: 'missing restricted Flow delegation profile' } })
    } else if (!doctorProbe && !charterOk) {
      say({ id: message.id, error: { code: -32602, message: 'missing or misplaced delegated charter section' } })
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
const SETTLED = ['succeeded', 'failed', 'cancelled', 'unknown', 'awaiting_approval', 'quarantined']

// MCP is the only entry mode, so the smoke calls the tools a host calls. One server process
// per call, the way the deleted CLI mode was one process per call; a test that polls opens one
// session and keeps it. Roots come from the client, which is where a real host's come from.
const session = async (options, body) => {
  const { host = 'claude', stateDir = state('default'), mode = 'happy', roots = [repo], extraEnv = {} } = options
  const client = new McpStdioClient({
    command: process.execPath,
    args: [bundle, 'mcp', '--host', host, '--state-dir', stateDir],
    cwd: repo,
    env: { ...process.env, FLOW_DELEGATION_CODEX_BIN: fake, FLOW_FAKE_MODE: mode, ...extraEnv },
    roots: roots.map((path) => ({ uri: pathToFileURL(path).href, name: 'root' })),
  })
  await client.start()
  try { return await body(client) } finally { await client.close() }
}
// A tool either answers with a job envelope or with a rejection. Both shapes reduce to the
// envelope the assertions read, so a rejected request reads as a failed job with its kind.
const envelope = (result) => result.structuredContent?.job ?? { status: 'failed', error: result.structuredContent?.error ?? null }
const call = (name, args, options = {}) => session(options, (client) =>
  client.callTool(name, args, { timeout: options.timeout ?? 60_000, onprogress: options.onprogress ?? null }))
const startJob = async (input = {}, options = {}) => envelope(await call(`delegate_to_${options.target || 'codex'}`, {
  mode: 'task', cwd: repo, model: 'gpt-5.6-luna', effort: 'low', access: 'read-only',
  delivery: 'attached', timeBudgetSeconds: 30, prompt: 'x', ...input,
}, options))
const statusOf = async (jobId, options = {}) => envelope(await call('delegation_status', { jobId }, options))
const resultOf = async (jobId, options = {}) => envelope(await call('delegation_result', { jobId }, options))
const eventsOf = async (jobId, args = {}, options = {}) => (await call('delegation_events', { jobId, ...args }, options)).structuredContent.events
const cancelJob = async (jobId, options = {}) => envelope(await call('delegation_cancel', { jobId }, options))
const steerJob = async (jobId, text, options = {}) => envelope(await call('delegation_steer', { jobId, text }, options))
const continueJob = async (jobId, input = {}, options = {}) => envelope(await call('delegation_continue', { jobId, delivery: 'attached', ...input }, options))
const waitFor = (jobId, stateDir, wanted = null) => session({ stateDir }, async (client) => {
  for (let i = 0; i < 80; i++) {
    const result = envelope(await client.callTool('delegation_result', { jobId }, { timeout: 30_000 }))
    if (SETTLED.includes(result.status)) {
      if (wanted) assert.equal(result.status, wanted, JSON.stringify(result))
      return result
    }
    await delay(100)
  }
  assert.fail(`job ${jobId} did not finish`)
})
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
  const happy = await startJob({ prompt: 'Reply with OK' }, { stateDir: state('happy') })
  assert.equal(happy.status, 'succeeded', JSON.stringify(happy))
  assert.equal(happy.output, 'OK from fake Codex')
  assert.equal(happy.model, 'gpt-5.6-luna')
  assert.ok(happy.threadId && happy.turnId)
  assert.equal(happy.commandFailures, 0)
  const happyEvents = await eventsOf(happy.jobId, { after: 0, limit: 1000 }, { stateDir: state('happy') })
  assert.deepEqual(happyEvents.map((event) => event.seq), happyEvents.map((_, index) => index + 1))
  const happyDb = new DatabaseSync(join(state('happy'), 'jobs.sqlite3'), { readOnly: true })
  assert.equal(happyDb.prepare('SELECT prompt FROM jobs WHERE id=?').get(happy.jobId).prompt, null)
  happyDb.close()
  // A succeeded turn whose commands failed must say so in the envelope: this is the only
  // signal separating a real green from a provider answering with a broken shell.
  const brokenShell = await startJob({ prompt: 'Run commands' }, { mode: 'command-failure', stateDir: state('command-failure') })
  assert.equal(brokenShell.status, 'succeeded')
  assert.equal(brokenShell.commandFailures, 2, JSON.stringify(brokenShell))
  const initializeError = await startJob({ prompt: 'Initialization failure' }, {
    mode: 'initialize-error', stateDir: state('initialize-error'),
  })
  assert.equal(initializeError.status, 'failed')
  assert.equal(initializeError.error.kind, 'APP_SERVER_ERROR')
  assert.equal(providerScopeRunning(providerScopeName(initializeError.jobId)), false)

  const answerSchema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } }
  const good = await startJob({ prompt: 'Return JSON', outputSchema: answerSchema }, { mode: 'good-schema', stateDir: state('schema-good') })
  assert.equal(good.status, 'succeeded')
  assert.deepEqual(good.structured, { answer: 'yes' })
  const bad = await startJob({ prompt: 'Return JSON', outputSchema: answerSchema }, { mode: 'bad-schema', stateDir: state('schema-bad') })
  assert.equal(bad.status, 'failed')
  assert.equal(bad.error.kind, 'SCHEMA_OUTPUT')
  const badWrite = await startJob({ prompt: 'Return JSON', access: 'workspace-write', outputSchema: answerSchema }, { mode: 'bad-schema', stateDir: state('schema-bad-write') })
  assert.equal(badWrite.status, 'failed')
  assert.equal(badWrite.error.kind, 'SCHEMA_OUTPUT')
  const rejectedByBooleanSchema = await startJob({ prompt: 'Return anything', outputSchema: false }, { stateDir: state('schema-false') })
  assert.equal(rejectedByBooleanSchema.status, 'failed')
  assert.equal(rejectedByBooleanSchema.error.kind, 'BAD_SCHEMA')
  assert.equal(jobCount(state('schema-false')), 0)
  // Every schema below is valid JSON Schema and invalid for Codex structured output, which is
  // the whole point: the provider would accept the request and answer against constraints
  // nobody checked, so Flow rejects it before a job row exists.
  const rejectedSchemas = [
    ['schema-incomplete', { type: 'object', properties: { answer: { const: 'yes' } } }, /additionalProperties/],
    ['schema-untyped', { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { const: 'yes' } } }, /explicit type/],
    ['schema-constrained-ref', {
      type: 'object', additionalProperties: false, required: ['answer'],
      properties: { answer: { $ref: '#/$defs/answer', minLength: 1 } },
      $defs: { answer: { type: 'string' } },
    }, /explicit type/],
    ['schema-constrained-any-of', {
      type: 'object', additionalProperties: false, required: ['answer'],
      properties: { answer: { anyOf: [{ type: 'string' }, { type: 'null' }], minLength: 1 } },
    }, /explicit type/],
    ['schema-unsupported-applicator', {
      type: 'object', additionalProperties: false, required: ['answer'],
      properties: { answer: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
    }, /unsupported oneOf/],
  ]
  for (const [name, outputSchema, message] of rejectedSchemas) {
    const rejected = await startJob({ prompt: 'Return JSON', outputSchema }, { stateDir: state(name) })
    assert.equal(rejected.status, 'failed', name)
    assert.equal(rejected.error.kind, 'BAD_SCHEMA', name)
    assert.match(rejected.error.message, message, name)
    assert.equal(jobCount(state(name)), 0, name)
  }

  console.log('seat contract rides the delegated payload')
  const contractJob = await startJob({ prompt: 'Seat contract', access: 'workspace-write' }, {
    mode: 'capture-instructions', stateDir: state('seat-contract'),
  })
  assert.equal(contractJob.status, 'succeeded', JSON.stringify(contractJob))
  const payload = readFileSync(instructionsOut, 'utf8')
  const openTag = '<seat-contract scope="containment">'
  assert.equal((payload.match(/<seat-contract /g) || []).length, 1, 'expected exactly one seat-contract block')
  assert.ok(payload.includes(openTag), 'the seat-contract block is not scoped to containment')
  // Both halves of the ordering check, separately. indexOf returns -1 for a tag that is not there,
  // and -1 is lower than every real index, so a payload that lost </delegated-seat> altogether
  // would satisfy the comparison below while proving nothing.
  const seatBlockEnd = payload.indexOf('</delegated-seat>')
  assert.ok(seatBlockEnd >= 0, 'the delegated payload has no </delegated-seat> to order against')
  assert.ok(seatBlockEnd < payload.indexOf(openTag), 'the seat-contract block must sit after the delegated-seat block, and it does not')
  const blockStart = payload.indexOf(openTag) + openTag.length
  const blockEnd = payload.indexOf('</seat-contract>')
  assert.ok(blockEnd > blockStart, 'the seat-contract block never closes')
  const contractBlock = payload.slice(blockStart, blockEnd)
  // A byte-identical rebuild proves the bundle matches src and nothing more. Reading the canonical
  // contract here is what proves the bundle was built with __FLOW_SEAT_CONTRACT__ pointing at it.
  const containment = universalContainment(readFileSync(join(root, 'seat-contract.md'), 'utf8')).trim()
  assert.ok(contractBlock.includes(containment), 'the delegated payload lost the canonical Containment section')
  // Containment and nothing else. The other three sections are doctrine for a seat working an
  // issue; a caller that wants them pastes them into its own task text.
  for (const heading of ['Synchronous execution', 'Scope and completion', 'Reporting']) {
    assert.ok(!contractBlock.includes(`## ${heading}`), `the seat-contract block carries ${heading}, which must never ride a delegated payload`)
  }
  // The charter rides as one section, verbatim. The orchestrator's doctrine, which a leaf seat
  // cannot act on, does not ride, and neither does a binding profile: the section names no role.
  assert.equal((payload.match(/<flow-charter /g) || []).length, 1, 'expected exactly one charter block')
  const rules = charterSection(readFileSync(join(root, 'charter', 'charter.md'), 'utf8'), DELEGATED_CHARTER_HEADING)
  assert.ok(rules !== null && payload.includes(rules.trim()), 'the delegated payload lost the engineering-rules section of the charter')
  for (const heading of ['Orchestration with Delegation', 'Cross-Family Delegation', 'The `flow` pipeline', 'Model Rankings', 'Rules of Engagement - Model Selection', 'Rules of Engagement - Model Contracts', 'Gripes']) {
    assert.ok(!payload.includes(`## ${heading}`), `the delegated payload carries the "${heading}" charter section, which a leaf seat cannot act on`)
  }
  assert.ok(!payload.includes('<flow-profile'), 'the delegated payload carries a binding profile, and the section it rides with names no role')

  console.log('immutable structured review')
  const reviewState = state('review')
  const review = await startJob({ mode: 'adversarial-review', base: 'HEAD~1', prompt: '' }, { mode: 'review', stateDir: reviewState })
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
  // The table is a data file the bundle reads at runtime, so re-verifying a row is an edit to
  // capabilities.json and no rebuild. An inlined copy would defeat that, and the note strings are
  // long enough to be unmistakable, so their absence from the built bundle is the proof.
  const capabilityFile = JSON.parse(readFileSync(join(root, 'capabilities.json'), 'utf8'))
  assert.equal(capabilityFile.schemaVersion, HOST_CAPABILITIES_SCHEMA_VERSION)
  const sampleNote = capabilityFile.hosts.codex.capabilities['hook-ask'].note
  assert.ok(sampleNote.length > 40)
  assert.equal(readFileSync(bundle, 'utf8').includes(sampleNote), false, 'the bundle inlined the capability table')
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
      // Date.parse alone normalizes an impossible date ('2023-02-31' becomes March 3), so the
      // round-trip back to YYYY-MM-DD is what proves the calendar date is real.
      const verifiedMs = Date.parse(entry.verifiedAt)
      assert.ok(!Number.isNaN(verifiedMs), `${host}/${id} verifiedAt is a real date`)
      assert.equal(new Date(verifiedMs).toISOString().slice(0, 10), entry.verifiedAt, `${host}/${id} verifiedAt is a real calendar date`)
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

  // The slice 3 rows were probed a day after the table default, so every Codex cell in them
  // carries its own verifiedAt, and four of the Claude cells carry the 2026-08-31 re-verification
  // date. skill-composition is the one Claude cell in this group that run did not exercise, so it
  // still reads the table default, which is what proves a date lands per entry rather than
  // re-dating the whole table.
  const tableDefaultDate = hostInventories.codex.capabilities['hook-deny'].verifiedAt
  assert.equal(tableDefaultDate, '2026-08-29', 'table default date')
  const sliceThreeRows = {
    'agent-depth-limit': { claude: [true, 'mechanism'], codex: [false, 'mechanism'] },
    'per-seat-authority-narrowing': { claude: [true, 'mechanism'], codex: [false, 'mechanism'] },
    'skill-composition': { claude: [true, 'mechanism'], codex: [true, 'contract'] },
    'hooks-in-native-children': { claude: [true, 'mechanism'], codex: [true, 'mechanism'] },
    'mcp-client-roots': { claude: [true, 'mechanism'], codex: [false, 'mechanism'] },
  }
  for (const [id, expected] of Object.entries(sliceThreeRows)) {
    for (const [host, [supported, assurance]] of Object.entries(expected)) {
      const entry = hostInventories[host].capabilities[id]
      assert.ok(entry, `${host}/${id} is in the inventory`)
      assert.equal(entry.supported, supported, `${host}/${id} supported`)
      assert.equal(entry.assurance, assurance, `${host}/${id} assurance`)
    }
    assert.equal(hostInventories.codex.capabilities[id].verifiedAt, '2026-08-30', `codex/${id} verifiedAt`)
    const claudeDate = id === 'skill-composition' ? tableDefaultDate : '2026-08-31'
    assert.equal(hostInventories.claude.capabilities[id].verifiedAt, claudeDate, `claude/${id} verifiedAt`)
  }
  assert.throws(() => { hostInventories.codex.capabilities['agent-depth-limit'].verifiedAt = '1999-01-01' }, TypeError)
  assert.throws(() => { hostInventories.claude.capabilities['skill-composition'].supported = false }, TypeError)

  // The 2026-08-31 Claude re-verification. The machine had moved past the recorded claude-code
  // version, the drift gate caught it, and these five rows were re-dated because
  // the slice 4 run used every one of them: seat tool lists held, leaf defs with no Agent tool
  // could not spawn, the PreToolUse guards fired inside seats, and the session still advertised
  // roots. Watched at work, not re-probed, so no supported or assurance value moved with the date.
  assert.equal(hostInventories.claude.verifiedAgainst, 'claude-code 2.1.257', 'the claude record names the version those rows were re-verified under')
  for (const id of ['per-seat-tool-allowlist', 'agent-depth-limit', 'per-seat-authority-narrowing', 'hooks-in-native-children', 'mcp-client-roots']) {
    assert.equal(hostInventories.claude.capabilities[id].verifiedAt, '2026-08-31', `claude/${id} verifiedAt`)
    assert.equal(hostInventories.claude.capabilities[id].supported, true, `claude/${id} supported`)
    assert.equal(hostInventories.claude.capabilities[id].assurance, 'mechanism', `claude/${id} assurance`)
  }

  // The issue-stage profiles cite these ids by name, in prose no test parses. Renaming a row in
  // HOST_CAPABILITY_TABLE has to fail here rather than leave a profile naming an id nobody has.
  const citedCapabilities = {
    claude: ['per-seat-tool-allowlist', 'agent-depth-limit', 'hooks-in-native-children', 'mcp-client-roots'],
    codex: [
      'per-seat-authority-narrowing', 'agent-depth-limit', 'hooks-in-native-children',
      'mcp-client-roots', 'implicit-skill-suppression',
    ],
  }
  for (const [host, ids] of Object.entries(citedCapabilities)) {
    for (const id of ids) {
      assert.ok(hostInventories[host].capabilities[id], `the ${host} issue-stage profile cites capability ${id}, which the inventory no longer has`)
    }
  }

  console.log('route and nesting guards')
  assert.throws(
    () => assertRoute({ host: 'codex', target: 'codex', depth: 0 }),
    (error) => error.kind === 'SAME_FAMILY',
  )
  const nested = await startJob({}, { stateDir: state('nested'), extraEnv: { FLOW_DELEGATION_DEPTH: '1' } })
  assert.equal(nested.status, 'failed')
  assert.equal(nested.error.kind, 'NESTED_DELEGATION')
  const invalidTargetState = state('invalid-target')
  const invalidTargetStore = new JobStore(invalidTargetState)
  const invalidTarget = invalidTargetStore.createJob({
    traceId: 'invalid-target', host: 'claude', target: 'other', depth: 0, mode: 'task', access: 'read-only',
    cwd: repo, workspaceKey: repo, model: 'gpt-5.6-luna', effort: 'low',
    timeBudgetSeconds: 30, prompt: 'never start', outputSchema: null,
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
  // A root inside the repository does not widen into the repository. The job's cwd is the root
  // itself, so it passes the cwd check and dies on the worktree root, which sits above it.
  const nestedRead = await startJob({ prompt: 'nested read', cwd: nestedDir }, { stateDir: state('nested-read'), roots: [nestedDir] })
  assert.equal(nestedRead.status, 'failed')
  assert.equal(nestedRead.error.kind, 'OUTSIDE_ROOTS')
  const widenedWrite = await startJob({ prompt: 'nested write', cwd: nestedDir, access: 'workspace-write' }, { stateDir: state('nested-write'), roots: [nestedDir] })
  assert.equal(widenedWrite.status, 'failed')
  assert.equal(widenedWrite.error.kind, 'OUTSIDE_ROOTS')

  console.log('redacted internal errors')
  const redactStore = new JobStore(state('redact'))
  const redactJob = redactStore.createJob({
    traceId: 't', host: 'claude', target: 'codex', depth: 0, mode: 'task', access: 'read-only',
    cwd: repo, workspaceKey: repo, model: 'gpt-5.6-luna', effort: 'low',
    timeBudgetSeconds: 30, prompt: 'x', outputSchema: null,
  })
  redactStore.recordInternalError(redactJob.id, new TypeError('stack detail stays in the journal'))
  assert.deepEqual(redactStore.events(redactJob.id).find((event) => event.type === 'internal.error').payload, { redacted: true })
  redactStore.close()
  const providerError = await startJob({ prompt: 'fail before start' }, { mode: 'provider-error', stateDir: state('provider-error') })
  assert.equal(providerError.status, 'failed')
  assert.equal(providerError.error.kind, 'APP_SERVER_ERROR')
  assert.equal(providerError.error.message, 'Codex App Server rejected a request.')
  assert.equal(providerError.error.details.code, -32603)
  assert.doesNotMatch(JSON.stringify(providerError), /test@example\.invalid|\/home\/test\/private/)
  const failedTurn = await startJob({ prompt: 'fail in turn' }, { mode: 'failed-turn', stateDir: state('failed-turn') })
  assert.equal(failedTurn.status, 'failed')
  assert.equal(failedTurn.error.kind, 'BAD_MODEL')
  assert.equal(failedTurn.error.message, 'Codex rejected the requested model.')
  assert.doesNotMatch(JSON.stringify(failedTurn), /test@example\.invalid|\/home\/test\/private|gpt-private/)
  const failedTurnDb = new DatabaseSync(join(state('failed-turn'), 'jobs.sqlite3'), { readOnly: true })
  const failedTurnJournal = failedTurnDb.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='internal.error'").get(failedTurn.jobId)
  failedTurnDb.close()
  assert.match(failedTurnJournal.payload_json, /test@example\.invalid|\/home\/test\/private|gpt-private/)
  assert.deepEqual((await eventsOf(failedTurn.jobId, {}, { stateDir: state('failed-turn') }))
    .find((event) => event.type === 'internal.error').payload, { redacted: true })

  console.log('rejected requests never reach the job table')
  // The tool schema is the only door into the service now, so a missing model is refused
  // before a request exists: no job row, no worker, no provider. The service repeats the
  // check for a caller that is not the MCP layer, and today there is no such caller.
  const noModelState = state('no-model')
  const noModel = await call('delegate_to_codex', {
    mode: 'task', prompt: 'x', cwd: repo, access: 'read-only', effort: 'low',
    delivery: 'attached', timeBudgetSeconds: 30,
  }, { stateDir: noModelState })
  assert.equal(noModel.isError, true)
  assert.match(noModel.content[0].text, /Invalid arguments.*model/s)
  assert.equal(jobCount(noModelState), 0)
  // The host is the server's own argument and never tool input, so an unknown one is refused
  // before a session exists at all.
  for (const host of [null, 'gemini']) {
    const refused = spawnSync(process.execPath, [bundle, 'mcp', ...(host ? ['--host', host] : [])], {
      cwd: repo, encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(refused.status, 2, String(host))
    assert.match(refused.stderr, /--host is required/, String(host))
  }

  console.log('writer lease, cancel, steer, and continuation')
  const leaseState = state('lease')
  const first = await startJob({ prompt: 'slow write', access: 'workspace-write', delivery: 'detached' }, { mode: 'slow', stateDir: leaseState })
  await delay(300)
  const activeContinuation = await continueJob(first.jobId, { prompt: 'too early' }, { stateDir: leaseState })
  assert.equal(activeContinuation.status, 'failed')
  assert.equal(activeContinuation.error.kind, 'JOB_STATE')
  const second = await startJob({ prompt: 'second write', access: 'workspace-write', delivery: 'detached' }, { mode: 'slow', stateDir: leaseState })
  const blocked = await waitFor(second.jobId, leaseState, 'failed')
  assert.equal(blocked.error.kind, 'WORKSPACE_BUSY')
  await waitFor(first.jobId, leaseState, 'succeeded')

  const cancelState = state('cancel')
  const cancellable = await startJob({ prompt: 'wait', delivery: 'detached' }, { mode: 'slow', stateDir: cancelState })
  await delay(300)
  await cancelJob(cancellable.jobId, { stateDir: cancelState })
  await waitFor(cancellable.jobId, cancelState, 'cancelled')

  const queuedState = state('queued-cancel')
  const queuedStore = new JobStore(queuedState)
  const queued = queuedStore.createJob({
    traceId: 'queued-cancel', parentJobId: null, host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'read-only', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low',
    timeBudgetSeconds: 30, prompt: 'never start', outputSchema: null, baseSha: null, headSha: null,
  })
  const cancelledQueued = queuedStore.requestCancel(queued.id)
  assert.equal(cancelledQueued.status, 'cancelled')
  assert.equal(cancelledQueued.prompt, null)

  const missingIdentity = queuedStore.createJob({
    traceId: 'missing-identity', parentJobId: null, host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'read-only', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low',
    timeBudgetSeconds: 30, prompt: 'never start', outputSchema: null, baseSha: null, headSha: null,
  })
  assert.throws(() => queuedStore.claim(missingIdentity.id, process.pid, null), (error) => error.kind === 'WORKER_IDENTITY')

  const terminalRace = queuedStore.createJob({
    traceId: 'terminal-race', parentJobId: null, host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'read-only', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low',
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
  const steerable = await startJob({ prompt: 'wait', delivery: 'detached' }, { mode: 'steer', stateDir: steerState })
  await delay(300)
  await steerJob(steerable.jobId, 'new direction', { stateDir: steerState })
  const steered = await waitFor(steerable.jobId, steerState, 'succeeded')
  assert.equal(steered.output, 'STEERED: new direction')
  const steerDb = new DatabaseSync(join(steerState, 'jobs.sqlite3'), { readOnly: true })
  assert.equal(steerDb.prepare(`SELECT payload_json FROM controls WHERE job_id=? AND type='steer'`).get(steerable.jobId).payload_json, '{}')
  steerDb.close()

  const continued = await continueJob(happy.jobId, { prompt: 'Continue' }, { stateDir: state('happy') })
  assert.equal(continued.status, 'succeeded')
  assert.equal(continued.threadId, happy.threadId)

  console.log('duplicate worker claim')
  const duplicateState = state('duplicate-worker')
  const owned = await startJob({ prompt: 'slow write', access: 'workspace-write', delivery: 'detached' }, { mode: 'slow', stateDir: duplicateState })
  let beforeDuplicate = await statusOf(owned.jobId, { stateDir: duplicateState })
  for (let i = 0; i < 40 && beforeDuplicate.status !== 'running'; i++) {
    await delay(50)
    beforeDuplicate = await statusOf(owned.jobId, { stateDir: duplicateState })
  }
  assert.equal(beforeDuplicate.status, 'running')
  const duplicateWorker = spawnSync(process.execPath, [bundle, 'worker', '--job', owned.jobId, '--state-dir', duplicateState], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, FLOW_DELEGATION_CODEX_BIN: fake, FLOW_FAKE_MODE: 'slow' },
  })
  assert.equal(duplicateWorker.status, 1)
  const afterDuplicate = await statusOf(owned.jobId, { stateDir: duplicateState })
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
    model: 'gpt-5.6-luna', effort: 'low',
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
    model: 'gpt-5.6-luna', effort: 'low',
    timeBudgetSeconds: 30, prompt: 'blocked', outputSchema: null,
  })
  assert.throws(
    () => quarantineStore.claim(blockedJob.id, process.pid, processStartToken(process.pid)),
    (error) => error.kind === 'WORKSPACE_BUSY',
  )
  quarantineStore.close()
  const quarantined = await statusOf(quarantinedJob.id, { stateDir: quarantineState })
  assert.equal(quarantined.status, 'quarantined')
  assert.equal(quarantined.quarantine.resumeStatus, 'unknown')
  assert.equal(quarantined.quarantine.trackedProcesses, 1)
  const quarantineCancel = await cancelJob(quarantinedJob.id, { stateDir: quarantineState })
  assert.equal(quarantineCancel.status, 'failed')
  assert.equal(quarantineCancel.error.kind, 'JOB_QUARANTINED')
  // The refusal names what is still alive, so the human reading it can go and look.
  assert.deepEqual(quarantineCancel.error.details.live, [{ kind: 'process', id: provider.pid }])
  provider.kill('SIGKILL')
  await new Promise((resolve) => provider.once('exit', resolve))
  const released = await statusOf(quarantinedJob.id, { stateDir: quarantineState })
  assert.equal(released.status, 'unknown')
  assert.equal(released.quarantine, null)
  const releasedStore = new JobStore(quarantineState)
  assert.equal(releasedStore.db.prepare('SELECT COUNT(*) AS count FROM leases').get().count, 0)
  releasedStore.claim(blockedJob.id, process.pid, processStartToken(process.pid))
  releasedStore.finish(blockedJob.id, 'cancelled')
  releasedStore.close()

  // A quarantine with nothing left to observe cannot clear itself: a status read has no
  // identity to check, so the job stays quarantined and its write lease stays held forever.
  // Cancelling is the way out, and it ends the job as unknown because nothing proved what the
  // accepted write turn did.
  const strandedState = state('quarantine-stranded')
  const strandedStore = new JobStore(strandedState)
  const strandedJob = strandedStore.createJob({
    traceId: 'stranded', host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'workspace-write', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low',
    timeBudgetSeconds: 30, prompt: 'stranded', outputSchema: null,
  })
  strandedStore.claim(strandedJob.id, process.pid, processStartToken(process.pid))
  strandedStore.quarantine(strandedJob.id, 'reconciling', {
    error: { kind: 'PROVIDER_QUARANTINED', message: 'test quarantine with no identities', details: null },
  })
  assert.equal(strandedStore.db.prepare('SELECT COUNT(*) AS count FROM leases').get().count, 1)
  strandedStore.close()
  const stillQuarantined = await statusOf(strandedJob.id, { stateDir: strandedState })
  assert.equal(stillQuarantined.status, 'quarantined')
  assert.equal(stillQuarantined.quarantine.trackedProcesses, 0)
  const cleared = await cancelJob(strandedJob.id, { stateDir: strandedState })
  assert.equal(cleared.status, 'unknown', JSON.stringify(cleared))
  assert.equal(cleared.quarantine, null)
  const clearedStore = new JobStore(strandedState)
  assert.equal(clearedStore.db.prepare('SELECT COUNT(*) AS count FROM leases').get().count, 0)
  // The lease is free, so the next write job on that worktree can claim it.
  const nextWrite = clearedStore.createJob({
    traceId: 'after-stranded', host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'workspace-write', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low',
    timeBudgetSeconds: 30, prompt: 'after stranded', outputSchema: null,
  })
  clearedStore.claim(nextWrite.id, process.pid, processStartToken(process.pid))
  clearedStore.finish(nextWrite.id, 'cancelled')
  clearedStore.close()

  console.log('stale workers quarantine live providers before recovery')
  const crashQuarantineState = state('crash-quarantine')
  const crashQuarantineStore = new JobStore(crashQuarantineState)
  const crashedJob = crashQuarantineStore.createJob({
    traceId: 'crash-quarantine', parentJobId: null, host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'workspace-write', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low',
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
  const crashQuarantined = await statusOf(crashedJob.id, { stateDir: crashQuarantineState })
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
  const crashRecovered = await statusOf(crashedJob.id, { stateDir: crashQuarantineState })
  assert.equal(crashRecovered.status, 'succeeded')
  assert.equal(crashRecovered.output, 'RECOVERED')
  const crashReleasedDb = new DatabaseSync(join(crashQuarantineState, 'jobs.sqlite3'), { readOnly: true })
  assert.equal(crashReleasedDb.prepare('SELECT COUNT(*) AS count FROM leases').get().count, 0)
  crashReleasedDb.close()

  console.log('unexpected approval and stale-job recovery')
  const approval = await startJob({ prompt: 'Ask for approval' }, { mode: 'approval', stateDir: state('approval') })
  assert.equal(approval.status, 'awaiting_approval')
  assert.equal(approval.error.kind, 'APPROVAL_REQUIRED')
  const permissionsApproval = await startJob({ prompt: 'Ask for permissions' }, { mode: 'permissions-approval', stateDir: state('permissions-approval') })
  assert.equal(permissionsApproval.status, 'awaiting_approval')
  assert.equal(permissionsApproval.error.kind, 'APPROVAL_REQUIRED')
  assert.ok(permissionsApproval.usage?.total)

  const missingCodex = await startJob({ prompt: 'cannot start' }, {
    stateDir: state('missing-codex'),
    extraEnv: { FLOW_DELEGATION_CODEX_BIN: join(temp, 'codex-does-not-exist') },
  })
  assert.equal(missingCodex.status, 'failed')
  assert.equal(missingCodex.error.kind, 'CODEX_NOT_INSTALLED')

  const leakedMcp = await startJob({ prompt: 'must not run' }, { mode: 'mcp-leak', stateDir: state('mcp-leak') })
  assert.equal(leakedMcp.status, 'failed')
  assert.equal(leakedMcp.error.kind, 'MCP_ISOLATION')
  assert.equal(leakedMcp.threadId, null)

  const malformedProtocol = await startJob({ prompt: 'must not run' }, {
    mode: 'malformed-protocol', stateDir: state('malformed-protocol'),
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
  const acceptedCrash = await startJob({ prompt: 'accepted before transport loss', access: 'workspace-write' }, {
    mode: 'accepted-crash', stateDir: acceptedCrashState,
  })
  assert.equal(acceptedCrash.status, 'unknown')
  const acceptedCrashDb = new DatabaseSync(join(acceptedCrashState, 'jobs.sqlite3'), { readOnly: true })
  const acceptedCrashRow = acceptedCrashDb.prepare('SELECT native_turn_id, turn_accepted_at, prompt FROM jobs WHERE id=?').get(acceptedCrash.jobId)
  acceptedCrashDb.close()
  assert.ok(acceptedCrashRow.native_turn_id)
  assert.ok(acceptedCrashRow.turn_accepted_at)
  assert.equal(acceptedCrashRow.prompt, null)

  const midturnRead = await startJob({ prompt: 'crash after acceptance' }, { mode: 'midturn-crash', stateDir: state('midturn-read') })
  assert.equal(midturnRead.status, 'failed')
  assert.equal(midturnRead.error.kind, 'APP_SERVER_EXIT')
  const midturnWrite = await startJob({ prompt: 'crash after write acceptance', access: 'workspace-write' }, { mode: 'midturn-crash', stateDir: state('midturn-write') })
  assert.equal(midturnWrite.status, 'unknown')
  assert.equal(midturnWrite.error.kind, 'APP_SERVER_EXIT')

  const detachedCommand = await startJob({ prompt: 'start a detached command' }, {
    mode: 'detached-command', stateDir: state('detached-command'),
  })
  assert.equal(detachedCommand.status, 'succeeded')
  await delay(1_200)
  assert.equal(existsSync(join(repo, 'codex-detached-survivor')), false)

  const recoveryState = state('recovery')
  const recoverable = await startJob({ prompt: 'complete' }, { stateDir: recoveryState })
  const recoveryDb = new DatabaseSync(join(recoveryState, 'jobs.sqlite3'))
  recoveryDb.prepare(`UPDATE jobs SET status='running', output=NULL, structured_json=NULL, error_json=NULL,
    heartbeat_at=0, worker_pid=99999999, native_turn_id='recovered' WHERE id=?`).run(recoverable.jobId)
  recoveryDb.close()
  const recovered = await statusOf(recoverable.jobId, { stateDir: recoveryState })
  assert.equal(recovered.status, 'succeeded')
  assert.equal(recovered.output, 'RECOVERED')

  const reusedPidState = state('recovery-pid-reuse')
  const reusedPid = await startJob({ prompt: 'complete' }, { stateDir: reusedPidState })
  const reusedPidDb = new DatabaseSync(join(reusedPidState, 'jobs.sqlite3'))
  reusedPidDb.prepare(`UPDATE jobs SET status='running', output=NULL, structured_json=NULL, error_json=NULL,
    heartbeat_at=0, worker_pid=?, native_turn_id='recovered' WHERE id=?`).run(process.pid, reusedPid.jobId)
  const nextSeq = reusedPidDb.prepare('SELECT MAX(seq) + 1 AS seq FROM events WHERE job_id=?').get(reusedPid.jobId).seq
  reusedPidDb.prepare(`INSERT INTO events (job_id, seq, type, payload_json, created_at) VALUES (?, ?, 'job.starting', ?, ?)`).run(
    reusedPid.jobId, nextSeq, JSON.stringify({ pid: process.pid, startToken: 'reused-process-token' }), Date.now(),
  )
  reusedPidDb.close()
  const recoveredFromReusedPid = await statusOf(reusedPid.jobId, { stateDir: reusedPidState })
  assert.equal(recoveredFromReusedPid.status, 'succeeded')
  assert.equal(recoveredFromReusedPid.output, 'RECOVERED')

  const unknownState = state('recovery-unknown')
  const unknownWrite = await startJob({ prompt: 'complete', access: 'workspace-write' }, { stateDir: unknownState })
  const unknownDb = new DatabaseSync(join(unknownState, 'jobs.sqlite3'))
  unknownDb.prepare(`UPDATE jobs SET status='running', output=NULL, structured_json=NULL, error_json=NULL,
    heartbeat_at=0, worker_pid=99999999, native_turn_id='recovered', turn_accepted_at=1 WHERE id=?`).run(unknownWrite.jobId)
  unknownDb.close()
  const unknown = await statusOf(unknownWrite.jobId, { stateDir: unknownState, mode: 'recovery-in-progress' })
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.error.kind, 'RECOVERY_UNKNOWN')

  const missingTurnState = state('recovery-missing-turn')
  const missingTurn = await startJob({ prompt: 'complete' }, { stateDir: missingTurnState })
  const missingTurnDb = new DatabaseSync(join(missingTurnState, 'jobs.sqlite3'))
  missingTurnDb.prepare(`UPDATE jobs SET status='running', output=NULL, structured_json=NULL, error_json=NULL,
    heartbeat_at=0, worker_pid=99999999, native_turn_id=NULL, turn_accepted_at=NULL WHERE id=?`).run(missingTurn.jobId)
  missingTurnDb.close()
  const notMisattributed = await statusOf(missingTurn.jobId, { stateDir: missingTurnState })
  assert.equal(notMisattributed.status, 'unknown')
  assert.equal(notMisattributed.error.kind, 'RECOVERY_UNKNOWN')
  const unknownContinuation = await continueJob(missingTurn.jobId, { prompt: 'unsafe continuation' }, { stateDir: missingTurnState })
  assert.equal(unknownContinuation.status, 'failed')
  assert.equal(unknownContinuation.error.kind, 'UNKNOWN_JOB')

  console.log('recovered turn classification')
  const recoveredOutcome = async (name, mode, { cancelRequested = false } = {}) => {
    const stateDir = state(name)
    const job = await startJob({ prompt: 'complete' }, { stateDir })
    const db = new DatabaseSync(join(stateDir, 'jobs.sqlite3'))
    db.prepare(`UPDATE jobs SET status='running', output=NULL, structured_json=NULL, error_json=NULL,
      heartbeat_at=0, worker_pid=99999999, native_turn_id='recovered' WHERE id=?`).run(job.jobId)
    if (cancelRequested) {
      db.prepare(`INSERT INTO controls (job_id, type, payload_json, created_at) VALUES (?, 'cancel', '{}', ?)`)
        .run(job.jobId, Date.now())
    }
    db.close()
    return statusOf(job.jobId, { stateDir, mode })
  }
  const interruptedRecovery = await recoveredOutcome('recovery-interrupted', 'recovery-interrupted')
  assert.equal(interruptedRecovery.status, 'failed')
  assert.equal(interruptedRecovery.error.kind, 'INTERRUPTED')
  const cancelledRecovery = await recoveredOutcome('recovery-cancelled', 'recovery-interrupted', { cancelRequested: true })
  assert.equal(cancelledRecovery.status, 'cancelled')
  assert.equal(cancelledRecovery.error, null)
  const emptyRecovery = await recoveredOutcome('recovery-empty', 'recovery-empty')
  assert.equal(emptyRecovery.status, 'failed')
  assert.equal(emptyRecovery.error.kind, 'EMPTY_OUTPUT')
  const oddRecovery = await recoveredOutcome('recovery-odd', 'recovery-odd')
  assert.equal(oddRecovery.status, 'unknown')
  assert.equal(oddRecovery.error.kind, 'UNKNOWN_TURN')

  console.log('concurrent opens, retention, and the schema reset')
  const raceState = state('migration-race')
  const raceStartAt = Date.now() + 1_500
  const raced = await Promise.all(Array.from({ length: 8 }, () => openStoreInChild(raceState, raceStartAt)))
  assert.deepEqual(raced.map((child) => child.code), raced.map(() => 0), raced.map((child) => child.stderr).join('\n'))

  const retentionState = state('retention')
  const retentionStore = new JobStore(retentionState)
  const seedJob = (traceId, extra = {}) => retentionStore.createJob({
    traceId, parentJobId: null, host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'read-only', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low',
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

  // An older schema, and the legacy database that a reset is safe on: every row in it is
  // terminal. The job cache is 14 days of operational history and never an archive, so the
  // store drops it and recreates the current schema rather than carrying a migration ladder
  // for rows nobody is going to read. What has to survive is the store: it opens, it reports
  // the current version, and the next job works.
  const LEGACY_SCHEMA = `
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
      status TEXT NOT NULL,
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
    PRAGMA user_version=1;
  `
  // A version-1 database with the rows a case needs. `lease` gives the job the write lease on
  // the repository, which is the thing a reset would silently hand to somebody else.
  const writeLegacyStore = (dir, rows) => {
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'jobs.sqlite3'))
    db.exec(LEGACY_SCHEMA)
    const at = Date.now()
    const insertJob = db.prepare(`INSERT INTO jobs (
      id, trace_id, parent_job_id, host, target, depth, mode, access, delivery,
      cwd, workspace_key, model, effort, service_tier, profile, time_budget_seconds,
      prompt, status, created_at, updated_at, heartbeat_at
    ) VALUES (?, 'legacy-trace', NULL, 'claude', 'codex', 0, 'task', 'workspace-write', 'detached',
      ?, ?, 'gpt-5.6-luna', 'low', 'default', 'standard', 900, 'legacy prompt', ?, ?, ?, ?)`)
    const insertLease = db.prepare('INSERT INTO leases (workspace_key, job_id, heartbeat_at) VALUES (?, ?, ?)')
    for (const row of rows) {
      insertJob.run(row.id, repo, repo, row.status, at, at, at)
      if (row.lease) insertLease.run(repo, row.id, at)
    }
    db.close()
  }
  const legacyState = state('legacy')
  writeLegacyStore(legacyState, [
    { id: 'legacy-done', status: 'succeeded' },
    { id: 'legacy-failed', status: 'failed' },
    { id: 'legacy-cancelled', status: 'cancelled' },
  ])
  const upgraded = new JobStore(legacyState)
  const columnsOf = (table) => upgraded.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)
  assert.equal(upgraded.userVersion(), 6)
  assert.equal(upgraded.getJob('legacy-done'), null)
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS jobs FROM jobs').get().jobs, 0)
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS leases FROM leases').get().leases, 0)
  for (const dead of ['delivery', 'service_tier', 'profile']) {
    assert.ok(!columnsOf('jobs').includes(dead), dead)
  }
  for (const live of ['max_turns', 'provider_processes_json', 'provider_scope']) {
    assert.ok(columnsOf('jobs').includes(live), live)
  }
  assert.ok(!columnsOf('leases').includes('heartbeat_at'))
  // The route index went with delegation_list. Nothing orders jobs by (host, target,
  // created_at) any more, and an index no query uses is write cost for nothing.
  assert.deepEqual(upgraded.db.prepare('PRAGMA index_list(jobs)').all()
    .map((index) => index.name).filter((name) => !name.startsWith('sqlite_')), ['jobs_status_idx'])
  const afterReset = upgraded.createJob({
    traceId: 'after-reset', host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'read-only', cwd: repo, workspaceKey: repo,
    model: 'gpt-5.6-luna', effort: 'low', timeBudgetSeconds: 30, prompt: 'after reset', outputSchema: null,
  })
  assert.equal(upgraded.getJob(afterReset.id).status, 'queued')
  upgraded.close()

  // The same reset, refused. A detached worker or a provider process outlives the MCP process
  // that started it, so an upgrade can land while a workspace-write job is still running. That
  // job's row carries its lease on the worktree, and dropping the row hands the worktree to the
  // next job without anyone proving the old provider dead. Nothing here can prove that, so the
  // store refuses to open and says what to do about it.
  for (const status of ['running', 'queued', 'starting', 'reconciling', 'awaiting_approval', 'quarantined', 'unknown']) {
    const blockedState = state(`legacy-live-${status}`)
    writeLegacyStore(blockedState, [{ id: 'legacy-live', status, lease: true }])
    assert.throws(() => new JobStore(blockedState), (error) => {
      assert.equal(error.kind, 'STORE_UPGRADE_BLOCKED')
      assert.match(error.message, /1 unfinished job\b/)
      assert.match(error.message, /cancel them with the previous Flow version/)
      return true
    }, status)
    // Refused means untouched: same schema version, same rows, same lease. A partial reset
    // that dropped the lease and then threw would be worse than either outcome.
    const survivor = new DatabaseSync(join(blockedState, 'jobs.sqlite3'))
    assert.equal(Number(survivor.prepare('PRAGMA user_version').get().user_version), 1)
    assert.equal(survivor.prepare('SELECT status FROM jobs WHERE id=?').get('legacy-live').status, status)
    assert.equal(Number(survivor.prepare('SELECT COUNT(*) AS leases FROM leases').get().leases), 1)
    assert.ok(survivor.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get())
    survivor.close()
  }
  // One live job among terminal ones is still one live job, and the count says so.
  const mixedState = state('legacy-mixed')
  writeLegacyStore(mixedState, [
    { id: 'legacy-done', status: 'succeeded' },
    { id: 'legacy-live-a', status: 'running', lease: true },
    { id: 'legacy-live-b', status: 'quarantined' },
  ])
  assert.throws(() => new JobStore(mixedState), (error) =>
    error.kind === 'STORE_UPGRADE_BLOCKED' && /2 unfinished jobs\b/.test(error.message))

  // A NEWER schema is refused rather than reset. That database belongs to a Flow version this
  // one cannot read, and its jobs may still be running.
  const newerState = state('schema-newer')
  new JobStore(newerState).close()
  const newerDb = new DatabaseSync(join(newerState, 'jobs.sqlite3'))
  newerDb.exec('PRAGMA user_version=99;')
  newerDb.close()
  assert.throws(() => new JobStore(newerState), (error) => error.kind === 'DATABASE_NEWER')

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
  // The whole tool set, asserted as a set: an addition has to be a decision, not a diff nobody
  // noticed. delegation_steer is here because the target is Codex, the one family that can
  // take text mid-turn.
  assert.deepEqual(names.sort(), [
    'delegate_to_codex', 'delegation_cancel', 'delegation_continue', 'delegation_doctor',
    'delegation_events', 'delegation_result', 'delegation_status', 'delegation_steer',
  ])
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
  // A job whose workspace sits outside the client's roots is invisible to every tool that
  // takes a job ID, not just to the one that reads it.
  const hiddenCwd = join(temp, 'hidden-job')
  mkdirSync(hiddenCwd)
  const hiddenStore = new JobStore(mcpState)
  const hiddenJob = hiddenStore.createJob({
    traceId: 'hidden-job', host: 'claude', target: 'codex', depth: 0,
    mode: 'task', access: 'read-only', cwd: hiddenCwd, workspaceKey: hiddenCwd,
    model: 'gpt-5.6-luna', effort: 'low',
    timeBudgetSeconds: 30, prompt: 'hidden', outputSchema: null,
  })
  hiddenStore.close()
  for (const [tool, input] of [
    ['delegation_status', { jobId: hiddenJob.id }],
    ['delegation_result', { jobId: hiddenJob.id }],
    ['delegation_events', { jobId: hiddenJob.id }],
    ['delegation_steer', { jobId: hiddenJob.id, text: 'hidden' }],
    ['delegation_continue', { jobId: hiddenJob.id, prompt: 'hidden' }],
    ['delegation_cancel', { jobId: hiddenJob.id }],
  ]) {
    const deniedHiddenJob = await client.callTool(tool, input, { timeout: 30_000 })
    assert.equal(deniedHiddenJob.isError, true, tool)
    assert.equal(deniedHiddenJob.structuredContent.error.kind, 'OUTSIDE_ROOTS', tool)
  }
  const doctorResult = await client.callTool('delegation_doctor', { cwd: repo }, { timeout: 30_000 })
  assert.equal(doctorResult.structuredContent.ok, true)
  assert.equal(doctorResult.structuredContent.checks.workspace.ok, true)
  assert.equal(doctorResult.structuredContent.checks.containment.mode, 'systemd-scope')
  assert.equal(doctorResult.structuredContent.checks.mcpIsolation.ok, true)
  assert.equal(doctorResult.structuredContent.checks.restrictedPermissions.ok, true)
  assert.equal(doctorResult.structuredContent.checks.restrictedPermissions.profile, 'flow_delegation')
  assert.equal(doctorResult.structuredContent.mcp.client.name, 'flow-smoke')
  assert.equal(doctorResult.structuredContent.mcp.capabilities.roots.listChanged, true)
  // The live operand for a version-drift check against hostCapabilities.verifiedAgainst. It is a
  // top-level field, beside that record rather than buried under mcp, and it repeats what this
  // client's initialize sent: name flow-smoke, version 1.0.0.
  assert.deepEqual(doctorResult.structuredContent.client, { name: 'flow-smoke', version: '1.0.0' })
  const doctorHostCapabilities = doctorResult.structuredContent.hostCapabilities
  assert.equal(doctorHostCapabilities.schemaVersion, 1)
  assert.equal(doctorHostCapabilities.host, 'claude')
  assert.equal(doctorHostCapabilities.capabilities['hook-deny'].supported, true)
  assert.equal(doctorResult.structuredContent.checks.hostCapabilities, undefined, 'the inventory is a sibling of checks, not a check')
  // Every drift status, on synthetic operands, because the live doctor can only ever show one of
  // them. The record is "<product> <version>" and the comparison uses the version half, so a
  // record that stops splitting that way reads unknown rather than quietly passing.
  const record = capabilitiesForHost('claude').verifiedAgainst
  assert.equal(record.split(' ').length, 2, `verifiedAgainst ${JSON.stringify(record)} is not "<product> <version>"`)
  const recordedVersion = record.split(' ')[1]
  assert.equal(capabilityDrift(recordedVersion, record).status, 'match')
  assert.equal(capabilityDrift('9.9.9', record).status, 'newer')
  assert.equal(capabilityDrift('0.0.1', record).status, 'older')
  assert.equal(capabilityDrift(null, record).status, 'unknown')
  assert.equal(capabilityDrift(recordedVersion, null).status, 'unknown')
  assert.equal(capabilityDrift('not-a-version', record).status, 'unknown')
  assert.equal(capabilityDrift(record, record).status, 'match', 'a product-qualified operand still compares on its version')
  // Field order in a version is significant and 10 sorts above 9, so this is a number compare
  // and not a string one.
  assert.equal(capabilityDrift('2.10.0', 'x 2.9.0').status, 'newer')
  assert.equal(capabilityDrift('2.9.0', 'x 2.10.0').status, 'older')
  assert.equal(capabilityDrift('2.1', 'x 2.1.0').status, 'match', 'a missing field reads as zero')
  assert.deepEqual(capabilityDrift(recordedVersion, record), { installed: recordedVersion, verifiedAgainst: recordedVersion, status: 'match' })
  // The doctor result carries the same verdict, computed by the service. flow-smoke 1.0.0 is not
  // the version the claude record names, so this one reads older.
  assert.deepEqual(doctorHostCapabilities.drift, { installed: '1.0.0', verifiedAgainst: recordedVersion, status: 'older' })
  // Unsupported entries are inventory, not failures. Doctor stays ok while they are present.
  assert.ok(Object.values(doctorHostCapabilities.capabilities).some((entry) => entry.supported === false))
  assert.equal(doctorResult.structuredContent.ok, true)
  await client.close()

  // PWD is set here on purpose. The Claude host has real roots and CLAUDE_PROJECT_DIR, so it must
  // never fall back to the launch shell's cwd; the same environment that gives a Codex host a
  // workspace below still has to fail NO_ROOTS on this one.
  const noRootsClient = new McpStdioClient({
    command: process.execPath,
    args: [bundle, 'mcp', '--host', 'claude', '--state-dir', state('mcp-no-roots')],
    cwd: repo,
    env: {
      ...process.env,
      CODEX_PROJECT_DIR: '',
      CLAUDE_PROJECT_DIR: '',
      PWD: repo,
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
  const noRootsStart = await noRootsClient.callTool('delegate_to_codex', {
    mode: 'task', prompt: 'no roots', cwd: repo, access: 'read-only',
    model: 'gpt-5.6-luna', effort: 'low', delivery: 'attached', timeBudgetSeconds: 30,
  }, { timeout: 30_000 })
  assert.equal(noRootsStart.isError, true)
  assert.equal(noRootsStart.structuredContent.error.kind, 'NO_ROOTS')
  await noRootsClient.close()

  // Codex 0.151.0 advertises no roots capability and sets no project-dir variable, which is
  // exactly this client: no roots, both project-dir variables empty. The launch shell's PWD is
  // the only workspace signal left, so the Codex host takes it and the same call that fails on
  // the Claude host above succeeds here.
  const codexPwdClient = new McpStdioClient({
    command: process.execPath,
    args: [bundle, 'mcp', '--host', 'codex', '--state-dir', state('mcp-codex-pwd')],
    cwd: repo,
    env: {
      ...process.env,
      CODEX_PROJECT_DIR: '',
      CLAUDE_PROJECT_DIR: '',
      PWD: repo,
      FLOW_DELEGATION_CODEX_BIN: fake,
      FLOW_FAKE_MODE: 'happy',
    },
    roots: [],
  })
  // Seeded rather than started: what is under test is whether PWD resolves to a workspace the
  // job's cwd sits inside, and reading a job back proves that without a provider turn.
  const pwdSeed = new JobStore(state('mcp-codex-pwd'))
  const pwdJob = pwdSeed.createJob({
    traceId: 'codex-pwd', host: 'codex', target: 'claude', depth: 0,
    mode: 'task', access: 'read-only', cwd: repo, workspaceKey: repo,
    model: 'sonnet', effort: 'low', timeBudgetSeconds: 30, prompt: 'pwd', outputSchema: null,
  })
  pwdSeed.close()
  await codexPwdClient.start()
  const codexPwdRead = await codexPwdClient.callTool('delegation_status', { jobId: pwdJob.id }, { timeout: 30_000 })
  assert.equal(codexPwdRead.isError, undefined, 'the Codex host resolves a workspace from PWD')
  assert.equal(codexPwdRead.structuredContent.job.jobId, pwdJob.id)
  await codexPwdClient.close()

  const codexNoPwdClient = new McpStdioClient({
    command: process.execPath,
    args: [bundle, 'mcp', '--host', 'codex', '--state-dir', state('mcp-codex-no-pwd')],
    cwd: repo,
    env: {
      ...process.env,
      CODEX_PROJECT_DIR: '',
      CLAUDE_PROJECT_DIR: '',
      PWD: '',
      FLOW_DELEGATION_CODEX_BIN: fake,
      FLOW_FAKE_MODE: 'happy',
    },
    roots: [],
  })
  const noPwdSeed = new JobStore(state('mcp-codex-no-pwd'))
  const noPwdJob = noPwdSeed.createJob({
    traceId: 'codex-no-pwd', host: 'codex', target: 'claude', depth: 0,
    mode: 'task', access: 'read-only', cwd: repo, workspaceKey: repo,
    model: 'sonnet', effort: 'low', timeBudgetSeconds: 30, prompt: 'no pwd', outputSchema: null,
  })
  noPwdSeed.close()
  await codexNoPwdClient.start()
  const codexNoPwdRead = await codexNoPwdClient.callTool('delegation_status', { jobId: noPwdJob.id }, { timeout: 30_000 })
  assert.equal(codexNoPwdRead.isError, true)
  assert.equal(codexNoPwdRead.structuredContent.error.kind, 'NO_ROOTS')
  await codexNoPwdClient.close()

  for (const entry of readdirSync(temp, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('state-')) continue
    const jobTempRoot = join(temp, entry.name, 'tmp')
    if (existsSync(jobTempRoot)) assert.deepEqual(readdirSync(jobTempRoot), [], `${entry.name} leaked a job temporary directory`)
  }

  console.log('smoke-delegation: ALL PASS')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
