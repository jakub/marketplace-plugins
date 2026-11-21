---
name: issue
description: Implement one ready-for-agent issue hands-off, through a pushed, reviewed, evidenced PR, then hand it to babysit. Never merges. Use when the user asks to run a specific issue number. Never start it from a finished prep, a defect you found, or a survey.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Bash(node:*), Read, Edit, Write, TaskOutput, TaskStop, PushNotification, Agent, SendMessage, AskUserQuestion, Skill, mcp__plugin_flow_flow_delegate__delegate_to_codex, mcp__plugin_flow_flow_delegate__delegation_result, mcp__plugin_flow_flow_delegate__delegation_cancel, mcp__plugin_flow_flow_delegate__delegation_steer, mcp__plugin_flow_flow_delegate__delegation_doctor, mcp__t3-code__orchestrator_capabilities, mcp__t3-code__delegate_task, mcp__t3-code__task_status, mcp__t3-code__task_cancel, mcp__t3-code__t3_thread_send
---

# issue

If the user started this, they aren't watching. You own the issue from claim to a pushed, reviewed, evidenced PR, then hand it to `babysit`. You never merge and never retire the worktree (`land` owns both; a chain land grant lets `babysit` hand the clean PR to `land`). `reference.md`, next to this file, holds claim refusal/retry rules, early checkpoint review details and the 5-step suspension protocol.

You're the orchestrator. File scans, command output and diffs live in seats; decisions stay with you. Pick seats, models, parallelism and rounds per issue, and journal each choice.

## Who can start it

- The issue number in the invocation (`/flow:issue 42`, "run issue #42", or naming it in words),
- the user saying yes to a `prep` handoff,
- a starting prompt from `chain` (naming the issue, land grant or none, and claim flags).

A handoff line mentioning this stage isn't an invocation. A non-positive integer aborts cleanly. If `#N` appears inside an unrelated request, ask which they mean.

**Done** is an open PR, pushed, reviewed, evidenced and linked with `Closes #N`, handed directly to `babysit` without asking. The PR body leads with problem, fix, one changelog line per commit, `## Risk` (tier, why, tripwires, unchanged `- intended case:` line), and `## Revert` judged against the repo's data stance (with no stance, persisted-state changes aren't reversible).

BAD

> ❌ `## Revert` Revert the squash commit.

GOOD

> ✅ `## Revert` Not clean. `git revert` restores the code, but WAL segments this build wrote keep the new layout, and trawl is forward-only. Back up the WAL directory before upgrading. To roll back, stop trawld, restore that backup, then start the old build.

**Or** a clean escalation: `needs-info`, `needs-human` or `needs-rebase`, a comment saying what blocks, and a stop per `reference.md` §Suspending.

## 1. Preflight

Before changing or spawning anything, verify cross-lab delegation is reachable:

