import { runClaudeJob } from './claude-worker.mjs'
import { runCodexJob } from './codex-worker.mjs'
import { DelegationError, TERMINAL_STATES, publicError } from './contracts.mjs'
import { JobStore, processStartToken, serviceLog } from './store.mjs'

// The MCP server answers a host in the foreground and keeps the store's 5 s wait. A worker
// answers nobody, so it waits out a long lock rather than losing a heartbeat or a journal
// line to one. A worker blocked here stops heartbeating, and recovery already tolerates
// that: it checks the pid and its start token before touching a job with a stale heartbeat.
const WORKER_BUSY_TIMEOUT_MS = 30_000

export async function runWorker(options) {
  const store = new JobStore(options.stateDir, { busyTimeoutMs: WORKER_BUSY_TIMEOUT_MS })
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
  return runProviderJob({ ...options, createAdapter: target === 'claude' ? runClaudeJob : runCodexJob })
}

/**
 * The half of a delegation worker that is the same on both routes: claim the job or explain
 * why it will never run, heartbeat, poll for controls, answer signals, and settle the job
 * exactly once with the provider tree proven dead or the job quarantined.
 *
 * createAdapter receives the claimed job and the skeleton's own settle, and returns the
 * provider half. The two adapters diverge on how a turn is started, driven and classified;
 * everything below is deliberately identical, because the last time these two lifecycles were
 * written out twice they drifted, and the half that drifted was the cleanup.
 */
