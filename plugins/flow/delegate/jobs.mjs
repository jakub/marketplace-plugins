// The job store: admission, the job directory, the provider's private TMPDIR, the write lease, the
// runner spawn, waiting, cancel, steering, reconciliation and pruning. A job is a directory under
// <state>/jobs/<uuid>/, and job.json is only ever replaced by rename, so a reader sees the old
// record or the new one. While a runner lives it is the only writer of its job's record; the server
// writes one only to create it or to settle a job whose runner is gone. A `claim` file, linked into
// place with its holder inside, decides who may move a queued job, so a late runner and a cancel or
// a lease takeover never both act on it. A steer is a file the server writes under steer/ and the
// runner answers beside it, so neither ever writes the other's file.
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { schemaProblem } from './schema.mjs'

const execFileAsync = promisify(execFile)
const MAIN = fileURLToPath(new URL('./main.mjs', import.meta.url))
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown'])
export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MODEL = /^[a-z0-9][a-z0-9.-]*$/
const START_KEYS = ['prompt', 'model', 'effort', 'cwd', 'mode', 'access', 'base', 'head', 'outputSchema', 'continue',
  'timeBudgetSeconds', 'waitSeconds', 'maxTurns', 'maxBudgetUsd']
const QUEUE_GRACE_MS = 60_000
const PRUNE_MS = 14 * 86_400_000
const STEER_BYTES = 65_536
const STEER_WAIT_MS = 30_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class DelegateError extends Error {
  constructor(kind, message, details) { super(message); this.kind = kind; this.details = details }
}
export const fail = (kind, message, details) => { throw new DelegateError(kind, message, details) }

// Written in the subset Codex enforces for structured output: closed objects, every property
// required. Like every schema a job carries, a reply is checked against it before success.
export const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'confidence', 'title', 'file', 'line', 'detail', 'systemic'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          confidence: { type: 'integer', minimum: 0, maximum: 100 },
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer', minimum: 0 },
          detail: { type: 'string' },
          systemic: { type: 'boolean' },
        },
      },
    },
  },
}

export const stateDir = () => process.env.FLOW_DELEGATION_STATE_DIR
  || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'flow')
export const jobDir = (id) => join(stateDir(), 'jobs', id)

