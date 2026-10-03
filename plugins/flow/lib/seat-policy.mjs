// Seat policy: what the T3 seat hooks decide, with no hook event names and no wire shapes. The
// adapter in hooks/scripts/seat-guard.mjs reads the call, asks here, and prints the answer through
// wire.mjs. Reads and writes of seat records go through lib/seat-store.mjs, which the adapter
// hands in, so this module never names a record path.
//
// Three decisions live here:
//
//   gateDelegateTask   the parent's PreToolUse on T3's delegate_task, in every session. A call
//                      without an explicit runtimeMode is denied, tagged or not, because a child
//                      copies its parent's mode at spawn and a parent switched to full access would
//                      silently widen every later child. A tagged call is admitted once, and only
//                      when it asks for exactly what the seat record names.
//   bindProblem        the child's UserPromptSubmit: whether this session may bind the record. A
//                      failed bind makes a void seat, which the adapter records and announces.
//   seatCallProblem    the child's PreToolUse before containment: a void seat, a record that is
//                      missing or corrupt, or a call that cannot be read is denied outright.
//   toolProblem        the child's PreToolUse containment, by the record's access: no spawned
//                      agent, no MCP tool off a two-name allowlist, edits only inside a writer's
//                      worktree, and no push, GitHub mutation or model CLI through the shell.
//
// Every field a decision reads is checked for shape first, and a field that is missing or of the
// wrong type denies: a seat call is never admitted on a value this module had to guess at.
//
// Containment is the Seat Contract made mechanical for the calls a seat makes through its tools.
// Like the guards in lib/hook-policy.mjs, the shell rules read shell text with regexes and a word
// split, not a shell parser: a command word assembled at run time (`g''it`, `$G push`) is not seen,
// and a word that only names a command (`which codex`) is denied. The edit rule resolves a target
// at hook time, so a symlink swapped in between the check and the write is not seen either. What
// the rules catch is the ordinary reach outside the seat, which is what the contract forbids.

import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { OPAQUE, segments } from './hook-policy.mjs'
import { inside } from './state-dir.mjs'

/** The permission_mode each host reports for T3's `auto` runtime mode, measured on 2026-10-03. */
export const PERMISSION_MODES = Object.freeze({
  claude: Object.freeze(['auto']),
  codex: Object.freeze(['default']),
})

// T3 names its providers by instance id; the record names the host family.
const PROVIDERS = new Map([['claudeAgent', 'claude'], ['codex', 'codex']])
const ACCESS = new Set(['read-only', 'workspace-write', 'review'])

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
// Text from the call that is echoed back in a reason is capped, so the answer stays small.
const quote = (text) => JSON.stringify(String(text).slice(0, 200))
const deny = (why) => ({ deny: `flow seat: ${why}` })

/**
 * The parent's gate on one delegate_task call. Returns null when the call is not a seat call and
 * names its runtimeMode, which the caller allows by printing nothing; {deny: reason} to refuse it;
 * {admit: id} once the record's admitted stamp is written. deps.store is lib/seat-store.mjs and
 * deps.toolUseId, when a string, is recorded in the stamp. The stamp is write-once, so of two
 * calls racing to admit one record exactly one is admitted and the other is denied.
 */
