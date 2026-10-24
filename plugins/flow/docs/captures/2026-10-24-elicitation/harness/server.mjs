#!/usr/bin/env node
// A stdio MCP server that asks the client for input nobody requested. It exists to give the
// Elicitation hook of issue #33 something to decline: after the handshake it sends one form
// `elicitation/create` and, 1.5 s later, one url `elicitation/create`, and it logs what the client
// answers. It offers no tool and reads nothing from the elicitation responses beyond `result.action`
// or the error code, so the log holds no message text.
//
// Why it elicits unprompted. A flow seat cannot call this server's tool: seat-guard denies every
// `mcp__` tool outside the Context7 allowlist. A tool that elicits mid-call would never run, so the
// server sends the request on its own.
//
// The era trick. Claude Code 2.1.310 speaks two MCP eras. It first sends `server/discover`, the
// modern handshake. This server answers it with -32601, and Claude falls back to `initialize`,
// where the server claims protocolVersion 2025-11-25. In that era the client services a
// server-initiated `elicitation/create` after `notifications/initialized`, which is what the hook
// needs. A modern-era server would have to elicit inside a tool call instead.
//
// Environment:
//   ELICIT_LOG        JSONL log path. Required. One line per message in or out, plus `meta` lines.
//   ELICIT_GATE       Optional path. The server waits up to 180 s for it to exist before it elicits and
//                     logs whether it appeared. If it never does, the server elicits nothing. Point it at
//                     a seat's receipt.json so the requests arrive after the seat is a member.
//   ELICIT_DELAY_MS   Pause between the gate (or `notifications/initialized`) and the form request.
//                     Default 2000.
//
// Log line: {t, pid, projectDir, dir: in|out|meta, kind, method?, id?, mode?, action?, error?}.
// projectDir is CLAUDE_PROJECT_DIR as the server saw it. `summary` is the last line:
// {form, url} holding each answer's action, `error:<code>`, `no-response` or `not-sent`.
import { appendFileSync, existsSync } from 'node:fs'

const LOG = process.env.ELICIT_LOG
if (!LOG) {
  process.stderr.write('server.mjs: ELICIT_LOG is required\n')
  process.exit(2)
}
const GATE = process.env.ELICIT_GATE || ''
const DELAY_MS = Number(process.env.ELICIT_DELAY_MS || 2000)
const PROTOCOL = '2025-11-25'
const SUMMARY_TIMEOUT_MS = 30_000

const log = (o) => appendFileSync(LOG, JSON.stringify({
  t: new Date().toISOString(), pid: process.pid, projectDir: process.env.CLAUDE_PROJECT_DIR ?? null, ...o,
}) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const pending = new Map() // request id -> mode
const results = { form: 'not-sent', url: 'not-sent' }
let summarized = false
let summaryTimer = null
let nextId = 1000

function summarize() {
  if (summarized) return
  summarized = true
  clearTimeout(summaryTimer)
  log({ dir: 'meta', kind: 'summary', summary: { ...results } })
}

function send(m, extra) {
  log({
    dir: 'out', kind: m.method ? 'request' : 'response', method: m.method, id: m.id,
    ...(m.error ? { error: m.error.code } : {}), ...extra,
  })
  process.stdout.write(JSON.stringify(m) + '\n')
}

function elicit(mode) {
  const id = nextId++
  pending.set(id, mode)
  results[mode] = 'no-response'
  const params = mode === 'url'
    ? { mode, message: 'elicitation probe (url)', url: 'https://example.invalid/probe', elicitationId: 'probe-url-1' }
    : { mode, message: 'elicitation probe (form)', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }
  send({ jsonrpc: '2.0', id, method: 'elicitation/create', params }, { mode })
}

async function fire() {
  if (GATE) {
    const until = Date.now() + 180_000
    while (!existsSync(GATE) && Date.now() < until) await sleep(250)
    const appeared = existsSync(GATE)
    log({ dir: 'meta', kind: 'gate', gate: GATE, appeared })
    if (!appeared) return summarize()
  }
  await sleep(DELAY_MS)
  elicit('form')
  await sleep(1500)
  elicit('url')
  summaryTimer = setTimeout(summarize, SUMMARY_TIMEOUT_MS)
}

function onMessage(m) {
  const isResponse = m.method === undefined && m.id !== undefined
  if (isResponse && pending.has(m.id)) {
    const mode = pending.get(m.id)
    pending.delete(m.id)
    const action = m.error ? `error:${m.error.code}` : (m.result?.action ?? 'no-action')
    results[mode] = action
    log({ dir: 'in', kind: 'response', id: m.id, mode, ...(m.error ? { error: m.error.code } : { action }) })
    if (pending.size === 0 && results.form !== 'not-sent' && results.url !== 'not-sent') summarize()
    return
  }
  const extra = m.method === 'initialize'
    ? { protocolVersion: m.params?.protocolVersion, clientElicitation: m.params?.capabilities?.elicitation !== undefined }
    : {}
  log({ dir: 'in', kind: isResponse ? 'response' : (m.id === undefined ? 'notification' : 'request'), method: m.method, id: m.id, ...extra })
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'elicit-probe', version: '0' } } })
  } else if (m.method === 'notifications/initialized') {
    fire()
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [] } })
  } else if (m.id !== undefined && m.method) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } })
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m
    try { m = JSON.parse(line) } catch { log({ dir: 'in', kind: 'unparseable' }); continue }
    onMessage(m)
  }
})
process.stdin.on('end', () => {
  log({ dir: 'meta', kind: 'stdin-closed' })
  summarize()
  process.exit(0)
})
