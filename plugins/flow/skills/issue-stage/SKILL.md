---
name: issue-stage
description: Hands-off implementation of one ready-for-agent issue, through a pushed, reviewed, evidenced PR and no further. The conductor composes the seat fabric per issue, contains every writer, journals every call to the issue, and never merges. MUST only run when the operator explicitly asks to run a specific issue number; never start it from adjacent work, a finished prep, a discovered defect, or a survey of what to do next.
disable-model-invocation: true
---

# issue-stage - the autonomous middle of the prep → issue → land process

Prep hardened the issue. This stage drives it, hands-off, to a pushed, reviewed, evidenced PR and stops there. The land stage is the only merge path.

First, before the argument step or anything else: read the profile for the active host from `profiles/` next to this file, and adopt its bindings for every `[[gate:]]` below. If no profile there matches the session's host, stop and say so before taking any action.

Every gate below carries a `[[gate:<id>]]` marker. The profile you just read has one section per marker and says what that gate binds to here. Where a step needs a decision from the human, the profile's human-choice binding says how to put the choice in front of them, how the answer comes back, and whether asking ends the turn.

There is no fixed pipeline here and no stage list. You are the conductor, in the main session, inline. You compose the run to fit the issue and flex seats, models, and rounds as the work reveals itself. The charter gives you the model table and the rules of engagement; this file gives you the contract and a short list of things you cannot trade away. Everything else is your call, and every call gets journaled.

## Core principles

1) You conduct inline, so the session is occupied for the run and its context has to last. File scans, command output, and diffs live in seats; only conclusions come home.
2) The invariants in §5 bind however you orchestrate. Fabric width, seats, modes, rounds are yours to flex, and every flex is journaled.
3) Hands-off by default. The only mid-run questions are forks genuinely the human's to pick, and a trust-model fork is never guessed and never continued past.
4) The issue is the record. The journal comments are what a human reads to audit the run, and the only recovery trail there is.
5) Never merge, never retire the worktree. The PR is where this stage stops, and the land stage cleans up after itself.

## 1. The contract

**In**: an open issue labeled `ready-for-agent`.

[[gate:resolve-issue]] The argument is an issue number; abort with usage if it is not a positive integer. Three origins authorize that number: the argument carried by the invocation, the human naming the issue in words, or the human's own go-ahead on a hand-off out of the prep stage. A hand-off line that names this stage is not an invocation - the human's next message is. Anything else is a stop, and this stage never picks its own issue out of adjacent work, a defect it noticed on the way past, or a survey of what to do next.

Read the issue. If it is closed, or the `ready-for-agent` label is missing, stop and route the human back through the prep stage. The label contract is the safety case, so don't run cold on a spec nobody validated.

A blocking label sitting next to `ready-for-agent` is a stop too. `needs-human`, `needs-info`, or `needs-rebase` on an issue that still reads `ready-for-agent` means the ready label is stale, not that the issue is ready twice over. Both get there honestly: a failed preflight leaves `ready-for-agent` alone and adds `needs-human`, and a re-prep can add `needs-info` beside it. Route the human to the blocker instead of around it. A blocking label is a human's unfinished decision, and the human is the only one who clears it.

[[gate:workspace-boundary]] The worktree this run will write in has to sit inside the workspace boundary the host enforces for this session. The profile says what that boundary is here and how to read it. A worktree outside it is a stop, not a thing to work around: every containment claim the preflight is about to make is scoped to that boundary, and a path outside it makes those claims false before a single seat spawns.

All work happens in a worktree, on branch `feat|fix|chore/issue-$N-<slug>`, based at the head the claim verified rather than at whatever this clone last fetched. The claim protocol in §3 is what puts it there.

**Out**: an open PR, pushed, reviewed, evidenced, and `Closes #N`-linked. Or a clean escalation: `needs-info`, `needs-human`, or `needs-rebase`, labeled, with a comment saying what is blocking, and the escalation notice of §9. A run that never got past the preflight leaves through that same door and leaves nothing else behind it (§2). Never merge.

## 2. The write-seat preflight [[gate:write-seat-preflight]]

This runs before any mutation, and "any" is literal: no assignment, no label, no comment, no claim tag, no branch, no worktree, no spawn happens until it passes. The one exemption is the terminal escalation a failure fires, spelled out at the end of this section. A host that cannot run this stage must never stamp `in-progress` on an issue and walk away.

