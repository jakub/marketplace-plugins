// The Codex target over `codex app-server --stdio`, spoken by hand: line-delimited JSON-RPC with
// requests by id, their responses, notifications, and server requests that must be answered. The
// App Server opens a thread first and takes the prompt later, so the thread is configured before
// any prompt exists, and turn/start goes out only once the live thread reads back the profile,
// the requested model and an MCP inventory with every server disabled. A failed read-back fails
// the job ISOLATION or MODEL_MISMATCH with no prompt sent. Before the thread exists, model/list is
// Codex's own catalog: a model it lists at an effort it does not list fails BAD_MODEL.
//
// The App Server has no --ignore-user-config and loads the human's config.toml,
// so everything that grants a capability is named off in the thread config: the plugin, app,
// hook, memory, multi-agent, browser, computer-use and image features, memories, every app, and
// every MCP server config/read names.
//
// The flow_delegation permission profile is the containment. Codex's built-in :read-only and
// :workspace profiles read every credential on the machine. This one grants read on :minimal, the
// worktree, its Git metadata and the running Codex executable, write on the TMPDIR the provider's
// environment names and nothing else (and on the worktree for a write job, with .git, .agents and
// .codex kept read-only), and no network.
// Codex runs each shell command by re-executing its own binary inside bubblewrap, so without the
// executable grant every command fails with execvp ENOENT while the turn still succeeds
// (openai/codex#29049).
//
// Codex merges the thread config into every loaded layer table by table, so a profile that a user
// or project layer already defines under the same name keeps that layer's parent and grants beside
// flow's own (0.159.2: a user-layer [permissions.flow_delegation] with `extends = ":read-only"` and
// a "/outside" write grant survived into a read-only thread). Each thread therefore names a profile
// no layer can know in advance, flow_delegation_ and a random suffix, and the read-back holds the
// thread to it: its id, no parent, no network, and no writable root the profile did not grant.
// Codex reports no read grant, so the unique name is what keeps a layer's read grants out.
//
// No approval is ever granted. Each approval request gets its method's decline, and any request
// that names an approval fails the job APPROVAL_REQUIRED once its turn ends, with the answer kept.
//
// The thread's model is read back once, when the thread opens. A model/rerouted notification that
// moves the turn to any other model stops the turn, and the job fails MODEL_MISMATCH with the model
// Codex moved to as its served model.
//
// A steer goes into the open turn as turn/steer with expectedTurnId set to that turn's id, so Codex
// refuses it rather than let it land anywhere else. The turn keeps running, and stdin closes only
// at turn/completed.
//
// The doctor's check runs the same handshake up to the read-back, on an ephemeral thread that
// takes no model or seat of its own, and closes without a turn, so a Codex release that changes a
// method or a field this file depends on fails the preflight instead of a job.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { DelegateError, git, log } from './jobs.mjs'
import { answered, classify, clip, DOCTOR_STDERR, handshake, listing } from './providers.mjs'

export const PROFILE = 'flow_delegation'
const VERSION = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version
const STEP_MS = 30_000
const INTERRUPT_MS = 10_000
const STEER_MS = 15_000
const MAX_PAGES = 10
const FEATURES_OFF = ['plugins', 'apps', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'browser_use', 'computer_use', 'image_generation']
const REJECTION = 'Flow grants a delegated job no approvals.'
// Each approval method's decline, in the shape that method's response takes.
const DECLINE = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  'item/permissions/requestApproval': { permissions: {}, scope: 'turn' },
  applyPatchApproval: { decision: { denied: { rejection: REJECTION } } },
  execCommandApproval: { decision: { denied: { rejection: REJECTION } } },
}
const decline = (method) => (Object.hasOwn(DECLINE, method) ? { result: DECLINE[method] } : { error: { code: -32601, message: `flow-delegate does not answer ${method}.` } })
const textInput = (text) => [{ type: 'text', text, text_elements: [] }]
const keys = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [])

