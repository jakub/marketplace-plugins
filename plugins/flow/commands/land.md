---
description: Land a PR — CI + unresolved-thread gates, escape-hatch ack, squash-merge, close issues explicitly, retire worktree, survey next moves. The only merge path.
argument-hint: <pr-number | empty for current branch>
allowed-tools: Bash(gh:*), Bash(git:*), Bash(docker:*), Bash(ls:*), Read, Edit, AskUserQuestion
---

# /flow:land — the human gate

/flow:land is the back of the **prep → issue → land** process. `/flow:issue` stopped at an open PR and left it there; once the human is happy with it, this command runs the closing ritual — the gates, the merge, the cleanup, and a survey of what to do next.

The argument is a PR number, or nothing at all: with no argument, resolve the PR from the current branch (`gh pr view --json number`). Abort with usage if neither resolves.

## Core principles

1) You are the gate, not another autonomous stage. A merge is the hardest thing in this pipeline to reverse, so anything that looks off gets presented to the human instead of resolved by you.
2) A check that errored, went stale, or is still pending is UNKNOWN — never a pass. Read the rollup yourself; exit codes from watch commands lie.
3) Prove outcomes, don't infer them. The merge and every issue closure get confirmed by re-reading state afterwards, because a failed command and a silent no-op both look like success from here.
4) Nothing external is lost. An unresolved reviewer thread blocks the merge even when it arrived after the run had already finished.
5) Housekeeping never blocks the land, and the survey at the end takes NO action — it is a menu, not a plan.

## 1. Resolve

```bash
gh pr view $PR --json number,title,state,headRefName,baseRefName,url,isDraft,mergeable,mergeStateStatus,closingIssuesReferences,statusCheckRollup,reviewThreads
```

Abort if the PR is not OPEN, or if it is a draft. Record `HEAD_REF`, `BASE_REF`, and `LINKED_ISSUES`.

An empty `closingIssuesReferences` does NOT mean there are no linked issues — it means GitHub parsed no link. A mangled `Closes #N`, or a squash parenthetical like `(#N)`, links nothing. Fall back to parsing the issue number out of `HEAD_REF` (`feat|fix|chore/issue-N-*`) and any `#N` references in the PR title and body. If it is still ambiguous, ask the human: closing nothing is the failure mode here, and it is a silent one.

## 2. Stacked-chain guard

If `BASE_REF` is not main, do not merge. This PR is stacked on another one — land the parent first or retarget this PR, and stop either way.

If other open PRs are based on THIS branch, retarget them to main FIRST (`gh pr edit <child> --base main`), surface the rebase sequence they will need, then continue.

## 3. CI gate

Partition `statusCheckRollup` by conclusion. Never trust a `--watch` exit code — re-read the rollup for the verdict.

The JSON rollup mixes CheckRuns with commit statuses, which is how external reviewers like CodeRabbit report. A commit status can surface as an entry with a null name and null conclusion, so before writing one off as UNKNOWN, cross-read `gh pr checks $PR` — that renders both kinds.

- **All SUCCESS / NEUTRAL / SKIPPED**: proceed.
- **Anything pending**: wait briefly and re-read. Still pending → report it and stop.
- **A failure listed in the repo's `.github/known-flakes.txt`**: note it and merge through. Entries are one per line in two forms — a bare check name means the whole check is flaky, while `check-name:test_name` means one flaky test inside a suite check, and merging through then requires the job log to show THAT test as the sole failure.
- **Anything else**, including an errored or stale check: abort and show it. The one exception is the valve below.

**The rerun-once valve** covers a suite check failing on a single test. All three of these have to hold: the failing test predates this PR (`git log -S <test_name>` finds no commit on the branch that introduced it), its file and paths don't overlap the PR diff, and the failure is timing-shaped — a timeout, an elapsed-time assertion, pool starvation — rather than an assertion on values. Then rerun the failed job ONCE (`gh run rerun <id> --failed`), re-read the rollup, and note the rerun in the land report.

Red twice on identical code is real: abort. Never rerun an assertion failure — that one is telling you the truth.

## 4. External-threads gate

Read the unresolved threads from `reviewThreads`, or `gh api repos/{owner}/{repo}/pulls/$PR/comments`. Unresolved threads from external reviewers block the merge.

