import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { protectedFileReason, publishReason } from '../../lib/hook-policy.mjs'

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash']
const WRITE_TOOLS = [...READ_TOOLS, 'Edit', 'Write', 'NotebookEdit']
const PROXY_ENV = new Set(['ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'])

export const claudeTools = (access) => access === 'workspace-write' ? WRITE_TOOLS : READ_TOOLS

export const pathInside = (root, path) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function sensitiveReadPaths() {
  const base = homedir()
  return [
    resolve(base, '.ssh'),
    resolve(base, '.gnupg'),
    resolve(base, '.git-credentials'),
    resolve(base, '.netrc'),
    resolve(base, '.npmrc'),
    resolve(base, '.pypirc'),
    resolve(base, '.docker'),
    resolve(base, '.aws'),
    resolve(base, '.azure'),
    resolve(base, '.kube'),
    resolve(base, '.config', 'gh'),
    resolve(base, '.config', 'gcloud'),
    ...(process.env.APPDATA ? [resolve(process.env.APPDATA, 'gcloud')] : []),
    resolve(base, '.claude'),
    resolve(base, '.claude.json'),
    resolve(base, '.codex'),
  ]
}

export function providerExecutablePaths() {
  const paths = new Set()
  const configured = [
    process.env.FLOW_DELEGATION_CLAUDE_BIN || 'claude',
    process.env.FLOW_DELEGATION_CODEX_BIN || 'codex',
  ]
  const suffixes = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const executable of configured) {
    const candidates = isAbsolute(executable) || executable.includes(sep)
      ? [resolve(executable)]
      : (process.env.PATH || '').split(delimiter).flatMap((directory) =>
          // POSIX treats an empty PATH entry as the current directory. Flow deliberately
          // skips it so an untrusted worktree cannot replace a provider executable.
          directory ? suffixes.map((suffix) => resolve(directory, `${executable}${suffix}`)) : [])
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      paths.add(candidate)
      try { paths.add(realpathSync(candidate)) } catch {}
    }
  }
  return [...paths].sort()
}

function sensitiveEnvironment() {
  const secretName = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|COOKIE)(?:_|$)/i
  return Object.keys(process.env)
    .filter((name) => secretName.test(name) || PROXY_ENV.has(name.toUpperCase()))
    .sort()
    .map((name) => ({ name, mode: 'deny' }))
}

export function claudeSandboxFor(job) {
  const filesystem = {
    // The CLI itself starts outside the command sandbox. Blocking the effective provider
    // executables here stops shell, language, and executable scripts from launching a raw
    // Claude or Codex child after they pass the command-text guard.
    denyRead: [...new Set([
      ...sensitiveReadPaths(),
      ...providerExecutablePaths(),
      ...(existsSync('/proc') ? ['/proc'] : []),
    ])],
    ...(job.access === 'workspace-write'
      ? { allowWrite: [job.workspaceKey] }
      : { denyWrite: [job.workspaceKey] }),
  }
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [],
      strictAllowlist: true,
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem,
    credentials: { envVars: sensitiveEnvironment() },
  }
}

function pathFromTool(toolName, input) {
  if (!input || typeof input !== 'object') return null
  if (toolName === 'NotebookEdit') return input.notebook_path
  if (['Read', 'Edit', 'Write'].includes(toolName)) return input.file_path
  if (['Grep', 'Glob'].includes(toolName)) return input.path || null
  return null
}

function canonicalTarget(job, value) {
  if (typeof value !== 'string' || !value) return null
  const absolute = resolve(job.cwd, value)
  let existing = absolute
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing)
  let canonical
  try {
    const base = realpathSync(existing)
    canonical = resolve(base, relative(existing, absolute))
  } catch { return null }
  return canonical
}

function readReason(job, value, { search = false } = {}) {
  if (search && !value) return null
  const target = canonicalTarget(job, value)
  if (!target) return 'The read target could not be resolved safely.'
  if (pathInside('/proc', target)) {
    return 'Delegated workers cannot read process state.'
  }
  if (sensitiveReadPaths().some((path) => pathInside(path, target) || (search && pathInside(target, path)))) {
    return 'The read target contains local authentication or credential state.'
  }
  return null
}

