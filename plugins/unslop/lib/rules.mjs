// Harness-neutral unslop rule rendering. The skill stays vendored verbatim; only these
// plugin-local wrappers define how its body is scoped in a session or a subagent.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SESSION_PREAMBLE = `Anti-slop writing rules, injected every session:
- Written deliverables get the FULL ruleset: docs, commit messages, PR and issue prose, reports, journal comments, published artifacts -- anything that outlives the conversation.
- Technical explanations and architectural designs get the jargon and plain-speech rules (26-31) plus the content rules, IN CHAT TOO: explaining a bug, how something works, or a design trade-off means plain words, named mechanisms, and concrete examples -- not terms of art doing the work of an explanation.
- Conversational voice belongs to the active output style. Where a mechanical style rule (punctuation, casing, emphasis) fights that style in chat, the style wins; in deliverables, unslop wins.`

const SUBAGENT_PREAMBLE = `Anti-slop writing rules, injected at the start of every subagent:
- Nothing you emit is conversation. Code comments, commit messages, PR and issue prose, docs, journal entries, files you write, and the report you hand back to whoever spawned you are all written deliverables, and the FULL ruleset applies to every one of them.
- That includes the mechanical style rules -- no em dashes, sentence case headings, straight quotes, no decorative boldface. A main-thread session lets its output style win those conflicts in chat. You have no conversational turn, so nothing wins them here.
- Explaining a bug, a mechanism, or a trade-off means plain words, named mechanisms, and concrete examples. A term of art is not an explanation.
- These rules govern how you write, never what you do. They do not license editing text you were asked to reproduce verbatim: quoted source, captured output, a relayed answer.`

const SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'unslop', 'SKILL.md',
)

let body
function skillBody() {
  if (body === undefined) {
    body = readFileSync(SKILL_PATH, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  }
  return body
}

export function renderRules(scope) {
  const preamble = scope === 'session'
    ? SESSION_PREAMBLE
    : scope === 'subagent'
      ? SUBAGENT_PREAMBLE
      : null
  if (!preamble) throw new TypeError(`unknown unslop scope: ${scope}`)
  return `<unslop>\n${preamble}\n\n${skillBody()}\n</unslop>`
}
