#!/usr/bin/env node
// Smoke harness for workflows/issue-fixed.mjs — the only executable spec of the result
// contract the /flow:issue-fixed conductor reads. Four passes, no network, no agents:
//   1. parse gate (the script has a top-level export + return; node --check can't load it)
//   2. null-cascade: every agent dies → salvage paths logged, controlled design-panel throw
//   3. happy path with one unverified push → headInSync downgrade, reply gating, result shape
//   4. refused security seat → cross-family retry, then a visible gap (never a clean pass)
//   5. codex seat overrides → transport flags in the prompts, marker findings logged+dropped
//   6. evidence visibility → the `evidence-public` ack gates what the ledger may publish
//   7. dead post-push build gate → escalates as unknown, never falls through as passed
// Every schema passed to agent() is validated: required ⊆ properties, recursively.
// Run: node plugins/flow/scripts/smoke-issue-fixed.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'issue-fixed.mjs')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

let failures = 0
const check = (cond, msg) => {
  if (cond) { console.log(`  ok: ${msg}`) } else { failures++; console.error(`  FAIL: ${msg}`) }
}

// ── schema sanity: required ⊆ properties, recursively ───────────────────────
function validateSchema(schema, path = 'schema') {
  const problems = []
  const walk = (s, p) => {
    if (!s || typeof s !== 'object') return
    if (s.type === 'object') {
      const props = Object.keys(s.properties || {})
      for (const r of s.required || []) {
        if (!props.includes(r)) problems.push(`${p}: required '${r}' missing from properties`)
      }
      for (const [k, v] of Object.entries(s.properties || {})) walk(v, `${p}.${k}`)
    }
    if (s.type === 'array' && s.items) walk(s.items, `${p}[]`)
  }
  walk(schema, path)
  return problems
}

// ── load + parse gate ────────────────────────────────────────────────────────
const body = readFileSync(SRC, 'utf8').replace(/^export /m, '')
let script
try {
  script = new AsyncFunction('args', 'log', 'phase', 'agent', 'parallel', 'budget', 'workflow', body)
  console.log('parse gate')
  check(true, 'issue-fixed.mjs parses inside the workflow wrapper')
} catch (e) {
  console.error(`  FAIL: issue-fixed.mjs does not parse: ${e.message}`)
  process.exit(1)
}

const baseArgs = {
  issueNumber: 999, issueTitle: 't', issueBody: 'body', acceptanceCriteria: '1. it works',
  contextPack: 'src/', worktree: '/tmp/wt', branch: 'feat/issue-999-x', base: 'origin/main',
  envNote: 'pre-push hook runs the full nextest suite; export DATABASE_URL=postgres://x',
}

async function run(stubAgent, argsOverride) {
  const logs = []
  const calls = [] // { label, prompt }
  const schemaProblems = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ label: opts.label || '?', prompt })
    if (opts.schema) schemaProblems.push(...validateSchema(opts.schema, opts.label || '?'))
    return stubAgent(prompt, opts)
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
  let result = null, error = null
  try {
    result = await script(argsOverride || baseArgs, (m) => logs.push(String(m)), () => {}, agent, parallel, null, null)
  } catch (e) { error = e }
  return { result, error, logs, calls, schemaProblems }
}

// ── pass 2: null cascade ─────────────────────────────────────────────────────
console.log('null cascade (every agent dies)')
{
  const { error, logs, schemaProblems } = await run(async () => null)
  check(error && /all design agents returned null/.test(error.message),
    `controlled throw at the empty design panel (got: ${error ? error.message : 'no error'})`)
  check(logs.some((l) => /flow-issue-999-reports\/design/.test(l)),
    'salvage attempts logged with slugged report paths')
  check(schemaProblems.length === 0, `schemas seen are internally consistent (${schemaProblems.join('; ') || 'none broken'})`)
}

