import { randomUUID } from 'node:crypto'
import { normalizeClaudeError } from './claude-errors.mjs'
import { createClaudeQuery } from './claude-sdk.mjs'
import { captureProcessDescendants, providerScopeRunning, signalProviderScope, signalTrackedProcessTree, trackedDescendantRunning } from './containment.mjs'
import { assertRoute, DelegationError, publicError, STALL_SECONDS } from './contracts.mjs'
import { validateStructuredValue } from './outcome.mjs'
import { processStartToken, serviceLog } from './store.mjs'

const STARTUP_SECONDS = 30
const RESULT_FAILURE_MESSAGES = {
  RATE_LIMIT: 'Claude rejected the turn because the current plan or API rate limit is exhausted.',
  CLAUDE_AUTH: 'Claude Code is not authenticated for Agent SDK use.',
  BAD_MODEL: 'Claude rejected the requested model.',
  MAX_TURNS: 'Claude reached the delegated turn limit.',
  MAX_BUDGET: 'Claude reached the delegated cost limit.',
  BILLING: 'Claude rejected the turn because the account has a billing problem or is on hold.',
  OVERLOADED: 'Claude is overloaded and rejected the turn.',
  SCHEMA_OUTPUT: 'Claude could not produce output that matches the requested schema.',
}

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
  const message = RESULT_FAILURE_MESSAGES[kind] || 'Claude did not complete the delegated turn.'
  return { kind, message, details: null }
}

