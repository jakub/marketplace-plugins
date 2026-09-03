import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ACTIVE_STATES, DelegationError, TERMINAL_STATES } from './contracts.mjs'

const SCHEMA_VERSION = 7
// Terminal jobs are operational history, not an archive. Fourteen days outlives any
// investigation of a run, including an `unknown` one.
const RETENTION_DAYS = 14
// Statuses that stop an older database from being reset. The four ACTIVE_STATES are the
// obvious ones. `quarantined` is a job Flow could not prove dead. `awaiting_approval` is
// terminal in this version, but a row in an older schema was written by code whose meaning of
// that word is gone, and the word says parked rather than finished, so it counts as live here.
// 'unknown' is terminal for a reader but not for the worktree: an older worker wrote it for an
// accepted write turn that lost its terminal proof, before it awaited the provider's stop, so the
// provider may still be writing under that lease.
const LIVE_ON_UPGRADE = [...ACTIVE_STATES, 'awaiting_approval', 'quarantined', 'unknown']

const now = () => Date.now()
const json = (value) => value == null ? null : JSON.stringify(value)
const parse = (value) => value == null ? null : JSON.parse(value)

// Field 22 of /proc/<pid>/stat is the process start time in clock ticks since boot. Paired
// with the pid it is a stable identity: a recycled pid gets a different token.
export function processStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    return fields[19] ? `linux:${fields[19]}` : null
  } catch { return null }
}

export function defaultStateDir() {
  if (process.env.FLOW_DELEGATION_STATE_DIR) return process.env.FLOW_DELEGATION_STATE_DIR
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'flow', 'delegation')
}

const SCHEMA = `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    parent_job_id TEXT REFERENCES jobs(id),
    host TEXT NOT NULL,
    target TEXT NOT NULL,
    depth INTEGER NOT NULL,
    mode TEXT NOT NULL,
    access TEXT NOT NULL,
    cwd TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    time_budget_seconds INTEGER NOT NULL,
    max_turns INTEGER,
    max_budget_usd REAL,
    prompt TEXT,
    output_schema_json TEXT,
    base_sha TEXT,
    head_sha TEXT,
    elicitation INTEGER NOT NULL DEFAULT 0,
    native_thread_id TEXT,
    native_turn_id TEXT,
    turn_accepted_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('queued','starting','running','reconciling','quarantined','succeeded','failed','cancelled','unknown','awaiting_approval')),
    worker_pid INTEGER,
    provider_pid INTEGER,
    provider_start_token TEXT,
    provider_process_group_id INTEGER,
    provider_scope TEXT,
    provider_processes_json TEXT,
    quarantine_resume_status TEXT,
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
  CREATE TABLE approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    decision TEXT CHECK (decision IN ('accept','decline')),
    decided_by TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE TABLE leases (
    workspace_key TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE
  );
  CREATE INDEX jobs_status_idx ON jobs(status, heartbeat_at);
  CREATE INDEX controls_pending_idx ON controls(job_id, handled_at, id);
`

// Failures that happen before a job row exists have nowhere else to land: publicError()
// hides the cause from the caller by design, so the truth goes here. Best effort, because a
// logging failure must never become the error the caller sees.
export function serviceLog(stateDir, message) {
  if (!stateDir) return
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const file = join(stateDir, 'service.log')
    // One rotated generation bounds the log at about a megabyte no matter how often a
    // caller manages to fail: nothing prunes this file otherwise.
    try { if (statSync(file).size > 512_000) renameSync(file, `${file}.1`) } catch {}
    appendFileSync(file, `${new Date(now()).toISOString()} ${message}\n`, { mode: 0o600 })
  } catch {}
}

