---
name: issue-stage
description: Hands-off implementation of one ready-for-agent issue, through a pushed, reviewed, evidenced PR and no further. The orchestrator composes the seat fabric per issue, contains every writer, journals every call to the issue, and never merges. MUST only run when the human explicitly asks to run a specific issue number; never start it from adjacent work, a finished prep, a discovered defect, or a survey of what to do next.
disable-model-invocation: true
---

# issue-stage - the autonomous middle of the prep → issue → land process

Prep hardened the issue. This stage drives it, hands-off, to a pushed, reviewed, evidenced PR and stops there. The land stage is the only merge path.

Everything up to `## Host mechanics` is the same on every host. That section, at the end, names the seats, models, calls and containment answers for the host you are running on. Read your host's subsection before step 1. Where a step needs a decision from the human, it goes through the human-choice binding your charter profile declares; whether that binding answers inside the turn or ends it decides which forks get asked at all (§9).

There is no fixed pipeline here and no stage list. You are the orchestrator, in the main session, inline. You compose the run to fit the issue and flex seats, models, and rounds as the work reveals itself. The set of seats composed for a run is its fabric. The charter gives you the model table and the rules of engagement; this file gives you the contract and a short list of things you cannot trade away. Everything else is your call, and every call gets journaled.

## Core principles

1) You orchestrate inline. File scans, command output, and diffs live in seats; only conclusions come home.
2) The invariants in §5 bind however you orchestrate. Fabric width, seats, modes, rounds are yours to flex, and every flex is journaled.
3) Hands-off by default. The only mid-run questions are forks genuinely the human's to pick, and a trust-model fork is never guessed and never continued past.
4) The issue is the record. The journal comments are what a human reads to audit the run, and the only recovery trail there is.
5) Never merge, never retire the worktree. The PR is where this stage stops, and the land stage cleans up after itself.

## 1. The contract

**In**: an open issue labeled `ready-for-agent`.

The argument is an issue number. Three origins authorize it: the argument carried by the invocation, the human naming the issue in words, or the human's own go-ahead on a hand-off out of the prep stage. A hand-off line that names this stage is not an invocation - the human's next message is. Anything else is a stop.

The claim executor (§3) re-reads the issue and refuses one that is closed, one without `ready-for-agent`, or one carrying a blocking label (`needs-human`, `needs-info`, `needs-rebase`). On `not-ready` route the human back through the prep stage; on `blocked` route them to the blocker, which only they clear.

All work happens in a worktree at `../<repo>-issue-N-<slug>`, a sibling of the repository, on branch `feat|fix|chore/issue-$N-<slug>`, based at the head the claim verified. The executor creates both.

**Workspace boundary.** The worktree has to sit inside the boundary the host enforces for this session, and your host's subsection says what that boundary is and how to read it. The executor checks what it can from git alone: the repository's common git directory resolves under the repository's parent, and that parent is writable. Whether the parent is inside the session's boundary is the host's question; answer it before the claim, because a prospective path outside the boundary is a stop before the first mutation, not something to route around.

The bridge runs its own workspace check on every call, after the worktree exists (DELEGATION.md, Workspace trust; `OUTSIDE_ROOTS` on failure). Passing it says a delegation job may run there, never that your own shell or a native seat may write there.

**Out**: an open PR, pushed, reviewed, evidenced, and `Closes #N`-linked. Or a clean escalation: `needs-info`, `needs-human`, or `needs-rebase`, labeled, with a comment saying what is blocking, and the escalation notice of §9. A run that never got past the preflight leaves through that same door and leaves nothing else behind it (§2). Never merge.

## 2. The write-seat preflight

This runs before any mutation, and "any" is literal: no assignment, no label, no comment, no claim tag, no branch, no worktree, no spawn happens until it passes. The one exemption is the terminal escalation a failure fires, spelled out at the end of this section. A host that cannot run this stage must never stamp `in-progress` on an issue and walk away.

Read the host capabilities with the `delegation_doctor` tool. Its `hostCapabilities` block carries one entry per capability id with `supported`, `verifiedAt`, `assurance` and a note, and a `drift` block the service computes: `installed`, the host CLI version the doctor observed; `verifiedAgainst`, the version the table was last checked on; and `status`, one of `match`, `newer`, `older`, `unknown`. Do not compute drift yourself from the strings.

