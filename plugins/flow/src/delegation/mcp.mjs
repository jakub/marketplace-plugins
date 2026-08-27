import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import { DelegationService } from './service.mjs'
import { ACCESS_MODES, DelegationError, DELIVERIES, EFFORTS, MODES, MODEL_PATTERN, publicError, resultEnvelope } from './contracts.mjs'
import { serviceLog } from './store.mjs'
import { VERSION } from './version.mjs'
import { canonicalRoots, canonicalWorkspace } from './workspace.mjs'

const jobId = z.string().uuid().describe('Durable Flow delegation job ID')
const model = z.string().regex(MODEL_PATTERN)
const effort = z.enum([...EFFORTS])
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
    const capabilities = server.server.getClientCapabilities()
    if (!capabilities?.roots) return []
    try { return (await server.server.listRoots()).roots.map((root) => root.uri) } catch { return [] }
  }
  const rootOptions = async () => ({ rootUris: await clientRoots() })

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

  server.registerTool('delegate_to_codex', {
    title: 'Delegate to Codex',
    description: 'Start a durable Codex task or review. Use attached delivery for a normal streamed call and detached delivery for a job you will poll.',
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

  server.registerTool('delegation_cancel', {
    description: 'Interrupt a running Codex turn. Cancellation is cooperative and durable.',
    inputSchema: { jobId: jobId },
    annotations: { destructiveHint: true, openWorldHint: false },
  }, asTool(async ({ jobId }) => toolResult({ ok: true, job: resultEnvelope(service.cancel(jobId)) })))

  server.registerTool('delegation_steer', {
    description: 'Add instructions to the active Codex turn without starting a new job.',
    inputSchema: { jobId: jobId, text: z.string().min(1) },
    annotations: { openWorldHint: false },
  }, asTool(async ({ jobId, text }) => toolResult({ ok: true, job: resultEnvelope(service.steer(jobId, text)) })))

  server.registerTool('delegation_continue', {
    description: 'Start a new job that continues an existing Codex thread.',
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
    description: 'Read the live Codex model catalog.',
    inputSchema: { cwd: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, asTool(async ({ cwd }) => {
    const roots = canonicalRoots({ rootUris: await clientRoots(), projectDir })
    const checked = await canonicalWorkspace(cwd || projectDir || roots[0], roots)
    const models = await service.models(checked)
    return toolResult({ ok: true, models })
  }))

  server.registerTool('delegation_doctor', {
    description: 'Check the local delegation database, Codex CLI, App Server, and account.',
    inputSchema: { cwd: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, asTool(async ({ cwd }) => {
    const roots = canonicalRoots({ rootUris: await clientRoots(), projectDir })
    const checked = await canonicalWorkspace(cwd || projectDir || roots[0], roots)
    return toolResult(await service.doctor(checked))
  }))

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
