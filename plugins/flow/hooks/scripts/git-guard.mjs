#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// git guard: enforces the charter's two git non-negotiables at the hook layer -
//   1. NEVER `--no-verify` (it exists to skip the checks that catch bad commits)
//   2. no commit trailers of any kind - not attribution (Co-Authored-By, Generated-with),
//      not session links (Claude-Session). the git author IS the author.
//
// Why a hook and not charter prose: the charter is injected by SessionStart, which reaches
// the main session only. A spawned subagent starts fresh, inherits the HARNESS instruction
// to append Co-Authored-By/Claude-Session, and never sees the charter line that overrides
// it - so the rule inverts exactly where nobody is watching, and the damage lands in git
// history permanently. Hooks fire on subagent tool calls too, so this layer travels where
// context does not. (Only `subagent_type: "fork"` inherits the conversation.)
//
// Escape hatch, for foreign commits that legitimately already carry a trailer (amending or
// rewording upstream work you did not author):
//   FLOW_SANCTION=git git commit --amend ...
//
// PreToolUse protocol: read tool call JSON on stdin; deny via hookSpecificOutput JSON.
// Deliberately narrow, same posture as the no-backlog guard: false negatives are
// acceptable (the policy is also in the charter), false positives are not.

const TRAILERS = [
  /^\s*Co-Authored-By\s*:/im,
  /^\s*Claude-Session\s*:/im,
  /^\s*Signed-Off-By\s*:/im,
  /Generated\s+with\s+\[?Claude/i,
  /🤖\s*Generated/i,
]

// `git`, then any run of tokens, then a bare `commit` word. Matches `git commit`,
// `git -C /wt commit`, `git --git-dir=x commit`; does NOT match `git log --grep=commit`
// (no whitespace before the word) or `git log | grep -i co-authored-by` (no commit token).
const GIT_COMMIT = /\bgit\b(?:\s+\S+)*?\s+commit\b/

// Prose about a rule is not a breach of it. `--no-verify` inside a quoted string or a heredoc
// body is text being handed to some other command - a PR comment, a commit body, a gripe
// describing this very guard - not a flag being handed to git. Matching the raw command
// string would block all three, which is how a guard turns into something people route
// around. Strip shell literals first, then match.
//
// The trailer check below deliberately does NOT strip: a trailer lives inside the quoted
// commit message, which is precisely where it has to be caught.
const stripLiterals = (s) =>
  s
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2/gm, ' ')
    .replace(/'[^']*'/g, ' ')
    .replace(/"[^"]*"/g, ' ')

// Irreversible git: operations that destroy work no reflog returns. The bar is deliberately
// narrow. `reset --hard` and `branch -D` are NOT here - the reflog does return those, and
// blocking them breaks the ordinary squash-merge flow (a squashed branch is no ancestor of
// main, so `-d` refuses it) for no safety earned.
//
// Each pattern is bounded to a single shell command with `[^;&|]*`, so a later invocation
// cannot hide behind an earlier read (`git log && git push --force`), and every one is
// matched against stripLiterals(cmd) so prose about a rule is not a breach of it.
const DESTRUCTIVE = [
  [
    /\bgit\b[^;&|]*\bpush\b[^;&|]*(?:--force(?!-with-lease)|\s-f(?=\s|$))/,
    'flow charter: no bare force-push. --force overwrites whatever the remote holds, ' +
      'including commits you pushed from another worktree. Use --force-with-lease: it ' +
      'refuses when the remote moved under you, which is the only thing bare --force gets wrong.',
  ],
  [
    /\bgit\b[^;&|]*\b(?:checkout|restore)\s+\.(?:\s|$)/,
    'flow charter: `git checkout .` and `git restore .` discard every uncommitted change in ' +
      'the tree, with no reflog entry to recover from. Name the paths you mean, or `git stash` ' +
      'first if you want them back.',
  ],
]

// `git clean -f` deletes untracked files permanently. Handled outside DESTRUCTIVE because the
// dry run is the fix we recommend, and a flag-cluster regex alone would block `-ndf` too.
const CLEAN_FORCE = /\bgit\b[^;&|]*\bclean\b[^;&|]*\s-{1,2}[a-zA-Z]*f/
const CLEAN_DRYRUN = /\bgit\b[^;&|]*\bclean\b[^;&|]*(?:\s-[a-zA-Z]*n\b|--dry-run)/

const deny = (reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
  process.exit(0)
}