// A provider's private TMPDIR, outside the job directory. Claude Code's sandbox creates its proxy
// bridge sockets in TMPDIR as claude-http-<16 hex>.sock and claude-socks-<16 hex>.sock. A Unix
// socket path holds at most 107 bytes, so every sandboxed command fails when TMPDIR is longer than
// 72 bytes. The job directory's depth follows HOME, and with HOME=/home/jakub a job's tmp under the
// default state directory was 75 bytes. So each job gets /tmp/flow-<first 8 characters of its
// id>-<8 random hex characters>, 27 bytes whatever HOME, the state directory or the host's own
// TMPDIR say. It is not in $XDG_RUNTIME_DIR, because Codex passes an MCP server no XDG variable, so
// the location would differ by host, and that directory is a small tmpfs meant for sockets, not for
// a build's temporary files. The path is chosen first and recorded as tmpDir while the job is still
// queued, and only then created, so the directory never exists before its job's record names it.
// makeTmp creates it with mode 0700 and fails if the name is taken, the random part keeps other
// users from predicting it, and the sticky bit on /tmp stops another user from moving it. The
// runner removes it when the job ends. When the runner dies, reconcile removes it, whether the job
// reached running or not.
const tmpPrefix = (id) => `flow-${String(id).slice(0, 8)}-`
export const tmpPath = (id) => join(realpathSync('/tmp'), `${tmpPrefix(id)}${randomBytes(4).toString('hex')}`)
export const makeTmp = (path) => mkdirSync(path, { mode: 0o700 })
// The path comes from a record, so it is removed only when it is one tmpPath could have given this
// id: a direct child of the real /tmp, named by the id's prefix and 8 hex characters, and still a
// directory of this user's rather than a symlink. No record can point the removal anywhere else.
// /tmp is not the job's to write, but everything inside the directory is, and a process the job
// left outside its provider's group can still write there while the removal runs. So removeTree
// never checks a path inside and then uses it: see its own comment. dropTmp never throws: the job
// and its lease are finalized after it whatever the provider left, and a directory that still
// resists is logged and left to the system's /tmp cleanup.
export function dropTmp(id, path) {
  try {
    if (typeof path !== 'string') return
    const name = basename(path)
    const prefix = tmpPrefix(id)
    if (path !== join(realpathSync('/tmp'), name) || !name.startsWith(prefix) || !/^[0-9a-f]{8}$/.test(name.slice(prefix.length))) return
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat?.isDirectory() || stat.uid !== process.getuid()) return
    removeTree(path)
  } catch (error) { log(`could not remove the TMPDIR of job ${id}: ${error?.code ?? error}`) }
}
// Node names no O_PATH. This is its value in the kernel's generic fcntl.h, which x86-64 and arm64
// both use.
const O_PATH = 0o10000000
// Removes the directory at path and everything in it, acting on each directory only through a
// handle to it. The handle is opened with O_NOFOLLOW and O_DIRECTORY, so a symlink never yields
// one, and with O_PATH, which needs no permission on the directory itself, so a directory nobody
// may enter still yields one. fstat on the handle checks the owner, and /proc/self/fd/<handle>
// opens the directory to its owner, lists it and names each entry from it, so an entry replaced
// after it was listed or opened sends nothing onto another path. unlink and rmdir never follow a
// final symlink. An entry that fails is skipped, so its parent's rmdir fails and dropTmp logs it.
// Node's rmSync is not used, because on Node 22 it checks each directory by path in JavaScript
// and then reads it by the same path.
function removeTree(path) {
  const fd = openSync(path, O_PATH | constants.O_NOFOLLOW | constants.O_DIRECTORY)
  try {
    if (fstatSync(fd).uid !== process.getuid()) return
    const dir = `/proc/self/fd/${fd}`
    chmodSync(dir, 0o700)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name)
      try { if (entry.isDirectory()) removeTree(child); else unlinkSync(child) } catch {}
    }
  } finally { closeSync(fd) }
  rmdirSync(path)
}

export function readJob(id) {
  try { return JSON.parse(readFileSync(join(jobDir(id), 'job.json'), 'utf8')) } catch { return null }
}
export function writeJob(job) {
  const temp = join(jobDir(job.id), `.job.${process.pid}.${randomUUID()}`)
  writeFileSync(temp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, join(jobDir(job.id), 'job.json'))
  return job
}
export const settle = (job, status, fields = {}) => writeJob({ ...job, ...fields, status, turnOpen: false, endedAt: new Date().toISOString() })
export function log(message) {
  try { appendFileSync(join(stateDir(), 'server.log'), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 }) } catch {}
}
// The claim file names its holder: it is linked into place already holding the claimant's pid
// and start token, so it never exists without them.
export function claim(id) {
  const temp = join(jobDir(id), `.claim.${process.pid}.${randomUUID()}`)
  try {
    writeFileSync(temp, JSON.stringify({ pid: process.pid, start: startToken(process.pid) }), { mode: 0o600 })
    linkSync(temp, join(jobDir(id), 'claim'))
    return true
  } catch { return false } finally { rmSync(temp, { force: true }) }
}
function claimantAlive(id) {
  try {
    const { pid, start } = JSON.parse(readFileSync(join(jobDir(id), 'claim'), 'utf8'))
    return Boolean(start) && startToken(pid) === start
  } catch { return false }
}

