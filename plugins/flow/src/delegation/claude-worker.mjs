import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { normalizeClaudeError } from './claude-errors.mjs'
import { createClaudeQuery } from './claude-sdk.mjs'
import { assertRoute, DelegationError, TERMINAL_STATES, publicError } from './contracts.mjs'
import { validateStructuredValue } from './outcome.mjs'
import { JobStore, processStartToken, serviceLog } from './store.mjs'

const STALL_SECONDS = 420
const STARTUP_SECONDS = 30

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function withStartupTimeout(promise, onTimeout, seconds = STARTUP_SECONDS) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout()
          reject(new DelegationError('CLAUDE_STARTUP_TIMEOUT', `Claude did not initialize within ${seconds} seconds.`))
        }, seconds * 1_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function sdkPrompt(text, sessionId, turnId) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
    uuid: turnId,
    session_id: sessionId,
  }
}

function resultUsage(result) {
  if (!result) return null
  return {
    durationMs: result.duration_ms ?? null,
    durationApiMs: result.duration_api_ms ?? null,
    turns: result.num_turns ?? null,
    totalCostUsd: result.total_cost_usd ?? null,
    usage: result.usage ?? null,
    modelUsage: result.modelUsage ?? null,
  }
}

function resultFailure(result, { assistantError = null, rateLimitStatus = null } = {}) {
  const kind = assistantError === 'authentication_failed' || assistantError === 'oauth_org_not_allowed' ? 'CLAUDE_AUTH'
    : assistantError === 'rate_limit' || rateLimitStatus === 'rejected' ? 'RATE_LIMIT'
    : assistantError === 'billing_error' || assistantError === 'account_on_hold' ? 'BILLING'
    : assistantError === 'model_not_found' ? 'BAD_MODEL'
    : assistantError === 'overloaded' ? 'OVERLOADED'
    : result?.subtype === 'error_max_turns' ? 'MAX_TURNS'
    : result?.subtype === 'error_max_budget_usd' ? 'MAX_BUDGET'
    : result?.subtype === 'error_max_structured_output_retries' ? 'SCHEMA_OUTPUT'
    : 'CLAUDE_TURN'
  const message = kind === 'RATE_LIMIT'
    ? 'Claude rejected the turn because the current plan or API rate limit is exhausted.'
    : kind === 'CLAUDE_AUTH'
      ? 'Claude Code is not authenticated for Agent SDK use.'
      : kind === 'BAD_MODEL'
        ? 'Claude rejected the requested model.'
        : 'Claude did not complete the delegated turn.'
  return { kind, message, details: null }
}

