---
name: issue-beta
description: BETA alternate to /flow:issue — a fully dynamic, fable-conducted run. Same contract in (ready-for-agent issue), same contract out (pushed, reviewed, evidenced PR), but the orchestration is composed per-issue by the conductor instead of a fixed pipeline. Use when explicitly invoked as issue-beta; the stable path remains /flow:issue.
---

# issue-beta — the dynamic run

**Status: experimental.** The stable path is `/flow:issue` (fixed workflow, `workflows/issue.mjs`).
This skill is the alternate: no static FABRIC table, no hardcoded stage list. YOU — the
session model, fable, **in the main session, inline** — are the conductor, and you compose
the run to fit the issue, flexing seats, models, and rounds as the work reveals itself.
v1 encodes distrust of the orchestrator in 993 lines of script; beta encodes trust plus a
short list of things you are not allowed to trade away.

The bet: a capability table plus rules of engagement, held by a model with taste 9 /
intelligence 9, beats a lookup table. Judge the output, not the price tag.

Conducting inline means the session is occupied for the run and its context is precious:
delegation discipline is survival, not style — file scans, command output, and diffs live
in subagents; only conclusions come home.

## The contract (unchanged from v1)

In: an open issue labelled `ready-for-agent`, claimed atomically (assign + `in-progress`,
verify the claim landed, snapshot `## Acceptance Criteria` at launch). Out: an open PR —
pushed, reviewed, evidenced, `Closes #N`-linked — or a clean escalation
(`needs-info` / `needs-human` / `needs-rebase`, each with a push notification). Never merge.

**Hands-off, with rare fork questions.** Default fully autonomous. AskUserQuestion is
allowed mid-run ONLY when a fork is genuinely the human's to pick — rival designs both
defensible on the merits, a contested finding whose dismissal changes the risk posture, a
scope smell the issue cannot settle. Same bar as `needs-info`, cheaper than escalating. If
no answer comes, decide, journal the guess as an event, and keep moving.

## Invariants — not negotiable, however you orchestrate

1. **Decorrelation**: every diff that ships is reviewed by at least one seat from a
   different model family than the one that wrote it. Claude-reviewing-claude and
   codex-reviewing-codex are both correlation failures.
2. **Adversarial floor**: at least one review seat is prompted to REFUTE — to break the
   change — not to summarise it. Confirmation-shaped review is not review.
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
5. **Evidence per criterion**: every acceptance criterion gets a verdict + concrete
   pointer (test name + result, command + output, file:line, screenshot) in a PR ledger.
   Judged against the launch snapshot; a body that moved mid-run is flagged, not chased.
6. **Termination on evidence, not counters** — risk-tiered convergence:
   - standard work: ONE clean cross-family adversarial pass (different family than the
     fixer, fresh eyes, nothing blocking) → converged.
   - trust-boundary contact or a churny run: TWO consecutive clean passes from different
     seats.
   - circuit breaker: past ~5 fix rounds, stop fixing — adjudicate the survivors at
     maximum reasoning effort, escalate the real ones. The breaker interrupts a human;
     it never ships silently.
7. **Containment**: all writes in the worktree; leaf agents do not sub-delegate; two
   agents never edit one file concurrently; no `--no-verify`, no trailers (hooks enforce).
8. **Refusal routing**: any seat can come back null (classifier roulette on both fable and
   opus). Every judgment/security seat needs a cross-family fallback, and a double-null is
   reported, never swallowed.

## Freedoms — yours to flex, per issue and mid-run

- **Fabric width**: how many design legs (one to a panel), which review lenses, whether a
  stage exists at all. A one-line doc fix does not need a design fan-out; an auth-touching
  "trivial" needs the full security panel regardless of its size label.
- **Continuous re-sizing — tripwires + taste**: size is not a launch-time verdict. These
  tripwires FORCE a fabric re-think, and each firing is journaled as an event:
  - the diff touches a trust boundary the issue never mentioned (auth, input parsing,
    shell/SQL/template construction, secret handling);
  - the diff exceeds ~2× the plan's expected file count;
  - fix rounds churn on the same area (a fix spawning findings where it landed);
  - cross-family reviewers disagree hard on the same code.
  Beyond the tripwires: standing permission to widen on any hunch. Narrowing is also
  legal (a "medium" that turned out mechanical) — journal that too.
