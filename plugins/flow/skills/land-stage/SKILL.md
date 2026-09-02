---
name: land-stage
description: Land one named pull request through the flow gates - the CI and unresolved-thread checks, the escape-hatch ack, the squash-merge, explicit issue closure, worktree retirement, and a survey of what to do next. The only merge path. MUST only run when the operator explicitly asks to land a specific PR; never start it from adjacent work, a finished review, or a green build.
disable-model-invocation: true
---

# land-stage - the human gate

This stage is the back of the prep → issue → land process. The issue run stopped at an open PR and left it there; once the human is happy with it, this stage runs the closing ritual - the gates, the merge, the cleanup, and a survey of what to do next.

Everything up to `## Host mechanics` is the same on every host. That section, at the end, says how the two steps that differ - the merge command and where the PR number comes from - work where you are running. Read your host's subsection before step 1. Where a step needs a decision from the human, it goes through the human-choice binding your charter profile declares.

## Core principles

1) You are the gate, not another autonomous stage. A merge is the hardest thing in this pipeline to reverse, so anything that looks off gets presented to the human instead of resolved by you.
2) A check that errored, went stale, or is still pending is UNKNOWN - never a pass. Read the rollup yourself.
3) Prove outcomes, don't infer them. The merge and every issue closure get confirmed by re-reading state afterwards, because a failed command and a silent no-op both look like success from here.
4) Nothing external is lost. An unresolved reviewer thread blocks the merge even when it arrived after the run had already finished.
5) Housekeeping never blocks the land, and the survey at the end takes NO action - it is a menu, not a plan.

## 1. Resolve

The argument is a PR number, or nothing at all: with no argument, resolve the PR from the current branch (`gh pr view --json number`). Abort with usage if neither resolves. Three origins authorize the number: the argument, the entry point the human invoked resolving the current branch, or the human naming the PR in words. Anything else is a stop.

```bash
gh pr view $PR --json number,title,body,state,headRefName,headRefOid,baseRefName,url,isDraft,isCrossRepository,mergeable,mergeStateStatus,autoMergeRequest,closingIssuesReferences,statusCheckRollup,comments
```

Abort if the PR is not OPEN, or if it is a draft. Record `HEAD_REF`, `HEAD_SHA` (the `headRefOid` - every gate below inspects THIS commit, and the merge in step 6 is pinned to it), `BASE_REF`, and `LINKED_ISSUES`. The `body` and `comments` come along in the same read because steps 1 and 5 parse them.

An empty `closingIssuesReferences` does NOT mean there are no linked issues - it means GitHub parsed no link. A mangled `Closes #N`, or a squash parenthetical like `(#N)`, links nothing. Two recoveries carry enough intent to act on: the issue number in `HEAD_REF` (`feat|fix|chore/issue-N-*`), and an explicit closing phrase in the PR title or body (`close[sd]?`/`fix(es|ed)?`/`resolve[sd]?` directly before `#N`). A bare `#N` anywhere else is a mention, not a link - "Part of #6" or "follow-up in #42" must never close anything - so bare references only become candidates in the human ask. When recovery turns up actual candidates but no clear answer, ask the human, listing the candidates with an explicit "close none": closing nothing is the silent failure mode here, and closing a bystander issue is the loud one. When recovery finds nothing at all - no linked issue, no branch number, no closing phrase, no bare mention - there is nothing to decide: note "no linked issues" in the land report and continue. A quick fix that never had an issue is normal, not a question.

## 2. Stacked-chain guard

If `BASE_REF` is not main, do not merge. This PR is stacked on another one - land the parent first or retarget this PR, and stop either way.

If other open PRs are based on THIS branch, retarget them to main FIRST (`gh pr edit <child> --base main`), surface the rebase sequence they will need, then continue.

## 3. CI gate

Partition `statusCheckRollup` by conclusion.

The JSON rollup mixes CheckRuns with commit statuses, which is how external reviewers like CodeRabbit report. A commit status can surface as an entry with a null name and null conclusion, so before writing one off as UNKNOWN, cross-read `gh pr checks $PR` - that renders both kinds.

