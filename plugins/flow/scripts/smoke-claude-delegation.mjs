#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { normalizeClaudeError } from '../src/delegation/claude-errors.mjs'
import { claudePolicyHook, claudeSandboxFor, sensitiveReadPaths } from '../src/delegation/claude-policy.mjs'
import { claudeSpawnCommand } from '../src/delegation/claude-launch.mjs'

const PROTOCOL_VERSION = '2025-06-18'

class McpClient {
  constructor({ command, args, cwd, env, root }) {
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.root = root
    this.pending = new Map()
    this.nextId = 1
    this.buffer = ''
    this.stderr = ''
  }

  async start() {
    this.child = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.receive(chunk))
    this.child.stdin.on('error', () => {})
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4_000) })
    this.exited = new Promise((resolve) => {
      let resolved = false
      const finish = (error, result) => {
        const pending = [...this.pending.values()]
        this.pending.clear()
        for (const request of pending) request.reject(error)
        if (!resolved) { resolved = true; resolve(result) }
      }
      this.child.once('error', (error) => finish(error, { error }))
      this.child.once('exit', (code, signal) => {
        const detail = this.stderr ? `: ${this.stderr}` : ''
        finish(new Error(`MCP server exited before replying (code ${code}, signal ${signal || 'none'})${detail}`), { code, signal })
      })
    })
    try {
      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: 'flow-claude-smoke', version: '1.0.0' },
      })
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    } catch (error) {
      await this.close()
      throw error
    }
  }

  send(value) { this.child.stdin.write(`${JSON.stringify(value)}\n`) }

  receive(chunk) {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.method && message.id !== undefined) {
        const result = message.method === 'roots/list'
          ? { roots: [{ uri: pathToFileURL(this.root).href, name: 'repo' }] }
          : {}
        this.send({ jsonrpc: '2.0', id: message.id, result })
        continue
      }
      if (message.method) continue
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    }
  }

  request(method, params, timeout = 30_000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeout)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  listTools() { return this.request('tools/list', {}) }
  callTool(name, args) { return this.request('tools/call', { name, arguments: args }) }

  async close() {
    if (this.closed || !this.child) return
    this.closed = true
    try { this.child.stdin.end() } catch {}
    const timer = this.child.exitCode === null && !this.child.signalCode
      ? setTimeout(() => this.child.kill('SIGKILL'), 5_000)
      : null
    await this.exited
    if (timer) clearTimeout(timer)
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(root, 'dist', 'delegation.mjs')
const temp = mkdtempSync(join(tmpdir(), 'flow-claude-delegation-smoke-'))
const repo = join(temp, 'repo')
const fake = join(temp, 'fake-claude.mjs')

writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('2.1.test (Claude Code)'); process.exit(0) }
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'redacted@example.invalid' }))
  process.exit(0)
}
const mode = process.env.FLOW_FAKE_CLAUDE_MODE || 'happy'
if (mode === 'assert-env') {
  if (process.env.FLOW_SMOKE_API_KEY || process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1' || !process.env.FLOW_DELEGATION_DEPTH) process.exit(19)
}
if (mode === 'schema-false') {
  const schemaIndex = args.indexOf('--json-schema')
  const schema = schemaIndex < 0 ? null : JSON.parse(args[schemaIndex + 1])
  if (JSON.stringify(schema) !== JSON.stringify({ not: {} })) process.exit(18)
}
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let sessionId = args.find((arg) => arg.startsWith('--session-id='))?.slice(13)
  || args.find((arg) => arg.startsWith('--resume='))?.slice(9)
  || randomUUID()
let pendingApproval = false
const usage = {
  input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5,
  output_tokens_details: { thinking_tokens: 0 }, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard', cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
}
const result = ({ text = 'OK from fake Claude', error = false, structured = undefined } = {}) => {
  say({
    type: 'result', subtype: 'success', duration_ms: 20, duration_api_ms: 10, is_error: error,
    num_turns: 1, stop_reason: error ? 'error' : 'end_turn', total_cost_usd: 0.001, usage,
    modelUsage: {}, permission_denials: pendingApproval ? [{ tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: {} }] : [],
    result: text, ...(structured === undefined ? {} : { structured_output: structured }),
    uuid: randomUUID(), session_id: sessionId,
  })
}
const initialize = (message) => say({
  type: 'control_response',
  response: {
    subtype: 'success', request_id: message.request_id,
    ...(mode === 'startup-empty' ? {} : { response: {
      commands: [], agents: [], output_style: 'default', available_output_styles: [],
      models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'fake', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }],
      account: { subscriptionType: 'Claude Max', apiProvider: 'firstParty', email: 'redacted@example.invalid' },
      pid: process.pid, current_permission_mode: 'dontAsk', analytics_disabled: true,
    } }),
  },
})
const initFrame = () => say({
  type: 'system', subtype: 'init', agents: [], apiKeySource: 'none', claude_code_version: '2.1.test',
  cwd: process.cwd(), tools: ['Read', 'Grep', 'Glob', 'Bash'], mcp_servers: [], model: 'claude-sonnet-5',
  permissionMode: 'dontAsk', slash_commands: [], output_style: 'default', skills: [], plugins: [],
  capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'], uuid: randomUUID(), session_id: sessionId,
})
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
    if (mode !== 'startup-slow') initialize(message)
  } else if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
    if (mode === 'interrupt-hangs') return
    say({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { still_queued: [] } } })
    if (mode === 'cancel-no-result') return setTimeout(() => process.exit(0), 10)
    result({ text: 'Interrupted', error: true })
  } else if (message.type === 'control_response' && message.response?.request_id === 'approval-1') {
    result({ text: 'Approval denied', error: true })
  } else if (message.type === 'user') {
    sessionId = message.session_id || sessionId
    initFrame()
    if (mode === 'crash') return setTimeout(() => process.exit(17), 10)
    if (mode === 'slow' || mode === 'cancel-no-result') return
    if (mode === 'interrupt-hangs') return
    if (mode === 'signal-command') {
      const code = "setTimeout(() => require('node:fs').writeFileSync('signal-survivor', 'bad'), 1000)"
      spawn(process.execPath, ['-e', code], { cwd: process.cwd(), stdio: 'ignore', detached: true }).unref()
      return
    }
    if (mode === 'detached-command') {
      const code = "setTimeout(() => require('node:fs').writeFileSync('detached-survivor', 'bad'), 1000)"
      spawn(process.execPath, ['-e', code], { cwd: process.cwd(), stdio: 'ignore', detached: true }).unref()
      return result()
    }
    if (mode === 'approval') {
      pendingApproval = true
      return say({
        type: 'control_request', request_id: 'approval-1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch denied' }, tool_use_id: 'tool-1', permission_suggestions: [] },
      })
    }
    if (mode === 'rate-limit') {
      say({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' }, uuid: randomUUID(), session_id: sessionId })
      say({ type: 'assistant', error: 'rate_limit', message: { id: 'm', role: 'assistant', content: [], model: 'claude-sonnet-5', stop_reason: null, usage }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId })
      return result({ text: 'limit reached', error: true })
    }
    const structured = mode === 'schema-good' ? { answer: 'yes' }
      : mode === 'schema-bad' ? { wrong: true }
      : undefined
    const text = structured === undefined ? 'OK from fake Claude' : JSON.stringify(structured)
    say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId })
    say({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text }], model: 'claude-sonnet-5', stop_reason: 'end_turn', usage }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId })
    result({ text, structured })
  }
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

