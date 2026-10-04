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
//                      when it asks for exactly what the seat record names.
//   bindProblem        the child's UserPromptSubmit: whether this session may bind the record. A
//                      failed bind makes a void seat, which the adapter records and announces.
//   seatCallProblem    the child's PreToolUse before containment: a void seat, a record that is
//                      missing or corrupt, or a call that cannot be read is denied outright.
//   toolProblem        the child's PreToolUse containment, by the record's access: no spawned
//                      agent, no MCP tool off a two-name allowlist, edits only inside a writer's
//                      worktree, and through the shell no push, no gh but its reads, no git off
//                      the read and writer allowlists, and no model CLI.
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
// The shell rules read quoting, substitutions, heredocs and redirections with a small lexer and
// the rest with hook-policy's word split, not a full shell parser: a command word assembled at run
// time (`g''it`, `$G push`) is not seen, nor is input typed into a running process (Codex's
// write_stdin), nor a command behind a wrapper the rules do not list. The edit rule resolves a target
// at hook time, so a symlink swapped in between the check and the write is not seen either. What
// the rules catch is the ordinary reach outside the seat, which is what the contract forbids.

import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { OPAQUE, segments } from './hook-policy.mjs'
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
//
// Each rule reads a command in command position: the first word of a segment once its VAR=value
// assignments, redirections and shell keywords are passed, and the command a listed wrapper runs
// (env, exec, nohup, nice, timeout, xargs, sudo, command, time, watch, stdbuf, eval, the package
// runners npx, bunx, pnpx and `npm exec`, and a shell given -c), and each command find runs
// through -exec, -execdir, -ok or -okdir. So `env X=1 npx codex` runs codex, and `which codex`,
// `command -v codex`, `ls dir/codex` and `echo codex` run which, a lookup, ls and echo. watch
// hands its words to a shell, so its literals are read as commands too. A wrapper off that list
// (make, a script) hides the command it runs from these rules.
//
// Before the words are read, lexShell reads the raw command the way the shell quotes it, and every
// command substitution outside single quotes, `$(...)`, a backquoted command, `<(...)` and `>(...)`,
// is checked as a command of its own, double-quoted or nested ones included. segments() masks a
// double-quoted string whole, so `echo "$(git push)"` would otherwise read as an echo. A
// substitution, quote or heredoc delimiter that does not close cannot be read, and a seat denies it.
// A command that runs a shell or eval has every literal in it checked as a command too, so a
// substitution inside a single-quoted `bash -c` string is read; like hook-policy's own reading, a
// literal beside such a string is read as a command as well, at the cost of one rephrase.
//
// Redirections are dropped from a segment's words before any argument is read, so the target of
// `>log`, `2> err` or a heredoc is never taken for a path, a branch name or a subcommand.
//
// git and gh are read through allowlists. A git read subcommand runs bare in every seat, a writer
// seat also runs add, rm, mv, commit, restore, stash and apply as `git -C <worktree>`, and every
// other subcommand, a user alias included, is denied. No git call in a seat, a read included,
// carries -c, --config-env or a GIT_* variable in its command, because configuration can make a
// read run a program (a pager, an external diff, a textconv); nor --output, which writes a file,
// nor --ext-diff, which runs one. gh runs its read verbs, a GET `gh api`, `gh auth status` and
// `gh --version`, and nothing else.