For every write-seat class this run will use, the host has to name a containment answer on three dimensions - workspace, descendants, hooks - and each answer is one of exactly three words: `mechanism`, `contract`, `unverified`. `mechanism` means something outside the model's control enforces it. `contract` means the seat was told and nothing checks. `unverified` means nobody knows. The answers come from the live host-capability read the profile binds, not from memory and not from this file; the profile names the call and the capability id behind each class.

Two more conditions, both hard:

- The canonical seat contract at `plugins/flow/seat-contract.md` must be readable. An unreadable contract is not a formatting problem, it is a spawn prompt going out with no contract in it.
- Version drift is a string comparison against the capability table's own verified-against record. If the host is running a version the table was never checked against, a capability the run needs reads `unverified`. Invent no runtime probe to paper over that, and do not re-check the contract mirrors at runtime - a build-time lint owns mirror parity.

`unverified` on a dimension a needed write-seat class depends on is a stop.

A failed preflight stops the run, and the stop is not silent. The terminal escalation is the single exemption to the ban above, and it is the whole of it: the `needs-human` label, one comment naming the failed capability by id, and the escalation notice of §9. Nothing else moves. No assignment, no `in-progress`, no claim tag, no branch, no worktree, no spawn, and the conductor's own minor-inline-edit latitude stays void for the rest of the run. Writing the code yourself because no seat can be contained is the named forbidden fallback: it is the exact failure the preflight exists to catch, and it is the one that looks most like progress from the inside.

The exemption is there because the alternative is worse than a label on an issue nobody claimed. A run that mutates nothing at all leaves an issue still reading `ready-for-agent`, with no record that a host tried and could not, and the next run walks into the same wall and learns the same nothing. None of those three writes needs a claim, and none of them says this run holds the issue.

A passed preflight leaves the charter's latitude exactly as ratified. Minor inline edits and scratch scripts are conducting; substantial writing goes only to contained seats.

## 3. The claim

Assigning the issue and re-reading it is not a claim, and calling it atomic does not make it one. Two runs under one account both see a green re-read of the assignment and the label, so the re-read proves only that somebody's claim landed, not whose. The mutual exclusion is a tag push, decided server-side.

Before acquiring anything, scan for a run that is already live: local worktrees, the issue's branches on the remote, and open PRs naming the issue, all three. If any of them turns up a live run, surface it and stop rather than double-running.

Ask the server for those branches, with `git ls-remote origin "refs/heads/feat/issue-${N}-*" "refs/heads/fix/issue-${N}-*" "refs/heads/chore/issue-${N}-*"`, the validated issue number rendered into each pattern before the command runs. Single-quoting those patterns hands the server a literal dollar sign and matches nothing, which looks exactly like a clean scan. Never `git branch` and never the remote-tracking refs either. Once a run releases its tag, that remote branch is the only marker a second run can see until a PR exists, and a clone's refs are only as fresh as its last fetch. A stale clone that asks itself misses the very branch whose appearance released the tag.

That scan is not redundancy behind the tag, it is what catches the ordinary case. A run releases its tag the moment its work branch is visible on the remote, so from then on there is no tag to contend for and a second invocation acquires a fresh one uncontested. The tag closes exactly one window, from this scan to the first appearance of the work branch on the remote. A run already past that window is caught here or it is not caught at all.

Acquire through `scripts/issue-claim.mjs`. It pushes `refs/tags/flow-claim-issue-N` without force and classifies the porcelain result, and its verdict is the whole answer:

- `acquired` is the only win. Proceed.
- `held` means another run has this issue. Surface that run and stop, having mutated nothing.
- `unknown` is an operational failure, not a loss. Report it and stop. A run that reads `unknown` as "somebody else has it" hides a broken remote.

On `acquired`, and while holding the tag, run that same three-pattern `ls-remote` again, plus the worktree and PR checks, before touching the issue at all. This is what catches the delayed contender: a run that scanned before you took the tag, saw nothing, and is still on its way to claiming. The second look is race-free by construction. Holding the tag blocks every new contender from acquiring, and any earlier winner released its tag only after its branch reached the remote, so a live run has nowhere left to hide. Scan, tag, scan again, and the tag covers the gap between the two scans.

