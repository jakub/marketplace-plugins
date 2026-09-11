---
name: issue
description: Hands-off implementation of one ready-for-agent issue, through a pushed, reviewed, evidenced PR and no further. The orchestrator composes the seat fabric per issue, contains every writer, journals every call to the issue, and never merges. MUST only run when the human explicitly asks to run a specific issue number; never start it from adjacent work, a finished prep, a discovered defect, or a survey of what to do next.
disable-model-invocation: true
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Bash(node:*), Read, Edit, Write, Workflow, TaskOutput, TaskStop, PushNotification, Agent, SendMessage, AskUserQuestion, Skill, mcp__plugin_flow_flow_delegate__delegate_to_codex, mcp__plugin_flow_flow_delegate__delegation_status, mcp__plugin_flow_flow_delegate__delegation_result, mcp__plugin_flow_flow_delegate__delegation_events, mcp__plugin_flow_flow_delegate__delegation_cancel, mcp__plugin_flow_flow_delegate__delegation_steer, mcp__plugin_flow_flow_delegate__delegation_continue, mcp__plugin_flow_flow_delegate__delegation_doctor
---

# issue - the autonomous middle of the prep → issue → land process

Prep hardened the issue. This stage drives it, hands-off, to a pushed, reviewed, evidenced PR and stops there. The land stage is the only merge path.

Everything up to `## Host mechanics` is the same on every host; read your host's subsection there before step 1. Picking a seat, asking the human a question and reaching the other model family are the charter's, and whether asking ends the turn decides which forks get asked at all (§9).

Compose the run inline to fit the issue. The set of seats is its fabric; flex seats, models and rounds as needed, and journal every call.

## Core principles

1) You orchestrate inline. File scans, command output and diffs live in seats.
2) The invariants in §5 bind however you orchestrate. Fabric width, seats, modes and rounds are yours to flex, and every flex is journaled.
3) Hands-off by default. The only mid-run questions are forks genuinely the human's to pick, and a trust-model fork is never guessed and never continued past.
4) The issue is the record. The journal comments are what a human reads to audit the run, and the only recovery trail there is.
5) Never merge, never retire the worktree. The PR is where this stage stops, and the land stage cleans up after itself.

## 1. The contract

**In**: an open issue labeled `ready-for-agent`.

The argument is an issue number. Three origins authorize it: the argument carried by the invocation, the human naming the issue in words, or the human's own go-ahead on a hand-off out of the prep stage. A hand-off line that names this stage is not an invocation - the human's next message is. Anything else is a stop.

The claim executor (§3) re-reads the issue and refuses one that is closed, one without `ready-for-agent`, or one carrying a blocking label (`needs-human`, `needs-info`, `needs-rebase`). On `not-ready` route the human back through the prep stage; on `blocked` route them to the blocker, which only they clear.

All work happens in a worktree at `<repoRoot>/.flow-worktrees/<repoName>-issue-N-<slug>`, on branch `feat|fix|chore/issue-$N-<slug>`, based at the head the claim verified. The executor creates the container, branch and worktree after it acquires the claim and rechecks readiness. The `-issue-N-` name remains visible to the existing live-run scanners.

Workspace boundary. First run `node <plugin-root>/scripts/issue-claim.mjs plan <N>` from the canonical primary checkout. The plan performs read-only issue, path and repository checks and prints the exact `repoRoot`, `worktree`, `branch` and `acDigest`. It creates no directory and edits no ignore file. The checkout must have a real `.git` directory with its common Git metadata inside that checkout. Linked checkouts, redirected metadata, symlinked containers and occupied targets fail the checks. An existing target must be a real empty directory.

The planned path must sit inside the host's writable repository grant. Prove that before the first mutation, using your host's subsection. The bridge also checks its workspace boundary on every call. A successful bridge check authorizes that delegation job, and does not grant your own shell or native seats more access.

