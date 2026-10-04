#!/usr/bin/env node
// The T3 seat executor: it opens a seat's record before the parent's delegate_task call and closes
// the seat with the one verdict the parent acts on.
//
//   seat.mjs open --access read-only|workspace-write|review --provider claude|codex --model <id>
//                 --effort <level> [--worktree <abs>] [--base <rev> --head <rev>] [--schema <file>]
//   seat.mjs close <seat-id> --task-status <json>
//
// stdout is one JSON line. open prints {ok: true, id, tag, runtimeMode, provider, model, effort,
// worktree, reviewWorktree}, close prints {ok: true, id, verdict, reasons, turn, result,
// servedModels, blocks, errors}, and a refusal prints {ok: false, error: {kind, message,
// details?}} with exit 1. The kinds are BAD_REQUEST, BAD_SCHEMA, GIT_REF, WORKSPACE_BUSY and,
// for anything this script did not expect, INTERNAL.
//
// open, in this order: prune closed records past retention; find the repository from --worktree,
// or the working directory, and its canonical checkout, the main worktree; for a review, resolve
// --base and --head to commit SHAs where --worktree (or the working directory) resolves them and
// add a detached worktree at the head under <canonical>/.flow-worktrees/review-<id>, the seat's
// worktree, with the findings schema as its answer schema; for a writer, hold the worktree's
// write lease directory (below); for a review, snapshot the canonical checkout with
// tree-snapshot.mjs; then write the schema and the record, last, through lib/seat-store.mjs. A
// failure undoes whatever this run created, the review worktree and the lease holder, so a refused
// open leaves nothing behind.
//
// The lease. A writer seat and a flow_delegate write job never share a worktree. open refuses when
// a live write job owns the lease directory delegate/jobs.mjs keys by the worktree, writes its
// holder file <leaseDirOf(worktree)>/<id> there, and then reads the directory again and backs out
// if a live job owner appeared meanwhile. acquireLease refuses a write job while a holder's seat
// has no closed stamp, so whichever of the two writes first, the other sees it. Writer seats
// share a worktree with each other, each committing its own paths, as native writers do.
//
// close judges the seat from its record and the stamps and results the hooks wrote, in this
// order of precedence, the first that holds being the verdict:
//   unknown         no readable record; a void stamp; no admitted, bound or receipt stamp; a
//                   record whose bytes no longer match the digest the bind pinned; no Stop on
//                   record; or a last stop that was valid with no intact result for its turn, or
//                   with no served model on record
//   model-mismatch  a model the hooks saw serving the seat, at the bind or in the result, is not
//                   the record's
//   tree-moved      for a review: the review worktree's HEAD left the head SHA or its tree is
//                   dirty, the canonical checkout's snapshot changed, or the coverage (read,
//                   partial and unopened together) misses a file in `git diff --name-only base
//                   head`, the last only when there is an envelope to read it from
//   capped          the last turn was capped
//   invalid         the last stop in the last turn was blocked
//   valid           otherwise; result is the envelope Stop recorded
// It writes the closed stamp first, with the verdict, the reasons and the task status the parent
// read from T3, then drops the writer's lease holder and removes the review worktree it created.
// The stamp is write-once, so a second close, or a racing one, prints the verdict on record and
// retries the cleanup. Cleanup that fails is listed in cleanupProblems and does not change the
// verdict.
//
// git runs with no GIT_* variable from the caller and no user or system configuration, as in
// delegate/jobs.mjs, so neither the caller's environment nor a config file decides which
// repository answers or what a revision means.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dropLease, JOB_ID, leaseDirOf, leaseLive } from '../delegate/jobs.mjs'
import { FINDINGS_SCHEMA, outputSchemaProblem } from '../delegate/schema.mjs'
import * as store from '../lib/seat-store.mjs'
import { inside } from '../lib/state-dir.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TREE_SNAPSHOT = join(HERE, 'tree-snapshot.mjs')
const ACCESS = ['read-only', 'workspace-write', 'review']
const PROVIDERS = ['claude', 'codex']
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@+/[\]-]{0,127}$/
const EFFORT = /^[a-z][a-z0-9-]{0,31}$/
const SEAT_ID = /^[0-9a-f]{32}$/
const SCHEMA_BYTES = 16 * 1024
const TASK_STATUS_BYTES = 64 * 1024
const GIT_MS = 60_000
const RUNTIME_MODE = 'auto'

