#!/usr/bin/env node
// evidence-push.mjs <repo> --pr <N> <file>...
//
// Commits screenshots to the repository's `flow-evidence` branch on origin and prints URLs pinned
// to that commit, for a pull request body. <repo> is a checkout path. Each file lands at
// pr-<N>/<basename>; a file of the same name replaces the old one in the new commit, and the old
// one's URLs keep resolving because they pin the commit that held it.
//
// Every file is checked before anything else runs, and a refusal there touches nothing: the
// extension is .png, .jpg, .jpeg, .gif or .webp, the path opens as a regular file without
// following a symlink, it holds at most 10 MiB, and no two files share a basename. Each is read
// once, through the descriptor it was checked on, into a private copy, and the copy is what git
// hashes, so a file swapped after the check never reaches the commit.
//
// The commit is built with plumbing alone: hash-object -w for each blob, a temporary
// GIT_INDEX_FILE seeded with read-tree of origin's tip (or empty when the branch is new),
// update-index --add --cacheinfo per file, write-tree, and commit-tree with the tip as its one
// parent (none on a new branch, which starts as an orphan root). No worktree, index or HEAD of the
// checkout is read or written, so it runs from any checkout while a stage works in it, and two
// runs share nothing but the object store. The message is `evidence: #<N> <basenames>`, with no
// trailers, and the identity is the repository's configured user.
//
// The push is `<commit>:refs/heads/flow-evidence` and nothing else: never `+`, --force or
// --force-with-lease. The land stage promises that branch is never rewritten (land/SKILL.md step
// 6), because merged PR bodies embed its SHAs, and a forced push is how a run would drop another
// run's commit. A non-fast-forward rejection means a concurrent run pushed first, so this one
// re-reads the tip, rebuilds on it and pushes again, three attempts in all, then refuses. Any
// failed push counts as that race when origin's tip moved off the one the commit was built on,
// because git words a rival that landed after the advertisement as a remote rejection. Pushes
// carry the same blobs every time, so a retry costs one small commit.
//
// Read-back: origin's flow-evidence, fetched, must be the pushed commit or a descendant of it,
// since another run may push on top before this one looks, and for every file `gh api
// repos/<o>/<r>/contents/<path>?ref=<commit> --jq .sha` must name the blob. A push whose answer is
// lost goes through the same ancestry test, so a commit that landed under a later one still counts.
// URLs follow the repository's visibility, read once with gh repo view before anything is pushed: a
// PUBLIC repository on github.com gets https://raw.githubusercontent.com/<o>/<r>/<commit>/<path>;
// anything else gets https://<host>/<o>/<r>/raw/<commit>/<path> on the host origin names, which
// renders for a signed-in viewer with access. Path segments are percent-encoded, `!'()*` included,
// so a filename with a parenthesis can't end a markdown link early. origin must fetch from and push to one GitHub URL, every gh call is pinned to the
// repository it parses to (GH_REPO and GH_HOST never reach gh), and GitHub must name that
// repository the same way, since a renamed one would leave the URLs on the old name.
//
// stdout is one JSON line: { ok: true, commit, branch: "flow-evidence", files: [{ path, blob, url,
// markdown }] } with markdown `![<basename without extension>](<url>)`, exit 0; { ok: false,
// reason } on a refusal, exit 1, carrying `commit` once one reached origin, and `landed: "unknown"`
// with the attempted `commit` when origin could not be read to say whether it did; usage on
// stderr, exit 2.

import { closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { execCapture, ghRunner, parseObject, runExecutor } from '../lib/gh-exec.mjs'
import { firstLine, makeRedactor } from '../lib/redact.mjs'
import { allowedHostsFrom, identityOfRemote } from '../lib/remote-identity.mjs'
import { originUrl as originOfOneUrl, pushStatus, readRef } from './issue-claim.mjs'

const BRANCH = 'flow-evidence'
const REF = `refs/heads/${BRANCH}`
const TRACKING = `refs/remotes/origin/${BRANCH}`
const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const MAX_BYTES = 10 * 1024 * 1024
const ATTEMPTS = 3
const OID = /^([0-9a-f]{40}|[0-9a-f]{64})$/
const USAGE = 'usage: evidence-push.mjs <repo> --pr <N> <file>...'

class Refusal { constructor(reason, extra = {}) { Object.assign(this, { reason, extra }) } }
const refuse = (reason, extra) => { throw new Refusal(reason, extra) }

export function evidencePush({ argv, env }) {
  const [repoArg, flag, pr, ...files] = argv
  if (!repoArg || flag !== '--pr' || !/^[1-9]\d*$/.test(pr ?? '') || files.length === 0) return { code: 2, stdout: '', stderr: `${USAGE}\n` }
  const scratch = mkdtempSync(join(tmpdir(), 'flow-evidence-'))
  try {
    return { code: 0, stdout: `${JSON.stringify({ ok: true, ...run({ repoArg, pr, files, env, scratch }) })}\n`, stderr: '' }
  } catch (error) {
    const verdict = error instanceof Refusal ? error : new Refusal(`unexpected failure: ${firstLine(error?.message ?? error)}`)
    return { code: 1, stdout: `${JSON.stringify({ ok: false, reason: verdict.reason, ...verdict.extra })}\n`, stderr: '' }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Each file checked and copied into scratch: { name, copy }. Nothing outside scratch is written. */
function stage(files, scratch) {
  const seen = new Set()
  return files.map((file, i) => {
    const name = basename(file)
    if (!EXTENSIONS.has(extname(name).toLowerCase())) refuse(`${name} is not one of ${[...EXTENSIONS].join(' ')}`)
    if (/[\x00-\x1f\x7f]/.test(name)) refuse(`file ${i + 1}'s name holds a control character`)
    if (seen.has(name)) refuse(`two files are named ${name}, and each lands at pr-<N>/<basename>`)
    seen.add(name)
    let fd
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
      refuse(error?.code === 'ELOOP' ? `${name} is a symlink, not a regular file` : `${name} does not open: ${error?.code ?? 'error'}`)
    }
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) refuse(`${name} is not a regular file`)
      if (st.size > MAX_BYTES) refuse(`${name} is ${st.size} bytes, over the ${MAX_BYTES / 1024 / 1024} MiB limit`)
      const bytes = readFileSync(fd)
      if (bytes.length > MAX_BYTES) refuse(`${name} grew past the ${MAX_BYTES / 1024 / 1024} MiB limit while it was read`)
      const copy = join(scratch, `blob-${i}`)
      writeFileSync(copy, bytes)
      return { name, copy }
    } finally {
      closeSync(fd)
    }
  })
}