**Out**: an open PR, pushed, reviewed, evidenced and `Closes #N`-linked. Or a clean escalation: `needs-info`, `needs-human` or `needs-rebase`, labeled, with a comment saying what is blocking, and the escalation notice of §9. A run that never got past the preflight is not an escalation at all: it stops in the turn and leaves the issue untouched (§2). Never merge.

The stage itself always stops at the pushed PR, and then hands that PR to the `babysit` skill. Continue into it after the final journal, on every run that reaches a push, without asking first: the watch is how a pushed PR becomes a landable one, not a favour the human has to request. An escalation and a suspension are not pushes, so neither hands off; there the final report names what is blocking and stops.

## 2. The write-seat preflight

This runs before any mutation, and "any" is literal: no assignment, no label, no comment, no claim tag, no branch, no worktree, no spawn happens until it passes. There is no exemption, and a failure leaves the issue exactly as it found it. A host that cannot run this stage must never stamp `in-progress` on an issue and walk away.

Run `delegation_doctor` with `cwd` equal to the plan's `repoRoot`, before the planned worktree exists. Require `checks.workspace.ok`, `selectedCwd` equal to `repoRoot`, and `usableRoots` containing that canonical repository root. Your host's subsection states whether additional roots are allowed. Also require the host's writable repository grant to cover the planned nested worktree. These are separate checks: the doctor reports bridge authority, while the host enforces your session's writes. Read the host capabilities from the same result. Its `hostCapabilities` block carries one entry per capability id with `supported`, `verifiedAt`, `assurance` and a note, and a `drift` block the service computes: `installed`, the host CLI version the doctor observed; `verifiedAgainst`, the version the table was last checked on; and `status`, one of `match`, `newer`, `older`, `unknown`. Do not compute drift yourself from the strings.

- `match`: proceed.
- `newer`: proceed and journal a `host newer than verified` event with both versions. Re-verification of `capabilities.json` is manual maintenance outside this run; no scheduled check reads drift status. See Known gaps for the accepted exposure.
- `older` or `unknown`: stop. Every capability the run depends on reads `unverified`.

A failed preflight stops the run and writes nothing: no label, no comment, no ping. Nothing has been claimed, no seat is running, and the human who named this issue is still here, so the report goes to them in the turn - what failed and which project root or setup prerequisite must be corrected before retrying the same issue request. `needs-human` is for a block found mid-run, where a durable marker is the only way the human learns of it; a stage that never started needs no marker, and the label would make the relaunch this stop just recommended fail the claim of §3. No inline edits happen for the rest of the run either: writing the code yourself because no seat can be spawned is the fallback this preflight exists to catch.

A passed preflight leaves the charter's latitude exactly as ratified. Minor inline edits and scratch scripts are orchestrating; substantial writing goes only to contained seats.

## 3. The claim

Assigning the issue and re-reading it is not a claim: two runs under one account both see a green re-read. The mutual exclusion is a tag on origin, created server-side, and `scripts/issue-claim.mjs` owns it.

Run `node <plugin-root>/scripts/issue-claim.mjs claim <N>` from the repository root, once. It scans local worktrees and branches, remote issue branches and open PRs for a live run. It accepts only an absent target or a real empty directory. After taking the tag, it repeats the scan and checks readiness and the target again. It then creates the private `.flow-worktrees` container, adds `/.flow-worktrees/` to `.git/info/exclude`, and creates the worktree and branch at origin's verified main. It confirms Git registered that exact path and branch, pushes the branch, moves the issue to assigned plus `in-progress`, and releases the tag once the branch reads back on origin. The local container and ignore entry are idempotent setup and may remain after a later failed claim. It prints one JSON line, and its `result` is the whole answer:

