---
name: flow
description: The flow development framework - project setup, the documentation stack, drift audits, and the label contract for the prep → issue → land pipeline. Use when setting up a new project's docs, auditing a project for drift, validating ready-for-agent issues, or answering a "how do we work" question the charter doesn't settle.
---

# flow - the development framework

The charter is in your context already; it says how we build and delegate. No command file says what its command does: prep, issue and land are each one stage skill (`prep-stage`, `issue-stage`, `land-stage`), a host-neutral body ending in a `## Host mechanics` section that holds only what differs by host; the charter's `## Hosts` section holds the rest. Where a host has commands, `prep.md`, `issue.md` and `land.md` only alias them. The `delegate` skill beside this one is the operating manual for a cross-family call. This skill holds what neither needs every session: how to set a project up, what the doc stack looks like, and the machinery running in the background.

Files in this directory:

| File | Contents |
|---|---|
| `label-contract.md` | Label state machine, the `ready-for-agent` contract, and its lint. |
| `drift-audit.md` | The procedure `drift` runs. |
| `templates/` | Seed files for `setup`: workspace CLAUDE.md, repo AGENTS.md, crate AGENTS.md, and the launcher and systemd units under `templates/systemd/`. |
| `cron/` | Standing instructions for the scheduled jobs (`lint.md`, `doc-sweep.md`); `scripts/flow-cron.mjs` runs them. |

## Subcommands

Name a subcommand when you invoke this skill and it runs the matching action:

| Subcommand | Action |
|---|---|
| `setup` | Deploy the doc stack to a project. Read **The documentation stack** and `templates/`, then follow **Setup**. |
| `drift` | Audit the current project (or the whole workspace, from `~/code`) against the framework. Read and execute `drift-audit.md`. |
| `labels` | Reconcile the repo's GitHub labels with `label-contract.md` and lint every `ready-for-agent` issue against the contract. |
| `charter` | Print the installed charter (`charter/charter.md` in the plugin root) so the user can review what every session is told. |
| `cron` | The scheduled jobs, which are Claude-hosted whatever this session runs on (see **Ambient machinery**). Bare `cron` runs `scripts/install-cron.sh status`; `cron install`, `cron run <lint\|doc-sweep>`, and `cron uninstall` pass through. Show the output; don't paraphrase it. |

## Setup

Deploy flow to a project, in this order. Every step is idempotent: skip what already exists and conforms, report what you created.

1. **Preconditions**: a git repo (stop if not), `gh` authenticated, origin remote resolvable.
2. **Workspace layer**, once per machine: `~/code/CLAUDE.md` from `templates/workspace-claude.md` - the project registry. Add or refresh this repo's one-liner.
2b. **Machine layer**, once per machine: `bash <plugin root>/scripts/install-cron.sh status`; if the launcher is missing, run `install`. This arms the nightly lint and the weekly doc sweep; **Ambient machinery** says what they need. Skip on a machine without systemd user sessions and say so.
3. **Repo layer**: `AGENTS.md` from `templates/repo-agents.md`, then `ln -s AGENTS.md CLAUDE.md`. Keep the file lean (≤ ~40 lines); it points at further reading (context.md, docs/adr/) rather than containing it. Its `## Contexts` section is the context map.
4. **Domain layer**, a judgment call - propose, don't blanket: for each crate or module with real domain depth, `crates/<x>/AGENTS.md` from `templates/crate-agents.md` plus the `CLAUDE.md` symlink, and a `context.md` slice if the vocabulary is crate-local. Every slice gets a line in the root `## Contexts`. Always committed.
5. **Decision records**: `docs/adr/` with a `0000-template.md`.
6. **Labels**: run the `labels` subcommand.
7. **Known flakes**: create `.github/known-flakes.txt` (empty). The land stage reads it - one entry per line, either a bare CI check name or `check-name:test_name` for a single flaky test (the `land-stage` skill documents both forms), naming what the repo consciously merges through. Lore lives in the repo, not in command prompts.
8. **Report**: what was created, what already conformed, what needs a human decision (e.g. which crates deserve domain files). A checklist, not an essay.

## Drift

`drift` re-checks the framework's invariants against reality; `drift-audit.md` is the procedure. Run it on a schedule (the nightly/weekly crons), after large merges, or when the docs feel stale. It reports and doesn't fix unless asked. Delegate the scanning to cheap read-only seats and return a reconciled report with a judgment pass on top.

## The documentation stack

Four layers, each answering one question:

| layer | file | question |
|---|---|---|
| operator | the host's own global instructions (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) + the charter | who the user is / how we build |
| workspace | `~/code/CLAUDE.md` | what exists (project registry) |
| repo | `AGENTS.md` ⟵ `CLAUDE.md` symlink | how to operate here (lean; points at context.md, docs/adr/) |
| domain | `crates/<x>/AGENTS.md` + symlink, `context.md` slices | crate-local depth |

One source, both model families: codex merges AGENTS.md hierarchically, Claude loads CLAUDE.md, and the symlink keeps them identical by construction. Root `context.md` holds cross-cutting ontology; crate-local vocabulary lives in slices next to the code.

