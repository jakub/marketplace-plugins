---
name: land-stage
description: Land one named pull request through the flow gates - the CI and unresolved-thread checks, the escape-hatch ack, the squash-merge, explicit issue closure, worktree retirement, and a survey of what to do next. The only merge path. MUST only run when the human explicitly asks to land a specific PR; never start it from adjacent work, a finished review, or a green build.
disable-model-invocation: true
---

# land-stage - the human gate

This stage is the back of the prep → issue → land process. The issue run stopped at an open PR and left it there; once the human is happy with it, this stage runs the closing ritual: the gates, the merge, the cleanup, and a survey of what to do next.

Everything up to `## Host mechanics` is the same on every host; read your host's subsection there before step 1. It holds where the PR number comes from and the tool allowance, and nothing else: the merge is one executor on every host, and asking the human a question is the charter's.

## Core principles

1) You are the gate. A merge is the hardest thing in this pipeline to reverse, so anything that looks off goes to the human instead of being resolved by you.
2) Prove outcomes, don't infer them. A failed command and a silent no-op look identical from here, so the merge and every issue closure get confirmed by re-reading state afterwards.
3) Nothing external is lost. An unresolved reviewer thread blocks the merge even when it arrived after the run had finished.
4) Housekeeping never blocks the land.

## 1. Resolve and gate

The argument is a PR number, or nothing at all: with no argument the PR is resolved from the current branch. Three origins authorize the number: the argument, the entry point the human invoked resolving the current branch, or the human naming the PR in words. Anything else is a stop.

Run `node <plugin-root>/scripts/land-gates.mjs [<pr>]` from the repository root. It is read-only: its git calls read the origin remote's URL and, with no argument, the current branch name, and everything else comes from GitHub. With no argument it also proves the resolved PR lives in the origin repository and heads the checked-out branch, and refuses otherwise (pass the number when a renamed local branch trips that).

It re-reads the PR state and base, the open PRs stacked on this one, every check run and commit status on the head partitioned against the base branch's `.github/known-flakes.txt` with the PR's own copy of that file diffed against it, every top-level comment, every review thread over paged GraphQL, the linked issues (parsed, recovered from the branch name and closing phrases, and bare mentions), a `## follow-up draft` comment, and the auto-merge and merge-queue state. It prints one JSON object with `verdict`, `stops` and `attention`. Exit 0 is `pass`, 1 is `stop`, 4 is a read that failed, which is never a pass, and 2 is a usage refusal with no JSON at all: a bad argument, an origin remote with no host or with a port, query string or fragment, an origin host that is not `github.com` and not in the `FLOW_GH_HOSTS` environment allowlist, or an `--accept-flake` the base allowlist does not declare or that names an ambiguous check. Read its stderr and fix the call.