export function gateDelegateTask(toolInput, { store, toolUseId } = {}) {
  if (!plainObject(toolInput)) return deny('the delegate_task call could not be read, so it is refused.')
  const { runtimeMode, task } = toolInput
  if (runtimeMode === undefined || runtimeMode === null || runtimeMode === 'inherit') {
    return deny('every delegate_task call in a flow session names runtimeMode explicitly; a child that inherits copies the parent\'s mode, full access included. Pass the mode `seat open` printed, `auto` today.')
  }
  if (typeof runtimeMode !== 'string') return deny('runtimeMode is not a string, so the call is refused.')
  if (typeof task !== 'string') return deny('the delegate_task task is not a string, so the call is refused.')

  const tag = store.parseTag(task)
  if (tag === null) return null
  if (tag.void) return deny('a seat tag appears in the task but not as the whole of line 1. Put the tag `seat open` printed alone on line 1.')

  const { id } = tag
  const loaded = store.readRecord(id)
  if (!loaded) return deny(`seat ${id} has no readable seat record. Open a new seat.`)
  if (store.readStamp(id, 'admitted') !== null) return deny(`seat ${id} was already admitted once. Open a new seat for another task.`)
  const { record } = loaded
  if (toolInput.role !== 'general') return deny('a seat call passes role "general", so T3 prepends nothing to the task.')
  const { target } = toolInput
  if (!plainObject(target) || typeof target.providerInstanceId !== 'string' || typeof target.model !== 'string') {
    return deny('the call\'s target.providerInstanceId or target.model could not be read, so the call is refused.')
  }
  const provider = PROVIDERS.get(target.providerInstanceId)
  if (!provider) return deny(`provider instance ${JSON.stringify(target.providerInstanceId.slice(0, 64))} is neither claudeAgent nor codex.`)
  const mismatched = [
    ['runtimeMode', runtimeMode, record.runtimeMode],
    ['provider', provider, record.provider],
    ['model', target.model, record.model],
  ].filter(([, asked, recorded]) => asked !== recorded)
  if (mismatched.length > 0) {
    const lines = mismatched.map(([field, , recorded]) => `${field} must be ${JSON.stringify(recorded)}`)
    return deny(`the call does not match seat ${id}'s record: ${lines.join('; ')}.`)
  }
  const stamp = typeof toolUseId === 'string' ? { toolUseId } : {}
  if (!store.stamp(id, 'admitted', stamp)) return deny(`seat ${id} was admitted by another call first.`)
  return { admit: id }
}

/**
 * Why this session may not bind the seat, or null when it may. Each fact is read by the caller:
 * the host the hook runs on, whether the session id passed the store's validation, the session's
 * permission_mode, the readRecord result, and the admitted, bound and void stamps (null when
 * absent).
 * Creating the session index and the bound stamp are the bind's last two steps and can still be
 * lost to a racer after a null here; the caller reports those as their own reasons.
 */
export function bindProblem({ host, sessionValid, permissionMode, seat, admitted, bound, voided }) {
  if (!seat) return 'record-missing'
  // A record voided by a failed first bind stays void: a retry needs a fresh record and admission.
  if (voided !== null && voided !== undefined) return 'record-void'
  if (admitted === null || admitted === undefined) return 'not-admitted'
  if (bound !== null && bound !== undefined) return 'already-bound'
  if (!sessionValid) return 'session-id-invalid'
  if (seat.record.provider !== host) return 'host-mismatch'
  if (!(PERMISSION_MODES[host] ?? []).includes(permissionMode)) return 'permission-mode-not-allowed'
  if (!ACCESS.has(seat.record.access)) return 'record-access-unknown'
  return null
}

/**
 * Why a tool call in a seat session is denied before containment looks at it, or null. entry is
 * the session index entry, seat the readRecord result for its id.
 */
export function seatCallProblem({ entry, seat, toolName, toolInput }) {
  if (entry.void !== undefined) {
    return `flow seat: this session is a void seat (${String(entry.void).slice(0, 64)}), so every tool call is denied. Stop and report that the seat is void.`
  }
  if (!seat) return 'flow seat: this seat\'s record is missing or corrupt, so every tool call is denied. Stop and report it.'
  if (typeof toolName !== 'string' || !plainObject(toolInput)) return 'flow seat: the tool call could not be read, so it is denied.'
  return null
}

// ------------------------------------------------------------------------------ containment

/** The MCP tools a seat may call: Context7's two read-only documentation lookups. */
export const MCP_ALLOWLIST = Object.freeze(['mcp__claude_ai_Context7__query-docs', 'mcp__claude_ai_Context7__resolve-library-id'])
const MCP = new Set(MCP_ALLOWLIST)
const SPAWNS = new Set(['Agent', 'Task', 'Workflow'])
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit', 'apply_patch'])
const MODEL_CLIS = new Set(['claude', 'codex', 'flow-delegate'])

