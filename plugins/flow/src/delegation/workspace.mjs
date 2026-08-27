import { execFileSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { DelegationError, FINDINGS_SCHEMA } from './contracts.mjs'

const isInside = (root, path) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function canonicalRoots({ rootUris = [], projectDir = null, fallbackCwd = null } = {}) {
  const candidates = []
  for (const uri of rootUris) {
    try {
      const parsed = new URL(uri)
      if (parsed.protocol === 'file:') candidates.push(fileURLToPath(parsed))
    } catch {}
  }
  if (projectDir) candidates.push(projectDir)
  if (fallbackCwd) candidates.push(fallbackCwd)
  const roots = []
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate)
      if (statSync(path).isDirectory() && !roots.includes(path)) roots.push(path)
    } catch {}
  }
  return roots
}

export function canonicalWorkspace(cwd, roots) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new DelegationError('BAD_WORKSPACE', 'cwd must be an absolute directory path.')
  }
  let canonical
  try {
    canonical = realpathSync(cwd)
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new DelegationError('BAD_WORKSPACE', 'cwd does not name an existing directory.')
  }
  if (!roots.length) {
    throw new DelegationError('NO_ROOTS', 'The client did not provide a usable workspace root.')
  }
  if (!roots.some((root) => isInside(root, canonical))) {
    throw new DelegationError('OUTSIDE_ROOTS', 'cwd resolves outside the workspace roots supplied by the client.')
  }
  return canonical
}

function git(cwd, args, message) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    }).trim()
  } catch {
    throw new DelegationError('GIT_REF', message)
  }
}

export function worktreeKey(cwd) {
  try {
    return realpathSync(git(cwd, ['rev-parse', '--show-toplevel'], 'cwd is not a Git worktree.'))
  } catch (error) {
    if (error instanceof DelegationError) return cwd
    throw error
  }
}

export function immutableReview({ cwd, mode, base = null, head = 'HEAD', prompt = '' }) {
  if (mode === 'task') return { prompt, baseSha: null, headSha: null, outputSchema: null }
  if (!base) throw new DelegationError('GIT_REF', 'Review mode requires a base revision.')
  const baseSha = git(cwd, ['rev-parse', '--verify', `${base}^{commit}`], 'The review base does not resolve to a commit.')
  const headSha = git(cwd, ['rev-parse', '--verify', `${head}^{commit}`], 'The review head does not resolve to a commit.')
  const focus = prompt.trim() ? `\nAdditional focus from the caller:\n${prompt.trim()}\n` : ''
  const reviewKind = mode === 'adversarial-review'
    ? 'Act as an adversarial code reviewer. Hunt for reachable correctness, security, concurrency, and trust-boundary defects.'
    : 'Act as a code reviewer. Report real defects that should block or change this patch.'
  const built = `${reviewKind}\n\nReview only the changes in git diff ${baseSha}...${headSha}. Read surrounding code and tests when needed. Do not edit files. Do not report style or formatting. Cite a repository-relative file and the first affected line in the new code. Use the output schema. A clean review has an empty findings array.${focus}`
  return { prompt: built, baseSha, headSha, outputSchema: FINDINGS_SCHEMA }
}