export function errorDetail(error) {
  const message = error?.message ? String(error.message) : String(error)
  return { message: message.slice(0, 2_000), stack: error?.stack ? String(error.stack).slice(0, 2_000) : null }
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
    cwd: row.cwd,
    workspaceKey: row.workspace_key,
    model: row.model,
    effort: row.effort,
    timeBudgetSeconds: row.time_budget_seconds,
    maxTurns: row.max_turns,
    maxBudgetUsd: row.max_budget_usd,
    prompt: row.prompt,
    outputSchema: parse(row.output_schema_json),
    baseSha: row.base_sha,
    headSha: row.head_sha,
    elicitation: Boolean(row.elicitation),
    nativeThreadId: row.native_thread_id,
    nativeTurnId: row.native_turn_id,
    turnAcceptedAt: row.turn_accepted_at,
    status: row.status,
    workerPid: row.worker_pid,
    providerPid: row.provider_pid,
    providerStartToken: row.provider_start_token,
    providerProcessGroupId: row.provider_process_group_id,
    providerScope: row.provider_scope,
    providerProcesses: parse(row.provider_processes_json) || [],
    quarantineResumeStatus: row.quarantine_resume_status,
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
    try {
      this.db = new DatabaseSync(this.path, { timeout: 5_000 })
      try { chmodSync(this.path, 0o600) } catch {}
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
      // A journal_mode switch answers SQLITE_BUSY at once and ignores busy_timeout while any
      // other connection holds the fresh database open. The mode is a durable property of the
      // file, so losing this race costs nothing: whoever wins sets WAL for everyone.
      try { this.db.exec('PRAGMA journal_mode=WAL;') } catch {}
      this.migrate()
      this.prune()
    } catch (error) {
      try { this.db?.close() } catch {}
      if (error instanceof DelegationError) throw error
      // A lock that outlives busy_timeout, a corrupt file, a full disk: the sqlite message is
      // the only diagnosis available, so it survives into the error and the service log.
      serviceLog(stateDir, `store open failed: ${errorDetail(error).stack || error?.message || error}`)
      // publicError() preserves DelegationError messages, so the sqlite detail stays in the
      // service log only: lock state and filesystem paths are not for the caller.
      throw new DelegationError('INTERNAL', 'The delegation database could not be opened.')
    }
  }

  userVersion() { return Number(this.db.prepare('PRAGMA user_version').get().user_version) }

  // How many jobs in an older database are still live, and so must not be dropped by the
  // reset below. `status` is the one column every earlier schema has, so this reads that and
  // nothing else: no other column name is safe to name across six versions.
  //
  // A jobs table that cannot be read this way is outside every schema Flow ever wrote. The
  // query throws, the migration rolls back, and the constructor turns it into INTERNAL with
  // the sqlite message in the service log. That is the right answer: the file survives, and a
  // store that cannot prove it holds no live jobs must not destroy them.
  liveJobsInLegacySchema() {
    const present = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get()
    if (!present) return 0
    const marks = LIVE_ON_UPGRADE.map(() => '?').join(',')
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status IN (${marks})`)
      .get(...LIVE_ON_UPGRADE).count)
  }

  // The job cache holds 14 days of operational history and is never an archive, so an older
  // schema is dropped and recreated rather than carried forward through a ladder of
  // migrations nobody can test against real rows. A NEWER schema is still refused: that
  // database belongs to a Flow version this one cannot read, and resetting it would destroy
  // live jobs the other version owns.
  //
  // An OLDER schema is refused too while any of its jobs is still live. A job row is not only
  // history: a workspace-write job holds a lease on its worktree, and a worker or a provider
  // process can outlive the MCP process that started it, so an upgrade can land mid-run.
  // Dropping that row drops its lease without proving the provider dead, and the next job can
  // then claim a worktree something else is still writing to. Terminal rows have no such
  // claim, so a legacy database that holds only those resets as before.
  migrate() {
    const version = this.userVersion()
    if (version === SCHEMA_VERSION) return
    if (version > SCHEMA_VERSION) throw new DelegationError('DATABASE_NEWER', 'The delegation database was created by a newer Flow version.')
    // Foreign keys off before the transaction: jobs.parent_job_id points into jobs itself, so
    // an implicit row-by-row delete could raise a violation while the table is on its way out.
    this.db.exec('PRAGMA foreign_keys=OFF')
    try {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        // Two processes can race a fresh state dir, so the version is re-read inside the write
        // lock: the loser sees the winner's tables and returns instead of re-running the DDL.
        const locked = this.userVersion()
        if (locked > SCHEMA_VERSION) throw new DelegationError('DATABASE_NEWER', 'The delegation database was created by a newer Flow version.')
        if (locked !== SCHEMA_VERSION) {
          // Inside the write lock, so no other process can start a job between this count and
          // the DROP that follows it.
          const live = this.liveJobsInLegacySchema()
          if (live > 0) {
            throw new DelegationError('STORE_UPGRADE_BLOCKED',
              `The delegation database was written by an older Flow version and still holds ` +
              `${live === 1 ? '1 unfinished job' : `${live} unfinished jobs`}. Upgrading resets the database, ` +
              'which would drop those jobs and the worktree write leases they hold without proving their ' +
              'providers dead. Let them finish, or cancel them with the previous Flow version, then upgrade.')
          }
          this.db.exec('DROP TABLE IF EXISTS approvals; DROP TABLE IF EXISTS leases; DROP TABLE IF EXISTS controls; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS jobs;')
          this.db.exec(SCHEMA)
          this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
        }
        this.db.exec('COMMIT')
      } catch (error) {
        try { this.db.exec('ROLLBACK') } catch {}
        throw error
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys=ON')
    }
  }

  // Terminal jobs are pruned on open. updated_at is the terminal timestamp: finish() and
  // requestCancel() write it with the terminal status and nothing updates a job afterwards.
  prune() {
    const cutoff = now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000
    const states = TERMINAL_STATES.map(() => '?').join(',')
    const candidate = this.db.prepare(`SELECT 1 FROM jobs WHERE status IN (${states}) AND updated_at < ? LIMIT 1`)
      .get(...TERMINAL_STATES, cutoff)
    let total = 0
    if (candidate) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        // events, controls and leases cascade. jobs.parent_job_id does not: a job survives
        // while any row still references it, so chains delete leaf-first, one pass per
        // generation, and no pass can leave a dangling parent reference.
        const expired = this.db.prepare(`DELETE FROM jobs WHERE status IN (${states}) AND updated_at < ?
          AND id NOT IN (SELECT parent_job_id FROM jobs WHERE parent_job_id IS NOT NULL)`)
        for (;;) {
          const changes = Number(expired.run(...TERMINAL_STATES, cutoff).changes)
          total += changes
          if (!changes) break
        }
        this.db.exec('COMMIT')
      } catch (error) {
        try { this.db.exec('ROLLBACK') } catch {}
        serviceLog(this.stateDir, `prune failed: ${error?.message || error}`)
      }
    }
    this.pruneTempDirs()
    return total
  }

  pruneTempDirs() {
    const tempRoot = join(this.stateDir, 'tmp')
    let entries
    try { entries = readdirSync(tempRoot, { withFileTypes: true }) } catch { return }
    const state = this.db.prepare('SELECT status FROM jobs WHERE id=?')
    const jobDir = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/
    for (const entry of entries) {
      const id = entry.name.match(jobDir)?.[1]
      if (!id) continue
      const row = state.get(id)
      if (row && (ACTIVE_STATES.includes(row.status) || row.status === 'quarantined')) continue
      try { rmSync(join(tempRoot, entry.name), { recursive: true, force: true }) } catch {}
    }
  }

  close() { this.db.close() }

  createJob(request) {
    const id = randomUUID()
    const at = now()
    this.db.prepare(`INSERT INTO jobs (
      id, trace_id, parent_job_id, host, target, depth, mode, access,
      cwd, workspace_key, model, effort, time_budget_seconds,
      max_turns, max_budget_usd,
      prompt, output_schema_json, base_sha, head_sha, native_thread_id, elicitation,
      status, created_at, updated_at, heartbeat_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
      .run(id, request.traceId || randomUUID(), request.parentJobId || null,
        request.host, request.target, request.depth, request.mode, request.access,
        request.cwd, request.workspaceKey, request.model, request.effort,
        request.timeBudgetSeconds,
        request.maxTurns ?? null, request.maxBudgetUsd ?? null, request.prompt,
        json(request.outputSchema), request.baseSha || null, request.headSha || null,
        request.nativeThreadId || null, request.elicitation ? 1 : 0, at, at, at)
    this.appendEvent(id, 'job.queued', { status: 'queued' })
    return this.getJob(id)
  }

  getJob(id) {
    const job = decode(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id))
    if (!job) return null
    // Computed from the journal on every read so a "succeeded" job whose shell was broken
    // (every command failed, provider answered from thin air) stays detectable by the host.
    job.commandFailures = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM events
      WHERE job_id = ? AND type = 'command.completed'
        AND (json_extract(payload_json, '$.status') = 'failed'
          OR COALESCE(json_extract(payload_json, '$.exitCode'), 0) != 0)`).get(id).count)
    return job
  }

  quarantinedCount() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='quarantined'").get().count)
  }

  requireJob(id) {
    const job = this.getJob(id)
    if (!job) throw new DelegationError('JOB_NOT_FOUND', 'No delegation job has that ID.')
    return job
  }

  appendEvent(jobId, type, payload = {}) {
    return this.db.prepare(`INSERT INTO events (job_id, seq, type, payload_json, created_at)
      VALUES (?, COALESCE((SELECT MAX(seq) + 1 FROM events WHERE job_id = ?), 1), ?, ?, ?)
      RETURNING seq`)
      .get(jobId, jobId, type, json(payload), now()).seq
  }

  // publicError() deliberately hides an unexpected failure from the caller. The journal is
  // 0600 and already carries bounded operational detail, so the real cause is kept here.
  recordInternalError(jobId, error) {
    try { this.appendEvent(jobId, 'internal.error', errorDetail(error)) } catch {}
  }

  events(jobId, { after = 0, limit = 200 } = {}) {
    this.requireJob(jobId)
    return this.db.prepare(`SELECT seq, type, payload_json, created_at FROM events
      WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(jobId, after, Math.max(1, Math.min(limit, 1000)))
      // internal.error payloads carry stacks and paths for the owner reading the database
      // directly; this method feeds the caller-facing events tool and attached progress,
      // where they would cross the redaction boundary publicError() maintains.
      .map((row) => ({
        seq: row.seq,
        type: row.type,
        payload: row.type === 'internal.error' ? { redacted: true } : parse(row.payload_json),
        createdAt: row.created_at,
      }))
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
        this.db.prepare('INSERT INTO leases (workspace_key, job_id) VALUES (?, ?)')
          .run(job.workspaceKey, id)
      }
      this.db.prepare(`UPDATE jobs SET status='starting', worker_pid=?, heartbeat_at=?, updated_at=? WHERE id=?`)
        .run(pid, at, at, id)
      this.appendEvent(id, 'job.starting', { pid, startToken })
      this.db.exec('COMMIT')
      return this.getJob(id)
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  // A worker that lost the claim still has to explain why the job will never run, but only
  // while nothing owns it. The queued guard makes the write a no-op when another worker won
  // the race, so a report can never overwrite the winner's job.
  failQueued(id, error) {
    const at = now()
    const result = this.db.prepare(`UPDATE jobs SET status='failed', error_json=?, prompt=NULL,
      updated_at=?, heartbeat_at=? WHERE id=? AND status='queued'`)
      .run(json(error), at, at, id)
    if (result.changes) this.appendEvent(id, 'job.failed', { error })
    return result.changes === 1
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

  setProviderProcess(id, { pid, startToken = null, processGroupId = null, scope = null, processes = [] } = {}) {
    const safeProcesses = processes.filter((entry) => Number.isInteger(entry?.pid) && entry.pid > 0
      && typeof entry.startToken === 'string' && entry.startToken)
    this.db.prepare(`UPDATE jobs SET provider_pid=?, provider_start_token=?,
      provider_process_group_id=?, provider_scope=?, provider_processes_json=?, updated_at=?
      WHERE id=? AND status IN ('starting','running','reconciling','quarantined')`)
      .run(Number.isInteger(pid) && pid > 0 ? pid : null,
        typeof startToken === 'string' && startToken ? startToken : null,
        Number.isInteger(processGroupId) && processGroupId > 0 ? processGroupId : null,
        typeof scope === 'string' && scope ? scope : null,
        json(safeProcesses), now(), id)
  }

  // jobs.heartbeat_at carries worker liveness. finish() releases an ordinary lease;
  // resolveQuarantine() releases one held past worker shutdown.
  heartbeat(id) {
    const at = now()
    this.db.prepare('UPDATE jobs SET heartbeat_at=?, updated_at=? WHERE id=? AND status IN (\'starting\',\'running\',\'reconciling\',\'awaiting_approval\')')
      .run(at, at, id)
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
      if (current.status === 'quarantined') {
        throw new DelegationError('JOB_QUARANTINED', 'A quarantined job can finish only after Flow proves its provider processes stopped.')
      }
      this.db.prepare(`UPDATE jobs SET status=?, output=?, structured_json=?, usage_json=?, error_json=?,
        prompt=NULL, provider_pid=NULL, provider_start_token=NULL,
        provider_process_group_id=NULL, provider_scope=NULL, provider_processes_json=NULL,
        quarantine_resume_status=NULL, updated_at=?, heartbeat_at=? WHERE id=?`)
        .run(status, output, json(structured), json(usage), json(error), at, at, id)
      this.db.prepare(`UPDATE controls SET payload_json='{}' WHERE job_id=?`).run(id)
      this.db.prepare('DELETE FROM leases WHERE job_id=?').run(id)
      this.db.exec('COMMIT')
    } catch (cause) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw cause
    }
    this.appendEvent(id, `job.${status}`, error ? { error } : { status })
    this.pruneTempDirs()
    return this.getJob(id)
  }

  quarantine(id, resumeStatus, { output = null, structured = null, usage = null, error = null } = {}) {
    if (!TERMINAL_STATES.includes(resumeStatus) && resumeStatus !== 'reconciling') {
      throw new DelegationError('JOB_STATE', `Cannot resume a quarantined job as ${resumeStatus}.`)
    }
    const at = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = decode(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id))
      if (!current) throw new DelegationError('JOB_NOT_FOUND', 'No delegation job has that ID.')
      if (TERMINAL_STATES.includes(current.status) || current.status === 'quarantined') {
        this.db.exec('COMMIT')
        return current
      }
      this.db.prepare(`UPDATE jobs SET status='quarantined', quarantine_resume_status=?,
        output=?, structured_json=?, usage_json=?, error_json=?, prompt=NULL,
        updated_at=?, heartbeat_at=? WHERE id=?`)
        .run(resumeStatus, output, json(structured), json(usage), json(error), at, at, id)
      this.db.prepare(`UPDATE controls SET payload_json='{}' WHERE job_id=?`).run(id)
      this.db.exec('COMMIT')
    } catch (cause) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw cause
    }
    this.appendEvent(id, 'job.quarantined', { resumeStatus })
    return this.getJob(id)
  }

  // force is the escape hatch delegation_cancel uses. A quarantine only clears itself when the
  // recorded processes are observed dead, and a job that recorded none can never reach that
  // proof on its own; it would hold its write lease forever. The caller does the liveness
  // check and passes the ending it wants, which is always a terminal one.
  resolveQuarantine(id, { force = null } = {}) {
    if (force !== null && !TERMINAL_STATES.includes(force)) {
      throw new DelegationError('JOB_STATE', `Cannot resolve a quarantined job as ${force}.`)
    }
    const at = now()
    let resumeStatus
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = decode(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id))
      if (!current) throw new DelegationError('JOB_NOT_FOUND', 'No delegation job has that ID.')
      if (current.status !== 'quarantined') {
        this.db.exec('COMMIT')
        return current
      }
      resumeStatus = force || current.quarantineResumeStatus
      if (!TERMINAL_STATES.includes(resumeStatus) && resumeStatus !== 'reconciling') {
        throw new DelegationError('JOB_STATE', 'The quarantined job has no valid resume state.')
      }
      this.db.prepare(`UPDATE jobs SET status=?, provider_pid=NULL, provider_start_token=NULL,
        provider_process_group_id=NULL, provider_scope=NULL, provider_processes_json=NULL,
        quarantine_resume_status=NULL, updated_at=?, heartbeat_at=? WHERE id=?`)
        .run(resumeStatus, at, resumeStatus === 'reconciling' ? 0 : at, id)
      if (TERMINAL_STATES.includes(resumeStatus)) {
        this.db.prepare('DELETE FROM leases WHERE job_id=?').run(id)
      }
      this.db.exec('COMMIT')
    } catch (cause) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw cause
    }
    this.appendEvent(id, 'quarantine.cleared', { status: resumeStatus })
    if (TERMINAL_STATES.includes(resumeStatus)) {
      this.appendEvent(id, `job.${resumeStatus}`, { status: resumeStatus })
    }
    this.pruneTempDirs()
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
      if (job.status === 'quarantined') {
        throw new DelegationError('JOB_QUARANTINED', 'The provider process is quarantined and cannot accept controls.')
      }
      if (!ACTIVE_STATES.includes(job.status)) throw new DelegationError('JOB_STATE', `Job ${jobId} is already ${job.status}.`)
      result = this.db.prepare('INSERT INTO controls (job_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(jobId, type, json(payload), now())
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
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
      if (job.status === 'quarantined') {
        throw new DelegationError('JOB_QUARANTINED', 'The provider process is quarantined and cannot accept cancellation.')
      }
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
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
    if (cancelled) this.appendEvent(jobId, 'job.cancelled', { status: 'cancelled' })
    else this.appendEvent(jobId, 'control.cancel.queued', {})
    return this.getJob(jobId)
  }

  // The approval fork. A worker parks a provider's approval request here and polls for the
  // decision; the MCP server process, which alone holds the session, asks the human and
  // writes it. approvals.mjs owns the wait; these are the rows.
  requestApproval(jobId, { method, summary = {}, seconds = null }) {
    const id = this.db.prepare(`INSERT INTO approvals (job_id, method, summary_json, created_at)
      VALUES (?, ?, ?, ?) RETURNING id`).get(jobId, method, json(summary), now()).id
    this.appendEvent(jobId, 'approval.requested', { approvalId: id, method, summary, seconds })
    return id
  }

  approvalDecision(jobId, approvalId) {
    const row = this.db.prepare('SELECT decision FROM approvals WHERE id = ? AND job_id = ?').get(approvalId, jobId)
    return row?.decision ?? null
  }

  // A queued cancel wins over an accept, decided inside the write lock so the worker's read
  // and the server's write cannot interleave into an accept the caller had already revoked.
  decideApproval(jobId, approvalId, decision, decidedBy) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const revoked = decision === 'accept' && this.cancelRequested(jobId)
      const finalDecision = revoked ? 'decline' : decision
      const finalBy = revoked ? 'cancel' : decidedBy
      const result = this.db.prepare(`UPDATE approvals SET decision = ?, decided_by = ?, decided_at = ?
        WHERE id = ? AND job_id = ? AND decision IS NULL`).run(finalDecision, finalBy, now(), approvalId, jobId)
      if (result.changes) this.appendEvent(jobId, 'approval.decided', { approvalId, decision: finalDecision, decidedBy: finalBy })
      this.db.exec('COMMIT')
      return result.changes > 0
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  // Newest first, one route only: the resources a host lists are the jobs it may read.
  listJobs({ host, target, limit = 50 } = {}) {
    return this.db.prepare('SELECT * FROM jobs WHERE host = ? AND target = ? ORDER BY created_at DESC, id LIMIT ?')
      .all(host, target, Math.max(1, Math.min(limit, 200))).map(decode)
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

  // Handled or not, a queued cancel is what makes an interrupted turn a cancellation rather
  // than a failure. finish() blanks control payloads but keeps the rows.
  cancelRequested(jobId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM controls WHERE job_id=? AND type='cancel' LIMIT 1`).get(jobId))
  }
}
