#!/usr/bin/env node
// gripe: Stop checkpoint.
//
// Fires at the end of a turn, for the main agent via Stop and for subagents via
// SubagentStop. Its job is the friction that never raises an error: a command that exits 0
// while doing the wrong thing, an ambiguous instruction the agent guessed at, a dead end
// where every individual call succeeded. It also cites repeated identical failures, which
// PostToolUseFailure nudges on mid-run; fingerprints that hook already nudged arrive via
// the shared gate state and are excluded here, so one fight buys one interruption.
//
// The note it emits always cites concrete events read out of the transcript. It never asks
// the agent to search its memory for annoyance, and it never requires a reply, because a
// question that expects an answer will get one whether or not anything went wrong.
//
// Scanning is incremental. Transcripts only grow, and a quiet session would otherwise
// re-read and re-parse the whole file at every turn end, so per-actor state carries a
// byte offset and the running counters and each run consumes only what was appended.
//
// Contract: read hook JSON on stdin, optionally write hookSpecificOutput JSON, always
// exit 0. Stop's additionalContext is non-error feedback and the conversation continues,
// so the agent can act on it without the turn being marked as failed.

import { open } from 'node:fs/promises'
import { MAX_COUNTER_KEYS, capKeys, fingerprint, loadGate } from '../../lib/gate.mjs'
import {
  MAX_SCAN_BYTES, MAX_TOOL_NAMES, buildCheckpointNote, freshCheckpointState,
  loadCheckpointState, observeToolResult, saveCheckpointState,
} from '../../lib/checkpoint.mjs'
import { safeId } from '../../lib/context.mjs'

/** Read only what was appended since the last run and fold it into the counters. */
async function scanNew(path, state) {
  let fh
  try {
    fh = await open(path, 'r')
  } catch {
    return state // transcript not readable, nothing to do
  }
  try {
    const { size } = await fh.stat()
    // A file smaller than our offset was truncated or replaced. Start over.
    if (size < state.offset) {
      const reset = freshCheckpointState()
      reset.asked = state.asked
      state = reset
    }
    // A tail past the byte budget gets its middle skipped, not buffered whole.
    if (size - state.offset > MAX_SCAN_BYTES) state.offset = size - MAX_SCAN_BYTES
    const len = size - state.offset
    if (len <= 0) return state

    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, state.offset)

    // Stop at the last newline. A trailing partial line is a half-flushed write, and
    // consuming it would both fail to parse and skip the record once it completes.
    const lastNl = buf.lastIndexOf(0x0a)
    if (lastNl === -1) return state

    const text = buf.subarray(0, lastNl).toString('utf8')
    state.offset += lastNl + 1

    for (const line of text.split('\n')) {
      if (!line) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const content = rec?.message?.content
      if (!Array.isArray(content)) continue

      for (const block of content) {
        if (block?.type === 'tool_use') {
          observeToolResult(state, { toolName: block.name, toolId: block.id, toolInput: block.input })
        } else if (block?.type === 'tool_result' && block.is_error) {
          const tool = state.toolNames[block.tool_use_id] || 'unknown'
          const raw = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? '')
          const fp = fingerprint(tool, raw)
          const seen = state.failures[fp] || { count: 0, tool, sample: raw.slice(0, 120) }
          seen.count++
          state.failures[fp] = seen
        }
      }
    }

    // Cap before the caller builds the note, so evaluation and the persisted state see
    // the same bounded evidence set; saveCheckpointState caps again defensively.
    capKeys(state.toolNames, MAX_TOOL_NAMES)
    capKeys(state.failures, MAX_COUNTER_KEYS)
    capKeys(state.churn, MAX_COUNTER_KEYS)
    return state
  } catch {
    return state
  } finally {
    await fh.close().catch(() => {})
  }
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk

  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return // unparseable input, never block on our own bug
  }

  // A Stop hook that re-fires on the continuation it caused will loop forever.
  if (input.stop_hook_active) return

  // Background work still running means the session is paused, not finished. Asking now
  // interrupts work in progress rather than reflecting on work that is done.
  const pending = (input.background_tasks || []).some((t) =>
    ['running', 'pending'].includes(String(t?.status).toLowerCase()),
  )
  if (pending) return

  // SubagentStop delivers agent_transcript_path instead of transcript_path, and an
  // agent_id that scopes the state: subagents share their parent's session id, so the
  // actor is the only thing keeping their scans apart. Both ids land in a filename, so
  // either one outside the safe alphabet is treated as absent rather than becoming a
  // path. An absent session id leaves nothing to key the checkpoint on, so the hook stops.
  const sessionId = safeId(input.session_id)
  const transcript = input.transcript_path || input.agent_transcript_path
  const actor = safeId(input.agent_id) ?? 'main'
  if (!sessionId || !transcript) return

  const state = loadCheckpointState(sessionId, actor, 'claude')
  // One checkpoint per session per actor. Repeated asking is what teaches an agent to
  // answer "none", and once asked there is nothing left to scan for.
  if (state.asked) return

  // scanNew returns the state to use: on a truncated transcript it hands back a fresh
  // one rather than the object passed in, so the return value is not optional.
  const scanned = await scanNew(transcript, state)
  const gate = loadGate(sessionId, actor)
  const nudged = new Set(
    Object.entries(gate.fingerprints).filter(([, r]) => r.nudgedAt).map(([fp]) => fp),
  )
  // Attribution is baked into the recipe as literals, so a subagent's filing carries its
  // own id without the agent deciding anything.
  const flags = ['--via checkpoint']
  if (actor !== 'main') flags.push(`--agent ${actor}`)
  const prompt = safeId(input.prompt_id)
  if (prompt) flags.push(`--prompt ${prompt}`)
  const note = buildCheckpointNote(scanned, nudged, flags)
  if (note) scanned.asked = true

  // Always persist, note or not. Recording that we looked is the whole point of the
  // offset: a quiet session must not re-parse the transcript at every turn end.
  saveCheckpointState(sessionId, actor, 'claude', scanned)

  if (!note) return
  // Echo the incoming event name: additionalContext under a mismatched hookEventName is
  // dropped, and this script serves both Stop and SubagentStop.
  const eventName = input.hook_event_name === 'SubagentStop' ? 'SubagentStop' : 'Stop'
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: eventName, additionalContext: note },
    }),
  )
}

// No process.exit(): an explicit exit can truncate stdout before the pipe drains, and a
// swallowed rejection already leaves the default exit code of 0.
main().catch(() => {})