- `match`: proceed.
- `newer`: the host has moved past the last verified version. Proceed, and journal a `host newer than verified` event with both versions so the human knows the table wants a re-check. Re-verifying is a one-line edit to `capabilities.json` with no rebuild, and the nightly lint reports a `newer` host so it gets done. The exposure this accepts is under Known gaps.
- `older` or `unknown`: stop. Every capability the run depends on reads `unverified`.

One more condition: the canonical seat contract must be readable. It is `seat-contract.md` at the plugin root, two directories above this file in the installed plugin. Unreadable means a spawn prompt going out with no contract in it, so it is a stop.

A failed preflight stops the run with exactly three writes: the `needs-human` label, one comment naming what failed (the drift status or the unreadable contract path), and the escalation notice of §9. Nothing else moves: no assignment, no `in-progress`, no claim tag, no branch, no worktree, no spawn, and no inline edits for the rest of the run. Writing the code yourself because no seat can be spawned is the fallback the preflight exists to catch.

A passed preflight leaves the charter's latitude exactly as ratified. Minor inline edits and scratch scripts are orchestrating; substantial writing goes only to contained seats.

## 3. The claim

Assigning the issue and re-reading it is not a claim: two runs under one account both see a green re-read. The mutual exclusion is a tag on origin, created server-side, and `scripts/issue-claim.mjs` owns it.