On a hit, abandon. `scripts/issue-claim.mjs abandon <N> <sha>` takes the acquire receipt, meaning the SHA the acquire result reported, and deletes the tag under a lease pinned to that SHA, so the delete can only remove the tag this run created moments ago. Then surface the run you found and stop. The issue itself is untouched, because that transient tag was this run's only mark on anything.

Abandon is not an exception to the stale-tag rule and never becomes one. It covers a single case, the tag this run provably created seconds ago and can name by its object. Every other tag on the remote stays human-only, including one a crash left five minutes back.

Then, in this order: assign the issue, remove `ready-for-agent`, and apply `in-progress`, which is one lifecycle transition rather than two labels sitting on one issue; snapshot `## Acceptance Criteria`, where the digest is the sha256 of the exact bytes of that section; post the launch journal comment, opening with the claim ledger of §4; create the work branch and push it; then release the tag through the same helper. The helper verifies the remote branch is at the head it expects before deleting the tag, and refuses if it isn't - the tag is what keeps a second run out during the window where the branch does not yet exist remotely, so it comes down only once that window has closed.

The label move is one transition and the claim step owns it. `label-contract.md` gives `ready-for-agent` to prep and has the claim step clear it, and every open issue carries exactly one lifecycle label. An issue left holding both reads as two states at once, and the nightly lint has to guess which one is true.

The acquire verdict carries the base. Create the branch at the SHA the acquire result reports, never from the local `origin/main` ref. The helper read that object off the remote and verified it, so it is origin's current main and it is the object the claim tag pins. A remote-tracking ref is only as fresh as the last fetch this clone happened to run, and the helper deliberately leaves it alone. A stale clone that claims successfully and then branches from its own `origin/main` runs every immutable-base review against an old base, and each of those reviews comes back clean about a diff nobody is going to merge.

A stale claim tag found at entry is surfaced to the human with the branch and PR state it guards. It is NEVER deleted or force-replaced by an agent. An agent that can break its own locks does not have a lock, and a crashed run's tag is exactly the case where the guess is most expensive.

The run is judged against the AC snapshot. A body that moves mid-run is flagged, not chased.

## 4. The journal [[gate:journal-assurance]]

Three kinds of issue comment, and no more:

1. *Launch*: the claim ledger, then the composed fabric - which seats, which modes, why - before work starts. The human audits the composition, not just the outcome.
2. *Events*, appended as they happen: tripwire fired, fabric widened or narrowed, fork guessed, seat re-run on a stronger model, breaker tripped, answer rejected as stale.
3. *Final*: outcomes plus coverage.

Quiet runs have exactly two comments. Eventful runs show their history.

The launch comment OPENS with the claim ledger, and the ledger has a fixed grammar so a reader can grep it out of a long thread. A host line first: the host, the versions it reports, and a one-line summary of the sandbox posture. Then the anchors line: the AC snapshot digest and the base sha. Then one line per write-seat CLASS:

```
seat-class: <name> | workspace: <answer> | descendants: <answer> | hooks: <answer>
```

The only permitted answers are `mechanism`, `contract`, and `unverified`, the same three words §2 read from the capability table. Classes, not instances: individual seats are journaled at spawn, in an event or in the launch composition. If the run reaches for a write-seat class that is not already in the ledger, that class gets its own preflight read and an appended journal event BEFORE its first spawn.

The ledger is a record, not a credential. At any recovery every authority claim in it is re-derived live, the preflight read again and the state read again, so a ledger line never authorizes a later action by itself. That is also why a seat under the same account that defaces a journal comment corrupts the history a human reads while laundering no authority forward.

State the assurance and move on. This is never a per-run trust question to the human. A run that asks whether its own contained seats are acceptable is asking the human to re-decide something ratified at design time, once per run, forever.

**Coverage is a deliverable.** The final journal states what actually looked at the diff: seats composed against seats delivered, by name. A thinned fabric that reads as a clean pass is the failure mode this whole system exists to prevent.

The journal is also the recovery trail. There is no run id, so the run has to be reconstructible from the issue alone.

## 5. Invariants

These hold however you orchestrate.

