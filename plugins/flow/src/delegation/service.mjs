import { spawn } from 'node:child_process'
import { assertRoute, capabilitiesForTarget, DelegationError, effortsForTarget, JOB_STATES, MODES, ACCESS_MODES, DELIVERIES, MODEL_PATTERN, SERVICE_TIERS, TERMINAL_STATES, publicError, resultEnvelope, targetForHost } from './contracts.mjs'
import { AppServerClient, assertRestrictedPermissionProfile, assertThreadMcpIsolated, CODEX_PERMISSION_PROFILE, codexHostSupport, codexVersion, isolatedThreadConfig, restrictedPermissionConfig } from './app-server.mjs'
import { claudeAgentSdkStatus, claudeAuthStatus, claudeModels, claudeVersion } from './claude-sdk.mjs'
import { providerContainmentSupport, providerScopeRunning } from './containment.mjs'
import { foldTurnOutcome, validateStructured } from './outcome.mjs'
import { validateOutputSchema } from './schema.mjs'
import { JobStore, defaultStateDir, processStartToken } from './store.mjs'
import { canonicalRoots, canonicalWorkspace, gitMetadataPaths, immutableReview, validatedWorktreeKey, worktreeKey } from './workspace.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const LIST_SCAN_LIMIT = 1_000

// Every field is type-checked before it is pattern-checked: a regex coerces its argument, so
// an undefined model matched the shape test and only failed later, as an opaque NOT NULL
// bind error from sqlite.
function validateStart(input, target) {
  if (!MODES.includes(input.mode)) throw new DelegationError('BAD_REQUEST', 'mode is invalid.')
  if (!ACCESS_MODES.includes(input.access)) throw new DelegationError('BAD_REQUEST', 'access is invalid.')
  if (!DELIVERIES.includes(input.delivery)) throw new DelegationError('BAD_REQUEST', 'delivery is invalid.')
  if (!effortsForTarget(target).includes(input.effort)) {
    throw new DelegationError('BAD_REQUEST', `effort is invalid for ${target}.`)
  }
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
  if (input.maxTurns !== null && (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 1000)) {
    throw new DelegationError('BAD_REQUEST', 'maxTurns must be between 1 and 1000.')
  }
  if (input.maxBudgetUsd !== null && (typeof input.maxBudgetUsd !== 'number'
    || !Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd < 0.01 || input.maxBudgetUsd > 1000)) {
    throw new DelegationError('BAD_REQUEST', 'maxBudgetUsd must be between 0.01 and 1000.')
  }
  if (target !== 'claude' && (input.maxTurns !== null || input.maxBudgetUsd !== null)) {
    throw new DelegationError('LIMIT_UNSUPPORTED', 'Codex App Server does not provide hard turn or cost limits for a delegated turn.')
  }
}

function terminal(job) { return TERMINAL_STATES.includes(job.status) }
function settled(job) { return terminal(job) || job.status === 'quarantined' }

function processGroupRunning(processGroupId) {
  if (process.platform === 'win32' || !Number.isInteger(processGroupId) || processGroupId <= 0) return false
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function quarantineRunning(job) {
  if (providerScopeRunning(job.providerScope)) return true
  if (processGroupRunning(job.providerProcessGroupId)) return true
  const identities = [
    ...(job.providerPid && job.providerStartToken
      ? [{ pid: job.providerPid, startToken: job.providerStartToken }]
      : []),
    ...(job.providerProcesses || []),
  ]
  if (!identities.length) return true
  return identities.some(({ pid, startToken }) => processStartToken(pid) === startToken)
}

function providerRecorded(job) {
  return Boolean(job.providerPid || job.providerProcessGroupId || job.providerScope || job.providerProcesses?.length)
}

function decodeListCursor(cursor, { host, target, status }) {
  if (!cursor) return null
  if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new DelegationError('BAD_REQUEST', 'The delegation list cursor is invalid.')
  }
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (value?.v !== 1 || value.host !== host || value.target !== target || value.status !== status
      || !Number.isSafeInteger(value.createdAt) || typeof value.id !== 'string') {
      throw new Error('cursor mismatch')
    }
    return { createdAt: value.createdAt, id: value.id }
  } catch {
    throw new DelegationError('BAD_REQUEST', 'The delegation list cursor is invalid.')
  }
}

function encodeListCursor(job, { host, target, status }) {
  return Buffer.from(JSON.stringify({
    v: 1,
    host,
    target,
    status,
    createdAt: job.createdAt,
    id: job.id,
  })).toString('base64url')
}