class SeatError extends Error {
  constructor(kind, message, details) { super(message); this.kind = kind; this.details = details }
}
const fail = (kind, message, details) => { throw new SeatError(kind, message, details) }

// ----- git

const gitEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
})
function git(cwd, args) {
  const run = spawnSync('git', ['-C', cwd, ...args], { env: gitEnv(), encoding: 'utf8', timeout: GIT_MS, maxBuffer: 1 << 28 })
  return { ok: run.status === 0, stdout: run.stdout ?? '', stderr: String(run.stderr ?? '').trim().split('\n')[0] }
}
const gitLine = (cwd, args) => {
  const run = git(cwd, args)
  return run.ok ? run.stdout.trim() : null
}

// The canonical checkout's four digests, or null when tree-snapshot cannot take them.
function snapshot(path) {
  const run = spawnSync(process.execPath, [TREE_SNAPSHOT, path], { env: gitEnv(), encoding: 'utf8', timeout: GIT_MS, maxBuffer: 1 << 20 })
  if (run.status !== 0) return null
  try { return JSON.parse(run.stdout) } catch { return null }
}
const sameSnapshot = (a, b) => ['status', 'diff', 'cached', 'untracked'].every((key) => typeof a?.[key] === 'string' && a[key] === b?.[key])

// ----- arguments

function flags(argv, names) {
  const out = {}
  for (let at = 0; at < argv.length; at += 2) {
    const name = argv[at]
    if (!names.includes(name)) fail('BAD_REQUEST', `Unknown argument: ${String(name).slice(0, 64)}.`)
    if (Object.hasOwn(out, name)) fail('BAD_REQUEST', `${name} is given twice.`)
    if (at + 1 >= argv.length) fail('BAD_REQUEST', `${name} needs a value.`)
    out[name] = argv[at + 1]
  }
  return out
}

function readSchema(path) {
  if (!isAbsolute(path)) fail('BAD_SCHEMA', '--schema must be an absolute path.')
  let bytes
  try { bytes = readFileSync(path) } catch { fail('BAD_SCHEMA', '--schema names no readable file.') }
  if (bytes.length > SCHEMA_BYTES) fail('BAD_SCHEMA', '--schema is over 16 KiB.')
  let schema
  try { schema = JSON.parse(bytes.toString('utf8')) } catch { fail('BAD_SCHEMA', '--schema is not JSON.') }
  const problem = outputSchemaProblem(schema)
  if (problem) fail('BAD_SCHEMA', `--schema: ${problem.replace(/^outputSchema:? ?/, '')}`)
  return schema
}

// ----- open

// The worktree a path is in (its top level, as a realpath) and the repository's canonical
// checkout, the main worktree, whose .git directory is the common one.
function repository(start) {
  let real
  try {
    real = realpathSync(start)
    if (!statSync(real).isDirectory()) throw new Error('not a directory')
  } catch { fail('BAD_REQUEST', `${start === process.cwd() ? 'The working directory' : '--worktree'} is not an existing directory.`) }
  const top = gitLine(real, ['rev-parse', '--show-toplevel'])
  const common = gitLine(real, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!top || !common) fail('BAD_REQUEST', 'The seat\'s directory is not inside a Git worktree.')
  if (basename(common) !== '.git') fail('BAD_REQUEST', 'The repository has no main worktree to call its canonical checkout.')
  return { top: realpathSync(top), repoRoot: realpathSync(dirname(common)) }
}

