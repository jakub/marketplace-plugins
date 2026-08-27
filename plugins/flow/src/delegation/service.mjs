import Ajv2020 from 'ajv/dist/2020.js'
import { spawn } from 'node:child_process'
import { assertRoute, DelegationError, EFFORTS, MODES, ACCESS_MODES, DELIVERIES, MODEL_PATTERN, SERVICE_TIERS, TERMINAL_STATES, publicError, resultEnvelope } from './contracts.mjs'
import { AppServerClient, codexVersion } from './app-server.mjs'
import { foldTurnOutcome, validateStructured } from './outcome.mjs'
import { JobStore, defaultStateDir, processStartToken, serviceLog } from './store.mjs'
import { canonicalRoots, canonicalWorkspace, immutableReview, worktreeKey, writableWorktreeKey } from './workspace.mjs'

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

// Every field is type-checked before it is pattern-checked: a regex coerces its argument, so
// an undefined model matched the shape test and only failed later, as an opaque NOT NULL
// bind error from sqlite.
function validateStart(input) {
  if (!MODES.includes(input.mode)) throw new DelegationError('BAD_REQUEST', 'mode is invalid.')
  if (!ACCESS_MODES.includes(input.access)) throw new DelegationError('BAD_REQUEST', 'access is invalid.')
  if (!DELIVERIES.includes(input.delivery)) throw new DelegationError('BAD_REQUEST', 'delivery is invalid.')
  if (!EFFORTS.includes(input.effort)) throw new DelegationError('BAD_REQUEST', 'effort is invalid.')
  if (!SERVICE_TIERS.includes(input.serviceTier)) throw new DelegationError('BAD_REQUEST', 'Only the default service tier is allowed.')
  if (typeof input.model !== 'string' || !MODEL_PATTERN.test(input.model)) {
    throw new DelegationError('BAD_REQUEST', 'model is required and must match the model name shape.')
  }
  if (typeof input.cwd !== 'string' || !input.cwd.trim()) {
    throw new DelegationError('BAD_REQUEST', 'cwd is required and must be an absolute directory path.')
  }
  if (typeof input.profile !== 'string' || !input.profile.trim()) {
    throw new DelegationError('BAD_REQUEST', 'profile is invalid.')
  }
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

  withStore(fn) {
    const store = this.store()
    try { return fn(store) } finally { store.close() }
  }

  async start(input, { rootUris = [], fallbackCwd = null } = {}) {
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
    const cwd = await canonicalWorkspace(normalized.cwd, roots)
    const workspaceKey = normalized.access === 'workspace-write'
      ? await writableWorktreeKey(cwd, roots)
      : await worktreeKey(cwd)
    const review = await immutableReview({ cwd, mode: normalized.mode, base: normalized.base, head: normalized.head, prompt: normalized.prompt })
    const outputSchema = validateSchema(review.outputSchema || normalized.outputSchema)
    return this.withStore((store) => {
      const job = store.createJob({
        ...normalized,
        host: this.host,
        target: 'codex',
        depth: this.depth,
        cwd,
        workspaceKey,
        prompt: review.prompt,
        outputSchema,
        baseSha: review.baseSha,
        headSha: review.headSha,
      })
      this.spawnWorker(job.id)
      return job
    })
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

  // One store for the whole poll loop: reopening the database every 250ms bought nothing.
  async wait(jobId, { onEvent = () => {}, signal = null } = {}) {
    let after = 0
    let cancelQueued = false
    let lastReconcile = 0
    const store = this.store()
    try {
      while (true) {
        let job = store.requireJob(jobId)
        for (const event of store.events(jobId, { after, limit: 200 })) {
          after = event.seq
          await onEvent(event)
        }
        if (terminal(job)) return job
        if (signal?.aborted && !cancelQueued) {
          store.requestCancel(jobId)
          cancelQueued = true
        }
        if (Date.now() - lastReconcile > 5_000) {
          lastReconcile = Date.now()
          job = await this.reconcile(jobId)
          if (terminal(job)) return job
        }
        await sleep(250)
      }
    } finally { store.close() }
  }

  get(jobId) { return this.withStore((store) => store.requireJob(jobId)) }

  result(jobId) { return resultEnvelope(this.get(jobId)) }

  events(jobId, options = {}) { return this.withStore((store) => store.events(jobId, options)) }

  cancel(jobId) { return this.withStore((store) => store.requestCancel(jobId)) }

  steer(jobId, text) {
    if (!text?.trim()) throw new DelegationError('BAD_REQUEST', 'Steering text cannot be empty.')
    return this.withStore((store) => {
      store.queueControl(jobId, 'steer', { text })
      return store.requireJob(jobId)
    })
  }

  continue(jobId, input, roots = {}) {
    const previous = this.get(jobId)
    if (!terminal(previous)) throw new DelegationError('JOB_STATE', 'A Codex thread can continue only after its current job reaches a terminal state.')
    if (previous.status === 'unknown') {
      throw new DelegationError('UNKNOWN_JOB', 'Flow will not continue a job whose native turn outcome is unknown.')
    }
    if (!previous.nativeThreadId) throw new DelegationError('NO_THREAD', 'The prior job has no Codex thread to continue.')
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
      this.withStore((store) => store.db.prepare('SELECT 1').get())
      checks.database = { ok: true, path: this.stateDir }
    } catch { checks.database = { ok: false, kind: 'DATABASE' } }
    // Each probe reports itself. Sharing one catch made an account failure read as a dead App
    // Server, which is the opposite of what doctor is for.
    if (checks.codex.ok) {
      let client
      try {
        client = await new AppServerClient({ cwd }).start()
        checks.appServer = { ok: true }
      } catch (error) {
        checks.appServer = { ok: false, error: publicError(error) }
      }
      if (client) {
        try {
          const account = await client.request('account/read', { refreshToken: false }, 20_000)
          checks.account = { ok: Boolean(account.account) || !account.requiresOpenaiAuth, requiresOpenaiAuth: account.requiresOpenaiAuth }
        } catch (error) {
          checks.account = { ok: false, error: publicError(error) }
        } finally { await client.stop() }
      }
    }
    return { ok: Object.values(checks).every((check) => check.ok), checks }
  }

  async reconcile(jobId, { staleAfterMs = 15_000 } = {}) {
    let job = this.get(jobId)
    if (terminal(job) || Date.now() - job.heartbeatAt < staleAfterMs) return job
    // Recovery defers rather than deciding whenever the worker's identity cannot be settled:
    // a live process that might still own the job must not have its outcome overwritten.
    const defer = (reason, error = null) => this.withStore((store) => {
      store.appendEvent(jobId, 'recovery.deferred', error ? { reason, error: publicError(error) } : { reason })
      return store.requireJob(jobId)
    })
    let identityAmbiguous = false
    if (job.workerPid) {
      try {
        process.kill(job.workerPid, 0)
        const claimedToken = this.withStore((store) => store.workerStartToken(jobId))
        const liveToken = processStartToken(job.workerPid)
        if (claimedToken && liveToken && claimedToken === liveToken) return job
        identityAmbiguous = !claimedToken || !liveToken
      } catch {}
    }
    const claimedRecovery = this.withStore((store) => store.markReconciling(jobId, job.heartbeatAt))
    job = this.get(jobId)
    if (terminal(job)) return job
    if (!claimedRecovery) return job
    if (!job.nativeThreadId) {
      if (identityAmbiguous) return defer('worker_identity')
      return this.withStore((store) => store.finish(jobId, 'failed', { error: { kind: 'WORKER_EXIT', message: 'The worker exited before Codex created a thread.', details: null } }))
    }
    if (!job.nativeTurnId) {
      if (identityAmbiguous) return defer('worker_identity')
      return this.withStore((store) => store.finish(jobId, 'unknown', { error: { kind: 'RECOVERY_UNKNOWN', message: 'Flow cannot identify which Codex turn belongs to the stale job.', details: null } }))
    }
    let client
    try {
      client = await new AppServerClient({ cwd: job.cwd }).start()
      const response = await client.request('thread/read', { threadId: job.nativeThreadId, includeTurns: true }, 20_000)
      const turns = response.thread?.turns || []
      const turn = turns.find((item) => item.id === job.nativeTurnId)
      if (!turn || turn.status === 'inProgress') {
        if (identityAmbiguous) return defer('turn_in_progress')
        return this.withStore((store) => store.finish(jobId, 'unknown', { error: { kind: 'RECOVERY_UNKNOWN', message: 'Codex could not prove the stale turn reached a terminal state.', details: null } }))
      }
      // The same fold the live worker uses. Recovery can read the controls table for a cancel
      // request, but it has no way to tell a deadline or a stall from any other interruption.
      const cancelRequested = this.withStore((store) => store.cancelRequested(jobId))
      const outcome = foldTurnOutcome(turn, { cancelRequested, acceptedWrite: job.access === 'workspace-write' })
      return this.withStore((store) => {
        if (outcome.status !== 'succeeded') return store.finish(jobId, outcome.status, { error: outcome.error })
        let structured = null
        if (job.outputSchema != null) {
          try { structured = validateStructured(job.outputSchema, outcome.output) } catch (error) {
            return store.finish(jobId, 'failed', { error: publicError(error) })
          }
        }
        return store.finish(jobId, 'succeeded', { output: outcome.output, structured })
      })
    } catch (error) {
      if (identityAmbiguous) return defer('worker_identity', error)
      if (!(error instanceof DelegationError)) this.withStore((store) => store.recordInternalError(jobId, error))
      return this.withStore((store) => store.finish(jobId, 'unknown', { error: { kind: 'RECOVERY_UNKNOWN', message: 'Flow could not reconcile the stale Codex turn.', details: publicError(error) } }))
    } finally { if (client) await client.stop() }
  }
}