function run({ repoArg, pr, files, env, scratch }) {
  const staged = stage(files, scratch)

  // ssh must never prompt: an agent's shell has no terminal, so a prompt is a hang.
  const gitEnv = { ...env, GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=10', GIT_TERMINAL_PROMPT: '0' }
  let repo
  try { repo = realpathSync(repoArg) } catch { refuse('the repository path does not resolve') }
  const origin = originOfOneUrl(repo, gitEnv)
  if (origin.url === undefined) refuse(origin.detail)
  const redact = makeRedactor(origin.url, 'origin')
  const pinned = identityOfRemote(origin.url, { purpose: 'push evidence to', allowedHosts: allowedHostsFrom(env) })
  if (pinned.identity === undefined) refuse(pinned.refusal)
  const id = pinned.identity
  const ctx = { cwd: repo, redact, env: gitEnv }
  const git = (args, { timeoutMs = 10_000, extraEnv } = {}) => execCapture('git', ['-C', repo, ...args], { timeoutMs, env: extraEnv ? { ...gitEnv, ...extraEnv } : gitEnv })
  const said = (r) => redact(firstLine(r.stderr)) || `exit ${r.code}`
  const must = (args, what, opts) => {
    const r = git(args, opts)
    if (r.code !== 0) refuse(`${what} failed: ${said(r)}`)
    return r.stdout.trim()
  }

  const runGh = ghRunner(env)
  const view = runGh(['repo', 'view', id.full, '--json', 'visibility,nameWithOwner'], { cwd: repo })
  const info = view.code === 0 ? parseObject(view.stdout) : null
  if (info === null) refuse(`gh repo view failed, so the URL shape is unknown and nothing was pushed: ${firstLine(view.stderr) || `exit ${view.code}`}`)
  if (String(info.nameWithOwner).toLowerCase() !== id.slug.toLowerCase()) {
    refuse(`origin's URL names ${id.slug}, and GitHub names that repository ${info.nameWithOwner}; update origin's URL and run again`)
  }
  const visibility = info.visibility
  if (!['PUBLIC', 'PRIVATE', 'INTERNAL'].includes(visibility)) refuse(`gh repo view named the visibility ${JSON.stringify(visibility)}, which has no URL shape here`)

  const blobs = staged.map(({ name, copy }) => {
    const blob = must(['hash-object', '-w', '--', copy], `git hash-object of ${name}`)
    if (!OID.test(blob)) refuse(`git hash-object of ${name} did not answer an object name`)
    return { name, path: `pr-${pr}/${name}`, blob }
  })
  const message = `evidence: #${pr} ${blobs.map((b) => b.name).join(', ')}`

  // origin's tip after a fetch, or null when origin has no flow-evidence.
  const fetchTip = () => {
    const listed = readRef(ctx, REF)
    if (listed.state === 'unknown') refuse(listed.detail)
    if (listed.state === 'absent') return null
    must(['fetch', '--quiet', '--no-tags', 'origin', `+${REF}:${TRACKING}`], `git fetch origin ${BRANCH}`, { timeoutMs: 120_000 })
    return must(['rev-parse', '--verify', '--quiet', `${TRACKING}^{commit}`], `reading ${TRACKING} after its fetch`)
  }
  // Whether origin's flow-evidence holds sha. A refusal from the read carries sha and says the
  // outcome is unknown, because by then a push may have landed.
  const originHolds = (sha, unknownReason) => {
    let tip
    try { tip = fetchTip() } catch (error) {
      if (error instanceof Refusal) refuse(`${unknownReason}: ${error.reason}`, { commit: sha, landed: 'unknown' })
      throw error
    }
    return { holds: tip !== null && git(['merge-base', '--is-ancestor', sha, tip]).code === 0, tip }
  }
  const build = (tip) => {
    const index = join(scratch, `index-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const opts = { extraEnv: { GIT_INDEX_FILE: index } }
    must(['read-tree', ...(tip === null ? ['--empty'] : [tip])], 'git read-tree', opts)
    for (const b of blobs) must(['update-index', '--add', '--cacheinfo', '100644', b.blob, b.path], `git update-index of ${b.path}`, opts)
    const tree = must(['write-tree'], 'git write-tree', opts)
    rmSync(index, { force: true })
    return must(['commit-tree', tree, ...(tip === null ? [] : ['-p', tip]), '-m', message], 'git commit-tree')
  }

  let commit = null
  for (let attempt = 1; ; attempt += 1) {
    const tip = fetchTip()
    const built = build(tip)
    const push = git(['push', '--porcelain', 'origin', `${built}:${REF}`], { timeoutMs: 120_000 })
    const status = pushStatus(push.stdout, REF)
    if (push.code === 0 && (status?.flag === ' ' || status?.flag === '*')) { commit = built; break }
    // Whatever the failure looked like, origin says what happened. An answer lost on the way back
    // can hide a push that landed. A tip that moved off the one this commit was built on is a
    // concurrent run, however git worded it: a client-side non-fast-forward, or a remote
    // "incorrect old value" when the rival landed after the advertisement. Anything else is a
    // real failure, and retrying it would only repeat it.
    const seen = originHolds(built, `the push of ${built.slice(0, 12)} to ${BRANCH} may have landed, and origin could not be read to tell`)
    if (seen.holds) { commit = built; break }
    if (seen.tip === tip) refuse(`the push of ${built.slice(0, 12)} to ${BRANCH} did not land: ${status === null ? said(push) : `${JSON.stringify(status.flag)} ${redact(status.summary)}`}`)
    if (attempt >= ATTEMPTS) refuse(`${BRANCH} moved under each of ${ATTEMPTS} pushes, so concurrent runs keep winning; nothing of this run is on origin`)
  }

  // Read back: origin holds the commit, and GitHub serves each blob at it.
  if (!originHolds(commit, 'the push landed but origin could not be read back').holds) {
    refuse(`origin's ${BRANCH} does not contain the pushed commit ${commit.slice(0, 12)}`, { commit })
  }
  const segment = (part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const encode = (path) => path.split('/').map(segment).join('/')
  for (const b of blobs) {
    const r = runGh(['api', '--hostname', id.host, `repos/${id.owner}/${id.repo}/contents/${encode(b.path)}?ref=${commit}`, '--jq', '.sha'], { cwd: repo })
    const served = r.code === 0 ? r.stdout.trim() : null
    if (served !== b.blob) {
      refuse(`GitHub does not serve ${b.path} at ${commit.slice(0, 12)} as blob ${b.blob.slice(0, 12)}: ${served === null ? firstLine(r.stderr) || `exit ${r.code}` : `it names ${served.slice(0, 12)}`}`, { commit })
    }
  }

  const urlOf = (path) => (visibility === 'PUBLIC' && id.host === 'github.com'
    ? `https://raw.githubusercontent.com/${id.owner}/${id.repo}/${commit}/${encode(path)}`
    : `https://${id.host}/${id.owner}/${id.repo}/raw/${commit}/${encode(path)}`)
  const alt = (name) => name.slice(0, name.length - extname(name).length).replace(/[[\]\\]/g, '\\$&')
  return {
    commit, branch: BRANCH,
    files: blobs.map((b) => ({ path: b.path, blob: b.blob, url: urlOf(b.path), markdown: `![${alt(b.name)}](${urlOf(b.path)})` })),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runExecutor(evidencePush({ argv: process.argv.slice(2), env: process.env }))
}
