// T3's own record of a seat's task, read from T3's store. seat.mjs close reads it here, so a close
// needs the seat id alone: no model copies T3's text back out, and a thread that did not start the
// task can close it. This is flow's only node:sqlite user. It says what T3 recorded and never
// judges the hook evidence, which stays seat.mjs's.
//
// The store is <home>/userdata/statev2.sqlite, where home is T3CODE_HOME when that is a non-empty
// absolute path and ~/.t3 when it is unset or empty. A relative T3CODE_HOME, or no regular file at
// the path, is T3_STORE (missing). The file is checked before the open, so close never creates the
// directory or the database. The open is read-only with a 2 s busy timeout, every query runs inside
// one BEGIN ... COMMIT so all of them see one snapshot, and the connection closes in a finally.
// Nothing is written, though a read-only open of a WAL database can create its -wal and -shm files.
//
// What is read (T3 0.1.6, migration 76), every column checked with pragma table_info inside the
// transaction before any query; a missing table or column is T3_STORE (schema), naming it:
//   orchestration_v2_projection_subagents  subagent_id, thread_id, child_thread_id, status
//   orchestration_v2_projection_runs       run_id, thread_id, ordinal, status, payload_json (startedAt)
//   orchestration_v2_projection_messages   message_id, run_id, role, created_at, updated_at,
//                                          payload_json (text)
//   effect_sql_migrations                  max(migration_id), recorded for forensics, never pinned
// payload_json is parsed here, never with json_extract, because a bad document would throw a SQLite
// error that reads as something else.
//
// The task. T3's id for it is node:delegated-task:command%3Amcp%3A<uuid>%3Adelegate-task%3Aflow-seat-<id>,
// the uuid being the parent's MCP session's, so the row is found by that grammar, never built. SQL
// narrows the candidates to the command%3Amcp%3A range of the primary key ending in the exact
// suffix, and the grammar decides in JS. LIKE is no identity test here: it reads the % of %3A as a
// wildcard and ignores case, and thread-send and provider-continuation rows carry flow-seat-<id>
// too. No row fits: TASK_NOT_FOUND. The checks run in this order, each over every row that fits:
//   - its status is one T3 writes (idle pending running waiting completed failed cancelled
//     interrupted) and one of the last four, or it is TASK_NOT_TERMINAL; this comes before the
//     child thread, which a task that has not started has none of;
//   - its child_thread_id is thread:delegated-task: and the id's tail after node:delegated-task:;
//   - every run of that thread has the id run:thread:<the thread, URL-encoded>:ordinal:<n>, n its
//     ordinal column, and a status T3 writes (preparing queued starting running waiting completed
//     interrupted failed cancelled rolled_back), and none is one of the first five;
//   - no subagents row whose thread_id is the child thread is idle, pending, running or waiting,
//     which stands in for T3's waiting_for_children.
// Anything T3 doesn't write is T3_STORE (value), as is a payload_json that is no JSON object. Two
// rows that fit, both finished, are ambiguous: flow admits one call per seat, so the state never
// heals, and a refusal would keep a writer's lease forever.
//
// The runs. A run counts unless it has neither payload.startedAt nor any message row, so monitor,
// rolled_back and continuation runs count. The child run is the lowest ordinal that counts and the
// latest run the highest. The latest text is payload.text of the latest run's newest assistant
// message, by created_at, then updated_at, then message_id, all descending, thinking rows included,
// when the latest run is the child run or completed, and null otherwise, so a failed follow-up has
// none. Each of those messages' created_at and updated_at must be a 24-character ISO time, because
// lexical order breaks on mixed precision. The rule over-includes on purpose: a wrong guess can only
// make close read stale-turn, never certify a run the hooks didn't see. payload.result and
// turn_items are not read, because neither follows the latest run.
//
// A refusal's message carries the SQLite error code, never SQLite's text or a path. SQLITE_BUSY and
// SQLITE_LOCKED after the timeout are T3_STORE_BUSY, which can surface at the first SELECT as much
// as at BEGIN.
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { textDigest } from './seat-store.mjs'

