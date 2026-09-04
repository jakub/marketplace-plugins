import { spawn } from 'node:child_process'
import { assertRoute, capabilitiesForHost, capabilitiesForTarget, DelegationError, EFFORTS, MODES, ACCESS_MODES, DELIVERIES, MODEL_PATTERN, TERMINAL_STATES, publicError, resultEnvelope, targetForHost } from './contracts.mjs'
import { AppServerClient, assertRestrictedPermissionProfile, assertThreadMcpIsolated, CODEX_PERMISSION_PROFILE, codexHostSupport, codexVersion, isolatedThreadConfig, restrictedPermissionConfig } from './app-server.mjs'
import { claudeAgentSdkStatus, claudeAuthStatus, claudeModels, claudeVersion } from './claude-sdk.mjs'
import { providerContainmentSupport, providerScopeRunning } from './containment.mjs'
import { foldTurnOutcome, validateStructured } from './outcome.mjs'
import { validateOutputSchema } from './schema.mjs'
import { JobStore, defaultStateDir, processStartToken, serviceLog } from './store.mjs'
import { canonicalRoots, canonicalWorkspace, gitMetadataPaths, immutableReview, validatedWorktreeKey, worktreeKey } from './workspace.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Every field is type-checked before it is pattern-checked: a regex coerces its argument, so
// an undefined model matched the shape test and only failed later, as an opaque NOT NULL
// bind error from sqlite.
function validateStart(input, target) {
  if (!MODES.includes(input.mode)) throw new DelegationError('BAD_REQUEST', 'mode is invalid.')
  if (!ACCESS_MODES.includes(input.access)) throw new DelegationError('BAD_REQUEST', 'access is invalid.')
  if (!DELIVERIES.includes(input.delivery)) throw new DelegationError('BAD_REQUEST', 'delivery is invalid.')
  if (!EFFORTS.includes(input.effort)) throw new DelegationError('BAD_REQUEST', 'effort is invalid.')
  if (typeof input.model !== 'string' || !MODEL_PATTERN.test(input.model)) {
    throw new DelegationError('BAD_REQUEST', 'model is required and must match the model name shape.')
  }
  if (typeof input.cwd !== 'string' || !input.cwd.trim()) {
    throw new DelegationError('BAD_REQUEST', 'cwd is required and must be an absolute directory path.')
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

// The MCP initialize handshake is the only live report of who is calling this service. Doctor
// repeats clientInfo exactly as the handshake gave it, and answers nulls when there was no
// handshake to read: never a guess, never this service's own version.
function observedClient(client) {
  return { name: client?.name ?? null, version: client?.version ?? null }
}

// The version of the CLI conducting this session, which is a different question from the
// target's. A Claude host is its own MCP client, so the handshake carries the Claude Code
// version. A Codex host's MCP client reports its own component version, so the CLI is asked
// directly. This is the live operand of the drift verdict; the recorded one is in
// capabilities.json.
function observedHostVersion(host, handshakeClient) {
  if (host === 'claude') return handshakeClient?.version ?? null
  return codexVersion().version
}

function terminal(job) { return TERMINAL_STATES.includes(job.status) }
function settled(job) { return terminal(job) || job.status === 'quarantined' }

function processGroupRunning(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function recordedIdentities(job) {
  return [
    ...(job.providerPid && job.providerStartToken
      ? [{ pid: job.providerPid, startToken: job.providerStartToken }]
      : []),
    ...(job.providerProcesses || []),
  ]
}

function quarantineRunning(job) {
  if (providerScopeRunning(job.providerScope)) return true
  if (processGroupRunning(job.providerProcessGroupId)) return true
  const identities = recordedIdentities(job)
  // Recovery never guesses: a job that recorded no process identity offers nothing to observe,
  // so nothing is proved stopped and the quarantine holds. delegation_cancel is the way out.
  if (!identities.length) return true
  return identities.some(({ pid, startToken }) => processStartToken(pid) === startToken)
}

// The same liveness question, answered with names instead of a boolean, and without the
// no-identities rule above. What is alive goes back to the caller in the refusal.
function liveProviderIdentities(job) {
  const live = new Map()
  const add = (kind, id) => live.set(`${kind}:${id}`, { kind, id })
  if (providerScopeRunning(job.providerScope)) add('scope', job.providerScope)
  if (processGroupRunning(job.providerProcessGroupId)) add('processGroup', job.providerProcessGroupId)
  // The lead process is usually recorded twice, once on its own and once inside the tracked
  // set, and one process is one thing to go and look at.
  for (const { pid, startToken } of recordedIdentities(job)) {
    if (processStartToken(pid) === startToken) add('process', pid)
  }
  return [...live.values()]
}

function providerRecorded(job) {
  return Boolean(job.providerPid || job.providerProcessGroupId || job.providerScope || job.providerProcesses?.length)
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

  // The inventory plus the drift verdict the reader is told not to compute for itself.
  hostCapabilities(handshakeClient) {
    return capabilitiesForHost(this.host, { installed: observedHostVersion(this.host, handshakeClient) })
  }

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
      elicitation: Boolean(input.elicitation),
    }
    const target = this.target()
    validateStart(normalized, target)
    assertRoute({ host: this.host, target, depth: this.depth })
    const containment = providerContainmentSupport()
    if (!containment.ok) {
      throw new DelegationError(containment.kind, 'Delegation requires Linux with a working systemd user scope for provider containment.')
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
    // spawn reports EAGAIN and EMFILE asynchronously. With no 'error' listener node raises
    // that failure on the process itself, which would take the MCP server down and with it
    // every other in-flight job. The job is still queued when this fires - nothing claimed
    // it and now nothing will - so failQueued is the honest report. The cause goes to the
    // owner-only service log; the caller sees a kind and a fixed message with no path in it.
    child.on('error', (cause) => {
      try { serviceLog(this.stateDir, `worker spawn failed for job ${jobId}: ${cause?.code || ''} ${cause?.message || cause}`) } catch {}
      const error = publicError(new DelegationError('WORKER_SPAWN_FAILED', 'The delegation worker process could not be started.'))
      try { this.withStore((store) => store.failQueued(jobId, error)) } catch {}
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

  async requireVisible(jobId, { rootUris = [], fallbackCwd = null } = {}) {
    const job = this.get(jobId)
    const roots = canonicalRoots({ rootUris, projectDir: this.projectDir, fallbackCwd })
    await canonicalWorkspace(job.cwd, roots)
    return job
  }

  result(jobId) { return resultEnvelope(this.get(jobId)) }

  events(jobId, options = {}) {
    this.get(jobId)
    return this.withStore((store) => store.events(jobId, options))
  }

  // Cancelling a quarantined job is the one way out of a quarantine that cannot end by itself:
  // the recorded processes are all gone, or none was ever recorded, so no later status read
  // will ever prove the writer stopped and the write lease would be held forever. Liveness is
  // re-checked here rather than trusted from the row, and the ending is 'unknown' because
  // nothing proved what the turn did.
  cancel(jobId) {
    const job = this.get(jobId)
    if (job.status !== 'quarantined') return this.withStore((store) => store.requestCancel(jobId))
    const live = liveProviderIdentities(job)
    if (live.length) {
      throw new DelegationError('JOB_QUARANTINED', 'The quarantined provider is still running, so Flow will not release its write lease.', { live })
    }
    return this.withStore((store) => store.resolveQuarantine(jobId, { force: 'unknown' }))
  }

  list(limit = 50) {
    return this.withStore((store) => store.listJobs({ host: this.host, target: this.target(), limit }))
  }

  // The route's jobs inside this client's workspace roots, which is the same visibility the
  // job tools enforce one id at a time. The database is shared across workspaces, so a
  // listing that skipped this check would name and expose another repository's jobs.
  async listVisible({ rootUris = [], fallbackCwd = null } = {}, limit = 50) {
    const roots = canonicalRoots({ rootUris, projectDir: this.projectDir, fallbackCwd })
    const visible = []
    for (const job of this.list(limit)) {
      try { await canonicalWorkspace(job.cwd, roots); visible.push(job) } catch {}
    }
    return visible
  }

  decideApproval(jobId, approvalId, decision, decidedBy) {
    if (!['accept', 'decline'].includes(decision)) throw new DelegationError('BAD_REQUEST', 'An approval decision is accept or decline.')
    return this.withStore((store) => {
      this.requireRoute(store.requireJob(jobId))
      return store.decideApproval(jobId, approvalId, decision, decidedBy)
    })
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
      prompt: input.prompt,
      cwd: previous.cwd,
      timeBudgetSeconds: input.timeBudgetSeconds || previous.timeBudgetSeconds,
      maxTurns: input.maxTurns ?? previous.maxTurns,
      maxBudgetUsd: input.maxBudgetUsd ?? previous.maxBudgetUsd,
      outputSchema: input.outputSchema ?? null,
      parentJobId: previous.id,
      nativeThreadId: previous.nativeThreadId,
      elicitation: Boolean(input.elicitation),
    }, roots)
  }

  // handshakeClient, not client: the App Server connection a few lines down already owns that
  // name inside this method, and two different clients under one identifier is a trap.
  async doctor(cwd, { workspace = { ok: Boolean(cwd) }, client: handshakeClient = null } = {}) {
    const target = this.target()
    if (target === 'claude') return this.claudeDoctor(cwd, { workspace, client: handshakeClient })
    const checks = {
      workspace,
      node: { ok: Number(process.versions.node.split('.')[0]) >= 22, version: process.version },
      host: codexHostSupport(),
      containment: providerContainmentSupport({ fresh: true }),
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
    } catch (error) {
      // The kind survives, because one of these is actionable and the rest are not. A store
      // that refuses to reset an older database while jobs are still live answers
      // STORE_UPGRADE_BLOCKED, and doctor is where an operator finds out why nothing starts.
      checks.database = { ok: false, kind: error instanceof DelegationError ? error.kind : 'DATABASE' }
    }
    // Each probe reports itself. Sharing one catch made an account failure read as a dead App
    // Server, which is the opposite of what doctor is for.
    if (checks.host.ok && checks.codex.ok && checks.containment.ok) {
      let client
      try {
        client = new AppServerClient({ cwd: cwd || undefined, experimentalApi: true })
        await client.start()
        checks.appServer = { ok: true }
      } catch (error) {
        checks.appServer = { ok: false, error: publicError(error) }
        if (client) await client.stop()
      }
      if (checks.appServer.ok) {
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
    // hostCapabilities sits beside checks, never inside it. It is a declarative inventory of
    // what this harness can do, so a false entry is a fact about the harness and must not pull
    // doctor's ok down the way a failed probe does.
    return { ok: Object.values(checks).every((check) => check.ok), target, capabilities: this.capabilities(), client: observedClient(handshakeClient), hostCapabilities: this.hostCapabilities(handshakeClient), checks }
  }

  async claudeDoctor(cwd, { workspace = { ok: Boolean(cwd) }, client = null } = {}) {
    const checks = {
      workspace,
      node: { ok: Number(process.versions.node.split('.')[0]) >= 22, version: process.version },
      claude: claudeVersion(),
      containment: providerContainmentSupport({ fresh: true }),
      agentSdk: claudeAgentSdkStatus(),
      database: { ok: false },
      account: claudeAuthStatus(),
      models: { ok: false },
    }
    try {
      const quarantined = this.withStore((store) => store.quarantinedCount())
      checks.database = { ok: true, path: this.stateDir, quarantined }
    } catch (error) {
      // The kind survives, because one of these is actionable and the rest are not. A store
      // that refuses to reset an older database while jobs are still live answers
      // STORE_UPGRADE_BLOCKED, and doctor is where an operator finds out why nothing starts.
      checks.database = { ok: false, kind: error instanceof DelegationError ? error.kind : 'DATABASE' }
    }
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
      client: observedClient(client),
      hostCapabilities: this.hostCapabilities(client),
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
      client = new AppServerClient({ cwd: job.cwd })
      await client.start()
      const response = await client.request('thread/read', { threadId: job.nativeThreadId, includeTurns: true }, 20_000)
      const turns = response.thread?.turns || []
      const turn = turns.find((item) => item.id === job.nativeTurnId)
      if (!turn || turn.status === 'inProgress') {
        return this.withStore((store) => store.finish(jobId, 'unknown', { error: { kind: 'RECOVERY_UNKNOWN', message: 'Codex could not prove the stale turn reached a terminal state.', details: null } }))
      }
      // The same fold the live worker uses. A cancel sits in the controls table and the worker
      // journals a deadline or a stall before it sends turn/interrupt, so recovery can name
      // each interruption of its own. One it cannot name was never asked for: Codex ends a
      // turn as interrupted when its client vanishes, and the client was the dead worker.
      const context = this.withStore((store) => ({ cancelRequested: store.cancelRequested(jobId), ...store.interruptEvidence(jobId) }))
      const outcome = foldTurnOutcome(turn, { ...context, acceptedWrite: job.access === 'workspace-write' })
      if (outcome.error?.kind === 'INTERRUPTED') {
        outcome.error = { kind: 'WORKER_EXIT', message: 'The delegation worker exited while the Codex turn was running.', details: null }
      }
      return this.withStore((store) => {
        if (outcome.internalError) store.recordInternalError(jobId, outcome.internalError)
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
