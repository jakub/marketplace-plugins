import Ajv2020 from 'ajv/dist/2020.js'
import { spawn } from 'node:child_process'
import { assertRoute, DelegationError, EFFORTS, MODES, ACCESS_MODES, DELIVERIES, SERVICE_TIERS, TERMINAL_STATES, publicError, resultEnvelope } from './contracts.mjs'
import { AppServerClient, codexVersion } from './app-server.mjs'
import { JobStore, defaultStateDir } from './store.mjs'
import { canonicalRoots, canonicalWorkspace, immutableReview, worktreeKey } from './workspace.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function validateSchema(schema) {
  if (schema == null) return null
  if (Buffer.byteLength(JSON.stringify(schema)) > 64 * 1024) {
    throw new DelegationError('BAD_SCHEMA', 'The output schema exceeds 64 KiB.')
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  if (!ajv.validateSchema(schema)) throw new DelegationError('BAD_SCHEMA', 'outputSchema is not a valid JSON Schema.')
  try { ajv.compile(schema) } catch { throw new DelegationError('BAD_SCHEMA', 'outputSchema cannot be compiled.') }
  return schema
}

function validateStart(input) {
  if (!MODES.includes(input.mode)) throw new DelegationError('BAD_REQUEST', 'mode is invalid.')
  if (!ACCESS_MODES.includes(input.access)) throw new DelegationError('BAD_REQUEST', 'access is invalid.')
  if (!DELIVERIES.includes(input.delivery)) throw new DelegationError('BAD_REQUEST', 'delivery is invalid.')
  if (!EFFORTS.includes(input.effort)) throw new DelegationError('BAD_REQUEST', 'effort is invalid.')
  if (!SERVICE_TIERS.includes(input.serviceTier)) throw new DelegationError('BAD_REQUEST', 'Only the default service tier is allowed.')
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(input.model)) throw new DelegationError('BAD_REQUEST', 'model has an invalid shape.')
  if (typeof input.prompt !== 'string' || (!input.prompt.trim() && input.mode === 'task')) {
    throw new DelegationError('BAD_REQUEST', 'Task mode requires a non-empty prompt.')
  }
  if (!Number.isInteger(input.timeBudgetSeconds) || input.timeBudgetSeconds < 30 || input.timeBudgetSeconds > 7200) {
    throw new DelegationError('BAD_REQUEST', 'timeBudgetSeconds must be between 30 and 7200.')
  }
}

function terminal(job) { return TERMINAL_STATES.includes(job.status) }

export class DelegationService {
  constructor({ host = 'claude', depth = 0, stateDir = defaultStateDir(), entryPath, projectDir = null } = {}) {
    this.host = host
    this.depth = depth
    this.stateDir = stateDir
    this.entryPath = entryPath
    this.projectDir = projectDir
  }

  store() { return new JobStore(this.stateDir) }

  start(input, { rootUris = [], fallbackCwd = null } = {}) {
    const normalized = {
      mode: input.mode || 'task',
      access: input.access || 'read-only',
      delivery: input.delivery || 'attached',
      effort: input.effort,
      model: input.model,
      serviceTier: input.serviceTier || 'default',
      profile: input.profile || 'standard',
      prompt: input.prompt || '',
      cwd: input.cwd,
      timeBudgetSeconds: input.timeBudgetSeconds || 900,
      outputSchema: input.outputSchema ?? null,
      base: input.base || null,
      head: input.head || 'HEAD',
      parentJobId: input.parentJobId || null,
      nativeThreadId: input.nativeThreadId || null,
    }
    validateStart(normalized)
    assertRoute({ host: this.host, target: 'codex', depth: this.depth })
    const roots = canonicalRoots({ rootUris, projectDir: this.projectDir, fallbackCwd })
    const cwd = canonicalWorkspace(normalized.cwd, roots)
    const review = immutableReview({ cwd, mode: normalized.mode, base: normalized.base, head: normalized.head, prompt: normalized.prompt })
    const outputSchema = validateSchema(review.outputSchema || normalized.outputSchema)
    const store = this.store()
    try {
      const job = store.createJob({
        ...normalized,
        host: this.host,
        target: 'codex',
        depth: this.depth,
        cwd,
        workspaceKey: worktreeKey(cwd),
        prompt: review.prompt,
        outputSchema,
        baseSha: review.baseSha,
        headSha: review.headSha,
      })
      this.spawnWorker(job.id)
      return job
    } finally { store.close() }
  }

