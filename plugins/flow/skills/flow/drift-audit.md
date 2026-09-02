# Drift audit procedure (the flow skill's `drift` subcommand)

Re-run the framework's invariants against reality. Report findings ranked by severity;
fix only when asked (or when running as the ambient cron with standing instructions).
Delegate each numbered section to a scoped agent (sonnet unless noted); reconcile and
judge the combined report on the conductor.

Scope: the current repo when run inside one; the whole workspace when run from the
workspace root (the directory holding the project checkouts, e.g. `~/code`).

## 1. Doc stack conformance

- Repo root: `AGENTS.md` exists, `CLAUDE.md` is a symlink to it (not a divergent copy -
  a real file that shadows the symlink is the worst drift: two sources, both trusted).
- `AGENTS.md` lean (≤ ~40 lines), discloses context.md / docs/adr/ that actually exist.
- `AGENTS.md` `## Contexts` is the context map and must stay honest both ways: every
  `crates/<x>/context.md` on disk has a line, every line points at a file that exists.
  Absent in a single-context repo is correct, not drift.
- No `context-map.md` (fold into `## Contexts` + delete). No `CLAUDE.local.md` (its content
  belongs in a committed file; flag for migration).
- Glossary files are lowercase `context.md`; an uppercase `CONTEXT.md` is drift (usually a
  vendored skill writing its own default) - fold it down and delete.
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

The operator is the owner of the marketplace repo's `origin` (the repo whose
`.claude-plugin/marketplace.json` names marketplace `jakub`). A repo whose `origin` owner is
someone else is third-party: it gets one report line saying so, and neither the label
taxonomy check in section 3 nor any branch or worktree proposal here runs against it. Flow's
taxonomy is not a contract anyone else's repo agreed to, and proposing a mutation on a fork
you do not own is out of scope no matter how safe the executor is. Read the URL with `git -C <repo> remote get-url origin`.

- `bash ${CLAUDE_PLUGIN_ROOT}/scripts/worktree-audit.sh <repo>`: include the TSV; `safe` rows
  are candidates the nightly lint routes through `scripts/lint-actions.mjs` (which re-checks
  everything and refuses on any doubt), `review` rows need a human, and `hold-*` rows are fine. Squash merges mean the MERGED column is usually `no`
  for landed branches; PR state is the signal.
- **Local** branches are the only class any flow job can act on: permission 2 routes them
  through `lint-actions.mjs`, which runs `git branch -D` and nothing else. That executor
  asks two separate questions and needs yes to both. Is the branch dead - a merged or
  closed PR, or a tip already in `origin/main`? And do the commits survive the delete - a
  same-tip `origin/<branch>`, a merged/closed PR head at this tip, or ancestry of
  `origin/main`? A pushed spike with no PR passes the second and fails the first, which is
  correct: perfectly recoverable, perfectly alive. `main`, `master`, and `flow-evidence`
  are refused outright. `git branch --merged main` misses squash-merged branches, so it is
  not the death test.
- **Remote** (`origin/*`) branches are report-only and stay that way: deleting one needs a
  push, which no cron job has and never will. Classify them against a fixed history depth of
  `gh pr list --state all --limit 200`, so two nights are comparable. A remote branch whose
  PR is merged or closed is stale; one whose PR falls below that floor is `unclassified`,
  never stale. Report stale remotes as a count plus at most ten names, and report the
  unclassified count next to the floor that produced it. A bare `branches ✓` is only honest
  when both classes were checked - say which one you mean.
- `.github/known-flakes.txt` exists; every entry names a check that actually exists in
  recent CI runs (a flake entry for a renamed check is dead lore).
- Isolated test DBs (where the repo uses them): no orphans beyond live worktrees.

## 5. Charter version skew

- Installed plugin version vs this repo's HEAD (`claude plugin list` vs
  `plugins/flow/.claude-plugin/plugin.json`) - a stale install means sessions run an old
  charter.
- Charter delivery: run `node ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/inject-charter.mjs 1` and
  read its first line. The script prints a `<!-- flow-charter WARNING: ... -->` comment
  naming any half at or over 9,000 characters, so read that instead of piping to `wc`: the
  nightly lint allows this script only at that exact absolute path and refuses pipelines.
  Claude Code caps one hook's stdout at 10,000 and replaces anything larger with a 2KB
  preview plus a file path, which is why the charter ships as two SessionStart hooks; a half
  over the cap means sessions run on a fragment while the `<flow-charter>` presence check in
  the global CLAUDE.md still passes. The script resolves the charter through
  `CLAUDE_PLUGIN_ROOT`, so this measures the installed charter, not the working tree's; the
  version-skew bullet above is what tells you whether those are the same file.
- Facts with `as-of` dates older than a quarter (the model rankings, the Codex App Server
  protocol): flag for re-verification.
- `node ${CLAUDE_PLUGIN_ROOT}/scripts/smoke-delegation.mjs` passes. The smoke test uses a local
  fake App Server. Run a separate live Claude-to-Codex call when authentication or protocol
  compatibility may have changed.
- Every `smoke-*.mjs` under `plugins/flow/scripts/` passes, plus `scripts/smoke-plugin-manifests.mjs`
  at the repo root. Take the list from `ls`, never from memory, so a new smoke is picked up and
  a deleted one is not reported. A smoke that lints a document builds its broken examples as
  inline strings, so a checked-in fixture tree is itself drift. Running them is dev-checkout
  work, not the nightly lint's: `smoke-bundle-drift` and `smoke-claude-delegation` need
  `npm ci` in `plugins/flow/deps`, and only `smoke-delegation.mjs` is on the cron's allowlist.
  Where the tree cannot run one, report it as not run rather than folding it into a clean line.

## Output format

```
# drift report - <repo|workspace> - <date>
## critical   (framework violated in a way that will corrupt runs)
## warning    (stale/nonconforming, will mislead agents)
## candidate  (improvements to propose, e.g. crates deserving domain files)
## clean      (sections that fully conform - one line each)
```
Each finding: what, where (path/issue#), the specific invariant violated, proposed fix.
No silent caps - if a section was sampled rather than exhaustive, say so.
