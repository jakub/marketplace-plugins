import Ajv2020 from 'ajv/dist/2020.js'
import { AppServerClient, sandboxFor } from './app-server.mjs'
import { assertRoute, DelegationError, publicError } from './contracts.mjs'
import { JobStore } from './store.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const textInput = (text) => [{ type: 'text', text, text_elements: [] }]

function finalMessage(turn, fallback) {
  const messages = (turn?.items || []).filter((item) => item.type === 'agentMessage' && item.text)
  return messages.at(-1)?.text || fallback || ''
}

function validateStructured(schema, text) {
  let value
  try { value = JSON.parse(text) } catch {
    throw new DelegationError('SCHEMA_OUTPUT', 'Codex returned text that is not valid JSON.')
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  let validate
  try { validate = ajv.compile(schema) } catch {
    throw new DelegationError('BAD_SCHEMA', 'The output schema is not a valid JSON Schema.')
  }
  if (!validate(value)) {
    throw new DelegationError('SCHEMA_OUTPUT', 'Codex returned JSON that does not match the requested schema.', {
      errors: validate.errors?.slice(0, 20) || [],
    })
  }
  return value
}

export async function runWorker({ jobId, stateDir }) {
  const store = new JobStore(stateDir)
  let job
  let client
  let heartbeat
  let controlTimer
  let deadlineTimer
  let forcedTimer
  let turnId = null
  let latestMessage = ''
  let usage = null
  let approvalMethod = null
  let timedOut = false
  let cancelled = false
  let terminalResolve
  const terminal = new Promise((resolve) => { terminalResolve = resolve })
  const inFlightControls = new Set()
  let previewAt = 0

  try {
    job = store.claim(jobId, process.pid)
    assertRoute({ host: job.host, target: job.target, depth: job.depth })
    heartbeat = setInterval(() => store.heartbeat(jobId), 1_000)

    const onNotification = (method, params) => {
      if (method === 'turn/started') {
        turnId = params.turn?.id || turnId
        if (turnId) store.setNativeTurn(jobId, turnId)
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
      approvalMethod = method
      store.appendEvent(jobId, 'approval.denied', { method })
    }

    client = await new AppServerClient({
      cwd: job.cwd,
      env: {
        FLOW_DELEGATION_DEPTH: String(job.depth + 1),
        FLOW_DELEGATION_PARENT_JOB_ID: job.id,
      },
      onNotification,
      onServerRequest,
    }).start()
    store.appendEvent(jobId, 'app_server.ready', {})

    const threadParams = {
      model: job.model,
      serviceTier: job.serviceTier,
      cwd: job.cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: job.access,
      developerInstructions: 'You are a delegated Codex worker. Complete the caller task directly. Do not delegate to another model family or start subagents.',
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
      if (inFlightControls.has(control.id)) return
      inFlightControls.add(control.id)
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
      } finally {
        inFlightControls.delete(control.id)
      }
    }
    controlTimer = setInterval(() => {
      for (const control of store.pendingControls(jobId)) void runControl(control)
    }, 250)

    deadlineTimer = setTimeout(async () => {
      timedOut = true
      store.appendEvent(jobId, 'turn.timeout', { seconds: job.timeBudgetSeconds })
      try { await client.request('turn/interrupt', { threadId, turnId }, 10_000) } catch {}
      forcedTimer = setTimeout(() => terminalResolve(null), 5_000)
    }, job.timeBudgetSeconds * 1_000)

    const turn = await terminal
    if (approvalMethod) {
      store.finish(jobId, 'awaiting_approval', {
        error: { kind: 'APPROVAL_REQUIRED', message: 'Codex requested an approval that Flow denied.', details: { method: approvalMethod } },
        usage,
      })
    } else if (!turn) {
      const status = job.access === 'workspace-write' ? 'unknown' : 'failed'
      store.finish(jobId, status, {
        error: { kind: 'TIMEOUT', message: 'The turn did not confirm a terminal state after interruption.', details: null },
        usage,
      })
    } else if (turn.status === 'interrupted') {
      store.finish(jobId, cancelled ? 'cancelled' : 'failed', {
        error: cancelled ? null : { kind: timedOut ? 'TIMEOUT' : 'INTERRUPTED', message: 'Codex interrupted the turn.', details: null },
        usage,
      })
    } else if (turn.status === 'failed') {
      store.finish(jobId, 'failed', {
        error: { kind: 'CODEX_TURN', message: turn.error?.message || 'Codex reported a failed turn.', details: null },
        usage,
      })
    } else if (turn.status !== 'completed') {
      store.finish(jobId, 'unknown', {
        error: { kind: 'UNKNOWN_TURN', message: `Codex ended with turn status ${turn.status || 'missing'}.`, details: null },
        usage,
      })
    } else {
      const output = finalMessage(turn, latestMessage).trim()
      if (!output) throw new DelegationError('EMPTY_OUTPUT', 'Codex completed without a final agent message.')
      const structured = job.outputSchema != null ? validateStructured(job.outputSchema, output) : null
      store.finish(jobId, 'succeeded', { output, structured, usage, error: null })
    }
  } catch (error) {
    try {
      const current = store.getJob(jobId)
      if (current && !['succeeded', 'failed', 'cancelled', 'unknown', 'awaiting_approval'].includes(current.status)) {
        const acceptedWrite = current.access === 'workspace-write' && current.turnAcceptedAt
        store.finish(jobId, acceptedWrite ? 'unknown' : 'failed', { error: publicError(error), usage })
      }
    } catch {}
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    if (controlTimer) clearInterval(controlTimer)
    if (deadlineTimer) clearTimeout(deadlineTimer)
    if (forcedTimer) clearTimeout(forcedTimer)
    if (client) await client.stop()
    store.close()
  }
}
