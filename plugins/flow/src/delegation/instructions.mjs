import { seatPayload } from '../../lib/charter-payload.mjs'
import { FLOW_CHARTER } from './charter.mjs'

// The seat half of the charter, verbatim, and nothing above the marker. Everything above it is
// doctrine for the orchestrator that delegated the job: how to spawn, which model plays which
// seat, how the pipeline runs, when to ask the human. A leaf seat cannot spawn, ask, publish or
// delegate, so none of it binds here, and every byte would ride every job and every continuation.
// seatPayload throws at load when the charter carries no marker line, before any job runs.
export const FLOW_SEAT_RULES = seatPayload(FLOW_CHARTER)

export function delegatedInstructions(job, provider) {
  const access = job.access === 'workspace-write'
    ? 'You may edit only the assigned Git worktree. Do not publish, push, or modify another checkout.'
    : 'This is a read-only job. Do not edit files or mutate the repository.'
  // Rebuilt on every call, so a continuation gets the same block from the same source rather
  // than caller prose.
  return `${FLOW_SEAT_RULES}\n<delegated-seat>\nYou are a delegated ${provider} worker. Complete the caller task directly. Do not start subagents, invoke Claude or Codex through the shell, or start another cross-family delegation. ${access} Stay within the assigned workspace and access mode. Read and follow the applicable AGENTS.md or CLAUDE.md files before acting.\n</delegated-seat>`
}
