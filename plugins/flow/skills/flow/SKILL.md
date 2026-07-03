---
name: flow
description: The flow development framework — doctrine, doc-stack setup, and drift audits for the prep → issue → land pipeline. Use when setting up a new project's documentation stack, auditing an existing project for drift against the framework, validating ready-for-agent issues, or answering "how do we work" questions the charter doesn't settle.
---

# flow — the development framework

This skill is the single source of doctrine for how the user and Claude build software
together. The **charter** (injected every session by this plugin's SessionStart hook)
carries the always-on rules; this skill carries the full framework, the setup procedure,
and the drift audit. Commands (`/flow:prep`, `/flow:issue`, `/flow:land`) execute the
pipeline; they point here for shared doctrine rather than restating it.

Base directory for this skill contains:

| File | Contents |
|---|---|
| `framework.md` | The full doctrine: pipeline phases, model policy, issue-as-record, evidence, doc stack. |
| `label-contract.md` | Label state machine + the `ready-for-agent` contract and its lint. |
| `drift-audit.md` | The audit procedure for `drift`. |
| `templates/` | Seed files for `setup`: workspace CLAUDE.md, repo AGENTS.md, crate AGENTS.md. |

## Subcommands

If the user request is a bare subcommand string (e.g. `/flow drift`), follow the matching
action directly:

| Subcommand | Action |
|---|---|
| `setup` | Deploy the doc stack to a project. Read `framework.md` § doc stack + all of `templates/`, then follow **Setup** below. |
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
   Keep it lean (≤ ~40 lines); it discloses further reading (CONTEXT.md, docs/adr/) rather
   than containing it. If the repo has a legacy `CONTEXT-MAP.md`, fold its pointers into
   AGENTS.md and delete it.
4. **Domain layer** (judgment call — propose, don't blanket): for each crate/module with
   real domain depth, `crates/<x>/AGENTS.md` from `templates/crate-agents.md` + the
   `CLAUDE.md` symlink, and a `CONTEXT.md` slice if the vocabulary is crate-local.
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

## Doctrine quick-reference (details in framework.md)

- **Pipeline**: `/flow:prep` (front door, interactive) → `/flow:issue` (hands-off through
  a pushed, reviewed, evidenced PR) → `/flow:land` (the only merge path, human-gated).
- **The issue is the spec AND the record**: body = living spec, edited in place; comments =
  append-only stage journal; PR = evidence. ADRs for permanent decisions only.
- **No-backlog**: PRs ship complete. The only follow-up path is the escape hatch
  (cross-crate-refactor scale), drafted on the PR, filed on human ack at land.
- **Evidence**: every acceptance criterion names its evidence at prep and gets a
  per-criterion verdict + link in the PR ledger.
- **Verification**: UNKNOWN ≠ clean. Errored/rate-limited/timed-out checks never pass.
- **Models**: fable judges, opus works, sonnet transcribes, gpt-5.5 decorrelates,
  haiku is retired. Axes (intelligence > taste > cost), never file counts.