- **Seat assignment**: route by the charter's capability table (taste → fable, top-effort
  reasoning → opus, mechanical → sonnet, decorrelation + bulk → codex tiers), but re-run
  any output that misses the bar on a stronger seat without asking. Escalation is cheaper
  than shipping mediocre work.
- **Orchestration medium — your call per fan-out**: drive Agent calls directly when a
  stage is adaptive or small; author a short ad-hoc Workflow script when a fan-out is
  deterministic and worth resume + progress UI (a 4-lens review fabric, parallel disjoint
  fixes). v1's `issue.mjs` is a parts library (salvage pattern, envelope rules, schemas,
  push-verify prompts) — steal from it, don't re-derive it.
- **Mode selection**: parallel-blind (v1's shape), collaborative (propose → critique →
  revise across families), or adversarial (red team vs blue team) — pick per stage.
  Cross-model disagreement is signal: resolve it explicitly, never average it.

## The codex seats — flat-rate, use them like it

gpt-5.6-sol (intelligence 8) costs effectively nothing on the subscription. That changes
the economics of every pattern below from "can we afford it" to "does it help":

- **Standing consult**: when torn at any judgment point (synthesis, triage, adjudication),
  ask sol for a decorrelated second opinion before deciding. Two-key dismissal: a
  medium+ finding is dismissed as noise only when both families agree it is.
- **Design dialectic — blind, then argue**: both families design INDEPENDENTLY first
  (decorrelation preserved), then each critiques the other's design, then you synthesize
  proposals + critiques + rebuttals. Two codex round-trips; the argument, not three
  monologues, is what you synthesize. Plain parallel-blind remains legal for small work.
- **Shadow reviewer — milestone checkpoints**: sol reads commits as they land during
  implementation, accumulating findings silently. At each milestone boundary the conductor
  triages the accumulated set and hands blocking items to the implementer before the next
  milestone starts — early signal, zero mid-thought interruption. The shadow complements
  the final adversarial pass; it never replaces it (convergence still needs fresh eyes on
  the finished diff).
- **Red team**: sol tries to break claude's implementation and vice versa; route
  demonstrable claims through the fast lane (invariant 2) — "prove it or drop it" beats
  prose severity debates.
- **Bulk tiers**: terra/luna for mechanical sweeps (comment rot, evidence collection,
  transcript reads) — luna + max + `--fast` is the cheap-depth combo. Never the
  decorrelation seat itself; that needs intelligence.

Transport: `plugins/flow/scripts/codex-exec.mjs` (`task` / `adversarial-review`
subcommands, JSON envelope, `.ok`/`.fast.applied` are the truth — see the envelope rules
in `workflows/issue.mjs`). Bash timeout 600000; the transport holds 540s inside it.

## Rules of engagement

- **Journal = composition + events + final.** Three kinds of issue comments:
  1. *Launch*: the composed fabric — which seats, which modes, why — before work starts.
     The human audits the composition, not just the outcome.
  2. *Events*, appended as they happen: tripwire fired, fabric widened/narrowed, fork
     guessed (question unanswered), seat re-run on a stronger model, breaker tripped.
  3. *Final*: outcomes + coverage. Quiet runs have exactly two comments; eventful runs
     show their history. The journal is also the recovery trail — beta has no runId
     resume, so it must be reconstructible from the issue alone.
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

## Known gaps (beta)

- No cross-session resume — v1's runId + workflow journal is stronger here. Mitigation is
  the event journal above: a fresh session reads the issue comments + worktree diff and
  reconstructs the run state.
- **Calibration ledger (planned, location decided)**: per-seat finding precision — what
  fraction of each seat's findings survive adjudication — tracked across runs, in the
  flow-adjacent memory space (cross-repo: sol's precision is a property of sol, not of the
  repo), updated by a post-run post-mortem seat, read at composition time. Not yet built;
  compose from the charter table until it exists.