- **All SUCCESS / NEUTRAL / SKIPPED**: proceed.
- **Anything pending**: wait briefly and re-read. Still pending → report it and stop.
- **A failure listed in the repo's `.github/known-flakes.txt`**: note it and merge through. Read the allowlist from the base branch, never from the PR: `git fetch origin $BASE_REF && git show origin/$BASE_REF:.github/known-flakes.txt`. The PR's own copy is part of what is being reviewed, and a branch that adds its failing check to the allowlist must not get to wave itself through - an entry that exists only on the PR side is a diff to flag, not an allowance. Entries are one per line in two forms - a bare check name means the whole check is flaky, while `check-name:test_name` means one flaky test inside a suite check, and merging through then requires the job log (`gh run view --log-failed`) to show THAT test as the sole failure.
- **Anything else**, including an errored or stale check: abort and show it. The one exception is the valve below.

**The rerun-once valve** covers a suite check failing on a single test. All three of these have to hold: the failing test predates this PR (`git log origin/$BASE_REF..HEAD -S <test_name>` finds no commit - the range matters, because an unbounded `git log -S` walks all of history and finds the commit that originally introduced the test on main, which proves nothing about this PR), its file and paths don't overlap the PR diff, and the failure is timing-shaped - a timeout, an elapsed-time assertion, pool starvation - rather than an assertion on values. Then rerun the failed job ONCE (`gh run rerun <id> --failed`), re-read the rollup, and note the rerun in the land report.

Red twice on identical code is real: abort. Never rerun an assertion failure - that one is telling you the truth.

## 4. External-threads gate

Threads are not reachable through `gh pr view --json`. That field list rejects `reviewThreads`, so read them over GraphQL:

```bash
gh api graphql -f query='
query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          comments(last: 20) { nodes { author { login } body path url } }
        }
      }
    }
  }
}' -f owner=<owner> -f repo=<repo> -F pr=$PR
```

A thread is unresolved when `isResolved` is false. Keep paging with `-f cursor=<endCursor>` while `pageInfo.hasNextPage` is true; 100 covers one round on a normal PR, and a truncated read looks exactly like a clean one. The comments use `last: 20`, not `first`, so a long back-and-forth shows its newest messages - the reviewer's latest reply is what decides whether the thread still stands, and the opening comment on a thread past 20 messages would tell you nothing about where it landed. Each node's `id` is the thread id the two mutations below take. The REST comments endpoint (`gh api repos/{owner}/{repo}/pulls/$PR/comments`) has no thread id and no resolved flag, so it can show you a comment but cannot settle its thread.

Unresolved threads from external reviewers block the merge.

Each one ends in exactly one of three states: it was fixed (resolve the thread, note the commit), it was answered and the run's reply stands (resolve it), or it is genuinely open - which means fixing it now in a quick pass on the branch, or sending the PR back through a fix round. A thread that needs a decision rather than a fix goes to the human like any other decision.

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

The two input field names differ, `pullRequestReviewThreadId` on the reply and `threadId` on the resolve, and swapping them is a schema error rather than a silent no-op. Read `thread.isResolved` back as proof, and re-run the paged query once at the end: zero unresolved threads is the only pass.

This is where a review that landed after the issue run finished gets caught. That is by design: the run cannot wait indefinitely, so this gate is what makes a late review still count.

## 5. Escape-hatch ack

If the PR carries a `## follow-up draft` comment - cross-crate-scale findings the run deferred rather than filing - present it to the human and ask: file it, or drop it, with the cost of each in a line. The place to look is the `comments` array from the step-1 read: the draft is a top-level PR comment, so it never appears in the review threads the previous gate walked.

On ack, file it: `FLOW_SANCTION=land gh issue create --title … --body … --label needs-triage`. The sanction is what gets it past the no-backlog hook, and it has to be inline on the same command: the hook reads the command string, so an exported variable does not count. The body links this PR, and the new issue still enters through the prep stage before any agent touches it.