const MODEL_CLIS = new Set(['claude', 'codex', 'flow-delegate'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash'])
const RUNNERS = new Set(['npx', 'bunx', 'pnpx'])
// Reserved words that a command follows: grammar, not the command. `time` is a wrapper below,
// so that the options of /usr/bin/time are passed too.
const KEYWORDS = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'do', 'while', 'until'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// The wrappers that run the command after their options, each with the options that take a value.
const WRAPPERS = {
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  exec: new Set(['-a']),
  nohup: new Set(),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  xargs: new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--process-slot-var']),
  sudo: new Set(['-u', '--user', '-g', '--group', '-U', '--other-user', '-C', '--close-from', '-D', '--chdir', '-p', '--prompt', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-R', '--chroot', '--host']),
  command: new Set(),
  time: new Set(['-f', '--format', '-o', '--output']),
  watch: new Set(['-n', '--interval', '-q', '--equexit']),
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
}
// The compound forms a seat may not use. A case arm and a function body put commands where the
// segment reading does not look (`x) git push`, `f() { gh pr create; }; f`), and a coproc runs one
// unseen, so a seat runs its commands directly instead. if, for, while, until, `{ }` and `( )` are
// read: the word after their keywords and grouping tokens is in command position.
const COMPOUND = new Set(['case', 'function', 'coproc'])
const FUNCTION_HEADER = /^[A-Za-z_][\w.:-]*\(\)/
// `command -v` and `command -V`, alone or beside -p, look a name up and run nothing.
const LOOKUP = /^-p*[vV][pvV]*$/
// find runs the words after each of these as a command, up to a `;` or `+` word.
const FIND_RUNS = new Set(['-exec', '-execdir', '-ok', '-okdir'])
// Options whose value is itself a command line: env's split string, a package runner's call.
const ENV_COMMAND = new Set(['-S', '--split-string'])
const RUNNER_COMMAND = new Set(['-c', '--call'])
const RUNNER_VALUES = new Set(['-p', '--package'])
const SHELL_DEPTH = 8

// A GIT_* variable set or exported anywhere in a command that runs git: GIT_DIR=x, export
// GIT_PAGER, env GIT_CONFIG_COUNT=1. Git reads dozens of them, some of which point it at another
// repository or index and some of which run a program, so a seat's git call is refused beside any
// of them. A reference, $GIT_DIR, sets nothing and is not one.
const GIT_ENV = /^GIT_\w*(?:=|$)/
const gitEnvWord = (word) => GIT_ENV.test(word.replace(/^[\\(<>`{!]+/, ''))

// A word as the shell would run it: the leading `$(`, `(`, backquote, `{`, `!`, `<`, `>` or
// backslash of a substitution, subshell, group or escape stripped, and any trailing `)`, backquote
// or `}`.
const bareWord = (word) => word.replace(/^[\\$(<>`{!]+/, '').replace(/[)`}]+$/, '')
const commandName = (word) => {
  const name = bareWord(word)
  return name.slice(name.lastIndexOf('/') + 1)
}
const unreadable = (word) => word.includes(OPAQUE) || word.startsWith('$')
// The command a package runner runs from a package spec: `@openai/codex@1.2` runs codex.
const packageCommand = (word) => {
  const name = commandName(word)
  return name.startsWith('@') ? name : name.split('@')[0]
}

function shellProblem(record, command, depth = 0) {
  if (depth > SHELL_DEPTH) {
    return `flow seat (shell): this command nests shells and substitutions more than ${SHELL_DEPTH} deep, so this guard cannot read it and the command is denied.`
  }
  let lexed
  try { lexed = lexShell(command) } catch (error) {
    if (error !== UNCLOSED) throw error
    return 'flow seat (shell): a quote, command substitution, backquote or heredoc in this command does not close where this guard can read it, so the command is denied. Write it plainly.'
  }
  for (const body of lexed.bodies) {
    const problem = shellProblem(record, body, depth + 1)
    if (problem) return problem
  }
  const reads = segments(lexed.text)
  const gitEnv = reads.some(({ words }) => words.some(gitEnvWord))
  const ran = { runsText: false }
  for (const { words } of reads) {
    const argv = argvOf(words)
    if (argv === null) return 'flow seat (shell): a redirection in this command names no target, so this guard cannot read it and the command is denied.'
    const problem = commandProblem(record, argv, gitEnv, ran)
    if (problem) return problem
  }
  if (ran.runsText) {
    for (const literal of lexed.literals) {
      const problem = shellProblem(record, literal, depth + 1)
      if (problem) return problem
    }
  }
  return null
}

// The problem with the command argv runs, or null. ran.runsText is set when a shell, eval or
// watch on the way runs text. find runs a command per -exec, -execdir, -ok or -okdir clause, and
// each clause is read as a command of its own, up to the `;` or `+` that ends it.
function commandProblem(record, argv, gitEnv, ran, depth = 0) {
  const found = commandOf(argv)
  if (!found) return null
  if (found.opaque) {
    return `flow seat (shell): \`${found.opaque}\` runs a quoted command line this guard cannot read, so the command is denied. Run the command plainly.`
  }
  if (found.compound) {
    return `flow seat (compound shell forms): this command uses ${found.compound}, and compound shell forms (case, function definitions, coproc) are not allowed in a seat. Run the commands directly.`
  }
  ran.runsText ||= found.runsText
  const { name, args } = found
  if (MODEL_CLIS.has(name)) {
    return `flow seat (no model through the shell): \`${name}\` reaches a model, and a seat reaches none through the shell. Do the work in this session.`
  }
  if (name === 'git') return gitProblem(record, args, gitEnv)
  if (name === 'gh') return ghProblem(args)
  if (name === 'find' && depth < SHELL_DEPTH) {
    for (let at = 0; at < args.length; at++) {
      if (!FIND_RUNS.has(bareWord(args[at]))) continue
      let end = at + 1
      while (end < args.length && !findEnds(args[end])) end++
      const problem = commandProblem(record, args.slice(at + 1, end), gitEnv, ran, depth + 1)
      if (problem) return problem
    }
  }
  return null
}
// The word that ends a find clause: `+`, or the escaped `\;` that the lexer marks. A quoted `';'`
// reads as OPAQUE, like a quoted `'{}'`, so it ends nothing: the clause then runs on to the next
// end, which can only add arguments, and every -exec in the find is read as its own clause anyway.
const findEnds = (word) => word === '+' || word.endsWith(FIND_END)

// ----- reading the raw command

const UNCLOSED = Symbol('unclosed')
// Stands for a heredoc's delimiter word in the rewritten command, so the opener reads as `<<` with
// an attached target, which argvOf drops like any other redirection.
const HEREDOC_MARK = '\u0001'
// Stands for an escaped `;`, which ends a find -exec clause.
const FIND_END = '\u0002'

/**
 * The raw command read the way the shell quotes it: the body of every command substitution that is
 * not inside single quotes, every literal (single-quoted, double-quoted, heredoc body), and the
 * command rewritten for segments(): `&>` and `>&file` spelled as plain `>`, input duplications and
 * closes (`<&0`, `0<&3`, `<&-`) dropped, an escaped `;` marked, and each heredoc reduced to its
 * opener with a mark for its delimiter and its body and delimiter line taken out, so no redirection
 * target reads as an argument and no heredoc text reaches segments(). Throws UNCLOSED when a quote,
 * substitution, backquote or heredoc delimiter does not close.
 */
function lexShell(text) {
  const out = { bodies: [], literals: [], edits: [] }
  lex(text, 0, false, out)
  let rewritten = text
  for (const [start, end, value] of out.edits.reverse()) rewritten = rewritten.slice(0, start) + value + rewritten.slice(end)
  return { bodies: out.bodies, literals: out.literals, text: rewritten }
}

// Read from at. Inside a substitution body (nested), return the index of its closing parenthesis;
// at the top, read to the end. out is null inside a body, which is read again as its own command.
function lex(text, at, nested, out) {
  let depth = 0
  let wordStart = true
  let heredocs = []
  while (at < text.length) {
    const c = text[at]
    const next = text[at + 1]
    if (c === '\\') {
      // An escaped `;` is a word, find's clause end, not a separator: segments() would split on it.
      if (next === ';') out?.edits.push([at, at + 2, FIND_END])
      at += 2
      wordStart = false
      continue
    }
    if (c === '\n' && heredocs.length > 0) {
      at = readHeredocs(text, at + 1, heredocs, out)
      heredocs = []
      wordStart = true
      continue
    }
    if (c === '#' && wordStart) {
      const end = text.indexOf('\n', at)
      at = end < 0 ? text.length : end
      continue
    }
    if (c === "'") {
      const end = text.indexOf("'", at + 1)
      if (end < 0) throw UNCLOSED
      out?.literals.push(text.slice(at + 1, end))
      at = end + 1
      wordStart = false
      continue
    }
    if (c === '"') { at = lexDouble(text, at + 1, out); wordStart = false; continue }
    if (c === '`') { at = lexBackquote(text, at + 1, out); wordStart = false; continue }
    if ((c === '$' || c === '<' || c === '>') && next === '(') { at = lexSubstitution(text, at + 2, out); wordStart = false; continue }
    if (c === '<' && next === '<') {
      if (text[at + 2] === '<') { at += 3; continue }
      at = heredocOpener(text, at + 2, heredocs, out)
      continue
    }
    if (c === '<' && next === '&') {
      // An input duplication or close names a descriptor, not a file: drop it whole, with the
      // descriptor before it, before segments() splits the command at its `&`.
      let start = at
      while (start > 0 && /\d/.test(text[start - 1])) start--
      if (start > 0 && !/[\s;&|(]/.test(text[start - 1])) start = at
      let end = at + 2
      while (/[\d-]/.test(text[end] ?? '')) end++
      out?.edits.push([start, end, ' '])
      at = end
      continue
    }
    if (c === '&' && next === '>') {
      out?.edits.push([at, at + 1, ' '])
      at += 2
      continue
    }
    if (c === '>' && next === '&') {
      if (text[at + 2] === '-') {
        let start = at
        while (start > 0 && /\d/.test(text[start - 1])) start--
        if (start > 0 && !/[\s;&|(]/.test(text[start - 1])) start = at
        out?.edits.push([start, at + 3, ' '])
        at += 3
      } else {
        if (!/\d/.test(text[at + 2] ?? '')) out?.edits.push([at, at + 2, '>'])
        at += 2
      }
      continue
    }
    if (nested) {
      if (c === '(') depth++
      else if (c === ')') {
        if (depth === 0) return at
        depth--
      }
    }
    wordStart = /[\s;&|()]/.test(c)
    at++
  }
  if (nested) throw UNCLOSED
  return at
}

function lexDouble(text, at, out) {
  const start = at
  while (at < text.length) {
    const c = text[at]
    if (c === '\\') at += 2
    else if (c === '"') {
      out?.literals.push(text.slice(start, at))
      return at + 1
    } else if (c === '`') at = lexBackquote(text, at + 1, out)
    else if (c === '$' && text[at + 1] === '(') at = lexSubstitution(text, at + 2, out)
    else at++
  }
  throw UNCLOSED
}

function lexSubstitution(text, at, out) {
  const end = lex(text, at, true, null)
  out?.bodies.push(text.slice(at, end))
  return end + 1
}

function lexBackquote(text, at, out) {
  let body = ''
  while (at < text.length) {
    const c = text[at]
    if (c === '\\' && /[`\\$]/.test(text[at + 1] ?? '')) {
      body += text[at + 1]
      at += 2
    } else if (c === '`') {
      out?.bodies.push(body)
      return at + 1
    } else {
      body += c
      at++
    }
  }
  throw UNCLOSED
}

// A heredoc opener after `<<`: its delimiter, read as one shell word with its quotes removed (so
// `'END DATA'` is the delimiter END DATA), joins the list whose bodies start at the next newline.
// Any quoting in the word makes the body plain text. The opener is rewritten as `<<` and the mark.
function heredocOpener(text, at, heredocs, out) {
  const opener = at - 2
  let dash = false
  if (text[at] === '-') { dash = true; at++ }
  while (text[at] === ' ' || text[at] === '\t') at++
  let delimiter = ''
  let quoted = false
  while (at < text.length && !/[\s;&|<>()]/.test(text[at])) {
    const c = text[at]
    if (c === "'") {
      const end = text.indexOf("'", at + 1)
      if (end < 0) throw UNCLOSED
      delimiter += text.slice(at + 1, end)
      quoted = true
      at = end + 1
    } else if (c === '"') {
      let end = at + 1
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      if (end >= text.length) throw UNCLOSED
      delimiter += text.slice(at + 1, end).replace(/\\(["\\$`])/g, '$1')
      quoted = true
      at = end + 1
    } else if (c === '\\') {
      delimiter += text[at + 1] ?? ''
      quoted = true
      at += 2
    } else {
      delimiter += c
      at++
    }
  }
  if (delimiter === '' && !quoted) throw UNCLOSED
  heredocs.push({ delimiter, quoted, dash })
  out?.edits.push([opener, at, `<<${HEREDOC_MARK}`])
  return at
}

// The bodies of the pending heredocs, one after another, each ending at a line that is its
// delimiter (bash also ends one at the delimiter followed by the `)` of a substitution). A body
// with an unquoted delimiter expands substitutions, so they are read from it; a quoted one is text.
function readHeredocs(text, at, heredocs, out) {
  for (const { delimiter, quoted, dash } of heredocs) {
    const start = at
    let end = text.length
    let resume = text.length
    while (at < text.length) {
      const newline = text.indexOf('\n', at)
      const lineEnd = newline < 0 ? text.length : newline
      const line = text.slice(at, lineEnd)
      const stripped = dash ? line.replace(/^\t+/, '') : line
      if (stripped.startsWith(delimiter) && /^[ \t)]*$/.test(stripped.slice(delimiter.length))) {
        end = at
        resume = at + (line.length - stripped.length) + delimiter.length
        break
      }
      at = newline < 0 ? text.length : newline + 1
    }
    const body = text.slice(start, end)
    if (out) {
      out.literals.push(body)
      if (!quoted) lexHeredocBody(body, out)
      out.edits.push([start, resume, ''])
    }
    at = resume
  }
  return at
}

function lexHeredocBody(body, out) {
  let at = 0
  while (at < body.length) {
    const c = body[at]
    if (c === '\\') at += 2
    else if (c === '`') at = lexBackquote(body, at + 1, out)
    else if (c === '$' && body[at + 1] === '(') at = lexSubstitution(body, at + 2, out)
    else at++
  }
}

// A segment's words with every redirection and its target removed, or null when a redirection
// names no target. An operator may stand alone (`> log`), carry its target (`>log`, `2>err`), or
// follow a word it is joined to (`a.txt>log`); a run of digits before it is the descriptor. A word
// that holds a quoted string holds no operator: the quotes were masked out of it.
const REDIRECTION = /<<<|<<-?|<>|<&|>>|>\||>&|>(?!\()|<(?!\()/
function argvOf(words) {
  const argv = []
  for (let at = 0; at < words.length; at++) {
    const word = words[at]
    const match = REDIRECTION.exec(word)
    if (!match) { argv.push(word); continue }
    const before = word.slice(0, match.index)
    if (before !== '' && !/^\d+$/.test(before)) argv.push(before)
    if (match.index + match[0].length === word.length) {
      if (at + 1 >= words.length) return null
      at++
    }
  }
  return argv
}

// The command in command position of words, past assignments, keywords and listed wrappers:
// {name, args, runsText}, args being the raw words after it and runsText whether a shell or eval
// on the way runs text; {opaque: wrapper} when a wrapper's command line is a quoted string;
// {compound: form} when the segment opens a case, a function definition or a coproc; or null
// when the segment runs no command.
function commandOf(words) {
  let at = 0
  let runsText = false
  for (;;) {
    const word = words[at]
    if (word === undefined) return null
    const bare = bareWord(word)
    if (bare === '' || KEYWORDS.has(bare) || ASSIGNMENT.test(bare)) { at++; continue }
    if (COMPOUND.has(bare)) return { compound: `\`${bare}\`` }
    if (FUNCTION_HEADER.test(word) || (words[at + 1] ?? '').startsWith('()')) return { compound: 'a function definition' }
    const name = commandName(word)
    if (Object.hasOwn(WRAPPERS, name)) {
      const next = afterOptions(words, at + 1, WRAPPERS[name], name === 'env' ? ENV_COMMAND : null)
      if (next.opaque) return { opaque: name }
      if (name === 'command' && words.slice(at + 1, next.at).some((word) => LOOKUP.test(bareWord(word)))) return null
      if (name === 'watch') runsText = true
      if (next.command !== undefined) at = next.command
      else at = name === 'timeout' ? next.at + 1 : next.at
      continue
    }
    if (name === 'eval') { runsText = true; at++; continue }
    const runner = RUNNERS.has(name) ? name : name === 'npm' && ['exec', 'x'].includes(bareWord(words[at + 1] ?? '')) ? 'npm exec' : null
    if (runner) {
      const next = afterOptions(words, at + (runner === 'npm exec' ? 2 : 1), RUNNER_VALUES, RUNNER_COMMAND)
      if (next.opaque) return { opaque: runner }
      if (next.command !== undefined) { at = next.command; continue }
      if (words[next.at] === undefined) return null
      words = [packageCommand(words[next.at]), ...words.slice(next.at + 1)]
      at = 0
      continue
    }
    if (SHELLS.has(name)) {
      runsText = true
      const next = shellCommand(words, at + 1)
      if (next === null) return { name, args: words.slice(at + 1), runsText }
      at = next
      continue
    }
    return { name, args: words.slice(at + 1), runsText }
  }
}

// Past a wrapper's options from at: {at} of the first word that is not an option, {command} of a
// command-line option's plain value, or {opaque: true} when that value is a quoted string.
function afterOptions(words, at, takesValue, commandLine) {
  while (at < words.length) {
    const word = bareWord(words[at])
    if (word === '--') return { at: at + 1 }
    if (!word.startsWith('-') || word === '-') return { at }
    if (commandLine?.has(word.split('=')[0])) {
      if (word.includes('=')) return { opaque: true }
      const value = words[at + 1]
      if (value === undefined) return { at: at + 1 }
      return unreadable(value) ? { opaque: true } : { command: at + 1 }
    }
    at += takesValue.has(word) ? 2 : 1
  }
  return { at }
}

// Where the command a shell's -c runs starts, or null when the shell runs no plain -c string: a
// script, stdin, or a quoted string, which segments() and the literal reading take instead.
function shellCommand(words, at) {
  let runs = false
  while (at < words.length) {
    const word = bareWord(words[at])
    if (word === '--') { at++; break }
    if (!/^[-+]/.test(word)) break
    if (['-o', '+o', '-O', '+O'].includes(word)) { at += 2; continue }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) runs = true
    at++
  }
  return runs && words[at] !== undefined && !unreadable(words[at]) ? at : null
}

// ----- git

const GIT_READS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'blame', 'grep', 'describe',
  'merge-base', 'rev-list', 'shortlog', 'show-ref', 'for-each-ref', 'name-rev',
])
// What a writer seat runs beyond the reads, and only as `git -C <worktree>`.
const GIT_WRITES = new Set(['add', 'rm', 'mv', 'commit', 'restore', 'stash', 'apply'])
const READ_LIST = 'status, log, diff, show, rev-parse, ls-files, ls-tree, cat-file, blame, grep, describe, merge-base, rev-list, shortlog, show-ref, for-each-ref, name-rev, a branch, tag or remote listing, config --get or --list, worktree list, stash list and reflog'

const GIT_CONFIG_DENIED = 'flow seat (git configuration): a seat\'s git call carries no -c, no --config-env and no GIT_* variable set or exported in the same command, reads included, because configuration can make git run a program. Run git with the configuration it has.'
const GIT_FILE_DENIED = (flag) => `flow seat (git output): \`${flag}\` makes git write a file or run an external diff, so it is denied in every seat. Read the output on stdout.`

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
  if (at >= args.length) return config ? GIT_CONFIG_DENIED : null
  if (unreadable(args[at])) {
    return 'flow seat (git): the git subcommand is quoted or expanded at run time, so this guard cannot read it and the command is denied. Write the subcommand plainly.'
  }
  const sub = bareWord(args[at])
  const rest = args.slice(at + 1).map(bareWord)
  if (sub === 'push') return 'flow seat (no git push): a seat never pushes; the parent publishes what the seat committed.'
  if (config) return GIT_CONFIG_DENIED
  const file = rest.find((word) => word.startsWith('--') && (abbreviates(word, '--output') || abbreviates(word, '--ext-diff')))
  if (file) return GIT_FILE_DENIED(file.split('=')[0])
  if (gitReads(sub, rest)) return null
  if (record.access !== 'workspace-write') {
    return `flow seat (git read allowlist): \`git ${sub}\` is an unknown or writing git subcommand, and this ${record.access} seat writes nothing. The reads allowed are git ${READ_LIST}.`
  }
  if (!GIT_WRITES.has(sub)) {
    return `flow seat (git write allowlist): \`git ${sub}\` is neither a git read nor one of a writer seat's writes, add, rm, mv, commit, restore, stash and apply, so it is denied. Branches, configuration, remotes, worktrees and clones are the parent's.`
  }
  const worktree = realWorktree(record)
  const form = sub === 'commit' ? `git -C ${worktree} commit -m <message> -- <paths>` : `git -C ${worktree} ${sub} ...`
  if (!worktree || !/^[A-Za-z0-9_./:@+,-]+$/.test(worktree)) {
    return 'flow seat (git -C the worktree): this seat\'s worktree path could not be resolved to a plain shell word, so no git write is allowed.'
  }
  if (dirs.length !== 1 || dirs[0] !== worktree || override) {
    return `flow seat (git -C the worktree): a git write in this seat runs only as \`${form}\`, with the worktree path written out and no --git-dir, --work-tree or second -C. Reads (git ${READ_LIST}) run bare.`
  }
  if (sub === 'add' && addsAll(rest)) {
    return `flow seat (add by path): a seat stages only the paths it names, as \`git -C ${worktree} add -- <paths>\`; -A, --all and --no-ignore-removal are denied.`
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
    case 'worktree':
    case 'stash': return rest[0] === 'list'
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

// True when `git add` stages everything rather than the paths it names.
function addsAll(rest) {
  const end = rest.indexOf('--')
  return (end < 0 ? rest : rest.slice(0, end)).some((word) =>
    (word.startsWith('--') && (abbreviates(word, '--all') || abbreviates(word, '--no-ignore-removal'))) || /^-[A-Za-z]*A[A-Za-z]*$/.test(word))
}

const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'C', 'c', 't'])
const COMMIT_VALUE_LONG = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--author', '--date', '--fixup', '--squash', '--template', '--cleanup', '--trailer'])
const COMMIT_WHOLE_INDEX = ['--all', '--include', '--pathspec-from-file']
// True when the commit names at least one path on its command line and commits nothing beyond them:
// no -a or --all, and no -i or --include, which commits the index as staged beside the paths.
function commitNamesPaths(rest) {
  let paths = 0
  for (let at = 0; at < rest.length; at++) {
    const word = rest[at]
    if (word === '--') { paths += rest.length - at - 1; break }
    if (word.startsWith('--')) {
      if (COMMIT_WHOLE_INDEX.some((option) => abbreviates(word, option))) return false
      if (!word.includes('=') && [...COMMIT_VALUE_LONG].some((option) => abbreviates(word, option))) at++
      continue
    }
    if (word.startsWith('-') && word.length > 1) {
      for (let i = 1; i < word.length; i++) {
        if (word[i] === 'a' || word[i] === 'i') return false
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

// ----- gh

const GH_GROUPS = new Set(['pr', 'issue', 'release', 'repo', 'run', 'workflow', 'label', 'gist'])
const GH_READS = new Set(['view', 'list', 'status', 'diff', 'checks', 'search'])
// `gh search` reads by what it searches for, so its verbs are the kinds of thing searched.
const GH_SEARCHES = new Set(['code', 'commits', 'issues', 'prs', 'repos'])
const GH_DENIED = (what) => `flow seat (gh reads only): \`gh ${what}\` is not one of the gh reads a seat runs, and a seat changes nothing on GitHub. The reads are gh pr, issue, release, repo, run, workflow, label or gist with view, list, status, diff, checks or search; gh search; gh api as a GET; gh auth status; gh --version. Put anything else in your report for the parent.`

function ghProblem(args) {
  if (args.length === 1 && bareWord(args[0]) === '--version') return null
  const verbAfter = (from) => {
    let at = from
    while (at < args.length && args[at].startsWith('-')) at += args[at] === '-R' || args[at] === '--repo' ? 2 : 1
    return at
  }
  const groupAt = verbAfter(0)
  if (groupAt >= args.length) return GH_DENIED(args.map(bareWord).join(' ').slice(0, 80))
  if (unreadable(args[groupAt])) return GH_DENIED('<unreadable>')
  const group = bareWord(args[groupAt])
  if (group === 'api') return ghApiProblem(args.slice(groupAt + 1))
  const verbAt = verbAfter(groupAt + 1)
  if (verbAt >= args.length) return GH_DENIED(group)
  if (unreadable(args[verbAt])) return GH_DENIED(`${group} <unreadable>`)
  const verb = bareWord(args[verbAt])
  const reads = (group === 'auth' && verb === 'status') || (group === 'search' && GH_SEARCHES.has(verb)) ||
    (GH_GROUPS.has(group) && GH_READS.has(verb))
  return reads ? null : GH_DENIED(`${group} ${verb}`)
}

function ghApiProblem(args) {
  const denied = 'flow seat (gh reads only): this `gh api` call can change GitHub (a method other than GET, or -f, -F, --field, --raw-field or --input), and a seat changes nothing there. Read with a plain `gh api <endpoint>` GET.'
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

// ----- the final message

/** How many times Stop refuses a turn's final message before it lets the seat stop, capped. */
export const STOP_BLOCKS = 3
const LINE_LIMIT = 10
const SCHEMA_CONTEXT_BYTES = 16 * 1024
const ENVELOPE = '{"status": "done" | "partial" | "blocked", "coverage": {"read": [], "partial": [], "unopened": [], "checksRun": []}, "notes": "", "answer": <your answer>}'
const COMMITS = '"commits": [{"sha": "<sha>", "subject": "<subject>"}]'
const envelopeFor = (access) => (access === 'workspace-write' ? `${ENVELOPE.slice(0, -1)}, ${COMMITS}}` : ENVELOPE)

/**
 * The turn a stop belongs to, from the state Stop last wrote (null for none) and this stop's turn
 * key, the host's id for the turn. A new key starts the next turn with no blocks; the same key, or
 * a stop whose key cannot be read, continues the current one, so blocks still count toward the cap.
 * messageSha256 is the digest of the last final message Stop checked in the turn, null in a new one.
 */
export function stopTurn(state, turnKey) {
  const key = typeof turnKey === 'string' && turnKey !== '' ? turnKey : null
  const current = plainObject(state) && Number.isSafeInteger(state.turn) && state.turn > 0 ? state : null
  if (current && (key === null || key === current.turnKey)) {
    return {
      turn: current.turn,
      turnKey: current.turnKey ?? null,
      blocks: Number.isSafeInteger(current.blocks) ? current.blocks : 0,
      outcome: current.outcome ?? null,
      errors: Array.isArray(current.errors) ? current.errors : [],
      stops: (Number.isSafeInteger(current.stops) ? current.stops : 0) + 1,
      messageSha256: typeof current.messageSha256 === 'string' ? current.messageSha256 : null,
    }
  }
  return { turn: (current?.turn ?? 0) + 1, turnKey: key, blocks: 0, outcome: null, errors: [], stops: 1, messageSha256: null }
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
      `- git reads run as usual. Your git writes are add, rm, mv, commit, restore, stash and apply, each as \`git -C ${record.worktree} ...\`, and you commit by path: \`git -C ${record.worktree} commit -m <message> -- <paths>\`.`,
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
