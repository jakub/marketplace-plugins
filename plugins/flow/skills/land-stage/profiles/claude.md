# land-stage host profile: Claude Code

Read this with `SKILL.md`. The stage is host-neutral prose; this file says what each of its
`[[gate:<id>]]` markers binds to in a Claude Code session. Where a gate has nothing
host-specific about it, the section says so rather than inventing a difference.

Tool allowance for the stage, and the one `/flow:land` declares in its frontmatter:

allowed-tools: Bash(gh:*), Bash(git:*), Bash(docker:*), Bash(ls:*), Read, Edit, AskUserQuestion

The human-choice binding is the AskUserQuestion tool: up to 4 questions per call, each with
selectable options, and the answer comes back inside the same turn. Never replace it with a
prose question the human has to answer in an essay.

### gate: resolve-pr

`$ARGUMENTS` from the `/flow:land` invocation is the PR number. Empty means resolve from the
current branch. The stage runs because the human typed the command, which is the explicit
request; nothing else in the session authorizes it, and a green build in the transcript is
not a request to land.

### gate: linked-issue-recovery

The recovery parsing is plain `gh` and shell work, no host difference. The ambiguity exit
goes through AskUserQuestion, one question listing the candidate issue numbers with "close
none" as an explicit option.

### gate: stacked-chain

No host difference. `gh pr edit <child> --base main` runs under the `Bash(gh:*)` allowance.

### gate: ci-rollup

No host difference. Both `gh pr view --json statusCheckRollup` and `gh pr checks` run under
`Bash(gh:*)`.

### gate: flake-allowance

No host difference. Reading `.github/known-flakes.txt` is the Read tool; reading a job log is
`gh run view --log-failed`.

### gate: rerun-once

No host difference. `git log -S <test_name>` and `gh run rerun <id> --failed` are both inside
the allowance, and git-guard passes read-only `git log`.

### gate: unresolved-threads

No host difference. Reading the threads is `gh pr view --json reviewThreads` or the comments
API; resolving one is `gh api graphql` with the `resolveReviewThread` mutation, and posting a
reply is `gh pr comment`.

### gate: escape-hatch-ack

AskUserQuestion, one question, options for file it and drop it with the consequence on each.
The turn continues with the answer, so the ack and the filing happen in one run.

### gate: sanctioned-issue-create

`FLOW_SANCTION=land gh issue create …`, inline on the command. The no-backlog PreToolUse hook
reads the command string and denies `gh issue create` without that prefix, so the sanction
has to be part of the same Bash call, not exported earlier.

### gate: squash-merge

`gh pr merge $PR --squash`, under the ask-gated guard: the PreToolUse chain returns
`permissionDecision: ask` for anything irreversible, and Claude Code turns that into a
confirmation prompt the human answers before the command runs. That prompt is the gate, so
the merge command is issued exactly once and never pre-approved in a batch.

### gate: issue-closure

No host difference. `gh issue view`, then `gh issue close --comment` for anything still open.

### gate: remote-branch-delete

No host difference. `git push origin --delete $HEAD_REF` is a delete of a remote ref that
just merged, so git-guard lets it through; a non-zero exit here is expected and ignored.

### gate: evidence-preservation

No host difference. The re-resolve check is `gh api …/contents/<path>?ref=<sha> --jq .sha`.

### gate: worktree-retirement

No host difference in the commands. `git worktree remove` and `git branch -D` are both
deliberately absent from git-guard's deny list, because the reflog returns them and blocking
`branch -D` would break exactly this step.

### gate: repo-teardown

`Bash(docker:*)` and `Bash(ls:*)` exist in the allowance for this gate and nothing else. The
teardown is whatever the repo's `AGENTS.md` documents; if the file documents none, skip.

### gate: memory-stamp

The project note lives under the session's memory directory
(`~/.claude/projects/<slug>/memory/`), and the edit is the Edit tool on that file. Skip when
the project keeps no note.

### gate: survey

No host difference. Read-only `gh pr list`, `gh issue list`, `git worktree list`, then a
ranked menu in the final message.
