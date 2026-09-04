#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { normalizeClaudeError } from '../src/delegation/claude-errors.mjs'
import { seatPayload } from '../lib/charter-payload.mjs'
import { claudePolicyHook, claudeSandboxFor, claudeTools, sensitiveReadPaths } from '../src/delegation/claude-policy.mjs'
import { McpStdioClient } from './mcp-stdio-client.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(root, 'dist', 'delegation.mjs')
const temp = mkdtempSync(join(tmpdir(), 'flow-claude-delegation-smoke-'))
const repo = join(temp, 'repo')
const fake = join(temp, 'fake-claude.mjs')
// The SDK carries delegatedInstructions in the initialize control request, not in argv, and
// the delegated process env is allowlisted. The capture path is baked into the fake instead.
const appendOut = join(temp, 'append-system-prompt.txt')

writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const mode = process.env.FLOW_FAKE_CLAUDE_MODE || 'happy'
if (args[0] === '--version') {
  if (mode === 'probe-version-exit') {
    console.log('sensitive version output')
    console.error('/private/version/stderr')
    process.exit(23)
  }
  if (mode === 'probe-version-signal') process.kill(process.pid, 'SIGTERM')
  console.log('2.1.test (Claude Code)')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  if (mode === 'probe-auth-invalid') { console.log('not json'); process.exit(0) }
  if (mode === 'probe-auth-empty') process.exit(0)
  if (mode === 'probe-auth-logged-out') {
    console.log(JSON.stringify({ loggedIn: false, email: 'private@example.invalid' }))
    process.exit(1)
  }
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'redacted@example.invalid' }))
  process.exit(0)
}
if (mode === 'assert-env') {
  if (process.env.FLOW_SMOKE_API_KEY || process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1' || process.env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK !== '1' || process.env.CLAUDE_CODE_NO_MODEL_FALLBACK !== '1' || !process.env.FLOW_DELEGATION_DEPTH) process.exit(19)
}
if (mode === 'schema-false') {
  const schemaIndex = args.indexOf('--json-schema')
  const schema = schemaIndex < 0 ? null : JSON.parse(args[schemaIndex + 1])
  if (JSON.stringify(schema) !== JSON.stringify({ not: {} })) process.exit(18)
}
if (mode === 'schema-dialect') {
  const schemaIndex = args.indexOf('--json-schema')
  if (schemaIndex < 0) process.exit(20)
  const schema = JSON.parse(args[schemaIndex + 1])
  const hasDialect = (value) => value && typeof value === 'object'
    && (Object.prototype.hasOwnProperty.call(value, '$schema') || Object.values(value).some(hasDialect))
  if (hasDialect(schema)) process.exit(20)
}
if (mode === 'assert-limits') {
  const turns = args.indexOf('--max-turns')
  const budget = args.indexOf('--max-budget-usd')
  if (turns < 0 || args[turns + 1] !== '7' || budget < 0 || args[budget + 1] !== '0.25') process.exit(21)
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
const result = ({ text = 'OK from fake Claude', error = false, structured = undefined, subtype = 'success' } = {}) => {
  const common = {
    type: 'result', subtype, duration_ms: 20, duration_api_ms: 10, is_error: error,
    num_turns: 1, stop_reason: error ? 'error' : 'end_turn', total_cost_usd: 0.001, usage,
    modelUsage: {}, permission_denials: pendingApproval ? [{ tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: {} }] : [],
    uuid: randomUUID(), session_id: sessionId,
  }
  if (subtype === 'success') {
    say({ ...common, result: text, ...(structured === undefined ? {} : { structured_output: structured }) })
  } else {
    say({ ...common, errors: [text] })
  }
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
    if (mode === 'capture-instructions') writeFileSync(${JSON.stringify(appendOut)}, message.request.appendSystemPrompt || '')
    if (mode !== 'startup-slow') initialize(message)
  } else if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
    if (mode === 'interrupt-hangs' || mode === 'refusal-swap-hang') return
    say({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { still_queued: [] } } })
    if (mode === 'cancel-no-result') return setTimeout(() => process.exit(0), 10)
    result({ text: 'Interrupted', error: true })
  } else if (message.type === 'control_response' && message.response?.request_id === 'approval-1') {
    const allowed = message.response?.response?.behavior === 'allow'
    if (allowed) pendingApproval = false
    result({ text: allowed ? 'APPROVED' : 'Approval denied', error: !allowed })
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
      const writer = "setTimeout(() => require('node:fs').writeFileSync('detached-survivor', 'bad'), 1000)"
      const daemon = "require('node:child_process').spawn(process.execPath, ['-e', " + JSON.stringify(writer)
        + "], { cwd: process.cwd(), stdio: 'ignore', detached: true }).unref()"
      spawn(process.execPath, ['-e', daemon], { cwd: process.cwd(), stdio: 'ignore', detached: true }).unref()
      return result()
    }
    if (mode === 'approval' || mode === 'approval-long') {
      pendingApproval = true
      return say({
        type: 'control_request', request_id: 'approval-1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: mode === 'approval-long' ? 'x'.repeat(5000) : 'touch denied' }, tool_use_id: 'tool-1', permission_suggestions: [] },
      })
    }
    if (mode === 'rate-limit') {
      say({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' }, uuid: randomUUID(), session_id: sessionId })
      say({ type: 'assistant', error: 'rate_limit', message: { id: 'm', role: 'assistant', content: [], model: 'claude-sonnet-5', stop_reason: null, usage }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId })
      return result({ text: 'limit reached', error: true })
    }
    if (mode === 'billing' || mode === 'overloaded') {
      const error = mode === 'billing' ? 'billing_error' : 'overloaded'
      say({ type: 'assistant', error, message: { id: 'm', role: 'assistant', content: [], model: 'claude-sonnet-5', stop_reason: null, usage }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId })
      return result({ text: error, error: true })
    }
    if (mode === 'refusal') {
      say({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [], model: 'claude-sonnet-5', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, usage }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId })
      say({ type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'claude-sonnet-5', request_id: null, api_refusal_category: 'cyber', content: 'declined', uuid: randomUUID(), session_id: sessionId })
      return result({ text: '' })
    }
    if (mode === 'refusal-fallback') {
      say({ type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', scope: 'local', original_model: 'claude-sonnet-5', fallback_model: 'claude-opus-4-8', request_id: null, api_refusal_category: 'cyber', content: 'fell back', uuid: randomUUID(), session_id: sessionId })
      say({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'answer from the fallback' }], model: 'claude-opus-4-8', stop_reason: 'end_turn', usage }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId })
      return result({ text: 'answer from the fallback' })
    }
    if (mode === 'silent-swap') {
      say({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'answer from a model nobody asked for' }], model: 'claude-opus-4-8', stop_reason: 'end_turn', usage }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId })
      return result({ text: 'answer from a model nobody asked for' })
    }
    if (mode === 'refusal-hang') {
      // A refusal with no result frame, waiting for whoever cancels it.
      say({ type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'claude-sonnet-5', request_id: null, api_refusal_category: 'cyber', content: 'declined', uuid: randomUUID(), session_id: sessionId })
      return
    }
    if (mode === 'refusal-swap-hang') {
      // Refusal banner, then a frame from the fallback model, then nothing: the worker's own
      // interrupt gets no answer and the CLI never sends a result frame.
      say({ type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', scope: 'local', original_model: 'claude-sonnet-5', fallback_model: 'claude-opus-4-8', request_id: null, api_refusal_category: 'cyber', content: 'fell back', uuid: randomUUID(), session_id: sessionId })
      say({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'partial answer from the fallback' }], model: 'claude-opus-4-8', stop_reason: null, usage }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId })
      return
    }
    if (mode === 'swap-then-return') {
      // The wrong model answers first, the right one later. The first frame has to decide.
      say({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'from the wrong model' }], model: 'claude-opus-4-8', stop_reason: 'end_turn', usage }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId })
      return setTimeout(() => {
        say({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'from the right model' }], model: 'claude-sonnet-5', stop_reason: 'end_turn', usage }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId })
        result({ text: 'from the right model' })
      }, 400)
    }
    if (mode === 'tagged-model') {
      say({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'same model, tagged' }], model: 'claude-sonnet-5[1m]', stop_reason: 'end_turn', usage }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId })
      return result({ text: 'same model, tagged' })
    }
    if (mode === 'max-turns') return result({ text: 'turn limit', error: true, subtype: 'error_max_turns' })
    if (mode === 'max-budget') return result({ text: 'budget limit', error: true, subtype: 'error_max_budget_usd' })
    if (mode === 'schema-output-limit') return result({ text: 'schema retries exhausted', error: true, subtype: 'error_max_structured_output_retries' })
    const structured = ['schema-good', 'schema-dialect'].includes(mode) ? { answer: 'yes' }
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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SETTLED = ['succeeded', 'failed', 'cancelled', 'unknown', 'awaiting_approval', 'quarantined']

