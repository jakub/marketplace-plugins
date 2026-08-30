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
file, the publish guard denies every merge spelling it recognizes, because nothing on this
host can put a confirmation prompt in front of the human at the moment a command runs. The
merge runs through flow's executor instead:

```bash
node <plugin-root>/scripts/land-merge.mjs <pr>
```

The ceremony, in order. Suspend the turn and give the human the repository slug, the branch,
the full 40-character head SHA, the pull request number, and one line on what landing it
changes. They approve it in their own terminal:

```bash
node <plugin-root>/scripts/release-sanction.mjs approve --repo <owner/name> --branch <branch> --head <sha> --pr <number> --op gh-pr-merge
```

Never run that yourself. The guard denies it, and an approval the session can write approves
nothing. A missing sanction is a stop, not a prompt to create one. Once the human says they
have written it, run the executor.

The executor takes the pull request number and nothing else, so there is no command form to
get right. It claims the sanction first, then re-derives the repository slug from the origin
remote and reads the head SHA, state, draft flag and base branch from GitHub. It refuses
unless all of those match the approval and the pull request is open, ready for review, and
targeting the default branch. Then it merges with `--squash` and `--match-head-commit
<sanctioned head>`, which is GitHub's own re-check that the branch did not move, and re-reads
the pull request to confirm `MERGED`. Its exit code is the gate: 0 with the merge confirmed,
or 1 with one line on stderr naming what failed.

One attempt is all a sanction buys, whatever the outcome. The claim happens before any check,
so a refusal spends the approval too. Read the reason, fix what it names, then ask for a new
sanction. Everything else in the step is unchanged: no `--delete-branch`.

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
