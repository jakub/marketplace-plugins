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

1. **Claim** (atomic): assign + `in-progress` label via check-and-set; concurrent runs
   cannot grab the same issue. Snapshot the acceptance criteria — if the body moves
   mid-run, escalate rather than guess.
2. **Launch**: worktree off origin/main; context pack (paths, not contents); workflow
   started; **runId stamped as an issue comment** for recovery.
3. **Design fan-out**: minimal (sonnet) ∥ clean (opus high) ∥ outside (gpt-5.6-sol high,
   read-only). Cross-model disagreement is signal, kept even on small work.
4. **Synthesis** (fable high; opus on trivial): one plan, per-plan difficulty
   (`mechanical | standard | hard`) that routes implementation. Blocking ambiguity →
   `needs-info`.
5. **Implement** (TDD): opus high primary; `mechanical` plans may drop to sonnet;
   `hard` runs xhigh. Difficulty is judged at synthesis, never counted from file totals.
6. **Build gate** (sonnet low): fmt, clippy, tests. Retry-wrapped; UNKNOWN ≠ pass.
7. **Internal review fabric** (parallel): codex adversarial (gpt-5.6-sol) · correctness (opus) ·
   security (opus — kept off fable, no classifier roulette) · simplify (sonnet) ·
   **AC evidence check** (opus): per-criterion verdict + evidence pointer against the
   launch snapshot. Dedupe in pure JS; blocking = critical/high/medium + unmet criteria.
8. **Fix loop** (≤3 rounds, opus): parallel across disjoint files, serial otherwise.
   Mediums are fixed, not deferred. Re-gate + re-review each round; codex re-verifies
   after the loop so cross-model signal survives to the end. Unresolved blockers get a
   **fable adjudication** (real blocker vs reviewer theater) before anything escalates.
9. **Doc-sync** (sonnet): diff-aware context.md/AGENTS.md updates travel with the change.
10. **Push PR** mid-run: summary + changelog description. Externals see code that already
    survived the internal loop.
11. **Post-push, parallel tracks**: complementary self-review (test quality, silent
    failures, comment rot, type design — the lenses the fabric doesn't cover) ∥ external
    reviewers (coderabbit et al.): poll for review-posted, ~10–15 min cap; silent externals
    never stall the run; stale-SHA findings revalidated against HEAD.
12. **Synthesis fix round** (fable → opus): fold internal + external findings into one
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

| | role | effort | skip when |
|---|---|---|---|
| fable 5 | every judgment seat: conduct, grill, synthesise, adjudicate, triage external findings | `high` | security-flavored payloads → route to opus; auto-fallback opus on refusal/null |
| opus 4.8 | workhorse: implementation, correctness/security review, fixes, PR lenses | `high`, `xhigh` for hard plans | pure judgment calls (fable's seat) |
| sonnet 5 | mechanical: gates, wrappers, scouts, doc-sync, minimal design leg, ledgers | `low` for wrappers | any embedded design judgment |
| gpt-5.6-sol | external decorrelation: outside design opinion, adversarial review, general delegation | `high` — codex config default (`~/.codex/config.toml`, as of 2026-07); pin `--model`/`--effort` per call to override | taste-critical surfaces; codex-reviewing-codex |
| haiku | — retired | | always |

Delegation charter (also in the injected charter): many small-context agents over marathon
threads; typed returns or disk journals; freedom scales with reversibility.

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