function commit(cwd, name, ref) {
  if (typeof ref !== 'string' || ref === '' || ref.startsWith('-')) fail('GIT_REF', `${name} must be a Git revision.`)
  const sha = gitLine(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
  return sha || fail('GIT_REF', `${name} ${ref.slice(0, 80)} does not resolve to a commit.`)
}

// The lease directory's live job owner, or null.
function liveJob(dir) {
  let names = []
  try { names = readdirSync(dir) } catch {}
  const owner = names.find((name) => JOB_ID.test(name))
  return owner && leaseLive(owner) ? owner : null
}

// Write this seat's holder file into the worktree's lease directory, unless a live write job
// holds it, and back out if one took it while the holder went in.
function holdWorktree(worktree, id) {
  const dir = leaseDirOf(worktree)
  const busy = (jobId) => fail('WORKSPACE_BUSY', `Write job ${jobId} holds this worktree.`, { jobId })
  const before = liveJob(dir)
  if (before) busy(before)
  for (let attempt = 0; ; attempt++) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      writeFileSync(join(dir, id), '', { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      // A job's release removes the directory once it is empty, which can land between the two.
      if (error.code !== 'ENOENT' || attempt >= 4) throw error
    }
  }
  const after = liveJob(dir)
  if (after) {
    dropLease(dir, id)
    busy(after)
  }
}

function open(argv) {
  const opts = flags(argv, ['--access', '--provider', '--model', '--effort', '--worktree', '--base', '--head', '--schema'])
  const access = opts['--access']
  const provider = opts['--provider']
  const model = opts['--model']
  const effort = opts['--effort']
  if (!ACCESS.includes(access)) fail('BAD_REQUEST', `--access must be one of ${ACCESS.join(', ')}.`)
  if (!PROVIDERS.includes(provider)) fail('BAD_REQUEST', `--provider must be one of ${PROVIDERS.join(', ')}.`)
  if (typeof model !== 'string' || !MODEL.test(model)) fail('BAD_REQUEST', '--model must be a model id.')
  if (typeof effort !== 'string' || !EFFORT.test(effort)) fail('BAD_REQUEST', '--effort must be an effort level.')
  const review = access === 'review'
  if (opts['--worktree'] !== undefined && !isAbsolute(opts['--worktree'])) fail('BAD_REQUEST', '--worktree must be an absolute path.')
  if (access === 'workspace-write' && opts['--worktree'] === undefined) fail('BAD_REQUEST', 'A workspace-write seat names its --worktree.')
  if (review && (opts['--base'] === undefined || opts['--head'] === undefined)) fail('GIT_REF', 'A review seat names --base and --head.')
  if (!review && (opts['--base'] !== undefined || opts['--head'] !== undefined)) fail('BAD_REQUEST', '--base and --head apply to a review seat only.')
  if (review && opts['--schema'] !== undefined) fail('BAD_SCHEMA', 'A review seat answers in the findings schema and takes no --schema.')
  const schema = review ? FINDINGS_SCHEMA : opts['--schema'] === undefined ? null : readSchema(opts['--schema'])

  const id = store.newId()
  store.pruneSeats()
  const { top, repoRoot } = repository(opts['--worktree'] ?? process.cwd())
  const undo = []
  try {
    let worktree = top
    let reviewWorktree = null
    let baseSha = null
    let headSha = null
    let canonicalSnapshot = null
    if (review) {
      baseSha = commit(top, '--base', opts['--base'])
      headSha = commit(top, '--head', opts['--head'])
      const path = join(repoRoot, '.flow-worktrees', `review-${id}`)
      const added = git(repoRoot, ['worktree', 'add', '--detach', path, headSha])
      if (!added.ok) fail('GIT_REF', `The review worktree could not be added: ${added.stderr.slice(0, 200)}`)
      undo.push(() => git(repoRoot, ['worktree', 'remove', '--force', path]))
      reviewWorktree = realpathSync(path)
      worktree = reviewWorktree
    }
    if (access === 'workspace-write') {
      holdWorktree(worktree, id)
      undo.push(() => dropLease(leaseDirOf(worktree), id))
    }
    if (review) {
      canonicalSnapshot = snapshot(repoRoot)
      if (!canonicalSnapshot) fail('GIT_REF', 'The canonical checkout could not be snapshotted.')
    }
    store.writeRecord({
      v: 1, id, createdAt: new Date().toISOString(), access, repoRoot, worktree, reviewWorktree, baseSha, headSha,
      provider, model, effort, runtimeMode: RUNTIME_MODE, canonicalSnapshot, hooksDigest: null,
    }, schema)
    return { ok: true, id, tag: store.seatTag(id), runtimeMode: RUNTIME_MODE, provider, model, effort, worktree, reviewWorktree }
  } catch (error) {
    for (const step of undo.reverse()) { try { step() } catch {} }
    throw error
  }
}

// ----- close

const STAMPS = ['admitted', 'bound', 'receipt']

// A coverage entry as a path relative to the review worktree: `./a`, `a` and `<worktree>/a` are
// one file.
function covered(envelope, worktree) {
  const lists = ['read', 'partial', 'unopened'].flatMap((key) => envelope?.coverage?.[key] ?? [])
  return new Set(lists.filter((entry) => typeof entry === 'string').map((entry) => {
    const path = isAbsolute(entry) && inside(worktree, entry) ? relative(worktree, entry) : entry
    return path.replace(/^(?:\.\/)+/, '').split(sep).join('/')
  }))
}

function treeReasons(record, envelope) {
  const reasons = []
  const at = record.reviewWorktree
  const head = typeof at === 'string' ? gitLine(at, ['rev-parse', '--verify', 'HEAD']) : null
  if (head !== record.headSha) reasons.push(head ? `the review worktree's HEAD is ${head}, not the head ${record.headSha}` : 'the review worktree\'s HEAD could not be read')
  const status = typeof at === 'string' ? git(at, ['status', '--porcelain', '--untracked-files=all']) : { ok: false }
  if (!status.ok) reasons.push('the review worktree\'s status could not be read')
  else if (status.stdout.trim() !== '') reasons.push('the review worktree is dirty')
  const now = snapshot(record.repoRoot)
  if (!now) reasons.push('the canonical checkout could not be snapshotted')
  else if (!sameSnapshot(now, record.canonicalSnapshot)) reasons.push('the canonical checkout changed while the seat ran')
  if (envelope && typeof at === 'string') {
    const diff = git(at, ['diff', '--no-ext-diff', '--name-only', '-z', record.baseSha, record.headSha])
    if (!diff.ok) reasons.push('the pinned diff\'s file list could not be read')
    else {
      const seen = covered(envelope, at)
      const missing = diff.stdout.split('\0').filter(Boolean).filter((file) => !seen.has(file))
      if (missing.length > 0) reasons.push(`the coverage misses ${missing.length} file(s) in the pinned diff: ${missing.slice(0, 10).join(', ')}`)
    }
  }
  return reasons
}

// The verdict, its reasons, and what the output reports from the seat's files. The facts are read
// whatever the verdict, so a second close, which prints the verdict on record, reports them too.
function judge(id, loaded) {
  const facts = { turn: null, envelope: null, servedModels: [], blocks: 0, errors: [] }
  const unknown = (reason) => ({ verdict: 'unknown', reasons: [reason], facts })
  if (!loaded) return unknown('the seat record is missing or corrupt')
  const { record, digest } = loaded
  const voided = store.readStamp(id, 'void')
  if (voided) return unknown(`the seat is void: ${String(voided.reason ?? 'no reason recorded').slice(0, 120)}`)
  for (const name of STAMPS) if (!store.readStamp(id, name)) return unknown(`the ${name} stamp is missing`)
  const bound = store.readStamp(id, 'bound')
  if (bound.recordDigest !== digest) return unknown('the record changed after the bind')
  const state = store.readState(id)
  if (!state || !Number.isSafeInteger(state.turn) || state.turn < 1) return unknown('no Stop was recorded, so there is no result')
  facts.turn = state.turn
  facts.blocks = Number.isSafeInteger(state.blocks) ? state.blocks : 0
  facts.errors = Array.isArray(state.errors) ? state.errors : []
  let envelope = null
  if (state.outcome === 'valid') {
    const result = store.readResult(id, state.turn)
    if (!result) return unknown(`turn ${state.turn} has no result`)
    if (!result.intact) return unknown(`turn ${state.turn}'s result does not match its recorded sha256`)
    const served = result.body?.servedModels
    if (!Array.isArray(served) || served.length === 0) return unknown(`turn ${state.turn}'s result names no served model`)
    facts.servedModels = served
    envelope = result.body.envelope
    facts.envelope = envelope
  } else if (state.outcome !== 'blocked' && state.outcome !== 'capped') {
    return unknown(`turn ${state.turn} has no result`)
  }
  const seen = [...(typeof bound.model === 'string' ? [bound.model] : []), ...facts.servedModels]
  const others = [...new Set(seen.filter((model) => model !== record.model))]
  if (others.length > 0) {
    return { verdict: 'model-mismatch', reasons: [`served by ${others.map((model) => String(model).slice(0, 80)).join(', ')}, not ${record.model}`], facts }
  }
  if (record.access === 'review') {
    const reasons = treeReasons(record, envelope)
    if (reasons.length > 0) return { verdict: 'tree-moved', reasons, facts }
  }
  if (state.outcome === 'capped') return { verdict: 'capped', reasons: [`turn ${state.turn} was blocked ${facts.blocks} times and then let stop`], facts }
  if (state.outcome === 'blocked') return { verdict: 'invalid', reasons: [`turn ${state.turn}'s last final message failed the envelope or the schema`], facts }
  return { verdict: 'valid', reasons: [], facts }
}

function cleanup(id, record) {
  const problems = []
  if (!record) return problems
  if (record.access === 'workspace-write' && typeof record.worktree === 'string') dropLease(leaseDirOf(record.worktree), id)
  const path = typeof record.repoRoot === 'string' ? join(record.repoRoot, '.flow-worktrees', `review-${id}`) : null
  if (record.access === 'review' && path && record.reviewWorktree === path && existsSync(path)) {
    const removed = git(record.repoRoot, ['worktree', 'remove', '--force', path])
    if (!removed.ok) problems.push(`the review worktree could not be removed: ${removed.stderr.slice(0, 200)}`)
  }
  return problems
}

function close(argv) {
  const [id, ...rest] = argv
  if (typeof id !== 'string' || !SEAT_ID.test(id)) fail('BAD_REQUEST', 'close takes a seat id, 32 lowercase hex characters.')
  const opts = flags(rest, ['--task-status'])
  const text = opts['--task-status']
  if (text === undefined) fail('BAD_REQUEST', 'close needs --task-status, the task_status answer for the seat\'s task, as JSON.')
  if (Buffer.byteLength(text) > TASK_STATUS_BYTES) fail('BAD_REQUEST', '--task-status is over 64 KiB.')
  let taskStatus
  try { taskStatus = JSON.parse(text) } catch { fail('BAD_REQUEST', '--task-status is not JSON.') }

  const loaded = store.readRecord(id)
  const judged = judge(id, loaded)
  let { verdict, reasons } = judged
  if (!store.stamp(id, 'closed', { verdict, reasons, taskStatus })) {
    // An earlier or racing close holds the stamp, and its verdict stands; or the record
    // directory is gone, and nothing can be recorded.
    const recorded = store.readStamp(id, 'closed')
    if (recorded) ({ verdict, reasons } = recorded)
  }
  const { facts } = judged
  const out = {
    ok: true, id, verdict, reasons, turn: facts.turn, result: verdict === 'valid' ? facts.envelope : null,
    servedModels: facts.servedModels, blocks: facts.blocks, errors: facts.errors,
  }
  const problems = cleanup(id, loaded?.record ?? null)
  if (problems.length > 0) out.cleanupProblems = problems
  return out
}

// ----- main

const USAGE = 'usage: seat.mjs open --access <read-only|workspace-write|review> --provider <claude|codex> --model <id> --effort <level> [--worktree <abs>] [--base <rev> --head <rev>] [--schema <file>] | seat.mjs close <seat-id> --task-status <json>'
const [verb, ...argv] = process.argv.slice(2)
let answer
try {
  if (verb === 'open') answer = open(argv)
  else if (verb === 'close') answer = close(argv)
  else fail('BAD_REQUEST', USAGE)
} catch (error) {
  answer = error instanceof SeatError
    ? { ok: false, error: { kind: error.kind, message: error.message, ...(error.details ? { details: error.details } : {}) } }
    : { ok: false, error: { kind: 'INTERNAL', message: `seat.mjs ${String(verb).slice(0, 16)} failed unexpectedly: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}` } }
}
process.stdout.write(`${JSON.stringify(answer)}\n`)
process.exitCode = answer.ok ? 0 : 1