- `claimed`: proceed. Record `base`, `branch`, `worktree`, `head` and `acDigest`, the sha256 of the exact bytes of `## Acceptance Criteria`. The run is judged against that snapshot; a body that moves mid-run is flagged, not chased. Post the launch comment of §4 now.
- `refused`: no claim tag, worktree or branch from this run remains, because the executor confirmed cleanup and `retained` is empty. The local container and ignore entry may remain. `reason` says why and the executor's header lists every reason with its fix, so fix what it names or route the human. `live-run` means another run owns this issue and `found` says what it saw. The issue is re-read under the tag, so `issue-closed`, `not-ready` and `blocked` can also arrive at `phase: acquired` after a confirmed abandon.
- `held`: another run held the tag before this run pushed anything (`phase: pre-acquire`, `retained` empty). Stop. A hold observed only after this run's own push is ambiguous and comes back as `unknown` with `reason: acquire-ambiguous` instead.
- `unknown`: an operational failure or a cleanup the executor could not confirm. `reason`, `phase` (`pre-acquire`, `acquired`, `published`) and `retained` (`claim-tag`, `worktree`, `local-branch`, `remote-branch`) say what is left; the executor's header defines each. Report all three verbatim and stop. Never read `unknown` as "somebody else has it", and never delete or replace a tag this run did not create: an agent that can break its own locks does not have a lock. A stale tag goes to the human with the branch and PR state it guards.

Pass `--kind feat|fix|chore` only when the label-derived default (`bug` is fix; `documentation` without `enhancement` is chore; otherwise feat) is wrong for the work.

The executor's header says why the label move comes after the push and why the branch is cut at the SHA the acquire read rather than at this clone's `origin/main`. Read it once; do not re-derive the protocol here.

## 4. The journal

Three kinds of issue comment, and no more:

1. *Launch*: the anchors and the composed fabric, before work starts.
2. *Events*, appended as they happen: tripwire fired, fabric widened or narrowed, fork guessed, seat re-run on a stronger model, breaker tripped, answer rejected as stale, host newer than verified.
3. *Final*: outcomes plus coverage.

The launch comment opens with the anchors, the base sha and the AC snapshot digest, then the composed fabric: which seats, at which model and effort, in which modes, and why. The human audits the composition, not just the outcome. At any recovery, state is re-read live; a journal line never authorizes a later action by itself.

**Coverage is a deliverable.** The final journal states what actually looked at the diff: seats composed against seats delivered, by name.

## 5. Invariants

These hold however you orchestrate.

1. **Decorrelation.** Every diff that ships is reviewed by at least one seat from a different model family than the one that wrote it. Read the writer's family off the seat that produced the code, then pick the reviewer from the other one. A PR holding both native-written and bridge-written work needs one of each, judged per diff and not per run: decorrelation is a rule about seat assignment, not about topology, and a family reviewing itself is a correlation failure whichever family it is.
2. **Adversarial minimum.** At least one review seat is prompted to refute the change, not to summarize it. A finding backed by a failing test it wrote is demonstrated rather than argued: it skips adjudication, and its fix inherits the test as the regression guard. A test can still encode the wrong requirement, so a fixer that disputes the test reports that instead of satisfying it. Prose refutation stays the minimum, since design flaws and missing coverage aren't demonstrable; the fast lane is an incentive, not a gate.
3. **Security visibility.** A refused, dead or errored security seat is surfaced to the human in the final journal as an unavailable security review. No findings from a seat that never ran is absence of evidence. Retry across families before declaring it.
4. **UNKNOWN is not a pass.** The charter's rule, applied to CI: green only on a head verified in sync, local sha == PR headRefOid, observed, never inferred from an exit status.
5. **Evidence per criterion, re-executable from the tree.** Every acceptance criterion gets a verdict plus a concrete pointer in a PR ledger, on top of the charter's evidence rule. A stranger holding only the merged repo has to be able to reproduce it from a committed test, script or artifact: journal prose describing a heroic verification (fuzz totals, sweep counts, browser differentials) is narrative, and an expiring capability URL is evidence with a TTL. If it can't survive `git clone` on a fresh machine, the ledger entry isn't done. Captures published under the charter's artifact rule are the carve-out, linked per criterion; the artifact host carries captures, never proof, so the testable claim behind one still needs its committed test.
6. **Termination on evidence, not counters.** Convergence is risk-tiered:
   - standard work: one clean cross-family adversarial pass (a different family than the fixer, fresh eyes, nothing blocking) and you're converged.
   - trust-boundary contact or a churny run: two consecutive clean passes from different seats.
   - breadth backstop: churn tripwires concentrate the fabric on the file that fights back, and depth there isn't coverage elsewhere. The final pass before convergence sweeps the whole diff at file granularity and lists what it read and what it skipped; any file no reviewer has named since the last fix round is a gap. A bridge review returns only the validated findings array, so its coverage list has nowhere to ride: continue that same review job and ask for the files read and skipped plus the verdict, in plain text, and read the continuation for those only - the findings stay what the validated result said (§8).
   - circuit breaker: past ~5 fix rounds, stop fixing. Hand the survivors to a seat picked for settling conflicting reviewers and escalate the real ones. The breaker interrupts a human; it never ships silently.
