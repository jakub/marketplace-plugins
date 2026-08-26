// gripe: write-time context capture. Everything here is read from the environment and
// never typed by the agent, per the schema's source column.

import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

const git = (args) => {
  try {
    return execFileSync('git', args, { timeout: 1500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/** Session id, cwd and git facts at the moment of writing. Null-safe outside a repo. */
export function captureContext() {
  const toplevel = git(['rev-parse', '--show-toplevel'])
  return {
    session_id:
      process.env.CLAUDE_CODE_SESSION_ID ||
      process.env.CODEX_SESSION_ID ||
      process.env.CODEX_THREAD_ID ||
      'unknown',
    cwd: process.cwd(),
    repo: toplevel ? basename(toplevel) : null,
    git_sha: git(['rev-parse', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  }
}

/** Ids that land in filenames or advertised command literals get a strict alphabet. */
export const safeId = (v) =>
  typeof v === 'string' && /^[\w.-]{1,64}$/.test(v) ? v : null
