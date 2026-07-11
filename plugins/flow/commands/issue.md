---
description: Hands-off implementation of a ready-for-agent issue, through a pushed, reviewed, evidenced PR. Conductor for the flow-issue workflow.
argument-hint: <issue-number> [--impl-model sonnet|opus|fable] [--impl-effort low|medium|high|xhigh]
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Read, Write, Workflow, TaskOutput, PushNotification, Task, Agent
---

# /flow:issue — one run, through the PR

Middle of **prep → issue → land** (doctrine: `flow` skill, `framework.md` §1). You are the
CONDUCTOR: pre-flight, claim, launch, journal, result handling. The heavy lifting happens
inside the background workflow — do not re-implement its stages inline, and do not pollute
the main context with file contents that belong in the workflow's agents.

Argument: `$ARGUMENTS` = issue number, optionally followed by `--impl-model <m>` /
`--impl-effort <e>` to override the implementer seat (default: fable at `high` for
non-mechanical difficulty, sonnet for mechanical; the workflow clamps fable to
`high` effort and any non-fallback seat that refuses/dies re-runs on the
difficulty-routed opus/sonnet fallback).
Abort with usage if the first token is not a positive integer.

## 1. Pre-flight

1. `gh issue view $N --json number,title,body,labels,state,url`. Abort if closed, or if
   NOT labelled `ready-for-agent` (route to `/flow:prep $N` instead — the contract is the
   safety case; don't run cold on an unvalidated spec).
2. Repo sanity: on a clean checkout, `git fetch origin main`.

## 2. Claim — atomic

Check-and-set so concurrent runs (or a future cron) can't double-grab:

```bash
gh issue edit $N --add-label in-progress --add-assignee @me
gh issue view $N --json assignees,labels   # verify OUR claim landed; if another assignee/claim beat us, STOP
```

If already `in-progress` with a live worktree/branch (check `git worktree list`,
`gh pr list --head`), stop and surface the existing run instead of double-running.
**Snapshot the `## Acceptance Criteria` section text now** — the workflow judges against
this snapshot; body edits mid-run are detected at the end (step 5.4).

## 3. Launch

1. Worktree off origin/main: branch `feat/issue-$N-<slug>` (or fix/chore by issue type),
   `git worktree add ../<repo>-issue-$N origin/main -b <branch>`.
2. **Context pack** — paths, not contents: the issue's likely modules (quick greps), the
   relevant CONTEXT.md slices and ADR paths, the repo's build/test commands (from
   AGENTS.md). Keep it a pointer list; workflow agents explore for themselves.
3. Resolve the workflow script: `${CLAUDE_PLUGIN_ROOT}/workflows/issue.mjs` — if the
   variable is unavailable in this context, locate it:
   `ls ~/.claude/plugins/cache/flow/flow/*/workflows/issue.mjs | sort -V | tail -1`.
4. Launch via the Workflow tool with `scriptPath` and args:
   `{ issueNumber, issueTitle, issueBody, acceptanceCriteria, contextPack, worktree, branch, base: "origin/main", externalReviewers: ["coderabbitai"] }`,
   plus `implModel` / `implEffort` when the corresponding flags were given (omit otherwise —
   absent keys mean the workflow's defaults: fable/high, sonnet for mechanical).
5. **Stamp the runId** the tool result returns as an issue journal comment:
   `flow run started — runId <id>, worktree <path>, branch <branch>` — this is the
   recovery anchor for any future session.

## 4. While it runs

Nothing. Do not poll, do not narrate. The workflow notifies on completion. If YOU are
asked to stop/restart: `TaskStop`, then resume later with
`Workflow({scriptPath, resumeFromRunId})` (same session) or follow **Recovery** below.

## 5. Result handling

The workflow returns a structured result. In order:

0. **Handoff verification** — the result's `handoff` field is the workflow's FINAL read of
   the PR (CI rollup, late external reviews, Closes-link). `ciStatus: "pending"` → the last
   push's CI outlived the run: watch it to completion (background poll, re-read the
   rollup) and report the real verdict, never "green" on faith. `"red"` → diagnose before
   journaling: single pre-existing timing-shaped test → the land skill's rerun-once valve;
   anything else → treat as a real failure (fix on the branch or escalate `needs-human`).
   `handoff.finalSummary` is the branch state at close; earlier fields (`implSummary`,
   `implDeviations`) are mid-run snapshots — prefer `handoff` where they disagree. A
   missing/null `handoff` is itself UNKNOWN: do the rollup read yourself.
1. **Escalations** — each also fires a push notification (PushNotification: one line,
   issue #, valve, PR url if any):
   - `needs-info`: post the questions as an issue comment, label `needs-info`, remove
     `in-progress`, retire nothing (worktree may be reused after answers).
   - `needs-human`: label, comment the adjudicated-real blockers (`unresolvedBlocking`)
     with file:line. The PR exists — say so.
   - `needs-rebase`: label, comment; the PR exists with conflicts surfaced.
2. **Escape hatch** (`escapeHatch` non-empty): post ONE draft comment on the PR —
   `## follow-up draft (cross-crate scale — requires human ack at /flow:land)` with the
   systemic findings. Do NOT create an issue (the hook would block it anyway; filing
   happens at land, on ack).
3. **AC body-move check**: re-fetch the issue body; if `## Acceptance Criteria` differs
   from the launch snapshot, flag it prominently in the final comment — the run judged
   against the snapshot.
4. **Final journal comment** on the issue: outcome (PR #, url), plan goal + difficulty,
   fix rounds + adjudication summary, post-push triage counts (fixed/noise, external
   received/timed-out), dropped-low count, deviations. Terse table > prose.
5. **Report to the human**: one screenful — PR url, evidence-ledger state, anything
   dropped or dismissed, next step (`/flow:land <PR>` when happy).

Never merge. The worktree stays (land retires it).

## Recovery (cross-session)

The runId comment on the issue is the anchor. Same session: `resumeFromRunId`. Fresh
session: read the workflow journal
(`<transcriptDir>/journal.jsonl` if available) and the worktree state
(`git -C <wt> log origin/main..HEAD`, diff), then either resume via a continuation script
or re-launch with a context pack noting which stages' commits already exist — the
workflow's stages are idempotent-guarded by the review fabric (re-reviewing done work is
cheap; re-implementing it is not — say what exists).