7. **Containment.** No two seats hold the same file at once, and staging is repo-global even when the edits are disjoint, so a fan-out of parallel fixers serializes on the index unless each one stages only its own paths. That constrains how you compose the fan-out as much as what the seats are handed. Every seat already receives the charter's seat contract, native or delegated, so your own prompt carries the worktree path, the checkpoints and the task, and no contract text.
   A **bridge writer** edits and cannot commit (delegate skill, `access`). Say so in its task text: its scope and checkpoint discipline governs its edits, and the commit and report obligations are yours. When it returns, do invariant 10's read, then stage only that seat's files by explicit path and commit with the seat named in the message body.
8. **The seat cap, counted honestly.** The charter's ceiling counts every native seat that is running AND every bridge job that has not reached a terminal state: queued, starting, running, reconciling, awaiting approval, unknown. Terminal jobs drop off. An UNKNOWN job holding workspace write keeps both its slot and its write lease until it is reconciled, because it may still be writing and freeing its slot double-books the worktree. Over the cap, batch.
9. **Refusal routing.** The charter's refusal rule binds every judgment and security seat here. A seat that comes back null is indistinguishable from one that refused, so the retry crosses the family line either way, and a double-null is reported, never swallowed.
10. **Seat reports are claims.** Before acting on any completion or blocker report, run `git -C <wt> log` and `git -C <wt> status` and compare them against what the seat says it did. A seat that stopped mid-task gets a nudge carrying that verified state, which commits exist and what the tree holds, so it cannot re-litigate what is already done; your host's subsection says how a running seat is reached and what to do instead when it cannot be. A seat that fabricates twice is re-run on a stronger model, journaled as an event.
    Take the tree snapshot, `node <plugin-root>/scripts/tree-snapshot.mjs <wt>`, once before a review seat spawns and once when it returns; the script's header says why a status line and a diff cannot do this job. Any difference and the review does not count as covering the diff that ships: stop, name the path that moved, and find out what wrote it.

## 6. The design pass, always on

Every production-code run gets a design pass, even when an ADR or prep settled the spec.

The standard is a blind pair plus your own synthesis:

- **The native leg**, on this host's own model family: the minimal framing. Smallest change, maximum reuse, grounded in the actual code seams.
- **The other-family leg**, blind and parallel, through the cross-family delegation tool. Not "ask the other family for an approach": a decorrelated design sheet with two jobs, propose its own shape independently and hunt spec gaps, naming what the issue didn't say that the writer would otherwise decide silently.
- **Your synthesis, inline**, with no extra seat: resolve disagreements explicitly, never average.

Launch the native leg first, then run the other-family leg attached, so both sheets land in the same turn.

Required outputs. A pass without these didn't happen:

1. **Placement map**: where each new thing lives, and why.
2. **Single-source-of-truth declarations**, with the drift guards that enforce them.
3. **API shapes with signatures**: streaming against buffered is decided here, on paper.
4. **Invariant ownership**: which layer enforces what.
5. **Checkpoints with per-checkpoint difficulty**, which is what routes each write seat.
6. **The not-alone list**: decisions the writer may not make without a checkpoint. It doubles as the shadow reviewer's structural watchlist, so the shadow covers design drift and not just behavior.

