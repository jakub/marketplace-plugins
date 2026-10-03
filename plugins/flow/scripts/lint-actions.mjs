#!/usr/bin/env node
// lint-actions.mjs: the nightly lint's read of what there is to change, and its only way to
// change it.
//
//   survey <repo>
//   remove-worktree <repo> <path>
//   delete-branch <repo> <branch>
//   delete-remote-branch <repo> <branch> [--expect <sha>]
//   relabel <repo> <N> --from <label|none> --to <label> --seen <updatedAt> --reason <words_joined_by_underscores>
//
// The model picks candidates from the survey; this code re-derives every condition from fresh
// state and refuses unless all of them hold. Every verb: the repository must resolve, and when
// FLOW_WORKSPACE is set (always, under FLOW_CRON_JOB) it must be a main checkout directly under it,
// because the path decides which repository the ambient token acts on. `git fetch --prune --no-tags
// origin` runs first and a failure refuses. That fetch follows remote.origin.fetch, which a clone
// can narrow, so a verb that deletes then fetches every origin branch it judges against by name,
// with forced refspecs, and judges only those. Every gh call is pinned to the repository origin
// parses to, and every verb but the survey refuses when GitHub names that repository otherwise, as
// it does after a transfer or a rename. Every mutation is read back, and nothing is undone: a label present after an edit is
// no proof this run put it there. A relabel a claim could race holds the issue's claim tag on
// origin, through issue-claim.mjs's own acquire and dropTag, from its re-check to its read-back.
// delete-remote-branch needs origin to fetch from and push to one URL, and deletes only at the tip
// it judged dead, through a lease origin checks at delete time, so a branch pushed to after the
// judgment is never deleted. Its one warrant is a merged or closed pull request from this
// repository whose head is that tip, never ancestry. It refuses a branch that open pull requests
// head, here or in the repository origin was forked from, or use as their base, and a branch this
// checkout holds through a worktree on it or a local branch of its name. A local branch that only
// tracks it is no hold, and every answer names those as trackedBy. Its known limit: GitHub has no
// lock, so a pull request opened between the last open-PR read and origin applying the delete
// loses its head branch. The land stage retires a pull request's head branch through it with
// --expect, which refuses unless origin's tip is exactly the head it merged.
// stdout is one JSON line {action, repo, target, ok, reason, ...}; exit 0 when the action happened
// (or the survey was read), 1 on a refusal, 2 on usage. Every argument fits git-guard's cron
// regex, which is why the relabel reason is a single token.

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { execCapture, ghRunner, parseJson, runExecutor } from '../lib/gh-exec.mjs'
import { firstLine, makeRedactor } from '../lib/redact.mjs'
import { allowedHostsFrom, identityOfRemote } from '../lib/remote-identity.mjs'
import { acquire, dropTag, originUrl as originOfOneUrl, readRef } from './issue-claim.mjs'

const HOUR = 3_600_000
const RECENT_MS = 96 * HOUR
const ORPHAN_MS = 6 * HOUR
const PROTECTED = new Set(['main', 'master', 'flow-evidence'])
const LIFECYCLE = ['needs-triage', 'agent-found', 'ready-for-agent', 'in-progress', 'needs-info', 'needs-human', 'needs-rebase', 'wontfix', 'deferred']
const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'flow', 'label-contract.md')
const FLAKES_PATH = '.github/known-flakes.txt'
// The only label moves the lint may make. `live` re-runs the claim's scan for a run on the issue
// and holds the claim tag while it moves the label; `minAge` is the grace a running issue stage
// needs before its branch reaches origin.
const TRANSITIONS = {
  'in-progress>ready-for-agent': { live: true, minAge: ORPHAN_MS },
  'ready-for-agent>needs-triage': { live: true, minAge: 0 },
  'none>needs-triage': { live: false, minAge: 0 },
}
const USAGE = 'usage: lint-actions.mjs survey <repo> | remove-worktree <repo> <path> | delete-branch <repo> <branch> | ' +
  'delete-remote-branch <repo> <branch> [--expect <sha>] | relabel <repo> <N> --from <label|none> --to <label> --seen <updatedAt> --reason <words_joined_by_underscores>'

class Verdict { constructor(ok, reason, extra) { Object.assign(this, { ok, reason, extra }) } }
const finish = (ok, reason, extra = {}) => { throw new Verdict(ok, reason, extra) }
const refuse = (reason, extra) => finish(false, reason, extra)

export function lintActions({ argv, env }) {
  const [action, repoArg, target, ...rest] = argv
  const known = ['survey', 'remove-worktree', 'delete-branch', 'delete-remote-branch', 'relabel']
  // delete-remote-branch takes one optional flag, --expect with a full object name.
  const expectOk = rest.length === 0 || (rest.length === 2 && rest[0] === '--expect' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(rest[1]))
  if (!known.includes(action) || !repoArg || (action !== 'survey' && !target) || (action === 'delete-remote-branch' ? !expectOk : action !== 'relabel' && rest.length > 0) || (action === 'survey' && target)) {
    return { code: 2, stdout: '', stderr: `${USAGE}\n` }
  }
  const emit = (v) => ({ code: v.ok ? 0 : 1, stdout: `${JSON.stringify({ action, repo: repoArg, target: target ?? null, ok: v.ok, reason: v.reason, ...v.extra })}\n`, stderr: '' })
  try {
    run({ action, repoArg, target, rest, env })
    return emit(new Verdict(false, 'the verb ended without a verdict', {}))
  } catch (error) {
    if (error instanceof Verdict) return emit(error)
    return emit(new Verdict(false, `unexpected failure: ${firstLine(error?.message ?? error)}`, {}))
  }
}

