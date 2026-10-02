#!/usr/bin/env node
// lint-actions.mjs: the nightly lint's read of what there is to change, and its only way to
// change it.
//
//   survey <repo>
//   remove-worktree <repo> <path>
//   delete-branch <repo> <branch>
//   relabel <repo> <N> --from <label|none> --to <label> --seen <updatedAt> --reason <words_joined_by_underscores>
//
// The model picks candidates from the survey; this code re-derives every condition from fresh
// state and refuses unless all of them hold. Every verb: the repository must resolve, and when
// FLOW_WORKSPACE is set (always, under FLOW_CRON_JOB) it must be a main checkout directly under it,
// because the path decides which repository the ambient token acts on. `git fetch --prune --no-tags
// origin` runs first and a failure refuses. Every gh call is pinned to the repository origin
// parses to. Every mutation is read back, and nothing is undone: a label present after an edit is
// no proof this run put it there. A relabel a claim could race holds the issue's claim tag on
// origin, through issue-claim.mjs's own acquire and dropTag, from its re-check to its read-back.
// stdout is one JSON line {action, repo, target, ok, reason, ...}; exit 0 when the action happened
// (or the survey was read), 1 on a refusal, 2 on usage. Every argument fits git-guard's cron
// regex, which is why the relabel reason is a single token.

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { execCapture, ghRunner, parseJson, runExecutor } from '../lib/gh-exec.mjs'
import { firstLine, makeRedactor } from '../lib/redact.mjs'
import { allowedHostsFrom, identityOfRemote } from '../lib/remote-identity.mjs'
import { acquire, dropTag } from './issue-claim.mjs'

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
  'relabel <repo> <N> --from <label|none> --to <label> --seen <updatedAt> --reason <words_joined_by_underscores>'

class Verdict { constructor(ok, reason, extra) { Object.assign(this, { ok, reason, extra }) } }
const finish = (ok, reason, extra = {}) => { throw new Verdict(ok, reason, extra) }
const refuse = (reason, extra) => finish(false, reason, extra)

export function lintActions({ argv, env }) {
  const [action, repoArg, target, ...rest] = argv
  const known = ['survey', 'remove-worktree', 'delete-branch', 'relabel']
  if (!known.includes(action) || !repoArg || (action !== 'survey' && !target) || (action !== 'relabel' && rest.length > 0) || (action === 'survey' && target)) {
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
  if (action === 'delete-branch' && PROTECTED.has(target)) refuse(`${target} is a protected branch`)
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
  const prCache = new Map()
  const prsFor = (branch) => {
    if (!prCache.has(branch)) {
      const list = gh(['pr', 'list', '--repo', id.full, '--head', branch, '--state', 'all', '--json', 'number,state,headRefOid'], `gh pr list --head ${branch}`)
      if (!Array.isArray(list)) refuse(`gh pr list --head ${branch} did not answer a list`)
      prCache.set(branch, list)
    }
    return prCache.get(branch)
  }
  // Ancestry is judged against the default branch GitHub names, read once, never a fixed main: a
  // second branch that happens to be called main proves nothing merged.
  let defaultName = null
  const defaultBranch = () => {
    defaultName ??= gh(['repo', 'view', id.full, '--json', 'defaultBranchRef'], 'gh repo view')?.defaultBranchRef?.name ?? null
    if (typeof defaultName !== 'string' || defaultName === '') refuse('gh repo view named no default branch, so nothing is judged against it')
    return defaultName
  }
  const inMain = (tip) => gitIn(repo, ['merge-base', '--is-ancestor', tip, `refs/remotes/origin/${defaultBranch()}`]) !== null

  // Recoverable: can origin reproduce this tip after the delete? An open pull request refuses outright.
  const recoverable = (branch, tip) => {
    const prs = prsFor(branch)
    const open = prs.find((p) => p.state === 'OPEN')
    if (open) refuse(`${branch} has an open pull request (#${open.number})`)
    const remoteTip = gitIn(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
    if (remoteTip === tip) return `origin/${branch} is at this tip`
    if (remoteTip !== null && gitIn(repo, ['rev-list', '--count', `refs/remotes/origin/${branch}..${tip}`]) === '0') return `no commits beyond origin/${branch}`
    const closed = prs.find((p) => (p.state === 'MERGED' || p.state === 'CLOSED') && p.headRefOid === tip)
    if (closed) return `pull request #${closed.number} (${closed.state}) has this tip as its head`
    if (inMain(tip)) return `the tip is in origin/${defaultBranch()}`
    return refuse('the tip is not reproducible from origin (no matching remote branch, pull request head or main ancestry)')
  }
  // Dead: recoverable is not a reason to delete; a pushed spike with no pull request is alive.
  const dead = (branch, tip) => {
    const closed = prsFor(branch).find((p) => p.state === 'MERGED' || p.state === 'CLOSED')
    if (closed) return `pull request #${closed.number} is ${closed.state}`
    if (inMain(tip)) return `the tip is already in origin/${defaultBranch()}`
    return refuse(`no merged or closed pull request and the tip is not in origin/${defaultBranch()}: recoverable, but not shown dead, so a human decides`)
  }
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
    const changed = lastChange(path)
    if (changed === null) refuse('the worktree\'s last change could not be read')
    if (Date.now() - changed < RECENT_MS) refuse(`the worktree changed ${Math.round((Date.now() - changed) / HOUR)}h ago, inside the four-day window`)
    const why = entry.branch ? recoverable(entry.branch, entry.head) : inMain(entry.head) ? `the detached tip is in origin/${defaultBranch()}` : refuse(`the detached tip is not in origin/${defaultBranch()}`)
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
    const why = `${dead(target, tip)}; ${recoverable(target, tip)}`
    // update-ref, unlike `git branch -D`, deletes a branch a worktree has checked out, so git's own
    // check is repeated here, after the reads above and straight before the delete.
    if (worktrees().some((e) => e.branch === target)) refuse('the branch was checked out in a worktree while it was being judged')
    // Compare-and-delete: git refuses if the branch moved off the tip every check above was about.
    if (gitIn(repo, ['update-ref', '-d', `refs/heads/${target}`, tip]) === null) refuse('the branch moved or could not be deleted')
    gitIn(repo, ['config', '--remove-section', `branch.${target}`])
    if (gitIn(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${target}`]) !== null) refuse('the delete was reported, but the branch still reads back')
    finish(true, `deleted at ${tip.slice(0, 12)} (${why})`)
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
