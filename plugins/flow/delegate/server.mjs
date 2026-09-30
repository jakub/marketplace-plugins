// The delegate MCP server, spoken by hand over stdio: initialize, ping, tools/list, tools/call,
// the cancelled notification, and one outbound request, roots/list. It declares no outputSchema,
// so structuredContent needs no validator. Jobs outlive this process: a runner is detached, and
// stdin closing ends the server and nothing else.
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import * as jobs from './jobs.mjs'
import { probe } from './providers.mjs'

const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
const RESULT_KEYS = ['jobId', 'waitSeconds', 'events']
const WAIT_GRACE_SECONDS = 15

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
    continue: { type: 'string', description: 'The id of a finished job whose provider thread this new task resumes, in the same cwd and access.' },
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
      description: `Run a ${title} job: a task, or an adversarial review of a pinned base..head diff that returns typed findings. Waits for the outcome unless waitSeconds is 0. continue resumes a finished job's thread.`,
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
      name: 'delegation_doctor',
      title: 'Delegation doctor',
      description: `Report whether ${title} is installed and signed in, the usable workspace roots and the state directory.`,
      inputSchema: object({}),
      annotations: { readOnlyHint: true },
    },
  ]
}

function toolResult(value) {
  const job = value.job
  const summary = job ? `${job.status} | ${job.target} ${job.model} ${job.effort} | ${job.requestPreview}`
    : value.error ? `${value.error.kind}: ${value.error.message}` : value.summary
  const body = { summary, ...value }
  // The summary opens the text, so a client that shows one line shows something readable.
  const text = JSON.stringify(body, null, 2).replace(/^\{\n {2}"summary":/, '{"summary":')
  return { content: [{ type: 'text', text }], structuredContent: body, ...(body.ok ? {} : { isError: true }) }
}

const jobResult = (job, events = 0) => toolResult({
  ok: !['failed', 'cancelled', 'unknown'].includes(job.status),
  job: jobs.envelope(job, events),
})

// A DelegateError is written for the caller. Anything else is an internal fault: its detail goes
// to server.log and the caller gets a fixed message.
function publicError(error) {
  if (error instanceof jobs.DelegateError) return { kind: error.kind, message: error.message, ...(error.details ? { details: error.details } : {}) }
  jobs.log(`internal error: ${error?.stack || error}`)
  return { kind: 'INTERNAL', message: 'The delegate server failed; server.log in the state directory has the detail.' }
}

export async function serve({ host, version }) {
  const target = host === 'claude' ? 'codex' : 'claude'
  const toolList = tools(target)
  const fixedRoots = (host === 'codex' ? [await jobs.codexRoot()] : [process.env.CLAUDE_PROJECT_DIR]).filter(Boolean)
  let clientCapabilities = {}
  let clientInfo = null
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

  // Roots are asked for on every call that needs them, so a changed workspace is seen at once.
  async function roots() {
    const paths = [...fixedRoots]
    if (clientCapabilities.roots) {
      const reply = await request('roots/list', {}, 5_000)
      for (const root of reply?.result?.roots ?? []) {
        try { if (String(root.uri).startsWith('file:')) paths.push(fileURLToPath(root.uri)) } catch {}
      }
    }
    return jobs.canonicalRoots(paths)
  }

  async function doctor() {
    const usable = await roots()
    const provider = await probe(target)
    const error = !provider.installed ? { kind: 'PROVIDER_NOT_INSTALLED', message: `${target} is not on the PATH this server sees.` }
      : provider.auth?.loggedIn !== true ? { kind: 'PROVIDER_AUTH', message: `${target} is not signed in.` }
        : !usable.length ? { kind: 'NO_ROOTS', message: 'The host supplied no usable workspace root.' } : null
    return toolResult({
      ok: !error, summary: error ? `${error.kind}: ${error.message}` : `${target} ${provider.version} ready`,
      host, target, provider, roots: usable, stateDir: jobs.stateDir(), node: process.version, client: clientInfo,
      ...(error ? { error } : {}),
    })
  }

  async function call(name, args, signal, progressToken) {
    const started = Date.now()
    let reported = 0
    const onTick = (job) => {
      if (progressToken === undefined || !job || Date.now() - reported < 10_000) return
      reported = Date.now()
      const seconds = Math.round((reported - started) / 1000)
      send({ method: 'notifications/progress', params: { progressToken, progress: seconds, message: `${job.status} after ${seconds}s` } })
    }
    if (name === `delegate_to_${target}`) {
      let job = await jobs.admit(args, { host, roots: await roots() })
      const seconds = args.waitSeconds ?? job.timeBudgetSeconds + WAIT_GRACE_SECONDS
      if (seconds > 0) job = await jobs.wait(job.id, seconds, { signal, onTick })
      // The caller who waited went away mid-call: the job goes with it. A detached job is untouched.
      if (signal.aborted && !jobs.TERMINAL.has(job.status)) jobs.requestCancel(job.id)
      return jobResult(job)
    }
    if (name === 'delegation_result') {
      jobs.checkKeys(args, RESULT_KEYS)
      const seconds = jobs.integer(args.waitSeconds, 'waitSeconds', 0, 7200, 0)
      const events = jobs.integer(args.events, 'events', 0, 200, 20)
      let job = jobs.visibleJob(args.jobId, { host, roots: await roots() })
      if (seconds > 0) job = await jobs.wait(job.id, seconds, { signal, onTick })
      return jobResult(job, events)
    }
    if (name === 'delegation_cancel') {
      jobs.checkKeys(args, ['jobId'])
      return jobResult(await jobs.cancel(jobs.visibleJob(args.jobId, { host, roots: await roots() })))
    }
    if (name === 'delegation_doctor') {
      jobs.checkKeys(args, [])
      return doctor()
    }
    return null
  }

  async function onCall(message) {
    const { name, arguments: args = {}, _meta: meta } = message.params ?? {}
    if (!toolList.some((tool) => tool.name === name)) {
      send({ id: message.id, error: { code: -32602, message: `Unknown tool: ${name}` } })
      return
    }
    const controller = new AbortController()
    inflight.set(message.id, controller)
    let result
    try { result = await call(name, args, controller.signal, meta?.progressToken) } catch (error) {
      result = toolResult({ ok: false, error: publicError(error) })
    } finally { inflight.delete(message.id) }
    // A request the client cancelled gets no response.
    if (!controller.signal.aborted) send({ id: message.id, result })
  }

  function onMessage(message) {
    const isRequest = message && typeof message.method === 'string'
    if (!isRequest) {
      pending.get(message?.id)?.(message)
      pending.delete(message?.id)
      return
    }
    const hasId = Object.hasOwn(message, 'id')
    switch (message.method) {
      case 'initialize': {
        clientCapabilities = message.params?.capabilities ?? {}
        clientInfo = message.params?.clientInfo ?? null
        const asked = message.params?.protocolVersion
        send({ id: message.id, result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS.at(-1),
          capabilities: { tools: {} },
          serverInfo: { name: 'flow-delegate', version },
        } })
        return
      }
      case 'ping': send({ id: message.id, result: {} }); return
      case 'tools/list': send({ id: message.id, result: { tools: toolList } }); return
      case 'tools/call': onCall(message); return
      case 'notifications/cancelled': inflight.get(message.params?.requestId)?.abort(); return
      default:
        if (hasId) send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
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