const state = (name) => join(temp, `state-${name}`)
const cli = (args, { input = '', mode = 'happy', stateDir = state('default'), extraEnv = {} } = {}) => {
  const output = execFileSync(process.execPath, [bundle, 'cli', ...args, '--state-dir', stateDir], {
    cwd: repo,
    input,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, FLOW_DELEGATION_CLAUDE_BIN: fake, FLOW_FAKE_CLAUDE_MODE: mode, ...extraEnv },
  })
  return JSON.parse(output)
}
const runArgs = ['run', '--host', 'codex', '--cwd', repo, '--model', 'sonnet', '--effort', 'low', '--time-budget-seconds', '30']
const waitFor = async (jobId, stateDir, status) => {
  for (let attempt = 0; attempt < 80; attempt++) {
    const job = cli(['result', jobId, '--host', 'codex'], { stateDir })
    if (['succeeded', 'failed', 'cancelled', 'unknown', 'awaiting_approval'].includes(job.status)) {
      assert.equal(job.status, status)
      return job
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`job ${jobId} did not finish`)
}
const waitForActive = async (jobId, stateDir) => {
  for (let attempt = 0; attempt < 80; attempt++) {
    const job = cli(['result', jobId, '--host', 'codex'], { stateDir })
    if (['starting', 'running'].includes(job.status)) return job
    if (['failed', 'cancelled', 'unknown', 'awaiting_approval'].includes(job.status)) {
      assert.fail(`job ${jobId} became ${job.status} before reaching active state`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`job ${jobId} did not reach active state`)
}
const waitForRunning = async (jobId, stateDir) => {
  for (let attempt = 0; attempt < 80; attempt++) {
    const job = cli(['result', jobId, '--host', 'codex'], { stateDir })
    if (job.status === 'running' && job.turnId) return job
    if (['failed', 'cancelled', 'unknown', 'awaiting_approval'].includes(job.status)) {
      assert.fail(`job ${jobId} became ${job.status} before Claude accepted its turn`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`job ${jobId} did not reach running state`)
}

let mcpClient

try {
  console.log('Claude routing, models, doctor, and typed output')
  const models = cli(['models', '--host', 'codex', '--cwd', repo], { stateDir: state('models') })
  assert.equal(models[0].value, 'sonnet')
  const doctor = cli(['doctor', '--host', 'codex', '--cwd', repo], { stateDir: state('doctor') })
  assert.equal(doctor.ok, true)
  assert.equal(doctor.target, 'claude')
  assert.equal(doctor.capabilities.liveSteer, false)
  assert.equal(doctor.checks.account.authMethod, 'claude.ai')
  assert.equal(doctor.checks.agentSdk.bundled, true)

  const happy = cli(runArgs, { input: 'Reply with OK', stateDir: state('happy') })
  assert.equal(happy.status, 'succeeded')
  assert.equal(happy.host, 'codex')
  assert.equal(happy.target, 'claude')
  assert.equal(happy.output, 'OK from fake Claude')
  assert.ok(happy.threadId && happy.turnId)
  const wrongRoute = cli(['result', happy.jobId, '--host', 'claude'], { stateDir: state('happy') })
  assert.equal(wrongRoute.status, 'failed')
  assert.equal(wrongRoute.error.kind, 'ROUTE_DENIED')
  const happyDb = new DatabaseSync(join(state('happy'), 'jobs.sqlite3'), { readOnly: true })
  assert.equal(happyDb.prepare('SELECT prompt FROM jobs WHERE id=?').get(happy.jobId).prompt, null)
  happyDb.close()
  const isolatedEnv = cli(runArgs, {
    input: 'Environment isolation', mode: 'assert-env', stateDir: state('isolated-env'),
    extraEnv: { FLOW_SMOKE_API_KEY: 'not-a-real-secret' },
  })
  assert.equal(isolatedEnv.status, 'succeeded')

  const schemaFile = join(temp, 'schema.json')
  writeFileSync(schemaFile, JSON.stringify({ type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } }))
  const schemaGood = cli([...runArgs, '--schema-file', schemaFile], { input: 'JSON', mode: 'schema-good', stateDir: state('schema-good') })
  assert.deepEqual(schemaGood.structured, { answer: 'yes' })
  const schemaBad = cli([...runArgs, '--schema-file', schemaFile], { input: 'JSON', mode: 'schema-bad', stateDir: state('schema-bad') })
  assert.equal(schemaBad.status, 'failed')
  assert.equal(schemaBad.error.kind, 'SCHEMA_OUTPUT')
  const schemaMissing = cli([...runArgs, '--schema-file', schemaFile], { input: 'JSON', mode: 'happy', stateDir: state('schema-missing') })
  assert.equal(schemaMissing.status, 'failed')
  assert.equal(schemaMissing.error.kind, 'SCHEMA_OUTPUT')
  assert.equal(schemaMissing.error.message, 'Claude completed without the requested structured output.')
  const falseSchemaFile = join(temp, 'false-schema.json')
  writeFileSync(falseSchemaFile, 'false')
  const schemaFalse = cli([...runArgs, '--schema-file', falseSchemaFile], { input: 'JSON', mode: 'schema-false', stateDir: state('schema-false') })
  assert.equal(schemaFalse.status, 'failed')
  assert.equal(schemaFalse.error.kind, 'SCHEMA_OUTPUT')

  console.log('Claude effort, nesting, control, and recovery semantics')
  const minimal = cli(['run', '--host', 'codex', '--cwd', repo, '--model', 'sonnet', '--effort', 'minimal'], { input: 'x', stateDir: state('minimal') })
  assert.equal(minimal.status, 'failed')
  assert.equal(minimal.error.kind, 'BAD_REQUEST')
  const nested = cli(runArgs, { input: 'x', stateDir: state('nested'), extraEnv: { FLOW_DELEGATION_DEPTH: '1' } })
  assert.equal(nested.error.kind, 'NESTED_DELEGATION')
  const emptyStartup = cli(runArgs, { input: 'x', mode: 'startup-empty', stateDir: state('startup-empty') })
  assert.equal(emptyStartup.status, 'failed')
  assert.equal(emptyStartup.error.kind, 'CLAUDE_PROTOCOL')

  const slowState = state('slow')
  const slow = cli([...runArgs, '--detach'], { input: 'wait', mode: 'slow', stateDir: slowState })
  const steer = cli(['steer', slow.jobId, '--host', 'codex'], { input: 'redirect', stateDir: slowState })
  assert.equal(steer.status, 'failed')
  assert.equal(steer.error.kind, 'CONTROL_UNSUPPORTED')
  cli(['cancel', slow.jobId, '--host', 'codex'], { stateDir: slowState })
  await waitFor(slow.jobId, slowState, 'cancelled')
  const startupState = state('startup-slow')
  const startup = cli([...runArgs, '--detach'], { input: 'wait before init', mode: 'startup-slow', stateDir: startupState })
  await waitForActive(startup.jobId, startupState)
  cli(['cancel', startup.jobId, '--host', 'codex'], { stateDir: startupState })
  await waitFor(startup.jobId, startupState, 'cancelled')
  const noResultState = state('cancel-no-result')
  const noResult = cli([...runArgs, '--detach'], { input: 'cancel without result', mode: 'cancel-no-result', stateDir: noResultState })
  await waitForRunning(noResult.jobId, noResultState)
  cli(['cancel', noResult.jobId, '--host', 'codex'], { stateDir: noResultState })
  await waitFor(noResult.jobId, noResultState, 'cancelled')
  const noResultWriteState = state('cancel-no-result-write')
  const noResultWrite = cli([...runArgs, '--access', 'workspace-write', '--detach'], { input: 'cancel write without result', mode: 'cancel-no-result', stateDir: noResultWriteState })
  await waitForRunning(noResultWrite.jobId, noResultWriteState)
  cli(['cancel', noResultWrite.jobId, '--host', 'codex'], { stateDir: noResultWriteState })
  await waitFor(noResultWrite.jobId, noResultWriteState, 'unknown')
  const hangingInterruptState = state('interrupt-hangs')
  const hangingInterrupt = cli([...runArgs, '--detach'], { input: 'cancel while interrupt hangs', mode: 'interrupt-hangs', stateDir: hangingInterruptState })
  await waitForRunning(hangingInterrupt.jobId, hangingInterruptState)
  cli(['cancel', hangingInterrupt.jobId, '--host', 'codex'], { stateDir: hangingInterruptState })
  await waitFor(hangingInterrupt.jobId, hangingInterruptState, 'cancelled')

  if (process.platform !== 'win32') {
    const detachedCommand = cli(runArgs, { input: 'start detached command', mode: 'detached-command', stateDir: state('detached-command') })
    assert.equal(detachedCommand.status, 'succeeded')
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    assert.equal(existsSync(join(repo, 'detached-survivor')), false)

    const signalState = state('signal-command')
    const signalled = cli([...runArgs, '--access', 'workspace-write', '--detach'], {
      input: 'start command before signal', mode: 'signal-command', stateDir: signalState,
    })
    await waitForRunning(signalled.jobId, signalState)
    const signalDb = new DatabaseSync(join(signalState, 'jobs.sqlite3'), { readOnly: true })
    const workerPid = signalDb.prepare('SELECT worker_pid FROM jobs WHERE id=?').get(signalled.jobId).worker_pid
    signalDb.close()
    process.kill(workerPid, 'SIGTERM')
    await waitFor(signalled.jobId, signalState, 'unknown')
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    assert.equal(existsSync(join(repo, 'signal-survivor')), false)
  }

  const continued = cli(['continue', happy.jobId, '--host', 'codex'], { input: 'Continue', stateDir: state('happy') })
  assert.equal(continued.status, 'succeeded')
  assert.equal(continued.threadId, happy.threadId)

  const approval = cli(runArgs, { input: 'Request approval', mode: 'approval', stateDir: state('approval') })
  assert.equal(approval.status, 'awaiting_approval')
  assert.equal(approval.error.kind, 'APPROVAL_REQUIRED')
  const limited = cli(runArgs, { input: 'Rate limit', mode: 'rate-limit', stateDir: state('rate-limit') })
  assert.equal(limited.status, 'failed')
  assert.equal(limited.error.kind, 'RATE_LIMIT')

  const readCrash = cli(runArgs, { input: 'Crash', mode: 'crash', stateDir: state('read-crash') })
  assert.equal(readCrash.status, 'failed')
  const writeCrash = cli([...runArgs, '--access', 'workspace-write'], { input: 'Crash', mode: 'crash', stateDir: state('write-crash') })
  assert.equal(writeCrash.status, 'unknown')
  assert.ok(writeCrash.threadId && writeCrash.turnId)

  console.log('Claude SDK hook policy')
  assert.equal(normalizeClaudeError(new Error('Model not found')).kind, 'BAD_MODEL')
  assert.equal(normalizeClaudeError(new Error('Session not found')).kind, 'CLAUDE_SDK')
  assert.equal(normalizeClaudeError(new Error('authentication_failed')).kind, 'CLAUDE_AUTH')
  assert.equal(normalizeClaudeError(new Error('Authoring output failed')).kind, 'CLAUDE_SDK')
  const windowsBin = join(temp, 'windows-bin')
  const windowsEntrypoint = join(windowsBin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  const windowsShim = join(windowsBin, 'claude.cmd')
  mkdirSync(dirname(windowsEntrypoint), { recursive: true })
  writeFileSync(windowsShim, '@echo off\n')
  writeFileSync(windowsEntrypoint, "console.log(JSON.stringify(process.argv.slice(2)))\n")
  const dangerousSchema = '{"description":"& echo shell-injection"}'
  const windowsLaunch = claudeSpawnCommand(windowsShim, ['--json-schema', dangerousSchema], {
    platform: 'win32', nodeExecutable: process.execPath,
  })
  assert.equal(windowsLaunch.command, process.execPath)
  assert.deepEqual(
    JSON.parse(spawnSync(windowsLaunch.command, windowsLaunch.args, { encoding: 'utf8' }).stdout),
    ['--json-schema', dangerousSchema],
  )
  assert.throws(
    () => claudeSpawnCommand(join(temp, 'missing.cmd'), [], { platform: 'win32' }),
    (error) => error.kind === 'CLAUDE_STARTUP',
  )
  if (process.platform !== 'win32') {
    const emptyPathDoctor = cli(['doctor', '--host', 'codex', '--cwd', repo], {
      stateDir: state('empty-path'), extraEnv: { PATH: ':', FLOW_DELEGATION_CLAUDE_BIN: 'claude' },
    })
    assert.equal(emptyPathDoctor.checks.claude.kind, 'CLAUDE_NOT_INSTALLED')
  }
  const spawnErrorDoctor = cli(['doctor', '--host', 'codex', '--cwd', repo], {
    stateDir: state('spawn-error'), extraEnv: { FLOW_DELEGATION_CLAUDE_BIN: repo },
  })
  assert.equal(spawnErrorDoctor.checks.account.kind, 'CLAUDE_STARTUP')
  const denied = []
  const readHook = claudePolicyHook({ access: 'read-only', cwd: repo, workspaceKey: repo }, { onDenied: (value) => denied.push(value) })
  const blockedEdit = await readHook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(repo, 'a.txt') } })
  assert.equal(blockedEdit.hookSpecificOutput.permissionDecision, 'deny')
  const writeHook = claudePolicyHook({ access: 'workspace-write', cwd: repo, workspaceKey: repo }, { onDenied: (value) => denied.push(value) })
  assert.ok(sensitiveReadPaths().includes(join(homedir(), '.claude')))
  assert.ok(sensitiveReadPaths().includes(join(homedir(), '.config', 'gcloud')))
  const previousAppData = process.env.APPDATA
  process.env.APPDATA = join(temp, 'AppData')
  assert.ok(sensitiveReadPaths().includes(join(temp, 'AppData', 'gcloud')))
  if (previousAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = previousAppData
  const customCredentials = join(temp, 'provider-credentials.json')
  const previousCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS
  process.env.GOOGLE_APPLICATION_CREDENTIALS = customCredentials
  assert.ok(sensitiveReadPaths().includes(customCredentials))
  if (previousCredentials === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS
  else process.env.GOOGLE_APPLICATION_CREDENTIALS = previousCredentials
  const escapedEdit = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(temp, 'outside.txt') } })
  assert.equal(escapedEdit.hookSpecificOutput.permissionDecision, 'deny')
  const nestedCli = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'claude -p hello' } })
  assert.equal(nestedCli.hookSpecificOutput.permissionDecision, 'deny')
  const nestedSubstitution = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'value=$(claude -p hello)' } })
  assert.equal(nestedSubstitution.hookSpecificOutput.permissionDecision, 'deny')
  const nestedWrapper = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'env -i /usr/bin/codex exec hello' } })
  assert.equal(nestedWrapper.hookSpecificOutput.permissionDecision, 'deny')
  const nestedShell = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'env -i bash -lc "claude -p hello"' } })
  assert.equal(nestedShell.hookSpecificOutput.permissionDecision, 'deny')
  const nestedDash = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'dash -c "claude -p hello"' } })
  assert.equal(nestedDash.hookSpecificOutput.permissionDecision, 'deny')
  const nestedNode = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node -e "require(\\\'node:child_process\\\').spawnSync(\\\'codex\\\')"' } })
  assert.equal(nestedNode.hookSpecificOutput.permissionDecision, 'deny')
  const quotedNestedCli = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: "'claude' -p hello" } })
  assert.equal(quotedNestedCli.hookSpecificOutput.permissionDecision, 'deny')
  const concatenatedNestedCli = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: "cl''aude -p hello" } })
  assert.equal(concatenatedNestedCli.hookSpecificOutput.permissionDecision, 'deny')
  const harmlessNode = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node -e "console.log(1)"' } })
  assert.equal(harmlessNode.continue, true)
  const environmentRead = await readHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/proc/self/environ' } })
  assert.equal(environmentRead.hookSpecificOutput.permissionDecision, 'deny')
  const threadEnvironmentRead = await readHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/proc/thread-self/environ' } })
  assert.equal(threadEnvironmentRead.hookSpecificOutput.permissionDecision, 'deny')
  const environmentSearch = await readHook({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'TOKEN', path: '/proc' } })
  assert.equal(environmentSearch.hookSpecificOutput.permissionDecision, 'deny')
  const harmlessSearch = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rg codex src' } })
  assert.equal(harmlessSearch.continue, true)
  const secretRedirect = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'printf %s secret > .env' } })
  assert.equal(secretRedirect.hookSpecificOutput.permissionDecision, 'deny')
  const lockfileWriter = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'touch package-lock.json' } })
  assert.equal(lockfileWriter.hookSpecificOutput.permissionDecision, 'deny')
  const generatedWriter = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'printf %s generated | tee dist/delegation.mjs' } })
  assert.equal(generatedWriter.hookSpecificOutput.permissionDecision, 'deny')
  const sudoSecretWriter = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sudo touch .env' } })
  assert.equal(sudoSecretWriter.hookSpecificOutput.permissionDecision, 'deny')
  const wildcardSecretWriter = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm .env*' } })
  assert.equal(wildcardSecretWriter.hookSpecificOutput.permissionDecision, 'deny')
  const inlineSecretWriter = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node -e "require(\'node:fs\').writeFileSync(\'.env\', \'x\')"' } })
  assert.equal(inlineSecretWriter.hookSpecificOutput.permissionDecision, 'deny')
  const backgroundLockfileWriter = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sleep 0 & sed -i s/a/b/ package-lock.json' } })
  assert.equal(backgroundLockfileWriter.hookSpecificOutput.permissionDecision, 'deny')
  const perlLockfileWriter = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: "perl -pi -e 's/a/b/' package-lock.json" } })
  assert.equal(perlLockfileWriter.hookSpecificOutput.permissionDecision, 'deny')
  const dynamicLockfileWriter = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'target=package-lock.json; touch "$target"' } })
  assert.equal(dynamicLockfileWriter.hookSpecificOutput.permissionDecision, 'deny')
  const resolver = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm install' } })
  assert.equal(resolver.continue, true)
  const secretName = 'FLOW_SMOKE_API_KEY'
  process.env[secretName] = 'not-a-real-secret'
  const fakeCodex = join(temp, 'fake-codex')
  writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n')
  chmodSync(fakeCodex, 0o755)
  const previousClaudeBin = process.env.FLOW_DELEGATION_CLAUDE_BIN
  const previousCodexBin = process.env.FLOW_DELEGATION_CODEX_BIN
  process.env.FLOW_DELEGATION_CLAUDE_BIN = fake
  process.env.FLOW_DELEGATION_CODEX_BIN = fakeCodex
  try {
    const sandbox = claudeSandboxFor({ access: 'workspace-write', workspaceKey: repo })
    assert.deepEqual(sandbox.credentials.envVars.find((entry) => entry.name === secretName), { name: secretName, mode: 'deny' })
    assert.ok(sandbox.filesystem.denyRead.includes(realpathSync(fake)))
    assert.ok(sandbox.filesystem.denyRead.includes(realpathSync(fakeCodex)))
    if (process.platform !== 'win32') assert.ok(sandbox.filesystem.denyRead.includes('/proc'))
  } finally {
    delete process.env[secretName]
    if (previousClaudeBin === undefined) delete process.env.FLOW_DELEGATION_CLAUDE_BIN
    else process.env.FLOW_DELEGATION_CLAUDE_BIN = previousClaudeBin
    if (previousCodexBin === undefined) delete process.env.FLOW_DELEGATION_CODEX_BIN
    else process.env.FLOW_DELEGATION_CODEX_BIN = previousCodexBin
  }
  assert.equal(denied.length, 22)

  console.log('Codex-hosted MCP registration')
  const deadClient = new McpClient({ command: process.execPath, args: ['-e', 'process.exit(17)'], cwd: repo, env: process.env, root: repo })
  await assert.rejects(deadClient.start(), /MCP server exited before replying/)
  mcpClient = new McpClient({
    command: process.execPath,
    args: [bundle, 'mcp', '--host', 'codex', '--state-dir', state('mcp')],
    cwd: repo,
    env: { ...process.env, FLOW_DELEGATION_CLAUDE_BIN: fake, FLOW_FAKE_CLAUDE_MODE: 'happy', CODEX_PROJECT_DIR: repo },
    root: repo,
  })
  await mcpClient.start()
  const tools = await mcpClient.listTools()
  const names = tools.tools.map((tool) => tool.name)
  assert.ok(names.includes('delegate_to_claude'))
  assert.ok(names.includes('delegation_list'))
  assert.ok(!names.includes('delegate_to_codex'))
  const modelResult = await mcpClient.callTool('delegation_models', { cwd: repo })
  assert.equal(modelResult.structuredContent.target, 'claude')
  assert.equal(modelResult.structuredContent.capabilities.liveSteer, false)
  const delegated = await mcpClient.callTool('delegate_to_claude', {
    mode: 'task', prompt: 'MCP', cwd: repo, access: 'read-only', model: 'sonnet', effort: 'low', delivery: 'attached', timeBudgetSeconds: 30,
  })
  assert.equal(delegated.structuredContent.job.status, 'succeeded')
  const listed = await mcpClient.callTool('delegation_list', { limit: 20 })
  assert.ok(listed.structuredContent.jobs.some((job) => job.jobId === delegated.structuredContent.job.jobId))
  await mcpClient.close()

  console.log('smoke-claude-delegation: ALL PASS')
} finally {
  await mcpClient?.close().catch(() => {})
  rmSync(temp, { recursive: true, force: true })
}
