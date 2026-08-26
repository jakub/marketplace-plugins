#!/usr/bin/env node
// Injection for the vendored unslop skill, in two modes.
//
// The upstream frontmatter says "Must always apply", but a skill description is an
// advertisement the model must still act on each turn -- unreliable exactly where
// unslop matters (prose turns that don't look tool-shaped). This hook makes it
// deterministic: the vendored body lands in context at session start, and again at
// the start of every subagent that writes something durable.
//
// Both preambles in lib/rules.mjs are PLUGIN-LOCAL wrapper text, not part of the vendored file.
// Scoping changes belong here; changes to the rules themselves go through patches/
// per the NOTICE. The body is read at runtime so there is no second copy to drift.
//
// Contract: `session` prints the block on stdout for SessionStart. `subagent` reads
// hook JSON on stdin and answers with hookSpecificOutput.additionalContext, or with
// nothing for a skipped agent type. An unknown mode exits 2, which Claude Code 2.1.241
// and later shows in the transcript; both hooks.json entries pass one explicitly, so
// that path only fires if the config and the script disagree.

import { shouldInjectSubagent } from '../../lib/agent-selection.mjs'
import { renderRules } from '../../lib/rules.mjs'

async function readStdin() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try { return JSON.parse(raw) } catch { return {} }
}

async function main() {
  const mode = process.argv[2]
  const source = process.argv[3] || 'claude'

  if (!['claude', 'codex'].includes(source)) {
    process.stderr.write(`inject-unslop: expected source "claude" or "codex", got ${JSON.stringify(source)}\n`)
    process.exitCode = 2
    return
  }

  if (mode === 'session') {
    console.log(renderRules('session'))
    return
  }

  if (mode === 'subagent') {
    const { agent_type: agentType } = await readStdin()
    if (!shouldInjectSubagent({ source, agentType })) return
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          additionalContext: renderRules('subagent'),
        },
      }),
    )
    return
  }

  process.stderr.write(`inject-unslop: expected mode "session" or "subagent", got ${JSON.stringify(mode)}\n`)
  process.exitCode = 2
}

// No process.exit(): an explicit exit can truncate stdout before the pipe drains.
main()
