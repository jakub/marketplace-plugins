// Seat policy: what the T3 seat hooks decide, with no hook event names and no wire shapes. The
// adapter in hooks/scripts/seat-guard.mjs reads the call, asks here, and prints the answer through
// wire.mjs. Reads and writes of seat records go through lib/seat-store.mjs, which the adapter
// hands in, so this module never names a path.
//
// Three decisions live here:
//
//   gateDelegateTask   the parent's PreToolUse on T3's delegate_task, in every session. A call
//                      without an explicit runtimeMode is denied, tagged or not, because a child
//                      copies its parent's mode at spawn and a parent switched to full access would
//                      silently widen every later child. A tagged call is admitted once, and only
//                      when it asks for exactly what the seat record names.
//   bindProblem        the child's UserPromptSubmit: whether this session may bind the record. A
//                      failed bind makes a void seat, which the adapter records and announces.
//   seatCallProblem    the child's PreToolUse before containment: a void seat, a record that is
//                      missing or corrupt, or a call that cannot be read is denied outright.
//
// Every field a decision reads is checked for shape first, and a field that is missing or of the
// wrong type denies: a seat call is never admitted on a value this module had to guess at.

/** The permission_mode each host reports for T3's `auto` runtime mode, measured on 2026-10-03. */
export const PERMISSION_MODES = Object.freeze({
  claude: Object.freeze(['auto']),
  codex: Object.freeze(['default']),
})

// T3 names its providers by instance id; the record names the host family.
const PROVIDERS = new Map([['claudeAgent', 'claude'], ['codex', 'codex']])
const ACCESS = new Set(['read-only', 'workspace-write', 'review'])

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const deny = (why) => ({ deny: `flow seat: ${why}` })

/**
 * The parent's gate on one delegate_task call. Returns null when the call is not a seat call and
 * names its runtimeMode, which the caller allows by printing nothing; {deny: reason} to refuse it;
 * {admit: id} once the record's admitted stamp is written. deps.store is lib/seat-store.mjs and
 * deps.toolUseId, when a string, is recorded in the stamp. The stamp is write-once, so of two
 * calls racing to admit one record exactly one is admitted and the other is denied.
 */
export function gateDelegateTask(toolInput, { store, toolUseId } = {}) {
  if (!plainObject(toolInput)) return deny('the delegate_task call could not be read, so it is refused.')
  const { runtimeMode, task } = toolInput
  if (runtimeMode === undefined || runtimeMode === null || runtimeMode === 'inherit') {
    return deny('every delegate_task call in a flow session names runtimeMode explicitly; a child that inherits copies the parent\'s mode, full access included. Pass the mode `seat open` printed, `auto` today.')
  }
  if (typeof runtimeMode !== 'string') return deny('runtimeMode is not a string, so the call is refused.')
  if (typeof task !== 'string') return deny('the delegate_task task is not a string, so the call is refused.')

  const tag = store.parseTag(task)
  if (tag === null) return null
  if (tag.void) return deny('a seat tag appears in the task but not as the whole of line 1. Put the tag `seat open` printed alone on line 1.')

  const { id } = tag
  const loaded = store.readRecord(id)
  if (!loaded) return deny(`seat ${id} has no readable seat record. Open a new seat.`)
  if (store.readStamp(id, 'admitted') !== null) return deny(`seat ${id} was already admitted once. Open a new seat for another task.`)
  const { record } = loaded
  if (toolInput.role !== 'general') return deny('a seat call passes role "general", so T3 prepends nothing to the task.')
  const { target } = toolInput
  if (!plainObject(target) || typeof target.providerInstanceId !== 'string' || typeof target.model !== 'string') {
    return deny('the call\'s target.providerInstanceId or target.model could not be read, so the call is refused.')
  }
  const provider = PROVIDERS.get(target.providerInstanceId)
  if (!provider) return deny(`provider instance ${JSON.stringify(target.providerInstanceId.slice(0, 64))} is neither claudeAgent nor codex.`)
  const mismatched = [
    ['runtimeMode', runtimeMode, record.runtimeMode],
    ['provider', provider, record.provider],
    ['model', target.model, record.model],
  ].filter(([, asked, recorded]) => asked !== recorded)
  if (mismatched.length > 0) {
    const lines = mismatched.map(([field, , recorded]) => `${field} must be ${JSON.stringify(recorded)}`)
    return deny(`the call does not match seat ${id}'s record: ${lines.join('; ')}.`)
  }
  const stamp = typeof toolUseId === 'string' ? { toolUseId } : {}
  if (!store.stamp(id, 'admitted', stamp)) return deny(`seat ${id} was admitted by another call first.`)
  return { admit: id }
}