// The git subcommands that write to a repository, its refs or its remotes. `branch` and `config`
// write only in some forms and are read by their own functions below. push is here too, though
// every seat denies it before this set is read.
const GIT_WRITES = new Set([
  'commit', 'add', 'rm', 'mv', 'reset', 'checkout', 'switch', 'restore', 'merge', 'rebase', 'cherry-pick',
  'revert', 'stash', 'tag', 'apply', 'am', 'clean', 'worktree', 'update-ref', 'push', 'fetch', 'pull', 'gc', 'prune',
])
// Environment assignments that point git at another repository, index or configuration: the
// environment spellings of --git-dir, --work-tree and -c, refused beside a writer's git write.
const GIT_ENV = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG\w*)=/

// The gh verbs that change GitHub, by command group.
const GH_MUTATIONS = {
  pr: new Set(['create', 'merge', 'close', 'reopen', 'edit', 'comment', 'review', 'ready', 'lock', 'unlock', 'update-branch', 'revert']),
  issue: new Set(['create', 'close', 'reopen', 'edit', 'comment', 'delete', 'transfer', 'pin', 'unpin', 'lock', 'unlock', 'develop']),
  release: new Set(['create', 'delete', 'edit', 'upload', 'delete-asset']),
  repo: new Set(['create', 'delete', 'edit', 'fork', 'rename', 'archive', 'unarchive', 'sync']),
}

// A command word as the shell would run it: the leading `$(`, `(`, backquote, `{`, `!`, `<`, `>`
// or backslash of a substitution, subshell, group or escape stripped, and any trailing `)`,
// backquote or `}`. So `echo $(git push)` reads `git` then `push`.
const bareWord = (word) => word.replace(/^[\\$(<>`{!]+/, '').replace(/[)`}]+$/, '')
const commandName = (word) => {
  const name = bareWord(word)
  return name.slice(name.lastIndexOf('/') + 1)
}
const unreadable = (word) => word.includes(OPAQUE) || word.startsWith('$')

/**
 * Why a bound, healthy seat may not make this call, or null when containment allows it.
 * record is the seat record; cwd is the session directory the hook reported, against which a
 * relative edit target is resolved; patchPaths is wire.mjs's applyPatchPaths, handed in by the
 * adapter because the apply_patch envelope is a wire format. Every reason names its rule.
 */
export function toolProblem({ record, toolName, toolInput, cwd }, { patchPaths }) {
  if (SPAWNS.has(toolName) || toolName.endsWith('spawn_agent') || toolName.startsWith('collaboration')) {
    return `flow seat (no spawns): ${quote(toolName)} starts another agent, and a seat does its work itself, in this session.`
  }
  if (toolName.startsWith('mcp__')) {
    if (MCP.has(toolName)) return null
    return `flow seat (MCP allowlist): ${quote(toolName)} is not on this seat's MCP allowlist, which holds Context7's query-docs and resolve-library-id alone.`
  }
  if (EDITS.has(toolName)) return editProblem(record, toolName, toolInput, cwd, patchPaths)
  if (toolName === 'Bash') {
    if (typeof toolInput.command !== 'string') return 'flow seat (shell): the command could not be read, so it is denied.'
    return shellProblem(record, toolInput.command)
  }
  return null
}

// ----- edits

function editProblem(record, toolName, toolInput, cwd, patchPaths) {
  if (record.access !== 'workspace-write') {
    return `flow seat (no edits): this ${record.access} seat edits nothing, so ${toolName} is denied. Report the change instead of making it.`
  }
  const targets = editTargets(toolName, toolInput, patchPaths)
  if (!targets) return `flow seat (edit targets): every target of this ${toolName} call could not be read, so it is denied.`
  const worktree = realWorktree(record)
  if (!worktree) return 'flow seat (edits inside the worktree): this seat\'s worktree could not be resolved, so no edit is allowed.'
  for (const target of targets) {
    const resolved = resolveTarget(target, cwd)
    if (!resolved || !inside(worktree, resolved.path)) {
      return `flow seat (edits inside the worktree): ${quote(target)} does not resolve inside ${worktree}, and a writer seat edits only inside its worktree.`
    }
    if (resolved.parts.includes('.git') || relative(worktree, resolved.path).split(sep).includes('.git')) {
      return `flow seat (no .git edits): ${quote(target)} is inside a .git directory or file. Change the repository through git, as \`git -C ${worktree} ...\`.`
    }
  }
  return null
}

