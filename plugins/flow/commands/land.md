---
description: Land a PR — CI + unresolved-thread gates, escape-hatch ack, squash-merge, close issues explicitly, retire worktree, survey next moves. The only merge path.
argument-hint: <pr-number | empty for current branch>
allowed-tools: Bash(gh:*), Bash(git:*), Bash(docker:*), Bash(ls:*), Read, Edit, AskUserQuestion
---

# /flow:land — the human gate

Back of **prep → issue → land** (doctrine: `flow` skill, `framework.md` §1). `/flow:issue`
stops at an open PR; once the human is happy, this performs the deterministic closing
ritual. Merging is hard to reverse — when anything looks off, present the state and ask.

Argument: `$ARGUMENTS` = PR number, else resolve from the current branch
(`gh pr view --json number`). Abort with usage if neither resolves.

## 1. Resolve

```bash
gh pr view $PR --json number,title,state,headRefName,baseRefName,url,isDraft,mergeable,mergeStateStatus,closingIssuesReferences,statusCheckRollup,reviewThreads
```
Abort if not OPEN or if draft. Record `HEAD_REF`, `BASE_REF`, `LINKED_ISSUES`.

`closingIssuesReferences` empty ≠ no linked issues — a missing/mangled `Closes #N` (or a
parenthetical `(#N)`) links nothing. Fall back: parse the issue number from `HEAD_REF`
(`feat|fix|chore/issue-N-*`) and `#N` refs in the PR title/body; if still ambiguous, ask
the human rather than closing nothing.

## 2. Stacked-chain guard

- `BASE_REF` ≠ main → **do not merge**; land the parent first or retarget. Stop.
- Open PRs based on THIS branch → retarget them to main FIRST
  (`gh pr edit <child> --base main`), surface the rebase sequence, then continue.

## 3. CI gate — per-check, UNKNOWN ≠ clean

1. Partition `statusCheckRollup` by conclusion. Never trust `--watch` exit codes; re-read
   the rollup for the verdict. The json rollup mixes CheckRuns with commit statuses
   (coderabbit et al.) — statuses can surface as entries with null name/conclusion; before
   treating a null entry as UNKNOWN, cross-read `gh pr checks $PR`, which renders both.
2. All SUCCESS/NEUTRAL/SKIPPED → proceed. Pending → wait briefly, re-read; still pending →
   report and stop.
3. Failures: a check listed in the repo's `.github/known-flakes.txt` may be noted and
   merged through. Entries are one per line, two forms: a bare check name (the whole check
   is flaky), or `check-name:test_name` (one flaky test inside a suite check — merge-through
   only if the job log shows THAT test as the sole failure). ANY other failure — or an
   errored/stale check, which is UNKNOWN, not a pass — abort and show it, except:
4. **Rerun-once valve** for a suite check failing on a single test: if ALL three hold —
   the failing test predates the PR (`git log -S <test_name>` finds no commit in this
   branch), its file/paths don't overlap the PR diff, and the failure is timing-shaped
   (timeout/elapsed/pool-starvation, not an assertion on values) — rerun the failed job
   ONCE (`gh run rerun <id> --failed`), re-read the rollup, and note the rerun in the land
   report. Red twice on identical code = real: abort. Never rerun an assertion failure.

## 4. External-threads gate

From `reviewThreads` (or `gh api repos/{owner}/{repo}/pulls/$PR/comments`): unresolved
external reviewer threads (coderabbit et al.) **block the merge**. For each: it was either
fixed (resolve the thread, note the commit), answered (the run's reply stands — resolve),
or is genuinely open (fix now in a quick pass on the branch, or send the PR back through a
fix round). Late-arriving reviews get caught here by design — nothing external is lost.

## 5. Escape-hatch ack

If the PR carries a `## follow-up draft` comment (cross-crate-scale findings the run
deferred): present it and ask. On ack:
`FLOW_SANCTION=land gh issue create --title … --body … --label needs-triage`
(the body links this PR; the new issue still enters through /flow:prep before any agent
touches it). On decline: reply to the draft comment that it was consciously dropped.

## 6. Merge + close — prove it

1. `gh pr merge $PR --squash` — deliberately WITHOUT `--delete-branch`: the issue-run
   worktree still holds the local branch, so the local delete would fail and mask a
   successful merge behind a non-zero exit. Confirm via
   `gh pr view $PR --json state,mergeCommit` that `state == MERGED`. Not merged → report
   and stop, never retry blindly.
2. Delete the remote branch: `git push origin --delete $HEAD_REF` (best effort — repo
   auto-delete may have raced it; a "remote ref does not exist" failure is fine). The
   LOCAL branch delete waits for step 7, after the worktree is retired.
3. For each `LINKED_ISSUES` (including any recovered by the step-1 fallback):
   `gh issue view <N> --json state` — squash-refs with parenthetical `(#N)` do NOT
   auto-close. Still OPEN → `gh issue close <N> --comment "Landed via PR #$PR (<url>)."`.
   Report the final state of every linked issue.

## 7. Local cleanup

1. Main checkout: `git switch main && git pull --ff-only`. Never bare-`cd` into worktrees.
2. Retire the worktree (`git worktree remove`), delete the local branch (`git branch -d`;
   a squash-merged branch is no ancestor of main, so once its upstream ref is pruned `-d`
   refuses — with `state == MERGED` already proven in step 6, `-D` is correct). Finish
   with `git fetch --prune` so stale remote-tracking refs don't survey as live branches.
3. Repo-specific teardown: if the repo's AGENTS.md documents per-worktree resources
   (isolated test DBs, containers), run the documented teardown best-effort — never block
   the land on housekeeping, never touch the canonical/shared instance.
4. Memory stamp: update the project memory note tracking this work (MERGED + issues
   CLOSED) so it isn't re-suggested later. Light touch.

## 8. Survey

Open PRs (status one-worder each: green / red / draft / stacked / needs-*), open issues
bucketed by lifecycle label, stale worktrees/branches. Synthesise a ranked 3-6 line menu —
lead with the highest-leverage move; call out what's blocked on the human; take no action.
Closed/`wontfix`/`deferred` stay buried.
