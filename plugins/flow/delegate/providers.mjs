// What the targets share: where a provider CLI is, what environment it runs in, its version and
// sign-in, and how a finished answer becomes an outcome. Each target is a transport of its own:
// codex-app-server.mjs speaks the Codex App Server, and claude-control.mjs speaks the Claude CLI's
// stream-json control channel. The runner drives both through one session shape: open, send,
// interrupt, close, then finish, which folds the provider's lines into an outcome.
import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { DelegateError } from './jobs.mjs'
import { CHECK_SECONDS, checkAnswer } from './schema.mjs'

// Only absolute PATH entries count. An empty or relative entry resolves against the job's cwd,
// and a worktree must never be able to supply the provider executable.
export function candidates(name) {
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

export const clip = (text) => String(text ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 500)
export function classify(message) {
  if (/\b401\b|\b403\b|unauthori[sz]ed|not (logged|signed) in|log ?in again|authenticat|credential|expired token/i.test(message)) return 'PROVIDER_AUTH'
  if (/refus|flagged|safety|usage polic|content polic|cyber/i.test(message)) return 'REFUSAL'
  if (/timed? ?out|timeout|deadline exceeded/i.test(message)) return 'TIMEOUT'
  if (/output schema|json schema|response_format|invalid schema/i.test(message)) return 'BAD_SCHEMA'
  return 'PROVIDER_ERROR'
}

// The provider's own catalog, read before the prompt. A model it lists must be asked for at an
// effort it lists for that model, or the call names an effort the provider cannot honour, and the
// job fails BAD_MODEL with nothing sent. An id it does not list is admitted, because a catalog can
// lag the models an account may use, and the envelope says the catalog was absent.
export function listing(provider, entry, job) {
  if (!entry) return 'absent'
  if (entry.efforts.includes(job.effort)) return 'listed'
  const efforts = entry.efforts.slice(0, 10).map(clip)
  throw new DelegateError('BAD_MODEL', efforts.length
    ? `${provider}'s catalog lists ${job.model} at effort ${efforts.join(', ')}, not ${job.effort}, so no prompt was sent.`
    : `${provider}'s catalog lists ${job.model} with no effort levels, so it cannot honour effort ${job.effort}, and no prompt was sent.`,
  { model: job.model, efforts })
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
