export const meta = {
  name: 'flow-issue',
  description: 'flow v2: design fan-out → fable synthesis → TDD → review fabric → fix loop → PR → post-push reviews (self ∥ external) → evidence ledger',
  phases: [
    { title: 'Size', detail: 'coarse triage → design/review fabric allocation' },
    { title: 'Design', detail: 'minimal ∥ clean ∥ codex, in parallel' },
    { title: 'Synthesize', detail: 'one plan + difficulty routing', model: 'fable' },
    { title: 'Implement', detail: 'TDD; opus primary, difficulty-routed' },
    { title: 'Review', detail: 'build gate + adversarial/correctness/security/simplify + AC evidence check' },
    { title: 'Fix', detail: '≤3 rounds; parallel over disjoint files; codex re-verify; fable adjudication' },
    { title: 'PR', detail: 'doc-sync, rebase, push, open PR' },
    { title: 'PostPush', detail: 'complementary lenses ∥ external reviewers → fable triage → fix round' },
    { title: 'Ledger', detail: 'per-AC evidence ledger on the PR' },
  ],
}

// ── tunables ────────────────────────────────────────────────────────────────
const FIX_ROUND_CAP = 3
const EXTERNAL_WAIT_MINUTES = 12 // post-push cap on waiting for coderabbit et al.

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
//     branch, base, externalReviewers? }
// May arrive as a parsed object OR a JSON-encoded string; parse defensively.
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const WT = A.worktree
const BASE = A.base || 'origin/main'
const EXTERNAL_BOTS = A.externalReviewers || ['coderabbitai']

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
  required: ['severity', 'title', 'file', 'line', 'detail', 'systemic'],
  properties: {
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
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
  required: ['prNumber', 'prUrl', 'rebased', 'conflict'],
  properties: {
    prNumber: { type: 'integer' },
    prUrl: { type: 'string' },
    rebased: { type: 'boolean' },
    conflict: { type: 'boolean', description: 'true if rebase onto base hit conflicts (branch pushed un-rebased)' },
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
${CODEX_LOCATE} && node "$COMPANION" task --effort high <<'PROMPT'
You are designing feature architecture for issue #${A.issueNumber} in ${WT}.
${A.contextPack}
Explore the referenced paths and the code they lead to before designing. Propose ONE concrete approach:
files to create/modify, key type/module decisions, data flow, error handling, test strategy.
Flag risks and pattern deviations. Long-term maintainability focus. Read-only — write NO files.
PROMPT
If the companion is not found, set approach to "codex skipped (companion not found)" and leave other fields empty.`

const synthesizePrompt = (designs) => `Synthesize ${designs.length} independent designs for issue #${A.issueNumber} into ONE plan.
${here}

Issue body:
${A.issueBody}

Acceptance criteria (the contract the run will be measured against):
${A.acceptanceCriteria || '(none stated — weak signal; consider blockingAmbiguity)'}

The designs:
${JSON.stringify(designs, null, 2)}

Synthesis rule: default to the MINIMAL-change design; switch to the CLEAN design where minimal
violates a documented decision (docs/adr/, CONTEXT.md — Read them when present). Cross-model
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
${here}
Detect and run the project's lint+test commands (Rust: \`cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace\`; otherwise the repo's documented equivalents).
On failure: fix in atomic commits and re-run (max a few rounds), then report.
${transientRule}`

const codexAdversarialPrompt = `Run EXACTLY this and convert codex's findings into the findings schema (systemic=false unless the finding is genuinely cross-crate-refactor scale):
${CODEX_LOCATE} && node "$COMPANION" adversarial-review --base ${BASE}
If the companion is not found, return an empty findings array.`

const reviewScope = `Review the diff (\`git -C ${WT} diff ${BASE}...HEAD\`) for issue #${A.issueNumber}. Cite file:line. Severity per finding. Set systemic=true ONLY for cross-crate-refactor-scale work that cannot fit this PR.`
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
realBlockers → escalates to a human. dismissed → recorded with your reason. Be strict about what interrupts a human.

Findings:
${JSON.stringify(blocking, null, 2)}`

const docSyncPrompt = `Documentation sync for issue #${A.issueNumber}.
${here}
Read \`git -C ${WT} diff ${BASE}...HEAD --stat\` and the touched files. If the change altered domain
behaviour, vocabulary, or crate responsibilities: update the affected CONTEXT.md slice(s) and
crate AGENTS.md files to match reality. Commit docs-only as \`docs(sync): <what>\` — nothing else
in the commit. If nothing needs updating, report done with note "no doc drift".`

const prPrompt = `Publish the branch for issue #${A.issueNumber} as a PR.
${here}
1. \`git -C ${WT} fetch origin\` then attempt \`git -C ${WT} rebase origin/main\`.
   On conflict: \`git -C ${WT} rebase --abort\`, set conflict=true, and continue (push un-rebased — GitHub will surface the conflict; a human or a rebase pass resolves it).
2. Push: \`git -C ${WT} push -u origin ${A.branch}\`.
3. Create the PR against main: title from the issue, body = summary narrative (what + why + key decisions) followed by a one-line-per-commit changelog, then "Closes #${A.issueNumber}" and the line "https://claude.ai/code/session_0165qbPf8wVPHUrKuhsvxKiF".
   Use \`gh pr create\`. If a PR for the branch already exists, reuse it.
${transientRule}
Report prNumber, prUrl, rebased, conflict.`

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
Return every substantive item from those bots: kind review|thread, body (trim boilerplate), path/line when anchored, headSha when the API provides it. receivedAny=false + timedOut=true if the window closes silently.
${transientRule}`

const postPushTriagePrompt = (internal, external, headNote) => `Triage post-push review findings for issue #${A.issueNumber} into ONE verdict set.
${here}
${headNote}
Sources: (a) complementary self-review lenses, (b) external reviewer items. For each: fix (real, in scope, actionable now), noise (wrong, stylistic, out of scope — with reason), or already-fixed (anchored to a stale SHA — VERIFY against current HEAD before dismissing; check the cited path/line in the code as it exists now).
Mediums get fixed, not deferred. systemic=true only for cross-crate-refactor scale.

Self-review findings:
${JSON.stringify(internal, null, 2)}

External items:
${JSON.stringify(external, null, 2)}`

const replyPrompt = (pr, triage) => `Reply to external reviewer threads on PR #${pr.prNumber} so the record is clean. Best effort — never fail the run over a reply.
${here}
For each external item that was fixed: reply naming the fixing commit. For each dismissed as noise/already-fixed: a one-line reasoned reply. Use \`gh api\` review-comment replies where anchored, else a single summary comment on the PR.
Triage record:
${JSON.stringify(triage, null, 2)}`

const ledgerPrompt = (pr, acCheck) => `Post the evidence ledger on PR #${pr.prNumber} as a comment.
${here}
Build a markdown table: Criterion | Verdict | Evidence — one row per acceptance criterion, from the
AC check below. Evidence cells carry the concrete pointer (test name + result, command + output tail,
file:line). Where the diff touches a web UI AND a dev/test server can be started cheaply AND
playwright (npx playwright) is available: capture a screenshot per UI-facing criterion, commit
screenshots to the branch \`flow-evidence\` (create orphan if missing, never main), and link the
blob URLs. Skip screenshots cleanly if any precondition is missing — say so in the ledger.
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
const acGap = (c) => ({ severity: 'critical', title: `AC ${c.status}: ${c.criterion}`, file: '', line: 0, detail: c.detail || c.evidence || 'acceptance-criteria gap', systemic: false })
const sentinel = (s) => { const v = (s || '').trim(); return v && !/^(none|n\/a|null|nil|no)\.?$/i.test(v) ? v : '' }

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
      agent(fixPrompt(f, plan), { label: `fix:${roundLabel}:${f.file}`, phase: 'Fix', model: 'opus', effort: 'high', schema: IMPL_RESULT })))
    items.forEach((f, i) => results.push({ ...f, round: roundLabel, fixSummary: fixed[i]?.summary || '' }))
  } else {
    for (const f of items) {
      const fixed = await agent(fixPrompt(f, plan), { label: `fix:${roundLabel}:${f.file || f.title}`, phase: 'Fix', model: 'opus', effort: 'high', schema: IMPL_RESULT })
      results.push({ ...f, round: roundLabel, fixSummary: fixed?.summary || '' })
    }
  }
  return results
}

// Fable holds the judgment seats, but its safety classifiers can bounce security-flavored
// content (agent() → null). Fall back to opus rather than losing the stage.
async function judge(prompt, opts) {
  const r = await agent(prompt, { ...opts, model: 'fable', effort: 'high' })
  if (r !== null) return r
  log(`${opts.label}: fable returned null (refusal or terminal error) → retrying on opus`)
  return agent(prompt, { ...opts, model: 'opus', effort: 'xhigh', label: `${opts.label}:opus-fallback` })
}

const designThunks = {
  codex: () => agent(codexDesignPrompt, { label: 'design:codex', phase: 'Design', model: 'sonnet', effort: 'low', schema: DESIGN }),
  minimal: () => agent(architectPrompt('minimal'), { label: 'design:minimal', phase: 'Design', agentType: 'feature-dev:code-architect', model: 'sonnet', schema: DESIGN }),
  clean: () => agent(architectPrompt('clean'), { label: 'design:clean', phase: 'Design', agentType: 'feature-dev:code-architect', model: 'opus', effort: 'high', schema: DESIGN }),
}
const reviewThunks = {
  codex: () => agent(codexAdversarialPrompt, { label: 'review:codex', phase: 'Review', model: 'sonnet', effort: 'low', schema: FINDINGS }),
  correctness: () => agent(correctnessPrompt, { label: 'review:correctness', phase: 'Review', agentType: 'feature-dev:code-reviewer', model: 'opus', effort: 'high', schema: FINDINGS }),
  simplify: () => agent(simplifyPrompt, { label: 'review:simplify', phase: 'Review', model: 'sonnet', schema: FINDINGS }),
  security: () => agent(securityPrompt, { label: 'review:security', phase: 'Review', agentType: 'feature-dev:code-reviewer', model: 'opus', effort: 'high', schema: FINDINGS }),
}

// ── pipeline ─────────────────────────────────────────────────────────────────
phase('Size')
const sized = (await agent(sizePrompt, { label: 'size', phase: 'Size', model: 'sonnet', schema: SIZE }))
  || { size: 'medium', expectedFiles: 0, rationale: 'size agent unavailable — defaulting to medium' }
const fabric = FABRIC[sized.size] || FABRIC.medium
log(`size=${sized.size}: ${sized.rationale} → designs[${fabric.designs.join(',')}] synth=${fabric.synthModel} reviews[${fabric.reviews.join(',')}]`)

phase('Design')
const designs = (await parallel(fabric.designs.map((k) => designThunks[k]))).filter(Boolean)

phase('Synthesize')
if (designs.length === 0) throw new Error('all design agents returned null — resume the run to retry')
const synthOpts = { label: 'synthesize', phase: 'Synthesize', schema: PLAN }
const plan = fabric.synthModel === 'fable'
  ? await judge(synthesizePrompt(designs), synthOpts)
  : await agent(synthesizePrompt(designs), { ...synthOpts, model: 'opus', effort: 'high' })
if (!plan) throw new Error('synthesis returned null on both fable and opus — resume the run to retry')
const amb = sentinel(plan.blockingAmbiguity)
if (amb) return { escalation: 'needs-info', questions: amb, plan: { goal: plan.goal } }

const implModel = plan.difficulty === 'mechanical' ? 'sonnet' : 'opus'
const implEffort = plan.difficulty === 'hard' ? 'xhigh' : 'high'
log(`difficulty=${plan.difficulty} → impl on ${implModel}/${implEffort}; ${plan.files.length} file(s), ${plan.milestones.length} milestone(s)`)

await agent(`In ${WT}: mkdir -p docs/working-plans; ensure .gitignore contains docs/working-plans/ (commit that line alone if you add it).
Write this plan to docs/working-plans/plan-issue-${A.issueNumber}.md, then post it as the journal entry: gh issue comment ${A.issueNumber} --body-file docs/working-plans/plan-issue-${A.issueNumber}.md. Do NOT commit the plan file.
Plan:
${JSON.stringify(plan, null, 2)}`, { label: 'plan:persist', phase: 'Synthesize', model: 'sonnet', effort: 'low' })

phase('Implement')
const impl = (await agent(implPrompt(plan), { label: 'impl', phase: 'Implement', model: implModel, effort: implEffort, schema: IMPL_RESULT }))
  || { summary: '(impl agent result lost — commits may exist; the review fabric judges the actual diff)', deviations: 'unknown (impl agent died)' }

phase('Review')
const gate = (await agent(buildGatePrompt, { label: 'build-gate', phase: 'Review', model: 'sonnet', schema: GATE }))
  || { status: 'unknown', output: 'build-gate agent unavailable' }
const reviews = (await parallel(fabric.reviews.map((k) => reviewThunks[k]))).filter(Boolean)
const acCheck = (await agent(acCheckPrompt(plan), { label: 'ac-check', phase: 'Review', model: 'opus', effort: 'high', schema: AC_CHECK }))
  || { criteria: [], scopeCreep: [], unavailable: true }
const findings = dedupeFindings(reviews.flatMap((r) => r.findings || []))
const escapeHatch = findings.filter((f) => f.systemic && isEscalationGrade(f))
const droppedLow = findings.filter((f) => !isBlocking(f) && !f.systemic)

phase('Fix')
let round = 0
let blocking = findings.filter(isBlocking)
  .concat(acCheck.criteria.filter((c) => c.status !== 'met').map(acGap))
  .concat(gate.status !== 'passed' ? [{ severity: 'critical', title: `build gate ${gate.status}`, file: '', line: 0, detail: gate.output, systemic: false }] : [])
let latestAcCheck = acCheck
const resolvedInLoop = []
while (round < FIX_ROUND_CAP && blocking.length > 0) {
  round++
  log(`fix round ${round}: ${blocking.length} blocking item(s)`)
  const attempted = await dispatchFixes(blocking, plan, `r${round}`)
  const reGate = await agent(buildGatePrompt, { label: `gate:r${round}`, phase: 'Fix', model: 'sonnet', schema: GATE })
  const [reCorrectness, reSecurity, reAc] = await parallel([
    () => agent(correctnessPrompt, { label: `correctness:r${round}`, phase: 'Fix', agentType: 'feature-dev:code-reviewer', model: 'opus', effort: 'high', schema: FINDINGS }),
    () => agent(securityPrompt, { label: `security:r${round}`, phase: 'Fix', agentType: 'feature-dev:code-reviewer', model: 'opus', effort: 'high', schema: FINDINGS }),
    () => agent(acCheckPrompt(plan), { label: `ac:r${round}`, phase: 'Fix', model: 'opus', effort: 'high', schema: AC_CHECK }),
  ])
  if (reAc) latestAcCheck = reAc
  blocking = dedupeFindings((reCorrectness?.findings || []).concat(reSecurity?.findings || [])).filter(isBlocking)
    // null reGate = unverified, not failed — don't manufacture a critical from a dead agent,
    // but a FAILED or UNKNOWN observed gate is blocking (unknown ≠ pass).
    .concat(reGate && reGate.status !== 'passed' ? [{ severity: 'critical', title: `build gate ${reGate.status}`, file: '', line: 0, detail: reGate.output, systemic: false }] : [])
    .concat((reAc?.criteria || []).filter((c) => c.status !== 'met').map(acGap))
  const stillKeys = new Set(blocking.map(softKey))
  for (const f of attempted) if (!stillKeys.has(softKey(f))) resolvedInLoop.push(f)
}

// Cross-model signal survives to the end: codex re-verifies after the loop settles.
let bonusRound = null
if (blocking.length === 0 && fabric.reviews.includes('codex')) {
  const codexVerify = await agent(codexAdversarialPrompt, { label: 'review:codex-final', phase: 'Fix', model: 'sonnet', effort: 'low', schema: FINDINGS })
  const fresh = dedupeFindings(codexVerify?.findings || []).filter(isEscalationGrade).filter((f) => !f.systemic)
  if (fresh.length > 0) {
    log(`codex final verify: ${fresh.length} fresh critical/high finding(s) → bonus fix round`)
    const attempted = await dispatchFixes(fresh, plan, 'codex-final')
    const bonusGate = await agent(buildGatePrompt, { label: 'gate:codex-final', phase: 'Fix', model: 'sonnet', schema: GATE })
    bonusRound = { findings: fresh.length, fixes: attempted.map((f) => f.title), gate: bonusGate?.status || 'unknown' }
    if (bonusGate && bonusGate.status !== 'passed') blocking = [{ severity: 'critical', title: `build gate ${bonusGate.status} after codex-final fixes`, file: '', line: 0, detail: bonusGate.output, systemic: false }]
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
await agent(docSyncPrompt, { label: 'doc-sync', phase: 'PR', model: 'sonnet', schema: DONE })
const pr = await agent(prPrompt, { label: 'publish', phase: 'PR', model: 'sonnet', schema: PR_INFO })
if (!pr) return {
  escalation: 'needs-human', reason: 'PR publish agent died — branch state unknown; recover from the journal',
  size: sized.size, plan: { goal: plan.goal, difficulty: plan.difficulty }, implSummary: impl.summary,
  fixRounds: round, unresolvedBlocking: adjudication.realBlockers, resolvedInLoop, escapeHatch, droppedLow,
}

// Blocked runs still publish (work preserved, reviewable) but skip the post-push machinery.
if (escalate || pr.conflict) {
  return {
    escalation: pr.conflict ? 'needs-rebase' : 'needs-human',
    prNumber: pr.prNumber, prUrl: pr.prUrl, rebased: pr.rebased, conflict: pr.conflict,
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
    agent(p, {
      label: `lens:${k}`, phase: 'PostPush', model: 'opus', effort: 'high', schema: FINDINGS,
      agentType: { tests: 'pr-review-toolkit:pr-test-analyzer', 'silent-failures': 'pr-review-toolkit:silent-failure-hunter', comments: 'pr-review-toolkit:comment-analyzer', types: 'pr-review-toolkit:type-design-analyzer' }[k],
    }))),
  () => agent(externalPollPrompt(pr), { label: 'external:poll', phase: 'PostPush', model: 'sonnet', effort: 'low', schema: EXTERNAL }),
])
const lensFindings = dedupeFindings((lensResults || []).filter(Boolean).flatMap((r) => r.findings || []))
const ext = external || { items: [], receivedAny: false, timedOut: true }
log(`post-push: ${lensFindings.length} lens finding(s); external receivedAny=${ext.receivedAny} timedOut=${ext.timedOut}`)

let triage = { fixes: [], noise: [] }
if (lensFindings.length > 0 || ext.items.length > 0) {
  const headNote = 'Current HEAD is the pushed branch tip; external items may anchor to an older SHA (headSha field) — verify against the code as it exists NOW.'
  triage = (await judge(postPushTriagePrompt(lensFindings, ext.items, headNote), { label: 'triage', phase: 'PostPush', schema: TRIAGE }))
    || { fixes: lensFindings.filter(isBlocking), noise: [] } // judges died → fix our own blocking lens findings, leave externals to /land's thread gate
  if (triage.fixes.length > 0) {
    await dispatchFixes(triage.fixes, plan, 'postpush')
    const ppGate = await agent(buildGatePrompt, { label: 'gate:postpush', phase: 'PostPush', model: 'sonnet', schema: GATE })
    await agent(`Push the fix commits: \`git -C ${WT} push\`. ${transientRule} Report done.`, { label: 'push:postpush', phase: 'PostPush', model: 'sonnet', effort: 'low', schema: DONE })
    if (ppGate && ppGate.status !== 'passed') {
      return {
        escalation: 'needs-human', reason: `build gate ${ppGate.status} after post-push fixes`,
        prNumber: pr.prNumber, prUrl: pr.prUrl, size: sized.size,
        plan: { goal: plan.goal, difficulty: plan.difficulty }, implSummary: impl.summary,
        gate: ppGate.status, fixRounds: round, bonusRound, adjudication, postPush: { lensFindings: lensFindings.length, external: { receivedAny: ext.receivedAny, timedOut: ext.timedOut }, triage: { fixed: triage.fixes.length, noise: triage.noise.length } },
        unresolvedBlocking: [], resolvedInLoop, escapeHatch, droppedLow, acLedger: latestAcCheck,
      }
    }
  }
  if (ext.items.length > 0) {
    await agent(replyPrompt(pr, triage), { label: 'external:reply', phase: 'PostPush', model: 'sonnet', effort: 'low', schema: DONE })
  }
}

phase('Ledger')
const ledger = await agent(ledgerPrompt(pr, latestAcCheck), { label: 'ledger', phase: 'Ledger', model: 'sonnet', schema: DONE })

return {
  escalation: null,
  prNumber: pr.prNumber, prUrl: pr.prUrl, rebased: pr.rebased,
  size: sized.size,
  plan: { goal: plan.goal, approach: plan.approach, difficulty: plan.difficulty, files: plan.files, milestones: plan.milestones },
  implModel, implSummary: impl.summary, implDeviations: impl.deviations,
  gate: gate.status, fixRounds: round, bonusRound, adjudication,
  postPush: {
    lensFindings: lensFindings.length,
    external: { receivedAny: ext.receivedAny, timedOut: ext.timedOut, items: ext.items.length },
    triage: { fixed: triage.fixes.length, noise: triage.noise.length },
  },
  ledgerPosted: !!(ledger && ledger.done),
  acLedger: latestAcCheck, scopeCreep: latestAcCheck.scopeCreep || [],
  resolvedInLoop, escapeHatch, droppedLow,
}
