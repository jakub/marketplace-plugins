---
name: flow
description: Set a project up for flow, audit it for drift, reconcile its labels, or answer a "how do we work" question the charter doesn't settle. Use when the user says "flow setup", "flow drift", "flow labels" or "flow charter", or asks how the prep → issue → land pipeline works.
---

# flow

The charter is what every session needs. The stage skills (`prep`, `issue`, `babysit`, `land`) carry their own steps, and `delegate` covers running other models. This one covers everything around them: setting a repository up, the doc stack, the labels and drift audits. Each hook documents itself in its script header under `hooks/scripts/`.

## Subcommands

- **`setup`**: set up the current repository for flow. Follow "Setup" below.
- **`drift`**: audit this project, or the whole workspace if you run it from `~/code`, with `drift-audit.md`.
- **`labels`**: reconcile the repo's labels and check its `ready-for-agent` issues, as `label-contract.md` says.
- **`charter`**: print `charter/charter.md`, so the user can see exactly what every session is told.

Also here: `templates/` holds the seed files for setup.

## Setup

Setup changes the current repository and its GitHub labels. It installs nothing on the machine: the Codex dispatcher and Codex hook trust are host setup, and the delegate skill's `reference.md` covers both. Every step is idempotent. Skip what already exists and conforms, and report what you created.

1. **Preconditions.** A git repo (stop if not), `gh` signed in, and an origin remote.
2. **Repo `AGENTS.md`.** Create it from `templates/repo-agents.md`, then `ln -s AGENTS.md CLAUDE.md`. Keep it around 40 lines, pointing at `context.md` and `docs/adr/` instead of copying them. Its `## Contexts` section is the context map.
3. **Domain docs.** A judgment call: propose it, don't apply it everywhere. For each crate or module with real domain depth, create `crates/<x>/AGENTS.md` from `templates/crate-agents.md` with its `CLAUDE.md` symlink, plus a `context.md` slice if the vocabulary is local. Each slice gets a line in the root `## Contexts`.
4. **ADRs.** Create `docs/adr/` with a `0000-template.md`.
5. **Labels.** Run the `labels` subcommand.
6. **Known flakes.** Create an empty `.github/known-flakes.txt`. The merge gate reads it from the base branch, never from the PR: one entry per line, a bare check name or `check-name:test_name`, naming what the repo merges through on purpose.
7. **Merge enforcement.** Create `.flow/managed` with one line that says the file opts the repository into flow's merge guard. Once it's committed, both publish guards deny a raw pull request merge and name `scripts/land-merge.mjs`. The guards read the file from the commit at `HEAD`, so an uncommitted file enrolls nothing. Commit it with the rest of setup. Pushing that commit is the user's call.
8. **Report** a checklist: what you created, what already conformed, and what needs the user's call. Name every file that is still uncommitted. Report merge enforcement as on only when `git ls-tree --name-only HEAD -- .flow/managed` prints the path. Otherwise report it as pending until `.flow/managed` is committed.

## The doc stack

Three layers, each answering one question:

| Layer | File | Answers |
|---|---|---|
| operator | the host's global instructions (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) and the charter | who the user is, how we build |
| repo | `AGENTS.md`, with `CLAUDE.md` symlinked to it | how to work here |
| domain | `crates/<x>/AGENTS.md` with its symlink, and `context.md` slices | crate-local depth |

Codex reads `AGENTS.md` and Claude Code reads `CLAUDE.md`, so the symlink gives both one source. The root `context.md` holds cross-cutting terms, and crate-local terms live next to the code.

Two files we deliberately don't use: `context-map.md`, which is redundant because `AGENTS.md` points at things directly, and `CLAUDE.local.md`, which is gitignored, so a fresh implementer in a worktree never sees it.
