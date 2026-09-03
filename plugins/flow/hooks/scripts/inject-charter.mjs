#!/usr/bin/env node
// Deliver the charter, in two modes, on both hosts.
//
// `session` prints the charter at SessionStart. Claude Code caps a single hook's stdout at
// 10,000 characters and replaces anything larger with a 2KB preview plus a file path, so there
// it ships as two hooks, each printing one half; the cut lands on the `## ` heading nearest the
// middle so the hand-authored charter stays one file. Codex measures the payload in tokens and
// spills what does not fit, so it takes the whole charter in one write.
//
// `subagent` reads hook JSON on stdin and answers with hookSpecificOutput.additionalContext
// holding the seat half alone: the rules every seat follows, without the orchestrator doctrine
// a leaf seat cannot act on. A spawn prompt therefore carries the worktree and the milestones
// and no contract text. On Claude, `Explore` and `fork` are skipped: Explore returns file paths
// and never writes, and fork already carries the whole session context, charter included. Codex
// has neither mechanism, so it skips nothing.
//
// Usage: inject-charter.mjs <session|subagent> <claude|codex> [1|2]. Always exits 0. A non-zero
// SessionStart hook costs the session its payload, and there is nothing a seat can do about a
// hook that failed, so a disagreement between this script and the hook config is reported on
// stderr and delivers what it can.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAUDE_HOOK_CAP, CLAUDE_PART_BUDGET, seatPayload, sessionHalves } from '../../lib/charter-payload.mjs'

const CLAUDE_SKIPPED = ['Explore', 'fork']

async function readStdin() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  // An unparseable body has no agent_type to match against the skip list, and a seat that gets
  // no rules is worse than a seat that gets them twice, so a broken read delivers.
  try { return JSON.parse(raw) } catch { return {} }
}

async function main() {
  const mode = process.argv[2]
  const host = process.argv[3] || 'claude'
  const fallback = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  if (!['claude', 'codex'].includes(host)) {
    process.stderr.write(`inject-charter: expected host "claude" or "codex", got ${JSON.stringify(host)}\n`)
    return
  }
  // Each host exports its own root variable, and a Codex process launched from a Claude shell can
  // inherit CLAUDE_PLUGIN_ROOT pointing at another install, so the declared host decides which
  // variable is read first.
  const preferred = host === 'codex'
    ? [process.env.PLUGIN_ROOT, process.env.CLAUDE_PLUGIN_ROOT]
    : [process.env.CLAUDE_PLUGIN_ROOT, process.env.PLUGIN_ROOT]
  const root = preferred.find(Boolean) || fallback
  let charter
  try {
    charter = readFileSync(join(root, 'charter', 'charter.md'), 'utf8')
  } catch (error) {
    process.stderr.write(`inject-charter: cannot read the charter under ${root}: ${error.message}\n`)
    return
  }

  if (mode === 'session') {
    if (host === 'codex') {
      process.stdout.write(charter)
      return
    }
    const halves = sessionHalves(charter)
    const part = process.argv[4] === '2' ? 1 : 0
    const over = halves
      .map((half, at) => (half.length >= CLAUDE_PART_BUDGET ? `part ${at + 1} is ${half.length} chars` : null))
      .filter(Boolean)
    if (over.length && part === 0) {
      process.stdout.write(`<!-- flow-charter WARNING: ${over.join('; ')}; the per-hook cap is ${CLAUDE_HOOK_CAP}. Trim the charter or move text out of it. -->\n\n`)
    }
    process.stdout.write(halves[part])
    return
  }

  if (mode === 'subagent') {
    const { agent_type: agentType } = await readStdin()
    if (host === 'claude' && CLAUDE_SKIPPED.includes(agentType)) return
    // seatPayload throws on a charter with zero or two marker lines. A hook that dies non-zero
    // is a harness error in the seat's face and still delivers nothing, so the defect goes to
    // stderr and the hook exits 0 with empty stdout: the seat runs on the guards alone, and the
    // conformance smoke is what catches the broken charter before it ships.
    let payload
    try {
      payload = seatPayload(charter)
    } catch (error) {
      process.stderr.write(`inject-charter: ${error.message}\n`)
      return
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: payload,
      },
    }))
    return
  }

  process.stderr.write(`inject-charter: expected mode "session" or "subagent", got ${JSON.stringify(mode)}\n`)
}

// No process.exit(): an explicit exit can truncate stdout before the pipe drains.
main()