function writeReason(job, value) {
  const target = canonicalTarget(job, value)
  if (!target || !pathInside(job.workspaceKey, target)) {
    return 'The edit target resolves outside the delegated job worktree.'
  }
  return protectedFileReason(target)
}

function shellWords(segment) {
  const words = []
  const pattern = /"((?:\\.|[^"])*)"|'([^']*)'|([^\s]+)/g
  for (const match of segment.matchAll(pattern)) {
    words.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\([\\"'])/g, '$1'))
  }
  return words
}

function commandName(word) {
  return basename(String(word || ''))
}

function commandOperands(words, start) {
  return words.slice(start).filter((word) => word && !word.startsWith('-'))
}

function directShellWriteTargets(command) {
  const targets = []
  const redirects = /(?:^|[\s;&|])(?:\d*|&)(?:>\||>>|>|<>)\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|([^\s;&|]+))/gm
  for (const match of String(command).matchAll(redirects)) {
    const target = match[1] ?? match[2] ?? match[3]
    if (target && !/^&\d+$/.test(target)) targets.push(target)
  }

  // Builds and package resolvers must remain able to generate dist files and lockfiles.
  // This catches commands that name a protected path as their direct write target, which
  // is the Bash equivalent of hand-editing that path through Edit or Write.
  for (const segment of String(command).split(/&&|\|\||[;&|\n]/)) {
    const words = shellWords(segment)
    if (!words.length) continue
    let index = 0
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] || '')) index++
    while (['command', 'exec', 'nohup', 'sudo'].includes(commandName(words[index]))) index++
    if (commandName(words[index]) === 'env') {
      index++
      while ((words[index] || '').startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] || '')) index++
    }
    const name = commandName(words[index])
    const rest = words.slice(index + 1)
    if (['touch', 'truncate', 'rm', 'unlink', 'tee'].includes(name)) {
      targets.push(...commandOperands(words, index + 1))
    } else if (['cp', 'mv', 'install', 'ln', 'rsync'].includes(name)) {
      const operands = commandOperands(words, index + 1)
      if (operands.length) targets.push(operands.at(-1))
    } else if (name === 'dd') {
      for (const word of rest) if (word.startsWith('of=') && word.length > 3) targets.push(word.slice(3))
    } else if (name === 'sed' && rest.some((word) => word === '-i' || word.startsWith('--in-place') || /^-i.+/.test(word))) {
      const operands = rest.filter((word) => word && !word.startsWith('-'))
      if (operands.length > 1) targets.push(...operands.slice(1))
    } else if (name === 'perl' && rest.some((word) => /^-[^-]*i/.test(word) || word.startsWith('--in-place'))) {
      const operands = []
      for (let restIndex = 0; restIndex < rest.length; restIndex++) {
        const word = rest[restIndex]
        if (word === '-e' || word === '-E') {
          restIndex++
        } else if (word && !word.startsWith('-')) {
          operands.push(word)
        }
      }
      targets.push(...operands)
    }
  }
  return targets
}

