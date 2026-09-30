#!/usr/bin/env node
// Smoke for the delegate server: the real server and runner over stdio, real Git repositories in a
// temp directory, and two fake provider executables first on a temp PATH. Each fake records its
// argv, stdin, cwd and environment in the job's private TMPDIR and answers in the JSONL shape its
// CLI emits, in the mode a FLOW_FAKE_MODE=<mode> token in the prompt names. No network, no model.
// Run: node plugins/flow/scripts/smoke-delegate.mjs

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { seatPayload } from '../lib/charter-payload.mjs'
import { FINDINGS_SCHEMA } from '../delegate/jobs.mjs'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = join(PLUGIN, 'delegate', 'main.mjs')
const SEAT = seatPayload(readFileSync(join(PLUGIN, 'charter', 'charter.md'), 'utf8'))
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-smoke-delegate-')))
const [home, fakeBin, state, repo, other] = ['home', 'bin', 'state', 'repo', 'other'].map((name) => join(tmp, name))
const pathWith = (...dirs) => [...dirs, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
const ENV = { PATH: pathWith(fakeBin), HOME: home, LANG: 'C.UTF-8', FLOW_DELEGATION_STATE_DIR: state, SMOKE_LEAK: 'host-only' }
const gitEnv = { ...ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'smoke',
  GIT_AUTHOR_EMAIL: 'smoke@example.invalid', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid' }
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' }).trim()

let checks = 0
const ok = (line) => { checks++; console.log(`  ok: ${line}`) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(probe, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const value = probe(); if (value) return value }
  return probe()
}
const alive = (pid) => {
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z' } catch { return false }
}
const jobPath = (id, ...rest) => join(state, 'jobs', id, ...rest)
const fakeCall = (id) => { try { return JSON.parse(readFileSync(jobPath(id, 'tmp', 'fake-call.json'), 'utf8')) } catch { return null } }
const readJob = (id) => JSON.parse(readFileSync(jobPath(id, 'job.json'), 'utf8'))

// One fake, two names. Codex answers `exec` and `exec resume`; Claude answers `-p` stream-json.
const FAKE = String.raw`#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process')
const NAME = path.basename(process.argv[1]), argv = process.argv.slice(2)
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n')
const flag = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
if (argv[0] === '--version') { console.log(NAME === 'codex' ? 'codex-cli 0.0.0-fake' : '0.0.0-fake (Claude Code)'); process.exit(0) }
if (argv[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0) }
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'secret@example.invalid', orgId: 'org-secret' })); process.exit(0) }
const stdin = fs.readFileSync(0, 'utf8')
const mode = (/FLOW_FAKE_MODE=([a-z-]+)/.exec(stdin) || [])[1] || 'happy'
const record = { argv, stdin, cwd: process.cwd(), env: process.env, pid: process.pid }
const save = () => fs.writeFileSync(path.join(process.env.TMPDIR, 'fake-call.json'), JSON.stringify(record))
save()
const hang = () => { record.childPid = spawn('sleep', ['300'], { stdio: 'ignore' }).pid; save(); setInterval(() => {}, 1000) }
if (mode === 'exit-nonzero') { process.stderr.write('SECRET-STDERR-TOKEN\n'); process.exit(3) }
if (mode === 'bad-json') console.log('this line is not json')
const schema = flag('--output-schema') ? JSON.parse(fs.readFileSync(flag('--output-schema'), 'utf8')) : flag('--json-schema') ? JSON.parse(flag('--json-schema')) : null
const answer = !schema ? 'fake answer' : JSON.stringify(schema.properties.findings
  ? { findings: [{ severity: 'low', confidence: 90, title: 't', file: 'a.txt', line: 1, detail: 'd', systemic: false }] } : { answer: '42' })
setTimeout(NAME === 'codex' ? codex : claude, mode === 'slow' ? 1500 : 0)
function codex() {
  out({ type: 'thread.started', thread_id: argv[1] === 'resume' ? argv[argv.length - 2] : '11111111-1111-4111-8111-111111111111' })
  out({ type: 'turn.started' })
  if (mode === 'hang') return hang()
  if (mode === 'refusal') {
    const message = JSON.stringify({ type: 'error', status: 400, error: { message: 'This request was flagged for possible cyber risk.' } })
    out({ type: 'error', message }); out({ type: 'turn.failed', error: { message } }); process.exit(1)
  }
  if (mode === 'command-failure') for (const code of [1, 2]) out({ type: 'item.completed', item: { type: 'command_execution', command: 'false', exit_code: code, status: 'failed' } })
  out({ type: 'item.completed', item: { type: 'agent_message', text: answer } })
  fs.writeFileSync(flag('-o'), answer)
  out({ type: 'turn.completed', usage: {} })
}
function claude() {
  const session = flag('--session-id') || flag('--resume')
  const model = 'claude-fake-1'
  out({ type: 'system', subtype: 'init', session_id: session, model })
  if (mode === 'mismatch') { out({ type: 'assistant', message: { model: 'claude-other-2', content: [{ type: 'text', text: 'swapped' }] } }); return hang() }
  if (mode === 'hang') return hang()
  if (mode === 'refusal') {
    out({ type: 'assistant', message: { model, stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] } })
    return out({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: session })
  }
  if (mode === 'command-failure') {
    out({ type: 'assistant', message: { model, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }] } })
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Exit code 1' }] } })
  }
  out({ type: 'assistant', message: { model: '<synthetic>', content: [] } })
  out({ type: 'assistant', message: { model: model + '[1m]', content: [{ type: 'text', text: answer }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: session,
    ...(schema ? { structured_output: JSON.parse(answer) } : {}), permission_denials: mode === 'approval' ? [{ tool_name: 'Read' }] : [] })
}
`

class Client {
  constructor({ host, cwd, env = {}, roots = null, entry = [MAIN] }) {
    this.roots = roots
    this.next = 0
    this.waiting = new Map()
    this.child = spawn(process.execPath, [...entry, 'mcp', '--host', host], { cwd, env: { ...ENV, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = JSON.parse(line)
      if (message.method === 'roots/list') {
        this.write({ id: message.id, result: { roots: (this.roots ?? []).map((root) => ({ uri: pathToFileURL(root).href, name: 'root' })) } })
      } else if (!message.method) {
        this.waiting.get(message.id)?.(message)
      }
    })
  }
  write(message) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.next
      const timer = setTimeout(() => reject(new Error(`${method} got no answer`)), 120_000)
      this.waiting.set(id, (message) => { clearTimeout(timer); resolve(message) })
      this.write({ id, method, params })
    })
  }
  async init() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: this.roots ? { roots: {} } : {}, clientInfo: { name: 'smoke', version: '0' } })
    this.write({ method: 'notifications/initialized' })
    return this
  }
  async call(name, args) {
    const { result } = await this.request('tools/call', { name, arguments: args })
    const text = result.content[0].text
    assert.equal(text.split('\n')[0].startsWith('{"summary": '), true, 'the text result opens with its summary')
    assert.deepEqual(JSON.parse(text), result.structuredContent, 'text and structuredContent carry the same object')
    assert.equal(Boolean(result.isError), !result.structuredContent.ok, 'isError mirrors ok')
    return { ...result.structuredContent, text }
  }
  close() { this.child.stdin.end() }
}
const connect = (options) => new Client(options).init()
const start = (client, args) => client.call(`delegate_to_${client.target ?? 'codex'}`, {
  model: client.target === 'claude' ? 'sonnet' : 'gpt-fake', effort: 'low', cwd: repo, ...args,
})

