# land reference

Stop codes, the rerun-once valve, GraphQL thread mutations and retirement edge cases behind `SKILL.md`. Read the section you hit.

## Gate stop codes (`land-merge.mjs` exit 1)

| Stop | Do this |
|---|---|
| `not-open`, `draft` | Abort. |
| `stacked-on-non-default` | Land the parent first or retarget this one. Stop either way. |
| `behind-base` | Rebase onto the default branch in its worktree, push with `--force-with-lease`, wait for CI on the new head, and run again with `--reviewed <step 1 head>`. Rebase conflicts go back to `babysit`. |
| `head-moved` | If the url or head branch in the detail isn't the PR the user named, stop and ask. Otherwise wait for CI on the new head and run again with `--reviewed <step 1 head>`. |
| `patch-changed`, `patch-unreadable` | The new head isn't provably the change the user asked to land. Hand it to `babysit`. Land it, with no `--reviewed`, only once an other-family adversarial review of the whole diff, pinned to that head, is clean. A clean babysit report alone doesn't show that review happened. Then that head is your step 1 head. |
| `ci-pending` | Wait in slices of at most five minutes and run again. Still pending after about 30 minutes: report it and stop. |
| `ci-failed` | `checks.failed` links each failed run. Read its log (`ci_logs` in T3 Code, `gh run view <run> --attempt <n> --log-failed` elsewhere). If a check under `checks.flakeCandidates` fails only on its listed test, run again with `--accept-flake <check>:<test>` and name it in the report. A timing-shaped failure in an old test gets the rerun-once valve below. Anything else: abort and show it. |
| `ci-unknown` | A nameless, stale or unreadable check, or no checks yet. Right after a push, wait once and run again. Otherwise abort and show it. |
| `accept-flake-refused` | The flag named nothing the base branch's `.github/known-flakes.txt` declares for exactly one failed check. Fix the flag or drop it. |
| `threads-unresolved` | Step 3 on each thread in `threads`, then run again. |
| `auto-merge-armed`, `merge-queue` | Someone armed a merge that would land the PR out of sight. Tell the user, and never merge over it. |
| `read-failed`, `head-unreadable`, `gate-moved` | Re-read and run again. The gate reads through GraphQL, so if `gh api rate_limit --jq .resources.graphql` shows `remaining` near 0, wait for `reset` first. A read that keeps failing is a report, not a pass. |
| `merge-rejected` | GitHub refused, for a conflict or branch protection. Run the gate once more, because after a sibling's land it reads `behind-base` and that row applies. A second `merge-rejected` on this land: show it and stop. |
| `redirected`, `origin`, `usage` | Fix the call or report it. |

### The rerun-once valve

Covers a suite check that fails on one test when all three hold:

- the test predates this PR (`git log origin/<base>..HEAD -S <test_name>` finds nothing);
- its file isn't in the PR diff;
- the failure is timing-shaped, like a timeout or pool starvation, not an assertion on values.

Rerun once (`ci_rerun` in T3 Code, `gh run rerun <id> --failed` elsewhere), run the gate again, and note the rerun. Red twice on the same code is real, so abort. Never rerun an assertion failure.

## GraphQL thread mutations (outside T3 Code)

In T3 Code, use `pull_request_respond` (`reviewThreadId`, `body`, `resolved: true`) instead of raw GraphQL. Outside T3 Code, reply and resolve are two GraphQL mutations (`gh pr comment` is neither: it posts a top-level comment and leaves the thread open):

```bash
gh api graphql -f query='mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) {
    comment { url }
  }
}' -f thread=<thread-id> -F body=@<reply-file>

gh api graphql -f query='mutation($thread: ID!) {
  resolveReviewThread(input: {threadId: $thread}) { thread { isResolved } }
}' -f thread=<thread-id>
```

Write the reply to a file and pass `-F body=@<reply-file>`, never inline, because a reply quoting reviewer text can carry quotes or command substitutions into the shell. Notice the input fields differ: `pullRequestReviewThreadId` on reply, `threadId` on resolve. Read `thread.isResolved` back and re-run `land-merge.mjs`.

## Retirement edge cases

- **Binding check.** The local head branch and its worktrees belong to this run only when `isCrossRepository` is false and the local tip equals or is an ancestor of the merged head SHA (`git -C $MAIN_WT merge-base --is-ancestor <local tip> <merged head SHA>`). Otherwise (fork PR, advanced/diverged branch, or unreachable SHA), report them as residue and leave them alone.
- **Worktrees.** Remove with `git -C $MAIN_WT worktree remove <path>` from outside it, never `--force`. Git refuses dirty or untracked non-ignored files: leave and report. `.flow-scratch/` is ignored and leaves with its worktree. A detached worktree under `.flow-worktrees/` whose commit is in the PR's history is residue for the user, never removed: ancestry doesn't prove this run made it.
- **Remote branch.** When `isCrossRepository` is false, run `node <plugin-root>/scripts/lint-actions.mjs delete-remote-branch $MAIN_WT <head branch> --expect <merged head SHA>` with the full SHA, after removing the local worktree and branch. It deletes under a lease only when origin's tip equals that SHA and no open PR heads or targets it. Report any `trackedBy` branches or refusals as residue; "Doesn't exist on origin" is fine. Skip on fork PRs and say so.
- **Claim tags.** For each closed issue, `git -C $MAIN_WT ls-remote origin refs/tags/flow-claim-issue-<N>` must print nothing. Report a surviving tag with its SHA and never delete it: another run might hold it.
- **Evidence verification.** Never delete, force-push or rewrite `flow-evidence`. Check that one committed capture resolves: `gh api --hostname <origin host> -H 'Accept: application/vnd.github.object+json' repos/<owner>/<repo>/contents/<path>?ref=<sha> --jq .sha` with origin's owner, repo and percent-encoded `<path>` written out (never `{owner}/{repo}`, which follows `GH_REPO`).
- **Per-worktree resources.** If the repo's `AGENTS.md` documents per-worktree teardown (test DBs, containers), run it best effort and never touch shared or canonical instances (`docker` and `ls` are in `land`'s Claude tool allowlist for that alone).