const BUSY_MS = 2_000
const SUBAGENTS = 'orchestration_v2_projection_subagents'
const RUNS = 'orchestration_v2_projection_runs'
const MESSAGES = 'orchestration_v2_projection_messages'
const MIGRATIONS = 'effect_sql_migrations'
const COLUMNS = {
  [SUBAGENTS]: ['subagent_id', 'thread_id', 'child_thread_id', 'status'],
  [RUNS]: ['run_id', 'thread_id', 'ordinal', 'status', 'payload_json'],
  [MESSAGES]: ['message_id', 'run_id', 'role', 'created_at', 'updated_at', 'payload_json'],
  [MIGRATIONS]: ['migration_id'],
}
const TASK_PREFIX = 'node:delegated-task:'
const CHILD_PREFIX = 'thread:delegated-task:'
// The primary-key range every delegate_task task id falls in: its own prefix, then one past it.
const TASK_RANGE = [`${TASK_PREFIX}command%3Amcp%3A`, `${TASK_PREFIX}command%3Amcp%3B`]
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SEAT_ID = /^[0-9a-f]{32}$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const RUN_PREFIX = 'run:thread:'
const RUN_ORDINAL = ':ordinal:'
// T3 0.1.6's statuses, live and ended.
const TASK_LIVE = new Set(['idle', 'pending', 'running', 'waiting'])
const TASK_ENDED = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const RUN_LIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting'])
const RUN_ENDED = new Set(['completed', 'interrupted', 'failed', 'cancelled', 'rolled_back'])
// SQLite primary result codes. BUSY and LOCKED are a writer holding the store. PERM, IOERR,
// CANTOPEN, AUTH and NOTADB are a file SQLite can't read as a database, which is missing; any
// other is value.
const BUSY_CODES = new Set([5, 6])
const OPEN_CODES = new Set([3, 10, 14, 23, 26])
const CLOSER_BYTES = 256

class Refusal extends Error {
  constructor(kind, message, details) { super(message); this.kind = kind; this.details = details }
}
const refuse = (kind, message, details) => { throw new Refusal(kind, message, details) }
const FALL_BACK = 'Close wrote nothing; fall back on the seat\'s work and leave the seat open until flow reads this T3.'
const unreadable = (what) => refuse('T3_STORE', `T3's store holds ${what}, which this flow doesn't read. ${FALL_BACK}`, { cause: 'value' })
const unfinished = (what) => refuse('TASK_NOT_TERMINAL', `T3 hasn't finished the seat's task: ${what}. Close wrote nothing. Wait for the task to finish and close the seat again; T3 can report a task finished a moment before its rows settle, so retry this up to 3 times with backoff.`)
const known = (status, live, ended) => live.has(status) || ended.has(status)
const sqliteCode = (error) => (error?.code === 'ERR_SQLITE_ERROR' && Number.isInteger(error.errcode) ? error.errcode : null)

// A T3 run id's ordinal, when the id is run:thread:<encodeURIComponent(thread)>:ordinal:<n> with n
// a positive safe integer in canonical digits; null for anything else, another thread's included.
function runOrdinal(runId, thread) {
  if (typeof runId !== 'string' || typeof thread !== 'string' || thread === '' || !runId.startsWith(RUN_PREFIX)) return null
  let segment
  try { segment = encodeURIComponent(thread) } catch { return null }
  const at = runId.lastIndexOf(RUN_ORDINAL)
  if (at < RUN_PREFIX.length || runId.slice(RUN_PREFIX.length, at) !== segment) return null
  const digits = runId.slice(at + RUN_ORDINAL.length)
  const ordinal = /^[1-9][0-9]*$/.test(digits) ? Number(digits) : NaN
  return Number.isSafeInteger(ordinal) ? ordinal : null
}

function payloadOf(json, what) {
  let value
  try { value = typeof json === 'string' ? JSON.parse(json) : undefined } catch {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) unreadable(`${what} whose payload_json is no JSON object`)
  return value
}

function storeFile() {
  const home = process.env.T3CODE_HOME
  if (home !== undefined && home !== '' && !isAbsolute(home)) {
    refuse('T3_STORE', `T3CODE_HOME is not an absolute path, so close can't find T3's store. Set it to the home of the T3 server that ran the seat. ${FALL_BACK}`, { cause: 'missing' })
  }
  return join(home || join(homedir(), '.t3'), 'userdata', 'statev2.sqlite')
}