Record from it `HEAD_SHA` (`head.sha`, the commit every gate inspected and the merge is pinned to), `HEAD_REF`, `BASE_REF`, `BASE_DEFAULT` (`base.default`, the repository's default branch), `isCrossRepository` and `linkedIssues` (its `linked` list is what closes; `recovered` and `mentions` are candidates).

**`stops`.** Each entry is a gate that failed, and the answer to each is fixed:

- `not-open`, `draft`: abort.
- `stacked-on-non-default`: this PR is stacked on another one. Land the parent first or retarget this PR, and stop either way.
- `ci-pending`: wait briefly and re-run the executor. Still pending → report it and stop.
- `ci-failed`: abort and show it. The one exception is the rerun-once valve below.
- `ci-unknown`: an errored, stale or nameless check is UNKNOWN, never a pass, and so is an empty rollup: a PR with no checks registered yet, which is the state right after a push, is not green. Abort and show it.
- `threads-unresolved`: §2.
- `auto-merge-armed`, `merge-queue`: someone armed a merge that will land this PR out of sight. Surface it to the human; never merge over it.
- `head-unreadable`, `threads-unreadable`, or any exit 4: a read failed. A failed read is not a clean one; fix the read and re-run.

**`attention`.** Facts that are not gates, each with a fixed answer too:

- `children`: other open PRs are based on this branch. Retarget them to the default branch FIRST (`gh pr edit <child> --base $BASE_DEFAULT`), surface the rebase sequence they will need, then re-run the executor.
- `flaky-merged-through`: a failure the base branch's allowlist covers, as a bare check name. Note it in the land report and continue. For a `check-name:test_name` entry the executor only lists the candidate under `ci.flakeCandidates` and keeps the check in `failed`: read the job log (`gh run view --log-failed`), and only when THAT test is the sole failure re-run the executor with `--accept-flake <check-name>:<test_name>`. The flag accepts nothing the base allowlist did not already declare, records the acceptance under `ci.acceptedFlakes`, and is your statement that you read the log, which the land report names. Any other failure in that job is `ci-failed`.
- `flakes-added-on-pr`: the PR's own copy of the allowlist carries entries the base does not. A branch that adds its failing check to the allowlist must not wave itself through: a diff to flag, never an allowance.
- `linked-issues-ambiguous`: `linkedIssues.linked` is what GitHub parsed and is the only list that closes on its own. `recovered` came from the branch name or a closing phrase, and a regex cannot tell `fixes #17` from `does not fix #17`, so a recovered number GitHub did not also link is a candidate, never a decision. `mentions` are bare `#N` references ("Part of #6", "follow-up in #42") and must never close anything. Ask the human, listing the candidates with an explicit "close none": closing nothing is the silent failure mode here, and closing a bystander issue is the loud one. When all three lists are empty, note "no linked issues" in the land report and continue. A quick fix that never had an issue is normal, not a question.
- `follow-up-draft`: §3.

**The rerun-once valve** covers a suite check failing on a single test. All three of these have to hold. The failing test predates this PR: `git log origin/$BASE_REF..HEAD -S <test_name>` finds no commit (bound the range, since an unbounded `git log -S` finds the commit that introduced the test on main and proves nothing here). Its file and paths don't overlap the PR diff. And the failure is timing-shaped, a timeout or an elapsed-time assertion or pool starvation, rather than an assertion on values. Then rerun the failed job ONCE (`gh run rerun <id> --failed`), re-run the executor, and note the rerun in the land report.

Red twice on identical code is real: abort. Never rerun an assertion failure - that one is telling you the truth.

## 2. Threads

Unresolved threads from external reviewers block the merge. The executor lists each one under `threads.unresolved` with its `id`, `path`, `url`, author and newest message, and that `id` is what the two mutations below take. The REST comments endpoint has no thread id and no resolved flag, so it can show a comment but cannot settle its thread.

Each one ends in exactly one of three states: fixed (resolve the thread, note the commit), answered with the run's reply standing (resolve it), or genuinely open, which means fixing it now in a quick pass on the branch or sending the PR back through a fix round. A thread that needs a decision rather than a fix goes to the human.

Replying and resolving are two separate mutations, and `gh pr comment` is neither: it posts a fresh top-level comment on the PR, which leaves the thread open and this gate red.

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

The two input field names differ, `pullRequestReviewThreadId` on the reply and `threadId` on the resolve, and swapping them is a schema error rather than a silent no-op. Read `thread.isResolved` back as proof, and re-run the executor at the end: zero unresolved threads is the only pass.

This is where a review that landed after the issue run finished gets caught. The run cannot wait indefinitely, so this gate is what makes a late review still count.

## 3. Escape-hatch ack

If the PR carries a `## follow-up draft` comment, meaning cross-crate-scale findings the run deferred rather than filing, present it to the human and ask: file it or drop it, with the cost of each in a line. The executor reports it under `followUpDraft`; it is a top-level PR comment, so it never appears among the review threads.

On ack, file it: `FLOW_SANCTION=land gh issue create --title … --body … --label needs-triage`. The sanction is what gets it past the no-backlog hook, and it has to be inline on the same command: the hook reads the command string, so an exported variable does not count. The body links this PR, and the new issue still enters through the prep stage before any agent touches it.

On decline, reply to the draft comment saying it was consciously dropped, so the next reader knows it was decided rather than missed.

## 4. Merge and close

1) The merge follows a `pass` run of the gate executor with no mutation since it. If you retargeted children, replied to or resolved threads, or filed the follow-up, run it again and take `HEAD_SHA` from that run. Its `arming` block already stopped on an armed auto-merge or a merge queue, and nothing merges over either.

You do not write the merge command. On every host the merge is one deterministic executor:

```bash
node <plugin-root>/scripts/land-merge.mjs <pr> $HEAD_SHA
```

It takes the PR number and the head every gate above inspected, and nothing else. It reads the PR from GitHub, refuses when GitHub's head is not the one you passed (the PR moved after the gates, so re-run them), refuses a closed or draft PR, a non-default base, an armed auto-merge or a merge queue, merges with `--squash --match-head-commit` pinned to that verified head, and re-reads the PR. `--match-head-commit` is GitHub's own re-check that the head is still the commit the gates inspected, so a push that raced them fails the merge instead of landing unreviewed; the answer to that failure is to re-run the gates, never to re-issue the merge against a fresh SHA. The merge deliberately omits `--delete-branch`, because the issue run's worktree still holds the local branch and a failed local delete would mask a merge that succeeded.

Its exit code is the gate. Exit 0 means the re-read confirmed the merge. Exit 1 with `refused` on stderr means nothing landed; read the reason and fix what it names. Any other exit 1 is neither a clean success nor a clean failure - a lost confirming read, a PR that reads `MERGED` but no longer matches, an armed state that may still land - so look at the PR yourself, do not re-run the executor blindly, and do not report it as either merged or failed. In a repository carrying a committed `.flow/managed` file the publish guard denies every raw merge spelling it recognizes and points here; never route around that denial with another spelling.

The authorization is the human's request to land this PR (the origin rules in step 1) plus the gates above. There is no approval ceremony beyond that. Issue the merge exactly once and never bundle it into a batch of other work.

