import { DelegationError } from './contracts.mjs'

export function normalizeClaudeError(error) {
  if (error instanceof DelegationError) return error
  const text = String(error?.message || error || '')
  if (error?.code === 'ENOENT') {
    return new DelegationError('CLAUDE_NOT_INSTALLED', 'Claude Code could not be started.')
  }
  if (/model/i.test(text) && /invalid|unknown|not found|does not exist|unsupported/i.test(text)) {
    return new DelegationError('BAD_MODEL', 'Claude rejected the requested model.')
  }
  if (/effort/i.test(text) && /invalid|unknown|unsupported/i.test(text)) {
    return new DelegationError('BAD_EFFORT', 'Claude rejected the requested effort level.')
  }
  if (/auth|login|oauth|credential/i.test(text)) {
    return new DelegationError('CLAUDE_AUTH', 'Claude Code is not authenticated for Agent SDK use.')
  }
  if (/could not be started|failed to (?:launch|spawn)|executable(?: was)? not found/i.test(text)) {
    return new DelegationError('CLAUDE_NOT_INSTALLED', 'Claude Code could not be started.')
  }
  if (/sandbox/i.test(text)) {
    return new DelegationError('SANDBOX_UNAVAILABLE', 'Claude could not start the required sandbox.')
  }
  return new DelegationError('CLAUDE_SDK', 'The Claude Agent SDK ended before the job completed.')
}
