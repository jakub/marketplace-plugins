#!/usr/bin/env node
// Smoke for the delegate server: the real server and runner over stdio, real Git repositories in a
// temp directory, and two fake provider executables first on a temp PATH. Each fake records its
// argv, cwd and environment in the job's private TMPDIR, and answers in the mode a
// FLOW_FAKE_MODE=<mode> token in the prompt names. The fake Codex is an App Server peer that also
// records every request and response; the fake Claude is a stream-json control-channel peer that
// records every frame it is written. The fakes speak the protocol subset the transports use, in
// the shapes Codex CLI 0.159.0 and Claude Code 2.1.284 answer with. No network, no model.
// Run: node plugins/flow/scripts/smoke-delegate.mjs

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { seatPayload } from '../lib/charter-payload.mjs'
import { transport as codexTransport } from '../delegate/codex-app-server.mjs'
import * as jobs from '../delegate/jobs.mjs'
import { checkAnswer, schemaProblem, validate } from '../delegate/schema.mjs'
const { FINDINGS_SCHEMA } = jobs

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = join(PLUGIN, 'delegate', 'main.mjs')
const SEAT = seatPayload(readFileSync(join(PLUGIN, 'charter', 'charter.md'), 'utf8'))
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-smoke-delegate-')))
const [home, fakeBin, state, repo, other] = ['home', 'bin', 'state', 'repo', 'other'].map((name) => join(tmp, name))
const pathWith = (...dirs) => [...dirs, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
const ENV = { PATH: pathWith(fakeBin), HOME: home, LANG: 'C.UTF-8', FLOW_DELEGATION_STATE_DIR: state, SMOKE_LEAK: 'host-only' }
// The cases that drive jobs.mjs in this process use the same state directory as the server.
process.env.FLOW_DELEGATION_STATE_DIR = state
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
// What the fake App Server was asked: every request's params for one method, and the text a
// turn/start carried.
const asked = (id, method) => (fakeCall(id)?.requests ?? []).filter((request) => request.method === method).map((request) => request.params)
const turnText = (id) => asked(id, 'turn/start')[0]?.input.map((part) => part.text).join('')
// What the fake Claude was written: every frame in order, and the text of each user message.
const wrote = (id) => fakeCall(id)?.frames ?? []
const userTexts = (id) => wrote(id).filter((frame) => frame.type === 'user').map((frame) => frame.message.content.map((part) => part.text).join(''))
const journal = (id) => readFileSync(jobPath(id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return line } })
const THREAD = '11111111-1111-4111-8111-111111111111'
const TURN = '22222222-2222-4222-8222-222222222222'

