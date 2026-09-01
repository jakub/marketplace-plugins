import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import { DelegationService } from './service.mjs'
import { ACCESS_MODES, capabilitiesForTarget, DelegationError, DELIVERIES, EFFORTS, MODES, MODEL_PATTERN, publicError, resultEnvelope, targetForHost } from './contracts.mjs'
import { serviceLog } from './store.mjs'
import { VERSION } from './version.mjs'
import { canonicalRoots, canonicalWorkspace } from './workspace.mjs'

const jobId = z.string().uuid().describe('Durable Flow delegation job ID')
const model = z.string().regex(MODEL_PATTERN).describe('Provider model id or alias as listed by delegation_models. Claude takes an alias (sonnet, opus, fable) or a full id (claude-fable-5-1); Codex takes its own ids (gpt-5.6-sol). Never the charter table\'s short names.')
const access = z.enum([...ACCESS_MODES])
const delivery = z.enum([...DELIVERIES])

function toolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  }
}

export async function startMcp({ host, depth, stateDir, entryPath, projectDir }) {
  const target = targetForHost(host)
  const targetTitle = target[0].toUpperCase() + target.slice(1)
  const effort = z.enum([...EFFORTS]).describe('Reasoning effort, low through max. The provider rejects a level its catalog does not list.')
  const capabilities = capabilitiesForTarget(target)
  const providerLimits = target === 'claude' ? {
    maxTurns: z.number().int().min(1).max(1000).optional().describe('Hard Claude conversation-turn limit for this job'),
    maxBudgetUsd: z.number().min(0.01).max(1000).optional().describe('Hard Claude SDK cost limit in US dollars for this job'),
  } : {}
  const service = new DelegationService({ host, depth, stateDir, entryPath, projectDir })
  const server = new McpServer({ name: 'flow-delegation', version: VERSION }, {
    capabilities: { logging: {} },
  })

  // publicError() is all the caller gets. An unexpected failure with no job to journal it
  // against would otherwise leave no record anywhere.
  const asTool = (fn) => async (...args) => {
    try { return await fn(...args) } catch (error) {
      if (!(error instanceof DelegationError)) serviceLog(stateDir, `mcp tool failed: ${error?.stack || error?.message || error}`)
      return toolResult({ ok: false, error: publicError(error) }, true)
    }
  }

  const clientRoots = async () => {
    const clientCapabilities = server.server.getClientCapabilities()
    if (!clientCapabilities?.roots) return []
    try { return (await server.server.listRoots()).roots.map((root) => root.uri) } catch { return [] }
  }
  const rootOptions = async () => ({ rootUris: await clientRoots() })
  const requireVisibleJob = async (jobId) => service.requireVisible(jobId, await rootOptions())
  const doctorContext = async (requestedCwd) => {
    const clientCapabilities = server.server.getClientCapabilities() || {}
    // What the initialize handshake reported, untouched. The SDK keeps the clientInfo object from
    // that one request, so this is the conducting host's own account of its name and version.
    const client = server.server.getClientVersion() || null
    const supportsRoots = Boolean(clientCapabilities.roots)
    let rootUris = []
    let rootsError = null
    if (supportsRoots) {
      try { rootUris = (await server.server.listRoots()).roots.map((root) => root.uri) } catch (error) {
        rootsError = publicError(error, 'The MCP client did not return workspace roots.')
      }
    }
    const roots = canonicalRoots({ rootUris, projectDir })
    const candidate = requestedCwd || projectDir || roots[0] || null
    let cwd = null
    let workspaceError = rootsError
    if (!workspaceError && candidate) {
      try { cwd = await canonicalWorkspace(candidate, roots) } catch (error) { workspaceError = publicError(error) }
    } else if (!workspaceError) {
      workspaceError = publicError(new DelegationError('NO_ROOTS', 'The client did not provide a usable workspace root.'))
    }
    return {
      cwd,
      workspace: {
        ok: Boolean(cwd),
        requestedCwd: requestedCwd || null,
        selectedCwd: cwd,
        projectDir: projectDir || null,
        clientRootCapability: supportsRoots,
        advertisedRootUris: rootUris,
        usableRoots: roots,
        error: workspaceError,
      },
      mcp: {
        client,
        capabilities: clientCapabilities,
        negotiatedProtocolVersion: null,
        protocolVersionNote: 'The MCP SDK does not expose the negotiated protocol version after initialization.',
      },
    }
  }

  // Attached delivery streams the durable event journal back as progress notifications.
  const attachedOptions = (extra) => ({
    signal: extra.signal,
    onEvent: async (event) => {
      if (extra._meta?.progressToken === undefined) return
      await extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: extra._meta.progressToken,
          progress: event.seq,
          message: `${event.type}: ${JSON.stringify(event.payload).slice(0, 300)}`,
        },
      })
    },
  })

  server.registerTool(`delegate_to_${target}`, {
    title: `Delegate to ${targetTitle}`,
    description: `Start a durable ${targetTitle} task or review. Use attached delivery for a normal streamed call and detached delivery for a job you will poll.`,
    inputSchema: {
      mode: z.enum([...MODES]).default('task'),
      prompt: z.string().describe('Task prompt, or optional focus for a review'),
      cwd: z.string().describe('Absolute working directory inside a client workspace root'),
      access: access.default('read-only'),
      model,
      effort,
      delivery: delivery.default('attached'),
      timeBudgetSeconds: z.number().int().min(30).max(7200).default(900),
      ...providerLimits,
      outputSchema: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
      base: z.string().optional().describe('Required Git revision for review modes'),
      head: z.string().default('HEAD').describe('Git revision for review modes'),
    },
    annotations: { openWorldHint: false },
  }, asTool(async (input, extra) => {
    const job = await service.start(input, await rootOptions())
    if (input.delivery === 'detached') return toolResult({ ok: true, job: resultEnvelope(job) })
    const finished = await service.wait(job.id, attachedOptions(extra))
    const envelope = resultEnvelope(finished)
    return toolResult({ ok: finished.status === 'succeeded', job: envelope }, finished.status !== 'succeeded')
  }))

  server.registerTool('delegation_status', {
    description: 'Read and reconcile one delegation job.',
    inputSchema: { jobId: jobId },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, asTool(async ({ jobId }) => {
    await requireVisibleJob(jobId)
    const job = await service.reconcile(jobId)
    return toolResult({ ok: true, job: resultEnvelope(job) })
  }))

  server.registerTool('delegation_result', {
    description: 'Read the typed result envelope for one delegation job.',
    inputSchema: { jobId: jobId },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, asTool(async ({ jobId }) => {
    await requireVisibleJob(jobId)
    return toolResult({ ok: true, job: service.result(jobId) })
  }))

  server.registerTool('delegation_events', {
    description: 'Read an ordered page of durable progress events.',
    inputSchema: {
      jobId: jobId,
      after: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(200),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, asTool(async ({ jobId, after, limit }) => {
    await requireVisibleJob(jobId)
    return toolResult({
      ok: true,
      events: service.events(jobId, { after, limit }),
    })
  }))

  server.registerTool('delegation_cancel', {
    description: `Interrupt a running ${targetTitle} turn. Cancellation is cooperative and durable.`,
    inputSchema: { jobId: jobId },
    annotations: { destructiveHint: true, openWorldHint: false },
  }, asTool(async ({ jobId }) => {
    await requireVisibleJob(jobId)
    return toolResult({ ok: true, job: resultEnvelope(service.cancel(jobId)) })
  }))

  // Registered only where it works. A tool whose whole behaviour is a typed refusal is worse
  // than no tool: the caller has to try it to learn what the capability report already says.
  if (capabilities.liveSteer) {
    server.registerTool('delegation_steer', {
      description: `Add instructions to the active ${targetTitle} turn without starting a new job.`,
      inputSchema: { jobId: jobId, text: z.string().min(1) },
      annotations: { openWorldHint: false },
    }, asTool(async ({ jobId, text }) => {
      await requireVisibleJob(jobId)
      return toolResult({ ok: true, job: resultEnvelope(service.steer(jobId, text)) })
    }))
  }

  server.registerTool('delegation_continue', {
    description: `Start a new job that continues an existing ${targetTitle} session.`,
    inputSchema: {
      jobId: jobId,
      prompt: z.string().min(1),
      access: access.optional(),
      model: model.optional(),
      effort: effort.optional(),
      delivery: delivery.default('attached'),
      timeBudgetSeconds: z.number().int().min(30).max(7200).optional(),
      ...providerLimits,
      outputSchema: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
    },
    annotations: { openWorldHint: false },
  }, asTool(async (input, extra) => {
    await requireVisibleJob(input.jobId)
    const job = await service.continue(input.jobId, input, await rootOptions())
    if (input.delivery === 'detached') return toolResult({ ok: true, job: resultEnvelope(job) })
    const finished = await service.wait(job.id, attachedOptions(extra))
    return toolResult({ ok: finished.status === 'succeeded', job: resultEnvelope(finished) }, finished.status !== 'succeeded')
  }))

  server.registerTool('delegation_doctor', {
    description: `Check the local delegation database, ${targetTitle} runtime, and account.`,
    inputSchema: { cwd: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, asTool(async ({ cwd }) => {
    const context = await doctorContext(cwd)
    const result = await service.doctor(context.cwd, { workspace: context.workspace, client: context.mcp.client })
    return toolResult({ ...result, mcp: context.mcp })
  }))

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
