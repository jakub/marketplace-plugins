#!/usr/bin/env node
// The T3 seat guard, one adapter for both hosts.
//
//   seat-guard.mjs prompt <claude|codex>   UserPromptSubmit: bind a tagged session to its seat
//   seat-guard.mjs pre <claude|codex>      PreToolUse, every tool: admit delegate_task, hold a seat
//   seat-guard.mjs stop <claude|codex>     Stop: check the final message, record it or block
//
// Policy is lib/seat-policy.mjs and the records are lib/seat-store.mjs. This file reads the call,
// asks the policy, and answers in wire.mjs's shapes. It allows by printing nothing.
//
// The PreToolUse group matches every tool in every session, so the path a non-seat session takes
// is the cost every tool call pays. That path reads stdin and makes one existsSync on the session
// index, the stop path does the same, and the prompt path makes one string test and touches no
// file. seat-policy.mjs is imported only past those checks. The static imports are wire.mjs and
// seat-store.mjs, which load node built-ins alone.
//
// A body this cannot read exits 0 with no output on both hosts: without a session id it cannot
// tell a seat from any other session, and a catch-all that failed closed would block every tool
// call after a harness change. Once the session index names a seat, everything that cannot be
// read is denied.
//
// Order in pre: the seat checks run before the delegate_task gate, so a seat's own delegate_task
// call is held as a seat call first and can never admit a record on the way.
//
// A tagged prompt ends one of three ways: bound, with the seat context; void, with the void
// context; or refused outright. The session index is what makes every later tool call a seat
// call, so a prompt whose session cannot end with a durable index entry, bound or void, is
// refused: injecting the void context alone would leave the session's tool calls reading as a
// non-seat's and running uncontained.
//
// Stop holds a bound seat to its answer. The turn is Claude's prompt_id or Codex's turn_id. A final
// message that is the flow envelope with a matching answer is written as result-<turn>.json with
// the digest of the message and the models that served it: Codex names its model in the Stop call,
// and Claude's are read from the session transcript from the bind on. Any other message is blocked
// with its problems, at most STOP_BLOCKS times a turn. A turn can stop again after it was settled,
// valid or capped, when another Stop hook blocks and the host resumes it, so the final message is
// checked again whenever it differs from the one last checked in the turn: a changed valid message
// replaces the result, and a changed failing one counts against the turn's blocks like any other,
// leaving the turn blocked or capped, which is what seat close reads. The same message is left
// alone. Every stop, that one included, adds the models it saw to `models` in the turn state, a set
// kept across turns, so a result replaced or a turn passed over never drops a model from what seat
// close judges. A void seat, a missing record, or a failure in this hook blocks nothing: the stop goes
// through, and seat close reads the turn's missing result.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as store from '../../lib/seat-store.mjs'
import { applyPatchPaths, preToolDeny, promptBlock, promptContext, readHookInput, stopBlock, transcriptModels } from './wire.mjs'

const DELEGATE_TASK = /^mcp__t3[-_]code__delegate_task$/
const [mode, host] = process.argv.slice(2)
const complain = (line) => process.stderr.write(`seat-guard: ${line}\n`)
const answer = (value) => process.stdout.write(JSON.stringify(value))
const loadPolicy = () => import('../../lib/seat-policy.mjs')

async function prompt(input) {
  const text = input.prompt
  if (typeof text !== 'string' || !text.includes('<flow-seat ')) return
  const tag = store.parseTag(text)
  if (tag === null) return
  const policy = await loadPolicy()
  const sessionId = input.session_id
  const id = tag.id ?? null

  const voidSeat = (reason) => {
    // The record's void stamp is its first claimant's alone: a tag replayed in another session
    // voids that session and never touches a record someone else already bound. The stamp is
    // best effort; the session index is what holds the session.
    try {
      if (id && store.readStamp(id, 'bound') === null) store.stamp(id, 'void', { reason })
    } catch (error) { complain(`void stamp: ${error.message}`) }
    let indexed = false
    try { indexed = store.voidSession(host, sessionId, id, reason) } catch (error) { complain(`void index: ${error.message}`) }
    answer(indexed ? promptContext(policy.voidSeatContext(reason)) : promptBlock(policy.unindexedSeatReason(reason)))
  }
  if (tag.void) return voidSeat(tag.void)

  try {
    const seat = store.readRecord(id)
    const problem = policy.bindProblem({
      host,
      sessionValid: store.indexPath(host, sessionId) !== null,
      permissionMode: input.permission_mode,
      seat,
      admitted: store.readStamp(id, 'admitted'),
      bound: store.readStamp(id, 'bound'),
      voided: store.readStamp(id, 'void'),
    })
    if (problem) return voidSeat(problem)
    if (!store.indexSession(host, sessionId, { id })) return voidSeat('session-already-indexed')
    const bound = { sessionId, host, permissionMode: input.permission_mode, cwd: typeof input.cwd === 'string' ? input.cwd : null, recordDigest: seat.digest }
    if (typeof input.model === 'string') bound.model = input.model
    if (!store.stamp(id, 'bound', bound)) return voidSeat('bound-lost-race')
    answer(promptContext(policy.seatContext(seat.record, seat.schema)))
  } catch (error) {
    complain(`bind: ${error.message}`)
    voidSeat('bind-failed')
  }
}