1. **Decorrelation.** [[gate:review-fabric]] Every diff that ships is reviewed by at least one seat from a different model family than the one that wrote it. A family reviewing itself is a correlation failure, whichever family it is and whichever host is conducting - decorrelation is a rule about seat assignment, not about topology. The profile says how a seat of each family is reached from here, and what a wider fabric of lenses costs on this host.
2. **Adversarial floor.** At least one review seat is prompted to refute the change, not to summarize it. A finding backed by a failing test it wrote is confidence 100 by construction: it skips adjudication, and its fix inherits the test as the regression guard. Prose refutation stays the floor, since design flaws and missing coverage aren't demonstrable; the fast lane is the incentive, not a gate.
3. **Security visibility.** A refused, dead, or errored security seat is surfaced as `securityReviewUnavailable` all the way to the human. No findings from a seat that never ran is absence of evidence. Retry across families before declaring it.
4. **UNKNOWN is not a pass.** Errored, rate-limited, and timed-out checks are their own state. CI is green only on a head verified in sync: local sha == PR headRefOid, observed, never inferred from an exit status.
5. **Evidence per criterion, re-executable from the tree.** Every acceptance criterion gets a verdict plus a concrete pointer in a PR ledger, and a stranger holding only the merged repo must be able to reproduce the evidence: a committed test, a committed script, a committed artifact. Journal prose describing a heroic verification (fuzz totals, sweep counts, browser differentials) is narrative, not evidence, and an expiring capability URL is evidence with a TTL. If it can't survive `git clone` on a fresh machine, the ledger entry isn't done. One carve-out: captures - screenshots, recordings, oversized image sets - go through the charter's artifact-publish role with retention that outlives the PR, linked per criterion. A capture isn't re-executable anyway, and hosting it beats bloating the repo with media. The artifact host carries captures, never proof: the testable claim behind the capture still needs its committed test.
6. **Termination on evidence, not counters.** Convergence is risk-tiered:
   - standard work: one clean cross-family adversarial pass (a different family than the fixer, fresh eyes, nothing blocking) and you're converged.
   - trust-boundary contact or a churny run: two consecutive clean passes from different seats.
   - breadth backstop: churn tripwires concentrate the fabric on the file that fights back, and depth there isn't coverage elsewhere. The final pass before convergence must sweep the whole diff at file granularity and list what it read and what it skipped; any file no reviewer has named since the last fix round is a gap. How that list reaches you depends on the seat. A native seat's report is prose already, and invariant 10 says how you check it against the tree. A bridge review has no prose to read: the job validates its whole final message against the closed findings schema, so a clean pass is an empty findings array and the coverage list has nowhere to ride except inside a finding a clean pass does not have. So continue that same review job, through the delegation continuation the profile names, and ask one question, the complete list of files read and files skipped plus the verdict, in plain text. Read the continuation for coverage and the verdict and for nothing else. The findings stay exactly what the validated structure of the original result said, which is what §8's rule against parsing review prose protects. Churn depth and closing breadth are separate obligations.
   - circuit breaker: past ~5 fix rounds, stop fixing. Adjudicate the survivors at maximum effort and escalate the real ones. The breaker interrupts a human; it never ships silently.
7. **Containment.** [[gate:write-seat]] Every write lands inside the worktree, from a seat that cannot sub-delegate, and no two seats hold the same file at once. Staging is repo-global even when the edits are disjoint, so a fan-out of parallel fixers serializes on the index unless each one stages only its own paths. That is a constraint on how you compose the fan-out, not only a rule the seats are handed.
   The rules each seat follows are not in this file. Every substantial write-capable seat - implementation, fixes, doc-sync - runs the canonical seat contract in `plugins/flow/seat-contract.md`, and the profile says how that contract is carried on this host: a contained seat definition that already holds it, a spawn prompt carrying the file verbatim, or the cross-family bridge with workspace write. A path reference is not a contract, and neither is a piece of one: the whole text reaches every substantial writer, and a delivery that carries a single section is a floor under the contract rather than the contract. The profiles say how the full text travels for each class. Naming the file here and restating none of it is the point, because two copies of a rule drift and the run then obeys the older one. Seats that change nothing - scouts, reviewers, transports - are not write seats and don't carry it. Your own prompt still names the worktree and the milestones; the contract carries the discipline.
