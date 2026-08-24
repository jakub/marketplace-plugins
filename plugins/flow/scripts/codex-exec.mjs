#!/usr/bin/env node
// codex-exec.mjs - the single transport between flow and the Codex CLI.
//
// Everything here talks to the raw `codex` binary; the delegate agent and the issue
// workflow call this script and nothing else, so there is exactly one place where flags,
// parsing, retries, and validation live. The transport ships in this plugin so no external
// path can silently break it.
//
// Modes:
//   task                 codex exec: read-only by default, optional --write / --schema
//   review               codex exec review (--base <ref> | --uncommitted): prose reviewed
//                        into findings via the CLI's stable "[P1] title - file:line" format
//   adversarial-review   codex exec + --output-schema over `git diff <base>...HEAD` with an
//                        adversarial framing - structured findings, no parsing heuristics
//
// Contract: stdout carries exactly ONE JSON envelope; exit 0 whenever an envelope was
// produced (even ok:false - the envelope IS the report). Nonzero exit = the wrapper itself
// broke. Callers branch on .ok / .error.kind, never on grep.
//
// Facts this file encodes (as-of 2026-08-23, codex-cli 0.149.0 - re-verify quarterly):
// effort only exists as `-c model_reasoning_effort=`; fast mode is `-c service_tier=priority`
// and an unsupported tier is OMITTED with only a stderr warning (fail-open - we detect and
// report it); request errors surface as `ERROR: {json}` lines and/or error-type items;
// `exec review` rejects a custom prompt alongside --base/--uncommitted.
//
// `exec --json` streams whole items, never token deltas - the delta notifications
// (AgentMessageDelta, ReasoningSummaryTextDelta, CommandExecutionOutputDelta) exist only in
// the experimental app-server JSON-RPC protocol. So the ONLY liveness signal during a turn is
// the reasoning-summary item, which lands every ~10s while the model thinks. Measured on
// 0.149.0: summaries on = an event every 9-10s across a 143s think; `model_reasoning_summary
// = "none"` = a flat zero events for the whole think. Final-message generation is silent
// either way (137s of nothing for a 4000-word answer), as is a running command (item.started,
// then nothing until it completes - item.updated does not carry aggregated output).
//
// The tuning set (model, effort, service tier, reasoning summary) is ALWAYS sent explicitly,
// defaulted here when a caller omits it. `~/.codex/config.toml` is mutable state - the Codex
// TUI writes the user's interactive picks back to it - so an omitted flag does not mean "the
// documented default", it means "whatever that user last selected in an unrelated session".
// Inheriting it makes a seat's strength drift silently and undetectably, and for the summary
// setting it silences the heartbeat and hands every long run to the stall watchdog. Same rule
// as --cwd: explicit or nothing.

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const MODES = ['task', 'review', 'adversarial-review']
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MODEL_RE = /^[a-z0-9][a-z0-9.-]*$/ // shape check only - the catalog is server-driven
const DEFAULT_MODEL = 'gpt-5.6-sol' // the decorrelation seat; never inherited from config.toml
const DEFAULT_EFFORT = 'high'
const DEFAULT_TIMEOUT = { task: 900, review: 1200, 'adversarial-review': 1200 }
// Sized against the longest window the CLI reports nothing through: final-message
// generation, which scales with answer length (137s measured for ~4000 words). The pinned
// reasoning summary covers the thinking phase at ~10s. Silence past this is wedged, not slow.
const DEFAULT_STALL = 420
// No TIMEOUT here: the attempt deadline is the whole remaining budget, so a TIMEOUT means
// the budget is spent and the remaining-budget check below would refuse the retry anyway.
const RETRYABLE = ['RATE_LIMIT', 'STALL']
const RATE_LIMIT_BACKOFF_MS = Number(process.env.CODEX_EXEC_BACKOFF_MS || 30_000)
const BIN = process.env.CODEX_BIN || 'codex'