- **In T3 Code**, call `orchestrator_capabilities` and confirm the providers you need (`claudeAgent`, `codex`, and `antigravity` when using Neon) report `canRunCrossProviderChildTask: true`, plus write access to `<repo>/.flow-worktrees/`. Call `delegation_doctor` only if you need the `flow_delegate` fallback (Antigravity sessions don't load `flow_delegate`).
- **Outside T3 Code (Claude Code or Codex)**, call `delegation_doctor` and require `ok: true`, the canonical repo root in `roots`, and write grant covering `<repo>/.flow-worktrees/`.

If preflight fails, stop and write nothing (no label, comment or ping). Never mark a failed start `needs-human` (that blocks the next claim) and never write the code yourself because a seat couldn't start.

## 2. Claim

Assigning an issue isn't a claim: origin decides via a tag push owned by `scripts/issue-claim.mjs`. Run it from the canonical checkout:

```bash
node <plugin-root>/scripts/issue-claim.mjs claim <N> [--kind feat|fix|chore] [--expect-body <sha256>] [--require-ancestor <sha>]...
```

Pass any `--expect-body` and `--require-ancestor` flags from a `chain` prompt unchanged. On `claimed`, record `base`, `branch`, `worktree`, `head` and `acDigest` (judge the run against that AC snapshot) and post the pre-flight journal comment. For `refused`, `held` or `unknown` (including the 5 s / 15 s / 45 s retry rule), follow `reference.md` §Claim outcomes and retries.

## 3. Journal

Three kinds of issue comment, and no others:

1. **Pre-flight**, before work starts: base SHA, AC digest, risk tier, seats with models/efforts/why, and the CI suite mapping (inv.3).
2. **Events**, as they happen: tripwires, scope/model changes, guessed forks, fix-round totals, breaker trips, stale answers, and one triage line per review finding (reviewed head, title/location, basis, disposition, obligation/exclusion, reason, evidence link).
3. **Final**: verdict per criterion, and planned vs. actual reviewer coverage.

On any recovery, re-read live state; a journal line never authorizes a later action alone.

## 4. Design pass

Every `standard`, `high`, or chain-dependent run (even at `low`) gets one. A standalone `low` run skips it (still writing a checkpoint plan if >1 checkpoint). On chain dependents, both legs check the spec against every parent's merged diff; a conflict is `needs-info`. Start the native leg (smallest change, max reuse) and the other-family blind leg (own shape, unstated gaps) together, then synthesize out loud instead of averaging.

The checkpoint plan lists each checkpoint's id, owned files (inv.6), parents (premise checkpoints first), and difficulty (what could break, never file count). Match each checkpoint's domain to the charter roster instead of defaulting every slice to `Opus`: send tight-oracle slices and test fixtures to `Sonnet 5.5 high`, docs/writing checkpoints to `Neon 4 med` in T3, and defensive security/auth boundaries to `Mythos 5.2 xhigh` (cross-reviewed by `Daybreak Blue xhigh`). Split independent checkpoints onto parallel write lanes by default, and on chain runs weight picks on wall-clock `Min` for throughput.

- A checkpoint starts once every parent's commits passed inv.8's git check and its named checks are green on those commits.
- Done means committed and verified on the run branch, never merged.
- When a parent changes or a premise fails, pause or steer dependents with verified state (§6) and recheck each before counting it done. A failed premise whose decision is the user's goes to §8.
- Small mid-run shape question: fork (§8), journaled as `prep-gap`. Genuinely open design: `needs-info`, back through `prep`.

## 5. Invariants

1. **Review crosses families per diff.** Every written file is reviewed by at least one lab that didn't write it, so multi-lab PRs (such as `Opus` code plus `Neon` docs) cross-review each lab's files without requiring redundant full-diff sweeps from every lab.
2. **Someone tries to break it.** Brief every review per `babysit` §Rounds to refute, not summarize. Failing reviewer tests still go through triage; if a fixer believes a test encodes the wrong requirement, it says so instead of satisfying it.
3. **Unknown is not a pass.** CI is green only on a synced head (`local SHA == PR headRefOid`) that you read directly. Before pushing, run checkpoint tests and repo `AGENTS.md`/`CLAUDE.md` commands; leave remaining suites to CI only when pre-flight mapped the exact job and matrix, and run any skipped/path-filtered/unreadable CI job locally before counting the head validated. With no CI, run everything locally (`land` still refuses `ci-unknown`).
4. **Every criterion has reproducible evidence.** Each gets a verdict and a pointer in the PR evidence ledger runnable from the merged repo alone (test, script or committed artifact).
5. **Stop on evidence, not exhaustion.** Risk tier defaults to `standard`. `low` and `standard` converge on one clean cross-family adversarial pass; in T3 Code when `antigravity` is enabled, pair rounds 1 to 3 with `Gemini 4 Neon` in parallel as third POV (and narrow split lanes per `babysit` §Rounds). `high` needs two clean passes in a row from different seats, a security seat among them (`Neon` counts as an independent lab alongside a seated reviewer). The final pass must list every file read and skipped (continue `flow_delegate` jobs that omit it). Count fix rounds against `babysit` §Rounds' breaker (3 on `low`, 5 otherwise) and rounds 4 to 5 significance gate, journaling the running total after every batch. For optional early checkpoint review on multi-checkpoint runs, see `reference.md` §Early checkpoint review.
6. **One file, one writer.** Disjoint file ownership per concurrent writer; stage paths explicitly. Uncommitted scratch goes in `<wt>/.flow-scratch/` (git-ignored, retired by `land`), never `/tmp`. `flow_delegate` writers edit without committing (you verify, stage by path and commit); T3 writers commit with `git -C <wt> commit -- <paths>`.
7. **Refusals get routed.** Follow the charter's refusal rule on every judgment and security seat. A null counts as a refusal (retry crosses families; second null stops and reports). Record an unavailable security seat in the final journal.
8. **Seat reports are claims.** Verify every "done" or "blocked" with `git -C <wt> log` and `git -C <wt> status`. Nudge stalled seats with verified state; re-run a seat that fabricates twice on a stronger model or switch lab. Snapshot the tree with `tree-snapshot.mjs <wt>` before and after unseated reviews (including Antigravity); T3 `seat open --access review` / `seat close` pins and checks the detached review worktree automatically.

## 6. Seats

- **In T3 Code**, run Claude and Codex seats through `seat.mjs` + `delegate_task`, and Gemini 4 Neon through unseated `delegate_task` (`delegate` §T3 seats and §5). Act on `seat close` verdicts, never `summary`. `flow_delegate` is the cross-family fallback; native tools are the same-family fallback.
- **In Claude Code**, `flow:implementer` writes and `flow:reader` scouts/reviews; long or parallel `flow_delegate` calls go through `flow:bridge`. Use `SendMessage`, `TaskOutput`, `TaskStop`.
- **In Codex**, use native spawns (one checkpoint each); verify parents in git before dependents start, and `followup_task` finished seats with verified state.

## 7. Tripwires

Each raises the tier one step, forces a seat/round rethink, and gets journaled as an event (nothing ever lowers the tier mid-run):

- diff touches an unmentioned trust boundary (auth, parsing, shell/SQL/template construction, secrets) -> **`high` outright**;
- diff grows past ~2× planned file count;
- fix rounds churn on one area after re-triaging against the intended case;
- two families' reviewers disagree hard on the same code -> in T3 Code with `antigravity` enabled, ask `Gemini 4 Neon` cold as third-lab tie-breaker before escalating to the user.

## 8. Forks and escalation

Only genuinely user-owned decisions escalate: two defensible designs, a contested finding changing risk posture, or a scope question the issue can't settle.

- **Optional forks.** Remedies that expand approved responsibility, supported behavior or trust posture are never optional: ask first. Otherwise ask if you can get an answer in-turn; if asking ends the turn, decide, journal `fork guessed` (naming the rejected option and why), and continue.
- **Trust-model forks** (who can reach what, unattended read/publish authority, security posture) always go to the user, because reviewers ratify a coherent guess instead of contesting it. If asking ends the turn, take the conservative posture, journal it, label `needs-human`, and suspend.
- **Escalate early.** Blocking missing info becomes `needs-info` the moment you find it, not after guessing. Any `needs-info`, `needs-human`, trust-fork or breaker stop follows `reference.md` §Suspending in order.