export class DelegationService {
  constructor({ host, depth = 0, stateDir = defaultStateDir(), entryPath, projectDir = null } = {}) {
    targetForHost(host)
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

  target() { return targetForHost(this.host) }

  capabilities() { return capabilitiesForTarget(this.target()) }

  requireRoute(job) {
    if (job.host !== this.host || job.target !== this.target()) {
      throw new DelegationError('ROUTE_DENIED', 'This delegation host does not own that job route.')
    }
    return job
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
      maxTurns: input.maxTurns ?? null,
      maxBudgetUsd: input.maxBudgetUsd ?? null,
      outputSchema: input.outputSchema ?? null,
      base: input.base || null,
      head: input.head || 'HEAD',
      parentJobId: input.parentJobId || null,
      nativeThreadId: input.nativeThreadId || null,
    }
    const target = this.target()
    validateStart(normalized, target)
    assertRoute({ host: this.host, target, depth: this.depth })
    const containment = providerContainmentSupport()
    if (!containment.ok) {
      throw new DelegationError(containment.kind, 'Linux delegation requires a working systemd user scope for provider containment.')
    }
    if (target === 'codex') {
      const host = codexHostSupport()
      if (!host.ok) throw new DelegationError(host.kind, 'Codex delegation requires a Linux host.')
      const codex = codexVersion()
      if (!codex.ok) {
        const message = codex.kind === 'CODEX_TOO_OLD'
          ? `Codex delegation requires Codex CLI ${codex.minimum} or newer.`
          : 'Codex could not be started or its version could not be read.'
        throw new DelegationError(codex.kind, message)
      }
    }
    const roots = canonicalRoots({ rootUris, projectDir: this.projectDir, fallbackCwd })
    const cwd = await canonicalWorkspace(normalized.cwd, roots)
    const workspaceKey = await validatedWorktreeKey(cwd, roots)
    const review = await immutableReview({ cwd, mode: normalized.mode, base: normalized.base, head: normalized.head, prompt: normalized.prompt })
    const outputSchema = validateOutputSchema(review.outputSchema || normalized.outputSchema, target)
    return this.withStore((store) => {
      const job = store.createJob({
        ...normalized,
        host: this.host,
        target,
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
        let job = this.requireRoute(store.requireJob(jobId))
        for (const event of store.events(jobId, { after, limit: 200 })) {
          after = event.seq
          await onEvent(event)
        }
        if (settled(job)) return job
        if (signal?.aborted && !cancelQueued) {
          store.requestCancel(jobId)
          cancelQueued = true
        }
        if (Date.now() - lastReconcile > 5_000) {
          lastReconcile = Date.now()
          job = await this.reconcile(jobId)
          if (settled(job)) return job
        }
        await sleep(250)
      }
    } finally { store.close() }
  }

  get(jobId) { return this.withStore((store) => this.requireRoute(store.requireJob(jobId))) }

  result(jobId) { return resultEnvelope(this.get(jobId)) }

  events(jobId, options = {}) {
    this.get(jobId)
    return this.withStore((store) => store.events(jobId, options))
  }

  async list({ status = null, limit = 20, cursor = null } = {}, { rootUris = [], fallbackCwd = null } = {}) {
    if (status !== null && !JOB_STATES.includes(status)) {
      throw new DelegationError('BAD_REQUEST', 'status is invalid.')
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DelegationError('BAD_REQUEST', 'limit must be between 1 and 100.')
    }
    const target = this.target()
    const roots = canonicalRoots({ rootUris, projectDir: this.projectDir, fallbackCwd })
    if (!roots.length) throw new DelegationError('NO_ROOTS', 'The client did not provide a usable workspace root.')
    const context = { host: this.host, target, status }
    let before = decodeListCursor(cursor, context)
    const visible = []
    let scanned = 0
    let lastScanned = null
    let scanTruncated = false
    const store = this.store()
    try {
      while (visible.length <= limit && scanned < LIST_SCAN_LIMIT) {
        const chunkLimit = Math.min(100, LIST_SCAN_LIMIT - scanned)
        const candidates = store.listJobs({ host: this.host, target, status, before, limit: chunkLimit })
        if (!candidates.length) break
        scanned += candidates.length
        lastScanned = candidates.at(-1)
        before = { createdAt: lastScanned.createdAt, id: lastScanned.id }
        for (const job of candidates) {
          try {
            await canonicalWorkspace(job.cwd, roots)
            visible.push(this.requireRoute(job))
            if (visible.length > limit) break
          } catch (error) {
            if (!(error instanceof DelegationError)) throw error
          }
        }
        if (visible.length > limit || candidates.length < chunkLimit) break
      }
      if (visible.length <= limit && scanned >= LIST_SCAN_LIMIT && before) {
        scanTruncated = store.listJobs({ host: this.host, target, status, before, limit: 1 }).length > 0
      }
    } finally { store.close() }
    const jobs = visible.slice(0, limit)
    const cursorJob = visible.length > limit ? jobs.at(-1) : (scanTruncated ? lastScanned : null)
    return {
      jobs,
      nextCursor: cursorJob ? encodeListCursor(cursorJob, context) : null,
    }
  }

  cancel(jobId) {
    this.get(jobId)
    return this.withStore((store) => store.requestCancel(jobId))
  }

  steer(jobId, text) {
    if (!text?.trim()) throw new DelegationError('BAD_REQUEST', 'Steering text cannot be empty.')
    return this.withStore((store) => {
      const job = this.requireRoute(store.requireJob(jobId))
      if (!capabilitiesForTarget(job.target).liveSteer) {
        throw new DelegationError('CONTROL_UNSUPPORTED', `${job.target} does not support live turn steering. Cancel the job or continue its session after it ends.`)
      }
      store.queueControl(jobId, 'steer', { text })
      return store.requireJob(jobId)
    })
  }

  continue(jobId, input, roots = {}) {
    const previous = this.get(jobId)
    if (!terminal(previous)) throw new DelegationError('JOB_STATE', `A ${previous.target} session can continue only after its current job reaches a terminal state.`)
    if (previous.status === 'unknown') {
      throw new DelegationError('UNKNOWN_JOB', 'Flow will not continue a job whose native turn outcome is unknown.')
    }
    if (!previous.nativeThreadId) throw new DelegationError('NO_THREAD', `The prior job has no ${previous.target} session to continue.`)
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
      maxTurns: input.maxTurns ?? previous.maxTurns,
      maxBudgetUsd: input.maxBudgetUsd ?? previous.maxBudgetUsd,
      outputSchema: input.outputSchema ?? null,
      parentJobId: previous.id,
      nativeThreadId: previous.nativeThreadId,
    }, roots)
  }

