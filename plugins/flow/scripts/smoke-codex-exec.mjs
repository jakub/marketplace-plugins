#!/usr/bin/env node
// Smoke harness for scripts/codex-exec.mjs - the raw-CLI codex transport. A PATH-shimmed
// fake `codex` (CODEX_BIN) replays canned JSONL so every envelope path is exercised with
// no network: flag mapping, pre-spawn USAGE rejections, error classification, the
// retry-once policy, stall/timeout watchdogs, schema validation, review-comment parsing,
// and the fast-mode silent-degrade detection. One env-gated live case (CODEX_LIVE=1) hits
// the real CLI. Run: node plugins/flow/scripts/smoke-codex-exec.mjs
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), 'codex-exec.mjs')
const T = mkdtempSync(join(tmpdir(), 'smoke-codex-'))
const FAKE = join(T, 'fake-codex.mjs')
const ARGV_FILE = join(T, 'argv.json')
const STATE = join(T, 'state')

// The fake: dumps argv, consumes stdin, then plays the scenario in FAKE_MODE.
writeFileSync(FAKE, `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2)))
let stdin = ''
try { stdin = readFileSync(0, 'utf8') } catch {}
writeFileSync(process.env.FAKE_ARGV_FILE + '.stdin', stdin)
const mode = process.env.FAKE_MODE
const say = (o) => console.log(JSON.stringify(o))
const msg = (text) => {
  say({ type: 'thread.started', thread_id: 'fake' })
  say({ type: 'turn.started' })
  say({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } })
  say({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 2 } })
  const o = process.argv.indexOf('-o')
  if (o !== -1) writeFileSync(process.argv[o + 1], text)
}
if (mode === 'happy') { msg('OK from codex') }
else if (mode === 'underdev_noise') {
  say({ type: 'item.completed', item: { id: 'i0', type: 'error', message: 'Under-development features enabled: x. Under-development features are incomplete.' } })
  msg('OK despite noise')
} else if (mode === 'schema_ok') { msg('{"a":"x"}') }
else if (mode === 'schema_bad') { msg('{"b":1}') }
else if (mode === 'adversarial') {
  msg(JSON.stringify({ findings: [{ severity: 'high', title: 'race in init', file: 'src/a.rs', line: 3, detail: 'TOCTOU on config load', recommendation: 'hold the lock' }] }))
} else if (mode === 'review_findings') {
  msg('Two problems found.\\n\\nReview comment:\\n\\n- [P1] Handle zero divisors — math.js:2-4\\n  Returns Infinity instead of null.\\n  Callers break.\\n\\n- [P2] Stale doc — README.md:10\\n  The example is wrong.')
} else if (mode === 'bad_model') {
  console.error('ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \\'x\\' model is not supported when using Codex with a ChatGPT account."}}')
  process.exit(1)
} else if (mode === 'rate_limit_once') {
  if (!existsSync(process.env.FAKE_STATE)) {
    writeFileSync(process.env.FAKE_STATE, '1')
    console.error('ERROR: {"type":"error","status":429,"error":{"message":"Rate limit exceeded"}}')
    process.exit(1)
  }
  msg('OK after retry')
} else if (mode === 'stall') {
  writeFileSync(process.env.FAKE_STATE + '.pid', String(process.pid))
  say({ type: 'thread.started', thread_id: 'fake' })
  setTimeout(() => {}, 120000)
} else if (mode === 'stale_then_empty') {
  if (!existsSync(process.env.FAKE_STATE)) {
    writeFileSync(process.env.FAKE_STATE, '1')
    const o = process.argv.indexOf('-o')
    if (o !== -1) writeFileSync(process.argv[o + 1], 'STALE ANSWER FROM ATTEMPT 1')
    say({ type: 'thread.started', thread_id: 'fake' })
    setTimeout(() => {}, 120000)
  } else { say({ type: 'turn.completed', usage: {} }) }
} else if (mode === 'big') { msg('x'.repeat(200000)) }
else if (mode === 'empty') { say({ type: 'turn.completed', usage: {} }) }
else if (mode === 'fast_degrade') {
  console.error('warning: Configured service tier \`priority\` is not advertised as supported for model \`gpt-5.5\` and will be omitted from requests.')
  msg('OK but slow')
} else { console.error('fake: unknown FAKE_MODE ' + mode); process.exit(2) }
`)
chmodSync(FAKE, 0o755)