// MCP is the service's only entry mode, so this smoke calls the tools a Codex host calls: one
// server process per call, and one kept-open session for a test that polls.
const session = async (options, body) => {
  const { host = 'codex', stateDir = state('default'), mode = 'happy', extraEnv = {}, elicit = null } = options
  const client = new McpStdioClient({
    command: process.execPath,
    args: [bundle, 'mcp', '--host', host, '--state-dir', stateDir],
    cwd: repo,
    env: { ...process.env, FLOW_DELEGATION_CLAUDE_BIN: fake, FLOW_FAKE_CLAUDE_MODE: mode, ...extraEnv },
    roots: [{ uri: pathToFileURL(repo).href, name: 'repo' }],
    elicit,
  })
  await client.start()
  try { return await body(client) } finally { await client.close() }
}
const envelope = (result) => result.structuredContent?.job ?? { status: 'failed', error: result.structuredContent?.error ?? null }
const call = (name, args, options = {}) => session(options, (client) =>
  client.callTool(name, args, { timeout: options.timeout ?? 60_000 }))
const startJob = async (input = {}, options = {}) => envelope(await call('delegate_to_claude', {
  mode: 'task', cwd: repo, model: 'sonnet', effort: 'low', access: 'read-only',
  delivery: 'attached', timeBudgetSeconds: 30, prompt: 'x', ...input,
}, options))
const continueJob = async (jobId, input = {}, options = {}) => envelope(await call('delegation_continue', { jobId, delivery: 'attached', ...input }, options))
const cancelJob = async (jobId, options = {}) => envelope(await call('delegation_cancel', { jobId }, options))
const doctorOf = async (options = {}) => (await call('delegation_doctor', { cwd: repo }, options)).structuredContent
const until = (accept, describe) => (jobId, stateDir) => session({ stateDir }, async (client) => {
  for (let attempt = 0; attempt < 80; attempt++) {
    const job = envelope(await client.callTool('delegation_result', { jobId }, { timeout: 30_000 }))
    const verdict = accept(job)
    if (verdict === true) return job
    if (verdict === 'reject') assert.fail(`job ${jobId} became ${job.status} before ${describe}`)
    await delay(100)
  }
  assert.fail(`job ${jobId} did not reach ${describe}`)
})
const waitFor = async (jobId, stateDir, status) => {
  const job = await until((one) => SETTLED.includes(one.status) || null, 'a terminal state')(jobId, stateDir)
  assert.equal(job.status, status, JSON.stringify(job))
  return job
}
const waitForActive = until(
  (job) => ['starting', 'running'].includes(job.status) ? true : (SETTLED.includes(job.status) ? 'reject' : null),
  'an active state',
)
const waitForRunning = until(
  (job) => job.status === 'running' && job.turnId ? true : (SETTLED.includes(job.status) ? 'reject' : null),
  'an accepted turn',
)

