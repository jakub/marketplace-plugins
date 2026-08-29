import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AppServerClient, assertRestrictedPermissionProfile, assertThreadMcpIsolated, CODEX_PERMISSION_PROFILE, codexHostSupport, codexVersion, isolatedThreadConfig, isApprovalRequest, restrictedPermissionConfig } from './app-server.mjs'
import { runClaudeWorker } from './claude-worker.mjs'
import { providerScopeName } from './containment.mjs'
import { assertRoute, DelegationError, TERMINAL_STATES, publicError } from './contracts.mjs'
import { delegatedInstructions } from './instructions.mjs'
import { foldTurnOutcome, validateStructured } from './outcome.mjs'
import { providerOutputSchema } from './schema.mjs'
import { JobStore, processStartToken, serviceLog } from './store.mjs'
import { gitMetadataPaths } from './workspace.mjs'

// The total budget alone cannot catch a wedged App Server: a half-dead socket sends no
// notifications while the worker keeps heartbeating as healthy. This is the quiet-period
// ceiling, inherited from the shell transport it replaced.
const STALL_SECONDS = 420

const textInput = (text) => [{ type: 'text', text, text_elements: [] }]

export async function runWorker(options) {
  const store = new JobStore(options.stateDir)
  let target
  try {
    target = store.requireJob(options.jobId).target
    if (!['claude', 'codex'].includes(target)) {
      const error = new DelegationError('ROUTE_DENIED', 'The queued job names an unknown model family.')
      store.failQueued(options.jobId, publicError(error))
      process.exitCode = 1
      return
    }
  } finally { store.close() }
  if (target === 'claude') return runClaudeWorker(options)
  return runCodexWorker(options)
}

