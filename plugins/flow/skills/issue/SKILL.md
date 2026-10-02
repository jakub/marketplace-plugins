---
name: issue
description: Hands-off implementation of one ready-for-agent issue, through a pushed, reviewed, evidenced PR and no further. The orchestrator composes the seats per issue, contains every writer, journals every call to the issue, and never merges. MUST only run when the human explicitly asks to run a specific issue number; never start it from adjacent work, a finished prep, a discovered defect, or a survey of what to do next.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Bash(node:*), Read, Edit, Write, TaskOutput, TaskStop, PushNotification, Agent, SendMessage, AskUserQuestion, Skill, mcp__plugin_flow_flow_delegate__delegate_to_codex, mcp__plugin_flow_flow_delegate__delegation_result, mcp__plugin_flow_flow_delegate__delegation_cancel, mcp__plugin_flow_flow_delegate__delegation_steer, mcp__plugin_flow_flow_delegate__delegation_doctor
---

# issue: the autonomous middle

This stage drives a prepped issue hands-off to a pushed, reviewed, evidenced PR and stops there. It never merges and never retires the worktree, because the land stage does both. Everything above `## Host mechanics` is the same on every host. Read your host's subsection before step 1.

File scans, command output and diffs live in seats, and decisions stay with you. Choose seats, models, width and rounds per issue and journal each choice. The invariants of §5 hold however you compose the run.

## 1. Contract

**In**: an open issue labeled `ready-for-agent`, named by number. Three origins authorize a run: the number carried by the invocation, the human naming the issue in words, or the human's go-ahead on a hand-off out of prep. A hand-off line that names this stage is not an invocation. Anything else is a stop.

**Out**: an open PR, pushed, reviewed, evidenced and linked with `Closes #N`. Or a clean escalation: `needs-info`, `needs-human` or `needs-rebase`, a comment saying what blocks, and the notice of §8.

When the run finishes its work, invoke the babysit stage with the PR number, without asking. The finished run authorizes that hand-off, not the push alone. An escalation or a suspension reports what blocks and stops, even after a checkpoint push.

## 2. Preflight

Before any mutation or spawn, call `delegation_doctor`. Require `ok: true`, which means the other family's CLI is installed and signed in, and require the canonical repository root among its `roots`. Require the host's write grant to cover `<repo>/.flow-worktrees/`, where the claim puts the worktree. If a check fails, stop in this turn and write nothing, not even a label, a comment or a ping, and tell the human what to fix. Never mark a failed start `needs-human`, because that label makes the next claim refuse. Never fall back to writing the code yourself because no seat can be spawned.

## 3. Claim

Assigning the issue and re-reading it is not a claim, because two runs under one account both see a green re-read. The claim is a tag that origin creates, and `scripts/issue-claim.mjs` owns it. Its header is the protocol.

Run `node <plugin-root>/scripts/issue-claim.mjs claim <N>` once, from the canonical checkout: the main working tree, not a linked worktree. Pass `--kind feat|fix|chore` only when the label default is wrong for the work (`bug` is fix, `documentation` without `enhancement` is chore, and anything else is feat). It prints one JSON line, and `result` is the whole answer:

- `claimed`: proceed. Record `base`, `branch`, `worktree`, `head` and `acDigest`, the sha256 of the exact `## Acceptance Criteria` bytes. The run is judged against that snapshot. Flag a body that moves mid-run, and do not chase it. Post the launch comment.
- `refused`: this run left nothing behind, and `reason` names the cause. `not-ready` routes the human back through prep. `blocked` routes them to the blocking label, which only they clear. `live-run` means another run owns the issue, and `found` says where. Fix anything else it names, or report it.
- `held`: another run holds the claim tag (`claim-held`). Stop.
- `unknown`: an operational failure, or a cleanup the executor could not confirm. Report `reason`, `retained` and `cleanup` verbatim, and stop. Never read `unknown` as another run owning the issue, and never delete a tag this run did not create. A stale tag goes to the human with the branch and PR state it guards.

## 4. Journal

Post three kinds of issue comment, and no others:

1. Launch, before work starts: the base SHA, the AC digest, and the seats with their models, efforts and reasons.
2. Events, as they happen: a tripwire fired, the run widened or narrowed, a fork guessed, a seat re-run on a stronger model, the breaker tripped, a stale answer rejected.
3. Final: a verdict per criterion, and coverage: the seats that actually looked at the diff against the ones planned, by name.

At any recovery, re-read state live. A journal line never authorizes a later action by itself.

## 5. Invariants

