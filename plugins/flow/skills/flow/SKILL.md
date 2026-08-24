---
name: flow
description: The flow development framework - project setup, the documentation stack, drift audits, and the label contract for the prep → issue → land pipeline. Use when setting up a new project's docs, auditing a project for drift, validating ready-for-agent issues, or answering a "how do we work" question the charter doesn't settle.
---

# flow - the development framework

The charter is in your context already; it says how we build and delegate. The command bodies (`prep.md`, `issue.md`, `land.md`) say what each command does. This skill holds what neither needs every session: how to set a project up, what the doc stack looks like, the machinery running in the background, and a reference description of the deprecated fixed pipeline. Don't restate the charter here - if something is true in every session, it belongs there.

Files in this directory:

| File | Contents |
|---|---|
| `label-contract.md` | Label state machine, the `ready-for-agent` contract, and its lint. |
| `drift-audit.md` | The procedure `drift` runs. |
| `templates/` | Seed files for `setup`: workspace CLAUDE.md, repo AGENTS.md, crate AGENTS.md, and the systemd units under `templates/systemd/`. |
| `cron/` | Standing instructions for the scheduled jobs (`lint.md`, `doc-sweep.md`); `scripts/flow-cron.mjs` runs them. |

## Subcommands

A bare subcommand (e.g. `/flow drift`) runs the matching action:

| Subcommand | Action |
|---|---|
| `setup` | Deploy the doc stack to a project. Read **The documentation stack** and `templates/`, then follow **Setup**. |
| `drift` | Audit the current project (or the whole workspace, from `~/code`) against the framework. Read and execute `drift-audit.md`. |
| `labels` | Reconcile the repo's GitHub labels with `label-contract.md` and lint every `ready-for-agent` issue against the contract. |
| `charter` | Print the installed charter (`${CLAUDE_PLUGIN_ROOT}/charter/charter.md`) so the user can review what every session is told. |
| `cron` | The scheduled jobs. Bare `cron` runs `scripts/install-cron.sh status`; `cron install`, `cron run <lint\|doc-sweep>`, and `cron uninstall` pass through. Show the output; don't paraphrase it. |

## Setup

Deploy flow to a project, in this order. Every step is idempotent: skip what already exists and conforms, report what you created.

1. **Preconditions**: a git repo (stop if not), `gh` authenticated, origin remote resolvable.
2. **Workspace layer**, once per machine: `~/code/CLAUDE.md` from `templates/workspace-claude.md` - the project registry. Add or refresh this repo's one-liner.
2b. **Machine layer**, once per machine: `bash ${CLAUDE_PLUGIN_ROOT}/scripts/install-cron.sh status`; if the launcher is missing, run `install`. This arms the nightly lint and the weekly doc sweep (see **Ambient machinery**). Skip on a machine without systemd user sessions and say so.
3. **Repo layer**: `AGENTS.md` from `templates/repo-agents.md`, then `ln -s AGENTS.md CLAUDE.md`. Keep the file lean (≤ ~40 lines); it points at further reading (context.md, docs/adr/) rather than containing it. Its `## Contexts` section is the context map, which is why no `context-map.md` exists - fold a legacy one into that section and delete it.
4. **Domain layer**, a judgment call - propose, don't blanket: for each crate or module with real domain depth, `crates/<x>/AGENTS.md` from `templates/crate-agents.md` plus the `CLAUDE.md` symlink, and a `context.md` slice if the vocabulary is crate-local. Every slice gets a line in the root `## Contexts`. Always committed - gitignored guidance never materializes in worktrees.
5. **Decision records**: `docs/adr/` with a `0000-template.md`.
6. **Labels**: run the `labels` subcommand.
7. **Known flakes**: create `.github/known-flakes.txt` (empty). `/flow:land` reads it - one CI check name per line that the repo consciously merges through. Lore lives in the repo, not in command prompts.
8. **Report**: what was created, what already conformed, what needs a human decision (e.g. which crates deserve domain files). A checklist, not an essay.

## Drift

`drift` re-checks the framework's invariants against reality; `drift-audit.md` is the procedure. Run it on a schedule (the nightly/weekly crons), after large merges, or when the docs feel stale. It reports and doesn't fix unless asked. Delegate the scanning to scoped cheap agents and return a reconciled report with a judgment pass on top.

## The documentation stack

Four layers, each answering one question:

| layer | file | question |
|---|---|---|
| operator | `~/.claude/CLAUDE.md` + the charter | who the user is / how we build |
| workspace | `~/code/CLAUDE.md` | what exists (project registry) |
| repo | `AGENTS.md` ⟵ `CLAUDE.md` symlink | how to operate here (lean; points at context.md, docs/adr/) |
| domain | `crates/<x>/AGENTS.md` + symlink, `context.md` slices | crate-local depth |

One source, both model families: codex merges AGENTS.md hierarchically, Claude loads CLAUDE.md, and the symlink keeps them identical by construction. Root `context.md` holds cross-cutting ontology; crate-local vocabulary lives in slices next to the code.

Deliberately not used: `context-map.md`-style index files (AGENTS.md points at further reading directly) and `CLAUDE.local.md` (gitignored, so a cold implementer in a worktree never sees it).

## Ambient machinery

- **no-backlog guard** (PreToolUse hook): blocks unsanctioned `gh issue create`.
- **git guard** (PreToolUse hook): blocks the hook-bypass flag, commit trailers, bare force-push, `checkout .`/`restore .`, and `git clean -f`; `FLOW_SANCTION=git` for a foreign commit that already carries a trailer. The destructive set is deliberately narrow - `reset --hard` and `branch -D` are excluded because the reflog returns them. Rules match against the command with quoted strings and heredoc bodies stripped, so writing about a rule is not breaking it. Hooks fire on subagent tool calls, so these rules hold in every seat even though the charter itself doesn't reach them.
- **protect-files guard** (PreToolUse on Edit/Write): refuses writes to `.env` and friends (`.env.example` and other templates exempt), to resolver-generated lockfiles, and into build output directories. It reads `file_path`, so a heredoc through Bash is not caught - a guardrail, not a boundary.
- **publish guard** (PreToolUse hook): asks before `cargo publish`, `npm publish`, `twine upload` and their siblings, because those registries have no usable unpublish. `--dry-run` passes. `docker push` and `gh release create` are deliberately absent: a retag and a release deletion both cost nothing.
- **escalation pings**: valves push to the phone via PushNotification from the conductor.
- **nightly lint** (systemd user timer, 03:30, sonnet): drift-audit §3-4 across every repo in the workspace - label contract, worktrees, branches, known flakes - plus §5 for the marketplace repo. Standing permissions, and nothing else: worktree removal and stale-branch deletion, both ONLY through `scripts/lint-actions.mjs` (a deterministic executor that re-derives every safety condition from a fresh fetch and refuses otherwise - the model proposes, the code decides), plus the label moves the contract prescribes (each with a comment). Report-only otherwise.
- **weekly doc sweep** (systemd user timer, Sunday 04:00, sonnet): drift-audit §1-2 across the workspace, report-only, findings carry the fix as a pasteable diff. It gets write access once a month of its reports has been boring.
- Both run `claude -p --permission-mode dontAsk` with a per-job tool allowlist in `scripts/flow-cron.mjs`; the allowlist is the job's whole write authority, the prompt in `skills/flow/cron/` can't widen it. Hooks fire under `-p`, so the job has the charter and both guards - and the git guard's cron mode makes git read-only for the session (deny-by-default subcommands, sanctions ignored) whenever `FLOW_CRON_JOB` is in the env, which the model cannot change. Reports land in `~/.local/state/flow/reports/`, the newest 30 per job, with a desktop notification carrying the headline; a failed or timed-out session exits non-zero so `systemctl --user status flow-lint` shows it. `scripts/install-cron.sh` writes a stable launcher at `~/.local/libexec/flow-cron` that resolves the installed plugin on each run, so a plugin upgrade changes the jobs without touching the units. The desktop app's own scheduler is deliberately not used: it strips hooks and only runs while the app is open.
- **scheduled bug hunts** (planned, not built): opus + sol, findings adversarially verified, deduped against open and closed issues, capped per sweep, filed `agent-found` with `FLOW_SANCTION=hunter`. Quarantine - nothing self-promotes past `/flow:prep`. Waits on a clean month of lint reports.
- **recovery**: `/flow:issue` has no runId; a fresh session reconstructs the run from the issue's event journal plus the worktree diff. The deprecated fixed pipeline resumes via `resumeFromRunId` same-session and a recovery-preamble agent cross-session (`issue-fixed.md` § Recovery).

## Inside the v1 run - what `workflows/issue-fixed.mjs` does

`/flow:issue-fixed` (deprecated) launches a workflow and handles its result; the
stages below are the black box it launches. This is reference, not instruction - the script
is the source of truth. The dynamic run (`/flow:issue`) composes its own fabric per issue
instead of running these.