Flexing the pass is your call, and each move is journaled:

- **Widen to a third leg**, a taste call, for a new subsystem, a public API or taste-heavy work. Or when the pair disagrees hard, which is a signal to widen rather than adjudicate thin.
- **Shrink to a lone cross-family pre-flight** only for changes with no code-design space at all: doc-only, config-only, comment-only. Never zero.
- **Open design discovered mid-run is a prep failure.** The full dialectic lives at the prep stage, and the label contract forbids an issue arriving here with open shape questions. A small shape question mid-run is a fork question, journaled as a prep-gap event. Genuinely open design is `needs-info`, back through the front door.

## 7. Freedoms

Yours to flex, per issue and mid-run.

- **Fabric width**: how many review lenses, and whether a post-push stage exists at all. The design pass is the one part with a minimum (§6), and an auth-touching "trivial" gets the full security panel regardless of its size label.
- **Continuous re-sizing**: size isn't a launch-time verdict. These tripwires force a fabric re-think, and each firing is journaled as an event:
  - the diff touches a trust boundary the issue never mentioned (auth, input parsing, shell or SQL or template construction, secret handling);
  - the diff exceeds about twice the plan's expected file count;
  - fix rounds churn on the same area, a fix spawning findings where it landed;
  - cross-family reviewers disagree hard on the same code.
  Beyond the tripwires you have standing permission to widen on any hunch. Narrowing is also legal, a "medium" that turned out mechanical; journal that too.
- **Seat assignment**: the difficulty §6 names per checkpoint, judged on what could break and never counted from file totals, picks the writer off the charter's model-selection bullets. A checkpoint whose shape is already decided and one with a live code-design decision in it do not get the same seat. When torn take the more capable one, and justify anything below the default write seat in the launch comment.
- **Orchestration medium, per fan-out**: drive the seats directly when a stage is adaptive or small; when it is deterministic and wide, a four-lens review fabric or parallel disjoint fixes, use what your host's subsection offers for a scripted fan-out.
- **Mode selection**: parallel-blind, collaborative (propose, then critique, then revise across families), or adversarial (red team against blue team), picked per stage. Cross-model disagreement is signal: resolve it explicitly, never average it.

## 8. The cross-family seats

The delegate skill is the operating manual for the calls themselves: attached against detached delivery, continuing or steering a running job, the review mode, and how to read an envelope. Read it before the first bridge call. What this stage adds:

- **Designer, every run**: the other-family design leg (§6) is a first-class seat. It proposes blind and hunts spec gaps before a line is written.
- **Standing consult**: when torn at any judgment point - synthesis, triage, adjudication - ask the other family for a decorrelated second opinion before deciding. Two-key dismissal: a medium-or-higher finding is dismissed as noise only when both families agree it is.
- **Dialectic is prep's, not yours**: blind, then argue, then synthesize runs at the prep stage, where the human adjudicates the argument into ADRs. Here the design pair stays blind and you synthesize. Wanting a dialectic mid-run means the issue shouldn't have passed the front door.
- **Shadow reviewer at checkpoint boundaries**: a bridge seat reads commits as they land and accumulates findings silently. At each checkpoint boundary you triage the set and hand blocking items to the writer before the next checkpoint starts, so the signal is early and nothing interrupts mid-thought. Its watchlist includes the design pass's not-alone list, so structural drift is a checkpoint finding too. It never replaces the final adversarial pass, because convergence still needs fresh eyes on the finished diff.
- **Red team**: each family tries to break the other's implementation. Route demonstrable claims through the fast lane of invariant 2 - "prove it or drop it" beats a prose argument about severity.
- **Bulk tier**: mechanical sweeps, meaning comment rot, evidence collection and transcript reads, go to the charter's cheap-at-max-effort seat. That seat is never the decorrelation seat, which needs intelligence.

