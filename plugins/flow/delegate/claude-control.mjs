// The Claude target over the Claude CLI's stream-json control channel, the protocol the Agent SDK
// speaks, spoken by hand: `claude -p --input-format stream-json --output-format stream-json`, one
// JSON frame per line each way. Flow writes control requests ({type: 'control_request',
// request_id, request}) and matches the control_response frames by request_id. A control request
// from the CLI gets an error answer, and one asking to use a tool fails the job APPROVAL_REQUIRED.
//
// The CLI opens its session before it takes a prompt, so the session is read back first.
// initialize answers with the CLI's model catalog: a model it lists must be asked for at an effort
// it lists (BAD_MODEL otherwise), and the model it resolves to is the one every frame must name.
// mcp_status must report no MCP server, or the job fails ISOLATION. Either failure sends no
// prompt. Only then does the prompt go out, as a user message marked client_composed, so the CLI
// neither expands an @path mention nor runs a slash command in text another model wrote. The
// system/init frame that follows it names the session's tools, MCP servers and plugins: a tool
// outside the requested set, any server or any plugin stops the turn before any tool result
// exists, and the job fails ISOLATION. An init or assistant frame from any model but the expected
// one stops the turn too, and the job fails MODEL_MISMATCH.
//
// The containment is what the CLI is handed: no setting source, no MCP config, and the sandbox and
// permission rules in claudeSettings. Stdin stays open while the turn runs; the runner closes it
// once the turn has ended, and the CLI then exits.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { DelegateError, log } from './jobs.mjs'
import { answered, candidates, classify, clip, listing } from './providers.mjs'

const STEP_MS = 30_000
const INTERRUPT_MS = 10_000
const NAMED = 20
const REJECTION = 'Flow grants a delegated job no approvals.'
const names = (list, name) => list.slice(0, NAMED).map((entry) => clip(name(entry) ?? 'unnamed'))

// Local sign-in and credential state no delegated seat reads.
function credentialPaths() {
  const home = homedir()
  const named = ['.ssh', '.gnupg', '.git-credentials', '.netrc', '.npmrc', '.pypirc', '.docker', '.aws', '.azure', '.kube',
    '.config/gh', '.config/gcloud', '.claude', '.claude.json', '.codex'].map((path) => join(home, path))
  const configured = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'].map((name) => process.env[name]).filter(Boolean).map((path) => resolve(path))
  return [...new Set([...named, ...configured])]
}

// Both provider executables, so a shell inside the sandbox cannot start either one. A PATH entry
// whose real target does not name the provider is a shared launcher (a mise or asdf shim resolves
// to the manager's own binary), and masking it would take node, python and every tool it serves
// with it, so it is left alone: the unreadable credentials and the closed network already leave a
// nested provider with nothing to sign in with and nowhere to connect.
function providerExecutables() {
  const paths = []
  for (const name of ['claude', 'codex']) {
    for (const path of candidates(name)) {
      let real
      try { real = realpathSync(path) } catch { continue }
      if (new RegExp(`(^|/)[^/]*${name}[^/]*(/|$)`, 'i').test(real)) paths.push(path, real)
    }
  }
  return [...new Set(paths)]
}

// Permission rules take gitignore patterns, where // anchors at the filesystem root.
const pattern = (path) => `/${path.replace(/[\\*?[\]!#]/g, '\\$&')}`

// The Claude tools' containment. Bash runs in the OS sandbox: no network, the credentials, both
// provider executables and /proc unreadable, and the worktree writable only on a write job. Read,
// Grep and Glob are file tools the sandbox does not cover, so the same credentials are denied to
// them as permission rules; Edit is allowed inside the worktree and nowhere else.
export function claudeSettings(job, dir) {
  const write = job.access === 'workspace-write'
  const tmp = join(dir, 'tmp')
  const secret = [...credentialPaths(), '/proc']
  return {
    permissions: {
      allow: write ? [`Edit(${pattern(job.worktree)}/**)`] : [],
      deny: secret.flatMap((path) => [`Read(${pattern(path)})`, `Read(${pattern(path)}/**)`]),
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true },
      filesystem: {
        denyRead: [...secret, ...providerExecutables()],
        ...(write ? { allowWrite: [job.worktree, tmp] } : { denyWrite: [job.worktree], allowWrite: [tmp] }),
      },
    },
  }
}