On decline, reply to the draft comment saying it was consciously dropped, so the next reader knows it was decided rather than missed.

## 6. Merge and close

1) First, two arming checks: if the step-1 read showed `autoMergeRequest` set, stop - someone armed an auto-merge that will land this PR out of sight, and that gets surfaced to the human, not merged over. If the base branch uses a merge queue, stop the same way: this stage performs an immediate merge, and a command that quietly enqueues instead leaves an armed future merge behind the moment your gate observations go stale.

Then merge, the way your host's subsection below says. Both paths are a squash-merge pinned with `--match-head-commit $HEAD_SHA`, deliberately WITHOUT `--delete-branch`. The issue run's worktree still holds the local branch, so the local delete fails - and a non-zero exit would mask a merge that actually succeeded. `--match-head-commit` is GitHub's own re-check that the head is still the commit every gate above inspected; a push that raced the gates fails the merge instead of landing unreviewed, and the answer to that failure is to re-run the gates, never to re-issue the merge with a fresh SHA.

The authorization is the same on every host: the human asked to land this PR (the origin rules in step 1) and the gates above passed. There is no approval ceremony beyond that. Issue the merge exactly once, after those gates pass, and never bundle it into a batch of other work.

Confirm with `gh pr view $PR --json state,mergeCommit,autoMergeRequest` that `state == MERGED`. If it isn't, do not treat that as a clean failure yet: `autoMergeRequest` now set means the merge call armed a deferred merge rather than performing one, and that is an ARMED state to report to the human verbatim. Either way, report and stop; never retry blindly.

2) Delete the remote branch: `git push origin --delete $HEAD_REF` - but only when the step-1 read showed `isCrossRepository: false`. On a fork PR, `origin` is the base repo and `HEAD_REF` is a name in someone else's repo; the same spelling would delete an unrelated base-repo branch that happens to share the name. A fork's branch is theirs to clean up - skip and say so. Otherwise best effort - the repo's auto-delete may have raced you, and "remote ref does not exist" is a fine outcome. The LOCAL branch waits for step 7, after the worktree is gone.

3) For every issue in `LINKED_ISSUES`, including any the step-1 recovery turned up: `gh issue view <N> --json state`. A squash-ref with a parenthetical `(#N)` auto-closes nothing. Still OPEN → `gh issue close <N> --comment "Landed via PR #$PR (<url>)."`. Report the final state of every linked issue, closed or not.

## 7. Local cleanup

1) Get main current - from the checkout that owns it. `git worktree list` names the canonical checkout (the first entry, or wherever `main` is checked out); call it `$MAIN_WT`. A plain `git switch main` run from the issue worktree fails, because main is already checked out over there, and the `&&`-chained cleanup behind it silently never runs. So: `git -C $MAIN_WT pull --ff-only` (switch first with `git -C $MAIN_WT switch main` only if that checkout is parked elsewhere).

2) Retire the worktree from OUTSIDE it: `git -C $MAIN_WT worktree remove <path>` - git refuses to remove the worktree the command is standing in, so run it from the canonical checkout, and if the session's own shell sits inside the doomed worktree, use absolute paths from here on. Then delete the local branch. `git branch -d` will refuse: a squash-merged branch is no ancestor of main, so once its upstream ref is pruned git can't see that it landed. You proved `state == MERGED` back in step 6, so `git branch -D <branch>` is the correct call; git-guard deliberately leaves `worktree remove` and `branch -D` alone because the reflog returns both. Finish with `git fetch --prune`, so stale remote-tracking refs don't survey as live branches.

