---
name: babysit
description: Watch one open pull request through external review and CI until everything is green, then hand it to the land stage. Validate and fix reviewer findings, answer every thread, and keep the branch rebased. Use when the human asks to monitor, watch, or babysit a PR, and whenever an issue run reaches its pushed PR, which always continues here.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Bash(node:*), Read, Edit, Write, Agent, TaskOutput, TaskStop, SendMessage, Monitor, PushNotification, AskUserQuestion, Skill, mcp__plugin_flow_flow_delegate__delegate_to_codex, mcp__plugin_flow_flow_delegate__delegation_result, mcp__plugin_flow_flow_delegate__delegation_cancel, mcp__plugin_flow_flow_delegate__delegation_steer, mcp__plugin_flow_flow_delegate__delegation_doctor, mcp__t3-code__orchestrator_capabilities, mcp__t3-code__delegate_task, mcp__t3-code__task_status, mcp__t3-code__task_cancel, mcp__t3-code__watch_pull_request, mcp__t3-code__unwatch_pull_request, mcp__t3-code__schedule_task, mcp__t3-code__delete_scheduled_task
---

# babysit: the watch between push and land

Babysit writes to one PR's branch and to the PR, and nothing else. It never merges and never arms auto-merge, because the land stage is the only merge path. It runs on any PR the human names, in a flow-managed repository or not. Everything above `## Host mechanics` is the same on every host.

## Contract

**In**: an open PR, by number or resolved from the current branch. Three origins authorize a run: the human asking to babysit, watch or monitor it; the human naming the PR in words; or an issue run that finished its work, which continues here without asking. A run that escalated or suspended has not finished, and a green build or a PR you noticed is not an invocation.

**Out**: a PR ready to land, with zero unresolved threads, every check green on the current head, and the head rebased on the current base, reported with the land stage named as the next move. Or an escalation: what is stuck, who it waits on, and the state of everything else.

Fix on the PR's branch in the issue run's worktree if it still exists, or in a new one under the canonical checkout's `.flow-worktrees/`, with `/.flow-worktrees/` in `.git/info/exclude`. Never work in the canonical checkout, where the human or another session may be.

## Triage

Validate each finding against the current head first. For a behavioral claim, prefer a failing test, which settles the claim and guards the fix. Each thread then ends in one of three states:

- **Fixed.** The finding is real and in scope. Fix it, run the test that covers it, reply naming the commit, and resolve the thread.
- **Rejected.** The finding is wrong, stale, or about code this PR does not touch. Reply with the concrete reason, such as the guard it missed or the file it misread, and resolve the thread.
- **The human's.** The finding is a judgment call: a contested design point, a scope question, or anything whose dismissal changes the risk posture. Reply with your read, leave the thread open, and report it. Resolve a bot's thread either way, but leave a person's thread you disagree with open for them.

A finding that reveals an open design question is a prep failure found late. Stop fixing, say so, and route the human, because a design decided in review threads is one nobody approved.

Reply and resolve with the two GraphQL mutations in the land stage's Threads section, and read `isResolved` back. `gh pr comment` does neither.

## Rounds

A round goes from what changed to pushed and answered:

1. Gather against the current head: the per-check rollup (never an exit code), new top-level comments, and every unresolved thread. Note the head SHA, because everything this round decides is about it.
2. Rebase first. If the base moved, rebase now, rerun the local tests, and push with `--force-with-lease`. A rebase after the fixes discards the CI runs and bot reviews they earned.
3. Triage and fix every relevant finding and every red check, reproducing it locally and fixing the cause, in atomic conventional commits. A timing-shaped failure in a test this PR never touched may be a base flake: rerun the job once, and if it stays red, report it. Accepting a flake is the land stage's call.
4. Before the push, get one adversarial review of the round's diff from the other family. A round of replies alone has no diff and skips this.
5. Push once, then reply to and resolve the round's threads, citing the pushed SHA.
6. Wait, then gather. The round is clean when CI completed on the new head and the bots posted against it, or when a reasonable quiet interval passed with nothing new.

A watcher only wakes you, and only a gather tells you about the PR. While anything is pending, gather at least every five minutes whether or not a watcher fired, because a reviewer's comment moves no check a watcher waits on. Say the PR waits on something only when a gather in the same turn showed it, naming the head SHA and the pending checks.

Past about five fix rounds, or when fixes keep spawning findings where they land, stop fixing. Hand the survivors to the human with your read on each.

## Report

When the PR is clean, say so, naming the head and the land stage as the next move. Otherwise give its state, what each open item waits on, and what you tried. The thread replies are the audit trail.

## Host mechanics

### Claude Code

**Argument.** The PR number in the `/flow:babysit` invocation, or the one named in words. Empty means the current branch.

**Waiting.** `Monitor` slices of at most five minutes, with an until-condition that covers comments, reviews and threads as well as the check rollup. End every slice with a full gather, whether the monitor fired, timed out or errored. A monitor that errored or timed out is unknown, not quiet.

**Seats.** Fix minor findings inline in the worktree, and hand a substantial round to `flow:implementer` with the worktree path. The cross-family review is `delegate_to_codex` in `adversarial-review` mode.

**Inside T3.** Arm `mcp__t3-code__watch_pull_request` on the PR and a `mcp__t3-code__schedule_task` wake into this thread every 5 minutes or sooner (`schedule: {type: "interval", everyMs: 300000}`, `bindToCurrentThread: true`, a prompt that names the PR), then end the turn. Start every wake, from either source, with a full gather. An errored watch is unknown, not quiet. If you cannot show that `schedule_task` wakes this same thread with its context, keep the `Monitor` waiting above instead. When the PR is clean or escalated, remove both with `mcp__t3-code__unwatch_pull_request` and `mcp__t3-code__delete_scheduled_task`. A fix round's writer and the cross-family review are T3 seats, run through `mcp__t3-code__delegate_task` as the `delegate` skill's `## T3 seats` says, with `mcp__t3-code__task_status` and `mcp__t3-code__task_cancel`. The seats above are their fallback.

### Codex

**Argument.** The PR number in the human's message that names this skill or asks for the watch in words. Empty means the current branch.

**Waiting.** Shell sleeps of at most five minutes inside the turn, each ending in a full gather. A wait too long for one turn ends it with a status line naming what is pending. The human's next message resumes from a fresh gather, never from remembered state.

**Git writes.** The repository grant can leave `.git` read-only, so worktree creation, commits, rebases and pushes go through the normal approval prompt.

**Seats.** Native spawns into the worktree, each small enough to verify with git before the next. The cross-family review is `delegate_to_claude` in `adversarial-review` mode.

**Inside T3.** Arm `mcp__t3_code__watch_pull_request` on the PR and a `mcp__t3_code__schedule_task` wake into this thread every 5 minutes or sooner (`schedule: {type: "interval", everyMs: 300000}`, `bindToCurrentThread: true`, a prompt that names the PR), then end the turn. Start every wake, from either source, with a full gather. An errored watch is unknown, not quiet. If you cannot show that `schedule_task` wakes this same thread with its context, keep the shell-sleep waiting above instead. When the PR is clean or escalated, remove both with `mcp__t3_code__unwatch_pull_request` and `mcp__t3_code__delete_scheduled_task`. A fix round's writer and the cross-family review are T3 seats, run through `mcp__t3_code__delegate_task` as the `delegate` skill's `## T3 seats` says, with `mcp__t3_code__task_status` and `mcp__t3_code__task_cancel`. The seats above are their fallback.
