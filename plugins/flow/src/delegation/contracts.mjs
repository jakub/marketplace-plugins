import { readFileSync } from 'node:fs'

export const HOSTS = ['claude', 'codex']
export const TARGETS = ['claude', 'codex']
export const MODES = ['task', 'review', 'adversarial-review']
export const ACCESS_MODES = ['read-only', 'workspace-write']
export const DELIVERIES = ['attached', 'detached']
// Codex's live model catalog starts every model at 'low'; a 'minimal' request reaches the
// provider and dies late as BAD_MODEL, blaming the wrong parameter. Reject it at the edge.
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const SERVICE_TIERS = ['default']
export const ACTIVE_STATES = ['queued', 'starting', 'running', 'reconciling']
export const TERMINAL_STATES = ['succeeded', 'failed', 'cancelled', 'unknown', 'awaiting_approval']
export const QUARANTINE_STATES = ['quarantined']
export const JOB_STATES = [...ACTIVE_STATES, ...QUARANTINE_STATES, ...TERMINAL_STATES]
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
    limits: {
      timeBudgetSeconds: true,
      maxTurns: target === 'claude',
      maxBudgetUsd: target === 'claude',
    },
  }
}

export const HOST_CAPABILITIES_SCHEMA_VERSION = 1
export const HOST_CAPABILITY_ASSURANCES = ['mechanism', 'contract', 'unverified']

// What the host harness itself can do, which is a different question from what a delegated
// target can do. capabilitiesForTarget answers "can I steer this job"; this table answers
// "does the harness I am running under have a permission prompt". It lives in
// capabilities.json at the plugin root, next to the bundle that reads it, so re-verifying a
// row is an edit to that file and no rebuild. The bundle reads it at runtime and never
// inlines it.
//
// The table is hand-maintained, so it is biased false: an entry nobody has probed reads
// supported:false with assurance 'unverified', and a reader never mistakes silence for
// support. 'mechanism' means a named feature was observed doing the thing. 'contract' means
// the behaviour rests on an agreement both sides keep, with no platform receipt to check.
// Every id names both hosts, so a gap is visible in the file rather than at the call site.
// Every entry carries its own verifiedAt, so re-dating one row never re-dates the rest.
function readCapabilityFile() {
  // dist/delegation.mjs sits one directory under the plugin root; src/delegation sits two.
  // The installed plugin only ever runs the bundle, so the first path is the real one and
  // the second is what lets a dev tree import this module straight from source.
  for (const path of ['../capabilities.json', '../../capabilities.json']) {
    try { return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) } catch {}
  }
  throw new DelegationError('INTERNAL', 'The host capability table could not be read.')
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreeze(child)
  }
  return Object.freeze(value)
}

let cachedHostCapabilities = null
function hostCapabilityRecord(host) {
  if (!cachedHostCapabilities) {
    const file = readCapabilityFile()
    if (file?.schemaVersion !== HOST_CAPABILITIES_SCHEMA_VERSION) {
      throw new DelegationError('INTERNAL', 'The host capability table has an unsupported schema version.')
    }
    cachedHostCapabilities = deepFreeze(Object.fromEntries(HOSTS.map((name) => [name, {
      schemaVersion: file.schemaVersion,
      host: name,
      verifiedAgainst: file.hosts?.[name]?.verifiedAgainst ?? null,
      capabilities: file.hosts?.[name]?.capabilities ?? {},
    }])))
  }
  return cachedHostCapabilities[host]
}

// The bare dotted version inside a version string, so "codex-cli 0.152.0" and
// "2.1.257 (Claude Code)" both yield the number the comparison needs.
export function bareVersion(value) {
  const match = /\b\d+(?:\.\d+)+\b/.exec(String(value ?? ''))
  return match ? match[0] : null
}

// Numeric compare on dot-separated integers, shorter operand padded with zeroes. Neither
// host tags a build or a prerelease onto the version it reports, so there is nothing else
// to order.
function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference) return difference > 0 ? 1 : -1
  }
  return 0
}

// The whole drift verdict, computed here so no caller has to compare version strings by
// hand. 'unknown' covers a missing operand and one that will not parse, and it is a stop for
// the reader exactly like 'older': a preflight that cannot read its own record has verified
// nothing.
export function capabilityDrift(installed, verifiedAgainst) {
  const observed = bareVersion(installed)
  const record = bareVersion(verifiedAgainst)
  const status = !observed || !record ? 'unknown'
    : compareVersions(observed, record) === 0 ? 'match'
      : compareVersions(observed, record) > 0 ? 'newer' : 'older'
  return Object.freeze({ installed: observed, verifiedAgainst: record, status })
}

/**
 * The host capability inventory, plus the drift verdict between the version the host CLI
 * reports right now and the version the table was last verified against. The caller supplies
 * the observed version because only it can see the live host.
 */
export function capabilitiesForHost(host, { installed = null } = {}) {
  if (!HOSTS.includes(host)) {
    throw new DelegationError('ROUTE_DENIED', 'The delegation host names an unknown model family.')
  }
  const record = hostCapabilityRecord(host)
  return Object.freeze({ ...record, drift: capabilityDrift(installed, record.verifiedAgainst) })
}

function publicQuarantine(job) {
  if (job.status !== 'quarantined') return null
  return {
    resumeStatus: job.quarantineResumeStatus,
    providerPid: job.providerPid,
    providerProcessGroupId: job.providerProcessGroupId,
    providerScope: job.providerScope,
    trackedProcesses: job.providerProcesses.length,
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
    limits: {
      timeBudgetSeconds: job.timeBudgetSeconds,
      maxTurns: job.maxTurns,
      maxBudgetUsd: job.maxBudgetUsd,
    },
    threadId: job.nativeThreadId,
    turnId: job.nativeTurnId,
    output: job.output,
    structured: job.structured,
    findings: job.mode === 'task' ? null : (job.structured?.findings ?? null),
    usage: job.usage,
    commandFailures: job.commandFailures ?? 0,
    error: job.error,
    quarantine: publicQuarantine(job),
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
    limits: {
      timeBudgetSeconds: job.timeBudgetSeconds,
      maxTurns: job.maxTurns,
      maxBudgetUsd: job.maxBudgetUsd,
    },
    threadId: job.nativeThreadId,
    turnId: job.nativeTurnId,
    error: job.error,
    quarantine: publicQuarantine(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}
