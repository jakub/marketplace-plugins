import { query } from '@anthropic-ai/claude-agent-sdk'
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, resolve, sep } from 'node:path'
import { providerScopeName, scopedProviderCommand } from './containment.mjs'
import { DelegationError } from './contracts.mjs'
import { normalizeClaudeError } from './claude-errors.mjs'
import { claudePolicyHook, claudeSandboxFor, claudeTools } from './claude-policy.mjs'
import { delegatedInstructions } from './instructions.mjs'
import { providerOutputSchema } from './schema.mjs'
import { VERSION } from './version.mjs'

export const CLAUDE_AGENT_SDK_VERSION = typeof __CLAUDE_AGENT_SDK_VERSION__ !== 'undefined'
  ? __CLAUDE_AGENT_SDK_VERSION__
  : 'unbundled'
const CLAUDE_PROBE_TIMEOUT_MS = 30_000

const CLAUDE_ENV_ALLOWLIST = new Set([
  // Process runtime and the authenticated user's Claude configuration.
  'APPDATA', 'COLORTERM', 'COMSPEC', 'HOME', 'LANG', 'LANGUAGE', 'LOCALAPPDATA',
  'LOGNAME', 'PATH', 'PATHEXT', 'SHELL', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP',
  'TMPDIR', 'TZ', 'USER', 'USERPROFILE', 'WINDIR', 'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME',
  // Network and certificate configuration needed to reach the selected provider.
  'ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_DIR', 'SSL_CERT_FILE',
  // First-party, gateway, Bedrock, Vertex, and Foundry authentication.
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CONFIG_DIR',
  'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_VERTEX_PROJECT_ID',
  'AWS_ACCESS_KEY_ID', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_CONFIG_FILE',
  'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN', 'AWS_SHARED_CREDENTIALS_FILE', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CONFIG_DIR', 'CLOUD_ML_REGION', 'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  // The deterministic smoke's fake Claude process uses this selector.
  'FLOW_FAKE_CLAUDE_MODE',
])

function claudeProcessEnvironment() {
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (CLAUDE_ENV_ALLOWLIST.has(name.toUpperCase()) || name.startsWith('LC_'))) {
      env[name] = value
    }
  }
  return env
}

export function claudeAgentSdkStatus() {
  const ok = typeof query === 'function'
  return {
    ok,
    version: CLAUDE_AGENT_SDK_VERSION,
    bundled: true,
    ...(ok ? {} : { kind: 'AGENT_SDK_MISSING' }),
  }
}

async function withProbeTimeout(promise, active, operation) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          active.close()
          reject(new DelegationError('CLAUDE_STARTUP_TIMEOUT', `Claude did not ${operation} within 30 seconds.`))
        }, CLAUDE_PROBE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function executablePath(name) {
  const candidate = name || 'claude'
  if (isAbsolute(candidate) || candidate.includes(sep)) {
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate) } catch { return null }
  }
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    // Do not honor POSIX's implicit current-directory entry here. A provider executable
    // must come from a named PATH directory or an explicit absolute override.
    if (!directory) continue
    const path = resolve(directory, candidate)
    try { accessSync(path, constants.X_OK); return realpathSync(path) } catch {}
  }
  return null
}

export function claudeExecutable() {
  const path = executablePath(process.env.FLOW_DELEGATION_CLAUDE_BIN || 'claude')
  if (!path) throw new DelegationError('CLAUDE_NOT_INSTALLED', 'Claude Code could not be started.')
  return path
}

function probeOutputState(value) {
  return typeof value === 'string' && value.trim() ? 'present' : 'empty'
}

function safeProbeErrorCode(error) {
  if (!error) return null
  const code = typeof error.code === 'string' ? error.code.toUpperCase() : ''
  return /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : 'UNKNOWN'
}

function safeProbeSignal(signal) {
  if (!signal) return null
  return typeof signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(signal) ? signal : 'UNKNOWN'
}

function probeFailure(result, kind, outcome, extra = {}) {
  return {
    ok: false,
    kind,
    ...extra,
    probe: {
      outcome,
      errorCode: safeProbeErrorCode(result.error),
      status: Number.isInteger(result.status) ? result.status : null,
      signal: safeProbeSignal(result.signal),
      stdout: probeOutputState(result.stdout),
      stderr: probeOutputState(result.stderr),
    },
  }
}

function probeStartFailure(result) {
  if (result.error?.code === 'ENOENT') return ['CLAUDE_NOT_INSTALLED', 'executable-not-found']
  if (result.error) {
    return ['CLAUDE_STARTUP', result.error.code === 'ETIMEDOUT' ? 'timeout' : 'spawn-error']
  }
  if (result.signal) return ['CLAUDE_STARTUP', 'signal']
  if (!Number.isInteger(result.status)) return ['CLAUDE_STARTUP', 'missing-status']
  return null
}

export function claudeVersion() {
  let bin
  try { bin = claudeExecutable() } catch {
    return { ok: false, kind: 'CLAUDE_NOT_INSTALLED', version: null }
  }
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  const startFailure = probeStartFailure(result)
  if (startFailure) return probeFailure(result, startFailure[0], startFailure[1], { version: null })
  if (result.status !== 0) return probeFailure(result, 'CLAUDE_VERSION', 'exit-nonzero', { version: null })
  const version = result.stdout.trim()
  if (!version) return probeFailure(result, 'CLAUDE_VERSION', 'empty-output', { version: null })
  return { ok: true, kind: null, version }
}

