---
description: DEPRECATED - the fixed-pipeline predecessor of /flow:issue, conductor for workflows/issue-fixed.mjs. Kept as a fallback and parts library; run only when explicitly invoked.
argument-hint: <issue-number> [--impl-model sonnet|opus|fable] [--impl-effort low|medium|high|xhigh] [--codex-model <m>] [--codex-effort minimal|low|medium|high|xhigh|max] [--codex-fast]
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Read, Write, Workflow, TaskOutput, PushNotification, Task, Agent
---

# /flow:issue-fixed - the fixed pipeline (deprecated)

**DEPRECATED 2026-08-21.** The dynamic run - formerly `issue-beta` - was promoted to `/flow:issue` after the comparison PRs. This command and its workflow (`workflows/issue-fixed.mjs`) are kept as a fallback and as the parts library the dynamic run steals from (salvage pattern, envelope rules, schemas, push-verify prompts). Run it only when explicitly invoked as `/flow:issue-fixed`; no new behavior lands here.

/flow:issue-fixed runs the same middle leg of the **prep → issue → land** process as /flow:issue - hands-off to a pushed, reviewed, evidenced PR, stopping there - but through the fixed workflow instead of a composed fabric.

You are the CONDUCTOR, not the implementer. You do five things: pre-flight, claim, launch, journal, and handle the result. The actual work happens inside a background workflow full of agents you never see. Don't re-implement its stages inline, and don't pull file contents into this context - that reading belongs to the workflow's agents, and your context has to survive until the run comes home. The conductor can escalate to the human if a tripwire fires or a decision is needed.

The argument must be an issue number, optionally followed by seat overrides. Abort with usage if the first token isn't a positive integer.

- `--impl-model <m>` / `--impl-effort <e>` override the implementer seat. By default the workflow routes off the plan's difficulty: `mechanical` gets sonnet/medium, `standard` gets opus/medium, `hard` gets opus/xhigh. Note this ladder is the deprecated script's; `/flow:issue` routes `standard` to opus/high. A seat that refuses or dies re-runs one rung UP, or on the routed model if an override put a different one in.
- `--codex-model <m>` / `--codex-effort <e>` / `--codex-fast` override both codex seats - the design leg and the adversarial review. Both seats have a sensible default to `gpt-5.6-sol` at `high`, stated explicitly on every call - nothing is ever inherited from `~/.codex/config.toml`.

## Core principles

1) You conduct, the workflow implements. Your context is a budget that has to last the whole run, so keep file contents, greps, and command output out of it - pointers only.
2) The issue is the record. The runId comment you stamp at launch is what lets any future session pick this run back up, and the journal comment you write at the end is what a human reads to understand what happened.
3) A check that errored, timed out, or is still pending is UNKNOWN - never a pass. Never report green on faith; go read the rollup yourself.
4) Escalate rather than guess. Every valve (`needs-info`, `needs-human`, `needs-rebase`) is a real answer, and a thinned review fabric or a missing security seat gets SAID, not glossed.
5) Never merge, and never retire the worktree. The PR is where this command stops - `/flow:land` is the only merge path, and it cleans up after itself.

## 1. Pre-flight

1) `gh issue view $N --json number,title,body,labels,state,url`.
2) Abort if the issue is closed.
3) Abort if it is NOT labeled `ready-for-agent`, and route the user to `/flow:prep $N` instead. The contract is the safety case - don't run cold on a spec nobody validated.
4) Repo sanity: you should be on a clean checkout. `git fetch origin main`.

## 2. Claim - atomic

Claim the issue with a check-and-set, so two concurrent runs (or a future cron) can't grab the same one:

```bash
gh issue edit $N --add-label in-progress --add-assignee @me
gh issue view $N --json assignees,labels   # verify OUR claim landed; if another assignee/claim beat us, STOP
```

If it is already `in-progress` with a live worktree or branch behind it (`git worktree list`, `gh pr list --head`), stop and surface the existing run rather than double-running it.

**Snapshot the `## Acceptance Criteria` section text now.** The workflow judges the finished work against this snapshot, and §5.4 compares it back against the live body to catch a mid-run edit.

## 3. Launch

1) **Worktree** off origin/main, branch `feat/issue-$N-<slug>` (or `fix/` or `chore/` by issue type): `git worktree add ../<repo>-issue-$N origin/main -b <branch>`.

2) **Context pack - paths, not contents.** A quick grep for the modules this issue likely touches, the relevant `context.md` slices and ADR paths, and the build/test commands out of `AGENTS.md`. Keep it a pointer list; the workflow's agents explore for themselves, this just gives them hints.

3) **envNote** is a separate argument, not part of the pack. Read the repo's hook config (lefthook, husky, `pre-push`) and write one or two sentences on what runs at push time and which env exports it needs - a test suite that hard-requires `DATABASE_URL`, say. Omit the argument entirely when there is nothing to say. This is the only thing the push and gate agents get; they cannot infer it from a one-line prompt.

4) **Resolve the workflow script**: `${CLAUDE_PLUGIN_ROOT}/workflows/issue-fixed.mjs`. If that variable isn't available here, find it with `ls ~/.claude/plugins/cache/*/flow/*/workflows/issue-fixed.mjs | sort -V | tail -1`.

5) **Salvage hygiene**: `rm -rf /tmp/flow-issue-$N-reports` before launching. That directory name is deterministic, so a leftover report from an earlier run of the same issue would look salvageable and fresh when it is neither.