8. **One seat cap, counted honestly.** About 20 live seats, and the count includes every native seat that is running AND every bridge job that has not reached a terminal state - queued, starting, running, reconciling, awaiting approval, unknown. Terminal jobs drop off. An UNKNOWN job holding workspace write keeps both its slot and its write lease until it is reconciled: it may still be writing, and freeing its slot double-books the worktree. Over the cap, batch.
9. **Refusal routing.** Any seat can come back null, and a refusal is indistinguishable from a dead one. Every judgment or security seat needs a cross-family fallback: the retry for a null security seat is a seat of the OTHER family, reached the way the profile says, never a second seat of the same family that just refused. A double-null is reported, never swallowed.
10. **Seat reports are claims.** [[gate:seat-verification]] A seat's final message is prose from a model that may have hallucinated its own progress: a backgrounded agent it never launched, a monitor it is waiting on, a commit annexed from a sibling. Before acting on any completion or blocker report, run `git -C <wt> log` and `git -C <wt> status` and compare against what the seat says it did. A seat that stopped mid-task gets a nudge carrying the conductor-verified state - which commits exist, what the tree holds - so it cannot re-litigate what is already done; the profile says how a running seat is reached here, and what to do instead when it cannot be reached. A seat that fabricates twice is re-run on a stronger model, journaled as an event.
    A reading also runs around every review seat, for a different reason, and a status line plus a diff cannot do that job. A reviewer is read-only by its prompt and by the hooks, and on any host that leaves a shell in the seat it is not read-only by mechanism. Untracked files are where a status-and-diff check goes blind: `?? path` reads exactly the same before and after that file's bytes change, and `git diff` never carried its content in the first place. So take the same four values prep-stage takes at its entry, once before the review seat spawns and once when it returns: `git status --porcelain=v2 --untracked-files=all`; `git diff | sha256sum`; `git diff --cached | sha256sum`; and a digest of every untracked, unignored path - name, type, mode, and either the file's bytes or the symlink's target, never the target's contents, `git ls-files --others --exclude-standard -z | sort -z | tar --null --no-recursion -T - --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - | sha256sum`. Any difference and the review does not count as covering the diff that ships: stop, name the path that moved, and find out what wrote it. The boundary is stated, not hidden. This sees tracked and untracked-unignored paths inside the worktree, by name, type, mode, and content; it does not see ignored paths, the interior of a tracked submodule (a gitlink and a coarse status line, never a hash of anything inside it), the inside of an untracked nested repository, or anything outside the worktree. It is a detector for a misbehaving seat, not containment, and a review of a tree that changed underneath it is a review of nothing that shipped.

## 6. The design pass, always on [[gate:design-pass-legs]]

Every production-code run gets a design pass. "The ADR or the prep settled it" isn't a skip reason: that covers the forks the spec named, and the code-level design space - where things live, what signatures stream, which table is canonical - is never in that set. Skip it and the writer becomes the architect by default, unreviewed, which is the defect class this pass exists to catch.

The standard is a blind pair plus your own synthesis:

- **The native leg**, on this host's own model family: the minimal framing. Smallest change, maximum reuse, grounded in the actual code seams. Usually the synthesis winner, and the anchor.
- **The bridge leg**, blind and parallel, through the cross-family delegation tool. This is not "ask the other family for an approach". It is a decorrelated design sheet with two jobs: propose its own shape independently, and hunt spec gaps, naming what the issue didn't say that the writer would otherwise decide silently. The outside brain finds different holes, and decorrelation is cheapest per finding at design time.
- **Your synthesis, inline**, with no extra seat: resolve disagreements explicitly, never average. A disagreement here costs a paragraph. The same disagreement at review time costs a fix round.

The two families MUST differ. Two seats out of one family is one opinion said twice. Launch the native leg first, then run the bridge attached, so both sheets land in the same turn. The profile pins the models and the efforts. Which family is the outside opinion flips with the host, so take it from the profile rather than from habit.

Required outputs. A pass without these didn't happen:

