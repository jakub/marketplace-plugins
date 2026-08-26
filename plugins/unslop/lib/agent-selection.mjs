// Harness-neutral selection with small, explicit source adapters. Unknown Codex seats
// receive the rules by default; skipping is an optimization and must be proven safe.

const COMMON_SKIP = new Set(['fork', 'codex-delegate', 'flow:codex-delegate'])
const CLAUDE_SKIP = new Set(['Explore'])

export function shouldInjectSubagent({ source, agentType }) {
  if (typeof agentType !== 'string' || agentType === '') return true
  if (COMMON_SKIP.has(agentType)) return false
  if (source === 'claude' && CLAUDE_SKIP.has(agentType)) return false
  return true
}
