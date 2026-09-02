// gripe: the storage module. The one write path for the CLI and every hook, imported
// directly so the observed lane never transits a shell.
//
// node:sqlite exists from 22.5 but throws on import without a flag until 23.4, so the
// floor is 24 and enforced here: on an older node this module fails to import, `gripe add`
// catches that and exits 0 with one stderr line per invariant 1, and every other entry
// point reports it and exits 1.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const NODE_MAJOR = Number(process.versions.node.split('.')[0])
if (NODE_MAJOR < 24) {
  throw new Error(`gripe needs node >= 24 for node:sqlite, found ${process.versions.node}`)
}

// The schema this code writes. A database reporting a higher user_version was created by
// newer code; refuse to touch it, because refusing beats corrupting.
export const SCHEMA_VERSION = 1

// Bodies are evidence, not archives. The cap keeps a runaway paste from bloating the
// monthly dump; the marker makes the truncation visible to the reader.
export const BODY_CAP = 4000

export const stateDir = () =>
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'gripe')

export const dbPath = () => join(stateDir(), 'gripe.db')

export class SchemaTooNew extends Error {}

const DDL = `
CREATE TABLE IF NOT EXISTS gripes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  body        TEXT NOT NULL,
  elicitation TEXT NOT NULL DEFAULT 'spontaneous',
  session_id  TEXT NOT NULL,
  prompt_id   TEXT,
  agent_id    TEXT,
  agent_type  TEXT,
  repo        TEXT,
  cwd         TEXT,
  git_sha     TEXT,
  branch      TEXT,
  trigger     TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`

/**
 * Open the database, creating and migrating as needed. WAL for concurrent readers, and a
 * generous busy timeout because a parallel fan-out serialises on the write lock: measured
 * without it, nineteen of twenty concurrent writers vanished silently.
 */
export function openStore() {
  mkdirSync(stateDir(), { recursive: true })
  const db = new DatabaseSync(dbPath(), { timeout: 5000 })
  db.exec('PRAGMA journal_mode = WAL')
  migrate(db)
  return db
}

function userVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version)
}

function migrate(db) {
  if (userVersion(db) === SCHEMA_VERSION) return
  // Two processes can race to create a fresh database, so the version is re-checked
  // inside the write lock; the loser of the race sees the winner's work and moves on.
  db.exec('BEGIN IMMEDIATE')
  try {
    const v = userVersion(db)
    if (v > SCHEMA_VERSION) throw new SchemaTooNew(`database is schema v${v}, this code writes v${SCHEMA_VERSION}`)
    if (v < 1) db.exec(DDL)
    // Future migrations stack here as `if (v < 2) ...`, additive only.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
}

const isBusy = (e) => /busy|locked/i.test(String(e?.message))

/** Insert one complaint. One retry on a busy failure, per the measured design. */
export function addGripe(db, row) {
  const body = row.body.length > BODY_CAP ? row.body.slice(0, BODY_CAP) + ' [truncated by gripe]' : row.body
  const stmt = db.prepare(`
    INSERT INTO gripes (body, elicitation, session_id, prompt_id, agent_id, agent_type,
                        repo, cwd, git_sha, branch, trigger)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const args = [
    body, row.elicitation ?? 'spontaneous', row.session_id ?? 'unknown',
    row.prompt_id ?? null, row.agent_id ?? null, row.agent_type ?? null,
    row.repo ?? null, row.cwd ?? null, row.git_sha ?? null, row.branch ?? null,
    row.trigger ?? null,
  ]
  try {
    return stmt.run(...args)
  } catch (e) {
    if (!isBusy(e)) throw e
    return stmt.run(...args)
  }
}

/** Record that a session happened, complaints or not: the denominator for the reader. */
export function markSession(db, sessionId) {
  if (!sessionId) return
  const stmt = db.prepare('INSERT OR IGNORE INTO sessions (session_id) VALUES (?)')
  try {
    stmt.run(sessionId)
  } catch (e) {
    if (!isBusy(e)) throw e
    stmt.run(sessionId)
  }
}

const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
const setMeta = (db, key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))

/**
 * Rows for the reader. A plain dump floors at the seen cursor and records the highest id
 * it printed, which is exactly what a later `seen` advances to; a filtered dump (`since`
 * or `repo`) ignores the cursor and records nothing, so looking backwards or sideways
 * never disturbs your place.
 */
export function dump(db, { since = null, repo = null } = {}) {
  const filtered = Boolean(since || repo)
  const where = []
  const args = []
  if (filtered) {
    if (since) { where.push(`date(created_at, 'localtime') >= date(?)`); args.push(since) }
    if (repo) { where.push('repo = ?'); args.push(repo) }
  } else {
    where.push('id > ?')
    args.push(Number(getMeta(db, 'seen_id') ?? 0))
  }
  const rows = db.prepare(
    `SELECT * FROM gripes WHERE ${where.join(' AND ')} ORDER BY id`).all(...args)
  if (!filtered && rows.length) setMeta(db, 'dump_high_id', rows[rows.length - 1].id)
  return rows
}

/** Advance the cursor to the last unfiltered dump. Records exposure, not judgment. */
export function seen(db) {
  const high = getMeta(db, 'dump_high_id')
  if (high === null) return null
  setMeta(db, 'seen_id', high)
  return Number(high)
}

export function search(db, text) {
  return db.prepare(
    `SELECT * FROM gripes WHERE body LIKE ? ESCAPE '\\' ORDER BY id`,
  ).all(`%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`)
}

/**
 * Health report. Invariant 1 makes every write failure silent, so this is the only way
 * to tell "no friction" from "every write has failed for a month".
 */
export function doctor(db) {
  const report = {
    db: dbPath(),
    schema_version: userVersion(db),
    journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    write_lock: false,
    rows: db.prepare('SELECT COUNT(*) AS n FROM gripes').get().n,
    sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    unseen: db.prepare('SELECT COUNT(*) AS n FROM gripes WHERE id > ?')
      .get(Number(getMeta(db, 'seen_id') ?? 0)).n,
    newest: db.prepare('SELECT MAX(created_at) AS t FROM gripes').get().t,
  }
  db.exec('BEGIN IMMEDIATE')
  db.exec('ROLLBACK')
  report.write_lock = true
  report.healthy = report.journal_mode === 'wal' && report.schema_version === SCHEMA_VERSION && report.write_lock
  return report
}
