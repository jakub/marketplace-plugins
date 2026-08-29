---
name: flow
description: The flow development framework - project setup, the documentation stack, drift audits, and the label contract for the prep → issue → land pipeline. Use when setting up a new project's docs, auditing a project for drift, validating ready-for-agent issues, or answering a "how do we work" question the charter doesn't settle.
---

# flow - the development framework

The charter is in your context already; it says how we build and delegate. The command bodies (`prep.md` and `issue.md`) say what each command does, and the `land-stage` skill holds the land steps that `land.md` now only aliases. This skill holds what neither needs every session: how to set a project up, what the doc stack looks like, and the machinery running in the background. Don't restate the charter here - if something is true in every session, it belongs there.

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
7. **Known flakes**: create `.github/known-flakes.txt` (empty). `/flow:land` reads it - one entry per line, either a bare CI check name or `check-name:test_name` for a single flaky test (the `land-stage` skill documents both forms), naming what the repo consciously merges through. Lore lives in the repo, not in command prompts.
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
- **protect-files guard** (PreToolUse on Edit/Write/NotebookEdit): refuses writes to `.env` and friends (`.env.example` and other templates exempt), to resolver-generated lockfiles, and into build output directories. It reads `file_path`, so a heredoc through Bash is not caught - a guardrail, not a boundary.
- **publish guard** (PreToolUse hook): asks before `cargo publish`, `npm publish`, `twine upload` and their siblings, because those registries have no usable unpublish. `--dry-run` passes. `docker push` and `gh release create` are deliberately absent: a retag and a release deletion both cost nothing.
- **escalation pings**: valves push to the phone via PushNotification from the conductor.
- **nightly lint** (systemd user timer, 03:30, sonnet): drift-audit §3-4 across every repo in the workspace - label contract, worktrees, branches, known flakes - plus §5 for the marketplace repo. Standing permissions, and nothing else: worktree removal and stale-branch deletion, both ONLY through `scripts/lint-actions.mjs` (a deterministic executor that re-derives every safety condition from a fresh fetch and refuses otherwise - the model proposes, the code decides), plus the label moves the contract prescribes (each with a comment). Report-only otherwise.
- **weekly doc sweep** (systemd user timer, Sunday 04:00, sonnet): drift-audit §1-2 across the workspace, report-only, findings carry the fix as a pasteable diff.
- Both run `claude -p --permission-mode dontAsk` with a per-job tool allowlist in `scripts/flow-cron.mjs`; the allowlist is the job's whole write authority, the prompt in `skills/flow/cron/` can't widen it. Hooks fire under `-p`, so the job has the charter and both guards - and the git guard's cron mode makes git read-only for the session (deny-by-default subcommands, sanctions ignored) whenever `FLOW_CRON_JOB` is in the env, which the model cannot change. Reports land in `~/.local/state/flow/reports/`, the newest 30 per job, with a desktop notification carrying the headline; a failed or timed-out session exits non-zero so `systemctl --user status flow-lint` shows it. `scripts/install-cron.sh` writes a stable launcher at `~/.local/libexec/flow-cron` that resolves the installed plugin on each run, so a plugin upgrade changes the jobs without touching the units. The desktop app's own scheduler is deliberately not used: as of 2026-08 it strips hooks and only runs while the app is open.
- **recovery**: `/flow:issue` has no runId; a fresh session reconstructs the run from the issue's event journal plus the worktree diff.