// Codex has wrapped an API error as a JSON string inside a message, so one that parses is unwrapped.
function errorText(text) {
  try {
    const parsed = JSON.parse(text)
    return clip(parsed?.error?.message ?? parsed?.message ?? text)
  } catch { return clip(text) }
}

// One JSON-RPC peer over the child's stdio. Each stdout line is dispatched, then handed to onLine
// unchanged. A request fails when the provider refuses it, stays silent past its timeout, or exits
// first.
function connect(child, { onLine, onNotification, onRequest, diagnostics = 'stderr.txt beside the events file has its diagnostics' }) {
  const pending = new Map()
  let next = 0
  let gone = null
  let ended = false
  const lost = (method) => new DelegateError('PROVIDER_ERROR', `The Codex App Server ${gone} before it answered ${method}; ${diagnostics}.`)
  const write = (message) => { if (!gone && !ended) child.stdin.write(`${JSON.stringify(message)}\n`) }
  const end = (why) => {
    gone ??= why
    for (const [id, entry] of pending) {
      pending.delete(id)
      entry.lose()
    }
  }
  child.stdin.on('error', () => {})
  child.on('error', () => end('could not be started'))
  child.on('close', () => end('exited'))
  const dispatch = (message) => {
    if (typeof message.method === 'string') {
      if (!Object.hasOwn(message, 'id')) return onNotification(message.method, message.params ?? {})
      const answer = onRequest(message.method, message.params ?? {})
      return write('result' in answer ? { id: message.id, result: answer.result } : { id: message.id, error: answer.error })
    }
    const entry = pending.get(message.id)
    if (!entry) return undefined
    pending.delete(message.id)
    return message.error ? entry.refuse(message.error) : entry.resolve(message.result ?? {})
  }
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch {}
    if (message && typeof message === 'object') {
      try { dispatch(message) } catch (error) { log(`codex app-server dispatch failed: ${error?.stack || error}`) }
    }
    onLine(line)
  })
  return {
    request(method, params, ms = STEP_MS) {
      return new Promise((resolve, reject) => {
        if (gone || ended) {
          reject(gone ? lost(method) : new DelegateError('PROVIDER_ERROR', `The Codex session was closed before ${method}.`))
          return
        }
        const id = ++next
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new DelegateError('PROVIDER_ERROR', `The Codex App Server did not answer ${method} within ${ms / 1000}s.`))
        }, ms)
        pending.set(id, {
          resolve: (result) => { clearTimeout(timer); resolve(result) },
          refuse: (error) => {
            clearTimeout(timer)
            const text = errorText(error?.message)
            const refusal = new DelegateError(classify(text), `Codex refused ${method}: ${text}`)
            refusal.refused = true
            reject(refusal)
          },
          lose: () => { clearTimeout(timer); reject(lost(method)) },
        })
        write({ id, method, params })
      })
    },
    notify(method) { write({ method }) },
    close() {
      if (ended) return
      ended = true
      child.stdin.end()
    },
  }
}

// A paged list: at most ten pages, and a cursor seen twice is a failure, not a loop.
async function pages(rpc, method, params, kind) {
  const data = []
  const seen = new Set()
  let cursor = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await rpc.request(method, { ...params, cursor })
    if (!Array.isArray(response?.data)) throw new DelegateError(kind, `Codex answered ${method} without a list.`)
    data.push(...response.data)
    cursor = response.nextCursor ?? null
    if (!cursor) return data
    if (seen.has(cursor)) throw new DelegateError(kind, `Codex repeated a ${method} cursor.`)
    seen.add(cursor)
  }
  throw new DelegateError(kind, `Codex answered ${method} in more than ${MAX_PAGES} pages.`)
}