// ── pass 3: happy path, one unverified push ──────────────────────────────────
console.log('happy path (post-push fix round, push NOT verified, handoff claims green)')
const finding = { severity: 'medium', title: 'lens finding', file: 'x.rs', line: 1, detail: 'd', systemic: false, confidence: 80 }
let happyStub
{
  const byLabel = {
    size: { size: 'small', expectedFiles: 1, rationale: 'r' },
    synthesize: { goal: 'g', approach: 'a', difficulty: 'standard', files: ['x.rs'], milestones: ['m1'], testPlan: 'tp', risks: '', blockingAmbiguity: '' },
    'plan:persist': 'ok',
    impl: { summary: 'built it', deviations: '' },
    'ac-check': { criteria: [{ criterion: 'c1', status: 'met', evidence: 'test x passed', detail: '' }], scopeCreep: [] },
    'doc-sync': { done: true, note: '' },
    publish: { prNumber: 42, prUrl: 'https://x/pr/42', rebased: true, conflict: false, headPushed: true, closesLinked: true },
    'lens:tests': { findings: [finding] },
    'external:poll': { items: [{ author: 'coderabbitai', kind: 'thread', body: 'b', path: 'p', line: 1, headSha: '' }], receivedAny: true, timedOut: false },
    triage: { fixes: [finding], noise: [] },
    'gate:postpush': { status: 'passed', output: '' },
    'push:postpush': { pushed: false, headSha: 'aaa', remoteSha: 'bbb', note: 'pre-push hook failed: DATABASE_URL unset' },
    ledger: { done: true, note: '' },
    handoff: { ciStatus: 'green', ciDetail: '', headInSync: false, localAhead: 2, lateExternalItems: 0, closesLinked: true, finalSummary: 's' },
  }
  happyStub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (label in byLabel) return byLabel[label]
    if (label.startsWith('design:')) return { approach: `design via ${label}`, files: ['x.rs'], keyDecisions: '', testStrategy: '', risks: '', blockingAmbiguity: '' }
    if (label.startsWith('review:') || label.startsWith('lens:')) return { findings: [] }
    if (label.startsWith('fix:')) return { summary: 'fixed', deviations: '' }
    if (label.startsWith('gate') || label === 'build-gate') return { status: 'passed', output: '' }
    if (label === 'external:reply') return { done: true, note: '' }
    return null
  }
  const { result, error, logs, calls, schemaProblems } = await run(happyStub)
  check(!error, `run completes without throwing (${error ? error.message : 'clean'})`)
  check(schemaProblems.length === 0, `schemas seen are internally consistent (${schemaProblems.join('; ') || 'none broken'})`)
  if (result) {
    check(result.escalation === null, 'happy-path escalation is null')
    check(result.prNumber === 42, 'PR number threaded through')
    check(result.handoff.headInSync === false, 'handoff.headInSync surfaces')
    check(result.handoff.ciStatus === 'pending', `green-with-stale-head downgraded to pending (got: ${result.handoff.ciStatus})`)
    check(result.postPush.pushed === false, 'postPush.pushed carries the unverified push')
    check(!calls.some((c) => c.label === 'external:reply'), 'external replies SKIPPED when the fix push is unverified')
    check(logs.some((l) => /skipping external replies/.test(l)), 'reply skip is logged')
    check(logs.some((l) => /push:postpush NOT VERIFIED/.test(l)), 'unverified push is logged loudly')
    const handoffCall = calls.find((c) => c.label === 'handoff')
    check(handoffCall && /HEAD SYNC FIRST/.test(handoffCall.prompt), 'handoff prompt carries step 0 (head sync)')
    check(handoffCall && /could not verify its push/.test(handoffCall.prompt), 'handoff prompt carries the push-repair note')
    const pushCall = calls.find((c) => c.label === 'push:postpush')
    check(pushCall && /Environment note/.test(pushCall.prompt), 'push prompt carries the envNote')
    check(pushCall && /ls-remote/.test(pushCall.prompt), 'push prompt demands ls-remote verification')
    const publishCall = calls.find((c) => c.label === 'publish')
    check(publishCall && /headPushed/.test(publishCall.prompt) && /Environment note/.test(publishCall.prompt), 'publish prompt verifies the initial push + carries the envNote')
    check(result.securityReviewUnavailable === false, 'a live security seat leaves securityReviewUnavailable false')
    const implCall = calls.find((c) => c.label === 'impl')
    check(implCall && /Do NOT spawn subagents/.test(implCall.prompt), 'impl prompt caps sub-delegation')
    check(implCall && /report completion only when/.test(implCall.prompt), 'impl prompt guards premature completion')
    check(logs.some((l) => /difficulty=standard → impl on opus\/medium/.test(l)), 'standard difficulty routes impl to opus/medium')
    check(logs.some((l) => /fallback opus\/high/.test(l)), 'the impl fallback goes one rung UP, not down')
    check(result.coverage && result.coverage.reviews.includes('codex'), 'coverage names the configured review lenses')
    check(result.coverage && result.coverage.reviewsDelivered === 4, `all 4 lenses delivered (got ${result.coverage && result.coverage.reviewsDelivered})`)
    const lensComments = calls.find((c) => c.label === 'lens:comments')
    check(lensComments && /adversarial-review/.test(lensComments.prompt) && /--effort max/.test(lensComments.prompt) && /--model gpt-5\.6-luna/.test(lensComments.prompt),
      'comments lens runs luna/max on the codex transport')
    for (const k of ['tests', 'silent-failures', 'types']) {
      const c = calls.find((x) => x.label === `lens:${k}`)
      check(c && /--effort high/.test(c.prompt) && /--model gpt-5\.6-sol/.test(c.prompt), `${k} lens runs sol/high on the codex transport`)
    }
    const lensTests = calls.find((c) => c.label === 'lens:tests')
    check(lensTests && /behavioral test coverage/.test(lensTests.prompt) && /<<'FOCUS'/.test(lensTests.prompt), 'lens focus rides the transport stdin')
  } else {
    failures++
    console.error('  FAIL: no result object returned')
  }
}