let failures = 0
const check = (cond, msg) => {
  if (cond) console.log(`  ok: ${msg}`)
  else { failures++; console.error(`  FAIL: ${msg}`) }
}

const run = (mode, args, { input = '', bin = FAKE } = {}) => {
  rmSync(ARGV_FILE, { force: true })
  const out = execFileSync('node', [WRAPPER, ...args], {
    input,
    env: { ...process.env, CODEX_BIN: bin, FAKE_MODE: mode, FAKE_ARGV_FILE: ARGV_FILE, FAKE_STATE: STATE, CODEX_EXEC_BACKOFF_MS: '50' },
  }).toString()
  return JSON.parse(out)
}
const argvSeen = () => (existsSync(ARGV_FILE) ? JSON.parse(readFileSync(ARGV_FILE, 'utf8')) : null)
const has = (arr, ...seq) => {
  const i = arr.findIndex((v, j) => seq.every((s, k) => arr[j + k] === s))
  return i !== -1
}

console.log('the tuning set is always explicit - never inherited from config.toml')
{
  // ~/.codex/config.toml is mutable state: the Codex TUI writes the user's interactive model
  // and effort picks back to it. An omitted flag would therefore couple every flow seat to an
  // unrelated session's leftovers, silently. All four knobs are sent on every call.
  const e = run('happy', ['task', '--cwd', T], { input: 'p' })
  check(e.ok === true, 'envelope ok with no tuning flags')
  const av = argvSeen()
  check(has(av, '-m', 'gpt-5.6-sol'), 'argv: model defaulted explicitly, not omitted')
  check(has(av, '-c', 'model_reasoning_effort=high'), 'argv: effort defaulted explicitly, not omitted')
  check(has(av, '-c', 'service_tier=default'), 'argv: service tier pinned to default when --fast is absent')
  // Not a quality setting: reasoning summaries are the only thing the CLI emits during a long
  // think, so `none` in config.toml would hand every slow run to the stall watchdog.
  check(has(av, '-c', 'model_reasoning_summary=detailed'), 'argv: reasoning summary pinned - the stall watchdog heartbeat')
  check(e.model === 'gpt-5.6-sol' && e.effort === 'high', 'envelope reports what actually ran, not null')
  check(e.fast.requested === false, 'fast not requested')
}

console.log('happy path + flag mapping')
{
  const e = run('happy', ['task', '--cwd', T, '--model', 'gpt-5.6-luna', '--effort', 'max', '--fast'], { input: 'do the thing' })
  check(e.ok === true, 'envelope ok')
  check(e.output === 'OK from codex', 'output carries the final message')
  check(e.tokens && e.tokens.input === 100 && e.tokens.output === 5 && e.tokens.reasoning === 2, 'usage mapped into tokens')
  check(e.fast.requested === true && e.fast.applied === true, 'fast requested+applied with no degrade warning')
  check(e.error === null, 'no error')
  const av = argvSeen()
  check(has(av, '-m', 'gpt-5.6-luna'), 'argv: -m model')
  check(has(av, '-c', 'model_reasoning_effort=max'), 'argv: effort via -c model_reasoning_effort')
  check(has(av, '-c', 'service_tier=priority'), 'argv: --fast via -c service_tier=priority')
  check(has(av, '-c', 'model_reasoning_summary=detailed'), 'argv: reasoning summary pinned regardless of caller flags')
  check(has(av, '-s', 'read-only'), 'argv: read-only sandbox by default')
  check(av[av.length - 1] === '-', 'argv: prompt from stdin via -')
  const stdinSeen = readFileSync(ARGV_FILE + '.stdin', 'utf8')
  check(stdinSeen === 'do the thing', 'prompt passed through verbatim')
  check(existsSync(e.eventsPath), 'events journal written')
}