// /proc/<pid>/stat field 22 is the start time, which tells a live process from a recycled pid.
// A zombie has already exited, so it counts as dead unless the question is only which process
// holds the pid.
export function startToken(pid, { zombie = false } = {}) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[0] === 'Z' && !zombie ? null : fields[19] ?? null
  } catch { return null }
}
const runnerAlive = (job) => Boolean(job.runnerPid && job.runnerStart) && startToken(job.runnerPid) === job.runnerStart
// A recorded group id is signalled only while it is still the provider's: its leader is the
// process recorded at spawn, or the leader is gone and members remain, which the kernel keeps
// unambiguous by never handing out an id a live group still carries. A leader id that now names
// another process means the group ended and the id was reused, so nothing is sent.
export function signalProvider(job, signal = 'SIGKILL') {
  const pgid = job?.providerPgid
  if (!pgid || !job.providerStart) return
  const leader = startToken(pgid, { zombie: true })
  if (leader !== null && leader !== job.providerStart) return
  try { process.kill(-pgid, signal) } catch {}
}
// Whether a recorded group may still hold a process that can write. Unknown never releases the
// lease, so every answer this cannot prove reads as alive. A leader id that now names another
// process means the group ended, as for signalProvider; with no start token on record that check
// cannot run, and any group carrying the id keeps the lease, at worst until that group ends. Then:
// kill(-pgid, 0) failing with ESRCH proves the group gone, and any other failure reads alive.
// Otherwise /proc is scanned for the members, the processes whose pgrp is the id, and each
// member's every thread is read from /proc/<pid>/task, because the stat of a thread-group leader
// can read Z while another of its threads runs. The group is gone only when every thread of every
// member reads Z (zombie) or X (dead): a zombie holds no file descriptor and runs no code. A
// member with any other thread, a /proc read that fails for any reason but the process having
// ended, or a scan that finds no member while kill(-pgid, 0) still answers, as hidepid or an
// unreadable entry would make it, reads alive. Every caller asks only after the group's SIGKILL,
// so no member can fork past the scan. proc is the /proc reader; only the smoke passes another.
const PROC = { list: (path) => readdirSync(path), read: (path) => readFileSync(path, 'utf8') }
export function providerGroupAlive(job, proc = PROC) {
  const pgid = job?.providerPgid
  if (!pgid) return false
  if (job.providerStart) {
    const leader = startToken(pgid, { zombie: true })
    if (leader !== null && leader !== job.providerStart) return false
  }
  try { process.kill(-pgid, 0) } catch (error) { return error.code !== 'ESRCH' }
  const ended = (error) => error?.code === 'ENOENT' || error?.code === 'ESRCH'
  // comm, in parentheses, may itself hold spaces and parentheses, so the fields start after the
  // last ')': state, ppid, pgrp.
  const fields = (stat) => stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  let pids
  try { pids = proc.list('/proc').filter((name) => /^[0-9]+$/.test(name)) } catch { return true }
  let members = 0
  for (const pid of pids) {
    let stat
    try { stat = proc.read(`/proc/${pid}/stat`) } catch (error) { if (ended(error)) continue; return true }
    if (Number(fields(stat)[2]) !== pgid) continue
    members += 1
    let tasks
    try { tasks = proc.list(`/proc/${pid}/task`) } catch (error) { if (ended(error)) continue; return true }
    for (const tid of tasks) {
      let task
      try { task = proc.read(`/proc/${pid}/task/${tid}/stat`) } catch (error) { if (error?.code === 'ENOENT') continue; return true }
      if (!['Z', 'X'].includes(fields(task)[0])) return true
    }
  }
  return members === 0
}

export const inside = (root, path) => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
export function canonicalRoots(paths) {
  const roots = []
  for (const path of paths) {
    try {
      const real = realpathSync(path)
      if (statSync(real).isDirectory() && !roots.includes(real)) roots.push(real)
    } catch {}
  }
  return roots
}

// No user or system config and no inherited GIT_* variable: neither may change which repository
// answers or what a revision resolves to. Only absolute PATH entries find the binary, the rule
// providers.mjs keeps for a provider: an empty or relative entry, or an empty PATH, resolves
// against this server's working directory, which on a Codex host is the project itself.
export async function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
  const path = (env.PATH || '').split(delimiter).filter((directory) => isAbsolute(directory)).join(delimiter)
  if (!path) return null
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      env: { ...env, PATH: path, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, timeout: 15_000,
    })
    return stdout.trim()
  } catch { return null }
}

// Codex starts this server in the thread's project directory. That directory is the one root,
// and only when it is a repository's top level and not the home directory.
export async function codexRoot() {
  try {
    const cwd = realpathSync(process.cwd())
    if (cwd === realpathSync(homedir())) return null
    const top = await git(cwd, ['rev-parse', '--show-toplevel'])
    return top && realpathSync(top) === cwd ? cwd : null
  } catch { return null }
}