1. **Placement map**: where each new thing lives, and why.
2. **Single-source-of-truth declarations**, with the drift guards that enforce them.
3. **API shapes with signatures**: streaming against buffered is decided here, on paper.
4. **Invariant ownership**: which layer enforces what.
5. **Milestones with per-milestone difficulty**, which routes the write seat's model and effort.
6. **The not-alone list**: decisions the writer may not make without a checkpoint. It doubles as the shadow reviewer's structural watchlist, so the shadow covers design drift and not just behavior.

Flexing the pass is your call, and each move is journaled:

- **Widen to three legs** by adding a taste leg, on the model the charter's table ranks highest for taste and the profile names: a new subsystem, a public API, taste-heavy work. Or when the pair disagrees hard, which is a signal to widen rather than adjudicate thin.
- **Shrink to a lone bridge pre-flight** only for changes with no code-design space at all: doc-only, config-only, comment-only. Never zero.
- **Open design discovered mid-run is a prep failure, not a mode.** The full dialectic - blind, then argue, then the human adjudicates - lives at the prep stage, and the label contract forbids an issue arriving here with open shape questions. A small shape question mid-run is a fork question, journaled as a prep-gap event. Genuinely open design is `needs-info`, back through the front door.

## 7. Freedoms

Yours to flex, per issue and mid-run.

- **Fabric width**: how many review lenses, and whether a post-push stage exists at all. The design pass has a floor (§6), and an auth-touching "trivial" gets the full security panel regardless of its size label.
- **Continuous re-sizing**: size isn't a launch-time verdict. These tripwires force a fabric re-think, and each firing is journaled as an event:
  - the diff touches a trust boundary the issue never mentioned (auth, input parsing, shell or SQL or template construction, secret handling);
  - the diff exceeds about twice the plan's expected file count;
  - fix rounds churn on the same area, a fix spawning findings where it landed;
  - cross-family reviewers disagree hard on the same code.
  Beyond the tripwires you have standing permission to widen on any hunch. Narrowing is also legal, a "medium" that turned out mechanical; journal that too.
- **Seat assignment, one ladder**: the design pass names a difficulty per milestone - `mechanical`, `standard`, `hard` - judged on what could break, never counted from file totals. Difficulty routes both the model and the effort on the write seat. `mechanical` is a cheaper same-family model at medium effort, and only when the seat is transcribing a complete spec whose shape is already decided. `standard` is the default code-writing model at high effort, and it is the default for a reason: anything with a code-design decision left in it, a new test harness, or an unfamiliar toolchain is standard. `hard` is that same model at maximum effort, for work where a miss ships. When torn between two rungs, take the higher. Dropping a write seat below the default code writer is an exception you justify in the launch journal. Non-writing seats route by the charter's table, and the profile names which model each rung is here.
- **Orchestration medium, per fan-out**: [[gate:fanout-medium]] drive the seats directly when a stage is adaptive or small. When a fan-out is deterministic, wide, and worth resume plus a progress readout - a four-lens review fabric, parallel disjoint fixes - use whatever this host offers for a scripted fan-out. The profile says what that is, or says the host has none and direct calls are the answer.
- **Mode selection**: parallel-blind, collaborative (propose, then critique, then revise across families), or adversarial (red team against blue team), picked per stage. Cross-model disagreement is signal: resolve it explicitly, never average it.

## 8. The cross-family seats

The bridge is reached through the delegation tool the charter names, and what it costs differs by host. On one the outside family is flat-rate, so every pattern below turns from "can we afford it" into "does it help". On the other every cross-family review is metered. The profile carries that note, and the review is mandatory either way - decorrelation is not a budget line.

- **Designer, every run**: the bridge design leg (§6) is a first-class seat, not a consult. It proposes blind and hunts spec gaps before a line is written.
- **Standing consult**: when torn at any judgment point - synthesis, triage, adjudication - ask the other family for a decorrelated second opinion before deciding. Two-key dismissal: a medium-or-higher finding is dismissed as noise only when both families agree it is.
- **Dialectic is prep's, not yours**: blind, then argue, then synthesize runs at the prep stage, where the human adjudicates the argument into ADRs. Here the design pair stays blind and you synthesize. Wanting a dialectic mid-run means the issue shouldn't have passed the front door.
- **Shadow reviewer at milestone boundaries**: a bridge seat reads commits as they land during implementation and accumulates findings silently. At each milestone boundary you triage the accumulated set and hand blocking items to the writer before the next milestone starts. Early signal, no mid-thought interruption. The shadow's watchlist includes the design pass's not-alone list, so structural drift is a checkpoint finding too. The shadow complements the final adversarial pass and never replaces it, because convergence still needs fresh eyes on the finished diff.
- **Red team**: each family tries to break the other's implementation. Route demonstrable claims through the fast lane of invariant 2 - "prove it or drop it" beats a prose argument about severity.
- **Bulk tier**: the cheapest model in the charter's table for mechanical sweeps, meaning comment rot, evidence collection, transcript reads. That model at maximum effort is the cheap-depth combo. It is never the decorrelation seat itself, which needs intelligence.

