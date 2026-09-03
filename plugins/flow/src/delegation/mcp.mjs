import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import { DelegationService } from './service.mjs'
import { ACCESS_MODES, capabilitiesForTarget, DelegationError, DELIVERIES, EFFORTS, MODES, MODEL_PATTERN, publicError, resultEnvelope, targetForHost } from './contracts.mjs'
import { doctorResultShape, eventsResultShape, jobResultShape } from './envelope-schema.mjs'
import { serviceLog } from './store.mjs'
import { VERSION } from './version.mjs'
import { canonicalRoots, canonicalWorkspace } from './workspace.mjs'

const jobId = z.string().uuid().describe('Durable Flow delegation job ID')
const model = z.string().regex(MODEL_PATTERN).describe('Provider model id or alias. Claude takes an alias (sonnet, opus, fable) or a full id (claude-fable-5-1); Codex takes its own ids (gpt-5.6-sol). Never the charter table\'s short names.')
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
    capabilities: { logging: {}, resources: {} },
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

  // The approval fork is asked only when this client can render a form, and only on an
  // attached call, because a detached job has nobody waiting to answer. The flag rides the
  // job so the worker knows whether to park a request or deny it outright.
  const clientElicits = () => Boolean(server.server.getClientCapabilities()?.elicitation?.form)
  const elicitationFor = (delivery) => clientElicits() && delivery === 'attached'
  const approvalMessage = (jobId, summary) => {
    const head = `Delegated ${targetTitle} job ${String(jobId).slice(0, 8)} asks for an approval Flow does not grant on its own.`
    if (summary?.kind === 'command') return `${head} It wants to run a command${summary.cwd ? ` in ${summary.cwd}` : ''}:\n${summary.command ?? '(command not reported)'}`
    if (summary?.kind === 'file-change') return `${head} It wants to change ${summary.paths.length === 1 ? 'a file' : `${summary.paths.length} files`}:\n${summary.paths.join('\n')}`
    if (summary?.kind === 'tool') {
      const lines = [summary.title ?? `It wants to use ${summary.toolName}.`]
      if (summary.description) lines.push(summary.description)
      if (summary.blockedPath) lines.push(`Blocked path: ${summary.blockedPath}`)
      if (summary.decisionReason) lines.push(`Reason: ${summary.decisionReason}`)
      lines.push(summary.input ? `Input:\n${summary.input}` : 'The input is too long to show and is not part of what you approve.')
      return `${head} ${lines.join('\n')}`
    }
    return `${head} Request: ${summary?.method ?? 'unknown'}`
  }
  // One form per request, one decision, and anything that is not an explicit accept is a
  // decline: a dismissed form, a cancelled one, a client error, or the window closing.
  const answerApproval = async (jobId, event, signal) => {
    const { approvalId, summary, seconds } = event.payload || {}
    let decision = 'decline'
    let decidedBy = 'human'
    try {
      const answer = await server.server.elicitInput({
        mode: 'form',
        message: approvalMessage(jobId, summary),
        requestedSchema: {
          type: 'object',
          properties: {
            decision: {
              type: 'string',
              title: 'Decision',
              description: 'accept lets the delegated seat do this one thing; decline refuses it and the job ends as awaiting_approval',
              enum: ['accept', 'decline'],
            },
          },
          required: ['decision'],
        },
      }, { timeout: Math.max(5, (Number(seconds) || 240) - 10) * 1_000, signal })
      if (answer?.action === 'accept' && answer?.content?.decision === 'accept') decision = 'accept'
      else decidedBy = answer?.action === 'accept' ? 'human' : `human:${answer?.action || 'none'}`
    } catch (error) {
      decidedBy = signal?.aborted ? 'caller-cancelled' : 'elicitation-error'
      if (!signal?.aborted) serviceLog(stateDir, `elicitation for job ${jobId} failed: ${error?.message || error}`)
    }
    try { service.decideApproval(jobId, approvalId, decision, decidedBy) } catch (error) {
      serviceLog(stateDir, `approval decision for job ${jobId} could not be recorded: ${error?.message || error}`)
    }
  }
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
  const attachedOptions = (extra, jobId) => ({
    signal: extra.signal,
    onEvent: async (event) => {
      // Not awaited: the form can stay open for minutes, and the wait loop must keep reading
      // the job, the caller's abort signal, and the terminal state while it does. The form
      // races the same signal, so a cancelled call closes it as a decline.
      if (event.type === 'approval.requested') void answerApproval(jobId, event, extra.signal)
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
    outputSchema: jobResultShape,
    annotations: { openWorldHint: false },
  }, asTool(async (input, extra) => {
    const job = await service.start({ ...input, elicitation: elicitationFor(input.delivery) }, await rootOptions())
    if (input.delivery === 'detached') return toolResult({ ok: true, job: resultEnvelope(job) })
    const finished = await service.wait(job.id, attachedOptions(extra, job.id))
    const envelope = resultEnvelope(finished)
    return toolResult({ ok: finished.status === 'succeeded', job: envelope }, finished.status !== 'succeeded')
  }))

  server.registerTool('delegation_status', {
    description: 'Read and reconcile one delegation job.',
    inputSchema: { jobId: jobId },
    outputSchema: jobResultShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, asTool(async ({ jobId }) => {
    await requireVisibleJob(jobId)
    const job = await service.reconcile(jobId)
    return toolResult({ ok: true, job: resultEnvelope(job) })
  }))

  server.registerTool('delegation_result', {
    description: 'Read the typed result envelope for one delegation job.',
    inputSchema: { jobId: jobId },
    outputSchema: jobResultShape,
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
    outputSchema: eventsResultShape,
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
    outputSchema: jobResultShape,
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
      outputSchema: jobResultShape,
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
    outputSchema: jobResultShape,
    annotations: { openWorldHint: false },
  }, asTool(async (input, extra) => {
    await requireVisibleJob(input.jobId)
    const job = await service.continue(input.jobId, { ...input, elicitation: elicitationFor(input.delivery) }, await rootOptions())
    if (input.delivery === 'detached') return toolResult({ ok: true, job: resultEnvelope(job) })
    const finished = await service.wait(job.id, attachedOptions(extra, job.id))
    return toolResult({ ok: finished.status === 'succeeded', job: resultEnvelope(finished) }, finished.status !== 'succeeded')
  }))

  server.registerTool('delegation_doctor', {
    description: `Check the local delegation database, ${targetTitle} runtime, and account.`,
    inputSchema: { cwd: z.string().optional() },
    outputSchema: doctorResultShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, asTool(async ({ cwd }) => {
    const context = await doctorContext(cwd)
    const result = await service.doctor(context.cwd, { workspace: context.workspace, client: context.mcp.client })
    return toolResult({ ...result, mcp: context.mcp })
  }))

  // The job record as resources: state is read, mutations are called. Every read runs the
  // same route and visibility checks the tools do, and an unexpected failure is logged and
  // reported as INTERNAL, because a resource error message crosses the same redaction
  // boundary a tool result does.
  const readJson = (uri, value) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] })
  const asResource = (fn) => async (...args) => {
    try { return await fn(...args) } catch (error) {
      if (error instanceof DelegationError) throw error
      serviceLog(stateDir, `mcp resource failed: ${error?.stack || error?.message || error}`)
      throw new DelegationError('INTERNAL', 'The resource could not be read.')
    }
  }
  server.registerResource('jobs', 'flow://jobs', {
    title: 'Delegation jobs',
    description: `This route's ${targetTitle} delegation jobs, newest first, as result envelopes.`,
    mimeType: 'application/json',
  }, asResource(async (uri) => readJson(uri.href, { jobs: (await service.listVisible(await rootOptions())).map(resultEnvelope) })))
  const jobResource = (suffix, name, title, description, read) => {
    server.registerResource(name, new ResourceTemplate(`flow://jobs/{jobId}${suffix}`, {
      list: async () => ({
        resources: (await service.listVisible(await rootOptions())).map((job) => ({ uri: `flow://jobs/${job.id}${suffix}`, name: `${name} ${job.id}`, mimeType: 'application/json' })),
      }),
    }), { title, description, mimeType: 'application/json' }, asResource(async (uri, variables) => {
      const id = String(variables.jobId)
      await requireVisibleJob(id)
      return readJson(uri.href, read(id))
    }))
  }
  jobResource('', 'job', 'Delegation job', 'The result envelope for one job.', (id) => service.result(id))
  jobResource('/events', 'job-events', 'Delegation job events', 'The ordered event journal for one job, first 1000 events.', (id) => ({ events: service.events(id, { after: 0, limit: 1000 }) }))
  jobResource('/capabilities', 'job-capabilities', 'Delegation job capabilities', 'The target controls this job ran under, and whether it could ask the human.', (id) => {
    const job = service.get(id)
    return { target: job.target, capabilities: capabilitiesForTarget(job.target), elicitation: Boolean(job.elicitation) }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
