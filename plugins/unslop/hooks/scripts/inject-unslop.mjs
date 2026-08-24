#!/usr/bin/env node
// Injection for the vendored unslop skill, in two modes.
//
// The upstream frontmatter says "Must always apply", but a skill description is an
// advertisement the model must still act on each turn -- unreliable exactly where
// unslop matters (prose turns that don't look tool-shaped). This hook makes it
// deterministic: the vendored body lands in context at session start, and again at
// the start of every subagent that writes something durable.
//
// Both preambles below are PLUGIN-LOCAL wrapper text, not part of the vendored file.
// Scoping changes belong here; changes to the rules themselves go through patches/
// per the NOTICE. The body is read at runtime so there is no second copy to drift.
//
// Contract: `session` prints the block on stdout for SessionStart. `subagent` reads
// hook JSON on stdin and answers with hookSpecificOutput.additionalContext, or with
// nothing for a skipped agent type. An unknown mode exits 2, which Claude Code 2.1.241
// and later shows in the transcript; both hooks.json entries pass one explicitly, so
// that path only fires if the config and the script disagree.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Seats that get nothing. Explore and the other search fan-outs return file paths, and
// a twenty-agent sweep would buy the ruleset twenty times to punctuate a list of hits.
// fork copies the parent's context, so it already carries the SessionStart block.
// codex-delegate is a transport whose job is relaying Codex output faithfully, and
// editing rules aimed at a relay corrupt exactly that. Everything else is on, which is
// the point: the ad-hoc general-purpose and claude seats have no agent definition to
// carry the rules for them.
const SKIP = new Set(['Explore', 'fork', 'codex-delegate', 'flow:codex-delegate'])

const SESSION_PREAMBLE = `Anti-slop writing rules, injected every session:
- Written deliverables get the FULL ruleset: docs, commit messages, PR and issue prose, reports, journal comments, published artifacts -- anything that outlives the conversation.
- Technical explanations and architectural designs get the jargon and plain-speech rules (26-31) plus the content rules, IN CHAT TOO: explaining a bug, how something works, or a design trade-off means plain words, named mechanisms, and concrete examples -- not terms of art doing the work of an explanation.
- Conversational voice belongs to the active output style. Where a mechanical style rule (punctuation, casing, emphasis) fights that style in chat, the style wins; in deliverables, unslop wins.`

const SUBAGENT_PREAMBLE = `Anti-slop writing rules, injected at the start of every subagent:
- Nothing you emit is conversation. Code comments, commit messages, PR and issue prose, docs, journal entries, files you write, and the report you hand back to whoever spawned you are all written deliverables, and the FULL ruleset applies to every one of them.
- That includes the mechanical style rules -- no em dashes, sentence case headings, straight quotes, no decorative boldface. A main-thread session lets its output style win those conflicts in chat. You have no conversational turn, so nothing wins them here.
- Explaining a bug, a mechanism, or a trade-off means plain words, named mechanisms, and concrete examples. A term of art is not an explanation.
- These rules govern how you write, never what you do. They do not license editing text you were asked to reproduce verbatim: quoted source, captured output, a relayed answer.`

const skillPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'unslop', 'SKILL.md')

function block(preamble) {
  const body = readFileSync(skillPath, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  return `<unslop>\n${preamble}\n\n${body}\n</unslop>`
}

async function readStdin() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try { return JSON.parse(raw) } catch { return {} }
}

async function main() {
  const mode = process.argv[2]

  if (mode === 'session') {
    console.log(block(SESSION_PREAMBLE))
    return
  }

  if (mode === 'subagent') {
    const { agent_type: agentType } = await readStdin()
    if (SKIP.has(agentType)) return
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          additionalContext: block(SUBAGENT_PREAMBLE),
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