// ── pass 4: refused security seat ────────────────────────────────────────────
// The one silence the fabric cannot absorb: a classifier refusal returns null, which is
// indistinguishable from a thinner fabric. The run must retry across model families and,
// failing that, carry the gap out to the human rather than read as a clean pass.
console.log('security seat refused on both families')
{
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (label === 'review:security' || label === 'review:security:fable-fallback') return null
    if (label === 'review:security:salvage' || label === 'review:security:fable-fallback:salvage') return null
    return happyStub(prompt, opts)
  }
  const { result, error, logs, calls } = await run(stub)
  check(!error, `run completes without throwing (${error ? error.message : 'clean'})`)
  check(calls.some((c) => c.label === 'review:security:fable-fallback'), 'a null security seat retries on the other model family')
  check(result && result.securityReviewUnavailable === true, 'both families empty → securityReviewUnavailable surfaces in the result')
  check(logs.some((l) => /SECURITY REVIEW UNAVAILABLE/.test(l)), 'the gap is logged loudly, not swallowed')
  check(result && result.escalation === null, 'the gap is reported, not auto-escalated (the conductor decides)')
  check(result && result.coverage.reviewsDelivered < result.coverage.reviews.length, `coverage shows the shortfall (${result && result.coverage.reviewsDelivered}/${result && result.coverage.reviews.length})`)
  check(logs.some((l) => /review coverage: 3 of 4/.test(l)), 'the thinned fabric is logged as a coverage line')
}

// ── pass 5: codex seat overrides + marker hygiene ────────────────────────────
// The codex legs run on the codex-exec transport that ships in this plugin. Overrides must
// reach the shell command verbatim; marker findings (CODEX_UNAVAILABLE / CODEX_FAST_DEGRADED)
// are observability and must be logged then dropped, never surfaced as review signal.
console.log('codex seat overrides (luna/max/fast, explicit pluginRoot)')
{
  const stub = async (prompt, opts = {}) => {
    if ((opts.label || '') === 'review:codex') return { findings: [
      { severity: 'low', title: 'CODEX_FAST_DEGRADED', file: '', line: 0, detail: 'tier omitted', systemic: false, confidence: 100 },
    ] }
    return happyStub(prompt, opts)
  }
  const args = { ...baseArgs, codexModel: 'gpt-5.6-luna', codexEffort: 'max', codexFast: true, pluginRoot: '/plugroot' }
  const { result, error, logs, calls } = await run(stub, args)
  check(!error, `run completes without throwing (${error ? error.message : 'clean'})`)
  const design = calls.find((c) => c.label === 'design:codex')
  check(design && design.prompt.includes('CODEX="/plugroot/scripts/codex-exec.mjs"'), 'explicit pluginRoot resolves the transport without a glob')
  check(design && /--model gpt-5\.6-luna/.test(design.prompt) && /--effort max/.test(design.prompt) && /--fast/.test(design.prompt), 'design leg carries model/effort/fast overrides')
  check(design && /CODEX_UNAVAILABLE: <error\.kind>/.test(design.prompt), 'design leg keeps the envelope-aware unavailable sentinel')
  const review = calls.find((c) => c.label === 'review:codex')
  check(review && /adversarial-review --cwd/.test(review.prompt) && /--effort max/.test(review.prompt), 'adversarial leg runs the transport with the effort override')
  check(review && /confidence = 55/.test(review.prompt), 'codex findings keep the inferred-not-executed confidence rule')
  for (const [name, c] of [['design', design], ['review', review]]) {
    check(c && /timeout parameter set to 600000/.test(c.prompt) && /--timeout-secs 540/.test(c.prompt),
      `${name} leg sizes the Bash timeout against the transport's 540s total budget`)
  }
  const lensT = calls.find((c) => c.label === 'lens:tests')
  check(lensT && /--model gpt-5\.6-sol/.test(lensT.prompt) && /--effort high/.test(lensT.prompt), 'lens seats stay pinned under --codex-* overrides')
  check(lensT && /--fast/.test(lensT.prompt), '--codex-fast passes through to the lens seats')
  check(logs.some((l) => /codex seats: model=gpt-5\.6-luna \(override\) effort=max \(override\) fast=true/.test(l)), 'overrides are logged at launch, marked as overrides')
  check(logs.some((l) => /fast tier silently dropped/.test(l)), 'CODEX_FAST_DEGRADED marker is logged')
  check(result && !(result.droppedLow || []).some((f) => /CODEX_FAST_DEGRADED/.test(f.title)), 'marker finding dropped, not surfaced as review signal')
}
console.log('codex defaults (bad effort ignored, uninterpolated pluginRoot falls back to glob)')
{
  const args = { ...baseArgs, codexEffort: 'turbo', pluginRoot: '${CLAUDE_PLUGIN_ROOT}' }
  const { logs, calls, error } = await run(happyStub, args)
  check(!error, `run completes without throwing (${error ? error.message : 'clean'})`)
  check(logs.some((l) => /codexEffort 'turbo'.*ignored/.test(l)), 'invalid codexEffort is ignored with a visible log')
  const design = calls.find((c) => c.label === 'design:codex')
  check(design && design.prompt.includes('cache/*/flow/*/scripts/codex-exec.mjs'), 'uninterpolated ${CLAUDE_PLUGIN_ROOT} falls back to the same-plugin glob')
  check(design && /--effort high/.test(design.prompt), 'design leg default effort stays pinned at high')
  const review = calls.find((c) => c.label === 'review:codex')
  // Regression guard: an omitted flag would inherit ~/.codex/config.toml, which the Codex TUI
  // rewrites with the user's interactive picks — the review seat's strength must not drift
  // with unrelated sessions. Both knobs are stated, always.
  check(review && /--effort high/.test(review.prompt) && /--model gpt-5\.6-sol/.test(review.prompt),
    'adversarial leg pins its own model+effort rather than inheriting config.toml')
  check(design && /--model gpt-5\.6-sol/.test(design.prompt), 'design leg pins its model too')
  check(logs.some((l) => /codex seats: model=gpt-5\.6-sol effort=high fast=false/.test(l)),
    'seat defaults are logged concretely, never as "default"')
}

