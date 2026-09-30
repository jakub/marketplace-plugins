---
name: land
description: Land one named pull request through the flow gates: the CI and unresolved-thread checks, the follow-up-draft ack, the squash-merge, explicit issue closure, worktree retirement, and a survey of what to do next. The only merge path. MUST only run when the human explicitly asks to land a specific PR; never start it from adjacent work, a finished review, or a green build.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(node:*), Bash(docker:*), Bash(ls:*), Read, Edit, AskUserQuestion, mcp__plugin_flow_flow_delegate__delegate_to_codex, mcp__plugin_flow_flow_delegate__delegation_result, mcp__plugin_flow_flow_delegate__delegation_cancel, mcp__plugin_flow_flow_delegate__delegation_doctor
---

# land: the human gate

A merge is the hardest step to reverse, so anything that looks wrong goes to the human. Prove each outcome by reading state back, because a failed command and a silent no-op look the same. An unresolved thread blocks the merge even when it arrived after the run finished. Housekeeping never blocks the land. Everything above `## Host mechanics` is the same on every host.

## 1. Gate

The argument is a PR number, or nothing, which resolves the PR from the current branch. Three origins authorize it: the argument, the human's invocation resolving the current branch, or the human naming the PR in words. Anything else is a stop.

Run `node <plugin-root>/scripts/land-gates.mjs [<pr>]` from the repository root. It is read-only and prints one JSON object with `verdict`, `stops` and `attention`. Exit 0 is `pass`, 1 is `stop`, and 4 is a failed read, which is never a pass. Exit 2 is a usage refusal with no JSON, so read stderr and fix the call, passing the number if it refused to resolve the current branch.

Record `head.sha`, which every gate inspected and the merge pins to, and `head.ref`, `base.ref`, `base.default`, `isCrossRepository` and `linkedIssues`.

Each stop has a fixed answer:

- `not-open`, `draft`: abort.
- `stacked-on-non-default`: the PR is stacked on another one. Land the parent first or retarget this one, and stop either way.
- `ci-pending`: wait briefly and run the executor again. Still pending: report it and stop.
- `ci-failed`: abort and show it, except under the rerun-once valve below.
- `ci-unknown`: an errored, stale or nameless check is unknown, and so is an empty rollup, which is how a PR looks right after a push. Abort and show it.
- `threads-unresolved`: §2.
- `auto-merge-armed`, `merge-queue`: someone armed a merge that would land the PR out of sight. Tell the human, and never merge over it.
- `head-unreadable`, `threads-unreadable`, or any exit 4: a read failed. Fix the read and run the executor again.

Each attention entry has a fixed answer too:

- `children`: open PRs are based on this branch. Retarget them first with `gh pr edit <child> --base <base.default>`, tell the human the rebases they will need, and run the executor again.
- `flaky-merged-through`: the base branch's `.github/known-flakes.txt` names a failing check. Note it in the land report and continue. A `check:test` entry only adds a candidate under `ci.flakeCandidates`. Read the job log with `gh run view --log-failed`, and only when that test is the job's sole failure, run the executor again with `--accept-flake <check>:<test>` and name it in the land report.
- `flakes-added-on-pr`: the PR's own copy of the flake list adds entries. A branch must not approve its own failures, so flag the diff and allow nothing from it.
- `linked-issues-ambiguous`: only `linkedIssues.linked`, which GitHub parsed, closes on its own. `recovered` came from the branch name or a closing phrase and is a candidate, because a regex cannot tell `fixes #17` from `does not fix #17`. `mentions` close nothing. Ask the human, listing the candidates and "close none". With all three lists empty, note "no linked issues" and continue.
- `follow-up-draft`: §3.

**The rerun-once valve** covers a suite check that fails on one test, when all three conditions hold. The test predates this PR: `git log origin/<base.ref>..HEAD -S <test_name>` finds no commit (an unbounded `-S` finds the commit that added the test on main). Its file does not overlap the PR diff. The failure is timing-shaped, such as a timeout or pool starvation, not an assertion on values. Then rerun the failed job once with `gh run rerun <id> --failed`, run the executor again, and note the rerun. Red twice on the same code is real, so abort. Never rerun an assertion failure.

## 2. Threads

The executor lists each unresolved thread under `threads.unresolved` with its `id`, `path`, `url`, author and newest message. Each thread ends fixed (resolve it and note the commit), answered with the run's reply standing (resolve it), or open, which means a quick fix on the branch or another fix round. A thread that needs a decision goes to the human.

