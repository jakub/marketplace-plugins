---
description: Hands-off implementation of a ready-for-agent issue, through a pushed, reviewed, evidenced PR.
argument-hint: <issue-number>
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Bash(node:*), Read, Write, Workflow, TaskOutput, TaskStop, PushNotification, Agent, SendMessage, AskUserQuestion, Skill
---

# /flow:issue

/flow:issue is the middle of the prep → issue → land process. Prep hardened the issue; this command drives it, hands-off, to a pushed, reviewed, evidenced PR and stops there.

There is no fixed pipeline and no stage list. You are the conductor, in the main session, inline. You compose the run to fit the issue and flex seats, models, and rounds as the work reveals itself. The charter gives you the model table and the rules of engagement; this file gives you the contract and a short list of things you can't trade away. Everything else is your call, and every call gets journaled.

The argument must be an issue number; abort with usage if it isn't a positive integer.

## Core principles

1) You conduct inline, so the session is occupied for the run and its context has to last. File scans, command output, and diffs live in subagents; only conclusions come home.
2) The invariants in §2 bind however you orchestrate. Fabric width, seats, modes, rounds are yours to flex, and every flex is journaled.
3) Hands-off by default. The only mid-run questions are forks genuinely the human's to pick, and trust-model forks are never guessed.
4) The issue is the record. The journal comments are what a human reads to audit the run, and the only recovery trail there is.
5) Never merge, never retire the worktree. The PR is where this command stops; `/flow:land` is the only merge path, and it cleans up after itself.

## 1. The contract

**In**: an open issue labeled `ready-for-agent`. If the label is missing, stop and route the user to `/flow:prep $N` - the contract is the safety case, so don't run cold on a spec nobody validated. Claim it atomically: assign + `in-progress`, then re-read to verify OUR claim landed, so two concurrent runs can't grab the same issue. If a live worktree, branch, or PR already exists behind it, surface the existing run rather than double-running. Snapshot `## Acceptance Criteria` at claim: the run is judged against the snapshot, and a body that moves mid-run is flagged, not chased. All work happens in a worktree off origin/main, branch `feat|fix|chore/issue-$N-<slug>`.

