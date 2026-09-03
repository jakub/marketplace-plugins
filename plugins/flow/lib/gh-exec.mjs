// The process plumbing every flow executor needs to reach gh, and the parse of what gh printed.
//
// scripts/issue-claim.mjs, scripts/land-gates.mjs and scripts/land-merge.mjs each ended in the
// same thirty lines: find gh on PATH, take GH_REPO and GH_HOST out of the child environment, wrap
// execFileSync so a failure arrives as a value instead of a throw, and turn the executor's
// { code, stdout, stderr } into two written streams and an exit status. The three copies were
// byte-identical, and one of them is a security decision rather than plumbing. This is that code
// once, for the same reason lib/remote-identity.mjs holds the origin parse once.
//
// What is deliberately NOT here is the runner signature each executor injects. issue-claim's
// takes { cwd } and applies its own fixed timeout, the two land executors take a timeout per
// call, and each one's smoke fakes exactly that shape across the module boundary. The shared
// piece is the process call underneath; every main block still builds the runner its own
// function signature documents.

import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * A real gh, resolved from PATH once and remembered as an absolute path.
 *
 * At one uid this is cooperative and not tamper-proof: whoever can set PATH could put a different
 * gh first, the same way they could ignore the executor entirely and call the API themselves.
 * What the one-time absolute resolution buys is that a PATH change mid-run cannot swap the binary
 * out from under a claim or a merge that is half done, and that no environment variable exists
 * whose only job is to select the gh an executor trusts.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string} an absolute path, or the bare name when PATH holds no executable gh
 */
export const resolveGh = (env = process.env) => {
  for (const dir of String(env?.PATH || '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'gh')
    try { accessSync(candidate, constants.X_OK); return candidate } catch {}
  }
  return 'gh'
}

/**
 * The child environment for every gh call an executor makes, with GH_REPO and GH_HOST removed.
 *
 * This is the security decision the three copies each held. Every call these executors make is
 * already pinned to the repository derived from the origin remote, and gh reads GH_REPO and
 * GH_HOST as an ambient override of exactly that. Left in place, an inherited GH_REPO would let
 * a claim read its issue from one repository and label another, or a gate read the checks of a
 * pull request nobody named. The variables come off the child environment rather than being
 * checked for, because there is no value of either that an executor wants.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {Record<string,string|undefined>} a copy, so the parent environment is untouched
 */
export const pinnedGhEnv = (env = process.env) => {
  const child = { ...env }
  delete child.GH_REPO
  delete child.GH_HOST
  return child
}

/**
 * Run a command and report it as a value. A nonzero exit, a timeout and a missing binary all come
 * back as the same shape, because every caller here treats them the same way: the read failed and
 * the reason is a string to redact and quote. Used for git as well as gh, which is why the binary
 * and the environment are both arguments.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number, env?: Record<string,string|undefined>}} [options]
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export const execCapture = (bin, args, { cwd, timeoutMs, env } = {}) => {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: 'utf8', timeout: timeoutMs, cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout: String(stdout), stderr: '' }
  } catch (error) {
    return {
      code: error?.status ?? 1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || error?.message || error),
    }
  }
}

/**
 * Put an executor's result on the wire and exit with its code. Every executor returns
 * { code, stdout, stderr } instead of writing and exiting itself, which is what lets a smoke
 * drive it in process; this is the one place that turns that value back into a process outcome.
 *
 * @param {{code: number, stdout?: string, stderr?: string}} result
 * @returns {never}
 */
export const runExecutor = (result) => {
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.code)
}

/**
 * The JSON a command printed, or null when it printed something else. Any JSON value passes,
 * including an array: `gh pr list` and every `gh api --paginate --slurp` read answer with one,
 * and the callers that expect a list check for it themselves. Use parseObject where the answer
 * has to be a single record.
 *
 * @param {unknown} text
 */
export const parseJson = (text) => {
  if (typeof text !== 'string') return null
  try { return JSON.parse(text) } catch { return null }
}

/**
 * The same parse, narrowed to a plain JSON object. An array is not one: a read that asked for a
 * single pull request and was handed a list has not answered the question, and letting it through
 * turns every field access into undefined rather than into the failure it is.
 *
 * @param {unknown} text
 */
export const parseObject = (text) => {
  const value = parseJson(text)
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}
