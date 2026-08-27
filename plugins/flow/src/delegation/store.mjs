import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ACTIVE_STATES, ALL_STATES, DelegationError, TERMINAL_STATES } from './contracts.mjs'

const now = () => Date.now()
const json = (value) => value == null ? null : JSON.stringify(value)
const parse = (value) => value == null ? null : JSON.parse(value)

export function processStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
      return fields[19] ? `linux:${fields[19]}` : null
    } catch { return null }
  }
  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    }).trim()
    return started ? `${process.platform}:${started}` : null
  } catch { return null }
}

export function defaultStateDir() {
  if (process.env.FLOW_DELEGATION_STATE_DIR) return process.env.FLOW_DELEGATION_STATE_DIR
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'flow', 'delegation')
}

function decode(row) {
  if (!row) return null
  return {
    id: row.id,
    traceId: row.trace_id,
    parentJobId: row.parent_job_id,
    host: row.host,
    target: row.target,
    depth: row.depth,
    mode: row.mode,
    access: row.access,
    delivery: row.delivery,
    cwd: row.cwd,
    workspaceKey: row.workspace_key,
    model: row.model,
    effort: row.effort,
    serviceTier: row.service_tier,
    profile: row.profile,
    timeBudgetSeconds: row.time_budget_seconds,
    prompt: row.prompt,
    outputSchema: parse(row.output_schema_json),
    baseSha: row.base_sha,
    headSha: row.head_sha,
    nativeThreadId: row.native_thread_id,
    nativeTurnId: row.native_turn_id,
    turnAcceptedAt: row.turn_accepted_at,
    status: row.status,
    workerPid: row.worker_pid,
    output: row.output,
    structured: parse(row.structured_json),
    usage: parse(row.usage_json),
    error: parse(row.error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    heartbeatAt: row.heartbeat_at,
  }
}

export class JobStore {
  constructor(stateDir = defaultStateDir()) {
    this.stateDir = stateDir
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    try { chmodSync(stateDir, 0o700) } catch {}
    this.path = join(stateDir, 'jobs.sqlite3')
    this.db = new DatabaseSync(this.path)
    try { chmodSync(this.path, 0o600) } catch {}
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.migrate()
  }

  migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version
    if (version > 1) throw new DelegationError('DATABASE_NEWER', 'The delegation database was created by a newer Flow version.')
    if (version === 1) return
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        parent_job_id TEXT REFERENCES jobs(id),
        host TEXT NOT NULL,
        target TEXT NOT NULL,
        depth INTEGER NOT NULL,
        mode TEXT NOT NULL,
        access TEXT NOT NULL,
        delivery TEXT NOT NULL,
        cwd TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        service_tier TEXT NOT NULL,
        profile TEXT NOT NULL,
        time_budget_seconds INTEGER NOT NULL,
        prompt TEXT,
        output_schema_json TEXT,
        base_sha TEXT,
        head_sha TEXT,
        native_thread_id TEXT,
        native_turn_id TEXT,
        turn_accepted_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('queued','starting','running','reconciling','succeeded','failed','cancelled','unknown','awaiting_approval')),
        worker_pid INTEGER,
        output TEXT,
        structured_json TEXT,
        usage_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
      CREATE TABLE events (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (job_id, seq)
      );
      CREATE TABLE controls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        handled_at INTEGER
      );
      CREATE TABLE leases (
        workspace_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
        heartbeat_at INTEGER NOT NULL
      );
      CREATE INDEX jobs_status_idx ON jobs(status, heartbeat_at);
      CREATE INDEX controls_pending_idx ON controls(job_id, handled_at, id);
      PRAGMA user_version=1;
      COMMIT;
    `)
  }

  close() { this.db.close() }

  createJob(request) {
    const id = randomUUID()
    const at = now()
    this.db.prepare(`INSERT INTO jobs (
      id, trace_id, parent_job_id, host, target, depth, mode, access, delivery,
      cwd, workspace_key, model, effort, service_tier, profile, time_budget_seconds,
      prompt, output_schema_json, base_sha, head_sha, native_thread_id,
      status, created_at, updated_at, heartbeat_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
      .run(id, request.traceId || randomUUID(), request.parentJobId || null,
        request.host, request.target, request.depth, request.mode, request.access,
        request.delivery, request.cwd, request.workspaceKey, request.model, request.effort,
        request.serviceTier, request.profile, request.timeBudgetSeconds, request.prompt,
        json(request.outputSchema), request.baseSha || null, request.headSha || null,
        request.nativeThreadId || null, at, at, at)
    this.appendEvent(id, 'job.queued', { status: 'queued' })
    return this.getJob(id)
  }

  getJob(id) { return decode(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)) }

  requireJob(id) {
    const job = this.getJob(id)
    if (!job) throw new DelegationError('JOB_NOT_FOUND', 'No delegation job has that ID.')
    return job
  }

  appendEvent(jobId, type, payload = {}) {
    this.db.prepare(`INSERT INTO events (job_id, seq, type, payload_json, created_at)
      VALUES (?, COALESCE((SELECT MAX(seq) + 1 FROM events WHERE job_id = ?), 1), ?, ?, ?)`)
      .run(jobId, jobId, type, json(payload), now())
    return this.db.prepare('SELECT MAX(seq) AS seq FROM events WHERE job_id = ?').get(jobId).seq
  }

  events(jobId, { after = 0, limit = 200 } = {}) {
    this.requireJob(jobId)
    return this.db.prepare(`SELECT seq, type, payload_json, created_at FROM events
      WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(jobId, after, Math.max(1, Math.min(limit, 1000)))
      .map((row) => ({ seq: row.seq, type: row.type, payload: parse(row.payload_json), createdAt: row.created_at }))
  }

  claim(id, pid, startToken = null) {
    if (typeof startToken !== 'string' || !startToken) {
      throw new DelegationError('WORKER_IDENTITY', 'Flow could not record a stable worker process identity.')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const job = decode(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id))
      if (!job) throw new DelegationError('JOB_NOT_FOUND', 'No delegation job has that ID.')
      if (job.status !== 'queued') throw new DelegationError('JOB_STATE', `Job ${id} is ${job.status}, not queued.`)
      const at = now()
      if (job.access === 'workspace-write') {
        const held = this.db.prepare('SELECT job_id FROM leases WHERE workspace_key = ?').get(job.workspaceKey)
        if (held) throw new DelegationError('WORKSPACE_BUSY', `Another write job owns this worktree: ${held.job_id}.`)
        this.db.prepare('INSERT INTO leases (workspace_key, job_id, heartbeat_at) VALUES (?, ?, ?)')
          .run(job.workspaceKey, id, at)
      }
      this.db.prepare(`UPDATE jobs SET status='starting', worker_pid=?, heartbeat_at=?, updated_at=? WHERE id=?`)
        .run(pid, at, at, id)
      this.appendEvent(id, 'job.starting', { pid, startToken })
      this.db.exec('COMMIT')
      return this.getJob(id)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  setRunning(id, { threadId, turnId = null, accepted = false } = {}) {
    const at = now()
    this.db.prepare(`UPDATE jobs SET status='running', native_thread_id=COALESCE(?, native_thread_id),
      native_turn_id=COALESCE(?, native_turn_id), turn_accepted_at=CASE WHEN ? THEN COALESCE(turn_accepted_at, ?) ELSE turn_accepted_at END,
      prompt=CASE WHEN ? THEN NULL ELSE prompt END, updated_at=?, heartbeat_at=? WHERE id=?`)
      .run(threadId || null, turnId || null, accepted ? 1 : 0, at, accepted ? 1 : 0, at, at, id)
  }

  setNativeTurn(id, turnId, { accepted = false } = {}) {
    const at = now()
    this.db.prepare(`UPDATE jobs SET native_turn_id=?,
      turn_accepted_at=CASE WHEN ? THEN COALESCE(turn_accepted_at, ?) ELSE turn_accepted_at END,
      prompt=CASE WHEN ? THEN NULL ELSE prompt END, updated_at=?, heartbeat_at=?
      WHERE id=? AND status IN ('starting','running')`)
      .run(turnId, accepted ? 1 : 0, at, accepted ? 1 : 0, at, at, id)
  }

  heartbeat(id) {
    const at = now()
    this.db.prepare('UPDATE jobs SET heartbeat_at=?, updated_at=? WHERE id=? AND status IN (\'starting\',\'running\',\'reconciling\',\'awaiting_approval\')')
      .run(at, at, id)
    this.db.prepare('UPDATE leases SET heartbeat_at=? WHERE job_id=?').run(at, id)
  }

  finish(id, status, { output = null, structured = null, usage = null, error = null } = {}) {
    if (!TERMINAL_STATES.includes(status)) {
      throw new DelegationError('JOB_STATE', `Cannot finish a job as ${status}.`)
    }
    const at = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = decode(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id))
      if (!current) throw new DelegationError('JOB_NOT_FOUND', 'No delegation job has that ID.')
      if (TERMINAL_STATES.includes(current.status)) {
        this.db.exec('COMMIT')
        return current
      }
      this.db.prepare(`UPDATE jobs SET status=?, output=?, structured_json=?, usage_json=?, error_json=?,
        prompt=NULL, updated_at=?, heartbeat_at=? WHERE id=?`)
        .run(status, output, json(structured), json(usage), json(error), at, at, id)
      this.db.prepare(`UPDATE controls SET payload_json='{}' WHERE job_id=?`).run(id)
      this.db.prepare('DELETE FROM leases WHERE job_id=?').run(id)
      this.db.exec('COMMIT')
    } catch (cause) {
      this.db.exec('ROLLBACK')
      throw cause
    }
    this.appendEvent(id, `job.${status}`, error ? { error } : { status })
    return this.getJob(id)
  }

  markReconciling(id, expectedHeartbeat) {
    const at = now()
    const result = this.db.prepare(`UPDATE jobs SET status='reconciling', updated_at=?, heartbeat_at=?
      WHERE id=? AND heartbeat_at=? AND status IN ('queued','starting','running','reconciling')`)
      .run(at, at, id, expectedHeartbeat)
    if (result.changes) this.appendEvent(id, 'job.reconciling', {})
    return result.changes === 1
  }

  queueControl(jobId, type, payload = {}) {
    this.db.exec('BEGIN IMMEDIATE')
    let result
    try {
      const job = decode(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId))
      if (!job) throw new DelegationError('JOB_NOT_FOUND', 'No delegation job has that ID.')
      if (!ACTIVE_STATES.includes(job.status)) throw new DelegationError('JOB_STATE', `Job ${jobId} is already ${job.status}.`)
      result = this.db.prepare('INSERT INTO controls (job_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(jobId, type, json(payload), now())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.appendEvent(jobId, `control.${type}.queued`, {})
    return Number(result.lastInsertRowid)
  }

  requestCancel(jobId) {
    this.db.exec('BEGIN IMMEDIATE')
    let cancelled = false
    try {
      const job = decode(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId))
      if (!job) throw new DelegationError('JOB_NOT_FOUND', 'No delegation job has that ID.')
      if (TERMINAL_STATES.includes(job.status)) {
        this.db.exec('COMMIT')
        return job
      }
      if (job.status === 'queued') {
        const at = now()
        this.db.prepare(`UPDATE jobs SET status='cancelled', prompt=NULL, updated_at=?, heartbeat_at=? WHERE id=?`)
          .run(at, at, jobId)
        cancelled = true
      } else {
        this.db.prepare(`INSERT INTO controls (job_id, type, payload_json, created_at)
          VALUES (?, 'cancel', '{}', ?)`).run(jobId, now())
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    if (cancelled) this.appendEvent(jobId, 'job.cancelled', { status: 'cancelled' })
    else this.appendEvent(jobId, 'control.cancel.queued', {})
    return this.getJob(jobId)
  }

  pendingControls(jobId) {
    return this.db.prepare(`SELECT id, type, payload_json, created_at FROM controls
      WHERE job_id=? AND handled_at IS NULL ORDER BY id`).all(jobId)
      .map((row) => ({ id: row.id, type: row.type, payload: parse(row.payload_json), createdAt: row.created_at }))
  }

  handleControl(jobId, id, outcome = {}) {
    this.db.prepare(`UPDATE controls SET handled_at=?, payload_json='{}' WHERE id=? AND job_id=?`).run(now(), id, jobId)
    this.appendEvent(jobId, 'control.handled', { controlId: id, ...outcome })
  }

  workerStartToken(jobId) {
    const row = this.db.prepare(`SELECT payload_json FROM events
      WHERE job_id=? AND type='job.starting' ORDER BY seq DESC LIMIT 1`).get(jobId)
    return row ? parse(row.payload_json)?.startToken || null : null
  }

  staleActive(before) {
    const placeholders = ACTIVE_STATES.map(() => '?').join(',')
    return this.db.prepare(`SELECT * FROM jobs WHERE status IN (${placeholders}) AND heartbeat_at < ?`)
      .all(...ACTIVE_STATES, before).map(decode)
  }
}
