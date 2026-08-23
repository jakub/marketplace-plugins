#!/usr/bin/env node
// gripe: Stop checkpoint.
//
// Fires at the end of a main-agent turn. Its job is the friction that never raises an
// error: a command that exits 0 while doing the wrong thing, an ambiguous instruction the
// agent guessed at, a dead end where every individual call succeeded. PostToolUseFailure
// already owns error-shaped friction, so this hook must not duplicate it.
//
// The note it emits always cites concrete events read out of the transcript. It never asks
// the agent to search its memory for annoyance, and it never requires a reply, because a
// question that expects an answer will get one whether or not anything went wrong.
//
// Scanning is incremental. Transcripts only grow, and a quiet session would otherwise
// re-read and re-parse the whole file at every turn end, so per-session state carries a
// byte offset and the running counters and each run consumes only what was appended.
//
// Contract: read hook JSON on stdin, optionally write hookSpecificOutput JSON, always
// exit 0. Stop's additionalContext is non-error feedback and the conversation continues,
// so the agent can act on it without the turn being marked as failed.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

// A session with fewer tool calls than this had no room to develop friction worth filing.
const MIN_TOOL_CALLS = 15
// Same tool aimed at the same target this many times is someone fighting something.
const CHURN_THRESHOLD = 3
// Two identical failures is a pattern. One is ordinary work.
const REPEAT_THRESHOLD = 2
// Bound on the tool_use_id to tool-name map. A failing result nearly always follows its
// call immediately, so this only has to survive a chunk boundary, not a whole session.
const MAX_TOOL_NAMES = 4000

const stateDir = () =>
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'gripe')

const statePath = (sessionId) => join(stateDir(), 'scan', `${sessionId}.json`)

const freshState = () => ({
  offset: 0, // bytes of the transcript already consumed
  asked: false,
  toolCalls: 0,
  toolNames: {}, // tool_use_id -> tool name, needed across chunk boundaries
  failures: {}, // fingerprint -> { count, tool, sample }
  churn: {}, // "tool target" -> { count, tool, target }
})

function loadState(sessionId) {
  try {
    return { ...freshState(), ...JSON.parse(readFileSync(statePath(sessionId), 'utf8')) }
  } catch {
    return freshState() // missing or corrupt state just means starting over
  }
}

function saveState(sessionId, state) {
  try {
    mkdirSync(join(stateDir(), 'scan'), { recursive: true })
    writeFileSync(statePath(sessionId), JSON.stringify(state))
  } catch {
    // Losing state costs a rescan next turn, which is slow rather than wrong.
  }
}

/** Collapse an error string to something that matches again next time it happens. */
function fingerprint(toolName, text) {
  const norm = String(text)
    .toLowerCase()
    .replace(/\/[^\s'"]+/g, '/P') // paths differ per run, the shape does not
    .replace(/\b[0-9a-f]{7,}\b/g, 'H') // shas, ids
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return `${toolName}::${norm}`
}

/** What a tool call was aimed at, for spotting repetition without an error. */
function target(toolName, input) {
  if (!input || typeof input !== 'object') return null
  if (input.file_path) return String(input.file_path)
  if (input.command) {
    // Leading bare words only, stopping at the first argument. `gh run watch 123` and
    // `gh run watch --exit-status` are the same fight; `gh run list` is a different one,
    // so a flat two-token slice would wrongly merge them.
    const words = []
    for (const tok of String(input.command).trim().split(/\s+/)) {
      if (words.length === 3) break
      if (!/^[A-Za-z][\w.-]*$/.test(tok)) break
      words.push(tok)
    }
    return words.join(' ') || null
  }
  if (input.pattern) return String(input.pattern)
  return null
}

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
      const reset = freshState()
      reset.asked = state.asked
      state = reset
    }
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
          state.toolCalls++
          state.toolNames[block.id] = block.name
          const t = target(block.name, block.input)
          if (t) {
            const key = `${block.name} ${t}`
            const seen = state.churn[key] || { count: 0, tool: block.name, target: t }
            seen.count++
            state.churn[key] = seen
          }
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

    // Keep the id map bounded. Oldest keys go first; insertion order is preserved.
    const ids = Object.keys(state.toolNames)
    if (ids.length > MAX_TOOL_NAMES) {
      for (const id of ids.slice(0, ids.length - MAX_TOOL_NAMES)) delete state.toolNames[id]
    }
    return state
  } catch {
    return state
  } finally {
    await fh.close().catch(() => {})
  }
}

/** Build the note, or return null when there is nothing concrete to point at. */
function buildNote(state) {
  const repeats = Object.values(state.failures).filter((f) => f.count >= REPEAT_THRESHOLD)
  const churned = Object.values(state.churn).filter((c) => c.count >= CHURN_THRESHOLD)
  const totalFailures = Object.values(state.failures).reduce((n, f) => n + f.count, 0)

  // No concrete evidence means no honest question to ask. Stay quiet.
  if (!repeats.length && !churned.length && totalFailures < 2) return null
  if (state.toolCalls < MIN_TOOL_CALLS) return null

  const cited = []
  for (const f of repeats.slice(0, 2)) {
    cited.push(`${f.tool} failed ${f.count} times the same way (${f.sample.replace(/\s+/g, ' ').trim()})`)
  }
  for (const c of churned.slice(0, 2)) {
    cited.push(`${c.tool} was aimed at "${c.target}" ${c.count} times`)
  }
  if (!cited.length && totalFailures >= 2) {
    cited.push(`${totalFailures} tool calls failed`)
  }

  return [
    `gripe: this run, ${cited.join('; ')}.`,
    `If any of that was avoidable friction in the tooling or the workflow rather than ordinary`,
    `work, file the specific problem:`,
    ``,
    `  gripe add --via checkpoint "<what you expected, what happened instead, what it cost>"`,
    ``,
    `If it was just the work, carry on. No reply is expected and saying nothing costs nothing.`,
  ].join('\n')
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

  const sessionId = input.session_id
  const transcript = input.transcript_path
  if (!sessionId || !transcript) return

  const state = loadState(sessionId)
  // One checkpoint per session. Repeated asking is what teaches an agent to answer "none",
  // and once asked there is nothing left to scan for.
  if (state.asked) return

  // scanNew returns the state to use: on a truncated transcript it hands back a fresh
  // one rather than the object passed in, so the return value is not optional.
  const scanned = await scanNew(transcript, state)
  const note = buildNote(scanned)
  if (note) scanned.asked = true

  // Always persist, note or not. Recording that we looked is the whole point of the
  // offset: a quiet session must not re-parse the transcript at every turn end.
  saveState(sessionId, scanned)

  if (!note) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: note },
    }),
  )
}

main()
  .catch(() => {}) // a broken checkpoint must never fail the run
  .finally(() => process.exit(0))
