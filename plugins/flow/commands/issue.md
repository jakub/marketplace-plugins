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
`--impl-effort <e>` to override the implementer seat (default: effort routed by the plan's
difficulty — mechanical `sonnet/medium`, standard `opus/medium`, hard `opus/xhigh`; the
workflow clamps an explicit `--impl-model fable` to `high`, and a seat that refuses/dies
re-runs one rung UP, or on the routed model when an override put a different one in).
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
   relevant context.md slices and ADR paths, the repo's build/test commands (from
   AGENTS.md). Keep it a pointer list; workflow agents explore for themselves.
   **envNote** (separate arg, not part of the pack): read the repo's hook config
   (lefthook/husky/pre-push) — what runs on push and which env exports it needs (e.g. a
   test suite that hard-requires `DATABASE_URL`). One or two sentences; omit the arg
   entirely when there is nothing to say. This is what the push/gate agents get — they
   cannot infer it from a one-line prompt.
3. Resolve the workflow script: `${CLAUDE_PLUGIN_ROOT}/workflows/issue.mjs` — if the
   variable is unavailable in this context, locate it:
   `ls ~/.claude/plugins/cache/flow/flow/*/workflows/issue.mjs | sort -V | tail -1`.
   Salvage hygiene: `rm -rf /tmp/flow-issue-$N-reports` before launch — the workflow's
   report-salvage dir is deterministic, and a stale file from an earlier run of the same
   issue must not be salvageable as fresh.
4. Launch via the Workflow tool with `scriptPath` and args:
   `{ issueNumber, issueTitle, issueBody, acceptanceCriteria, contextPack, envNote, worktree, branch, base: "origin/main", externalReviewers: ["coderabbitai"] }`,
   plus `implModel` / `implEffort` when the corresponding flags were given (omit otherwise —
   absent keys mean the workflow's defaults: difficulty-routed, see the argument note above).
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
   the PR (head-sync guard, CI rollup, late external reviews, Closes-link).
   `headInSync: false` → the PR tip on GitHub is NOT the work the run judged: distrust
   `ciStatus` entirely, push the worktree branch yourself (the envNote you built names the
   hook exports; use a long timeout — pre-push hooks may run the full suite) or escalate
   `needs-human` with the divergence. `ciStatus: "pending"` with `headInSync: true` is the
   NORMAL state right after a repair push → the last push's CI outlived the run: watch it
   to completion (background poll, re-read the rollup) and report the real verdict, never
   "green" on faith. `"red"` → diagnose before
   journaling: single pre-existing timing-shaped test → the land skill's rerun-once valve;
   anything else → treat as a real failure (fix on the branch or escalate `needs-human`).
   `handoff.finalSummary` is the branch state at close; earlier fields (`implSummary`,
   `implDeviations`) are mid-run snapshots — prefer `handoff` where they disagree. A
   missing/null `handoff` is itself UNKNOWN: do the rollup read yourself.
   Escalation results carry push state too (`headPushed` on needs-rebase/needs-human,
   `postPush.pushed` on the post-push gate escalation): a false value means unpushed
   local commits exist in the worktree — verify with `git ls-remote` before acting.
1. **Escalations** — each also fires a push notification (PushNotification: one line,
   issue #, valve, PR url if any):
   - `needs-info`: post the questions as an issue comment, label `needs-info`, remove
     `in-progress`, retire nothing (worktree may be reused after answers).
   - `needs-human`: label, comment the adjudicated-real blockers (`unresolvedBlocking`)
     with file:line. The PR exists — say so.
   - `needs-rebase`: label, comment; the PR exists with conflicts surfaced.
1.5. **Unreviewed-security gate** (`securityReviewUnavailable: true`): no security seat
   produced a result on either model family — this diff is NOT security-reviewed, and the
   empty finding set is absence of evidence, not evidence of absence. Say so in the final
   report AND in the journal comment, in those words. Do not let it read as a clean pass.
   On a diff that touches a trust boundary (auth, input parsing, shell/SQL/template
   construction, secret handling), escalate `needs-human` rather than handing it to /land.
2. **Escape hatch** (`escapeHatch` non-empty): post ONE draft comment on the PR —
   `## follow-up draft (cross-crate scale — requires human ack at /flow:land)` with the
   systemic findings. Do NOT create an issue (the hook would block it anyway; filing
   happens at land, on ack).
3. **AC body-move check**: re-fetch the issue body; if `## Acceptance Criteria` differs
   from the launch snapshot, flag it prominently in the final comment — the run judged
   against the snapshot.
4. **Final journal comment** on the issue: outcome (PR #, url), plan goal + difficulty,
   **review coverage** (`coverage.reviewsDelivered` of `coverage.reviews.length` lenses, by
   name — a run judged by a thinned fabric is not the same evidence as a full one, and the
   human at land cannot infer it from the finding count), fix rounds + adjudication summary,
   post-push triage counts (fixed/noise, external received/timed-out), dropped-low count,
   deviations. Terse table > prose.
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
