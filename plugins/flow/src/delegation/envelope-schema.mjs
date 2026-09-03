// The result envelope as a schema, declared on every tool so the SDK validates it before it
// is sent and the client validates it on arrival. resultEnvelope() in contracts.mjs builds
// the object; this file is its shape, and the two are one field list or the smoke fails.
// contracts.mjs stays free of zod because the workers import it and never need a schema.
import * as z from 'zod/v4'
import { ACCESS_MODES, ACTIVE_STATES, EFFORTS, ERROR_KINDS, HOSTS, MODES, TARGETS, TERMINAL_STATES } from './contracts.mjs'

export const JOB_STATES = [...ACTIVE_STATES, 'quarantined', ...TERMINAL_STATES]

export const publicErrorShape = z.object({
  kind: z.enum(ERROR_KINDS),
  message: z.string(),
  details: z.unknown().nullable(),
})

export const quarantineShape = z.object({
  resumeStatus: z.string().nullable(),
  providerPid: z.number().int().nullable(),
  providerProcessGroupId: z.number().int().nullable(),
  providerScope: z.string().nullable(),
  trackedProcesses: z.number().int().min(0),
})

export const envelopeShape = z.object({
  jobId: z.string().uuid(),
  status: z.enum(JOB_STATES),
  host: z.enum(HOSTS),
  target: z.enum(TARGETS),
  mode: z.enum(MODES),
  access: z.enum(ACCESS_MODES),
  model: z.string(),
  effort: z.enum(EFFORTS),
  elicitation: z.boolean().describe('Whether an approval request in this job is put to the human through the MCP session, or denied outright'),
  limits: z.object({
    timeBudgetSeconds: z.number().int(),
    maxTurns: z.number().int().nullable(),
    maxBudgetUsd: z.number().nullable(),
  }),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  output: z.string().nullable(),
  structured: z.unknown().nullable(),
  findings: z.array(z.unknown()).nullable(),
  usage: z.unknown().nullable(),
  commandFailures: z.number().int().min(0).describe('Recorded command completions that failed or exited nonzero. Always 0 on the Claude route, which records none'),
  error: publicErrorShape.nullable(),
  quarantine: quarantineShape.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})

export const eventShape = z.object({
  seq: z.number().int().min(1),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number().int(),
})

// Raw shapes for registerTool: the SDK wraps a shape in an object schema of its own.
export const jobResultShape = { ok: z.literal(true), job: envelopeShape }
export const eventsResultShape = { ok: z.literal(true), events: z.array(eventShape) }
// Doctor answers with a check tree whose keys vary by host, so its declared shape is loose.
export const doctorResultShape = z.looseObject({ ok: z.boolean() })

/** JSON Schema for the envelope, for a caller that composes a schema of its own around it. */
export function envelopeJsonSchema() {
  return z.toJSONSchema(envelopeShape, { io: 'output' })
}