export function checkKeys(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('BAD_REQUEST', 'The arguments must be an object.')
  for (const key of Object.keys(input)) if (!keys.includes(key)) fail('BAD_REQUEST', `Unknown argument: ${key}.`)
}
export function integer(value, name, min, max, fallback) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) fail('BAD_REQUEST', `${name} must be an integer from ${min} to ${max}.`)
  return value
}
function oneOf(value, name, list, fallback) {
  if (value === undefined) return fallback
  if (!list.includes(value)) fail('BAD_REQUEST', `${name} must be one of: ${list.join(', ')}.`)
  return value
}

function validateStart(input, target) {
  checkKeys(input, START_KEYS)
  const mode = oneOf(input.mode, 'mode', ['task', 'adversarial-review'], 'task')
  const review = mode === 'adversarial-review'
  if (typeof input.prompt !== 'string' || (!review && !input.prompt.trim())) fail('BAD_REQUEST', 'A task needs a non-empty prompt.')
  if (typeof input.model !== 'string' || !MODEL.test(input.model)) fail('BAD_REQUEST', 'model is required: a provider model id or alias.')
  if (!EFFORTS.includes(input.effort)) fail('BAD_REQUEST', `effort is required: one of ${EFFORTS.join(', ')}.`)
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) fail('BAD_REQUEST', 'cwd must be an absolute path.')
  const access = oneOf(input.access, 'access', ['read-only', 'workspace-write'])
  for (const name of ['base', 'head']) {
    if (input[name] === undefined) continue
    if (!review) fail('BAD_REQUEST', `${name} applies to adversarial-review mode only.`)
    if (typeof input[name] !== 'string' || !input[name] || input[name].startsWith('-')) fail('GIT_REF', `${name} must be a Git revision.`)
  }
  if (review && input.base === undefined) fail('GIT_REF', 'adversarial-review needs a base revision.')
  if (input.outputSchema !== undefined) {
    const schema = input.outputSchema
    if (review) fail('BAD_SCHEMA', 'adversarial-review answers in the fixed findings schema.')
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') {
      fail('BAD_SCHEMA', 'outputSchema must be a JSON Schema object whose type is "object".')
    }
    if (Buffer.byteLength(JSON.stringify(schema)) > 65_536) fail('BAD_SCHEMA', 'outputSchema exceeds 64 KiB.')
    const problem = schemaProblem(schema)
    if (problem) fail('BAD_SCHEMA', `outputSchema: ${problem}.`)
  }
  if (input.continue !== undefined) {
    if (typeof input.continue !== 'string' || !JOB_ID.test(input.continue)) fail('BAD_REQUEST', 'continue must be a job id.')
    if (review) fail('BAD_REQUEST', 'A continuation is a task; a new diff is a new review.')
  }
  const timeBudgetSeconds = integer(input.timeBudgetSeconds, 'timeBudgetSeconds', 30, 7200, 900)
  integer(input.waitSeconds, 'waitSeconds', 0, 7200)
  if ((input.maxTurns !== undefined || input.maxBudgetUsd !== undefined) && target !== 'claude') {
    fail('BAD_REQUEST', 'maxTurns and maxBudgetUsd apply to the Claude target only.')
  }
  const maxTurns = integer(input.maxTurns, 'maxTurns', 1, 1000, null)
  const budget = input.maxBudgetUsd
  if (budget !== undefined && !(typeof budget === 'number' && budget >= 0.01 && budget <= 1000)) {
    fail('BAD_REQUEST', 'maxBudgetUsd must be a number from 0.01 to 1000.')
  }
  return { mode, review, access, timeBudgetSeconds, maxTurns, maxBudgetUsd: budget ?? null }
}

async function commit(cwd, ref) {
  const sha = await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
  return sha || fail('GIT_REF', `${ref} does not resolve to a commit in cwd.`)
}

const preview = (text) => {
  const chars = Array.from(String(text).replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim())
  return chars.length > 240 ? `${chars.slice(0, 237).join('')}...` : chars.join('')
}