export async function runClaudeWorker({ jobId, stateDir }) {
  const store = new JobStore(stateDir)
  let job
  try {
    job = store.claim(jobId, process.pid, processStartToken(process.pid))
  } catch (error) {
    serviceLog(stateDir, `Claude worker could not claim job ${jobId}: ${error.message}`)
    try { store.failQueued(jobId, publicError(error)) } catch {}
    store.close()
    process.exitCode = 1
    return
  }

  let active
  let child
  let childExited = Promise.resolve()
  let heartbeat
  let controlTimer
  let deadlineTimer
  let forcedTimer
  let stallTimer
  let accepted = false
  let cancelled = false
  let timedOut = false
  let stalled = false
  let interruptReason = null
  let approvalRequired = null
  let assistantError = null
  let rateLimitStatus = null
  let terminalResult = null
  let latestPreview = ''
  let previewChars = 0
  let previewAt = 0
  let stderrTail = ''
  let controlBusy = false
  let activeControlPoll = Promise.resolve()
  let releasePrompt
  const promptReady = new Promise((resolve) => { releasePrompt = resolve })
  const sessionId = job.nativeThreadId || randomUUID()
  const turnId = randomUUID()
  const signalHandlers = []

  async function* input() {
    await promptReady
    yield sdkPrompt(job.prompt || '', sessionId, turnId)
  }

  const childTreeRunning = () => {
    if (!child?.pid) return false
    if (process.platform === 'win32') return child.exitCode === null && !child.signalCode
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }

  const signalChildTree = (signal) => {
    if (!child?.pid) return
    try {
      if (process.platform === 'win32') {
        const args = ['/PID', String(child.pid), '/T']
        if (signal === 'SIGKILL') args.push('/F')
        spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true })
      } else {
        process.kill(-child.pid, signal)
      }
    } catch {}
  }

  const waitForChildTree = async (milliseconds) => {
    const deadline = Date.now() + milliseconds
    while (childTreeRunning() && Date.now() < deadline) await delay(50)
    return !childTreeRunning()
  }

  const stopChild = async () => {
    try { active?.close() } catch {}
    if (!child?.pid || !childTreeRunning()) {
      await Promise.race([childExited, delay(100)])
      return
    }
    signalChildTree('SIGTERM')
    if (await waitForChildTree(1_000)) return
    signalChildTree('SIGKILL')
    // Never release a workspace-write lease while a descendant can still mutate the tree.
    // POSIX process groups let us prove that the full provider tree has exited.
    if (process.platform !== 'win32') {
      while (childTreeRunning()) {
        signalChildTree('SIGKILL')
        await delay(50)
      }
    }
    await Promise.race([childExited, delay(1_000)])
  }

  const clearTurnTimers = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
    if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null }
    if (forcedTimer) { clearTimeout(forcedTimer); forcedTimer = null }
  }

  const interruptAndForce = async (reason) => {
    if (interruptReason || terminalResult) return
    interruptReason = reason
    clearTurnTimers()
    if (reason === 'deadline') {
      timedOut = true
      store.appendEvent(jobId, 'turn.timeout', { seconds: job.timeBudgetSeconds })
    } else if (reason === 'stall') {
      stalled = true
      store.appendEvent(jobId, 'turn.stalled', { seconds: STALL_SECONDS })
    }
    forcedTimer = setTimeout(() => { try { active.close() } catch {} }, 5_000)
    const interrupt = Promise.resolve().then(() => active.interrupt()).catch(() => {})
    await Promise.race([interrupt, delay(5_500)])
  }

  const resetStall = () => {
    if (!accepted || interruptReason || terminalResult) return
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => { void interruptAndForce('stall') }, STALL_SECONDS * 1_000)
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

    const onSignal = (signal) => {
      try { active?.close() } catch {}
      signalChildTree('SIGKILL')
      try {
        const current = store.getJob(jobId)
        if (current && !TERMINAL_STATES.includes(current.status)) {
          const acceptedWrite = current.access === 'workspace-write' && current.turnAcceptedAt
          store.finish(jobId, acceptedWrite && !terminalResult ? 'unknown' : 'failed', {
            error: { kind: 'INTERRUPTED', message: `The Claude delegation worker received ${signal}.`, details: null },
            usage: resultUsage(terminalResult),
          })
        }
      } catch {}
      try { process.kill(-process.pid, 'SIGKILL') } catch {}
      process.exit(1)
    }
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      const handler = () => onSignal(signal)
      signalHandlers.push([signal, handler])
      process.on(signal, handler)
    }

    const canUseTool = async (toolName) => {
      approvalRequired ||= toolName || 'unknown'
      store.appendEvent(jobId, 'approval.denied', { toolName: toolName || 'unknown' })
      return {
        behavior: 'deny',
        message: 'Flow does not grant delegated approvals. The caller must change the job contract.',
        interrupt: true,
        decisionClassification: 'user_reject',
      }
    }

    const runControl = async (control) => {
      try {
        if (control.type === 'cancel') {
          cancelled = true
          if (accepted) {
            await interruptAndForce('cancel')
            store.handleControl(jobId, control.id, { result: 'interrupt_sent' })
          } else {
            active.close()
            store.handleControl(jobId, control.id, { result: 'cancelled_before_turn' })
          }
        } else {
          store.handleControl(jobId, control.id, {
            result: 'unsupported',
            error: { kind: 'CONTROL_UNSUPPORTED', message: 'Claude does not support live turn steering.', details: null },
          })
        }
      } catch (error) {
        store.handleControl(jobId, control.id, { result: 'failed', error: publicError(normalizeClaudeError(error)) })
      }
    }
    const pollControls = () => {
      if (controlBusy) return
      controlBusy = true
      activeControlPoll = (async () => {
        for (const control of store.pendingControls(jobId)) await runControl(control)
      })().finally(() => { controlBusy = false })
    }

    active = createClaudeQuery(job, input(), {
      sessionId,
      canUseTool,
      onSpawn: (spawned) => {
        child = spawned
        childExited = new Promise((resolve) => child.once('exit', resolve))
      },
      onStderr: (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-16_384) },
      onPolicyDenied: ({ toolName, reason }) => {
        store.appendEvent(jobId, 'policy.denied', { toolName, reason: String(reason).slice(0, 500) })
      },
    })
    store.appendEvent(jobId, 'claude_sdk.ready', {})
    controlTimer = setInterval(pollControls, 250)
    pollControls()

    // The SDK control channel initializes before Claude emits the streamed system/init
    // frame. That frame waits for the first user message, so using it as the release gate
    // deadlocks the session. A successful initialize response proves the CLI is ready. Flow
    // chose the session and user-message UUIDs, so it can persist the accepted boundary and
    // then release exactly that message.
    const initialized = await withStartupTimeout(active.initializationResult(), () => active.close())
    if (!initialized || typeof initialized !== 'object') {
      throw new DelegationError('CLAUDE_PROTOCOL', 'Claude returned no SDK initialization result.')
    }
    if (cancelled) {
      store.finish(jobId, 'cancelled')
      return
    }
    const selectedModel = Array.isArray(initialized.models)
      ? initialized.models.find((entry) => entry.value === job.model)
      : null
    store.setRunning(jobId, { threadId: sessionId })
    store.appendEvent(jobId, job.nativeThreadId ? 'session.resumed' : 'session.started', {
      sessionId,
      model: selectedModel?.resolvedModel || job.model,
      apiProvider: initialized.account?.apiProvider || null,
      subscriptionType: initialized.account?.subscriptionType || null,
    })
    store.setNativeTurn(jobId, turnId, { accepted: true })
    store.appendEvent(jobId, 'turn.accepted', { turnId })
    accepted = true
    releasePrompt()
    deadlineTimer = setTimeout(() => { void interruptAndForce('deadline') }, job.timeBudgetSeconds * 1_000)
    resetStall()

    try {
      for await (const message of active) {
        resetStall()
        if (message.type === 'system' && message.subtype === 'init') {
          if (message.session_id !== sessionId) {
            throw new DelegationError('CLAUDE_PROTOCOL', 'Claude returned a different session ID than Flow requested.')
          }
          store.appendEvent(jobId, 'session.initialized', {
            sessionId,
            model: message.model || job.model,
            apiKeySource: message.apiKeySource || null,
            capabilities: Array.isArray(message.capabilities) ? message.capabilities : [],
          })
        } else if (message.type === 'stream_event') {
          const delta = message.event?.delta
          if (message.event?.type === 'content_block_delta' && delta?.type === 'text_delta') {
            const text = delta.text || ''
            previewChars += text.length
            latestPreview = (latestPreview + text).slice(-240)
            if (previewChars - previewAt >= 400) {
              previewAt = previewChars
              store.appendEvent(jobId, 'agent.progress', {
                characters: previewChars,
                preview: latestPreview,
              })
            }
          }
        } else if (message.type === 'assistant') {
          assistantError ||= message.error || null
          for (const block of message.message?.content || []) {
            if (block.type === 'tool_use') {
              store.appendEvent(jobId, 'tool.started', { toolName: block.name || 'unknown' })
            }
          }
        } else if (message.type === 'user' && message.tool_use_result !== undefined) {
          store.appendEvent(jobId, 'tool.completed', {})
        } else if (message.type === 'tool_progress') {
          store.appendEvent(jobId, 'tool.progress', {
            toolName: message.tool_name || 'unknown',
            elapsedSeconds: message.elapsed_time_seconds ?? null,
          })
        } else if (message.type === 'rate_limit_event') {
          rateLimitStatus = message.rate_limit_info?.status || null
          store.appendEvent(jobId, 'rate_limit.updated', { status: rateLimitStatus })
        } else if (message.type === 'result') {
          terminalResult = message
          break
        }
      }
    } catch (error) {
      if (!terminalResult) throw error
      store.appendEvent(jobId, 'transport.error_after_result', {})
    }

    clearTurnTimers()
    await stopChild()
    const usage = resultUsage(terminalResult)
    if (approvalRequired) {
      store.finish(jobId, 'awaiting_approval', {
        error: {
          kind: 'APPROVAL_REQUIRED',
          message: 'Claude requested an approval that Flow denied.',
          details: { toolName: approvalRequired },
        },
        usage,
      })
    } else if (!terminalResult) {
      const acceptedWrite = job.access === 'workspace-write' && accepted
      const status = cancelled && !acceptedWrite ? 'cancelled' : acceptedWrite ? 'unknown' : 'failed'
      store.finish(jobId, status, {
        error: status === 'cancelled' ? null : {
          kind: stalled ? 'STALL' : timedOut ? 'TIMEOUT' : 'CLAUDE_SDK',
          message: acceptedWrite
            ? 'Claude did not prove the accepted write turn reached a terminal state.'
            : 'Claude ended before the delegated turn reached a terminal state.',
          details: null,
        },
        usage,
      })
    } else if (cancelled && (terminalResult.is_error || terminalResult.subtype !== 'success')) {
      store.finish(jobId, 'cancelled', { usage })
    } else if (timedOut || stalled) {
      store.finish(jobId, 'failed', {
        error: {
          kind: timedOut ? 'TIMEOUT' : 'STALL',
          message: `Claude exceeded the ${timedOut ? 'total time budget' : 'quiet-period limit'}.`,
          details: null,
        },
        usage,
      })
    } else if (terminalResult.subtype !== 'success' || terminalResult.is_error) {
      store.finish(jobId, 'failed', { error: resultFailure(terminalResult, { assistantError, rateLimitStatus }), usage })
    } else {
      const output = String(terminalResult.result || '').trim()
      if (!output) throw new DelegationError('EMPTY_OUTPUT', 'Claude completed without a final result.')
      if (job.outputSchema != null && terminalResult.structured_output === undefined) {
        throw new DelegationError('SCHEMA_OUTPUT', 'Claude completed without the requested structured output.')
      }
      const structured = job.outputSchema == null
        ? null
        : validateStructuredValue(job.outputSchema, terminalResult.structured_output, 'Claude')
      store.finish(jobId, 'succeeded', { output, structured, usage, error: null })
    }
  } catch (error) {
    try {
      if (!(error instanceof DelegationError)) store.recordInternalError(jobId, error)
      const normalized = normalizeClaudeError(error)
      await stopChild()
      const current = store.getJob(jobId)
      if (current && !TERMINAL_STATES.includes(current.status)) {
        const acceptedWrite = current.access === 'workspace-write' && current.turnAcceptedAt
        const status = approvalRequired ? 'awaiting_approval'
          : cancelled && !acceptedWrite ? 'cancelled'
            : acceptedWrite && !terminalResult ? 'unknown'
              : 'failed'
        store.finish(jobId, status, {
          error: status === 'cancelled' ? null : approvalRequired
            ? { kind: 'APPROVAL_REQUIRED', message: 'Claude requested an approval that Flow denied.', details: { toolName: approvalRequired } }
            : publicError(normalized),
          usage: resultUsage(terminalResult),
        })
      }
    } catch (finishError) {
      serviceLog(stateDir, `Claude worker could not finish job ${jobId}: ${finishError?.stack || finishError}`)
    }
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    if (heartbeat) clearInterval(heartbeat)
    if (controlTimer) clearInterval(controlTimer)
    clearTurnTimers()
    await activeControlPoll.catch(() => {})
    await stopChild()
    if (stderrTail && !terminalResult) serviceLog(stateDir, `Claude stderr for ${jobId}: ${stderrTail}`)
    store.close()
  }
}
