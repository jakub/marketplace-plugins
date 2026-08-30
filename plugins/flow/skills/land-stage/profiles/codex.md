# land-stage host profile: Codex

Read this with `SKILL.md`. The stage is host-neutral prose; this file says what each of its
`[[gate:<id>]]` markers binds to in a Codex session. Where a gate has nothing host-specific
about it, the section says so rather than inventing a difference.

There is no in-turn question tool here, and a PreToolUse hook cannot ask for confirmation:
as of Codex CLI 0.151.0 an `ask` result reads as a hook failure and the command runs anyway.
So the human-choice binding is the suspended turn. Write the question, list up to 4 numbered
options with a one-line consequence each, then end the turn. The human's next message is the
answer. Do not guess an answer to keep the run moving, and do not stack two questions into
one suspension.

## Gates

### gate: resolve-pr

There is no slash-command argument. The PR number comes out of the human's message asking to
land it. `agents/openai.yaml` sets `allow_implicit_invocation: false` as the intended way to
keep this stage out of automatic selection, but that suppression is unverified on Codex's
plugin-loader path (the capability inventory in `src/delegation/contracts.mjs` marks it
`supported: false`), so do not lean on it. The actual gate is the human: this stage runs only
when they name the plugin-namespaced `land-stage` skill or ask for the land in words, and a PR
that merely looks ready is never an invocation.

### gate: linked-issue-recovery

The recovery parsing is plain `gh` and shell work, no host difference. The ambiguity exit
suspends the turn with the candidate issue numbers as options, plus "close none".

### gate: stacked-chain

No host difference. `gh pr edit <child> --base main`.

### gate: ci-rollup

No host difference. Read the rollup JSON, then cross-read `gh pr checks $PR`.

### gate: flake-allowance

No host difference. The allowlist read is `git show origin/$BASE_REF:.github/known-flakes.txt`
after a fetch - the base branch's copy, as the stage requires, never the PR's. A job log is
`gh run view --log-failed`.

### gate: rerun-once

No host difference. `git log origin/$BASE_REF..HEAD -S <test_name>` is read-only, and
`gh run rerun <id> --failed` runs once.

### gate: unresolved-threads

No host difference. The read and both mutations are `gh api graphql` calls, exactly as the
stage writes them. If a thread turns out to need a decision rather than a fix, that decision
goes through the suspended turn like any other.

### gate: escape-hatch-ack

Suspend the turn. Two options is the usual shape: file the follow-up issue, or drop it and
reply on the draft comment. Say in one line what each choice costs. The filing happens in the
next turn, after the human answers.

### gate: sanctioned-issue-create

`FLOW_SANCTION=land gh issue create …`, inline on the command, same as everywhere else. The
no-backlog hook reads the command string on PreToolUse and denies `gh issue create` without
it, so an exported variable does not count.

### gate: squash-merge

You do not write the merge command. In a repository that carries a committed `.flow/managed`
file, the publish guard denies every raw merge spelling it recognizes and points at flow's
executor, which is how the merge runs on this host:

```bash
node <plugin-root>/scripts/land-merge.mjs <pr>
```

The authorization is the same one every host uses: the human asked to land this pull request
(the resolve-pr gate's origin rules), and the stage's gates passed. There is no approval
ceremony beyond that. What the executor adds over a raw `gh pr merge` is that nothing about
the merge is taken from the conversation: it takes the pull request number and nothing else,
derives the host, owner and repository from the origin remote, pins every gh call to that
repository, reads the head SHA, state, draft flag and base branch from GitHub, and refuses a
closed or draft pull request, a base that is not the default branch, an armed auto-merge, or
a merge queue on the base - it only ever performs an immediate squash-merge and will not
leave an armed future merge behind. Then it merges with `--squash` and `--match-head-commit`
pinned to the head it just verified, GitHub's own re-check that the branch did not move, and
re-reads the pull request. Do not route around a guard denial with another spelling; the
denial means take the executor path.

Its exit code is the gate. Exit 0 means the re-read confirmed the pull request merged and is
still the head, base and host-qualified repository the run verified: your merge, landed. Exit 1
with `refused` on stderr means a check failed before anything ran, or gh gave a clean rejection
with the pull request still open, and nothing landed. Read the reason and fix what it names. Any
other exit 1 is neither a clean success nor a clean failure, and it is not for you to guess: a
lost confirming read, a pull request that reads `MERGED` but no longer matches what was verified
(someone else may have merged the same number), or an armed auto-merge or merge queue that may
still land it later. Look at the pull request yourself before doing anything else, do not re-run
the executor blindly, and do not report it as either merged or failed.

Everything else in the step is unchanged: no `--delete-branch`.

### gate: issue-closure

No host difference. `gh issue view`, then `gh issue close --comment` for anything still open.

### gate: remote-branch-delete

No host difference. `git push origin --delete $HEAD_REF`, best effort, non-zero exit ignored.

### gate: evidence-preservation

No host difference. The re-resolve check is `gh api …/contents/<path>?ref=<sha> --jq .sha`.

### gate: worktree-retirement

No host difference. `git worktree remove`, then `git branch -D <branch>`; git-guard allows
both, and the reflog is the undo.

### gate: repo-teardown

The teardown is whatever the repo's `AGENTS.md` documents, run as ordinary shell commands.
There is no per-tool allowance to widen here, so the only limits are the sandbox and approval
policy the session already runs under. Skip when the file documents none.

### gate: memory-stamp

Edit the project's note with `apply_patch`, the same way any other file gets edited. Skip when
the project keeps no such note, and never invent one to have something to stamp.

### gate: survey

No host difference. Read-only `gh pr list`, `gh issue list`, `git worktree list`, then a
ranked menu in the final message.
