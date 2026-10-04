#!/usr/bin/env node
// The T3 seat executor: it opens a seat's record before the parent's delegate_task call, closes
// the seat with the one verdict the parent acts on, and reads or grants Codex's trust in flow's
// own Codex hooks.
//
//   seat.mjs open --access read-only|workspace-write|review --provider claude|codex --model <id>
//                 --effort <level> [--worktree <abs>] [--base <rev> --head <rev>] [--schema <file>]
//   seat.mjs close <seat-id> --task-status <json>
//   seat.mjs close <seat-id> --abandon
//   seat.mjs trust [--write --expect <digest>]
//
// stdout is one JSON line. open prints {ok: true, id, tag, clientRequestId, runtimeMode, provider,
// model, effort, worktree, reviewWorktree}, close prints {ok: true, id, verdict, reasons, turn, result,
// servedModels, blocks, errors, cleanupProblems?}, with or without --abandon, trust prints {ok: true, keys: [{key, command, trustStatus,
// currentHash}], digest, wrote}, and a refusal prints {ok: false, error: {kind, message,
// details?}} with exit 1. The kinds are BAD_REQUEST, BAD_SCHEMA, GIT_REF, WORKSPACE_BUSY and
// HOOKS_UNTRUSTED from open; BAD_REQUEST, TASK_NOT_TERMINAL and TASK_MISMATCH from close; BAD_REQUEST,
// HOOKS_MISMATCH, HOOKS_CHANGED, HOOKS_UNTRUSTED, PROVIDER_NOT_INSTALLED and the Codex App
// Server's own failure kinds (PROVIDER_ERROR, PROVIDER_AUTH, TIMEOUT) from trust; and, for
// anything this script did not expect, INTERNAL.
//
// open, in this order: prune closed records past retention; find the repository from --worktree,
// or the working directory, and its canonical checkout, the main worktree; for a review, resolve
// --base and --head to commit SHAs where --worktree (or the working directory) resolves them and
// add a detached worktree at the head under <canonical>/.flow-worktrees/review-<id>, the seat's
// worktree, recording its admin directory (`git rev-parse --absolute-git-dir` there) as
// reviewGitDir, with the findings schema as its answer schema; for a Codex seat, read flow's Codex
// hook trust (below) and refuse with HOOKS_UNTRUSTED unless every flow hook is there, enabled and
// trusted, recording the digest of the keys and hashes it read as hooksDigest; for a writer, hold
// the worktree's write lease directory (below); for a review, snapshot the canonical checkout
// with tree-snapshot.mjs and add its HEAD commit and the branch HEAD names; then write the schema and the record, last, through lib/seat-store.mjs. Before the holder, open builds the seat's context as the prompt hook will (with the real schema.json path) and refuses BAD_REQUEST when the paths make it past the 6000-byte hook budget even with the schema left out by path.
// A failure undoes whatever this run created, the review worktree and the lease holder, so a
// refused open leaves nothing behind, with one exception under The lease.
//
// The lease. A writer seat and a flow_delegate write job never share a worktree. open refuses when
// a live write job owns the lease directory delegate/jobs.mjs keys by the worktree, writes its
// pending holder file <leaseDirOf(worktree)>/<id> there, and then reads the directory again and
// backs out if a live job owner appeared meanwhile. acquireLease refuses a write job while a
// holder's seat has no closed stamp, so whichever of the two writes first, the other sees it. A
// pending holder whose seat has no record is an open in flight for a minute after its write, and
// after that acquireLease may take it over as the leftover of an open that died before its record,
// by renaming it. So nothing slow runs between the holder and the record (the Codex trust read
// comes first), and once the record is written open renames its holder to <id>.live, the holder
// no job takes over. Of the two renames of the pending holder, exactly one finds the file. If the
// job's came first, open voids the record it wrote, closes it as unknown so it is pruned like any
// closed record, and refuses WORKSPACE_BUSY. Writer seats share a worktree with each other, each
// committing its own paths, as native writers do.
//
// close first refuses TASK_NOT_TERMINAL, writing nothing, unless --task-status is a task_status
// answer T3 gives for a finished task: an object whose status is completed, failed, cancelled or
// interrupted, whose workState is not working or waiting_for_children, and whose
// hasPendingChildRuns is not true. A writer's lease stays held until then. Once the seat was
// admitted, close also refuses TASK_MISMATCH, writing nothing, unless the task status's taskId
// carries flow-seat-<id>, the clientRequestId the admitted call named, plainly or URL-encoded, so
// one seat is never closed on another task's status. It then judges the seat
// from its record and the stamps and results the hooks wrote, in this order of precedence, the
// first that holds being the verdict:
//   unknown         no readable record; a void stamp; no admitted, bound or receipt stamp; a
//                   record whose bytes no longer match the digest the bind pinned; a bound
//                   session whose index entry is void (session-index-void) or missing or names
//                   another seat (session-index-mismatch); no Stop on record; a turn a prompt
//                   opened after the bind with no stop on record (turn-without-result); a last
//                   stop that was valid with no intact result for its turn, or with a result that
//                   names no served model; or no served model on record from any stop
//   model-mismatch  a model the hooks saw serving the seat, at the bind or at any stop in any
//                   turn (Stop keeps them as one set in the turn state), is not the record's
//   tree-moved      for a review: the review worktree's HEAD left the head SHA or its tree is
//                   dirty, the canonical checkout's snapshot, HEAD commit or branch changed, or
//                   the coverage (read,
//                   partial and unopened together) misses a file in `git diff --name-only base
//                   head`, the last only when there is an envelope to read it from
//   capped          the last turn was capped
//   invalid         the last stop in the last turn was blocked
//   valid           otherwise; result is the envelope Stop recorded
// It writes the closed stamp first, with the verdict, the reasons, the task status the parent
// read from T3, and the facts the output reports: the turn, the sha256 of that turn's result bytes
// as judge read them (null with no result), the served models, the blocks and the errors. It
// then drops the writer's lease holder and removes the review worktree it created, only while the
// path still resolves to the recorded worktree, its admin directory is still reviewGitDir, and
// `git worktree list` still lists it; a worktree that is not the one open added is left in place
// and reported. The stamp is
// write-once and is the record, so a second close, or a racing one, prints the stamp's verdict
// and facts, with the result read again from the pinned turn: that result while its bytes still
// hash to the pinned sha256, and otherwise null, with result-changed-after-close among the
// reasons and the verdict unchanged. It also retries the cleanup. Cleanup that fails is listed in
// cleanupProblems and does not change the verdict.
//
// close --abandon closes a seat whose delegate_task call made no task: T3 refused or lost the call
// after the parent's PreToolUse admitted it, so no task_status will ever name the seat, and close
// with one could never run. It takes no --task-status, and refuses BAD_REQUEST, writing nothing,
// once the seat has a bound stamp: a bound seat's child ran, so it closes with its task status.
// Otherwise it writes the closed stamp with verdict unknown, reasons ['abandoned-before-bind'] and
// abandoned: true, then reads the bound stamp again, and with none it drops the writer's lease
// holder and removes the review worktree as close does. A bind refuses a record with a closed stamp
// (record-closed), so a child that starts after that is a void seat. A bind reads the closed stamp
// before it writes its bound stamp, and that order against abandon's makes a racing bind safe either
// way:
//   - the bound stamp lands after abandon's second read. The closed stamp was on disk before it,
//     and the child's tool calls all come after its bind, so the closed-seat rule denies every one
//     and nothing of the child's runs under the dropped holder.
//   - the bound stamp lands before abandon's second read. A call of the child may have passed
//     before the closed stamp, so the child may still be working. Abandon reports reasons
//     ['abandon-raced-bind'], keeps the holder and the review worktree, and lists them in
//     cleanupProblems. delegate/jobs.mjs holds a holder of an abandoned seat with a bound stamp, and
//     close with the task's status, once T3 reports it finished, prints the abandon on record and
//     drops it.
// Any later close of an abandoned seat prints abandon-raced-bind whenever the seat has a bound stamp.
//
// trust. Codex skips a hook it does not trust without a word, and keys its trust by position,
// `<plugin>:hooks/codex.json:<event>:<group>:<handler>`, with a hash of the command. trust spawns
// `codex app-server --stdio` (the codex on PATH, absolute entries only, through
// delegate/codex-app-server.mjs's JSON-RPC peer), initializes, and reads hooks/list for the
// canonical checkout of the working directory. Flow's keys are the plugin-source entries for which
// all of these hold:
//   - the pluginId is flow@<marketplace>, the marketplace this copy of flow came from. A plugin
//     manager installs flow at <home>/plugins/cache/<marketplace>/flow/<version> (Claude Code and
//     Codex alike), so a copy there reads the marketplace from its own path; a source checkout
//     reads the name from the manifest of the marketplace repository whose plugins/flow it is.
//     A copy that is neither names no id, and trust fails HOOKS_MISMATCH rather than guess one.
//   - the command is one of the handler commands in hooks/codex.json with ${PLUGIN_ROOT} standing
//     for one plugin root (Codex reports each command with the root already expanded, 0.160.0),
//     the sourcePath is that root's hooks/codex.json, and that file's bytes are this copy's
//     hooks/codex.json's bytes.
// The root is not this copy's: Claude Code and Codex each install their own copy of flow, so the
// Claude copy's seat.mjs reads and writes the trust of the copy Codex installed, which carries the
// same hooks file whenever both hosts carry one version. Another plugin id is not flow, whatever its
// commands and hooks file look like, so trust never reads or writes it. All of the keys must come
// from one root, there must be exactly one per handler, and each key must start
// <pluginId>:hooks/codex.json:, or trust fails HOOKS_MISMATCH, which is what an install older or
// newer than this copy of flow reads as.
// A plain trust prints the keys and their digest, the sha256 of the sorted [key, currentHash]
// pairs as JSON, which is also what open records as hooksDigest. The human grants trust to what
// they were shown, so --write takes that digest as --expect: it lists the keys again and fails
// HOOKS_CHANGED, writing nothing, unless their digest is the expected one. It then upserts those
// keys, and no other, into hooks.state with config/batchWrite, each as {trusted_hash: <its
// currentHash>}, reads hooks/list again, and fails HOOKS_UNTRUSTED unless every one reads
// trusted. A user's, a project's or another plugin's hook is never written.
//
// git runs with no GIT_* variable from the caller and no user or system configuration, as in
// delegate/jobs.mjs, so neither the caller's environment nor a config file decides which
// repository answers or what a revision means.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from '../delegate/codex-app-server.mjs'
import { dropLease, JOB_ID, leaseDirOf, leaseLive } from '../delegate/jobs.mjs'
import { findExecutable } from '../delegate/providers.mjs'
import { FINDINGS_SCHEMA, outputSchemaProblem } from '../delegate/schema.mjs'
import { plainShellWord, seatContext } from '../lib/seat-policy.mjs'
import * as store from '../lib/seat-store.mjs'
import { inside } from '../lib/state-dir.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TREE_SNAPSHOT = join(HERE, 'tree-snapshot.mjs')
const CODEX_HOOKS = join(HERE, '..', 'hooks', 'codex.json')
const PLUGIN_ROOT = realpathSync(join(HERE, '..'))
const VERSION = JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version
const CLOSE_MS = 5_000
const ACCESS = ['read-only', 'workspace-write', 'review']
const PROVIDERS = ['claude', 'codex']
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@+/[\]-]{0,127}$/
const EFFORT = /^[a-z][a-z0-9-]{0,31}$/
const SEAT_ID = /^[0-9a-f]{32}$/
const DIGEST = /^[0-9a-f]{64}$/
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
// The canonical checkout as a review pins it: the four digests, the HEAD commit (null when unborn)
// and the branch HEAD names (null when detached), or null when tree-snapshot cannot take them.
function canonicalState(path) {
  const digests = snapshot(path)
  if (!digests) return null
  return { ...digests, head: gitLine(path, ['rev-parse', '--verify', '--quiet', 'HEAD']), branch: gitLine(path, ['symbolic-ref', '--quiet', 'HEAD']) }
}

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

