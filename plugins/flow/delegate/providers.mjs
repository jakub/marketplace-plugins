// What the targets share: where a provider CLI is, what environment it runs in, its version and
// sign-in, and how a finished answer becomes an outcome. The Claude target is here as well: a
// one-shot `claude -p` that loads no setting source and no MCP server and runs its tools inside
// the sandbox described by the settings it is handed. The Codex target is codex-app-server.mjs.
//
// The runner drives every target through one session shape: open, send, interrupt, close, then
// finish, which folds the provider's lines into an outcome. A one-shot CLI takes its whole prompt
// on stdin in the spawn that creates its session, so its open is the spawn and its send is stdin.
import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { log } from './jobs.mjs'
import { CHECK_SECONDS, checkAnswer } from './schema.mjs'

// Only absolute PATH entries count. An empty or relative entry resolves against the job's cwd,
// and a worktree must never be able to supply the provider executable.
function candidates(name) {
  return (process.env.PATH || '').split(delimiter).filter((directory) => isAbsolute(directory)).map((directory) => join(directory, name))
}
export function findExecutable(name) {
  for (const path of candidates(name)) {
    try {
      accessSync(path, constants.X_OK)
      if (statSync(path).isFile()) return path
    } catch {}
  }
  return null
}

// The provider sees a fixed set of variables and nothing else the host carries, plus the depth
// marker that refuses a second hop and a private TMPDIR under the job.
const KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TERM|TZ|CODEX_HOME|CLAUDE_CONFIG_DIR|XDG_[A-Z_]+|LC_[A-Z_]+)$/
const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => KEEP.test(name)))
export function providerEnv(job, dir) {
  const env = { ...baseEnv(), TMPDIR: join(dir, 'tmp'), FLOW_DELEGATION_DEPTH: '1', FLOW_DELEGATION_JOB: job.id }
  if (job.target === 'claude') {
    // Neither fallback switch is public API, so the fold also checks every assistant frame's
    // model. Auto-memory would write this job into the human's project memory.
    Object.assign(env, { CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1', CLAUDE_CODE_NO_MODEL_FALLBACK: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
  }
  return env
}

const execute = (bin, args) => new Promise((done) => {
  execFile(bin, args, { env: baseEnv(), timeout: 10_000, encoding: 'utf8' }, (error, stdout, stderr) => {
    const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
    done({ code, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() })
  })
})

// Version and sign-in state, and nothing more: the Claude status also carries an email and an
// organization, which stay here.
export async function probe(target) {
  const bin = findExecutable(target)
  if (!bin) return { installed: false, version: null, auth: null }
  const version = (await execute(bin, ['--version'])).stdout.split('\n')[0] || null
  let auth
  if (target === 'codex') {
    // Codex prints its status line to stderr.
    const status = await execute(bin, ['login', 'status'])
    auth = { loggedIn: status.code === 0, method: /Logged in using (.+)/.exec(`${status.stdout}\n${status.stderr}`)?.[1] ?? null }
  } else {
    const status = await execute(bin, ['auth', 'status', '--json'])
    try {
      const parsed = JSON.parse(status.stdout)
      auth = { loggedIn: parsed.loggedIn === true, method: parsed.authMethod ?? null, provider: parsed.apiProvider ?? null }
    } catch { auth = { loggedIn: false, method: null } }
  }
  return { installed: true, version, auth }
}

// Local sign-in and credential state no delegated seat reads.
function credentialPaths() {
  const home = homedir()
  const named = ['.ssh', '.gnupg', '.git-credentials', '.netrc', '.npmrc', '.pypirc', '.docker', '.aws', '.azure', '.kube',
    '.config/gh', '.config/gcloud', '.claude', '.claude.json', '.codex'].map((path) => join(home, path))
  const configured = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'].map((name) => process.env[name]).filter(Boolean).map((path) => resolve(path))
  return [...new Set([...named, ...configured])]
}

// Both provider executables, so a shell inside the sandbox cannot start either one. A PATH entry
// whose real target does not name the provider is a shared launcher (a mise or asdf shim resolves
// to the manager's own binary), and masking it would take node, python and every tool it serves
// with it, so it is left alone: the unreadable credentials and the closed network already leave a
// nested provider with nothing to sign in with and nowhere to connect.
function providerExecutables() {
  const paths = []
  for (const name of ['claude', 'codex']) {
    for (const path of candidates(name)) {
      let real
      try { real = realpathSync(path) } catch { continue }
      if (new RegExp(`(^|/)[^/]*${name}[^/]*(/|$)`, 'i').test(real)) paths.push(path, real)
    }
  }
  return [...new Set(paths)]
}

// Permission rules take gitignore patterns, where // anchors at the filesystem root.
const pattern = (path) => `/${path.replace(/[\\*?[\]!#]/g, '\\$&')}`

// The Claude tools' containment. Bash runs in the OS sandbox: no network, the credentials, both
// provider executables and /proc unreadable, and the worktree writable only on a write job. Read,
// Grep and Glob are file tools the sandbox does not cover, so the same credentials are denied to
// them as permission rules; Edit is allowed inside the worktree and nowhere else.
export function claudeSettings(job, dir) {
  const write = job.access === 'workspace-write'
  const tmp = join(dir, 'tmp')
  const secret = [...credentialPaths(), '/proc']
  return {
    permissions: {
      allow: write ? [`Edit(${pattern(job.worktree)}/**)`] : [],
      deny: secret.flatMap((path) => [`Read(${pattern(path)})`, `Read(${pattern(path)}/**)`]),
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true },
      filesystem: {
        denyRead: [...secret, ...providerExecutables()],
        ...(write ? { allowWrite: [job.worktree, tmp] } : { denyWrite: [job.worktree], allowWrite: [tmp] }),
      },
    },
  }
}

export const clip = (text) => String(text ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 500)
export function classify(message) {
  if (/\b401\b|\b403\b|unauthori[sz]ed|not (logged|signed) in|log ?in again|authenticat|credential|expired token/i.test(message)) return 'PROVIDER_AUTH'
  if (/refus|flagged|safety|usage polic|content polic|cyber/i.test(message)) return 'REFUSAL'
  if (/timed? ?out|timeout|deadline exceeded/i.test(message)) return 'TIMEOUT'
  if (/output schema|json schema|response_format|invalid schema/i.test(message)) return 'BAD_SCHEMA'
  return 'PROVIDER_ERROR'
}

// A completed turn is a success only with an answer, and, when a schema was asked for, with a
// structure that conforms to it. Neither provider's own enforcement is taken on trust: Codex
// narrows a schema outside its subset without saying so.
export function answered(job, dir, base, output, structured) {
  if (!output && structured === undefined) return { ...base, status: 'failed', error: { kind: 'EMPTY_OUTPUT', message: 'The provider completed without a final answer.' } }
  if (!job.hasSchema) return { ...base, status: 'succeeded', output }
  if (structured === undefined || structured === null || typeof structured !== 'object') {
    return { ...base, output, status: 'failed', error: { kind: 'SCHEMA_OUTPUT', message: 'The provider did not return JSON in the requested schema.' } }
  }
  const errors = checkAnswer(join(dir, 'schema.json'), structured)
  if (errors === null) {
    return { ...base, output, status: 'failed', error: { kind: 'SCHEMA_OUTPUT', message: `The provider's answer could not be checked against the requested schema within ${CHECK_SECONDS} seconds.` } }
  }
  if (errors.length) {
    return { ...base, output, status: 'failed', error: { kind: 'SCHEMA_OUTPUT', message: 'The provider\'s answer does not match the requested schema.', details: { errors } } }
  }
  return { ...base, status: 'succeeded', output, structured }
}

const modelKey = (model) => String(model).replace(/\[1m\]$/i, '').toLowerCase()

function claudeFailure(result, assistantError, text) {
  if (['authentication_failed', 'oauth_org_not_allowed'].includes(assistantError)) return { kind: 'PROVIDER_AUTH', message: 'Claude is not signed in, or the account may not use this model.' }
  if (result.subtype === 'error_max_turns') return { kind: 'TIMEOUT', message: 'Claude reached the maxTurns limit.' }
  if (result.subtype === 'error_max_budget_usd') return { kind: 'TIMEOUT', message: 'Claude reached the maxBudgetUsd limit.' }
  if (result.subtype === 'error_max_structured_output_retries') return { kind: 'SCHEMA_OUTPUT', message: 'Claude could not answer in the requested schema.' }
  const detail = clip(text || assistantError || result.subtype)
  return { kind: classify(detail), message: `Claude: ${detail}` }
}

const claude = {
  name: 'Claude',
  argv(job, dir) {
    const base = ['Read', 'Grep', 'Glob', 'Bash', ...(job.hasSchema ? ['StructuredOutput'] : [])]
    const tools = job.access === 'workspace-write' ? [...base, 'Edit', 'Write', 'NotebookEdit'] : base
    return ['-p', '--output-format', 'stream-json', '--verbose', '--model', job.model, '--effort', job.effort,
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--setting-sources', '', '--strict-mcp-config',
      '--settings', JSON.stringify(claudeSettings(job, dir)), '--tools', tools.join(','), '--allowedTools', base.join(','),
      ...(job.resumeThreadId ? ['--resume', job.resumeThreadId] : ['--session-id', job.sessionId]),
      '--append-system-prompt-file', join(dir, 'seat.md'),
      ...(job.hasSchema ? ['--json-schema', readFileSync(join(dir, 'schema.json'), 'utf8')] : []),
      ...(job.maxTurns ? ['--max-turns', String(job.maxTurns)] : []),
      ...(job.maxBudgetUsd ? ['--max-budget-usd', String(job.maxBudgetUsd)] : [])]
  },
  stdin: (seat, prompt) => prompt,
  fold(job, dir) {
    let session = null
    let served = null
    let mismatch = null
    let refusal = null
    let result = null
    let assistantError = null
    let failures = 0
    const bash = new Set()
    return {
      thread: () => session,
      event(event) {
        if (event.type === 'system' && event.subtype === 'init') {
          session = event.session_id ?? session
          served = event.model ?? served
        } else if (event.type === 'system' && /^model_refusal/.test(event.subtype ?? '')) {
          refusal ??= { category: event.api_refusal_category ?? null }
        } else if (event.type === 'result') {
          result = event
        } else if (event.type === 'user') {
          for (const block of event.message?.content ?? []) {
            if (block?.type === 'tool_result' && block.is_error && bash.has(block.tool_use_id)) failures++
          }
        } else if (event.type === 'assistant') {
          const message = event.message ?? {}
          assistantError = event.error ?? assistantError
          for (const block of message.content ?? []) if (block?.type === 'tool_use' && block.name === 'Bash') bash.add(block.id)
          if (message.stop_reason === 'refusal') refusal ??= { category: message.stop_details?.category ?? null }
          // The init frame names the model that serves the session. Any other model on an
          // assistant frame is a swap, and the turn stops now rather than at its end: on a write
          // job the wrong model would be editing the worktree meanwhile.
          if (!mismatch && served && message.model && message.model !== '<synthetic>' && modelKey(message.model) !== modelKey(served)) {
            mismatch = { expected: served, served: message.model }
            return 'interrupt'
          }
        }
        return undefined
      },
      finish({ code, signal }) {
        const base = { threadId: result?.session_id ?? session, servedModel: served, output: null, structured: null, commandFailures: failures, error: null }
        if (mismatch) return { ...base, status: 'failed', error: { kind: 'MODEL_MISMATCH', message: `Claude answered on ${mismatch.served}, not ${mismatch.expected}, and the turn was stopped.`, details: mismatch } }
        if (refusal) return { ...base, status: 'failed', error: { kind: 'REFUSAL', message: 'Claude declined the delegated turn.', details: refusal } }
        if (!result) {
          return { ...base, status: 'failed', error: { kind: 'PROVIDER_ERROR', message: `Claude exited (${signal ?? code}) without a result; stderr.txt beside the events file has its diagnostics.` } }
        }
        const text = String(result.result ?? '').trim()
        if (result.is_error || result.subtype !== 'success') return { ...base, output: text || null, status: 'failed', error: claudeFailure(result, assistantError, text) }
        // dontAsk turns every would-be prompt into a denial the model works around. The job asked
        // for less than the task needed, so its answer is kept and the outcome says so.
        if (result.permission_denials?.length) {
          return { ...base, output: text || null, status: 'failed', error: { kind: 'APPROVAL_REQUIRED', message: 'Claude needed a permission this job does not grant.', details: { denied: result.permission_denials.map((denial) => denial.tool_name) } } }
        }
        return answered(job, dir, base, text, result.structured_output)
      },
    }
  },
}

// A one-shot CLI as a session. Nothing can be read back between its spawn and its prompt, and it
// has no interrupt of its own, so a stop reaches it through its process group alone. Each stdout
// line is folded first and then handed to the runner, which journals it and reads the session's
// state after it.
function oneShot(provider) {
  return {
    name: provider.name,
    async open({ job, dir, bin, env, seat, onSpawn, onLine }) {
      const child = spawn(bin, provider.argv(job, dir), { cwd: job.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env })
      onSpawn(child)
      const fold = provider.fold(job, dir)
      const session = {
        stopReason: null,
        turnEnded: false,
        get threadId() { return fold.thread() },
        send(prompt) { child.stdin.end(provider.stdin(seat, prompt)) },
        interrupt: async () => null,
        close() {},
        finish: (exit) => fold.finish(exit),
      }
      child.stdin.on('error', () => {})
      createInterface({ input: child.stdout }).on('line', (line) => {
        let event
        try { event = JSON.parse(line) } catch {}
        if (event !== undefined) {
          try { if (fold.event(event) === 'interrupt') session.stopReason = 'MODEL_MISMATCH' } catch (error) { log(`fold failed for ${job.id}: ${error?.stack || error}`) }
        }
        onLine(line)
      })
      return session
    },
  }
}

export const claudeTransport = oneShot(claude)
