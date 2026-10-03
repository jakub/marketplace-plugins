#!/usr/bin/env node
// issue-claim.mjs claim <N> [--kind feat|fix|chore]
//
// Starts at most one autonomous run on an issue. The lock is a lightweight tag,
// refs/tags/flow-claim-issue-<N>, created on origin by a plain push: a ref create is the one
// update git's wire protocol makes atomic, so of any number of racers exactly one gets a `*`
// (created) line back. The exit code cannot decide it, because pushing the object a tag already
// holds exits 0 as `=` (up to date) and every racer pushes the same head of main. Anything but
// exactly one `*` line for the ref is a loss, and the remote is re-read to say whose.
//
// The run: read the issue (open, ready-for-agent as its sole lifecycle label, an exact
// `## Acceptance Criteria` section with content, digested); scan this clone's worktrees and
// branches, origin's branches and every open pull request for a live run; fetch and take the
// tag; scan and read the issue again under it; add the worktree and branch at the tagged SHA
// under <root>/.flow-worktrees/, with `/.flow-worktrees/` and `/.flow-scratch/` in the repository's
// .git/info/exclude, the second for the run's uncommitted files, which land retires with the
// worktree; push the branch; move the labels and read them back; drop the
// tag. The branch reaches origin before the labels move, because the pushed branch is what every
// later scan finds once the tag is gone, and no scan reads a label.
//
// stdout is one JSON line whose `result` is claimed (exit 0), refused (2), held (3) or unknown
// (4). Every result but claimed carries `retained`: what this run may have left, from claim-tag,
// worktree, local-branch and remote-branch, each dropped from the list only once it reads back
// gone. A refusal that retains anything is reported unknown, keeping its reason and naming the
// cleanup that would not confirm. Once the branch is on origin nothing is given back.
//
// gh is pinned to the host, owner and repository origin parses to, never gh's own default
// (which prefers an upstream remote), and origin must fetch from and push to one URL. Nothing
// printed carries a remote's credential. There is no bare force: the one lease deletes the tag
// only at the SHA this run created it at, and origin re-checks that object at delete time.

import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { execCapture, ghRunner, parseJson, parseObject, runExecutor } from '../lib/gh-exec.mjs'
import { firstLine, makeRedactor } from '../lib/redact.mjs'
import { allowedHostsFrom, identityOfRemote } from '../lib/remote-identity.mjs'

const LOCAL_MS = 5_000
const REMOTE_MS = 30_000
const PUSH_MS = 60_000
const FETCH_MS = 120_000
const EXIT = { claimed: 0, refused: 2, held: 3, unknown: 4 }

const SHA = /^[0-9a-f]{40}$/
const AC_HEADING = '## Acceptance Criteria'
const READY = 'ready-for-agent'
const IN_PROGRESS = 'in-progress'
const LIFECYCLE = ['needs-triage', 'agent-found', READY, IN_PROGRESS, 'needs-info', 'needs-human', 'needs-rebase', 'wontfix', 'deferred']
const KINDS = ['feat', 'fix', 'chore']
const SLUG_MAX = 40
// The lines the claim keeps in .git/info/exclude. The common exclude file applies in every worktree,
// so the second keeps each run's uncommitted notes and captures out of its own status.
const EXCLUDED = ['/.flow-worktrees/', '/.flow-scratch/']
const USAGE = 'usage: issue-claim.mjs claim <issue-number> [--kind feat|fix|chore]\n'

const git = (cwd, args, timeoutMs = LOCAL_MS, env) => execCapture('git', ['-C', cwd, ...args], { timeoutMs, env })

/** The line git marked as the failure; a failed worktree add opens with progress, not the error. */
const complaint = (text) => {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  return (lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.at(-1) ?? '').slice(0, 200)
}

const tagRef = (issue) => `refs/tags/flow-claim-issue-${issue}`

/** The SHA advertised for exactly this ref; an ls-remote pattern is a match, not an equality. */
const shaOfRef = (stdout, ref) => {
  for (const line of String(stdout).split('\n')) {
    const [sha, name] = line.split('\t')
    if (name === ref && SHA.test(sha)) return sha
  }
  return null
}

