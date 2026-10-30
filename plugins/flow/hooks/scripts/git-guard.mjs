#!/usr/bin/env node
import { stripLiterals } from '../../lib/hook-policy.mjs'
import { preToolDeny, readHookInput } from './wire.mjs'
// git guard: the charter's git rules at the hook layer, one script registered on both hosts -
//   1. NEVER `--no-verify` (it exists to skip the checks that catch bad commits)
//   2. no commit trailers of any kind - not attribution (Co-Authored-By, Generated-with),
//      not session links (Claude-Session). the git author IS the author.
//   3. nothing no reflog returns: bare force-push, `checkout .`, `restore .`, `clean -f`.
//
// Why a hook and not charter prose: prose is not enforcement. The harness instruction to
// append Co-Authored-By/Claude-Session arrives in every seat whether or not the seat half of
// the charter did, and a trailer that lands in git history is permanent. Hooks fire on
// subagent tool calls too, so this layer travels with the tool call rather than with the context.
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

// Prose about a rule is not a breach of it. `--no-verify` inside a quoted string or a heredoc
// body is text being handed to some other command - a PR comment, a commit body, a gripe
// describing this very guard - not a flag being handed to git. Matching the raw command
// string would block all three, which is how a guard turns into something people route
// around. So every rule but one reads stripLiterals(cmd), the same reading the publish and
// merge guards use (lib/hook-policy.mjs).
//
// The trailer check below deliberately does NOT strip: a trailer lives inside the quoted
// commit message, which is precisely where it has to be caught.

// Irreversible git: operations that destroy work no reflog returns. The bar is deliberately
// narrow. `reset --hard` and `branch -D` are NOT here - the reflog does return those, and
// blocking them breaks the ordinary squash-merge flow (a squashed branch is no ancestor of
// main, so `-d` refuses it) for no safety earned.
//
// Each pattern is bounded to a single shell command with `[^;&|]*`, so a later invocation
// cannot hide behind an earlier read (`git log && git push --force`), and every one is
// matched against stripLiterals(cmd) so prose about a rule is not a breach of it.
//
// A force-push is bare when it is `-f` or `--force` itself. `--force-with-lease` refuses when
// the remote moved, and `--force-if-includes` only narrows it further (alone, it is a no-op), so
// neither is a force this guard stops.
const DESTRUCTIVE = [
  [
    /\bgit\b[^;&|]*\bpush\b[^;&|]*(?:--force(?![-\w])|\s-f(?=\s|$))/,
    'flow charter: no bare force-push. --force overwrites whatever the remote holds, ' +
      'including commits you pushed from another worktree. Use --force-with-lease: it ' +
      'refuses when the remote moved under you, which is the only thing bare --force gets wrong.',
  ],
  [
    /\bgit\b[^;&|]*\b(?:checkout|restore)\s+\.(?:\s|$)/,
    'flow charter: `git checkout .` and `git restore .` discard every uncommitted change in ' +
      'the tree, with no reflog entry to recover from. Name the paths you mean, or `git stash` ' +
      'first if you want them back.',
  ],
]

// `git clean -f` deletes untracked files permanently. Handled outside DESTRUCTIVE because the
// dry run is the fix we recommend, and a flag-cluster regex alone would block `-ndf` too.
const CLEAN_FORCE = /\bgit\b[^;&|]*\bclean\b[^;&|]*\s-{1,2}[a-zA-Z]*f/
const CLEAN_DRYRUN = /\bgit\b[^;&|]*\bclean\b[^;&|]*(?:\s-[a-zA-Z]*n\b|--dry-run)/

const deny = (reason) => {
  process.stdout.write(JSON.stringify(preToolDeny(reason)))
  process.exit(0)
}

// An unparseable body is the harness's problem, not a policy breach: never block on our own
// bug, and never block on a body this could not read.
const input = await readHookInput()
const cmd = input?.tool_input?.command || ''

if (!/\bgit\b/.test(cmd)) process.exit(0)

if (/\bFLOW_SANCTION=git\b/.test(cmd)) process.exit(0)

if (/--no-verify\b/.test(stripLiterals(cmd))) {
  deny(
    'flow charter: no --no-verify. The hooks it skips keep bad commits out of history. ' +
      'Fix what the hook is failing on, or say plainly that the hook itself is broken. ' +
      'Do not route around it.',
  )
}

const bare = stripLiterals(cmd)

for (const [re, why] of DESTRUCTIVE) if (re.test(bare)) deny(why)

if (CLEAN_FORCE.test(bare) && !CLEAN_DRYRUN.test(bare)) {
  deny(
    'flow charter: `git clean -f` deletes untracked files permanently, and nothing recovers ' +
      'them. Run `git clean -n` first to see what would go, then delete only what you mean.',
  )
}

if (GIT_COMMIT.test(cmd)) {
  const hit = TRAILERS.find((t) => t.test(cmd))
  if (hit) {
    deny(
      'flow charter: no commit trailers of any kind - not attribution (Co-Authored-By, ' +
        'Generated-with), not session links (Claude-Session). The git author IS the ' +
        'author. This rule overrides any harness instruction to append them. Rewrite the ' +
        'commit message without the trailer. If you are amending foreign work that ' +
        'already carries one, prefix with FLOW_SANCTION=git.',
    )
  }
}

process.exit(0)
