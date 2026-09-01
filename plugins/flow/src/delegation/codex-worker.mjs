import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AppServerClient, assertRestrictedPermissionProfile, assertThreadMcpIsolated, CODEX_PERMISSION_PROFILE, codexHostSupport, codexVersion, isolatedThreadConfig, isApprovalRequest, restrictedPermissionConfig } from './app-server.mjs'
import { providerScopeName } from './containment.mjs'
import { assertRoute, DelegationError, publicError, STALL_SECONDS } from './contracts.mjs'
import { delegatedInstructions } from './instructions.mjs'
import { foldTurnOutcome, validateStructured } from './outcome.mjs'
import { providerOutputSchema } from './schema.mjs'
import { processStartToken } from './store.mjs'
import { gitMetadataPaths } from './workspace.mjs'

const textInput = (text) => [{ type: 'text', text, text_elements: [] }]

/** The Codex App Server half of a delegation worker. runProviderJob owns everything else. */
export function runCodexJob({ job, store, settle }) {
  const jobId = job.id
  let client
  let deadlineTimer
  let forcedTimer
  let stallTimer
  let threadId = null
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
  let previewAt = 0
  let jobTempDir = null

  const rememberProvider = ({ discover = false } = {}) => {
    const pid = client?.child?.pid
    if (!Number.isInteger(pid) || pid <= 0) return
    if (discover) client.captureDescendants()
    store.setProviderProcess(jobId, {
      pid,
      startToken: processStartToken(pid),
      processGroupId: pid,
      scope: client.scopeName,
      processes: client.trackedProcesses(),
    })
  }

  // Every notification for this job is proof the App Server is still alive, so each one
  // restarts the quiet-period clock. The timer only exists once the turn is accepted.
  const resetStall = () => {
    if (!onStallFire || interruptReason) return
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(onStallFire, STALL_SECONDS * 1_000)
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

  return {
    provider: 'Codex',
    providerLabel: 'Codex App Server',

    async start() {
      assertRoute({ host: job.host, target: job.target, depth: job.depth })
      const host = codexHostSupport()
      if (!host.ok) throw new DelegationError(host.kind, 'Codex delegation requires a Linux host.')
      const codex = codexVersion()
      if (!codex.ok) throw new DelegationError(codex.kind, 'Codex no longer meets the delegation version requirement.')
      const tempRoot = join(store.stateDir, 'tmp')
      mkdirSync(tempRoot, { recursive: true, mode: 0o700 })
      jobTempDir = mkdtempSync(join(tempRoot, `${job.id}-`))
      chmodSync(jobTempDir, 0o700)
      const metadataPaths = await gitMetadataPaths(job.cwd)

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
        // Named after the job, so a scope outliving its worker can still be found by hand.
        scopeName: providerScopeName(job.id),
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
        // Flow never asks for another tier. It is still sent explicitly, because a turn that
        // states its tier cannot be re-pointed by an account default changing underneath it.
        serviceTier: 'default',
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
      threadId = threadResponse.thread?.id
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
        serviceTier: 'default',
        effort: job.effort,
        summary: 'detailed',
        outputSchema: providerOutputSchema(job.outputSchema),
      }, 30_000)
      turnId = turnResponse.turn?.id || turnId
      if (!turnId) throw new DelegationError('APP_SERVER_PROTOCOL', 'Codex did not return a turn ID.')
      store.setRunning(jobId, { threadId, turnId, accepted: true })
      store.appendEvent(jobId, 'turn.accepted', { turnId })
    },

    async run() {
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
        return
      }
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
    },

    async onControl(control) {
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
    },

    async stop() {
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
    },

    killProvider() { client?.signalTree('SIGKILL') },

    onHeartbeat() { rememberProvider({ discover: true }) },

    clearTimers() {
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null }
      if (forcedTimer) { clearTimeout(forcedTimer); forcedTimer = null }
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
    },

    nativeTerminal() { return nativeTurnTerminal },

    usage() { return usage },

    failureOutcome(error, { acceptedWrite }) {
      if (approvalMethod) {
        return {
          status: 'awaiting_approval',
          error: { kind: 'APPROVAL_REQUIRED', message: 'Codex requested an approval that Flow denied.', details: { method: approvalMethod } },
        }
      }
      return {
        status: acceptedWrite && !nativeTurnTerminal ? 'unknown' : 'failed',
        error: publicError(error),
      }
    },

    cleanup({ quarantined }) {
      // A quarantined job's provider is still alive and still holds this directory open.
      if (!jobTempDir || quarantined) return
      try { rmSync(jobTempDir, { recursive: true, force: true }) } catch {}
    },
  }
}