0. **Size**: coarse triage that buys the fabric. `trivial` is a claim that no production
   code path can regress - not a line count - because it is the one bucket that thins review.
1. **Claim** (atomic): assign + `in-progress` via check-and-set; concurrent runs cannot grab
   the same issue. Snapshot the acceptance criteria - if the body moves mid-run, escalate.
2. **Launch**: worktree off origin/main; context pack (paths, not contents); runId stamped.
3. **Design fan-out**: minimal (opus medium - the modal winner) ∥ clean (fable high - the
   taste seat) ∥ outside (gpt-5.6-sol high, read-only). Cross-model disagreement is signal,
   kept even on small work.
4. **Synthesis** (fable high; opus on trivial): one plan, per-plan difficulty
   (`mechanical | standard | hard`) that routes implementation. Blocking ambiguity →
   `needs-info`.
5. **Implement** (TDD): difficulty routes BOTH model and effort - `mechanical` sonnet/medium,
   `standard` opus/medium, `hard` opus/xhigh. Difficulty is judged at synthesis, never counted
   from file totals. The seat is prompted against scope expansion, premature completion, and
   sub-delegation - a leaf of a fan-out does its own work.
6. **Build gate** (sonnet low): fmt, clippy, tests. Retry-wrapped; UNKNOWN ≠ pass.
7. **Internal review fabric** (parallel): codex adversarial (gpt-5.6-sol) · correctness
   (opus xhigh) · security (opus xhigh) · simplify (opus medium) · AC evidence check
   (opus xhigh): per-criterion verdict + evidence pointer against the launch snapshot.
   Dedupe in pure JS; blocking = critical/high/medium + unmet criteria. A null security seat
   retries on fable, then surfaces `securityReviewUnavailable` - never a silently thinner
   fabric. The codex leg is in every size bucket: cheapest seat in the fabric and the only
   cross-model signal. What actually looked at the diff rides out in `coverage`.
8. **Fix loop** (≤3 rounds, opus; xhigh for critical/high, medium below): parallel across
   disjoint files, serial otherwise; each fixer stages only its own files by explicit path -
   staging is repo-global even when the edits are disjoint. Mediums are fixed, not deferred. Re-gate + re-review each
   round; codex re-verifies after the loop. Unresolved blockers get an **opus max
   adjudication** (real blocker vs reviewer theater) before anything escalates.
9. **Doc-sync** (opus high): diff-aware context.md/AGENTS.md updates travel with the change,
   edited in place - docs correct what the diff made false, they do not grow per PR.
10. **Push PR** mid-run: summary + changelog description. Externals see code that already
    survived the internal loop.
11. **Post-push, parallel tracks**: complementary review on the codex transport (test quality,
    silent failures, type design at sol `high`; comment rot on luna `max`) ∥ external
    reviewers (coderabbit et al.): poll for review-posted, ~10-15 min cap; silent externals
    never stall the run; stale-SHA findings revalidated against HEAD.
12. **Synthesis fix round** (fable → opus; taste seat): fold internal + external findings into
    one verdict set (fix / noise / already-fixed); apply; push; reply to external threads.
13. **Evidence ledger** (sonnet medium): final PR comment - criterion → verdict → evidence,
    every cell openable from the GitHub page without cloning. Four surfaces, strongest first:
    `ci` a job/step deep-link (`#step:<n>:<line>`) - strongest because GitHub produced the
    bytes, not the agent; `code` a permalink pinned to the PR head SHA; `commit` a capture on
    `flow-evidence` under `pr-<N>/` (never main), embedded via a SHA-pinned raw url so it
    renders for anyone who can see the PR; `artifact` on plans for what git cannot serve - an
    HTML page, video, oversized image set - always `--keep`, never `--ttl`, because a TTL'd
    URL is not evidence. Visibility is a LOOKUP, not a judgment: the conductor resolves the
    `evidence-public` label into `evidencePublic` at launch, and public publishing needs that
    ack AND a per-criterion `visibility: public`; otherwise the prompt never mentions
    `--public` at all. A private artifact is tailnet-only - link it, never embed it, and say
    so. Missing screenshot preconditions are a stated gap, never a silent one. Captures
    illustrate; the committed test or command pointer still does the proving.
14. **Stop**: an open, reviewed, evidenced PR. Never auto-merge. Final journal comment.

## Endgame

Once `ready-for-agent` has proven watertight through the label lint and a body of clean runs, a cron picks up validated issues and fires `/flow:issue` unattended. The contract is the safety case; don't ship the cron before the contract has earned it.
