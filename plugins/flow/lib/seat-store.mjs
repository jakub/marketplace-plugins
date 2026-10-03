// The seat store: the only reader and writer of T3 seat records. A seat record is the directory
// <stateDir()>/seats/<id>/ that the parent opens and the hooks stamp, and the session index under
// seats/by-session/ maps one host session to the record it bound. Policy decides what a record
// means; this module owns the layout, the bytes and the write discipline, so every hook, the seat
// executor and the smoke agree on them. It imports node built-ins and ./state-dir.mjs only,
// because a hook loads it on every call that reaches past its fast path.
//
// Layout: directories 0700, files 0600.
//   seats/<id>/record.json         the record, immutable once written; its digest is sha256(bytes)
//   seats/<id>/schema.json         the answer schema snapshot, pinned by record.schemaSha256
//   seats/<id>/<stamp>.json        admitted, bound, receipt, void, closed; each written once
//   seats/<id>/state.json          the Stop hook's turn state, replaced whole
//   seats/<id>/result-<n>.json     turn n's result, with result-<n>.sha256 written after it
//   seats/by-session/<sha256(host NUL sessionId)>   {id} or {id, void}
//
// Stamps are write-once because each one is a claim that a step happened exactly once: one
// admission per record, one binding session, one first seat call, one close. A stamp that could be
// rewritten would let a replayed tag or a second session take over a record that another session
// already holds, and would let close read a later writer's facts as the first one's. So a stamp is
// written to a temporary file and hard-linked into place: link(2) fails with EEXIST when the name
// exists, exactly as an O_EXCL open does, so of any number of racers exactly one wins. Unlike an
// O_EXCL open of the final name, the winner's file never exists empty or half written, so a crash
// mid-write cannot leave a stamp that blocks the step forever and reads as corrupt. The session
// index is created the same way. Every other file is replaced whole by temp file and rename.
//
// Session ids come from the hook's stdin and are checked against SESSION before use, and seat ids
// against ID, so neither reaches a path unchecked. The index file name is a hash of both anyway.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { RETENTION_MS, stateDir } from './state-dir.mjs'

