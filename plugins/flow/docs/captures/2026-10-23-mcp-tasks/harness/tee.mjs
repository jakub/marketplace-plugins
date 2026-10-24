// Disposable stdio tee for the #34 live capture. Spawns the flow delegate server from the worktree
// and logs every frame in both directions, with wall-clock and monotonic time, to FLOW_CAPTURE_LOG.
// Prompt-bearing fields are redacted in both directions; structure, ids and timing are kept.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const log = process.env.FLOW_CAPTURE_LOG
const arm = process.env.FLOW_CAPTURE_ARM ?? 'unnamed'
const main = process.env.FLOW_CAPTURE_MAIN
const host = process.env.FLOW_CAPTURE_HOST ?? 'claude'
const t0 = performance.now()
const REDACT = new Set(['prompt', 'requestPreview', 'output', 'text', 'message'])
function redact(value, key) {
  if (Array.isArray(value)) return value.map((v) => redact(v))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k)
    return out
  }
  if (typeof value === 'string' && REDACT.has(key)) return `<redacted ${value.length} chars>`
  return value
}
function record(dir, line) {
  let frame
  try { frame = redact(JSON.parse(line)) } catch { frame = { unparsed: line.length } }
  appendFileSync(log, JSON.stringify({ arm, dir, t: new Date().toISOString(), ms: Math.round((performance.now() - t0) * 10) / 10, frame }) + '\n')
}
const child = spawn(process.execPath, [main, 'mcp', '--host', host], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
appendFileSync(log, JSON.stringify({ arm, dir: 'meta', t: new Date().toISOString(), node: process.version, pid: process.pid, serverPid: child.pid, env: { CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null, CLAUDE_AUTO_BACKGROUND_TASKS: process.env.CLAUDE_AUTO_BACKGROUND_TASKS ?? null, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null, cwd: process.cwd() } }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => { record('client->server', line); child.stdin.write(line + '\n') })
createInterface({ input: child.stdout }).on('line', (line) => { record('server->client', line); process.stdout.write(line + '\n') })
process.stdin.on('end', () => child.stdin.end())
child.on('exit', (code) => { appendFileSync(log, JSON.stringify({ arm, dir: 'meta', t: new Date().toISOString(), serverExit: code }) + '\n'); process.exit(code ?? 0) })