  spawnWorker(jobId) {
    if (!this.entryPath) throw new DelegationError('INTERNAL', 'The delegation entry path is missing.')
    const child = spawn(process.execPath, [this.entryPath, 'worker', '--job', jobId, '--state-dir', this.stateDir], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        FLOW_DELEGATION_STATE_DIR: this.stateDir,
        FLOW_DELEGATION_DEPTH: String(this.depth + 1),
        FLOW_DELEGATION_PARENT_JOB_ID: jobId,
      },
    })
    child.unref()
  }

  async wait(jobId, { onEvent = () => {}, signal = null } = {}) {
    let after = 0
    let cancelQueued = false
    let lastReconcile = 0
    while (true) {
      const store = this.store()
      let job
      try {
        job = store.requireJob(jobId)
        for (const event of store.events(jobId, { after, limit: 200 })) {
          after = event.seq
          await onEvent(event)
        }
        if (terminal(job)) return job
        if (signal?.aborted && !cancelQueued) {
          store.queueControl(jobId, 'cancel')
          cancelQueued = true
        }
      } finally { store.close() }
      if (Date.now() - lastReconcile > 5_000) {
        lastReconcile = Date.now()
        job = await this.reconcile(jobId)
        if (terminal(job)) return job
      }
      await sleep(250)
    }
  }

  get(jobId) {
    const store = this.store()
    try { return store.requireJob(jobId) } finally { store.close() }
  }

  result(jobId) { return resultEnvelope(this.get(jobId)) }

  events(jobId, options = {}) {
    const store = this.store()
    try { return store.events(jobId, options) } finally { store.close() }
  }

  cancel(jobId) {
    const store = this.store()
    try {
      const job = store.requireJob(jobId)
      if (terminal(job)) return job
      store.queueControl(jobId, 'cancel')
      return store.requireJob(jobId)
    } finally { store.close() }
  }

  steer(jobId, text) {
    if (!text?.trim()) throw new DelegationError('BAD_REQUEST', 'Steering text cannot be empty.')
    const store = this.store()
    try {
      store.queueControl(jobId, 'steer', { text })
      return store.requireJob(jobId)
    } finally { store.close() }
  }

  continue(jobId, input, roots = {}) {
    const previous = this.get(jobId)
    if (!previous.nativeThreadId) throw new DelegationError('NO_THREAD', 'The prior job has no Codex thread to continue.')
    if (previous.status === 'unknown' && previous.access === 'workspace-write') {
      throw new DelegationError('UNKNOWN_WRITE', 'Flow will not continue an unknown write job.')
    }
    return this.start({
      mode: 'task',
      access: input.access || previous.access,
      delivery: input.delivery || 'attached',
      effort: input.effort || previous.effort,
      model: input.model || previous.model,
      serviceTier: 'default',
      profile: input.profile || previous.profile,
      prompt: input.prompt,
      cwd: previous.cwd,
      timeBudgetSeconds: input.timeBudgetSeconds || previous.timeBudgetSeconds,
      outputSchema: input.outputSchema ?? null,
      parentJobId: previous.id,
      nativeThreadId: previous.nativeThreadId,
    }, roots)
  }

  async models(cwd) {
    const client = await new AppServerClient({ cwd }).start()
    try {
      const models = []
      let cursor = null
      do {
        const page = await client.request('model/list', { cursor, limit: 100, includeHidden: false }, 20_000)
        models.push(...(page.data || []))
        cursor = page.nextCursor || null
      } while (cursor)
      return models
    } finally { await client.stop() }
  }

  async doctor(cwd) {
    const checks = {
      node: { ok: Number(process.versions.node.split('.')[0]) >= 22, version: process.version },
      codex: codexVersion(),
      database: { ok: false },
      appServer: { ok: false },
      account: { ok: false },
    }
    try {
      const store = this.store()
      store.db.prepare('SELECT 1').get()
      store.close()
      checks.database = { ok: true, path: this.stateDir }
    } catch { checks.database = { ok: false, kind: 'DATABASE' } }
    if (checks.codex.ok) {
      let client
      try {
        client = await new AppServerClient({ cwd }).start()
        checks.appServer = { ok: true }
        const account = await client.request('account/read', { refreshToken: false }, 20_000)
        checks.account = { ok: Boolean(account.account) || !account.requiresOpenaiAuth, requiresOpenaiAuth: account.requiresOpenaiAuth }
      } catch (error) {
        checks.appServer = { ok: false, error: publicError(error) }
      } finally { if (client) await client.stop() }
    }
    return { ok: Object.values(checks).every((check) => check.ok), checks }
  }

  async reconcile(jobId, { staleAfterMs = 15_000 } = {}) {
    let job = this.get(jobId)
    if (terminal(job) || Date.now() - job.heartbeatAt < staleAfterMs) return job
    try { if (job.workerPid) { process.kill(job.workerPid, 0); return job } } catch {}
    const store = this.store()
    try { store.markReconciling(jobId) } finally { store.close() }
    job = this.get(jobId)
    if (!job.nativeThreadId) {
      const local = this.store()
      try { return local.finish(jobId, 'failed', { error: { kind: 'WORKER_EXIT', message: 'The worker exited before Codex created a thread.', details: null } }) }
      finally { local.close() }
    }
    let client
    try {
      client = await new AppServerClient({ cwd: job.cwd }).start()
      const response = await client.request('thread/read', { threadId: job.nativeThreadId, includeTurns: true }, 20_000)
      const turns = response.thread?.turns || []
      const turn = turns.find((item) => item.id === job.nativeTurnId) || turns.at(-1)
      const local = this.store()
      try {
        if (!turn || turn.status === 'inProgress') {
          return local.finish(jobId, 'unknown', { error: { kind: 'RECOVERY_UNKNOWN', message: 'Codex could not prove the stale turn reached a terminal state.', details: null } })
        }
        if (turn.status === 'interrupted') return local.finish(jobId, 'cancelled')
        if (turn.status === 'failed') return local.finish(jobId, 'failed', { error: { kind: 'CODEX_TURN', message: turn.error?.message || 'Codex reported a failed turn.', details: null } })
        const output = (turn.items || []).filter((item) => item.type === 'agentMessage' && item.text).at(-1)?.text?.trim() || ''
        if (!output) return local.finish(jobId, 'unknown', { error: { kind: 'EMPTY_OUTPUT', message: 'Recovery found a completed turn without a final message.', details: null } })
        let structured = null
        if (job.outputSchema != null) {
          try {
            structured = JSON.parse(output)
            const ajv = new Ajv2020({ allErrors: true, strict: false })
            const validate = ajv.compile(job.outputSchema)
            if (!validate(structured)) {
              return local.finish(jobId, 'failed', { error: { kind: 'SCHEMA_OUTPUT', message: 'Recovered output does not match the requested schema.', details: { errors: validate.errors?.slice(0, 20) || [] } } })
            }
          } catch {
            return local.finish(jobId, 'failed', { error: { kind: 'SCHEMA_OUTPUT', message: 'Recovered output is not valid JSON.', details: null } })
          }
        }
        return local.finish(jobId, 'succeeded', { output, structured })
      } finally { local.close() }
    } catch (error) {
      const local = this.store()
      try { return local.finish(jobId, 'unknown', { error: { kind: 'RECOVERY_UNKNOWN', message: 'Flow could not reconcile the stale Codex turn.', details: publicError(error) } }) }
      finally { local.close() }
    } finally { if (client) await client.stop() }
  }
}
