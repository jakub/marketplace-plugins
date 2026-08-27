// Harness-neutral selection with small, explicit source adapters. Codex seats all
// receive the rules: every skip below is justified by a Claude mechanism (Explore
// returns file paths, fork copies the parent context that already carries the session
// block, codex-delegate relays Codex output verbatim), and none of those justifications
// has been observed on Codex. A Codex skip needs its own captured evidence.

const CLAUDE_SKIP = new Set(['Explore', 'fork', 'codex-delegate', 'flow:codex-delegate'])

export function shouldInjectSubagent({ source, agentType }) {
  if (typeof agentType !== 'string' || agentType === '') return true
  if (source === 'claude' && CLAUDE_SKIP.has(agentType)) return false
  return true
}
