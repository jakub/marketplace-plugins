// The charter's split and the block a seat reads.
//
// charter/charter.md is one file in two halves, separated by exactly one SEAT_MARKER line. Above
// it is doctrine for the orchestrator; below it are the rules every seat follows. A session gets
// the whole file. A spawned seat (hooks/scripts/inject-charter.mjs at SubagentStart) and a
// delegated job (delegate/runner.mjs) both get seatPayload(), so every seat reads the same bytes
// and no prompt carries contract text.

// An HTML comment, so a reader handed either half sees ordinary prose and the marker never reaches
// a model as an instruction.
export const SEAT_MARKER =
  '<!-- flow-charter: seat rules. Everything below this line is also delivered to every seat. -->'

const SEAT_PREFACE =
  'You are a seat spawned inside a flow session; these are the rules every seat follows, and ' +
  'the orchestrator that spawned you holds the rest of the charter.'

/**
 * The charter's two halves: `orchestrator` above the marker line, `seat` below it.
 *
 * Throws unless the marker appears exactly once. With none, every seat would run on nothing; with
 * two, one of them would silently decide what a seat reads.
 */
export function splitCharter(text) {
  const lines = text.split('\n')
  const found = lines.flatMap((line, index) => (line.trimEnd() === SEAT_MARKER ? [index] : []))
  if (found.length !== 1) {
    throw new Error(`the charter must carry exactly one seat-rules marker line, "${SEAT_MARKER}", and carries ${found.length}`)
  }
  return { orchestrator: lines.slice(0, found[0]).join('\n'), seat: lines.slice(found[0] + 1).join('\n') }
}

/**
 * The seat half as the tagged block a seat reads. The source's closing `</flow-charter>` belongs
 * to the whole-file block a session gets, so it comes off here and the wrapper adds its own; the
 * body is otherwise verbatim.
 */
export function seatPayload(text) {
  const lines = splitCharter(text).seat.split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines[lines.length - 1]?.trim() === '</flow-charter>') lines.pop()
  return `<flow-charter scope="seat">\n${SEAT_PREFACE}\n\n${lines.join('\n').trim()}\n</flow-charter>\n`
}
