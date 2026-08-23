#!/usr/bin/env node
// gripe: SubagentStart. The same advertisement subagents would otherwise never hear,
// with attribution baked into the recipe as literals: a subagent lives inside one
// prompt, so `--agent` and `--prompt` stay valid for its whole life, and the agent
// copies a literal rather than deciding anything.
//
// Contract: read hook JSON on stdin, emit hookSpecificOutput JSON, always exit 0.

import { safeId } from '../../lib/context.mjs'
import { heredocDelim } from '../../lib/gate.mjs'

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input = {}
  try { input = JSON.parse(raw) } catch {}

  // Ids land inside an advertised shell command; anything outside the safe alphabet is
  // dropped rather than quoted, because attribution is not worth an injection risk. No
  // --via here: an unprompted filing is spontaneous whoever writes it.
  const flags = []
  const agent = safeId(input.agent_id)
  const prompt = safeId(input.prompt_id)
  if (agent) flags.push(`--agent ${agent}`)
  if (prompt) flags.push(`--prompt ${prompt}`)

  const d = heredocDelim() // random per advertisement; a fixed delimiter is an injection path
  const note = [
    `gripe: a local friction log. When tooling or workflow friction costs you real time, file it in one command (always exits 0, no reply expected, never required):`,
    `gripe add${flags.length ? ' ' + flags.join(' ') : ''} <<'${d}'`,
    `<what you expected, what happened instead, what it cost>`,
    d,
  ].join('\n')

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: note },
    }),
  )
}

// No process.exit(): an explicit exit can truncate stdout before the pipe drains.
main().catch(() => {})