// Findings shape for adversarial-review, enforced server-side via --output-schema.
// Every property is required (structured-output strict mode) - codex sends "" when empty.
const ADVERSARIAL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'title', 'file', 'line', 'detail', 'recommendation'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string' },
          file: { type: 'string', description: 'path relative to the repo root' },
          line: { type: 'integer', description: 'first affected line of the NEW code' },
          detail: { type: 'string' },
          recommendation: { type: 'string' },
        },
      },
    },
  },
}

const adversarialPrompt = (base, extra) => `You are an adversarial code reviewer. In this repository, run:
  git diff ${base}...HEAD
Review ONLY that diff (read surrounding code for context as needed). Hunt for real defects: correctness bugs, races/TOCTOU, injection (SQL/HTML/shell/template), secret handling, authz gaps, unsafe deserialization, error-handling holes, reachable panics in production paths, trust-boundary leaks. Do not report style or formatting.
Severity: critical = ship-stopping if merged; high = a real defect a user can hit; medium = a defect on an edge path; low = minor. A reachable panic, crash, or DoS triggerable by request-controlled input is never below medium.
Cite file paths relative to the repo root and the first affected line of the new code. Read-only - write NO files.
${extra ? `Additional reviewer focus from the caller:\n${extra}\n` : ''}Report every finding through the output schema. No findings → an empty findings array.`

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { mode: argv[0], timeoutSecs: null, stallSecs: null }
  const flags = argv.slice(1)
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]
    const next = () => {
      i++
      if (i >= flags.length) throw new Error(`${f} requires a value`)
      return flags[i]
    }
    if (f === '--cwd') a.cwd = next()
    else if (f === '--model') a.model = next()
    else if (f === '--effort') a.effort = next()
    else if (f === '--fast') a.fast = true
    else if (f === '--write') a.write = true
    else if (f === '--schema') a.schema = next()
    else if (f === '--base') a.base = next()
    else if (f === '--uncommitted') a.uncommitted = true
    else if (f === '--timeout-secs') a.timeoutSecs = Number(next())
    else if (f === '--stall-secs') a.stallSecs = Number(next())
    else if (f === '--events') a.events = next()
    else throw new Error(`unknown flag: ${f}`)
  }
  return a
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  // Buffer-by-Buffer += decodes each chunk independently, corrupting a multi-byte
  // character that straddles a 64 KiB read boundary - decode as one utf8 stream.
  process.stdin.setEncoding('utf8')
  let buf = ''
  for await (const chunk of process.stdin) buf += chunk
  return buf
}

// ── minimal structural JSON-schema check (required/type/enum/additionalProperties) ──
function validateAgainst(schema, value, path = '$') {
  const errs = []
  if (!schema || typeof schema !== 'object') return errs
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: not in enum [${schema.enum.join(', ')}]`)
  const t = schema.type
  if (t === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: expected object`]
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${path}: missing required '${r}'`)
    const props = schema.properties || {}
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) if (!(k in props)) errs.push(`${path}: unexpected key '${k}'`)
    }
    for (const [k, sub] of Object.entries(props)) if (k in value) errs.push(...validateAgainst(sub, value[k], `${path}.${k}`))
  } else if (t === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected array`]
    if (schema.items) value.forEach((v, i) => errs.push(...validateAgainst(schema.items, v, `${path}[${i}]`)))
  } else if (t === 'string' && typeof value !== 'string') errs.push(`${path}: expected string`)
  else if (t === 'integer' && !Number.isInteger(value)) errs.push(`${path}: expected integer`)
  else if (t === 'number' && typeof value !== 'number') errs.push(`${path}: expected number`)
  else if (t === 'boolean' && typeof value !== 'boolean') errs.push(`${path}: expected boolean`)
  return errs
}

