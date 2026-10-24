// The delegate MCP server, spoken by hand over stdio in two eras, chosen per request. A request
// whose params._meta carries io.modelcontextprotocol/protocolVersion is modern (2026-07-28): its
// identity and capabilities come from that _meta alone, and the server writes no request to the
// client for it. Any other request is legacy and reads what initialize negotiated. Both eras get
// server/discover, ping, tools/list, tools/call, tasks/get, tasks/cancel, tasks/update and the
// cancelled notification; initialize is legacy only, and the one outbound request, roots/list,
// serves legacy requests only. A modern delegate call that declares the tasks extension and names
// no waitSeconds is answered with a task, which is the job under its own id. It declares
// no outputSchema, so structuredContent needs no validator. Jobs outlive this process: a runner is
// detached, and stdin closing ends the server and nothing else. The doctor is the one tool that
// starts a provider in this process, for a handshake that sends no prompt.
import { mkdirSync, realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { RETENTION_MS, stateDir } from '../lib/state-dir.mjs'
import { transport as claude } from './claude-control.mjs'
import { transport as codex } from './codex-app-server.mjs'
import * as jobs from './jobs.mjs'
import { findExecutable, probe, providerEnv } from './providers.mjs'

// The versions a legacy initialize negotiates, and the one modern version a request's _meta may name.
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
const MODERN = '2026-07-28'
const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_CLIENT = 'io.modelcontextprotocol/clientInfo'
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
const TASKS = 'io.modelcontextprotocol/tasks'
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo'
const POLL_MS = 1000
const RESULT_KEYS = ['jobId', 'waitSeconds', 'events']
const TRANSPORTS = { codex, claude }

function tools(target) {
  const title = target === 'codex' ? 'Codex' : 'Claude'
  const models = target === 'codex'
    ? 'A Codex model id such as gpt-6-sol or gpt-6-luna.'
    : 'A Claude alias (sonnet, opus, fable) or a full id such as claude-opus-5-5.'
  const jobId = { type: 'string', description: 'The job id a delegate call returned.' }
  const start = {
    prompt: { type: 'string', description: 'The task, or extra focus for a review (may be empty in review mode).' },
    model: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]*$', description: `${models} Required on every call.` },
    effort: { type: 'string', enum: jobs.EFFORTS, description: 'Reasoning effort. Required on every call.' },
    cwd: { type: 'string', description: 'Absolute directory inside a workspace root and a Git worktree.' },
    mode: { type: 'string', enum: ['task', 'adversarial-review'], default: 'task' },
    access: { type: 'string', enum: ['read-only', 'workspace-write'], description: 'Default read-only; workspace-write confines writes to the worktree and holds its one write lease.' },
    base: { type: 'string', description: 'Review mode: the base revision, pinned to a SHA before the job starts.' },
    head: { type: 'string', default: 'HEAD', description: 'Review mode: the head revision, pinned to a SHA.' },
    outputSchema: { type: 'object', description: 'Task mode: a JSON Schema (type object, at most 64 KiB) the answer must follow; the answer is checked against it before the job succeeds. Write closed objects with every property required.' },
    continue: { type: 'string', description: 'The id of a finished job whose provider thread this new task resumes, in the same cwd and access. A running job is refused: steer it with delegation_steer instead.' },
    timeBudgetSeconds: { type: 'integer', minimum: 30, maximum: 7200, default: 900 },
    waitSeconds: { type: 'integer', minimum: 0, maximum: 7200, description: 'How long to wait for the outcome; default the whole budget. 0 detaches: collect it with delegation_result.' },
    ...(target === 'claude' ? {
      maxTurns: { type: 'integer', minimum: 1, maximum: 1000, description: 'Hard Claude turn limit.' },
      maxBudgetUsd: { type: 'number', minimum: 0.01, maximum: 1000, description: 'Hard Claude cost limit in US dollars.' },
    } : {}),
  }
  const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
  return [
    {
      name: `delegate_to_${target}`,
      title: `Delegate to ${title}`,
      description: `Run a ${title} job: a task, or an adversarial review of a pinned base..head diff that returns typed findings. Waits for the outcome unless waitSeconds is 0, or returns a background MCP task when the client declares the tasks extension and waitSeconds is absent. continue resumes a finished job's thread.`,
      inputSchema: object(start, ['prompt', 'model', 'effort', 'cwd']),
    },
    {
      name: 'delegation_result',
      title: 'Delegation result',
      description: 'Read one job: status, outcome and the last event lines. waitSeconds blocks until it ends or the wait runs out.',
      inputSchema: object({
        jobId,
        waitSeconds: { type: 'integer', minimum: 0, maximum: 7200, default: 0 },
        events: { type: 'integer', minimum: 0, maximum: 200, default: 20, description: 'How many trailing event lines to include.' },
      }, ['jobId']),
      annotations: { readOnlyHint: true },
    },
    {
      name: 'delegation_cancel',
      title: 'Cancel a delegation',
      description: `Stop a queued or running ${title} job and its whole process group.`,
      inputSchema: object({ jobId }, ['jobId']),
      annotations: { destructiveHint: true },
    },
    {
      name: 'delegation_steer',
      title: 'Steer a delegation',
      description: `Add an instruction to a running ${title} job's open turn without stopping it. The job keeps its id and its thread. The result carries steer.status: delivered once ${title} took it, failed when it refused it or the turn had ended, unknown when the job never answered or ${title} had neither taken nor refused it yet.`,
      inputSchema: object({
        jobId,
        prompt: { type: 'string', description: 'The instruction to add, at most 64 KiB.' },
      }, ['jobId', 'prompt']),
    },
    {
      name: 'delegation_doctor',
      title: 'Delegation doctor',
      description: `Report whether ${title} is installed and signed in, the usable workspace roots and the state directory, and prove the transport with a handshake that runs no turn: ${title}'s model catalog, ${target === 'codex' ? 'the permission profile and ' : ''}the MCP servers a job's session would see.`,
      inputSchema: object({}),
      annotations: { readOnlyHint: true },
    },
  ]
}