// The tools a job may run without asking, and the whole set it may name. A write job adds the
// editing tools, which the permission rules confine to the worktree.
function toolSets(job) {
  const read = ['Read', 'Grep', 'Glob', 'Bash', ...(job.hasSchema ? ['StructuredOutput'] : [])]
  return { read, all: job.access === 'workspace-write' ? [...read, 'Edit', 'Write', 'NotebookEdit'] : read }
}

function argv(job, dir) {
  const { read, all } = toolSets(job)
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
    '--model', job.model, '--effort', job.effort, '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--setting-sources', '', '--strict-mcp-config', '--settings', JSON.stringify(claudeSettings(job, dir)),
    '--tools', all.join(','), '--allowedTools', read.join(','),
    ...(job.resumeThreadId ? ['--resume', job.resumeThreadId] : ['--session-id', job.sessionId]),
    '--append-system-prompt-file', join(dir, 'seat.md'),
    ...(job.hasSchema ? ['--json-schema', readFileSync(join(dir, 'schema.json'), 'utf8')] : []),
    ...(job.maxTurns ? ['--max-turns', String(job.maxTurns)] : []),
    ...(job.maxBudgetUsd ? ['--max-budget-usd', String(job.maxBudgetUsd)] : [])]
}

const modelKey = (model) => String(model).replace(/\[1m\]$/i, '').toLowerCase()

function claudeFailure(result, assistantError, text) {
  if (['authentication_failed', 'oauth_org_not_allowed'].includes(assistantError)) return { kind: 'PROVIDER_AUTH', message: 'Claude is not signed in, or the account may not use this model.' }
  if (result.subtype === 'error_max_turns') return { kind: 'TIMEOUT', message: 'Claude reached the maxTurns limit.' }
  if (result.subtype === 'error_max_budget_usd') return { kind: 'TIMEOUT', message: 'Claude reached the maxBudgetUsd limit.' }
  if (result.subtype === 'error_max_structured_output_retries') return { kind: 'SCHEMA_OUTPUT', message: 'Claude could not answer in the requested schema.' }
  const detail = clip(text || assistantError || result.subtype)
  return { kind: classify(detail), message: `Claude: ${detail}` }
}

// The catalog initialize answers with. A requested id matches an entry's alias or the wire id it
// resolves to, ignoring case and a [1m] suffix; the alias wins when both match.
function catalogOf(initialized) {
  if (!Array.isArray(initialized?.models)) throw new DelegateError('PROVIDER_ERROR', 'Claude answered initialize without a model catalog, so no prompt was sent.')
  return initialized.models.filter((model) => typeof model?.value === 'string').map((model) => ({
    id: model.value,
    resolvedModel: typeof model.resolvedModel === 'string' ? model.resolvedModel : null,
    efforts: Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter((effort) => typeof effort === 'string') : [],
  }))
}
function lookup(models, id) {
  const key = modelKey(id)
  return models.find((model) => modelKey(model.id) === key) ?? models.find((model) => model.resolvedModel && modelKey(model.resolvedModel) === key) ?? null
}

// The control peer over the child's stdio. Each stdout line is dispatched, then handed to onLine
// unchanged. A control request fails when the CLI answers it with an error, stays silent past its
// timeout, or exits first.
function connect(child, { onLine, onFrame, onRequest }) {
  const pending = new Map()
  let next = 0
  let gone = null
  let ended = false
  const lost = (subtype) => new DelegateError('PROVIDER_ERROR', `Claude ${gone} before it answered ${subtype}; stderr.txt beside the events file has its diagnostics.`)
  const write = (frame) => { if (!gone && !ended) child.stdin.write(`${JSON.stringify(frame)}\n`) }
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
  const dispatch = (frame) => {
    if (frame.type === 'control_response') {
      const response = frame.response ?? {}
      const entry = pending.get(response.request_id)
      if (!entry) return undefined
      pending.delete(response.request_id)
      return response.subtype === 'success' ? entry.resolve(response.response ?? {}) : entry.refuse(response.error)
    }
    if (frame.type === 'control_request') {
      return write({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: onRequest(frame.request ?? {}) } })
    }
    return frame.type === 'control_cancel_request' || frame.type === 'keep_alive' ? undefined : onFrame(frame)
  }
  createInterface({ input: child.stdout }).on('line', (line) => {
    let frame
    try { frame = JSON.parse(line) } catch {}
    if (frame && typeof frame === 'object') {
      try { dispatch(frame) } catch (error) { log(`claude control dispatch failed: ${error?.stack || error}`) }
    }
    onLine(line)
  })
  return {
    writable: () => !gone && !ended,
    write,
    request(subtype, ms = STEP_MS) {
      return new Promise((resolve, reject) => {
        if (gone || ended) {
          reject(gone ? lost(subtype) : new DelegateError('PROVIDER_ERROR', `The Claude session was closed before ${subtype}.`))
          return
        }
        const id = `flow-${++next}`
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new DelegateError('PROVIDER_ERROR', `Claude did not answer ${subtype} within ${ms / 1000}s.`))
        }, ms)
        pending.set(id, {
          resolve: (response) => { clearTimeout(timer); resolve(response) },
          refuse: (error) => {
            clearTimeout(timer)
            const text = clip(typeof error === 'string' ? error : error?.message ?? JSON.stringify(error))
            const refusal = new DelegateError(classify(text), `Claude refused ${subtype}: ${text}`)
            refusal.refused = true
            reject(refusal)
          },
          lose: () => { clearTimeout(timer); reject(lost(subtype)) },
        })
        write({ type: 'control_request', request_id: id, request: { subtype } })
      })
    },
    close() {
      if (ended) return
      ended = true
      child.stdin.end()
    },
  }
}