// ── review-comment parsing: "- [P1] title - file:line[-line]" + indented detail ──
function parseReviewFindings(text) {
  const head = /^\s*[-*]?\s*\[P(\d)\]\s*(.*?)\s+(?:—|–|--)\s+(\S+?):(\d+)(?:-(\d+))?\s*$/
  const out = []
  let cur = null
  for (const line of String(text || '').split('\n')) {
    const m = line.match(head)
    if (m) {
      if (cur) out.push(cur)
      cur = { priority: Number(m[1]), title: m[2].trim(), file: m[3], line: Number(m[4]), lineEnd: Number(m[5] || m[4]), detail: '' }
      continue
    }
    if (!cur) continue
    if (/^\s+\S/.test(line)) cur.detail += (cur.detail ? '\n' : '') + line.trim()
    else if (line.trim() !== '') { out.push(cur); cur = null }
  }
  if (cur) out.push(cur)
  return out
}

// ── error classification ─────────────────────────────────────────────────────
function classify({ spawnError, killedBy, exitCode, errorText }) {
  if (spawnError && spawnError.code === 'ENOENT') return 'NOT_INSTALLED'
  if (spawnError) return 'UNKNOWN'
  if (killedBy === 'stall') return 'STALL'
  if (killedBy === 'timeout') return 'TIMEOUT'
  if (exitCode === 2) return 'USAGE'
  const t = errorText
  if (/rate limit|too many requests|usage limit|"status":\s*429/i.test(t)) return 'RATE_LIMIT'
  if (/sign in again|log ?out and sign in|access token could not be refreshed|"status":\s*401|not logged in/i.test(t)) return 'AUTH'
  if (/model[^.]*not supported|not supported[^.]*model|unknown model/i.test(t)) return 'BAD_MODEL'
  if (/reasoning[^.]*(effort|level)|effort[^.]*not supported/i.test(t)) return 'BAD_EFFORT'
  return 'UNKNOWN'
}

// ── one codex run: spawn, stream JSONL, watchdogs, collect ───────────────────
// The detached child outlives a killed wrapper unless someone reaps it - a workspace-write
// codex still mutating a worktree after the workflow moved on is unacceptable. Catchable
// terminations sweep the process group; only an uncatchable SIGKILL of the wrapper orphans it.
let activeChild = null
const reapChild = () => {
  if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
    try { process.kill(-activeChild.pid, 'SIGKILL') } catch {}
  }
}
process.on('exit', reapChild)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { reapChild(); process.exit(1) })

function runOnce({ argvTail, promptText, spawnCwd, eventsFile, stallMs, timeoutMs }) {
  return new Promise((resolve) => {
    const r = {
      spawnError: null, killedBy: null, exitCode: null,
      finalMsg: '', usage: null, errorLines: [], noise: [], stderr: '',
    }
    let child
    try {
      child = spawn(BIN, argvTail, { cwd: spawnCwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      r.spawnError = e
      return resolve(r)
    }
    activeChild = child
    let done = false
    let lastEvent = Date.now()
    const kill = (why) => {
      // exitCode guard: the timers phase can preempt a queued 'close' - never mark a child
      // that already exited cleanly as watchdog-killed.
      if (done || child.exitCode !== null || child.signalCode !== null) return
      r.killedBy = why
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
    }
    const stallTimer = setInterval(() => { if (Date.now() - lastEvent > stallMs) kill('stall') }, 1_000)
    const deadlineTimer = setTimeout(() => kill('timeout'), timeoutMs)
    const finish = () => {
      if (done) return
      done = true
      clearInterval(stallTimer)
      clearTimeout(deadlineTimer)
      resolve(r)
    }
    child.on('error', (e) => { r.spawnError = e; finish() })
    child.on('close', (code) => {
      r.exitCode = code
      if (code === 0) r.killedBy = null // belt for the same race: a clean exit was never killed
      finish()
    })
    child.stdin.on('error', () => {}) // child may exit before reading the prompt
    if (promptText !== null) child.stdin.end(promptText)
    else child.stdin.end()

    createInterface({ input: child.stdout }).on('line', (line) => {
      lastEvent = Date.now()
      try { appendFileSync(eventsFile, line + '\n') } catch {}
      let ev
      try { ev = JSON.parse(line) } catch { r.noise.push(line); return }
      if (ev.type === 'item.completed' && ev.item) {
        if (ev.item.type === 'agent_message' && typeof ev.item.text === 'string') r.finalMsg = ev.item.text
        // Enabled under-development features inject warning items typed "error" - noise, not failure.
        if (ev.item.type === 'error' && !/^Under-development features enabled/.test(ev.item.message || '')) {
          r.errorLines.push(ev.item.message || JSON.stringify(ev.item))
        }
      }
      if (ev.type === 'turn.completed' && ev.usage) r.usage = ev.usage
    })
    createInterface({ input: child.stderr }).on('line', (line) => {
      lastEvent = Date.now()
      r.stderr += line + '\n'
      try { appendFileSync(eventsFile, JSON.stringify({ type: 'wrapper.stderr', line }) + '\n') } catch {}
      const m = line.match(/^ERROR:\s*(\{.*\})\s*$/)
      if (m) r.errorLines.push(m[1])
    })
  })
}

// ── main ─────────────────────────────────────────────────────────────────────
const startedAt = Date.now()
let a
try {
  a = parseArgs(process.argv.slice(2))
} catch (e) {
  a = { mode: process.argv[2], parseError: e.message }
}
const tmpBase = mkdtempSync(join(tmpdir(), 'codex-exec-'))

// This run's dir has to outlive the process: with no --events, the envelope's eventsPath
// points inside it, and deleting it on exit would hand the caller a path that no longer
// resolves. So sweep the PREVIOUS runs' dirs instead - otherwise every nightly lint and
// every delegate call leaves one behind until the machine reboots. A run can hold its dir
// open for at most --timeout-secs, which the arg check caps at 7200s, so a 24h floor
// cannot race a live sibling; nobody reads yesterday's event journal either.
const STALE_TMP_MS = 24 * 60 * 60 * 1000
try {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('codex-exec-')) continue
    const p = join(tmpdir(), name)
    if (p === tmpBase) continue
    try { if (Date.now() - statSync(p).mtimeMs > STALE_TMP_MS) rmSync(p, { recursive: true, force: true }) } catch {}
  }
} catch {}