// Turn this seat's pending holder live, once its record is written. False when the holder is gone:
// a write job took it over as abandoned first. The rename is the one step both sides race on.
function holdLive(worktree, id) {
  const dir = leaseDirOf(worktree)
  try { renameSync(join(dir, id), join(dir, `${id}.live`)) } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  return true
}

// The clientRequestId a seat's delegate_task call carries, which T3 builds the task id from.
const clientRequestIdOf = (id) => `flow-seat-${id}`

async function open(argv) {
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
  store.pruneSeats(Date.now(), dropHolders)
  const { top, repoRoot } = repository(opts['--worktree'] ?? process.cwd())
  if (access === 'workspace-write' && !plainShellWord(realpathSync.native(top))) {
    fail('BAD_REQUEST', 'A writer\'s worktree path must be a plain shell word (letters, digits and _ . / : @ + , -), because its git writes name it unquoted after -C. Use a worktree under such a path.')
  }
  const undo = []
  try {
    let worktree = top
    let reviewWorktree = null
    let reviewGitDir = null
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
      const gitDir = gitLine(reviewWorktree, ['rev-parse', '--absolute-git-dir'])
      if (!gitDir) fail('GIT_REF', 'The review worktree\'s git directory could not be read.')
      reviewGitDir = realpathSync(gitDir)
      worktree = reviewWorktree
    }
    // The trust read can take a minute, so it comes before the holder: nothing slow may sit between
    // the holder and the record (see The lease, above).
    const digest = provider === 'codex' ? await seatTrust(repoRoot) : null
    const record = {
      v: 1, id, createdAt: new Date().toISOString(), access, repoRoot, worktree, reviewWorktree, reviewGitDir, baseSha, headSha,
      provider, model, effort, runtimeMode: RUNTIME_MODE, canonicalSnapshot: null, hooksDigest: digest,
    }
    // The seat's context repeats its paths, and the prompt hook cannot deliver one past the hook
    // budget, so a seat whose context cannot fit is refused here, before the holder and the record.
    try { seatContext(record, schema, join(store.seatDir(id), 'schema.json')) } catch (error) {
      if (error.code !== 'CONTEXT_TOO_LONG') throw error
      fail('BAD_REQUEST', 'The seat\'s paths make its context longer than the 6000-byte hook budget; use shorter paths.')
    }
    if (access === 'workspace-write') {
      holdWorktree(worktree, id)
      undo.push(() => dropLease(leaseDirOf(worktree), id))
    }
    if (review) {
      canonicalSnapshot = canonicalState(repoRoot)
      if (!canonicalSnapshot) fail('GIT_REF', 'The canonical checkout could not be snapshotted.')
    }
    store.writeRecord({ ...record, canonicalSnapshot }, schema)
    if (access === 'workspace-write' && !holdLive(worktree, id)) {
      const reason = 'a write job took the lease holder over as abandoned before the record was written'
      store.stamp(id, 'void', { reason: 'lease-lost-at-open' })
      store.stamp(id, 'closed', { verdict: 'unknown', reasons: [reason], taskStatus: null, turn: null, resultSha256: null, servedModels: [], blocks: 0, errors: [] })
      fail('WORKSPACE_BUSY', `This open stalled for over a minute, so ${reason}, and a write job may hold the worktree now.`)
    }
    return { ok: true, id, tag: store.seatTag(id), clientRequestId: clientRequestIdOf(id), runtimeMode: RUNTIME_MODE, provider, model, effort, worktree, reviewWorktree }
  } catch (error) {
    for (const step of undo.reverse()) { try { step() } catch {} }
    throw error
  }
}