  async models(cwd) {
    if (this.target() === 'claude') return claudeModels(cwd)
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

  async doctor(cwd, { workspace = { ok: Boolean(cwd) } } = {}) {
    const target = this.target()
    if (target === 'claude') return this.claudeDoctor(cwd, { workspace })
    const checks = {
      workspace,
      node: { ok: Number(process.versions.node.split('.')[0]) >= 22, version: process.version },
      host: codexHostSupport(),
      containment: providerContainmentSupport(),
      codex: codexVersion(),
      database: { ok: false },
      appServer: { ok: false },
      account: { ok: false },
      permissionApi: { ok: false },
      restrictedPermissions: { ok: false },
      mcpIsolation: { ok: false },
    }
    try {
      const quarantined = this.withStore((store) => store.quarantinedCount())
      checks.database = { ok: true, path: this.stateDir, quarantined }
    } catch { checks.database = { ok: false, kind: 'DATABASE' } }
    // Each probe reports itself. Sharing one catch made an account failure read as a dead App
    // Server, which is the opposite of what doctor is for.
    if (checks.host.ok && checks.codex.ok && checks.containment.ok) {
      let client
      try {
        client = await new AppServerClient({ cwd: cwd || undefined, experimentalApi: true }).start()
        checks.appServer = { ok: true }
      } catch (error) {
        checks.appServer = { ok: false, error: publicError(error) }
      }
      if (client) {
        let config = null
        try {
          const profiles = await client.request('permissionProfile/list', { cursor: null, limit: 100, cwd: cwd || null }, 20_000)
          if (!Array.isArray(profiles?.data)) throw new DelegationError('PERMISSION_PROFILE', 'Codex returned an invalid permission profile inventory.')
          checks.permissionApi = { ok: true, profiles: profiles.data.length }
        } catch (error) {
          checks.permissionApi = { ok: false, error: publicError(error) }
        }
        try {
          config = await isolatedThreadConfig(client)
          if (!workspace.ok || !cwd) throw new DelegationError('NO_WORKSPACE', 'A workspace is required to verify restricted permissions.')
          const workspaceKey = await worktreeKey(cwd)
          const metadataPaths = await gitMetadataPaths(cwd)
          config = {
            ...config,
            ...restrictedPermissionConfig({ cwd, workspaceKey, access: 'read-only' }, { gitMetadataPaths: metadataPaths }),
          }
          const thread = await client.request('thread/start', {
            cwd,
            runtimeWorkspaceRoots: [workspaceKey],
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            permissions: CODEX_PERMISSION_PROFILE,
            config,
            ephemeral: true,
            serviceName: 'flow-delegation-doctor',
          }, 30_000)
          const active = assertRestrictedPermissionProfile(thread)
          checks.restrictedPermissions = { ok: true, ...active }
          const isolation = await assertThreadMcpIsolated(client, thread.thread?.id)
          checks.mcpIsolation = {
            ok: true,
            phase: 'thread',
            standaloneServers: Object.keys(config.mcp_servers).length,
            servers: isolation.servers,
          }
        } catch (error) {
          const value = { ok: false, error: publicError(error) }
          if (!checks.restrictedPermissions.ok) checks.restrictedPermissions = value
          if (!checks.mcpIsolation.ok) checks.mcpIsolation = value
        }
        try {
          const account = await client.request('account/read', { refreshToken: false }, 20_000)
          checks.account = { ok: Boolean(account.account) || !account.requiresOpenaiAuth, requiresOpenaiAuth: account.requiresOpenaiAuth }
        } catch (error) {
          checks.account = { ok: false, error: publicError(error) }
        } finally { await client.stop() }
      }
    }
    return { ok: Object.values(checks).every((check) => check.ok), target, capabilities: this.capabilities(), checks }
  }

  async claudeDoctor(cwd, { workspace = { ok: Boolean(cwd) } } = {}) {
    const checks = {
      workspace,
      node: { ok: Number(process.versions.node.split('.')[0]) >= 22, version: process.version },
      claude: claudeVersion(),
      containment: providerContainmentSupport(),
      agentSdk: claudeAgentSdkStatus(),
      database: { ok: false },
      account: claudeAuthStatus(),
      models: { ok: false },
    }
    try {
      const quarantined = this.withStore((store) => store.quarantinedCount())
      checks.database = { ok: true, path: this.stateDir, quarantined }
    } catch { checks.database = { ok: false, kind: 'DATABASE' } }
    if (!cwd) {
      checks.models = { ok: false, kind: 'NO_WORKSPACE' }
    } else if (checks.claude.ok && checks.account.ok && checks.containment.ok) {
      try {
        const models = await claudeModels(cwd)
        checks.models = { ok: models.length > 0, count: models.length }
      } catch (error) {
        checks.models = { ok: false, error: publicError(error) }
      }
    }
    return {
      ok: Object.values(checks).every((check) => check.ok),
      target: 'claude',
      capabilities: this.capabilities(),
      checks,
    }
  }

  async reconcile(jobId, { staleAfterMs = 15_000 } = {}) {
    let job = this.get(jobId)
    if (terminal(job)) return job
    if (job.status === 'quarantined') {
      if (quarantineRunning(job)) return job
      job = this.withStore((store) => store.resolveQuarantine(jobId))
      if (terminal(job)) return job
    }
    if (Date.now() - job.heartbeatAt < staleAfterMs) return job
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
    if (identityAmbiguous) return defer('worker_identity')
    if (providerRecorded(job) && quarantineRunning(job)) {
      return this.withStore((store) => store.quarantine(jobId, 'reconciling', {
        error: {
          kind: 'PROVIDER_QUARANTINED',
          message: 'The provider process outlived its delegation worker.',
          details: null,
        },
      }))
    }
    const claimedRecovery = this.withStore((store) => store.markReconciling(jobId, job.heartbeatAt))
    job = this.get(jobId)
    if (terminal(job)) return job
    if (!claimedRecovery) return job
    if (job.target === 'claude') {
      if (!job.nativeThreadId) {
        return this.withStore((store) => store.finish(jobId, 'failed', {
          error: { kind: 'WORKER_EXIT', message: 'The worker exited before Claude created a session.', details: null },
        }))
      }
      if (!job.nativeTurnId || !job.turnAcceptedAt) {
        return this.withStore((store) => store.finish(jobId, 'failed', {
          error: { kind: 'WORKER_EXIT', message: 'The worker exited before Flow released the prompt to Claude.', details: null },
        }))
      }
      const acceptedWrite = job.access === 'workspace-write'
      return this.withStore((store) => store.finish(jobId, acceptedWrite ? 'unknown' : 'failed', {
        error: {
          kind: 'RECOVERY_UNKNOWN',
          message: acceptedWrite
            ? 'Claude cannot prove whether the stale write turn reached a terminal state.'
            : 'Claude cannot recover the result of the stale read-only turn.',
          details: null,
        },
      }))
    }
    if (job.target !== 'codex') {
      return this.withStore((store) => store.finish(jobId, 'unknown', {
        error: { kind: 'ROUTE_DENIED', message: 'The stale job names an unknown model family.', details: null },
      }))
    }
    if (!job.nativeThreadId) {
      return this.withStore((store) => store.finish(jobId, 'failed', { error: { kind: 'WORKER_EXIT', message: 'The worker exited before Codex created a thread.', details: null } }))
    }
    if (!job.nativeTurnId) {
      return this.withStore((store) => store.finish(jobId, 'unknown', { error: { kind: 'RECOVERY_UNKNOWN', message: 'Flow cannot identify which Codex turn belongs to the stale job.', details: null } }))
    }
    let client
    try {
      client = await new AppServerClient({ cwd: job.cwd }).start()
      const response = await client.request('thread/read', { threadId: job.nativeThreadId, includeTurns: true }, 20_000)
      const turns = response.thread?.turns || []
      const turn = turns.find((item) => item.id === job.nativeTurnId)
      if (!turn || turn.status === 'inProgress') {
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