export function reviewPrompt(baseSha, headSha, focus) {
  const extra = focus.trim() ? `\n\nAdditional focus from the caller:\n${focus.trim()}` : ''
  return `Act as an adversarial code reviewer. Review the diff \`git diff ${baseSha} ${headSha}\` in this repository and try to refute the change. Hunt for reachable correctness, security, concurrency and trust-boundary defects; read surrounding code and tests as needed. Report only findings you verified against the code, never style or formatting. Cite a repository-relative file and the first affected line in the new code. Do not edit files. Answer in the output schema; a clean review has an empty findings array.${extra}`
}

export async function admit(input, { host, roots }) {
  // A runner hands its provider FLOW_DELEGATION_DEPTH, so a server started inside a delegated
  // seat cannot start a second hop.
  if (process.env.FLOW_DELEGATION_DEPTH) fail('NESTED_DELEGATION', 'A delegated seat cannot start another delegation.')
  const target = host === 'claude' ? 'codex' : 'claude'
  const request = validateStart(input, target)
  if (!roots.length) fail('NO_ROOTS', 'The host supplied no usable workspace root.')
  let cwd
  try {
    cwd = realpathSync(input.cwd)
    if (!statSync(cwd).isDirectory()) throw new Error('not a directory')
  } catch { fail('BAD_REQUEST', 'cwd does not name an existing directory.') }
  if (!roots.some((root) => inside(root, cwd))) fail('OUTSIDE_ROOTS', 'cwd resolves outside the workspace roots.')
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top) fail('BAD_REQUEST', 'cwd is not inside a Git worktree.')
  const worktree = realpathSync(top)
  if (!roots.some((root) => inside(root, worktree))) fail('OUTSIDE_ROOTS', 'The Git worktree resolves outside the workspace roots.')

  let access = request.access ?? 'read-only'
  let parent = null
  if (input.continue) {
    parent = visibleJob(input.continue, { host, roots })
    // Only a finished job is continued. A running one is steered with delegation_steer, or
    // cancelled and then continued, and a continuation never stops it.
    if (!TERMINAL.has(parent.status)) fail('JOB_STATE', 'The job is still running: steer it with delegation_steer, or cancel it and continue it once it ends.')
    if (parent.status === 'unknown' || !parent.threadId) fail('JOB_STATE', 'Only a finished job with a provider thread and a known outcome can be continued.')
    if (parent.cwd !== cwd) fail('BAD_REQUEST', `A continuation runs in the cwd of the job it continues: ${parent.cwd}.`)
    if (request.access && request.access !== parent.access) fail('BAD_REQUEST', `A continuation keeps the access of the job it continues: ${parent.access}.`)
    access = parent.access
  }
  let prompt = input.prompt
  let schema = input.outputSchema ?? null
  let baseSha = null
  let headSha = null
  if (request.review) {
    baseSha = await commit(cwd, input.base)
    headSha = await commit(cwd, input.head ?? 'HEAD')
    prompt = reviewPrompt(baseSha, headSha, input.prompt)
    schema = FINDINGS_SCHEMA
    access = 'read-only'
  }
  const job = {
    id: randomUUID(), host, target, mode: request.mode, access, cwd, worktree, model: input.model, effort: input.effort,
    status: 'queued', createdAt: new Date().toISOString(), endedAt: null,
    timeBudgetSeconds: request.timeBudgetSeconds, maxTurns: request.maxTurns, maxBudgetUsd: request.maxBudgetUsd,
    parentJobId: parent?.id ?? null, resumeThreadId: parent?.threadId ?? null,
    sessionId: target === 'claude' && !parent ? randomUUID() : null, threadId: null,
    requestPreview: preview(input.prompt.trim() ? input.prompt : `Review ${baseSha}..${headSha}`),
    baseSha, headSha, hasSchema: schema !== null,
    servedModel: null, catalog: null, isolation: null, promptSent: false, turnOpen: false, steers: [], tmpDir: null,
    output: null, structured: null, commandFailures: 0, error: null,
  }
  mkdirSync(jobDir(job.id), { recursive: true, mode: 0o700 })
  writeFileSync(join(jobDir(job.id), 'prompt.txt'), prompt, { mode: 0o600 })
  if (schema) writeFileSync(join(jobDir(job.id), 'schema.json'), JSON.stringify(schema), { mode: 0o600 })
  writeJob(job)
  if (access === 'workspace-write') {
    try { acquireLease(job) } catch (error) {
      rmSync(jobDir(job.id), { recursive: true, force: true })
      throw error
    }
  }
  spawnRunner(job)
  return job
}

