#!/usr/bin/env node
// Smoke harness for workflows/issue.mjs — the only executable spec of the result
// contract the /flow:issue conductor reads. Three passes, no network, no agents:
//   1. parse gate (the script has a top-level export + return; node --check can't load it)
//   2. null-cascade: every agent dies → salvage paths logged, controlled design-panel throw
//   3. happy path with one unverified push → headInSync downgrade, reply gating, result shape
// Every schema passed to agent() is validated: required ⊆ properties, recursively.
// Run: node plugins/flow/scripts/smoke-issue.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'issue.mjs')
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
  check(true, 'issue.mjs parses inside the workflow wrapper')
} catch (e) {
  console.error(`  FAIL: issue.mjs does not parse: ${e.message}`)
  process.exit(1)
}

const baseArgs = {
  issueNumber: 999, issueTitle: 't', issueBody: 'body', acceptanceCriteria: '1. it works',
  contextPack: 'src/', worktree: '/tmp/wt', branch: 'feat/issue-999-x', base: 'origin/main',
  envNote: 'pre-push hook runs the full nextest suite; export DATABASE_URL=postgres://x',
}

async function run(stubAgent) {
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
    result = await script(baseArgs, (m) => logs.push(String(m)), () => {}, agent, parallel, null, null)
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
{
  const finding = { severity: 'medium', title: 'lens finding', file: 'x.rs', line: 1, detail: 'd', systemic: false, confidence: 80 }
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
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (label in byLabel) return byLabel[label]
    if (label.startsWith('design:')) return { approach: `design via ${label}`, files: ['x.rs'], keyDecisions: '', testStrategy: '', risks: '', blockingAmbiguity: '' }
    if (label.startsWith('review:') || label.startsWith('lens:')) return { findings: [] }
    if (label.startsWith('fix:')) return { summary: 'fixed', deviations: '' }
    if (label.startsWith('gate') || label === 'build-gate') return { status: 'passed', output: '' }
    if (label === 'external:reply') return { done: true, note: '' }
    return null
  }
  const { result, error, logs, calls, schemaProblems } = await run(stub)
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
  } else {
    failures++
    console.error('  FAIL: no result object returned')
  }
}

console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