function run({ action, repoArg, target, rest, env }) {
  // Unattended: ssh must never prompt, since a prompt is a hang until the job's timeout.
  const gitEnv = { ...env, GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=10', GIT_TERMINAL_PROMPT: '0' }
  const gitIn = (dir, args, timeoutMs = 10_000) => {
    const r = execCapture('git', ['-C', dir, ...args], { timeoutMs, env: gitEnv })
    return r.code === 0 ? r.stdout.trim() : null
  }
  const real = (path) => { try { return realpathSync(path) } catch { return null } }

  // ---- the workspace bound, the fetch and the pin, for every verb
  const repo = real(repoArg)
  if (repo === null) refuse('the repository path does not resolve')
  if (env.FLOW_CRON_JOB && !env.FLOW_WORKSPACE) refuse('FLOW_CRON_JOB is set and FLOW_WORKSPACE is not, so the repository path is unbounded')
  if (env.FLOW_WORKSPACE) {
    if (dirname(repo) !== real(env.FLOW_WORKSPACE)) refuse(`${repo} is not a direct child of the workspace; the lint acts only on the repositories it enumerated`)
    const common = gitIn(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    if (common === null || real(common) !== join(repo, '.git')) refuse(`${repo} is not a main checkout with its own .git; a linked worktree acts on another repository`)
  }
  if ((action === 'delete-branch' || action === 'delete-remote-branch') && PROTECTED.has(target)) refuse(`${target} is a protected branch`)
  const originUrl = gitIn(repo, ['remote', 'get-url', 'origin'])
  if (originUrl === null) refuse('the repository has no origin remote')
  const redact = makeRedactor(originUrl, 'origin')
  const fetched = execCapture('git', ['-C', repo, 'fetch', '--prune', '--no-tags', '--quiet', 'origin'], { timeoutMs: 60_000, env: gitEnv })
  if (fetched.code !== 0) refuse(`git fetch origin failed, so nothing is decided on possibly stale refs: ${redact(firstLine(fetched.stderr)) || `exit ${fetched.code}`}`)
  const pinned = identityOfRemote(originUrl, { purpose: 'act on', allowedHosts: allowedHostsFrom(env) })
  if (pinned.identity === undefined && action !== 'survey') refuse(pinned.refusal)
  const id = pinned.identity ?? null
  const runGh = ghRunner(env)
  const gh = (args, what) => {
    const r = runGh(args, { cwd: repo })
    const value = r.code === 0 ? parseJson(r.stdout) : null
    if (value === null) refuse(`${what} failed, so nothing is decided without it: ${firstLine(r.stderr) || `exit ${r.code}`}`)
    return value
  }
  const slurp = (path, what) => {
    const value = gh(['api', '--hostname', id.host, '--paginate', '--slurp', path], what)
    if (!Array.isArray(value)) refuse(`${what} did not read as an array of pages`)
    return value
  }
  const pages = (path, what) => {
    const value = slurp(path, what)
    if (!value.every(Array.isArray)) refuse(`${what} did not read as an array of pages`)
    return value.flat()
  }
  const PR_LIMIT = 1000
  const prCache = new Map()
  // fresh skips the cache, for the re-read straight before a delete.
  const prsFor = (branch, { fresh = false } = {}) => {
    if (fresh || !prCache.has(branch)) {
      // gh pr list fetches 30 by default. An explicit limit, and a full answer read as possibly
      // truncated, keep a destructive decision from resting on a partial list.
      const list = gh(['pr', 'list', '--repo', id.full, '--head', branch, '--state', 'all', '--limit', String(PR_LIMIT), '--json', 'number,state,headRefOid,isCrossRepository'], `gh pr list --head ${branch}`)
      if (!Array.isArray(list)) refuse(`gh pr list --head ${branch} did not answer a list`)
      if (list.length >= PR_LIMIT) refuse(`gh pr list --head ${branch} returned ${list.length} pull requests, its limit, so the list may be partial`)
      prCache.set(branch, list)
    }
    return prCache.get(branch)
  }
  // Open pull requests whose base is the branch, from any repository: GitHub closes each of them
  // when the branch is deleted. fresh skips the cache, like prsFor's.
  const baseCache = new Map()
  const basedOn = (branch, { fresh = false } = {}) => {
    if (fresh || !baseCache.has(branch)) {
      const list = gh(['pr', 'list', '--repo', id.full, '--base', branch, '--state', 'open', '--limit', String(PR_LIMIT), '--json', 'number'], `gh pr list --base ${branch}`)
      if (!Array.isArray(list)) refuse(`gh pr list --base ${branch} did not answer a list`)
      if (list.length >= PR_LIMIT) refuse(`gh pr list --base ${branch} returned ${list.length} pull requests, its limit, so the list may be partial`)
      baseCache.set(branch, list)
    }
    return baseCache.get(branch)
  }
  // When origin is a fork, a pull request into the repository it was forked from can head from
  // this branch, and GitHub closes it when the branch is deleted. gh pr list --head reads origin
  // alone, so the parent is read by its own query, head=<owner>:<branch>, with the owner GitHub
  // names now (canonicalName), not the one origin's URL may still carry. The parent is
  // looked up once per run, through the same cached gh repo view as the default branch.
  const parentOf = () => {
    const parent = repoView()?.parent ?? null
    if (parent === null) return null
    if (typeof parent?.owner?.login !== 'string' || parent.owner.login === '' || typeof parent?.name !== 'string' || parent.name === '') refuse('gh repo view named a parent without an owner and a name')
    return `${parent.owner.login}/${parent.name}`
  }
  const upstreamCache = new Map()
  const upstreamOpenOf = (branch, { fresh = false } = {}) => {
    const parent = parentOf()
    if (parent === null) return null
    if (fresh || !upstreamCache.has(branch)) {
      const head = encodeURIComponent(`${canonicalName().split('/')[0]}:${branch}`)
      const open = pages(`repos/${parent}/pulls?state=open&head=${head}&per_page=100`, `gh api over ${parent}'s open pull requests from ${branch}`)[0] ?? null
      upstreamCache.set(branch, open === null ? null : { number: open.number, repo: parent })
    }
    return upstreamCache.get(branch)
  }
  const refuseUpstreamOpen = (branch, opts) => {
    const open = upstreamOpenOf(branch, opts)
    if (open) refuse(`${branch} heads an open pull request in ${open.repo} (#${open.number}), which deleting it would close`)
  }
  const refuseBased = (branch, opts) => {
    const based = basedOn(branch, opts)
    if (based.length > 0) refuse(`${based.length} open pull request(s) use ${branch} as their base (#${based.map((p) => p.number).join(', #')}), and deleting it would close them`)
  }
  // Ancestry is judged against the default branch GitHub names, read once, never a fixed main: a
  // second branch that happens to be called main proves nothing merged.
  let repoInfo = null
  const repoView = () => (repoInfo ??= gh(['repo', 'view', id.full, '--json', 'defaultBranchRef,nameWithOwner,parent'], 'gh repo view'))
  let defaultName = null
  const defaultBranch = () => {
    defaultName ??= repoView()?.defaultBranchRef?.name ?? null
    if (typeof defaultName !== 'string' || defaultName === '') refuse('gh repo view named no default branch, so nothing is judged against it')
    return defaultName
  }
  // origin's URL can keep a repository's old owner or name after a transfer or a rename, and
  // GitHub redirects it, so every gh call still lands. A query that names the owner itself, such
  // as the parent's head=<owner>:<branch>, would ask about the old one. So the name GitHub gives is
  // the one used there, and a verb that changes anything refuses until origin's URL says it too.
  const canonicalName = () => {
    const name = repoView()?.nameWithOwner
    if (typeof name !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(name)) refuse('gh repo view named no nameWithOwner, so the repository origin reaches is unconfirmed')
    return name
  }
  if (id !== null && action !== 'survey' && canonicalName().toLowerCase() !== `${id.owner}/${id.repo}`.toLowerCase()) {
    refuse(`origin's URL names ${id.owner}/${id.repo}, and GitHub names that repository ${canonicalName()}; update origin's URL to the new name and run again`)
  }
  // Only the local verbs judge ancestry, and only against the exact default-branch tip fromOrigin
  // fetched, never a tracking ref some other fetch left.
  let judgedMain = null
  const inMain = (tip) => gitIn(repo, ['merge-base', '--is-ancestor', tip, judgedMain ?? refuse('ancestry was asked before origin was fetched by name')]) !== null
  // What a verb that deletes judges against: origin's branches fetched by name, with forced
  // explicit refspecs, into their tracking refs. The preamble's fetch honours remote.origin.fetch,
  // which a clone can narrow or negate, so its success proves nothing about a given tracking ref.
  // Answers each branch's tip, or null for a branch origin does not have; that branch's tracking
  // ref may be stale, and no judgment reads it. The default branch has to be there, and its tip
  // pins inMain. A tracking ref this creates outside a narrowed refspec stays behind, except the
  // one delete-remote-branch drops after its delete.
  const originCtx = { cwd: repo, redact, env: gitEnv }
  const fromOrigin = (branches) => {
    const tips = new Map()
    for (const branch of new Set([defaultBranch(), ...branches])) {
      const listed = readRef(originCtx, `refs/heads/${branch}`)
      if (listed.state === 'unknown') refuse(listed.detail)
      tips.set(branch, listed.state === 'present' ? listed.sha : null)
    }
    const present = [...tips.keys()].filter((branch) => tips.get(branch) !== null)
    if (tips.get(defaultBranch()) === null) refuse(`origin has no ${defaultBranch()} branch, so nothing is judged against it`)
    const fetched = execCapture('git', ['-C', repo, 'fetch', '--quiet', '--no-tags', 'origin', ...present.map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`)], { timeoutMs: 60_000, env: gitEnv })
    if (fetched.code !== 0) refuse(`git fetch of ${present.join(', ')} from origin failed, so nothing is judged on possibly stale refs: ${redact(firstLine(fetched.stderr)) || `exit ${fetched.code}`}`)
    for (const branch of present) {
      const sha = gitIn(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
      if (sha === null) refuse(`origin/${branch} did not read back after its fetch`)
      tips.set(branch, sha)
    }
    judgedMain = tips.get(defaultBranch())
    return tips
  }

  // gh pr list --head matches the branch name alone, so a fork's pull request from a branch of the
  // same name is listed too. An open one blocks whichever repository it heads from, because that
  // is the conservative reading; a merged or closed one is a warrant only from this repository,
  // since a fork's history says nothing about the branch here, even at the same tip.
  const openPrOf = (branch) => prsFor(branch).find((p) => p.state === 'OPEN') ?? null
  const closedAt = (branch, tip) => prsFor(branch).find((p) => (p.state === 'MERGED' || p.state === 'CLOSED') && p.isCrossRepository === false && p.headRefOid === tip) ?? null
  const refuseOpen = (branch) => {
    const open = openPrOf(branch)
    if (open) refuse(`${branch} has an open pull request (#${open.number})`)
  }
  // Recoverable: can origin reproduce this tip after the delete? An open pull request refuses outright.
  // remoteTip is the branch's tip on origin as fromOrigin fetched it, or null.
  const recoverable = (branch, tip, remoteTip) => {
    refuseOpen(branch)
    if (remoteTip === tip) return `origin/${branch} is at this tip`
    if (remoteTip !== null && gitIn(repo, ['rev-list', '--count', `${remoteTip}..${tip}`]) === '0') return `no commits beyond origin/${branch}`
    const closed = closedAt(branch, tip)
    if (closed) return `pull request #${closed.number} (${closed.state}) has this tip as its head`
    if (inMain(tip)) return `the tip is in origin/${defaultBranch()}`
    return refuse('the tip is not reproducible from origin (no matching remote branch, pull request head or main ancestry)')
  }
  // Dead: recoverable is not a reason to delete; a pushed spike with no pull request is alive. A
  // closed pull request is a warrant only for the tip it closed at, since a branch name can be
  // reused for new work after its old pull request closed.
  // deathOf answers null where dead refuses. prWarrant is the pull request half alone, and the
  // only warrant a branch on origin gets: issue-claim pushes a new run branch at main's tip, and a
  // release or stable branch can sit behind main, so ancestry says nothing about either's death.
  const prWarrant = (branch, tip) => {
    const closed = closedAt(branch, tip)
    return closed ? `pull request #${closed.number} is ${closed.state}` : null
  }
  const deathOf = (branch, tip) => prWarrant(branch, tip) ?? (inMain(tip) ? `the tip is already in origin/${defaultBranch()}` : null)
  const dead = (branch, tip) => deathOf(branch, tip) ??
    refuse(`no merged or closed pull request and the tip is not in origin/${defaultBranch()}: recoverable, but not shown dead, so a human decides`)
  const worktrees = () => {
    const listed = gitIn(repo, ['worktree', 'list', '--porcelain', '-z'])
    if (listed === null) refuse('git worktree list failed')
    const entries = []
    for (const field of listed.split('\0')) {
      if (field.startsWith('worktree ')) entries.push({ path: field.slice(9), branch: null, head: null })
      else if (field.startsWith('branch ')) entries.at(-1).branch = field.slice(7).replace(/^refs\/heads\//, '')
      else if (field.startsWith('HEAD ')) entries.at(-1).head = field.slice(5)
    }
    return entries
  }
  /**
   * Why this checkout holds a branch of origin's: a worktree on it, or a local branch of that name.
   * Tracking is no hold. With a same-repository pull request at the tip as the warrant, deleting
   * the branch on origin loses no commit, and a stacked child that tracks its landed parent would
   * otherwise hold the parent forever. Trackers are named instead, by trackersOf.
   */
  const heldHere = (branch) => {
    const wt = worktrees().find((e) => e.branch === branch)
    if (wt) return `the worktree ${wt.path} is on ${branch}`
    const local = execCapture('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { timeoutMs: 10_000, env: gitEnv })
    if (local.code === 0) return `the local branch ${branch} exists here`
    if (local.code !== 1) refuse(`git rev-parse refs/heads/${branch} failed`)
    return null
  }
  // Every local branch whose branch.<x>.merge names refs/heads/<b> and whose branch.<x>.remote
  // resolves to origin's URL, read from the config itself: %(upstream) renders empty under a
  // narrowed refspec, follows one merge value of several, and knows nothing of a second remote
  // with origin's URL. A branch with no remote set is taken as origin's, as git pull takes it.
  let trackerIndex = null
  const trackersOf = (branch) => {
    if (trackerIndex === null) {
      const r = execCapture('git', ['-C', repo, 'config', '--get-regexp', '^branch\\..*\\.(merge|remote)$'], { timeoutMs: 10_000, env: gitEnv })
      if (r.code !== 0 && r.code !== 1) refuse('git config over the branch settings failed')
      const settings = new Map()
      for (const line of (r.code === 0 ? r.stdout : '').split('\n').filter(Boolean)) {
        const space = line.indexOf(' ')
        const key = line.slice(0, space < 0 ? line.length : space).match(/^branch\.(.+)\.(merge|remote)$/)
        if (!key) continue
        if (!settings.has(key[1])) settings.set(key[1], { merge: [], remote: [] })
        settings.get(key[1])[key[2]].push(space < 0 ? '' : line.slice(space + 1))
      }
      const urls = new Map()
      const isOrigin = (remote) => {
        if (remote === 'origin') return true
        if (!urls.has(remote)) {
          const named = execCapture('git', ['-C', repo, 'remote', 'get-url', remote], { timeoutMs: 10_000, env: gitEnv })
          urls.set(remote, named.code === 0 ? named.stdout.trim() : remote)
        }
        return urls.get(remote) === originUrl
      }
      trackerIndex = new Map()
      for (const [name, { merge, remote }] of settings) {
        if (!(remote.length === 0 || remote.some(isOrigin))) continue
        for (const ref of new Set(merge)) trackerIndex.set(ref, [...(trackerIndex.get(ref) ?? []), name].sort())
      }
    }
    return trackerIndex.get(`refs/heads/${branch}`) ?? []
  }
  /** The newest of the HEAD commit's time and every tracked file's mtime, in ms, or null. */
  const lastChange = (path) => {
    const committed = gitIn(path, ['log', '-1', '--format=%ct', 'HEAD'])
    const files = gitIn(path, ['ls-files', '-z'])
    if (committed === null || files === null) return null
    let newest = Number(committed) * 1000
    for (const file of files.split('\0').filter(Boolean)) { try { newest = Math.max(newest, lstatSync(join(path, file)).mtimeMs) } catch {} }
    return newest
  }

  if (action === 'remove-worktree') {
    const path = real(target) ?? target
    const all = worktrees()
    if (all[0]?.path === path) refuse('this is the main worktree')
    const entry = all.find((e) => e.path === path)
    if (!entry) refuse('the path is not a registered worktree of this repository')
    const status = gitIn(path, ['status', '--porcelain'])
    if (status === null) refuse('the worktree status could not be read')
    if (status !== '') refuse('the worktree has tracked changes or untracked files')
    // .flow-scratch/ is ignored, so status reads clean over it and lastChange never sees it. A run's
    // scratch is retired by land, with the run, never by the lint.
    const refuseScratch = (when = '') => {
      let scratch
      try { scratch = readdirSync(join(path, '.flow-scratch')).length } catch (error) { scratch = error?.code === 'ENOENT' ? 0 : null }
      if (scratch === null) refuse('the worktree\'s .flow-scratch/ could not be read')
      if (scratch > 0) refuse(`the worktree holds run scratch${when}; land retires it`)
    }
    refuseScratch()
    const changed = lastChange(path)
    if (changed === null) refuse('the worktree\'s last change could not be read')
    if (Date.now() - changed < RECENT_MS) refuse(`the worktree changed ${Math.round((Date.now() - changed) / HOUR)}h ago, inside the four-day window`)
    const tips = fromOrigin(entry.branch ? [entry.branch] : [])
    const why = entry.branch ? recoverable(entry.branch, entry.head, tips.get(entry.branch)) : inMain(entry.head) ? `the detached tip is in origin/${defaultBranch()}` : refuse(`the detached tip is not in origin/${defaultBranch()}`)
    // Again after every network read, straight before the remove. Nothing locks a scratch writer,
    // so one that writes between this read and git's own removal is the window left.
    refuseScratch(', written while it was being judged')
    const removed = execCapture('git', ['-C', repo, 'worktree', 'remove', path], { timeoutMs: 60_000, env: gitEnv })
    if (removed.code !== 0) refuse(`git worktree remove refused: ${firstLine(removed.stderr)}`)
    gitIn(repo, ['worktree', 'prune'])
    if (worktrees().some((e) => e.path === path) || real(path) !== null) refuse('git reported the removal, but the worktree still reads back')
    finish(true, `removed (${why})`)
  }

  if (action === 'delete-branch') {
    const tip = gitIn(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${target}`])
    if (tip === null) refuse('the branch does not exist')
    if (target === defaultBranch()) refuse(`${target} is the default branch`)
    if (worktrees().some((e) => e.branch === target)) refuse('the branch is checked out in a worktree')
    const tips = fromOrigin([target])
    const why = `${dead(target, tip)}; ${recoverable(target, tip, tips.get(target))}`
    // update-ref, unlike `git branch -D`, deletes a branch a worktree has checked out, so git's own
    // check is repeated here, after the reads above and straight before the delete.
    if (worktrees().some((e) => e.branch === target)) refuse('the branch was checked out in a worktree while it was being judged')
    // Compare-and-delete: git refuses if the branch moved off the tip every check above was about.
    if (gitIn(repo, ['update-ref', '-d', `refs/heads/${target}`, tip]) === null) refuse('the branch moved or could not be deleted')
    gitIn(repo, ['config', '--remove-section', `branch.${target}`])
    if (gitIn(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${target}`]) !== null) refuse('the delete was reported, but the branch still reads back')
    finish(true, `deleted at ${tip.slice(0, 12)} (${why})`)
  }

  if (action === 'delete-remote-branch') {
    const ref = `refs/heads/${target}`
    // HEAD is origin's symbolic ref here, never a branch, and git refuses to name a branch HEAD.
    if (target === 'HEAD' || gitIn(repo, ['check-ref-format', ref]) === null) refuse(`${target} is not a valid branch name`)
    if (target === defaultBranch()) refuse(`${target} is the default branch`)
    // The delete goes to origin's push URL and the read-back reads its fetch URL, so with two URLs
    // a branch could be deleted in one repository and judged and read back in another.
    const one = originOfOneUrl(repo, gitEnv)
    if (one.url === undefined) refuse(one.problem === 'no-origin' ? 'the repository has no origin remote' : 'origin fetches from and pushes to URLs that are not one URL, so the delete could land where no read here looks')
    // Every answer from here on, success or refusal, names the local branches that track this one.
    const trackedBy = trackersOf(target)
    try {
      // A branch this checkout still holds is in use here, whatever GitHub says: a just-claimed run
      // branch has no pull request yet, and land deletes the local branch before the remote one.
      const held = heldHere(target)
      if (held) refuse(held)
      // The tip is the one fromOrigin fetched, not the ls-remote answer before it: the fetch brought
      // the tip's objects here beside the default branch. Freshness is not what keeps the delete
      // safe: the lease below is, since origin refuses it if the branch moved off this tip after.
      const tip = fromOrigin([target]).get(target)
      if (tip === null) refuse(`${target} does not exist on origin`)
      // --expect binds the delete to one tip the caller already knows, such as the head land
      // merged: any other tip on origin is someone's later work, left for a human.
      const expect = rest[1] ?? null
      if (expect !== null && tip !== expect) refuse(`origin's ${target} is at ${tip.slice(0, 12)}, not the expected ${expect.slice(0, 12)}, so nothing was deleted`)
      refuseOpen(target)
      refuseUpstreamOpen(target)
      refuseBased(target)
      const why = prWarrant(target, tip) ??
        refuse('no merged or closed pull request from this repository has this tip as its head, and ancestry is no warrant on origin: not shown dead, so a human decides')
      // GitHub has no lock to hold across the delete, and the lease below checks only the tip, so
      // the open pull request reads, head and base, are repeated, uncached, straight before the
      // push. The window left is from this read to origin applying the delete: a pull request
      // opened or reopened inside it loses its head branch, and GitHub closes it. The reason below
      // names the tip, so the branch can be pushed back.
      const late = prsFor(target, { fresh: true }).find((p) => p.state === 'OPEN')
      if (late) refuse(`${target} gained an open pull request (#${late.number}) while it was being judged`)
      refuseUpstreamOpen(target, { fresh: true })
      refuseBased(target, { fresh: true })
      const heldLate = heldHere(target)
      if (heldLate) refuse(`${heldLate}, since it was judged`)
      // Compare-and-delete: origin applies the delete only while the branch is still at the tip
      // every check above was about, and rejects it as stale otherwise.
      const pushed = execCapture('git', ['-C', repo, 'push', `--force-with-lease=${ref}:${tip}`, 'origin', `:${ref}`], { timeoutMs: 60_000, env: gitEnv })
      const after = readRef({ cwd: repo, redact, env: gitEnv }, ref)
      if (after.state === 'unknown') refuse(`the delete ${pushed.code === 0 ? 'was reported' : 'failed'} and origin could not be read back: ${after.detail}`)
      if (pushed.code !== 0) {
        if (after.state === 'absent') refuse('the push failed, yet the branch reads back gone; whose delete removed it is unknown')
        refuse(`origin refused the delete, so nothing was deleted (the branch may have moved off ${tip.slice(0, 12)} since it was judged): ${redact(firstLine(pushed.stderr)) || `exit ${pushed.code}`}`)
      }
      if (after.state === 'present') refuse(`the delete was reported but still reads back, at ${after.sha.slice(0, 12)}`)
      // fromOrigin made this tracking ref, and a narrowed refspec's prune would never drop it. The
      // compare-and-delete leaves one that moved since.
      gitIn(repo, ['update-ref', '-d', `refs/remotes/origin/${target}`, tip])
      finish(true, `deleted on origin at ${tip.slice(0, 12)} (${why})`)
    } catch (error) {
      if (error instanceof Verdict) error.extra = { ...error.extra, trackedBy }
      throw error
    }
  }

  if (action === 'relabel') {
    const flags = {}
    for (let i = 0; i < rest.length; i += 2) {
      if (!['--from', '--to', '--seen', '--reason'].includes(rest[i]) || rest[i] in flags || i + 1 >= rest.length) refuse(`${rest[i]} is not a relabel flag with a value; ${USAGE}`)
      flags[rest[i]] = rest[i + 1]
    }
    const [from, to, seen, reason] = ['--from', '--to', '--seen', '--reason'].map((name) => flags[name] ?? null)
    if (!/^[1-9][0-9]*$/.test(target)) refuse('the issue number must be a positive integer')
    const rule = TRANSITIONS[`${from}>${to}`]
    if (!rule) refuse(`--from ${from} --to ${to} is not a transition the lint may make; it may make ${Object.keys(TRANSITIONS).join(', ')}`)
    if (seen === null || !Number.isFinite(Date.parse(seen))) refuse('--seen takes the updatedAt the lint read the issue at')
    if (reason === null || reason.replace(/_/g, '') === '') refuse('--reason takes the finding, one token with underscores for spaces')
    const wanted = from === 'none' ? [] : [from]
    const lifecycleOf = (issue) => LIFECYCLE.filter((l) => issue.labels.includes(l))
    const same = (a, b) => a.length === b.length && a.every((l) => b.includes(l))
    const readIssue = () => {
      const v = gh(['issue', 'view', target, '--repo', id.full, '--json', 'number,state,labels,updatedAt'], `gh issue view ${target}`)
      if (!Array.isArray(v?.labels)) refuse('gh issue view did not answer an issue')
      return { state: v.state, labels: v.labels.map((l) => l.name), updatedAt: v.updatedAt }
    }
    const judge = (issue) => {
      if (issue.state !== 'OPEN') refuse(`the issue is ${issue.state}, not OPEN`)
      if (!same(lifecycleOf(issue), wanted)) refuse(`the issue carries lifecycle labels [${lifecycleOf(issue).join(', ')}], and this transition needs ${from === 'none' ? 'none' : `${from} alone`}`)
      if (Date.parse(issue.updatedAt) !== Date.parse(seen)) refuse(`the issue moved since the lint read it (updatedAt ${issue.updatedAt}, seen ${seen}), so the judgment is stale`)
      const age = Date.now() - Date.parse(issue.updatedAt)
      if (age < rule.minAge) refuse(`the issue was updated ${Math.round(age / 60_000)} minutes ago; under six hours it may be a running issue stage whose branch is not on origin yet`)
    }
    const forIssue = new RegExp(`^(feat|fix|chore)/issue-${target}-`)
    const patterns = ['feat', 'fix', 'chore'].map((k) => `refs/heads/${k}/issue-${target}-*`)
    const claimRef = `refs/tags/flow-claim-issue-${target}`
    /** The claim's own scan for a run on the issue; the tag counts except while this verb holds it. */
    const liveRun = ({ tagCounts }) => {
      const local = gitIn(repo, ['for-each-ref', '--format=%(refname:short)', ...patterns])
      if (local === null) refuse('git for-each-ref failed')
      const localHit = local.split('\n').find((b) => forIssue.test(b))
      if (localHit) refuse(`live: local branch ${localHit}`)
      const wt = worktrees().find((e) => e.path.includes(`-issue-${target}-`) || forIssue.test(e.branch ?? ''))
      if (wt) refuse(`live: worktree ${wt.path}`)
      const remote = gitIn(repo, ['ls-remote', 'origin', ...patterns, ...(tagCounts ? [claimRef] : [])], 60_000)
      if (remote === null) refuse('git ls-remote origin failed')
      const remoteHit = remote.split('\n').map((l) => l.split('\t')[1] ?? '')
        .find((ref) => (tagCounts && ref === claimRef) || forIssue.test(ref.replace(/^refs\/heads\//, '')))
      if (remoteHit) refuse(`live: ${remoteHit} on origin`)
      const pr = pages(`repos/${id.owner}/${id.repo}/pulls?state=open&per_page=100`, 'gh api over the open pull requests').find((p) => forIssue.test(String(p?.head?.ref ?? '')))
      if (pr) refuse(`live: open pull request #${pr.number} from ${pr.head.ref}`)
    }
    const move = () => {
      const edit = runGh(['issue', 'edit', target, '--repo', id.full, ...(from === 'none' ? [] : ['--remove-label', from]), '--add-label', to], { cwd: repo })
      const after = readIssue()
      if (after.state !== 'OPEN' || !same(lifecycleOf(after), [to])) {
        if (after.state === 'OPEN' && same(lifecycleOf(after), wanted)) refuse(`the edit ${edit.code === 0 ? 'was accepted' : 'failed'} and the labels read back unchanged; nothing moved`)
        refuse(`after the edit the issue reads ${after.state} with [${lifecycleOf(after).join(', ')}] instead of OPEN with ${to} alone; left for a human, nothing undone`)
      }
      // The labels moved but this run's edit failed. A read-back cannot say whose edit moved them, so
      // the outcome is unknown and is never reported as this run's action.
      if (edit.code !== 0) refuse(`the edit failed, yet the labels read back as ${to} alone; whose edit moved them is unknown`)
    }
    // A move a claim could race runs under the claim's own tag. An issue run takes the tag before
    // its re-read and label edit, and this verb takes it before its own, so neither edit can land
    // between the other's read and write: a run that meets the lint's tag stands down as held, and
    // the lint refuses a tag it did not create. Everything is checked once for free and once more
    // under the tag, and the tag goes back straight after the read-back, before the comment.
    const underClaimTag = (act) => {
      const ctx = { cwd: repo, redact, env: gitEnv }
      const got = acquire(ctx, target)
      if (got.result === 'held' && got.observed === 'pre-push') refuse(`live: ${claimRef} on origin`)
      if (got.result !== 'acquired') refuse(`the claim tag could not be taken, so nothing moved: ${got.detail}`, got.observed === 'post-push' ? { retained: ['claim-tag'] } : {})
      let failure = null
      try { act() } catch (error) { failure = error }
      const dropped = dropTag(ctx, target, got.sha)
      const kept = dropped.gone ? null : `${claimRef} stays on origin (${dropped.reason ?? dropped.result}: ${dropped.detail ?? 'no detail'}) and holds off every claim of this issue until a human deletes it`
      if (failure instanceof Verdict && kept) {
        failure.reason += `; ${kept}`
        failure.extra = { ...failure.extra, retained: ['claim-tag'] }
      }
      if (failure) throw failure
      return kept
    }
    judge(readIssue())
    let kept = null
    if (rule.live) {
      liveRun({ tagCounts: true })
      kept = underClaimTag(() => { judge(readIssue()); liveRun({ tagCounts: false }); move() })
    } else move()
    const words = reason.replace(/_/g, ' ').trim()
    const body = `${from === 'none' ? `Added \`${to}\`` : `Moved \`${from}\` to \`${to}\``}: ${words}.\n\n- flow nightly lint`
    const commented = runGh(['issue', 'comment', target, '--repo', id.full, '--body', body], { cwd: repo }).code === 0
    finish(true, `relabelled ${from} to ${to}${commented ? '' : '; the comment failed, the labels moved'}${kept ? `; ${kept}` : ''}`, kept ? { retained: ['claim-tag'] } : {})
  }

  // ---- survey: read-only, and every read that fails refuses the whole survey.
  const all = worktrees()
  const branchLines = gitIn(repo, ['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(upstream:short)%09%(upstream:track)', 'refs/heads'])
  if (branchLines === null) refuse('git for-each-ref failed')
  const prsOf = (branch) => (id === null ? null : prsFor(branch))
  const survey = {
    identity: id?.full ?? null,
    ...(id === null ? { skipped: pinned.refusal } : {}),
    worktrees: all.slice(1).map((e) => {
      const status = gitIn(e.path, ['status', '--porcelain'])
      const changed = lastChange(e.path)
      return { path: e.path, branch: e.branch, head: e.head, clean: status === null ? null : status === '', lastChange: changed === null ? null : new Date(changed).toISOString(), prs: e.branch ? prsOf(e.branch) : null }
    }),
    branches: branchLines.split('\n').filter(Boolean).map((line) => {
      const [name, tip, upstream, track] = line.split('\t')
      return { name, tip, upstream: upstream || null, track: track || null, checkedOut: all.some((e) => e.branch === name), protected: PROTECTED.has(name), prs: PROTECTED.has(name) ? null : prsOf(name) }
    }),
  }
  if (id !== null) {
    // Origin's branches as origin lists them, not as tracking refs: a narrowed fetch refspec can
    // leave a tracking ref for a branch origin no longer has. Minus the default and the protected
    // ones, each judged as delete-remote-branch would judge it.
    const remoteLines = gitIn(repo, ['ls-remote', '--heads', 'origin'], 60_000)
    if (remoteLines === null) refuse('git ls-remote over origin\'s branches failed')
    survey.remoteBranches = remoteLines.split('\n').filter(Boolean).map((line) => {
      const [tip, refname] = line.split('\t')
      return { name: refname.slice('refs/heads/'.length), tip }
    }).filter(({ name }) => name !== defaultBranch() && !PROTECTED.has(name)).map(({ name, tip }) => {
      const open = openPrOf(name)
      const upstream = open ? null : upstreamOpenOf(name)
      const held = heldHere(name)
      const based = basedOn(name).length
      return { name, tip, openPr: open?.number ?? upstream?.number ?? null, openPrRepo: open ? `${id.owner}/${id.repo}` : upstream?.repo ?? null, basedPrs: based, heldHere: held, trackedBy: trackersOf(name), dead: open || upstream || based > 0 || held ? null : prWarrant(name, tip) }
    })
    survey.issues = pages(`repos/${id.owner}/${id.repo}/issues?state=open&per_page=100`, 'gh api over the open issues').filter((i) => !i.pull_request).map((i) => {
      const labels = (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
      const lifecycle = LIFECYCLE.filter((l) => labels.includes(l))
      // The body only where the lint has to judge it against the ready-for-agent contract.
      return { number: i.number, title: i.title, labels, lifecycle, updatedAt: i.updated_at, ...(lifecycle.includes('ready-for-agent') ? { body: i.body ?? '' } : {}) }
    })
    survey.labels = labelDrift(pages(`repos/${id.owner}/${id.repo}/labels?per_page=100`, 'gh api over the labels'))
    survey.flakes = flakeEntries({ gh, slurp, gitIn, repo, id, defaultBranch: defaultBranch() })
  }
  finish(true, 'surveyed', survey)
}

/**
 * The repository's label tuples against the table in label-contract.md, read by its header cells
 * (label, color, description) so a reshaped table still parses, plus the stock `name` (`color`)
 * modifiers. A table that parses to nothing is reported, never read as a clean repository.
 */
function labelDrift(have) {
  const text = readFileSync(CONTRACT, 'utf8')
  const want = []
  let cols = null
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) { cols = null; continue }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.replaceAll('`', '').trim())
    if (cols === null) {
      const lower = cells.map((c) => c.toLowerCase())
      cols = { name: lower.indexOf('label'), color: lower.indexOf('color'), description: lower.findIndex((c) => c.startsWith('description')) }
    } else if (!cells.every((c) => /^:?-+:?$/.test(c)) && Object.values(cols).every((i) => i >= 0)) {
      want.push({ name: cells[cols.name], color: cells[cols.color], description: cells[cols.description] })
    }
  }
  for (const m of text.matchAll(/`([a-z][a-z-]*)` \(`([0-9a-f]{6})`\)/g)) want.push({ name: m[1], color: m[2], description: null })
  if (want.length === 0) return { error: `no label tuples parsed out of ${CONTRACT}` }
  const byName = new Map(have.map((l) => [l.name, l]))
  const drifted = []
  for (const w of want) {
    const h = byName.get(w.name)
    if (h === undefined) continue
    const off = {}
    if (String(h.color).toLowerCase() !== w.color) off.color = { want: w.color, have: h.color }
    if (w.description !== null && (h.description ?? '') !== w.description) off.description = { want: w.description, have: h.description ?? '' }
    if (Object.keys(off).length > 0) drifted.push({ name: w.name, ...off })
  }
  return { missing: want.filter((w) => !byName.has(w.name)).map((w) => w.name), drifted, extra: have.map((l) => l.name).filter((n) => !want.some((w) => w.name === n)) }
}

/** Each known-flakes line on the default branch, against the jobs of the last 20 workflow runs. */
function flakeEntries({ gh, slurp, gitIn, repo, id, defaultBranch }) {
  const text = gitIn(repo, ['show', `refs/remotes/origin/${defaultBranch}:${FLAKES_PATH}`])
  if (text === null) return { file: false, entries: [] }
  const runs = gh(['api', '--hostname', id.host, `repos/${id.owner}/${id.repo}/actions/runs?per_page=20`], 'gh api over the workflow runs')?.workflow_runs ?? []
  const jobsPerRun = runs.map((r) => slurp(`repos/${id.owner}/${id.repo}/actions/runs/${r.id}/jobs?per_page=100`, `gh api over the jobs of run ${r.id}`).flatMap((p) => p?.jobs ?? []))
  const names = new Set(jobsPerRun.flat().map((j) => j.name))
  const entries = text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')).map((entry) => {
    // The whole line if a job has that name, else the longest job name it starts with, else its first colon.
    let check = names.has(entry) ? entry : null
    if (check === null) for (const name of names) if (entry.startsWith(`${name}:`) && name.length > (check?.length ?? -1)) check = name
    check ??= entry.includes(':') ? entry.slice(0, entry.indexOf(':')).trim() : entry
    return {
      entry, check,
      runsSeen: jobsPerRun.filter((jobs) => jobs.some((j) => j.name === check)).length,
      runsFailed: jobsPerRun.filter((jobs) => jobs.some((j) => j.name === check && j.conclusion === 'failure')).length,
    }
  })
  return { file: true, runs: runs.length, entries }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runExecutor(lintActions({ argv: process.argv.slice(2), env: process.env }))
}
