import { FLOW_CHARTER } from './charter.mjs'

export function delegatedInstructions(job, provider) {
  const access = job.access === 'workspace-write'
    ? 'You may edit only the assigned Git worktree. Do not publish, push, or modify another checkout.'
    : 'This is a read-only job. Do not edit files or mutate the repository.'
  const profile = job.profile === 'defensive-security'
    ? '\nThe caller selected the defensive-security profile for authorized defensive research.'
    : ''
  return `${FLOW_CHARTER.trim()}\n\n<delegated-seat>\nYou are a delegated ${provider} worker. Complete the caller task directly. Do not start subagents, invoke Claude or Codex through the shell, or start another cross-family delegation. ${access} Stay within the assigned workspace and access mode. Read and follow the applicable AGENTS.md or CLAUDE.md files before acting.${profile}\n</delegated-seat>`
}