A detached job you never read back is an UNKNOWN you invented on purpose, so retain the job id and read it with the status and result tools.

Reviews run adversarially against an immutable base, read-only. `failed`, `unknown`, `cancelled` and `awaiting_approval` are all an unavailable seat, never a clean review; invariant 4 is not suspended because the seat was on the other side of a bridge. The service validates review findings against a strict schema, so read the findings and do not parse review prose.

## 9. Forks, escalation, and when to stop

**Optional forks.** A fork is the human's only when it is genuinely theirs to pick: rival designs both defensible on the merits, a contested finding whose dismissal changes the risk posture, a scope smell the issue cannot settle. Same bar as `needs-info`, cheaper than escalating.

Whether you ask at all depends on your host. Where asking answers inside the turn, ask, one call with the recommendation first and a consequence on each option; if the human dismisses the question, decide it and journal. Where asking ends the turn, an optional fork is never asked: decide it, journal a `fork guessed` event naming the alternative you rejected and why, and keep moving.

**Trust-model forks.** Anything that sets the posture of a trust boundary - who may reach what, what an unattended tool will read or publish, where authority ends - is asked on every host, whatever asking costs. A coherent trust model reads as intentional, so the review fabric ratifies a guessed posture rather than contesting it and the whole review budget goes on agreeing with itself. Unanswered, the run does not continue: take the conservative posture (confine, refuse, least reach), label `needs-human`, write the durable journal entry, and stop.

**The suspension protocol**, where asking ends the turn. Finish every mutation first: commit, push, the journal event, the label, the escalation notice. THEN read the anchors - the AC snapshot digest, the head sha, the issue's `updatedAt` - immediately before asking, because reading them earlier lets your own checkpoint expire your own question. Ask one question, up to four numbered options, the recommendation first, each option carrying its consequence in a line.

One fork changes that order: the one whose subject is the tree itself. When the question is whether this content may be pushed or published at all (material that turned up mid-run and might be secret), pushing first answers it in the direction nobody ratified, and no answer afterwards can unsend the bytes. So that checkpoint omits the push. Commit locally, journal the event, apply the label, fire the notice, and suspend. The contested bytes stay on this machine until a ratifying answer arrives over live anchors.

Every other trust fork keeps the full checkpoint including the push: a work-in-progress push to this run's own private feature branch settles nothing about who may reach what. The carve-out is narrow on purpose, because a run that skips its checkpoint on every fork loses the recovery trail that makes suspending survivable.

An answer that arrives over moved anchors is expired. Journal `stale-answer-rejected`, keep `needs-human`, re-read the moved state, and ask fresh against it. `needs-human` clears only after that revalidation, never on the arrival of an answer alone.

**Escalate early on ambiguity.** A blocking question that the issue, the code and the docs cannot settle is `needs-info` the moment you find it, not after an implementation guess. Fork questions are for choices you could make but the human should; `needs-info` is for blockers you cannot.

**The escalation notice.** Every escalation is a label plus a comment saying what is blocking, and then a ping so the human learns about it without watching the issue. The ping is best-effort and your host's subsection says what it is, including when the answer is that this host has nothing to ping with. The durable part is always the label and the comment: a notice that never lands must never be the reason a clean escalation reads as a silent one.

## Known gaps

- **The composed run has no run id.** Bridge jobs have durable job ids, but the surrounding dynamic run recovers from the issue comments and the worktree diff.
- **No calibration ledger**: per-seat finding precision is not tracked across runs. Compose from the charter's model table.
- **A `newer` host is trusted on the last verified version's evidence.** The table is biased false, so it protects capabilities it never claimed, but a `supported: true` mechanism can still regress in a CLI release it has not seen. Nothing here detects that: re-verify the table by hand and reintroduce the stop for the capability.

## Host mechanics

Read the subsection for your host.

### Claude Code

