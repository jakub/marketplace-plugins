// The approval fork, shared by both workers. A provider that asks for an approval used to
// get an immediate deny and the job ended as awaiting_approval. When the MCP client that
// started the job can render an elicitation form, the worker parks the request in the
// store, the server process (the only one holding the MCP session) asks the human, writes
// the decision back, and the worker answers the provider with it. Flow still never grants
// on its own: a decision the human did not make within the window is a decline, and so is
// a request Flow cannot show in full, because a form that hides part of the action is a
// form that approves something the human did not see.
//
// The worker and the server are different processes, so the store is the channel. Polling
// at 250ms is the same cadence the control queue uses.

export const APPROVAL_WAIT_SECONDS = 240
const APPROVAL_POLL_MS = 250
// A field longer than this cannot be shown whole, and a truncated command or input is where a
// destructive suffix hides. Such a request is declined unasked.
export const DETAIL_LIMIT = 4000

const text = (value) => value === undefined || value === null ? null : typeof value === 'string' ? value : JSON.stringify(value)
const whole = (value) => {
  const rendered = text(value)
  return rendered !== null && rendered.length > 0 && rendered.length <= DETAIL_LIMIT ? rendered : null
}

/**
 * The public description of an approval request, or the reason it cannot be put to the
 * human. What the human sees is exactly what is here: the command, the paths, the tool and
 * its input, each whole or absent. Never the raw request, never the environment, never a
 * diff body.
 */
export function approvalSummary(method, params = {}, context = {}) {
  if (method === 'item/commandExecution/requestApproval') {
    const kind = params.kind ?? 'command'
    if (kind !== 'command') return { ok: false, reason: `a ${kind} approval carries no command to show` }
    const command = whole(params.command)
    if (!command) return { ok: false, reason: params.command ? 'the command is longer than the form can show' : 'the request names no command' }
    return { ok: true, summary: { kind: 'command', command, cwd: whole(params.cwd), reason: whole(params.reason) } }
  }
  if (method === 'item/fileChange/requestApproval') {
    const changes = context.item?.changes
    if (!Array.isArray(changes) || changes.length === 0) return { ok: false, reason: 'no file change item is on record for this request' }
    const paths = changes.map((change) => change?.path ?? change?.filePath).filter((path) => typeof path === 'string' && path.length > 0)
    if (paths.length !== changes.length || paths.length > 100) return { ok: false, reason: 'the file change names paths the form cannot show' }
    return { ok: true, summary: { kind: 'file-change', paths, kinds: changes.map((change) => change?.kind ?? null), reason: whole(params.reason) } }
  }
  if (method === 'claude/can_use_tool') {
    const toolName = whole(params.toolName)
    if (!toolName) return { ok: false, reason: 'the request names no tool' }
    // The host's own rendered sentence is the authoritative description when it is present;
    // the input is shown whole beside it or not at all.
    const title = whole(params.title)
    const input = whole(params.input)
    if (!title && !input) return { ok: false, reason: 'the tool input is longer than the form can show and the host rendered no title' }
    return {
      ok: true,
      summary: {
        kind: 'tool', toolName, title, input,
        description: whole(params.description), blockedPath: whole(params.blockedPath), decisionReason: whole(params.decisionReason),
      },
    }
  }
  return { ok: false, reason: `Flow does not put ${method} to the human` }
}

const LIVE = new Set(['queued', 'starting', 'running', 'reconciling'])

/**
 * Park an approval request and wait for the human's decision, or the window to close.
 * Returns 'accept' or 'decline'. A cancel on record beats an accept whenever both exist,
 * checked before the decision is read and again after, and the store refuses to record an
 * accept over a queued cancel, so the three checks agree. A job that stopped being live
 * while the form was open gets a decline too, so the worker never waits on a dead turn.
 */
export async function awaitApproval(store, jobId, { method, summary }, { seconds = APPROVAL_WAIT_SECONDS, onTick = () => {} } = {}) {
  const approvalId = store.requestApproval(jobId, { method, summary, seconds })
  const deadline = Date.now() + seconds * 1_000
  while (Date.now() < deadline) {
    if (store.cancelRequested(jobId)) {
      store.decideApproval(jobId, approvalId, 'decline', 'cancel')
      return 'decline'
    }
    const decision = store.approvalDecision(jobId, approvalId)
    if (decision === 'accept' && store.cancelRequested(jobId)) return 'decline'
    if (decision) return decision
    if (!LIVE.has(store.getJob(jobId)?.status)) {
      store.decideApproval(jobId, approvalId, 'decline', 'job-ended')
      return 'decline'
    }
    onTick()
    await new Promise((resolve) => setTimeout(resolve, APPROVAL_POLL_MS))
  }
  store.decideApproval(jobId, approvalId, 'decline', 'timeout')
  return 'decline'
}