// One writer per worktree. The lease is the directory leases/<sha256 of the worktree>, holding one
// file named for the job that owns it. A new lease is built under a private name and renamed into
// place whole, and rename(2) onto a directory that is not empty fails, so two admissions cannot
// both take it. Only a file under its owner's own name is ever moved out, and the directory is
// then removed only if still empty, so neither a release nor the takeover of a stale lease can
// remove a lease that changed hands in between.
const leaseDir = (job) => join(stateDir(), 'leases', createHash('sha256').update(job.worktree).digest('hex'))
// The holder is reconciled first: a queued job past its grace is claimed and settled, so no
// runner can start it once its lease is gone, and a running one whose runner died is settled
// after its provider group is killed. An ended job still holds the lease while its provider group
// has not read gone, so no two writers ever share a worktree.
function leaseLive(jobId) {
  const held = typeof jobId === 'string' && JOB_ID.test(jobId) ? reconcile(readJob(jobId)) : null
  return Boolean(held) && (!TERMINAL.has(held.status) || providerGroupAlive(held))
}
function dropLease(dir, owner) {
  const aside = join(dirname(dir), `.drop.${randomUUID()}`)
  try { renameSync(join(dir, owner), aside) } catch { return }
  rmSync(aside, { force: true })
  try { rmdirSync(dir) } catch {}
}
export function acquireLease(job) {
  const dir = leaseDir(job)
  const mine = join(dirname(dir), `.new.${job.id}`)
  mkdirSync(mine, { recursive: true, mode: 0o700 })
  writeFileSync(join(mine, job.id), '', { mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { renameSync(mine, dir); return } catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
      let owner
      try { owner = readdirSync(dir).find((name) => JOB_ID.test(name)) } catch { continue }
      if (!owner) continue
      if (leaseLive(owner)) fail('WORKSPACE_BUSY', `Write job ${owner} holds this worktree.`, { jobId: owner })
      dropLease(dir, owner)
    }
    fail('WORKSPACE_BUSY', 'The worktree lease is contended.')
  } finally { rmSync(mine, { recursive: true, force: true }) }
}
export function releaseLease(job) {
  if (job.access === 'workspace-write') dropLease(leaseDir(job), job.id)
}

function spawnRunner(job) {
  const child = spawn(process.execPath, [MAIN, 'run', '--job', job.id], {
    detached: true, stdio: 'ignore', env: { ...process.env, FLOW_DELEGATION_STATE_DIR: stateDir() },
  })
  child.on('error', (error) => {
    log(`runner spawn failed for ${job.id}: ${error.message}`)
    if (!claim(job.id)) return
    releaseLease(job)
    settle(job, 'failed', { error: { kind: 'INTERNAL', message: 'The job runner could not be started.' } })
  })
  child.unref()
}

// A running job whose runner is gone has an unknown outcome: nothing is left that could prove
// what the provider did. Its provider group is killed and its TMPDIR removed, and its lease is
// released only if the group already reads gone; otherwise the next takeover checks again,
// since a SIGKILL is only queued when kill(2) returns. A queued job past a
// minute is settled once this call holds its claim or the holder is dead, and left alone while a
// live runner holds it, since that runner is starting. A runner that died while starting may have
// recorded and made the TMPDIR already, so that one is removed too.
export function reconcile(job) {
  if (job?.status === 'running' && !runnerAlive(job)) {
    const again = readJob(job.id)
    if (again?.status !== 'running') return again
    signalProvider(again)
    dropTmp(again.id, again.tmpDir)
    if (!providerGroupAlive(again)) releaseLease(again)
    return settle(again, 'unknown', { error: { kind: 'RUNNER_LOST', message: 'The job runner exited without recording an outcome.' } })
  }
  if (job?.status === 'queued' && Date.now() - Date.parse(job.createdAt) > QUEUE_GRACE_MS) {
    if (!claim(job.id) && claimantAlive(job.id)) return readJob(job.id) ?? job
    const again = readJob(job.id)
    if (again?.status === 'running') return reconcile(again)
    if (again?.status !== 'queued') return again
    dropTmp(again.id, again.tmpDir)
    releaseLease(again)
    return settle(again, 'failed', { error: { kind: 'RUNNER_LOST', message: 'The job runner never started.' } })
  }
  return job
}