// Subcommands that cannot write a ref in any form. `symbolic-ref`, `fetch`, and
// `branch` each have read AND write forms and are NOT here - they're handled below.
const CRON_READ = new Set([
  'status', 'log', 'shortlog', 'show', 'diff', 'blame', 'grep',
  'rev-parse', 'rev-list', 'merge-base', 'describe', 'cat-file', 'check-ignore',
  'ls-files', 'ls-tree', 'ls-remote', 'for-each-ref', 'show-ref',
  'version', 'help',
])
// Branch options that put `branch` in list/read mode and legitimately take a ref
// argument (so a positional after them is not a create target).
const BRANCH_LIST_OPTS = new Set([
  '--list', '--merged', '--no-merged', '--contains', '--no-contains',
  '--points-at', '--sort', '--format', '--show-current', '-l',
])

// Return a deny reason, or null to allow. Evaluates EVERY git invocation in the command
// string; one disallowed invocation denies the whole call. Over-blocking is acceptable in
// cron mode (the job just reports the refusal); under-blocking is not - the allowlist is
// the job's authority. Cron git is READ-ONLY for every job: the lint's two destructive
// actions run through scripts/lint-actions.mjs, which re-derives the safety conditions
// deterministically; the model never runs the mutating git itself.
//
// Tokenizing on whitespace alone loses any invocation glued to a shell operator:
// `git log --oneline&&git push` split as [git, log, --oneline&&git, push], the scan saw
// only the allowed `log`, and the push went through both this guard and `Bash(git:*)`.
// So every operator and quote character becomes its own token first. That also uncovers
// `bash -c "git push"` and `$(git push)`. It over-blocks a quoted "git push" inside a
// --grep, which is the direction this file already chose.
// Variable indirection (`G=git; $G push`) still slips past - only a real shell parser
// closes that - so a `=git` suffix counts as a git token and the Bash allowlist, which
// permits no bare assignment prefix, carries the rest.
const isGitToken = (t) => /(^|[/=])git$/.test(t)

