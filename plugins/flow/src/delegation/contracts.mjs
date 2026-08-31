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
// "does the harness I am running under have a permission prompt". It is a hand-maintained
// inventory, so it is biased false: an entry nobody has probed reads supported:false with
// assurance 'unverified', and a reader never mistakes silence for support. 'mechanism' means
// a named feature was observed doing the thing. 'contract' means the behaviour rests on an
// agreement both sides keep, with no platform receipt to check. Every id names both hosts, so
// a gap is visible in this source rather than at the call site. A cell dated later than the
// rest carries its own verifiedAt, so adding a row never re-dates the rows already there.
const HOST_CAPABILITY_VERIFIED_AT = '2026-08-29'
const HOST_VERIFIED_AGAINST = { claude: 'claude-code 2.1.251', codex: 'codex-cli 0.151.0' }
const HOST_CAPABILITY_TABLE = {
  'plugin-skill-contribution': {
    claude: { supported: true, assurance: 'mechanism', note: 'A plugin ships skills under skills/ and the loader registers them.' },
    codex: { supported: true, assurance: 'mechanism', note: 'Live probe: Codex discovers a plugin\'s skills with no extra configuration.' },
  },
  'plugin-command-contribution': {
    claude: { supported: true, assurance: 'mechanism', note: 'A plugin ships slash commands under commands/ and the loader registers them.' },
    codex: { supported: false, assurance: 'unverified', note: 'Live probe: Codex did not discover a plugin\'s commands/ directory.' },
  },
  'implicit-skill-suppression': {
    claude: { supported: true, assurance: 'mechanism', note: 'Skill frontmatter disable-model-invocation keeps a skill out of automatic selection.' },
    codex: { supported: false, assurance: 'unverified', note: 'The 0.151.0 source honors allow_implicit_invocation, but nothing proves the plugin-loader path reaches that code. A live capture of a plugin-supplied agents/openai.yaml staying out of automatic selection flips this to true.' },
  },
  'structured-question': {
    claude: { supported: true, assurance: 'mechanism', note: 'The interactive ask tool returns the option the human picked.' },
    codex: { supported: false, assurance: 'unverified', note: 'No interactive question tool that returns a chosen option.' },
  },
  'suspended-turn-ask': {
    claude: { supported: false, assurance: 'unverified', note: 'Not needed. The interactive ask tool already collects an answer mid-turn.' },
    codex: { supported: true, assurance: 'contract', note: 'The turn ends with the question and the human answers in the next turn. The platform sends no receipt, so the protocol is the whole assurance.' },
  },
  'hook-ask': {
    claude: { supported: true, assurance: 'mechanism', note: 'A hook returning ask shows the human a permission prompt.' },
    codex: { supported: false, assurance: 'mechanism', note: 'Codex 0.151.0 accepts an ask decision and then fails open, running the command with no prompt. false is the honest value.' },
  },
  'hook-deny': {
    claude: { supported: true, assurance: 'mechanism', note: 'A hook returning deny stops the tool call.' },
    codex: { supported: true, assurance: 'mechanism', note: 'A hook returning deny stops the tool call.' },
  },
  'per-seat-tool-allowlist': {
    claude: { supported: true, assurance: 'mechanism', note: 'An agent definition\'s tools frontmatter fixes the tool list for that seat.' },
    codex: { supported: false, assurance: 'unverified', note: 'No per-seat tool allowlist found.' },
  },
  'agent-depth-limit': {
    claude: { supported: true, assurance: 'mechanism', note: 'A leaf seat\'s agent def omits the Agent tool (flow:implementer, Explore), so nesting is impossible rather than discouraged.' },
    codex: { supported: false, assurance: 'mechanism', verifiedAt: '2026-08-30', note: 'agents.max_depth is V1-only and ignored by multi-agent V2 (codex-rs/core/src/config/mod.rs:882); the V2 spawn path (agent/control/spawn.rs) has no depth check, so a descendant-spawn prohibition is prompt contract only.' },
  },
  'per-seat-authority-narrowing': {
    claude: { supported: true, assurance: 'mechanism', note: 'An agent def\'s tools list narrows each seat below the session (Explore has no Edit/Write/Agent; flow:implementer has no Agent); neither host has a per-seat filesystem sandbox.' },
    codex: { supported: false, assurance: 'mechanism', verifiedAt: '2026-08-30', note: 'V2 spawn_agent accepts only model, reasoning_effort and fork_turns (tools/handlers/multi_agents_spec.rs); a child inherits the parent\'s cwd, approval policy and sandbox.' },
  },
  'skill-composition': {
    claude: { supported: true, assurance: 'mechanism', note: 'The Skill tool loads a named skill mid-turn.' },
    codex: { supported: false, assurance: 'unverified', verifiedAt: '2026-08-30', note: 'No Skill-call tool; a skill composes by reading sibling SKILL.md files. Unverified on the installed-plugin path until the slice 3 capture.' },
  },
  'mcp-client-roots': {
    claude: { supported: true, assurance: 'mechanism', note: 'The MCP client advertises the roots capability and answers roots/list with the session workspace.' },
    codex: { supported: false, assurance: 'mechanism', verifiedAt: '2026-08-30', note: 'The Codex 0.151.0 MCP client advertises no roots capability and sets no project-dir variable; the delegation server takes the launch shell PWD as the workspace boundary on this host, so a session started with codex -C elsewhere fails closed with OUTSIDE_ROOTS.' },
  },
  'hooks-in-native-children': {
    claude: { supported: true, assurance: 'mechanism', note: 'A subagent\'s tool calls run the session\'s PreToolUse hooks.' },
    codex: { supported: true, assurance: 'mechanism', verifiedAt: '2026-08-30', note: 'A V2 child receives a Config derived from the parent\'s turn (agent/control/spawn.rs) and the plugin PreToolUse hooks fire inside it: a spawn_agent child attempting an unsanctioned issue create and a git push --no-verify was denied by both flow guards (slice 3 capture, flow-evidence pr-9/capture-child-hooks.*).' },
  },
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreeze(child)
  }
  return Object.freeze(value)
}

const HOST_CAPABILITIES = deepFreeze(Object.fromEntries(HOSTS.map((host) => [host, {
  schemaVersion: HOST_CAPABILITIES_SCHEMA_VERSION,
  host,
  verifiedAgainst: HOST_VERIFIED_AGAINST[host],
  capabilities: Object.fromEntries(Object.entries(HOST_CAPABILITY_TABLE).map(([id, hosts]) => [id, {
    supported: hosts[host].supported,
    verifiedAt: hosts[host].verifiedAt ?? HOST_CAPABILITY_VERIFIED_AT,
    assurance: hosts[host].assurance,
    note: hosts[host].note,
  }])),
}])))

export function capabilitiesForHost(host) {
  if (!HOSTS.includes(host)) {
    throw new DelegationError('ROUTE_DENIED', 'The delegation host names an unknown model family.')
  }
  return HOST_CAPABILITIES[host]
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
