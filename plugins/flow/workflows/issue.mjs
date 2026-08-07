export const meta = {
  name: 'flow-issue',
  description: 'flow issue pipeline: design fan-out → synthesis → TDD → review fabric → fix loop → PR → post-push reviews (self ∥ external) → evidence ledger',
  phases: [
    { title: 'Size', detail: 'coarse triage → design/review fabric allocation' },
    { title: 'Design', detail: 'minimal ∥ clean ∥ codex, in parallel' },
    { title: 'Synthesize', detail: 'one plan + difficulty routing', model: 'fable' },
    { title: 'Implement', detail: 'TDD; fable default (opus/sonnet fallback; impl seat overridable via args)' },
    { title: 'Review', detail: 'build gate + adversarial/correctness/security/simplify + AC evidence check' },
    { title: 'Fix', detail: '≤3 rounds; parallel over disjoint files; codex re-verify; fable adjudication' },
    { title: 'PR', detail: 'doc-sync, rebase, push, open PR' },
    { title: 'PostPush', detail: 'complementary lenses ∥ external reviewers → fable triage → fix round' },
    { title: 'Ledger', detail: 'per-AC evidence ledger on the PR' },
    { title: 'Handoff', detail: 'head-sync guard + final CI rollup + Closes-link + late-external read' },
  ],
}

// ── tunables ────────────────────────────────────────────────────────────────
const FIX_ROUND_CAP = 3
const EXTERNAL_WAIT_MINUTES = 15 // post-push cap on waiting for coderabbit et al. (Handoff re-checks once more at close)

// Design/review breadth by size. Judgment seats (synthesis, adjudication, triage) sit on
// fable for anything non-trivial; trivial synthesis stays on opus — the fan-out is already
// two designs and the decision space is small.
const FABRIC = {
  trivial: { designs: ['minimal', 'codex'],          synthModel: 'opus',  reviews: ['correctness', 'security'] },
  small:   { designs: ['minimal', 'codex'],          synthModel: 'fable', reviews: ['codex', 'correctness', 'simplify', 'security'] },
  medium:  { designs: ['codex', 'minimal', 'clean'], synthModel: 'fable', reviews: ['codex', 'correctness', 'simplify', 'security'] },
  large:   { designs: ['codex', 'minimal', 'clean'], synthModel: 'fable', reviews: ['codex', 'correctness', 'simplify', 'security'] },
}

// args (passed by /flow:issue after pre-flight + claim + worktree creation):
//   { issueNumber, issueTitle, issueBody, acceptanceCriteria, contextPack, worktree,
//     branch, base, externalReviewers?, implModel?, implEffort?, envNote? }
// May arrive as a parsed object OR a JSON-encoded string; parse defensively.
// implModel/implEffort override the impl seat (default since 2026-07-11: fable/high for
// non-mechanical difficulty — slice-C trial worked well; mechanical stays sonnet per the
// charter's routing). A null result from any seat other than the difficulty-routed
// opus/sonnet fallback (safety-classifier refusal or terminal error) re-runs on that
// fallback, so neither an override experiment nor fable roulette can lose the run.
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const WT = A.worktree
const BASE = A.base || 'origin/main'
const EXTERNAL_BOTS = A.externalReviewers || ['coderabbitai']

const sentinel = (s) => { const v = (s || '').trim(); return v && !/^(none|n\/a|null|nil|no)\.?$/i.test(v) ? v : '' }

// envNote: repo-specific environment the push/gate agents cannot infer from a one-line
// prompt — e.g. exports a pre-push hook's test suite needs (the wf_512af7b9 false-green:
// hook needed DATABASE_URL, bare push agent didn't have it). Empty → adds nothing.
const ENV_NOTE = sentinel(A.envNote)
  ? `\nEnvironment note (hooks/tests need this — e.g. exports required by pre-push hooks): ${sentinel(A.envNote)}`
  : ''

const CODEX_LOCATE = `COMPANION=$(ls ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null | sort -V | tail -1)`

// ── schemas ─────────────────────────────────────────────────────────────────
const SIZE = {
  type: 'object', additionalProperties: false,
  required: ['size', 'expectedFiles', 'rationale'],
  properties: {
    size: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
    expectedFiles: { type: 'integer' },
    rationale: { type: 'string' },
  },
}

const DESIGN = {
  type: 'object', additionalProperties: false,
  required: ['approach', 'files', 'keyDecisions', 'testStrategy', 'risks', 'blockingAmbiguity'],
  properties: {
    approach: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    keyDecisions: { type: 'string' },
    testStrategy: { type: 'string' },
    risks: { type: 'string' },
    blockingAmbiguity: { type: 'string', description: 'empty if none; else the question issue+code cannot resolve' },
  },
}

const PLAN = {
  type: 'object', additionalProperties: false,
  required: ['goal', 'approach', 'difficulty', 'files', 'milestones', 'testPlan', 'risks', 'blockingAmbiguity'],
  properties: {
    goal: { type: 'string' },
    approach: { type: 'string' },
    difficulty: {
      type: 'string', enum: ['mechanical', 'standard', 'hard'],
      description: 'mechanical: pure transcription of a complete spec. standard: normal judgment. hard: subtle invariants, concurrency, or wide blast radius.',
    },
    files: { type: 'array', items: { type: 'string' } },
    milestones: { type: 'array', items: { type: 'string' } },
    testPlan: { type: 'string' },
    risks: { type: 'string' },
    blockingAmbiguity: { type: 'string' },
  },
}

const IMPL_RESULT = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'deviations'],
  properties: {
    summary: { type: 'string', description: 'what was built + the atomic commits made' },
    deviations: { type: 'string' },
  },
}

const FINDING = {
  type: 'object', additionalProperties: false,
  required: ['severity', 'title', 'file', 'line', 'detail', 'systemic', 'confidence'],
  properties: {
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    confidence: { type: 'integer', description: 'is-it-real, 0-100 per the reviewer rubric: 50 = inferred from reading, 75 = double-checked against the code paths, 100 = demonstrated by execution' },
    title: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    detail: { type: 'string' },
    systemic: { type: 'boolean', description: 'true ONLY for cross-crate-refactor-scale work that cannot fit this PR (escape-hatch candidate)' },
  },
}
const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: FINDING } },
}

// UNKNOWN ≠ pass: a gate that errored/rate-limited is its own state, never green.
const GATE = {
  type: 'object', additionalProperties: false, required: ['status', 'output'],
  properties: {
    status: { type: 'string', enum: ['passed', 'failed', 'unknown'] },
    output: { type: 'string', description: 'tail of failing output, or why the result is unknown' },
  },
}

const AC_CHECK = {
  type: 'object', additionalProperties: false,
  required: ['criteria', 'scopeCreep'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['criterion', 'status', 'evidence', 'detail'],
        properties: {
          criterion: { type: 'string' },
          status: { type: 'string', enum: ['met', 'unmet', 'unknown'] },
          evidence: { type: 'string', description: 'the concrete pointer: test name + result, command + output, file:line' },
          detail: { type: 'string' },
        },
      },
    },
    scopeCreep: { type: 'array', items: { type: 'string' } },
  },
}

