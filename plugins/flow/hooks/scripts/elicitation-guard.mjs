#!/usr/bin/env node
// The elicitation guard: a Claude-only Elicitation hook that declines every MCP elicitation in a
// T3 seat, so an MCP server the seat calls can never put a form or a URL dialog in front of the
// human. A seat is unattended by design: the orchestrator answers for it, and input the seat is
// missing belongs in its result envelope.
//
// Membership is seat-guard.mjs's predicate: the Claude session index for the call's session_id
// validates and exists. The entry is never read, and neither is a record or a stamp, so a bound,
// void, closed or missing-record seat declines alike. A broken seat is still not the human's
// problem. A call whose identity is unknown, an unreadable body or an invalid session_id, exits 0
// with no output, so the human's own dialog appears, in parity with seat-guard's fast path. That
// path costs one string test and one existsSync, and imports nothing seat-guard does not.
//
// A decline does not close or void the seat, and this hook never writes to the seat store: the
// seat keeps working and reports the missing input in its envelope. The decline goes to stdout
// first. The member path sets exit code 2 before the write and 0 only after the write returns,
// and any throw or stdout error sets it back to 2. Claude Code reads exit 2 as a decline too, so
// a fault after membership cannot leak a dialog. Only then is node:child_process loaded, to file
// a gripe through PATH: detached, stdio ignored, never waited on, so a missing or hung gripe
// never touches the decline. The gripe body names the MCP server alone, restricted to
// [A-Za-z0-9._-] and cut to 64 characters; nothing from the message, URL, schema, elicitation id
// or seat id reaches its argv.
//
// Measured on Claude Code 2.1.309 (2026-10-23) and 2.1.310 (2026-10-24): a plugin hooks.json
// Elicitation hook fires in every mode flow runs a seat, for an elicitation nested in a tool call
// and for an unsolicited server request alike. Exit 0 with the decline shape declines, and so
// does exit 2; reason and stderr are discarded. The input carries no agent_id. A T3 claudeAgent
// child with no such hook already auto-declined elicitations on 2026-10-24, so this hook is the
// guarantee that does not depend on T3's current behavior.
//
// Gaps, named plainly:
// - There is deliberately no Codex counterpart. Codex 0.164.0 has no Elicitation hook event, and
//   it auto-rejects MCP elicitations unless `approval_policy.granular.mcp_elicitations = true`.
//   A Codex seat on a machine with that set surfaces them, and flow reads no Codex config.
// - A native Agent-tool subagent of a non-seat orchestrator keeps the dialog. The input has no
//   agent_id to tell it from the main thread, and a marker written at PreToolUse would put state
//   on every tool call's fast path and race parallel calls.
// - An elicitation before the seat's first prompt binds the session index (UserPromptSubmit) is
//   not a member yet.

import { existsSync } from 'node:fs'
import * as store from '../../lib/seat-store.mjs'
import { elicitationDecline, readHookInput } from './wire.mjs'

const serverName = (name) =>
  typeof name === 'string' && name !== '' ? name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) : '(unnamed)'

async function decline(input) {
  process.exitCode = 2
  try {
    process.stdout.on('error', () => { process.exitCode = 2 })
    process.stdout.write(JSON.stringify(elicitationDecline()))
    process.exitCode = 0
    const { spawn } = await import('node:child_process')
    const body = `flow seat declined an MCP elicitation from server ${serverName(input.mcp_server_name)}`
    const child = spawn('gripe', ['add', '--trigger', 'flow-seat-elicitation', body], {
      detached: true,
      stdio: 'ignore',
      shell: false,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: input.session_id },
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    process.exitCode = 2
  }
}

async function main() {
  const input = await readHookInput()
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return
  const index = store.indexPath('claude', input.session_id)
  if (index === null || !existsSync(index)) return
  return decline(input)
}

await main()