export function visibleJob(id, { host, roots }) {
  const job = typeof id === 'string' && JOB_ID.test(id) ? readJob(id) : null
  if (!job || job.host !== host || !roots.some((root) => inside(root, job.cwd))) {
    fail('JOB_NOT_FOUND', 'No job with that id is visible from this workspace.')
  }
  return reconcile(job)
}

export async function wait(id, seconds, { signal, onTick } = {}) {
  const deadline = Date.now() + seconds * 1000
  let job = reconcile(readJob(id))
  let checked = Date.now()
  while (job && !TERMINAL.has(job.status) && Date.now() < deadline && !signal?.aborted) {
    await sleep(250)
    job = readJob(id)
    if (Date.now() - checked > 2000) { job = reconcile(job); checked = Date.now() }
    onTick?.(job)
  }
  return job
}

// How long a job's stop and settlement can take once the stop starts, which a default wait past the
// budget and a cancel both wait out, so either returns the settled job rather than one still
// running. It bounds the runner's work, not the provider's exit: a provider group that still reads
// alive after the SIGKILL wait leaves its exit unconfirmed, and the runner settles the job and
// keeps the write lease until a takeover finds the group gone. The longest stop is the sum of: the
// provider interrupt's answer, 10 s (INTERRUPT_MS in codex-app-server.mjs and claude-control.mjs);
// SIGTERM to SIGKILL, 10 s, then the wait for the group to read gone, 10 s (both KILL_GRACE_MS in
// runner.mjs); the schema check, 10 s (CHECK_SECONDS in schema.mjs); and the provider's close, 5 s
// (CLOSE_MS in providers.mjs). That is 45 s, and 60 leaves a margin.
export const STOP_SECONDS = 60
export const requestCancel = (id) => { try { writeFileSync(join(jobDir(id), 'cancel'), '') } catch {} }
export async function cancel(job) {
  if (TERMINAL.has(job.status)) fail('JOB_STATE', `The job already ended ${job.status}.`)
  requestCancel(job.id)
  if (job.status === 'queued' && claim(job.id)) {
    releaseLease(job)
    return settle(job, 'cancelled', { error: { kind: 'CANCELLED', message: 'The job was cancelled before it started.' } })
  }
  return wait(job.id, STOP_SECONDS)
}

