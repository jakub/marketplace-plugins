# flow — the full doctrine

This file is the prose source of truth; the charter is its always-loaded distillation.

## 1. The pipeline

Three commands, two human touchpoints. Everything between the touchpoints runs hands-off.

### /flow:prep — the single front door (interactive)

Takes an issue number OR free text (a spike, a hunch, a mid-development deviation).
Nothing enters the tracker except through here.

1. **Entry**: free-text mode dedupes against open AND closed issues before anything else.
2. **Scout**: domain docs (context.md slices, ADRs), code seams, prior art — delegated to
   scoped agents; the conductor keeps paths and conclusions, never file dumps.
3. **Triviality gate**: fully specified and small → *do it now* (no ticket theater).
   Too big → split into tracer-bullet slices. Otherwise → grill.
4. **Grill**: one question at a time, each with a recommended answer, stress-tested against
   glossary and code. Decisions crystallise into context.md edits and ADRs, committed to main.
5. **Acceptance criteria, testable by construction**: every criterion names its own
   evidence — the test, command, or screenshot that will prove it. Criteria that cannot be
   validated are rejected here, not discovered mid-run.
6. **Finalise**: issue body = hardened spec (edited in place); design synthesis posted as a
   journal comment; `ready-for-agent` applied only if the label contract validates.

### /flow:issue — one run, through the PR (hands-off)

0. **Size**: coarse triage that buys the fabric. `trivial` is a claim that no production
   code path can regress — not a line count — because it is the one bucket that thins review.
1. **Claim** (atomic): assign + `in-progress` label via check-and-set; concurrent runs
   cannot grab the same issue. Snapshot the acceptance criteria — if the body moves
   mid-run, escalate rather than guess.
2. **Launch**: worktree off origin/main; context pack (paths, not contents); workflow
   started; **runId stamped as an issue comment** for recovery.
3. **Design fan-out**: minimal (opus medium — the modal winner) ∥ clean (fable high — the taste seat) ∥ outside
   (gpt-5.6-sol high, read-only). Cross-model disagreement is signal, kept even on small work.
4. **Synthesis** (fable high; opus on trivial): one plan, per-plan difficulty
   (`mechanical | standard | hard`) that routes implementation. Blocking ambiguity →
   `needs-info`.
5. **Implement** (TDD): difficulty routes BOTH model and effort — `mechanical` sonnet/medium,
   `standard` opus/medium, `hard` opus/xhigh. Lower effort reads the plan more literally and
   scopes to what was asked; higher effort buys depth for subtle invariants. Difficulty is
   judged at synthesis, never counted from file totals. The seat is prompted against scope
   expansion, premature completion, and sub-delegation — a leaf of a fan-out does its own work.
6. **Build gate** (sonnet low): fmt, clippy, tests. Retry-wrapped; UNKNOWN ≠ pass.
7. **Internal review fabric** (parallel): codex adversarial (gpt-5.6-sol) · correctness
   (opus xhigh) · security (opus xhigh) · simplify (opus medium — its mediums block) · **AC evidence check**
   (opus xhigh): per-criterion verdict + evidence pointer against the launch snapshot.
   Dedupe in pure JS; blocking = critical/high/medium + unmet criteria. A null security seat
   (opus carries its own cyber classifiers) retries on fable, then surfaces
   `securityReviewUnavailable` to the human — never a silently thinner fabric. The codex leg
   is in every size bucket: it is the cheapest seat in the fabric and the only cross-model
   signal, so no bucket ships without one. What actually looked at the diff rides out in
   `coverage` (configured vs delivered) for the journal.
8. **Fix loop** (≤3 rounds, opus; xhigh for critical/high findings, medium below — the
   per-round re-gate and re-review are the real verification): parallel across disjoint files, serial otherwise.
   Mediums are fixed, not deferred. Re-gate + re-review each round; codex re-verifies
   after the loop so cross-model signal survives to the end. Unresolved blockers get an
   **opus max adjudication** (real blocker vs reviewer theater) before anything escalates.
