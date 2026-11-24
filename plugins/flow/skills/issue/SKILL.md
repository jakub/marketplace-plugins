---
name: issue
description: Implement one ready-for-agent issue hands-off, through a pushed, reviewed, evidenced PR, then hand it to babysit. Never merges. Use when the user asks to run a specific issue number. Never start it from a finished prep, a defect you found, or a survey.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Bash(node:*), Read, Edit, Write, TaskOutput, TaskStop, PushNotification, Agent, SendMessage, AskUserQuestion, Skill, mcp__plugin_flow_flow_delegate__delegate_to_codex, mcp__plugin_flow_flow_delegate__delegation_result, mcp__plugin_flow_flow_delegate__delegation_cancel, mcp__plugin_flow_flow_delegate__delegation_steer, mcp__plugin_flow_flow_delegate__delegation_doctor, mcp__t3-code__orchestrator_capabilities, mcp__t3-code__delegate_task, mcp__t3-code__task_status, mcp__t3-code__task_cancel, mcp__t3-code__t3_thread_send
---

# issue

If the user triggered this, they aren't watching. You own the issue from claim through a pushed, reviewed, evidenced PR, then hand it straight to `babysit`. You never merge and never retire the worktree (`land` owns both; a chain land grant lets `babysit` hand the clean PR to `land`). See `reference.md` beside this file for claim refusal and retry rules, early checkpoint review details, and the 5-step suspension protocol.

You're the orchestrator. Keep file scans, command output, and diffs inside seats, and keep decisions in the main thread. Choose seats, models, parallelism, and review rounds for each issue and journal those choices.

## Who can start it

- An explicit issue number (`/flow:issue 42`, "run issue #42", or naming it in words).
- The user saying yes to a `prep` hand-off.
- A `chain` starting prompt naming the issue, any land grant, and claim flags.

A hand-off line that merely mentions this stage isn't an invocation. Abort cleanly on any non-positive integer. If `#N` appears inside an unrelated request, ask which one the user means.

**Done** means an open PR that is pushed, reviewed, evidenced, linked with `Closes #N`, and handed directly to `babysit` without asking. Lead the PR body with the problem, the fix, one changelog line per commit, `## Risk` (tier, why, any tripwires, and the unchanged `- intended case:` line), and `## Revert` judged against the repo's data stance (with no stated stance, treat persisted-state changes as not cleanly reversible).

BAD

> ❌ `## Revert` Revert the squash commit.

GOOD

> ✅ `## Revert` Not clean. `git revert` restores the code, but WAL segments written by this build keep the new layout, and trawl is forward-only. Back up the WAL directory before upgrading. To roll back, stop trawld, restore the backup, and start the old build.

**Escalation** is the other valid exit: label `needs-info`, `needs-human`, or `needs-rebase`, comment what's blocking, and stop per `reference.md` §Suspending.

## 1. Preflight

Before modifying anything or spawning seats, verify that cross-lab delegation works:

- **In T3 Code**, call `orchestrator_capabilities` and confirm every provider you need (`claudeAgent`, `codex`, and `antigravity` when using `Neon`) reports `canRunCrossProviderChildTask: true`, with write access to `<repo>/.flow-worktrees/`. Call `delegation_doctor` only if you need the `flow_delegate` fallback (Antigravity sessions don't load `flow_delegate`).
- **Outside T3 Code (Claude Code or Codex)**, call `delegation_doctor` and require `ok: true`, the canonical repo root in `roots`, and a write grant covering `<repo>/.flow-worktrees/`.

If preflight fails, stop without writing anything (no label, comment, or ping). Never label a failed start `needs-human` (that blocks the next claim), and never write the code yourself just because a seat couldn't start.

## 2. Claim

GitHub assignment isn't a claim. Origin decides ownership via a tag push handled by `scripts/issue-claim.mjs`, run from the canonical checkout:

```bash
node <plugin-root>/scripts/issue-claim.mjs claim <N> [--kind feat|fix|chore] [--expect-body <sha256>] [--require-ancestor <sha>]...
```

Pass any `--expect-body` and `--require-ancestor` flags from a `chain` prompt unchanged. On `claimed`, record `base`, `branch`, `worktree`, `head`, and `acDigest` (judge the run against that acceptance-criteria snapshot) and post the pre-flight journal comment. For `refused`, `held`, or `unknown` (including the 5 s / 15 s / 45 s retry schedule), follow `reference.md` §Claim outcomes and retries.

## 3. Journal

Post only three kinds of issue comments:

1. **Pre-flight** (before work starts): base SHA, AC digest, risk tier, planned seats with models, efforts, and reasons, and the CI suite mapping (inv.3).
2. **Events** (as they occur): tripwires, scope or model changes, guessed forks, fix-round totals, breaker trips, stale answers, and one triage line per review finding (reviewed head, title and location, basis, disposition, obligation or exclusion, reason, and evidence link).
3. **Final**: verdict per acceptance criterion, plus planned versus actual reviewer coverage.

After any interruption or recovery, re-read live state. A journal entry never authorizes a later action on its own.

## 4. Design pass

Run a design pass for every `standard`, `high`, or chain-dependent issue (even at `low`). A standalone `low` issue skips it, though you still write a checkpoint plan if there's more than one checkpoint. On chain-dependent runs, every leg checks the spec against every parent's merged diff, and any conflict escalates as `needs-info`. Launch the native leg (smallest change, maximum reuse) and an independent other-family leg (own shape, unstated gaps) together, plus `Neon 4 high` (`Neon 4 xhigh` on `high` risk) as a third independent leg in T3 Code when `antigravity` is enabled. Synthesize the proposals explicitly instead of averaging them.

Your checkpoint plan lists each checkpoint's id, owned files (inv.6), parent checkpoints (premise checkpoints first), and difficulty based on what could break rather than file count. Match each checkpoint to the charter roster instead of defaulting every slice to `Opus`: send well-tested slices and test fixtures to `Sonnet 5.5 high`, technical writing, docs, and ADRs to `Neon 4 med` in T3 (`Fable` outside T3), and defensive security or auth boundaries to `Mythos 5.2 xhigh` (cross-reviewed by `Daybreak Blue xhigh`). Run independent checkpoints in parallel write lanes by default, and favor lower `Min` on chain runs for throughput.

- Start a checkpoint only after every parent's commits pass inv.8's git check and its named checks are green on those commits.
- A checkpoint is done when it's committed and verified on the run branch, never merged.
- If a parent changes or a premise fails, pause or steer dependent seats with verified state (§6) and re-verify each before counting it done. If a failed premise requires a user decision, go to §8.
- Treat a small mid-run shape question as a fork (§8) journaled as `prep-gap`. Send a genuinely open design back through `prep` as `needs-info`.

## 5. Invariants

1. **Cross-family review per diff.** Every modified file is reviewed by at least one model family that didn't write it. Multi-lab PRs (such as `Opus` code with `Neon` docs) cross-review each lab's files without requiring redundant full-diff sweeps from every lab.
2. **Adversarial review.** Brief every reviewer per `babysit` §Rounds to try to break the change, not summarize it, and to flag any added comment that lacks a solid one-line justification or belongs in code or an ADR instead. Failing tests written by a reviewer still go through triage. If a fixer thinks a test encodes the wrong requirement, it says so instead of blindly satisfying it.
3. **Verify checks on the synced head.** CI counts as green only on a synced head (`local SHA == PR headRefOid`) that you read directly. Before pushing, run checkpoint tests and the commands in the repo's `AGENTS.md`/`CLAUDE.md`. Leave remaining suites to CI only if pre-flight mapped the exact job and matrix, and run any skipped, path-filtered, or unreadable CI job locally before calling the head validated. If the repo has no CI, run everything locally (`land` still refuses `ci-unknown`).
4. **Reproducible evidence per criterion.** Every acceptance criterion gets a verdict and a pointer in the PR evidence ledger that runs from the merged repo alone (a test, script, or committed artifact).
5. **Converge on clean passes within the breaker.** Risk tier defaults to `standard`. `low` and `standard` converge on one clean cross-family adversarial pass. In T3 Code when `antigravity` is enabled, pair rounds 1 to 3 with `Gemini 4 Neon` in parallel as a third perspective (alongside narrow split lanes per `babysit` §Rounds). `high` requires two clean passes in a row from different seats, including a security seat (`Neon` counts as an independent lab alongside a seated reviewer). The final pass must list every file read and skipped (continue `flow_delegate` jobs that leave this out). Count fix batches against `babysit` §Rounds' breaker (3 on `low`, 5 otherwise) and apply the rounds 4 to 5 significance gate, journaling the running total after every batch. For optional early checkpoint review on multi-checkpoint runs, see `reference.md` §Early checkpoint review.
6. **One writer per file.** Give concurrent writers disjoint file ownership and stage paths explicitly. Put uncommitted scratch in `<wt>/.flow-scratch/` (git-ignored and retired by `land`), never `/tmp`. `flow_delegate` writers edit without committing (you verify, stage by path, and commit); T3 writers commit with `git -C <wt> commit -- <paths>`.
7. **Route refusals cleanly.** Follow the charter's refusal rule on every judgment and security seat. Treat a null response as a refusal: retry across model families, and stop and report on a second null. Note any unavailable security seat in the final journal.
8. **Verify seat reports against git.** Check every "done" or "blocked" report with `git -C <wt> log` and `git -C <wt> status`. Nudge stalled seats with verified state, and re-run a seat that fabricates twice on a stronger model or different lab. Snapshot the worktree with `tree-snapshot.mjs <wt>` before and after unseated reviews (including Antigravity). T3 `seat open --access review` and `seat close` pin and check the detached review worktree automatically.

## 6. Seats

- **In T3 Code**, run Claude and Codex seats through `seat.mjs` + `delegate_task`, and `Gemini 4 Neon` through unseated `delegate_task` (`delegate` §T3 seats and §5). Act on `seat close` verdicts, never on `summary`. Fall back to `flow_delegate` across families and native tools within the same family.
- **In Claude Code**, `flow:implementer` writes and `flow:reader` scouts or reviews. Route long or parallel `flow_delegate` calls through `flow:bridge`, and manage seats with `SendMessage`, `TaskOutput`, and `TaskStop`.
- **In Codex**, use native spawns (one per checkpoint), verify parent commits in git before starting dependents, and use `followup_task` with verified state on finished seats.

## 7. Tripwires

Each tripwire raises the risk tier by one step, triggers a seat and round rethink, and gets journaled as an event. Nothing ever lowers the tier mid-run.

- Touching an unmentioned trust boundary (auth, parsing, shell/SQL/template construction, secrets) jumps the tier straight to **`high`**.
- The diff grows past roughly 2× the planned file count.
- Fix rounds keep churning on the same area even after re-triaging against the intended case.
- Reviewers from two families strongly disagree on the same code. In T3 Code with `antigravity` enabled, bring in `Gemini 4 Neon` cold as a third-lab tie-breaker before escalating to the user.

## 8. Forks and escalation

Escalate only genuinely user-owned decisions: two defensible designs, a contested finding that changes risk posture, or a scope question the issue doesn't settle.

- **Optional forks.** Remedies that expand approved responsibility, supported behavior, or trust posture are never optional, so ask first. Otherwise ask if you can get an answer in-turn. If asking would end the turn, make the call, journal `fork guessed` (naming the rejected option and why), and continue.
- **Trust-model forks.** Questions about who can reach what, unattended read or publish authority, or security posture always go to the user, because reviewers tend to ratify a coherent guess instead of challenging it. If asking would end the turn, take the conservative option, journal it, label `needs-human`, and suspend.
- **Escalate early.** Label blocking missing info `needs-info` as soon as you hit it instead of guessing. Every `needs-info`, `needs-human`, trust-fork, or breaker stop follows `reference.md` §Suspending in order.
