#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '../deps/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../deps/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { ListRootsRequestSchema } from '../deps/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js'
import { JobStore, processStartToken } from '../src/delegation/store.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(root, 'dist', 'delegation.mjs')
const temp = mkdtempSync(join(tmpdir(), 'flow-delegation-smoke-'))
const repo = join(temp, 'repo')
const nestedDir = join(repo, 'nested')
const fake = join(temp, 'fake-codex.mjs')

writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline'
if (process.argv[2] === '--version') { console.log('codex-cli 0.test'); process.exit(0) }
const mode = process.env.FLOW_FAKE_MODE || 'happy'
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let active = null
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
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  const answer = (result) => say({ id: message.id, result })
  if (message.id === 900 && !message.method) finish('failed', '')
  else if (message.id === 902 && !message.method) {
    if (message.result?.permissions && Object.keys(message.result.permissions).length === 0) finish('failed', '')
    else process.exit(18)
  }
  else if (message.method === 'initialize') answer({ userAgent: 'fake' })
  else if (message.method === 'initialized') {}
  else if (message.method === 'thread/start') {
    if (mode === 'profile' && !message.params.developerInstructions.includes('authorized defensive research')) {
      say({ id: message.id, error: { code: -32602, message: 'missing defensive profile' } })
    } else answer({ thread: { id: 'thread-test' } })
  }
  else if (message.method === 'thread/resume') answer({ thread: { id: message.params.threadId } })
  else if (message.method === 'turn/start') {
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
    if (mode === 'approval') {
      timer = setTimeout(() => say({ method: 'item/commandExecution/requestApproval', id: 900, params: { threadId: active.threadId, turnId: active.turnId, itemId: 'command-1' } }), 20)
    } else if (mode === 'permissions-approval') {
      timer = setTimeout(() => say({ method: 'item/permissions/requestApproval', id: 902, params: { threadId: active.threadId, turnId: active.turnId, itemId: 'permissions-1', cwd: process.cwd(), permissions: { network: { enabled: true } }, startedAtMs: Date.now() } }), 20)
    } else timer = setTimeout(() => finish(), mode === 'slow' || mode === 'steer' ? 2500 : 20)
  } else if (message.method === 'turn/interrupt') { answer({}); finish('interrupted', '') }
  else if (message.method === 'turn/steer') { answer({}); finish('completed', 'STEERED: ' + message.params.input[0].text) }
  else if (message.method === 'model/list') answer({ data: [{ id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'Luna' }], nextCursor: null })
  else if (message.method === 'account/read') answer({ account: { type: 'chatgpt', email: 'test@example.invalid', planType: 'test' }, requiresOpenaiAuth: true })
  else if (message.method === 'thread/read') answer({ thread: { id: message.params.threadId, turns: [{ id: 'recovered', items: mode === 'recovery-in-progress' ? [] : [{ type: 'agentMessage', id: 'i', text: 'RECOVERED', phase: null, memoryCitation: null, delivery: null }], itemsView: { type: 'full' }, status: mode === 'recovery-in-progress' ? 'inProgress' : 'completed', error: null, startedAt: 1, completedAt: mode === 'recovery-in-progress' ? null : 2, durationMs: mode === 'recovery-in-progress' ? null : 1 }] } })
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
const cli = (args, { input = '', mode = 'happy', stateDir = state('default'), extraEnv = {} } = {}) => {
  const output = execFileSync(process.execPath, [bundle, 'cli', ...args, '--state-dir', stateDir], {
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
    if (['succeeded', 'failed', 'cancelled', 'unknown', 'awaiting_approval'].includes(result.status)) {
      if (wanted) assert.equal(result.status, wanted)
      return result
    }
    await delay(100)
  }
  assert.fail(`job ${jobId} did not finish`)
}

try {
  console.log('task and typed output')
  const happy = cli(runArgs, { input: 'Reply with OK', stateDir: state('happy') })
  assert.equal(happy.status, 'succeeded')
  assert.equal(happy.output, 'OK from fake Codex')
  assert.equal(happy.model, 'gpt-5.6-luna')
  assert.equal(happy.serviceTier, 'default')
  assert.ok(happy.threadId && happy.turnId)
  const happyEvents = cli(['events', happy.jobId, '--after', '0', '--limit', '1000'], { stateDir: state('happy') })
  assert.deepEqual(happyEvents.map((event) => event.seq), happyEvents.map((_, index) => index + 1))
  const happyDb = new DatabaseSync(join(state('happy'), 'jobs.sqlite3'), { readOnly: true })
  assert.equal(happyDb.prepare('SELECT prompt FROM jobs WHERE id=?').get(happy.jobId).prompt, null)
  happyDb.close()

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
  assert.equal(rejectedByBooleanSchema.error.kind, 'SCHEMA_OUTPUT')

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

  console.log('route and nesting guards')
  const same = cli(['run', '--host', 'codex', '--cwd', repo, '--model', 'gpt-5.6-luna', '--effort', 'low'], { input: 'x', stateDir: state('same') })
  assert.equal(same.status, 'failed')
  assert.equal(same.error.kind, 'SAME_FAMILY')
  const nested = cli(runArgs, { input: 'x', stateDir: state('nested'), extraEnv: { FLOW_DELEGATION_DEPTH: '1' } })
  assert.equal(nested.status, 'failed')
  assert.equal(nested.error.kind, 'NESTED_DELEGATION')
  const escape = join(repo, 'escape')
  symlinkSync(temp, escape, 'dir')
  const nestedRead = cli([...runArgs, '--cwd', nestedDir], { input: 'nested read', stateDir: state('nested-read') })
  assert.equal(nestedRead.status, 'succeeded')
  const widenedWrite = cli([...runArgs, '--cwd', nestedDir, '--access', 'workspace-write'], { input: 'nested write', stateDir: state('nested-write') })
  assert.equal(widenedWrite.status, 'failed')
  assert.equal(widenedWrite.error.kind, 'OUTSIDE_ROOTS')

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

  console.log('MCP registration, roots, progress, and attached result')
  const mcpState = state('mcp')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle, 'mcp', '--host', 'claude', '--state-dir', mcpState],
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      FLOW_DELEGATION_CODEX_BIN: fake,
      FLOW_FAKE_MODE: 'happy',
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'flow-smoke', version: '1.0.0' }, { capabilities: { roots: { listChanged: false } } })
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(repo).href, name: 'repo' }] }))
  await client.connect(transport)
  const tools = await client.listTools()
  const names = tools.tools.map((tool) => tool.name)
  for (const name of ['delegate_to_codex', 'delegation_status', 'delegation_result', 'delegation_events', 'delegation_cancel', 'delegation_steer', 'delegation_continue', 'delegation_models', 'delegation_doctor']) assert.ok(names.includes(name), name)
  const escaped = await client.callTool({
    name: 'delegate_to_codex',
    arguments: { mode: 'task', prompt: 'escape', cwd: temp, access: 'read-only', model: 'gpt-5.6-luna', effort: 'low', delivery: 'attached', timeBudgetSeconds: 30 },
  })
  assert.equal(escaped.isError, true)
  assert.equal(escaped.structuredContent.error.kind, 'OUTSIDE_ROOTS')
  const symlinkEscape = await client.callTool({
    name: 'delegate_to_codex',
    arguments: { mode: 'task', prompt: 'symlink escape', cwd: escape, access: 'read-only', model: 'gpt-5.6-luna', effort: 'low', delivery: 'attached', timeBudgetSeconds: 30 },
  })
  assert.equal(symlinkEscape.isError, true)
  assert.equal(symlinkEscape.structuredContent.error.kind, 'OUTSIDE_ROOTS')
  const progress = []
  const mcpResult = await client.callTool({
    name: 'delegate_to_codex',
    arguments: { mode: 'task', prompt: 'MCP test', cwd: repo, access: 'read-only', model: 'gpt-5.6-luna', effort: 'low', delivery: 'attached', timeBudgetSeconds: 30 },
  }, undefined, { timeout: 30_000, resetTimeoutOnProgress: true, onprogress: (event) => progress.push(event) })
  assert.equal(mcpResult.isError, undefined)
  assert.equal(mcpResult.structuredContent.job.status, 'succeeded')
  assert.ok(progress.length > 0)
  const modelResult = await client.callTool({ name: 'delegation_models', arguments: { cwd: repo } }, undefined, { timeout: 30_000 })
  assert.equal(modelResult.structuredContent.models[0].id, 'gpt-5.6-luna')
  const escapedModels = await client.callTool({ name: 'delegation_models', arguments: { cwd: temp } }, undefined, { timeout: 30_000 })
  assert.equal(escapedModels.isError, true)
  assert.equal(escapedModels.structuredContent.error.kind, 'OUTSIDE_ROOTS')
  const doctorResult = await client.callTool({ name: 'delegation_doctor', arguments: { cwd: repo } }, undefined, { timeout: 30_000 })
  assert.equal(doctorResult.structuredContent.ok, true)
  await client.close()

  console.log('smoke-delegation: ALL PASS')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