try {
  mkdirSync(fakeBin, { recursive: true })
  for (const name of ['codex', 'claude']) writeFileSync(join(fakeBin, name), FAKE, { mode: 0o755 })
  // home is a repository's top level too, so the Codex home-directory rule is what refuses it.
  for (const dir of [repo, other, home]) {
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: gitEnv })
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-q', '-m', 'one')
  }
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  git(repo, 'commit', '-q', '-am', 'two')
  mkdirSync(join(repo, 'sub'))
  symlinkSync(other, join(repo, 'escape'))

  const claudeHost = await connect({ host: 'claude', cwd: repo, env: { CLAUDE_PROJECT_DIR: repo } })
  const codexHost = await connect({ host: 'codex', cwd: repo })
  codexHost.target = 'claude'

  // The timeout case runs its 30-second budget while everything else proceeds.
  const timed = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=hang', timeBudgetSeconds: 30, waitSeconds: 0 })

  const names = async (client) => (await client.request('tools/list', {})).result.tools
  const claudeTools = await names(claudeHost)
  assert.deepEqual(claudeTools.map((tool) => tool.name), ['delegate_to_codex', 'delegation_result', 'delegation_cancel', 'delegation_doctor'])
  assert.deepEqual((await names(codexHost)).map((tool) => tool.name), ['delegate_to_claude', 'delegation_result', 'delegation_cancel', 'delegation_doctor'])
  assert.ok(claudeTools.every((tool) => tool.inputSchema?.type === 'object' && !('outputSchema' in tool)))
  assert.ok(!('maxTurns' in claudeTools[0].inputSchema.properties), 'the Codex target takes no Claude limits')
  ok('four tools per host, each reaching the other family only, with input schemas and no output schema')

  // Roots: host-supplied only, realpath and Git top level both inside one.
  const refused = async (client, args, kind) => {
    const result = await start(client, { prompt: 'x', ...args })
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, kind, JSON.stringify(result.error))
  }
  await refused(claudeHost, { cwd: other }, 'OUTSIDE_ROOTS')
  await refused(claudeHost, { cwd: join(repo, 'escape') }, 'OUTSIDE_ROOTS')
  const noRoots = await connect({ host: 'claude', cwd: repo })
  await refused(noRoots, {}, 'NO_ROOTS')
  noRoots.close()
  const listed = await connect({ host: 'claude', cwd: tmp, roots: [other] })
  const viaRoots = await start(listed, { prompt: 'FLOW_FAKE_MODE=happy', cwd: other })
  assert.equal(viaRoots.job.status, 'succeeded')
  await refused(listed, { cwd: repo }, 'OUTSIDE_ROOTS')
  const hidden = await listed.call('delegation_result', { jobId: timed.job.id })
  assert.equal(hidden.error.kind, 'JOB_NOT_FOUND', 'a job outside the roots is invisible')
  listed.close()
  for (const [cwd, env] of [[join(repo, 'sub'), { CODEX_PROJECT_DIR: repo, PWD: repo, GIT_DIR: join(repo, '.git') }], [home, {}]]) {
    const codexOff = await connect({ host: 'codex', cwd, env })
    codexOff.target = 'claude'
    await refused(codexOff, {}, 'NO_ROOTS')
    codexOff.close()
  }
  ok('roots: CLAUDE_PROJECT_DIR and roots/list admit; outside, a symlink escape, no roots, a Codex subdirectory or home, and inherited project variables refuse')

  const nested = await connect({ host: 'claude', cwd: repo, env: { CLAUDE_PROJECT_DIR: repo, FLOW_DELEGATION_DEPTH: '1' } })
  await refused(nested, {}, 'NESTED_DELEGATION')
  nested.close()
  for (const [args, kind] of [[{ delivery: 'detached' }, 'BAD_REQUEST'], [{ model: undefined }, 'BAD_REQUEST'], [{ effort: 'minimal' }, 'BAD_REQUEST'],
    [{ maxTurns: 3 }, 'BAD_REQUEST'], [{ mode: 'adversarial-review', base: 'nope' }, 'GIT_REF'], [{ outputSchema: { type: 'array' } }, 'BAD_SCHEMA'],
    [{ mode: 'adversarial-review', base: 'HEAD~1', outputSchema: { type: 'object' } }, 'BAD_SCHEMA']]) {
    await refused(claudeHost, args, kind)
  }
  ok('a nested server refuses to start a job, and malformed calls get typed refusals')

  // Argv, stdin and environment per target and access mode.
  const codexRead = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy read' })
  const codexWrite = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy write', access: 'workspace-write' })
  for (const [result, access] of [[codexRead, 'read-only'], [codexWrite, 'workspace-write']]) {
    assert.equal(result.job.status, 'succeeded')
    assert.equal(result.job.output, 'fake answer')
    const call = fakeCall(result.job.id)
    for (const word of ['exec', '--json', '--ignore-user-config', '--ignore-rules', '-C', '-s', access, 'model_reasoning_effort="low"', 'approval_policy="never"']) {
      assert.ok(call.argv.includes(word), `codex argv carries ${word}`)
    }
    assert.equal(call.argv.at(-1), '-')
    assert.equal(call.cwd, repo)
    assert.ok(call.stdin.startsWith(SEAT), 'the Codex prompt starts with the seat bytes')
    assert.ok(call.stdin.includes(access === 'read-only' ? 'This is a read-only job.' : 'You may edit only the assigned Git worktree.'))
    assert.equal(call.env.FLOW_DELEGATION_DEPTH, '1')
    assert.equal(call.env.SMOKE_LEAK, undefined, 'a host variable outside the allowlist reached the provider')
    assert.equal(call.env.TMPDIR, jobPath(result.job.id, 'tmp'))
  }
  const claudeRead = await start(codexHost, { prompt: 'FLOW_FAKE_MODE=happy read' })
  const claudeWrite = await start(codexHost, { prompt: 'FLOW_FAKE_MODE=happy write', access: 'workspace-write' })
  for (const [result, write] of [[claudeRead, false], [claudeWrite, true]]) {
    assert.equal(result.job.status, 'succeeded', JSON.stringify(result.job.error))
    assert.equal(result.job.servedModel, 'claude-fake-1', 'the served model is reported, and <synthetic> and [1m] are not swaps')
    const call = fakeCall(result.job.id)
    const flag = (name) => call.argv[call.argv.indexOf(name) + 1]
    assert.equal(flag('--setting-sources'), '')
    for (const word of ['-p', '--strict-mcp-config', '--verbose']) assert.ok(call.argv.includes(word))
    assert.equal(flag('--permission-mode'), 'dontAsk')
    assert.equal(flag('--permission-prompts'), 'none')
    assert.equal(flag('--session-id'), result.job.threadId)
    assert.equal(flag('--tools').includes('Edit'), write)
    const settings = JSON.parse(flag('--settings'))
    assert.deepEqual(settings.sandbox.network.allowedDomains, [])
    assert.equal(settings.sandbox.failIfUnavailable, true)
    assert.deepEqual(write ? settings.sandbox.filesystem.allowWrite[0] : settings.sandbox.filesystem.denyWrite, write ? repo : [repo])
    assert.ok(settings.permissions.deny.includes(`Read(/${home}/.ssh/**)`))
    assert.ok(settings.sandbox.filesystem.denyRead.includes(join(fakeBin, 'codex')), 'the provider executables are masked')
    assert.deepEqual(settings.permissions.allow, write ? [`Edit(/${repo}/**)`] : [])
    assert.equal(call.stdin, `FLOW_FAKE_MODE=happy ${write ? 'write' : 'read'}`, 'the Claude task goes to stdin alone')
    assert.ok(readFileSync(flag('--append-system-prompt-file'), 'utf8').startsWith(SEAT), 'the Claude seat file starts with the seat bytes')
    assert.equal(call.env.CLAUDE_CODE_NO_MODEL_FALLBACK, '1')
    assert.equal(call.env.SMOKE_LEAK, undefined)
  }
  ok('argv per target and access, the seat bytes first, and only allowlisted variables plus the depth marker reach the provider')

  // Review mode pins SHAs before the job exists and forces read-only and the findings schema.
  const baseSha = git(repo, 'rev-parse', 'HEAD~1')
  const headSha = git(repo, 'rev-parse', 'HEAD')
  const review = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy', mode: 'adversarial-review', base: 'main~1', access: 'workspace-write' })
  assert.equal(review.job.status, 'succeeded')
  assert.deepEqual([review.job.baseSha, review.job.headSha, review.job.access], [baseSha, headSha, 'read-only'])
  const reviewCall = fakeCall(review.job.id)
  assert.ok(reviewCall.argv.includes('read-only'))
  assert.deepEqual(JSON.parse(readFileSync(reviewCall.argv[reviewCall.argv.indexOf('--output-schema') + 1], 'utf8')), FINDINGS_SCHEMA)
  assert.ok(reviewCall.stdin.includes(`git diff ${baseSha} ${headSha}`))
  assert.equal(review.job.structured.findings.length, 1)
  const claudeReview = await start(codexHost, { prompt: 'FLOW_FAKE_MODE=happy', mode: 'adversarial-review', base: baseSha })
  assert.equal(claudeReview.job.structured.findings[0].file, 'a.txt')
  ok('adversarial review pins base and head to SHAs, forces read-only and the findings schema, and returns typed findings')

  const schema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } }
  for (const client of [claudeHost, codexHost]) {
    const typed = await start(client, { prompt: 'FLOW_FAKE_MODE=happy', outputSchema: schema })
    assert.deepEqual(typed.job.structured, { answer: '42' })
  }
  ok('a task outputSchema comes back parsed as structured on both targets')

  const expect = async (client, prompt, status, kind) => {
    const result = await start(client, { prompt })
    assert.equal(result.job.status, status, JSON.stringify(result.job.error))
    assert.equal(result.job.error?.kind ?? null, kind)
    return result
  }
  await expect(claudeHost, 'FLOW_FAKE_MODE=refusal', 'failed', 'REFUSAL')
  const claudeRefusal = await expect(codexHost, 'FLOW_FAKE_MODE=refusal', 'failed', 'REFUSAL')
  assert.equal(claudeRefusal.job.error.details.category, 'cyber')
  const began = Date.now()
  const swapped = await expect(codexHost, 'FLOW_FAKE_MODE=mismatch', 'failed', 'MODEL_MISMATCH')
  assert.deepEqual(swapped.job.error.details, { expected: 'claude-fake-1', served: 'claude-other-2' })
  assert.ok(Date.now() - began < 20_000, 'the swap stopped the turn instead of waiting out the budget')
  const swappedCall = fakeCall(swapped.job.id)
  assert.ok(await until(() => !alive(swappedCall.pid) && !alive(swappedCall.childPid)), 'the swapped provider group was killed')
  const denied = await expect(codexHost, 'FLOW_FAKE_MODE=approval', 'failed', 'APPROVAL_REQUIRED')
  assert.equal(denied.job.output, 'fake answer', 'a denied turn keeps its answer')
  ok('refusals are typed on both targets, a model swap is latched and stopped at once, and a denied permission is APPROVAL_REQUIRED')

  const failing = await expect(claudeHost, 'FLOW_FAKE_MODE=exit-nonzero', 'failed', 'PROVIDER_ERROR')
  assert.ok(!failing.text.includes('SECRET-STDERR-TOKEN'), 'provider stderr reached the tool result')
  assert.ok(readFileSync(jobPath(failing.job.id, 'stderr.txt'), 'utf8').includes('SECRET-STDERR-TOKEN'))
  assert.equal((await expect(claudeHost, 'FLOW_FAKE_MODE=command-failure', 'succeeded', null)).job.commandFailures, 2)
  assert.equal((await expect(codexHost, 'FLOW_FAKE_MODE=command-failure', 'succeeded', null)).job.commandFailures, 1)
  const noisy = await expect(claudeHost, 'FLOW_FAKE_MODE=bad-json', 'succeeded', null)
  assert.ok(readFileSync(noisy.job.eventsPath, 'utf8').includes('this line is not json'))
  ok('stderr stays in stderr.txt, failed commands are counted, and a non-JSON line is journaled without breaking the fold')

  // Detach, then collect.
  const detached = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=slow', waitSeconds: 0 })
  assert.ok(['queued', 'running'].includes(detached.job.status))
  const collected = await claudeHost.call('delegation_result', { jobId: detached.job.id, waitSeconds: 30, events: 2 })
  assert.equal(collected.job.status, 'succeeded')
  assert.equal(collected.job.events.length, 2)
  assert.equal(JSON.parse(collected.job.events.at(-1)).type, 'turn.completed')
  ok('waitSeconds 0 detaches, and delegation_result waits for the outcome and returns the trailing events')

  // Continue resumes the provider thread, same cwd and access.
  const resumed = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy again', continue: codexRead.job.id })
  assert.equal(resumed.job.threadId, codexRead.job.threadId)
  assert.equal(resumed.job.parentJobId, codexRead.job.id)
  const resumeArgv = fakeCall(resumed.job.id).argv
  assert.deepEqual(resumeArgv.slice(0, 2), ['exec', 'resume'])
  assert.deepEqual(resumeArgv.slice(-2), [codexRead.job.threadId, '-'])
  assert.ok(resumeArgv.includes('sandbox_mode="read-only"'))
  const claudeResumed = await start(codexHost, { prompt: 'FLOW_FAKE_MODE=happy again', continue: claudeRead.job.id })
  const claudeArgv = fakeCall(claudeResumed.job.id).argv
  assert.equal(claudeArgv[claudeArgv.indexOf('--resume') + 1], claudeRead.job.threadId)
  assert.ok(!claudeArgv.includes('--session-id'))
  assert.equal(claudeResumed.job.threadId, claudeRead.job.threadId)
  await refused(claudeHost, { continue: codexRead.job.id, access: 'workspace-write' }, 'BAD_REQUEST')
  await refused(claudeHost, { continue: timed.job.id }, 'JOB_STATE')
  ok('continue resumes the same Codex thread and Claude session, and refuses a changed access or an unfinished job')

  // Cancel stops the whole provider group.
  const hanging = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=hang', waitSeconds: 0, access: 'workspace-write' })
  const hangCall = await until(() => fakeCall(hanging.job.id)?.childPid && fakeCall(hanging.job.id))
  await refused(claudeHost, { access: 'workspace-write' }, 'WORKSPACE_BUSY')
  assert.equal((await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy' })).job.status, 'succeeded', 'a reader shares a busy worktree')
  const cancelled = await claudeHost.call('delegation_cancel', { jobId: hanging.job.id })
  assert.equal(cancelled.job.status, 'cancelled')
  assert.equal(cancelled.job.error.kind, 'CANCELLED')
  assert.ok(await until(() => !alive(hangCall.pid) && !alive(hangCall.childPid)), 'cancel left part of the provider group running')
  assert.equal((await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy', access: 'workspace-write' })).job.status, 'succeeded', 'cancel released the lease')
  ok('one writer per worktree, readers alongside it, and cancel kills the provider and its children and frees the lease')

  // A runner that dies leaves an unknown outcome, and its lease does not outlive it.
  const orphan = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=hang', waitSeconds: 0, access: 'workspace-write' })
  const orphanCall = await until(() => fakeCall(orphan.job.id)?.childPid && fakeCall(orphan.job.id))
  process.kill(readJob(orphan.job.id).runnerPid, 'SIGKILL')
  await until(() => !alive(readJob(orphan.job.id).runnerPid))
  const lost = await claudeHost.call('delegation_result', { jobId: orphan.job.id })
  assert.equal(lost.job.status, 'unknown')
  assert.equal(lost.job.error.kind, 'RUNNER_LOST')
  assert.ok(await until(() => !alive(orphanCall.pid) && !alive(orphanCall.childPid)), 'the orphaned provider group was killed')
  await refused(claudeHost, { continue: orphan.job.id }, 'JOB_STATE')
  assert.equal((await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy', access: 'workspace-write' })).job.status, 'succeeded', 'a dead writer kept its lease')
  ok('a dead runner reads unknown with RUNNER_LOST, cannot be continued, and its lease is reclaimed')

  const doctor = await claudeHost.call('delegation_doctor', {})
  assert.equal(doctor.ok, true)
  assert.deepEqual([doctor.host, doctor.target, doctor.provider.version, doctor.roots], ['claude', 'codex', 'codex-cli 0.0.0-fake', [repo]])
  assert.equal((await codexHost.call('delegation_doctor', {})).provider.auth.method, 'claude.ai')
  assert.ok(!(await codexHost.call('delegation_doctor', {})).text.includes('secret@example.invalid'), 'the doctor repeated the account email')
  const bare = await connect({ host: 'claude', cwd: repo, env: { CLAUDE_PROJECT_DIR: repo, PATH: pathWith() } })
  assert.equal((await bare.call('delegation_doctor', {})).error.kind, 'PROVIDER_NOT_INSTALLED')
  assert.equal((await start(bare, { prompt: 'x' })).job.error.kind, 'PROVIDER_NOT_INSTALLED')
  bare.close()
  ok('the doctor reports version, sign-in and roots without the account identity, and a missing provider is typed')

  const expired = await claudeHost.call('delegation_result', { jobId: timed.job.id, waitSeconds: 60 })
  assert.equal(expired.job.status, 'failed')
  assert.equal(expired.job.error.kind, 'TIMEOUT')
  ok('a job past its time budget is stopped and fails TIMEOUT')
  claudeHost.close()
  codexHost.close()

  // The Codex dispatcher resolves the installed cache by version and runs the server in-process.
  const codexHome = join(tmp, 'codex-home')
  mkdirSync(join(codexHome, 'plugins', 'cache', 'jakub', 'flow'), { recursive: true })
  symlinkSync(PLUGIN, join(codexHome, 'plugins', 'cache', 'jakub', 'flow', '9.9.9'))
  const dispatched = new Client({ host: 'codex', cwd: repo, env: { CODEX_HOME: codexHome }, entry: [join(PLUGIN, 'bin', 'flow-delegate'), '--flow-version', '9.9.9'] })
  await dispatched.init()
  assert.equal((await dispatched.request('tools/list', {})).result.tools[0].name, 'delegate_to_claude')
  dispatched.close()
  const missing = spawnSync(process.execPath, [join(PLUGIN, 'bin', 'flow-delegate'), '--flow-version', '9.9.8', 'mcp', '--host', 'codex'], { env: { ...ENV, CODEX_HOME: codexHome }, encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /plugins\/cache\/jakub\/flow\/9\.9\.8\/delegate\/main\.mjs is missing/)
  ok('the dispatcher resolves $CODEX_HOME/plugins/cache/jakub/flow/<version>, and a missing version exits 1 naming the path')

  const install = () => spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'install-delegate.mjs'), 'install'], { env: { ...ENV, HOME: home }, encoding: 'utf8' })
  const installed = join(home, '.local', 'bin', 'flow-delegate')
  assert.match(install().stderr, /installed/)
  assert.deepEqual(readFileSync(installed), readFileSync(join(PLUGIN, 'bin', 'flow-delegate')))
  assert.match(install().stderr, /up to date/)
  writeFileSync(installed, 'stale')
  assert.match(install().stderr, /updated/)
  assert.deepEqual(readFileSync(installed), readFileSync(join(PLUGIN, 'bin', 'flow-delegate')))
  ok('the installer copies the dispatcher when it is missing or differs, and leaves an identical copy alone')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\nsmoke-delegate: ALL PASS (${checks} checks)`)
