#!/usr/bin/env node
// Deliver the charter, across Claude Code, Codex and Antigravity.
//
//   inject-charter.mjs session <claude|codex|antigravity>    SessionStart: whole charter/charter.md
//   inject-charter.mjs subagent <claude|codex|antigravity>   SubagentStart (or Antigravity seat SessionStart): seat half
//
// Claude Code caps one hook's output at 10,000 characters and swaps anything larger for a 2KB
// preview plus a file path. The session then runs on a fragment while the global CLAUDE.md's
// <flow-charter> presence check still passes. So an oversize charter is refused, never cut: the
// hook prints one HTML comment naming the size and no <flow-charter> tag, and the presence check
// fails where the human can see it. Codex and Antigravity read the same file, so they get the same
// refusal. Codex measures the additionalContextLimit in hooks/codex.json in tokens, at about four
// bytes each, so its 8000 for the session and 3000 for a seat hold the whole charter and the seat
// half with room. Antigravity's SessionStart expects a JSON `injectSteps` payload on stdout, and
// has no SubagentStart event, so a seat-only Antigravity setup registers `subagent antigravity`
// on SessionStart to deliver the seat half alone.
//
// On Claude, `Explore` and `fork` get no seat half: Explore only locates files, and fork already
// copies the session's context, charter included. Codex and Antigravity skip nothing.
//
// Always exits 0, with diagnostics on stderr: a failed hook costs the session or the seat its
// payload and fixes nothing. No process.exit(), which can cut stdout before the pipe drains.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seatPayload } from '../../lib/charter-payload.mjs'
import { readHookInput } from './wire.mjs'

// A margin under the host's 10,000. smoke-charter.mjs fails at 9,500, so an edit that grows the
// charter trips the smoke before any session is refused.
const SESSION_CAP = 9_800
const CLAUDE_SKIPPED = ['Explore', 'fork']

const [mode, host] = process.argv.slice(2)
const complain = (line) => process.stderr.write(`inject-charter: ${line}\n`)
const antigravityStep = (text) => JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] })

function readCharter() {
  // Each host exports its own root variable, and a process started from a Claude shell can inherit
  // a CLAUDE_PLUGIN_ROOT naming another install, so the declared host's variable wins (and
  // Antigravity never reads CLAUDE_PLUGIN_ROOT, falling back to this script's own checkout when
  // registered directly from ~/.gemini/config/hooks.json).
  const names = host === 'antigravity'
    ? ['PLUGIN_ROOT']
    : host === 'codex'
      ? ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']
      : ['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT']
  const root = names.map((name) => process.env[name]).find(Boolean) ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  try {
    return readFileSync(join(root, 'charter', 'charter.md'), 'utf8')
  } catch (error) {
    complain(`cannot read the charter under ${root}: ${error.message}`)
    return null
  }
}

async function main() {
  if (!['claude', 'codex', 'antigravity'].includes(host)) return complain(`expected host "claude", "codex" or "antigravity", got ${JSON.stringify(host)}`)
  if (mode === 'session') {
    const charter = readCharter()
    if (charter === null) return
    const text = charter.length <= SESSION_CAP
      ? charter
      : `<!-- flow charter refused: charter/charter.md is ${charter.length} characters, over the ${SESSION_CAP} one SessionStart hook carries whole. This session runs without the charter. Tell the human. -->\n`
    return process.stdout.write(host === 'antigravity' ? antigravityStep(text) : text)
  }
  if (mode === 'subagent') {
    // An unreadable body has no agent_type to skip, and a seat with no rules is worse than one
    // with the rules twice, so a broken read delivers.
    const event = await readHookInput()
    if (host === 'claude' && CLAUDE_SKIPPED.includes(event?.agent_type)) return
    const charter = readCharter()
    if (charter === null) return
    let additionalContext
    try {
      additionalContext = seatPayload(charter)
    } catch (error) {
      return complain(error.message)
    }
    if (host === 'antigravity') return process.stdout.write(antigravityStep(additionalContext))
    return process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext } }))
  }
  complain(`expected mode "session" or "subagent", got ${JSON.stringify(mode)}`)
}

await main()
