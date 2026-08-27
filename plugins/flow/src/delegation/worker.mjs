import { AppServerClient, isApprovalRequest, sandboxFor } from './app-server.mjs'
import { assertRoute, DelegationError, TERMINAL_STATES, publicError } from './contracts.mjs'
import { foldTurnOutcome, validateStructured } from './outcome.mjs'
import { JobStore, processStartToken, serviceLog } from './store.mjs'

// The total budget alone cannot catch a wedged App Server: a half-dead socket sends no
// notifications while the worker keeps heartbeating as healthy. This is the quiet-period
// ceiling, inherited from the shell transport it replaced.
const STALL_SECONDS = 420

const textInput = (text) => [{ type: 'text', text, text_elements: [] }]

function developerInstructions(job) {
  const base = 'You are a delegated Codex worker. Complete the caller task directly. Do not delegate to another model family or start subagents.'
  if (job.profile === 'defensive-security') {
    return `${base} The caller selected the defensive-security profile for authorized defensive research. Stay within the requested workspace and access mode.`
  }
  return base
}

export async function runWorker({ jobId, stateDir }) {
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
  const signalHandlers = []

  // Every notification for this job is proof the App Server is still alive, so each one
  // restarts the quiet-period clock. The timer only exists once the turn is accepted.
  const resetStall = () => {
    if (!onStallFire || interruptReason) return
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(onStallFire, STALL_SECONDS * 1_000)
  }

  try {
    assertRoute({ host: job.host, target: job.target, depth: job.depth })
    const preflightCancel = store.pendingControls(jobId).find((control) => control.type === 'cancel')
    if (preflightCancel) {
      store.handleControl(jobId, preflightCancel.id, { result: 'cancelled_before_start' })
      store.finish(jobId, 'cancelled')
      return
    }
    heartbeat = setInterval(() => store.heartbeat(jobId), 1_000)

    // A kill mid-turn skips the cooperative interrupt. The child dies BEFORE the job is
    // marked, because finish() releases the write lease and a writer must never outlive it;
    // an accepted write with no native terminal proof is unknown, never failed.
    const onSignal = (signal) => {
      try { client?.child?.stdin?.destroy() } catch {}
      try { client?.child?.kill('SIGKILL') } catch {}
      try {
        const current = store.getJob(jobId)
        if (current && !TERMINAL_STATES.includes(current.status)) {
          const acceptedWrite = current.access === 'workspace-write' && current.turnAcceptedAt
          store.finish(jobId, acceptedWrite && !nativeTurnTerminal ? 'unknown' : 'failed', {
            error: { kind: 'INTERRUPTED', message: `The delegation worker received ${signal}.`, details: null },
            usage,
          })
        }
      } catch {}
      // The worker leads its own process group (spawned detached), so this sweeps any
      // command subprocess Codex left behind along with this process itself.
      try { process.kill(-process.pid, 'SIGKILL') } catch {}
      process.exit(1)
    }
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      const handler = () => onSignal(signal)
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

    client = await new AppServerClient({
      cwd: job.cwd,
      env: {
        FLOW_DELEGATION_DEPTH: String(job.depth + 1),
        FLOW_DELEGATION_PARENT_JOB_ID: job.id,
      },
      onNotification,
      onServerRequest,
      onClose: (error) => {
        transportError = error
        terminalResolve(null)
      },
    }).start()
    store.appendEvent(jobId, 'app_server.ready', {})

    const threadParams = {
      model: job.model,
      serviceTier: job.serviceTier,
      cwd: job.cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: job.access,
      developerInstructions: developerInstructions(job),
    }
    const threadResponse = job.nativeThreadId
      ? await client.request('thread/resume', { threadId: job.nativeThreadId, ...threadParams }, 30_000)
      : await client.request('thread/start', { ...threadParams, ephemeral: false, serviceName: 'flow-delegation' }, 30_000)
    const threadId = threadResponse.thread?.id
    if (!threadId) throw new DelegationError('APP_SERVER_PROTOCOL', 'Codex did not return a thread ID.')
    store.setRunning(jobId, { threadId })
    store.appendEvent(jobId, job.nativeThreadId ? 'thread.resumed' : 'thread.started', { threadId })

    const turnResponse = await client.request('turn/start', {
      threadId,
      input: textInput(job.prompt || ''),
      cwd: job.cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: sandboxFor(job),
      model: job.model,
      serviceTier: job.serviceTier,
      effort: job.effort,
      summary: 'detailed',
      outputSchema: job.outputSchema,
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
      if (client) await client.stop()
      client = null
      store.finish(jobId, 'awaiting_approval', {
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
      if (!turn) {
        await client.stop()
        client = null
      }
      if (outcome.status === 'succeeded') {
        const structured = job.outputSchema != null ? validateStructured(job.outputSchema, outcome.output) : null
        store.finish(jobId, 'succeeded', { output: outcome.output, structured, usage, error: null })
      } else {
        store.finish(jobId, outcome.status, { error: outcome.error, usage })
      }
    }
  } catch (error) {
    try {
      if (!(error instanceof DelegationError)) store.recordInternalError(jobId, error)
      const current = store.getJob(jobId)
      if (current && !TERMINAL_STATES.includes(current.status)) {
        const acceptedWrite = current.access === 'workspace-write' && current.turnAcceptedAt
        const status = approvalMethod ? 'awaiting_approval' : acceptedWrite && !nativeTurnTerminal ? 'unknown' : 'failed'
        if (status === 'unknown' || status === 'awaiting_approval') {
          if (client) await client.stop()
          client = null
        }
        store.finish(jobId, status, {
          error: approvalMethod
            ? { kind: 'APPROVAL_REQUIRED', message: 'Codex requested an approval that Flow denied.', details: { method: approvalMethod } }
            : publicError(error),
          usage,
        })
      }
    } catch {}
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    if (heartbeat) clearInterval(heartbeat)
    if (controlTimer) clearInterval(controlTimer)
    if (deadlineTimer) clearTimeout(deadlineTimer)
    if (forcedTimer) clearTimeout(forcedTimer)
    if (stallTimer) clearTimeout(stallTimer)
    await activeControlPoll.catch(() => {})
    if (client) await client.stop()
    store.close()
  }
}
