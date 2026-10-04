// Seat policy: what the T3 seat hooks decide, with no hook event names and no wire shapes. The
// adapter in hooks/scripts/seat-guard.mjs reads the call, asks here, and prints the answer through
// wire.mjs. Reads and writes of seat records go through lib/seat-store.mjs, which the adapter
// hands in, so this module never names a record path.
//
// The decisions that live here:
//
//   gateDelegateTask   the parent's PreToolUse on T3's delegate_task, in every session. A call
//                      without an explicit runtimeMode is denied, tagged or not, because a child
//                      copies its parent's mode at spawn and a parent switched to full access would
//                      silently widen every later child. A tagged call is admitted once, and only
//                      when it asks for exactly what the seat record names: the runtime mode, the
//                      provider, the model, the effort, and clientRequestId flow-seat-<id>, which
//                      T3 builds the task id from, so close can tell this seat's task from another.
//   bindProblem        the child's UserPromptSubmit: whether this session may bind the record. A
//                      failed bind makes a void seat, which the adapter records and announces.
//   seatCallProblem    the child's PreToolUse before containment: a void seat, a record that is
//                      missing or corrupt, a seat already closed, or a call that cannot be read is
//                      denied outright.
//   toolProblem        the child's PreToolUse containment, by the record's access: no spawned
//                      agent, no MCP tool off a two-name allowlist, edits only inside a writer's
//                      worktree, and through the shell no push, no gh but its reads, no git off
//                      the read and writer allowlists, no model CLI, no seat executor and nothing
//                      in the background.
//   stopTurn, finalAnswer, failedStop
//                      the child's Stop: which turn a stop belongs to, whether the final message
//                      is the flow envelope with an answer that matches the seat's schema, and
//                      what a failed one does: block with its problems, up to STOP_BLOCKS times a
//                      turn, then let the seat stop, capped.
//
// Every field a decision reads is checked for shape first, and a field that is missing or of the
// wrong type denies: a seat call is never admitted on a value this module had to guess at.
//
// Containment is the Seat Contract made mechanical for the calls a seat makes through its tools.
// The shell rules are a guardrail for a confused seat, at native-seat parity: they read the plain
// forms a seat writes and say so under The shell below. The edit rule resolves a target at hook
// time, so a symlink swapped in between the check and the write is not seen either. What the rules
// catch is the ordinary reach outside the seat, which is what the contract forbids.

import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { segments } from './hook-policy.mjs'
import { CHECK_SECONDS, checkAnswer, envelopeSchema, validate } from '../delegate/schema.mjs'
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
// The option id under which each provider's target carries its effort, as orchestrator_capabilities
// advertises it. T3 takes options as an array of {id, value} or as a record of id to value.
const EFFORT_OPTION = { claude: 'effort', codex: 'reasoningEffort' }
function optionValue(options, id) {
  if (Array.isArray(options)) {
    const named = options.filter((option) => plainObject(option) && option.id === id)
    return named.length === 1 ? named[0].value : undefined
  }
  return plainObject(options) && Object.hasOwn(options, id) ? options[id] : undefined
}
// Text from the call that is echoed back in a reason is capped, so the answer stays small.
const quote = (text) => JSON.stringify(String(text).slice(0, 200))
const deny = (why) => ({ deny: `flow seat: ${why}` })

/**
 * The parent's gate on one delegate_task call. Returns null when the call is not a seat call and
 * names its runtimeMode, which the caller allows by printing nothing; {deny: reason} to refuse it;
 * {admit: id} once the record's admitted stamp is written. deps.store is lib/seat-store.mjs and
 * deps.toolUseId, when a string, is recorded in the stamp beside the clientRequestId. The stamp is write-once, so of two
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
  const clientRequestId = `flow-seat-${id}`
  const mismatched = [
    ['runtimeMode', runtimeMode, record.runtimeMode],
    ['provider', provider, record.provider],
    ['model', target.model, record.model],
    [`target.options ${EFFORT_OPTION[provider]}`, optionValue(target.options, EFFORT_OPTION[provider]), record.effort],
    ['clientRequestId', toolInput.clientRequestId, clientRequestId],
  ].filter(([, asked, recorded]) => asked !== recorded)
  if (mismatched.length > 0) {
    const lines = mismatched.map(([field, , recorded]) => `${field} must be ${JSON.stringify(recorded)}`)
    return deny(`the call does not match seat ${id}'s record: ${lines.join('; ')}.`)
  }
  const stamp = typeof toolUseId === 'string' ? { toolUseId, clientRequestId } : { clientRequestId }
  if (!store.stamp(id, 'admitted', stamp)) return deny(`seat ${id} was admitted by another call first.`)
  return { admit: id }
}

/**
 * Why this session may not bind the seat, or null when it may. Each fact is read by the caller:
 * the host the hook runs on, whether the session id passed the store's validation, the session's
 * permission_mode, the readRecord result, and the admitted, bound, void and closed stamps (null
 * when absent).
 * Creating the session index and the bound stamp are the bind's last two steps and can still be
 * lost to a racer after a null here; the caller reports those as their own reasons.
 */
