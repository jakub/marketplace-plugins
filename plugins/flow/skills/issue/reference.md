# issue reference

Refusal handling, early checkpoint review rules and suspension steps behind `SKILL.md`. Read the section you hit.

## Claim outcomes and retries

`node <plugin-root>/scripts/issue-claim.mjs claim <N> [--kind feat|fix|chore] [--expect-body <sha256>] [--require-ancestor <sha>]...` prints one JSON line, and `result` is the whole answer:

- **`claimed`**: go. Record `base`, `branch`, `worktree`, `head` and `acDigest`, the sha256 of the exact `## Acceptance Criteria` bytes. The run is judged against that snapshot. If the body moves mid-run, flag it and don't chase it. Post the pre-flight comment.
- **`refused`**: nothing was left behind, and `reason` says why. `not-ready` goes back through `prep`. `blocked` goes to the blocking label, which only the user clears. `live-run` means another run owns it, and `found` says where. `body-moved` (the body changed since the chain's user confirmed it) and `missing-ancestor` (a parent's merge commit isn't in the base) go back to the chain's user. Fix anything else it names, or report it.
- **`held`**: another run holds the claim tag. Stop.
- **`unknown`**: something broke, or a cleanup couldn't be confirmed. When `retained` is empty, the claim left nothing behind, so run it again in the foreground up to 3 times, waiting 5 s, 15 s and 45 s before each. Any other `unknown`, or one still there after the third retry: report `reason`, `retained` and `cleanup` verbatim and stop. Don't read it as another run owning the issue, and never delete a tag this run didn't create. A stale tag goes to the user with the branch and PR state it guards.

Pass `--kind` only if the label default is wrong: `bug` is `fix`, `documentation` without `enhancement` is `chore`, and anything else is `feat`.

## Early checkpoint review

On a `standard` or `high` run with more than one checkpoint, you may get an early cross-family review of a verified checkpoint so a defect surfaces before its dependents build on it:

- Review its real commit range: an ancestor base and a head that contains the checkpoint's commits, any interleaved commits included, with no filtered tree.
- Writers keep going only when the reviewer reads a checkout flow's executor pins and closes, which is T3's `seat open --access review`. On any other route, review at a quiet boundary or skip the early pass, because invariant 8's snapshot would move under live writers.
- The reviewer returns coverage for every file in the range. An early pass is never a clean pass and never final coverage, because it doesn't read the head that ships.
- Triage its findings as `babysit` §Triage says, and count its fix batches against the same breaker, with no carve-out. A range with multiple labs' work follows invariant 1.

## Suspending a run

When a `needs-info`, `needs-human`, trust-fork or breaker stop ends the run, the question to the user is your last act, so nothing the run still owes waits behind an answer that may never come. In this order:

1. **Settle every running seat.** Let a seat that's about to commit finish, cancel the rest, and wait until each cancelled seat has stopped, because a seat still running after its cancel can commit behind the check and step 2 would push it. In Codex you can't reach a running seat (§6), so wait for each one to finish instead. Then close every seat and check it against git (invariant 8). Cancelling a task doesn't close its seat.
2. **Finish the mutations:** commit, push, journal, label, comment and ping (`PushNotification` in Claude Code, `notify-send` in Codex). Finish only what the run was already allowed to do; this step never authorizes a new push or more implementation. One exception: when the question is whether something may be pushed at all (such as possible secret material), commit locally and do everything else except the push. Every other trust fork keeps the push, because pushing this run's own feature branch settles nothing about who can reach what.
3. **Remove watchers and scheduled wakes,** as `babysit` §Waiting says.
4. **Read the anchors** that exist right before you ask: the AC digest, the head SHA and the issue's `updatedAt`. A stage with no issue yet, such as a free-text prep, has fewer.
5. **Ask** through the session's question tool, with 2 to 4 options, the recommended one first, and the reason inside the question. With no question tool, the question is the run's final response.

An answer that arrives after the anchors moved is stale. Journal `stale-answer-rejected`, keep `needs-human`, re-read, and ask again against the new state. `needs-human` clears only after that re-check.
