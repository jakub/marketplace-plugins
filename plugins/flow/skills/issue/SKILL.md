---
name: issue
description: Implement one ready-for-agent issue hands-off, through a pushed, reviewed, evidenced PR, then hand it to babysit. Never merges. Use when the user asks to run a specific issue number. Never start it from a finished prep, a defect you found, or a survey.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Bash(node:*), Read, Edit, Write, TaskOutput, TaskStop, PushNotification, Agent, SendMessage, AskUserQuestion, Skill, mcp__plugin_flow_flow_delegate__delegate_to_codex, mcp__plugin_flow_flow_delegate__delegation_result, mcp__plugin_flow_flow_delegate__delegation_cancel, mcp__plugin_flow_flow_delegate__delegation_steer, mcp__plugin_flow_flow_delegate__delegation_doctor, mcp__t3-code__orchestrator_capabilities, mcp__t3-code__delegate_task, mcp__t3-code__task_status, mcp__t3-code__task_cancel, mcp__t3-code__t3_thread_send
---

# issue

If the user started this, they aren't watching. You own the issue from claim to a pushed, reviewed, evidenced PR, and then you hand it to `babysit`. You never merge and you never retire the worktree. That's `land`'s job.

You're the orchestrator. File scans, command output and diffs live in seats, and decisions stay with you. Pick the seats, models, width and rounds per issue, and journal each choice. However you compose the run, the invariants in step 5 hold.

## Who can start it

Exactly one of these:

- the issue number in the invocation (`/flow:issue 42` in Claude Code, "run issue #42" in Codex),
- the user naming the issue in words,
- the user saying yes to a prep hand-off.

A hand-off line that mentions this stage is not an invocation. A number that isn't a positive integer aborts with usage and changes nothing. If a message mentions `#N` while it describes something else, ask which they mean.

**Done** is an open PR, pushed, reviewed, evidenced and linked with `Closes #N`. Invoke the `babysit` skill with it right away, without asking.

