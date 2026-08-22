---
name: flow
description: The flow development framework — doctrine, doc-stack setup, and drift audits for the prep → issue → land pipeline. Use when setting up a new project's documentation stack, auditing an existing project for drift against the framework, validating ready-for-agent issues, or answering "how do we work" questions the charter doesn't settle.
---

# flow — the development framework

This framework is the doctrine for how the user and Claude build software
together. The **charter** (injected every session by this plugin's SessionStart hook)
carries the always-on rules; this skill carries the full framework, the setup procedure,
and the drift audit. Commands (`/flow:prep`, `/flow:issue`, `/flow:land`) execute the
pipeline; they point here for shared doctrine rather than restating it.

Base directory for this skill contains:

| File | Contents |
|---|---|
| `label-contract.md` | Label state machine + the `ready-for-agent` contract and its lint. |
| `drift-audit.md` | The audit procedure for `drift`. |
| `templates/` | Seed files for `setup`: workspace CLAUDE.md, repo AGENTS.md, crate AGENTS.md. |

Doctrine lives in two places: The **charter** (hook-injected every session)
carries the always-on rules and the model policy. The **command bodies** (`prep.md`,
`issue.md`, `land.md`) carry the steps each command executes. This file carries what neither
needs at runtime: the setup procedure, the doc stack, the ambient machinery, and a reference
description of what the deprecated fixed workflow (v1, `/flow:issue-fixed`) does inside
the black box.

## Subcommands

If the user request is a bare subcommand string (e.g. `/flow drift`), follow the matching
action directly:

| Subcommand | Action |
|---|---|
| `setup` | Deploy the doc stack to a project. Read **The documentation stack** + all of `templates/`, then follow **Setup** below. |
| `drift` | Audit the current project (or the workspace, if run from `~/code`) against the framework. Read `drift-audit.md` and execute it. |
| `labels` | Reconcile the repo's GitHub labels with `label-contract.md` § taxonomy, and lint every `ready-for-agent` issue against the contract. |
| `charter` | Print the currently-installed charter (`../../charter/charter.md`) so the human can review what every session is being told. |

## Setup

Deploying flow to a project, in order. Each step is idempotent — skip what exists and
conforms, report what was created or already conformed.

1. **Preconditions**: git repo (stop if not), `gh` authenticated, origin remote resolvable.
2. **Workspace layer** (once per machine): `~/code/CLAUDE.md` from
   `templates/workspace-claude.md` — the project registry. Add/refresh this repo's
   one-liner.
3. **Repo layer**: `AGENTS.md` from `templates/repo-agents.md`, then `ln -s AGENTS.md CLAUDE.md`.
   Ask for the **evidence posture** — `public-by-intent` for open-source or soon-to-be-open
   repos, `private` otherwise — and record it in `## Operating notes`. It is the one line a
   run cannot infer, and prep reads it to decide whether PR captures may publish publicly.
   Never guess it: absent posture means private.
   Keep it lean (≤ ~40 lines); it discloses further reading (context.md, docs/adr/) rather
   than containing it. Its `## Contexts` section is the context map — that is why no
   `context-map.md` exists. If the repo has a legacy one, fold its pointers into that
   section and delete it.
4. **Domain layer** (judgment call — propose, don't blanket): for each crate/module with
   real domain depth, `crates/<x>/AGENTS.md` from `templates/crate-agents.md` + the
   `CLAUDE.md` symlink, and a `context.md` slice if the vocabulary is crate-local. Every
   slice gets a line in the root AGENTS.md `## Contexts` section.
   Committed, always — gitignored guidance never materialises in worktrees.
5. **Decision records**: ensure `docs/adr/` exists with a `0000-template.md`.
6. **Labels**: run the `labels` subcommand.
7. **Known flakes**: create `.github/known-flakes.txt` (empty) — `/flow:land` reads it;
   one CI check name per line that the repo consciously merges through. Lore lives in the
   repo, not in command prompts.
8. **Report**: what was created, what conformed, what needs a human decision (e.g. which
   crates deserve domain files) — as a checklist, not an essay.

## Drift

`drift` re-runs the framework's invariants against reality — see `drift-audit.md` for the
full procedure. Run it: on a schedule (the ambient nightly/weekly crons), after large
merges, or when documentation feels stale. It reports; it does not auto-fix without being
asked. Delegate the scanning to scoped agents and return the reconciled report — the audit
is designed to be run by cheap models with a judgment pass on top.

## The documentation stack

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

## Ambient machinery

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
  reads the journal + worktree diff and skips completed stages (procedure: `issue-fixed.md`
  § Recovery; the dynamic `/flow:issue` reconstructs from its event journal + worktree instead).

## Inside the v1 run — what `workflows/issue-fixed.mjs` does

`/flow:issue-fixed` (deprecated) launches a workflow and handles its result; the
stages below are the black box it launches. This is reference, not instruction — the script
is the source of truth. The dynamic run (`/flow:issue`) composes its own fabric per issue
instead of running these.

0. **Size**: coarse triage that buys the fabric. `trivial` is a claim that no production
   code path can regress — not a line count — because it is the one bucket that thins review.
1. **Claim** (atomic): assign + `in-progress` via check-and-set; concurrent runs cannot grab
   the same issue. Snapshot the acceptance criteria — if the body moves mid-run, escalate.
2. **Launch**: worktree off origin/main; context pack (paths, not contents); runId stamped.
3. **Design fan-out**: minimal (opus medium — the modal winner) ∥ clean (fable high — the
   taste seat) ∥ outside (gpt-5.6-sol high, read-only). Cross-model disagreement is signal,
   kept even on small work.
4. **Synthesis** (fable high; opus on trivial): one plan, per-plan difficulty
   (`mechanical | standard | hard`) that routes implementation. Blocking ambiguity →
   `needs-info`.
5. **Implement** (TDD): difficulty routes BOTH model and effort — `mechanical` sonnet/medium,
   `standard` opus/medium, `hard` opus/xhigh. Difficulty is judged at synthesis, never counted
   from file totals. The seat is prompted against scope expansion, premature completion, and
   sub-delegation — a leaf of a fan-out does its own work.
6. **Build gate** (sonnet low): fmt, clippy, tests. Retry-wrapped; UNKNOWN ≠ pass.
7. **Internal review fabric** (parallel): codex adversarial (gpt-5.6-sol) · correctness
   (opus xhigh) · security (opus xhigh) · simplify (opus medium) · AC evidence check
   (opus xhigh): per-criterion verdict + evidence pointer against the launch snapshot.
   Dedupe in pure JS; blocking = critical/high/medium + unmet criteria. A null security seat
   retries on fable, then surfaces `securityReviewUnavailable` — never a silently thinner
   fabric. The codex leg is in every size bucket: cheapest seat in the fabric and the only
   cross-model signal. What actually looked at the diff rides out in `coverage`.
8. **Fix loop** (≤3 rounds, opus; xhigh for critical/high, medium below): parallel across
   disjoint files, serial otherwise; each fixer stages only its own files by explicit path —
   staging is repo-global even when the edits are disjoint. Mediums are fixed, not deferred. Re-gate + re-review each
   round; codex re-verifies after the loop. Unresolved blockers get an **opus max
   adjudication** (real blocker vs reviewer theater) before anything escalates.
9. **Doc-sync** (opus high): diff-aware context.md/AGENTS.md updates travel with the change,
   edited in place — docs correct what the diff made false, they do not grow per PR.
10. **Push PR** mid-run: summary + changelog description. Externals see code that already
    survived the internal loop.
11. **Post-push, parallel tracks**: complementary review on the codex transport (test quality,
    silent failures, type design at sol `high`; comment rot on luna `max`) ∥ external
    reviewers (coderabbit et al.): poll for review-posted, ~10–15 min cap; silent externals
    never stall the run; stale-SHA findings revalidated against HEAD.
12. **Synthesis fix round** (fable → opus; taste seat): fold internal + external findings into
    one verdict set (fix / noise / already-fixed); apply; push; reply to external threads.
13. **Evidence ledger** (sonnet medium): final PR comment — criterion → verdict → evidence,
    every cell openable from the GitHub page without cloning. Four surfaces, strongest first:
    `ci` a job/step deep-link (`#step:<n>:<line>`) — strongest because GitHub produced the
    bytes, not the agent; `code` a permalink pinned to the PR head SHA; `commit` a capture on
    `flow-evidence` under `pr-<N>/` (never main), embedded via a SHA-pinned raw url so it
    renders for anyone who can see the PR; `artifact` on plans for what git cannot serve — an
    HTML page, video, oversized image set — always `--keep`, never `--ttl`, because a TTL'd
    URL is not evidence. Visibility is a LOOKUP, not a judgment: the conductor resolves the
    `evidence-public` label into `evidencePublic` at launch, and public publishing needs that
    ack AND a per-criterion `visibility: public`; otherwise the prompt never mentions
    `--public` at all. A private artifact is tailnet-only — link it, never embed it, and say
    so. Missing screenshot preconditions are a stated gap, never a silent one. Captures
    illustrate; the committed test or command pointer still does the proving.
14. **Stop**: an open, reviewed, evidenced PR. Never auto-merge. Final journal comment.

## Endgame

Once `ready-for-agent` has proven watertight through the label lint and a body of clean
runs: a cron picks up validated issues and fires /flow:issue unattended. The contract is
the safety case; do not ship the cron before the contract has earned it.

## Doctrine quick-reference

- **Pipeline**: `/flow:prep` (front door, interactive) → `/flow:issue` (hands-off through
  a pushed, reviewed, evidenced PR) → `/flow:land` (the only merge path, human-gated).
- **The issue is the spec AND the record**: body = living spec, edited in place; comments =
  append-only stage journal; PR = evidence. ADRs for permanent decisions only.
- **No-backlog**: PRs ship complete. The only follow-up path is the escape hatch
  (cross-crate-refactor scale), drafted on the PR, filed on human ack at land.
- **Evidence**: every acceptance criterion names its evidence at prep and gets a
  per-criterion verdict + link in the PR ledger.
- **Verification**: UNKNOWN ≠ clean. Errored/rate-limited/timed-out checks never pass.
- **Models**: fable tastes, opus 5 reasons and codes, sonnet transcribes, gpt-5.6-sol
  decorrelates, haiku is retired. Axes (intelligence > taste > cost), never file counts.
  A refused seat returns null — fall back across families, then surface the gap.