// ----- trust

// Each handler command in hooks/codex.json, as a pattern in which ${PLUGIN_ROOT} matches a root.
function flowHandlers() {
  const handlers = []
  const events = JSON.parse(readFileSync(CODEX_HOOKS, 'utf8')).hooks
  for (const groups of Object.values(events)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        if (handler.type !== 'command') continue
        const parts = handler.command.split('${PLUGIN_ROOT}').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        handlers.push({ command: handler.command, pattern: new RegExp(`^${parts.join('(.+)')}$`) })
      }
    }
  }
  return handlers
}

const realOrSelf = (path) => { try { return realpathSync(path) } catch { return path } }

// The plugin id Codex gives this copy of flow, flow@<marketplace>, read from where the copy sits.
function ownPluginId() {
  const parts = PLUGIN_ROOT.split(sep)
  const at = parts.length - 5
  if (at >= 0 && parts[at] === 'plugins' && parts[at + 1] === 'cache' && parts[at + 2] !== '' && parts[at + 3] === 'flow') return `flow@${parts[at + 2]}`
  const repo = dirname(dirname(PLUGIN_ROOT))
  let manifest = null
  try { manifest = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8')) } catch {}
  const entry = Array.isArray(manifest?.plugins) ? manifest.plugins.find((plugin) => plugin?.name === 'flow') : undefined
  if (typeof manifest?.name === 'string' && manifest.name !== '' && typeof entry?.source === 'string' && realOrSelf(join(repo, entry.source)) === PLUGIN_ROOT) return `flow@${manifest.name}`
  fail('HOOKS_MISMATCH', 'This copy of flow is neither in a plugin cache nor the flow of a marketplace repository, so it cannot name the plugin id whose hooks are flow\'s.')
}

// Whether the file at path holds exactly the bytes own does, read once per path.
function sameBytes(path, own, seen) {
  if (!seen.has(path)) {
    let same = false
    try { same = statSync(path).isFile() && readFileSync(path).equals(own) } catch {}
    seen.set(path, same)
  }
  return seen.get(path)
}

// Flow's entries in a hooks/list answer: one per handler, from this copy's plugin id and one root
// whose hooks/codex.json is byte for byte this copy's.
function flowKeys(listed, handlers) {
  if (!Array.isArray(listed?.data)) fail('PROVIDER_ERROR', 'Codex answered hooks/list without a list.')
  const pluginId = ownPluginId()
  const own = readFileSync(CODEX_HOOKS)
  const seen = new Map()
  const byKey = new Map()
  for (const scope of listed.data) {
    for (const hook of Array.isArray(scope?.hooks) ? scope.hooks : []) {
      if (hook?.source !== 'plugin' || hook.handlerType !== 'command' || typeof hook.key !== 'string' || typeof hook.command !== 'string') continue
      if (hook.pluginId !== pluginId) continue
      for (const handler of handlers) {
        const match = handler.pattern.exec(hook.command)
        const roots = new Set(match ? match.slice(1) : [])
        if (roots.size !== 1) continue
        const [root] = roots
        if (hook.sourcePath !== `${root}/hooks/codex.json` || !sameBytes(hook.sourcePath, own, seen)) continue
        byKey.set(hook.key, { hook, handler, root })
      }
    }
  }
  const found = [...byKey.values()]
  const roots = new Set(found.map(({ root }) => root))
  const missing = handlers.filter((handler) => found.filter((entry) => entry.handler === handler).length !== 1)
  const keyed = found.every(({ hook }) => hook.key.startsWith(`${pluginId}:hooks/codex.json:`))
  if (missing.length > 0 || found.length !== handlers.length || roots.size !== 1 || !keyed) {
    fail('HOOKS_MISMATCH', `Codex lists ${found.length} hook(s) of ${pluginId} that run flow's Codex handlers from a hooks/codex.json identical to this copy's, and this copy of flow registers ${handlers.length}, one each, from one root; the installed flow is another version, so its trust cannot be read against this one.`,
      { pluginId, expected: handlers.length, found: found.length, unmatched: missing.map((handler) => handler.command) })
  }
  return found.map(({ hook }) => ({ key: hook.key, command: hook.command, trustStatus: hook.trustStatus, currentHash: hook.currentHash, enabled: hook.enabled !== false }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

const hooksDigest = (keys) => createHash('sha256').update(JSON.stringify(keys.map(({ key, currentHash }) => [key, currentHash]))).digest('hex')
const untrusted = (keys) => keys.filter((key) => key.trustStatus !== 'trusted' || !key.enabled || typeof key.currentHash !== 'string')
const shown = (keys) => keys.map(({ key, command, trustStatus, currentHash }) => ({ key, command, trustStatus, currentHash }))

// One Codex App Server session in cwd for steps(rpc), closed and reaped whatever happens. A
// failure the peer reports keeps its kind.
async function withCodex(cwd, steps) {
  const bin = findExecutable('codex')
  if (!bin) fail('PROVIDER_NOT_INSTALLED', 'No codex executable is on PATH, so Codex\'s hook trust cannot be read.')
  const child = spawn(bin, ['app-server', '--stdio'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', () => {})
  const closed = new Promise((resolve) => child.on('close', resolve))
  const rpc = connect(child, {
    onLine: () => {}, onNotification: () => {},
    onRequest: (method) => ({ error: { code: -32601, message: `seat.mjs does not answer ${method}.` } }),
    diagnostics: 'run it again, or run codex app-server yourself to see its stderr',
  })
  try {
    await rpc.request('initialize', { clientInfo: { name: 'flow-seat', title: 'Flow seat trust', version: VERSION }, capabilities: { experimentalApi: true } })
    rpc.notify('initialized')
    return await steps(rpc)
  } catch (error) {
    if (error?.kind && !(error instanceof SeatError)) fail(error.kind, error.message)
    throw error
  } finally {
    rpc.close()
    let timer
    await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_MS) })])
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

const listFlowKeys = async (rpc, cwd, handlers) => flowKeys(await rpc.request('hooks/list', { cwds: [cwd] }), handlers)

// Where trust reads hooks/list: the canonical checkout of the working directory, or the working
// directory itself outside a repository.
function trustCwd() {
  const common = gitLine(process.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return common && basename(common) === '.git' ? realpathSync(dirname(common)) : realpathSync(process.cwd())
}

async function trust(argv) {
  const write = argv[0] === '--write'
  const opts = flags(write ? argv.slice(1) : argv, ['--expect'])
  const expected = opts['--expect']
  if (!write && expected !== undefined) fail('BAD_REQUEST', 'trust takes nothing, or --write --expect <digest>, the digest a plain trust listed.')
  if (write && (typeof expected !== 'string' || !DIGEST.test(expected))) fail('BAD_REQUEST', 'trust --write needs --expect <digest>, the 64 hex digest a plain trust listed.')
  const cwd = trustCwd()
  const handlers = flowHandlers()
  return withCodex(cwd, async (rpc) => {
    const keys = await listFlowKeys(rpc, cwd, handlers)
    const digest = hooksDigest(keys)
    if (!write) return { ok: true, keys: shown(keys), digest, wrote: false }
    if (digest !== expected) {
      fail('HOOKS_CHANGED', 'Flow\'s Codex hooks are not the ones listed under the expected digest, so nothing was written. Run trust again and show the human the new list.',
        { expected, digest, keys: shown(keys) })
    }
    const value = Object.fromEntries(keys.map(({ key, currentHash }) => [key, { trusted_hash: currentHash }]))
    await rpc.request('config/batchWrite', { edits: [{ keyPath: 'hooks.state', value, mergeStrategy: 'upsert' }], reloadUserConfig: true })
    const after = await listFlowKeys(rpc, cwd, handlers)
    const still = untrusted(after)
    if (still.length > 0) {
      fail('HOOKS_UNTRUSTED', `Codex still reads ${still.length} of flow's hooks as not trusted after the write.`, { keys: shown(still) })
    }
    return { ok: true, keys: shown(after), digest: hooksDigest(after), wrote: true }
  })
}

// open's read of the trust a Codex seat depends on: the digest, or HOOKS_UNTRUSTED.
async function seatTrust(cwd) {
  let keys
  try { keys = await withCodex(cwd, (rpc) => listFlowKeys(rpc, cwd, flowHandlers())) } catch (error) {
    if (!(error instanceof SeatError)) throw error
    fail('HOOKS_UNTRUSTED', `Flow's Codex hook trust could not be confirmed (${error.kind}): ${error.message}`, { hooksDigest: null, cause: error.kind })
  }
  const digest = hooksDigest(keys)
  const still = untrusted(keys)
  if (still.length > 0) {
    fail('HOOKS_UNTRUSTED', `Codex does not run ${still.length} of flow's hooks (not trusted, modified or disabled), so a Codex seat would run unguarded. Run seat.mjs trust as the flow skill's setup says.`,
      { hooksDigest: digest, keys: shown(still) })
  }
  return digest
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
  const now = canonicalState(record.repoRoot)
  const then = record.canonicalSnapshot
  if (!now) reasons.push('the canonical checkout could not be snapshotted')
  else {
    if (!sameSnapshot(now, then)) reasons.push('the canonical checkout changed while the seat ran')
    if (now.head !== then?.head || now.branch !== then?.branch) {
      reasons.push(`the canonical checkout's HEAD moved while the seat ran: ${now.head ?? 'unborn'} on ${now.branch ?? 'a detached HEAD'}, not ${then?.head ?? 'unborn'} on ${then?.branch ?? 'a detached HEAD'}`)
    }
  }
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

// The verdict, its reasons, and what the output reports from the seat's files, with the sha256 of
// the last turn's result bytes as read here (null with none), so the closed stamp can pin them.
function judge(id, loaded) {
  const facts = { turn: null, envelope: null, resultSha256: null, servedModels: [], blocks: 0, errors: [] }
  const unknown = (reason) => ({ verdict: 'unknown', reasons: [reason], facts })
  if (!loaded) return unknown('the seat record is missing or corrupt')
  const { record, digest } = loaded
  const voided = store.readStamp(id, 'void')
  if (voided) return unknown(`the seat is void: ${String(voided.reason ?? 'no reason recorded').slice(0, 120)}`)
  for (const name of STAMPS) if (!store.readStamp(id, name)) return unknown(`the ${name} stamp is missing`)
  const bound = store.readStamp(id, 'bound')
  if (bound.recordDigest !== digest) return unknown('the record changed after the bind')
  // The bound session's index entry is what made its tool calls seat calls. Voided or replaced
  // after the bind, the hooks no longer held that session as this seat.
  const entry = store.readIndex(bound.host, bound.sessionId)
  if (entry?.void !== undefined) return unknown('session-index-void')
  if (entry === null || entry.id !== id) return unknown('session-index-mismatch')
  const state = store.readState(id)
  if (!state || !Number.isSafeInteger(state.turn) || state.turn < 1) return unknown('no Stop was recorded, so there is no result')
  // A prompt after the bind opened a turn that no stop was ever recorded for: the result on record
  // answers an earlier turn.
  if (Object.hasOwn(state, 'opened') && state.opened !== state.turnKey) return unknown('turn-without-result')
  facts.turn = state.turn
  facts.blocks = Number.isSafeInteger(state.blocks) ? state.blocks : 0
  facts.errors = Array.isArray(state.errors) ? state.errors : []
  // Read once whatever the outcome, so the closed stamp pins the bytes on disk for the turn.
  const result = store.readResult(id, state.turn)
  facts.resultSha256 = result?.sha256 ?? null
  let envelope = null
  if (state.outcome === 'valid') {
    if (!result) return unknown(`turn ${state.turn} has no result`)
    if (!result.intact) return unknown(`turn ${state.turn}'s result does not match its recorded sha256`)
    envelope = result.body.envelope
    facts.envelope = envelope
  } else if (state.outcome !== 'blocked' && state.outcome !== 'capped') {
    return unknown(`turn ${state.turn} has no result`)
  }
  // Every model a stop saw, in any turn, and the result's own: one turn on another model taints
  // the seat even when the last turn's answer came from the record's. The result must name its own
  // models, so a result is never vouched for by the models of another turn.
  const strings = (list) => (Array.isArray(list) ? list.filter((model) => typeof model === 'string') : [])
  const resultModels = envelope ? strings(result.body.servedModels) : []
  facts.servedModels = [...new Set([...strings(state.models), ...resultModels])]
  if (envelope && resultModels.length === 0) return unknown(`turn ${state.turn}'s result names no served model`)
  if (facts.servedModels.length === 0) return unknown('no served model is on record for any of the seat\'s stops')
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

// Drop a writer seat's lease holder, live or still pending, from its worktree's lease directory.
// True when none of its holders is left, and when the record names no worktree to look in.
function dropHolders(id, record) {
  if (record?.access !== 'workspace-write' || typeof record.worktree !== 'string') return true
  const dir = leaseDirOf(record.worktree)
  for (const holder of [`${id}.live`, id]) dropLease(dir, holder)
  // A holder whose absence can't be confirmed (an unreadable lease directory) counts as present,
  // so prune keeps the record rather than aborting every open.
  return [`${id}.live`, id].every((holder) => {
    try { return lstatSync(join(dir, holder), { throwIfNoEntry: false }) === undefined } catch { return false }
  })
}

function cleanup(id, record) {
  const problems = []
  if (!record) return problems
  dropHolders(id, record)
  const path = typeof record.repoRoot === 'string' ? join(record.repoRoot, '.flow-worktrees', `review-${id}`) : null
  if (record.access === 'review' && path && record.reviewWorktree === path && existsSync(path)) {
    if (!openedReview(record, path)) problems.push(`the worktree at ${path} is not the one this seat opened, so it was left in place`)
    else {
      const removed = git(record.repoRoot, ['worktree', 'remove', '--force', path])
      if (!removed.ok) problems.push(`the review worktree could not be removed: ${removed.stderr.slice(0, 200)}`)
    }
  }
  return problems
}

// Whether path is still the review worktree open added: the same real path, the same admin
// directory under the common .git, and listed by git as a worktree.
function openedReview(record, path) {
  let real = null
  try { real = realpathSync(path) } catch {}
  const gitDir = gitLine(path, ['rev-parse', '--absolute-git-dir'])
  let realGitDir = null
  try { realGitDir = gitDir && realpathSync(gitDir) } catch {}
  const listed = git(record.repoRoot, ['worktree', 'list', '--porcelain'])
  return real === record.reviewWorktree && typeof record.reviewGitDir === 'string' && realGitDir === record.reviewGitDir &&
    listed.ok && listed.stdout.split('\n').includes(`worktree ${path}`)
}

// A later close's output: the closed stamp's verdict and facts, and the result it pinned while the
// result file's bytes still hash to the pinned sha256. Once they do not, the result is null and
// the reasons say so; the verdict stays the one on record. An abandon's reason is read from bound,
// whether the seat has a bound stamp now (see close --abandon above).
function onRecord(id, recorded, bound = store.readStamp(id, 'bound') !== null) {
  const turn = Number.isSafeInteger(recorded.turn) && recorded.turn > 0 ? recorded.turn : null
  const pinned = typeof recorded.resultSha256 === 'string' ? recorded.resultSha256 : null
  const now = turn === null ? null : store.readResult(id, turn)
  const reasons = recorded.abandoned === true ? [bound ? 'abandon-raced-bind' : 'abandoned-before-bind']
    : Array.isArray(recorded.reasons) ? [...recorded.reasons] : []
  let result = null
  if ((now?.sha256 ?? null) !== pinned) reasons.push('result-changed-after-close')
  else if (recorded.verdict === 'valid') result = now?.body?.envelope ?? null
  return {
    ok: true, id, verdict: recorded.verdict, reasons, turn, result,
    servedModels: Array.isArray(recorded.servedModels) ? recorded.servedModels : [],
    blocks: Number.isSafeInteger(recorded.blocks) ? recorded.blocks : 0,
    errors: Array.isArray(recorded.errors) ? recorded.errors : [],
  }
}

const TASK_ENDED = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const TASK_BUSY = new Set(['working', 'waiting_for_children'])
const terminalTask = (status) => status !== null && typeof status === 'object' && !Array.isArray(status) &&
  TASK_ENDED.has(status.status) && !TASK_BUSY.has(status.workState) && status.hasPendingChildRuns !== true

// Whether a task status is the seat's own task: T3 builds the task id from the call's
// clientRequestId, URL-encoded inside it, as in `...delegate-task%3Aflow-seat-<id>`.
function taskOf(status, id) {
  if (typeof status.taskId !== 'string') return false
  let decoded = status.taskId
  try { decoded = decodeURIComponent(status.taskId) } catch {}
  return [status.taskId, decoded].some((text) => text.includes(clientRequestIdOf(id)))
}

function close(argv) {
  const [id, ...rest] = argv
  if (typeof id !== 'string' || !SEAT_ID.test(id)) fail('BAD_REQUEST', 'close takes a seat id, 32 lowercase hex characters.')
  if (rest.includes('--abandon')) {
    if (rest.length !== 1) fail('BAD_REQUEST', 'close --abandon takes nothing else: no --task-status and no value.')
    return abandon(id)
  }
  const opts = flags(rest, ['--task-status'])
  const text = opts['--task-status']
  if (text === undefined) fail('BAD_REQUEST', 'close needs --task-status, the task_status answer for the seat\'s task, as JSON.')
  if (Buffer.byteLength(text) > TASK_STATUS_BYTES) fail('BAD_REQUEST', '--task-status is over 64 KiB.')
  let taskStatus
  try { taskStatus = JSON.parse(text) } catch { fail('BAD_REQUEST', '--task-status is not JSON.') }
  if (!terminalTask(taskStatus)) {
    fail('TASK_NOT_TERMINAL', 'close records a seat whose task T3 reports finished: a task_status answer whose status is completed, failed, cancelled or interrupted, whose workState is not working or waiting_for_children, and with no pending child runs. Wait for the task to finish, then close it.')
  }
  if (store.readStamp(id, 'admitted') !== null && !taskOf(taskStatus, id)) {
    fail('TASK_MISMATCH', `The task status is not this seat's task: its taskId does not carry ${clientRequestIdOf(id)}, the clientRequestId the seat's delegate_task call was admitted with. Pass the task_status answer for this seat's own task.`)
  }

  const loaded = store.readRecord(id)
  const { verdict, reasons, facts } = judge(id, loaded)
  const { turn, resultSha256, servedModels, blocks, errors } = facts
  const closed = { verdict, reasons, taskStatus, turn, resultSha256, servedModels, blocks, errors }
  let out = { ok: true, id, verdict, reasons, turn, result: verdict === 'valid' ? facts.envelope : null, servedModels, blocks, errors }
  if (!store.stamp(id, 'closed', closed)) {
    // An earlier or racing close holds the stamp, and its record stands; or the record directory
    // is gone, and nothing can be recorded.
    const recorded = store.readStamp(id, 'closed')
    if (recorded) out = onRecord(id, recorded)
  }
  const problems = cleanup(id, loaded?.record ?? null)
  if (problems.length > 0) out.cleanupProblems = problems
  return out
}

const ABANDON_RACED = 'a child bound this seat while it was abandoned and may still be running, so its lease holder and review worktree are kept; close it with --task-status once T3 reports its task finished'

// close --abandon: see the header for the order of its writes and reads and why it is safe.
function abandon(id) {
  if (store.readStamp(id, 'bound') !== null) {
    fail('BAD_REQUEST', 'A bound seat closes with its task status: its child ran, so wait for task_status to report the task finished and pass it with --task-status.')
  }
  const loaded = store.readRecord(id)
  store.stamp(id, 'closed', { verdict: 'unknown', reasons: ['abandoned-before-bind'], abandoned: true, taskStatus: null, turn: null, resultSha256: null, servedModels: [], blocks: 0, errors: [] })
  // Read only once the closed stamp is on disk, whoever wrote it.
  const bound = store.readStamp(id, 'bound') !== null
  const recorded = store.readStamp(id, 'closed')
  // No closed stamp to read means no record directory, so nothing was recorded.
  const out = recorded ? onRecord(id, recorded, bound)
    : { ok: true, id, verdict: 'unknown', reasons: ['abandoned-before-bind'], turn: null, result: null, servedModels: [], blocks: 0, errors: [] }
  if (bound) {
    out.cleanupProblems = [ABANDON_RACED]
    return out
  }
  const problems = cleanup(id, loaded?.record ?? null)
  if (problems.length > 0) out.cleanupProblems = problems
  return out
}

// ----- main

const USAGE = 'usage: seat.mjs open --access <read-only|workspace-write|review> --provider <claude|codex> --model <id> --effort <level> [--worktree <abs>] [--base <rev> --head <rev>] [--schema <file>] | seat.mjs close <seat-id> --task-status <json> | seat.mjs close <seat-id> --abandon | seat.mjs trust [--write --expect <digest>]'
const [verb, ...argv] = process.argv.slice(2)
let answer
try {
  if (verb === 'open') answer = await open(argv)
  else if (verb === 'close') answer = close(argv)
  else if (verb === 'trust') answer = await trust(argv)
  else fail('BAD_REQUEST', USAGE)
} catch (error) {
  answer = error instanceof SeatError
    ? { ok: false, error: { kind: error.kind, message: error.message, ...(error.details ? { details: error.details } : {}) } }
    : { ok: false, error: { kind: 'INTERNAL', message: `seat.mjs ${String(verb).slice(0, 16)} failed unexpectedly: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}` } }
}
process.stdout.write(`${JSON.stringify(answer)}\n`)
process.exitCode = answer.ok ? 0 : 1