console.log('stale temp dirs from previous runs are swept')
{
  // The run's own dir must survive - the envelope advertises eventsPath inside it - so the
  // wrapper collects the previous runs' instead. Without that, every nightly lint and every
  // delegate call left one in /tmp until reboot.
  const stale = join(tmpdir(), 'codex-exec-smoke-stale')
  const fresh = join(tmpdir(), 'codex-exec-smoke-fresh')
  mkdirSync(stale, { recursive: true })
  mkdirSync(fresh, { recursive: true })
  writeFileSync(join(stale, 'events.jsonl'), 'x')
  const old = (Date.now() - 48 * 60 * 60 * 1000) / 1000
  utimesSync(stale, old, old)
  const e = run('happy', ['task', '--cwd', T], { input: 'p' })
  check(e.ok === true, 'run succeeds')
  check(!existsSync(stale), 'a 48h-old codex-exec- dir is collected, contents and all')
  check(existsSync(fresh), 'a fresh one - a concurrent run - is left alone')
  check(existsSync(e.eventsPath), 'this run keeps the journal its own envelope points at')
  rmSync(fresh, { recursive: true, force: true })
}

console.log('write mode + under-development noise filtered')
{
  const e = run('underdev_noise', ['task', '--cwd', T, '--write'], { input: 'p' })
  check(e.ok === true, 'under-development error items do not fail the run')
  check(has(argvSeen(), '-s', 'workspace-write'), 'argv: --write maps to workspace-write')
}

console.log('pre-spawn USAGE rejections (no spawn happens)')
{
  for (const [name, args, input] of [
    ['bad effort', ['task', '--cwd', T, '--effort', 'ultra'], 'p'],
    ['missing cwd', ['task'], 'p'],
    ['bad mode', ['banana', '--cwd', T], 'p'],
    ['empty prompt', ['task', '--cwd', T], ''],
    ['adversarial without --base', ['adversarial-review', '--cwd', T], ''],
    ['review with a prompt', ['review', '--cwd', T, '--uncommitted'], 'p'],
    ['write on review', ['review', '--cwd', T, '--uncommitted', '--write'], ''],
    ['unknown flag', ['task', '--cwd', T, '--frobnicate'], 'p'],
    ['bad model shape', ['task', '--cwd', T, '--model', 'GPT 5.6!'], 'p'],
  ]) {
    const e = run('happy', args, { input })
    check(e.ok === false && e.error.kind === 'USAGE' && argvSeen() === null, `${name} → USAGE, codex never spawned`)
  }
  const badSchema = join(T, 'bad.json')
  writeFileSync(badSchema, '{not json')
  const e = run('happy', ['task', '--cwd', T, '--schema', badSchema], { input: 'p' })
  check(e.ok === false && e.error.kind === 'USAGE', 'unparseable --schema → USAGE')
}

console.log('error classification')
{
  const e = run('bad_model', ['task', '--cwd', T, '--model', 'gpt-9'], { input: 'p' })
  check(e.ok === false && e.error.kind === 'BAD_MODEL', `400 model error → BAD_MODEL (got ${e.error && e.error.kind})`)
  check(e.error.retried === false, 'BAD_MODEL is not retried')
  const e2 = run('happy', ['task', '--cwd', T], { input: 'p', bin: '/nonexistent/codex-bin' })
  check(e2.ok === false && e2.error.kind === 'NOT_INSTALLED', `missing binary → NOT_INSTALLED (got ${e2.error && e2.error.kind})`)
}

