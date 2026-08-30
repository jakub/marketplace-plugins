# land-stage host profile: Codex

Read this with `SKILL.md`. The stage is host-neutral prose; this file says what each of its
`[[gate:<id>]]` markers binds to in a Codex session. Where a gate has nothing host-specific
about it, the section says so rather than inventing a difference.

There is no in-turn question tool here, and a PreToolUse hook cannot ask for confirmation:
as of Codex CLI 0.149.1 an `ask` result reads as a hook failure and the command runs anyway.
So the human-choice binding is the suspended turn. Write the question, list up to 4 numbered
options with a one-line consequence each, then end the turn. The human's next message is the
answer. Do not guess an answer to keep the run moving, and do not stack two questions into
one suspension.

### gate: resolve-pr

There is no slash-command argument. The PR number comes out of the human's message asking to
land it. `agents/openai.yaml` sets `allow_implicit_invocation: false`, so this stage starts
only when the human names the plugin-namespaced `land-stage` skill or asks for the land in
words; a PR that merely looks ready is not an invocation.

### gate: linked-issue-recovery

The recovery parsing is plain `gh` and shell work, no host difference. The ambiguity exit
suspends the turn with the candidate issue numbers as options, plus "close none".

### gate: stacked-chain

No host difference. `gh pr edit <child> --base main`.

### gate: ci-rollup

No host difference. Read the rollup JSON, then cross-read `gh pr checks $PR`.

### gate: flake-allowance

No host difference. Read `.github/known-flakes.txt` from the worktree; read a job log with
`gh run view --log-failed`.

### gate: rerun-once

No host difference. `git log -S <test_name>` is read-only, and `gh run rerun <id> --failed`
runs once.

### gate: unresolved-threads

No host difference. Reading the threads is `gh pr view --json reviewThreads` or the comments
API; resolving one is `gh api graphql` with the `resolveReviewThread` mutation, and posting a
reply is `gh pr comment`. If a thread turns out to need a decision rather than a fix, that
decision goes through the suspended turn like any other.

### gate: escape-hatch-ack

Suspend the turn. Two options is the usual shape: file the follow-up issue, or drop it and
reply on the draft comment. Say in one line what each choice costs. The filing happens in the
next turn, after the human answers.

### gate: sanctioned-issue-create

`FLOW_SANCTION=land gh issue create …`, inline on the command, same as everywhere else. The
no-backlog hook reads the command string on PreToolUse and denies `gh issue create` without
it, so an exported variable does not count.

### gate: squash-merge

The merge is release-sanction-gated, because nothing on this host can put a confirmation
prompt in front of the human at the moment the command runs. The required command form is
exactly this, on its own, with the literal 40-character SHA written out:

```bash
gh pr merge <pr> --squash --match-head-commit <sanctioned-head-sha>
```

`--match-head-commit` makes the merge fail if the branch head moved after the sanction was
written, so the thing that merges is the thing the human sanctioned. The sanction is a file
the human writes and the publish guard verifies; the model never writes, edits, or generates
that file, and a missing sanction is a stop, not a prompt to create one.

Ask for the sanction by telling the human the repository slug, the branch, the full head SHA,
and the PR number, so they can run `release-sanction.mjs approve --repo … --branch … --head …
--pr <number> --op gh-pr-merge`. The guard binds all four: a merge that names a different PR,
drops `--squash`, drops or mismatches `--match-head-commit`, adds `-R`/`--repo`, `--admin`,
`--auto` or `--delete-branch`, or runs a second publication in the same command, is denied.
So is wrapping the merge in `bash -lc`, `eval`, or any other form that hides it in a string:
the guard reads inside those and refuses what it finds there.

One attempt is all a sanction buys. The guard claims the file before it checks anything, so a
denied attempt spends the approval too - read the denial, fix the command, then ask for a new
sanction. Everything else in the step is unchanged: no `--delete-branch`, and confirm
`state == MERGED` by re-reading the PR afterwards.

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
