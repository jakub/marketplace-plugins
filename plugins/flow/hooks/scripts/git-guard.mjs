#!/usr/bin/env node
// git guard: enforces the charter's two git non-negotiables at the hook layer -
//   1. NEVER `--no-verify` (it exists to skip the checks that catch bad commits)
//   2. no commit trailers of any kind - not attribution (Co-Authored-By, Generated-with),
//      not session links (Claude-Session). the git author IS the author.
//
// Why a hook and not charter prose: the charter is injected by SessionStart, which reaches
// the main session only. A spawned subagent starts fresh, inherits the HARNESS instruction
// to append Co-Authored-By/Claude-Session, and never sees the charter line that overrides
// it - so the rule inverts exactly where nobody is watching, and the damage lands in git
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

// Prose about a rule is not a breach of it. `--no-verify` inside a quoted string or a heredoc
// body is text being handed to some other command - a PR comment, a commit body, a gripe
// describing this very guard - not a flag being handed to git. Matching the raw command
// string blocked all three, which is how a guard turns into something people route around.
// Strip shell literals first, then match.
//
// The trailer check below deliberately does NOT strip: a trailer lives inside the quoted
// commit message, which is precisely where it has to be caught.
const stripLiterals = (s) =>
  s
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2/gm, ' ')
    .replace(/'[^']*'/g, ' ')
    .replace(/"[^"]*"/g, ' ')