// The first step on every connection: initialize with the experimental API, which the thread
// fields below need, then the running executable the sandbox must be able to re-exec.
async function initialize(rpc, child, bin) {
  await rpc.request('initialize', { clientInfo: { name: 'flow-delegate', title: 'Flow delegate', version: VERSION }, capabilities: { experimentalApi: true } })
  rpc.notify('initialized')
  return runtimePaths(child.pid, bin)
}

// Codex's catalog with hidden models, so an id the account may use is not read as unlisted: each
// model and the efforts it accepts.
async function listModels(rpc) {
  return (await pages(rpc, 'model/list', { limit: 100, includeHidden: true }, 'PROVIDER_ERROR')).filter((model) => typeof model?.id === 'string').map((model) => ({
    id: model.id,
    efforts: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).map((option) => option?.reasoningEffort).filter((effort) => typeof effort === 'string'),
  }))
}

// Every MCP server name in the effective config and in each layer Codex loaded. A thread config
// that disables a name no loaded layer defines fails with "invalid transport" (0.159.0), so a
// layer Codex reports as disabled, such as an untrusted project's, contributes no names; if the
// thread loads it anyway, the read-back before the prompt finds its servers.
async function configuredServers(rpc, cwd) {
  const response = await rpc.request('config/read', { cwd, includeLayers: true })
  const names = new Set(keys(response?.config?.mcp_servers))
  for (const layer of Array.isArray(response?.layers) ? response.layers : []) {
    if (layer?.disabledReason == null) for (const name of keys(layer?.config?.mcp_servers)) names.add(name)
  }
  return [...names].sort()
}

