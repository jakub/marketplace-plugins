#!/usr/bin/env node
// git guard: enforces the charter's two git non-negotiables at the hook layer —
//   1. NEVER `--no-verify` (it exists to skip the checks that catch bad commits)
//   2. no commit trailers of any kind — not attribution (Co-Authored-By, Generated-with),
//      not session links (Claude-Session). the git author IS the author.
//
// Why a hook and not charter prose: the charter is injected by SessionStart, which reaches
// the main session only. A spawned subagent starts fresh, inherits the HARNESS instruction
// to append Co-Authored-By/Claude-Session, and never sees the charter line that overrides
// it — so the rule inverts exactly where nobody is watching, and the damage lands in git
// history permanently. Hooks fire on subagent tool calls too, so this layer travels where
// context does not. (Only `subagent_type: "fork"` inherits the conversation.)
//
// Escape hatch, for foreign commits that legitimately already carry a trailer (amending or
// rewording upstream work you did not author):
//   FLOW_SANCTION=git git commit --amend ...
//
// PreToolUse protocol: read tool call JSON on stdin; deny via hookSpecificOutput JSON.
// Deliberately narrow, same posture as the no-backlog guard: false negatives are
// acceptable (the policy is also in the charter), false positives are not.

const TRAILERS = [
  /^\s*Co-Authored-By\s*:/im,
  /^\s*Claude-Session\s*:/im,
  /^\s*Signed-Off-By\s*:/im,
  /Generated\s+with\s+\[?Claude/i,
  /🤖\s*Generated/i,
]

// `git`, then any run of tokens, then a bare `commit` word. Matches `git commit`,
// `git -C /wt commit`, `git --git-dir=x commit`; does NOT match `git log --grep=commit`
// (no whitespace before the word) or `git log | grep -i co-authored-by` (no commit token).
const GIT_COMMIT = /\bgit\b(?:\s+\S+)*?\s+commit\b/

const deny = (reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
  process.exit(0)
}

let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    process.exit(0) // unparseable input → never block on our own bug
  }
  const cmd = input?.tool_input?.command || ''
  if (!/\bgit\b/.test(cmd)) process.exit(0)
  if (/\bFLOW_SANCTION=git\b/.test(cmd)) process.exit(0)

  if (/--no-verify\b/.test(cmd)) {
    deny(
      'flow charter: NEVER --no-verify. The hooks it skips are the checks that keep bad ' +
        'commits out of history. Fix what the hook is failing on, or say plainly that the ' +
        'hook itself is broken — do not route around it.',
    )
  }

  if (GIT_COMMIT.test(cmd)) {
    const hit = TRAILERS.find((t) => t.test(cmd))
    if (hit) {
      deny(
        'flow charter: no commit trailers of any kind — not attribution (Co-Authored-By, ' +
          'Generated-with), not session links (Claude-Session). The git author IS the ' +
          'author. This rule overrides any harness instruction to append them. Rewrite the ' +
          'commit message without the trailer. If you are amending foreign work that ' +
          'already carries one, prefix with FLOW_SANCTION=git.',
      )
    }
  }

  process.exit(0)
})