const ID = /^[0-9a-f]{32}$/
const SESSION = /^[A-Za-z0-9._-]{1,128}$/
const HOSTS = new Set(['claude', 'codex'])
const STAMPS = new Set(['admitted', 'bound', 'receipt', 'void', 'closed'])
// The tag is all of line 1 and carries the id alone. A well-formed tag anywhere else in the prompt,
// line 1 included when it holds more than the tag, voids the seat rather than reading as no tag.
const TAG_LINE = /^<flow-seat id=([0-9a-f]{32})>$/
const TAG_ANYWHERE = /<flow-seat id=[0-9a-f]{32}>/

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seatsRoot = () => join(stateDir(), 'seats')
const indexRoot = () => join(seatsRoot(), 'by-session')
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const validId = (id) => typeof id === 'string' && ID.test(id)
const validTurn = (n) => Number.isSafeInteger(n) && n > 0

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
const tempBeside = (path) => join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}`)
function replaceFile(path, bytes) {
  const temp = tempBeside(path)
  try {
    writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } finally { rmSync(temp, { force: true }) }
}
// True when this call created path, false when it already existed. Any other failure throws.
function createFile(path, bytes) {
  const temp = tempBeside(path)
  try {
    writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' })
    linkSync(temp, path)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  } finally { rmSync(temp, { force: true }) }
}

/** A fresh seat id: 128 random bits as 32 lowercase hex characters. */
export const newId = () => randomBytes(16).toString('hex')

/** The seat tag for id, which the parent puts on line 1 of the task. */
export function seatTag(id) {
  if (!validId(id)) throw new Error('seatTag: the id is not 32 lowercase hex characters')
  return `<flow-seat id=${id}>`
}

/**
 * Read a prompt's seat tag with string tests alone. Null means the prompt is not a seat, which
 * includes a line 1 that only resembles a tag. {id} means line 1 is exactly a tag and no other
 * well-formed tag appears. {void} means a well-formed tag appears anywhere but as the whole of
 * line 1, so the session must not be treated as an ordinary one or bound as a seat.
 */
export function parseTag(prompt) {
  if (typeof prompt !== 'string') return null
  const cut = prompt.indexOf('\n')
  const first = cut < 0 ? prompt : prompt.slice(0, cut)
  const rest = cut < 0 ? '' : prompt.slice(cut + 1)
  const match = TAG_LINE.exec(first)
  if (TAG_ANYWHERE.test(match ? rest : prompt)) return { void: 'tag-not-on-line-1' }
  return match ? { id: match[1] } : null
}

/** The record directory for id, or null when id is not a seat id. */
export const seatDir = (id) => (validId(id) ? join(seatsRoot(), id) : null)

/** The index file for one host session, or null when the host or the session id fails validation. */
export const indexPath = (host, sessionId) =>
  HOSTS.has(host) && typeof sessionId === 'string' && SESSION.test(sessionId)
    ? join(indexRoot(), sha256(`${host}\0${sessionId}`))
    : null

/**
 * Write a new record and its schema snapshot. The record directory is created exclusively, so an
 * id is never written twice and a second call for it throws. The schema goes in first and
 * record.json last, so a reader that finds the record finds its schema. record.schemaSha256 is set
 * here from the bytes written, null when there is no schema. Returns the id (generated when the
 * record names none) and the digest of record.json's bytes, which the bound stamp pins.
 */
export function writeRecord(record, schema = null) {
  const id = record.id ?? newId()
  const dir = seatDir(id)
  if (!dir) throw new Error('writeRecord: the id is not 32 lowercase hex characters')
  mkdirSync(seatsRoot(), { recursive: true, mode: 0o700 })
  mkdirSync(dir, { mode: 0o700 })
  const schemaBytes = schema == null ? null : json(schema)
  if (schemaBytes) replaceFile(join(dir, 'schema.json'), schemaBytes)
  const bytes = json({ ...record, id, schemaSha256: schemaBytes ? sha256(schemaBytes) : null })
  replaceFile(join(dir, 'record.json'), bytes)
  return { id, digest: sha256(bytes) }
}

/**
 * The record, its digest and its schema, or null when the record is missing or corrupt: unparsable,
 * naming another id, or with a schema snapshot that is missing or does not match schemaSha256.
 */
export function readRecord(id) {
  const dir = seatDir(id)
  if (!dir) return null
  let bytes
  let record
  try {
    bytes = readFileSync(join(dir, 'record.json'))
    record = JSON.parse(bytes.toString('utf8'))
  } catch { return null }
  if (!record || record.v !== 1 || record.id !== id) return null
  let schema = null
  if (record.schemaSha256 != null) {
    try {
      const schemaBytes = readFileSync(join(dir, 'schema.json'))
      if (sha256(schemaBytes) !== record.schemaSha256) return null
      schema = JSON.parse(schemaBytes.toString('utf8'))
    } catch { return null }
  }
  return { record, digest: sha256(bytes), schema }
}

/**
 * Write stamp name once, as {at, ...obj}; a caller's own `at` wins. True when this call wrote it.
 * False when the stamp already exists, whoever wrote it, and when the record directory does not
 * exist or id is not a seat id. An unknown stamp name is a programming error and throws.
 */
export function stamp(id, name, obj = {}) {
  if (!STAMPS.has(name)) throw new Error(`stamp: unknown stamp ${name}`)
  const dir = seatDir(id)
  if (!dir) return false
  try { return createFile(join(dir, `${name}.json`), json({ at: new Date().toISOString(), ...obj })) } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/** Stamp name's content, or null when it is missing or unreadable. */
export function readStamp(id, name) {
  if (!STAMPS.has(name)) throw new Error(`stamp: unknown stamp ${name}`)
  const dir = seatDir(id)
  return dir ? readJson(join(dir, `${name}.json`)) : null
}

/** Create the session's index entry naming id. False when one already exists or the input fails validation. */
export function indexSession(host, sessionId, { id } = {}) {
  const path = indexPath(host, sessionId)
  if (!path || !validId(id)) return false
  mkdirSync(indexRoot(), { recursive: true, mode: 0o700 })
  return createFile(path, json({ id }))
}

/**
 * Mark the session void, replacing any entry it has. id is the seat it tried to bind, or null when
 * the prompt named none. A void session denies every tool call and its seat's verdict is unknown.
 * False when the input fails validation.
 */
export function voidSession(host, sessionId, id, reason) {
  const path = indexPath(host, sessionId)
  if (!path || !(id === null || validId(id))) return false
  mkdirSync(indexRoot(), { recursive: true, mode: 0o700 })
  replaceFile(path, json({ id, void: String(reason) }))
  return true
}

/**
 * The session's entry: null when the session has none, {id} when it is bound, {id, void} when it
 * is void. An entry that exists but cannot be read reads as void, never as no seat.
 */
export function readIndex(host, sessionId) {
  const path = indexPath(host, sessionId)
  if (!path) return null
  let text
  try { text = readFileSync(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    return { id: null, void: 'index-unreadable' }
  }
  let entry
  try { entry = JSON.parse(text) } catch { return { id: null, void: 'index-unreadable' } }
  if (entry?.void !== undefined) {
    return { id: validId(entry.id) ? entry.id : null, void: typeof entry.void === 'string' ? entry.void : 'index-unreadable' }
  }
  return validId(entry?.id) ? { id: entry.id } : { id: null, void: 'index-unreadable' }
}

/** The Stop hook's turn state, or null when none has been written or it is unreadable. */
export function readState(id) {
  const dir = seatDir(id)
  return dir ? readJson(join(dir, 'state.json')) : null
}

/** Replace the turn state whole. Throws when id is not a seat id or the record directory is gone. */
export function writeState(id, state) {
  const dir = seatDir(id)
  if (!dir) throw new Error('writeState: the id is not 32 lowercase hex characters')
  replaceFile(join(dir, 'state.json'), json(state))
}

/**
 * Write turn n's result and then its sha256, and return the sha256. The sha256 file is written
 * second, so a result without one is a write that did not finish. Throws on a bad id or turn.
 */
export function writeResult(id, n, body) {
  const dir = seatDir(id)
  if (!dir || !validTurn(n)) throw new Error('writeResult: bad seat id or turn')
  const bytes = json(body)
  const digest = sha256(bytes)
  replaceFile(join(dir, `result-${n}.json`), bytes)
  replaceFile(join(dir, `result-${n}.sha256`), `${digest}\n`)
  return digest
}

/**
 * Turn n's result: null when it was never written, else {body, sha256, intact}. sha256 is the hash
 * of the bytes on disk; intact is true only when it equals the recorded sha256 and the body parses.
 */
export function readResult(id, n) {
  const dir = seatDir(id)
  if (!dir || !validTurn(n)) return null
  let bytes
  try { bytes = readFileSync(join(dir, `result-${n}.json`)) } catch { return null }
  const digest = sha256(bytes)
  let body = null
  try { body = JSON.parse(bytes.toString('utf8')) } catch {}
  let recorded = null
  try { recorded = readFileSync(join(dir, `result-${n}.sha256`), 'utf8').trim() } catch {}
  return { body, sha256: digest, intact: body !== null && recorded === digest }
}

/**
 * Remove every record whose closed stamp is older than RETENTION_MS, and the index entries that
 * name it. A record without a closed stamp stays however old it is, admitted or not, until a human
 * or the parent reconciles it; so does one whose closed stamp has no readable time.
 */
export function pruneSeats(now = Date.now()) {
  const removed = []
  const retained = []
  let names
  try { names = readdirSync(seatsRoot()) } catch { return { removed, retained } }
  for (const name of names.filter((entry) => ID.test(entry))) {
    const at = Date.parse(readStamp(name, 'closed')?.at)
    if (Number.isFinite(at) && now - at > RETENTION_MS) {
      rmSync(join(seatsRoot(), name), { recursive: true, force: true })
      removed.push(name)
    } else retained.push(name)
  }
  if (removed.length > 0) {
    const gone = new Set(removed)
    let entries = []
    try { entries = readdirSync(indexRoot()) } catch {}
    for (const entry of entries.filter((file) => /^[0-9a-f]{64}$/.test(file))) {
      if (gone.has(readJson(join(indexRoot(), entry))?.id)) rmSync(join(indexRoot(), entry), { force: true })
    }
  }
  return { removed, retained }
}