Each one ends in exactly one of three states: it was fixed (resolve the thread, note the commit), it was answered and the run's reply stands (resolve it), or it is genuinely open — which means fixing it now in a quick pass on the branch, or sending the PR back through a fix round.

This is where a review that landed after `/flow:issue` finished gets caught. That is by design: the run cannot wait indefinitely, so this gate is what makes a late review still count.

## 5. Escape-hatch ack

If the PR carries a `## follow-up draft` comment — cross-crate-scale findings the run deferred rather than filing — present it to the human and ask.

On ack, file it: `FLOW_SANCTION=land gh issue create --title … --body … --label needs-triage`. The sanction is what gets it past the no-backlog hook, the body links this PR, and the new issue still enters through `/flow:prep` before any agent touches it.

On decline, reply to the draft comment saying it was consciously dropped, so the next reader knows it was decided rather than missed.

## 6. Merge and close

1) `gh pr merge $PR --squash`, deliberately WITHOUT `--delete-branch`. The issue run's worktree still holds the local branch, so the local delete fails — and a non-zero exit would mask a merge that actually succeeded. Confirm with `gh pr view $PR --json state,mergeCommit` that `state == MERGED`. If it isn't, report and stop; never retry blindly.

2) Delete the remote branch: `git push origin --delete $HEAD_REF`. Best effort — the repo's auto-delete may have raced you, and "remote ref does not exist" is a fine outcome. The LOCAL branch waits for step 7, after the worktree is gone.

3) For every issue in `LINKED_ISSUES`, including any the step-1 fallback recovered: `gh issue view <N> --json state`. A squash-ref with a parenthetical `(#N)` auto-closes nothing. Still OPEN → `gh issue close <N> --comment "Landed via PR #$PR (<url>)."`. Report the final state of every linked issue, closed or not.

## 7. Local cleanup

1) Get main current: `git switch main && git pull --ff-only`. Never bare-`cd` into a worktree.

2) Retire the worktree (`git worktree remove`), then delete the local branch. `git branch -d` will refuse: a squash-merged branch is no ancestor of main, so once its upstream ref is pruned git can't see that it landed. You proved `state == MERGED` back in step 6, so `git branch -D <branch>` is the correct call. Finish with `git fetch --prune`, so stale remote-tracking refs don't survey as live branches.

3) Evidence branch: the ledger may have committed captures to `flow-evidence` (or the repo's own convention) under a `pr-$PR/` path. **Nothing about that branch gets deleted, force-pushed, or rewritten — not now, not later.** The ledger embeds those captures as SHA-pinned raw urls, which resolve only while the commit object survives; deleting the branch or rewriting its history makes every one of them GC-eligible, and GitHub's grace period for dangling commits is a courtesy, not a contract. Pruning the directory in a fresh commit is safe but buys nothing — the blobs stay in history either way.

What DOES get cleaned up is a stray worktree or checkout the evidence commit went through. `git worktree list` after step 2 shows anything the ledger left behind; `git fetch --prune` won't touch it.

Then confirm the evidence held. Take one committed capture out of the ledger comment and check the object still resolves at its pinned SHA: `gh api repos/{owner}/{repo}/contents/<path>?ref=<sha> --jq .sha`. A ledger row pointing at a dead url is worse than a row that admits a gap, and this is the last moment anyone is looking at it.

4) Repo-specific teardown: if the repo's `AGENTS.md` documents per-worktree resources — isolated test databases, containers — run the documented teardown, best effort. Never block the land on housekeeping, and never touch the canonical or shared instance.

5) Memory stamp: update the project memory note tracking this work to MERGED with its issues CLOSED, so it doesn't get re-suggested later. Light touch.

## 8. Survey

Close with what is available to do next: open PRs with a one-word status each (green / red / draft / stacked / needs-*), open issues bucketed by lifecycle label, and any stale worktrees or branches left lying around.

Synthesize that into a ranked 3-6 line menu. Lead with the highest-leverage move, call out anything blocked on the human, and leave closed / `wontfix` / `deferred` work buried.

**Take no action on any of it.** You just finished a merge and a cleanup sequence, and the pull to keep going is strongest right here. The survey is a menu for the human to pick from.
