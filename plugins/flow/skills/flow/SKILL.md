---
name: flow
description: The flow development framework: project setup, the documentation stack, drift audits, and the label contract for the prep → issue → land pipeline. Use when setting up a new project's docs, auditing a project for drift, validating ready-for-agent issues, or answering a "how do we work" question the charter doesn't settle.
---

# flow: project setup and the doc stack

The charter holds the doctrine every session needs. The stage skills (`prep`, `issue`, `babysit`, `land`) hold their own steps, and `delegate` covers cross-family calls. This skill covers project setup, the doc stack, the label contract, the drift audit and the scheduled jobs. Each hook documents itself in its script's header under `hooks/scripts/`.

| File | Contents |
|---|---|
| `label-contract.md` | The label table, its rules and the `ready-for-agent` contract. |
| `drift-audit.md` | The procedure the `drift` subcommand runs. |
| `templates/` | Seed files for `setup`: the workspace `CLAUDE.md`, the repository and crate `AGENTS.md`, and the launcher and systemd units under `templates/systemd/`. |
| `cron/` | The prompts for the nightly lint and the weekly doc sweep, which `scripts/flow-cron.mjs` runs. |

## Subcommands

Name a subcommand when you invoke this skill:

| Subcommand | Action |
|---|---|
| `setup` | Deploy the doc stack to a project: read **The documentation stack** and `templates/`, then follow **Setup**. |
| `drift` | Audit the current project, or the whole workspace from `~/code`, by running `drift-audit.md`. |
| `labels` | Reconcile the repository's labels and check its `ready-for-agent` issues, as `label-contract.md` says. |
| `charter` | Print `charter/charter.md` from the plugin root, so the human can review what every session is told. |
| `cron` | Bare `cron` runs `bash <plugin-root>/scripts/install-cron.sh status`. `cron install`, `cron run <lint\|doc-sweep>` and `cron uninstall` pass through. Show the output without paraphrasing it. |

## Setup

Run these steps in order. Each one is idempotent: skip what already exists and conforms, and report what you created.

1. **Preconditions.** A git repository (stop if not), `gh` signed in, and a resolvable origin remote.
2. **Workspace layer**, once per machine. Create `~/code/CLAUDE.md`, the project registry, from `templates/workspace-claude.md`, and add or refresh this repository's line.
3. **Delegate dispatcher**, once per machine before the first Codex session. Run `node <codex-plugin-root>/scripts/install-delegate.mjs install` from the flow copy that Codex installed. It copies `bin/flow-delegate` to `~/.local/bin/flow-delegate`, which must be on PATH, and refuses to replace a file there that is not a flow dispatcher. Codex starts MCP servers before any hook runs, so the SessionStart hook that keeps the dispatcher current cannot cover the first launch.
4. **Codex hook trust**, once per machine with the human present, and again after flow adds a hook. Codex skips an untrusted hook without a word, so T3 seats on Codex need flow's hooks trusted. Run `node <codex-plugin-root>/scripts/seat.mjs trust` from the flow copy that Codex installed, because trust counts only the hooks rooted at the copy it runs from. It lists flow's own Codex hook keys, the command each one runs, and a `digest` of the list. Show the list to the human. On their consent, run `node <codex-plugin-root>/scripts/seat.mjs trust --write --expect <digest>` with the `digest` from that list. It lists the keys again and refuses with `HOOKS_CHANGED`, writing nothing, if they no longer match the digest; then list again and show the human the new list. Otherwise it upserts only flow's keys into Codex's hook trust, leaves every other entry alone, and reads the keys back: report success only when each one reads `trusted`. `HOOKS_MISMATCH` means the flow Codex has installed is not the copy or the version this `seat.mjs` came from, so run the copy Codex installed, update the installs until both hosts carry one version, then run it again. Never run it from a hook.
5. **Scheduled jobs**, once per machine with a systemd user manager. Run `bash <plugin-root>/scripts/install-cron.sh status`, and `install` if the launcher is missing. The jobs are `claude -p` sessions whichever host runs the pipeline, and the launcher finds flow through `~/.claude/plugins/installed_plugins.json`, so flow must be installed at Claude user scope (`claude plugin install flow@jakub --scope user`). The installer checks that `node` and `claude` are on the launcher's own PATH and dry-runs both jobs before it enables a timer. On a machine without systemd user sessions, skip this step and say so.
6. **Repository layer.** Create `AGENTS.md` from `templates/repo-agents.md`, then run `ln -s AGENTS.md CLAUDE.md`. Keep it lean, about 40 lines, pointing at `context.md` and `docs/adr/` instead of holding their content. Its `## Contexts` section is the context map.
7. **Domain layer**, a judgment call to propose, not to apply everywhere. For each crate or module with real domain depth, create `crates/<x>/AGENTS.md` from `templates/crate-agents.md` with its `CLAUDE.md` symlink, and a `context.md` slice if the vocabulary is crate-local. Each slice gets a line in the root `## Contexts`.
8. **Decision records.** Create `docs/adr/` with a `0000-template.md`.
9. **Labels.** Run the `labels` subcommand.
10. **Known flakes.** Create an empty `.github/known-flakes.txt`. The merge executor reads it from the base branch, never from the PR: one entry per line, either a bare check name or `check-name:test_name`, naming what the repository merges through on purpose.
11. **Report** what you created, what already conformed, and what needs the human's decision, as a checklist.

## The documentation stack

Four layers, each answering one question:

| Layer | File | Question |
|---|---|---|
| operator | the host's global instructions (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) and the charter | who the user is, and how we build |
| workspace | `~/code/CLAUDE.md` | what exists |
| repository | `AGENTS.md`, with `CLAUDE.md` as a symlink to it | how to operate here |
| domain | `crates/<x>/AGENTS.md` with its symlink, and `context.md` slices | crate-local depth |

Codex merges `AGENTS.md` files by directory, and Claude Code loads `CLAUDE.md`, so the symlink gives both families one source. The root `context.md` holds cross-cutting terms, and crate-local terms live in slices next to the code.

Two files are deliberately not used. A `context-map.md` index is redundant, because `AGENTS.md` points at further reading directly. A `CLAUDE.local.md` is gitignored, so a cold implementer in a worktree never sees it.