/** present, absent or unknown. `ls-remote --exit-code` answers 0 or 2; anything else is no answer. */
export const readRef = (ctx, ref) => {
  const r = git(ctx.cwd, ['ls-remote', '--exit-code', 'origin', ref], REMOTE_MS, ctx.env)
  if (r.code === 2) return { state: 'absent' }
  const sha = r.code === 0 ? shaOfRef(r.stdout, ref) : null
  if (sha !== null) return { state: 'present', sha }
  return { state: 'unknown', detail: `git ls-remote origin ${ref} failed: ${firstLine(ctx.redact(r.stderr)) || `exit ${r.code}`}` }
}

/**
 * origin's one URL, or why there is not exactly one. git reads from origin's fetch URL and pushes
 * to its push URL (`get-url` applies pushurl, insteadOf and pushInsteadOf), so with two URLs a tag
 * could be pushed to one repository and read back from another.
 */
export const originUrl = (cwd, env) => {
  const urls = (push) => {
    const r = git(cwd, ['remote', 'get-url', ...(push ? ['--push'] : []), '--all', 'origin'], LOCAL_MS, env)
    return r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
  }
  const fetchUrls = urls(false)
  const pushUrls = urls(true)
  if (fetchUrls.length === 0) return { problem: 'no-origin', detail: 'this directory has no origin remote to claim on' }
  if (fetchUrls.length !== 1 || pushUrls.length !== 1 || pushUrls[0] !== fetchUrls[0]) {
    return { problem: 'push-fetch-mismatch', detail: `origin has ${fetchUrls.length} fetch and ${pushUrls.length} push URL(s) that are not one URL, so the tag could land where no read here looks` }
  }
  return { url: fetchUrls[0] }
}

/** The one `git push --porcelain` status line naming this ref, or null when there is not exactly one. */
const pushStatus = (stdout, ref) => {
  const lines = String(stdout).split('\n').map((l) => l.split('\t'))
    .filter((p) => p.length >= 2 && p[1].slice(p[1].lastIndexOf(':') + 1) === ref)
  return lines.length === 1 ? { flag: lines[0][0], summary: (lines[0][2] ?? '').trim() } : null
}

/**
 * Create the claim tag at origin's main. `ctx` is { cwd, redact, env? }, env being git's environment
 * when the caller pins one (the nightly lint's non-interactive ssh). `observed` says whether a tag
 * of this run can be on origin: pre-push (nothing was pushed), post-push (a push went out and its
 * outcome is ambiguous: a lost response and a rival's tag read the same) or absent (a push went
 * out and the re-read proved no tag). --no-tags keeps live claim tags out of the clone, where a
 * later `git push --tags` would recreate them. An origin without one URL for both is refused before
 * anything, whoever the caller is: every read below would look where the push did not go.
 */
export const acquire = (ctx, issue) => {
  const ref = tagRef(issue)
  const origin = originUrl(ctx.cwd, ctx.env)
  if (origin.url === undefined) return { result: 'refused', reason: origin.problem, observed: 'pre-push', detail: origin.detail }
  const fetched = git(ctx.cwd, ['fetch', '--quiet', '--no-tags', 'origin'], FETCH_MS, ctx.env)
  if (fetched.code !== 0) {
    return { result: 'unknown', observed: 'pre-push', detail: `git fetch origin failed: ${firstLine(ctx.redact(fetched.stderr)) || `exit ${fetched.code}`}` }
  }
  const main = git(ctx.cwd, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], LOCAL_MS, ctx.env)
  const base = main.stdout.trim()
  if (main.code !== 0 || !SHA.test(base)) {
    return { result: 'refused', reason: 'no-main-branch', observed: 'pre-push', detail: 'origin has no main branch to hang a claim on' }
  }
  const before = readRef(ctx, ref)
  if (before.state === 'present') return { result: 'held', sha: before.sha, observed: 'pre-push', detail: 'the tag was on origin before this run pushed' }
  if (before.state === 'unknown') return { result: 'unknown', observed: 'pre-push', detail: before.detail }

  const push = git(ctx.cwd, ['push', '--porcelain', 'origin', `${base}:${ref}`], PUSH_MS, ctx.env)
  const status = pushStatus(push.stdout, ref)
  if (push.code === 0 && status?.flag === '*') return { result: 'acquired', sha: base }
  const said = status === null ? 'no status line' : `${JSON.stringify(status.flag)} ${ctx.redact(status.summary)}`
  const why = `the push did not create the tag (git said ${said}, exit ${push.code})`
  const after = readRef(ctx, ref)
  if (after.state === 'present') return { result: 'held', sha: after.sha, observed: 'post-push', detail: why }
  if (after.state === 'absent') {
    return { result: 'unknown', observed: 'absent', detail: `${why}, and origin holds no tag: ${complaint(ctx.redact(push.stderr)) || 'git said nothing'}` }
  }
  return { result: 'unknown', observed: 'post-push', detail: `${why}, and the re-read failed: ${after.detail}` }
}