console.log('rate limit → one retry → success')
{
  rmSync(STATE, { force: true })
  const e = run('rate_limit_once', ['task', '--cwd', T], { input: 'p' })
  check(e.ok === true && e.output === 'OK after retry', 'second attempt succeeds')
  check(e.error === null, 'error cleared after successful retry')
}

console.log('watchdogs (--timeout-secs is TOTAL across attempts)')
{
  const e = run('stall', ['task', '--cwd', T, '--stall-secs', '2', '--timeout-secs', '40'], { input: 'p' })
  check(e.ok === false && e.error.kind === 'STALL', `hung codex killed (got ${e.error && e.error.kind})`)
  check(e.error.retried === true, 'stall retried once while budget remained')
  const e2 = run('stall', ['task', '--cwd', T, '--stall-secs', '30', '--timeout-secs', '6'], { input: 'p' })
  check(e2.ok === false && e2.error.kind === 'TIMEOUT', `total budget enforced (got ${e2.error && e2.error.kind})`)
  check(e2.error.retried === false, 'no retry when the total budget cannot fit one')
}

console.log('wrapper termination reaps the detached child')
{
  rmSync(STATE + '.pid', { force: true })
  const { spawn } = await import('node:child_process')
  const wrapper = spawn('node', [WRAPPER, 'task', '--cwd', T, '--stall-secs', '60', '--timeout-secs', '120'], {
    env: { ...process.env, CODEX_BIN: FAKE, FAKE_MODE: 'stall', FAKE_ARGV_FILE: ARGV_FILE, FAKE_STATE: STATE },
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  wrapper.stdin.end('p')
  await new Promise((res) => setTimeout(res, 1500))
  const childPid = existsSync(STATE + '.pid') ? Number(readFileSync(STATE + '.pid', 'utf8')) : null
  check(childPid !== null, 'fake codex started and recorded its pid')
  wrapper.kill('SIGTERM')
  await new Promise((res) => setTimeout(res, 800))
  let alive = true
  try { process.kill(childPid, 0) } catch { alive = false }
  check(!alive, 'SIGTERM on the wrapper killed the detached codex process group')
  if (alive) { try { process.kill(-childPid, 'SIGKILL') } catch {} }
}

console.log('large envelope survives the stdout pipe')
{
  const e = run('big', ['task', '--cwd', T], { input: 'p' })
  check(e.ok === true && e.output.length === 200000, `200 KB output intact through a pipe (got ${e.output && e.output.length} bytes)`)
}

console.log('multi-byte prompt survives the 64 KiB stdin chunk boundary')
{
  const prompt = 'a'.repeat(65535) + '—em-dash straddles the chunk boundary—' + 'b'.repeat(100)
  const e = run('happy', ['task', '--cwd', T], { input: prompt })
  check(e.ok === true, 'run succeeds')
  check(readFileSync(ARGV_FILE + '.stdin', 'utf8') === prompt, 'prompt arrived byte-identical (no U+FFFD corruption)')
}

console.log('a killed attempt\'s -o file never launders into the retry')
{
  rmSync(STATE, { force: true })
  const e = run('stale_then_empty', ['task', '--cwd', T, '--stall-secs', '2', '--timeout-secs', '40'], { input: 'p' })
  check(e.ok === false && e.error.kind === 'EMPTY_OUTPUT', `stale attempt-1 answer rejected (got ${e.ok ? 'ok:true output=' + JSON.stringify(e.output) : e.error.kind})`)
}

console.log('empty output is UNKNOWN, never a pass')
{
  const e = run('empty', ['task', '--cwd', T], { input: 'p' })
  check(e.ok === false && e.error.kind === 'EMPTY_OUTPUT', `exit 0 with no message → EMPTY_OUTPUT (got ${e.error && e.error.kind})`)
}

console.log('schema mode')
{
  const schema = join(T, 'schema.json')
  writeFileSync(schema, JSON.stringify({ type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } }))
  const ok = run('schema_ok', ['task', '--cwd', T, '--schema', schema], { input: 'p' })
  check(ok.ok === true && ok.structured && ok.structured.a === 'x', 'valid structured output parsed into .structured')
  check(has(argvSeen(), '--output-schema', schema), 'argv: --output-schema passed through')
  const bad = run('schema_bad', ['task', '--cwd', T, '--schema', schema], { input: 'p' })
  check(bad.ok === false && bad.error.kind === 'SCHEMA_MISMATCH', `off-schema output → SCHEMA_MISMATCH (got ${bad.error && bad.error.kind})`)
}

console.log('adversarial-review')
{
  execFileSync('git', ['init', '-q', join(T, 'repo')])
  execFileSync('git', ['-C', join(T, 'repo'), 'commit', '-q', '--allow-empty', '-m', 'init'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 's@s' },
  })
  const e = run('adversarial', ['adversarial-review', '--cwd', join(T, 'repo'), '--base', 'HEAD'], { input: 'focus on races' })
  check(e.ok === true && Array.isArray(e.findings) && e.findings[0].title === 'race in init', 'findings surfaced from structured output')
  const av = argvSeen()
  check(av.includes('--output-schema'), 'argv: built-in findings schema attached')
  const prompt = readFileSync(ARGV_FILE + '.stdin', 'utf8')
  check(/git diff HEAD\.\.\.HEAD/.test(prompt), 'framing prompt names the base diff')
  check(/focus on races/.test(prompt), 'caller focus threaded into the framing')
  const e2 = run('adversarial', ['adversarial-review', '--cwd', join(T, 'repo'), '--base', 'no-such-ref'], { input: '' })
  check(e2.ok === false && e2.error.kind === 'USAGE', 'unresolvable --base → USAGE')
}

