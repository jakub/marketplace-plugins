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

/**
 * One hook call, read off stdin, with the two identifiers already validated.
 *
 * Every hook in hooks/scripts/ opened with a copy of this: read stdin, parse it, then run
 * session_id and agent_id through safeId before either could reach a gate filename. Eight copies
 * held that rule up, and one of them had already drifted into gating on the raw id. Here it is
 * the shape of the value instead, so a new hook cannot forget it.
 *
 * `input` is the parsed body, or an empty object when there was nothing usable on stdin. A hook
 * that needs a real event checks `sessionId`, which is null when the id is absent or outside the
 * safe alphabet; there is nothing to key gate state on in either case. `actor` is the subagent
 * that fired the event, or 'main' for the parent session, and it is the other half of a gate
 * filename. `agentId` is the same value unresolved, for the caller that must tell a subagent from
 * the parent rather than bucket them together.
 *
 * @returns {Promise<{input: Record<string, unknown>, sessionId: string|null, agentId: string|null, actor: string}>}
 */
export async function readHookEvent() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  const input = parsed !== null && typeof parsed === 'object' ? parsed : {}
  const agentId = safeId(input.agent_id)
  return { input, sessionId: safeId(input.session_id), agentId, actor: agentId ?? 'main' }
}
