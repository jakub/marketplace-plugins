---
name: babysit
description: Watch one open pull request through external review and CI until everything is green - validate and fix reviewer findings, answer every thread, keep the branch rebased - then hand it to the land stage. Use when the human asks to monitor, watch, or babysit a PR, or when the request that launched an issue run also asked for its PR to be seen through review.
---

# babysit - the watch between push and land

The issue stage stops at a pushed PR, and the land stage gates a finished one. This skill is the stretch in between: external reviewers and CI keep arriving after the push, and someone has to read them, fix what is real, answer what is not, and keep the branch mergeable while other PRs land around it. That someone is you, in rounds, until the PR is clean or a human is needed.

This is not a stage. It writes to one branch and its PR, never merges, never touches the issue tracker beyond the PR itself, and can run standalone on any PR the human names, flow-managed repository or not.

## The contract

**In**: an open PR, by number or resolved from the current branch. Three origins authorize a run: the human asking to babysit, watch, or monitor it; the human's go-ahead on a hand-off out of an issue run; or the message that launched that issue run having asked up front for the PR to be watched through review. A green build in the transcript, or a PR you merely noticed, is not an invocation.

**Out**: a PR that is ready to land - zero unresolved threads, every check green on the current head, the head rebased on the current base - reported to the human with the land stage named as the next move. Or an escalation: a plain statement of what is stuck, who it is waiting on, and the state of everything else. Never merge, and never arm auto-merge: the land stage is the only merge path, and in a flow-managed repository the publish guard denies a raw merge anyway.

**Where the writes go.** Fixes land on the PR's branch in a worktree. An issue run's worktree, if it still exists, is that worktree; otherwise create one as a sibling of the repository and check the PR branch out into it. Never babysit on the canonical checkout - the human, or another session, may be standing in it.

## The reviewers

The projects here typically carry GitHub-hosted review bots - CodeRabbit, Macroscope, Greptile - alongside any human reviewers. The bots are useful and wrong often enough that neither blanket-accepting nor blanket-dismissing them survives contact. So every finding gets the same treatment: validate it against the actual code before anything else. Read the lines it cites, check the claim holds on the current head, and for a behavioral claim, prefer demonstrating it - a failing test that proves the finding skips the argument entirely and becomes the regression guard for its fix.

Each thread then ends in exactly one of three states:

- **Fixed**: the finding was real and in this PR's scope. Fix it, verify the fix by running the test that covers it, reply naming the commit, resolve the thread.
- **Rejected**: the finding is wrong, or right about code this PR does not touch. Reply with the concrete reason - the guard the bot missed, the invariant that makes it safe, the file it misread - and resolve the thread. A rejection with no reply is indistinguishable from a miss, and the reply is what makes the dismissal auditable later.
- **Human's**: the finding is a judgment call - a contested design point, a scope question, anything whose dismissal changes the risk posture. Reply with your read, leave the thread unresolved, and surface it in your report. A bot thread is yours to resolve either way; a human reviewer's thread you disagree with stays open for them, because resolving over a person is how a real objection gets buried.

Findings that reveal an open design question are none of the three. That is a prep failure surfacing late; stop fixing, say so, and route the human, because a design decided in review threads is a design nobody ratified.

The reply and resolve mutations, and why `gh pr comment` is neither, live in the land stage skill's Threads section. Use those exact mutations and read `isResolved` back as proof.

## The round

Work in rounds. A round is one pass from "what changed" to "pushed and answered", and the loop is: gather, rebase, triage, fix, review, push, respond, wait.

1. **Gather** against the current head: the check rollup per check (never an exit code), new top-level comments, and every unresolved review thread. Note the head SHA you gathered at; everything this round decides is about that head.
2. **Rebase first, not last.** Overlapping PRs are normal here, so check whether the base branch moved. If it did, rebase onto it now, rerun the local test suite, and push with `--force-with-lease` (the git guard denies bare `--force`, and with-lease is also simply correct: it refuses when the remote moved under you). Rebasing at the top of the round costs one CI cycle; rebasing after the fixes throws away the bot reviews and CI runs the fixes just earned.
3. **Triage and fix.** Every relevant finding through the three-state treatment above, plus any red check: reproduce the failure locally, fix the cause, keep the round's commits atomic and conventional. A failure in a test this PR never touched, timing-shaped rather than value-shaped, may be base flake: rerun the failed job once, and if it stays red, surface it instead of looping - flake acceptance is the land stage's ritual, not yours.
4. **Cross-family review before the push.** The charter's decorrelation rule does not pause because the diffs got small: the round's batched diff gets one adversarial review from the other model family before it ships. A round that produced no code - replies and resolutions only - has no diff and skips this.
5. **Push once per round**, then reply to and resolve the round's threads, citing the pushed SHA.
6. **Wait, then verify the wait.** The bots re-review the new head and CI reruns, neither instantly. A round is not clean because the PR was quiet the moment you pushed: it is clean when CI has completed on the new head and the bots have either posted against it or a reasonable quiet interval has passed with nothing arriving. Then gather again; the next round starts only if the gather found something.

Multiple rounds are the expected shape, not a failure. But churn is a signal: past roughly five fix rounds, or when a fix keeps spawning findings where it landed, stop fixing. Summarize the survivors, your read on each, and hand the set to the human - a breaker that trips loudly beats a babysitter that argues with a bot all night.

## Reporting

When the PR is clean, say so plainly: every thread resolved, every check green on the named head, rebased on the current base, ready to land through the land stage. When it is not, say what state it is in, what each open item waits on, and what you already tried. Either way the threads themselves carry the audit trail - that is why every one of them got a reply.

## Host mechanics

Read the subsection for your host.

### Claude Code

**Argument.** `$ARGUMENTS` from the `/flow:babysit` invocation is the PR number; empty means resolve from the current branch. The human asking in words works the same.

**Waiting.** Prefer a real wait over a hot poll: the Monitor tool with an until-condition over the PR's checks and comments, or a scheduled wakeup where the session offers one, and bounded `gh` polls otherwise. A monitor that errors or times out is UNKNOWN, not quiet - re-read the PR before trusting it.

**Seats.** Minor fixes are yours inline in the worktree; a substantial fix round goes to an implementer seat handed the worktree path. The cross-family review is a `delegate_to_codex` review-mode call per the delegate skill.

### Codex

**Argument.** The PR number in the human's message naming this skill or asking for the watch in words; empty means the current branch. There is no slash command here.

**Waiting.** Poll with bounded shell sleeps inside the turn. A wait too long to hold in one turn ends it with a status line naming what you are waiting for; the human's next message resumes the watch from a fresh gather, never from remembered state.

**Seats.** Fix seats are native spawns into the worktree; the cross-family review is a `delegate_to_claude` review-mode call per the delegate skill. A running seat cannot be reached here, so keep fix batches small enough to verify against git between spawns.