async function runProviderJob({ jobId, stateDir, createAdapter }) {
  const store = new JobStore(stateDir, { busyTimeoutMs: WORKER_BUSY_TIMEOUT_MS })
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

  let heartbeat
  let controlTimer
  let controlBusy = false
  let activeControlPoll = Promise.resolve()
  let signalStopping = false
  let quarantined = false
  const processHandlers = []

  const recordBackgroundFailure = (error) => {
    try { store.recordInternalError(jobId, error) } catch {
      serviceLog(stateDir, `delegation worker background operation failed for ${jobId}.`)
    }
  }

  let adapter
  const settle = async (status, result = {}) => {
    if (await adapter.stop()) return store.finish(jobId, status, result)
    quarantined = true
    return store.quarantine(jobId, status, result)
  }
  const live = () => {
    const current = store.getJob(jobId)
    if (!current || TERMINAL_STATES.includes(current.status) || current.status === 'quarantined') return null
    return current
  }
  const acceptedWriteOn = (current) => current.access === 'workspace-write' && Boolean(current.turnAcceptedAt)

  adapter = createAdapter({ job, store, stateDir, settle, recordBackgroundFailure })

  try {
    const preflightCancel = store.pendingControls(jobId).find((control) => control.type === 'cancel')
    if (preflightCancel) {
      store.handleControl(jobId, preflightCancel.id, { result: 'cancelled_before_start' })
      store.finish(jobId, 'cancelled')
      return
    }
    heartbeat = setInterval(() => {
      try {
        store.heartbeat(jobId)
        adapter.onHeartbeat()
      } catch (error) { recordBackgroundFailure(error) }
    }, 1_000)

    // A kill mid-turn skips the cooperative interrupt. The child dies BEFORE the job is
    // marked, because finish() releases the write lease and a writer must never outlive it;
    // an accepted write with no native terminal proof is unknown, never failed.
    const onFatal = async (error) => {
      if (signalStopping) return
      signalStopping = true
      try {
        const current = live()
        if (current) {
          const unproven = acceptedWriteOn(current) && !adapter.nativeTerminal()
          await settle(unproven ? 'unknown' : 'failed', { error, usage: adapter.usage() })
        }
      } catch {}
      try { adapter.cleanup({ quarantined }) } catch {}
      // The worker leads its own process group (spawned detached), so this sweeps any
      // remaining worker subprocesses along with this process itself. The provider has its own
      // tracked process group and is either dead or held in quarantine before this point.
      try { process.kill(-process.pid, 'SIGKILL') } catch {}
      process.exit(1)
    }
    const abandon = (error) => {
      recordBackgroundFailure(error)
      adapter.killProvider()
      try { process.kill(-process.pid, 'SIGKILL') } catch {}
      process.exit(1)
    }
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      const handler = () => {
        void onFatal({ kind: 'INTERRUPTED', message: `The ${adapter.provider} delegation worker received ${signal}.`, details: null }).catch(abandon)
      }
      processHandlers.push([signal, handler])
      process.on(signal, handler)
    }
    // The worker runs detached with its stdio discarded, so an exception nobody caught ended
    // the process with no record anywhere, left the provider running until recovery noticed
    // the missing heartbeat, and had the orphaned turn read as INTERRUPTED. The service log
    // gets the stack first, because a journal write can be the very thing that threw; the job
    // then ends the way a signal ends it, provider tree first.
    const onCrash = (error) => {
      serviceLog(stateDir, `${adapter.provider} worker crashed on job ${jobId}: ${error?.stack || error}`)
      recordBackgroundFailure(error)
      void onFatal({ kind: 'WORKER_EXIT', message: `The ${adapter.provider} delegation worker crashed.`, details: null }).catch(abandon)
    }
    for (const event of ['uncaughtException', 'unhandledRejection']) {
      processHandlers.push([event, onCrash])
      process.on(event, onCrash)
    }

    const pollControls = () => {
      if (controlBusy) return
      controlBusy = true
      activeControlPoll = (async () => {
        for (const control of store.pendingControls(jobId)) await adapter.onControl(control)
      })().catch(recordBackgroundFailure).finally(() => { controlBusy = false })
    }

    // start() brings the provider up to the point where a queued control can reach it, so the
    // poll starts the moment that is true and not before: a cancel handed to a provider that
    // does not exist yet is a thrown error recorded as a failed control.
    await adapter.start()
    controlTimer = setInterval(pollControls, 250)
    pollControls()
    await adapter.run()
  } catch (error) {
    try {
      if (!(error instanceof DelegationError)) store.recordInternalError(jobId, error)
      const current = live()
      if (current) {
        const outcome = adapter.failureOutcome(error, { acceptedWrite: acceptedWriteOn(current) })
        await settle(outcome.status, { error: outcome.error, usage: adapter.usage() })
      }
    } catch (settleError) {
      serviceLog(stateDir, `${adapter.provider} worker could not finish job ${jobId}: ${settleError?.stack || settleError}`)
    }
  } finally {
    // Keep the signal handlers installed until provider cleanup finishes. A signal in this
    // window must not restore Node's default immediate exit and strand a live provider.
    signalStopping = true
    if (heartbeat) clearInterval(heartbeat)
    if (controlTimer) clearInterval(controlTimer)
    adapter.clearTimers()
    await activeControlPoll.catch(() => {})
    try {
      const stopped = await adapter.stop()
      if (!stopped) {
        const current = live()
        if (current) {
          quarantined = true
          const unproven = acceptedWriteOn(current) && !adapter.nativeTerminal()
          store.quarantine(jobId, unproven ? 'unknown' : 'failed', {
            error: {
              kind: 'PROVIDER_QUARANTINED',
              message: `${adapter.providerLabel} survived repeated termination attempts.`,
              details: null,
            },
            usage: adapter.usage(),
          })
        }
      } else if (store.getJob(jobId)?.status === 'quarantined') {
        store.resolveQuarantine(jobId)
        quarantined = false
      }
    } catch (error) {
      serviceLog(stateDir, `${adapter.provider} worker could not quarantine provider processes for ${jobId}: ${error?.stack || error}`)
    }
    try { adapter.cleanup({ quarantined }) } catch (error) { recordBackgroundFailure(error) }
    for (const [event, handler] of processHandlers) process.off(event, handler)
    store.close()
  }
}
