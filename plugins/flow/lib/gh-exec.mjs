// How every flow executor reaches gh and git, and reads what they printed.
//
// gh is resolved from PATH once, to an absolute path, so a PATH change mid-run cannot swap the
// binary under a claim or a merge that is half done. Only absolute entries count, for gh and for
// every bare name execCapture runs, git included: a relative one names a different binary in
// every directory, the inspected repository's among them, so with no match in an absolute entry
// the call refuses rather than let the child search PATH again. GH_REPO and GH_HOST come off gh's
// environment: every call is already pinned to the repository origin parses to, and either
// variable is an ambient override of exactly that pin.

import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

const resolveBin = (name, env) => {
  for (const dir of String(env?.PATH || '').split(delimiter)) {
    if (!isAbsolute(dir)) continue
    try { accessSync(join(dir, name), constants.X_OK); return join(dir, name) } catch {}
  }
  return null
}
const notFound = (name) => ({ code: 127, stdout: '', stderr: `${name}: not found in an absolute PATH entry\n` })

/** Run a command and report a non-zero exit, a timeout or a missing binary as a value, never a throw. */
export const execCapture = (bin, args, { cwd, timeoutMs, env } = {}) => {
  const path = bin.includes('/') ? bin : resolveBin(bin, env ?? process.env)
  if (!path) return notFound(bin)
  try {
    const stdout = execFileSync(path, args, { encoding: 'utf8', timeout: timeoutMs, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout: String(stdout), stderr: '' }
  } catch (error) {
    return { code: error?.status ?? 1, stdout: String(error?.stdout || ''), stderr: String(error?.stderr || error?.message || error) }
  }
}

/** The gh runner an executor's main block hands in: `(args, { cwd, timeoutMs }) => { code, stdout, stderr }`. */
export const ghRunner = (env = process.env) => {
  const bin = resolveBin('gh', env)
  const childEnv = { ...env }
  delete childEnv.GH_REPO
  delete childEnv.GH_HOST
  if (!bin) return () => notFound('gh')
  return (args, { cwd, timeoutMs = 60_000 } = {}) => execCapture(bin, args, { cwd, timeoutMs, env: childEnv })
}

/** Write an executor's { code, stdout, stderr } and exit with its code. */
export const runExecutor = (result) => {
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.code)
}

/** Any JSON value a command printed (paged reads print arrays), or null. */
export const parseJson = (text) => {
  if (typeof text !== 'string') return null
  try { return JSON.parse(text) } catch { return null }
}

/** The same, narrowed to one plain object: a list where a record was asked for has not answered. */
export const parseObject = (text) => {
  const value = parseJson(text)
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}