// The closer's own T3 thread, for the stamp's audit trail only, never matched against the owner.
function closerThreadId() {
  const id = process.env.T3CODE_THREAD_ID
  return typeof id === 'string' && id !== '' && Buffer.byteLength(id, 'utf8') <= CLOSER_BYTES && !/\p{Cc}/u.test(id) ? id : null
}

// payload.text of the run's newest assistant message, or null when it has none.
function newestText(db, runId) {
  const messages = db.prepare(`select message_id, created_at, updated_at, payload_json from ${MESSAGES} where run_id = ? and role = 'assistant' order by created_at desc, updated_at desc, message_id desc`).all(runId)
  const time = (value) => typeof value === 'string' && ISO_TIME.test(value)
  if (!messages.every((message) => time(message.created_at) && time(message.updated_at))) unreadable('a message time that is not a 24-character ISO time')
  if (messages.length === 0) return null
  const { text } = payloadOf(messages[0].payload_json, 'a message')
  return typeof text === 'string' ? text : null
}

// One finished task row's child thread, runs and nested tasks, as {task, run}, or a refusal.
function taskOf(db, row) {
  const thread = CHILD_PREFIX + row.subagent_id.slice(TASK_PREFIX.length)
  if (row.child_thread_id !== thread) unreadable('a finished task whose child thread is not the one T3 names after the task')
  const runs = db.prepare(`select run_id, thread_id, ordinal, status, payload_json from ${RUNS} where thread_id = ? order by ordinal`).all(thread)
  for (const run of runs) {
    const ordinal = runOrdinal(run.run_id, thread)
    if (ordinal === null || run.ordinal !== ordinal || run.thread_id !== thread) unreadable('a run whose id does not name its own thread and ordinal')
    if (!known(run.status, RUN_LIVE, RUN_ENDED)) unreadable('a run status T3 0.1.6 does not write')
    run.payload = payloadOf(run.payload_json, 'a run')
  }
  const live = runs.find((run) => RUN_LIVE.has(run.status))
  if (live) unfinished(`a run in its thread is ${live.status}`)
  const nested = db.prepare(`select status from ${SUBAGENTS} where thread_id = ?`).all(thread)
  if (!nested.every(({ status }) => known(status, TASK_LIVE, TASK_ENDED))) unreadable('a nested task status T3 0.1.6 does not write')
  const waiting = nested.find(({ status }) => TASK_LIVE.has(status))
  if (waiting) unfinished(`a task it started is ${waiting.status}`)
  const anyMessage = db.prepare(`select 1 as one from ${MESSAGES} where run_id = ? limit 1`)
  const ran = runs.filter((run) => (run.payload.startedAt !== undefined && run.payload.startedAt !== null) || anyMessage.get(run.run_id) !== undefined)
  const child = ran[0] ?? null
  const latest = ran.at(-1) ?? null
  const latestText = latest !== null && (latest === child || latest.status === 'completed') ? newestText(db, latest.run_id) : null
  return {
    task: {
      taskId: row.subagent_id, ownerThreadId: row.thread_id, childThreadId: thread, status: row.status, childRunId: child?.run_id ?? null,
      latestRunId: latest?.run_id ?? null, latestRunStatus: latest?.status ?? null, latestTextSha256: textDigest(latestText),
    },
    run: { childOrdinal: child?.ordinal ?? null, latestOrdinal: latest?.ordinal ?? null, latestRunId: latest?.run_id ?? null, latestText },
  }
}