function protectedShellReason(job, command) {
  for (const value of directShellWriteTargets(command)) {
    if (/[$`]/.test(value) || value.includes('<(') || value.includes('>(')) {
      return 'Flow cannot prove that a dynamic write target avoids protected files. Name each write target explicitly.'
    }
    if (/[*?\[\]{}]/.test(value)) {
      return 'Flow cannot prove that a wildcard write avoids protected files. Name each write target explicitly.'
    }
    const target = canonicalTarget(job, value)
    if (!target || !pathInside(job.workspaceKey, target)) continue
    const reason = protectedFileReason(target)
    if (reason) return reason
  }
  // Inline evaluators can hide writes from the direct-target parser. Reject evaluators that
  // contain common mutation APIs. Executing repository scripts remains available for normal
  // builds and tests; workspace-write authority still covers the whole disposable worktree.
  const inlineMutation = /(?:^|[\n;&|`]\s*|\$\(\s*)(?:[^\s;&|()/]+\/)*(?:python(?:\d+(?:\.\d+)*)?|node|ruby|perl|php|lua)\b[^;&|\n]*?(?:-c|-e|--eval)\s+(?:'([^']*)'|"((?:\\.|[^"])*)"|([^\s;&|]+))/gmi
  for (const match of String(command).matchAll(inlineMutation)) {
    const payload = match[1] ?? match[2] ?? match[3] ?? ''
    if (/\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|truncate(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|remove|rmtree)\b|\bopen\s*\([^)]*,\s*['"][wax+]/i.test(payload)) {
      return 'Flow cannot inspect an inline program well enough to prove that its writes avoid protected files.'
    }
  }
  return null
}

function nestedProviderReason(command) {
  const text = String(command || '')
  const dequoted = text.replace(/'([^']*)'|"((?:\\.|[^"])*)"/g, (_match, single, double) =>
    single ?? double.replace(/\\(["\\$`])/g, '$1'))
  for (const candidate of new Set([text, dequoted])) {
    const provider = /(?:^|[\n;&|`(]\s*|\$\(\s*|\b(?:then|do|else)\s+|-(?:exec|execdir)\s+)(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:[^\s;&|()/]+\/)*(claude|codex)(?=[\s;&|)`]|$)/m.exec(candidate)
      || /(?:^|[\n;&|`(]\s*|\$\(\s*|\b(?:then|do|else)\s+)(?:command|exec|env|nohup|sudo|xargs)\b[^;&|\n`$()]*?\b(claude|codex)(?=[\s;&|)`]|$)/m.exec(candidate)
    if (provider) return `Flow delegated workers cannot invoke ${provider[1]} directly or start nested delegation.`
  }
  if (/(?:^|[\n;&|`(]\s*|\$\(\s*)(?:(?:command|exec|env|nohup|sudo)\b[^;&|\n`$()]*?\s+)?(?:(?:[^\s;&|()/]+\/)*busybox\s+)?(?:[^\s;&|()/]+\/)*(?:bash|dash|sh|ash|ksh|zsh|fish|csh|tcsh|pwsh|powershell)\s+(?:-[^\s]*c\b|-{1,2}command\b)/im.test(text)) {
    return 'Flow delegated workers cannot hide a second shell command behind a shell interpreter.'
  }
  const inlineRunner = /(?:^|[\n;&|`(]\s*|\$\(\s*)(?:[^\s;&|()/]+\/)*(?:python(?:\d+(?:\.\d+)*)?|node|ruby|perl|php|lua)\b[^;&|\n]*?(?:-c|-e|--eval)\s+(?:'([^']*)'|"((?:\\.|[^"])*)"|([^\s;&|]+))/gmi
  for (const match of text.matchAll(inlineRunner)) {
    const payload = match[1] ?? match[2] ?? match[3] ?? ''
    const nested = /\b(claude|codex)\b/i.exec(payload)
    if (nested) return `Flow delegated workers cannot invoke ${nested[1].toLowerCase()} directly or start nested delegation.`
  }
  return null
}

export function claudePolicyHook(job, { onDenied = () => {} } = {}) {
  const allowed = new Set(claudeTools(job.access))
  return async (input) => {
    if (input?.hook_event_name !== 'PreToolUse') return { continue: true }
    const toolName = input.tool_name
    let reason = null
    if (!allowed.has(toolName)) {
      reason = `${toolName || 'This tool'} is outside the delegated job's ${job.access} tool set.`
    } else if (toolName === 'Read') {
      reason = readReason(job, pathFromTool(toolName, input.tool_input))
    } else if (['Grep', 'Glob'].includes(toolName)) {
      reason = readReason(job, pathFromTool(toolName, input.tool_input), { search: true })
    } else if (['Edit', 'Write', 'NotebookEdit'].includes(toolName)) {
      reason = writeReason(job, pathFromTool(toolName, input.tool_input))
    } else if (toolName === 'Bash') {
      const command = input.tool_input?.command
      if (typeof command !== 'string') reason = 'Claude sent a Bash call without an inspectable command.'
      else reason = nestedProviderReason(command) || protectedShellReason(job, command) || publishReason(command)
    }
    if (!reason) return { continue: true }
    onDenied({ toolName, reason })
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }
  }
}
