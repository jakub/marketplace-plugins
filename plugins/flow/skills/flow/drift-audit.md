# Drift audit (the flow skill's `drift` subcommand)

Check the framework's invariants against the real state. Report findings ranked by severity, and fix nothing unless asked. Give each section to a scoped read-only seat, then reconcile and judge the combined report on the main thread. The scope is the current repository, or every repository under the workspace root (such as `~/code`) when you run it from there. The weekly doc sweep runs sections 1 and 2.

## 1. Doc stack conformance

- The repository root has `AGENTS.md`, and `CLAUDE.md` is a symlink to it. A real `CLAUDE.md` beside it is the worst drift: two sources, both trusted.
- `AGENTS.md` is lean (about 40 lines) and points at the `context.md` files and `docs/adr/` that actually exist.
- `## Contexts` in `AGENTS.md` is the context map, and it is honest both ways: every `crates/<x>/context.md` on disk has a line, and every line points at a file that exists. A single-context repository without the section is correct.
- There is no `context-map.md` (fold it into `## Contexts` and delete it) and no `CLAUDE.local.md` (move its content into a committed file).
- Glossary files are lowercase `context.md`. An uppercase `CONTEXT.md`, usually a vendored skill's default, is drift: fold it down and delete it.
- Domain docs: spot-check the claims in each crate's `context.md` or `AGENTS.md` against the code. Flag a crate without domain files only when it shows domain depth, such as its own vocabulary or ADR references.
- The workspace registry, `CLAUDE.md` at the workspace root, lists every project that exists and every active project, one line each.

## 2. Glossary drift

- Sample-grep the terms in each `context.md`. Flag orphans (defined, never used) and ghosts (used everywhere, never defined).
- `docs/adr/` is numbered in sequence, every referenced ADR exists, and no ADR contradicts a newer one without a superseded-by note.

## 3. Labels and the tracker

Run the `labels` subcommand (`label-contract.md`): the label set, every `ready-for-agent` issue against the contract, and no orphaned `in-progress` claim.

## 4. Repository state

The marketplace repository is the one whose `.claude-plugin/marketplace.json` names marketplace `jakub`, and its origin owner is the human. A repository with another origin owner is third-party: give it one report line, and run neither section 3 nor this section against it.

Run `node <plugin-root>/scripts/lint-actions.mjs survey <repo>`. It reports worktrees, local branches with their PRs, origin's branches, open issues and known flakes.

- A clean worktree unchanged for four days whose PR is merged or closed, and a local branch whose PR is merged or closed, are candidates for `lint-actions.mjs remove-worktree` and `delete-branch`. Both verbs re-check every condition and refuse on any doubt, and `main`, `master` and `flow-evidence` are never deleted. `git branch --merged main` misses squash merges, so PR state is the test.
- A branch on origin that the survey's `remoteBranches` shows with no open PR and a `dead` reason is a candidate for `lint-actions.mjs delete-remote-branch`. Its tip is the head of a merged or closed PR, or is already in the default branch. The verb re-checks both and deletes only at the tip it judged. Report the rest as a count and at most ten names.
- Every `.github/known-flakes.txt` entry names a check that ran in recent CI. An entry with `runsSeen` 0 is dead lore.
- Isolated test databases, where the repository uses them, have no orphans beyond live worktrees.

## 5. Plugin checks (the marketplace repository only)

- The `flow@jakub` version in `~/.claude/plugins/installed_plugins.json` matches `plugins/flow/.claude-plugin/plugin.json`. A stale install means sessions run an old charter.
- Facts with an as-of date older than a quarter, such as the model rankings and the delegate skill's provider flags, need re-verification.
- In a dev checkout, `node scripts/smoke-all.mjs` passes.

## Output format

```
# drift report - <repo|workspace> - <date>
## critical   (framework violated in a way that will corrupt runs)
## warning    (stale/nonconforming, will mislead agents)
## candidate  (improvements to propose, e.g. crates deserving domain files)
## clean      (sections that fully conform - one line each)
```

Each finding gives what, where (a path or an issue number), the invariant violated, and the proposed fix. Say when a section was sampled rather than exhaustive.