The PR body leads with the problem, then the fix, then one changelog line per commit. It carries a `## Risk` section (the tier, why, any tripwire that raised it, and the issue's `- intended case:` line, unchanged in meaning) and a `## Revert` section, both written from the diff that ships. Never narrow that line, because triage judges findings against it. Revert says what a rollback leaves behind, judged against the data stance in the repo's `AGENTS.md`. With no stance there, a change to persisted state isn't reversible, so say that.

BAD

> ❌ `## Revert` Revert the squash commit.

GOOD

> ✅ `## Revert` Not clean. `git revert` restores the code, but WAL segments this build wrote keep the new layout, and trawl is forward-only. Back up the WAL directory before upgrading. To roll back, stop trawld, restore that backup, then start the old build.

**Or** a clean escalation: `needs-info`, `needs-human` or `needs-rebase`, a comment saying what blocks, and a ping (step 8). An escalation or a suspension stops there, even after a checkpoint push.

## 1. Preflight

Before you change or spawn anything, call `delegation_doctor` and require:

- `ok: true`, meaning the other family's CLI is installed and signed in;
- the canonical repo root among its `roots`;
- your write grant covering `<repo>/.flow-worktrees/`, where the claim puts the worktree.

If any check fails, stop this turn and write nothing: no label, no comment, no ping. Tell the user what to fix. Never mark a failed start `needs-human`, because that label makes the next claim refuse. Never fall back to writing the code yourself because you couldn't spawn a seat.

Where roots come from: in Claude Code, the session's MCP roots plus `CLAUDE_PROJECT_DIR`. In Codex, the directory the session started in, which must be the repo's top level. Codex can leave `.git` read-only, so the claim, commits and pushes go through the normal approval prompt there. Never widen the grant to the repo's parent.

## 2. Claim

Assigning the issue and re-reading it isn't a claim: two runs under one account both see a green re-read. The claim is a tag that origin creates, and `scripts/issue-claim.mjs` owns it. Its header is the protocol.

Run it once, from the canonical checkout (the main working tree, not a linked worktree):

```bash
node <plugin-root>/scripts/issue-claim.mjs claim <N> [--kind feat|fix|chore]
```

Pass `--kind` only if the label default is wrong: `bug` is fix, `documentation` without `enhancement` is chore, and anything else is feat. It prints one JSON line, and `result` is the whole answer:

- **`claimed`**: go. Record `base`, `branch`, `worktree`, `head` and `acDigest`, the sha256 of the exact `## Acceptance Criteria` bytes. The run is judged against that snapshot. If the body moves mid-run, flag it and don't chase it. Post the pre-flight comment.
- **`refused`**: nothing was left behind, and `reason` says why. `not-ready` goes back through prep. `blocked` goes to the blocking label, which only the user clears. `live-run` means another run owns it, and `found` says where. Fix anything else it names, or report it.
- **`held`**: another run holds the claim tag. Stop.
- **`unknown`**: something broke, or a cleanup couldn't be confirmed. Report `reason`, `retained` and `cleanup` verbatim and stop. Don't read it as another run owning the issue, and never delete a tag this run didn't create. A stale tag goes to the user with the branch and PR state it guards.

## 3. Journal

Three kinds of issue comment, and no others:

1. **Pre-flight**, before work starts: the base SHA, the AC digest, the risk tier, the seats with their models, efforts and why, and the CI mapping invariant 3 asks for.
2. **Events**, as they happen: a tripwire fired, the run widened or narrowed, a fork guessed, a seat re-run on a stronger model, the fix-round total, the breaker tripped, a stale answer rejected. Each review round adds one triage line per finding: the reviewed head, the finding's title and location, its basis, its disposition, the obligation or exclusion, the reason, and an evidence link. Several lines can share one comment.
3. **Final**: a verdict per criterion, and coverage: which seats actually looked at the diff versus the ones you planned, by name.

When you recover from anything, re-read live state. A journal line never authorizes a later action on its own.

## 4. Design pass

Every `standard` or `high` run gets one, even when prep or an ADR settled the spec. A `low` run skips it, because prep's dialectic already shaped the change, but a `low` run with more than one checkpoint still writes the checkpoint plan below. Start the native leg, then the other-family leg, so both land in the same turn:

- The native leg frames the smallest change with the most reuse, grounded in the real code seams.
- The other-family leg is blind. It proposes its own shape and explicitly calls out what the issue left unsaid or poorly defined.

Synthesize them yourself, and resolve each disagreement out loud instead of averaging. Say where each new thing lives and why, which layer enforces each invariant, and the checkpoint plan.

The checkpoint plan lists each checkpoint's id, the files it owns (invariant 6), its parents, premise checkpoints included, and its difficulty. Difficulty is about what could break, never file count, and it picks each write seat's rung. Add a shared or exclusive constraint only where it affects scheduling, such as a fixed port or one test database. Schedule the checkpoints from the plan:

- A checkpoint starts once every parent's commits passed invariant 8's git check and the parents' named checks are green on those commits. It doesn't wait for unrelated checkpoints. A dependent waits for evidence on its parent's current state, and never inherits a green from an earlier one.
- Done means committed and verified on the run branch, never merged.
- A premise checkpoint runs at its first eligible point, because a failed premise changes what its dependents build against.
- When a parent changes or a premise fails, pause or steer its dependents with the verified state (step 6), and recheck each one before it counts as done. A steer is how the change reaches a dependent, not proof the dependent absorbed it.
- A failed premise whose decision is the user's goes to step 8.

Open design questions found mid-run means prep missed something. A small shape question is a fork (step 8), journaled as a prep-gap event. A genuinely open design is `needs-info`, back through prep.

## 5. Invariants

1. **Review crosses families per diff.** A PR with native-written and delegated-written work needs a reviewer from each family.
2. **Someone tries to break it.** Tell at least one review seat to refute the change, not summarize it. Brief the first review as `babysit` §Rounds says, on every route. A reviewer's failing test is evidence, not a way past triage, and a Fixed finding's test follows `babysit` §Triage. If the fixer thinks the test encodes the wrong requirement, it says so instead of satisfying it.
3. **Unknown is not a pass.** CI is green only on a head you checked is in sync (the local SHA equals the PR's `headRefOid`) and that you actually saw. Never infer it from an exit code. A `failed`, `cancelled` or `unknown` review job is a missing seat, not a clean review.
   - Before a push, run the tests the checkpoints named and every command the repo's `AGENTS.md` or `CLAUDE.md` requires. Leave any other suite that a CI job runs to that job, because CI runs it on the same head and a local copy of that run adds no evidence.
   - Record once, in the pre-flight journal, which CI job runs each remaining suite: the job, its command, and the matrix or environment that selects the suite. Reuse that mapping until the run changes the workflow files or the test commands.
   - On every synced head, read that job's actual result. A job that was skipped, path-filtered or unreadable on that head is no evidence, so run its suite locally on that head and journal the result before you count the head validated. `land` reads a skipped check as a pass, so nothing later catches it.
   - A suite no CI job runs stays local. With no CI, everything stays local, and `land` still refuses `ci-unknown`.
4. **Every criterion has evidence a stranger can re-run.** Each gets a verdict and a pointer in the PR's evidence ledger, reproducible from the merged repo alone with a committed test, script or artifact. Journal prose is narrative. An expiring URL is evidence with a TTL.
5. **Stop on evidence, not exhaustion.** The issue's `## Risk` tier sets the bar, and no section means `standard`. `low` and `standard` converge on one clean adversarial pass from the family that didn't write the fix. `high` needs two clean passes in a row from different seats, and a security seat is one of the reviewers. Triage every finding as `babysit` §Triage says, and count a pass as clean only by its definition there. The final pass sweeps the whole diff file by file and lists what it read and skipped, and a file no reviewer named since the last fix round is a gap. A `flow_delegate` review returns no such list, so continue that job and ask for one before the pass counts. Count fix rounds against the breaker in `babysit` §Rounds, exactly 3 on `low` and 5 otherwise, which says what a round is and what to do when it trips. Journal the running total after every fix round, because `babysit` continues the count instead of resetting it.
   - On a `standard` or `high` run with more than one checkpoint, you may get an early cross-family review of a verified checkpoint, so a defect surfaces before its dependents build on it. Review its real commit range: an ancestor base and a head that contains the checkpoint's commits, any interleaved commits included, with no filtered tree. Writers keep going only when the reviewer reads a checkout flow's executor pins and closes, which is T3's `seat open --access review`. On any other route, review at a quiet boundary or skip the early pass, because invariant 8's snapshot would move under live writers. The reviewer returns coverage for every file in the range. An early pass is never a clean pass and never final coverage, because it doesn't read the head that ships. Triage its findings as `babysit` §Triage says, and count its fix batches against the same breaker, with no carve-out. A range with both families' work follows invariant 1.
6. **One file, one writer.** No two seats hold the same file at once, and each stages only its own paths, because the index is shared. Notes, logs, captures and anything else the run won't commit go in the worktree's `.flow-scratch/`, which the claim git-ignores. Never put them in /tmp or the workspace root, because `land` retires scratch with the worktree. Say so in each seat's task.
   - A `flow_delegate` writer can edit but not commit, so tell it that. When it returns, verify it (invariant 8), stage its files by path, and commit them. Name the seat in the journal, never in the commit.
   - A T3 writer commits its own paths with `git -C <wt> commit -- <paths>`, and invariant 8 checks those commits.
7. **Refusals get routed.** The charter's refusal rule binds every judgment and security seat. A null counts as a refusal, so the retry crosses families, and a second null is reported, never swallowed. A security seat that refused, died or errored goes in the final journal as an unavailable security review.
8. **Seat reports are claims.** Before you act on "done" or "blocked", run `git -C <wt> log` and `git -C <wt> status` and compare. Nudge a seat that stopped mid-task with the state you verified. Re-run a seat that fabricates twice on a stronger model, and journal it. Snapshot the tree with `node <plugin-root>/scripts/tree-snapshot.mjs <wt>` before each review seat spawns and when it returns. Any difference means the review doesn't cover what ships: stop, name the path, and find what wrote it. For a T3 review seat, `seat open` and `seat close` do this for you: open pins a detached worktree at the head, and close checks it unmoved and clean, snapshots the canonical checkout, and compares the review's coverage with the pinned diff.

## 6. Seats

- **In T3 Code**, every seat is a T3 seat through `delegate_task` (see the `delegate` skill's `## T3 seats`). Wait, steer and close as its §3–§5 say, stop a seat with `task_cancel`, and act on the `seat close` verdict. Preflight's doctor still runs, because `flow_delegate` is the cross-family fallback, and the native seats below are the same-family one.
- **In Claude Code**, `flow:implementer` writes and `flow:reader` scouts, proposes and reviews. Run a long or parallel `flow_delegate` call through `flow:bridge`. `SendMessage` reaches a running seat with state you verified, `TaskOutput` reads its stream, and `TaskStop` ends it.
- **In Codex**, use native spawns, one checkpoint each. You can't reach a running seat, so verify a parent with git before its dependents start (step 4), and `followup_task` a finished seat with verified state.

## 7. Tripwires

Size isn't fixed at launch. Each of these raises the tier one step and forces a rethink of seats and rounds, journaled as an event:

- the diff touches a trust boundary the issue never mentioned: auth, input parsing, shell, SQL or template construction, secrets;
- the diff grows past about twice the planned file count;
- fix rounds churn on one area, with each fix spawning findings where it lands. Re-triage the churning findings against the intended case first, and raise the tier only if intended-case defects survive;
- the two families' reviewers disagree hard on the same code.

A trust boundary makes the run `high` outright. Nothing lowers the tier mid-run, because a run that talks itself into less review is exactly what the tier guards against.

## 8. Forks and escalation

A fork is the user's only when it's genuinely theirs to pick: two designs both defensible on the merits, a contested finding whose dismissal changes the risk posture, or a scope question the issue can't settle.

**Optional forks.** A remedy that expands the approved responsibility, the supported behavior or the trust posture is never one. It goes to the user before anyone writes it, because guessing it grows the work. Otherwise, if you can ask and get the answer in the same turn, ask, with the consequence on each option. If they dismiss it, decide and journal. If asking would end the turn, don't ask. Decide, journal a `fork guessed` event naming the rejected option and why, and keep going.

**Trust-model forks** set the posture of a trust boundary: who can reach what, what an unattended tool reads or publishes, where authority ends. Always ask these, on every host, because reviewers will ratify a coherent guessed posture instead of contesting it. When asking ends the turn, take the conservative posture (confine, refuse, least reach), journal it, and stop as "Suspending" says, with the `needs-human` label.

**Suspending.** When a `needs-info`, `needs-human`, trust-fork or breaker stop ends the run, the question to the user is your last act, so nothing the run still owes waits behind an answer that may never come. In this order:

1. **Settle every running seat.** Let a seat that's about to commit finish, and cancel the rest. Then close every seat and check it against git (invariant 8). Cancelling a task doesn't close its seat.
2. **Finish the mutations:** commit, push, journal, label, comment and ping. Finish only what the run was already allowed to do. This step never authorizes a new push or more implementation. One exception: when the question is whether something may be pushed at all, such as possible secret material, commit locally and do everything else except the push. Every other trust fork keeps the push, because pushing this run's own feature branch settles nothing about who can reach what.
3. **Remove watchers and scheduled wakes,** as `babysit` §Waiting says.
4. **Read the anchors** that exist, right before you ask: the AC digest, the head SHA and the issue's `updatedAt`. A stage with no issue yet, such as a free-text prep, has fewer.
5. **Ask** through the session's question tool, with 2 to 4 options, the recommended one first, and the reason inside the question. With no question tool, the question is the run's final response.

An answer that arrives after the anchors moved is stale. Journal `stale-answer-rejected`, keep `needs-human`, re-read, and ask again against the new state. `needs-human` clears only after that re-check.

**Escalate early.** A blocking question the issue, code and docs can't settle is `needs-info` the moment you find it, not after you guessed an implementation. Every escalation is a label, a comment saying what blocks, then a best-effort ping: `PushNotification` in Claude Code, `notify-send` in Codex (silent over SSH). A stop that "Suspending" covers then ends with the question, in its order. Nothing tests whether the user is present. The label and the comment stay the record, and an unanswered question leaves the run stopped. Preflight stops (step 1) and optional forks keep their own paths.