// ── pass 6: evidence visibility gate ─────────────────────────────────────────
// Publishing a capture to the public plans host needs the `evidence-public` ack AND a
// per-criterion `visibility: public`. The ack is a conductor-resolved boolean, never a
// ledger judgment, and its absence must shut the public host regardless of the AC text.
console.log('evidence visibility gate')
{
  const acText = '- [ ] Banner names the field.\n  - evidence: screenshot\n  - surface: artifact\n  - visibility: public'
  const withAck = await run(happyStub, { ...baseArgs, acceptanceCriteria: acText, evidencePublic: true })
  const ledgerOn = withAck.calls.find((c) => c.label === 'ledger')
  check(ledgerOn && /carries the `evidence-public` ack/.test(ledgerOn.prompt), 'acked run tells the ledger public is available')
  check(ledgerOn && /plans publish --public --keep/.test(ledgerOn.prompt), 'acked run names the --public invocation')
  check(ledgerOn && ledgerOn.prompt.includes('visibility: public'), 'declared AC fields reach the ledger verbatim')

  const noAck = await run(happyStub, { ...baseArgs, acceptanceCriteria: acText })
  const ledgerOff = noAck.calls.find((c) => c.label === 'ledger')
  check(ledgerOff && /NO `evidence-public` ack/.test(ledgerOff.prompt), 'unacked run tells the ledger nothing publishes publicly')
  check(ledgerOff && !/--public/.test(ledgerOff.prompt), 'unacked run never names --public, even with visibility: public in the AC text')
  check(ledgerOff && /unacked is unpublished/.test(ledgerOff.prompt), 'unacked run states the override explicitly')
}

// ── pass 7: dead post-push build gate ────────────────────────────────────────
// UNKNOWN ≠ pass covers the post-push gate too. It once guarded on `ppGate &&`, so a null
// skipped the escalation and returned a run whose post-push build was never verified.
console.log('post-push build gate dies')
{
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (label === 'gate:postpush' || label === 'gate:postpush:salvage') return null
    return happyStub(prompt, opts)
  }
  const { result, error } = await run(stub)
  check(!error, `run completes without throwing (${error ? error.message : 'clean'})`)
  check(result && result.escalation === 'needs-human', `a dead post-push gate escalates (got ${result && result.escalation})`)
  check(result && result.gate === 'unknown', `the unknown verdict is reported, never read as passed (got ${result && result.gate})`)
  check(result && /build gate unknown after post-push fixes/.test(result.reason || ''), 'the escalation reason names the gate')
}

console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