// A steer adds text to a running job's open turn without stopping it. Only a running job whose
// turn is open takes one: any other call is refused, and nothing is written. The request goes in
// as steer/<uuid>.json, by temp file and rename, and the runner answers with <uuid>.ack.json once
// the provider has taken it or refused it. The wait ends at that answer, when the job ends (the
// runner answers every steer it took before it writes the outcome), or after 30 seconds. A steer
// with no answer, or one the runner answered with delivered: null because the provider had neither
// taken nor refused it yet, is unknown, never delivered.
const steerDir = (id) => join(jobDir(id), 'steer')
function readAck(jobId, id) {
  try { return JSON.parse(readFileSync(join(steerDir(jobId), `${id}.ack.json`), 'utf8')) } catch { return null }
}
export async function requestSteer(input, { host, roots, signal }) {
  checkKeys(input, ['jobId', 'prompt'])
  const { prompt } = input
  if (typeof prompt !== 'string' || !prompt.trim()) fail('BAD_REQUEST', 'A steer needs a non-empty prompt.')
  if (Buffer.byteLength(prompt) > STEER_BYTES) fail('BAD_REQUEST', 'A steer prompt exceeds 64 KiB.')
  const job = visibleJob(input.jobId, { host, roots })
  if (job.status === 'queued') fail('JOB_STATE', 'The job has not started yet, so it has no turn to steer; try again in a moment.')
  if (job.status !== 'running') fail('JOB_STATE', `The job already ended ${job.status}; continue it to add a new task on its thread.`)
  if (!job.turnOpen) fail('JOB_STATE', 'The job has no open turn: its prompt has not gone out yet, or its turn has ended.')
  const id = randomUUID()
  const dir = steerDir(job.id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `.steer.${process.pid}.${randomUUID()}`)
  writeFileSync(temp, JSON.stringify({ id, prompt, at: new Date().toISOString() }), { mode: 0o600 })
  renameSync(temp, join(dir, `${id}.json`))
  const deadline = Date.now() + STEER_WAIT_MS
  let current = job
  let checked = Date.now()
  let ack = readAck(job.id, id)
  while (!ack && !TERMINAL.has(current.status) && Date.now() < deadline && !signal?.aborted) {
    await sleep(250)
    ack = readAck(job.id, id)
    current = readJob(job.id) ?? current
    if (Date.now() - checked > 2000) { current = reconcile(current); checked = Date.now() }
  }
  ack ??= readAck(job.id, id)
  const status = !ack || ack.delivered === null ? 'unknown' : ack.delivered === true ? 'delivered' : 'failed'
  return { job: readJob(job.id) ?? current, steer: { id, status, ...(ack?.error ? { error: ack.error } : {}) } }
}

// A job's record is how a takeover judges the lease that names it: a missing record reads as an
// ended holder whose group is gone. So a record whose lease is still held stays, however old,
// until the lease is released or taken over. The lease file stays the bare name it is built as;
// putting the group in it would make the runner a second writer of the lease after admission.
const leaseHeld = (job) => job?.access === 'workspace-write' && Boolean(lstatSync(join(leaseDir(job), job.id), { throwIfNoEntry: false }))
export function prune() {
  const root = join(stateDir(), 'jobs')
  let names = []
  try { names = readdirSync(root) } catch { return }
  for (const name of names.filter((entry) => JOB_ID.test(entry))) {
    const job = readJob(name)
    let ended = NaN
    try { ended = job ? (TERMINAL.has(job.status) ? Date.parse(job.endedAt) : NaN) : statSync(join(root, name)).mtimeMs } catch {}
    if (Date.now() - ended > PRUNE_MS && !leaseHeld(job)) rmSync(join(root, name), { recursive: true, force: true })
  }
}

// The last lines of the event journal, each cut to 400 characters. Only the file's tail is read,
// and a line the read began inside of is dropped.
function tail(path, count) {
  let text
  let partial
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size, 262_144)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      text = buffer.toString('utf8')
      partial = length < size
    } finally { closeSync(fd) }
  } catch { return [] }
  const lines = text.split('\n').filter(Boolean)
  if (partial) lines.shift()
  return lines.slice(-count).map((line) => (line.length > 400 ? `${line.slice(0, 399)}…` : line))
}

// catalog says whether the provider's own model catalog listed the requested model ('listed') or
// admitted an id it does not know ('absent'). isolation is what the provider's live session read
// back, and promptSent says whether the prompt ever left the runner: a job refused before it has
// no provider turn to explain. steers lists every steer the runner answered, in order.
export function envelope(job, events = 0) {
  const { id, host, target, mode, access, cwd, model, effort, status, createdAt, endedAt, threadId, parentJobId,
    requestPreview, baseSha, headSha, servedModel, catalog, isolation, promptSent, steers, output, structured, commandFailures, error } = job
  const eventsPath = join(jobDir(id), 'events.jsonl')
  return { id, host, target, mode, access, cwd, model, effort, status, createdAt, endedAt, threadId, parentJobId,
    requestPreview, baseSha, headSha, servedModel, catalog, isolation, promptSent, steers, output, structured, commandFailures, error, eventsPath,
    events: events ? tail(eventsPath, events) : [] }
}