Deliberately not used: `context-map.md`-style index files (AGENTS.md points at further reading directly) and `CLAUDE.local.md` (gitignored, so a cold implementer in a worktree never sees it).

## Ambient machinery

- **charter delivery** (SessionStart and SubagentStart hooks): one `hooks/scripts/inject-charter.mjs` on both hosts. At session start Claude gets the charter as two hooks, one per half, because a single hook's stdout is capped at 10,000 characters; Codex gets the whole file in one write. At subagent start both hosts hand the spawned seat the charter's seat half - the rules below the marker line - as `additionalContext`, so a spawn prompt carries the task and never the contract. Claude skips `Explore` (it only locates files) and `fork` (it already copies the session's context); Codex has neither mechanism and skips nothing. A delegated job gets the same bytes in its preamble.
- **no-backlog guard** (PreToolUse hook): blocks unsanctioned `gh issue create`.
- **git guard** (PreToolUse hook): blocks the hook-bypass flag, commit trailers, bare force-push, `checkout .`/`restore .`, and `git clean -f`; `FLOW_SANCTION=git` for a foreign commit that already carries a trailer. The destructive set is deliberately narrow - `reset --hard` and `branch -D` are excluded because the reflog returns them. The flag and destructive rules match against the command with quoted strings and heredoc bodies stripped, so writing about a rule is not breaking it; the trailer check reads the raw command, because a trailer lives inside the quoted message. Under `FLOW_CRON_JOB` the guard is instead a fail-closed grammar over every command, git or not, one command per call; `skills/flow/cron/lint.md` spells it out. Hooks fire on a seat's tool calls as well as the orchestrator's, so these rules hold in every seat whatever its prompt says.
- **protect-files guard** (PreToolUse on whichever file-editing tools this host has): refuses writes to `.env` and friends (`.env.example` and other templates exempt), to `.flow/managed` (the committed marker that opts a repository into the merge guardrail), to resolver-generated lockfiles, and into build output directories. It reads the edit's target path, so a heredoc through a shell command is not caught.
- **publish guard** (PreToolUse hook): on Claude, asks before `cargo publish`, `npm publish`, `twine upload` and their siblings, because those registries have no usable unpublish; on Codex, which cannot render an ask, it denies them and directs the human to publish by hand. The merge half is identical on both hosts: in a repository with `.flow/managed`, either adapter denies every merge spelling it recognizes and names `scripts/land-merge.mjs`, the executor the land stage runs once its gates pass. `--dry-run` passes. `docker push` and `gh release create` are deliberately absent: a retag and a release deletion both cost nothing.
- **escalation pings**: a tripped valve sends a notification from the orchestrator; the stage's host-mechanics section says what that ping binds to, including when the answer is that this host has nothing to ping with.
- **nightly lint** (systemd user timer, 03:30, sonnet): drift-audit §3-4 across every repo in the workspace - label contract, worktrees, branches, known flakes - plus §5 for the marketplace repo. Standing permissions, and nothing else: worktree removal, stale-branch deletion, and the three label moves the contract prescribes (an orphaned claim back to `ready-for-agent`, a contract failure down to `needs-triage`, an unlabelled issue up to `needs-triage`), every one ONLY through a `scripts/lint-actions.mjs` verb (a deterministic executor that re-derives every safety condition from fresh state and refuses otherwise - the model proposes, the code decides); the job's allowlist grants no `gh issue edit` and no `gh issue comment`. Report-only otherwise.
- **weekly doc sweep** (systemd user timer, Sunday 04:00, sonnet): drift-audit §1-2 across the workspace, report-only, findings carry the fix as a pasteable diff.
- Both jobs are Claude-hosted, and that stays true whichever host orchestrates the pipeline: a run is a headless `claude -p` session, and the launcher resolves the plugin by reading `~/.claude/plugins/installed_plugins.json` for a `flow@jakub` entry at Claude user scope, the only registry it reads. Install it there (`claude plugin install flow@jakub --scope user`, as of Claude Code 2.1.257). Without that entry `install-cron.sh install` fails its launcher dry-run, says so, and writes nothing.
- Each run is `claude -p --permission-mode dontAsk` with a per-job tool allowlist in `scripts/flow-cron.mjs`; the allowlist is the job's whole write authority, the prompt in `skills/flow/cron/` can't widen it. Hooks fire under `-p`, so the job has the charter and both guards - and the git guard's cron mode makes git read-only for the session (deny-by-default subcommands, sanctions ignored) whenever `FLOW_CRON_JOB` is in the env, which the model cannot change. Reports land in `~/.local/state/flow/reports/`, the newest 30 per job, with a desktop notification carrying the headline; a failed or timed-out session exits non-zero so `systemctl --user status flow-lint` shows it. `scripts/install-cron.sh` writes a stable launcher at `~/.local/libexec/flow-cron` that resolves the installed plugin on each run, so a plugin upgrade changes the jobs without touching the units.
