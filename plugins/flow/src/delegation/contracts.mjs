export const HOSTS = ['claude', 'codex']
export const TARGETS = ['claude', 'codex']
export const MODES = ['task', 'review', 'adversarial-review']
export const ACCESS_MODES = ['read-only', 'workspace-write']
export const DELIVERIES = ['attached', 'detached']
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const SERVICE_TIERS = ['default']
export const ACTIVE_STATES = ['queued', 'starting', 'running', 'reconciling']
export const TERMINAL_STATES = ['succeeded', 'failed', 'cancelled', 'unknown', 'awaiting_approval']
export const JOB_STATES = [...ACTIVE_STATES, ...TERMINAL_STATES]
export const MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]*$/

export const FINDINGS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'confidence', 'title', 'file', 'line', 'detail', 'systemic'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          confidence: { type: 'integer', minimum: 0, maximum: 100 },
          title: { type: 'string', minLength: 1 },
          file: { type: 'string' },
          line: { type: 'integer', minimum: 0 },
          detail: { type: 'string', minLength: 1 },
          systemic: { type: 'boolean' },
        },
      },
    },
  },
}

export class DelegationError extends Error {
  constructor(kind, message, details = null) {
    super(message)
    this.name = 'DelegationError'
    this.kind = kind
    this.details = details
  }
}

export function publicError(error, fallback = 'Delegation failed') {
  if (error instanceof DelegationError) {
    return { kind: error.kind, message: error.message, details: error.details }
  }
  return { kind: 'INTERNAL', message: fallback, details: null }
}

export function assertRoute({ host, target, depth }) {
  if (!HOSTS.includes(host) || !TARGETS.includes(target)) {
    throw new DelegationError('ROUTE_DENIED', 'The delegation route names an unknown model family.')
  }
  if (!Number.isInteger(depth) || depth < 0) {
    throw new DelegationError('ROUTE_DENIED', 'The delegation depth is invalid.')
  }
  if (depth > 0) {
    throw new DelegationError('NESTED_DELEGATION', 'A delegated model cannot start another delegation.')
  }
  if (host === target) {
    throw new DelegationError('SAME_FAMILY', `A ${host} host cannot delegate to ${target}.`)
  }
}

export function targetForHost(host) {
  if (!HOSTS.includes(host)) {
    throw new DelegationError('ROUTE_DENIED', 'The delegation host names an unknown model family.')
  }
  return host === 'claude' ? 'codex' : 'claude'
}

export function effortsForTarget(target) {
  if (target === 'codex') return CODEX_EFFORTS
  if (target === 'claude') return CLAUDE_EFFORTS
  throw new DelegationError('ROUTE_DENIED', 'The delegation target names an unknown model family.')
}

export function capabilitiesForTarget(target) {
  if (!TARGETS.includes(target)) {
    throw new DelegationError('ROUTE_DENIED', 'The delegation target names an unknown model family.')
  }
  return {
    cancel: true,
    continue: true,
    liveSteer: target === 'codex',
    crashReconcile: target === 'codex',
    structuredOutput: true,
  }
}

export function resultEnvelope(job) {
  return {
    jobId: job.id,
    status: job.status,
    host: job.host,
    target: job.target,
    mode: job.mode,
    access: job.access,
    model: job.model,
    effort: job.effort,
    serviceTier: job.serviceTier,
    threadId: job.nativeThreadId,
    turnId: job.nativeTurnId,
    output: job.output,
    structured: job.structured,
    findings: job.mode === 'task' ? null : (job.structured?.findings ?? null),
    usage: job.usage,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

export function jobSummary(job) {
  return {
    jobId: job.id,
    parentJobId: job.parentJobId,
    status: job.status,
    host: job.host,
    target: job.target,
    mode: job.mode,
    access: job.access,
    cwd: job.cwd,
    model: job.model,
    effort: job.effort,
    threadId: job.nativeThreadId,
    turnId: job.nativeTurnId,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}
