import { profileBlock } from '../../lib/charter-payload.mjs'
import { universalContainment } from '../../lib/seat-contract.mjs'
import { FLOW_CHARTER } from './charter.mjs'
import { FLOW_SEAT_CONTRACT } from './seat-contract.mjs'
import { profileForTarget } from './profiles.mjs'

export function delegatedInstructions(job, provider) {
  const access = job.access === 'workspace-write'
    ? 'You may edit only the assigned Git worktree. Do not publish, push, or modify another checkout.'
    : 'This is a read-only job. Do not edit files or mutate the repository.'
  const profile = job.profile === 'defensive-security'
    ? '\nThe caller selected the defensive-security profile for authorized defensive research.'
    : ''
  // Keyed off the job's target, the family the work runs in, and rebuilt on every call so
  // a continuation gets the same block from the same source rather than caller prose.
  const host = String(job.target || '').toLowerCase()
  const bindings = profileBlock({ host, text: profileForTarget(host) })
  // Containment and nothing else. A delegated worker is a seat, so it gets the section of the
  // seat contract every seat obeys whatever the host; the other three sections are doctrine for
  // a seat working an issue, and a caller that wants them pastes them into its own task text.
  // Widening this to a second section is a payload every job pays for, so it is a decision.
  const containment = universalContainment(FLOW_SEAT_CONTRACT).trim()
  return `${FLOW_CHARTER.trim()}\n\n${bindings}\n<delegated-seat>\nYou are a delegated ${provider} worker. Complete the caller task directly. Do not start subagents, invoke Claude or Codex through the shell, or start another cross-family delegation. ${access} Stay within the assigned workspace and access mode. Read and follow the applicable AGENTS.md or CLAUDE.md files before acting.${profile}\n</delegated-seat>\n\n<seat-contract scope="containment">\n${containment}\n</seat-contract>`
}