async function runCodexWorker({ jobId, stateDir }) {
  const store = new JobStore(stateDir)
  let job
  try {
    job = store.claim(jobId, process.pid, processStartToken(process.pid))
  } catch (error) {
    // A failed claim means this process never owned the job. Another worker may hold the
    // lease and the write boundary right now, so the only write allowed is the one that still
    // finds the job queued: that proves no worker owns it and the caller would otherwise wait
    // out the stale-heartbeat timeout for a job nobody will ever start.
    serviceLog(stateDir, `worker could not claim job ${jobId}: ${error.message}`)
    try { store.failQueued(jobId, publicError(error)) } catch {}
    store.close()
    process.exitCode = 1
    return
  }

  let client
  let heartbeat
  let controlTimer
  let deadlineTimer
  let forcedTimer
  let stallTimer
  let turnId = null
  let latestMessage = ''
  let usage = null
  let approvalMethod = null
  let transportError = null
  let timedOut = false
  let stalled = false
  let interruptReason = null
  let cancelled = false
  let nativeTurnTerminal = false
  let onStallFire = null
  let terminalResolve
  const terminal = new Promise((resolve) => { terminalResolve = resolve })
  let controlBusy = false
  let activeControlPoll = Promise.resolve()
  let previewAt = 0
  let jobTempDir = null
  let quarantined = false
  let signalStopping = false
  const providerScope = process.platform === 'linux' ? providerScopeName(job.id) : null
  const signalHandlers = []

  const rememberProvider = ({ discover = false } = {}) => {
    const pid = client?.child?.pid
    if (!Number.isInteger(pid) || pid <= 0) return
    if (discover) client.captureDescendants()
    const startToken = processStartToken(pid)
    store.setProviderProcess(jobId, {
      pid,
      startToken,
      processGroupId: process.platform === 'win32' ? null : pid,
      scope: client.scopeName,
      processes: client.trackedProcesses(),
    })
  }

  const stopProvider = async () => {
    if (!client) return true
    const active = client
    rememberProvider()
    await active.stop()
    if (active.treeRunning()) {
      rememberProvider()
      return false
    }
    client = null
    return true
  }

  const settle = async (status, result = {}) => {
    if (!await stopProvider()) {
      quarantined = true
      return store.quarantine(jobId, status, result)
    }
    return store.finish(jobId, status, result)
  }

  // Every notification for this job is proof the App Server is still alive, so each one
  // restarts the quiet-period clock. The timer only exists once the turn is accepted.
  const resetStall = () => {
    if (!onStallFire || interruptReason) return
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(onStallFire, STALL_SECONDS * 1_000)
  }

  try {
    assertRoute({ host: job.host, target: job.target, depth: job.depth })
    const host = codexHostSupport()
    if (!host.ok) throw new DelegationError(host.kind, 'Codex delegation requires a Linux host.')
    const codex = codexVersion()
    if (!codex.ok) throw new DelegationError(codex.kind, 'Codex no longer meets the delegation version requirement.')
    const preflightCancel = store.pendingControls(jobId).find((control) => control.type === 'cancel')
    if (preflightCancel) {
      store.handleControl(jobId, preflightCancel.id, { result: 'cancelled_before_start' })
      store.finish(jobId, 'cancelled')
      return
    }
    const tempRoot = join(stateDir, 'tmp')
    mkdirSync(tempRoot, { recursive: true, mode: 0o700 })
    jobTempDir = mkdtempSync(join(tempRoot, `${job.id}-`))
    chmodSync(jobTempDir, 0o700)
    const metadataPaths = await gitMetadataPaths(job.cwd)
    heartbeat = setInterval(() => {
      try {
        store.heartbeat(jobId)
        rememberProvider({ discover: true })
      } catch (error) {
        store.recordInternalError(jobId, error)
      }
    }, 1_000)

    // A kill mid-turn skips the cooperative interrupt. The child dies BEFORE the job is
    // marked, because finish() releases the write lease and a writer must never outlive it;
    // an accepted write with no native terminal proof is unknown, never failed.
    const onSignal = async (signal) => {
      if (signalStopping) return
      signalStopping = true
      try {
        const current = store.getJob(jobId)
        if (current && !TERMINAL_STATES.includes(current.status) && current.status !== 'quarantined') {
          const acceptedWrite = current.access === 'workspace-write' && current.turnAcceptedAt
          await settle(acceptedWrite && !nativeTurnTerminal ? 'unknown' : 'failed', {
            error: { kind: 'INTERRUPTED', message: `The delegation worker received ${signal}.`, details: null },
            usage,
          })
        }
      } catch {}
      if (!quarantined) try { if (jobTempDir) rmSync(jobTempDir, { recursive: true, force: true }) } catch {}
      // The worker leads its own process group (spawned detached), so this sweeps any
      // remaining worker subprocesses along with this process itself. App Server has its own
      // tracked process group and is either dead or held in quarantine before this point.
      try { process.kill(-process.pid, 'SIGKILL') } catch {}
      process.exit(1)
    }
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      const handler = () => { void onSignal(signal) }
      signalHandlers.push([signal, handler])
      process.on(signal, handler)
    }

    const onNotification = (method, params) => {
      resetStall()
      if (method === 'turn/started') {
        turnId = params.turn?.id || turnId
        if (turnId) store.setNativeTurn(jobId, turnId, { accepted: true })
        store.appendEvent(jobId, 'turn.started', { turnId })
      } else if (method === 'turn/completed') {
        terminalResolve(params.turn)
      } else if (method === 'item/started') {
        store.appendEvent(jobId, 'item.started', { itemType: params.item?.type || 'unknown' })
      } else if (method === 'item/completed') {
        const item = params.item || {}
        if (item.type === 'agentMessage' && item.text) latestMessage = item.text
        if (item.type === 'commandExecution') {
          store.appendEvent(jobId, 'command.completed', {
            command: String(item.command || '').slice(0, 300),
            exitCode: item.exitCode ?? null,
            status: item.status || null,
          })
        } else if (item.type === 'fileChange') {
          store.appendEvent(jobId, 'files.changed', {
            paths: (item.changes || []).map((change) => change.path || change.filePath).filter(Boolean).slice(0, 100),
            status: item.status || null,
          })
        } else {
          store.appendEvent(jobId, 'item.completed', { itemType: item.type || 'unknown' })
        }
      } else if (method === 'item/agentMessage/delta') {
        latestMessage += params.delta || ''
        if (latestMessage.length - previewAt >= 400) {
          previewAt = latestMessage.length
          store.appendEvent(jobId, 'agent.progress', {
            characters: latestMessage.length,
            preview: latestMessage.slice(-240),
          })
        }
      } else if (method === 'thread/tokenUsage/updated') {
        usage = params.tokenUsage || null
        store.appendEvent(jobId, 'usage.updated', { total: usage?.total || null })
      }
    }
    const onServerRequest = (method) => {
      if (isApprovalRequest(method)) {
        approvalMethod = method
        store.appendEvent(jobId, 'approval.denied', { method })
      } else {
        store.appendEvent(jobId, 'app_server.request_denied', { method })
      }
    }

    client = new AppServerClient({
      cwd: job.cwd,
      env: {
        FLOW_DELEGATION_DEPTH: String(job.depth + 1),
        FLOW_DELEGATION_PARENT_JOB_ID: job.id,
        FLOW_DELEGATION_ACCESS: job.access,
        FLOW_DELEGATION_WORKSPACE_KEY: job.workspaceKey,
        TMPDIR: jobTempDir,
      },
      experimentalApi: true,
      scopeName: providerScope,
      onNotification,
      onServerRequest,
      onClose: (error) => {
        transportError = error
        terminalResolve(null)
      },
    })
    await client.start()
    rememberProvider()
    store.appendEvent(jobId, 'app_server.ready', {})

    const config = {
      ...await isolatedThreadConfig(client),
      ...restrictedPermissionConfig(job, { gitMetadataPaths: metadataPaths, tempDir: jobTempDir }),
    }
    store.appendEvent(jobId, 'mcp.isolation_configured', {
      standaloneServers: Object.keys(config.mcp_servers).length,
    })

    const threadParams = {
      model: job.model,
      serviceTier: job.serviceTier,
      cwd: job.cwd,
      runtimeWorkspaceRoots: [job.workspaceKey],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      permissions: CODEX_PERMISSION_PROFILE,
      developerInstructions: delegatedInstructions(job, 'Codex'),
      config,
    }
    const threadResponse = job.nativeThreadId
      ? await client.request('thread/resume', { threadId: job.nativeThreadId, ...threadParams }, 30_000)
      : await client.request('thread/start', { ...threadParams, ephemeral: false, serviceName: 'flow-delegation' }, 30_000)
    const threadId = threadResponse.thread?.id
    if (!threadId) throw new DelegationError('APP_SERVER_PROTOCOL', 'Codex did not return a thread ID.')
    assertRestrictedPermissionProfile(threadResponse)
    const isolation = await assertThreadMcpIsolated(client, threadId)
    store.appendEvent(jobId, 'mcp.isolation_verified', isolation)
    store.setRunning(jobId, { threadId })
    store.appendEvent(jobId, job.nativeThreadId ? 'thread.resumed' : 'thread.started', { threadId })

    const turnResponse = await client.request('turn/start', {
      threadId,
      input: textInput(job.prompt || ''),
      cwd: job.cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      model: job.model,
      serviceTier: job.serviceTier,
      effort: job.effort,
      summary: 'detailed',
      outputSchema: providerOutputSchema(job.outputSchema),
    }, 30_000)
    turnId = turnResponse.turn?.id || turnId
    if (!turnId) throw new DelegationError('APP_SERVER_PROTOCOL', 'Codex did not return a turn ID.')
    store.setRunning(jobId, { threadId, turnId, accepted: true })
    store.appendEvent(jobId, 'turn.accepted', { turnId })

    const runControl = async (control) => {
      try {
        if (control.type === 'cancel') {
          cancelled = true
          await client.request('turn/interrupt', { threadId, turnId }, 10_000)
          store.handleControl(jobId, control.id, { result: 'interrupt_sent' })
        } else if (control.type === 'steer') {
          await client.request('turn/steer', {
            threadId,
            expectedTurnId: turnId,
            input: textInput(control.payload.text),
          }, 15_000)
          store.handleControl(jobId, control.id, { result: 'steered' })
        }
      } catch (error) {
        store.handleControl(jobId, control.id, { result: 'failed', error: publicError(error) })
      }
    }
    const pollControls = () => {
      if (controlBusy) return
      controlBusy = true
      activeControlPoll = (async () => {
        for (const control of store.pendingControls(jobId)) await runControl(control)
      })().finally(() => { controlBusy = false })
    }
    controlTimer = setInterval(pollControls, 250)

    // Deadline and stall share one ending: whichever fires first owns the reason, clears
    // both timers before any await, and only that one sends turn/interrupt. Without the
    // latch, a stall followed by a slow interrupt let the deadline fire a second interrupt
    // and the recorded reason depended on response timing.
    const interruptAndForce = async (reason) => {
      if (interruptReason) return
      interruptReason = reason
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null }
      if (reason === 'deadline') {
        timedOut = true
        store.appendEvent(jobId, 'turn.timeout', { seconds: job.timeBudgetSeconds })
      } else {
        stalled = true
        store.appendEvent(jobId, 'turn.stalled', { seconds: STALL_SECONDS })
      }
      try { await client.request('turn/interrupt', { threadId, turnId }, 10_000) } catch {}
      if (!forcedTimer) forcedTimer = setTimeout(() => terminalResolve(null), 5_000)
    }
    deadlineTimer = setTimeout(() => { void interruptAndForce('deadline') }, job.timeBudgetSeconds * 1_000)
    onStallFire = () => { void interruptAndForce('stall') }
    resetStall()

    const turn = await terminal
    nativeTurnTerminal = Boolean(turn && turn.status !== 'inProgress')
    if (approvalMethod) {
      await settle('awaiting_approval', {
        error: { kind: 'APPROVAL_REQUIRED', message: 'Codex requested an approval that Flow denied.', details: { method: approvalMethod } },
        usage,
      })
    } else {
      const outcome = foldTurnOutcome(turn, {
        cancelRequested: cancelled,
        deadlineFired: timedOut,
        stallFired: stalled,
        acceptedWrite: job.access === 'workspace-write',
        latestMessage,
        transportError,
      })
      if (outcome.internalError) store.recordInternalError(jobId, outcome.internalError)
      if (outcome.status === 'succeeded') {
        const structured = job.outputSchema != null ? validateStructured(job.outputSchema, outcome.output) : null
        await settle('succeeded', { output: outcome.output, structured, usage, error: null })
      } else {
        await settle(outcome.status, { error: outcome.error, usage })
      }
    }
  } catch (error) {
    try {
      if (!(error instanceof DelegationError)) store.recordInternalError(jobId, error)
      const current = store.getJob(jobId)
      if (current && !TERMINAL_STATES.includes(current.status) && current.status !== 'quarantined') {
        const acceptedWrite = current.access === 'workspace-write' && current.turnAcceptedAt
        const status = approvalMethod ? 'awaiting_approval' : acceptedWrite && !nativeTurnTerminal ? 'unknown' : 'failed'
        await settle(status, {
          error: approvalMethod
            ? { kind: 'APPROVAL_REQUIRED', message: 'Codex requested an approval that Flow denied.', details: { method: approvalMethod } }
            : publicError(error),
          usage,
        })
      }
    } catch {}
  } finally {
    // Keep the signal handlers installed until provider cleanup finishes. A signal in this
    // window must not restore Node's default immediate exit and strand a live provider.
    signalStopping = true
    if (heartbeat) clearInterval(heartbeat)
    if (controlTimer) clearInterval(controlTimer)
    if (deadlineTimer) clearTimeout(deadlineTimer)
    if (forcedTimer) clearTimeout(forcedTimer)
    if (stallTimer) clearTimeout(stallTimer)
    await activeControlPoll.catch(() => {})
    try {
      const stopped = !client || await stopProvider()
      if (!stopped) {
        const current = store.getJob(jobId)
        if (current && !TERMINAL_STATES.includes(current.status) && current.status !== 'quarantined') {
          quarantined = true
          const acceptedWrite = current.access === 'workspace-write' && current.turnAcceptedAt
          store.quarantine(jobId, acceptedWrite && !nativeTurnTerminal ? 'unknown' : 'failed', {
            error: { kind: 'PROVIDER_QUARANTINED', message: 'Codex App Server survived repeated termination attempts.', details: null },
            usage,
          })
        }
      } else if (store.getJob(jobId)?.status === 'quarantined') {
        store.resolveQuarantine(jobId)
        quarantined = false
      }
    } catch (error) {
      serviceLog(stateDir, `Codex worker could not quarantine provider processes for ${jobId}: ${error?.stack || error}`)
    }
    if (jobTempDir && !quarantined) try { rmSync(jobTempDir, { recursive: true, force: true }) } catch {}
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    store.close()
  }
}