// Irreversible git: operations that destroy work no reflog returns. The bar is deliberately
// narrow. `reset --hard` and `branch -D` are NOT here - the reflog does return those, and
// blocking them breaks the ordinary squash-merge flow (a squashed branch is no ancestor of
// main, so `-d` refuses it) for no safety earned.
//
// Each pattern is bounded to a single shell command with `[^;&|]*`, so a later invocation
// cannot hide behind an earlier read (`git log && git push --force`), and every one is
// matched against stripLiterals(cmd) so prose about a rule is not a breach of it.
const DESTRUCTIVE = [
  [
    /\bgit\b[^;&|]*\bpush\b[^;&|]*(?:--force(?!-with-lease)|\s-f(?=\s|$))/,
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

// Subcommands that cannot write a ref in any form. `symbolic-ref`, `fetch`, and
// `branch` each have read AND write forms and are NOT here - they're handled below.
const CRON_READ = new Set([
  'status', 'log', 'shortlog', 'show', 'diff', 'blame', 'grep',
  'rev-parse', 'rev-list', 'merge-base', 'describe', 'cat-file', 'check-ignore',
  'ls-files', 'ls-tree', 'ls-remote', 'for-each-ref', 'show-ref',
  'version', 'help',
])
// Branch options that put `branch` in list/read mode and legitimately take a ref
// argument (so a positional after them is not a create target).
const BRANCH_LIST_OPTS = new Set([
  '--list', '--merged', '--no-merged', '--contains', '--no-contains',
  '--points-at', '--sort', '--format', '--show-current', '-l',
])

// Return a deny reason, or null to allow. Evaluates EVERY git invocation in the command
// string; one disallowed invocation denies the whole call. Over-blocking is acceptable in
// cron mode (the job just reports the refusal); under-blocking is not - the allowlist is
// the job's authority. Cron git is READ-ONLY for every job: the lint's two destructive
// actions run through scripts/lint-actions.mjs, which re-derives the safety conditions
// deterministically; the model never runs the mutating git itself.
//
// Tokenizing on whitespace alone loses any invocation glued to a shell operator:
// `git log --oneline&&git push` split as [git, log, --oneline&&git, push], the scan saw
// only the allowed `log`, and the push went through both this guard and `Bash(git:*)`.
// So every operator and quote character becomes its own token first. That also uncovers
// `bash -c "git push"` and `$(git push)`. It over-blocks a quoted "git push" inside a
// --grep, which is the direction this file already chose.
// Variable indirection (`G=git; $G push`) still slips past - only a real shell parser
// closes that - so a `=git` suffix counts as a git token and the Bash allowlist, which
// permits no bare assignment prefix, carries the rest.
const isGitToken = (t) => /(^|[/=])git$/.test(t)

const cronVerdict = (cmd, job) => {
  const tokens = cmd.replace(/[;|&()<>\n`'"]/g, ' $& ').split(/\s+/).filter(Boolean)
  const valueOpts = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
  for (let i = 0; i < tokens.length; i++) {
    if (!isGitToken(tokens[i])) continue
    // Skip global options (and their values) to find the subcommand.
    let j = i + 1
    while (j < tokens.length && tokens[j].startsWith('-')) {
      if (valueOpts.has(tokens[j])) j += 2
      else j += 1
    }
    const sub = tokens[j] || ''
    const rest = tokens.slice(j + 1)
    const next = rest.find((t) => !t.startsWith('-')) || ''
    const no = (why) =>
      `flow cron guard (${job}): git ${sub || '<none>'} is outside this job's permissions${why ? ` - ${why}` : ''}. ` +
      'Cron git is read-only; the lint mutates only through scripts/lint-actions.mjs. ' +
      'Report the need instead of working around this.'

    if (CRON_READ.has(sub)) continue
    if (sub === 'worktree') {
      if (next === 'list') continue
      return no('only `worktree list` here')
    }
    if (sub === 'branch') {
      // Any short bundle carrying a write letter (D/d delete, m/M move, c/C copy,
      // f force) - catches -Df and other combined forms the old single-char test missed.
      const shortWrite = rest.some((t) => /^-[a-zA-Z]*[DdmMcCf]/.test(t) && !t.startsWith('--'))
      const longWrite = rest.some((t) => /^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(t))
      if (shortWrite || longWrite) return no('branch may only be listed')
      // A bare positional with no list-mode option present is a create target
      // (`git branch <name> [<start>]`). List forms always carry a list option.
      const hasListOpt = rest.some((t) => BRANCH_LIST_OPTS.has(t) || /^--(sort|format|points-at|contains|no-contains|merged|no-merged)=/.test(t))
      const positional = rest.some((t) => !t.startsWith('-'))
      if (positional && !hasListOpt) return no('branch may only be listed, not created')
      continue
    }
    if (sub === 'symbolic-ref') {
      // Read: `symbolic-ref [--short] <name>` (one positional). Write: a second
      // positional (the target ref) or -d/--delete.
      if (rest.some((t) => t === '-d' || t === '--delete')) return no('symbolic-ref is read-only')
      if (rest.filter((t) => !t.startsWith('-')).length > 1) return no('symbolic-ref may not repoint a ref')
      continue
    }
    if (sub === 'fetch') {
      // A refspec with an explicit destination (`<src>:<dst>`) writes an arbitrary
      // local ref. Plain `fetch origin main` / `--prune` carries no colon.
      if (rest.some((t) => !t.startsWith('-') && t.includes(':'))) return no('fetch may not write an explicit refspec destination')
      continue
    }
    if (sub === 'remote') {
      if (next === '' || next === 'get-url' || next === 'show') continue
      return no('remotes are read-only')
    }
    return no('')
  }
  return null
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

  // Cron mode: when flow-cron.mjs spawned this session it exported FLOW_CRON_JOB, and
  // hooks inherit that env. The scheduled jobs read untrusted text (issue bodies, PR
  // titles, repo files), so here git is deny-by-default: only the subcommands the job's
  // standing permissions name may run, and FLOW_SANCTION is ignored - an injected
  // instruction can put the sanction string in a command, but it cannot change this
  // process's environment. Interactive sessions are untouched. Env source of truth:
  // scripts/flow-cron.mjs; keep the write set in step with the prompts in skills/flow/cron/.
  const cronJob = process.env.FLOW_CRON_JOB || ''
  if (cronJob) {
    const verdict = cronVerdict(cmd, cronJob)
    if (verdict) deny(verdict)
    process.exit(0) // cron sessions never commit, so the trailer rules below are moot
  }

  if (/\bFLOW_SANCTION=git\b/.test(cmd)) process.exit(0)

  if (/--no-verify\b/.test(stripLiterals(cmd))) {
    deny(
      'flow charter: NEVER --no-verify. The hooks it skips are the checks that keep bad ' +
        'commits out of history. Fix what the hook is failing on, or say plainly that the ' +
        'hook itself is broken - do not route around it.',
    )
  }

  const bare = stripLiterals(cmd)

  for (const [re, why] of DESTRUCTIVE) if (re.test(bare)) deny(why)

  if (CLEAN_FORCE.test(bare) && !CLEAN_DRYRUN.test(bare)) {
    deny(
      'flow charter: `git clean -f` deletes untracked files permanently - nothing recovers ' +
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
})