const ADJUDICATION = {
  type: 'object', additionalProperties: false,
  required: ['realBlockers', 'dismissed'],
  properties: {
    realBlockers: { type: 'array', items: FINDING },
    dismissed: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'reason'],
        properties: { title: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
}

const PR_INFO = {
  type: 'object', additionalProperties: false,
  required: ['prNumber', 'prUrl', 'rebased', 'conflict', 'headPushed', 'closesLinked'],
  properties: {
    prNumber: { type: 'integer' },
    prUrl: { type: 'string' },
    rebased: { type: 'boolean' },
    conflict: { type: 'boolean', description: 'true if rebase onto base hit conflicts (branch pushed un-rebased)' },
    headPushed: { type: 'boolean', description: 'observed after the push: git ls-remote sha for the branch equals local HEAD — never inferred from push exit status alone' },
    closesLinked: { type: 'boolean', description: 'closingIssuesReferences contains the issue, verified after creation' },
  },
}

const PUSH_RESULT = {
  type: 'object', additionalProperties: false,
  required: ['pushed', 'headSha', 'remoteSha', 'note'],
  properties: {
    pushed: { type: 'boolean', description: 'true ONLY when observed after the push: local HEAD sha equals the ls-remote sha for the branch' },
    headSha: { type: 'string' },
    remoteSha: { type: 'string', description: 'empty when unreadable' },
    note: { type: 'string', description: 'on failure: exact tail of the push/hook output, not a paraphrase; empty on clean success' },
  },
}

const HANDOFF = {
  type: 'object', additionalProperties: false,
  required: ['ciStatus', 'ciDetail', 'headInSync', 'lateExternalItems', 'closesLinked', 'finalSummary'],
  properties: {
    ciStatus: { type: 'string', enum: ['green', 'red', 'pending', 'unknown'] },
    headInSync: { type: 'boolean', description: 'observed: local worktree HEAD sha equals the PR headRefOid, after any step-0 repair push' },
    localAhead: { type: 'integer', description: 'commits local HEAD is ahead of the PR head at final read; 0 when in sync' },
    ciDetail: { type: 'string', description: 'failing/pending check names + one-line cause; empty when green' },
    lateExternalItems: { type: 'integer', description: 'substantive external-bot items visible now that the poll window missed' },
    closesLinked: { type: 'boolean', description: 'closingIssuesReferences references the issue, after any repair' },
    finalSummary: { type: 'string', description: 'the branch as it exists NOW: commit count, diffstat headline, notable post-implementation changes' },
  },
}

const EXTERNAL = {
  type: 'object', additionalProperties: false,
  required: ['items', 'receivedAny', 'timedOut'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['author', 'kind', 'body', 'path', 'line', 'headSha'],
        properties: {
          author: { type: 'string' },
          kind: { type: 'string', enum: ['review', 'thread'] },
          body: { type: 'string' },
          path: { type: 'string' },
          line: { type: 'integer' },
          headSha: { type: 'string', description: 'commit the comment anchors to; empty if unknown' },
        },
      },
    },
    receivedAny: { type: 'boolean' },
    timedOut: { type: 'boolean' },
  },
}