const eventsFile = (a && a.events) || join(tmpBase, 'events.jsonl')
const lastMsgFile = join(tmpBase, 'last-message.txt')

const envelope = (fields) => ({
  ok: false, mode: a.mode || null, model: a.model || null, effort: a.effort || null,
  fast: { requested: !!a.fast, applied: false },
  exitCode: null, durationMs: Date.now() - startedAt,
  tokens: null, output: '', findings: null, structured: null,
  error: null, eventsPath: eventsFile,
  ...fields,
})
// Emit exactly one envelope, then unwind. `process.exit()` right after a write truncates
// stdout at the 64 KiB pipe buffer - and a pipe is how every caller reads this - so the
// exit rides the write callback (fires once the reader has drained us) and an Emitted
// throw stops the remaining top-level flow. Anything else reaching the unwind handlers is
// a genuine wrapper bug: stderr + exit 1, the one case callers may treat as "no envelope".
class Emitted extends Error {}
const unwind = (e) => {
  if (e instanceof Emitted) return
  process.stderr.write(`codex-exec wrapper failure: ${(e && e.stack) || e}\n`)
  process.exit(1)
}
process.on('uncaughtException', unwind)
process.on('unhandledRejection', unwind)
const emit = (fields) => {
  process.exitCode = 0
  process.stdout.write(JSON.stringify(envelope(fields), null, 2) + '\n', () => process.exit(0))
  throw new Emitted()
}
const usage = (detail) => emit({ error: { kind: 'USAGE', detail, retried: false } })

// input validation - fail fast, before any spawn
if (a.parseError) usage(a.parseError)
if (!MODES.includes(a.mode)) usage(`mode must be one of ${MODES.join(' | ')} (got: ${a.mode || 'nothing'})`)
if (!a.cwd) usage('--cwd is required (always explicit - never inherited from the caller\'s process)')
if (!existsSync(a.cwd) || !statSync(a.cwd).isDirectory()) usage(`--cwd is not a directory: ${a.cwd}`)
if (a.effort && !EFFORTS.includes(a.effort)) usage(`--effort must be one of ${EFFORTS.join('|')} (got: ${a.effort})`)
if (a.model && !MODEL_RE.test(a.model)) usage(`--model has an implausible shape: ${a.model}`)
for (const [name, v] of [['--timeout-secs (total across attempts)', a.timeoutSecs], ['--stall-secs', a.stallSecs]]) {
  if (v !== null && (!Number.isInteger(v) || v < 1 || v > 7200)) usage(`${name} must be an integer in [1, 7200]`)
}
if (a.write && a.mode !== 'task') usage('--write only applies to task mode - reviews are read-only by definition')
if (a.schema && a.mode !== 'task') usage('--schema only applies to task mode (adversarial-review has a built-in schema)')