export function bindProblem({ host, sessionValid, permissionMode, seat, admitted, bound, voided, closed }) {
  if (!seat) return 'record-missing'
  // A closed record is over, such as one seat close --abandon gave up on after its delegate_task
  // call made no task: a child that starts for it late binds nothing.
  if (closed !== null && closed !== undefined) return 'record-closed'
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
 * the session index entry, seat the readRecord result for its id, and closed its closed stamp
 * (null when absent): a closed seat is over, so it makes no call at all.
 */
export function seatCallProblem({ entry, seat, closed = null, toolName, toolInput }) {
  if (entry.void !== undefined) {
    return `flow seat: this session is a void seat (${String(entry.void).slice(0, 64)}), so every tool call is denied. Stop and report that the seat is void.`
  }
  if (!seat) return 'flow seat: this seat\'s record is missing or corrupt, so every tool call is denied. Stop and report it.'
  if (closed !== null) return 'flow seat: this seat was closed, and its verdict is recorded, so every tool call is denied. Stop.'
  if (typeof toolName !== 'string' || !plainObject(toolInput)) return 'flow seat: the tool call could not be read, so it is denied.'
  return null
}

// ------------------------------------------------------------------------------ containment

/** The MCP tools a seat may call: Context7's two read-only documentation lookups. */
export const MCP_ALLOWLIST = Object.freeze(['mcp__claude_ai_Context7__query-docs', 'mcp__claude_ai_Context7__resolve-library-id'])
const MCP = new Set(MCP_ALLOWLIST)
const SPAWNS = new Set(['Agent', 'Task', 'Workflow'])
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit', 'apply_patch'])

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
    return shellProblem(record, toolInput.command, toolInput.run_in_background)
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

// A writer's git writes name its worktree as one unquoted `-C` word, because the shell rules read
// no quoting. seat.mjs open refuses a writer whose worktree path fails this, so it never opens a
// seat that could edit but never commit.
export function plainShellWord(path) {
  return typeof path === 'string' && /^[A-Za-z0-9_./:@+,-]+$/.test(path)
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
//
// A guardrail for a confused seat, at the parity native seats have, not a sandbox. Each rule
// reads hook-policy's segments(): every segment of the command with its quoted text and heredoc
// bodies blanked, and a string a shell or eval runs (`bash -c '...'`) read again as segments of
// its own. A rule looks at the command word: the first word after VAR=value assignments, shell
// keywords (`if`, `then`, `while`, `!` and the rest of KEYWORDS) and a group's `(` or `{`, with a
// leading backslash stripped and a path reduced to its basename, followed through the WRAPPERS
// below to the command they run, and for `find` into the command after -exec, -execdir, -ok or
// -okdir. That catches the plain forms a seat writes, `git push`, `env codex`, `(git push)`,
// `if git push; then`, `bash -c "gh pr create"`. It does not catch a command word or argument that
// is quoted, escaped or expanded, a command run by `source`, a command substitution or a command
// built at run time, a find command after the first `\;` of its -exec, or a command a wrapper off
// the list runs. A Bash write outside the worktree is not read at all, and a read-only seat is
// read-only by instruction for Bash. Native seats run Bash under the same posture.
//
// git and gh are read through allowlists. A git read runs bare in every seat, a writer seat also
// runs add, rm, mv, commit, restore and apply as `git -C <worktree>`, and every other subcommand,
// a user alias included, is denied. No git call carries -c, --config-env or a GIT_* variable set
// or exported in the same command, because configuration can make a read run a program; nor
// --output, -O or --ext-diff, which write a file or run a program; nor stash, whose stack every
// worktree of the repository shares. gh runs its read verbs, a GET `gh api` with its short flags
// written apart, `gh auth status` and `gh --version`, and nothing else. A seat runs nothing in the
// background, and no seat opens or closes a seat.

const MODEL_CLIS = new Set(['claude', 'codex', 'flow-delegate'])
const DETACHES = new Set(['setsid', 'disown', 'coproc'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// The wrappers followed to the command they run, each with the options that take a separate value.
// timeout's duration is skipped too. A package runner runs the command its package spec names.
const RUNNER = ['-p', '--package']
const SHELL = ['-o', '-O']
const WRAPPERS = new Map(Object.entries({
  env: ['-u', '--unset', '-C', '--chdir'], nice: ['-n', '--adjustment'], nohup: [], timeout: ['-s', '--signal', '-k', '--kill-after'],
  xargs: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--process-slot-var'],
  exec: ['-a'], command: [], builtin: [],
  sudo: ['-u', '--user', '-g', '--group', '-U', '--other-user', '-C', '--close-from', '-D', '--chdir', '-p', '--prompt', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-R', '--chroot', '--host'],
  time: ['-f', '--format', '-o', '--output'], stdbuf: ['-i', '--input', '-o', '--output', '-e', '--error'],
  npx: RUNNER, bunx: RUNNER, pnpx: RUNNER, sh: SHELL, bash: SHELL, zsh: SHELL,
  watch: ['-n', '--interval'], eval: [],
}))
// Reserved words that stand before a command, skipped as a wrapper is. A group's `(` or `{`, stuck
// to the word or standing apart, is skipped the same way, and a `)` closing the segment is dropped.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!'])
// The options of find that run a command. `-exec ... \;` ends with its segment, so the command is the
// rest of the words; `-exec ... {} +` ends at the `+`, and what follows is find's again.
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])
// `command -v` and `command -V` look a name up and run nothing.
const LOOKUP = /^-p*[vV]/
// A GIT_* variable set or exported anywhere in a command that runs git. A reference sets nothing.
const GIT_ENV = /^GIT_\w*(?:=|$)/
// A lone `&` outside quoted text: `&&`, `|&`, `>&`, `<&` and `&>` are not one. It is replaced by a
// marker word before segments() reads the command, so one in quoted text or a heredoc body is
// held out with that text, and one in a string a shell runs is read with that string.
const LONE_AMPERSAND = /(?<![&|<>\\])&(?![&>])/g
const MARK = '\u0001'
// `&>file` and `>&file` redirect as plainly as `>file`; segments() would leave their target as a word.
const AMPERSAND_REDIRECT = /&>|>&(?![\d-])/g

const NO_BACKGROUND = 'flow seat (no background): a seat runs every command in the foreground and watches it finish, so `&`, setsid, disown, coproc and run_in_background are denied. Run the command and wait for it.'

function shellProblem(record, command, background) {
  if (background === true || segments(command.replace(LONE_AMPERSAND, ` ${MARK} `)).some(({ bare }) => bare.includes(MARK))) return NO_BACKGROUND
  const reads = segments(command.replace(AMPERSAND_REDIRECT, '>')).map(({ bare }) => argvOf(bare.split(/\\?\s+/).filter(Boolean)))
  const gitEnv = reads.some((words) => words.some((word) => GIT_ENV.test(word)))
  for (const found of reads.flatMap(commandsOf)) {
    const { name, args } = found
    if (MODEL_CLIS.has(name)) {
      return `flow seat (no model through the shell): \`${name}\` reaches a model, and a seat reaches none through the shell. Do the work in this session.`
    }
    if (name === 'node' && args.some((arg) => arg.slice(arg.lastIndexOf('/') + 1) === 'seat.mjs')) {
      return 'flow seat (no seat executor): seat.mjs opens and closes seats, and that is the parent\'s work, not a seat\'s.'
    }
    if (DETACHES.has(name)) return NO_BACKGROUND
    const problem = name === 'git' ? gitProblem(record, args, gitEnv) : name === 'gh' ? ghProblem(args) : null
    if (problem) return problem
  }
  return null
}

// A segment's words without its redirections: a word holding `<` or `>` is one (quoted text is
// blanked, so neither can be inside one), and an operator standing alone takes its target with it.
function argvOf(words) {
  const argv = []
  for (let at = 0; at < words.length; at++) {
    if (!/[<>]/.test(words[at])) argv.push(words[at])
    else if (/^\d*[<>]+\|?$/.test(words[at])) at++
  }
  return argv
}

// Every command a segment runs: its command word, and for `find` each command after an -exec.
function commandsOf(words) {
  const found = commandOf(words)
  if (!found) return []
  const runs = [found]
  if (found.name !== 'find') return runs
  for (let at = 0; at < found.args.length; at++) {
    if (!FIND_EXEC.has(found.args[at])) continue
    const end = found.args.indexOf('+', at)
    runs.push(...commandsOf(found.args.slice(at + 1, end < 0 ? undefined : end)))
  }
  return runs
}

// The command words run: {name, args}, or null when the segment runs no command.
function commandOf(words) {
  words = words.length ? [...words.slice(0, -1), words.at(-1).replace(/\)+$/, '')].filter(Boolean) : words
  let runner = false
  for (let at = 0; at < words.length;) {
    const open = words[at].replace(/^[({]+/, '')
    if (open === '' || KEYWORDS.has(open) || ASSIGNMENT.test(open)) { at++; continue }
    const word = open.replace(/^\\/, '')
    let name = word.slice(word.lastIndexOf('/') + 1)
    if (runner) name = name.split('@')[0]
    const npmExec = name === 'npm' && ['exec', 'x'].includes(words[at + 1])
    const takesValue = npmExec ? RUNNER : WRAPPERS.get(name)
    if (!takesValue) return { name, args: words.slice(at + 1) }
    at += npmExec ? 2 : 1
    while (at < words.length && words[at].startsWith('-') && words[at] !== '-') {
      if (words[at] === '--') { at++; break }
      if (name === 'command' && LOOKUP.test(words[at])) return null
      at += takesValue.includes(words[at]) ? 2 : 1
    }
    if (name === 'timeout') at++
    runner = takesValue === RUNNER
  }
  return null
}

// ----- git

const GIT_READS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'blame', 'grep', 'describe',
  'merge-base', 'rev-list', 'shortlog', 'show-ref', 'for-each-ref', 'name-rev',
])
// What a writer seat runs beyond the reads, and only as `git -C <worktree>`.
const GIT_WRITES = new Set(['add', 'rm', 'mv', 'commit', 'restore', 'apply'])
const READ_LIST = 'status, log, diff, show, rev-parse, ls-files, ls-tree, cat-file, blame, grep, describe, merge-base, rev-list, shortlog, show-ref, for-each-ref, name-rev, a branch, tag or remote listing, config --get or --list, worktree list and reflog'

const GIT_CONFIG_DENIED = 'flow seat (git configuration): a seat\'s git call carries no -c, no --config-env and no GIT_* variable set or exported in the same command, reads included, because configuration can make git run a program. Run git with the configuration it has.'
const GIT_FILE_DENIED = (flag) => `flow seat (git output): \`${flag}\` makes git write a file or run a program, so it is denied in every seat. Read the output on stdout.`

function gitProblem(record, args, gitEnv) {
  const dirs = []
  let config = gitEnv
  let override = false
  let at = 0
  for (; at < args.length && args[at].startsWith('-'); at++) {
    const flag = args[at]
    if (flag === '-C') dirs.push(args[++at])
    else if (flag === '-c' || flag === '--config-env') { config = true; at++ }
    else if (/^-c./.test(flag) || flag.startsWith('--config-env=')) config = true
    else if (['--git-dir', '--work-tree'].includes(flag)) { override = true; at++ }
    else if (/^--(?:git-dir|work-tree)=/.test(flag)) override = true
    else if (['--namespace', '--super-prefix', '--list-cmds'].includes(flag)) at++
  }
  const sub = args[at]
  const rest = args.slice(at + 1)
  if (sub === 'push') return 'flow seat (no git push): a seat never pushes; the parent publishes what the seat committed.'
  if (config) return GIT_CONFIG_DENIED
  if (sub === undefined) return null
  if (sub === 'stash') return 'flow seat (no git stash): the stash stack is shared by every worktree of the repository, so a seat neither reads nor writes it.'
  const file = rest.find((word) => (word.startsWith('--') && ['--output', '--ext-diff', '--open-files-in-pager'].some((option) => abbreviates(word, option))) || /^-[A-Za-z]*O/.test(word))
  if (file) return GIT_FILE_DENIED(file.split('=')[0])
  if (sub === 'apply' && rest.some((word) => ['--unsafe-paths', '--directory'].some((option) => abbreviates(word, option)))) {
    return 'flow seat (git apply in place): --unsafe-paths and --directory let a patch land outside the worktree, so they are denied in every seat.'
  }
  if (gitReads(sub, rest)) return null
  if (record.access !== 'workspace-write') {
    return `flow seat (git read allowlist): \`git ${sub}\` is an unknown or writing git subcommand, and this ${record.access} seat writes nothing. The reads allowed are git ${READ_LIST}.`
  }
  if (!GIT_WRITES.has(sub)) {
    return `flow seat (git write allowlist): \`git ${sub}\` is neither a git read nor one of a writer seat's writes, add, rm, mv, commit, restore and apply, so it is denied. Branches, configuration, remotes, worktrees, the stash and clones are the parent's.`
  }
  const worktree = realWorktree(record)
  const form = sub === 'commit' ? `git -C ${worktree} commit -m <message> -- <paths>` : `git -C ${worktree} ${sub} ...`
  if (!worktree || !plainShellWord(worktree)) {
    return 'flow seat (git -C the worktree): this seat\'s worktree path could not be resolved to a plain shell word, so no git write is allowed.'
  }
  if (dirs.length !== 1 || dirs[0] !== worktree || override) {
    return `flow seat (git -C the worktree): a git write in this seat runs only as \`${form}\`, with the worktree path written out and no --git-dir, --work-tree or second -C. Reads (git ${READ_LIST}) run bare.`
  }
  if (sub === 'add' && addsAll(rest)) {
    return `flow seat (add by path): -A, --all, -u, --update, --renormalize and --no-ignore-removal stage only the paths a seat names, as \`git -C ${worktree} add -A -- <paths>\`.`
  }
  if (sub === 'commit' && !commitNamesPaths(rest)) {
    return `flow seat (commit by path): a seat commits only the paths it names, as \`${form}\`; -a, --all, -i, --include, --pathspec-from-file and a commit of the whole index are denied.`
  }
  return null
}

// Whether `git <sub> <rest>` only reads. A subcommand off the list is a write, whatever it does.
function gitReads(sub, rest) {
  if (GIT_READS.has(sub)) return true
  switch (sub) {
    case 'branch': return branchReads(rest)
    case 'tag': return rest.every((word) => word === '-l' || word === '--list' || !word.startsWith('-')) &&
      (rest.length === 0 || rest.includes('-l') || rest.includes('--list'))
    case 'remote': return rest.length === 0 || (rest.length === 1 && ['-v', '--verbose'].includes(rest[0]))
    case 'config': return rest.some((word) => CONFIG_READS.has(word)) && rest.every((word) => CONFIG_READS.has(word) || !word.startsWith('-'))
    case 'worktree': return rest[0] === 'list'
    case 'reflog': return rest.length === 0 || rest[0] === 'show' || rest[0].startsWith('-')
    default: return false
  }
}

const CONFIG_READS = new Set(['--get', '--get-all', '--list', '-l'])
const BRANCH_LIST = new Set(['--list', '-l', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current'])
const BRANCH_COMMIT = new Set(['--contains', '--merged', '--no-merged'])
// A branch listing: listing flags alone, a commit after --contains, --merged or --no-merged, and
// patterns only beside --list or -l. A bare name creates a branch.
function branchReads(rest) {
  const listing = rest.includes('--list') || rest.includes('-l')
  for (let at = 0; at < rest.length; at++) {
    const word = rest[at]
    if (BRANCH_LIST.has(word) || /^--(?:contains|merged|no-merged)=/.test(word)) continue
    if (BRANCH_COMMIT.has(word)) {
      if (rest[at + 1] !== undefined && !rest[at + 1].startsWith('-')) at++
      continue
    }
    if (word.startsWith('-') || !listing) return false
  }
  return true
}

// git takes any unambiguous prefix of a long option, so `--incl` is --include. A prefix of three
// characters or more stands for the option here, ambiguous ones included, which git refuses anyway.
const abbreviates = (word, option) => word.length >= 3 && option.startsWith(word.split('=')[0])

// True when `git add` stages more than the paths it names: a flag that widens it to the whole tree,
// with no path operand to narrow it.
const ADD_WIDE = ['--all', '--update', '--renormalize', '--no-ignore-removal']
function addsAll(rest) {
  const end = rest.indexOf('--')
  const options = end < 0 ? rest : rest.slice(0, end)
  const wide = options.some((word) => (word.startsWith('--') && ADD_WIDE.some((option) => abbreviates(word, option))) || /^-[A-Za-z]*[Au]/.test(word))
  const paths = options.filter((word) => !word.startsWith('-')).length + (end < 0 ? 0 : rest.length - end - 1)
  return wide && paths === 0
}

const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'C', 'c', 't'])
const COMMIT_VALUE_LONG = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--author', '--date', '--fixup', '--squash', '--template', '--cleanup', '--trailer'])
const COMMIT_WHOLE_INDEX = ['--all', '--include', '--pathspec-from-file']
// True when the commit names at least one path on its command line and commits nothing beyond them:
// no -a or --all, and no -i or --include, which commits the index as staged beside the paths. A
// quoted value is blanked, so an option's value is the next word only when that word is not
// itself an option; `-` is stdin, never a path.
function commitNamesPaths(rest) {
  let paths = 0
  const value = (at) => rest[at + 1] !== undefined && !rest[at + 1].startsWith('-')
  for (let at = 0; at < rest.length; at++) {
    const word = rest[at]
    if (word === '--') { paths += rest.slice(at + 1).filter((path) => path !== '-').length; break }
    if (word.startsWith('--')) {
      if (COMMIT_WHOLE_INDEX.some((option) => abbreviates(word, option))) return false
      if (!word.includes('=') && [...COMMIT_VALUE_LONG].some((option) => abbreviates(word, option)) && value(at)) at++
      continue
    }
    if (word.startsWith('-')) {
      for (let i = 1; i < word.length; i++) {
        if (word[i] === 'a' || word[i] === 'i') return false
        if (COMMIT_VALUE_SHORT.has(word[i])) {
          if (i === word.length - 1 && value(at)) at++
          break
        }
      }
      continue
    }
    paths++
  }
  return paths > 0
}

// ----- gh

const GH_GROUPS = new Set(['pr', 'issue', 'release', 'repo', 'run', 'workflow', 'label', 'gist'])
const GH_READS = new Set(['view', 'list', 'status', 'diff', 'checks', 'search'])
// `gh search` reads by what it searches for, so its verbs are the kinds of thing searched.
const GH_SEARCHES = new Set(['code', 'commits', 'issues', 'prs', 'repos'])
const GH_DENIED = (what) => `flow seat (gh reads only): \`gh ${what}\` is not one of the gh reads a seat runs, and a seat changes nothing on GitHub. The reads are gh pr, issue, release, repo, run, workflow, label or gist with view, list, status, diff, checks or search; gh search; gh api as a GET; gh auth status; gh --version. Put anything else in your report for the parent.`

function ghProblem(args) {
  if (args.length === 1 && args[0] === '--version') return null
  const verbAfter = (from) => {
    let at = from
    while (at < args.length && args[at].startsWith('-')) at += args[at] === '-R' || args[at] === '--repo' ? 2 : 1
    return at
  }
  const groupAt = verbAfter(0)
  const group = args[groupAt]
  if (group === undefined) return GH_DENIED(args.join(' ').slice(0, 80))
  if (group === 'api') return ghApiProblem(args.slice(groupAt + 1))
  const verbAt = verbAfter(groupAt + 1)
  const verb = args[verbAt]
  if (verb === undefined) return GH_DENIED(group)
  // `gh auth status` is a read only as exactly those two words: --show-token (-t) prints the
  // credential into the transcript, and gh parses it wherever it sits, before either word too.
  const reads = (args.length === 2 && args[0] === 'auth' && args[1] === 'status') || (group === 'search' && GH_SEARCHES.has(verb)) ||
    (GH_GROUPS.has(group) && GH_READS.has(verb))
  return reads ? null : GH_DENIED(`${group} ${verb}`)
}

function ghApiProblem(args) {
  const denied = 'flow seat (gh reads only): this `gh api` call can change GitHub (a method other than GET, or -f, -F, --field, --raw-field or --input), and a seat changes nothing there. Read with a plain `gh api <endpoint>` GET.'
  for (let at = 0; at < args.length; at++) {
    const word = args[at]
    if (/^-[^-]{2,}/.test(word)) {
      return `flow seat (gh api separate flags): \`${word.slice(0, 40)}\` clusters short flags, which can hide a method or a field, so a seat writes each gh api flag apart, as \`-X GET\`.`
    }
    let method = null
    if (word === '-X' || word === '--method') method = args[++at] ?? ''
    else if (word.startsWith('--method=')) method = word.slice('--method='.length)
    if (method !== null && method.toUpperCase() !== 'GET') return denied
    if (word === '-f' || word === '-F' || /^--(?:field|raw-field|input)(?:=|$)/.test(word)) return denied
  }
  return null
}

// ----- the final message

/** How many times Stop refuses a turn's final message before it lets the seat stop, capped. */
export const STOP_BLOCKS = 3
const LINE_LIMIT = 10
const SCHEMA_CONTEXT_BYTES = 16 * 1024
const ENVELOPE = '{"status": "done" | "partial" | "blocked", "coverage": {"read": [], "partial": [], "unopened": [], "checksRun": []}, "notes": "", "answer": <your answer>}'
const COMMITS = '"commits": [{"sha": "<sha>", "subject": "<subject>"}]'
const envelopeFor = (access) => (access === 'workspace-write' ? `${ENVELOPE.slice(0, -1)}, ${COMMITS}}` : ENVELOPE)

/** A turn key as the hooks record it: the host's id for the turn, or null when it cannot be read. */
export const turnKeyOf = (key) => (typeof key === 'string' && key !== '' ? key : null)

/**
 * The turn a stop belongs to, from the state Stop last wrote (null for none) and this stop's turn
 * key, the host's id for the turn. A new key starts the next turn with no blocks; the same key, or
 * a stop whose key cannot be read, continues the current one, so blocks still count toward the cap.
 * messageSha256 is the digest of the last final message Stop checked in the turn, null in a new one.
 * opened, the key of the last turn a prompt opened after the bind, is carried over unchanged.
 */
export function stopTurn(state, turnKey) {
  const key = turnKeyOf(turnKey)
  const opened = plainObject(state) && Object.hasOwn(state, 'opened') ? { opened: state.opened } : {}
  const current = plainObject(state) && Number.isSafeInteger(state.turn) && state.turn > 0 ? state : null
  if (current && (key === null || key === current.turnKey)) {
    return {
      ...opened,
      turn: current.turn,
      turnKey: current.turnKey ?? null,
      blocks: Number.isSafeInteger(current.blocks) ? current.blocks : 0,
      outcome: current.outcome ?? null,
      errors: Array.isArray(current.errors) ? current.errors : [],
      stops: (Number.isSafeInteger(current.stops) ? current.stops : 0) + 1,
      messageSha256: typeof current.messageSha256 === 'string' ? current.messageSha256 : null,
    }
  }
  return { ...opened, turn: (current?.turn ?? 0) + 1, turnKey: key, blocks: 0, outcome: null, errors: [], stops: 1, messageSha256: null }
}

/**
 * The seat's cumulative served models after a stop: the set the state Stop last wrote holds (null
 * for none), with the models this stop saw added in first-seen order.
 */
export function seenModels(state, seen) {
  const before = plainObject(state) && Array.isArray(state.models) ? state.models.filter((model) => typeof model === 'string') : []
  return [...new Set([...before, ...seen.filter((model) => typeof model === 'string')])]
}

/**
 * The seat's final message checked as its answer: {envelope} when it passes, else {errors}, as
 * `path: problem` lines (validate stops at ten). The message is one JSON object, alone or as the
 * whole of one fenced block. The envelope is checked here, against envelopeSchema for the record's access; the answer
 * inside it is checked against the schema file at schemaPath (null when the seat has none) by
 * checkAnswer, in a child process killed after CHECK_SECONDS, and a check that does not finish is
 * a failure like any other.
 */
export function finalAnswer(record, text, schemaPath) {
  const read = readMessage(text)
  if (read.errors) return read
  const errors = validate(envelopeSchema(record.access), read.value)
  if (errors.length > 0) return { errors }
  if (schemaPath !== null) {
    let found
    try { found = checkAnswer(schemaPath, read.value.answer, CHECK_SECONDS * 1000) } catch {
      return { errors: ['$.answer: the schema check ended without a verdict'] }
    }
    if (found === null) return { errors: [`$.answer: the schema check did not finish in ${CHECK_SECONDS} seconds`] }
    if (found.length > 0) return { errors: found.map((line) => line.replace(/^\$/, '$.answer')) }
  }
  return { envelope: read.value }
}

// A fence that opens the message and one that closes it. A message holding two blocks matches too,
// with the fences between them inside the capture, and fails to parse: no JSON text holds a line
// that starts with a fence.
const FENCED = /^```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n```$/
function readMessage(text) {
  if (typeof text !== 'string') return { errors: ['$: the final message could not be read'] }
  const trimmed = text.trim()
  const fenced = FENCED.exec(trimmed)
  const body = fenced ? fenced[1] : trimmed
  let value
  try { value = JSON.parse(body) } catch {
    return { errors: ['$: the final message is not one JSON object, alone or as the whole of one fenced block'] }
  }
  if (!plainObject(value)) return { errors: ['$: the final message is JSON but not one object'] }
  return { value }
}

/**
 * What Stop does after a final message failed: the next state, and the reason to block with, or
 * null once the turn has used its STOP_BLOCKS blocks, when the state records the turn capped.
 * blocks counts the blocks sent, so a capped turn reads STOP_BLOCKS.
 */
export function failedStop(record, state, errors) {
  const lines = errors.slice(0, LINE_LIMIT)
  if (state.blocks >= STOP_BLOCKS) return { state: { ...state, outcome: 'capped', errors: lines }, block: null }
  const blocks = state.blocks + 1
  const reason = [
    `flow seat: your final message is not a valid flow envelope (block ${blocks} of ${STOP_BLOCKS}). Fix these and end your turn again with the corrected message:`,
    ...lines,
    `Your final message is one JSON object, alone or as the whole of one fenced block: ${envelopeFor(record.access)}`,
  ].join('\n')
  return { state: { ...state, blocks, outcome: 'blocked', errors: lines }, block: reason }
}

/**
 * The context a bound seat reads before its task: one sentence that sets the orchestrator half
 * aside, the record's facts, the envelope its final message must be, and the answer schema from
 * the record (schema, null when the seat has none). The Seat Contract itself arrived at
 * SessionStart and is not repeated.
 */
export function seatContext(record, schema = null) {
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
      `- git reads run as usual. Your git writes are add, rm, mv, commit, restore and apply, each as \`git -C ${record.worktree} ...\`, and you commit by path: \`git -C ${record.worktree} commit -m <message> -- <paths>\`.`,
    )
  } else if (record.access === 'review') {
    lines.push(`- review worktree: ${record.worktree}, base ${record.baseSha}, head ${record.headSha}. Edit nothing.`)
  } else {
    lines.push(`- worktree: ${record.worktree}. Edit nothing.`)
  }
  lines.push(
    '',
    'Your final message is one JSON object in the flow envelope and nothing else, alone or as the whole of one fenced block:',
    envelopeFor(record.access),
    'coverage lists the files you read whole, read in part and left unopened, and the checks you ran. A stop hook checks the message and returns any problem to you to fix.',
  )
  if (record.access === 'workspace-write') lines.push('commits lists every commit you made, each with its full SHA.')
  const text = schema === null ? null : JSON.stringify(schema)
  if (text === null) lines.push('`answer` is the JSON value your task asks for; this seat has no answer schema.')
  else if (Buffer.byteLength(text) > SCHEMA_CONTEXT_BYTES) lines.push('`answer` follows the answer schema your task names; it is over 16 KiB, so it is not repeated here.')
  else lines.push('`answer` must match this JSON Schema:', text)
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