// Every path the call names, or null when one is unreadable or none is named. A field that is
// present must be a non-empty string, and a patch envelope rides beside a file_path rather than
// being vouched for by it: apply_patch is Codex's edit, and its targets come from the envelope.
function editTargets(toolName, toolInput, patchPaths) {
  const targets = []
  for (const key of ['file_path', 'notebook_path']) {
    const value = toolInput[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value === '') return null
    targets.push(value)
  }
  if (toolName === 'apply_patch' || toolInput.command !== undefined) {
    if (typeof toolInput.command !== 'string') return null
    const parsed = patchPaths(toolInput.command)
    if (!parsed.complete) return null
    targets.push(...parsed.paths)
  }
  return targets.length > 0 ? targets : null
}

function realWorktree(record) {
  if (typeof record.worktree !== 'string' || !isAbsolute(record.worktree)) return null
  try { return realpathSync.native(record.worktree) } catch { return null }
}

// Where a write to target lands: the realpath of its nearest existing ancestor joined to the
// components below it that do not exist yet. Components are resolved by the kernel, not by
// lexical normalisation, so `link/..` goes where the link points. A `..` among the missing
// components has no answer this can give: `missing/../link/x` would join lexically to `link/x`
// and never resolve the link. Neither does a missing component that exists as a dangling symlink,
// or a relative target without an absolute cwd. Each returns null.
function resolveTarget(target, cwd) {
  if (target.includes('\0')) return null
  let raw
  if (isAbsolute(target)) raw = target
  else if (typeof cwd === 'string' && isAbsolute(cwd)) raw = `${cwd}/${target}`
  else return null
  const parts = raw.split('/')
  for (let n = parts.length; n >= 1; n--) {
    let real
    // realpath(3) itself: fs.realpathSync normalises `..` lexically before it resolves anything.
    try { real = realpathSync.native(parts.slice(0, n).join('/') || '/') } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue
      return null
    }
    const rest = parts.slice(n).filter((part) => part !== '' && part !== '.')
    if (rest.includes('..')) return null
    if (rest.length > 0) {
      try {
        lstatSync(join(real, rest[0]))
        return null
      } catch {}
    }
    return { path: join(real, ...rest), parts }
  }
  return null
}

// ----- the shell

function shellProblem(record, command) {
  const reads = segments(command)
  const gitEnv = reads.some(({ words }) => words.some((word) => GIT_ENV.test(bareWord(word))))
  for (const { words } of reads) {
    for (let at = 0; at < words.length; at++) {
      const name = commandName(words[at])
      if (MODEL_CLIS.has(name)) {
        return `flow seat (no model through the shell): \`${name}\` reaches a model, and a seat reaches none through the shell. Do the work in this session.`
      }
      const args = words.slice(at + 1)
      const problem = name === 'git' ? gitProblem(record, args, gitEnv) : name === 'gh' ? ghProblem(args) : null
      if (problem) return problem
    }
  }
  return null
}

