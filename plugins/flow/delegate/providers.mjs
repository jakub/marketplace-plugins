// What differs per target: where the CLI is, what it is told, what environment it gets, and how
// its JSONL folds into an outcome.
import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

// Only absolute PATH entries count. An empty or relative entry resolves against the job's cwd,
// and a worktree must never be able to supply the provider executable.
export function findExecutable(name) {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!isAbsolute(directory)) continue
    const path = join(directory, name)
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
    // Neither switch is public API, so the fold also checks every assistant frame's model.
    Object.assign(env, { CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1', CLAUDE_CODE_NO_MODEL_FALLBACK: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
  }
  return env
}

const execute = (bin, args) => new Promise((resolve) => {
  execFile(bin, args, { env: baseEnv(), timeout: 10_000, encoding: 'utf8' }, (error, stdout, stderr) => {
    const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
    resolve({ code, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() })
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
    const status = await execute(bin, ['login', 'status'])
    // Codex prints its status line to stderr.
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

export const PROVIDERS = {}