/**
 * Delete the claim tag only while it holds `receipt`, the SHA this run's acquire created it at. The
 * read refuses any other object; the lease makes origin re-check that object at delete time, so a
 * tag swapped in between is rejected as stale rather than deleted. `gone` is true only when origin
 * was read back without the tag.
 */
export const dropTag = (ctx, issue, receipt) => {
  const ref = tagRef(issue)
  const before = readRef(ctx, ref)
  if (before.state === 'unknown') return { result: 'unknown', gone: false, detail: before.detail }
  if (before.state === 'absent') return { result: 'refused', reason: 'tag-absent', gone: true }
  if (before.sha !== receipt) {
    return { result: 'refused', reason: 'receipt-mismatch', gone: false, found: before.sha, detail: `the tag is at ${before.sha.slice(0, 12)}, not ${receipt.slice(0, 12)}` }
  }
  const push = git(ctx.cwd, ['push', '--porcelain', `--force-with-lease=${ref}:${receipt}`, 'origin', `:${ref}`], PUSH_MS, ctx.env)
  const after = readRef(ctx, ref)
  if (after.state === 'absent') return { result: 'dropped', gone: true }
  return {
    result: 'unknown', gone: false, found: after.sha ?? null,
    detail: after.state === 'present' ? `the tag is still on origin at ${after.sha.slice(0, 12)} (push exit ${push.code})` : after.detail,
  }
}

const labelNames = (labels) => (Array.isArray(labels) ? labels : [])
  .map((l) => (typeof l === 'string' ? l : String(l?.name ?? ''))).filter(Boolean)
const loginsOf = (list) => (Array.isArray(list) ? list : [])
  .map((a) => (typeof a === 'string' ? a : String(a?.login ?? ''))).filter(Boolean)
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * The exact bytes from the `## Acceptance Criteria` line to the next `## ` heading, untrimmed,
 * since the digest is what the run is judged against. A trailing \r is ignored for the match and
 * kept in the digest. A heading with nothing under it is no section.
 */
const acceptanceCriteria = (body) => {
  const text = String(body ?? '')
  let offset = 0
  let start = -1
  let end = text.length
  for (const raw of text.split('\n')) {
    const bare = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (start < 0 && bare === AC_HEADING) start = offset
    else if (start >= 0 && bare.startsWith('## ')) { end = offset; break }
    offset += raw.length + 1
  }
  if (start < 0) return null
  const section = text.slice(start, end)
  return section.split('\n').slice(1).some((l) => l.trim() !== '') ? section : null
}

/**
 * A branch-safe slug, cut back to a word boundary. A title with nothing in [a-z0-9] (修复登录)
 * becomes t-<12 hex of its sha256>, which is deterministic, so two runs build the same branch.
 */
const slugify = (title) => {
  const text = String(title ?? '').trim()
  const flat = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (flat === '') return text === '' ? '' : `t-${sha256(text).slice(0, 12)}`
  if (flat.length <= SLUG_MAX) return flat
  const cut = flat.slice(0, SLUG_MAX)
  const boundary = cut.lastIndexOf('-')
  return (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/-+$/, '')
}

const kindFromLabels = (labels) => {
  if (labels.includes('bug')) return 'fix'
  if (labels.includes('documentation') && !labels.includes('enhancement')) return 'chore'
  return 'feat'
}