function gitProblem(record, args, gitEnv) {
  const dirs = []
  let override = gitEnv
  let at = 0
  for (; at < args.length && args[at].startsWith('-'); at++) {
    const flag = args[at]
    if (flag === '-C') dirs.push(args[++at])
    else if (['-c', '--config-env', '--git-dir', '--work-tree'].includes(flag)) { override = true; at++ }
    else if (/^--(?:config-env|git-dir|work-tree)=/.test(flag)) override = true
    else if (['--namespace', '--super-prefix', '--list-cmds'].includes(flag)) at++
  }
  if (at >= args.length) return null
  if (unreadable(args[at])) {
    return 'flow seat (git): the git subcommand is quoted or expanded at run time, so this guard cannot read it and the command is denied. Write the subcommand plainly.'
  }
  const sub = bareWord(args[at])
  const rest = args.slice(at + 1).map(bareWord)
  if (sub === 'push') return 'flow seat (no git push): a seat never pushes; the parent publishes what the seat committed.'
  const writes = GIT_WRITES.has(sub) || (sub === 'branch' && branchWrites(rest)) || (sub === 'config' && configWrites(rest))
  if (!writes) return null
  if (record.access !== 'workspace-write') {
    return `flow seat (no git writes): \`git ${sub}\` writes to the repository, and this ${record.access} seat writes nothing. Reads such as git status, log, diff and show are allowed.`
  }
  const worktree = realWorktree(record)
  const form = sub === 'commit' ? `git -C ${worktree} commit -m <message> -- <paths>` : `git -C ${worktree} ${sub} ...`
  if (!worktree || !/^[A-Za-z0-9_./:@+,-]+$/.test(worktree)) {
    return 'flow seat (git -C the worktree): this seat\'s worktree path could not be resolved to a plain shell word, so no git write is allowed.'
  }
  if (dirs.length !== 1 || dirs[0] !== worktree || override) {
    return `flow seat (git -C the worktree): a git write in this seat runs only as \`${form}\`, with the worktree path written out and no --git-dir, --work-tree, second -C, -c or GIT_DIR-style variable.`
  }
  if (sub === 'commit' && !commitNamesPaths(rest)) {
    return `flow seat (commit by path): a seat commits only the paths it names, as \`${form}\`; -a, --all, --pathspec-from-file and a commit of the whole index are denied.`
  }
  return null
}

const BRANCH_WRITE_LONG = new Set(['--delete', '--move'])
function branchWrites(rest) {
  return rest.some((word) => BRANCH_WRITE_LONG.has(word) || /^-[A-Za-z]*[dDmM][A-Za-z]*$/.test(word))
}

const CONFIG_WRITE_FLAGS = new Set(['--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit'])
const CONFIG_WRITE_VERBS = new Set(['set', 'unset', 'rename-section', 'remove-section', 'edit'])
const CONFIG_VALUE_FLAGS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url'])
// `config` writes when it sets, unsets or edits: a write flag or verb, or a key and a value.
function configWrites(rest) {
  const positional = []
  let reads = false
  for (let at = 0; at < rest.length; at++) {
    const word = rest[at]
    if (CONFIG_WRITE_FLAGS.has(word)) return true
    if (CONFIG_VALUE_FLAGS.has(word)) at++
    else if (word.startsWith('--get') || word === '--list' || word === '-l') reads = true
    else if (!word.startsWith('-')) positional.push(word)
  }
  if (CONFIG_WRITE_VERBS.has(positional[0])) return true
  if (reads || positional[0] === 'get' || positional[0] === 'list') return false
  return positional.length >= 2
}

const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'C', 'c', 't'])
const COMMIT_VALUE_LONG = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--author', '--date', '--fixup', '--squash', '--template', '--cleanup', '--trailer'])
// True when the commit names at least one path on its command line and stages nothing beyond them.
function commitNamesPaths(rest) {
  let paths = 0
  for (let at = 0; at < rest.length; at++) {
    const word = rest[at]
    if (word === '--') { paths += rest.length - at - 1; break }
    if (word === '--all' || word.startsWith('--pathspec-from-file')) return false
    if (word.startsWith('--')) {
      if (COMMIT_VALUE_LONG.has(word)) at++
      continue
    }
    if (word.startsWith('-') && word.length > 1) {
      for (let i = 1; i < word.length; i++) {
        if (word[i] === 'a') return false
        if (COMMIT_VALUE_SHORT.has(word[i])) {
          if (i === word.length - 1) at++
          break
        }
      }
      continue
    }
    paths++
  }
  return paths > 0
}

