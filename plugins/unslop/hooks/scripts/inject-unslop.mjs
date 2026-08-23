#!/usr/bin/env node
// SessionStart injection for the vendored unslop skill.
//
// The upstream frontmatter says "Must always apply", but a skill description is an
// advertisement the model must still act on each turn -- unreliable exactly where
// unslop matters (prose turns that don't look tool-shaped). This hook makes it
// deterministic: the vendored body lands in context at session start.
//
// The scoping preamble below is PLUGIN-LOCAL wrapper text, not part of the vendored
// file. Scoping changes belong here; changes to the rules themselves go through
// patches/ per the NOTICE. The body is read at runtime so there is no second copy
// to drift.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const skill = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'unslop', 'SKILL.md')
const body = readFileSync(skill, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim()

console.log(`<unslop>
Anti-slop writing rules, injected every session:
- Written deliverables get the FULL ruleset: docs, commit messages, PR and issue prose, reports, journal comments, published artifacts -- anything that outlives the conversation.
- Technical explanations and architectural designs get the jargon and plain-speech rules (26-31) plus the content rules, IN CHAT TOO: explaining a bug, how something works, or a design trade-off means plain words, named mechanisms, and concrete examples -- not terms of art doing the work of an explanation.
- Conversational voice belongs to the active output style. Where a mechanical style rule (punctuation, casing, emphasis) fights that style in chat, the style wins; in deliverables, unslop wins.

${body}
</unslop>`)