// What cron mode classifies. The scheduled jobs read untrusted text, so this is a grammar
// that fails closed, not a scanner that blanks what it recognizes: two rounds of review found
// eleven ways past a blanking scanner (quoted executable words, bash -lc, a shell fed a heredoc,
// g'it', g\it, if/then, trap, find -exec, the rest of a heredoc opener line, ...), and every one
// of them is a shape the grammar below never accepts.
//
// A cron command is one or more simple commands joined by ';', '&&', '||', a newline, or '|'.
// A simple command is a plain unquoted command word followed by argument words. Denied outright:
// a backslash outside quotes; a backtick, $(, <(, >(, parentheses or braces anywhere outside
// single quotes; a lone '&'; a quote glued to a word except after --opt=; a redirection that is
// not to /dev/null or a descriptor; a command word that is quoted, holds '$', is an assignment,
// or is not on the short allowlist of commands a job runs; a '$' anywhere outside single quotes,
// since a one-shot cron call has no variables worth keeping and "$GH_TOKEN" in a comment body
// is an exfiltration; a pipe into anything but a fixed set of read-only filters. Two shapes
// carry the jobs' real commands: bash or sh may run a script under the plugin root and nothing
// else, and node may run a .mjs or .js script path and nothing else (never -e, -p, --eval,
// --print, --input-type, --require, --import, and never a script on stdin). Quoted argument
// words then drop out before the git classifier below reads the command words, so an issue
// body that mentions a git write is prose again.
// The command words a cron job may run at all. Anything else in command position is refused,
// so `git log; rm -rf ~` and `git log; curl ...` die on the word and not on a guess about
// what it does. Pipe targets have their own, narrower set below.
const CRON_COMMANDS = new Set(['git', 'gh', 'node', 'bash', 'sh', 'claude', 'gripe', 'echo', 'true', 'ls', 'cat', 'pwd', 'date', 'test', '['])
const CRON_FILTERS = new Set([
  'head', 'tail', 'grep', 'egrep', 'fgrep', 'sort', 'uniq', 'wc', 'cut', 'tr', 'jq', 'cat',
  'column', 'paste', 'rev', 'nl', 'fold', 'fmt', 'tac',
])
const NODE_EVAL = /^(-e|-p|-r|-i|--eval|--print|--require|--import|--input-type|--loader|--experimental-loader)(=|$)/
// Filter options that turn a read-only filter into a writer or a launcher: sort -o and
// --compress-program are the known ones, and the rest are their spellings elsewhere.
const FILTER_WRITES = /^(-o|--output|--compress-program|-T|--temporary-directory|--files0-from|-f|--file)(=|$)|^-[a-zA-Z]*[oT]/
const PLAIN_COMMAND_WORD = /^[A-Za-z0-9_./+-]+$/
const pluginRoot = () =>
  process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const cronScanTarget = (cmd) => {
  const stop = (why) => ({ deny: why })
  const segments = [] // [{ words: [{ text, quoted }], piped }]
  let words = []
  let piped = false
  let word = null // { text, quoted } while a word is open
  let pendingHeredocs = [] // delimiters whose bodies start at the next newline
  const openWord = () => { if (!word) word = { text: '', quoted: false } }
  const closeWord = () => { if (word) { words.push(word); word = null } }
  const closeSegment = (nextPiped) => {
    closeWord()
    if (words.length) segments.push({ words, piped })
    else if (piped) return stop('a pipe with nothing after it')
    words = []
    piped = nextPiped
    return null
  }
  // Returns [content, indexAfterClosingQuote], or null when unterminated. Double quotes honor
  // backslash escapes; single quotes never do.
  const readQuoted = (i, q) => {
    let j = i + 1
    let content = ''
    while (j < cmd.length) {
      const c = cmd[j]
      if (q === '"' && c === '\\' && j + 1 < cmd.length) { content += cmd[j + 1]; j += 2; continue }
      if (c === q) return [content, j + 1]
      content += c
      j += 1
    }
    return null
  }
  let i = 0
  while (i < cmd.length) {
    const ch = cmd[i]
    const next = cmd[i + 1]
    if (ch === '\\') return stop('a backslash escape outside quotes')
    if (ch === '`') return stop('a backtick substitution')
    if (ch === '$') return stop('a $ outside single quotes (no substitution, no variable, no exfiltration)')
    if ((ch === '<' || ch === '>') && next === '(') return stop('a process substitution')
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') return stop(`a shell grouping character (${ch})`)
    if (ch === "'" || ch === '"') {
      const glued = word !== null && word.text !== ''
      if (glued && !/^-[A-Za-z0-9-]+=$/.test(word.text)) return stop('a quote glued to a word')
      const read = readQuoted(i, ch)
      if (!read) return stop('an unterminated quote')
      const [content, after] = read
      if (ch === '"' && /[$`]/.test(content)) return stop('a $ or backtick inside double quotes')
      const tail = cmd[after]
      if (tail !== undefined && !/[\s;|&]/.test(tail)) return stop('a quote glued to a word')
      openWord()
      // A quote glued after --opt= keeps the option and drops the value: the classifier
      // needs to see the option, and the value is data. A whole quoted word is data too.
      if (glued) word.valueDropped = true
      else word.quoted = true
      word.text += content
      i = after
      continue
    }
    if (ch === '<' && next === '<') {
      const m = /^<<-?\s*(['"]?)([\w-]+)\1/.exec(cmd.slice(i))
      if (!m) return stop('a heredoc without a plain delimiter')
      pendingHeredocs.push({ delimiter: m[2], quoted: m[1] !== '' })
      closeWord()
      i += m[0].length
      continue
    }
    if (ch === '<') return stop('a redirection from a file')
    if (ch === '>' || (ch === '&' && next === '>')) {
      // Only /dev/null and descriptor duplication are targets a cron job may name; anything
      // else is a file write the job has no authority for (and a way to stage a script).
      if (word && !/^\d+$/.test(word.text)) return stop('a redirection glued to a word')
      const m = /^(?:&>|>>?)(?:&\d|\s*\/dev\/null)/.exec(cmd.slice(i))
      if (!m) return stop('a redirection to a file')
      word = null
      i += m[0].length
      continue
    }
    if (ch === '&' && next === '&') { const e = closeSegment(false); if (e) return e; i += 2; continue }
    if (ch === '&') return stop('a background operator')
    if (ch === '|' && next === '|') { const e = closeSegment(false); if (e) return e; i += 2; continue }
    if (ch === '|') { const e = closeSegment(true); if (e) return e; i += 1; continue }
    if (ch === ';') { const e = closeSegment(false); if (e) return e; i += 1; continue }
    if (ch === '\n') {
      const e = closeSegment(false)
      if (e) return e
      i += 1
      for (const h of pendingHeredocs) {
        const rest = cmd.slice(i)
        const endRe = new RegExp('^\\s*' + h.delimiter.replace(/-/g, '\\-') + '\\s*$', 'm')
        const em = endRe.exec(rest)
        const body = em ? rest.slice(0, em.index) : rest
        if (!h.quoted && /[$`]/.test(body)) return stop('a $ or backtick in an unquoted heredoc body')
        i += em ? em.index + em[0].length : rest.length
      }
      pendingHeredocs = []
      continue
    }
    if (/\s/.test(ch)) { closeWord(); i += 1; continue }
    if (ch === '#' && !word) return stop('a comment')
    openWord()
    word.text += ch
    i += 1
  }
  const e = closeSegment(false)
  if (e) return e

  const root = pluginRoot()
  const out = []
  for (const seg of segments) {
    const [head, ...args] = seg.words
    if (head.quoted) return stop('a quoted command word')
    if (!PLAIN_COMMAND_WORD.test(head.text)) return stop(`a command word the grammar cannot vouch for (${head.text.slice(0, 30)})`)
    // The bare name, resolved through PATH by the shell: a path-qualified word (./git, /tmp/bash)
    // is whatever the repository or the temp directory put there.
    const base = head.text
    if (base.includes('/')) return stop(`a path-qualified command word (${base.slice(0, 30)})`)
    if (seg.piped && !CRON_FILTERS.has(base)) return stop(`a pipe into ${base}, which is not a read-only filter`)
    if (seg.piped && args.some((a) => !a.quoted && FILTER_WRITES.test(a.text))) return stop(`a filter option that writes a file or runs a program`)
    if (!seg.piped && !CRON_COMMANDS.has(base)) return stop(`${base} is not a command a cron job runs`)
    if (base === 'bash' || base === 'sh') {
      const script = args[0]
      const runsPluginScript = script && !script.quoted && /\.sh$/.test(script.text)
        && resolve(script.text).startsWith(root + '/')
        && !args.slice(1).some((a) => !a.quoted && a.text.startsWith('-'))
      if (!runsPluginScript) return stop(`${base} may only run a script under the plugin root`)
    }
    if (base === 'node') {
      const script = args[0]
      if (!script || script.quoted || !/\.(mjs|js)$/.test(script.text)) return stop('node may only run a .mjs or .js script path')
      if (args.some((a) => !a.quoted && NODE_EVAL.test(a.text))) return stop('node evaluating inline code')
    }
    if (isGitToken(head.text) && seg.words.some((w) => /::|:\/\//.test(w.text))) return stop('a git command naming a URL or transport')
    // A refspec hidden in quotes, or in a dropped --refmap= value, would pass the classifier below
    // as an opaque word. Only the ref-moving subcommands take refspecs, so the colon check is scoped
    // to them and --format='%(refname:short)' on a log or branch stays legal.
    if (isGitToken(head.text)) {
      const movesRefs = args.some((a) => !a.quoted && /^(fetch|pull|push|remote|ls-remote|clone|submodule)$/.test(a.text))
      const hidden = seg.words.some((w) => (w.quoted || w.valueDropped) && (/^\+|refs\//.test(w.text) || (movesRefs && /:/.test(w.text))))
      if (hidden) return stop('a quoted refspec')
    }
    out.push(seg.words.map((w) => (w.quoted ? 'QUOTED' : w.valueDropped ? w.text.slice(0, w.text.indexOf('=') + 1) : w.text)).join(' '))
  }
  return { text: out.join(' ; ') }
}

const cronVerdict = (cmd, job) => {
  const tokens = cmd.replace(/[;|&()<>\n`'"]/g, ' $& ').split(/\s+/).filter(Boolean)
  const valueOpts = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
  for (let i = 0; i < tokens.length; i++) {
    if (!isGitToken(tokens[i])) continue
    // Skip global options (and their values) to find the subcommand.
    let j = i + 1
    while (j < tokens.length && tokens[j].startsWith('-')) {
      // -c writes config for one call, and config runs code (core.pager, alias.*, credential.helper);
      // --exec-path swaps the git binaries. Neither has a read-only use here.
      if (/^-c/.test(tokens[j]) || /^(--config-env|--exec-path)(=|$)/.test(tokens[j])) {
        return `flow cron guard (${job}): git ${tokens[j]} is outside this job's permissions - it can run code. Cron git is read-only; report the need instead of working around this.`
      }
      if (valueOpts.has(tokens[j])) j += 2
      else j += 1
    }
    const sub = tokens[j] || ''
    const rest = tokens.slice(j + 1)
    const next = rest.find((t) => !t.startsWith('-')) || ''
    const no = (why) =>
      `flow cron guard (${job}): git ${sub || '<none>'} is outside this job's permissions${why ? ` - ${why}` : ''}. ` +
      'Cron git is read-only; the lint mutates only through scripts/lint-actions.mjs. ' +
      'Report the need instead of working around this.'

    if (CRON_READ.has(sub)) continue
    if (sub === 'worktree') {
      if (next === 'list') continue
      return no('only `worktree list` here')
    }
    if (sub === 'branch') {
      // Any short bundle carrying a write letter (D/d delete, m/M move, c/C copy,
      // f force) - catches -Df and other combined forms.
      const shortWrite = rest.some((t) => /^-[a-zA-Z]*[DdmMcCf]/.test(t) && !t.startsWith('--'))
      const longWrite = rest.some((t) => /^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(t))
      if (shortWrite || longWrite) return no('branch may only be listed')
      // A bare positional with no list-mode option present is a create target
      // (`git branch <name> [<start>]`). List forms always carry a list option.
      const hasListOpt = rest.some((t) => BRANCH_LIST_OPTS.has(t) || /^--(sort|format|points-at|contains|no-contains|merged|no-merged)=/.test(t))
      const positional = rest.some((t) => !t.startsWith('-'))
      if (positional && !hasListOpt) return no('branch may only be listed, not created')
      continue
    }
    if (sub === 'symbolic-ref') {
      // Read: `symbolic-ref [--short] <name>` (one positional). Write: a second
      // positional (the target ref) or -d/--delete.
      if (rest.some((t) => t === '-d' || t === '--delete')) return no('symbolic-ref is read-only')
      if (rest.filter((t) => !t.startsWith('-')).length > 1) return no('symbolic-ref may not repoint a ref')
      continue
    }
    if (sub === 'fetch') {
      // A refspec with an explicit destination (`<src>:<dst>`) writes an arbitrary
      // local ref. Plain `fetch origin main` / `--prune` carries no colon.
      if (rest.some((t) => !t.startsWith('-') && t.includes(':'))) return no('fetch may not write an explicit refspec destination')
      continue
    }
    if (sub === 'remote') {
      if (next === '' || next === 'get-url' || next === 'show') continue
      return no('remotes are read-only')
    }
    return no('')
  }
  return null
}

let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    process.exit(0) // unparseable input → never block on our own bug
  }
  const cmd = input?.tool_input?.command || ''

  // Cron mode: when flow-cron.mjs spawned this session it exported FLOW_CRON_JOB, and
  // hooks inherit that env. The scheduled jobs read untrusted text (issue bodies, PR
  // titles, repo files), so here EVERY command has to fit the cron grammar above, git or
  // not - a substitution inside a gh comment body is an exfiltration whether or not the
  // word git appears - and git itself is deny-by-default: only the subcommands the job's
  // standing permissions name may run, and FLOW_SANCTION is ignored, since an injected
  // instruction can put the sanction string in a command but cannot change this process's
  // environment. Interactive sessions are untouched. Env source of truth:
  // scripts/flow-cron.mjs; keep the write set in step with the prompts in skills/flow/cron/.
  const cronJob = process.env.FLOW_CRON_JOB || ''
  if (cronJob) {
    const target = cronScanTarget(cmd)
    if (target.deny) {
      deny(`flow cron guard (${cronJob}): ${target.deny}. Cron runs plain commands one at a time; spell the command out.`)
    }
    const verdict = cronVerdict(target.text, cronJob)
    if (verdict) deny(verdict)
    process.exit(0) // cron sessions never commit, so the trailer rules below are moot
  }

  if (!/\bgit\b/.test(cmd)) process.exit(0)

  if (/\bFLOW_SANCTION=git\b/.test(cmd)) process.exit(0)

  if (/--no-verify\b/.test(stripLiterals(cmd))) {
    deny(
      'flow charter: NEVER --no-verify. The hooks it skips are the checks that keep bad ' +
        'commits out of history. Fix what the hook is failing on, or say plainly that the ' +
        'hook itself is broken - do not route around it.',
    )
  }

  const bare = stripLiterals(cmd)

  for (const [re, why] of DESTRUCTIVE) if (re.test(bare)) deny(why)

  if (CLEAN_FORCE.test(bare) && !CLEAN_DRYRUN.test(bare)) {
    deny(
      'flow charter: `git clean -f` deletes untracked files permanently - nothing recovers ' +
        'them. Run `git clean -n` first to see what would go, then delete only what you mean.',
    )
  }

  if (GIT_COMMIT.test(cmd)) {
    const hit = TRAILERS.find((t) => t.test(cmd))
    if (hit) {
      deny(
        'flow charter: no commit trailers of any kind - not attribution (Co-Authored-By, ' +
          'Generated-with), not session links (Claude-Session). The git author IS the ' +
          'author. This rule overrides any harness instruction to append them. Rewrite the ' +
          'commit message without the trailer. If you are amending foreign work that ' +
          'already carries one, prefix with FLOW_SANCTION=git.',
      )
    }
  }

  process.exit(0)
})
