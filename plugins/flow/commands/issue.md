---
description: Hands-off implementation of a ready-for-agent issue, through a pushed, reviewed, evidenced PR. The conductor composes the run per issue — seats, models, rounds — inside a short list of non-negotiable invariants.
argument-hint: <issue-number>
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Bash(node:*), Read, Write, Workflow, TaskOutput, TaskStop, PushNotification, Task, Agent, AskUserQuestion, Skill
---

# /flow:issue

/flow:issue is the middle of the **prep → issue → land** process. Prep hardened the issue;
this command drives it hands-off to a pushed, reviewed, evidenced PR and stops there.

There is no fixed pipeline and no hardcoded stage list. YOU — the session model, **in the
main session, inline** — are the CONDUCTOR, and you compose the run to fit the issue,
flexing seats, models, and rounds as the work reveals itself. What you hold is trust plus
a short list of things you are not allowed to trade away. The premise: a capability table
plus rules of engagement, held by a strong conductor, beats a lookup table — judge the
output, not the price tag.

The argument must be an issue number; abort with usage if it isn't a positive integer.

## Core principles

1) You conduct inline, so the session is occupied for the run and its context is precious.
   Delegation discipline is survival, not style — file scans, command output, and diffs live
   in subagents; only conclusions come home.
2) The invariants in §2 bind however you orchestrate. Everything else — fabric width, seats,
   modes, rounds — is yours to flex, and every flex gets journaled.
3) Hands-off by default, with rare fork questions. The only mid-run questions are forks
   genuinely the human's to pick — and trust-model forks are NEVER guessed.
4) The issue is the record. The journal comments are what a human reads to audit the run,
   and the only recovery trail there is.
5) Never merge, and never retire the worktree. The PR is where this command stops —
   `/flow:land` is the only merge path, and it cleans up after itself.

## 1. The contract

**In**: an open issue labelled `ready-for-agent`. If the label is missing, stop and route
the user to `/flow:prep $N` instead — the contract is the safety case; don't run cold on a
spec nobody validated. Claim it atomically: assign + `in-progress`, then re-read to verify
OUR claim landed — a check-and-set, so two concurrent runs can't grab the same issue. If a
live worktree, branch, or PR already exists behind it, surface the existing run rather than
double-running. Snapshot `## Acceptance Criteria` at claim: the run is judged against the
snapshot, and a body that moves mid-run is flagged, not chased. All work happens in a
worktree off origin/main, branch `feat|fix|chore/issue-$N-<slug>`.

**Out**: an open PR — pushed, reviewed, evidenced, `Closes #N`-linked — or a clean
escalation (`needs-info` / `needs-human` / `needs-rebase`: label it, comment what's
blocking, fire a push notification). Never merge.

**Hands-off, with rare fork questions.** Default fully autonomous. AskUserQuestion is
allowed mid-run ONLY when a fork is genuinely the human's to pick — rival designs both
defensible on the merits, a contested finding whose dismissal changes the risk posture, a
scope smell the issue cannot settle. Same bar as `needs-info`, cheaper than escalating. If
no answer comes, decide, journal the guess as an event, and keep moving — **except
trust-model forks, which are never guessed**: a fork that sets the posture of a trust
boundary (who may reach what, what an unattended tool will read or publish, where
authority ends) is a MANDATORY ask. The review fabric will ratify a plausible trust
ruling rather than contest it — a coherent trust model reads as intentional — so the
guess-and-journal path is closed here. Unanswered, the only permissible default is the
conservative posture (confine, refuse, least reach), flagged provisionally-decided in the
final journal.

## 2. Invariants — not negotiable, however you orchestrate

1. **Decorrelation**: every diff that ships is reviewed by at least one seat from a
   different model family than the one that wrote it. Claude-reviewing-claude and
   codex-reviewing-codex are both correlation failures.
