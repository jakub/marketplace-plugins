#!/usr/bin/env node
// The T3 seat guard, one adapter for both hosts.
//
//   seat-guard.mjs prompt <claude|codex>   UserPromptSubmit: bind a tagged session to its seat
//   seat-guard.mjs pre <claude|codex>      PreToolUse, every tool: admit delegate_task, hold a seat
//   seat-guard.mjs stop <claude|codex>     Stop: not registered yet; exits 0 and prints nothing
//
// Policy is lib/seat-policy.mjs and the records are lib/seat-store.mjs. This file reads the call,
// asks the policy, and answers in wire.mjs's shapes. It allows by printing nothing.
//
// The PreToolUse group matches every tool in every session, so the path a non-seat session takes
// is the cost every tool call pays. That path reads stdin and makes one existsSync on the session
// index, and the prompt path makes one string test and touches no file. seat-policy.mjs is
// imported only past those checks. The static imports are wire.mjs and seat-store.mjs, which load
// node built-ins alone.
//
// A body this cannot read exits 0 with no output on both hosts: without a session id it cannot
// tell a seat from any other session, and a catch-all that failed closed would block every tool
// call after a harness change. Once the session index names a seat, everything that cannot be
// read is denied.
//
// Order in pre: the seat checks run before the delegate_task gate, so a seat's own delegate_task
// call is held as a seat call first and can never admit a record on the way.

import { existsSync } from 'node:fs'
import * as store from '../../lib/seat-store.mjs'
import { preToolDeny, promptContext, readHookInput } from './wire.mjs'

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
    // Each write is best effort: the context still reaches the child when the state dir refuses.
    try { if (id) store.stamp(id, 'void', { reason }) } catch (error) { complain(`void stamp: ${error.message}`) }
    try { store.voidSession(host, sessionId, id, reason) } catch (error) { complain(`void index: ${error.message}`) }
    answer(promptContext(policy.voidSeatContext(reason)))
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
    })
    if (problem) return voidSeat(problem)
    if (!store.indexSession(host, sessionId, { id })) return voidSeat('session-already-indexed')
    const bound = { sessionId, host, permissionMode: input.permission_mode, cwd: typeof input.cwd === 'string' ? input.cwd : null, recordDigest: seat.digest }
    if (typeof input.model === 'string') bound.model = input.model
    if (!store.stamp(id, 'bound', bound)) return voidSeat('bound-lost-race')
    answer(promptContext(policy.seatContext(seat.record)))
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
        const problem = policy.seatCallProblem({ entry, seat, toolName, toolInput: input.tool_input })
        if (problem) return answer(preToolDeny(problem))
        // The receipt proves a seat call reached this hook. It is written before any decision on
        // the call, so a seat whose first call is denied still shows the hook ran.
        store.stamp(entry.id, 'receipt', { tool: toolName })
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

async function main() {
  if (!['claude', 'codex'].includes(host)) return complain(`expected host "claude" or "codex", got ${JSON.stringify(host)}`)
  if (!['prompt', 'pre', 'stop'].includes(mode)) return complain(`expected mode "prompt", "pre" or "stop", got ${JSON.stringify(mode)}`)
  if (mode === 'stop') return
  const input = await readHookInput()
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return
  if (mode === 'prompt') return prompt(input)
  return pre(input)
}

await main()