const TRIAGE = {
  type: 'object', additionalProperties: false,
  required: ['fixes', 'noise'],
  properties: {
    fixes: { type: 'array', items: FINDING },
    noise: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'reason'],
        properties: { title: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
}

const DONE = {
  type: 'object', additionalProperties: false, required: ['done', 'note'],
  properties: { done: { type: 'boolean' }, note: { type: 'string' } },
}

// ── prompt builders ──────────────────────────────────────────────────────────
const here = `All work happens in the worktree at ${WT}. Keep the persistent shell rooted in the main repo — never use a bare \`cd ${WT}\` prefix. For shell commands wrap the cd in a subshell: \`(cd ${WT} && <cmd>)\`; or use \`git -C ${WT} …\`. For Read/Edit/Glob use absolute paths under ${WT}. (A "Shell cwd was reset to …" notice is expected, benign harness behaviour — never a broken tool channel or a reason to stop.)`

const transientRule = `If a command fails transiently (rate limit, 401/5xx, network), retry up to 3 times with backoff. If you still cannot get a definitive result, report status "unknown" with the reason — NEVER report a pass you did not observe.`

const sizePrompt = `Classify the IMPLEMENTATION size of issue #${A.issueNumber} — coarse triage, not a design.
${here}
${A.contextPack}

Buckets: trivial (one file, mechanical/test-only) · small (1-2 files, contained, obvious shape) · medium (3-6 files or non-obvious design) · large (cross-cutting / new subsystem / migration).
When torn, pick the smaller unless there is a genuine design decision to make.`

const architectPrompt = (framing) => `Design the architecture for issue #${A.issueNumber}.
${here}
Framing: ${framing === 'minimal'
  ? 'the SMALLEST change that satisfies the issue, maximum reuse of existing code.'
  : 'the best long-term design — elegant abstractions, new structure where it pays off.'}

Context pack (explore independently from these pointers — Read referenced files, follow imports, run your own greps):
${A.contextPack}

Propose ONE concrete approach. Flag deviations from existing patterns and any ambiguity the issue + code cannot resolve.`

const codexDesignPrompt = `Run EXACTLY this, then return codex's design verbatim as your "approach" (fill the other fields from it):
${CODEX_LOCATE} && node "$COMPANION" task --cwd "${WT}" --effort high <<'PROMPT'
You are designing feature architecture for issue #${A.issueNumber} in ${WT}.
${A.contextPack}
Explore the referenced paths and the code they lead to before designing. Propose ONE concrete approach:
files to create/modify, key type/module decisions, data flow, error handling, test strategy.
Flag risks and pattern deviations. Long-term maintainability focus. Read-only — write NO files.
PROMPT
If codex produces no design for ANY reason (companion not found, CLI error, timeout), set
approach to exactly "CODEX_UNAVAILABLE: <one-line reason>" and leave every other field empty —
never fill the schema with a design codex did not write.`

const synthesizePrompt = (designs, panelNote) => `Synthesize ${designs.length} independent designs for issue #${A.issueNumber} into ONE plan.${panelNote}
${here}

Issue body:
${A.issueBody}

Acceptance criteria (the contract the run will be measured against):
${A.acceptanceCriteria || '(none stated — weak signal; consider blockingAmbiguity)'}

The designs:
${JSON.stringify(designs, null, 2)}

Synthesis rule: default to the MINIMAL-change design; switch to the CLEAN design where minimal
violates a documented decision (docs/adr/, context.md — Read them when present). Cross-model
disagreement (codex vs claude legs) is signal: resolve it explicitly in "approach", don't average it.

Assign "difficulty" honestly — it routes the implementer (mechanical→sonnet, standard→opus high,
hard→opus xhigh). Break work into ordered milestones the implementer commits atomically.
Set blockingAmbiguity ONLY for a blocker that issue+code+docs genuinely cannot settle.`

const implPrompt = (plan) => `Implement issue #${A.issueNumber} against the plan, strict TDD (red → green → refactor).
${here}

Plan:
${JSON.stringify(plan, null, 2)}

Rules:
- Milestones in order: failing test FIRST, minimum code to pass, refactor.
- Run the project's test command to see red→green at each step.
- Commit each milestone atomically (conventional messages, present tense, NO attribution trailers, NEVER --no-verify).
- Structural deviation from the plan → note it in "deviations". Local deviation → adapt, note in the commit message, keep going.`

const buildGatePrompt = `Run the build gate in the worktree and report status passed/failed/unknown.
${here}${ENV_NOTE}
Detect and run the project's lint+test commands (Rust: \`cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace\`; otherwise the repo's documented equivalents).
On failure: fix in atomic commits and re-run (max a few rounds), then report.
${transientRule}`

const codexAdversarialPrompt = `Run EXACTLY this:
${CODEX_LOCATE} && node "$COMPANION" adversarial-review --cwd "${WT}" --base ${BASE} --json
Stdout is a JSON payload. Map its .result.findings[] into the findings schema MECHANICALLY —
field transcription, not reinterpretation: severity→severity (same enum), title→title,
file→file, line_start→line, detail = body plus recommendation if present, systemic=false
unless the finding is genuinely cross-crate-refactor scale, confidence = 55 (codex findings
arrive inferred from reading, unverified by execution) unless the payload carries its own score.
If .result is null or .parseError is set, that is a FAILED review, not an empty one.
If codex produces no review for ANY reason (companion not found, CLI error, timeout, parse error),
return exactly one finding: severity "low", title "CODEX_UNAVAILABLE: <one-line reason>", file "",
line 0, detail the underlying error, systemic false, confidence 100 — an errored review must be
visible as unavailable, never as a clean pass.`

const reviewScope = `Review the diff (\`git -C ${WT} diff ${BASE}...HEAD\`) for issue #${A.issueNumber}. Cite file:line. Severity per finding — severity floor: a reachable panic, crash, or DoS triggerable by request-controlled input is never below medium. Set confidence per finding (0-100: is it real — not severity). Set systemic=true ONLY for cross-crate-refactor-scale work that cannot fit this PR.`
const correctnessPrompt = `${reviewScope}
Focus: correctness bugs, races, TOCTOU, data-flow errors, error-handling holes, edge cases.`
const simplifyPrompt = `${reviewScope}
Focus ONLY: reuse, simplification, efficiency, altitude drift — not bugs. Severity medium/low.`
const securityPrompt = `${reviewScope}
Hunt: injection (SQL/HTML/shell/template), secret handling, authz gaps, unsafe deserialization, TOCTOU, panics in prod paths, trust-boundary leaks.`

const acCheckPrompt = (plan) => `Verify the diff against issue #${A.issueNumber}'s acceptance criteria — per criterion, with evidence.
${here}
Diff: \`git -C ${WT} diff ${BASE}...HEAD\`. Run tests/commands as needed to OBSERVE each criterion; do not infer from reading alone where execution is possible.
${transientRule} (an unobservable criterion is status "unknown" — unknown is NOT met.)

Acceptance criteria (snapshot taken at launch — judge against THIS text):
${A.acceptanceCriteria || '(none — derive the criteria list from the issue body, flag that AC were missing)'}

Issue body:
${A.issueBody}

Plan goal: ${plan.goal}

For each criterion: status met/unmet/unknown + the concrete evidence pointer (test name + result, command + output tail, file:line). Also list scopeCreep: implementation beyond the issue's ask.`

const fixPrompt = (f, plan) => `Fix this reviewer finding for issue #${A.issueNumber}, in an atomic commit.
${here}
Finding [${f.severity}] ${f.title} @ ${f.file}:${f.line}
${f.detail}
Plan goal (stay in scope): ${plan.goal}
Smallest correct fix; commit conventionally (NEVER --no-verify); report what changed.`

const adjudicatePrompt = (blocking) => `Adjudicate the blocking findings that survived ${FIX_ROUND_CAP} fix rounds for issue #${A.issueNumber}.
${here}
For each: is it a REAL blocker (ship-stopping if merged) or reviewer theater (style dressed as severity, already mitigated, wrong about the code)? Read the actual code before judging — do not take the finding's word for it.
Severity floor: a reachable panic, crash, or DoS triggerable by request-controlled input is never below medium — do not dismiss or downgrade such a finding as low-impact. Findings carry a structured confidence (is-it-real, 0-100): weigh low-confidence criticals skeptically; do not dismiss high-confidence mediums as noise.
realBlockers → escalates to a human. dismissed → recorded with your reason. Be strict about what interrupts a human.

Findings:
${JSON.stringify(blocking, null, 2)}`

const docSyncPrompt = `Documentation sync for issue #${A.issueNumber}.
${here}
Read \`git -C ${WT} diff ${BASE}...HEAD --stat\` and the touched files. If the change altered domain
behaviour, vocabulary, or crate responsibilities: update the affected context.md slice(s) and
crate AGENTS.md files to match reality. Commit docs-only as \`docs(sync): <what>\` — nothing else
in the commit. If nothing needs updating, report done with note "no doc drift".`

const prPrompt = `Publish the branch for issue #${A.issueNumber} as a PR.
${here}${ENV_NOTE}
1. \`git -C ${WT} fetch origin\` then attempt \`git -C ${WT} rebase origin/main\`.
   On conflict: \`git -C ${WT} rebase --abort\`, set conflict=true, and continue (push un-rebased — GitHub will surface the conflict; a human or a rebase pass resolves it).
2. Push: \`git -C ${WT} push -u origin ${A.branch}\` (NEVER --no-verify; if a pre-push hook fails, capture its output — the environment note above may name required exports). Then VERIFY:
   compare \`git -C ${WT} rev-parse HEAD\` with the first field of \`git ls-remote origin refs/heads/${A.branch}\`. headPushed=true ONLY when they match — never inferred from the push exit status.
   If the push failed but a PR already exists for the branch, still report it — with headPushed=false and the hook/push output noted.
3. Create the PR against main: title from the issue, body = summary narrative (what + why + key decisions) followed by a one-line-per-commit changelog. No attribution trailers.
   The body MUST end with a line containing exactly \`Closes #${A.issueNumber}\` — this is a hard requirement, not styling: it is what links the PR to the issue for the land ritual.
   Use \`gh pr create\`. If a PR for the branch already exists, reuse it (and still verify the Closes line below).
4. VERIFY the link: \`gh pr view <number> --json closingIssuesReferences\` must reference issue #${A.issueNumber}. If it does not, edit the body to append the \`Closes #${A.issueNumber}\` line (\`gh pr edit --body-file\` with current body + the line) and re-verify. Report closesLinked from what you OBSERVED, never from having written the line.
${transientRule}
Report prNumber, prUrl, rebased, conflict, headPushed, closesLinked.`

const lensPrompts = {
  tests: `${reviewScope}\nFocus: behavioural test coverage — gaps where new logic lacks a test that would catch its regression, tests asserting implementation instead of behaviour, missing edge/failure cases.`,
  'silent-failures': `${reviewScope}\nFocus: silent failures — swallowed errors, catch-and-continue, fallbacks masking faults, missing error propagation/logging.`,
  comments: `${reviewScope}\nFocus: comment accuracy — comments the diff made stale, missing constraint documentation on non-obvious code, comment rot.`,
  types: `${reviewScope}\nFocus: type design in added/modified types — invariant expression, encapsulation, impossible-states-representable problems.`,
}

const externalPollPrompt = (pr) => `Collect external reviewer feedback on PR #${pr.prNumber} (bots: ${EXTERNAL_BOTS.join(', ')}).
Poll up to ${EXTERNAL_WAIT_MINUTES} minutes total: check every ~45s with
\`gh pr view ${pr.prNumber} --json reviews,comments\` and
\`gh api repos/{owner}/{repo}/pulls/${pr.prNumber}/comments --paginate\` (run from ${WT} via subshell).
${here}
Stop early once at least one listed bot has posted a completed review (not a "reviewing…" placeholder — a placeholder or in-progress marker does NOT count as received).
Return every substantive item from those bots: kind review|thread, body (trim boilerplate), path/line when anchored, headSha when the API provides it.
receivedAny and timedOut are the two mutually exclusive outcomes of the window: a completed review observed → receivedAny=true, timedOut=false; the window closed without one → receivedAny=false, timedOut=true. Never report false/false.
${transientRule}`

const postPushTriagePrompt = (internal, external, headNote) => `Triage post-push review findings for issue #${A.issueNumber} into ONE verdict set.
${here}
${headNote}
Sources: (a) complementary self-review lenses, (b) external reviewer items. For each: fix (real, in scope, actionable now), noise (wrong, stylistic, out of scope — with reason), or already-fixed (anchored to a stale SHA — VERIFY against current HEAD before dismissing; check the cited path/line in the code as it exists now).
Mediums get fixed, not deferred. Severity floor: a reachable panic, crash, or DoS triggerable by request-controlled input is never below medium — do not dismiss or downgrade such a finding as low-impact. Findings carry a structured confidence (is-it-real, 0-100): weigh low-confidence criticals skeptically; do not dismiss high-confidence mediums as noise. systemic=true only for cross-crate-refactor scale.

Self-review findings:
${JSON.stringify(internal, null, 2)}

External items:
${JSON.stringify(external, null, 2)}`

const replyPrompt = (pr, triage) => `Reply to external reviewer threads on PR #${pr.prNumber} so the record is clean. Best effort — never fail the run over a reply.
${here}
For each external item that was fixed: reply naming the fixing commit. For each dismissed as noise/already-fixed: a one-line reasoned reply. Use \`gh api\` review-comment replies where anchored, else a single summary comment on the PR.
Triage record:
${JSON.stringify(triage, null, 2)}`

const pushPrompt = `Push the post-push fix commits and VERIFY they arrived.
${here}${ENV_NOTE}
1. \`git -C ${WT} push origin ${A.branch}\` — NEVER --no-verify. If a pre-push hook fails, do not bypass it; capture the failing output.
2. Verify regardless of what step 1's exit status claimed: headSha = \`git -C ${WT} rev-parse HEAD\`; remoteSha = first field of \`git ls-remote origin refs/heads/${A.branch}\`.
3. pushed=true ONLY when headSha equals remoteSha. Otherwise pushed=false and note = the exact tail of the hook/push output — surfacing the failure IS the job; never report success you did not observe.
${transientRule}`

const handoffPrompt = (pr, pushRepairNote) => `Final handoff verification for PR #${pr.prNumber} (issue #${A.issueNumber}) — report the PR as it exists NOW, not as earlier stages left it.
${here}${ENV_NOTE}
${pushRepairNote}0. HEAD SYNC FIRST — every read below is meaningless against a stale head. Compare local = \`git -C ${WT} rev-parse HEAD\` with remote = \`gh pr view ${pr.prNumber} --json headRefOid -q .headRefOid\`.
   - Match → headInSync=true, localAhead=0.
   - Local ahead (the remote oid is an ancestor of HEAD): push \`git -C ${WT} push origin ${A.branch}\` (the environment note above names exports pre-push hooks may need; NEVER --no-verify), re-read headRefOid, re-compare, and report the FINAL observed state with localAhead = commits still unpushed.
   - Remote ahead or histories diverged: do NOT push or force — headInSync=false, describe the divergence in ciDetail.
   HARD RULE: ciStatus may be "green" ONLY when headInSync=true. If the head is stale or your push failed, ciStatus is "pending" (CI has not run on the real work) or "unknown", and ciDetail names the divergence and the push/hook error verbatim.
1. CI: read \`gh pr view ${pr.prNumber} --json statusCheckRollup\` AND \`gh pr checks ${pr.prNumber}\` (the json rollup mixes CheckRuns with commit statuses — entries with null fields are statuses; judge them via gh pr checks). Every completed check successful → green. Any failure → red; name the failing check(s) and pull the one-line cause from the job log. Anything queued/running → pending. ${transientRule}
2. Closes-link: \`gh pr view ${pr.prNumber} --json closingIssuesReferences\` must reference issue #${A.issueNumber}. If it does not: append a final line \`Closes #${A.issueNumber}\` to the PR body (\`gh pr edit --body-file\` with the current body plus the line), re-read, and report the observed post-repair state.
3. Late externals: check reviews/threads from ${EXTERNAL_BOTS.join(', ')} (\`gh pr view ${pr.prNumber} --json reviews\` + \`gh api repos/{owner}/{repo}/pulls/${pr.prNumber}/comments --paginate\`) — count substantive items the run has not replied to (the post-push poll window may have closed before they arrived). Count only; do NOT reply or resolve.
4. finalSummary: from \`git -C ${WT} log ${BASE}..HEAD --oneline\` and \`git -C ${WT} diff ${BASE}...HEAD --stat\` — commit count, diffstat headline, and anything notable that landed AFTER the implementation stage (post-push fixes, captured evidence, doc syncs).`

const ledgerPrompt = (pr, acCheck) => `Post the evidence ledger on PR #${pr.prNumber} as a comment.
${here}
Build a markdown table: Criterion | Verdict | Evidence — one row per acceptance criterion, from the
AC check below. Evidence cells carry the concrete pointer (test name + result, command + output tail,
file:line). Where the diff touches a web UI AND a dev/test server can be started cheaply AND
playwright (npx playwright) is available: capture a screenshot per UI-facing criterion. Home the
images in the repo's own committed-evidence convention when one exists (e.g. a visual-evidence/
dir already on the branch); otherwise commit them to the branch \`flow-evidence\` (create orphan
if missing, never main). Either way EMBED the key screenshots inline in the ledger — markdown
image syntax over SHA-pinned raw URLs (\`![label](https://github.com/<owner>/<repo>/raw/<commit-sha>/<path>)\`,
exact commit SHA, never a branch name, so embeds survive branch deletion and rebase) — and link
the rest from their Evidence cells. Skip screenshots cleanly if any precondition is missing — say
so in the ledger.
Post with \`gh pr comment ${pr.prNumber} --body-file <tmpfile>\`. Write long output to a temp file, not the chat.
${transientRule}

AC check:
${JSON.stringify(acCheck, null, 2)}`

// ── pure helpers ─────────────────────────────────────────────────────────────
const SEV_RANK = { critical: 3, high: 2, medium: 1, low: 0 }
const isBlocking = (f) => SEV_RANK[f.severity] >= 1 && !f.systemic // crit/high/medium in-diff: fix, don't defer
const isEscalationGrade = (f) => SEV_RANK[f.severity] >= 2
const normTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const softKey = (f) => `${f.file || ''}::${normTitle(f.title)}`
const acGap = (c) => ({ severity: 'critical', title: `AC ${c.status}: ${c.criterion}`, file: '', line: 0, detail: c.detail || c.evidence || 'acceptance-criteria gap', systemic: false, confidence: 100 })

// A dead fan-out agent is signal, not silence: name it before dropping it.
const keepNamed = (keys, results, stage) => {
  keys.forEach((k, i) => { if (!results[i]) log(`${stage}:${k} returned null (skipped or died) — dropped from the fabric`) })
  return results.filter(Boolean)
}

// Result hygiene for the happy-path return: the conductor journals from this object; full
// texts already live on the issue (plan) and the PR (ledger, review threads). Escalation
// returns stay untrimmed — a human acts on those directly.
const clip = (s, n) => { const v = String(s ?? ''); return v.length > n ? `${v.slice(0, n)} …[+${v.length - n} chars — full text in the issue/PR journal]` : v }
const slimFinding = (f) => ({ severity: f.severity, confidence: f.confidence, title: f.title, file: f.file, line: f.line, round: f.round, detail: clip(f.detail, 240) })

function dedupeFindings(findings) {
  const byKey = new Map()
  for (const f of findings) {
    const key = `${f.file || ''}:${f.line || 0}:${normTitle(f.title)}`
    const prev = byKey.get(key)
    if (!prev) { byKey.set(key, { ...f, sources: 1 }); continue }
    prev.sources += 1
    if (SEV_RANK[f.severity] > SEV_RANK[prev.severity]) prev.severity = f.severity
    prev.systemic = prev.systemic || f.systemic
  }
  return [...byKey.values()].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
}

// Dispatch fixes concurrently when every finding names a distinct file; serially otherwise
// (shared worktree — two agents editing one file is a merge conflict with extra steps).
async function dispatchFixes(items, plan, roundLabel) {
  const files = items.map((f) => f.file || '')
  const disjoint = files.every(Boolean) && new Set(files).size === files.length
  const results = []
  if (disjoint) {
    const fixed = await parallel(items.map((f) => () =>
      salvageableAgent(fixPrompt(f, plan), { label: `fix:${roundLabel}:${f.file}`, phase: 'Fix', model: 'opus', effort: 'high', schema: IMPL_RESULT })))
    items.forEach((f, i) => results.push({ ...f, round: roundLabel, fixSummary: fixed[i]?.summary || '' }))
  } else {
    for (const f of items) {
      const fixed = await salvageableAgent(fixPrompt(f, plan), { label: `fix:${roundLabel}:${f.file || f.title}`, phase: 'Fix', model: 'opus', effort: 'high', schema: IMPL_RESULT })
      results.push({ ...f, round: roundLabel, fixSummary: fixed?.summary || '' })
    }
  }
  return results
}

// The host agent() resolves to null when a subagent dies on a terminal API error — but a
// schema'd agent that exhausts its StructuredOutput retry cap THROWS instead (three runs
// bitten; latest wf_c92d331a-f75, where a COMPLETED impl stage lost only its report and
// the throw killed the run past its `|| fallback`). Route every call through this shim so
// a lost result degrades to null — the contract all the fallbacks here are written
// against. parallel() thunks already null on throw; double-wrapping those is harmless.
const safeAgent = (prompt, opts) => agent(prompt, opts).catch((e) => {
  log(`${opts?.label || 'agent'}: threw (${clip(String(e), 160)}) → null; fallbacks engage`)
  return null
})

// Report salvage: a seat that finishes its work but dies on the StructuredOutput retry
// cap loses only its report (5 deaths in wf_512af7b9 alone). Heavy seats mirror the report
// to a file OUTSIDE the worktree (a fixer's `git add -A` can never sweep it); on a null
// result a cheap reader re-emits it through the schema. Zero cost when healthy. The dir is
// deterministic (no Date.now in workflow scripts) — the conductor rm -rf's it at launch.
const REPORT_DIR = `/tmp/flow-issue-${A.issueNumber}-reports`
const slugify = (s) => {
  // char-replacement alone can collide (src/a.rs vs src_a.rs) — append a djb2 hash
  const t = String(s); let h = 5381
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0
  return `${t.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)}-${h.toString(36)}`
}
const salvageableAgent = async (prompt, opts) => {
  const reportFile = `${REPORT_DIR}/${slugify(opts.label || 'agent')}.json`
  const r = await safeAgent(`${prompt}

Report durability: immediately BEFORE emitting your structured report, also write the identical JSON to ${reportFile} (mkdir -p ${REPORT_DIR} first). That file is run bookkeeping outside the worktree — never commit it, never mention it in the report itself.`, opts)
  if (r !== null) return r
  log(`${opts.label}: result lost — attempting salvage from ${reportFile}`)
  return safeAgent(`Read the file ${reportFile}. If it exists and parses as JSON, emit its contents VERBATIM through the structured output schema — pure transcription, zero reinterpretation. If it is missing, unparseable, or plainly describes different work than issue #${A.issueNumber}, emit nothing and stop.`,
    { label: `${opts.label}:salvage`, phase: opts.phase, model: 'sonnet', effort: 'low', schema: opts.schema })
}

// Fable holds the judgment seats, but its safety classifiers can bounce security-flavored
// content (agent() → null). Fall back to opus rather than losing the stage. Both legs are
// salvageable: fable → salvage fable's report → opus → salvage opus's report.
async function judge(prompt, opts) {
  const r = await salvageableAgent(prompt, { ...opts, model: 'fable', effort: 'high' })
  if (r !== null) return r
  log(`${opts.label}: fable returned null (refusal or terminal error) → retrying on opus`)
  return salvageableAgent(prompt, { ...opts, model: 'opus', effort: 'xhigh', label: `${opts.label}:opus-fallback` })
}

const designThunks = {
  codex: () => salvageableAgent(codexDesignPrompt, { label: 'design:codex', phase: 'Design', model: 'sonnet', effort: 'low', schema: DESIGN }),
  minimal: () => salvageableAgent(architectPrompt('minimal'), { label: 'design:minimal', phase: 'Design', agentType: 'flow:code-architect', model: 'sonnet', schema: DESIGN }),
  clean: () => salvageableAgent(architectPrompt('clean'), { label: 'design:clean', phase: 'Design', agentType: 'flow:code-architect', model: 'opus', effort: 'high', schema: DESIGN }),
}
const reviewThunks = {
  codex: () => salvageableAgent(codexAdversarialPrompt, { label: 'review:codex', phase: 'Review', model: 'sonnet', effort: 'low', schema: FINDINGS }),
  correctness: () => salvageableAgent(correctnessPrompt, { label: 'review:correctness', phase: 'Review', agentType: 'flow:code-reviewer', model: 'opus', effort: 'high', schema: FINDINGS }),
  simplify: () => salvageableAgent(simplifyPrompt, { label: 'review:simplify', phase: 'Review', model: 'sonnet', schema: FINDINGS }),
  security: () => salvageableAgent(securityPrompt, { label: 'review:security', phase: 'Review', agentType: 'flow:code-reviewer', model: 'opus', effort: 'high', schema: FINDINGS }),
}

// ── pipeline ─────────────────────────────────────────────────────────────────
phase('Size')
const sized = (await safeAgent(sizePrompt, { label: 'size', phase: 'Size', model: 'sonnet', schema: SIZE }))
  || { size: 'medium', expectedFiles: 0, rationale: 'size agent unavailable — defaulting to medium' }
const fabric = FABRIC[sized.size] || FABRIC.medium
log(`size=${sized.size}: ${sized.rationale} → designs[${fabric.designs.join(',')}] synth=${fabric.synthModel} reviews[${fabric.reviews.join(',')}]`)

phase('Design')
// CODEX_UNAVAILABLE sentinel: a dead codex leg returns a schema-valid husk (see
// codexDesignPrompt) — drop it before it dilutes the synthesis panel.
const rawDesigns = await parallel(fabric.designs.map((k) => designThunks[k]))
const designs = keepNamed(fabric.designs, rawDesigns, 'design')
  .filter((d) => {
    const dead = typeof d.approach === 'string' && d.approach.startsWith('CODEX_UNAVAILABLE')
    if (dead) log(`design:codex unavailable (${clip(d.approach, 120)}) — dropped from the synthesis panel`)
    return !dead
  })
// A thinned panel is disclosed to the synthesizer, not silently averaged over.
const missingSeats = fabric.designs.filter((k, i) => !rawDesigns[i]
  || (typeof rawDesigns[i].approach === 'string' && rawDesigns[i].approach.startsWith('CODEX_UNAVAILABLE')))
const panelNote = missingSeats.length
  ? `\nPANEL THINNED: ${designs.length} of ${fabric.designs.length} design seats delivered — missing: ${missingSeats.join(', ')}. Recommendations present in only one design lack cross-checking; treat them with proportionate suspicion and verify against the code yourself.`
  : ''

phase('Synthesize')
if (designs.length === 0) throw new Error('all design agents returned null — resume the run to retry')
const synthOpts = { label: 'synthesize', phase: 'Synthesize', schema: PLAN }
const plan = fabric.synthModel === 'fable'
  ? await judge(synthesizePrompt(designs, panelNote), synthOpts)
  : await salvageableAgent(synthesizePrompt(designs, panelNote), { ...synthOpts, model: 'opus', effort: 'high' })
if (!plan) throw new Error('synthesis returned null on both fable and opus — resume the run to retry')
const amb = sentinel(plan.blockingAmbiguity)
if (amb) return { escalation: 'needs-info', questions: amb, plan: { goal: plan.goal } }

// Implementer seat: fable/high by default for anything non-mechanical; mechanical work
// with a complete spec stays on sonnet (charter routing). The old difficulty-routed
// opus/sonnet seat survives as the fallback for a null result.
const implFallbackModel = plan.difficulty === 'mechanical' ? 'sonnet' : 'opus'
const implFallbackEffort = plan.difficulty === 'hard' ? 'xhigh' : 'high'
let implModel = A.implModel || (plan.difficulty === 'mechanical' ? 'sonnet' : 'fable')
let implEffort = A.implEffort || (implModel === 'fable' ? 'high' : implFallbackEffort)
if (implModel === 'fable' && implEffort === 'xhigh') implEffort = 'high' // fable tops out at high
log(`difficulty=${plan.difficulty} → impl on ${implModel}/${implEffort}${A.implModel || A.implEffort ? ' (override)' : ''}, fallback ${implFallbackModel}/${implFallbackEffort}; ${plan.files.length} file(s), ${plan.milestones.length} milestone(s)`)

await safeAgent(`In ${WT}: mkdir -p docs/working-plans; ensure .gitignore contains docs/working-plans/ (commit that line alone if you add it).
Write this plan to docs/working-plans/plan-issue-${A.issueNumber}.md, then post it as the journal entry: gh issue comment ${A.issueNumber} --body-file docs/working-plans/plan-issue-${A.issueNumber}.md. Do NOT commit the plan file.
Plan:
${JSON.stringify(plan, null, 2)}`, { label: 'plan:persist', phase: 'Synthesize', model: 'sonnet', effort: 'low' })

phase('Implement')
let implRun = await salvageableAgent(implPrompt(plan), { label: 'impl', phase: 'Implement', model: implModel, effort: implEffort, schema: IMPL_RESULT })
if (implRun === null && (implModel !== implFallbackModel || implEffort !== implFallbackEffort)) {
  // Seat refused or died (override experiment or fable safety-classifier roulette) —
  // re-run on the difficulty-routed fallback. Commits from a partial first attempt are
  // fine: the review fabric judges the actual diff.
  log(`impl: ${implModel}/${implEffort} returned null (refusal or terminal error) → falling back to ${implFallbackModel}/${implFallbackEffort}`)
  implModel = implFallbackModel
  implEffort = implFallbackEffort
  implRun = await salvageableAgent(implPrompt(plan), { label: 'impl:fallback', phase: 'Implement', model: implModel, effort: implEffort, schema: IMPL_RESULT })
}
const impl = implRun
  || { summary: '(impl agent result lost — commits may exist; the review fabric judges the actual diff)', deviations: 'unknown (impl agent died)' }

phase('Review')
const gate = (await salvageableAgent(buildGatePrompt, { label: 'build-gate', phase: 'Review', model: 'sonnet', effort: 'low', schema: GATE }))
  || { status: 'unknown', output: 'build-gate agent unavailable' }
const reviews = keepNamed(fabric.reviews, await parallel(fabric.reviews.map((k) => reviewThunks[k])), 'review')
const acCheck = (await salvageableAgent(acCheckPrompt(plan), { label: 'ac-check', phase: 'Review', model: 'opus', effort: 'high', schema: AC_CHECK }))
  || { criteria: [], scopeCreep: [], unavailable: true }
// CODEX_UNAVAILABLE marker findings are observability, not review signal — log and drop.
const dropCodexMarker = (fs) => fs.filter((f) => {
  const dead = typeof f.title === 'string' && f.title.startsWith('CODEX_UNAVAILABLE')
  if (dead) log(`codex review unavailable (${clip(f.detail || f.title, 120)}) — no cross-model signal this pass`)
  return !dead
})
const findings = dedupeFindings(dropCodexMarker(reviews.flatMap((r) => r.findings || [])))
const escapeHatch = findings.filter((f) => f.systemic && isEscalationGrade(f))
const droppedLow = findings.filter((f) => !isBlocking(f) && !f.systemic)
// Dropped ≠ invisible: the conductor should not have to excavate the result object to see these.
if (droppedLow.length) log(`dropped ${droppedLow.length} low finding(s) (not fixed, reported in result): ${droppedLow.map((f) => f.title).join(' · ')}`)

phase('Fix')
let round = 0
let blocking = findings.filter(isBlocking)
  .concat(acCheck.criteria.filter((c) => c.status !== 'met').map(acGap))
  .concat(gate.status !== 'passed' ? [{ severity: 'critical', title: `build gate ${gate.status}`, file: '', line: 0, detail: gate.output, systemic: false, confidence: 100 }] : [])
let latestAcCheck = acCheck
const resolvedInLoop = []
while (round < FIX_ROUND_CAP && blocking.length > 0) {
  round++
  log(`fix round ${round}: ${blocking.length} blocking item(s)`)
  const attempted = await dispatchFixes(blocking, plan, `r${round}`)
  const reGate = await salvageableAgent(buildGatePrompt, { label: `gate:r${round}`, phase: 'Fix', model: 'sonnet', effort: 'low', schema: GATE })
  const [reCorrectness, reSecurity, reAc] = await parallel([
    () => salvageableAgent(correctnessPrompt, { label: `correctness:r${round}`, phase: 'Fix', agentType: 'flow:code-reviewer', model: 'opus', effort: 'high', schema: FINDINGS }),
    () => salvageableAgent(securityPrompt, { label: `security:r${round}`, phase: 'Fix', agentType: 'flow:code-reviewer', model: 'opus', effort: 'high', schema: FINDINGS }),
    () => salvageableAgent(acCheckPrompt(plan), { label: `ac:r${round}`, phase: 'Fix', model: 'opus', effort: 'high', schema: AC_CHECK }),
  ])
  if (reAc) latestAcCheck = reAc
  blocking = dedupeFindings((reCorrectness?.findings || []).concat(reSecurity?.findings || [])).filter(isBlocking)
    // null reGate = unverified, not failed — don't manufacture a critical from a dead agent,
    // but a FAILED or UNKNOWN observed gate is blocking (unknown ≠ pass).
    .concat(reGate && reGate.status !== 'passed' ? [{ severity: 'critical', title: `build gate ${reGate.status}`, file: '', line: 0, detail: reGate.output, systemic: false, confidence: 100 }] : [])
    .concat((reAc?.criteria || []).filter((c) => c.status !== 'met').map(acGap))
  const stillKeys = new Set(blocking.map(softKey))
  for (const f of attempted) if (!stillKeys.has(softKey(f))) resolvedInLoop.push(f)
}

// Cross-model signal survives to the end: codex re-verifies after the loop settles.
let bonusRound = null
if (blocking.length === 0 && fabric.reviews.includes('codex')) {
  const codexVerify = await salvageableAgent(codexAdversarialPrompt, { label: 'review:codex-final', phase: 'Fix', model: 'sonnet', effort: 'low', schema: FINDINGS })
  const fresh = dedupeFindings(dropCodexMarker(codexVerify?.findings || [])).filter(isEscalationGrade).filter((f) => !f.systemic)
  if (fresh.length > 0) {
    log(`codex final verify: ${fresh.length} fresh critical/high finding(s) → bonus fix round`)
    const attempted = await dispatchFixes(fresh, plan, 'codex-final')
    const bonusGate = await salvageableAgent(buildGatePrompt, { label: 'gate:codex-final', phase: 'Fix', model: 'sonnet', effort: 'low', schema: GATE })
    bonusRound = { findings: fresh.length, fixes: attempted.map((f) => f.title), gate: bonusGate?.status || 'unknown' }
    if (bonusGate && bonusGate.status !== 'passed') blocking = [{ severity: 'critical', title: `build gate ${bonusGate.status} after codex-final fixes`, file: '', line: 0, detail: bonusGate.output, systemic: false, confidence: 100 }]
  }
}

// Judgment before escalation: only adjudicated-real blockers interrupt the human.
let adjudication = { realBlockers: [], dismissed: [] }
if (blocking.length > 0) {
  adjudication = (await judge(adjudicatePrompt(blocking), { label: 'adjudicate', phase: 'Fix', schema: ADJUDICATION }))
    || { realBlockers: blocking, dismissed: [] } // both judges died → escalate everything rather than swallow
  log(`adjudication: ${adjudication.realBlockers.length} real, ${adjudication.dismissed.length} dismissed`)
}
const escalate = adjudication.realBlockers.length > 0

phase('PR')
// opus seat: doc-sync output is the only content-producing stage no later review reads —
// doc rot ships silently, so don't put the cheapest model on it.
await safeAgent(docSyncPrompt, { label: 'doc-sync', phase: 'PR', model: 'opus', effort: 'high', schema: DONE })
const pr = await salvageableAgent(prPrompt, { label: 'publish', phase: 'PR', model: 'sonnet', schema: PR_INFO })
if (!pr) return {
  escalation: 'needs-human', reason: 'PR publish agent died — branch and push state unknown; check `git ls-remote` against the worktree HEAD yourself and recover from the journal',
  size: sized.size, plan: { goal: plan.goal, difficulty: plan.difficulty }, implSummary: impl.summary,
  fixRounds: round, unresolvedBlocking: adjudication.realBlockers, resolvedInLoop, escapeHatch, droppedLow,
}

// Blocked runs still publish (work preserved, reviewable) but skip the post-push machinery.
if (escalate || pr.conflict) {
  return {
    escalation: pr.conflict ? 'needs-rebase' : 'needs-human',
    prNumber: pr.prNumber, prUrl: pr.prUrl, rebased: pr.rebased, conflict: pr.conflict, headPushed: pr.headPushed,
    size: sized.size, plan: { goal: plan.goal, approach: plan.approach, difficulty: plan.difficulty, files: plan.files },
    implModel, implSummary: impl.summary, implDeviations: impl.deviations,
    gate: gate.status, fixRounds: round, bonusRound, adjudication,
    unresolvedBlocking: adjudication.realBlockers, resolvedInLoop, escapeHatch, droppedLow,
    acLedger: latestAcCheck, scopeCreep: latestAcCheck.scopeCreep || [],
  }
}

phase('PostPush')
const [lensResults, external] = await parallel([
  () => parallel(Object.entries(lensPrompts).map(([k, p]) => () =>
    salvageableAgent(p, {
      label: `lens:${k}`, phase: 'PostPush', model: 'opus', effort: 'high', schema: FINDINGS,
      agentType: { tests: 'pr-review-toolkit:pr-test-analyzer', 'silent-failures': 'pr-review-toolkit:silent-failure-hunter', comments: 'pr-review-toolkit:comment-analyzer', types: 'pr-review-toolkit:type-design-analyzer' }[k],
    }))),
  () => safeAgent(externalPollPrompt(pr), { label: 'external:poll', phase: 'PostPush', model: 'sonnet', effort: 'low', schema: EXTERNAL }),
])
const lensFindings = dedupeFindings(keepNamed(Object.keys(lensPrompts), lensResults || [], 'lens').flatMap((r) => r.findings || []))
const ext = external || { items: [], receivedAny: false, timedOut: true }
log(`post-push: ${lensFindings.length} lens finding(s); external receivedAny=${ext.receivedAny} timedOut=${ext.timedOut}`)

let triage = { fixes: [], noise: [] }
let ppPush = null // push result of the post-push fix round; null = no fix round ran, nothing new to push
if (lensFindings.length > 0 || ext.items.length > 0) {
  const headNote = 'Current HEAD is the pushed branch tip; external items may anchor to an older SHA (headSha field) — verify against the code as it exists NOW.'
  triage = (await judge(postPushTriagePrompt(lensFindings, ext.items, headNote), { label: 'triage', phase: 'PostPush', schema: TRIAGE }))
    || { fixes: lensFindings.filter(isBlocking), noise: [] } // judges died → fix our own blocking lens findings, leave externals to /land's thread gate
  if (triage.fixes.length > 0) {
    await dispatchFixes(triage.fixes, plan, 'postpush')
    const ppGate = await salvageableAgent(buildGatePrompt, { label: 'gate:postpush', phase: 'PostPush', model: 'sonnet', effort: 'low', schema: GATE })
    // Push before the gate verdict either way — preserve the work remotely even when escalating.
    ppPush = (await safeAgent(pushPrompt, { label: 'push:postpush', phase: 'PostPush', model: 'sonnet', effort: 'low', schema: PUSH_RESULT }))
      || { pushed: false, headSha: '', remoteSha: '', note: 'push agent died — push state unknown' }
    if (!ppPush.pushed) log(`push:postpush NOT VERIFIED — ${clip(ppPush.note, 200)}; handoff step 0 must repair`)
    if (ppGate && ppGate.status !== 'passed') {
      return {
        escalation: 'needs-human', reason: `build gate ${ppGate.status} after post-push fixes`,
        prNumber: pr.prNumber, prUrl: pr.prUrl, size: sized.size,
        plan: { goal: plan.goal, difficulty: plan.difficulty }, implSummary: impl.summary,
        gate: ppGate.status, fixRounds: round, bonusRound, adjudication, postPush: { lensFindings: lensFindings.length, external: { receivedAny: ext.receivedAny, timedOut: ext.timedOut }, triage: { fixed: triage.fixes.length, noise: triage.noise.length }, pushed: ppPush.pushed, pushNote: clip(ppPush.note, 300) },
        unresolvedBlocking: [], resolvedInLoop, escapeHatch, droppedLow, acLedger: latestAcCheck,
      }
    }
  }
  // Replies name fixing commits — phantom references if those commits never left the worktree.
  if (ext.items.length > 0 && (!ppPush || ppPush.pushed)) {
    await safeAgent(replyPrompt(pr, triage), { label: 'external:reply', phase: 'PostPush', model: 'sonnet', effort: 'low', schema: DONE })
  } else if (ext.items.length > 0) {
    log('skipping external replies — fix commits not verifiably pushed; /land thread gate covers them')
  }
}

phase('Ledger')
const ledger = await safeAgent(ledgerPrompt(pr, latestAcCheck), { label: 'ledger', phase: 'Ledger', model: 'sonnet', schema: DONE })

// Final read of the PR as it exists NOW — CI may outlive the run, externals may arrive
// late, and mid-run summaries go stale; the conductor trusts this field over them.
phase('Handoff')
const pushRepairNote = ppPush && !ppPush.pushed
  ? `NOTE: a post-push fix round could not verify its push (${clip(ppPush.note, 200)}) — expect the local head to be ahead; step 0 must repair this before reading CI.\n`
  : ''
const handoff = (await safeAgent(handoffPrompt(pr, pushRepairNote), { label: 'handoff', phase: 'Handoff', model: 'sonnet', schema: HANDOFF }))
  || { ciStatus: 'unknown', ciDetail: 'handoff agent unavailable — conductor must read the rollup itself', headInSync: false, lateExternalItems: 0, closesLinked: pr.closesLinked === true, finalSummary: '' }
// Belt and braces for the prompt's hard rule: green is only green on the head we judged.
if (handoff.ciStatus === 'green' && handoff.headInSync !== true) {
  log('handoff claimed green with headInSync!=true — downgrading to pending (hard rule)')
  handoff.ciStatus = 'pending'
  if (!handoff.ciDetail) handoff.ciDetail = 'downgraded: PR head not verified in sync with the worktree'
}
log(`handoff: ci=${handoff.ciStatus}${handoff.ciDetail ? ` (${clip(handoff.ciDetail, 120)})` : ''} head-in-sync=${handoff.headInSync} closes-link=${handoff.closesLinked} late-external=${handoff.lateExternalItems}`)

return {
  escalation: null,
  prNumber: pr.prNumber, prUrl: pr.prUrl, rebased: pr.rebased,
  size: sized.size,
  plan: { goal: plan.goal, approach: clip(plan.approach, 1500), difficulty: plan.difficulty, files: plan.files, milestones: plan.milestones },
  implModel, implSummary: impl.summary, implDeviations: impl.deviations,
  gate: gate.status, fixRounds: round, bonusRound, adjudication,
  postPush: {
    lensFindings: lensFindings.length,
    external: { receivedAny: ext.receivedAny, timedOut: ext.timedOut, items: ext.items.length },
    triage: { fixed: triage.fixes.length, noise: triage.noise.length },
    pushed: ppPush ? ppPush.pushed : null, // null = no post-push fix round, nothing new to push
  },
  ledgerPosted: !!(ledger && ledger.done),
  handoff,
  acLedger: {
    criteria: (latestAcCheck.criteria || []).map((c) => ({ criterion: c.criterion, status: c.status, evidence: clip(c.evidence, 240), detail: clip(c.detail, 240) })),
  },
  scopeCreep: latestAcCheck.scopeCreep || [],
  resolvedInLoop: resolvedInLoop.map(slimFinding),
  escapeHatch, // untrimmed: the conductor posts these verbatim as the follow-up draft
  droppedLow: droppedLow.map(slimFinding),
}