Confirm with `gh pr view $PR --json state,mergeCommit,autoMergeRequest` that `state == MERGED`. If it isn't, do not treat that as a clean failure yet: `autoMergeRequest` now set means the merge call armed a deferred merge rather than performing one, and that is an ARMED state to report to the human verbatim. Either way, report and stop; never retry blindly.

2) Delete the remote branch: `git push origin --delete $HEAD_REF`, but only when the executor reported `isCrossRepository: false`. On a fork PR, `origin` is the base repo and `HEAD_REF` is a name in someone else's repo, so the same spelling would delete an unrelated base-repo branch sharing the name; a fork's branch is theirs to clean up, so skip and say so. Otherwise best effort, since the repo's auto-delete may have raced you and "remote ref does not exist" is a fine outcome. The LOCAL branch waits for step 5, after the worktree is gone.

3) For every issue in `linkedIssues.linked`, plus any recovered candidate the human confirmed: `gh issue view <N> --json state`. A squash-ref with a parenthetical `(#N)` auto-closes nothing. Still OPEN → `gh issue close <N> --comment "Landed via PR #$PR (<url>)."`. Report the final state of every linked issue, closed or not.

## 5. Local cleanup

1) Get main current, from the checkout that owns it. `git worktree list` names the canonical checkout (the first entry, or wherever `main` is checked out); call it `$MAIN_WT`. A plain `git switch main` from the issue worktree fails, because main is already checked out over there, and the `&&`-chained cleanup behind it silently never runs. So: `git -C $MAIN_WT pull --ff-only` (switch first with `git -C $MAIN_WT switch main` only if that checkout is parked elsewhere).

2) Retire the worktree from OUTSIDE it: `git -C $MAIN_WT worktree remove <path>` - git refuses to remove the worktree the command is standing in, so run it from the canonical checkout, and if the session's own shell sits inside the doomed worktree, use absolute paths from here on. Then delete the local branch. `git branch -d` will refuse: a squash-merged branch is no ancestor of main, so once its upstream ref is pruned git can't see that it landed. You proved `state == MERGED` back in step 4, so `git branch -D <branch>` is the correct call; the git guard deliberately leaves `worktree remove` and `branch -D` alone because the reflog returns both. Finish with `git fetch --prune`, so stale remote-tracking refs don't survey as live branches.

3) Evidence branch: the ledger may have committed captures to `flow-evidence` (or the repo's own convention) under a `pr-$PR/` path. **Nothing about that branch gets deleted, force-pushed, or rewritten - not now, not later.** The ledger embeds those captures as SHA-pinned raw urls that resolve only while the commit object survives, so deleting the branch or rewriting its history makes every one of them GC-eligible, and GitHub's grace period for dangling commits is a courtesy, not a contract. Pruning the directory in a fresh commit is safe but buys nothing.

What DOES get cleaned up is a stray worktree or checkout the evidence commit went through. `git worktree list` after step 2 shows anything the ledger left behind; `git fetch --prune` won't touch it.

Then confirm the evidence held. Take one committed capture out of the ledger comment and check the object still resolves at its pinned SHA: `gh api repos/{owner}/{repo}/contents/<path>?ref=<sha> --jq .sha`. A ledger row pointing at a dead url is worse than one that admits a gap, and this is the last moment anyone is looking at it.

4) Repo-specific teardown: if the repo's `AGENTS.md` documents per-worktree resources - isolated test databases, containers - run the documented teardown, best effort. Never block the land on housekeeping, and never touch the canonical or shared instance.

5) Memory stamp: if a project memory note tracks this work, update it to MERGED with its issues CLOSED, so it doesn't get re-suggested later. Light touch; skip if the project keeps no such notes, and never invent one to have something to stamp.

## 6. Survey

Close with what is available to do next: open PRs with a one-word status each (green / red / draft / stacked / needs-*), open issues bucketed by lifecycle label, and any stale worktrees or branches left lying around. Synthesize that into a ranked 3-6 line menu. Lead with the highest-leverage move, call out anything blocked on the human, and leave closed, `wontfix` and `deferred` work buried.

Take no action on any of it. The survey is a menu for the human to pick from.

## Host mechanics

Everything above is host-neutral, and what the charter already says about your host stays there. These subsections carry the argument and the tool allowance, which is all that differs.

### Claude Code

**Argument.** `$ARGUMENTS` from the `/flow:land` invocation is the PR number; empty means the current branch. The human typed the command, and that is the request. A green build in the transcript is not one.

**Allowance notes.** `Bash(node:*)` is in the alias for the gate and merge executors; `Bash(docker:*)` and `Bash(ls:*)` are there for repo teardown and nothing else. The memory stamp is the Edit tool on the note under `~/.claude/projects/<slug>/memory/`.

### Codex

**Argument.** The PR number in the human's message naming the plugin's `land-stage` skill or asking for the land in words; there is no slash command here. Empty means the current branch.

**Allowance notes.** There is no per-skill tool allowance on this host; the session's sandbox and approval policy apply as they are. The memory stamp is an ordinary file edit.
