// The approval fork, shared by both workers. A provider that asks for an approval used to
// get an immediate deny and the job ended as awaiting_approval. When the MCP client that
// started the job can render an elicitation form, the worker parks the request in the
// store, the server process (the only one holding the MCP session) asks the human, writes
// the decision back, and the worker answers the provider with it. Flow still never grants
// on its own: a decision the human did not make within the window is a decline.
//
// The worker and the server are different processes, so the store is the channel. Polling
// at 250ms is the same cadence the control queue uses.

export const APPROVAL_WAIT_SECONDS = 240
const APPROVAL_POLL_MS = 250
const SUMMARY_LIMIT = 400

const bounded = (value) => {
  if (value === undefined || value === null) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text
}

/**
 * The bounded, public description of an approval request: what the provider wants to do,
 * never the raw request. This is what the human sees in the form, so it carries no
 * environment, no credentials, and no more than a few hundred characters of any field.
 */
export function approvalSummary(method, params = {}) {
  if (method === 'item/commandExecution/requestApproval') {
    return { kind: 'command', command: bounded(params.command ?? params.item?.command), cwd: bounded(params.cwd), itemId: params.itemId ?? null }
  }
  if (method === 'item/fileChange/requestApproval') {
    return { kind: 'file-change', path: bounded(params.path ?? params.item?.path), itemId: params.itemId ?? null }
  }
  if (method === 'claude/can_use_tool') {
    return { kind: 'tool', toolName: bounded(params.toolName), input: bounded(params.input) }
  }
  return { kind: 'other', method }
}

/**
 * Park an approval request and wait for the human's decision, or the window to close.
 * Returns 'accept' or 'decline'. A cancel request arriving mid-wait is a decline, because
 * the caller has already said it wants the job to stop.
 */
export async function awaitApproval(store, jobId, { method, summary }, { seconds = APPROVAL_WAIT_SECONDS, onTick = () => {} } = {}) {
  const approvalId = store.requestApproval(jobId, { method, summary, seconds })
  const deadline = Date.now() + seconds * 1_000
  while (Date.now() < deadline) {
    const decision = store.approvalDecision(jobId, approvalId)
    if (decision) return decision
    if (store.cancelRequested(jobId)) {
      store.decideApproval(jobId, approvalId, 'decline', 'cancel')
      return 'decline'
    }
    onTick()
    await new Promise((resolve) => setTimeout(resolve, APPROVAL_POLL_MS))
  }
  store.decideApproval(jobId, approvalId, 'decline', 'timeout')
  return 'decline'
}