// The session's MCP inventory before any prompt. A list with any server in it, or an answer that is
// not a list, stops the job, and so does an inventory Claude refuses to report.
async function checkServers(peer) {
  let status
  try { status = await peer.request('mcp_status') } catch (error) {
    if (error.refused) throw new DelegateError('ISOLATION', `${error.message}; no prompt was sent.`)
    throw error
  }
  const servers = status?.mcpServers
  if (!Array.isArray(servers)) throw new DelegateError('ISOLATION', 'Claude answered mcp_status without a server list, so no prompt was sent.')
  if (servers.length) {
    throw new DelegateError('ISOLATION', `Claude reported ${servers.length} MCP server(s) in the session, so no prompt was sent.`,
      { servers: names(servers, (server) => server?.name) })
  }
  return []
}

export const transport = {
  name: 'Claude',
  async open({ job, dir, bin, env, onSpawn, onLine }) {
    const child = spawn(bin, argv(job, dir), { cwd: job.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env })
    onSpawn(child)
    const requested = new Set(toolSets(job).all)
    let sessionId = null
    let served = null
    let expected = null
    let mcpServers = null
    let leak = null
    let mismatch = null
    let refusal = null
    let result = null
    let assistantError = null
    let failures = 0
    const asked = []
    const bash = new Set()
    const session = {
      servedModel: null, models: null, catalog: null, isolation: null, stopReason: null, promptSent: false, turnOpen: false, turnEnded: false,
      get threadId() { return result?.session_id ?? sessionId },
      send(prompt) {
        if (!peer.writable()) throw new DelegateError('PROVIDER_ERROR', 'Claude exited before it took the prompt; stderr.txt beside the events file has its diagnostics.')
        session.promptSent = true
        if (!session.turnEnded) session.turnOpen = true
        peer.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null,
          session_id: job.resumeThreadId ?? job.sessionId, uuid: randomUUID(), client_composed: true })
      },
      async interrupt() {
        if (!session.turnOpen) return null
        try {
          await peer.request('interrupt', INTERRUPT_MS)
          return { method: 'interrupt', delivered: true }
        } catch (error) { return { method: 'interrupt', delivered: false, error: clip(error.message) } }
      },
      close() { peer.close() },
      finish({ code, signal }) {
        const base = { threadId: session.threadId, servedModel: served, output: null, structured: null, commandFailures: failures, error: null }
        if (leak) return { ...base, status: 'failed', error: { kind: 'ISOLATION', message: leak.message, details: leak.details } }
        if (mismatch) return { ...base, status: 'failed', error: { kind: 'MODEL_MISMATCH', message: `Claude answered on ${mismatch.served}, not ${mismatch.expected}, and the turn was stopped.`, details: mismatch } }
        if (refusal) return { ...base, status: 'failed', error: { kind: 'REFUSAL', message: 'Claude declined the delegated turn.', details: refusal } }
        if (!result) {
          return { ...base, status: 'failed', error: { kind: 'PROVIDER_ERROR', message: `Claude exited (${signal ?? code}) without a result; stderr.txt beside the events file has its diagnostics.` } }
        }
        const text = String(result.result ?? '').trim()
        if (result.is_error || result.subtype !== 'success') return { ...base, output: text || null, status: 'failed', error: claudeFailure(result, assistantError, text) }
        // dontAsk turns every would-be prompt into a denial the model works around, and a tool the
        // CLI asked flow about was refused. The job asked for less than the task needed, so its
        // answer is kept and the outcome says so.
        const denied = [...asked, ...(Array.isArray(result.permission_denials) ? result.permission_denials.map((denial) => denial?.tool_name) : [])]
        if (denied.length) {
          return { ...base, output: text || null, status: 'failed', error: { kind: 'APPROVAL_REQUIRED', message: 'Claude needed a permission this job does not grant.', details: { denied: names(denied, (name) => name) } } }
        }
        return answered(job, dir, base, text, result.structured_output)
      },
    }
    // The init frame is the session's own account of what it can reach. Anything beyond the
    // requested tools, or any MCP server or plugin at all, stops the turn now: the prompt is in,
    // but no tool has answered yet. A frame that does not list all three is not a pass.
    const checkInit = (frame) => {
      const [tools, servers, plugins] = [frame.tools, frame.mcp_servers, frame.plugins].map((list) => (Array.isArray(list) ? list : null))
      const extra = (tools ?? []).filter((tool) => typeof tool !== 'string' || !requested.has(tool))
      if (tools && servers && plugins && !extra.length && !servers.length && !plugins.length) {
        session.isolation ??= { mcpServers, tools: [...tools] }
        return
      }
      const found = [tools ? `${extra.length} tool(s) outside the requested set` : 'no tool list', servers ? `${servers.length} MCP server(s)` : 'no MCP server list',
        plugins ? `${plugins.length} plugin(s)` : 'no plugin list']
      leak ??= {
        message: `Claude opened the session with ${found.join(', ')}, and the turn was stopped.`,
        details: { tools: names(extra, String), mcpServers: names(servers ?? [], (server) => server?.name), plugins: names(plugins ?? [], (plugin) => plugin?.name) },
      }
      session.stopReason ??= 'ISOLATION'
    }
    // A listed model resolves to the wire id every frame must name; an unlisted one is held to the
    // model its init frame names, Fable's rule. Any other model on an init or assistant frame is a
    // swap, and the turn stops now rather than at its end: on a write job the wrong model would be
    // editing the worktree meanwhile.
    const swapped = (model) => {
      const want = expected ?? served
      if (mismatch || !want || !model || model === '<synthetic>' || modelKey(model) === modelKey(want)) return
      mismatch = { expected: clip(want), served: clip(model) }
      session.stopReason ??= 'MODEL_MISMATCH'
    }
    const onFrame = (frame) => {
      if (frame.type === 'system' && frame.subtype === 'init') {
        sessionId = frame.session_id ?? sessionId
        // The served model reaches the envelope, so it is clipped like any provider string.
        if (typeof frame.model === 'string') served = clip(frame.model)
        session.servedModel = served
        swapped(frame.model)
        checkInit(frame)
      } else if (frame.type === 'system' && /^model_refusal/.test(frame.subtype ?? '')) {
        refusal ??= { category: frame.api_refusal_category ?? null }
      } else if (frame.type === 'result') {
        result = frame
        session.turnOpen = false
        session.turnEnded = true
      } else if (frame.type === 'user') {
        for (const block of Array.isArray(frame.message?.content) ? frame.message.content : []) {
          if (block?.type === 'tool_result' && block.is_error && bash.has(block.tool_use_id)) failures++
        }
      } else if (frame.type === 'assistant') {
        const message = frame.message ?? {}
        assistantError = frame.error ?? assistantError
        for (const block of Array.isArray(message.content) ? message.content : []) if (block?.type === 'tool_use' && block.name === 'Bash') bash.add(block.id)
        if (message.stop_reason === 'refusal') refusal ??= { category: message.stop_details?.category ?? null }
        swapped(message.model)
      }
    }
    const onRequest = (request) => {
      if (request.subtype === 'can_use_tool') {
        asked.push(request.tool_name)
        return REJECTION
      }
      return `flow-delegate does not answer ${clip(request.subtype ?? 'unnamed')}.`
    }
    const peer = connect(child, { onLine, onFrame, onRequest })
    try {
      session.models = catalogOf(await peer.request('initialize'))
      const entry = lookup(session.models, job.model)
      session.catalog = listing('Claude', entry, job)
      expected = entry?.resolvedModel ?? null
      mcpServers = await checkServers(peer)
    } catch (error) {
      peer.close()
      throw error
    }
    return session
  },
}