/**
 * Why this session may not bind the seat, or null when it may. Each fact is read by the caller:
 * the host the hook runs on, whether the session id passed the store's validation, the session's
 * permission_mode, the readRecord result, and the admitted and bound stamps (null when absent).
 * Creating the session index and the bound stamp are the bind's last two steps and can still be
 * lost to a racer after a null here; the caller reports those as their own reasons.
 */
export function bindProblem({ host, sessionValid, permissionMode, seat, admitted, bound }) {
  if (!seat) return 'record-missing'
  if (admitted === null || admitted === undefined) return 'not-admitted'
  if (bound !== null && bound !== undefined) return 'already-bound'
  if (!sessionValid) return 'session-id-invalid'
  if (seat.record.provider !== host) return 'host-mismatch'
  if (!(PERMISSION_MODES[host] ?? []).includes(permissionMode)) return 'permission-mode-not-allowed'
  if (!ACCESS.has(seat.record.access)) return 'record-access-unknown'
  return null
}

/**
 * Why a tool call in a seat session is denied before containment looks at it, or null. entry is
 * the session index entry, seat the readRecord result for its id.
 */
export function seatCallProblem({ entry, seat, toolName, toolInput }) {
  if (entry.void !== undefined) {
    return `flow seat: this session is a void seat (${String(entry.void).slice(0, 64)}), so every tool call is denied. Stop and report that the seat is void.`
  }
  if (!seat) return 'flow seat: this seat\'s record is missing or corrupt, so every tool call is denied. Stop and report it.'
  if (typeof toolName !== 'string' || !plainObject(toolInput)) return 'flow seat: the tool call could not be read, so it is denied.'
  return null
}

const ENVELOPE = '{"status": "done" | "partial" | "blocked", "coverage": {"read": [], "partial": [], "unopened": [], "checksRun": []}, "notes": "", "answer": {}}'

/**
 * The context a bound seat reads before its task: one sentence that sets the orchestrator half
 * aside, the record's facts, and the envelope its final message must be. The Seat Contract itself
 * arrived at SessionStart and is not repeated.
 */
export function seatContext(record) {
  const lines = [
    'The orchestrator half of the flow charter does not apply in this session: you are a flow seat, and the Seat Contract governs.',
    '',
    `Seat ${record.id}:`,
    `- access: ${record.access}`,
    `- provider: ${record.provider}, model: ${record.model}, effort: ${record.effort}, runtimeMode: ${record.runtimeMode}`,
    `- repository: ${record.repoRoot}`,
  ]
  if (record.access === 'workspace-write') {
    lines.push(
      `- worktree: ${record.worktree}. Edit only inside it.`,
      `- run every git write as \`git -C ${record.worktree} ...\`, and commit by path: \`git -C ${record.worktree} commit -- <paths>\`.`,
    )
  } else if (record.access === 'review') {
    lines.push(`- review worktree: ${record.worktree}, base ${record.baseSha}, head ${record.headSha}. Edit nothing.`)
  } else {
    lines.push(`- worktree: ${record.worktree}. Edit nothing.`)
  }
  lines.push(
    '',
    'Your final message is one JSON object in the flow envelope and nothing else:',
    ENVELOPE,
    '`answer` follows the answer schema your task names.',
  )
  if (record.access === 'workspace-write') lines.push('Add "commits": [{"sha": "", "subject": ""}] with every commit you made.')
  return lines.join('\n')
}

/** The context a void seat reads: it must stop, because every tool call it makes is denied. */
export function voidSeatContext(reason) {
  return [
    `This session carries a flow seat tag, but it could not bind as a flow seat (${reason}), so it is a void seat.`,
    'Every tool call in this session is denied. Do no work: reply with one line saying the seat is void and why, then stop.',
    'The parent reads this seat\'s verdict as unknown and reruns the work elsewhere.',
  ].join('\n')
}
