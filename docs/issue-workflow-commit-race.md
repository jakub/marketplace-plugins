# flow-issue: parallel fix agents race at `git commit`, not at the edit

Field report from run `wf_c90dc56c-98b` (trawl issue #78, flow 0.11.0). The
disjoint-file guard in `dispatchFixes` makes parallel fix agents safe at the
**edit** level, but staging and committing are repo-global — and the fix prompt
never tells an agent to scope its staging. Two agents on different files
collided at `git add`/`git commit`, and finished, verified work fell out of
history entirely.

## What happened

Round r2 dispatched fixes in parallel (findings named distinct files, so the
`disjoint` branch ran). The agents' own result summaries describe the collision:

> "My first `git add -A` swept in sibling agents' unstaged work; I immediately
> reset it (soft, then mixed) and re-committed only my two paths. That second
> commit again picked up sibling files staged in the window between my reset
> and my commit, so I reset once more and used `git commit --only <paths>` —
> by then a sibling agent had already committed everything itself."

> "I staged only my three paths and committed with an explicit pathspec, but a
> sibling agent sharing the worktree committed in the same instant and its
> commit swept my staged files in; my own `git commit` then found nothing to
> commit."

Net effect after the round:

- Commits the agents reported (`1f837d29`, `521703b9`) no longer existed on
  the branch — later resets by siblings rewrote them away.
- Three files of **finished, verified** work (a DuckDB regression probe plus
  the whole web-ui backtick rollout for two findings the ledger marked FIXED)
  sat **uncommitted** in the worktree. The run then died on quota; the
  conductor found them dirty at recovery, re-verified, and committed them by
  hand. Had the run reached `publish` instead, the PR would have shipped
  without fixes the evidence ledger claimed, and post-push reply threads would
  have named phantom "fixing commits" (the risk the comment at issue.mjs:952
  already anticipates).
- Where work did survive, it rode under a sibling's unrelated commit message —
  atomicity and attribution both lost.

## Root cause

`dispatchFixes` (issue.mjs:612) guards **which files get edited** in parallel:

```js
const disjoint = files.every(Boolean) && new Set(files).size === files.length
```

But the index and HEAD are shared per-worktree. `git add -A`, `git reset`, and
`git commit` (which commits whatever is staged, regardless of who staged it)
are all repo-global. The fix prompt (issue.mjs:425) says only "in an atomic
commit … commit conventionally" — nothing about scoping the staging — so an
agent's default `git add -A` is the race. Resets issued to *undo* a sweep then
destroy sibling commits, which is how reported commits vanished.

The report-durability note at issue.mjs:642 already knows about this failure
mode ("a fixer's `git add -A` can never sweep it") — it protects the run's
bookkeeping file, but not the sibling agents' code.

## Fix: scope the staging in the prompt; per-agent worktrees are the wrong tool

Separate worktrees per fix agent would put each fix on its own branch and buy
an N-way merge problem; the run is building one branch. The commit path just
needs the same discipline the edit path already has.

Suggested `fixPrompt` addition (one paragraph):

> The worktree is shared with sibling agents fixing other files concurrently.
> NEVER `git add -A`, `git add .`, or `git commit -a` — stage and commit ONLY
> your own paths: `git add <your files>` then `git commit --only <your files>
> -m …` (`--only` commits exactly the named paths even if siblings have staged
> other files). Never `git reset` anything you did not stage, and never
> rewrite existing commits — if the index looks unexpected, commit your paths
> with `--only` and report the anomaly instead of cleaning it up.

`git commit --only <paths>` is the load-bearing part: it snapshots the named
paths directly, so a sibling's concurrently-staged files neither enter the
commit nor block it, and no reset is ever needed. That closes both the sweep
and the reset-destroys-sibling-commits failure in one rule.

Residuals worth knowing, probably acceptable:

- Two `--only` commits at the same instant still serialize on git's own index
  lock; one may retry. That's a transient error, not lost work — the prompt
  could mention "on an index.lock error, wait and retry".
- lefthook pre-commit (fmt/clippy) checks the whole tree, not the staged set,
  so a sibling's mid-edit state can fail a hook run for an innocent agent.
  Same shape: retry, don't reset. A commit mutex in the workflow (serialize
  just the commit step via a small semaphore around a `commitFiles()` helper)
  would eliminate both residuals if they show up in practice.

## Repro pointer

Full forensics: trawl issue #78 comments (runId `wf_c90dc56c-98b`), journal at
the run's transcript dir — the two fix-agent summaries quoted above are the
`query_merge.rs:205` and eventstats-lambda findings' results in
`journal.jsonl`.
