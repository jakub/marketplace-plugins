---
name: flow
description: Set a project up for flow, audit it for drift, reconcile its labels, or answer a "how do we work" question the charter doesn't settle. Use when the user says "flow setup", "flow drift", "flow labels", "flow charter" or "flow cron", or asks how the prep → issue → land pipeline works.
---

# flow

The charter is what every session needs. The stage skills (`prep`, `issue`, `babysit`, `land`) carry their own steps, and `delegate` covers running other models. This one covers everything around them: setting a project up, the doc stack, the labels, drift audits and the scheduled jobs. Each hook documents itself in its script header under `hooks/scripts/`.

## Subcommands

- **`setup`**: put the doc stack into a project. Follow "Setup" below.
- **`drift`**: audit this project, or the whole workspace if you run it from `~/code`, with `drift-audit.md`.
- **`labels`**: reconcile the repo's labels and check its `ready-for-agent` issues, as `label-contract.md` says.
- **`charter`**: print `charter/charter.md`, so the user can see exactly what every session is told.
- **`cron`**: bare `cron` runs `bash <plugin-root>/scripts/install-cron.sh status`. `cron install`, `cron run <lint|doc-sweep>` and `cron uninstall` pass through. Show the output as is. Don't paraphrase it.

Also here: `templates/` holds the seed files for setup, and `cron/` holds the nightly lint and weekly doc-sweep prompts that `scripts/flow-cron.mjs` runs.

## Setup

Every step is idempotent. Skip what already exists and conforms, and report what you created.

1. **Preconditions.** A git repo (stop if not), `gh` signed in, and an origin remote.
2. **Workspace registry**, once per machine. Create `~/code/CLAUDE.md` from `templates/workspace-claude.md`, and add or refresh this repo's line.
3. **Delegate dispatcher**, once per machine, before the first Codex session. Run `node <codex-plugin-root>/scripts/install-delegate.mjs install` from the flow copy Codex installed. It copies `bin/flow-delegate` to `~/.local/bin/flow-delegate`, which must be on PATH, and refuses to overwrite a file there that isn't a flow dispatcher. Codex starts MCP servers before any hook runs, so the hook that keeps it current can't cover the very first launch.
4. **Codex hook trust**, once per machine with the user present, and again whenever flow adds or changes a hook. Codex skips an untrusted hook without a word, so T3 seats on Codex depend on this.
   1. Run `node <plugin-root>/scripts/seat.mjs trust` from either host's flow copy. It lists flow's Codex hook keys, the command each runs, and a `digest` of the list.
   2. Show the user the list.
   3. If they agree, run `node <plugin-root>/scripts/seat.mjs trust --write --expect <digest>`. It writes only flow's keys, leaves every other entry alone, and reads them back. Report success only when every key reads `trusted`.
   - `HOOKS_CHANGED` means the hooks moved since you listed them, and nothing was written. List again and show the user the new list.
   - `HOOKS_MISMATCH` means Codex has a different flow version installed than this `seat.mjs`. Get both hosts on one version, then run it again.
   - Never run this from a hook.
5. **Scheduled jobs**, once per machine with a systemd user manager. Run `bash <plugin-root>/scripts/install-cron.sh status`, and `install` if the launcher is missing. The jobs are `claude -p` sessions whichever host runs the pipeline, and the launcher finds flow through `~/.claude/plugins/installed_plugins.json`, so flow must be installed at Claude user scope (`claude plugin install flow@jakub --scope user`). The installer checks `node` and `claude` are on the launcher's PATH and dry-runs both jobs before it enables a timer. No systemd user sessions? Skip this and say so.
6. **Repo `AGENTS.md`.** Create it from `templates/repo-agents.md`, then `ln -s AGENTS.md CLAUDE.md`. Keep it around 40 lines, pointing at `context.md` and `docs/adr/` instead of copying them. Its `## Contexts` section is the context map.
7. **Domain docs.** A judgment call: propose it, don't apply it everywhere. For each crate or module with real domain depth, create `crates/<x>/AGENTS.md` from `templates/crate-agents.md` with its `CLAUDE.md` symlink, plus a `context.md` slice if the vocabulary is local. Each slice gets a line in the root `## Contexts`.
8. **ADRs.** Create `docs/adr/` with a `0000-template.md`.
9. **Labels.** Run the `labels` subcommand.
10. **Known flakes.** Create an empty `.github/known-flakes.txt`. The merge gate reads it from the base branch, never from the PR: one entry per line, a bare check name or `check-name:test_name`, naming what the repo merges through on purpose.
11. **Report** a checklist: what you created, what already conformed, and what needs the user's call.

## The doc stack

Four layers, each answering one question:

| Layer | File | Answers |
|---|---|---|
| operator | the host's global instructions (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) and the charter | who the user is, how we build |
| workspace | `~/code/CLAUDE.md` | what exists |
| repo | `AGENTS.md`, with `CLAUDE.md` symlinked to it | how to work here |
| domain | `crates/<x>/AGENTS.md` with its symlink, and `context.md` slices | crate-local depth |

Codex reads `AGENTS.md` and Claude Code reads `CLAUDE.md`, so the symlink gives both one source. The root `context.md` holds cross-cutting terms, and crate-local terms live next to the code.

Two files we deliberately don't use: `context-map.md`, which is redundant because `AGENTS.md` points at things directly, and `CLAUDE.local.md`, which is gitignored, so a fresh implementer in a worktree never sees it.