/** The Claude Agent SDK half of a delegation worker. runProviderJob owns everything else. */
export function runClaudeJob({ job, store, stateDir, settle, recordBackgroundFailure }) {
  const jobId = job.id
  let active
  let child
  let childExited = Promise.resolve()
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
  let refusal = null
  let servedBy = null
  let terminalResult = null
  let latestPreview = ''
  let previewChars = 0
  let previewAt = 0
  let stderrTail = ''
  const knownDescendants = new Map()
  let releasePrompt
  const promptReady = new Promise((resolve) => { releasePrompt = resolve })
  const sessionId = job.nativeThreadId || randomUUID()
  const turnId = randomUUID()

  async function* input() {
    await promptReady
    yield sdkPrompt(job.prompt || '', sessionId, turnId)
  }

  const childTreeRunning = () => {
    if (!child?.pid) return false
    if (providerScopeRunning(child.flowProviderScope)) return true
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM' || trackedDescendantRunning(knownDescendants)
    }
  }

  const rememberProvider = () => {
    if (!child?.pid) return
    const startToken = processStartToken(child.pid)
    const processes = []
    if (startToken) processes.push({ pid: child.pid, startToken })
    for (const [pid, token] of knownDescendants) processes.push({ pid, startToken: token })
    store.setProviderProcess(jobId, {
      pid: child.pid,
      startToken,
      processGroupId: child.pid,
      scope: child.flowProviderScope,
      processes,
    })
  }

  const freezeDescendants = () => {
    captureProcessDescendants(child?.pid, knownDescendants, { freeze: true })
  }

  const signalChildTree = (signal) => {
    if (!child?.pid) return
    signalProviderScope(child.flowProviderScope, signal)
    signalTrackedProcessTree(child.pid, knownDescendants, signal)
  }

  const waitForChildTree = async (milliseconds) => {
    const deadline = Date.now() + milliseconds
    while (childTreeRunning() && Date.now() < deadline) await delay(50)
    return !childTreeRunning()
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
      try { store.appendEvent(jobId, 'turn.timeout', { seconds: job.timeBudgetSeconds }) } catch (error) {
        recordBackgroundFailure(error)
      }
    } else if (reason === 'stall') {
      stalled = true
      try { store.appendEvent(jobId, 'turn.stalled', { seconds: STALL_SECONDS }) } catch (error) {
        recordBackgroundFailure(error)
      }
    }
    forcedTimer = setTimeout(() => { try { active.close() } catch {} }, 5_000)
    const interrupt = Promise.resolve().then(() => active.interrupt()).catch(() => {})
    await Promise.race([interrupt, delay(5_500)])
  }

  const resetStall = () => {
    if (!accepted || interruptReason || terminalResult) return
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => { void interruptAndForce('stall').catch(recordBackgroundFailure) }, STALL_SECONDS * 1_000)
  }

  return {
    provider: 'Claude',
    providerLabel: 'Claude',

    async start() {
      assertRoute({ host: job.host, target: job.target, depth: job.depth })
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
      active = createClaudeQuery(job, input(), {
        sessionId,
        canUseTool,
        onSpawn: (spawned) => {
          child = spawned
          childExited = new Promise((resolve) => child.once('exit', resolve))
          rememberProvider()
        },
        onStderr: (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-16_384) },
        onPolicyDenied: ({ toolName, reason }) => {
          store.appendEvent(jobId, 'policy.denied', { toolName, reason: String(reason).slice(0, 500) })
        },
      })
      store.appendEvent(jobId, 'claude_sdk.ready', {})
    },

    async run() {
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
        await settle('cancelled')
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
      deadlineTimer = setTimeout(() => { void interruptAndForce('deadline').catch(recordBackgroundFailure) }, job.timeBudgetSeconds * 1_000)
      resetStall()

      try {
        for await (const message of active) {
          resetStall()
          if (message.type === 'system' && (message.subtype === 'model_refusal_no_fallback' || message.subtype === 'model_refusal_fallback')) {
            // The CLI's structured counterpart to stop_reason 'refusal'. The fallback variant
            // means the harness answered on another model anyway; the job still fails, because
            // a downgraded answer under the requested model's name is the one outcome the
            // charter forbids.
            refusal = {
              category: message.api_refusal_category ?? null,
              originalModel: message.original_model ?? null,
              fallbackModel: message.fallback_model ?? null,
            }
            store.appendEvent(jobId, 'turn.refused', refusal)
          } else if (message.type === 'system' && message.subtype === 'init') {
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
            if (message.message?.stop_reason === 'refusal' && !refusal) {
              refusal = { category: message.message.stop_details?.category ?? null, originalModel: message.message.model ?? null, fallbackModel: null }
              store.appendEvent(jobId, 'turn.refused', refusal)
            }
            if (message.message?.model && message.message.model !== servedBy) {
              servedBy = message.message.model
              store.appendEvent(jobId, 'model.served', { model: servedBy })
            }
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
            // Freeze the provider tree while the native result still proves parentage. A command
            // may have created another session and become invisible after the CLI exits.
            freezeDescendants()
            terminalResult = message
            break
          }
        }
      } catch (error) {
        if (!terminalResult) throw error
        store.appendEvent(jobId, 'transport.error_after_result', {})
      }

      clearTurnTimers()
      const usage = resultUsage(terminalResult)
      if (approvalRequired) {
        await settle('awaiting_approval', {
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
        await settle(status, {
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
        await settle('cancelled', { usage })
      } else if (refusal) {
        await settle('failed', {
          error: { kind: 'REFUSAL', message: 'Claude declined the delegated turn.', details: refusal },
          usage,
        })
      } else if (timedOut || stalled) {
        await settle('failed', {
          error: {
            kind: timedOut ? 'TIMEOUT' : 'STALL',
            message: `Claude exceeded the ${timedOut ? 'total time budget' : 'quiet-period limit'}.`,
            details: null,
          },
          usage,
        })
      } else if (terminalResult.subtype !== 'success' || terminalResult.is_error) {
        await settle('failed', { error: resultFailure(terminalResult, { assistantError, rateLimitStatus }), usage })
      } else {
        const output = String(terminalResult.result || '').trim()
        if (!output) throw new DelegationError('EMPTY_OUTPUT', 'Claude completed without a final result.')
        if (job.outputSchema != null && terminalResult.structured_output === undefined) {
          throw new DelegationError('SCHEMA_OUTPUT', 'Claude completed without the requested structured output.')
        }
        const structured = job.outputSchema == null
          ? null
          : validateStructuredValue(job.outputSchema, terminalResult.structured_output, 'Claude')
        await settle('succeeded', { output, structured, usage, error: null })
      }
    },

    // Cancel is the only control this route can queue: the service refuses a steer for a
    // Claude job before it reaches the controls table.
    async onControl(control) {
      try {
        cancelled = true
        if (accepted) {
          await interruptAndForce('cancel')
          store.handleControl(jobId, control.id, { result: 'interrupt_sent' })
        } else {
          active.close()
          store.handleControl(jobId, control.id, { result: 'cancelled_before_turn' })
        }
      } catch (error) {
        store.handleControl(jobId, control.id, { result: 'failed', error: publicError(normalizeClaudeError(error)) })
      }
    },

    async stop() {
      freezeDescendants()
      rememberProvider()
      try { active?.close() } catch {}
      if (!child?.pid || !childTreeRunning()) {
        await Promise.race([childExited, delay(100)])
        return true
      }
      signalChildTree(terminalResult ? 'SIGKILL' : 'SIGTERM')
      if (await waitForChildTree(terminalResult ? 100 : 1_000)) return true
      signalChildTree('SIGKILL')
      if (!await waitForChildTree(2_000)) {
        freezeDescendants()
        rememberProvider()
        return false
      }
      await Promise.race([childExited, delay(1_000)])
      return true
    },

    killProvider() { signalChildTree('SIGKILL') },

    onHeartbeat() {},

    clearTimers() { clearTurnTimers() },

    nativeTerminal() { return Boolean(terminalResult) },

    usage() { return resultUsage(terminalResult) },

    failureOutcome(error, { acceptedWrite }) {
      if (approvalRequired) {
        return {
          status: 'awaiting_approval',
          error: { kind: 'APPROVAL_REQUIRED', message: 'Claude requested an approval that Flow denied.', details: { toolName: approvalRequired } },
        }
      }
      if (cancelled && !acceptedWrite) return { status: 'cancelled', error: null }
      return {
        status: acceptedWrite && !terminalResult ? 'unknown' : 'failed',
        error: publicError(normalizeClaudeError(error)),
      }
    },

    cleanup() {
      if (stderrTail && !terminalResult) serviceLog(stateDir, `Claude stderr for ${jobId}: ${stderrTail}`)
    },
  }
}