**Out**: an open PR - pushed, reviewed, evidenced, `Closes #N`-linked - or a clean escalation (`needs-info` / `needs-human` / `needs-rebase`: label it, comment what's blocking, fire a push notification). Never merge.

**Fork questions.** AskUserQuestion is allowed mid-run only when a fork is genuinely the human's to pick: rival designs both defensible on the merits, a contested finding whose dismissal changes the risk posture, a scope smell the issue cannot settle. Same bar as `needs-info`, cheaper than escalating. If no answer comes, decide, journal the guess as an event, and keep moving.

The exception is a trust-model fork - anything that sets the posture of a trust boundary (who may reach what, what an unattended tool will read or publish, where authority ends). Those are a mandatory ask, never guessed. The review fabric will ratify a plausible trust ruling rather than contest it, because a coherent trust model reads as intentional, so the guess-and-journal path is closed here. Unanswered, the only permissible default is the conservative posture (confine, refuse, least reach), flagged as provisionally decided in the final journal.

## 2. Invariants

These hold however you orchestrate.

1. **Decorrelation.** Every diff that ships is reviewed by at least one seat from a different model family than the one that wrote it. Claude reviewing Claude and codex reviewing codex are both correlation failures.
2. **Adversarial floor.** At least one review seat is prompted to refute the change, not to summarize it. A finding backed by a failing test it wrote is confidence 100 by construction: it skips adjudication, and its fix inherits the test as the regression guard. Prose refutation stays the floor, since design flaws and missing coverage aren't demonstrable; the fast lane is the incentive, not a gate.
3. **Security visibility.** A refused, dead, or errored security seat is surfaced as `securityReviewUnavailable` all the way to the human. No findings from a seat that never ran is absence of evidence. Retry across families before declaring it.
4. **UNKNOWN ≠ pass.** Errored, rate-limited, and timed-out checks are their own state. CI is green only on a head verified in sync: local sha == PR headRefOid, observed, never inferred from an exit status.
5. **Evidence per criterion, re-executable from the tree.** Every acceptance criterion gets a verdict plus a concrete pointer in a PR ledger, and a stranger holding only the merged repo must be able to reproduce the evidence - a committed test, a committed script, a committed artifact. Journal prose describing a heroic verification (fuzz totals, sweep counts, browser differentials) is narrative, not evidence; an expiring capability URL is evidence with a TTL. If it can't survive `git clone` on a fresh machine, the ledger entry isn't done. One carve-out: captures (screenshots, recordings) may host on plans through the `/artifacts` skill with `--keep`, linked per criterion, since a capture isn't re-executable anyway and plans beats bloating the repo with media. Plans hosts captures, never proof: the testable claim behind the capture still needs its committed test. Judged against the claim snapshot; a body that moved mid-run is flagged, not chased.
6. **Termination on evidence, not counters.** Convergence is risk-tiered:
   - standard work: one clean cross-family adversarial pass (a different family than the fixer, fresh eyes, nothing blocking) and you're converged.
   - trust-boundary contact or a churny run: two consecutive clean passes from different seats.
   - breadth backstop: churn tripwires concentrate the fabric on the file that fights back, and depth there isn't coverage elsewhere. The final pass before convergence must sweep the whole diff surface at file granularity and list what it read and what it skipped; any file no reviewer has named since the last fix round is a gap. Churn depth and closing breadth are separate obligations.
   - circuit breaker: past ~5 fix rounds, stop fixing. Adjudicate the survivors at maximum effort and escalate the real ones. The breaker interrupts a human; it never ships silently.
7. **Containment.** All writes in the worktree; leaf agents don't sub-delegate; two agents never edit one file concurrently. Staging is repo-global even when edits are disjoint, so parallel fixers stage only their own files by explicit path (never `git add -A` / `commit -a`) or their commits serialize. No `--no-verify`, no trailers - hooks enforce both.
   This is mechanism, not memory: every write-capable seat (implementation, fixes, doc-sync) spawns as `flow:implementer`. Its toolset has no Agent tool, so sub-delegation is impossible rather than discouraged, and its system prompt carries the sync-run, scope, and report discipline. A `general-purpose` seat holding Edit is a containment violation. Seats that edit nothing (scouts, reviewers, transports) keep their own defs. Your prompt still names the worktree and the milestones; the def carries the rules.
8. **Refusal routing.** Any seat can come back null. Every judgment or security seat needs a cross-family fallback: `gpt-daybreak-blue-latest` through codex-delegate is the first retry for security-flavored work, not the other Claude, and a double-null is reported, never swallowed.
9. **Seat reports are claims.** A seat's final message is prose from a model that may have hallucinated its own progress - "launched a background agent", "waiting on the monitor", a commit annexed from a sibling. Before acting on any completion or blocker report, run `git -C <wt> log` and `git -C <wt> status` and compare against what the seat says it did. A seat that stopped mid-task gets a `SendMessage` nudge carrying the conductor-verified state (which commits exist, what the tree holds), so it can't re-litigate what's done. A seat that fabricates twice is re-run on a stronger model, journaled as an event.

## 3. The design pass - always on

Every production-code run gets a design pass. "The ADR / prep settled it" isn't a skip reason: that covers the forks the spec named, and the code-level design space (where things live, what signatures stream, which table is canonical) is never in that set. Skip it and the implementer becomes the architect by default, unreviewed - the defect class this pass exists to catch.

The standard is a blind cross-model pair plus your own synthesis:

- **opus leg** (high): the minimal framing - smallest change, maximum reuse, grounded in the actual code seams. Usually the synthesis winner; the anchor.
- **sol leg** (blind, parallel): not "ask codex for an approach". A decorrelated design sheet with two jobs: propose its own shape independently, and hunt spec gaps - name what the issue didn't say that the implementer would otherwise decide silently. The outside brain finds different holes, and decorrelation is cheapest per finding at design time.
- **your synthesis, inline** (no extra seat): resolve disagreements explicitly, never average. A disagreement here costs a paragraph; the same disagreement at review time costs a fix round.

Required outputs. A pass without these didn't happen:

1. **Placement map** - where each new thing lives and why.
2. **Single-source-of-truth declarations**, with the drift guards that enforce them.
3. **API shapes with signatures** - streaming vs buffered is decided here, on paper.
4. **Invariant ownership** - which layer enforces what.
5. **Milestones with per-milestone difficulty** - routes implementer model and effort.
6. **The "not-alone" list** - decisions the implementer may not make without a checkpoint. Doubles as the shadow reviewer's structural watchlist, so the shadow covers design drift, not just behavior.

Flexing the pass (your call, each move journaled):

- **Widen to three legs** by adding the fable clean/taste leg: new subsystem, public API surface, taste-heavy work - or the pair disagrees hard, which is a signal to widen rather than adjudicate thin.
- **Shrink to a lone sol pre-flight** only for changes with no code-design space at all (doc-only, config-only, comment-only). Never zero.
- **Open design discovered mid-run is a prep failure, not a mode.** The full dialectic (blind → argue → human adjudicates) lives at /flow:prep, and the label contract forbids an issue arriving here with open shape questions. A small shape question mid-run is a fork question, journaled as a prep-gap event; genuinely open design is `needs-info`, back through the front door.

## 4. Freedoms

Yours to flex, per issue and mid-run.

- **Fabric width**: how many review lenses, whether a post-push stage exists at all. The design pass has a floor (§3), and an auth-touching "trivial" gets the full security panel regardless of its size label.
- **Continuous re-sizing**: size isn't a launch-time verdict. These tripwires force a fabric re-think, and each firing is journaled as an event:
  - the diff touches a trust boundary the issue never mentioned (auth, input parsing, shell/SQL/template construction, secret handling);
  - the diff exceeds ~2× the plan's expected file count;
  - fix rounds churn on the same area (a fix spawning findings where it landed);
  - cross-family reviewers disagree hard on the same code.
  Beyond the tripwires you have standing permission to widen on any hunch. Narrowing is also legal (a "medium" that turned out mechanical); journal that too.
- **Seat assignment, one ladder**: the design pass names a difficulty per milestone (`mechanical | standard | hard`), judged on what could break, never counted from file totals. Difficulty routes both model and effort on the `flow:implementer` seat: `mechanical` → sonnet/medium (transcribing a complete spec, shape already decided); `standard` → opus/high (the default: anything with a code-design decision left in it, a new test harness, an unfamiliar toolchain); `hard` → opus/xhigh (a miss ships). When torn between two rungs, take the higher. Opus is the default code writer; sonnet on an implementer seat is an exception you justify in the launch journal. Non-writing seats route by the charter's table.
- **Orchestration medium, per fan-out**: drive Agent calls directly when a stage is adaptive or small; write a short ad-hoc Workflow script when a fan-out is deterministic and worth resume plus a progress UI (a 4-lens review fabric, parallel disjoint fixes). `workflows/issue-fixed.mjs` is a parts library - salvage pattern, envelope rules, schemas, push-verify prompts - so take from it rather than re-deriving it.
- **Mode selection**: parallel-blind, collaborative (propose → critique → revise across families), or adversarial (red team vs blue team), picked per stage. Cross-model disagreement is signal: resolve it explicitly, never average it.

## 5. The codex seats

Sol is flat-rate on the subscription, which turns every pattern below from "can we afford it" into "does it help":

- **Designer, every run**: the sol design leg (§3) is a first-class seat, not a consult. Sol proposes blind and hunts spec gaps before a line is written.
- **Standing consult**: when torn at any judgment point (synthesis, triage, adjudication), ask sol for a decorrelated second opinion before deciding. Two-key dismissal: a medium+ finding is dismissed as noise only when both families agree it is.
- **Dialectic is prep's, not yours**: blind → argue → synthesize runs at /flow:prep, where the human adjudicates the argument into ADRs. At issue stage the design pair stays blind and you synthesize; wanting a dialectic mid-run means the issue shouldn't have passed the front door.
- **Shadow reviewer at milestone checkpoints**: sol reads commits as they land during implementation, accumulating findings silently. At each milestone boundary you triage the accumulated set and hand blocking items to the implementer before the next milestone starts - early signal, no mid-thought interruption. The shadow's watchlist includes the design pass's "not-alone" list, so structural drift is a checkpoint finding too. The shadow complements the final adversarial pass; it never replaces it, because convergence still needs fresh eyes on the finished diff.
- **Red team**: sol tries to break Claude's implementation and vice versa. Route demonstrable claims through the fast lane (§2, invariant 2): "prove it or drop it" beats prose severity debates.
- **Bulk tier**: luna for mechanical sweeps (comment rot, evidence collection, transcript reads); luna at max effort is the cheap-depth combo. Never the decorrelation seat itself - that needs intelligence.

Transport: `codex-exec.mjs` under the plugin's `scripts/` (`task` / `adversarial-review` subcommands, JSON envelope; `.ok` and `.fast.applied` are the truth - the envelope rules are in `workflows/issue-fixed.mjs`). Bash timeout 600000; the transport holds 540s inside it. If the envelope error says the subscription rejected the model tier you pinned, re-run on another codex model from the charter's table rather than losing the seat.

## 6. Rules of engagement

- **Journal = composition + events + final.** Three kinds of issue comment:
  1. *Launch*: the composed fabric - which seats, which modes, why - before work starts. The human audits the composition, not just the outcome.
  2. *Events*, appended as they happen: tripwire fired, fabric widened or narrowed, fork guessed (question unanswered), seat re-run on a stronger model, breaker tripped.
  3. *Final*: outcomes plus coverage. Quiet runs have exactly two comments; eventful runs show their history. The journal is also the recovery trail: there is no runId to resume, so the run has to be reconstructible from the issue alone.
- **Coverage is a deliverable**: the final journal states what actually looked at the diff (seats composed vs delivered, by name). A thinned fabric that reads as a clean pass is the failure mode this whole system exists to prevent.
- **Escalate early on ambiguity**: a blocking question that issue + code + docs can't settle is `needs-info` the moment you find it, not after an implementation guess. Fork questions are for choices you could make but the human should; needs-info is for blockers you can't.

## Known gaps

- **No cross-session resume** - there is no runId to pick back up. The event journal is the mitigation: a fresh session reads the issue comments plus the worktree diff and reconstructs the run state.
- **No calibration ledger**: per-seat finding precision is not tracked across runs; compose from the charter's model table.
