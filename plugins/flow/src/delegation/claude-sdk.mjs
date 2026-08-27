import { query } from '@anthropic-ai/claude-agent-sdk'
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, resolve, sep } from 'node:path'
import { DelegationError } from './contracts.mjs'
import { claudePolicyHook, claudeSandboxFor, claudeTools } from './claude-policy.mjs'
import { VERSION } from './version.mjs'

export const CLAUDE_AGENT_SDK_VERSION = '0.3.240'
const CLAUDE_PROBE_TIMEOUT_MS = 30_000

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
  const suffixes = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue
    for (const suffix of suffixes) {
      const path = resolve(directory, `${candidate}${suffix}`)
      try { accessSync(path, constants.X_OK); return realpathSync(path) } catch {}
    }
  }
  return null
}

export function claudeExecutable() {
  const path = executablePath(process.env.FLOW_DELEGATION_CLAUDE_BIN || 'claude')
  if (!path) throw new DelegationError('CLAUDE_NOT_INSTALLED', 'Claude Code could not be started.')
  return path
}

export function claudeVersion() {
  let bin
  try { bin = claudeExecutable() } catch {
    return { ok: false, kind: 'CLAUDE_NOT_INSTALLED', version: null }
  }
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (result.error?.code === 'ENOENT') return { ok: false, kind: 'CLAUDE_NOT_INSTALLED', version: null }
  if (result.status !== 0) return { ok: false, kind: 'CLAUDE_VERSION', version: null }
  return { ok: true, kind: null, version: result.stdout.trim() }
}

export function claudeAuthStatus() {
  let bin
  try { bin = claudeExecutable() } catch {
    return { ok: false, kind: 'CLAUDE_NOT_INSTALLED' }
  }
  const result = spawnSync(bin, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0) return { ok: false, kind: 'CLAUDE_AUTH' }
  try {
    const value = JSON.parse(result.stdout)
    return {
      ok: value.loggedIn === true,
      kind: value.loggedIn === true ? null : 'CLAUDE_AUTH',
      authMethod: value.authMethod || null,
      apiProvider: value.apiProvider || null,
      subscriptionType: value.subscriptionType || null,
    }
  } catch {
    return { ok: false, kind: 'CLAUDE_AUTH' }
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

function delegatedInstructions(job) {
  const access = job.access === 'workspace-write'
    ? 'You may edit only the assigned Git worktree. Do not publish, push, or modify another checkout.'
    : 'This is a read-only job. Do not edit files or mutate the repository.'
  const profile = job.profile === 'defensive-security'
    ? ' The caller selected the defensive-security profile for authorized defensive research.'
    : ''
  return `You are a delegated Claude worker. Complete the caller task directly. Do not start subagents, invoke Claude or Codex through the shell, or start another cross-family delegation. ${access} Read and follow the applicable AGENTS.md or CLAUDE.md files before acting.${profile}`
}

export function createClaudeQuery(job, prompt, {
  sessionId,
  onSpawn = () => {},
  onStderr = () => {},
  onPolicyDenied = () => {},
  canUseTool,
} = {}) {
  const tools = claudeTools(job.access)
  return query({
    prompt,
    options: {
      pathToClaudeCodeExecutable: claudeExecutable(),
      cwd: job.cwd,
      model: job.model,
      effort: job.effort,
      ...(job.nativeThreadId ? { resume: job.nativeThreadId, forkSession: false } : { sessionId }),
      persistSession: true,
      includePartialMessages: true,
      outputFormat: job.outputSchema == null ? undefined : { type: 'json_schema', schema: job.outputSchema },
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
        append: delegatedInstructions(job),
      },
      extraArgs: { 'disable-slash-commands': null, 'no-chrome': null },
      env: {
        ...process.env,
        FLOW_DELEGATION_DEPTH: String(job.depth + 1),
        FLOW_DELEGATION_PARENT_JOB_ID: job.id,
        CLAUDE_AGENT_SDK_CLIENT_APP: `flow-delegation/${VERSION}`,
      },
      stderr: onStderr,
      spawnClaudeCodeProcess: ({ command, args, cwd, env }) => {
        const child = spawn(command, args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', onStderr)
        onSpawn(child)
        return child
      },
    },
  })
}

export function normalizeClaudeError(error) {
  if (error instanceof DelegationError) return error
  const text = String(error?.message || error || '')
  if (error?.code === 'ENOENT' || /not found|could not be started/i.test(text)) {
    return new DelegationError('CLAUDE_NOT_INSTALLED', 'Claude Code could not be started.')
  }
  if (/auth|login|oauth|credential/i.test(text)) {
    return new DelegationError('CLAUDE_AUTH', 'Claude Code is not authenticated for Agent SDK use.')
  }
  if (/model/i.test(text) && /invalid|unknown|not found|does not exist|unsupported/i.test(text)) {
    return new DelegationError('BAD_MODEL', 'Claude rejected the requested model.')
  }
  if (/effort/i.test(text) && /invalid|unknown|unsupported/i.test(text)) {
    return new DelegationError('BAD_EFFORT', 'Claude rejected the requested effort level.')
  }
  if (/sandbox/i.test(text)) {
    return new DelegationError('SANDBOX_UNAVAILABLE', 'Claude could not start the required sandbox.')
  }
  return new DelegationError('CLAUDE_SDK', 'The Claude Agent SDK ended before the job completed.')
}