Run `node <plugin-root>/scripts/issue-claim.mjs claim <N>` from the repository root, once. It scans for a live run (local worktrees and branches, the issue's branches on origin, open PRs), takes the tag, scans again while holding it, creates the worktree and the branch at origin's verified main, pushes the branch, moves the issue to assigned plus `in-progress`, and releases the tag once the branch reads back on origin. It prints one JSON line, and its `result` is the whole answer:

- `claimed`: proceed. Record `base`, `branch`, `worktree`, `head` and `acDigest`, the sha256 of the exact bytes of `## Acceptance Criteria`. The run is judged against that snapshot; a body that moves mid-run is flagged, not chased. Post the launch comment of §4 now.
- `refused`: nothing of this run's is left anywhere; the executor confirmed every cleanup, and `retained` is empty by construction. `reason` says why: `live-run` (another run owns this issue, `found` says what it saw; surface it and stop), `issue-closed`, `not-ready`, `blocked`, `no-acceptance-criteria`, `bad-slug`, `worktree-path`, `outside-parent`, `acquire-refused`, `worktree-add`, `push`. Fix what it names or route the human.
- `held`: another run holds the tag right now. Stop.
- `unknown`: an operational failure, or a cleanup the executor could not confirm. `phase` says how far it got: `pre-acquire` means nothing was mutated; `acquired` means the tag may exist on origin; `published` means the branch reached origin, which is the marker every other run scans for, and the tag stays until a human settles the issue's state. `retained` lists what may still exist: `claim-tag`, `worktree`, `local-branch`, `remote-branch`. Report `reason`, `phase` and `retained` verbatim and stop. Never read `unknown` as "somebody else has it", and never delete or replace a tag this run did not create: an agent that can break its own locks does not have a lock. A stale tag is surfaced to the human with the branch and PR state it guards.

Pass `--kind feat|fix|chore` only when the label-derived default (`bug` is fix, `documentation` is chore, otherwise feat) is wrong for the work.

The executor's header says why the label move comes after the push and why the branch is cut at the SHA the acquire read rather than at this clone's `origin/main`. Read it once; do not re-derive the protocol here.

## 4. The journal

Three kinds of issue comment, and no more:

1. *Launch*: the anchors and the composed fabric, before work starts.
2. *Events*, appended as they happen: tripwire fired, fabric widened or narrowed, fork guessed, seat re-run on a stronger model, breaker tripped, answer rejected as stale, host newer than verified.
3. *Final*: outcomes plus coverage.

Quiet runs have exactly two comments. Eventful runs show their history.

The launch comment opens with the anchors, the base sha and the AC snapshot digest, and then the composed fabric: which seats, which modes, why. The human audits the composition, not just the outcome. At any recovery, state is re-read live; a journal line never authorizes a later action by itself.

**Coverage is a deliverable.** The final journal states what actually looked at the diff: seats composed against seats delivered, by name. A thinned fabric that reads as a clean pass is the failure mode this whole system exists to prevent.

The journal is also the recovery trail. There is no run id, so the run has to be reconstructible from the issue alone.

## 5. Invariants

These hold however you orchestrate.

1. **Decorrelation.** Every diff that ships is reviewed by at least one seat from a different model family than the one that wrote it. A family reviewing itself is a correlation failure, whichever family it is and whichever host is orchestrating - decorrelation is a rule about seat assignment, not about topology. Read the writer's family off the seat that produced the code, then pick the reviewer from the other one; a PR holding both native-written and bridge-written work needs one of each, judged per diff and not per run. Your host's subsection says how a seat of each family is reached and what a wider fabric costs there.
2. **Adversarial floor.** At least one review seat is prompted to refute the change, not to summarize it. A finding backed by a failing test it wrote is confidence 100 by construction: it skips adjudication, and its fix inherits the test as the regression guard. Prose refutation stays the floor, since design flaws and missing coverage aren't demonstrable; the fast lane is the incentive, not a gate.
3. **Security visibility.** A refused, dead, or errored security seat is surfaced to the human in the final journal as an unavailable security review. No findings from a seat that never ran is absence of evidence. Retry across families before declaring it.
4. **UNKNOWN is not a pass.** Errored, rate-limited, and timed-out checks are their own state. CI is green only on a head verified in sync: local sha == PR headRefOid, observed, never inferred from an exit status.
5. **Evidence per criterion, re-executable from the tree.** Every acceptance criterion gets a verdict plus a concrete pointer in a PR ledger, and a stranger holding only the merged repo must be able to reproduce the evidence: a committed test, a committed script, a committed artifact. Journal prose describing a heroic verification (fuzz totals, sweep counts, browser differentials) is narrative, not evidence, and an expiring capability URL is evidence with a TTL. If it can't survive `git clone` on a fresh machine, the ledger entry isn't done. One carve-out: captures - screenshots, recordings, oversized image sets - go through the charter's artifact-publish role with retention that outlives the PR, linked per criterion. A capture isn't re-executable anyway, and hosting it beats bloating the repo with media. The artifact host carries captures, never proof: the testable claim behind the capture still needs its committed test.
6. **Termination on evidence, not counters.** Convergence is risk-tiered:
   - standard work: one clean cross-family adversarial pass (a different family than the fixer, fresh eyes, nothing blocking) and you're converged.
   - trust-boundary contact or a churny run: two consecutive clean passes from different seats.
   - breadth backstop: churn tripwires concentrate the fabric on the file that fights back, and depth there isn't coverage elsewhere. The final pass before convergence must sweep the whole diff at file granularity and list what it read and what it skipped; any file no reviewer has named since the last fix round is a gap. A native seat's report is prose already, and invariant 10 says how you check it against the tree. A bridge review returns only the validated findings array, so its coverage list has nowhere to ride: continue that same review job with `delegation_continue` and ask for the complete list of files read and skipped plus the verdict, in plain text. Read the continuation for coverage and the verdict only; the findings stay what the validated result said (§8). Churn depth and closing breadth are separate obligations.
   - circuit breaker: past ~5 fix rounds, stop fixing. Hand the survivors to the adjudicator (`adjudicator`) and escalate the real ones. The breaker interrupts a human; it never ships silently.
7. **Containment.** Every write lands inside the worktree, from a seat that cannot sub-delegate, and no two seats hold the same file at once. Staging is repo-global even when the edits are disjoint, so a fan-out of parallel fixers serializes on the index unless each one stages only its own paths. That constrains how you compose the fan-out as much as what the seats are handed.
   Every substantial write-capable seat - implementation, fixes, doc-sync - runs the canonical seat contract, `seat-contract.md` at the plugin root, and your host's subsection says how it travels for each class: a contained seat definition that already holds it, a spawn prompt carrying the file verbatim, or the cross-family bridge with workspace write. The whole text reaches every substantial writer; a path reference or a single section does not count. This file names the contract and restates none of it, because two copies of a rule drift and the run then obeys the older one. Scouts, reviewers and transports change nothing and don't carry it. Your own prompt still names the worktree and the milestones; the contract carries the discipline.
   A **bridge writer** (the cross-family delegation at `access: "workspace-write"`, on either host) edits and cannot commit: the delegation sandbox grants write on the job's workspace and nowhere else, this stage works in a linked worktree whose object store and refs live in the parent repository's git directory outside that grant, and network is off, so `git commit` and `git push` fail in that seat by design. Paste the ENTIRE canonical contract into its task text, with one adaptation written above it: the contract's scope and milestone discipline governs the seat's EDITS, and the commit and report obligations move to you. When the seat comes back, do invariant 10's read yourself, then stage ONLY that seat's files by explicit path and commit with the seat named in the message body. Never `git add -A` after a bridge seat: the worktree may be holding a sibling's work. The bridge sandbox also leaves local destruction open - `git checkout .` or `git clean -f` inside the worktree throws away a sibling's uncommitted work, which git-guard denies natively and nothing denies there - so never point a bridge writer at a worktree holding another seat's uncommitted work.
8. **One seat cap, counted honestly.** About 20 live seats, and the count includes every native seat that is running AND every bridge job that has not reached a terminal state - queued, starting, running, reconciling, awaiting approval, unknown. Terminal jobs drop off. An UNKNOWN job holding workspace write keeps both its slot and its write lease until it is reconciled: it may still be writing, and freeing its slot double-books the worktree. Over the cap, batch.
9. **Refusal routing.** Any seat can come back null, and a refusal is indistinguishable from a dead one. Every judgment or security seat needs a cross-family fallback: the retry for a null security seat is a seat of the OTHER family, never a second seat of the same family that just refused. A double-null is reported, never swallowed.
10. **Seat reports are claims.** A seat's final message is prose from a model that may have hallucinated its own progress: a backgrounded agent it never launched, a monitor it is waiting on, a commit annexed from a sibling. Before acting on any completion or blocker report, run `git -C <wt> log` and `git -C <wt> status` and compare against what the seat says it did. A seat that stopped mid-task gets a nudge carrying the orchestrator-verified state - which commits exist, what the tree holds - so it cannot re-litigate what is already done; your host's subsection says how a running seat is reached, and what to do instead when it cannot be. A seat that fabricates twice is re-run on a stronger model, journaled as an event.
    A reading also runs around every review seat, for a different reason, and a status line plus a diff cannot do that job. A reviewer is read-only by its prompt and by the hooks, and on any host that leaves a shell in the seat it is not read-only by mechanism. Untracked files are where a status-and-diff check goes blind: `?? path` reads exactly the same before and after that file's bytes change, and `git diff` never carried its content in the first place. So take the tree snapshot - `node <plugin-root>/scripts/tree-snapshot.mjs <wt>`, the same four digests the prep stage takes at its entry - once before the review seat spawns and once when it returns. Any difference and the review does not count as covering the diff that ships: stop, name the path that moved, and find out what wrote it. The script's header states what the snapshot sees and does not see. It is a detector for a misbehaving seat, not containment, and a review of a tree that changed underneath it is a review of nothing that shipped.

## 6. The design pass, always on

Every production-code run gets a design pass. "The ADR or the prep settled it" isn't a skip reason: that covers the forks the spec named, and the code-level design space - where things live, what signatures stream, which table is canonical - is never in that set. Skip it and the writer becomes the architect by default, unreviewed, which is the defect class this pass exists to catch.

The standard is a blind pair plus your own synthesis:

- **The native leg**, on this host's own model family: the minimal framing. Smallest change, maximum reuse, grounded in the actual code seams. Usually the synthesis winner, and the anchor.
- **The bridge leg**, blind and parallel, through the cross-family delegation tool. This is not "ask the other family for an approach". It is a decorrelated design sheet with two jobs: propose its own shape independently, and hunt spec gaps, naming what the issue didn't say that the writer would otherwise decide silently. The outside brain finds different holes, and decorrelation is cheapest per finding at design time.
- **Your synthesis, inline**, with no extra seat: resolve disagreements explicitly, never average. A disagreement here costs a paragraph. The same disagreement at review time costs a fix round.

The two legs MUST be different families: the native leg is your own family, and the bridge leg's `family: other` floor puts it in the other one. Launch the native leg first, then run the bridge attached, so both sheets land in the same turn.

Required outputs. A pass without these didn't happen:

1. **Placement map**: where each new thing lives, and why.
2. **Single-source-of-truth declarations**, with the drift guards that enforce them.
3. **API shapes with signatures**: streaming against buffered is decided here, on paper.
4. **Invariant ownership**: which layer enforces what.
5. **Milestones with per-milestone difficulty**, which routes the write seat's model and effort.
6. **The not-alone list**: decisions the writer may not make without a checkpoint. It doubles as the shadow reviewer's structural watchlist, so the shadow covers design drift and not just behavior.

Flexing the pass is your call, and each move is journaled:

- **Widen to three legs** by adding the taste leg (`taste-leg`): a new subsystem, a public API, taste-heavy work. Or when the pair disagrees hard, which is a signal to widen rather than adjudicate thin.
- **Shrink to a lone bridge pre-flight** only for changes with no code-design space at all: doc-only, config-only, comment-only. Never zero.
- **Open design discovered mid-run is a prep failure.** The full dialectic - blind, then argue, then the human adjudicates - lives at the prep stage, and the label contract forbids an issue arriving here with open shape questions. A small shape question mid-run is a fork question, journaled as a prep-gap event. Genuinely open design is `needs-info`, back through the front door.

## 7. Freedoms

Yours to flex, per issue and mid-run.

- **Fabric width**: how many review lenses, and whether a post-push stage exists at all. The design pass has a floor (§6), and an auth-touching "trivial" gets the full security panel regardless of its size label.
- **Continuous re-sizing**: size isn't a launch-time verdict. These tripwires force a fabric re-think, and each firing is journaled as an event:
  - the diff touches a trust boundary the issue never mentioned (auth, input parsing, shell or SQL or template construction, secret handling);
  - the diff exceeds about twice the plan's expected file count;
  - fix rounds churn on the same area, a fix spawning findings where it landed;
  - cross-family reviewers disagree hard on the same code.
  Beyond the tripwires you have standing permission to widen on any hunch. Narrowing is also legal, a "medium" that turned out mechanical; journal that too.
- **Seat assignment**: the design pass names a difficulty per milestone, judged on what could break, never counted from file totals, and difficulty picks the write-seat role: `write-seat-mechanical`, `write-seat-standard` (the default), `write-seat-hard`. The charter says what each is for. When torn, take the higher; a write seat below `standard` is justified in the launch comment.
- **Orchestration medium, per fan-out**: drive the seats directly when a stage is adaptive or small. When a fan-out is deterministic, wide, and worth resume plus a progress readout - a four-lens review fabric, parallel disjoint fixes - use whatever this host offers for a scripted fan-out. Your host's subsection says what that is, or says the host has none and direct calls are the answer.
- **Mode selection**: parallel-blind, collaborative (propose, then critique, then revise across families), or adversarial (red team against blue team), picked per stage. Cross-model disagreement is signal: resolve it explicitly, never average it.

## 8. The cross-family seats

The bridge is reached through the delegation tool the charter names. What a cross-family seat costs depends on your accounts, and your profile's `review-seat-bridge` binding says how wide to go. The mandatory review is not a budget line.

- **Designer, every run**: the bridge design leg (§6) is a first-class seat. It proposes blind and hunts spec gaps before a line is written.
- **Standing consult**: when torn at any judgment point - synthesis, triage, adjudication - ask the other family for a decorrelated second opinion before deciding. Two-key dismissal: a medium-or-higher finding is dismissed as noise only when both families agree it is.
- **Dialectic is prep's, not yours**: blind, then argue, then synthesize runs at the prep stage, where the human adjudicates the argument into ADRs. Here the design pair stays blind and you synthesize. Wanting a dialectic mid-run means the issue shouldn't have passed the front door.
- **Shadow reviewer at milestone boundaries**: a bridge seat reads commits as they land during implementation and accumulates findings silently. At each milestone boundary you triage the accumulated set and hand blocking items to the writer before the next milestone starts. Early signal, no mid-thought interruption. The shadow's watchlist includes the design pass's not-alone list, so structural drift is a checkpoint finding too. The shadow complements the final adversarial pass and never replaces it, because convergence still needs fresh eyes on the finished diff.
- **Red team**: each family tries to break the other's implementation. Route demonstrable claims through the fast lane of invariant 2 - "prove it or drop it" beats a prose argument about severity.
- **Bulk tier**: the bulk seat (`bulk-seat`) for mechanical sweeps, meaning comment rot, evidence collection, transcript reads, at max effort for the cheap-depth combo. It is never the decorrelation seat itself, which needs intelligence.

Delivery follows the seat's role. Attached delivery keeps the job's progress visible inside the call, and that is what a normal seat wants. Detached delivery is for a job that would hold the turn longer than the orchestrator can afford to wait, such as a long review or a deep design leg. Retain the job id and read it back with the delegation status and result tools; a detached job you never read is an UNKNOWN you invented on purpose.

Reviews run in adversarial-review mode against an immutable base, with read-only access. `failed`, `unknown`, `cancelled`, and `awaiting_approval` are all an unavailable seat, never a clean review - invariant 4 is not suspended because the seat was on the other side of a bridge. The service validates review findings against a strict schema, so read the findings and do not parse review prose.

## 9. Forks, escalation, and when to stop

**Optional forks.** A fork is the human's only when it is genuinely theirs to pick: rival designs both defensible on the merits, a contested finding whose dismissal changes the risk posture, a scope smell the issue cannot settle. Same bar as `needs-info`, cheaper than escalating.

Whether you ask at all depends on the human-choice binding. Where it answers inside the turn, ask, one call with the recommendation first and a consequence on each option; if the human dismisses the question, decide it and journal. Where it ends the turn, an optional fork is never asked: decide it, journal a `fork guessed` event naming the alternative you rejected and why, and keep moving. Suspending a hands-off run to ask a question you are able to answer costs the human a turn and buys nothing.

**Trust-model forks.** Anything that sets the posture of a trust boundary - who may reach what, what an unattended tool will read or publish, where authority ends - is a mandatory ask on EVERY host, whatever the binding costs. Never guessed. The review fabric will ratify a plausible trust ruling rather than contest it, because a coherent trust model reads as intentional, so the guess-and-journal path is closed here.

Unanswered, the run does not continue. Take the conservative posture (confine, refuse, least reach), label `needs-human`, write the durable journal entry, and STOP. There is no provisionally-decided-and-continued path out of a trust fork on any host: a run that ships a trust posture nobody ratified has spent its whole review budget agreeing with itself.

**The suspension protocol**, where the human-choice binding ends the turn. Finish every mutation first: commit, push, the journal event, the label, the escalation notice. THEN read the anchors - the AC snapshot digest, the head sha, the issue's `updatedAt` - immediately before asking. Reading them earlier lets your own checkpoint expire your own question. Ask one question, up to four numbered options, the recommendation first, each option carrying its consequence in a line.

One fork changes that order: the one whose subject is the tree itself. When the question is whether this content may be pushed or published at all (material that turned up mid-run and might be secret), pushing first answers it in the direction nobody ratified, and no answer afterwards can unsend the bytes. So the checkpoint omits the push. Commit locally, journal the event, apply the label, fire the notice, and suspend. The contested bytes stay on this machine until a ratifying answer arrives over live anchors, and only then does the push happen.

Every other trust fork keeps the full checkpoint including the push: a work-in-progress push to this run's own private feature branch settles nothing about who may reach what or what an unattended tool will read later. The carve-out is narrow on purpose, because a run that skips its checkpoint on every fork loses the recovery trail that makes suspending survivable.

An answer that arrives over moved anchors is expired. Journal `stale-answer-rejected`, keep `needs-human`, re-read the moved state, and ask fresh against it. `needs-human` clears only after that revalidation, never on the arrival of an answer alone.

**Escalate early on ambiguity.** A blocking question that the issue, the code, and the docs cannot settle is `needs-info` the moment you find it, not after an implementation guess. Fork questions are for choices you could make but the human should; `needs-info` is for blockers you cannot.

**The escalation notice.** Every escalation is a label plus a comment saying what is blocking, and then a ping so the human learns about it without watching the issue. The ping is best-effort and your host's subsection says what it is, including when the answer is that this host has nothing to ping with. The durable part is always the label and the comment: a notice that never lands must never be the reason a clean escalation reads as a silent one.

## Known gaps

- **The composed run has no run id.** Bridge jobs have durable job ids, but the surrounding dynamic run recovers from the issue comments and the worktree diff.
- **No calibration ledger**: per-seat finding precision is not tracked across runs. Compose from the charter's model table.
- **A `newer` host is trusted on the last verified version's evidence.** The table is biased false, so it protects capabilities it never claimed, but it cannot protect a `supported: true` mechanism from a regression in a CLI release it has not seen. If a release regresses a `mechanism` this stage depends on (hooks in native children, the per-seat tool list), nothing here detects it: re-verify the table by hand and reintroduce the stop for that capability.

## Host mechanics

Everything above is host-neutral. The subsections name the seats, calls and containment answers for each host; the human-choice binding lives in the charter profile.

### Claude Code

**Argument.** `$ARGUMENTS` from the `/flow:issue` invocation. Empty, or anything that is not a positive integer, aborts with usage and mutates nothing. `Bash(node:*)` is in the alias's allowance for the claim helper, the tree snapshot, and the orchestrator's own scratch scripts.

**Workspace boundary.** The session's workspace roots: the directory the session was opened in plus anything the human added. `mcp-client-roots` is true with assurance `mechanism`, so the delegation server reads those roots over `roots/list`, and the sibling worktree is inside the boundary whenever the repository is.

**Write seats.** The native writer's definition (`flow:implementer`) has no Agent tool, so a native subagent is impossible, and git-guard and the no-backlog guard fire inside it. It still holds Bash, and no hook denies `claude -p` or `codex exec` from a shell, so the contract's no-delegation line is what stands in front of that. Its worktree confinement is the contract plus the repository's git hooks, not a sandbox. A bridge writer is `delegate_to_codex` at `access: "workspace-write"` with the worktree as `cwd`; its confinement is the delegation sandbox (DELEGATION.md, Sandbox), which the plugin's hooks do not reach.

**Contract delivery.** A native writer is always `flow:implementer`; the canonical contract rides its definition as a byte-equal tail, so the spawn prompt carries the worktree path and the milestones and no contract text. A `general-purpose` seat holding Edit is a containment violation whatever its prompt says. A bridge writer gets the ENTIRE contract pasted into its task text (the delegated payload carries the Containment section alone).

**Design legs.** Native: the native design leg (`design-leg-native`) as `flow:code-architect`, in the background; its definition holds no Edit, Write or Agent tool. Bridge: the bridge design leg (`design-leg-bridge`) through `delegate_to_codex`, `access: "read-only"`, the repository root as `cwd`. Widen to the taste leg (`taste-leg`).

**Review fabric.** A Claude-family seat is a native Agent call; a Codex-family seat is `delegate_to_codex`. A diff from `flow:implementer` is Claude-written, so its mandatory review is the bridge review seat (`review-seat-bridge`) through `delegate_to_codex` in `mode: "adversarial-review"` against an immutable `base`, `access: "read-only"`. A diff from a bridge writer is Codex-written, so its mandatory review is the native review seat (`review-seat-native`) as `flow:code-reviewer`; sending it back across the bridge is Codex reviewing Codex. Security-flavored seats go to the security seat (`security-seat`) first.

**Fan-out medium.** Direct Agent calls when a stage is adaptive or small. When the fan-out is deterministic, wide, and worth resume plus a progress readout, a short ad-hoc script under the `Workflow` allowance: plain JavaScript, no TypeScript syntax, and no `Date.now()`, `Math.random()` or argless `new Date()`, because resume replays the script and those three break it. `TaskOutput` reads a seat back; `TaskStop` ends one.

**Reaching a running seat.** `SendMessage`, carrying orchestrator-verified state read from git first. `TaskOutput` reads its stream when the final message is the thing in doubt.

**Forks.** The human-choice binding answers inside the turn, so optional forks are asked.

**Escalation ping.** `PushNotification`, one line naming the issue number and what is blocking, fired after the label and the comment are on the issue. Best effort.

**Seat ladder.** `mechanical`, `standard` and `hard` are the three write-seat roles, each a `flow:implementer` spawn at the model and effort the profile binds; `standard` is the default. Bulk sweeps are the bulk seat (`bulk-seat`) through `delegate_to_codex`; that is the cheap-depth seat and never the decorrelation seat.

### Codex

**Argument.** The number in the human's message naming the plugin's `issue-stage` skill or asking in words to run an issue; there is no slash command here. A bare integer or `#N` in that request is the subject, and a message that mentions `#N` while describing something else suspends the turn to ask which. There is no per-skill tool allowance here; the session's sandbox and approval policy apply as they are, to you and to every native child.

**Workspace boundary.** Two roots can diverge on this host. The bridge root is the launch shell's PWD, because the Codex MCP client advertises no roots (`mcp-client-roots` reads `supported: false` with assurance `mechanism`; DELEGATION.md, Route policy). The session root is the cwd this session runs in, which `codex -C` sets; it is the sandbox root for your own writes and for every native `spawn_agent` child. `cd parent; codex -C repo` splits them: the sibling worktree under `parent` then passes every delegation check while no native seat can write a byte in it, so preflight goes green and the run dies at `git worktree add`. Read the session root from the session's own cwd, never from PWD, and treat diverged roots as a stop. The intended worktree sits inside the session root only when the session was launched from the directory HOLDING the repository with no `-C`; launched at the repository root, `git worktree add` writes outside the sandbox. Say that at preflight, name the directory to relaunch from, and stop: do not claim the issue first, and do not move the worktree inside the repository to get around it.

**Write seats.** A native writer is a `spawn_agent` seat. `spawn_agent` narrows nothing below the session and has no depth cap, so the contract's no-spawn line is prompt text; the plugin's PreToolUse guards do fire in the child. A bridge writer is `delegate_to_claude` at `access: "workspace-write"` with the worktree as `cwd`; its confinement is the delegation sandbox (DELEGATION.md, Sandbox), which the plugin's hooks do not reach.

**Contract delivery.** A native writer carries the ENTIRE canonical contract pasted verbatim into its spawn prompt - a path reference is a spawn prompt with no contract in it, because the seat gets no second fetch. Above the paste, one host line: the plugin's hooks fire inside this seat, so git-guard and the no-backlog guard deny there exactly as they deny here, and a spawn from this seat is a contract breach with nothing to stop it. Every pipeline seat gets `fork_turns: "none"`, so it starts from its own prompt and not from a copy of your turn. Scouts, reviewers and transports carry the read-only prohibitions instead. A bridge writer gets the same full paste in its delegation task text.

**Design legs.** Native: the native design leg (`design-leg-native`) as a `spawn_agent` seat, `fork_turns: "none"`, read-only by its prompt. Bridge: the bridge design leg (`design-leg-bridge`) through `delegate_to_claude`, `access: "read-only"`, the repository root as `cwd`. The outside opinion here is a Claude model. Widen to the taste leg (`taste-leg`) through the bridge.

**Review fabric.** A Codex-family seat is a native `spawn_agent`; a Claude-family seat is `delegate_to_claude`. A diff from a native writer is Codex-written, so its mandatory review is the bridge review seat (`review-seat-bridge`) through `delegate_to_claude` in `mode: "adversarial-review"` against an immutable `base`, `access: "read-only"` - the common case here. A diff from a bridge writer is Claude-written, so its mandatory review is the native review seat (`review-seat-native`); do not send that one across the bridge. Security-flavored seats go to the security seat (`security-seat`) first.

**Fan-out medium.** None. A deterministic fan-out is a batch of native spawns issued in one turn, and the verification between batches is git: read `git -C <wt> log` and `git -C <wt> status` before issuing the next batch. Size the batch to what you can check that way.

**Reaching a running seat.** You cannot. A running seat is opaque here - no live output, no way in until it finishes - so prefer one milestone per spawn, because a seat that wandered can only be corrected after it stops. `followup_task` on a completed seat starts its next turn carrying the orchestrator-verified state; `send_message` only queues text and resumes nothing. Four to six concurrent write seats on disjoint files is this host's working ceiling, bounded by what you can verify against git in one turn, inside the stage's 20-seat cap.

**Forks.** The human-choice binding ends the turn, so optional forks are never asked; trust forks suspend, with the full checkpoint and the push carve-out exactly as §9 states them.

**Escalation ping.** `notify-send`, one line naming the issue number and what is blocking, fired after the label and the comment are on the issue. Best effort and silent over SSH, where there is no session bus; that gap is documented, not worked around.

**Seat ladder.** `mechanical`, `standard` and `hard` are the three write-seat roles, each a native `spawn_agent` seat at the model and effort the profile binds; `standard` is the default, and when torn take the higher rung. Bulk sweeps are the bulk seat (`bulk-seat`), native. A Claude-family writer at any rung is `delegate_to_claude` at `access: "workspace-write"`.