// One fake, two names. Codex answers `app-server --stdio` as a JSON-RPC peer; Claude answers `-p`
// with stream-json in and out as a control-channel peer. Each provider takes its prompt only after
// a handshake the modes under test act in (turn/start, or the first user message), so each fake
// reads its mode from the job's prompt.txt beside its TMPDIR.
const FAKE = String.raw`#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process')
const NAME = path.basename(process.argv[1]), argv = process.argv.slice(2)
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n')
const flag = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
if (argv[0] === '--version') { console.log(NAME === 'codex' ? 'codex-cli 0.0.0-fake' : '0.0.0-fake (Claude Code)'); process.exit(0) }
if (argv[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0) }
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'secret@example.invalid', orgId: 'org-secret' })); process.exit(0) }
const finding = (mode) => mode === 'bad-structure' ? { severity: 'urgent', confidence: 90, title: 't', file: 'a.txt', line: 1, detail: 'd' }
  : { severity: 'low', confidence: 90, title: 't', file: 'a.txt', line: 1, detail: 'd', systemic: false }
const answerFor = (schema, mode) => !schema ? 'fake answer' : JSON.stringify(schema.properties.findings ? { findings: [finding(mode)] } : { answer: '42' })
const modeOf = (text) => (/FLOW_FAKE_MODE=([a-z-]+)/.exec(text) || [])[1] || 'happy'
if (NAME === 'codex') appServer()
else claudeCli()

function appServer() {
  let prompt = ''
  try { prompt = fs.readFileSync(path.join(process.env.TMPDIR, '..', 'prompt.txt'), 'utf8') } catch {}
  const mode = modeOf(prompt)
  const record = { argv, cwd: process.cwd(), env: process.env, pid: process.pid, exe: fs.realpathSync('/proc/self/exe'), requests: [], responses: [] }
  const save = () => fs.writeFileSync(path.join(process.env.TMPDIR, 'fake-call.json'), JSON.stringify(record))
  save()
  if (argv.join(' ') !== 'app-server --stdio') { process.stderr.write('fake codex: unexpected argv\n'); process.exit(64) }
  const THREAD = '11111111-1111-4111-8111-111111111111', TURN = '22222222-2222-4222-8222-222222222222'
  // The servers this config defines, as config/read reports them: two in the effective config, one
  // only in a project layer, and one in a layer Codex did not load, which a thread may not name.
  const LOADED = ['hostDocs', 'nodeRepl', 'repoProbe']
  const MODELS = [{ id: 'gpt-fake', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, { id: 'gpt-fake-mini', efforts: ['low', 'medium'] }, { id: 'gpt-fake-other', efforts: ['low'] }]
    .map(({ id, efforts }) => ({ id, model: id, hidden: false, supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: 'low' }))
  let thread = null, threadId = null, turnOpen = false, served = 0
  const reply = (id, result) => out({ id, result })
  const refuse = (id, message) => out({ id, error: { code: -32600, message } })
  const page = (list, params) => {
    const at = Number(params.cursor || 0)
    return { data: list.slice(at, at + 2), nextCursor: at + 2 < list.length ? String(at + 2) : null }
  }
  const complete = (status, error = null) => {
    turnOpen = false
    out({ method: 'turn/completed', params: { threadId, turn: { id: TURN, items: [], status, error } } })
  }
  const hang = () => { record.childPid = spawn('sleep', ['300'], { stdio: 'ignore' }).pid; save() }
  const waiting = new Map()
  const ask = (method) => new Promise((resolve) => {
    const id = 'srv-' + (++served)
    waiting.set(id, resolve)
    out({ id, method, params: { threadId, turnId: TURN, itemId: 'i' + served } })
  })
  async function runTurn(params) {
    out({ method: 'turn/started', params: { threadId, turn: { id: TURN, items: [], status: 'inProgress', error: null } } })
    if (mode === 'hang') return hang()
    if (mode === 'refusal') {
      const message = 'This request was flagged for possible cyber risk.'
      out({ method: 'error', params: { error: { message }, willRetry: false, threadId, turnId: TURN } })
      return complete('failed', { message })
    }
    if (mode === 'command-failure') {
      for (const code of [1, 2]) out({ method: 'item/completed', params: { threadId, turnId: TURN, item: { type: 'commandExecution', id: 'c' + code, command: 'false', exitCode: code, status: 'failed' } } })
    }
    if (mode === 'approval') {
      for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'applyPatchApproval', 'execCommandApproval', 'item/tool/requestUserInput']) await ask(method)
    }
    out({ method: 'item/completed', params: { threadId, turnId: TURN, item: { type: 'agentMessage', id: 'm1', text: answerFor(params.outputSchema, mode), phase: 'final_answer' } } })
    complete('completed')
  }
  function handle({ id, method, params = {} }) {
    if (method === 'initialize') return reply(id, { userAgent: 'fake/0.0.0', codexHome: '/nonexistent', platformFamily: 'unix', platformOs: 'linux' })
    if (method === 'initialized') return undefined
    if (method === 'model/list') return reply(id, page(MODELS, params))
    if (method === 'config/read') {
      const layer = (type, servers, disabledReason = null) => ({ name: { type }, version: '1', config: { mcp_servers: Object.fromEntries(servers.map((name) => [name, { command: '/bin/true' }])) }, disabledReason })
      return reply(id, { config: { model: 'gpt-fake', mcp_servers: { hostDocs: { url: 'https://example.invalid/mcp' }, nodeRepl: { command: '/bin/true' } } }, origins: {},
        layers: [layer('user', ['hostDocs', 'nodeRepl']), layer('project', ['repoProbe']), layer('project', ['untrustedProbe'], 'the project is not trusted'), layer('system', [])] })
    }
    if (method === 'thread/start' || method === 'thread/resume') {
      for (const name of Object.keys(params.config?.mcp_servers ?? {})) {
        if (!LOADED.includes(name)) return refuse(id, 'failed to load configuration: invalid transport in mcp_servers.' + name)
      }
      thread = params
      threadId = method === 'thread/resume' ? params.threadId : THREAD
      const answer = () => reply(id, {
        thread: { id: threadId }, model: mode === 'model-swap' ? 'gpt-fake-other' : params.model, modelProvider: 'openai', cwd: params.cwd,
        instructionSources: [path.join(params.cwd, 'AGENTS.md')], approvalPolicy: params.approvalPolicy, approvalsReviewer: 'user',
        activePermissionProfile: { id: mode === 'profile-ignored' ? ':read-only' : params.permissions ?? ':read-only', extends: null }, reasoningEffort: null,
      })
      return mode === 'slow' ? setTimeout(answer, 1500) : answer()
    }
    if (method === 'mcpServerStatus/list') {
      if (thread?.config?.permissions && !thread.config.default_permissions) return refuse(id, 'failed to reload config')
      const servers = LOADED.map((name) => ({ name, runtimeStatus: thread?.config?.mcp_servers?.[name]?.enabled === false ? 'disabled' : 'failed', pluginId: null, tools: {} }))
      if (mode === 'mcp-leak') servers.push({ name: 'pluginDocs', runtimeStatus: 'ready', pluginId: 'docs@fake', tools: { search: {} } })
      return reply(id, page(servers, params))
    }
    if (method === 'turn/start') {
      if (mode === 'exit-nonzero') { process.stderr.write('SECRET-STDERR-TOKEN\n'); process.exit(3) }
      turnOpen = true
      reply(id, { turn: { id: TURN, items: [], status: 'inProgress', error: null } })
      return setTimeout(runTurn, mode === 'slow' ? 1500 : 0, params)
    }
    if (method === 'turn/steer') {
      if (!turnOpen || params.expectedTurnId !== TURN) return refuse(id, 'no active turn to steer')
      return reply(id, { turnId: TURN })
    }
    if (method === 'turn/interrupt') {
      if (!turnOpen) return refuse(id, 'no active turn to interrupt')
      reply(id, {})
      return complete('interrupted')
    }
    return out({ id, error: { code: -32601, message: 'unknown method ' + method } })
  }
  if (mode === 'bad-json') console.log('this line is not json')
  const lines = require('node:readline').createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    if (typeof message.method === 'string') {
      record.requests.push({ method: message.method, params: message.params })
      save()
      handle(message)
    } else {
      record.responses.push(message)
      save()
      waiting.get(message.id)?.()
    }
  })
  // Like the App Server, the fake exits when its client closes stdin.
  lines.on('close', () => process.exit(0))
}

function claudeCli() {
  let prompt = ''
  try { prompt = fs.readFileSync(path.join(process.env.TMPDIR, '..', 'prompt.txt'), 'utf8') } catch {}
  const mode = modeOf(prompt)
  const record = { argv, cwd: process.cwd(), env: process.env, pid: process.pid, frames: [] }
  const save = () => fs.writeFileSync(path.join(process.env.TMPDIR, 'fake-call.json'), JSON.stringify(record))
  save()
  if (argv.slice(0, 5).join(' ') !== '-p --input-format stream-json --output-format stream-json') { process.stderr.write('fake claude: unexpected argv\n'); process.exit(64) }
  // The catalog initialize answers with: aliases resolving to wire ids, a model with two efforts,
  // and one with no effort levels. An id outside it is served as itself, or by the alias below.
  const MODELS = [['default', 'claude-fake-1', true], ['sonnet', 'claude-fake-1', true], ['opus', 'claude-fake-opus-2', true],
    ['claude-fake-mini', 'claude-fake-mini', ['low', 'medium']], ['haiku', 'claude-fake-haiku-0', false]]
    .map(([value, resolvedModel, efforts]) => ({ value, resolvedModel, displayName: value, description: value, supportsEffort: efforts !== false,
      ...(efforts ? { supportedEffortLevels: efforts === true ? ['low', 'medium', 'high', 'xhigh', 'max'] : efforts } : {}) }))
  const ALIASES = { fable: 'claude-fake-fable-3' }
  const requested = flag('--model')
  const model = MODELS.find((entry) => entry.value === requested || entry.resolvedModel === requested)?.resolvedModel ?? ALIASES[requested] ?? requested
  const session = flag('--session-id') || flag('--resume')
  const schema = flag('--json-schema') ? JSON.parse(flag('--json-schema')) : null
  const answer = answerFor(schema, mode)
  let busy = false, closed = false, hangTimer = null, asked = 0
  const waiting = new Map()
  const reply = (request_id, response) => out({ type: 'control_response', response: { subtype: 'success', request_id, response } })
  const result = (fields) => {
    busy = false
    out({ type: 'result', session_id: session, ...fields })
    if (closed) process.exit(0)
  }
  const hang = () => { record.childPid = spawn('sleep', ['300'], { stdio: 'ignore' }).pid; save(); hangTimer = setInterval(() => {}, 1000) }
  const ask = (request) => new Promise((resolve) => {
    const request_id = 'cli-' + (++asked)
    waiting.set(request_id, resolve)
    out({ type: 'control_request', request_id, request })
  })
  function control({ request_id, request }) {
    if (request.subtype === 'initialize') {
      return reply(request_id, { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: MODELS, account: { email: 'secret@example.invalid' } })
    }
    if (request.subtype === 'mcp_status') {
      return reply(request_id, { mcpServers: mode === 'mcp-leak' ? [{ name: 'hostDocs', status: 'connected', scope: 'user' }] : [] })
    }
    if (request.subtype === 'interrupt') {
      reply(request_id, {})
      if (!busy) return undefined
      clearInterval(hangTimer)
      return result({ subtype: 'error_during_execution', is_error: true, result: '' })
    }
    return out({ type: 'control_response', response: { subtype: 'error', request_id, error: 'unsupported control request ' + request.subtype } })
  }
  async function turn() {
    const served = mode === 'init-swap' ? 'claude-fake-1' : model
    if (mode === 'mismatch') { out({ type: 'assistant', message: { model: 'claude-other-2', content: [{ type: 'text', text: 'swapped' }] } }); return hang() }
    if (['hang', 'tool-leak', 'plugin-leak'].includes(mode)) return hang()
    if (mode === 'refusal') {
      out({ type: 'assistant', message: { model: served, stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] } })
      return result({ subtype: 'success', is_error: false, result: '' })
    }
    if (mode === 'command-failure') {
      out({ type: 'assistant', message: { model: served, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }] } })
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Exit code 1' }] } })
    }
    if (mode === 'can-use-tool') await ask({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 't2' })
    out({ type: 'assistant', message: { model: '<synthetic>', content: [] } })
    out({ type: 'assistant', message: { model: served + '[1m]', content: [{ type: 'text', text: answer }] } })
    result({ subtype: 'success', is_error: false, result: answer, ...(schema ? { structured_output: JSON.parse(answer) } : {}),
      permission_denials: mode === 'approval' ? [{ tool_name: 'Read' }] : [] })
  }
  function user(frame) {
    if (mode === 'exit-nonzero') { process.stderr.write('SECRET-STDERR-TOKEN\n'); process.exit(3) }
    busy = true
    if (mode === 'bad-json') console.log('this line is not json')
    out({ type: 'system', subtype: 'init', session_id: session, model: mode === 'init-swap' ? 'claude-fake-1' : model, cwd: process.cwd(),
      tools: [...flag('--tools').split(','), ...(mode === 'tool-leak' ? ['WebFetch'] : [])],
      mcp_servers: mode === 'plugin-leak' ? [{ name: 'plugin:docs:search', status: 'connected' }] : [],
      plugins: mode === 'plugin-leak' ? [{ name: 'docs', path: '/plugins/docs' }] : [],
      permissionMode: 'dontAsk', apiKeySource: 'none', claude_code_version: '0.0.0-fake', slash_commands: [], output_style: 'default', skills: [] })
    out({ type: 'user', message: frame.message, parent_tool_use_id: null, session_id: session, uuid: frame.uuid, isReplay: true })
    setTimeout(turn, mode === 'slow' ? 1500 : 0)
  }
  const lines = require('node:readline').createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    const frame = JSON.parse(line)
    record.frames.push(frame)
    save()
    if (frame.type === 'control_request') return control(frame)
    if (frame.type === 'control_response') return waiting.get(frame.response.request_id)?.()
    if (frame.type === 'user') return user(frame)
    return undefined
  })
  // Like the CLI, the fake finishes the turn it is running before it exits on the end of stdin.
  lines.on('close', () => { closed = true; if (!busy) process.exit(0) })
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
  // An untracked .codex directory, which a write job's profile keeps read-only.
  mkdirSync(join(repo, '.codex'))
  symlinkSync(other, join(repo, 'escape'))

  const claudeHost = await connect({ host: 'claude', cwd: repo, env: { CLAUDE_PROJECT_DIR: repo } })
  const codexHost = await connect({ host: 'codex', cwd: repo })
  codexHost.target = 'claude'

  // The timeout case runs its 30-second budget while everything else proceeds.
  const timed = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=hang', timeBudgetSeconds: 30, waitSeconds: 0 })
  // So does a conforming answer to an admitted schema whose check branches two ways on each of 32
  // levels of references, which only the check's kill timer ends.
  const costly = { type: 'object', required: ['answer'], $defs: { d0: { type: 'number' } }, properties: { answer: { anyOf: [{ $ref: '#/$defs/d32' }, { type: 'string' }] } } }
  for (let level = 1; level <= 32; level++) costly.$defs[`d${level}`] = { anyOf: [{ $ref: `#/$defs/d${level - 1}` }, { $ref: `#/$defs/d${level - 1}` }] }
  assert.equal(schemaProblem(costly), null)
  const unchecked = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy', outputSchema: costly, waitSeconds: 0 })

  const names = async (client) => (await client.request('tools/list', {})).result.tools
  const claudeTools = await names(claudeHost)
  assert.deepEqual(claudeTools.map((tool) => tool.name), ['delegate_to_codex', 'delegation_result', 'delegation_cancel', 'delegation_steer', 'delegation_doctor'])
  assert.deepEqual((await names(codexHost)).map((tool) => tool.name), ['delegate_to_claude', 'delegation_result', 'delegation_cancel', 'delegation_steer', 'delegation_doctor'])
  assert.ok(claudeTools.every((tool) => tool.inputSchema?.type === 'object' && !('outputSchema' in tool)))
  assert.ok(!('maxTurns' in claudeTools[0].inputSchema.properties), 'the Codex target takes no Claude limits')
  ok('five tools per host, each reaching the other family only, with input schemas and no output schema')

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

  // The Codex thread: the flow_delegation profile with its exact grants, every capability off,
  // every MCP server config/read names disabled, the seat as developer instructions, and the
  // prompt alone on turn/start. Environment per target and access mode.
  const codexRead = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy read' })
  const codexWrite = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy write', access: 'workspace-write' })
  const FEATURES = ['plugins', 'apps', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'browser_use', 'computer_use', 'image_generation']
  for (const [result, write] of [[codexRead, false], [codexWrite, true]]) {
    assert.equal(result.job.status, 'succeeded', JSON.stringify(result.job.error))
    assert.equal(result.job.output, 'fake answer')
    const call = fakeCall(result.job.id)
    assert.deepEqual(call.argv, ['app-server', '--stdio'])
    assert.equal(call.cwd, repo)
    assert.deepEqual(call.requests.map((request) => request.method),
      ['initialize', 'initialized', 'model/list', 'model/list', 'config/read', 'thread/start', 'mcpServerStatus/list', 'mcpServerStatus/list', 'turn/start'])
    const [init] = asked(result.job.id, 'initialize')
    assert.deepEqual([init.clientInfo.name, init.capabilities.experimentalApi], ['flow-delegate', true])
    assert.deepEqual(asked(result.job.id, 'config/read'), [{ cwd: repo, includeLayers: true }])
    const [thread] = asked(result.job.id, 'thread/start')
    assert.deepEqual([thread.model, thread.cwd, thread.runtimeWorkspaceRoots, thread.approvalPolicy, thread.allowProviderModelFallback, thread.ephemeral],
      ['gpt-fake', repo, [repo], 'never', false, false])
    assert.equal(thread.permissions, 'flow_delegation')
    assert.equal(thread.config.default_permissions, 'flow_delegation')
    assert.deepEqual(thread.config.permissions.flow_delegation.network, { enabled: false })
    assert.deepEqual(thread.config.permissions.flow_delegation.filesystem, {
      ':minimal': 'read', [repo]: write ? 'write' : 'read', [join(repo, '.git')]: 'read',
      ...(write ? { [join(repo, '.codex')]: 'read' } : {}),
      [call.exe]: 'read', [join(fakeBin, 'codex')]: 'read', [jobPath(result.job.id, 'tmp')]: 'write',
    }, 'the grants: :minimal, the worktree, its Git metadata and the running executable read, the job tmp written')
    for (const name of FEATURES) assert.equal(thread.config[`features.${name}`], false, `features.${name} is off`)
    assert.deepEqual(thread.config.memories, { use_memories: false, generate_memories: false })
    assert.deepEqual(thread.config.apps, { _default: { enabled: false } })
    assert.deepEqual(thread.config.mcp_servers, { hostDocs: { enabled: false }, nodeRepl: { enabled: false }, repoProbe: { enabled: false } },
      'every server a loaded layer names is disabled, and none from a layer Codex did not load')
    assert.equal(thread.developerInstructions, readFileSync(jobPath(result.job.id, 'seat.md'), 'utf8'))
    assert.ok(thread.developerInstructions.startsWith(SEAT), 'the Codex developer instructions start with the seat bytes')
    assert.ok(thread.developerInstructions.includes(write ? 'You may edit only the assigned Git worktree.' : 'This is a read-only job.'))
    const [turn] = asked(result.job.id, 'turn/start')
    assert.deepEqual(turn.input, [{ type: 'text', text: `FLOW_FAKE_MODE=happy ${write ? 'write' : 'read'}`, text_elements: [] }], 'turn/start carries the prompt alone')
    assert.deepEqual([turn.threadId, turn.model, turn.effort, turn.approvalPolicy, turn.cwd, 'outputSchema' in turn], [result.job.threadId, 'gpt-fake', 'low', 'never', repo, false])
    assert.deepEqual([result.job.servedModel, result.job.threadId], ['gpt-fake', '11111111-1111-4111-8111-111111111111'])
    assert.deepEqual(result.job.isolation, { profile: 'flow_delegation', mcpServers: ['hostDocs', 'nodeRepl', 'repoProbe'], instructionSources: [join(repo, 'AGENTS.md')] })
    assert.equal(result.job.catalog, 'listed')
    assert.equal(result.job.promptSent, true)
    assert.deepEqual(asked(result.job.id, 'mcpServerStatus/list').map((params) => [params.threadId, params.detail, params.cursor]),
      [[result.job.threadId, 'toolsAndAuthOnly', null], [result.job.threadId, 'toolsAndAuthOnly', '2']], 'the inventory is read for the thread, page by page')
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
    assert.deepEqual(call.argv.slice(0, 6), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])
    assert.ok(call.argv.includes('--replay-user-messages'))
    assert.ok(!call.argv.some((word) => word.includes('FLOW_FAKE_MODE')), 'the prompt reached argv')
    assert.deepEqual(wrote(result.job.id).map((frame) => (frame.type === 'control_request' ? frame.request.subtype : frame.type)), ['initialize', 'mcp_status', 'user'],
      'no user message before initialize and mcp_status have answered')
    const [message] = wrote(result.job.id).filter((frame) => frame.type === 'user')
    assert.deepEqual([message.client_composed, message.parent_tool_use_id, message.session_id, message.message.role], [true, null, result.job.threadId, 'user'])
    assert.match(message.uuid, /^[0-9a-f-]{36}$/)
    assert.deepEqual(result.job.isolation, { mcpServers: [], tools: flag('--tools').split(',') })
    assert.equal(result.job.catalog, 'listed')
    assert.equal(result.job.promptSent, true)
    const settings = JSON.parse(flag('--settings'))
    assert.deepEqual(settings.sandbox.network.allowedDomains, [])
    assert.equal(settings.sandbox.failIfUnavailable, true)
    assert.deepEqual(write ? settings.sandbox.filesystem.allowWrite[0] : settings.sandbox.filesystem.denyWrite, write ? repo : [repo])
    assert.ok(settings.permissions.deny.includes(`Read(/${home}/.ssh/**)`))
    assert.ok(settings.sandbox.filesystem.denyRead.includes(join(fakeBin, 'codex')), 'the provider executables are masked')
    assert.deepEqual(settings.permissions.allow, write ? [`Edit(/${repo}/**)`] : [])
    assert.deepEqual(userTexts(result.job.id), [`FLOW_FAKE_MODE=happy ${write ? 'write' : 'read'}`], 'the Claude task goes in one user message alone')
    assert.ok(readFileSync(flag('--append-system-prompt-file'), 'utf8').startsWith(SEAT), 'the Claude seat file starts with the seat bytes')
    assert.equal(call.env.CLAUDE_CODE_NO_MODEL_FALLBACK, '1')
    assert.equal(call.env.SMOKE_LEAK, undefined)
  }
  ok('the Codex thread carries the flow_delegation profile, every capability off and every configured MCP server disabled; Claude runs over stream-json with its prompt in one client_composed user message after initialize and mcp_status; argv per Claude access; the seat bytes first; and only allowlisted variables plus the depth marker reach the provider')

  // Nothing goes out until the live thread reads back its profile, its model and an MCP inventory
  // with every server disabled.
  for (const [mode, kind, details] of [['profile-ignored', 'ISOLATION', { profile: ':read-only' }],
    ['model-swap', 'MODEL_MISMATCH', { expected: 'gpt-fake', served: 'gpt-fake-other' }], ['mcp-leak', 'ISOLATION', { servers: ['pluginDocs'] }]]) {
    const refusedEarly = await start(claudeHost, { prompt: `FLOW_FAKE_MODE=${mode}` })
    assert.deepEqual([refusedEarly.job.status, refusedEarly.job.error?.kind, refusedEarly.job.promptSent, refusedEarly.job.threadId, refusedEarly.job.isolation],
      ['failed', kind, false, null, null], JSON.stringify(refusedEarly.job))
    assert.deepEqual(refusedEarly.job.error.details, details)
    assert.deepEqual(asked(refusedEarly.job.id, 'turn/start'), [], `${mode}: a prompt reached the provider`)
    assert.ok(await until(() => !alive(fakeCall(refusedEarly.job.id).pid)), `${mode}: the App Server outlived the refusal`)
  }
  ok('a thread that reads back another profile, another model or a reachable MCP server fails before the prompt, and the App Server records no turn/start')

  // Claude: an MCP server in mcp_status stops the job before the prompt, and an init frame that
  // names a tool outside the requested set, an MCP server or a plugin stops the turn it opened.
  const claudeLeak = await start(codexHost, { prompt: 'FLOW_FAKE_MODE=mcp-leak' })
  assert.deepEqual([claudeLeak.job.status, claudeLeak.job.error?.kind, claudeLeak.job.promptSent, claudeLeak.job.threadId, claudeLeak.job.isolation],
    ['failed', 'ISOLATION', false, null, null], JSON.stringify(claudeLeak.job))
  assert.deepEqual(claudeLeak.job.error.details, { servers: ['hostDocs'] })
  assert.deepEqual(userTexts(claudeLeak.job.id), [], 'mcp-leak: a prompt reached the provider')
  assert.ok(await until(() => !alive(fakeCall(claudeLeak.job.id).pid)), 'the Claude CLI outlived the refusal')
  for (const [mode, details] of [['tool-leak', { tools: ['WebFetch'], mcpServers: [], plugins: [] }],
    ['plugin-leak', { tools: [], mcpServers: ['plugin:docs:search'], plugins: ['docs'] }]]) {
    const leaked = await start(codexHost, { prompt: `FLOW_FAKE_MODE=${mode}` })
    assert.deepEqual([leaked.job.status, leaked.job.error?.kind, leaked.job.promptSent, leaked.job.isolation], ['failed', 'ISOLATION', true, null], JSON.stringify(leaked.job))
    assert.deepEqual(leaked.job.error.details, details)
    assert.ok(wrote(leaked.job.id).some((frame) => frame.request?.subtype === 'interrupt'), `${mode}: the turn was not interrupted`)
    const flowLines = journal(leaked.job.id).filter((event) => typeof event.type === 'string' && event.type.startsWith('flow.'))
    assert.deepEqual(flowLines, [{ type: 'flow.stop', reason: 'ISOLATION' }, { type: 'flow.interrupt', method: 'interrupt', delivered: true }])
    const leakedCall = fakeCall(leaked.job.id)
    assert.ok(await until(() => !alive(leakedCall.pid) && !alive(leakedCall.childPid)), `${mode}: the provider group outlived the stop`)
  }
  ok('Claude: an MCP server in mcp_status fails ISOLATION with no user message written, and an init frame with an extra tool, an MCP server or a plugin interrupts its turn and fails ISOLATION')

  // The catalogs. A listed model at an effort the catalog does not list for it fails BAD_MODEL
  // before anything else happens; a model listed with no effort levels takes no effort at all; an
  // unlisted id is admitted and says so; a Claude alias is held to the wire id it resolves to.
  const codexBad = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy', model: 'gpt-fake-mini', effort: 'high' })
  assert.deepEqual([codexBad.job.status, codexBad.job.error?.kind, codexBad.job.promptSent, codexBad.job.catalog], ['failed', 'BAD_MODEL', false, null])
  assert.deepEqual(codexBad.job.error.details, { model: 'gpt-fake-mini', efforts: ['low', 'medium'] })
  assert.deepEqual(fakeCall(codexBad.job.id).requests.map((request) => request.method), ['initialize', 'initialized', 'model/list', 'model/list'],
    'a refused effort opened no thread')
  const codexUnlisted = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy', model: 'gpt-fake-unlisted' })
  assert.deepEqual([codexUnlisted.job.status, codexUnlisted.job.catalog, codexUnlisted.job.servedModel], ['succeeded', 'absent', 'gpt-fake-unlisted'])
  for (const [model, effort, efforts] of [['claude-fake-mini', 'high', ['low', 'medium']], ['haiku', 'low', []]]) {
    const claudeBad = await start(codexHost, { prompt: 'FLOW_FAKE_MODE=happy', model, effort })
    assert.deepEqual([claudeBad.job.status, claudeBad.job.error?.kind, claudeBad.job.promptSent, claudeBad.job.catalog], ['failed', 'BAD_MODEL', false, null])
    assert.deepEqual(claudeBad.job.error.details, { model, efforts })
    assert.deepEqual(wrote(claudeBad.job.id).map((frame) => frame.request?.subtype ?? frame.type), ['initialize'], `${model}: the CLI was asked for more than its catalog`)
  }
  for (const [model, catalog, servedModel] of [['opus', 'listed', 'claude-fake-opus-2'], ['claude-fake-opus-2', 'listed', 'claude-fake-opus-2'], ['fable', 'absent', 'claude-fake-fable-3']]) {
    const served = await start(codexHost, { prompt: 'FLOW_FAKE_MODE=happy', model, effort: 'max' })
    assert.deepEqual([served.job.status, served.job.catalog, served.job.servedModel], ['succeeded', catalog, servedModel], `${model}: ${JSON.stringify(served.job.error)}`)
  }
  const substituted = await start(codexHost, { prompt: 'FLOW_FAKE_MODE=init-swap', model: 'opus' })
  assert.deepEqual([substituted.job.status, substituted.job.error?.kind, substituted.job.catalog], ['failed', 'MODEL_MISMATCH', 'listed'])
  assert.deepEqual(substituted.job.error.details, { expected: 'claude-fake-opus-2', served: 'claude-fake-1' })
  assert.ok(wrote(substituted.job.id).some((frame) => frame.request?.subtype === 'interrupt'), 'the substitute session was not interrupted')
  ok('the catalogs: a listed model at an unlisted effort, or with no efforts, fails BAD_MODEL before the thread or the prompt on both targets; an unlisted id succeeds with catalog absent; a Claude alias or its wire id is held to the resolved model, and a session that opens on another fails MODEL_MISMATCH')

  // Review mode pins SHAs before the job exists and forces read-only and the findings schema.
  const baseSha = git(repo, 'rev-parse', 'HEAD~1')
  const headSha = git(repo, 'rev-parse', 'HEAD')
  const review = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy', mode: 'adversarial-review', base: 'main~1', access: 'workspace-write' })
  assert.equal(review.job.status, 'succeeded')
  assert.deepEqual([review.job.baseSha, review.job.headSha, review.job.access], [baseSha, headSha, 'read-only'])
  assert.equal(asked(review.job.id, 'thread/start')[0].config.permissions.flow_delegation.filesystem[repo], 'read')
  assert.deepEqual(asked(review.job.id, 'turn/start')[0].outputSchema, FINDINGS_SCHEMA)
  assert.ok(turnText(review.job.id).includes(`git diff ${baseSha} ${headSha}`))
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

  const strict = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'integer' } } }
  for (const client of [claudeHost, codexHost]) {
    const mistyped = await start(client, { prompt: 'FLOW_FAKE_MODE=happy', outputSchema: strict })
    assert.deepEqual([mistyped.job.status, mistyped.job.error?.kind, mistyped.job.structured], ['failed', 'SCHEMA_OUTPUT', null])
    assert.deepEqual(mistyped.job.error.details.errors, ['$.answer: expected integer'])
    assert.equal(mistyped.job.output, '{"answer":"42"}', 'the raw answer is kept')
  }
  const badReview = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=bad-structure', mode: 'adversarial-review', base: 'main~1' })
  assert.deepEqual([badReview.job.status, badReview.job.error?.kind], ['failed', 'SCHEMA_OUTPUT'])
  assert.deepEqual(badReview.job.error.details.errors, ['$.findings[0]: missing the required property "systemic"', '$.findings[0].severity: not one of the allowed values'])
  // A nested $id starts a resource its own references resolve in, and #name is an anchor, not a
  // pointer; the checker resolves every $ref as a pointer from the root, so it admits neither.
  const scoped = { type: 'object', $defs: { value: { type: 'string' }, child: { $id: 'https://example.invalid/child', type: 'object', $defs: { value: { type: 'integer' } }, properties: { value: { $ref: '#/$defs/value' } } } }, properties: { child: { $ref: '#/$defs/child' } } }
  for (const outputSchema of [{ type: 'object', patternProperties: {} }, { type: 'object', properties: { a: { type: 'text' } } }, { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } },
    scoped, { type: 'object', properties: { a: { $ref: '#name' } } }]) {
    await refused(claudeHost, { outputSchema }, 'BAD_SCHEMA')
  }
  assert.equal(schemaProblem({ $id: 'https://example.invalid/root', type: 'object', $defs: { a: { type: 'string' } }, properties: { a: { $ref: '#/$defs/a' }, self: { $ref: '#' } } }), null, 'a root $id and pointers from the root are admitted')
  const multiple = ([of, value]) => validate({ type: 'object', properties: { n: { type: 'number', multipleOf: of } } }, { n: value }).length === 0
  assert.deepEqual([[1, 1e-10], [1, 1.0000000001], [0.1, 0.35], [3e-308, 1e308], [0.7, 1e300]].filter(multiple), [], 'a non-multiple fails, including one whose quotient overflows or rounds to an integer')
  assert.deepEqual([[1, 0], [1, -4], [0.1, 0.3], [0.01, 1.15], [1e-308, 1e308], [2.5, 1e21]].filter((pair) => !multiple(pair)), [], 'a multiple passes as the decimals JSON prints')
  ok('an answer that breaks its schema fails SCHEMA_OUTPUT on both targets and in review, a schema the server cannot check is refused, and multipleOf is exact')

  const slow = join(tmp, 'slow-pattern.json')
  writeFileSync(slow, JSON.stringify({ type: 'object', properties: { title: { type: 'string', pattern: '^([a-z]+\\s?)*$' } } }))
  const checkStarted = Date.now()
  assert.equal(checkAnswer(slow, { title: `${'a'.repeat(40)}!` }, 1000), null, 'a pattern that backtracks without end is killed, not waited on')
  assert.ok(Date.now() - checkStarted < 5000, `the kill took ${Date.now() - checkStarted} ms`)
  assert.deepEqual(checkAnswer(slow, { title: 'a b' }), [])
  assert.deepEqual(checkAnswer(slow, { title: 'A' }), ['$.title: does not match the pattern'])
  ok('the answer is checked in a child process that a timer kills, so a backtracking pattern cannot hold the runner')

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
  assert.ok(wrote(swapped.job.id).some((frame) => frame.request?.subtype === 'interrupt'), 'the swap was not interrupted')
  const denied = await expect(codexHost, 'FLOW_FAKE_MODE=approval', 'failed', 'APPROVAL_REQUIRED')
  assert.equal(denied.job.output, 'fake answer', 'a denied turn keeps its answer')
  // Claude asks by control request only if something routes a prompt to flow. It is refused, and
  // the job ends APPROVAL_REQUIRED with the answer kept.
  const toolAsk = await expect(codexHost, 'FLOW_FAKE_MODE=can-use-tool', 'failed', 'APPROVAL_REQUIRED')
  assert.deepEqual([toolAsk.job.output, toolAsk.job.error.details], ['fake answer', { denied: ['Bash'] }])
  assert.deepEqual(wrote(toolAsk.job.id).filter((frame) => frame.type === 'control_response'),
    [{ type: 'control_response', response: { subtype: 'error', request_id: 'cli-1', error: 'Flow grants a delegated job no approvals.' } }])
  // Codex asks by server request. Each approval gets its method's decline, a request that is not an
  // approval gets -32601, and the job ends APPROVAL_REQUIRED with the answer kept.
  const declined = await expect(claudeHost, 'FLOW_FAKE_MODE=approval', 'failed', 'APPROVAL_REQUIRED')
  assert.deepEqual([declined.job.output, declined.job.error.details], ['fake answer', { method: 'item/commandExecution/requestApproval' }])
  const answers = Object.fromEntries(fakeCall(declined.job.id).responses.map((response) => [response.id, response.result ?? { code: response.error.code }]))
  const rejection = { decision: { denied: { rejection: 'Flow grants a delegated job no approvals.' } } }
  assert.deepEqual(answers, { 'srv-1': { decision: 'decline' }, 'srv-2': { decision: 'decline' }, 'srv-3': { permissions: {}, scope: 'turn' },
    'srv-4': rejection, 'srv-5': rejection, 'srv-6': { code: -32601 } })
  ok('refusals are typed on both targets, a model swap is latched and interrupted at once, a denied permission or a Claude tool request is APPROVAL_REQUIRED, and every approval request is declined in its own shape')

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
  assert.equal(JSON.parse(collected.job.events.at(-1)).method, 'turn/completed')
  ok('waitSeconds 0 detaches, and delegation_result waits for the outcome and returns the trailing events')

  // Continue resumes the provider thread, same cwd and access.
  const resumed = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy again', continue: codexRead.job.id })
  assert.equal(resumed.job.threadId, codexRead.job.threadId)
  assert.equal(resumed.job.parentJobId, codexRead.job.id)
  const [resumeThread] = asked(resumed.job.id, 'thread/resume')
  assert.equal(resumeThread.threadId, codexRead.job.threadId)
  assert.equal(resumeThread.permissions, 'flow_delegation')
  assert.equal(resumeThread.config.permissions.flow_delegation.filesystem[repo], 'read')
  assert.deepEqual(asked(resumed.job.id, 'thread/start'), [], 'a continuation opens no new thread')
  const claudeResumed = await start(codexHost, { prompt: 'FLOW_FAKE_MODE=happy again', continue: claudeRead.job.id })
  const claudeArgv = fakeCall(claudeResumed.job.id).argv
  assert.equal(claudeArgv[claudeArgv.indexOf('--resume') + 1], claudeRead.job.threadId)
  assert.ok(!claudeArgv.includes('--session-id'))
  assert.equal(claudeResumed.job.threadId, claudeRead.job.threadId)
  await refused(claudeHost, { continue: codexRead.job.id, access: 'workspace-write' }, 'BAD_REQUEST')
  ok('continue resumes the same Codex thread and Claude session, and refuses a changed access')

  // continue takes a finished job only. A running one is refused, with a pointer to
  // delegation_steer, and left running.
  for (const client of [claudeHost, codexHost]) {
    const running = await start(client, { prompt: 'FLOW_FAKE_MODE=hang', waitSeconds: 0 })
    assert.ok(await until(() => readJob(running.job.id).threadId), 'the running job recorded its provider thread')
    const continued = await start(client, { prompt: 'FLOW_FAKE_MODE=happy new direction', continue: running.job.id })
    assert.deepEqual([continued.ok, continued.error?.kind], [false, 'JOB_STATE'], JSON.stringify(continued))
    assert.match(continued.error.message, /delegation_steer/)
    assert.equal(readJob(running.job.id).status, 'running', 'a refused continuation stopped the job')
    assert.equal((await client.call('delegation_cancel', { jobId: running.job.id })).job.status, 'cancelled')
  }
  ok('continuing a running job on either target is refused with JOB_STATE and leaves the job running')

  // Cancel stops the whole provider group.
  const hanging = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=hang', waitSeconds: 0, access: 'workspace-write' })
  const hangCall = await until(() => fakeCall(hanging.job.id)?.childPid && fakeCall(hanging.job.id))
  await refused(claudeHost, { access: 'workspace-write' }, 'WORKSPACE_BUSY')
  assert.equal((await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy' })).job.status, 'succeeded', 'a reader shares a busy worktree')
  const cancelled = await claudeHost.call('delegation_cancel', { jobId: hanging.job.id })
  assert.equal(cancelled.job.status, 'cancelled')
  assert.equal(cancelled.job.error.kind, 'CANCELLED')
  assert.ok(await until(() => !alive(hangCall.pid) && !alive(hangCall.childPid)), 'cancel left part of the provider group running')
  // The App Server took turn/interrupt while it was still alive to record it, and the runner
  // journaled its answer before signalling the group.
  assert.deepEqual(asked(hanging.job.id, 'turn/interrupt'), [{ threadId: THREAD, turnId: TURN }])
  const stops = journal(hanging.job.id).filter((event) => typeof event.type === 'string' && event.type.startsWith('flow.'))
  assert.deepEqual(stops, [{ type: 'flow.stop', reason: 'CANCELLED' }, { type: 'flow.interrupt', method: 'turn/interrupt', delivered: true }])
  assert.equal((await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy', access: 'workspace-write' })).job.status, 'succeeded', 'cancel released the lease')
  const claudeHanging = await start(codexHost, { prompt: 'FLOW_FAKE_MODE=hang', waitSeconds: 0 })
  const claudeHangCall = await until(() => fakeCall(claudeHanging.job.id)?.childPid && fakeCall(claudeHanging.job.id))
  assert.equal((await codexHost.call('delegation_cancel', { jobId: claudeHanging.job.id })).job.status, 'cancelled')
  assert.ok(await until(() => !alive(claudeHangCall.pid) && !alive(claudeHangCall.childPid)), 'cancel left part of the Claude group running')
  assert.ok(wrote(claudeHanging.job.id).some((frame) => frame.request?.subtype === 'interrupt'), 'the Claude CLI got no interrupt')
  const claudeStops = journal(claudeHanging.job.id).filter((event) => typeof event.type === 'string' && event.type.startsWith('flow.'))
  assert.deepEqual(claudeStops, [{ type: 'flow.stop', reason: 'CANCELLED' }, { type: 'flow.interrupt', method: 'interrupt', delivered: true }])
  ok('one writer per worktree, readers alongside it, and cancel interrupts the Codex turn or the Claude session, then kills the provider and its children and frees the lease')

  // The Codex session steers its open turn against that turn's own id, and a turn that has ended
  // takes no steer. The session is driven directly here, over the fake App Server.
  const steerId = randomUUID()
  const steerDir = jobs.jobDir(steerId)
  mkdirSync(join(steerDir, 'tmp'), { recursive: true })
  writeFileSync(join(steerDir, 'prompt.txt'), 'FLOW_FAKE_MODE=hang')
  let steerChild = null
  const session = await codexTransport.open({
    job: { id: steerId, target: 'codex', cwd: repo, worktree: repo, access: 'read-only', model: 'gpt-fake', effort: 'low', hasSchema: false, resumeThreadId: null },
    dir: steerDir, bin: join(fakeBin, 'codex'), seat: SEAT, env: { ...ENV, TMPDIR: join(steerDir, 'tmp'), FLOW_DELEGATION_DEPTH: '1', FLOW_DELEGATION_JOB: steerId },
    onSpawn: (child) => { steerChild = child }, onLine: () => {},
  })
  assert.deepEqual(await session.steer('before the prompt'), { delivered: false, error: 'the turn has ended' })
  await session.send('FLOW_FAKE_MODE=hang')
  assert.equal(session.turnOpen, true)
  assert.deepEqual(await session.steer('also count the lines'), { delivered: true })
  assert.deepEqual(asked(steerId, 'turn/steer'), [{ threadId: THREAD, expectedTurnId: TURN, input: [{ type: 'text', text: 'also count the lines', text_elements: [] }] }])
  assert.deepEqual(await session.interrupt(), { method: 'turn/interrupt', delivered: true })
  assert.ok(await until(() => session.turnEnded), 'the interrupted turn never ended')
  assert.deepEqual(await session.steer('too late'), { delivered: false, error: 'the turn has ended' })
  assert.equal(await session.interrupt(), null, 'an ended turn takes no interrupt')
  session.close()
  try { process.kill(-steerChild.pid, 'SIGKILL') } catch {}
  ok('the Codex session steers its open turn with turn/steer against the turn id, interrupts it, and takes neither once the turn has ended')

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

  // A job settled long after its runner died records a group id that now names someone else's
  // group: a process with that pid and a different start. Nothing may be signalled.
  const bystander = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  const deadPid = spawnSync('true').pid
  const reused = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy' })
  jobs.writeJob({ ...readJob(reused.job.id), status: 'running', endedAt: null, runnerPid: deadPid, runnerStart: '1', providerPgid: bystander.pid, providerStart: '1' })
  const recycled = await claudeHost.call('delegation_result', { jobId: reused.job.id })
  assert.equal(recycled.job.status, 'unknown')
  await sleep(300)
  assert.ok(alive(bystander.pid), 'a reused group id was signalled')
  process.kill(-bystander.pid, 'SIGKILL')
  ok('a recorded provider group whose id now names another process is never signalled')

  // Of many admissions racing to take over one stale lease, exactly one holds it afterwards.
  const RACER = String.raw`
    import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
    import { randomUUID } from 'node:crypto'
    const { acquireLease, jobDir, writeJob } = await import(process.env.JOBS_URL)
    const [worktree, go, ready] = process.argv.slice(1)
    const job = { id: randomUUID(), access: 'workspace-write', worktree, status: 'queued', createdAt: new Date().toISOString() }
    mkdirSync(jobDir(job.id), { recursive: true })
    writeJob(job)
    writeFileSync(ready + job.id, '')
    while (!existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
    try { acquireLease(job); console.log('won ' + job.id) } catch (error) { console.log('lost ' + (error.kind ?? error.message)) }`
  for (let round = 0; round < 8; round++) {
    const worktree = join(tmp, `race-${round}`)
    const stale = { id: randomUUID(), access: 'workspace-write', worktree, status: 'failed', createdAt: new Date().toISOString() }
    mkdirSync(jobs.jobDir(stale.id), { recursive: true })
    jobs.writeJob(stale)
    jobs.acquireLease(stale)
    const [go, ready] = [join(tmp, `race-${round}-go`), join(tmp, `race-${round}-ready-`)]
    const racers = Array.from({ length: 12 }, () => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', RACER, worktree, go, ready],
        { env: { ...ENV, JOBS_URL: pathToFileURL(join(PLUGIN, 'delegate', 'jobs.mjs')).href }, stdio: ['ignore', 'pipe', 'inherit'] })
      let text = ''
      child.stdout.on('data', (chunk) => { text += chunk })
      child.on('close', () => resolve(text.trim()))
    }))
    await until(() => readdirSync(tmp).filter((name) => name.startsWith(`race-${round}-ready-`)).length === 12, 30_000)
    writeFileSync(go, '')
    const results = await Promise.all(racers)
    const won = results.filter((line) => line.startsWith('won ')).map((line) => line.slice(4))
    assert.equal(won.length, 1, `round ${round}: ${results.join(' | ')}`)
    const leaseDir = join(state, 'leases', createHash('sha256').update(worktree).digest('hex'))
    assert.deepEqual(readdirSync(leaseDir), won, `round ${round}: the lease directory names its one holder`)
    assert.ok(results.every((line) => line.startsWith('won ') || line === 'lost WORKSPACE_BUSY'), results.join(' | '))
  }
  ok('twelve admissions racing over one stale lease leave exactly one holder, eight rounds running')

  // A write job still queued past its grace: a new writer takes its lease, and its runner, arriving
  // late, must find the job already settled rather than start a second writer.
  const late = { id: randomUUID(), host: 'claude', target: 'codex', mode: 'task', access: 'workspace-write', cwd: repo, worktree: repo,
    model: 'gpt-fake', effort: 'low', status: 'queued', createdAt: new Date(Date.now() - 120_000).toISOString(), endedAt: null,
    timeBudgetSeconds: 60, maxTurns: null, maxBudgetUsd: null, parentJobId: null, resumeThreadId: null, sessionId: null, threadId: null,
    requestPreview: 'late', baseSha: null, headSha: null, hasSchema: false, servedModel: null, output: null, structured: null, commandFailures: 0, error: null }
  mkdirSync(jobs.jobDir(late.id), { recursive: true })
  writeFileSync(jobPath(late.id, 'prompt.txt'), 'FLOW_FAKE_MODE=happy late')
  jobs.writeJob(late)
  jobs.acquireLease(late)
  const taker = await start(claudeHost, { prompt: 'FLOW_FAKE_MODE=happy', access: 'workspace-write' })
  assert.equal(taker.job.status, 'succeeded', JSON.stringify(taker.job.error))
  assert.deepEqual([readJob(late.id).status, readJob(late.id).error?.kind], ['failed', 'RUNNER_LOST'])
  spawnSync(process.execPath, [MAIN, 'run', '--job', late.id], { env: ENV })
  assert.equal(fakeCall(late.id), null, 'the late runner started a provider in a worktree another writer held')
  assert.equal(readJob(late.id).status, 'failed')
  ok('a queued writer past its grace is claimed and settled before its lease goes, so its late runner never starts')

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
  assert.deepEqual(asked(timed.job.id, 'turn/interrupt'), [{ threadId: THREAD, turnId: TURN }], 'the budget interrupts the Codex turn before the group is killed')
  ok('a job past its time budget is interrupted, stopped and fails TIMEOUT')

  const bounded = await claudeHost.call('delegation_result', { jobId: unchecked.job.id, waitSeconds: 60 })
  assert.deepEqual([bounded.job.status, bounded.job.error?.kind, bounded.job.structured], ['failed', 'SCHEMA_OUTPUT', null])
  assert.match(bounded.job.error.message, /could not be checked against the requested schema within 10 seconds/)
  ok('an answer whose check branches exponentially fails SCHEMA_OUTPUT once the check is killed, and the job settles')
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
