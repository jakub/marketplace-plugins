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

## 2. Stacked-chain guard

- `BASE_REF` ≠ main → **do not merge**; land the parent first or retarget. Stop.
- Open PRs based on THIS branch → retarget them to main FIRST
  (`gh pr edit <child> --base main`), surface the rebase sequence, then continue.

## 3. CI gate — per-check, UNKNOWN ≠ clean

1. Partition `statusCheckRollup` by conclusion. Never trust `--watch` exit codes; re-read
   the rollup for the verdict.
2. All SUCCESS/NEUTRAL/SKIPPED → proceed. Pending → wait briefly, re-read; still pending →
   report and stop.
3. Failures: a check listed in the repo's `.github/known-flakes.txt` (one check name per
   line) may be noted and merged through. ANY other failure — or an errored/stale check,
   which is UNKNOWN, not a pass — abort and show it.

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

1. `gh pr merge $PR --squash --delete-branch`; confirm `state == MERGED`. Failure → report
   and stop, never retry blindly.
2. For each `LINKED_ISSUES`: `gh issue view <N> --json state` — squash-refs with
   parenthetical `(#N)` do NOT auto-close. Still OPEN → `gh issue close <N> --comment
   "Landed via PR #$PR (<url>)."`. Report the final state of every linked issue.

## 7. Local cleanup

1. Main checkout: `git switch main && git pull --ff-only`. Never bare-`cd` into worktrees.
2. Retire the worktree (`git worktree remove`), delete the local branch (`git branch -d`).
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