**Argument.** The issue number the human named in the `/flow:issue` invocation. Empty, or anything that is not a positive integer, aborts with usage and mutates nothing. `Bash(node:*)` is in this skill's allowance for the claim helper, the tree snapshot, and the orchestrator's own scratch scripts.

Workspace boundary. The session's workspace roots are the directory the session was opened in plus anything the human added. The delegation server reads MCP roots and `CLAUDE_PROJECT_DIR`. Require the canonical repository root among the usable roots reported by the preflight. Additional roots explicitly authorized by the human are allowed. The nested worktree must stay inside the host's writable repository grant. Give every delegated writer the exact worktree path as `cwd`.

**Fan-out medium.** Direct Agent calls when a stage is adaptive or small. When the fan-out is deterministic, wide and worth resume plus a progress readout, or when a seat has to run at an effort a bare Agent call cannot set, write a short ad-hoc script under the `Workflow` allowance (the charter's Hosts section has the script rules).

**Reaching a running seat.** `SendMessage`, carrying orchestrator-verified state read from git first. `TaskOutput` reads a seat's stream when its final message is the thing in doubt, and `TaskStop` ends one.

**Forks.** Asking answers inside the turn, so optional forks are asked.

**Escalation ping.** `PushNotification`, one line naming the issue number and what is blocking, fired after the label and the comment are on the issue. Best effort.

### Codex

**Argument.** The number in the human's message naming the plugin's `issue` skill or asking in words to run an issue. A bare integer or `#N` in that request is the subject, and a message that mentions `#N` while describing something else suspends the turn to ask which. There is no per-skill tool allowance here; the session's sandbox and approval policy apply as they are, to you and to every native child.

Workspace boundary. Open the native app project at the canonical primary checkout and invoke the issue skill, for example "run issue #42". Codex fixes writable roots when the session starts. Its repository write grant covers the planned `.flow-worktrees` child, while `.git` can remain read-only. The orchestrator uses the normal approval mechanism for the claim executor and Git operations that need metadata writes. Do not widen the grant to the repository's parent.

The delegation server starts through the stable `flow-delegate` command with no MCP `cwd` override. It validates its actual process cwd as an exact canonical Git top-level directory and ignores inherited `PWD`, `CODEX_PROJECT_DIR` and `CLAUDE_PROJECT_DIR`. At preflight, require the session cwd and the doctor's sole usable root to equal the plan's `repoRoot`. Run the doctor against that existing root, never against the prospective worktree. If the dispatcher is unavailable, stop and report the missing flow setup prerequisite. Setup installs it once; a new session or explicit app MCP reload then starts the server. If the root or grant is invalid, stop before the claim and report the failed check. A valid project session needs no per-issue launcher or restart.

Give a delegated Claude writer only the exact claimed worktree as `cwd`. Its write grant covers that worktree, and its Git metadata stays read-only. The orchestrator verifies the edits and commits them through the host's normal approval mechanism.

**Fan-out medium.** None. A deterministic fan-out is a batch of native spawns issued in one turn, and the verification between batches is git: read `git -C <wt> log` and `git -C <wt> status` before issuing the next batch. Size the batch to what you can check that way.

**Reaching a running seat.** You cannot. A running seat is opaque here, with no live output and no way in until it finishes, so prefer one checkpoint per spawn: a seat that wandered can only be corrected after it stops. `followup_task` on a completed seat starts its next turn carrying the orchestrator-verified state; `send_message` only queues text and resumes nothing. Four to six concurrent write seats on disjoint files is this host's working ceiling, bounded by what you can verify against git in one turn, inside the charter's seat cap.

**Forks.** Asking ends the turn, so optional forks are never asked; trust forks suspend, with the full checkpoint and the push carve-out exactly as §9 states them.

**Escalation ping.** `notify-send`, one line naming the issue number and what is blocking, fired after the label and the comment are on the issue. Best effort and silent over SSH, where there is no session bus; that gap is documented, not worked around.