Reply and resolve are two GraphQL mutations. `gh pr comment` is neither: it posts a new top-level comment, which leaves the thread open and the gate red.

```bash
gh api graphql -f query='mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) {
    comment { url }
  }
}' -f thread=<thread-id> -f body='<reply>'

gh api graphql -f query='mutation($thread: ID!) {
  resolveReviewThread(input: {threadId: $thread}) { thread { isResolved } }
}' -f thread=<thread-id>
```

The input fields differ: `pullRequestReviewThreadId` on the reply and `threadId` on the resolve. Swapping them is a schema error, not a silent no-op. Read `thread.isResolved` back, and run the executor again at the end. Zero unresolved threads is the only pass.

## 3. Follow-up draft

A `## follow-up draft` comment, reported under `followUpDraft`, holds findings the run deferred as too large for the PR. Ask the human whether to file it or drop it, with the cost of each. To file it, run `FLOW_SANCTION=land gh issue create --title ... --body ... --label needs-triage` with the sanction inline, because the no-backlog hook reads the command string. The body links this PR, and the new issue still enters through prep. To drop it, reply to the draft comment saying it was dropped on purpose.

## 4. Merge and close

1. Merge only after a `pass` from the gate executor with no mutation since. If you retargeted children, touched threads or filed the follow-up, run it again and take `head.sha` from that run. Then run this exactly once, never batched with other work:

   ```bash
   node <plugin-root>/scripts/land-merge.mjs <pr> <head.sha>
   ```

   Exit 0 means a re-read proved the merge. Exit 1 with `refused` on stderr means nothing landed: fix what it names, and if the head moved, run the gates again rather than merging a new SHA. Any other exit 1 is unproven either way, so look at the PR yourself, do not re-run blindly, and report neither merged nor failed. Never route around a denied raw merge with another spelling.
2. If `isCrossRepository` is false, delete the remote branch with `git push origin --delete <head.ref>`, where "remote ref does not exist" is fine. On a fork PR, skip this and say so, because that command would delete an unrelated base-repository branch of the same name.
3. For each issue in `linkedIssues.linked`, plus any candidate the human confirmed, read `gh issue view <N> --json state`. A squash commit's `(#N)` closes nothing. If the issue is still open, run `gh issue close <N> --comment "Landed via PR #<pr> (<url>)."`. Report every linked issue's final state.

## 5. Cleanup

1. `git worktree list` names the canonical checkout, `$MAIN_WT`: the first entry, or wherever `main` is checked out. Run `git -C $MAIN_WT pull --ff-only`, switching it to main first only if it is on another branch. A `git switch main` from the issue worktree fails, because main is checked out there.
2. Remove the worktree from outside it with `git -C $MAIN_WT worktree remove <path>`. If your shell is inside it, use absolute paths from here on. Delete the local branch with `git branch -D <branch>`: `-d` refuses a squash-merged branch, and the merge executor already proved the land. Finish with `git fetch --prune`.
3. Never delete, force-push or rewrite `flow-evidence`, or the repository's own evidence branch. The PR ledger embeds its captures as SHA-pinned URLs that resolve only while those commits survive. Remove any stray worktree the evidence commit used, and check that one committed capture still resolves: `gh api repos/{owner}/{repo}/contents/<path>?ref=<sha> --jq .sha`.
4. If the repository's `AGENTS.md` documents per-worktree resources such as test databases or containers, run its teardown, best effort. Never touch the canonical or shared instance.
5. If a project memory note tracks this work, mark it merged with its issues closed. If there is none, skip this step.

## 6. Survey

Close with what there is to do next: open PRs with a one-word status each (green, red, draft, stacked, or needs-*), open issues by lifecycle label, and stale worktrees or branches. Rank them as a short menu, highest-leverage move first, and call out what waits on the human. Leave out closed, `wontfix` and `deferred` work. Take no action on any of it.

## Host mechanics

### Claude Code

**Argument.** The PR number in the `/flow:land` invocation, or the one the human named in words. Empty means the current branch. `Bash(docker:*)` and `Bash(ls:*)` are in the allowance for repository teardown only. The memory stamp is an `Edit` to the note under `~/.claude/projects/<slug>/memory/`.

### Codex

**Argument.** The PR number in the human's message that names the `land` skill or asks for the land in words. Empty means the current branch. There is no per-skill tool allowance, so the session's sandbox and approval policy apply. The memory stamp is an ordinary file edit.
