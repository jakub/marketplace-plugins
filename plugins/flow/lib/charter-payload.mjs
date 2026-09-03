// Sizes and rendering for the charter payload.
//
// charter/charter.md is one file in two halves, separated by exactly one SEAT_MARKER line.
// Above the marker is doctrine for the orchestrator, delivered at SessionStart alone. Below it
// are the rules every seat follows, delivered at SessionStart and again to every seat that is
// spawned, so no prompt has to carry contract text. Adapters own their wire format: this file
// owns the budgets, the split, and the one block shape a seat reads.

// Claude Code truncates a single hook's stdout past 10,000 characters, swapping the
// payload for a 2KB preview plus a file path. WARN at 9,000 leaves room to notice first.
export const CLAUDE_HOOK_CAP = 10_000
export const CLAUDE_PART_BUDGET = 9_000

// Codex takes the whole charter as one SessionStart payload and measures it in tokens, so these
// are maintenance budgets rather than hard limits: spilling is the runtime fallback, not the
// target. The hook in hooks/codex.json declares additionalContextLimit 8000, which Codex 0.152.0
// honors for SessionStart and counts at about four bytes per token before it spills to a file
// (codex-rs/hooks/src/output_spill.rs, read 2026-09-01), so 22,000 bytes stays inline. Nothing is
// appended to the charter any more, so both budgets bound the same bytes: the charter used to
// share the payload with a 5,000-byte binding profile, and it now gets the whole allowance. The
// charter ceiling sits 2,000 bytes under the wire limit, so a growing charter trips the lint
// before a session ever reads its payload out of a spill file.
export const CODEX_CHARTER_BYTE_BUDGET = 20_000
export const CODEX_INLINE_BYTE_BUDGET = 22_000

// The one line that separates the halves. It is an HTML comment, so a reader handed either half
// sees ordinary prose and the marker itself never reaches a model as an instruction.
export const SEAT_MARKER =
  '<!-- flow-charter: seat rules. Everything below this line is also delivered to every seat. -->'

const SEAT_PREFACE =
  'You are a seat spawned inside a flow session; these are the rules every seat follows, and ' +
  'the orchestrator that spawned you holds the rest of the charter.'

/**
 * The charter's two halves: `orchestrator` is everything above the marker line, `seat` is
 * everything below it.
 *
 * Throws unless the marker appears exactly once. Zero markers means the seat half cannot be
 * found and every seat would run on nothing; two means the split is ambiguous and one of them
 * silently decides what a seat reads. Both are install-time defects, so they fail loudly here
 * rather than shipping a truncated payload.
 */
export function splitCharter(text) {
  const lines = text.split('\n')
  const found = lines.reduce((at, line, index) => (line.trimEnd() === SEAT_MARKER ? [...at, index] : at), [])
  if (found.length !== 1) {
    throw new Error(
      `the charter must carry exactly one seat-rules marker line, "${SEAT_MARKER}", and carries ${found.length}`,
    )
  }
  const cut = found[0]
  return {
    orchestrator: lines.slice(0, cut).join('\n'),
    seat: lines.slice(cut + 1).join('\n'),
  }
}

/**
 * The seat half as the tagged block a spawned seat reads: a subagent through a SubagentStart
 * hook on either host, a delegated job through its preamble.
 *
 * The source's closing `</flow-charter>` tag belongs to the whole-file block a session gets, so
 * it comes off here and the wrapper adds its own. The body is otherwise verbatim: a seat and the
 * session that spawned it read the same bytes, and there is nothing to reword between them.
 */
export function seatPayload(text) {
  const lines = splitCharter(text).seat.split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines[lines.length - 1]?.trim() === '</flow-charter>') lines.pop()
  return `<flow-charter scope="seat">\n${SEAT_PREFACE}\n\n${lines.join('\n').trim()}\n</flow-charter>\n`
}

/**
 * The two blocks Claude Code's SessionStart hooks print, in order.
 *
 * One hook's stdout is capped, so the whole charter ships as two, cut at the `## ` heading
 * nearest the middle of the file. The cut is by size and not by the seat marker: a seat gets the
 * seat half from its own hook, and a session reads both blocks whatever the cut lands on.
 */
export function sessionHalves(text) {
  const headings = [...text.matchAll(/^## .*$/gm)].map((match) => match.index)
  const mid = text.length / 2
  const cut = headings.reduce((best, at) => (Math.abs(at - mid) < Math.abs(best - mid) ? at : best), headings[0] ?? 0)
  return [
    `${text.slice(0, cut).trimEnd()}\n\n<!-- flow-charter continues in the next SessionStart block -->\n`,
    `<!-- flow-charter, part 2 of 2 -->\n\n${text.slice(cut)}`,
  ]
}
