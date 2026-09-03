import { charterSection } from '../../lib/charter-payload.mjs'
import { universalContainment } from '../../lib/seat-contract.mjs'
import { FLOW_CHARTER } from './charter.mjs'
import { FLOW_SEAT_CONTRACT } from './seat-contract.mjs'

// The one charter section a delegated seat is handed. The rest of the charter is doctrine
// for the orchestrator that delegated the job: how to spawn, which model plays which role,
// how the pipeline runs, when to ask the human. A leaf seat cannot spawn, ask, publish or
// delegate, so none of it binds there, and every byte of it would ride every job and every
// continuation. The engineering rules bind any seat that reads or writes code.
export const DELEGATED_CHARTER_HEADING = 'Rules of Engagement - Everything Else'

const section = charterSection(FLOW_CHARTER, DELEGATED_CHARTER_HEADING)
if (section === null) {
  throw new Error(`the charter has no "## ${DELEGATED_CHARTER_HEADING}" section to hand a delegated seat`)
}
// No binding profile rides with the section because the section names no role. A marker
// here would be a rule the seat could not bind, so it fails at load, before any job runs.
if (section.includes('[[role:')) {
  throw new Error(`the "${DELEGATED_CHARTER_HEADING}" charter section names a role, which a delegated seat cannot bind`)
}

export const FLOW_DELEGATED_RULES = section.trim()

export function delegatedInstructions(job, provider) {
  const access = job.access === 'workspace-write'
    ? 'You may edit only the assigned Git worktree. Do not publish, push, or modify another checkout.'
    : 'This is a read-only job. Do not edit files or mutate the repository.'
  // Containment and nothing else. A delegated worker is a seat, so it gets the section of the
  // seat contract every seat obeys whatever the host; the other three sections are doctrine for
  // a seat working an issue, and a caller that wants them pastes them into its own task text.
  // Widening this to a second section is a payload every job pays for, so it is a decision.
  const containment = universalContainment(FLOW_SEAT_CONTRACT).trim()
  // Rebuilt on every call, so a continuation gets the same block from the same source rather
  // than caller prose.
  return `<flow-charter scope="delegated-seat">\nThis is the engineering-rules section of the flow charter. The rest of the charter governs the orchestrator that delegated this job and does not apply to this seat.\n\n${FLOW_DELEGATED_RULES}\n</flow-charter>\n\n<delegated-seat>\nYou are a delegated ${provider} worker. Complete the caller task directly. Do not start subagents, invoke Claude or Codex through the shell, or start another cross-family delegation. ${access} Stay within the assigned workspace and access mode. Read and follow the applicable AGENTS.md or CLAUDE.md files before acting.\n</delegated-seat>\n\n<seat-contract scope="containment">\n${containment}\n</seat-contract>`
}
