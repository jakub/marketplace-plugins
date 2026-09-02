// Sizes and rendering for the charter payload both hosts inject at SessionStart.
// The charter says what a role is for; a host profile binds each role to the mechanism
// that plays it here. Adapters own their wire format: this file owns the budgets, the
// read, and the one block shape a session sees.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Claude Code truncates a single hook's stdout past 10,000 characters, swapping the
// payload for a 2KB preview plus a file path. WARN at 9,000 leaves room to notice first.
export const CLAUDE_HOOK_CAP = 10_000
export const CLAUDE_PART_BUDGET = 9_000

// Codex takes one payload and measures it in tokens, so these are maintenance budgets
// rather than hard limits: spilling is the runtime fallback, not the target. The hook in
// hooks/codex.json declares additionalContextLimit 8000, which Codex 0.152.0 honors for
// SessionStart and counts at about four bytes per token before it spills to a file
// (codex-rs/hooks/src/output_spill.rs, read 2026-09-01), so 22,000 bytes stays inline.
export const CODEX_CHARTER_BYTE_BUDGET = 15_000
export const CODEX_PROFILE_BYTE_BUDGET = 5_000
export const CODEX_INLINE_BYTE_BUDGET = 22_000

export const NO_BINDINGS_NOTE =
  "This host's binding profile did not load, so you are running on the charter alone. " +
  'Say so once, at the top of your first reply, and then keep every charter rule that is ' +
  'still true without it. Do not guess at a mechanism this host might have, and do not ' +
  'start a flow pipeline stage, until the human repairs the install.'

/**
 * The profile text for one host, or `{ text: null }` when it is missing or unreadable.
 *
 * A SessionStart hook that throws costs the session its whole payload, and an error
 * string would put an install path in front of the model, so every failure is the same
 * silent null and the renderer turns it into the no-bindings note.
 */
export function readProfile(root, host) {
  try {
    return { host, text: readFileSync(join(root, 'charter', 'profiles', `${host}.md`), 'utf8') }
  } catch {
    return { host, text: null }
  }
}

/**
 * Render one profile as the tagged block a session reads.
 *
 * Source profiles carry no outer tags. This renderer owns exactly one opening line, the
 * body verbatim, one closing line and one trailing newline, so the block's shape is the
 * same on both hosts and `bindings` alone says whether the bindings are real.
 */
export function profileBlock({ host, text }) {
  const bindings = text === null ? 'none' : 'bound'
  const body = text === null ? NO_BINDINGS_NOTE : text
  const separator = body.endsWith('\n') ? '' : '\n'
  return `<flow-profile host="${host}" bindings="${bindings}">\n${body}${separator}</flow-profile>\n`
}
