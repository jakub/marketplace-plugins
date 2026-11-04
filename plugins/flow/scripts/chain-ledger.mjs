#!/usr/bin/env node
// chain-ledger.mjs <host/owner/name> '<request>' [--confirmed N:<sha256>,...]
//
// Where each issue of a chain stands, read from GitHub and origin, so both hosts and both model
// families give one answer to "what can start, what can land, what needs the user". It only reads:
// no gh mutation, no fetch, no git write, no file. Nothing is stored either. The request is the one
// part of a chain GitHub can't give back, so it rides in every status message instead: stdout ends
// with `footer`, this command again in canonical form, --confirmed included when it was given, and
// a coordinator that lost its session re-runs the footer. A run with no --confirmed prints a footer
// with none, so a digest nobody confirmed never reads as confirmed; the coordinator builds
// --confirmed from the nodes' bodySha256 once the user says yes. A coordinator holding only the
// request runs without it and asks again before any dependent starts. A local record would buy
// little for its cost: a write under .git prompts for approval on Codex, and the claim tag already
// turns away a duplicate worker.
//
// The request. The canonical form is `issues: #A, #B; after: #A -> #C; land: #A`: numbers ascend,
// edges sort by parent then child, and `after:` and `land:` are left out when empty. The arrow form
// is segments split at `;` or a newline, each `#X -> #Y -> ...` (`→` or `->`), where a `land` token
// straight after an issue grants that issue its land: `#A → land → #C` is the edge A→C and a grant
// for A. An issue may repeat across segments, which is how a join is written. Both forms print back
// canonical, and chainId is the first 8 hex digits of its sha256, so one chain has one id however
// it was typed. An `owner/name#N` has to be origin's repository. A duplicate edge, issue or grant
// refuses duplicate, and so does a --confirmed naming one issue twice. Edges come only from the
// request: an issue body is editable and anyone can comment on a public repository, so a body that
// mentions another chain issue with no edge between them gets a warning and never an edge.
//
// The reads, every gh call pinned to origin's host and repository: `gh repo view` for the default
// branch, which has to be main because the claim cuts every run from origin/main; `gh api user`
// for the login; per issue, `gh issue view` with its comments and linked pull requests, both paged
// to the end by gh (2.103.3); per linked pull request in this repository, `gh pr view`; per merged
// candidate, the REST `compare/<mergeCommit>...main`; and one `git ls-remote origin` for the claim
// tags and run branches issue-claim.mjs makes, with no terminal prompt, no askpass helper and, unless GIT_SSH_COMMAND
// is already set, ssh in batch mode. Origin is read the claim's way, so one whose fetch and push
// URLs differ is unread here too. Origin, the default branch or the login unread is exit 4, because
// no state means anything without them.
//
// A candidate is a pull request linked to the issue, with its head in this repository, on the
// claim's `(feat|fix|chore)/issue-N-` branch, whose closingIssuesReferences hold the issue. A CLOSED
// one that never merged is ignored. One OPEN or MERGED candidate is the issue's, and two are
// unknown. Run marks are the claim tag, a run branch on origin, a candidate and `in-progress`.
//
// Admission and reconciliation. The grammar and repository refusals (usage, parse, cycle,
// self-edge, duplicate, unknown-issue, foreign-repo, not-main) hold on every run. The issue
// refusals hold only on a run without --confirmed, the preflight: there an issue with no run marks
// has to pass what the claim checks (open, ready-for-agent as its sole lifecycle label, an exact
// `## Acceptance Criteria` section, all through issue-claim.mjs's own exports so the two can't
// drift), and a parent closed with no run marks refuses dead-parent, since no child of it can
// start. A run with --confirmed is a chain the user already confirmed, and no issue refuses it: one
// that was parked or closed since gets a state, because a parked issue holds only its descendants
// and everything else keeps going. An issue with run marks gets a state on every run, which is what
// lets a chain resume over issues already running or landed. An issue whose reads failed is neither
// admitted nor refused: it reads unknown.
//
// The state, first match wins:
//   unknown         a read for this issue failed (the issue, origin's refs, a linked pull request,
//                   the compare), two candidates, or a merged candidate whose compare shows main
//                   without its merge commit. Nothing rounds it up.
//   landed          the candidate is MERGED, and the compare is ahead or identical with behind_by 0.
//   dead-parent     a parent at any depth is CLOSED with no merged candidate.
//   parked:closed   CLOSED with no run marks, which only a confirmed chain gets this far with.
//   parked:<label>  a lifecycle label other than ready-for-agent and in-progress, the first in the
//                   label contract's order. It outranks a clean line.
//   started-early   run marks while some parent hasn't landed.
//   clean           the newest comment by the login whose first line after the attribution block
//                   (`> [!NOTE]`, `> 🤖 …`, one blank line) is `babysit: clean #<pr> <40-hex head>`
//                   names the open candidate at its current head. Anyone can comment, so another
//                   login's line counts for nothing.
//   running         an open candidate, a run branch, or in-progress.
//   claiming        a claim tag and no branch.
//   waiting         some parent hasn't landed (reason waits-on), or the body digests differently
//                   from its --confirmed value (body-moved), which the claim would refuse anyway.
//   ready           none of the above, and the issue passes the claim's readiness and criteria
//                   checks. One that fails them here, which only a confirmed chain can reach,
//                   reads unknown with the claim's reason (not-ready, no-acceptance-criteria),
//                   never ready.
//
// Slots. claiming, running, clean, started-early and unknown each hold one, since a run nobody can
// see may still be live, and the rest hold none. ready issues get `next: launch` in ascending order
// while fewer than 4 slots are held, each launch taking one, and `queued` after that. The other
// `next` values: land (clean and granted, which the worker does), user-merge (clean, not granted),
// watch (running, claiming), wait (waiting), none (landed), user (parked, dead-parent,
// started-early, unknown). GitHub can't say which session merged a pull request, so a landed issue
// carries mergedBy and granted as two facts, read as "merged by <login>; land granted in this
// chain".
//
// stdout is one JSON line. `result` is ledger (exit 0, whatever the states, unknown among them),
// refused (exit 2: usage, parse, cycle, self-edge, duplicate, unknown-issue, foreign-repo or
// not-main on any run, and issue-closed, not-ready, blocked, no-acceptance-criteria or dead-parent
// only without --confirmed; a cycle is printed in `cycle`), or unknown (exit 4: origin-unreadable,
// default-branch-unreadable or login-unreadable).
// Nothing printed carries origin's credential.

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { execCapture, ghRunner, parseObject, runExecutor } from '../lib/gh-exec.mjs'
import { firstLine, makeRedactor } from '../lib/redact.mjs'
import { allowedHostsFrom, identityOfRemote } from '../lib/remote-identity.mjs'
import { LIFECYCLE, READY, acceptanceCriteria, bodyDigest, originUrl, readinessOf } from './issue-claim.mjs'