function ghProblem(args) {
  const verbAfter = (from) => {
    let at = from
    while (at < args.length && args[at].startsWith('-')) at += args[at] === '-R' || args[at] === '--repo' ? 2 : 1
    return at
  }
  const groupAt = verbAfter(0)
  if (groupAt >= args.length) return null
  if (unreadable(args[groupAt])) return 'flow seat (no gh mutations): the gh command is quoted or expanded at run time, so this guard cannot read it and the command is denied. Write it plainly.'
  const group = bareWord(args[groupAt])
  if (group === 'api') return ghApiProblem(args.slice(groupAt + 1))
  if (!GH_MUTATIONS[group]) return null
  const verbAt = verbAfter(groupAt + 1)
  if (verbAt >= args.length) return null
  const verb = bareWord(args[verbAt])
  if (unreadable(args[verbAt]) || GH_MUTATIONS[group].has(verb)) {
    return `flow seat (no gh mutations): \`gh ${group} ${unreadable(args[verbAt]) ? '<unreadable>' : verb}\` changes GitHub, and a seat changes nothing there. Put it in your report for the parent.`
  }
  return null
}

function ghApiProblem(args) {
  const denied = 'flow seat (no gh mutations): this `gh api` call can change GitHub (a method other than GET, or -f, -F, --field, --raw-field or --input), and a seat changes nothing there. Read with a plain `gh api <endpoint>` GET.'
  for (let at = 0; at < args.length; at++) {
    const word = args[at]
    let method = null
    if (word === '-X' || word === '--method') method = args[++at] ?? ''
    else if (word.startsWith('--method=')) method = word.slice('--method='.length)
    else if (/^-X./.test(word)) method = word.slice(2)
    if (method !== null && (unreadable(method) || method.toUpperCase() !== 'GET')) return denied
    if (/^-[fF]/.test(word) || /^--(?:field|raw-field|input)(?:=|$)/.test(word)) return denied
  }
  return null
}

const ENVELOPE = '{"status": "done" | "partial" | "blocked", "coverage": {"read": [], "partial": [], "unopened": [], "checksRun": []}, "notes": "", "answer": {}}'

/**
 * The context a bound seat reads before its task: one sentence that sets the orchestrator half
 * aside, the record's facts, and the envelope its final message must be. The Seat Contract itself
 * arrived at SessionStart and is not repeated.
 */
export function seatContext(record) {
  const lines = [
    'The orchestrator half of the flow charter does not apply in this session: you are a flow seat, and the Seat Contract governs.',
    '',
    `Seat ${record.id}:`,
    `- access: ${record.access}`,
    `- provider: ${record.provider}, model: ${record.model}, effort: ${record.effort}, runtimeMode: ${record.runtimeMode}`,
    `- repository: ${record.repoRoot}`,
  ]
  if (record.access === 'workspace-write') {
    lines.push(
      `- worktree: ${record.worktree}. Edit only inside it.`,
      `- run every git write as \`git -C ${record.worktree} ...\`, and commit by path: \`git -C ${record.worktree} commit -- <paths>\`.`,
    )
  } else if (record.access === 'review') {
    lines.push(`- review worktree: ${record.worktree}, base ${record.baseSha}, head ${record.headSha}. Edit nothing.`)
  } else {
    lines.push(`- worktree: ${record.worktree}. Edit nothing.`)
  }
  lines.push(
    '',
    'Your final message is one JSON object in the flow envelope and nothing else:',
    ENVELOPE,
    '`answer` follows the answer schema your task names.',
  )
  if (record.access === 'workspace-write') lines.push('Add "commits": [{"sha": "", "subject": ""}] with every commit you made.')
  return lines.join('\n')
}

/**
 * Why a tagged prompt is refused when its session could not be recorded at all, bound or void.
 * The user reads this, not the model: no turn runs on the prompt.
 */
export function unindexedSeatReason(reason) {
  return `flow seat: this prompt carries a seat tag, but the seat could not be recorded for this session (${reason}), so the prompt is refused. The parent reads this seat's verdict as unknown.`
}

/** The context a void seat reads: it must stop, because every tool call it makes is denied. */
export function voidSeatContext(reason) {
  return [
    `This session carries a flow seat tag, but it could not bind as a flow seat (${reason}), so it is a void seat.`,
    'Every tool call in this session is denied. Do no work: reply with one line saying the seat is void and why, then stop.',
    'The parent reads this seat\'s verdict as unknown and reruns the work elsewhere.',
  ].join('\n')
}