function snapshot(db, id) {
  const missing = []
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const have = new Set(db.prepare(`pragma table_info(${table})`).all().map((column) => column.name))
    if (have.size === 0) missing.push(table)
    else missing.push(...columns.filter((column) => !have.has(column)).map((column) => `${table}.${column}`))
  }
  if (missing.length > 0) refuse('T3_STORE', `T3's store lacks ${missing.join(', ')}, so T3 changed its store and this flow can't read it. ${FALL_BACK}`, { cause: 'schema', missing })
  const suffix = `%3Adelegate-task%3Aflow-seat-${id}`
  const grammar = new RegExp(`^${TASK_RANGE[0]}${UUID}${suffix}$`)
  const rows = db.prepare(`select subagent_id, thread_id, child_thread_id, status from ${SUBAGENTS} where subagent_id >= ? and subagent_id < ? and substr(subagent_id, ?) = ? order by subagent_id`)
    .all(...TASK_RANGE, -suffix.length, suffix).filter((row) => typeof row.subagent_id === 'string' && grammar.test(row.subagent_id))
  if (rows.length === 0) {
    refuse('TASK_NOT_FOUND', 'T3\'s store holds no delegate_task task for this seat, so close wrote nothing. If the seat\'s delegate_task call errored or returned no taskId, close it with --abandon; otherwise check that T3CODE_HOME names the home of the T3 server that ran the seat.')
  }
  if (!rows.every((row) => known(row.status, TASK_LIVE, TASK_ENDED))) unreadable('a task status T3 0.1.6 does not write')
  const live = rows.find((row) => TASK_LIVE.has(row.status))
  if (live) unfinished(`its task is ${live.status}`)
  const tasks = rows.map((row) => taskOf(db, row))
  if (tasks.length > 1) return { ok: true, ambiguous: true, taskIds: tasks.map(({ task }) => task.taskId) }
  const migration = db.prepare(`select max(migration_id) as id from ${MIGRATIONS}`).get()?.id
  const [{ task, run }] = tasks
  return { ok: true, task: { ...task, closerThreadId: closerThreadId(), t3Migration: Number.isSafeInteger(migration) ? migration : null }, run }
}

/**
 * The seat's task as T3's store holds it, in one of three shapes:
 *   {ok: true, task, run}: task is {taskId, ownerThreadId, childThreadId, status, childRunId,
 *     latestRunId, latestRunStatus, latestTextSha256, closerThreadId, t3Migration}, and run is
 *     {childOrdinal, latestOrdinal, latestRunId, latestText} for seat.mjs's freshness check;
 *   {ok: true, ambiguous: true, taskIds}: more than one finished task fits the seat;
 *   {ok: false, kind, message, details}: kind TASK_NOT_FOUND, TASK_NOT_TERMINAL, T3_STORE_BUSY, or
 *     T3_STORE with details.cause missing, schema or value, and details.code for a SQLite error.
 * Every SQLite error is answered here, so none reaches a caller's catch-all with its raw text.
 */
export function readSeatTask(id) {
  if (typeof id !== 'string' || !SEAT_ID.test(id)) throw new TypeError('readSeatTask: the id is not 32 lowercase hex characters')
  let db = null
  try {
    const file = storeFile()
    let found = false
    try { found = statSync(file).isFile() } catch {}
    if (!found) refuse('T3_STORE', `T3's store is not at $T3CODE_HOME/userdata/statev2.sqlite, or ~/.t3/userdata/statev2.sqlite with T3CODE_HOME unset, so close can't read the seat's task. ${FALL_BACK}`, { cause: 'missing' })
    try { db = new DatabaseSync(file, { readOnly: true, timeout: BUSY_MS }) } catch (error) {
      const code = sqliteCode(error)
      refuse('T3_STORE', `T3's store could not be opened${code === null ? '' : ` (SQLite error ${code})`}. ${FALL_BACK}`, { cause: 'missing', ...(code === null ? {} : { code }) })
    }
    db.exec('BEGIN')
    const answer = snapshot(db, id)
    db.exec('COMMIT')
    return answer
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, kind: error.kind, message: error.message, details: error.details }
    const code = sqliteCode(error)
    if (code === null) throw error
    if (BUSY_CODES.has(code & 0xff)) {
      return { ok: false, kind: 'T3_STORE_BUSY', message: `T3's store stayed locked for over ${BUSY_MS / 1000} s (SQLite error ${code}), so close wrote nothing. Close the seat again.`, details: { code } }
    }
    return { ok: false, kind: 'T3_STORE', message: `T3's store could not be read (SQLite error ${code}). ${FALL_BACK}`, details: { cause: OPEN_CODES.has(code & 0xff) ? 'missing' : 'value', code } }
  } finally {
    if (db !== null) {
      try { if (db.isTransaction) db.exec('ROLLBACK') } catch {}
      try { db.close() } catch {}
    }
  }
}