console.log('review parsing')
{
  const e = run('review_findings', ['review', '--cwd', join(T, 'repo'), '--uncommitted'])
  check(e.ok === true && e.findings.length === 2, `[P#] blocks parsed (got ${e.findings && e.findings.length})`)
  const f = e.findings[0]
  check(f.priority === 1 && f.file === 'math.js' && f.line === 2 && f.lineEnd === 4, 'priority/file/line-range extracted')
  check(/Returns Infinity/.test(f.detail) && /Callers break/.test(f.detail), 'multi-line detail captured')
  check(e.findings[1].priority === 2 && e.findings[1].file === 'README.md', 'second finding independent')
  const av = argvSeen()
  check(av[0] === 'exec' && av[1] === 'review' && av.includes('--uncommitted') && av.includes('--json'), 'argv: exec review --json --uncommitted')
  check(!av.includes('--output-schema') && !av.includes('-o'), 'argv: no exec-only flags leak into review')
}

console.log('fast-mode silent degrade detected')
{
  const e = run('fast_degrade', ['task', '--cwd', T, '--fast'], { input: 'p' })
  check(e.ok === true, 'degraded run still succeeds')
  check(e.fast.requested === true && e.fast.applied === false, 'fast.applied=false on the omitted-tier warning')
}

if (process.env.CODEX_LIVE === '1') {
  console.log('LIVE: real CLI, luna/low')
  const out = execFileSync('node', [WRAPPER, 'task', '--cwd', T, '--model', 'gpt-5.6-luna', '--effort', 'low', '--timeout-secs', '300'], {
    input: 'Reply with exactly: OK', env: { ...process.env, CODEX_BIN: 'codex' },
  }).toString()
  const e = JSON.parse(out)
  check(e.ok === true && /OK/.test(e.output), `live luna run (output: ${String(e.output).slice(0, 40)})`)
  check(e.tokens && e.tokens.input > 0, 'live token usage reported')
} else {
  console.log('LIVE case skipped (set CODEX_LIVE=1 to hit the real CLI)')
}

rmSync(T, { recursive: true, force: true })
console.log(failures === 0 ? '\nsmoke-codex-exec: ALL PASS' : `\nsmoke-codex-exec: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
