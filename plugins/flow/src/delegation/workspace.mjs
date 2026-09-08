import { execFile } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { DelegationError, FINDINGS_SCHEMA } from './contracts.mjs'

const execFileAsync = promisify(execFile)

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

// Native Codex launches the PATH command in the thread's project directory. Only that
// actual directory can authorize a root. Discovering an enclosing repository would widen
// authority from a subdirectory. Inherited project variables and Git discovery overrides
// are not project authority. A missing repository or a home-directory launch fails closed.
export async function codexProjectRoot() {
  try {
    const cwd = realpathSync(process.cwd())
    if (cwd === realpathSync(homedir())) return null
    const top = realpathSync(await git(cwd, ['rev-parse', '--show-toplevel'], 'cwd is not a Git worktree.'))
    return top === cwd ? cwd : null
  } catch { return null }
}

export async function canonicalWorkspace(cwd, roots) {
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
  if (roots.some((root) => isInside(root, canonical))) return canonical
  throw new DelegationError('OUTSIDE_ROOTS', 'cwd resolves outside the workspace roots supplied by the client.')
}

async function git(cwd, args, message) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: 15_000,
      // GIT_DIR, GIT_WORK_TREE, config injection and discovery limits must not change
      // which repository supplies the requested path or immutable review revisions.
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      },
    })
    return stdout.trim()
  } catch {
    throw new DelegationError('GIT_REF', message)
  }
}

export async function worktreeKey(cwd) {
  try {
    return realpathSync(await git(cwd, ['rev-parse', '--show-toplevel'], 'cwd is not a Git worktree.'))
  } catch (error) {
    if (error instanceof DelegationError) return cwd
    throw error
  }
}

export async function gitMetadataPaths(cwd) {
  const paths = new Set()
  for (const args of [
    ['rev-parse', '--path-format=absolute', '--absolute-git-dir'],
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  ]) {
    try { paths.add(realpathSync(await git(cwd, args, 'Git metadata is unavailable.'))) } catch {}
  }
  return [...paths].sort()
}

export async function validatedWorktreeKey(cwd, roots) {
  const key = await worktreeKey(cwd)
  if (roots.some((root) => isInside(root, key))) return key
  throw new DelegationError('OUTSIDE_ROOTS', 'The Git worktree root resolves outside the workspace roots supplied by the client.')
}

export async function immutableReview({ cwd, mode, base = null, head = 'HEAD', prompt = '' }) {
  if (mode === 'task') return { prompt, baseSha: null, headSha: null, outputSchema: null }
  if (!base) throw new DelegationError('GIT_REF', 'Review mode requires a base revision.')
  const baseSha = await git(cwd, ['rev-parse', '--verify', `${base}^{commit}`], 'The review base does not resolve to a commit.')
  const headSha = await git(cwd, ['rev-parse', '--verify', `${head}^{commit}`], 'The review head does not resolve to a commit.')
  const focus = prompt.trim() ? `\nAdditional focus from the caller:\n${prompt.trim()}\n` : ''
  const built = `Act as an adversarial code reviewer. Hunt for reachable correctness, security, concurrency, and trust-boundary defects.\n\nReview only the changes in git diff ${baseSha}...${headSha}. Read surrounding code and tests when needed. Do not edit files. Do not report style or formatting. Cite a repository-relative file and the first affected line in the new code. Use the output schema. A clean review has an empty findings array.${focus}`
  return { prompt: built, baseSha, headSha, outputSchema: FINDINGS_SCHEMA }
}