let schemaObj = null
if (a.schema) {
  if (!existsSync(a.schema)) usage(`--schema file not found: ${a.schema}`)
  try { schemaObj = JSON.parse(readFileSync(a.schema, 'utf8')) } catch (e) { usage(`--schema is not valid JSON: ${e.message}`) }
  if (!schemaObj || schemaObj.type !== 'object') usage('--schema must be a JSON Schema with top-level type "object"')
}

if (a.mode === 'adversarial-review' && !a.base) usage('adversarial-review requires --base <ref>')
if (a.mode === 'review' && !a.base && !a.uncommitted) usage('review requires --base <ref> or --uncommitted')
if (a.base) {
  const rev = spawnSync('git', ['-C', a.cwd, 'rev-parse', '--verify', '--quiet', `${a.base}^{commit}`], { encoding: 'utf8' })
  if (rev.status !== 0) usage(`--base does not resolve to a commit in ${a.cwd}: ${a.base}`)
}

const stdinText = await readStdin()
if (a.mode === 'task' && !stdinText.trim()) usage('task mode needs a prompt on stdin')
if (a.mode === 'review' && stdinText.trim()) usage('review mode takes no prompt - the CLI rejects a custom prompt alongside --base/--uncommitted (use adversarial-review for framed reviews)')

// Pin the tuning set AFTER validation, so an explicit bad value still errors rather than
// being silently replaced. From here on a.model/a.effort are concrete and the envelope
// reports what actually ran instead of a null that means "ask config.toml".
a.model = a.model || DEFAULT_MODEL
a.effort = a.effort || DEFAULT_EFFORT

// argv assembly - all four always sent; nothing falls through to config.toml
const tuning = [
  '-m', a.model,
  '-c', `model_reasoning_effort=${a.effort}`,
  '-c', `service_tier=${a.fast ? 'priority' : 'default'}`,
  // Not a quality knob: this is the watchdog's heartbeat. `none` in config.toml makes an
  // entire thinking phase emit zero events, and the stall timer then kills a healthy run.
  '-c', 'model_reasoning_summary=detailed',
]
let argvTail, promptText
if (a.mode === 'review') {
  argvTail = ['exec', 'review', '--json', ...(a.base ? ['--base', a.base] : ['--uncommitted']), ...tuning]
  promptText = null
} else {
  const schemaPath = a.mode === 'adversarial-review'
    ? (writeFileSync(join(tmpBase, 'adversarial-schema.json'), JSON.stringify(ADVERSARIAL_SCHEMA)), join(tmpBase, 'adversarial-schema.json'))
    : a.schema
  argvTail = [
    'exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--json',
    '-C', a.cwd, '-s', a.write ? 'workspace-write' : 'read-only',
    '-o', lastMsgFile,
    ...(schemaPath ? ['--output-schema', schemaPath] : []),
    ...tuning,
    '-',
  ]
  promptText = a.mode === 'adversarial-review' ? adversarialPrompt(a.base, stdinText.trim()) : stdinText
}

// --timeout-secs is the TOTAL budget across attempts (callers size their Bash-tool timeout
// against it - a per-attempt deadline would silently double under the retry policy).
const totalBudgetMs = (a.timeoutSecs ?? DEFAULT_TIMEOUT[a.mode]) * 1000
const stallMs = (a.stallSecs ?? DEFAULT_STALL) * 1000
const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