function toolResult(value) {
  const job = value.job
  const line = job && `${job.status} | ${job.target} ${job.model} ${job.effort} | ${job.requestPreview}`
  const summary = value.steer ? `steer ${value.steer.status} | ${line}`
    : job ? line : value.error ? `${value.error.kind}: ${value.error.message}` : value.summary
  const body = { summary, ...value }
  // The summary opens the text, so a client that shows one line shows something readable.
  const text = JSON.stringify(body, null, 2).replace(/^\{\n {2}"summary":/, '{"summary":')
  return { content: [{ type: 'text', text }], structuredContent: body, ...(body.ok ? {} : { isError: true }) }
}

const jobResult = (job, events = 0) => toolResult({
  ok: !['failed', 'cancelled', 'unknown'].includes(job.status),
  job: jobs.envelope(job, events),
})

// A job seen as a task. Every terminal job is a completed task whose result is the CallToolResult a
// synchronous call returns, so a failed, cancelled or unknown job reaches the caller as its isError
// envelope. The timestamps come from the record, so a poll reads nothing else. ttlMs is a floor:
// the prune counts its 14 days from endedAt, and only at a server's start.
const task = (job) => {
  const done = jobs.TERMINAL.has(job.status)
  return {
    taskId: job.id, status: done ? 'completed' : 'working', statusMessage: job.status,
    createdAt: job.createdAt, lastUpdatedAt: job.endedAt ?? job.startedAt ?? job.createdAt, ttlMs: RETENTION_MS,
    ...(done ? { result: jobResult(job) } : { pollIntervalMs: POLL_MS }),
  }
}

const INTERNAL_MESSAGE = 'The delegate server failed; server.log in the state directory has the detail.'
// A DelegateError is written for the caller. Anything else is an internal fault: its detail goes
// to server.log and the caller gets a fixed message.
function publicError(error) {
  if (error instanceof jobs.DelegateError) return { kind: error.kind, message: error.message, ...(error.details ? { details: error.details } : {}) }
  jobs.log(`internal error: ${error?.stack || error}`)
  return { kind: 'INTERNAL', message: INTERNAL_MESSAGE }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
// A protocol error, answered as a JSON-RPC error rather than a tool result.
const rpcError = (code, message, data) => Object.assign(new Error(message), { rpc: { code, message, ...(data ? { data } : {}) } })

export async function serve({ host, version }) {
  const target = host === 'claude' ? 'codex' : 'claude'
  const toolList = tools(target)
  const fixedRoots = (host === 'codex' ? [await jobs.codexRoot()] : [process.env.CLAUDE_PROJECT_DIR]).filter(Boolean)
  // A modern request may not be asked for roots, so its roots are the fixed ones, resolved once for
  // the life of the process: admission and every later lookup read the same list.
  const modernRoots = Object.freeze(jobs.canonicalRoots(fixedRoots))
  // The legacy globals. Only a legacy initialize writes them, and only legacy requests read them.
  let clientCapabilities = {}
  let clientInfo = null
  let legacyProtocol = null
  let nextId = 0
  const pending = new Map()
  const inflight = new Map()

  process.stdout.on('error', () => process.exit(0))
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const request = (method, params, ms) => new Promise((resolve) => {
    const id = `flow-delegate-${++nextId}`
    const timer = setTimeout(() => { pending.delete(id); resolve(null) }, ms)
    pending.set(id, (reply) => { clearTimeout(timer); resolve(reply) })
    send({ id, method, params })
  })
  // A modern result says it is complete; a legacy result goes out as it always has. A result that
  // names its own resultType keeps it.
  const reply = (ctx, id, result) => send({ id, result: ctx.era === 'modern' ? { resultType: 'complete', ...result } : result })

  // The era of one request, read before it is dispatched and never written anywhere. A modern
  // request's identity and capabilities come from its own _meta; a legacy request gets a snapshot of
  // what the last initialize negotiated. A _meta that is no object cannot carry the version key, so
  // the request is legacy by construction and is answered as it always was. A malformed or
  // unsupported modern _meta throws the JSON-RPC error the request is answered with. This validates
  // the fields the server reads and no others: the version, clientCapabilities (required), the
  // string name and version of clientInfo when that is present, and experimental, extensions and
  // every entry of either as objects. Every other field of the RequestMeta, and every other
  // capability or clientInfo field, passes through untouched.
  function context(message) {
    const meta = message.params?._meta
    if (!isObject(meta) || !Object.hasOwn(meta, META_VERSION)) {
      return Object.freeze({ era: 'legacy', protocolVersion: legacyProtocol, clientInfo, capabilities: clientCapabilities, tasks: false })
    }
    const requested = meta[META_VERSION]
    if (typeof requested !== 'string') throw rpcError(-32602, `Invalid params: ${META_VERSION} must be a string.`)
    if (requested !== MODERN) throw rpcError(-32022, 'Unsupported protocol version.', { supported: [MODERN], requested })
    if (!Object.hasOwn(meta, META_CAPABILITIES)) throw rpcError(-32602, `Invalid params: ${META_CAPABILITIES} is required.`)
    for (const key of [META_CLIENT, META_CAPABILITIES]) {
      if (Object.hasOwn(meta, key) && !isObject(meta[key])) throw rpcError(-32602, `Invalid params: ${key} must be an object.`)
    }
    const info = meta[META_CLIENT]
    if (info !== undefined && (typeof info.name !== 'string' || typeof info.version !== 'string')) {
      throw rpcError(-32602, `Invalid params: ${META_CLIENT} needs a string name and a string version.`)
    }
    // The nested declarations are checked too: experimental and extensions, when present, are objects,
    // and so is every entry of either, an unknown extension's settings included.
    const capabilities = meta[META_CAPABILITIES]
    for (const field of ['experimental', 'extensions']) {
      if (!Object.hasOwn(capabilities, field)) continue
      if (!isObject(capabilities[field])) throw rpcError(-32602, `Invalid params: ${META_CAPABILITIES}.${field} must be an object.`)
      for (const [entry, settings] of Object.entries(capabilities[field])) {
        if (!isObject(settings)) throw rpcError(-32602, `Invalid params: ${META_CAPABILITIES}.${field}[${JSON.stringify(entry)}] must be an object.`)
      }
    }
    const tasks = Object.hasOwn(capabilities.extensions ?? {}, TASKS)
    return Object.freeze({
      era: 'modern', protocolVersion: requested, clientInfo: info ?? null, capabilities, tasks,
    })
  }

  // Roots are asked for on every legacy call that needs them, so a changed workspace is seen at
  // once. A modern call gets the fixed roots and no request.
  async function roots(ctx) {
    if (ctx.era === 'modern') return modernRoots
    const paths = [...fixedRoots]
    if (ctx.capabilities.roots) {
      const reply = await request('roots/list', {}, 5_000)
      for (const root of reply?.result?.roots ?? []) {
        try { if (String(root.uri).startsWith('file:')) paths.push(fileURLToPath(root.uri)) } catch {}
      }
    }
    return jobs.canonicalRoots(paths)
  }

  // The transport's own handshake against the provider a job would run, with a job's environment
  // and a private TMPDIR named and made the way a job's is, in the first usable root or the state
  // directory when there is none. It creates the state directory first, because that directory can
  // be the cwd and holds the server.log that a failed handshake points to. It sends no prompt, and
  // it removes the TMPDIR afterwards.
  async function checkTransport(bin, usable) {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
    const tmp = jobs.tmpPath('doctor')
    jobs.makeTmp(tmp)
    try {
      const cwd = usable[0] ?? realpathSync(stateDir())
      return await TRANSPORTS[target].check({ cwd, bin, env: providerEnv({ id: 'doctor', target }, tmp) })
    } finally { jobs.dropTmp('doctor', tmp) }
  }

  // ok needs the provider installed and signed in, its handshake passed, and a usable root. The
  // handshake is the protocol drift check: a CLI release that changes a method or a field the
  // transport depends on fails it here, with a typed kind, before any job runs. client, tasks and
  // rootsSource describe the calling request, not the connection.
  async function doctor(ctx) {
    const usable = await roots(ctx)
    const bin = findExecutable(target)
    const [provider, transport] = await Promise.all([probe(target), bin ? checkTransport(bin, usable) : null])
    const error = !bin || !provider.installed ? { kind: 'PROVIDER_NOT_INSTALLED', message: `${target} is not on the PATH this server sees.` }
      : provider.auth?.loggedIn !== true ? { kind: 'PROVIDER_AUTH', message: `${target} is not signed in.` }
        : !transport.ok ? transport.error
          : !usable.length ? { kind: 'NO_ROOTS', message: 'The host supplied no usable workspace root.' } : null
    const ready = transport?.ok && `${target} ${provider.version} ready: ${transport.catalog.length} model(s) listed, ${transport.profile ? `profile ${transport.profile}, ` : ''}${transport.mcpServersDisabled} MCP server(s) disabled, no turn`
    return toolResult({
      ok: !error, summary: error ? `${error.kind}: ${error.message}` : ready,
      host, target, provider, transport, roots: usable, stateDir: stateDir(), node: process.version,
      client: { era: ctx.era, protocolVersion: ctx.protocolVersion, clientInfo: ctx.clientInfo, capabilities: ctx.capabilities },
      tasks: { served: true, declaredOnThisCall: ctx.tasks },
      rootsSource: ctx.era === 'legacy' && ctx.capabilities.roots ? 'roots/list' : 'fixed',
      ...(error ? { error } : {}),
    })
  }

  async function call(name, args, signal, progressToken, ctx) {
    const started = Date.now()
    let reported = 0
    const onTick = (job) => {
      if (progressToken === undefined || !job || Date.now() - reported < 10_000) return
      reported = Date.now()
      const seconds = Math.round((reported - started) / 1000)
      send({ method: 'notifications/progress', params: { progressToken, progress: seconds, message: `${job.status} after ${seconds}s` } })
    }
    if (name === `delegate_to_${target}`) {
      let job = await jobs.admit(args, { host, roots: await roots(ctx), signal })
      // A call that declared the tasks extension and named no wait gets the admitted job as a task at
      // once. An explicit waitSeconds, 0 included, keeps its meaning.
      const asTask = ctx.tasks && !Object.hasOwn(args, 'waitSeconds')
      if (!asTask) {
        // Past the budget, the default wait holds on for the job's whole stop (STOP_SECONDS in jobs.mjs).
        const seconds = args.waitSeconds ?? job.timeBudgetSeconds + jobs.STOP_SECONDS
        if (seconds > 0) job = await jobs.wait(job.id, seconds, { signal, onTick })
      }
      // A request cancelled before its answer is written takes its admitted job with it as a
      // cooperative cancel marker, whether the call waited, detached or was to become a task. Once
      // the answer is written, the request no longer reaches the job.
      if (signal.aborted && !jobs.TERMINAL.has(job.status)) jobs.requestCancel(job.id)
      return asTask ? { resultType: 'task', ...task(job) } : jobResult(job)
    }
    if (name === 'delegation_result') {
      jobs.checkKeys(args, RESULT_KEYS)
      const seconds = jobs.integer(args.waitSeconds, 'waitSeconds', 0, 7200, 0)
      const events = jobs.integer(args.events, 'events', 0, 200, 20)
      let job = jobs.visibleJob(args.jobId, { host, roots: await roots(ctx) })
      if (seconds > 0) job = await jobs.wait(job.id, seconds, { signal, onTick })
      return jobResult(job, events)
    }
    if (name === 'delegation_cancel') {
      jobs.checkKeys(args, ['jobId'])
      return jobResult(await jobs.cancel(jobs.visibleJob(args.jobId, { host, roots: await roots(ctx) })))
    }
    // A steer is ok only once the provider took it, and the job comes back as it stands.
    if (name === 'delegation_steer') {
      const { job, steer } = await jobs.requestSteer(args, { host, roots: await roots(ctx), signal })
      return toolResult({ ok: steer.status === 'delivered', job: jobs.envelope(job), steer })
    }
    if (name === 'delegation_doctor') {
      jobs.checkKeys(args, [])
      return doctor(ctx)
    }
    return null
  }

  async function onCall(message, ctx) {
    const { name, arguments: args = {}, _meta: meta } = message.params ?? {}
    if (!toolList.some((tool) => tool.name === name)) {
      send({ id: message.id, error: { code: -32602, message: `Unknown tool: ${name}` } })
      return
    }
    const controller = new AbortController()
    inflight.set(message.id, controller)
    let result
    try { result = await call(name, args, controller.signal, meta?.progressToken, ctx) } catch (error) {
      result = toolResult({ ok: false, error: publicError(error) })
    } finally { inflight.delete(message.id) }
    // A request the client cancelled gets no response.
    if (!controller.signal.aborted) reply(ctx, message.id, result)
  }

  // An internal fault on a task method: the detail goes to server.log and the caller gets the fixed
  // message.
  const fault = (error) => {
    jobs.log(`internal error: ${error?.stack || error}`)
    return { code: -32603, message: INTERNAL_MESSAGE }
  }

  // tasks/get, tasks/cancel and tasks/update, answered synchronously, so no notifications/cancelled
  // can reach one. A request that does not declare the extension is refused before its id is read,
  // and an id that names no job this session may see gets one answer whatever the reason, so the
  // answer tells nobody whether a job exists. A cancel only writes the marker: the runner stops and
  // settles the job, or a later tasks/get reconciles it if its runner never started or died, and a
  // native success may still win.
  function onTask(message, ctx) {
    const { id } = message
    if (!ctx.tasks) {
      return send({ id, error: { code: -32021, message: `${message.method} needs the ${TASKS} extension declared on the request.`,
        data: { requiredCapabilities: { extensions: { [TASKS]: {} } } } } })
    }
    let seen
    try { seen = jobs.findJob(message.params?.taskId, { host, roots: modernRoots }) } catch (error) {
      return send({ id, error: error instanceof jobs.DelegateError && error.kind === 'JOB_NOT_FOUND' ? { code: -32602, message: 'Unknown task' } : fault(error) })
    }
    const lost = () => new Error(`the record of job ${seen.id} was lost after it was seen`)
    if (message.method === 'tasks/get') {
      // A job that faults after it was seen is a failed task: the protocol's one use of failed.
      let projected
      try {
        const job = jobs.reconcile(seen)
        if (!job) throw lost()
        projected = task(job)
      } catch (error) {
        projected = { taskId: seen.id, status: 'failed', statusMessage: 'failed', createdAt: seen.createdAt,
          lastUpdatedAt: seen.endedAt ?? seen.startedAt ?? seen.createdAt, ttlMs: RETENTION_MS, error: fault(error) }
      }
      return reply(ctx, id, projected)
    }
    // A cancel decides from the record as the lookup read it and does not reconcile: reconciling
    // settles a lost job and releases its lease, and for a running job whose runner died it signals
    // the provider group and removes the TMPDIR before the acknowledgement could go out. That work
    // is left to the next tasks/get and to a lease takeover. A job that ended since the lookup gets
    // a marker nothing reads.
    if (message.method === 'tasks/cancel') {
      try {
        if (!jobs.TERMINAL.has(seen.status)) jobs.markCancel(seen.id)
      } catch (error) { return send({ id, error: fault(error) }) }
    }
    // tasks/update has nothing to update, since no task ever waits for input.
    return reply(ctx, id, {})
  }

  function onMessage(message) {
    const isRequest = message && typeof message.method === 'string'
    if (!isRequest) {
      pending.get(message?.id)?.(message)
      pending.delete(message?.id)
      return
    }
    // A notification has no era and gets no answer. The cancelled one is the only one acted on.
    if (!Object.hasOwn(message, 'id')) {
      if (message.method === 'notifications/cancelled') inflight.get(message.params?.requestId)?.abort()
      return
    }
    let ctx
    try { ctx = context(message) } catch (error) {
      if (!error.rpc) throw error
      send({ id: message.id, error: error.rpc })
      return
    }
    const notFound = () => send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
    switch (message.method) {
      // Discovery answers the same in both eras and writes nothing, so it makes no later call modern
      // or task-capable.
      case 'server/discover':
        send({ id: message.id, result: {
          resultType: 'complete', supportedVersions: [MODERN],
          capabilities: { tools: {}, extensions: { [TASKS]: {} } },
          _meta: { [SERVER_INFO]: { name: 'flow-delegate', version } },
        } })
        return
      case 'initialize': {
        if (ctx.era === 'modern') return notFound()
        clientCapabilities = message.params?.capabilities ?? {}
        clientInfo = message.params?.clientInfo ?? null
        const asked = message.params?.protocolVersion
        legacyProtocol = PROTOCOLS.includes(asked) ? asked : PROTOCOLS.at(-1)
        send({ id: message.id, result: {
          protocolVersion: legacyProtocol,
          capabilities: { tools: {} },
          serverInfo: { name: 'flow-delegate', version },
        } })
        return
      }
      case 'ping': reply(ctx, message.id, {}); return
      case 'tools/list': reply(ctx, message.id, { tools: toolList }); return
      case 'tools/call': onCall(message, ctx); return
      case 'tasks/get':
      case 'tasks/cancel':
      case 'tasks/update': onTask(message, ctx); return
      default: notFound()
    }
  }

  jobs.prune()
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    if (!line.trim()) return
    let message
    try { message = JSON.parse(line) } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    onMessage(message)
  })
  lines.on('close', () => process.exit(0))
}