Delivery semantics are role language, not a preference. Attached delivery keeps the job's progress visible inside the call, and that is what a normal seat wants. Detached delivery is for a run that must outlive the current tool call: retain the job id and read it back with the delegation status, events, and result tools, because a detached job you never read is an UNKNOWN you invented on purpose.

Reviews run in adversarial-review mode against an immutable base, with read-only access. `failed`, `unknown`, `cancelled`, and `awaiting_approval` are all an unavailable seat, never a clean review - invariant 4 is not suspended because the seat was on the other side of a bridge. The service validates review findings against a strict schema, so read the findings and do not parse review prose.

## 9. Forks, escalation, and when to stop

**Optional forks.** [[gate:fork-ask]] A fork is the human's only when it is genuinely theirs to pick: rival designs both defensible on the merits, a contested finding whose dismissal changes the risk posture, a scope smell the issue cannot settle. Same bar as `needs-info`, cheaper than escalating.

Whether you ask at all depends on the host. Where the human-choice binding answers inside the turn, ask. Where the binding ends the turn, an optional fork is never asked: decide it, journal a `fork guessed` event naming the alternative you rejected and why, and keep moving. Suspending a hands-off run to ask a question you are able to answer costs the human a turn and buys nothing.

**Trust-model forks.** [[gate:trust-fork-ask]] Anything that sets the posture of a trust boundary - who may reach what, what an unattended tool will read or publish, where authority ends - is a mandatory ask on EVERY host, whatever the binding costs. Never guessed. The review fabric will ratify a plausible trust ruling rather than contest it, because a coherent trust model reads as intentional, so the guess-and-journal path is closed here.

Unanswered, the run does not continue. Take the conservative posture (confine, refuse, least reach), label `needs-human`, write the durable journal entry, and STOP. There is no provisionally-decided-and-continued path out of a trust fork on any host: a run that ships a trust posture nobody ratified has spent its whole review budget agreeing with itself.

**The suspension protocol**, where the human-choice binding ends the turn. Finish every mutation first: commit, push, the journal event, the label, the escalation notice. THEN read the anchors - the AC snapshot digest, the head sha, the issue's `updatedAt` - immediately before asking. Reading them earlier lets your own checkpoint expire your own question. Ask one question, up to four numbered options, the recommendation first, each option carrying its consequence in a line.

An answer that arrives over moved anchors is expired. Journal `stale-answer-rejected`, keep `needs-human`, re-read the moved state, and ask fresh against it. `needs-human` clears only after that revalidation, never on the arrival of an answer alone.

**Escalate early on ambiguity.** A blocking question that the issue, the code, and the docs cannot settle is `needs-info` the moment you find it, not after an implementation guess. Fork questions are for choices you could make but the human should; `needs-info` is for blockers you cannot.

**The escalation notice.** [[gate:escalation-notice]] Every escalation is a label plus a comment saying what is blocking, and then a ping so the human learns about it without watching the issue. The ping is best-effort and the profile says what it binds to here, including when the answer is that this host has nothing to ping with. The durable part is always the label and the comment: a notice that never lands must never be the reason a clean escalation reads as a silent one. Those three writes are also the whole of what a failed preflight may perform (§2), and not one of them needs a claim first.

## Known gaps

- **The composed run has no run id.** Bridge jobs have durable job ids, but the surrounding dynamic run still recovers from the issue comments and the worktree diff. Parked at prep, deliberately: cross-machine run identity is a bigger design than this stage needs.
- **No calibration ledger**: per-seat finding precision is not tracked across runs. Compose from the charter's model table.
