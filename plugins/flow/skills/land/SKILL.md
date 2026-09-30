---
name: land
description: Land one named pull request through the flow gates: the merge gate, the follow-up-draft ack, the squash-merge, explicit issue closure, worktree retirement, and a survey of what to do next. The only merge path. MUST only run when the human explicitly asks to land a specific PR; never start it from adjacent work, a finished review, or a green build.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(node:*), Bash(docker:*), Bash(ls:*), Read, Edit, AskUserQuestion, mcp__plugin_flow_flow_delegate__delegate_to_codex, mcp__plugin_flow_flow_delegate__delegation_result, mcp__plugin_flow_flow_delegate__delegation_cancel, mcp__plugin_flow_flow_delegate__delegation_steer, mcp__plugin_flow_flow_delegate__delegation_doctor
---

# land: the human gate

A merge is the hardest step to reverse, so anything that looks wrong goes to the human. Prove each outcome by reading state back, because a failed command and a silent no-op look the same. An unresolved thread blocks the merge even when it arrived after the run finished. Housekeeping never blocks the land. Everything above `## Host mechanics` is the same on every host.

## 1. Read the PR

The argument is a PR number, or nothing, which resolves the PR from the current branch. Three origins authorize it: the argument, the human's invocation resolving the current branch, or the human naming the PR in words. Anything else is a stop.

`<repo>` below is the `host/owner/repo` that `git remote get-url origin` names. With no number, run `gh pr view --json number,url,headRefName` from the current branch. Use that number only when `url` names `<repo>` and `headRefName` is the checked-out branch. Otherwise ask the human for the number, because a fork checkout with an upstream remote resolves the upstream's PR.

Read the PR with `gh pr view <pr> --repo <repo> --json headRefOid,headRefName,baseRefName,isCrossRepository,closingIssuesReferences,title,body,url`. Record the head SHA, the head branch, the base branch, `isCrossRepository` and `closingIssuesReferences`.

## 2. Merge through the gate

Run this once, never batched with other work:

```bash
node <plugin-root>/scripts/land-merge.mjs <pr> <head-sha>
```

It reads every fact that can stop a land and merges only when none does, so there is nothing to check before calling it. It prints one JSON line:

- `merged` (exit 0): a re-read proved the merge. Name every `excused` entry in the land report.
- `refused` (exit 1): nothing merged. `stops` lists every stop it found. Act on each one, then run it again.
- `unknown` (exit 4): look at the PR yourself, report neither merged nor failed, and never re-run blindly.

Each stop has a fixed answer:

- `not-open`, `draft`: abort.
- `stacked-on-non-default`: the PR is stacked on another one. Land the parent first or retarget this one, and stop either way.
- `behind-base`: rebase the branch onto the default branch in its worktree, push with `--force-with-lease`, wait for CI on the new head, and run again with it. When the rebase has conflicts, hand the PR back to babysit.
- `head-moved`: the PR's head is not the one you read. If the url or head branch in the detail is not the PR the human named, stop and ask. Otherwise wait for CI on the new head, and run again with it.
- `ci-pending`: wait in slices of at most five minutes, and run again. If it is still pending after about 30 minutes, report it and stop.
- `ci-failed`: `checks.failed` lists each failed check with its link, which names the run. Read the job log with `gh run view <run> --attempt <n> --log-failed`, naming the attempt. If a check under `checks.flakeCandidates` has a log that shows the listed test as its only failure, run again with `--accept-flake <check>:<test>`, and name it in the land report. The rerun-once valve below covers a timing-shaped failure in a test that predates the PR. On anything else, abort and show it.
- `ci-unknown`: a nameless, stale or unreadable check, or no checks yet. Right after a push, wait once and run again. Otherwise abort and show it.
- `accept-flake-refused`: the flag named nothing the base branch's `.github/known-flakes.txt` declares for exactly one failed check. Fix the flag or drop it.
- `threads-unresolved`: §3 on each thread in `threads`, then run again.
- `auto-merge-armed`, `merge-queue`: someone armed a merge that would land the PR out of sight. Tell the human, and never merge over it.
- `read-failed`, `head-unreadable`, `retargeted`: re-read and run again. A read that keeps failing is a report, not a pass.
- `merge-rejected`: GitHub refused the merge, for a conflict or branch protection. Show it and stop.
- `redirected`, `origin`, `usage`, `cron`: fix the call or report it.

**The rerun-once valve** covers a suite check that fails on one test, when all three conditions hold. The test predates this PR: `git log origin/<base>..HEAD -S <test_name>` finds no commit (an unbounded `-S` finds the commit that added the test on main). Its file does not overlap the PR diff. The failure is timing-shaped, such as a timeout or pool starvation, not an assertion on values. Then rerun the failed job once with `gh run rerun <id> --failed`, run the executor again, and note the rerun. Red twice on the same code is real, so abort. Never rerun an assertion failure.

Never route around a denied raw merge with another spelling.

## 3. Threads

The refusal lists each unresolved thread under `threads` with its `id`, `path`, `url`, `author` and `lastBody`, the newest message. Each thread ends fixed (resolve it and note the commit), answered with the run's reply standing (resolve it), or open, which means a quick fix on the branch or another fix round. A thread that needs a decision goes to the human.

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

## 4. After the merge

The merge proved the base is the default branch.

1. Children: `gh pr list --repo <repo> --base <head branch> --state open --json number,title`. Retarget each with `gh pr edit <n> --repo <repo> --base <base>` before the next step, and tell the human the rebases they will need.
2. The remote branch: if `isCrossRepository` is false, run `git push origin --delete <head branch>`, where "remote ref does not exist" is fine. On a fork PR, skip this and say so, because that command would delete an unrelated base-repository branch of the same name.
3. Issues: a squash commit's `(#N)` closes nothing. Close each `closingIssuesReferences` number that is still open with `gh issue close <N> --repo <repo> --comment "Landed via PR #<pr> (<url>)."`. Then read the title, the body and the head branch for other numbers the PR claims to close: a closing phrase outside code that is not negated, or a `feat|fix|chore/issue-<N>-` branch. A URL to another repository's PR is not a local issue, and a bare mention closes nothing. Ask the human about each candidate, with "close none" as an option, and close the ones they confirm. Read every closure back with `gh issue view <N> --repo <repo> --json state`, and report each linked issue's final state, or "no linked issues".
4. Follow-up: read the body and every page of top-level comments (`gh api --paginate --slurp repos/<owner>/<name>/issues/<pr>/comments`) for a `## follow-up draft` heading. It holds findings the run deferred as too large for the PR. Ask the human whether to file it or drop it, with the cost of each. To file it, run `FLOW_SANCTION=land gh issue create --repo <repo> --title ... --body ... --label needs-triage` with the sanction inline, because the no-backlog hook reads the command string. The body links this PR, and the new issue still enters through prep. To drop it, reply on the PR saying it was dropped on purpose.

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