// The thread's own MCP inventory. Every server must read disabled with no tools, whatever layer
// defined it, so a server the thread config did not know about still stops the job. An inventory
// Codex refuses to report is a failed read-back too.
async function checkServers(rpc, threadId) {
  let statuses
  try {
    statuses = await pages(rpc, 'mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 100 }, 'ISOLATION')
  } catch (error) {
    if (error.refused) throw new DelegateError('ISOLATION', `${error.message}; no prompt was sent.`)
    throw error
  }
  const exposed = statuses.filter((status) => status?.runtimeStatus !== 'disabled' || keys(status?.tools).length > 0)
  if (exposed.length) {
    throw new DelegateError('ISOLATION', `Codex left ${exposed.length} MCP server(s) reachable in the thread, so no prompt was sent.`,
      { servers: exposed.slice(0, 20).map((status) => clip(status?.name ?? 'unnamed')) })
  }
  return statuses.map((status) => String(status?.name)).sort()
}

// The profile the live thread reports, and the sandbox Codex projects from it. Anything but the
// profile this thread named fails ISOLATION, and so does that profile with a parent, with network
// access, or with a writable root it did not grant, which only another layer can have added.
// Nothing goes to the thread.
function checkProfile(opened, name, profile) {
  const active = opened.activePermissionProfile ?? {}
  if (active.id !== name) {
    const reported = active.id == null ? null : clip(active.id)
    throw new DelegateError('ISOLATION', `Codex opened the thread under the ${reported ?? 'no named'} permission profile, not ${name}, so no prompt was sent.`, { profile: reported })
  }
  const sandbox = opened.sandbox ?? {}
  const granted = Object.keys(profile.filesystem).filter((path) => profile.filesystem[path] === 'write')
  const extra = (Array.isArray(sandbox.writableRoots) ? sandbox.writableRoots : []).filter((root) => !granted.includes(root))
  const found = [
    active.extends != null && `a parent profile, ${clip(active.extends)}`,
    !['readOnly', 'workspaceWrite'].includes(sandbox.type) && `a ${clip(sandbox.type ?? 'missing')} sandbox`,
    sandbox.networkAccess !== false && 'network access',
    extra.length > 0 && `${extra.length} writable root(s) it did not grant`,
  ].filter(Boolean)
  if (found.length) {
    throw new DelegateError('ISOLATION', `Codex opened the thread under ${name} with ${found.join(', ')}, so no prompt was sent.`,
      { profile: name, extends: active.extends == null ? null : clip(active.extends), sandbox: clip(sandbox.type ?? 'missing'), networkAccess: sandbox.networkAccess ?? null, writableRoots: extra.slice(0, 20).map(clip) })
  }
  return name
}

function packageRoot(path) {
  const segments = path.split(sep)
  const at = segments.lastIndexOf('node_modules')
  if (at < 0 || at + 1 >= segments.length) return null
  return segments.slice(0, at + (segments[at + 1].startsWith('@') ? 3 : 2)).join(sep)
}

// The Codex executable, as the sandbox's re-exec needs it: what the App Server is running, read
// from /proc once initialize has answered (a launcher that execs in place, such as a mise shim,
// has done so by then), the PATH entry that started it and that entry's real path, and the npm
// package root when a path runs through node_modules, since an npm install re-execs the vendor
// binary nested inside its package.
function runtimePaths(pid, bin) {
  let exe
  try { exe = realpathSync(`/proc/${pid}/exe`) } catch {
    throw new DelegateError('PROVIDER_ERROR', 'The running Codex executable could not be read from /proc.')
  }
  const paths = new Set([exe, bin])
  try { paths.add(realpathSync(bin)) } catch {}
  for (const path of [...paths]) {
    const root = packageRoot(path)
    if (root) paths.add(root)
  }
  return [...paths]
}

async function permissionProfile(job, tmp, runtime) {
  const write = job.access === 'workspace-write'
  const filesystem = { ':minimal': 'read', [job.worktree]: write ? 'write' : 'read' }
  if (write) {
    for (const name of ['.git', '.agents', '.codex']) {
      const path = join(job.worktree, name)
      if (!existsSync(path)) continue
      filesystem[path] = 'read'
      try { filesystem[realpathSync(path)] = 'read' } catch {}
    }
  }
  for (const flag of ['--absolute-git-dir', '--git-common-dir']) {
    const path = await git(job.cwd, ['rev-parse', '--path-format=absolute', flag])
    if (path) try { filesystem[realpathSync(path)] = 'read' } catch {}
  }
  for (const path of runtime) filesystem[path] ??= 'read'
  filesystem[realpathSync(tmp)] = 'write'
  return { description: 'Flow delegated job', filesystem, network: { enabled: false } }
}

// A profile name for one thread, which no config layer can have defined before it.
const profileName = () => `${PROFILE}_${randomUUID().replaceAll('-', '')}`

function threadParams(job, seat, servers, name, profile) {
  return {
    model: job.model, cwd: job.cwd, runtimeWorkspaceRoots: [job.worktree],
    approvalPolicy: 'never', approvalsReviewer: 'user', serviceTier: 'default',
    allowProviderModelFallback: false,
    permissions: name,
    developerInstructions: seat,
    config: {
      ...Object.fromEntries(FEATURES_OFF.map((feature) => [`features.${feature}`, false])),
      memories: { use_memories: false, generate_memories: false },
      apps: { _default: { enabled: false } },
      mcp_servers: Object.fromEntries(servers.map((server) => [server, { enabled: false }])),
      default_permissions: name,
      permissions: { [name]: profile },
    },
  }
}

export const transport = {
  name: 'Codex',
  async open({ job, dir, bin, env, seat, onSpawn, onLine }) {
    const child = spawn(bin, ['app-server', '--stdio'], { cwd: job.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env })
    onSpawn(child)
    let turnId = null
    let turn = null
    let answer = ''
    let failures = 0
    let lastError = null
    let approvalMethod = null
    let rerouted = null
    const session = {
      threadId: null, servedModel: null, models: null, catalog: null, isolation: null, stopReason: null, promptSent: false, turnOpen: false, turnEnded: false,
      async send(prompt) {
        const outputSchema = job.hasSchema ? JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8')) : null
        session.promptSent = true
        const started = await rpc.request('turn/start', {
          threadId: session.threadId, input: textInput(prompt), cwd: job.cwd, approvalPolicy: 'never',
          model: job.model, effort: job.effort, summary: 'detailed', serviceTier: 'default', ...(outputSchema ? { outputSchema } : {}),
        })
        if (!started?.turn?.id) throw new DelegateError('PROVIDER_ERROR', 'Codex accepted the prompt without naming its turn.')
        turnId ??= started.turn.id
        if (!session.turnEnded) session.turnOpen = true
      },
      async steer(text) {
        if (!session.turnOpen) return { delivered: false, error: 'the turn has ended' }
        try {
          await rpc.request('turn/steer', { threadId: session.threadId, expectedTurnId: turnId, input: textInput(text) }, STEER_MS)
          return { delivered: true }
        } catch (error) { return { delivered: false, error: clip(error.message) } }
      },
      async interrupt() {
        if (!session.turnOpen) return null
        try {
          await rpc.request('turn/interrupt', { threadId: session.threadId, turnId }, INTERRUPT_MS)
          return { method: 'turn/interrupt', delivered: true }
        } catch (error) { return { method: 'turn/interrupt', delivered: false, error: clip(error.message) } }
      },
      close() { rpc.close() },
      finish({ code, signal }) {
        const base = { threadId: session.threadId, servedModel: session.servedModel, output: null, structured: null, commandFailures: failures, error: null }
        if (rerouted) return { ...base, status: 'failed', error: { kind: 'MODEL_MISMATCH', message: `Codex rerouted the turn to ${rerouted.served}, not ${rerouted.expected}, and the turn was stopped.`, details: rerouted } }
        if (turn?.status === 'failed' || (!turn && lastError)) {
          const problem = (turn?.error?.message && errorText(turn.error.message)) || lastError || 'the turn failed'
          return { ...base, status: 'failed', error: { kind: classify(problem), message: `Codex: ${problem}` } }
        }
        if (!turn) {
          return { ...base, status: 'failed', error: { kind: 'PROVIDER_ERROR', message: `Codex exited (${signal ?? code}) without ending its turn; stderr.txt beside the events file has its diagnostics.` } }
        }
        if (turn.status !== 'completed') return { ...base, status: 'failed', error: { kind: 'PROVIDER_ERROR', message: `Codex ended its turn ${clip(turn.status)}.` } }
        const items = Array.isArray(turn.items) ? turn.items : []
        const output = String(items.findLast((item) => item?.type === 'agentMessage' && item.text)?.text || answer).trim()
        if (approvalMethod) {
          return { ...base, output: output || null, status: 'failed', error: { kind: 'APPROVAL_REQUIRED', message: 'Codex asked for an approval this job does not grant, and it was declined.', details: { method: approvalMethod } } }
        }
        let structured
        if (job.hasSchema) try { structured = JSON.parse(output) } catch {}
        return answered(job, dir, base, output, structured)
      },
    }
    const onNotification = (method, params) => {
      if (method === 'turn/started') {
        if (params.turn?.id && !session.turnEnded) {
          turnId ??= params.turn.id
          session.turnOpen = true
        }
      } else if (method === 'item/completed') {
        const item = params.item ?? {}
        if (item.type === 'agentMessage' && typeof item.text === 'string') answer = item.text
        else if (item.type === 'commandExecution' && (item.status === 'failed' || (item.exitCode ?? 0) !== 0)) failures++
      } else if (method === 'turn/completed') {
        if (turnId && params.turn?.id && params.turn.id !== turnId) return
        turn = params.turn ?? {}
        session.turnOpen = false
        session.turnEnded = true
      } else if (method === 'error' && params.willRetry !== true) {
        lastError = errorText(params.error?.message)
      } else if (method === 'model/rerouted' && !rerouted && typeof params.toModel === 'string' && params.toModel !== job.model) {
        // The backend moved the turn to another model, whatever the thread read back when it
        // opened, so the answer would not be the requested model's. The turn stops now.
        rerouted = { expected: job.model, served: clip(params.toModel), reason: params.reason == null ? null : clip(params.reason) }
        session.servedModel = rerouted.served
        session.stopReason ??= 'MODEL_MISMATCH'
      }
    }
    const onRequest = (method) => {
      if (/approval/i.test(method)) approvalMethod ??= method
      return decline(method)
    }
    const rpc = connect(child, { onLine, onNotification, onRequest })
    try {
      const runtime = await initialize(rpc, child, bin)
      // A listed model at an effort it does not list stops here, before config/read and the thread.
      session.models = await listModels(rpc)
      session.catalog = listing('Codex', session.models.find((model) => model.id === job.model), job)
      const servers = await configuredServers(rpc, job.cwd)
      const name = profileName()
      const permissions = await permissionProfile(job, env.TMPDIR, runtime)
      const params = threadParams(job, seat, servers, name, permissions)
      const opened = job.resumeThreadId
        ? await rpc.request('thread/resume', { threadId: job.resumeThreadId, ...params })
        : await rpc.request('thread/start', { ...params, ephemeral: false, serviceName: 'flow-delegate' })
      if (!opened?.thread?.id) throw new DelegateError('PROVIDER_ERROR', 'Codex opened no thread.')
      // Nothing goes out until the live thread reads back what was asked for: the profile, the
      // model, and an MCP inventory with every server disabled. The config layers flow built the
      // thread from are an assumption; this is the thread itself.
      const profile = checkProfile(opened, name, permissions)
      if (opened.model !== job.model) {
        const served = opened.model == null ? null : clip(opened.model)
        throw new DelegateError('MODEL_MISMATCH', `Codex opened the thread on ${served ?? 'no named model'}, not ${job.model}, so no prompt was sent.`, { expected: job.model, served })
      }
      const mcpServers = await checkServers(rpc, opened.thread.id)
      session.threadId = opened.thread.id
      session.servedModel = opened.model
      session.isolation = { profile, mcpServers, instructionSources: Array.isArray(opened.instructionSources) ? opened.instructionSources : [] }
    } catch (error) {
      rpc.close()
      throw error
    }
    return session
  },
  // The doctor's handshake in cwd: initialize, the catalog, config/read, then an ephemeral thread
  // with a read-only job's profile and thread config, read back for its profile and its MCP
  // inventory. The thread gets no model and no seat, so Codex opens it on its default model, and
  // nothing is ever sent to it. An ephemeral thread leaves no rollout behind.
  check({ cwd, bin, env }) {
    const child = spawn(bin, ['app-server', '--stdio'], { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env })
    const rpc = connect(child, { onLine: () => {}, onNotification: () => {}, onRequest: decline, diagnostics: DOCTOR_STDERR })
    return handshake('Codex', child, rpc, async (report) => {
      const runtime = await initialize(rpc, child, bin)
      report.protocol.push('initialize')
      report.catalog = await listModels(rpc)
      report.protocol.push('model/list')
      const servers = await configuredServers(rpc, cwd)
      report.protocol.push('config/read')
      const job = { cwd, worktree: cwd, access: 'read-only' }
      const name = profileName()
      const permissions = await permissionProfile(job, env.TMPDIR, runtime)
      const opened = await rpc.request('thread/start', { ...threadParams(job, undefined, servers, name, permissions), ephemeral: true, serviceName: 'flow-delegate' })
      if (!opened?.thread?.id) throw new DelegateError('PROVIDER_ERROR', 'Codex opened no thread.')
      report.profile = checkProfile(opened, name, permissions)
      report.protocol.push('thread/start')
      report.mcpServersDisabled = (await checkServers(rpc, opened.thread.id)).length
      report.protocol.push('mcpServerStatus/list')
    })
  },
}