try {
  console.log('Claude routing, doctor, and typed output')
  const doctor = await doctorOf({ stateDir: state('doctor') })
  assert.equal(doctor.ok, true)
  assert.equal(doctor.target, 'claude')
  assert.equal(doctor.capabilities.liveSteer, false)
  assert.equal(doctor.capabilities.limits.maxTurns, true)
  assert.equal(doctor.capabilities.limits.maxBudgetUsd, true)
  assert.equal(doctor.checks.containment.mode, 'systemd-scope')
  assert.equal(doctor.checks.account.authMethod, 'claude.ai')
  assert.equal(doctor.checks.agentSdk.bundled, true)
  assert.equal(doctor.checks.models.count, 1)
  assert.equal(Object.hasOwn(doctor.checks.claude, 'probe'), false)
  assert.equal(Object.hasOwn(doctor.checks.account, 'probe'), false)
  // The host here is Codex, so the drift operand is what `codex --version` reports on this
  // machine. A checkout with no Codex installed reads unknown, which is a stop and not a pass.
  assert.equal(doctor.hostCapabilities.host, 'codex')
  assert.ok(['match', 'newer', 'older', 'unknown'].includes(doctor.hostCapabilities.drift.status))

  const happy = await startJob({ prompt: 'Reply with OK' }, { stateDir: state('happy'), mode: 'capture-instructions' })
  assert.equal(happy.status, 'succeeded')
  assert.equal(happy.host, 'codex')
  assert.equal(happy.target, 'claude')
  assert.equal(happy.output, 'OK from fake Claude')
  assert.ok(happy.threadId && happy.turnId)
  // A Claude-target job carries the charter's seat half once, ahead of the delegated-seat block.
  const appended = readFileSync(appendOut, 'utf8')
  assert.equal((appended.match(/<flow-charter /g) || []).length, 1, 'expected exactly one charter block')
  assert.ok(appended.includes('<flow-charter scope="seat">'), 'delegated system prompt lost the seat half of the charter')
  const seat = seatPayload(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'charter', 'charter.md'), 'utf8'))
  assert.ok(appended.includes(seat), 'delegated system prompt lost the seat half verbatim')
  assert.ok(!appended.includes('## Model Rankings'), 'delegated system prompt carries the model rankings, which a leaf seat cannot act on')
  assert.ok(appended.indexOf('</flow-charter>') < appended.indexOf('<delegated-seat>'), 'the charter block must precede the delegated-seat block')
  // The other host's server owns the other route. Both hosts share one database, so a job ID
  // from this route is not authority over there.
  const wrongRoute = envelope(await call('delegation_result', { jobId: happy.jobId }, { host: 'claude', stateDir: state('happy') }))
  assert.equal(wrongRoute.status, 'failed')
  assert.equal(wrongRoute.error.kind, 'ROUTE_DENIED')
  const happyDb = new DatabaseSync(join(state('happy'), 'jobs.sqlite3'), { readOnly: true })
  assert.equal(happyDb.prepare('SELECT prompt FROM jobs WHERE id=?').get(happy.jobId).prompt, null)
  happyDb.close()
  const isolatedEnv = await startJob({ prompt: 'Environment isolation' }, {
    mode: 'assert-env', stateDir: state('isolated-env'),
    extraEnv: { FLOW_SMOKE_API_KEY: 'not-a-real-secret' },
  })
  assert.equal(isolatedEnv.status, 'succeeded')
  const bounded = await startJob({ prompt: 'Bounded task', maxTurns: 7, maxBudgetUsd: 0.25 }, {
    mode: 'assert-limits', stateDir: state('limits'),
  })
  assert.equal(bounded.status, 'succeeded')
  assert.equal(bounded.limits.maxTurns, 7)
  assert.equal(bounded.limits.maxBudgetUsd, 0.25)
  const boundedContinued = await continueJob(bounded.jobId, { prompt: 'Continue within the same limits' }, {
    mode: 'assert-limits', stateDir: state('limits'),
  })
  assert.equal(boundedContinued.status, 'succeeded')
  assert.equal(boundedContinued.limits.maxTurns, 7)
  assert.equal(boundedContinued.limits.maxBudgetUsd, 0.25)
  const maxTurns = await startJob({ prompt: 'Turn limit', maxTurns: 1 }, { mode: 'max-turns', stateDir: state('max-turns') })
  assert.equal(maxTurns.status, 'failed')
  assert.equal(maxTurns.error.kind, 'MAX_TURNS')
  const maxBudget = await startJob({ prompt: 'Budget limit', maxBudgetUsd: 0.01 }, { mode: 'max-budget', stateDir: state('max-budget') })
  assert.equal(maxBudget.status, 'failed')
  assert.equal(maxBudget.error.kind, 'MAX_BUDGET')
  const billing = await startJob({ prompt: 'Billing failure' }, { mode: 'billing', stateDir: state('billing') })
  assert.equal(billing.error.kind, 'BILLING')
  assert.match(billing.error.message, /billing problem/)
  const overloaded = await startJob({ prompt: 'Overload failure' }, { mode: 'overloaded', stateDir: state('overloaded') })
  assert.equal(overloaded.error.kind, 'OVERLOADED')
  assert.match(overloaded.error.message, /overloaded/)
  const refused = await startJob({ prompt: 'Refused turn' }, { mode: 'refusal', stateDir: state('refusal') })
  assert.equal(refused.status, 'failed')
  assert.equal(refused.error.kind, 'REFUSAL')
  assert.equal(refused.error.details.category, 'cyber')
  assert.equal(refused.error.details.fallbackModel, null)
  const fellBack = await startJob({ prompt: 'Refused then answered elsewhere' }, { mode: 'refusal-fallback', stateDir: state('refusal-fallback') })
  assert.equal(fellBack.status, 'failed', 'an answer from a fallback model is a refusal, not a success')
  assert.equal(fellBack.error.kind, 'REFUSAL')
  assert.equal(fellBack.error.details.fallbackModel, 'claude-opus-4-8')
  const swapped = await startJob({ prompt: 'Swapped without a word' }, { mode: 'silent-swap', stateDir: state('silent-swap') })
  assert.equal(swapped.status, 'failed', 'an answer from an unrequested model fails even with no refusal signal')
  assert.equal(swapped.error.kind, 'MODEL_MISMATCH')
  assert.equal(swapped.error.details.served, 'claude-opus-4-8')
  assert.equal(swapped.error.details.expected, 'claude-sonnet-5')
  const returned = await startJob({ prompt: 'Swapped, then back' }, { mode: 'swap-then-return', stateDir: state('swap-then-return') })
  assert.equal(returned.status, 'failed', 'a later frame from the requested model does not undo the swap')
  assert.equal(returned.error.kind, 'MODEL_MISMATCH')
  assert.equal(returned.error.details.served, 'claude-opus-4-8')
  const returnedEvents = (await call('delegation_events', { jobId: returned.jobId }, { stateDir: state('swap-then-return') })).structuredContent.events.map((event) => event.type)
  assert.ok(returnedEvents.includes('model.mismatch'), 'the mismatch is journaled')
  assert.ok(returnedEvents.includes('turn.interrupted'), 'the provider was interrupted on the first mismatched frame')
  assert.equal(returnedEvents.filter((type) => type === 'model.mismatch').length, 1, 'one mismatch is latched once')
  const refusedEvents = (await call('delegation_events', { jobId: fellBack.jobId }, { stateDir: state('refusal-fallback') })).structuredContent.events.map((event) => event.type)
  assert.equal(refusedEvents.filter((type) => type === 'turn.refused').length, 1, 'one refusal journals one event')
  const declinedEvents = (await call('delegation_events', { jobId: refused.jobId }, { stateDir: state('refusal') })).structuredContent.events.map((event) => event.type)
  assert.equal(declinedEvents.filter((type) => type === 'turn.refused').length, 1, 'an assistant refusal followed by its banner journals one event')
  const hung = await startJob({ prompt: 'Refused, swapped, then silence' }, { mode: 'refusal-swap-hang', stateDir: state('refusal-swap-hang') })
  assert.equal(hung.status, 'failed')
  assert.equal(hung.error.kind, 'REFUSAL', 'a known refusal outranks the missing terminal frame the interrupt caused')
  assert.equal(hung.error.details.fallbackModel, 'claude-opus-4-8')
  const tagged = await startJob({ prompt: 'Same model, context tag' }, { mode: 'tagged-model', stateDir: state('tagged-model') })
  assert.equal(tagged.status, 'succeeded', 'a context-window tag on the served model id is not a swap')
  const schemaOutputLimit = await startJob({ prompt: 'Schema retry failure' }, { mode: 'schema-output-limit', stateDir: state('schema-output-limit') })
  assert.equal(schemaOutputLimit.error.kind, 'SCHEMA_OUTPUT')
  assert.match(schemaOutputLimit.error.message, /requested schema/)

  const answerSchema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } }
  const schemaGood = await startJob({ prompt: 'JSON', outputSchema: answerSchema }, { mode: 'schema-good', stateDir: state('schema-good') })
  assert.deepEqual(schemaGood.structured, { answer: 'yes' })
  assert.ok(claudeTools('read-only', { structured: true }).includes('StructuredOutput'))
  assert.ok(!claudeTools('read-only').includes('StructuredOutput'))
  const structuredPolicy = claudePolicyHook({ access: 'read-only', cwd: repo, workspaceKey: repo, outputSchema: answerSchema })
  assert.deepEqual(await structuredPolicy({ hook_event_name: 'PreToolUse', tool_name: 'StructuredOutput', tool_input: { answer: 'yes' } }), { continue: true })
  const plainPolicy = claudePolicyHook({ access: 'read-only', cwd: repo, workspaceKey: repo, outputSchema: null })
  const plainStructured = await plainPolicy({ hook_event_name: 'PreToolUse', tool_name: 'StructuredOutput', tool_input: { answer: 'yes' } })
  assert.equal(plainStructured.hookSpecificOutput.permissionDecision, 'deny')
  const schemaDialect = await startJob({
    prompt: 'JSON',
    outputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['answer'],
      properties: { answer: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' } },
    },
  }, { mode: 'schema-dialect', stateDir: state('schema-dialect') })
  assert.deepEqual(schemaDialect.structured, { answer: 'yes' })
  const schemaBad = await startJob({ prompt: 'JSON', outputSchema: answerSchema }, { mode: 'schema-bad', stateDir: state('schema-bad') })
  assert.equal(schemaBad.status, 'failed')
  assert.equal(schemaBad.error.kind, 'SCHEMA_OUTPUT')
  const schemaMissing = await startJob({ prompt: 'JSON', outputSchema: answerSchema }, { mode: 'happy', stateDir: state('schema-missing') })
  assert.equal(schemaMissing.status, 'failed')
  assert.equal(schemaMissing.error.kind, 'SCHEMA_OUTPUT')
  assert.equal(schemaMissing.error.message, 'Claude completed without the requested structured output.')
  const schemaFalse = await startJob({ prompt: 'JSON', outputSchema: false }, { mode: 'schema-false', stateDir: state('schema-false') })
  assert.equal(schemaFalse.status, 'failed')
  assert.equal(schemaFalse.error.kind, 'SCHEMA_OUTPUT')

  console.log('Claude effort, nesting, control, and recovery semantics')
  // Codex's model catalog starts every model at 'low', so 'minimal' is not an effort either
  // family takes. The tool schema refuses it before the request exists.
  const minimal = await call('delegate_to_claude', {
    mode: 'task', prompt: 'x', cwd: repo, model: 'sonnet', effort: 'minimal',
    access: 'read-only', delivery: 'attached', timeBudgetSeconds: 30,
  }, { stateDir: state('minimal') })
  assert.equal(minimal.isError, true)
  assert.match(minimal.content[0].text, /Invalid arguments.*effort/s)
  const nested = await startJob({}, { stateDir: state('nested'), extraEnv: { FLOW_DELEGATION_DEPTH: '1' } })
  assert.equal(nested.error.kind, 'NESTED_DELEGATION')
  const emptyStartup = await startJob({}, { mode: 'startup-empty', stateDir: state('startup-empty') })
  assert.equal(emptyStartup.status, 'failed')
  assert.equal(emptyStartup.error.kind, 'CLAUDE_PROTOCOL')

  const slowState = state('slow')
  const slow = await startJob({ prompt: 'wait', delivery: 'detached' }, { mode: 'slow', stateDir: slowState })
  // There is no delegation_steer on this route. Claude has no live-steer control, and a tool
  // whose whole behaviour is a typed refusal teaches the caller nothing the capability report
  // did not already say.
  assert.equal((await session({ stateDir: slowState }, (client) => client.listTools()))
    .tools.some((tool) => tool.name === 'delegation_steer'), false)
  await cancelJob(slow.jobId, { stateDir: slowState })
  await waitFor(slow.jobId, slowState, 'cancelled')
  const startupState = state('startup-slow')
  const startup = await startJob({ prompt: 'wait before init', delivery: 'detached' }, { mode: 'startup-slow', stateDir: startupState })
  await waitForActive(startup.jobId, startupState)
  await cancelJob(startup.jobId, { stateDir: startupState })
  await waitFor(startup.jobId, startupState, 'cancelled')
  const refusedHangState = state('refusal-hang')
  const refusedHang = await startJob({ prompt: 'refused, then cancelled' , delivery: 'detached' }, { mode: 'refusal-hang', stateDir: refusedHangState })
  await waitForRunning(refusedHang.jobId, refusedHangState)
  await delay(300)
  await cancelJob(refusedHang.jobId, { stateDir: refusedHangState })
  const refusedThenCancelled = await waitFor(refusedHang.jobId, refusedHangState, 'failed')
  assert.equal(refusedThenCancelled.error.kind, 'REFUSAL', 'a cancel that races a refusal does not hide the refusal')
  assert.equal(refusedThenCancelled.error.details.category, 'cyber')
  const noResultState = state('cancel-no-result')
  const noResult = await startJob({ prompt: 'cancel without result', delivery: 'detached' }, { mode: 'cancel-no-result', stateDir: noResultState })
  await waitForRunning(noResult.jobId, noResultState)
  await cancelJob(noResult.jobId, { stateDir: noResultState })
  await waitFor(noResult.jobId, noResultState, 'cancelled')
  const noResultWriteState = state('cancel-no-result-write')
  const noResultWrite = await startJob({ prompt: 'cancel write without result', access: 'workspace-write', delivery: 'detached' }, { mode: 'cancel-no-result', stateDir: noResultWriteState })
  await waitForRunning(noResultWrite.jobId, noResultWriteState)
  await cancelJob(noResultWrite.jobId, { stateDir: noResultWriteState })
  await waitFor(noResultWrite.jobId, noResultWriteState, 'unknown')
  const hangingInterruptState = state('interrupt-hangs')
  const hangingInterrupt = await startJob({ prompt: 'cancel while interrupt hangs', delivery: 'detached' }, { mode: 'interrupt-hangs', stateDir: hangingInterruptState })
  await waitForRunning(hangingInterrupt.jobId, hangingInterruptState)
  await cancelJob(hangingInterrupt.jobId, { stateDir: hangingInterruptState })
  await waitFor(hangingInterrupt.jobId, hangingInterruptState, 'cancelled')

  const detachedCommand = await startJob({ prompt: 'start detached command' }, { mode: 'detached-command', stateDir: state('detached-command') })
  assert.equal(detachedCommand.status, 'succeeded')
  await delay(1_200)
  assert.equal(existsSync(join(repo, 'detached-survivor')), false)

  const signalState = state('signal-command')
  const signalled = await startJob({ prompt: 'start command before signal', access: 'workspace-write', delivery: 'detached' }, {
    mode: 'signal-command', stateDir: signalState,
  })
  await waitForRunning(signalled.jobId, signalState)
  const signalDb = new DatabaseSync(join(signalState, 'jobs.sqlite3'), { readOnly: true })
  const workerPid = signalDb.prepare('SELECT worker_pid FROM jobs WHERE id=?').get(signalled.jobId).worker_pid
  signalDb.close()
  process.kill(workerPid, 'SIGTERM')
  await waitFor(signalled.jobId, signalState, 'unknown')
  await delay(1_200)
  assert.equal(existsSync(join(repo, 'signal-survivor')), false)

  const continued = await continueJob(happy.jobId, { prompt: 'Continue' }, { stateDir: state('happy') })
  assert.equal(continued.status, 'succeeded')
  assert.equal(continued.threadId, happy.threadId)

  const approval = await startJob({ prompt: 'Request approval' }, { mode: 'approval', stateDir: state('approval') })
  assert.equal(approval.status, 'awaiting_approval')
  assert.equal(approval.error.kind, 'APPROVAL_REQUIRED')
  assert.equal(approval.elicitation, false)
  // The same fork put to the human through the session that started the job: the SDK's
  // permission callback waits for the form, and an accept becomes an allow.
  const forms = []
  const approved = await startJob({ prompt: 'Request approval' }, {
    mode: 'approval', stateDir: state('approval-accept'),
    elicit: (params) => { forms.push(params); return { action: 'accept', content: { decision: 'accept' } } },
  })
  assert.equal(approved.status, 'succeeded', JSON.stringify(approved))
  assert.equal(approved.output, 'APPROVED')
  assert.equal(approved.elicitation, true)
  assert.equal(forms.length, 1)
  assert.match(forms[0].message, /Delegated Claude job [0-9a-f]{8} asks for an approval[\s\S]*Bash[\s\S]*touch denied/)
  // An input the form cannot show whole, with no host-rendered title, is declined unasked.
  const oversized = await startJob({ prompt: 'Request approval' }, {
    mode: 'approval-long', stateDir: state('approval-long'), elicit: () => assert.fail('an undisclosed input must never reach the human'),
  })
  assert.equal(oversized.status, 'awaiting_approval')
  const humanRefused = await startJob({ prompt: 'Request approval' }, {
    mode: 'approval', stateDir: state('approval-decline'),
    elicit: () => ({ action: 'decline' }),
  })
  assert.equal(humanRefused.status, 'awaiting_approval')
  assert.equal(humanRefused.error.kind, 'APPROVAL_REQUIRED')
  const limited = await startJob({ prompt: 'Rate limit' }, { mode: 'rate-limit', stateDir: state('rate-limit') })
  assert.equal(limited.status, 'failed')
  assert.equal(limited.error.kind, 'RATE_LIMIT')

  const readCrash = await startJob({ prompt: 'Crash' }, { mode: 'crash', stateDir: state('read-crash') })
  assert.equal(readCrash.status, 'failed')
  const writeCrash = await startJob({ prompt: 'Crash', access: 'workspace-write' }, { mode: 'crash', stateDir: state('write-crash') })
  assert.equal(writeCrash.status, 'unknown')
  assert.ok(writeCrash.threadId && writeCrash.turnId)

  console.log('Claude SDK hook policy')
  assert.equal(normalizeClaudeError(new Error('Model not found')).kind, 'BAD_MODEL')
  assert.equal(normalizeClaudeError(new Error('Session not found')).kind, 'CLAUDE_SDK')
  assert.equal(normalizeClaudeError(new Error('authentication_failed')).kind, 'CLAUDE_AUTH')
  assert.equal(normalizeClaudeError(new Error('Authoring output failed')).kind, 'CLAUDE_SDK')
  // An empty PATH entry means the current directory to POSIX. A provider executable is never
  // taken from one, so the only claude on this PATH is no claude at all.
  const emptyPathDoctor = await doctorOf({
    stateDir: state('empty-path'), extraEnv: { PATH: ':', FLOW_DELEGATION_CLAUDE_BIN: 'claude' },
  })
  assert.equal(emptyPathDoctor.checks.claude.kind, 'CLAUDE_NOT_INSTALLED')
  const spawnErrorDoctor = await doctorOf({
    stateDir: state('spawn-error'), extraEnv: { FLOW_DELEGATION_CLAUDE_BIN: repo },
  })
  assert.equal(spawnErrorDoctor.checks.claude.kind, 'CLAUDE_STARTUP')
  assert.equal(spawnErrorDoctor.checks.claude.probe.outcome, 'spawn-error')
  assert.equal(spawnErrorDoctor.checks.claude.probe.status, null)
  assert.match(spawnErrorDoctor.checks.claude.probe.errorCode, /^(EACCES|EPERM)$/)
  assert.equal(spawnErrorDoctor.checks.account.kind, 'CLAUDE_STARTUP')
  assert.equal(spawnErrorDoctor.checks.account.probe.outcome, 'spawn-error')
  const versionExitDoctor = await doctorOf({
    stateDir: state('probe-version-exit'), mode: 'probe-version-exit',
  })
  assert.deepEqual(versionExitDoctor.checks.claude.probe, {
    outcome: 'exit-nonzero', errorCode: null, status: 23, signal: null, stdout: 'present', stderr: 'present',
  })
  assert.doesNotMatch(JSON.stringify(versionExitDoctor), /sensitive version output|private\/version/)
  const versionSignalDoctor = await doctorOf({
    stateDir: state('probe-version-signal'), mode: 'probe-version-signal',
  })
  assert.equal(versionSignalDoctor.checks.claude.kind, 'CLAUDE_STARTUP')
  assert.equal(versionSignalDoctor.checks.claude.probe.outcome, 'signal')
  assert.equal(versionSignalDoctor.checks.claude.probe.signal, 'SIGTERM')
  const invalidAuthDoctor = await doctorOf({
    stateDir: state('probe-auth-invalid'), mode: 'probe-auth-invalid',
  })
  assert.equal(invalidAuthDoctor.checks.account.kind, 'CLAUDE_AUTH')
  assert.equal(invalidAuthDoctor.checks.account.probe.outcome, 'invalid-json')
  assert.equal(invalidAuthDoctor.checks.account.probe.stdout, 'present')
  assert.doesNotMatch(JSON.stringify(invalidAuthDoctor), /not json/)
  const emptyAuthDoctor = await doctorOf({
    stateDir: state('probe-auth-empty'), mode: 'probe-auth-empty',
  })
  assert.equal(emptyAuthDoctor.checks.account.probe.outcome, 'empty-output')
  const loggedOutDoctor = await doctorOf({
    stateDir: state('probe-auth-logged-out'), mode: 'probe-auth-logged-out',
  })
  assert.equal(loggedOutDoctor.checks.account.kind, 'CLAUDE_AUTH')
  assert.equal(loggedOutDoctor.checks.account.probe.outcome, 'not-authenticated')
  assert.equal(loggedOutDoctor.checks.account.probe.status, 1)
  assert.doesNotMatch(JSON.stringify(loggedOutDoctor), /private@example\.invalid/)
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
  writeFileSync(customCredentials, '{}')
  const linkedCredentials = join(temp, 'linked-provider-credentials.json')
  symlinkSync(customCredentials, linkedCredentials)
  process.env.GOOGLE_APPLICATION_CREDENTIALS = linkedCredentials
  const configuredPaths = sensitiveReadPaths()
  assert.ok(configuredPaths.includes(linkedCredentials))
  assert.ok(configuredPaths.includes(realpathSync(linkedCredentials)))
  const previousDockerConfig = process.env.DOCKER_CONFIG
  const previousKubeconfig = process.env.KUBECONFIG
  const overrideNames = [
    'AZURE_CONFIG_DIR',
    'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    'GIT_CONFIG_GLOBAL',
    'NETRC',
    'NPM_CONFIG_USERCONFIG',
    'PIP_CONFIG_FILE',
    'TWINE_CONFIG_FILE',
  ]
  const previousOverrides = new Map(overrideNames.map((name) => [name, process.env[name]]))
  const dockerConfig = join(temp, 'docker-config')
  const kubeconfigA = join(temp, 'kube-a')
  const kubeconfigB = join(temp, 'kube-b')
  const additionalOverrides = overrideNames.map((name) => join(temp, name.toLowerCase()))
  process.env.DOCKER_CONFIG = dockerConfig
  process.env.KUBECONFIG = [kubeconfigA, kubeconfigB].join(delimiter)
  for (let index = 0; index < overrideNames.length; index++) {
    process.env[overrideNames[index]] = additionalOverrides[index]
  }
  const overridePaths = sensitiveReadPaths()
  assert.ok(overridePaths.includes(dockerConfig))
  assert.ok(overridePaths.includes(kubeconfigA))
  assert.ok(overridePaths.includes(kubeconfigB))
  for (const path of additionalOverrides) assert.ok(overridePaths.includes(path))
  process.env.GOOGLE_APPLICATION_CREDENTIALS = 'relative-provider-credentials.json'
  assert.ok(sensitiveReadPaths(repo).includes(join(repo, 'relative-provider-credentials.json')))
  const relativeCredentialRead = await readHook({
    hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'relative-provider-credentials.json' },
  })
  assert.equal(relativeCredentialRead.hookSpecificOutput.permissionDecision, 'deny')
  if (previousDockerConfig === undefined) delete process.env.DOCKER_CONFIG
  else process.env.DOCKER_CONFIG = previousDockerConfig
  if (previousKubeconfig === undefined) delete process.env.KUBECONFIG
  else process.env.KUBECONFIG = previousKubeconfig
  for (const [name, value] of previousOverrides) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  if (previousCredentials === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS
  else process.env.GOOGLE_APPLICATION_CREDENTIALS = previousCredentials
  const escapedEdit = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(temp, 'outside.txt') } })
  assert.equal(escapedEdit.hookSpecificOutput.permissionDecision, 'deny')
  // A nested provider launch is not a command-text rule any more. Matching the text lost to
  // `npx claude`, to `$X -p`, and to base64, and a check three obvious tricks walk around reads
  // as protection while providing none. The sandbox below is the real control: both provider
  // executables and every credential path are unreadable, and the network allowlist is empty,
  // so a launch that gets past the text has no auth and nowhere to send anything.
  for (const command of [
    'claude -p hello',
    'value=$(claude -p hello)',
    'env -i /usr/bin/codex exec hello',
    'dash -c "claude -p hello"',
    'node -e "console.log(1)"',
  ]) {
    const allowed = await writeHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
    assert.equal(allowed.continue, true, command)
  }
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
    assert.ok(sandbox.filesystem.denyRead.includes('/proc'))
    // The half of the nested-launch answer that command text never had: no reachable provider
    // binary, no credential store, no network, and a sandbox that fails closed.
    assert.ok(sandbox.filesystem.denyRead.includes(join(homedir(), '.claude')))
    assert.deepEqual(sandbox.network.allowedDomains, [])
    assert.equal(sandbox.network.strictAllowlist, true)
    assert.equal(sandbox.enabled, true)
    assert.equal(sandbox.failIfUnavailable, true)
    assert.equal(sandbox.allowUnsandboxedCommands, false)
  } finally {
    delete process.env[secretName]
    if (previousClaudeBin === undefined) delete process.env.FLOW_DELEGATION_CLAUDE_BIN
    else process.env.FLOW_DELEGATION_CLAUDE_BIN = previousClaudeBin
    if (previousCodexBin === undefined) delete process.env.FLOW_DELEGATION_CODEX_BIN
    else process.env.FLOW_DELEGATION_CODEX_BIN = previousCodexBin
  }
  assert.ok(denied.length >= 15, `expected at least 15 policy-denial callbacks, received ${denied.length}`)
  for (const toolName of ['Bash', 'Edit', 'Grep', 'Read', 'Write']) {
    assert.ok(denied.some((entry) => entry.toolName === toolName), `missing policy-denial callback for ${toolName}`)
  }

  console.log('Codex-hosted MCP registration')
  const deadClient = new McpStdioClient({ command: process.execPath, args: ['-e', 'process.exit(17)'], cwd: repo, env: process.env, roots: [] })
  await assert.rejects(deadClient.start(), /MCP server exited early/)
  await session({ stateDir: state('mcp') }, async (client) => {
    const tools = await client.listTools()
    // The Codex-hosted tool set, as a set. delegation_steer is absent because the target is
    // Claude, and delegate_to_codex because a host never delegates to its own family.
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'delegate_to_claude', 'delegation_cancel', 'delegation_continue', 'delegation_doctor',
      'delegation_events', 'delegation_result', 'delegation_status',
    ])
    const delegateTool = tools.tools.find((tool) => tool.name === 'delegate_to_claude')
    assert.ok(delegateTool.inputSchema.properties.maxTurns)
    assert.ok(delegateTool.inputSchema.properties.maxBudgetUsd)
    const delegated = await client.callTool('delegate_to_claude', {
      mode: 'task', prompt: 'MCP', cwd: repo, access: 'read-only', model: 'sonnet', effort: 'low', delivery: 'attached', timeBudgetSeconds: 30,
    }, { timeout: 60_000 })
    assert.equal(delegated.structuredContent.job.status, 'succeeded')
    const read = await client.callTool('delegation_result', { jobId: delegated.structuredContent.job.jobId }, { timeout: 30_000 })
    assert.equal(read.structuredContent.job.output, 'OK from fake Claude')
  })

  console.log('smoke-claude-delegation: ALL PASS')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