9. **Doc-sync** (opus high): diff-aware context.md/AGENTS.md updates travel with the change,
   edited in place — docs correct what the diff made false, they do not grow per PR.
10. **Push PR** mid-run: summary + changelog description. Externals see code that already
    survived the internal loop.
11. **Post-push, parallel tracks**: complementary self-review (test quality, silent
    failures, comment rot, type design — the lenses the fabric doesn't cover) ∥ external
    reviewers (coderabbit et al.): poll for review-posted, ~10–15 min cap; silent externals
    never stall the run; stale-SHA findings revalidated against HEAD.
12. **Synthesis fix round** (fable → opus; taste seat — signal vs noise): fold internal + external findings into one
    verdict set (fix / noise / already-fixed); apply; push; reply to external threads.
13. **Evidence ledger**: final PR comment — criterion → verdict → evidence link (test name
    + output, command transcript, headless-playwright screenshot where UI is involved).
    Evidence files live on a dedicated ref, never on main.
14. **Stop**: an open, reviewed, evidenced PR. Never auto-merge. Final journal comment on
    the issue. Escalation valves (`needs-info`, `needs-human`, `needs-rebase`) each fire a
    push notification — blocked hands-off runs interrupt the human; nothing else does.

### /flow:land — the human gate

1. **Gates**: stacked-chain guard · per-check CI rollup (never `--watch` exit codes; known
   flakes only from `.github/known-flakes.txt`) · **unresolved external threads block**.
2. **Escape-hatch ack**: a drafted follow-up (cross-crate-refactor scale only) becomes a
   real issue only on human ack (`FLOW_SANCTION=land`).
3. **Merge + close + clean**: squash-merge, delete branch, close linked issues by hand if
   the ref didn't, retire worktree, drop the isolated test DB, stamp memory.
4. **Survey**: open PRs, label buckets, stale state → a ranked menu. The human picks.

## 2. Model policy

Axes over file counts: **intelligence > taste > cost** on anything that ships. Defaults,
not limits — judge the output, not the price tag; escalate without asking when a cheaper
model's output misses the bar.

Seats split by what the work **is**, not by how important it feels. **Taste** — reconciling
rival designs, judging the best long-term shape, separating reviewer signal from noise, copy
and UI — is fable's edge. **Reasoning and coding** — is this finding real, implement this
plan, fix this bug — is opus's, and opus has the `xhigh`/`max` rungs fable does not.

| | role | effort | skip when |
|---|---|---|---|
| fable 5 | taste seats: conduct, grill, synthesise, clean-design leg, triage external findings | `high` (its ceiling — no xhigh/max) | security-flavored payloads → route to opus; auto-fallback opus on refusal/null |
| opus 5 | workhorse: implementation, both design-adjacent review seats, fixes, adjudication, PR lenses | routed, not pinned: `medium` is the default working rung (it reads instructions more literally and scopes tighter), `xhigh` where a miss ships — hard plans, critical/high fixes, correctness/security/AC — `max` for adjudication alone | pure taste calls (fable's seat) |
| sonnet 5 | mechanical: gates, wrappers, transports, scouts, ledgers, salvage reads | `low` for wrappers, `medium` for anything with a verdict in it; `xhigh` exists on this tier now — try it before escalating a tier on hard mechanical work | any embedded design judgment |
| gpt-5.6-sol | external decorrelation: outside design opinion, adversarial review, general delegation. reach it ONLY via the **codex-delegate** agent or the codex-exec transport (`plugins/flow/scripts/codex-exec.mjs`) — the companion plugin, `/codex:*` commands, and codex-rescue agent no longer exist | efforts `minimal…max`, server-gated per model; `xhigh` — codex config default (`~/.codex/config.toml`, as of 2026-08); pin `--model`/`--effort` per call. `--fast` = priority service tier — fails OPEN upstream (unsupported tier silently dropped), so trust the envelope's `fast.applied`, never the request | taste-critical surfaces; codex-reviewing-codex |
| gpt-5.6-terra / -luna | mid / nano tiers for bulk, latency-sensitive, or high-volume delegation through the same transport; luna+`max`+`--fast` is the cheap-depth combo for mechanical sweeps | same surface as sol | the adversarial-review seat — decorrelation needs intelligence, not throughput |
| haiku | — retired | | always |

**Refusals are a routing constraint, not an edge case.** Both fable and opus 5 run cyber
classifiers; a declined request returns null, indistinguishable from a dead agent. Every
seat that can be refused needs a fallback on a different family *and* a visible marker when
both come back empty. A review seat that silently vanishes reads as a clean pass.

Delegation charter (also in the injected charter): agents for genuinely independent,
sizeable tracks — not for work finishable in a handful of tool calls, and never to verify
your own work. Typed returns or disk journals; freedom scales with reversibility; spawn
counts stay low.

## 3. The issue is the record

- **Body = living spec**, edited in place: premise + why, agreed approach, ADR links,
  acceptance criteria. GitHub keeps edit history.
- **Comments = append-only journal**, one per stage: scout findings, grill decisions,
  synthesis/plan, runId stamp, implementation deviations, review + fix summary, final
  outcome. A human reviews the *run* by reading the journal.
- **PR = evidence**: findings tables, fix-loop log, the AC ledger, external-thread replies.
- **ADRs on main** for permanent decisions only; everything else lives and dies with the issue.

## 4. The documentation stack

Four layers, each answering one question. Deliberately NOT used: `context-map.md`-style
index files (AGENTS.md discloses further reading directly) and `CLAUDE.local.md`
(gitignored files never materialise in worktrees — the cold implementer would fly blind;
domain guidance is committed, always).

| layer | file | question |
|---|---|---|
| operator | `~/.claude/CLAUDE.md` + this plugin's charter | who the user is / how we build |
| workspace | `~/code/CLAUDE.md` | what exists (project registry) |
| repo | `AGENTS.md` ⟵ `CLAUDE.md` symlink | how to operate here (lean; discloses context.md, docs/adr/) |
| domain | `crates/<x>/AGENTS.md` + symlink, `context.md` slices | crate-local depth |

One source, both models: codex merges AGENTS.md hierarchically; Claude loads CLAUDE.md —
the symlink keeps them identical by construction. Root context.md keeps cross-cutting
ontology; crate-local vocabulary moves into slices next to the code it describes.

## 5. Ambient machinery

- **no-backlog guard** (hook, ships here): blocks unsanctioned `gh issue create`.
- **git guard** (hook, ships here): blocks `--no-verify` and commit trailers
  (`FLOW_SANCTION=git` for foreign commits that already carry one). Both guards are
  `PreToolUse`, which is why they hold where the charter does not: hooks fire on subagent
  tool calls, but the SessionStart charter injection reaches the main session only. A fresh
  subagent inherits the harness default to append `Co-Authored-By`/`Claude-Session` and never
  sees the line overriding it — so that rule is enforced structurally, not by prose.
- **escalation pings**: valves push to the phone (PushNotification from the conductor).
- **nightly lint** (cron, sonnet): label contract, stale worktrees, orphaned branches, doc staleness.
- **weekly doc sweep** (cron, sonnet): workspace-wide context.md/AGENTS.md drift vs reality.
- **scheduled bug hunts** (cron, opus + gpt-5.6-sol): findings adversarially verified, deduped
  against open+closed, capped per sweep, filed `agent-found` (`FLOW_SANCTION=hunter`) —
  quarantine; nothing self-promotes past /flow:prep.
- **recovery**: `resumeFromRunId` same-session; cross-session, a recovery-preamble agent
  reads the journal + worktree diff and skips completed stages.

## 6. Endgame

Once `ready-for-agent` has proven watertight through the label lint and a body of clean
runs: a cron picks up validated issues and fires /flow:issue unattended. The contract is
the safety case; do not ship the cron before the contract has earned it.