const parseWorktrees = (stdout) => {
  const entries = []
  for (const raw of String(stdout).split('\n')) {
    if (raw.startsWith('worktree ')) entries.push({ path: raw.slice(9), branch: null })
    else if (raw.startsWith('branch ') && entries.length > 0) entries.at(-1).branch = raw.slice(7)
  }
  return entries
}

const real = (path) => { try { return realpathSync(path) } catch { return '' } }
/** A real directory at its canonical path; lstat, so a symlink or a dangling link never passes. */
const isRealDir = (path, absentOk = false) => {
  try { return lstatSync(path).isDirectory() && real(path) === path } catch (e) { return absentOk && e?.code === 'ENOENT' }
}

/**
 * Decide and act. Returns { code, stdout, stderr } rather than exiting, so a smoke can drive it in
 * process. `runGh(args, { cwd })` is injected; `env` is read for FLOW_GH_HOSTS alone.
 */
export function issueClaim({ argv, cwd, env = {}, runGh }) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { code: 0, stdout: USAGE, stderr: '' }
  const emit = (payload, human) => ({
    code: EXIT[payload.result], stdout: `${JSON.stringify(payload)}\n`, stderr: human ? `issue-claim: ${human}\n` : '',
  })
  const usage = (detail) => emit({ command: 'claim', result: 'refused', reason: 'usage', retained: [], cleanup: null, detail }, `${detail}.\n\n${USAGE}`)

  const [verb, ...rest] = argv
  if (verb !== 'claim') return usage(argv.length === 0 ? 'expected the claim verb' : `${JSON.stringify(verb)} is not a verb; the one verb is claim`)
  if (typeof runGh !== 'function') return usage('claim was called with no gh runner')
  let issueArg = null
  let kindArg = null
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--kind') {
      kindArg = rest[i + 1] ?? null
      i += 1
      if (!KINDS.includes(kindArg)) return usage('--kind takes feat, fix or chore')
    } else if (issueArg === null) issueArg = rest[i]
    else return usage(`${JSON.stringify(rest[i])} is an extra argument`)
  }
  const issue = Number(issueArg)
  if (!Number.isInteger(issue) || issue <= 0) return usage(`${JSON.stringify(issueArg)} is not an issue number`)

  const tag = `flow-claim-issue-${issue}`
  const ref = tagRef(issue)
  const base = { command: 'claim', issue, tag, ref }
  const early = (reason, detail) => emit({ ...base, result: 'refused', reason, retained: [], cleanup: null, detail }, `${detail}. Nothing was claimed.`)

  // ---- origin: one URL for fetch and push, parsed down to a host, owner and repository to pin gh to.
  const origin = originUrl(cwd)
  if (origin.url === undefined) return early(origin.problem, origin.detail)
  const parsed = identityOfRemote(origin.url, { purpose: 'claim an issue on', allowedHosts: allowedHostsFrom(env) })
  if (parsed.identity === undefined) return early(parsed.problem === 'host' ? 'origin-host-not-allowed' : 'origin-unparseable', parsed.refusal)
  const id = parsed.identity
  const repo = id.full
  base.repo = repo
  const ctx = { cwd, redact: makeRedactor([origin.url], repo) }
  const repoPin = ['--repo', id.full]
  const hostPin = ['--hostname', id.host]
  const failed = (what, r) => `${what} failed: ${firstLine(ctx.redact(r.stderr)) || `exit ${r.code}`}`

  let worktree = null
  let branch = null
  const where = { 'claim-tag': () => `${ref} on ${repo}`, worktree: () => worktree, 'local-branch': () => `${branch} in this clone`, 'remote-branch': () => `${branch} on ${repo}` }
  const leftovers = (retained) => (retained.length === 0
    ? 'No claim tag, worktree or branch from this run remains.'
    : `This run may have left ${retained.map((r) => `${r} (${where[r]()})`).join(', ')}; settle that by hand before running this again.`)
  /** Every non-win result. A refusal (or hold) that retains anything is an unknown. */
  const settle = (want, reason, detail, { retained = [], cleanup = null, extra = {}, human = null } = {}) => {
    const result = retained.length === 0 ? want : 'unknown'
    return emit({ ...base, ...extra, result, reason, retained, cleanup, detail }, human ?? `${detail}. ${leftovers(retained)}`)
  }

  const readIssue = () => {
    const r = runGh(['issue', 'view', String(issue), ...repoPin, '--json', 'number,title,state,labels,assignees,body,url'], { cwd })
    const v = r.code === 0 ? parseObject(r.stdout) : null
    if (v === null) return { problem: r.code === 0 ? `gh issue view ${issue} printed no JSON object` : failed(`gh issue view ${issue}`, r) }
    return { issue: v, state: String(v.state ?? '').toUpperCase(), labels: labelNames(v.labels) }
  }
  const readiness = (read) => {
    if (read.state !== 'OPEN') return { reason: 'issue-closed', detail: `issue #${issue} is ${read.state || 'in no readable state'}, and only an open issue is claimed` }
    if (!read.labels.includes(READY)) return { reason: 'not-ready', detail: `issue #${issue} does not carry ${READY}` }
    const others = LIFECYCLE.filter((l) => l !== READY && read.labels.includes(l))
    if (others.length > 0) {
      return { reason: 'blocked', detail: `issue #${issue} carries ${others.join(', ')} beside ${READY}, which is trusted only as the sole lifecycle label`, extra: { blocking: others } }
    }
    return null
  }

  // ---- the issue. Everything up to the acquire is a read, so a refusal here changed nothing.
  const first = readIssue()
  if (first.problem) return settle('unknown', 'issue-unreadable', first.problem)
  const wrong = readiness(first)
  if (wrong !== null) return settle('refused', wrong.reason, wrong.detail, { extra: wrong.extra })
  const section = acceptanceCriteria(first.issue.body)
  if (section === null) return settle('refused', 'no-acceptance-criteria', `issue #${issue} has no "${AC_HEADING}" line with anything under it`)
  const acDigest = sha256(section)
  const kind = kindArg ?? kindFromLabels(first.labels)
  const slug = slugify(first.issue.title)
  if (slug === '') return settle('refused', 'bad-slug', `the title of issue #${issue} is empty, so there is nothing to name a branch after`)
  branch = `${kind}/issue-${issue}-${slug}`

  // ---- the boundary: the main checkout with its own real .git, and a target that is free.
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  const root = top.code === 0 ? real(top.stdout.trim()) : ''
  if (root === '') return settle('unknown', 'repo-unreadable', failed('git rev-parse --show-toplevel', top))
  const gitDir = join(root, '.git')
  const parent = join(root, '.flow-worktrees')
  const infoDir = join(gitDir, 'info')
  const exclude = join(infoDir, 'exclude')
  worktree = join(parent, `${basename(root)}-issue-${issue}-${slug}`)
  const names = { kind, branch, worktree, acDigest, title: first.issue.title ?? null, url: first.issue.url ?? null }
  /** null when the boundary holds, else [want, reason, detail]. */
  const boundary = () => {
    const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    if (common.code !== 0) return ['unknown', 'repo-unreadable', failed('git rev-parse --git-common-dir', common)]
    if (!isRealDir(root)) return ['refused', 'worktree-path', 'the repository root is not a real directory at its canonical path']
    if (!isRealDir(gitDir) || real(common.stdout.trim()) !== gitDir) {
      return ['refused', 'not-main-worktree', `claim runs from the main checkout with a real ${gitDir}; the common Git directory is ${common.stdout.trim()}`]
    }
    if (!isRealDir(parent, true) || !isRealDir(infoDir, true) || !isRealDir(join(gitDir, 'worktrees'), true)) {
      return ['refused', 'worktree-path', `${parent}, ${infoDir} and ${join(gitDir, 'worktrees')} must be real directories where they exist`]
    }
    try {
      const st = lstatSync(exclude)
      if (!st.isFile() || st.nlink !== 1) return ['refused', 'worktree-path', `${exclude} must be a real, unshared file`]
    } catch (e) { if (e?.code !== 'ENOENT') return ['refused', 'worktree-path', `${exclude} could not be inspected`] }
    if (!isRealDir(worktree, true)) return ['refused', 'worktree-path', `${worktree} exists and is not a real directory`]
    try {
      if (readdirSync(worktree).length !== 0) return ['refused', 'worktree-path', `${worktree} is not empty, so no worktree is written over it`]
    } catch (e) { if (e?.code !== 'ENOENT') return ['refused', 'worktree-path', `${worktree} could not be read`] }
    return null
  }
  const bad = boundary()
  if (bad !== null) return settle(bad[0], bad[1], bad[2], { extra: names })

  // ---- the scan: the four places a run leaves a mark. The server is asked for branches because
  // a clone's remote refs are as old as its fetch; every open pull request is paged because a
  // fork's head branch is advertised by no ref on origin.
  const forIssue = new RegExp(`^(feat|fix|chore)/issue-${issue}-`)
  const patterns = KINDS.map((k) => `refs/heads/${k}/issue-${issue}-*`)
  const branchHits = (stdout, where) => String(stdout).split('\n').map((l) => l.split('\t'))
    .filter(([sha, name]) => SHA.test(sha ?? '') && forIssue.test(String(name).replace(/^refs\/heads\//, '')))
    .map(([sha, name]) => ({ where, ref: name, sha }))
  const scan = () => {
    const wt = git(cwd, ['worktree', 'list', '--porcelain'])
    if (wt.code !== 0) return { problem: failed('git worktree list', wt) }
    const worktrees = parseWorktrees(wt.stdout).filter((e) =>
      basename(e.path).includes(`-issue-${issue}-`) || forIssue.test(String(e.branch ?? '').replace(/^refs\/heads\//, '')))
    const local = git(cwd, ['for-each-ref', '--format=%(objectname)\t%(refname)', ...patterns])
    if (local.code !== 0) return { problem: failed('git for-each-ref', local) }
    const remote = git(cwd, ['ls-remote', 'origin', ...patterns], REMOTE_MS)
    if (remote.code !== 0) return { problem: failed('git ls-remote origin', remote) }
    const prs = runGh(['api', ...hostPin, '--paginate', '--slurp', `repos/${id.owner}/${id.repo}/pulls?state=open&per_page=100`], { cwd })
    const pages = prs.code === 0 ? parseJson(prs.stdout) : null
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
      return { problem: prs.code === 0 ? 'the open pull requests did not read as an array of pages' : failed('gh api over the open pull requests', prs) }
    }
    const found = {
      worktrees,
      localBranches: branchHits(local.stdout, 'local-branch'),
      remoteBranches: branchHits(remote.stdout, 'remote-branch'),
      pullRequests: pages.flat().filter((pr) => forIssue.test(String(pr?.head?.ref ?? '')))
        .map((pr) => ({ number: pr.number ?? null, headRefName: pr.head.ref, url: pr.html_url ?? null })),
    }
    return { found, live: Object.values(found).some((list) => list.length > 0) }
  }
  const firstScan = scan()
  if (firstScan.problem) return settle('unknown', 'scan-unreadable', firstScan.problem, { extra: names })
  if (firstScan.live) return settle('refused', 'live-run', `issue #${issue} already has a run on it`, { extra: { ...names, found: firstScan.found } })

  // ---- the claim. Everything above was a read.
  const got = acquire(ctx, issue)
  if (got.result === 'held' && got.observed === 'pre-push') {
    return settle('held', 'claim-held', `issue #${issue} is already claimed (${ref} at ${got.sha.slice(0, 12)}); the run holding it releases it, or a human breaks the tag`, { extra: { ...names, sha: got.sha } })
  }
  if (got.result === 'held') {
    return settle('unknown', 'acquire-ambiguous', `the claim tag was on origin after this run's own push, and whose it is cannot be established: ${got.detail}`, { retained: ['claim-tag'], extra: names })
  }
  if (got.result === 'refused') return settle('refused', 'acquire-refused', `the claim was refused: ${got.detail}`, { extra: names })
  if (got.result !== 'acquired') {
    const retained = got.observed === 'post-push' ? ['claim-tag'] : []
    return settle('unknown', got.observed === 'absent' ? 'acquire-not-created' : 'acquire-unknown', `the claim could not be taken: ${got.detail}`, { retained, extra: names })
  }
  const baseSha = got.sha
  const claimed = { ...names, base: baseSha }

  /** Undo what this run made, reading each thing back; whatever is not positively gone stays retained. */
  const unwind = ({ added }) => {
    const retained = []
    const cleanup = []
    if (added) {
      git(cwd, ['worktree', 'remove', worktree], PUSH_MS)
      git(cwd, ['worktree', 'prune'])
      const listed = git(cwd, ['worktree', 'list', '--porcelain'])
      if (listed.code !== 0 || parseWorktrees(listed.stdout).some((e) => e.path === worktree) || real(worktree) !== '') {
        retained.push('worktree'); cleanup.push('worktree-remove')
      }
      // Compare-and-delete: git refuses if the branch moved off the base this run cut it at.
      git(cwd, ['update-ref', '-d', `refs/heads/${branch}`, baseSha])
      const left = git(cwd, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`])
      if (left.code !== 0 || left.stdout.split('\n').includes(`refs/heads/${branch}`)) { retained.push('local-branch'); cleanup.push('local-branch-delete') }
    }
    if (!dropTag(ctx, issue, baseSha).gone) { retained.push('claim-tag'); cleanup.push('drop-tag') }
    return { retained, cleanup: cleanup.length === 0 ? null : cleanup.join(', ') }
  }
  const standDown = (want, reason, detail, { added = false, extra = {} } = {}) => {
    const swept = unwind({ added })
    return settle(want, reason, detail, { retained: swept.retained, cleanup: swept.cleanup, extra: { ...claimed, ...extra } })
  }

  // ---- under the tag: a contender that scanned before this run took it, and an issue a human
  // closed, relabelled or blocked since the first read, both stop here at the cost of one tag.
  const again = scan()
  if (again.problem) return standDown('unknown', 'scan-unreadable', `the scan under the claim tag failed: ${again.problem}`)
  if (again.live) return standDown('refused', 'live-run', `issue #${issue} already has a run on it, found while holding the claim`, { extra: { found: again.found } })
  const reread = readIssue()
  if (reread.problem) return standDown('unknown', 'issue-unreadable', `the read under the claim tag failed: ${reread.problem}`)
  const moved = readiness(reread)
  if (moved !== null) return standDown('refused', moved.reason, `${moved.detail}, and it changed while this run held the claim`, { extra: moved.extra })

  // ---- local setup, then one re-check that the directories written through are still real.
  let setup = null
  try {
    for (const dir of [parent, infoDir]) {
      try { mkdirSync(dir, { mode: 0o700 }) } catch (e) { if (e?.code !== 'EEXIST') throw e }
    }
    setup = boundary()
    if (setup === null) {
      const fd = openSync(exclude, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      try {
        const st = fstatSync(fd)
        if (!st.isFile() || st.nlink !== 1) throw new Error(`${exclude} is not a real, unshared file`)
        const text = readFileSync(fd, 'utf8')
        const have = text.split(/\r?\n/)
        const missing = EXCLUDED.filter((line) => !have.includes(line))
        if (missing.length > 0) writeSync(fd, `${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.map((line) => `${line}\n`).join('')}`)
      } finally { closeSync(fd) }
    }
  } catch (e) { setup = ['refused', 'worktree-path', String(e?.message ?? e)] }
  if (setup !== null) return standDown(setup[0], setup[1], setup[2])

  // ---- the worktree, at the object the tag was created at, never this clone's own idea of main.
  const add = git(cwd, ['worktree', 'add', worktree, '-b', branch, baseSha], PUSH_MS)
  if (add.code !== 0) {
    return standDown('refused', 'worktree-add', `git worktree add failed (exit ${add.code}): ${complaint(ctx.redact(add.stderr)) || 'git said nothing'}`, { added: true })
  }
  const listed = git(cwd, ['worktree', 'list', '--porcelain'])
  const entry = listed.code === 0 ? parseWorktrees(listed.stdout).find((e) => e.path === worktree) : undefined
  if (entry?.branch !== `refs/heads/${branch}`) {
    return standDown('refused', 'worktree-add', `git reported adding ${worktree}, but that path and branch did not read back from the worktree list`, { added: true })
  }

  // ---- publish. A non-zero push is not proof nothing landed, so origin is asked before any undo.
  const head = baseSha
  const branchRef = `refs/heads/${branch}`
  const everything = ['claim-tag', 'worktree', 'local-branch', 'remote-branch']
  const pushed = git(worktree, ['push', '-u', 'origin', branch], PUSH_MS)
  if (pushed.code !== 0) {
    const detail = `git push -u origin ${branch} failed (exit ${pushed.code}): ${complaint(ctx.redact(pushed.stderr)) || 'git said nothing'}`
    const remote = readRef(ctx, branchRef)
    if (remote.state === 'present' && remote.sha === head) {
      return settle('unknown', 'push', `${detail}, but ${branchRef} is on origin at ${head.slice(0, 12)}: the branch was published and only the answer was lost`, { retained: everything, extra: { ...claimed, head } })
    }
    if (remote.state === 'unknown') return settle('unknown', 'push', `${detail}, and origin could not be read afterwards: ${remote.detail}`, { retained: everything, extra: { ...claimed, head } })
    if (remote.state === 'present') {
      // A rival took the name. Its branch goes under found, never retained: it is not this run's to clear.
      const rival = { worktrees: [], localBranches: [], remoteBranches: [{ where: 'remote-branch', ref: branchRef, sha: remote.sha }], pullRequests: [] }
      const swept = unwind({ added: true })
      return settle('unknown', 'push', `${detail}, and ${branchRef} is on origin at ${remote.sha.slice(0, 12)}, which this run did not push`, { retained: swept.retained, cleanup: swept.cleanup, extra: { ...claimed, head, found: rival } })
    }
    return standDown('refused', 'push', detail, { added: true, extra: { head } })
  }

  // ---- past here the branch is on origin and nothing is given back.
  const stuck = (reason, detail) => settle('unknown', reason, detail, {
    retained: everything, extra: { ...claimed, head },
    human: `${detail}. ${branch} is on ${repo} at ${head.slice(0, 12)} and ${ref} is still there; finish or unwind this by hand, and do not re-run the claim.`,
  })
  const edit = runGh(['issue', 'edit', String(issue), ...repoPin, '--add-assignee', '@me', '--remove-label', READY, '--add-label', IN_PROGRESS], { cwd })
  if (edit.code !== 0) return stuck('issue-edit', failed(`gh issue edit ${issue}`, edit))
  // gh exiting 0 says the request was accepted. The read-back needs the whole state the next reader
  // needs: open, in-progress, no other lifecycle label, and assigned to the login @me resolved to.
  const me = runGh(['api', ...hostPin, '--jq', '.login', 'user'], { cwd })
  const login = me.code === 0 ? me.stdout.trim() : ''
  const confirmed = readIssue()
  if (confirmed.problem) return stuck('issue-edit-unconfirmed', `the edit was accepted and the issue could not be read back: ${confirmed.problem}`)
  if (login === '') return stuck('issue-edit-unconfirmed', `the edit was accepted and ${failed('gh api user', me)}, so the assignment cannot be checked`)
  const assigned = loginsOf(confirmed.issue.assignees)
  const lifecycle = LIFECYCLE.filter((l) => confirmed.labels.includes(l))
  if (confirmed.state !== 'OPEN' || lifecycle.length !== 1 || lifecycle[0] !== IN_PROGRESS || !assigned.includes(login)) {
    return stuck('issue-edit-unconfirmed', `the edit was accepted and issue #${issue} reads back ${confirmed.state || 'stateless'} with ` +
      `${confirmed.labels.join(', ') || 'no labels'}, assigned to ${assigned.join(', ') || 'nobody'}`)
  }

  // ---- give the tag back once the branch reads back on origin at the head this run pushed.
  const published = readRef(ctx, branchRef)
  if (published.state !== 'present' || published.sha !== head) {
    return stuck('release', `${branchRef} did not read back on origin at ${head.slice(0, 12)} (${published.state}), so the claim tag stays`)
  }
  const dropped = dropTag(ctx, issue, baseSha)
  if (!dropped.gone) return stuck('release', `the claim tag could not be dropped (${dropped.reason ?? dropped.result}: ${dropped.detail ?? 'no detail'})`)

  return emit({ command: 'claim', result: 'claimed', repo, issue, title: names.title, kind, branch, worktree, base: baseSha, head, acDigest, url: names.url })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runExecutor(issueClaim({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, runGh: ghRunner(process.env) }))
}
