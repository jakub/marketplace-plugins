# Drift audit procedure (`/flow drift`)

Re-run the framework's invariants against reality. Report findings ranked by severity;
fix only when asked (or when running as the ambient cron with standing instructions).
Delegate each numbered section to a scoped agent (sonnet unless noted); reconcile and
judge the combined report on the conductor.

Scope: the current repo when run inside one; the whole workspace when run from the
workspace root (the directory holding the project checkouts, e.g. `~/code`).

## 1. Doc stack conformance

- Repo root: `AGENTS.md` exists, `CLAUDE.md` is a symlink to it (not a divergent copy —
  a real file that shadows the symlink is the worst drift: two sources, both trusted).
- `AGENTS.md` lean (≤ ~40 lines), discloses context.md / docs/adr/ that actually exist.
- `AGENTS.md` `## Contexts` is the context map and must stay honest both ways: every
  `crates/<x>/context.md` on disk has a line, every line points at a file that exists.
  Absent in a single-context repo is correct, not drift.
- No `context-map.md` (fold into `## Contexts` + delete). No `CLAUDE.local.md` (its content
  belongs in a committed file; flag for migration).
- Glossary files are lowercase `context.md`; an uppercase `CONTEXT.md` is drift (usually a
  vendored skill writing its own default) — fold it down and delete.
- Domain layer: for each crate/module with a `context.md` slice or `AGENTS.md`, the file's
  claims spot-check against the code (an agent reads the doc, greps the crate, flags
  statements that no longer hold). For crates WITHOUT domain files, flag only those with
  evident domain depth (own vocabulary, ADR references) as candidates.
- Workspace registry (`CLAUDE.md` at the workspace root): every listed project exists;
  every dir that is a real active project is listed (one line each). Staleness cuts both ways.

## 2. Glossary drift

- Terms defined in context.md (root + slices): sampled greps confirm they still name real
  code concepts; flag orphans (defined, never used) and ghosts (pervasive in code,
  undefined in the glossary).
- ADR index: files in `docs/adr/` are sequentially numbered, referenced ADRs exist, and no
  ADR contradicts a newer one without a superseded-by note.

## 3. Label + tracker hygiene

Run the `labels` subcommand (see `label-contract.md`): taxonomy present, every
`ready-for-agent` validates the contract, no orphaned `in-progress` claims.

## 4. Repo state hygiene

- `git worktree list`: no worktrees for merged/deleted branches.
- `git branch --merged main`: no stale local branches.
- `.github/known-flakes.txt` exists; every entry names a check that actually exists in
  recent CI runs (a flake entry for a renamed check is dead lore).
- Isolated test DBs (where the repo uses them): no orphans beyond live worktrees.

## 5. Charter version skew

- Installed plugin version vs this repo's HEAD (`claude plugin list` vs
  `plugins/flow/.claude-plugin/plugin.json`) — a stale install means sessions run an old
  charter.
- Facts with `as-of` dates older than a quarter (model pricing, codex CLI surface):
  flag for re-verification.
- `node plugins/flow/scripts/smoke-codex-exec.mjs` passes (add `CODEX_LIVE=1` when codex
  auth is available) — the transport's encoded CLI facts (model catalog, effort surface,
  service-tier fail-open behavior, JSONL event shapes) drift with codex releases.

## Output format

```
# drift report — <repo|workspace> — <date>
## critical   (framework violated in a way that will corrupt runs)
## warning    (stale/nonconforming, will mislead agents)
## candidate  (improvements to propose, e.g. crates deserving domain files)
## clean      (sections that fully conform — one line each)
```
Each finding: what, where (path/issue#), the specific invariant violated, proposed fix.
No silent caps — if a section was sampled rather than exhaustive, say so.
