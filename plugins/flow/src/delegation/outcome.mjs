import Ajv2020 from 'ajv/dist/2020.js'
import { DelegationError, publicError } from './contracts.mjs'

export function finalMessage(turn, fallback) {
  const messages = (turn?.items || []).filter((item) => item.type === 'agentMessage' && item.text)
  return messages.at(-1)?.text || fallback || ''
}

export function validateStructured(schema, text) {
  let value
  try { value = JSON.parse(text) } catch {
    throw new DelegationError('SCHEMA_OUTPUT', 'Codex returned text that is not valid JSON.')
  }
  return validateStructuredValue(schema, value, 'Codex')
}

export function validateStructuredValue(schema, value, provider = 'The delegated model') {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  let validate
  try { validate = ajv.compile(schema) } catch {
    throw new DelegationError('BAD_SCHEMA', 'The output schema is not a valid JSON Schema.')
  }
  if (!validate(value)) {
    throw new DelegationError('SCHEMA_OUTPUT', `${provider} returned JSON that does not match the requested schema.`, {
      errors: validate.errors?.slice(0, 20) || [],
    })
  }
  return value
}

function codexTurnError(error) {
  const text = String(error?.message || '')
  if (/model/i.test(text) && /invalid|unknown|not found|does not exist|unsupported/i.test(text)) {
    return { kind: 'BAD_MODEL', message: 'Codex rejected the requested model.', details: null }
  }
  if (/schema|structured output|response_format/i.test(text)) {
    return { kind: 'BAD_SCHEMA', message: 'Codex rejected the output schema.', details: null }
  }
  if (/(?:^|[^a-z0-9])(?:auth|authentication|authorization|login|oauth|credentials?|unauthenticated|not[ _-]+authenticated)(?:[^a-z0-9]|$)/i.test(text)) {
    return { kind: 'CODEX_AUTH', message: 'Codex is not authenticated.', details: null }
  }
  if (/rate.?limit|too many requests|quota/i.test(text)) {
    return { kind: 'RATE_LIMIT', message: 'Codex rejected the turn because an account limit was reached.', details: null }
  }
  return { kind: 'CODEX_TURN', message: 'Codex reported a failed turn.', details: null }
}

// The one fold from a native Codex turn to a job outcome. The live worker and recovery must
// agree on what a turn means, so both call this. The worker fills every context flag;
// reconcile() can read the controls table for a cancel request but cannot tell a deadline
// from a stall, so it passes neither and an interrupted turn folds to plain INTERRUPTED.
export function foldTurnOutcome(turn, {
  cancelRequested = false,
  deadlineFired = false,
  stallFired = false,
  acceptedWrite = false,
  latestMessage = '',
  transportError = null,
} = {}) {
  if (!turn) {
    return {
      status: acceptedWrite ? 'unknown' : 'failed',
      error: transportError
        ? publicError(transportError)
        : {
          kind: stallFired ? 'STALL' : 'TIMEOUT',
          message: 'The turn did not confirm a terminal state after interruption.',
          details: null,
        },
    }
  }
  if (turn.status === 'interrupted') {
    if (cancelRequested) return { status: 'cancelled', error: null }
    return {
      status: 'failed',
      error: {
        kind: deadlineFired ? 'TIMEOUT' : stallFired ? 'STALL' : 'INTERRUPTED',
        message: 'Codex interrupted the turn.',
        details: null,
      },
    }
  }
  if (turn.status === 'failed') {
    return {
      status: 'failed',
      error: codexTurnError(turn.error),
      internalError: turn.error || null,
    }
  }
  if (turn.status === 'completed') {
    const output = finalMessage(turn, latestMessage).trim()
    if (!output) {
      return {
        status: 'failed',
        error: { kind: 'EMPTY_OUTPUT', message: 'Codex completed without a final agent message.', details: null },
      }
    }
    return { status: 'succeeded', output, error: null }
  }
  return {
    status: 'unknown',
    error: { kind: 'UNKNOWN_TURN', message: `Codex ended with turn status ${turn.status || 'missing'}.`, details: null },
  }
}