async function pre(input) {
  const toolName = input.tool_name
  const delegateTask = typeof toolName === 'string' && DELEGATE_TASK.test(toolName)
  const index = store.indexPath(host, input.session_id)
  const inSeat = index !== null && existsSync(index)
  if (!inSeat && !delegateTask) return
  const policy = await loadPolicy()

  if (inSeat) {
    try {
      const entry = store.readIndex(host, input.session_id)
      if (entry !== null) {
        const seat = entry.void === undefined ? store.readRecord(entry.id) : null
        const closed = seat ? store.readStamp(entry.id, 'closed') : null
        const problem = policy.seatCallProblem({ entry, seat, closed, toolName, toolInput: input.tool_input })
        if (problem) return answer(preToolDeny(problem))
        // The receipt proves a seat call reached this hook. It is written before any decision on
        // the call, so a seat whose first call is denied still shows the hook ran.
        store.stamp(entry.id, 'receipt', { tool: toolName })
        const reason = policy.toolProblem(
          { record: seat.record, toolName, toolInput: input.tool_input, cwd: input.cwd },
          { patchPaths: applyPatchPaths },
        )
        if (reason) return answer(preToolDeny(reason))
      }
    } catch (error) {
      complain(`seat: ${error.message}`)
      return answer(preToolDeny('flow seat: the seat guard could not check this call, so it is denied.'))
    }
  }

  if (delegateTask) {
    try {
      const decision = policy.gateDelegateTask(input.tool_input, { store, toolUseId: input.tool_use_id })
      if (decision?.deny) answer(preToolDeny(decision.deny))
    } catch (error) {
      complain(`gate: ${error.message}`)
      answer(preToolDeny('flow seat: the delegate_task gate could not check this call, so it is denied.'))
    }
  }
}

async function stop(input) {
  const index = store.indexPath(host, input.session_id)
  if (index === null || !existsSync(index)) return
  const policy = await loadPolicy()
  try {
    const entry = store.readIndex(host, input.session_id)
    if (entry === null || entry.void !== undefined) return
    const { id } = entry
    const seat = store.readRecord(id)
    if (!seat) return complain(`stop: seat ${id} has no readable record`)
    const prior = store.readState(id)
    const state = policy.stopTurn(prior, host === 'claude' ? input.prompt_id : input.turn_id)
    const servedModels = host === 'codex'
      ? (typeof input.model === 'string' ? [input.model] : [])
      : transcriptModels(input.transcript_path, { sessionId: input.session_id, since: store.readStamp(id, 'bound')?.at ?? null })
    const models = policy.seenModels(prior, servedModels)
    const messageSha256 = store.textDigest(input.last_assistant_message)
    const settled = state.outcome === 'valid' || state.outcome === 'capped'
    if (settled && messageSha256 !== null && messageSha256 === state.messageSha256) {
      // The turn stands as it was, but the models this stop saw still go on record.
      if (models.length !== (prior.models?.length ?? 0)) store.writeState(id, { ...prior, models })
      return
    }
    const schemaPath = seat.record.schemaSha256 == null ? null : join(store.seatDir(id), 'schema.json')
    const checked = policy.finalAnswer(seat.record, input.last_assistant_message, schemaPath)
    if (checked.envelope) {
      store.writeResult(id, state.turn, { envelope: checked.envelope, servedModels, messageSha256, at: new Date().toISOString() })
      return store.writeState(id, { ...state, outcome: 'valid', errors: [], messageSha256, models })
    }
    const failed = policy.failedStop(seat.record, state, checked.errors)
    store.writeState(id, { ...failed.state, messageSha256, models })
    if (failed.block) answer(stopBlock(failed.block))
  } catch (error) {
    complain(`stop: ${error.message}`)
  }
}

async function main() {
  if (!['claude', 'codex'].includes(host)) return complain(`expected host "claude" or "codex", got ${JSON.stringify(host)}`)
  if (!['prompt', 'pre', 'stop'].includes(mode)) return complain(`expected mode "prompt", "pre" or "stop", got ${JSON.stringify(mode)}`)
  const input = await readHookInput()
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return
  if (mode === 'prompt') return prompt(input)
  if (mode === 'stop') return stop(input)
  return pre(input)
}

await main()