6) **Launch via the Workflow tool** with `scriptPath` and args:
   `{ issueNumber, issueTitle, issueBody, acceptanceCriteria, contextPack, envNote, worktree, branch, base: "origin/main", externalReviewers: ["coderabbitai"], pluginRoot: "${CLAUDE_PLUGIN_ROOT}", evidencePublic }`
   `evidencePublic` is simply whether the `evidence-public` label was on the issue in the labels you already read at pre-flight - a boolean, resolved here so the ledger never has to decide it. Absent label means `false`, and false means no capture on this run reaches the public host no matter what the acceptance criteria say.
   Add `implModel` / `implEffort` / `codexModel` / `codexEffort` / `codexFast` only when the matching flag was given - an absent key is what tells the workflow to use its own defaults. `pluginRoot` is how the codex legs find the codex-exec transport without globbing for it; if the variable didn't interpolate, pass the directory you resolved the script from in step 4.

7) **Stamp the runId** the tool result hands back, as a journal comment on the issue: `flow run started - runId <id>, worktree <path>, branch <branch>`. This is the recovery anchor for any future session.

## 4. While it runs

Nothing. Do not poll, do not narrate - the workflow notifies you when it is done.

If the *user* asks you to stop or restart: `TaskStop`, then pick it back up with `Workflow({scriptPath, resumeFromRunId})` in the same session, or follow **Recovery** below in a fresh one.

## 5. Result handling

The workflow returns a structured result. Work through it in this order.

### 5.0 Handoff verification

The `handoff` field is the workflow's FINAL read of the PR - head-sync guard, CI rollup, late external reviews, the Closes-link. A missing or null `handoff` is itself UNKNOWN: go do the rollup read yourself.

- **`headInSync: false`** means the PR tip on GitHub is not the work the run judged. Distrust `ciStatus` entirely. Either push the worktree branch yourself (the envNote you wrote names the hook exports; give it a long timeout, because pre-push hooks may run the full suite) or escalate `needs-human` with the divergence.
- **`ciStatus: "pending"` with `headInSync: true`** is the NORMAL state right after a repair push - the last push's CI outlived the run. Watch it to completion with a background poll, re-read the rollup, and report the real verdict.
- **`ciStatus: "red"`** gets diagnosed before you journal anything. A single pre-existing, timing-shaped test is what the land skill's rerun-once valve is for. Anything else is a real failure: fix it on the branch, or escalate `needs-human`.

`handoff.finalSummary` is the branch state at close. Earlier fields like `implSummary` and `implDeviations` are mid-run snapshots - where they disagree with `handoff`, `handoff` wins.

Escalation results carry push state too: `headPushed` on needs-rebase and needs-human, `postPush.pushed` on the post-push gate escalation. A false value means there are unpushed local commits sitting in the worktree - verify with `git ls-remote` before you act on anything.

### 5.1 Escalations

Each of these also fires a push notification (PushNotification: one line - issue #, which valve, PR url if there is one).

- **`needs-info`**: Post the questions as an issue comment, label `needs-info`, remove `in-progress`. Retire nothing - the worktree may get reused once the answers land.
- **`needs-human`**: Label it, then comment the adjudicated-real blockers (`unresolvedBlocking`) with `file:line`. The PR exists - say so.
- **`needs-rebase`**: Label and comment. The PR exists, with the conflicts surfaced.

### 5.2 Unreviewed-security gate

If `securityReviewUnavailable: true`, no security seat produced a result on either model family. This diff is NOT security-reviewed, and the empty finding set is absence of evidence, not evidence of absence. Say exactly that - in the final report AND in the journal comment, in those words. Do not let it read as a clean pass.

If the diff touches a trust boundary - auth, input parsing, shell/SQL/template construction, secret handling - escalate `needs-human` instead of handing it to /flow:land.

### 5.3 Escape hatch (follow up issue suggestions)

If `escapeHatch` is non-empty, post ONE draft comment on the PR headed `## follow-up draft (cross-crate scale - requires human ack at /flow:land)`, carrying the systemic findings. Do NOT create an issue - the hook would block it anyway, and filing happens at land, on human ack.

### 5.4 AC body-move check

Re-fetch the issue body. If `## Acceptance Criteria` differs from the snapshot you took at claim, flag it prominently in the final comment: the run judged against the snapshot, not against what is there now.

### 5.5 Final journal comment

On the issue. A terse table beats prose. It carries:

- Outcome - PR number and url.
- The plan's goal and difficulty.
- **Review coverage** - `coverage.reviewsDelivered` of `coverage.reviews.length` lenses, by name. A run judged by a thinned fabric is not the same evidence as one judged by a full fabric, and the human at land cannot infer that from the finding count.
- Fix rounds, and the adjudication summary.
- Post-push triage counts: fixed vs noise, external reviews received vs timed out.
- Dropped-low count, and any deviations.

### 5.6 Report to the human

One screenful: PR url, evidence-ledger state, anything dropped or dismissed, and the next step (`/flow:land <PR>` when they are happy with it).

## Recovery (cross-session)

The runId comment on the issue is the anchor.

Same session, just `resumeFromRunId`. In a fresh session, read the workflow journal (`<transcriptDir>/journal.jsonl` if it is available) and the worktree state (`git -C <wt> log origin/main..HEAD`, and the diff), then either resume through a continuation script or re-launch with a context pack that says which stages' commits already exist. The stages are idempotent-guarded by the review fabric - re-reviewing finished work is cheap, re-implementing it is not, so say what exists.
