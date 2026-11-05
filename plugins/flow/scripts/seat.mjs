#!/usr/bin/env node
// The T3 seat executor: it opens a seat's record before the parent's delegate_task call, closes
// the seat with the one verdict the parent acts on, and reads or grants Codex's trust in flow's
// own Codex hooks.
//
//   seat.mjs open --access read-only|workspace-write|review --provider claude|codex
//                 [--provider-instance-id <id>] --model <id> [--expected-served-model <id>]
//                 --effort <level> [--worktree <abs>] [--base <rev> --head <rev>] [--schema <file>]
//   seat.mjs close <seat-id> --task-status <json|->
//   seat.mjs close <seat-id> --abandon
//   seat.mjs trust [--write --expect <digest>]
//
// stdout is one JSON line. open prints {ok: true, id, tag, clientRequestId, runtimeMode, provider,
// providerInstanceId, model, expectedServedModel, effort, worktree, reviewWorktree}, close prints {ok: true, id, verdict, reasons, turn, result,
// servedModels, blocks, errors, cleanupProblems?, recorded?}, with or without --abandon, trust prints {ok: true, keys: [{key, command, trustStatus,
// currentHash}], digest, wrote}, and a refusal prints {ok: false, error: {kind, message,
// details?}} with exit 1. The kinds are BAD_REQUEST, BAD_SCHEMA, GIT_REF, WORKSPACE_BUSY,
// HOOKS_MISMATCH, HOOKS_CHANGED and HOOKS_UNTRUSTED from open; BAD_REQUEST, TASK_NOT_TERMINAL,
// TASK_MISMATCH and TASK_INCOMPLETE from close; BAD_REQUEST,
// HOOKS_MISMATCH, HOOKS_CHANGED, HOOKS_UNTRUSTED, PROVIDER_NOT_INSTALLED and the Codex App
// Server's own failure kinds (PROVIDER_ERROR, PROVIDER_AUTH, TIMEOUT) from trust; and, for
// anything this script did not expect, INTERNAL.
//
// The seat's identity. --provider names the hook host family the child runs under, which picks
// the host it binds on and the option its effort rides in, not the vendor of the model. The record
// always holds providerInstanceId, the T3 provider instance the delegate_task call must name, and
// expectedServedModel, the model id the hooks must see serving the seat; --model stays the id the
// call asks for. An omitted --provider-instance-id is claudeAgent for claude and codex for codex,
// and an omitted --expected-served-model is --model; an empty value is refused, never defaulted.
// The instance id is opaque and matched exactly. Before anything is pruned or created, open refuses
// BAD_REQUEST an instance id over 128 UTF-8 bytes or holding a control character, an expected id
// that is no model id, and what seat-policy's seatIdentityProblem refuses: a claude seat on the
// codex instance, and a codex seat on any instance but codex or expecting a model it did not ask
// for. Flow stores no endpoint, credential or vendor, and maps no router id to a served one.
//
// open, in this order: prune closed records past retention; find the repository from --worktree,
// or the working directory, and its canonical checkout, the main worktree; for a review, resolve
// --base and --head to commit SHAs where --worktree (or the working directory) resolves them,
// add `/.flow-worktrees/` to the common .git/info/exclude through lib/git-exclude.mjs (creating
// info/ when it is missing), so no review worktree shows in the canonical checkout's snapshot, and
// add a detached worktree at the head under <canonical>/.flow-worktrees/review-<id>, the seat's
// worktree, recording its admin directory (`git rev-parse --absolute-git-dir` there) as
// reviewGitDir, with the findings schema as its answer schema; for a Codex seat, read flow's Codex
// hook trust (below) between two digests of its plugin root (The plugin root, below) and refuse
// with HOOKS_UNTRUSTED unless every flow hook is there, enabled and trusted, recording the digest
// of the keys and hashes it read as hooksDigest and the root and its digest as codexPluginRoot and
// codexPluginDigest; for a writer, hold
// the worktree's write lease directory (below); for a review, snapshot the canonical checkout
// with tree-snapshot.mjs and add its HEAD commit, the branch HEAD names and the sha256 of origin's URL; then write the schema and the record, last, through lib/seat-store.mjs. Before the holder, open builds the seat's context as the prompt hook will (with the real schema.json path) and refuses BAD_REQUEST when the paths make it past the 6000-byte hook budget even with the schema left out by path.
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
// The plugin root. Codex keeps one trust hash for the whole installed plugin, so a change to any
// file under flow's Codex plugin root, from a cache refresh or a reinstall, untrusts every flow
// hook, and Codex then skips them without a word. A turn after that leaves nothing on record. The
// root's digest is the sha256 of the JSON of one entry per directory and file under it, the root
// included as '': [<relative path>, 'dir', null] or [<relative path>, 'file', <sha256 of its
// bytes>], with / between path segments, sorted by code unit. Every entry is read through lstat,
// and a file through an O_NOFOLLOW and O_NONBLOCK open and fstat, so no link is followed and no
// FIFO blocks the walk. A symlink, any other entry type or an entry that cannot be read is a problem.
// open lists the hooks in one App Server session to learn the root, digests it, reads the trust in
// a second session, and digests it again. A walk problem refuses HOOKS_MISMATCH. A second session
// that names another root, or a second digest unlike the first, refuses HOOKS_CHANGED. All of it
// runs before the lease holder, so a refusal leaves no record, holder or review worktree. A Claude
// record carries neither codexPluginRoot nor codexPluginDigest.
//
// close reads the task status from --task-status <json>, at most 64 KiB, or with --task-status -
// from stdin, at most 256 KiB of raw bytes (a trailing newline counts) that must decode as UTF-8.
// A single argv string fails with E2BIG at 128 KiB on Linux, so a parent passes a whole status on
// stdin. A status over its cap, not UTF-8 or not JSON is refused BAD_REQUEST. No refusal of close
// writes anything: no stamp is added or changed, and the writer's lease holder and the review
// worktree stay, so a retry with the whole status can still close the seat.
// close then refuses TASK_NOT_TERMINAL, writing nothing, unless --task-status is a task_status
// answer T3 gives for a finished task: an object whose status is completed, failed, cancelled or
// interrupted, whose workState is not working or waiting_for_children, and whose
// hasPendingChildRuns is not true. A writer's lease stays held until then. Once the seat was
// admitted, close also refuses TASK_MISMATCH, writing nothing, unless the task status's taskId
// carries flow-seat-<id>, the clientRequestId the admitted call named, plainly or URL-encoded, so
// one seat is never closed on another task's status. It then refuses TASK_INCOMPLETE unless the
// status has its own childRunId, latestTerminalRunId, latestTerminalStatus, summary and
// latestTerminalSummary keys (a key set to null is present), and TASK_MISMATCH unless both run ids
// follow one grammar: run:thread:<seg>:ordinal:<n>, split at the last :ordinal:, where seg equals
// encodeURIComponent(childThreadId), compared encoded, childThreadId is a non-empty string, n
// matches [1-9][0-9]* and is a safe integer, and the latest ordinal is not below the child's.
// childThreadId is a T3 id and is never compared with a hook's sessionId. It then judges the seat
// from its record and the stamps and results the hooks wrote, in this order of precedence, the
// first that holds being the verdict:
//   unknown         no readable record; a record that fails seatIdentityProblem, such as one
//                   an older flow wrote without providerInstanceId or expectedServedModel; a
//                   void stamp; no admitted, bound or receipt stamp; a record whose bytes no
//                   longer match the digest the bind pinned, or a bind that pinned other bytes
//                   than the admission did; a bound session whose index entry is void
//                   (session-index-void) or missing or names another seat
//                   (session-index-mismatch); no Stop on record; a turn a prompt
//                   opened after the bind with no stop on record (turn-without-result); a last
//                   stop that was valid with no intact result for its turn, or with a result that
//                   names no served model; or no served model on record from any stop
//   model-mismatch  the model the hooks saw at the bind is not the record's model, the one the
//                   call asked for (`bound to <X>, not <model>`), or a model a stop saw serving
//                   the seat in any turn (Stop keeps them as one set in the turn state), or the
//                   result's own, is not the record's expectedServedModel (`served by <Y>, not
//                   <expected>`, one reason per distinct id in first-seen order, after the bind's).
//                   A router id the call asked for is never read as a served one: flow maps no
//                   router to the model behind it, so the parent declares it at open.
//   tree-moved      for a review: the review worktree's HEAD left the head SHA or its tree is
//                   dirty, the canonical checkout's snapshot changed, its HEAD commit or branch
//                   changed other than by the fast-forward below, or, with an envelope to check,
//                   `git diff --name-only base head` could not be read
//   coverage-gap    for a review with an envelope: the coverage (read, partial and unopened
//                   together) misses a file in that diff. An entry covers a file when it is the
//                   file's path, or that path, a space and a parenthesized note (see uncovered).
//                   The reasons are one count, then every missed path, uncapped; result is the
//                   envelope Stop recorded
//   capped          the last turn was capped
//   invalid         the last stop in the last turn was blocked
//   valid           otherwise; result is the envelope Stop recorded
// The fast-forward. A land in a parallel run pulls main in the canonical checkout, which moves the
// HEAD every open review pinned. A HEAD or branch change is no tree-moved reason when all of these
// hold, and ls-remote runs only once the rest do:
//   - the branch is the one open recorded, named and under refs/heads/;
//   - both HEADs are 40-hex commits, and `git merge-base --is-ancestor <then> <now>` exits 0;
//   - the sha256 of origin's URL, `git remote get-url origin`, was recorded at open and is the same
//     now, so a seat can't repoint origin at a repository it controls. Only the digest is stored
//     or printed, because an HTTPS URL can carry a token. A record from before the rule has no
//     origin and never passes;
//   - `git ls-remote --exit-code origin <branch>` prints exactly one line, for exactly that ref,
//     whose SHA is the HEAD now. That is origin's live tip, never the local tracking ref, which
//     update-ref can forge.
// ls-remote runs in the git environment below plus GIT_TERMINAL_PROMPT=0, an empty SSH_ASKPASS and
// GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=10', and is killed after 30 s, so it
// never waits on a prompt. Any other result, an unreadable origin among them, keeps tree-moved. The
// four digests stay their own reason, so a fast-forward that also changes the tree reads tree-moved.
// Three residuals are known and accepted:
//   - it isn't an authorship check. A seat that resets and pulls, or fetches and fast-forward
//     merges, in the canonical checkout passes;
//   - a sibling merge that lands on origin after a pull moves the live tip past the canonical
//     HEAD, so a close after that merge and before that sibling's land pulls reads tree-moved;
//   - an HTTPS origin that needs a credential helper fails closed, because no global or system
//     configuration is read.
// close then checks a valid or coverage-gap verdict against the task status, as negative evidence
// only. T3's text can withhold either, and the result is still the envelope Stop recorded, never
// T3's summary. The latest run's text is summary when latestTerminalRunId is childRunId. Otherwise,
// when latestTerminalStatus is completed, it is latestTerminalSummary when that is a string and
// summary when it is null (T3 0.1.6 nulls it when it repeats summary), and for any other status
// there is none. Reason stale-turn comes first, for no text, for text whose store.textDigest (the
// raw bytes Stop hashed, nothing trimmed or unfenced) is not the turn state's messageSha256, or
// for a latest ordinal above the child's when the turn state has no own opened key. The ordinal is
// a one-way signal and never a turn count: a failed run takes an ordinal and has no Stop, and a
// steer adds no run. Reason hooks-changed comes after it, for a Codex record whose plugin root
// changed. close scans the root twice in a row, and a problem in either scan, a digest unlike
// codexPluginDigest or two unequal digests is a change. A Codex record with neither key predates
// the check and is not scanned, one with a single key or a malformed digest reads hooks-changed,
// and a Claude record is never scanned. Either reason makes the verdict unknown and the result
// null, and keeps turn, servedModels, blocks and errors. close checks only those two verdicts, so
// the two reasons only ever turn valid or coverage-gap into unknown, and every verdict above keeps
// its precedence.
// Two gaps are known and not fixed:
//   - a later run whose hooks were dark and whose text is byte-identical to the recorded message
//     passes when the turn state already holds an opened key, from an earlier follow-up or steer;
//   - the scan sees endpoint drift only, so a change restored byte for byte before close passes.
//     The change seen on 2026-11-03 was a cache refresh that stayed.
// It writes the closed stamp first, with the verdict, the reasons, the task status the parent
// read from T3, the latest run's id as runId, the turn state's messageSha256, and the facts the
// output reports: the turn, the sha256 of that turn's result bytes as judge read them (null with
// no result), the served models, the blocks and the errors. It
// then drops the writer's lease holder and removes the review worktree it created, only while the
// path still resolves to the recorded worktree, its admin directory is still reviewGitDir, and
// `git worktree list` still lists it; a worktree that is not the one open added is left in place
// and reported. The stamp is
// write-once and is the record, so a second close, or a racing one, prints the stamp's verdict
// and facts, with the result read again from the pinned turn: that result while its bytes still
// hash to the pinned sha256, and otherwise null, with result-changed-after-close among the
// reasons and the verdict unchanged. It also retries the cleanup. Cleanup that fails is listed in
// cleanupProblems and does not change the verdict. A stamp that holds valid or coverage-gap and is
// not an abandon is first checked against the status this close was given, so a later close never
// certifies a run the stamp did not judge. A latest run id other than the stamp's runId adds
// stale-turn, and a stamp written before close recorded runId has none, so it reads as another
// run. The same run with text whose store.textDigest is not the stamp's messageSha256 adds stale-turn too, and the root
// scan above adds hooks-changed. With either reason, close prints verdict unknown with those
// reasons, result null and, last, recorded: {verdict, turn} from the stamp. It never rewrites the
// stamp, judges the seat again or reads its trees, because a review's worktree is gone by then. A
// stamp that holds any other verdict certified nothing and prints as before. A close that lost the
// race for the stamp takes the same path, so two first closes on one status print one outcome.
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
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from '../delegate/codex-app-server.mjs'
import { dropLease, JOB_ID, leaseDirOf, leaseLive } from '../delegate/jobs.mjs'
import { findExecutable } from '../delegate/providers.mjs'
import { FINDINGS_SCHEMA, outputSchemaProblem } from '../delegate/schema.mjs'
import { ensureExcluded } from '../lib/git-exclude.mjs'
import { DEFAULT_INSTANCE, MODEL, plainShellWord, seatContext, seatIdentityProblem, validInstanceId } from '../lib/seat-policy.mjs'
import * as store from '../lib/seat-store.mjs'
import { inside } from '../lib/state-dir.mjs'
import { readSeatTask } from '../lib/t3-store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TREE_SNAPSHOT = join(HERE, 'tree-snapshot.mjs')
const CODEX_HOOKS = join(HERE, '..', 'hooks', 'codex.json')
const PLUGIN_ROOT = realpathSync(join(HERE, '..'))
const VERSION = JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version
const CLOSE_MS = 5_000
const ACCESS = ['read-only', 'workspace-write', 'review']
const PROVIDERS = ['claude', 'codex']
const EFFORT = /^[a-z][a-z0-9-]{0,31}$/
const SEAT_ID = /^[0-9a-f]{32}$/
const DIGEST = /^[0-9a-f]{64}$/
const SCHEMA_BYTES = 16 * 1024
const GIT_MS = 60_000
const HEAD_SHA = /^[0-9a-f]{40}$/
// ls-remote may reach the network: no prompt of any kind, and a bound on how long it may take.
const LS_REMOTE_MS = 30_000
const LS_REMOTE_ENV = { GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS: '', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' }
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
function git(cwd, args, { env = {}, timeout = GIT_MS } = {}) {
  const run = spawnSync('git', ['-C', cwd, ...args], { env: { ...gitEnv(), ...env }, encoding: 'utf8', timeout, maxBuffer: 1 << 28 })
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
// The canonical checkout as a review pins it: the four digests, the HEAD commit (null when unborn),
// the branch HEAD names (null when detached) and the sha256 of origin's URL (null with no origin),
// never the URL, which can carry a token, or null when
// tree-snapshot cannot take them.
const digestOf = (text) => (text === null ? null : createHash('sha256').update(text).digest('hex'))
function canonicalState(path) {
  const digests = snapshot(path)
  if (!digests) return null
  return {
    ...digests, head: gitLine(path, ['rev-parse', '--verify', '--quiet', 'HEAD']), branch: gitLine(path, ['symbolic-ref', '--quiet', 'HEAD']),
    origin: digestOf(gitLine(path, ['remote', 'get-url', 'origin'])),
  }
}

// Why the canonical HEAD's move from then to now is not a fast-forward onto origin's live tip of
// the same branch, or null when it is (The fast-forward, in the header). ls-remote comes last, so
// a move the local checks refuse never reaches the network.
function fastForwardProblem(repoRoot, then, now) {
  const branch = then?.branch
  if (typeof branch !== 'string' || !branch.startsWith('refs/heads/') || now.branch !== branch) return 'the branch is not the named branch open recorded'
  if (!HEAD_SHA.test(then.head ?? '') || !HEAD_SHA.test(now.head ?? '')) return 'a HEAD is not a 40-hex commit'
  if (typeof then.origin !== 'string' || then.origin === '') return 'open recorded no origin'
  if (now.origin !== then.origin) return now.origin === null ? 'origin is gone' : "origin's URL is not the one open recorded"
  if (!git(repoRoot, ['merge-base', '--is-ancestor', then.head, now.head]).ok) return 'the HEAD at open is not an ancestor of this one'
  const remote = git(repoRoot, ['ls-remote', '--exit-code', 'origin', branch], { env: LS_REMOTE_ENV, timeout: LS_REMOTE_MS })
  if (!remote.ok) return `origin's ${branch} could not be read`
  const lines = remote.stdout.split('\n').filter(Boolean)
  const [sha, ref] = lines[0]?.split('\t') ?? []
  if (lines.length !== 1 || ref !== branch) return `origin named no single tip for ${branch}`
  if (sha !== now.head) return `origin's ${branch} is ${sha.slice(0, 64)}, not this HEAD`
  return null
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

// The worktree a path is in (its top level, as a realpath), the repository's canonical
// checkout, the main worktree, and its .git directory, the common one, as a realpath.
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
  return { top: realpathSync(top), repoRoot: realpathSync(dirname(common)), commonDir: realpathSync(common) }
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
  const opts = flags(argv, ['--access', '--provider', '--provider-instance-id', '--model', '--expected-served-model', '--effort', '--worktree', '--base', '--head', '--schema'])
  const access = opts['--access']
  const provider = opts['--provider']
  const model = opts['--model']
  const effort = opts['--effort']
  if (!ACCESS.includes(access)) fail('BAD_REQUEST', `--access must be one of ${ACCESS.join(', ')}.`)
  if (!PROVIDERS.includes(provider)) fail('BAD_REQUEST', `--provider must be one of ${PROVIDERS.join(', ')}.`)
  if (typeof model !== 'string' || !MODEL.test(model)) fail('BAD_REQUEST', '--model must be a model id.')
  if (typeof effort !== 'string' || !EFFORT.test(effort)) fail('BAD_REQUEST', '--effort must be an effort level.')
  // Only an omitted flag takes its default: an empty value is refused like any other bad one.
  const providerInstanceId = opts['--provider-instance-id'] ?? DEFAULT_INSTANCE[provider]
  const expectedServedModel = opts['--expected-served-model'] ?? model
  if (!validInstanceId(providerInstanceId)) fail('BAD_REQUEST', '--provider-instance-id must be 1 to 128 UTF-8 bytes with no control character.')
  if (!MODEL.test(expectedServedModel)) fail('BAD_REQUEST', '--expected-served-model must be a model id.')
  const identity = seatIdentityProblem({ provider, providerInstanceId, model, expectedServedModel, effort, runtimeMode: RUNTIME_MODE })
  if (identity) fail('BAD_REQUEST', `--provider, --provider-instance-id and --expected-served-model do not fit: ${identity}.`)
  const review = access === 'review'
  if (opts['--worktree'] !== undefined && !isAbsolute(opts['--worktree'])) fail('BAD_REQUEST', '--worktree must be an absolute path.')
  if (access === 'workspace-write' && opts['--worktree'] === undefined) fail('BAD_REQUEST', 'A workspace-write seat names its --worktree.')
  if (review && (opts['--base'] === undefined || opts['--head'] === undefined)) fail('GIT_REF', 'A review seat names --base and --head.')
  if (!review && (opts['--base'] !== undefined || opts['--head'] !== undefined)) fail('BAD_REQUEST', '--base and --head apply to a review seat only.')
  if (review && opts['--schema'] !== undefined) fail('BAD_SCHEMA', 'A review seat answers in the findings schema and takes no --schema.')
  const schema = review ? FINDINGS_SCHEMA : opts['--schema'] === undefined ? null : readSchema(opts['--schema'])

  const id = store.newId()
  store.pruneSeats(Date.now(), dropHolders)
  const { top, repoRoot, commonDir } = repository(opts['--worktree'] ?? process.cwd())
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
      // Outside the claim, the exclude file may lack the line, and then this worktree and every
      // other review's would show in the canonical snapshot, so overlapping reviews read tree-moved.
      try {
        const info = join(commonDir, 'info')
        try { mkdirSync(info, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
        // ensureExcluded's O_NOFOLLOW guards only the last component, so info itself must be a real
        // directory, not a symlink that carries the append to a file outside the repository.
        if (!lstatSync(info).isDirectory()) throw new Error(`${info} is not a real directory`)
        ensureExcluded(join(info, 'exclude'), ['/.flow-worktrees/'])
      } catch (error) { fail('GIT_REF', `/.flow-worktrees/ could not be added to the repository's info/exclude: ${String(error.message).slice(0, 200)}`) }
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
    const trusted = provider === 'codex' ? await seatTrust(repoRoot) : null
    const record = {
      v: 1, id, createdAt: new Date().toISOString(), access, repoRoot, worktree, reviewWorktree, reviewGitDir, baseSha, headSha,
      provider, providerInstanceId, model, expectedServedModel, effort, runtimeMode: RUNTIME_MODE, canonicalSnapshot: null, hooksDigest: trusted?.hooksDigest ?? null,
      // A Claude record carries neither key, so their absence also marks a Codex record from before.
      ...(trusted ? { codexPluginRoot: trusted.codexPluginRoot, codexPluginDigest: trusted.codexPluginDigest } : {}),
    }
    // The seat's context repeats its paths, and the prompt hook cannot deliver one past the hook
    // budget, so a seat whose context cannot fit is refused here, before the holder and the record.
    try { seatContext(record, schema, store.schemaPath(id)) } catch (error) {
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
      store.stamp(id, 'closed', { verdict: 'unknown', reasons: [reason], task: null, turn: null, resultSha256: null, servedModels: [], blocks: 0, errors: [] })
      fail('WORKSPACE_BUSY', `This open stalled for over a minute, so ${reason}, and a write job may hold the worktree now.`)
    }
    return {
      ok: true, id, tag: store.seatTag(id), clientRequestId: clientRequestIdOf(id), runtimeMode: RUNTIME_MODE, provider, providerInstanceId, model,
      expectedServedModel, effort, worktree, reviewWorktree,
    }
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

// Flow's entries in a hooks/list answer, {keys, root}: one key per handler, from this copy's plugin
// id and one root, the plugin root Codex runs them from, whose hooks/codex.json is byte for byte
// this copy's.
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
  const keys = found.map(({ hook }) => ({ key: hook.key, command: hook.command, trustStatus: hook.trustStatus, currentHash: hook.currentHash, enabled: hook.enabled !== false }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { keys, root: [...roots][0] }
}

const hooksDigest = (keys) => createHash('sha256').update(JSON.stringify(keys.map(({ key, currentHash }) => [key, currentHash]))).digest('hex')

// The content of a Codex flow plugin root: {digest}, or {problem} when the root or anything in it
// is a symlink, any type but a regular file or a directory, or unreadable. Nothing is followed: each
// entry is lstat'd, and a file is opened O_NOFOLLOW and O_NONBLOCK and checked again before it is
// read, so a FIFO is never read and a swapped-in link is refused. The digest is the sha256 of the
// JSON of every entry's [path, 'dir', null] or [path, 'file', sha256], the path relative to the
// root with '/' (the root itself ''), sorted by code unit; modes and times are not content.
function pluginTree(root) {
  const problem = (rel, what) => ({ problem: `${rel === '' ? 'the plugin root' : rel} ${what}` })
  if (typeof root !== 'string' || !isAbsolute(root)) return problem('', 'is not an absolute path')
  const entries = []
  const pending = [['', root]]
  while (pending.length > 0) {
    const [rel, path] = pending.pop()
    let info
    try { info = lstatSync(path) } catch (error) { return problem(rel, `cannot be read (${error.code ?? 'error'})`) }
    if (info.isDirectory()) {
      entries.push([rel, 'dir', null])
      let names
      try { names = readdirSync(path) } catch (error) { return problem(rel, `cannot be listed (${error.code ?? 'error'})`) }
      for (const name of names) pending.push([rel === '' ? name : `${rel}/${name}`, join(path, name)])
    } else if (info.isFile()) {
      let fd = null
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        if (!fstatSync(fd).isFile()) return problem(rel, 'stopped being a regular file while it was read')
        entries.push([rel, 'file', createHash('sha256').update(readFileSync(fd)).digest('hex')])
      } catch (error) {
        return problem(rel, `cannot be read (${error.code ?? 'error'})`)
      } finally {
        if (fd !== null) closeSync(fd)
      }
    } else return problem(rel, info.isSymbolicLink() ? 'is a symlink' : 'is neither a regular file nor a directory')
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return { digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') }
}

// open's digest of the Codex flow plugin root, or HOOKS_MISMATCH when it holds what flow cannot
// digest, since a change to it while the seat ran could then go unseen.
function rootDigest(root) {
  const tree = pluginTree(root)
  if (tree.problem) {
    fail('HOOKS_MISMATCH', `The flow plugin Codex installed holds what flow cannot digest (${tree.problem}), so a change to it while the seat runs could not be seen. Reinstall flow on Codex.`, { codexPluginRoot: root })
  }
  return tree.digest
}
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
    const { keys } = await listFlowKeys(rpc, cwd, handlers)
    const digest = hooksDigest(keys)
    if (!write) return { ok: true, keys: shown(keys), digest, wrote: false }
    if (digest !== expected) {
      fail('HOOKS_CHANGED', 'Flow\'s Codex hooks are not the ones listed under the expected digest, so nothing was written. Run trust again and show the human the new list.',
        { expected, digest, keys: shown(keys) })
    }
    const value = Object.fromEntries(keys.map(({ key, currentHash }) => [key, { trusted_hash: currentHash }]))
    await rpc.request('config/batchWrite', { edits: [{ keyPath: 'hooks.state', value, mergeStrategy: 'upsert' }], reloadUserConfig: true })
    const { keys: after } = await listFlowKeys(rpc, cwd, handlers)
    const still = untrusted(after)
    if (still.length > 0) {
      fail('HOOKS_UNTRUSTED', `Codex still reads ${still.length} of flow's hooks as not trusted after the write.`, { keys: shown(still) })
    }
    return { ok: true, keys: shown(after), digest: hooksDigest(after), wrote: true }
  })
}

// open's read of the trust a Codex seat depends on, bracketed by two digests of the flow plugin
// root Codex runs the hooks from: {hooksDigest, codexPluginRoot, codexPluginDigest}, or a refusal.
// One App Server session's hooks/list names the root, the root is digested, a second session reads
// the trust, and the root is digested again, so a change between the first digest and the trust
// read refuses HOOKS_CHANGED rather than pass as the trust of bytes the seat will not run.
async function seatTrust(cwd) {
  const handlers = flowHandlers()
  const listed = async () => {
    try { return await withCodex(cwd, (rpc) => listFlowKeys(rpc, cwd, handlers)) } catch (error) {
      if (!(error instanceof SeatError)) throw error
      fail('HOOKS_UNTRUSTED', `Flow's Codex hook trust could not be confirmed (${error.kind}): ${error.message}`, { hooksDigest: null, cause: error.kind })
    }
  }
  const { root } = await listed()
  const before = rootDigest(root)
  const { keys, root: trustRoot } = await listed()
  if (trustRoot !== root) {
    fail('HOOKS_CHANGED', 'Codex moved flow\'s hooks to another plugin root while open read their trust, so nothing was written. Open the seat again.', { codexPluginRoot: root })
  }
  const digest = hooksDigest(keys)
  const still = untrusted(keys)
  if (still.length > 0) {
    fail('HOOKS_UNTRUSTED', `Codex does not run ${still.length} of flow's hooks (not trusted, modified or disabled), so a Codex seat would run unguarded. Run seat.mjs trust as the delegate skill's reference.md says under "Codex host setup".`,
      { hooksDigest: digest, keys: shown(still) })
  }
  if (rootDigest(root) !== before) {
    fail('HOOKS_CHANGED', 'The flow plugin Codex installed changed while open read its hook trust, and Codex untrusts every flow hook when any plugin file changes, so nothing was written. Check the trust with seat.mjs trust, then open the seat again.', { codexPluginRoot: root })
  }
  return { hooksDigest: digest, codexPluginRoot: root, codexPluginDigest: before }
}

// ----- close

const STAMPS = ['admitted', 'bound', 'receipt']

// The verdicts whose result is the envelope Stop recorded, and the only ones freshness checks.
const RESULTS = new Set(['valid', 'coverage-gap'])

// The files in the pinned diff, `git diff --name-only base head` in the review worktree, or null
// when the list can't be read.
function pinnedDiff(record) {
  if (typeof record.reviewWorktree !== 'string') return null
  const diff = git(record.reviewWorktree, ['diff', '--no-ext-diff', '--name-only', '-z', record.baseSha, record.headSha])
  return diff.ok ? diff.stdout.split('\0').filter(Boolean) : null
}

// The files in the diff that the coverage (read, partial and unopened together) doesn't cover.
// An entry is first made a path relative to the review worktree, so `./a`, `a` and `<worktree>/a`
// are one file. It covers diff path P when it is P, or when it is P, a space, and a note in
// parentheses. An exact match wins, and otherwise only the longest such P is covered, so
// `a (b).md` is that file, `a (b).md (n)` covers it, and neither covers a diffed `a`.
function uncovered(envelope, worktree, files) {
  const inDiff = new Set(files)
  const seen = new Set()
  for (const entry of ['read', 'partial', 'unopened'].flatMap((key) => envelope?.coverage?.[key] ?? [])) {
    if (typeof entry !== 'string') continue
    const path = (isAbsolute(entry) && inside(worktree, entry) ? relative(worktree, entry) : entry).replace(/^(?:\.\/)+/, '').split(sep).join('/')
    if (inDiff.has(path)) { seen.add(path); continue }
    if (!path.endsWith(')')) continue
    let longest = null
    for (const file of files) {
      if (path.startsWith(`${file} (`) && (longest === null || file.length > longest.length)) longest = file
    }
    if (longest !== null) seen.add(longest)
  }
  return files.filter((file) => !seen.has(file))
}

// The reasons a review's trees read tree-moved. With an envelope to check coverage against, a
// diff list that can't be read is one too, since the coverage can't be checked without it.
function treeReasons(record, envelope, files) {
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
      const problem = fastForwardProblem(record.repoRoot, then, now)
      if (problem) {
        reasons.push(`the canonical checkout's HEAD moved while the seat ran: ${now.head ?? 'unborn'} on ${now.branch ?? 'a detached HEAD'}, not ${then?.head ?? 'unborn'} on ${then?.branch ?? 'a detached HEAD'}, and it is not a fast-forward onto origin's live tip: ${problem}`)
      }
    }
  }
  if (envelope && typeof at === 'string' && files === null) reasons.push('the pinned diff\'s file list could not be read')
  return reasons
}

// The verdict, its reasons, and what the output reports from the seat's files, with the sha256 of
// the last turn's result bytes as read here (null with none), so the closed stamp can pin them,
// and, from the turn state, the digest of the final message Stop last checked and whether a
// follow-up prompt is on record, which freshness reads.
function judge(id, loaded) {
  const facts = { turn: null, envelope: null, resultSha256: null, servedModels: [], blocks: 0, errors: [], messageSha256: null, opened: false }
  const unknown = (reason) => ({ verdict: 'unknown', reasons: [reason], facts })
  if (!loaded) return unknown('the seat record is missing or corrupt')
  const { record, digest } = loaded
  // A record the identity rule refuses names no instance or expected model to judge against.
  const identity = seatIdentityProblem(record)
  if (identity) return unknown(`the seat record fails the seat identity rule: ${identity}`)
  const voided = store.readStamp(id, 'void')
  if (voided) return unknown(`the seat is void: ${String(voided.reason ?? 'no reason recorded').slice(0, 120)}`)
  for (const name of STAMPS) if (!store.readStamp(id, name)) return unknown(`the ${name} stamp is missing`)
  const bound = store.readStamp(id, 'bound')
  if (bound.recordDigest !== digest) return unknown('the record changed after the bind')
  if (store.readStamp(id, 'admitted').recordDigest !== bound.recordDigest) return unknown('the record changed between the admission and the bind')
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
  facts.messageSha256 = typeof state.messageSha256 === 'string' ? state.messageSha256 : null
  facts.opened = Object.hasOwn(state, 'opened')
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
  // The bind sees the model the session asked for, which a router seat names but is not served
  // by; every stop sees the model that answered, which must be the one the record expects.
  const mismatches = []
  if (typeof bound.model === 'string' && bound.model !== record.model) mismatches.push(`bound to ${bound.model.slice(0, 80)}, not ${record.model}`)
  for (const model of new Set(facts.servedModels.filter((served) => served !== record.expectedServedModel))) {
    mismatches.push(`served by ${model.slice(0, 80)}, not ${record.expectedServedModel}`)
  }
  if (mismatches.length > 0) return { verdict: 'model-mismatch', reasons: mismatches, facts }
  if (record.access === 'review') {
    const files = envelope ? pinnedDiff(record) : null
    const reasons = treeReasons(record, envelope, files)
    if (reasons.length > 0) return { verdict: 'tree-moved', reasons, facts }
    // Every missed path is its own reason, uncapped, because the parent scopes the next review
    // from that list.
    const missing = files === null ? [] : uncovered(envelope, record.reviewWorktree, files)
    if (missing.length > 0) return { verdict: 'coverage-gap', reasons: [`the coverage misses ${missing.length} file(s) in the pinned diff`, ...missing], facts }
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
  if (!dropHolders(id, record)) {
    problems.push(`the writer's lease holder in ${leaseDirOf(record.worktree)} could not be removed or confirmed gone, so flow_delegate write jobs there may still see the worktree busy; remove ${id}.live and ${id} there`)
  }
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
  else if (RESULTS.has(recorded.verdict)) result = now?.body?.envelope ?? null
  return {
    ok: true, id, verdict: recorded.verdict, reasons, turn, result,
    servedModels: Array.isArray(recorded.servedModels) ? recorded.servedModels : [],
    blocks: Number.isSafeInteger(recorded.blocks) ? recorded.blocks : 0,
    errors: Array.isArray(recorded.errors) ? recorded.errors : [],
  }
}

// A later close's output once the stamp is on record: onRecord's, unless the stamp certified a
// valid or coverage-gap verdict that T3's store or the seat's hooks now contradict. A store that
// now holds two tasks for the seat (run is null) is task-ambiguous. A latest run other than the one
// the stamp judged (a stamp written before close recorded runId reads as another run), or the same
// run with text other than the message the stamp judged, is stale-turn, and a changed plugin root
// is hooks-changed: the verdict is unknown, with those reasons, no result and what the stamp
// recorded beside them. The stamp is never rewritten, so a later close never certifies a run the
// stamp did not judge. A stamp that certified nothing prints as it is, and judge's tree checks
// never run again here, since the first close removed the review worktree.
function repeated(id, recorded, run, record) {
  const shown = onRecord(id, recorded)
  if (!RESULTS.has(recorded.verdict) || recorded.abandoned === true) return shown
  const reasons = []
  if (run === null) reasons.push('task-ambiguous')
  else if (run.latestRunId !== recorded.runId || store.textDigest(run.latestText) !== recorded.messageSha256) reasons.push('stale-turn')
  if (hooksChanged(record)) reasons.push('hooks-changed')
  if (reasons.length === 0) return shown
  return { ...shown, verdict: 'unknown', reasons, result: null, recorded: { verdict: recorded.verdict, turn: shown.turn } }
}

// Whether a Codex seat's hooks may have gone dark while it ran: the flow plugin root open recorded
// no longer holds what open digested. Codex untrusts every flow hook when any plugin file changes
// and skips an untrusted hook without a word. The root is scanned twice in a row, and a scan that
// fails, either scan's digest other than the record's, or two scans that differ all count. A Codex
// record with neither key predates the check and is not checked; one with a single key or a
// malformed value is; a Claude record never is.
function hooksChanged(record) {
  if (record?.provider !== 'codex') return false
  const hasRoot = Object.hasOwn(record, 'codexPluginRoot')
  const hasDigest = Object.hasOwn(record, 'codexPluginDigest')
  if (!hasRoot && !hasDigest) return false
  if (!hasRoot || !hasDigest || typeof record.codexPluginDigest !== 'string' || !DIGEST.test(record.codexPluginDigest)) return true
  const first = pluginTree(record.codexPluginRoot)
  const second = pluginTree(record.codexPluginRoot)
  return first.digest === undefined || first.digest !== record.codexPluginDigest || second.digest !== first.digest
}

// Why a seat judge read valid or coverage-gap is not proven to have answered T3's latest run under
// its hooks, as reasons in this order, none when it is. T3's text is negative evidence only: it can
// turn either into unknown, and the answer still comes from the result Stop wrote. stale-turn: the
// latest run left no text (lib/t3-store.mjs says when it has none), its text is not byte for byte
// the final message Stop recorded, or it is a later run than the child's while no follow-up prompt
// is on record. hooks-changed: see hooksChanged.
function freshness(facts, run, record) {
  const reasons = []
  const latest = store.textDigest(run.latestText)
  if (latest === null || latest !== facts.messageSha256 || (run.latestOrdinal > run.childOrdinal && !facts.opened)) reasons.push('stale-turn')
  if (hooksChanged(record)) reasons.push('hooks-changed')
  return reasons
}

function close(argv) {
  const [id, ...rest] = argv
  if (typeof id !== 'string' || !SEAT_ID.test(id)) fail('BAD_REQUEST', 'close takes a seat id, 32 lowercase hex characters.')
  if (rest.includes('--abandon')) {
    if (rest.length !== 1) fail('BAD_REQUEST', 'close --abandon takes nothing else.')
    return abandon(id)
  }
  flags(rest, [])
  // T3's store comes first: a refusal there writes nothing, so a retry can still close the seat.
  const read = readSeatTask(id)
  if (!read.ok) fail(read.kind, read.message, read.details)
  const run = read.ambiguous ? null : read.run

  const loaded = store.readRecord(id)
  const judged = judge(id, loaded)
  // Two tasks for one seat outrank every verdict, since neither can be told for the seat's own.
  // Otherwise only a verdict with a result is checked against T3's latest run, so every other
  // verdict keeps its precedence, and the check can only turn valid or coverage-gap into unknown.
  const doubts = run === null ? ['task-ambiguous'] : RESULTS.has(judged.verdict) ? freshness(judged.facts, run, loaded.record) : []
  const { verdict, reasons } = doubts.length > 0 ? { verdict: 'unknown', reasons: doubts } : judged
  const { facts } = judged
  const { turn, resultSha256, servedModels, blocks, errors, messageSha256 } = facts
  const task = run === null ? { ambiguous: true, taskIds: read.taskIds } : read.task
  const closed = { verdict, reasons, task, runId: run?.latestRunId ?? null, turn, resultSha256, messageSha256, servedModels, blocks, errors }
  let out = { ok: true, id, verdict, reasons, turn, result: RESULTS.has(verdict) ? facts.envelope : null, servedModels, blocks, errors }
  if (!store.stamp(id, 'closed', closed)) {
    // An earlier or racing close holds the stamp, and its record stands; or the record directory
    // is gone, and nothing can be recorded.
    const recorded = store.readStamp(id, 'closed')
    if (recorded) out = repeated(id, recorded, run, loaded?.record ?? null)
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
  store.stamp(id, 'closed', { verdict: 'unknown', reasons: ['abandoned-before-bind'], abandoned: true, task: null, turn: null, resultSha256: null, servedModels: [], blocks: 0, errors: [] })
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

const USAGE = 'usage: seat.mjs open --access <read-only|workspace-write|review> --provider <claude|codex> [--provider-instance-id <id>] --model <id> [--expected-served-model <id>] --effort <level> [--worktree <abs>] [--base <rev> --head <rev>] [--schema <file>] | seat.mjs close <seat-id> | seat.mjs close <seat-id> --abandon | seat.mjs trust [--write --expect <digest>]'
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