1. **Decorrelation.** The charter's cross-family review applies per diff, so a PR with native-written and delegated-written work needs a reviewer from each family.
2. **Adversarial minimum.** At least one review seat is told to refute the change, not to summarize it. A finding backed by a failing test it wrote skips adjudication, and its fix keeps that test as the regression guard. A fixer that thinks the test encodes the wrong requirement says so instead of satisfying it.
3. **UNKNOWN is not a pass.** CI is green only on a head you verified in sync (the local SHA equals the PR's `headRefOid`) and observed, never inferred from an exit status. A `failed`, `cancelled` or `unknown` review job is an unavailable seat, never a clean review.
4. **Evidence per criterion, re-executable from the tree.** Every criterion gets a verdict and a pointer in the PR's evidence ledger. A stranger with only the merged repository must be able to reproduce it from a committed test, script or artifact. Journal prose is narrative, and an expiring URL is evidence with a TTL.
5. **Termination on evidence.** Standard work converges on one clean adversarial pass from the family that did not write the fix. Trust-boundary contact or a churning run needs two consecutive clean passes from different seats. The final pass sweeps the whole diff at file granularity and lists what it read and what it skipped, and a file no reviewer named since the last fix round is a gap. A review's `findings: []` carries no such list, so continue that job and ask for the files read and skipped before the pass counts. Past about five fix rounds, stop fixing: hand the survivors to a seat picked for settling conflicting reviewers, and escalate the real ones to the human instead of shipping them.
6. **Containment.** No two seats hold the same file at once, and each stages only its own paths, because the index is shared. A delegated writer can edit but not commit, so say so in its task. When it returns, verify it under invariant 8, stage its files by path, and commit with the seat named in the message body.
7. **Refusal routing.** The charter's refusal rule binds every judgment and security seat. A null answer counts as a refusal, so the retry crosses the family line, and a second null is reported, never swallowed. A security seat that still refused, died or errored goes in the final journal as an unavailable security review.
8. **Seat reports are claims.** Before you act on a completion or blocker report, run `git -C <wt> log` and `git -C <wt> status` and compare them with what the seat says. Nudge a seat that stopped mid-task with that verified state. Re-run a seat that fabricates twice on a stronger model, and journal it. Run `node <plugin-root>/scripts/tree-snapshot.mjs <wt>` before each review seat spawns and again when it returns. On any difference the review does not cover the diff that ships: stop, name the path that moved, and find what wrote it.

## 6. Design pass

Every production-code run gets a design pass, even when prep or an ADR settled the spec. Launch the native leg first, then the other-family leg attached, so both sheets land in the same turn. The native leg frames the smallest change with the most reuse, grounded in the real code seams. The other-family leg is blind: it proposes its own shape and names what the issue left unsaid. Synthesize inline, and resolve each disagreement explicitly instead of averaging.

The synthesis states where each new thing lives and why, which layer enforces each invariant, and the checkpoints with a difficulty for each. That difficulty, judged on what could break and never on file counts, picks each write seat from the charter's models. A doc-only, config-only or comment-only change can shrink the pass to one cross-family check, never to nothing.

Open design found mid-run is a prep failure. A small shape question is a fork (§8), journaled as a prep-gap event. A genuinely open design is `needs-info`, back through prep.

## 7. Tripwires

Size is not fixed at launch. Each of these forces a rethink of seats and rounds, journaled as an event:

- the diff touches a trust boundary the issue never mentioned: auth, input parsing, shell, SQL or template construction, or secret handling;
- the diff grows past about twice the planned file count;
- fix rounds churn on one area, with fixes spawning findings where they land;
- reviewers from the two families disagree hard on the same code.

## 8. Forks, suspension and escalation

A fork is the human's only when it is theirs to pick: rival designs both defensible on the merits, a contested finding whose dismissal changes the risk posture, or a scope question the issue cannot settle.

**Optional forks.** Where asking answers inside the turn, ask, with a consequence on each option. If the human dismisses the question, decide and journal. Where asking ends the turn, never ask. Decide, journal a `fork guessed` event naming the rejected alternative and why, and keep moving.

**Trust-model forks** set the posture of a trust boundary: who may reach what, what an unattended tool reads or publishes, and where authority ends. Ask them on every host, because reviewers ratify a coherent guessed posture instead of contesting it. Unanswered, the run does not continue: take the conservative posture (confine, refuse, least reach), label `needs-human`, journal it, and stop.

**Suspension**, where asking ends the turn. Finish every mutation first: commit, push, journal event, label and notice. Then, just before asking, read the anchors: the AC digest, the head SHA and the issue's `updatedAt`. One fork changes the order. When the question is whether content may be pushed or published at all, such as possible secret material, commit locally and do everything else except the push. Every other trust fork keeps the push, because a push to this run's own feature branch settles nothing about who may reach what.

An answer that arrives over moved anchors has expired. Journal `stale-answer-rejected`, keep `needs-human`, re-read the moved state, and ask again against it. `needs-human` clears only after that re-check.

**Escalate early.** A blocking question that the issue, the code and the docs cannot settle is `needs-info` the moment you find it, not after an implementation guess. Every escalation is a label, a comment saying what blocks, and then a best-effort ping, which your host's subsection names. The label and the comment are the durable part.

## Host mechanics

### Claude Code

**Argument.** The issue number in the `/flow:issue` invocation, or the one the human named in words. Anything but a positive integer aborts with usage and changes nothing.

**Roots.** The doctor's `roots` are the session's MCP roots plus `CLAUDE_PROJECT_DIR`.

**Seats.** `flow:implementer` writes, and `flow:reader` scouts, proposes and reviews. Run a long or parallel delegate call through `flow:bridge`.

**A running seat.** `SendMessage` reaches it with state you verified with git. `TaskOutput` reads its stream, and `TaskStop` ends it.

**Hand-off.** Invoke `flow:babysit` through the `Skill` tool with the PR number.

**Ping.** `PushNotification`, one line naming the issue and what blocks, after the label and the comment are on the issue.

### Codex

**Argument.** The number in the human's message that names the `issue` skill or asks in words to run an issue. A message that mentions `#N` while it describes something else ends the turn with a question asking which.

**Roots.** Open the project at the canonical checkout. The doctor's one root is the directory the session started in, when that is the repository's top level. The write grant covers `.flow-worktrees/`, but `.git` can stay read-only, so the claim, commits and pushes go through the normal approval prompt. Never widen the grant to the repository's parent.

**Seats.** Native spawns, one checkpoint each. A running seat cannot be reached, so verify with git between batches, and `followup_task` a finished seat with verified state.

**Hand-off.** Invoke the `babysit` skill by name with the PR number.

**Ping.** `notify-send`, one line naming the issue and what blocks. It is silent over SSH, where there is no session bus.