export function claudeAuthStatus() {
  let bin
  try { bin = claudeExecutable() } catch {
    return { ok: false, kind: 'CLAUDE_NOT_INSTALLED' }
  }
  const result = spawnSync(bin, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 10_000 })
  const startFailure = probeStartFailure(result)
  if (startFailure) return probeFailure(result, startFailure[0], startFailure[1])
  const output = result.stdout.trim()
  if (result.status !== 0) {
    if (output) {
      try {
        const value = JSON.parse(output)
        if (value && typeof value === 'object' && value.loggedIn === false) {
          return probeFailure(result, 'CLAUDE_AUTH', 'not-authenticated')
        }
      } catch {}
    }
    return probeFailure(result, 'CLAUDE_AUTH', 'exit-nonzero')
  }
  if (!output) return probeFailure(result, 'CLAUDE_AUTH', 'empty-output')
  try {
    const value = JSON.parse(output)
    if (!value || typeof value !== 'object' || typeof value.loggedIn !== 'boolean') {
      return probeFailure(result, 'CLAUDE_AUTH', 'invalid-json')
    }
    if (!value.loggedIn) return probeFailure(result, 'CLAUDE_AUTH', 'not-authenticated')
    return {
      ok: true,
      kind: null,
      authMethod: value.authMethod || null,
      apiProvider: value.apiProvider || null,
      subscriptionType: value.subscriptionType || null,
    }
  } catch {
    return probeFailure(result, 'CLAUDE_AUTH', 'invalid-json')
  }
}

async function* pendingInput() { await new Promise(() => {}) }

function probeOptions(cwd) {
  return {
    pathToClaudeCodeExecutable: claudeExecutable(),
    cwd,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    tools: [],
    skills: [],
    plugins: [],
    permissionMode: 'dontAsk',
    systemPrompt: 'Flow capability probe. Do not run a model turn.',
    extraArgs: { 'disable-slash-commands': null, 'no-chrome': null },
  }
}

export async function claudeModels(cwd) {
  let active
  try {
    active = query({ prompt: pendingInput(), options: probeOptions(cwd) })
    const initialized = await withProbeTimeout(active.initializationResult(), active, 'initialize the model probe')
    if (!initialized || typeof initialized !== 'object') {
      throw new DelegationError('CLAUDE_PROTOCOL', 'Claude returned no SDK initialization result for the model probe.')
    }
    return await withProbeTimeout(active.supportedModels(), active, 'return its model catalog')
  } catch (error) {
    throw normalizeClaudeError(error)
  } finally {
    active?.close()
  }
}

export function createClaudeQuery(job, prompt, {
  sessionId,
  onSpawn = () => {},
  onStderr = () => {},
  onPolicyDenied = () => {},
  canUseTool,
} = {}) {
  const tools = claudeTools(job.access, { structured: job.outputSchema != null })
  const scopeName = providerScopeName(job.id)
  return query({
    prompt,
    options: {
      pathToClaudeCodeExecutable: claudeExecutable(),
      cwd: job.cwd,
      model: job.model,
      effort: job.effort,
      maxTurns: job.maxTurns ?? undefined,
      maxBudgetUsd: job.maxBudgetUsd ?? undefined,
      ...(job.nativeThreadId ? { resume: job.nativeThreadId, forkSession: false } : { sessionId }),
      persistSession: true,
      includePartialMessages: true,
      // The SDK omits --json-schema for the boolean false schema because false is falsy.
      // {not:{}} is the equivalent always-invalid object schema and reaches the provider.
      outputFormat: job.outputSchema == null
        ? undefined
        : { type: 'json_schema', schema: job.outputSchema === false ? { not: {} } : providerOutputSchema(job.outputSchema) },
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      plugins: [],
      skills: [],
      tools,
      allowedTools: tools,
      disallowedTools: ['Agent', 'Task', 'Workflow', 'Skill', 'WebFetch', 'WebSearch', 'AskUserQuestion'],
      permissionMode: 'dontAsk',
      canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [claudePolicyHook(job, { onDenied: onPolicyDenied })], timeout: 5 }],
      },
      sandbox: claudeSandboxFor(job),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: delegatedInstructions(job, 'Claude'),
      },
      extraArgs: { 'disable-slash-commands': null, 'no-chrome': null },
      env: {
        ...claudeProcessEnvironment(),
        FLOW_DELEGATION_DEPTH: String(job.depth + 1),
        FLOW_DELEGATION_PARENT_JOB_ID: job.id,
        CLAUDE_AGENT_SDK_CLIENT_APP: `flow-delegation/${VERSION}`,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        // Claude Code retries a refused turn on a fallback model by default, and for a
        // subagent-style query that retry is silent. The charter's rule is that a refusal is a
        // typed result, never a quieter model, so the worker sees the refusal instead.
        CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1',
        // The CLI's own no-fallback guarantee: the availability chain collapses to the primary
        // model and any fallback pivot trips an internal error instead of switching. Neither
        // variable is public API, so the worker also checks the model named on every assistant
        // frame against the one it asked for, and fails the job when they differ.
        CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
      },
      stderr: onStderr,
      spawnClaudeCodeProcess: ({ command, args, cwd, env }) => {
        const launch = scopedProviderCommand(command, args, scopeName)
        const child = spawn(launch.command, launch.args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          // A separate process group lets the worker stop the CLI and every command it
          // started before releasing a workspace-write lease.
          detached: true,
        })
        child.flowProviderScope = scopeName
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', onStderr)
        onSpawn(child)
        return child
      },
    },
  })
}