const SELF = fileURLToPath(import.meta.url)
const CAP = 4
const REMOTE_MS = 30_000
const EXIT = { ledger: 0, refused: 2, unknown: 4 }
const SHA = /^[0-9a-f]{40}$/
const REF = /^(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#([1-9][0-9]*)$/
const ARROW = /\s*(?:->|→)\s*/
const SECTION = /^([A-Za-z]+)\s*:(.*)$/s
const CLEAN = /^babysit: clean #([1-9][0-9]*) ([0-9a-f]{40})$/
const MENTION = /(?:^|[^\w&/#])#([1-9][0-9]*)\b/g
const IN_PROGRESS = 'in-progress'
const KINDS = ['feat', 'fix', 'chore']
const ACTIVE = new Set(['claiming', 'running', 'clean', 'started-early', 'unknown'])
const ISSUE_FIELDS = 'number,title,state,labels,body,url,comments,closedByPullRequestsReferences'
const PR_FIELDS = 'number,state,headRefName,headRefOid,isCrossRepository,mergeCommit,mergedBy,closingIssuesReferences'
const BATCH_SSH = 'ssh -o BatchMode=yes -o ConnectTimeout=10'
const USAGE = "usage: chain-ledger.mjs <host/owner/name> '<request>' [--confirmed N:<sha256>,...]\n"

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const byNumber = (a, b) => a - b
const tag = (n) => `#${n}`
const labelNames = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : String(l?.name ?? ''))).filter(Boolean)
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const quote = (word) => (/^[A-Za-z0-9_/.:,=@+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)
const clip = (text) => JSON.stringify(String(text).slice(0, 80))

/**
 * The request in canonical form, or { refusal }. Returns { canonical, chainId, issues, edges,
 * land, qualified }, where qualified lists every owner/name#N for the caller to hold to origin.
 */
export function parseRequest(text) {
  const refuse = (reason, detail, extra = {}) => ({ refusal: { reason, detail, ...extra } })
  const segments = String(text ?? '').split(/[;\n]/).map((s) => s.trim()).filter((s) => s !== '')
  if (segments.length === 0) return refuse('parse', 'the request names no issue')
  const qualified = []
  const ref = (token) => {
    const m = token.match(REF)
    if (m === null) return null
    if (m[1] !== undefined) qualified.push({ owner: m[1], repo: m[2], token })
    return Number(m[3])
  }
  const nodes = new Set()
  const edges = []
  const edgeKeys = new Set()
  const land = new Set()
  /** null when the edge is new, else the refusal. */
  const addEdge = (parent, child) => {
    if (parent === child) return refuse('self-edge', `${tag(parent)} -> ${tag(child)} makes an issue wait on itself`)
    const key = `${parent}>${child}`
    if (edgeKeys.has(key)) return refuse('duplicate', `the edge ${tag(parent)} -> ${tag(child)} is written twice`)
    edgeKeys.add(key)
    edges.push([parent, child])
    return null
  }

  const keyed = segments.filter((s) => SECTION.test(s))
  if (keyed.length > 0 && keyed.length < segments.length) {
    return refuse('parse', 'the request mixes the canonical form (issues:, after:, land:) with arrow segments; write it one way')
  }
  if (keyed.length > 0) {
    const sections = new Map()
    for (const segment of segments) {
      const [, name, rest] = segment.match(SECTION)
      if (!['issues', 'after', 'land'].includes(name)) return refuse('parse', `${clip(`${name}:`)} is not a section; the sections are issues:, after: and land:`)
      if (sections.has(name)) return refuse('parse', `${name}: is given twice`)
      sections.set(name, rest.trim())
    }
    const items = (name) => (sections.get(name) ?? '') === '' ? [] : sections.get(name).split(',').map((s) => s.trim())
    if (items('issues').length === 0) return refuse('parse', 'the canonical form needs an issues: section that names at least one issue')
    for (const item of items('issues')) {
      const n = ref(item)
      if (n === null) return refuse('parse', `${clip(item)} in issues: is not an issue reference like #12`)
      if (nodes.has(n)) return refuse('duplicate', `${tag(n)} is in issues: twice`)
      nodes.add(n)
    }
    for (const item of items('after')) {
      const ends = item.split(ARROW)
      const [parent, child] = ends.map(ref)
      if (ends.length !== 2 || parent == null || child == null) return refuse('parse', `${clip(item)} in after: is not one edge like #1 -> #2`)
      const wrong = addEdge(parent, child)
      if (wrong !== null) return wrong
    }
    for (const item of items('land')) {
      const n = ref(item)
      if (n === null) return refuse('parse', `${clip(item)} in land: is not an issue reference like #12`)
      if (land.has(n)) return refuse('duplicate', `${tag(n)} is in land: twice`)
      land.add(n)
    }
    const outside = [...edges.flat(), ...land].find((n) => !nodes.has(n))
    if (outside !== undefined) return refuse('unknown-issue', `${tag(outside)} is in after: or land: and not in issues:`)
  } else {
    for (const segment of segments) {
      let last = null
      let granted = false
      for (const piece of segment.split(ARROW)) {
        if (piece === 'land') {
          if (last === null) return refuse('parse', `${clip(segment)} opens with land; land follows the issue it grants`)
          if (granted) return refuse('parse', `${clip(segment)} says land twice in a row`)
          if (land.has(last)) return refuse('duplicate', `${tag(last)} is granted its land twice`)
          land.add(last)
          granted = true
          continue
        }
        const n = ref(piece)
        if (n === null) return refuse('parse', `${clip(piece)} is neither an issue reference like #12 nor land`)
        nodes.add(n)
        if (last !== null) {
          const wrong = addEdge(last, n)
          if (wrong !== null) return wrong
        }
        last = n
        granted = false
      }
    }
  }

  const issues = [...nodes].sort(byNumber)
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const children = new Map(issues.map((n) => [n, edges.filter(([p]) => p === n).map(([, c]) => c)]))
  // Depth-first from each issue in ascending order; a child still on the stack closes a cycle,
  // which prints from its lowest issue so one cycle always reads the same.
  const color = new Map()
  const stack = []
  const visit = (n) => {
    color.set(n, 'open')
    stack.push(n)
    for (const c of children.get(n)) {
      if (color.get(c) === 'open') return stack.slice(stack.indexOf(c))
      if (!color.has(c)) {
        const found = visit(c)
        if (found !== null) return found
      }
    }
    stack.pop()
    color.set(n, 'done')
    return null
  }
  for (const n of issues) {
    const loop = color.has(n) ? null : visit(n)
    if (loop !== null) {
      const at = loop.indexOf(Math.min(...loop))
      const cycle = [...loop.slice(at), ...loop.slice(0, at), loop[at]].map(tag).join(' -> ')
      return refuse('cycle', `the edges close a cycle, ${cycle}, so none of those issues could ever start`, { cycle })
    }
  }

  const parts = [`issues: ${issues.map(tag).join(', ')}`]
  if (edges.length > 0) parts.push(`after: ${edges.map(([p, c]) => `${tag(p)} -> ${tag(c)}`).join(', ')}`)
  if (land.size > 0) parts.push(`land: ${[...land].sort(byNumber).map(tag).join(', ')}`)
  const canonical = parts.join('; ')
  return { canonical, chainId: sha256(canonical).slice(0, 8), issues, edges, land, qualified }
}

/** The babysit clean line a comment opens with after the attribution block, or null. */
const cleanLineOf = (body) => {
  const lines = String(body ?? '').split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (lines[0] !== '> [!NOTE]' || !String(lines[1] ?? '').startsWith('> 🤖 ') || lines[2] !== '') return null
  const m = String(lines[3] ?? '').match(CLEAN)
  return m === null ? null : { pr: Number(m[1]), head: m[2] }
}

/** issue -> { tag, branches } from ls-remote's lines; only the exact shapes the claim makes count. */
const runRefs = (stdout) => {
  const found = new Map()
  const at = (n) => found.get(n) ?? found.set(n, { tag: false, branches: 0 }).get(n)
  for (const line of String(stdout).split('\n')) {
    const [sha, name] = line.split('\t')
    if (!SHA.test(sha ?? '')) continue
    const claim = String(name).match(/^refs\/tags\/flow-claim-issue-([1-9][0-9]*)$/)
    if (claim !== null) at(Number(claim[1])).tag = true
    const branch = String(name).match(/^refs\/heads\/(?:feat|fix|chore)\/issue-([1-9][0-9]*)-/)
    if (branch !== null) at(Number(branch[1])).branches += 1
  }
  return found
}

/**
 * Read and judge. Returns { code, stdout, stderr } rather than exiting, so a smoke can drive it in
 * process. `runGh(args, { cwd })` is injected; `env` is the environment git runs in and the one
 * FLOW_GH_HOSTS is read from.
 */
export function chainLedger({ argv, cwd, env = process.env, runGh }) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { code: 0, stdout: USAGE, stderr: '' }
  const emit = (payload, human) => ({ code: EXIT[payload.result], stdout: `${JSON.stringify(payload)}\n`, stderr: human ? `chain-ledger: ${human}\n` : '' })
  const refuse = (reason, detail, extra = {}) => emit({ result: 'refused', reason, detail, ...extra }, `${detail}. Nothing was launched.`)
  const usage = (detail) => emit({ result: 'refused', reason: 'usage', detail }, `${detail}.\n\n${USAGE}`)
  const unread = (reason, detail) => emit({ result: 'unknown', reason, detail }, detail)

  // ---- the arguments, the request and the digests: nothing is read until all three hold.
  const positional = []
  let confirmedArg = null
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--confirmed') { positional.push(argv[i]); continue }
    if (confirmedArg !== null) return usage('--confirmed is given at most once')
    if (i + 1 >= argv.length || argv[i + 1] === '') return usage('--confirmed takes N:<sha256>,... with one entry per issue')
    confirmedArg = argv[(i += 1)]
  }
  if (positional.length !== 2) return usage(positional.length < 2 ? 'expected the repository and the request' : `${clip(positional[2])} is an extra argument`)
  if (typeof runGh !== 'function') return usage('the ledger was called with no gh runner')
  const [repoArg, requestArg] = positional
  if (!/^[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(repoArg)) return usage(`${clip(repoArg)} is not a repository as host/owner/name`)
  const confirmedPairs = []
  if (confirmedArg !== null) {
    for (const item of confirmedArg.split(',')) {
      const m = item.trim().match(/^([1-9][0-9]*):([0-9a-f]{64})$/)
      if (m === null) return usage(`--confirmed entry ${clip(item)} is not N:<sha256 as 64 lowercase hex>`)
      confirmedPairs.push([Number(m[1]), m[2]])
    }
  }
  const parsed = parseRequest(requestArg)
  if (parsed.refusal !== undefined) {
    const { reason, detail, ...extra } = parsed.refusal
    return refuse(reason, detail, extra)
  }
  const confirmed = new Map()
  for (const [n, digest] of confirmedPairs) {
    if (confirmed.has(n)) return refuse('duplicate', `--confirmed names ${tag(n)} twice`)
    if (!parsed.issues.includes(n)) return refuse('unknown-issue', `--confirmed names ${tag(n)}, which is not in the chain`)
    confirmed.set(n, digest)
  }

  // ---- origin, the default branch and the login. Without any of them no state means anything.
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || BATCH_SSH }
  const origin = originUrl(cwd, gitEnv)
  if (origin.url === undefined) return unread('origin-unreadable', origin.detail)
  const pinned = identityOfRemote(origin.url, { purpose: 'read a chain on', allowedHosts: allowedHostsFrom(env) })
  if (pinned.identity === undefined) return unread('origin-unreadable', pinned.refusal)
  const id = pinned.identity
  if (!sameName(repoArg, id.full)) return refuse('foreign-repo', `the chain names ${repoArg}, and this checkout's origin is ${id.full}`)
  const foreign = parsed.qualified.find((q) => !sameName(`${q.owner}/${q.repo}`, id.slug))
  if (foreign !== undefined) return refuse('foreign-repo', `${foreign.token} is not an issue of ${id.full}, and a chain runs in one repository`)

  const redact = makeRedactor([origin.url], id.full)
  const said = (r) => firstLine(redact(r.stderr || r.stdout)) || `exit ${r.code}`
  const gh = (args) => runGh(args, { cwd })
  const repoView = gh(['repo', 'view', id.full, '--json', 'defaultBranchRef'])
  const defaultBranch = (repoView.code === 0 ? parseObject(repoView.stdout) : null)?.defaultBranchRef?.name
  if (typeof defaultBranch !== 'string' || defaultBranch === '') {
    return unread('default-branch-unreadable', `the default branch of ${id.full} could not be read (${repoView.code === 0 ? 'no defaultBranchRef' : said(repoView)})`)
  }
  if (defaultBranch !== 'main') return refuse('not-main', `the default branch of ${id.full} is ${clip(defaultBranch)}, and the claim cuts every run from main`)
  const me = gh(['api', '--hostname', id.host, 'user', '--jq', '.login'])
  const login = me.code === 0 ? me.stdout.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(login)) return unread('login-unreadable', `the login gh holds for ${id.host} could not be read (${me.code === 0 ? 'no login' : said(me)})`)

  // ---- origin's claim tags and run branches, in one read.
  const listed = execCapture('git', ['-C', cwd, 'ls-remote', 'origin', 'refs/tags/flow-claim-issue-*', ...KINDS.map((k) => `refs/heads/${k}/issue-*`)], { timeoutMs: REMOTE_MS, env: gitEnv })
  const refs = listed.code === 0 ? runRefs(listed.stdout) : null
  const refsProblem = `git ls-remote origin failed: ${said(listed)}`

  // ---- each issue: what GitHub says about it, its candidate, and whether that candidate is on main.
  const facts = new Map()
  const readIssue = (n) => {
    const fact = { n, raw: null, labels: [], unknown: null, detail: null, candidate: null, contained: false, clean: false }
    const fail = (reason, detail) => Object.assign(fact, { unknown: reason, detail })
    const r = gh(['issue', 'view', String(n), '--repo', id.full, '--json', ISSUE_FIELDS])
    const v = r.code === 0 ? parseObject(r.stdout) : null
    if (v === null) return fail('issue-unreadable', r.code === 0 ? `gh issue view ${n} printed no JSON object` : `gh issue view ${n} failed: ${said(r)}`)
    const path = (() => { try { return new URL(String(v.url)).pathname.split('/').filter(Boolean) } catch { return [] } })()
    if (v.number !== n || path.length !== 4 || !sameName(path[0], id.owner) || !sameName(path[1], id.repo) || path[2] !== 'issues' || path[3] !== String(n)) {
      return fail('issue-unreadable', `gh issue view ${n} answered for ${JSON.stringify(v.url ?? null)}, which is not ${tag(n)} of ${id.full}`)
    }
    if (!Array.isArray(v.comments) || !Array.isArray(v.closedByPullRequestsReferences)) return fail('issue-unreadable', `gh issue view ${n} gave no comment list or no linked pull request list`)
    Object.assign(fact, { raw: v, labels: labelNames(v.labels) })
    if (refs === null) return fail('refs-unreadable', refsProblem)

    const forIssue = new RegExp(`^(feat|fix|chore)/issue-${n}-`)
    const linked = [...new Set(v.closedByPullRequestsReferences
      .filter((l) => l?.repository == null || (sameName(l.repository.owner?.login, id.owner) && sameName(l.repository.name, id.repo)))
      .map((l) => l?.number).filter((p) => Number.isSafeInteger(p) && p > 0))].sort(byNumber)
    const candidates = []
    for (const p of linked) {
      const pr = gh(['pr', 'view', String(p), '--repo', id.full, '--json', PR_FIELDS])
      const pv = pr.code === 0 ? parseObject(pr.stdout) : null
      if (pv === null) return fail('pr-unreadable', pr.code === 0 ? `gh pr view ${p} printed no JSON object` : `gh pr view ${p} failed: ${said(pr)}`)
      const state = String(pv.state ?? '')
      if (pv.number !== p || typeof pv.isCrossRepository !== 'boolean' || typeof pv.headRefName !== 'string' ||
          !['OPEN', 'CLOSED', 'MERGED'].includes(state) || !Array.isArray(pv.closingIssuesReferences)) {
        return fail('pr-unreadable', `gh pr view ${p} did not read back as a pull request with a state, a head branch, a fork flag and closing references`)
      }
      const closes = pv.closingIssuesReferences.some((c) => c?.number === n &&
        sameName(c?.repository?.owner?.login, id.owner) && sameName(c?.repository?.name, id.repo))
      if (pv.isCrossRepository || !forIssue.test(pv.headRefName) || !closes || state === 'CLOSED') continue
      candidates.push(pv)
    }
    if (candidates.length > 1) return fail('candidates-ambiguous', `${candidates.map((c) => tag(c.number)).join(' and ')} are both ${tag(n)}'s pull request on a claim branch`)
    const pv = candidates[0] ?? null
    fact.candidate = pv
    if (pv === null) return fact
    if (!SHA.test(String(pv.headRefOid ?? ''))) return fail('pr-unreadable', `the head of ${tag(pv.number)} did not read as a full SHA`)
    if (pv.state === 'MERGED') {
      const merge = String(pv.mergeCommit?.oid ?? '')
      if (!SHA.test(merge)) return fail('pr-unreadable', `${tag(pv.number)} is MERGED with no readable merge commit`)
      const cmp = gh(['api', '--hostname', id.host, `repos/${id.owner}/${id.repo}/compare/${merge}...main`])
      const c = cmp.code === 0 ? parseObject(cmp.stdout) : null
      if (c === null || typeof c.status !== 'string' || !Number.isSafeInteger(c.behind_by) || c.behind_by < 0) {
        return fail('compare-unreadable', `the compare of ${merge.slice(0, 12)}...main ${cmp.code === 0 ? 'gave no status or behind_by' : `failed: ${said(cmp)}`}`)
      }
      if (c.behind_by !== 0 || !['ahead', 'identical'].includes(c.status)) {
        return fail('merged-off-main', `${tag(pv.number)} is MERGED, and main does not contain its merge commit ${merge.slice(0, 12)} (${c.status}, behind_by ${c.behind_by})`)
      }
      fact.contained = true
      return fact
    }
    const lines = v.comments.map((c, i) => ({ i, at: String(c?.createdAt ?? ''), login: c?.author?.login, line: cleanLineOf(c?.body) }))
      .filter((c) => c.login === login && c.line !== null)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.i - b.i))
    const newest = lines.at(-1)?.line
    fact.clean = newest !== undefined && newest.pr === pv.number && newest.head === pv.headRefOid
    return fact
  }
  for (const n of parsed.issues) facts.set(n, readIssue(n))

  const parentsOf = new Map(parsed.issues.map((n) => [n, parsed.edges.filter(([, c]) => c === n).map(([p]) => p)]))
  const childrenOf = new Map(parsed.issues.map((n) => [n, parsed.edges.filter(([p]) => p === n).map(([, c]) => c)]))
  for (const fact of facts.values()) {
    const marks = fact.unknown === null && (fact.candidate !== null || fact.labels.includes(IN_PROGRESS) || refs.get(fact.n) !== undefined)
    const open = String(fact.raw?.state ?? '').toUpperCase() === 'OPEN'
    Object.assign(fact, {
      marks,
      landed: fact.unknown === null && fact.contained,
      dead: fact.unknown === null && !open && fact.candidate?.state !== 'MERGED',
    })
  }

  // ---- admission, on the preflight only: an issue with no run marks is held to what the claim
  // checks, in ascending order. A confirmed chain never refuses here, so one issue the user parked
  // can't take the others' status down with it.
  for (const n of confirmedArg === null ? parsed.issues : []) {
    const fact = facts.get(n)
    if (fact.unknown !== null || fact.marks) continue
    if (fact.dead && childrenOf.get(n).length > 0) {
      return refuse('dead-parent', `${tag(n)} is closed with no merged pull request and no run, so ${childrenOf.get(n).map(tag).join(', ')} could never start`)
    }
    const wrong = readinessOf(n, fact.raw)
    if (wrong !== null) return refuse(wrong.reason, wrong.detail)
    if (acceptanceCriteria(fact.raw.body) === null) return refuse('no-acceptance-criteria', `issue #${n} has no "## Acceptance Criteria" line with anything under it`)
  }

  // ---- reconciliation: one state per issue, first match wins.
  const deadAbove = (n, seen = new Set()) => parentsOf.get(n).some((p) => {
    if (seen.has(p)) return false
    seen.add(p)
    return facts.get(p).dead || deadAbove(p, seen)
  })
  /** issue -> why it reads unknown, for the warnings. */
  const why = new Map()
  const nodes = parsed.issues.map((n) => {
    const fact = facts.get(n)
    const parents = parentsOf.get(n)
    const waitsOn = fact.landed ? [] : parents.filter((p) => !facts.get(p).landed)
    const body = fact.raw === null ? null : bodyDigest(fact.raw.body)
    const parked = LIFECYCLE.find((l) => l !== READY && l !== IN_PROGRESS && fact.labels.includes(l))
    const ref = refs?.get(n)
    let state = 'ready'
    let reason = null
    if (fact.unknown !== null) { state = 'unknown'; reason = fact.unknown; why.set(n, fact.detail) }
    else if (fact.landed) state = 'landed'
    else if (deadAbove(n)) state = 'dead-parent'
    else if (fact.dead && !fact.marks) state = 'parked:closed'
    else if (parked !== undefined) state = `parked:${parked}`
    else if (fact.marks && waitsOn.length > 0) state = 'started-early'
    else if (fact.clean) state = 'clean'
    else if (fact.candidate?.state === 'OPEN' || (ref?.branches ?? 0) > 0 || fact.labels.includes(IN_PROGRESS)) state = 'running'
    else if (ref?.tag) state = 'claiming'
    else if (waitsOn.length > 0) { state = 'waiting'; reason = 'waits-on' }
    else if (confirmed.has(n) && confirmed.get(n) !== body) { state = 'waiting'; reason = 'body-moved' }
    else {
      // Only a confirmed chain gets here unadmitted. What the claim would refuse is never ready.
      const wrong = readinessOf(n, fact.raw) ?? (acceptanceCriteria(fact.raw.body) === null
        ? { reason: 'no-acceptance-criteria', detail: `issue #${n} has no "## Acceptance Criteria" line with anything under it` } : null)
      if (wrong !== null) { state = 'unknown'; reason = wrong.reason; why.set(n, wrong.detail) }
    }
    const pv = fact.candidate
    return {
      issue: n, title: typeof fact.raw?.title === 'string' ? fact.raw.title : null, state, reason,
      pr: pv?.number ?? null, head: SHA.test(String(pv?.headRefOid ?? '')) ? pv.headRefOid : null,
      mergeCommit: SHA.test(String(pv?.mergeCommit?.oid ?? '')) ? pv.mergeCommit.oid : null,
      mergedBy: typeof pv?.mergedBy?.login === 'string' ? pv.mergedBy.login : null,
      granted: parsed.land.has(n), parents, waitsOn, bodySha256: body, next: null,
    }
  })

  // ---- next, with the slots: every active node holds one, and each launch takes one.
  const NEXT = { landed: 'none', running: 'watch', claiming: 'watch', waiting: 'wait', 'dead-parent': 'user', 'started-early': 'user', unknown: 'user' }
  const active = nodes.filter((x) => ACTIVE.has(x.state)).length
  let held = active
  for (const x of nodes) {
    if (x.state === 'ready') x.next = held < CAP ? 'launch' : 'queued'
    else if (x.state === 'clean') x.next = x.granted ? 'land' : 'user-merge'
    else x.next = NEXT[x.state] ?? 'user'
    if (x.next === 'launch') held += 1
  }

  // ---- warnings: why an issue is unknown, a body naming a chain issue it has no edge with, and an
  // issue --confirmed left out.
  const linkedPair = (a, b) => parsed.edges.some(([p, c]) => (p === a && c === b) || (p === b && c === a))
  const warnings = []
  for (const n of parsed.issues) {
    const fact = facts.get(n)
    if (why.has(n)) warnings.push(`${tag(n)} is unknown: ${why.get(n)}`)
    if (fact.raw !== null) {
      const named = new Set([...String(fact.raw.body ?? '').matchAll(MENTION)].map((m) => Number(m[1])))
      for (const m of [...named].sort(byNumber)) {
        if (m !== n && parsed.issues.includes(m) && !linkedPair(n, m)) {
          warnings.push(`${tag(n)}'s body mentions ${tag(m)}, and the request has no edge between them; edges come only from the request`)
        }
      }
    }
  }
  if (confirmedArg !== null) for (const n of parsed.issues) if (!confirmed.has(n)) warnings.push(`--confirmed has no digest for ${tag(n)}`)

  const list = [...confirmed].sort((a, b) => a[0] - b[0]).map(([n, d]) => `${n}:${d}`).join(',')
  const footer = ['node', SELF, id.full, parsed.canonical, ...(confirmedArg === null ? [] : ['--confirmed', list])].map(quote).join(' ')

  return emit({
    result: 'ledger', repo: id.full, request: parsed.canonical, chainId: parsed.chainId, login, defaultBranch,
    cap: CAP, active, nodes, warnings, footer,
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runExecutor(chainLedger({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, runGh: ghRunner(process.env) }))
}