3) Evidence branch: the ledger may have committed captures to `flow-evidence` (or the repo's own convention) under a `pr-$PR/` path. **Nothing about that branch gets deleted, force-pushed, or rewritten - not now, not later.** The ledger embeds those captures as SHA-pinned raw urls, which resolve only while the commit object survives; deleting the branch or rewriting its history makes every one of them GC-eligible, and GitHub's grace period for dangling commits is a courtesy, not a contract. Pruning the directory in a fresh commit is safe but buys nothing - the blobs stay in history either way.

What DOES get cleaned up is a stray worktree or checkout the evidence commit went through. `git worktree list` after step 2 shows anything the ledger left behind; `git fetch --prune` won't touch it.

Then confirm the evidence held. Take one committed capture out of the ledger comment and check the object still resolves at its pinned SHA: `gh api repos/{owner}/{repo}/contents/<path>?ref=<sha> --jq .sha`. A ledger row pointing at a dead url is worse than a row that admits a gap, and this is the last moment anyone is looking at it.

4) Repo-specific teardown: if the repo's `AGENTS.md` documents per-worktree resources - isolated test databases, containers - run the documented teardown, best effort. Never block the land on housekeeping, and never touch the canonical or shared instance.

5) Memory stamp: if a project memory note tracks this work, update it to MERGED with its issues CLOSED, so it doesn't get re-suggested later. Light touch; skip if the project keeps no such notes, and never invent one to have something to stamp.

## 8. Survey

Close with what is available to do next: open PRs with a one-word status each (green / red / draft / stacked / needs-*), open issues bucketed by lifecycle label, and any stale worktrees or branches left lying around.

Synthesize that into a ranked 3-6 line menu. Lead with the highest-leverage move, call out anything blocked on the human, and leave closed / `wontfix` / `deferred` work buried.

**Take no action on any of it.** You just finished a merge and a cleanup sequence, and the pull to keep going is strongest right here. The survey is a menu for the human to pick from.

## Host mechanics

Everything above is host-neutral. Two steps differ by host; everything else runs as written under whatever shell allowance the host gives the stage.

### Claude Code

**Argument.** `$ARGUMENTS` from the `/flow:land` invocation is the PR number; empty means the current branch. The human typed the command, and that is the request. A green build in the transcript is not one.

**Merge.** `gh pr merge $PR --squash --match-head-commit $HEAD_SHA`, with no confirmation prompt in front of it. The command runs pre-approved under the alias's `Bash(gh:*)` allowance, and the publish guard asks only about package-registry publishes, so nothing stops this call to check with the human. The gate is upstream of the command: the invocation plus the passed gates.

**Allowance notes.** `Bash(docker:*)` and `Bash(ls:*)` are in the alias for repo teardown and nothing else. The memory stamp is the Edit tool on the note under `~/.claude/projects/<slug>/memory/`.

### Codex

**Argument.** The PR number in the human's message naming the plugin's `land-stage` skill or asking for the land in words; there is no slash command here.

**Merge.** You do not write the merge command. In a repository that carries a committed `.flow/managed` file, the publish guard denies every raw merge spelling it recognizes and points at flow's executor:

```bash
node <plugin-root>/scripts/land-merge.mjs <pr> $HEAD_SHA
```

It takes the PR number and the head every gate above inspected, and nothing else: it derives the host-qualified repository from the origin remote, reads the head SHA, state, draft flag and base from GitHub, refuses when GitHub's head is not the one you passed (the PR moved after the gates, so re-run them), refuses a closed or draft PR, a non-default base, an armed auto-merge or a merge queue, merges with `--squash --match-head-commit` pinned to that verified head, and re-reads the PR. Without the second argument the executor would pin the merge to whatever head it read itself, after the gates, which proves nothing. Its exit code is the gate. Exit 0 means the re-read confirmed the merge. Exit 1 with `refused` on stderr means nothing landed; read the reason and fix what it names. Any other exit 1 is neither a clean success nor a clean failure: a lost confirming read, a PR that reads `MERGED` but no longer matches what was verified, or an armed state that may still land later. Look at the PR yourself, do not re-run the executor blindly, and do not report it as either merged or failed. Never route around a guard denial with another spelling; the denial means take the executor path.

**Allowance notes.** There is no per-skill tool allowance on this host; the session's sandbox and approval policy apply as they are. The memory stamp is an ordinary file edit.
