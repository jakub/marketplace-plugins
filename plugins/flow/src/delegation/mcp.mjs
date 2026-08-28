import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import { DelegationService } from './service.mjs'
import { ACCESS_MODES, capabilitiesForTarget, DelegationError, DELIVERIES, effortsForTarget, JOB_STATES, jobSummary, MODES, MODEL_PATTERN, publicError, resultEnvelope, targetForHost } from './contracts.mjs'
import { serviceLog } from './store.mjs'
import { VERSION } from './version.mjs'
import { canonicalRoots, canonicalWorkspace } from './workspace.mjs'

const jobId = z.string().uuid().describe('Durable Flow delegation job ID')
const model = z.string().regex(MODEL_PATTERN)
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
  const effort = z.enum([...effortsForTarget(target)])
  const capabilities = capabilitiesForTarget(target)
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
  const doctorContext = async (requestedCwd) => {
    const clientCapabilities = server.server.getClientCapabilities() || {}
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
      serviceTier: z.literal('default').default('default'),
      profile: z.enum(['standard', 'defensive-security']).default('standard'),
      delivery: delivery.default('attached'),
      timeBudgetSeconds: z.number().int().min(30).max(7200).default(900),
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
    const job = await service.reconcile(jobId)
    return toolResult({ ok: true, job: resultEnvelope(job) })
  }))

  server.registerTool('delegation_result', {
    description: 'Read the typed result envelope for one delegation job.',
    inputSchema: { jobId: jobId },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, asTool(async ({ jobId }) => toolResult({ ok: true, job: service.result(jobId) })))

  server.registerTool('delegation_events', {
    description: 'Read an ordered page of durable progress events.',
    inputSchema: {
      jobId: jobId,
      after: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(200),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, asTool(async ({ jobId, after, limit }) => toolResult({
    ok: true,
    events: service.events(jobId, { after, limit }),
  })))

  server.registerTool('delegation_list', {
    description: 'List recent delegation jobs owned by this host route and visible from the current workspace roots. Prompts and outputs are omitted.',
    inputSchema: {
      status: z.enum([...JOB_STATES]).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, asTool(async (input) => {
    const page = await service.list({
      status: input.status || null,
      limit: input.limit,
      cursor: input.cursor || null,
    }, await rootOptions())
    return toolResult({
      ok: true,
      jobs: page.jobs.map(jobSummary),
      nextCursor: page.nextCursor,
    })
  }))

  server.registerTool('delegation_cancel', {
    description: `Interrupt a running ${targetTitle} turn. Cancellation is cooperative and durable.`,
    inputSchema: { jobId: jobId },
    annotations: { destructiveHint: true, openWorldHint: false },
  }, asTool(async ({ jobId }) => toolResult({ ok: true, job: resultEnvelope(service.cancel(jobId)) })))

  server.registerTool('delegation_steer', {
    description: capabilities.liveSteer
      ? `Add instructions to the active ${targetTitle} turn without starting a new job.`
      : `${targetTitle} does not support live turn steering. This tool returns CONTROL_UNSUPPORTED for ${targetTitle} jobs.`,
    inputSchema: { jobId: jobId, text: z.string().min(1) },
    annotations: { openWorldHint: false },
  }, asTool(async ({ jobId, text }) => toolResult({ ok: true, job: resultEnvelope(service.steer(jobId, text)) })))

  server.registerTool('delegation_continue', {
    description: `Start a new job that continues an existing ${targetTitle} session.`,
    inputSchema: {
      jobId: jobId,
      prompt: z.string().min(1),
      access: access.optional(),
      model: model.optional(),
      effort: effort.optional(),
      profile: z.enum(['standard', 'defensive-security']).optional(),
      delivery: delivery.default('attached'),
      timeBudgetSeconds: z.number().int().min(30).max(7200).optional(),
      outputSchema: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
    },
    annotations: { openWorldHint: false },
  }, asTool(async (input, extra) => {
    const job = await service.continue(input.jobId, input, await rootOptions())
    if (input.delivery === 'detached') return toolResult({ ok: true, job: resultEnvelope(job) })
    const finished = await service.wait(job.id, attachedOptions(extra))
    return toolResult({ ok: finished.status === 'succeeded', job: resultEnvelope(finished) }, finished.status !== 'succeeded')
  }))

  server.registerTool('delegation_models', {
    description: `Read the live ${targetTitle} model catalog and Flow control capabilities.`,
    inputSchema: { cwd: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, asTool(async ({ cwd }) => {
    const roots = canonicalRoots({ rootUris: await clientRoots(), projectDir })
    const checked = await canonicalWorkspace(cwd || projectDir || roots[0], roots)
    const models = await service.models(checked)
    return toolResult({ ok: true, target, capabilities, models })
  }))

  server.registerTool('delegation_doctor', {
    description: `Check the local delegation database, ${targetTitle} runtime, and account.`,
    inputSchema: { cwd: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, asTool(async ({ cwd }) => {
    const context = await doctorContext(cwd)
    const result = await service.doctor(context.cwd, { workspace: context.workspace })
    return toolResult({ ...result, mcp: context.mcp })
  }))

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