let retried = false
let attempt = 1
let run, kind
for (;;) {
  // A killed attempt's -o file must never launder into this attempt's result as a false pass.
  try { rmSync(lastMsgFile, { force: true }) } catch {}
  try { appendFileSync(eventsFile, JSON.stringify({ type: 'wrapper.attempt', n: attempt, argv: [BIN, ...argvTail] }) + '\n') } catch {}
  run = await runOnce({
    argvTail, promptText, spawnCwd: a.cwd, eventsFile, stallMs,
    timeoutMs: Math.max(totalBudgetMs - (Date.now() - startedAt), 1_000),
  })
  const failed = run.spawnError || run.killedBy || run.exitCode !== 0
  kind = failed ? classify({ ...run, errorText: run.errorLines.join('\n') + '\n' + run.stderr + '\n' + run.noise.join('\n') }) : null
  if (!failed || retried || !RETRYABLE.includes(kind)) break
  const remaining = totalBudgetMs - (Date.now() - startedAt)
  if (remaining < (kind === 'RATE_LIMIT' ? RATE_LIMIT_BACKOFF_MS + 10_000 : 10_000)) break // no budget left for a real retry
  retried = true
  attempt++
  if (kind === 'RATE_LIMIT') await sleep(RATE_LIMIT_BACKOFF_MS)
}

// The -o file is codex's own record of the final message - prefer it over event capture.
let finalMsg = run.finalMsg
try {
  const fromFile = existsSync(lastMsgFile) ? readFileSync(lastMsgFile, 'utf8') : ''
  if (fromFile.trim()) finalMsg = fromFile
} catch {}

// fast mode fails OPEN upstream: an unadvertised tier is dropped with only a warning.
// Never report a fast run the server did not actually receive as fast.
const fastDegraded = a.fast && /not advertised as supported.*omitted from requests/i.test(run.stderr + '\n' + run.noise.join('\n'))

const base = {
  exitCode: run.exitCode,
  tokens: run.usage ? {
    input: run.usage.input_tokens ?? 0, cachedInput: run.usage.cached_input_tokens ?? 0,
    output: run.usage.output_tokens ?? 0, reasoning: run.usage.reasoning_output_tokens ?? 0,
  } : null,
  fast: { requested: !!a.fast, applied: !!a.fast && !fastDegraded },
  output: finalMsg,
}

if (kind) {
  const detail = (run.spawnError ? String(run.spawnError.message || run.spawnError) + '\n' : '')
    + (run.killedBy ? `killed by wrapper: ${run.killedBy} (stall ${stallMs / 1000}s / total budget ${totalBudgetMs / 1000}s)\n` : '')
    + [...run.errorLines, run.stderr.trim()].filter(Boolean).join('\n')
  emit({ ...base, error: { kind, detail: detail.slice(0, 2000) || `exit ${run.exitCode}`, retried } })
}

if (!finalMsg.trim()) {
  emit({ ...base, error: { kind: 'EMPTY_OUTPUT', detail: 'codex exited 0 but produced no final message - an empty result is UNKNOWN, never a pass', retried } })
}

// mode-specific output validation
if (a.mode === 'review') {
  emit({ ...base, ok: true, findings: parseReviewFindings(finalMsg), error: null })
}
if (a.mode === 'adversarial-review' || schemaObj) {
  let parsed
  try { parsed = JSON.parse(finalMsg) } catch (e) {
    emit({ ...base, error: { kind: 'PARSE', detail: `final message is not JSON despite --output-schema: ${e.message}\n${finalMsg.slice(0, 500)}`, retried } })
  }
  const errs = validateAgainst(a.mode === 'adversarial-review' ? ADVERSARIAL_SCHEMA : schemaObj, parsed)
  if (errs.length) {
    emit({ ...base, error: { kind: 'SCHEMA_MISMATCH', detail: errs.slice(0, 10).join('; '), retried } })
  }
  if (a.mode === 'adversarial-review') emit({ ...base, ok: true, findings: parsed.findings, error: null })
  emit({ ...base, ok: true, structured: parsed, error: null })
}
emit({ ...base, ok: true, error: null })