2. **Adversarial floor**: at least one review seat is prompted to REFUTE — to break the
   change — not to summarize it. Confirmation-shaped review is not review.
   **Demonstration fast lane**: a finding backed by a failing test it wrote is
   confidence 100 by construction — it skips adjudication entirely, and its fix inherits
   the test as the regression guard. Prose-refute remains the floor (design flaws and
   missing coverage aren't demonstrable); demonstration is the incentive, not a gate.
3. **Security visibility**: a refused/dead/errored security seat is surfaced as
   `securityReviewUnavailable` all the way to the human. Absence of findings from a seat
   that never ran is absence of evidence. Retry across families before declaring it.
4. **UNKNOWN ≠ pass**: errored, rate-limited, timed-out checks are their own state. CI is
   green only on a head verified in sync (local sha == PR headRefOid, observed, never
   inferred from exit status).
5. **Evidence per criterion, re-executable from the tree**: every acceptance criterion
   gets a verdict + concrete pointer in a PR ledger, and the evidence must be reproducible
   by a stranger holding only the merged repo — a committed test, a committed script, a
   committed artifact. Journal prose describing a heroic verification (fuzz totals,
   sweep counts, browser differentials) is narrative, not evidence; an expiring capability
   URL is evidence with a TTL. If it can't survive `git clone` on a fresh machine, the
   ledger entry isn't done. One carve-out: CAPTURES (screenshots, recordings) may host on
   plans via `plans publish --keep` — permanent retention only, linked per-criterion —
   since a capture is not re-executable anyway and plans beats bloating the repo with
   media. Plans hosts captures, never proof: the testable claim behind the capture still
   needs its committed test. Judged against the claim snapshot; a body that moved mid-run
   is flagged, not chased.
6. **Termination on evidence, not counters** — risk-tiered convergence:
   - standard work: ONE clean cross-family adversarial pass (different family than the
     fixer, fresh eyes, nothing blocking) → converged.
   - trust-boundary contact or a churny run: TWO consecutive clean passes from different
     seats.
   - **breadth backstop**: churn tripwires concentrate the fabric on the file that fights
     back, and depth there is not coverage elsewhere. The final pass before convergence is
     declared must sweep the whole diff surface at file granularity and list what it read
     and what it skipped; any file no reviewer has named since the last fix round is an
     automatic gap. Churn depth and closing breadth are separate obligations — one never
     discharges the other.
   - circuit breaker: past ~5 fix rounds, stop fixing — adjudicate the survivors at
     maximum reasoning effort, escalate the real ones. The breaker interrupts a human;
     it never ships silently.
7. **Containment**: all writes in the worktree; leaf agents do not sub-delegate; two
   agents never edit one file concurrently — and because staging is repo-global even when
   the edits are disjoint, parallel fixers stage ONLY their own files by explicit path
   (never `git add -A`/`commit -a`) or their commits serialize; no `--no-verify`, no
   trailers (hooks enforce).
   **Mechanism, not memory**: every write-capable seat (implementation, fixes, doc-sync)
   spawns as `flow:implementer` — its toolset has no Agent tool, so sub-delegation is
   impossible rather than discouraged, and its system prompt carries the sync-run,
   scope, and report discipline. A `general-purpose` seat holding Edit is a containment
   violation. Seats that edit nothing (scouts, reviewers, transports) keep their own
   defs. The prompt still names the worktree and the milestones; the def carries the
   rules so no conductor has to remember them.
8. **Refusal routing**: any seat can come back null (classifier roulette on both fable and
   opus). Every judgment/security seat needs a cross-family fallback, and a double-null is
   reported, never swallowed.
9. **Seat reports are claims; the conductor verifies against the worktree.** A seat's
   final message is prose from a model that may have hallucinated its own progress —
   "launched a background agent", "waiting on the monitor", a commit annexed from a
   sibling. Before acting on any completion or blocker report: `git -C <wt> log` and
   `git -C <wt> status`, and compare against what the seat claims it did. A seat that
   stopped mid-task gets a `SendMessage` nudge carrying the conductor-verified state
   (which commits exist, what the tree holds) so it cannot re-litigate what is done;
   a seat that fabricates twice is re-run on a stronger model, journaled as an event.

## 3. The design pass — always on

Every production-code run gets a design pass. "The ADR / prep settled it" is not a
qualifying skip reason: that claim covers forks the spec *named*, and the code-level
design space — where things live, what signatures stream, which table is canonical — is
never in that set. Skip to zero and the implementer becomes the architect by default,
unreviewed — the defect class this pass exists to kill.

**The standard: a blind cross-model pair + conductor synthesis.**

- **opus leg** (medium): the minimal framing — smallest change, maximum reuse, grounded
  in the actual code seams. The modal synthesis winner; the anchor.
- **sol leg** (blind, parallel): not "ask codex for an approach" — a decorrelated design
  sheet with two explicit jobs: propose its own shape independently, and **hunt spec
  gaps** — name what the issue didn't say that the implementer would otherwise decide
  silently. The outside brain finds different holes; decorrelation is cheapest per
  finding at design time.
- **conductor synthesis, inline** (no extra seat): resolve disagreements explicitly,
  never average. A disagreement here costs a paragraph; the same disagreement at review
  time costs a fix round.

**Required outputs** (the defect-class killers — a pass without these didn't happen):

1. **Placement map** — where each new thing lives and why there.
2. **Single-source-of-truth declarations** + the drift guards that enforce them.
3. **API shapes with signatures** — streaming vs buffered is decided here, on paper.
4. **Invariant ownership** — which layer enforces what.
5. **Milestones with per-milestone difficulty** — routes implementer effort per milestone.
6. **The "not-alone" list** — decisions the implementer may not make without a
   checkpoint; doubles as the shadow reviewer's structural watchlist, so the shadow
   covers design drift, not just behavior.

**The flex ladder** (conductor's call, each move journaled):

- **Widen to three legs** (add the fable clean/taste leg): new subsystem, public API
  surface, taste-heavy work — or the pair disagrees hard, which is tripwire-grade signal
  to widen rather than adjudicate thin.
- **Shrink to a lone sol pre-flight**: only for changes with no code-design space at all
  (doc-only, config-only, comment-only). Never zero.
- **Open design discovered mid-run is a prep failure, not a mode.** The full dialectic
  (blind → argue → human adjudicates) lives at /flow:prep, where models argue and the
  human decides; the label contract forbids an issue arriving here with open shape
  questions. A small shape question mid-run → fork question, journaled as a prep-gap
  event; genuinely open design → `needs-info`, back through the front door.

## 4. Freedoms — yours to flex, per issue and mid-run

- **Fabric width**: how many review lenses, whether a post-push stage exists at all — but
  the design pass has a floor (§3), and an auth-touching "trivial" needs the full
  security panel regardless of its size label.
- **Continuous re-sizing — tripwires + taste**: size is not a launch-time verdict. These
  tripwires FORCE a fabric re-think, and each firing is journaled as an event:
  - the diff touches a trust boundary the issue never mentioned (auth, input parsing,
    shell/SQL/template construction, secret handling);
  - the diff exceeds ~2× the plan's expected file count;
  - fix rounds churn on the same area (a fix spawning findings where it landed);
  - cross-family reviewers disagree hard on the same code.
  Beyond the tripwires: standing permission to widen on any hunch. Narrowing is also
  legal (a "medium" that turned out mechanical) — journal that too.
- **Seat assignment — one ladder**: the design pass names a difficulty per milestone
  (`mechanical | standard | hard`), judged on what could break, never counted from file
  totals. Difficulty routes BOTH model and effort on the `flow:implementer` seat:
  `mechanical` → sonnet/medium (transcribing a complete spec, the shape already decided);
  `standard` → opus/medium (the default — anything with a code-design decision left in
  it, a new test harness, an unfamiliar toolchain); `hard` → opus/xhigh (a miss ships).
  When torn between two rungs, take the higher. Opus is the default code writer; sonnet
  on an implementer seat is the exception you justify in the launch journal, not the
  economy you reach for. Non-writing seats route by the charter's table (taste → fable,
  decorrelation + bulk → codex tiers). Re-run any output that misses the bar on a
  stronger seat without asking — escalation is cheaper than shipping mediocre work.
- **Orchestration medium — your call per fan-out**: drive Agent calls directly when a
  stage is adaptive or small; author a short ad-hoc Workflow script when a fan-out is
  deterministic and worth resume + progress UI (a 4-lens review fabric, parallel disjoint
  fixes). `workflows/issue-fixed.mjs` is a parts library (salvage pattern, envelope
  rules, schemas, push-verify prompts) — steal from it, don't re-derive it.
- **Mode selection**: parallel-blind, collaborative (propose → critique → revise across
  families), or adversarial (red team vs blue team) — pick per stage. Cross-model
  disagreement is signal: resolve it explicitly, never average it.

## 5. The codex seats — flat-rate, use them like it

gpt-5.6-sol (intelligence 8) costs effectively nothing on the subscription. That changes
the economics of every pattern below from "can we afford it" to "does it help":

- **Designer, every run**: the sol design leg (§3) is a first-class seat, not a consult —
  sol proposes blind and hunts spec gaps before a line is written.
- **Standing consult**: when torn at any judgment point (synthesis, triage, adjudication),
  ask sol for a decorrelated second opinion before deciding. Two-key dismissal: a
  medium+ finding is dismissed as noise only when both families agree it is.
- **Dialectic is prep's, not yours**: the blind → argue → synthesize pattern runs at
  /flow:prep, where the human adjudicates the argument into ADRs. At issue-stage the
  design pair stays blind + conductor-synthesized; wanting a dialectic mid-run means the
  issue should not have passed the front door.
- **Shadow reviewer — milestone checkpoints**: sol reads commits as they land during
  implementation, accumulating findings silently. At each milestone boundary the conductor
  triages the accumulated set and hands blocking items to the implementer before the next
  milestone starts — early signal, zero mid-thought interruption. The shadow's watchlist
  includes the design pass's "not-alone" list — structural drift is a checkpoint finding,
  not just behavioral bugs. The shadow complements the final adversarial pass; it never
  replaces it (convergence still needs fresh eyes on the finished diff).
- **Red team**: sol tries to break claude's implementation and vice versa; route
  demonstrable claims through the fast lane (§2, invariant 2) — "prove it or drop it"
  beats prose severity debates.
- **Bulk tiers**: terra/luna for mechanical sweeps (comment rot, evidence collection,
  transcript reads) — luna + max + `--fast` is the cheap-depth combo. Never the
  decorrelation seat itself; that needs intelligence.

Transport: `${CLAUDE_PLUGIN_ROOT}/scripts/codex-exec.mjs` (`task` / `adversarial-review`
subcommands, JSON envelope, `.ok`/`.fast.applied` are the truth — see the envelope rules
in `workflows/issue-fixed.mjs`). Bash timeout 600000; the transport holds 540s inside it.
Verify the configured model before pinning one in a prompt: subscription auth can reject
specific tiers (`--model gpt-5.6-sol` bounced under ChatGPT auth, 2026-08) — the envelope
error names it; fall back to the transport's pinned default rather than losing the seat.

## 6. Rules of engagement

- **Journal = composition + events + final.** Three kinds of issue comments:
  1. *Launch*: the composed fabric — which seats, which modes, why — before work starts.
     The human audits the composition, not just the outcome.
  2. *Events*, appended as they happen: tripwire fired, fabric widened/narrowed, fork
     guessed (question unanswered), seat re-run on a stronger model, breaker tripped.
  3. *Final*: outcomes + coverage. Quiet runs have exactly two comments; eventful runs
     show their history. The journal is also the recovery trail — there is no runId to
     resume, so the run must be reconstructible from the issue alone.
- **Coverage is a deliverable**: the final journal states what actually looked at the diff
  (seats composed vs delivered, by name). A thinned fabric that reads as a clean pass is
  the failure mode this whole system exists to prevent.
- **Escalate early on ambiguity**: a blocking question issue + code + docs cannot settle is
  `needs-info` at the moment you find it, not after an implementation guess. (Fork
  questions are for choices you COULD make but the human should; needs-info is for
  blockers you can't.)
- **Budget sense, not budget fear**: opus xhigh on a rename is waste; sonnet on an
  invariant is a different kind of waste. When unsure between two seats, take the smarter
  one on anything that ships and the cheaper one on anything that gets re-verified anyway.

## Known gaps

- **No cross-session resume** — there is no runId to pick back up. Mitigation is the
  event journal above: a fresh session reads the issue comments + worktree diff and
  reconstructs the run state.
- **Calibration ledger (planned, location decided)**: per-seat finding precision — what
  fraction of each seat's findings survive adjudication — tracked across runs, in the
  flow-adjacent memory space (cross-repo: sol's precision is a property of sol, not of the
  repo), updated by a post-run post-mortem seat, read at composition time. Not yet built;
  compose from the charter table until it exists.
