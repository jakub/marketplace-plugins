#!/usr/bin/env node
// land-gates.mjs [--accept-flake <check>:<test>]... [<pr>]
//
// The land's read-only verdict: every fact the land gates inspect, re-derived from GitHub and
// printed as one JSON object in a closed vocabulary. It mutates nothing, in the repository or the
// clone; its only git reads are origin's URL and, with no argument, the checked-out branch.
//
// Stops mean the pull request does not merge now: not-open, draft, head-unreadable,
// stacked-on-non-default, ci-pending, ci-failed, ci-unknown, threads-unresolved,
// threads-unreadable, auto-merge-armed, merge-queue. Attention needs an action or a decision and
// is not a refusal: children, flakes-added-on-pr, flaky-merged-through, linked-issues-ambiguous,
// follow-up-draft. A read that failed sets `error` and exits 4 whatever else was found, because
// "could not read the threads" and "no unresolved threads" must never share an exit code.
// Exit 0 pass, 1 stop, 2 usage or refusal, 4 unknown.
//
// Every list is read to the end, because a gate that reads the first page fails green: check
// runs, commit statuses and top-level comments over `gh api --paginate --slurp` (`gh pr view`
// pages none of them past 100), review threads over paged GraphQL. The check runs collected must
// number exactly the total_count GitHub reported. A check with no name is unknown however green it
// looks, and no checks at all is unknown too, which is what a pull request looks like in the
// seconds after a push. A check run is pending until its status is completed; a commit status
// (CodeRabbit's kind) has only `state`, and only the newest status per context counts.
//
// Known flakes are the base ref's .github/known-flakes.txt, read over the contents API and never
// from the pull request, so a branch cannot approve its own failures; a line the branch added is
// attention. A line equal to a reported check name excuses that check. Any other line splits after
// the longest reported check name it starts with (a status context like `ci/circleci: build` has
// a colon of its own) into check:test, which excuses nothing unless --accept-flake names it: that
// flag is the caller's statement that the job log shows the test was the check's only failure.
//
// Linked issues come back three ways and nothing is decided: linked (GitHub parsed), recovered
// (the issue in a feat|fix|chore/issue-N- branch, or a closing phrase neither negated in its
// sentence nor inside code), and mentions (every other bare #N).
//
// With no argument, the pull request gh resolves from the current branch is the one read that
// cannot pin --repo, so it must prove itself: its url names origin's repository and its head is
// the checked-out branch, or it is refused and the number can be passed. The head SHA printed is
// the one land-merge takes.

import { fileURLToPath } from 'node:url'

import { execCapture, ghRunner, parseJson, parseObject, runExecutor } from '../lib/gh-exec.mjs'
import { firstLine, makeRedactor, scrubUserinfo } from '../lib/redact.mjs'
import { allowedHostsFrom, identityOfRemote, prUrlMismatch } from '../lib/remote-identity.mjs'

const EXIT_PASS = 0
const EXIT_STOP = 1
const EXIT_USAGE = 2
const EXIT_UNKNOWN = 4
const MAX_THREAD_PAGES = 20
const SHA = /^[0-9a-f]{40}$/
const FLAKES_PATH = '.github/known-flakes.txt'
const HTTP_404 = /\(HTTP 404\)|\bNot Found\b/
const PR_FIELDS = 'number,title,body,state,headRefName,headRefOid,baseRefName,url,isDraft,isCrossRepository,autoMergeRequest,closingIssuesReferences'

// REST serves conclusions lowercase; anything outside both sets (stale among them) is unknown.
const RUN_SUCCESS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const RUN_FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'])
const STATUS_BUCKET = { SUCCESS: 'success', PENDING: 'pending', FAILURE: 'failed', ERROR: 'failed' }

const BRANCH_ISSUE = /^(feat|fix|chore)\/issue-(\d+)-/
const CLOSING_PHRASE = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi
const CODE_SPAN = /```[\s\S]*?```|`[^`\n]*`/g
const NEGATION = /\b(?:not|never|no longer|without)\b|n['\u2019]t\b/i
const SENTENCE_END = /[.!?\n]/
const BARE_ISSUE = /(^|[^\w#])#(\d+)\b/g
const FOLLOW_UP_DRAFT = /^##\s*follow-up draft/im

const USAGE = `usage: land-gates.mjs [--accept-flake <check-name>:<test_name>]... [<pull-request-number>]

Prints one JSON verdict for the pull request (resolved from the current branch when no number is
given) and exits 0 pass, 1 stop, 2 usage or refusal, 4 unknown. Origin must name github.com or a
host in FLOW_GH_HOSTS, with no port. --accept-flake takes a check-name:test_name entry from the
base branch's ${FLAKES_PATH}, for a check that is failing once, and is the caller's statement that
its job log shows that test as the only failure.
`

const THREADS_QUERY = `query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id isResolved isOutdated comments(last: 20) { nodes { author { login } body path url } } }
  } } }
}`
// A second query, so a host whose schema lacks the merge-queue fields cannot cost the thread read.
const QUEUE_QUERY = `query($owner: String!, $repo: String!, $pr: Int!, $base: String!) {
  repository(owner: $owner, name: $repo) { mergeQueue(branch: $base) { id } pullRequest(number: $pr) { isInMergeQueue } }
}`

const nonEmpty = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const upper = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '')
const truncate = (text, limit) => { const s = String(text ?? ''); return s.length <= limit ? s : `${s.slice(0, limit)}...` }

const bucketOf = (entry) => {
  if (entry.kind === 'status') return STATUS_BUCKET[upper(entry.state)] ?? 'unknown'
  if (upper(entry.status) !== 'COMPLETED') return 'pending'
  const token = upper(entry.conclusion)
  return RUN_SUCCESS.has(token) ? 'success' : RUN_FAILED.has(token) ? 'failed' : 'unknown'
}

/** check:test split after the longest reported check name the line starts with, else its first colon. */
const splitEntry = (line, names) => {
  let matched = null
  for (const name of names) if (line.startsWith(`${name}:`) && (matched === null || name.length > matched.length)) matched = name
  const colon = matched === null ? line.indexOf(':') : matched.length
  if (colon < 0) return null
  const check = line.slice(0, colon).trim()
  const test = line.slice(colon + 1).trim()
  return check === '' || test === '' ? null : { check, test }
}

const parseFlakes = (text, names) => {
  const bare = new Set()
  const tests = new Map()
  const lines = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    lines.push(line)
    if (names.has(line)) { bare.add(line); continue }
    const split = splitEntry(line, names)
    // No colon: a check that is not running today. A colon that splits into nothing: dropped.
    if (split === null) { if (!line.includes(':')) bare.add(line); continue }
    if (!tests.has(split.check)) tests.set(split.check, [])
    tests.get(split.check).push(split.test)
  }
  return { bare, tests, lines }
}

const readLinkedIssues = ({ closing, headRef, title, body }) => {
  const linked = []
  for (const ref of Array.isArray(closing) ? closing : []) {
    const n = Number(ref?.number)
    if (Number.isInteger(n) && n > 0 && !linked.includes(n)) linked.push(n)
  }
  const recovered = []
  const add = (n) => { if (Number.isInteger(n) && n > 0 && !linked.includes(n) && !recovered.includes(n)) recovered.push(n) }
  const branchMatch = String(headRef ?? '').match(BRANCH_ISSUE)
  if (branchMatch !== null) add(Number(branchMatch[2]))
  const text = `${String(title ?? '')}\n${String(body ?? '')}`
  // Code is blanked, not removed, so every index still points into the original text.
  const prose = text.replace(CODE_SPAN, (span) => span.replace(/[^\n]/g, ' '))
  const claimed = []
  for (const match of prose.matchAll(CLOSING_PHRASE)) {
    let from = 0
    for (let i = match.index - 1; i >= 0; i -= 1) if (SENTENCE_END.test(prose[i])) { from = i + 1; break }
    if (NEGATION.test(prose.slice(from, match.index))) continue
    add(Number(match[2]))
    claimed.push([match.index, match.index + match[0].length])
  }
  const mentions = []
  for (const match of text.matchAll(BARE_ISSUE)) {
    const at = match.index + match[1].length
    const n = Number(match[2])
    if (claimed.some(([from, to]) => at >= from && at < to)) continue
    if (n > 0 && !linked.includes(n) && !recovered.includes(n) && !mentions.includes(n)) mentions.push(n)
  }
  return { linked, recovered, mentions }
}

/**
 * Gather and judge. Returns { code, stdout, stderr } rather than exiting. `runGh(args)` is
 * injected; `env` is read for FLOW_GH_HOSTS. No FLOW_CRON_JOB refusal: reading changes nothing.
 */
export function landGates({ argv, env, cwd, runGh }) {
  const refuse = (reason) => ({ code: EXIT_USAGE, stdout: '', stderr: `land-gates: ${reason}\n` })
  if (argv.some((arg) => arg === '--help' || arg === '-h')) return { code: EXIT_PASS, stdout: USAGE, stderr: '' }
  const acceptFlakes = []
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i])
    if (arg === '--accept-flake' || arg.startsWith('--accept-flake=')) {
      const value = (arg === '--accept-flake' ? String(argv[++i] ?? '') : arg.slice('--accept-flake='.length)).trim()
      if (value === '') return refuse(`--accept-flake takes one check-name:test_name entry.\n\n${USAGE}`)
      if (!acceptFlakes.includes(value)) acceptFlakes.push(value)
    } else positional.push(arg)
  }
  if (positional.length > 1) return refuse(`expected at most one argument, the pull request number.\n\n${USAGE}`)
  const git = (args) => { const r = execCapture('git', ['-C', cwd, ...args], { timeoutMs: 5_000 }); return r.code === 0 ? r.stdout.trim() : '' }

  const originUrl = git(['remote', 'get-url', 'origin'])
  const remote = identityOfRemote(originUrl, { purpose: 'gate', allowedHosts: allowedHostsFrom(env) })
  if (remote.identity === undefined) return refuse(remote.refusal)
  const id = remote.identity
  const redact = makeRedactor(originUrl, id.full)
  const failures = []
  const said = (r) => redact(firstLine(r.stderr)) || `exit ${r.code}`
  const ghJson = (args, what) => {
    const r = runGh(args)
    const value = r.code === 0 ? parseJson(r.stdout) : null
    if (value === null && what !== null) failures.push(`${what}${r.code === 0 ? ' gave no readable JSON' : `: ${said(r)}`}`)
    return value
  }

  // ---- 1. the number
  let pr
  if (positional.length === 1) {
    if (!/^[0-9]+$/.test(positional[0]) || Number(positional[0]) <= 0) return refuse(`${JSON.stringify(positional[0])} is not a pull request number.\n\n${USAGE}`)
    pr = Number(positional[0])
  } else {
    const current = ghJson(['pr', 'view', '--json', 'number,url,headRefName'], null)
    const n = Number(current?.number)
    if (!Number.isInteger(n) || n <= 0) return refuse(`no pull request number was given and none resolves from the current branch of ${cwd}.\n\n${USAGE}`)
    const mismatch = prUrlMismatch(nonEmpty(current.url), id, n)
    if (mismatch !== null) {
      const where = mismatch.code === 'elsewhere' ? `belongs to ${mismatch.host}/${mismatch.owner}/${mismatch.repo}` : 'reported no url naming it'
      return refuse(redact(`gh resolved #${n} from the current branch and it ${where}, not ${id.full}, the repository origin names (a fork checkout with an upstream remote looks like this); pass the number explicitly`))
    }
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch === '' || branch === 'HEAD' || nonEmpty(current.headRefName) !== branch) {
      return refuse(redact(`gh resolved #${n} with head branch ${nonEmpty(current.headRefName) ?? 'unreadable'}, which is not the branch checked out in ${cwd} (${branch || 'none'}); pass the number explicitly`))
    }
    pr = n
  }

  // ---- 2. the pull request
  const view = ghJson(['pr', 'view', String(pr), '--repo', id.full, '--json', PR_FIELDS], `gh pr view ${pr}`)
  if (view === null || typeof view !== 'object') return { code: EXIT_UNKNOWN, stdout: '', stderr: `land-gates: ${failures[0] ?? 'gh pr view gave no object'}, so nothing about #${pr} could be gated\n` }
  const stops = []
  const attention = []
  const stop = (code, detail) => stops.push({ code, detail })
  const attend = (code, detail) => attention.push({ code, detail })
  const state = nonEmpty(view.state)
  if (state !== 'OPEN') stop('not-open', `#${pr} is ${state ?? 'in an unreadable state'}, and only an open pull request lands`)
  if (view.isDraft !== false) stop('draft', view.isDraft === true ? `#${pr} is a draft` : `the draft status of #${pr} did not read back as a boolean`)
  const headRef = nonEmpty(view.headRefName)
  const headSha = SHA.test(String(view.headRefOid ?? '')) ? view.headRefOid : null
  if (headSha === null) {
    const detail = `the head of #${pr} did not read back as a 40-character SHA (found ${JSON.stringify(view.headRefOid ?? null)}), so there is no commit to pin the merge to`
    stop('head-unreadable', detail)
    failures.push(detail)
  }
  const baseRef = nonEmpty(view.baseRefName)

  // ---- 3. the stacked chain
  const defaultBranch = nonEmpty(ghJson(['repo', 'view', id.full, '--json', 'defaultBranchRef'], 'gh repo view')?.defaultBranchRef?.name)
  const baseIsDefault = defaultBranch !== null && baseRef !== null ? baseRef === defaultBranch : null
  if (baseIsDefault === false) stop('stacked-on-non-default', `#${pr} targets ${baseRef} and the default branch is ${defaultBranch}; land the parent first or retarget`)
  const children = []
  if (headRef !== null) {
    const list = ghJson(['pr', 'list', '--repo', id.full, '--state', 'open', '--base', headRef, '--json', 'number,title,url'], `gh pr list --base ${headRef}`)
    for (const child of Array.isArray(list) ? list : []) children.push({ number: child?.number ?? null, title: child?.title ?? null, url: scrubUserinfo(child?.url ?? '') || null })
    if (children.length > 0) attend('children', `${children.length} open pull request(s) are based on ${headRef} (${children.map((c) => `#${c.number}`).join(', ')}); retarget them first`)
  }

  // ---- 4. CI, off the head SHA, every page of both sources
  const readPages = (path, what) => {
    const r = runGh(['api', '--hostname', id.host, '--paginate', '--slurp', path])
    const pages = r.code === 0 ? parseJson(r.stdout) : null
    if (!Array.isArray(pages)) { failures.push(r.code === 0 ? `${what} did not read as an array of pages` : `${what}: ${said(r)}`); return null }
    return pages
  }
  const entries = []
  let checksReadable = headSha !== null
  if (headSha !== null) {
    const commitPath = (kind) => `repos/${id.owner}/${id.repo}/commits/${headSha}/${kind}?per_page=100`
    const runPages = readPages(commitPath('check-runs'), 'gh api over the check runs')
    if (runPages === null) checksReadable = false
    else if (!runPages.every((page) => Array.isArray(page?.check_runs))) {
      failures.push('gh api over the check runs returned a page with no check_runs array')
      checksReadable = false
    } else {
      const runs = runPages.flatMap((page) => page.check_runs)
      for (const run of runs) {
        entries.push({ kind: 'check-run', name: nonEmpty(run?.name), url: nonEmpty(run?.details_url) ?? nonEmpty(run?.html_url), status: run?.status, conclusion: run?.conclusion })
      }
      const reported = runPages[0]?.total_count
      if (!Number.isSafeInteger(reported) || reported !== runs.length) {
        const detail = `the check-run read on ${headSha} collected ${runs.length} run(s) and GitHub reported total_count ${JSON.stringify(reported ?? null)}, so it cannot be shown to have seen every check`
        stop('ci-unknown', detail)
        failures.push(detail)
        checksReadable = false
      }
    }
    const statusPages = readPages(commitPath('statuses'), 'gh api over the commit statuses')
    if (statusPages === null) checksReadable = false
    else if (!statusPages.every(Array.isArray)) {
      failures.push('gh api over the commit statuses returned a page that is not a list')
      checksReadable = false
    } else {
      // Newest first: the first status of a context counts and later ones are superseded runs.
      const seen = new Set()
      for (const status of statusPages.flat()) {
        const context = nonEmpty(status?.context)
        if (context !== null && seen.has(context)) continue
        if (context !== null) seen.add(context)
        entries.push({ kind: 'status', name: context, url: nonEmpty(status?.target_url), state: status?.state })
      }
    }
  }
  const reportedNames = new Set(entries.map((e) => e.name).filter((n) => n !== null))

  // ---- 5. known flakes: the base ref governs; the head's copy only shows what the branch added.
  const readFlakes = (ref, what) => {
    const r = runGh(['api', '--hostname', id.host, `repos/${id.owner}/${id.repo}/contents/${FLAKES_PATH}?ref=${encodeURIComponent(ref)}`])
    if (r.code === 0) {
      const body = parseObject(r.stdout)
      // An over-size file comes back with encoding "none": unreadable, not empty.
      if (typeof body?.content === 'string' && body.encoding === 'base64') return Buffer.from(body.content, 'base64').toString('utf8')
      failures.push(`${what} gave no readable file contents`)
      return null
    }
    if (HTTP_404.test(r.stderr) || HTTP_404.test(r.stdout)) return ''
    failures.push(`${what}: ${said(r)}`)
    return null
  }
  const baseText = baseRef === null ? null : readFlakes(baseRef, `gh api for ${FLAKES_PATH} on ${baseRef}`)
  const baseFlakes = parseFlakes(baseText, reportedNames)
  const prFlakeLines = headSha === null ? [] : parseFlakes(readFlakes(headSha, `gh api for ${FLAKES_PATH} at the head`), reportedNames).lines
  const flakesAddedOnPr = prFlakeLines.filter((line) => !baseFlakes.lines.includes(line))
  if (flakesAddedOnPr.length > 0) attend('flakes-added-on-pr', `${FLAKES_PATH} gained ${flakesAddedOnPr.join(', ')} on this branch; the base copy is what this gate applied`)

  const ci = { success: [], pending: [], flaky: [], failed: [], unknown: [], flakeCandidates: {}, acceptedFlakes: [], flakesAddedOnPr }
  for (const entry of entries) {
    const bucket = entry.name === null ? 'unknown' : bucketOf(entry)
    if (bucket === 'success' || bucket === 'pending') ci[bucket].push(entry.name)
    else if (bucket === 'unknown') ci.unknown.push({ name: entry.name, link: entry.url })
    else if (baseFlakes.bare.has(entry.name)) { if (!ci.flaky.includes(entry.name)) ci.flaky.push(entry.name) }
    else {
      ci.failed.push({ name: entry.name, link: entry.url })
      if (baseFlakes.tests.has(entry.name)) ci.flakeCandidates[entry.name] = baseFlakes.tests.get(entry.name)
    }
  }
  const flakyByBare = [...ci.flaky]

  // --accept-flake: validated in full before anything moves. One acceptance is a statement about
  // one job log, so a name carried by two failed jobs, or claimed by two flags, is refused.
  if (acceptFlakes.length > 0 && baseText !== null) {
    const declared = new Map()
    for (const [check, tests] of baseFlakes.tests) for (const test of tests) declared.set(`${check}:${test}`, { check, test })
    const accepted = []
    const claimedBy = new Map()
    for (const value of acceptFlakes) {
      const split = reportedNames.has(value) ? null : splitEntry(value, reportedNames)
      const entry = split === null ? undefined : declared.get(`${split.check}:${split.test}`)
      if (entry === undefined) {
        return refuse(split === null
          ? `--accept-flake ${value} names no test; a bare check name on the allowlist moves on its own`
          : `--accept-flake ${value} is not an entry of ${FLAKES_PATH} on ${baseRef}, and the flag accepts only what the base declared`)
      }
      const failing = ci.failed.filter((f) => f.name === entry.check)
      if (failing.length !== 1) {
        return refuse(failing.length === 0
          ? `--accept-flake ${value} names ${entry.check}, which is not a failed check of #${pr}`
          : `--accept-flake ${value} names ${entry.check}, which ${failing.length} failed checks report (${failing.map((f) => f.link ?? 'no url').join(', ')}); one job log cannot speak for all of them`)
      }
      if (claimedBy.has(entry.check)) return refuse(`--accept-flake ${claimedBy.get(entry.check)} and --accept-flake ${value} both name ${entry.check}; pass the one the job log shows`)
      claimedBy.set(entry.check, value)
      accepted.push({ ...entry, failure: failing[0] })
    }
    for (const { check, test, failure } of accepted) {
      ci.acceptedFlakes.push({ check, test, link: failure.link })
      ci.failed = ci.failed.filter((f) => f !== failure)
      if (!ci.flaky.includes(check)) ci.flaky.push(check)
    }
  }

  if (checksReadable && entries.length === 0) stop('ci-unknown', `#${pr} reported no checks at all on ${headSha}, which is also how a pull request looks in the seconds after a push`)
  if (ci.pending.length > 0) stop('ci-pending', `${ci.pending.length} check(s) have not finished: ${ci.pending.join(', ')}`)
  if (ci.failed.length > 0) stop('ci-failed', `${ci.failed.length} check(s) failed: ${ci.failed.map((c) => c.name).join(', ')}`)
  if (ci.unknown.length > 0) stop('ci-unknown', `${ci.unknown.length} check(s) could not be read as pass or fail: ${ci.unknown.map((c) => c.name ?? '(unnamed)').join(', ')}`)
  if (flakyByBare.length > 0) attend('flaky-merged-through', `${flakyByBare.join(', ')} failed and ${FLAKES_PATH} on ${baseRef} lists it as flaky; note it in the land report`)
  for (const { check, test } of ci.acceptedFlakes) {
    attend('flaky-merged-through', `${check} failed and ${FLAKES_PATH} on ${baseRef} lists ${test} as flaky inside it; accepted by flag as --accept-flake ${check}:${test}. Name it in the land report`)
  }
  for (const [check, tests] of Object.entries(ci.flakeCandidates)) {
    if (ci.acceptedFlakes.some((a) => a.check === check)) continue
    attend('flaky-merged-through', `${check} failed and ${FLAKES_PATH} lists only ${tests.join(', ')} as flaky inside it; read the job log, and pass --accept-flake to merge on what it says`)
  }

  // ---- 6. review threads, paged to the end
  const graphql = (query, vars) => runGh(['api', 'graphql', '--hostname', id.host, '-f', `query=${query}`,
    ...Object.entries(vars).flatMap(([key, value]) => [typeof value === 'number' ? '-F' : '-f', `${key}=${value}`])])
  const threads = { total: 0, unresolved: [] }
  let threadsReadable = false
  let cursor = null
  for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
    const r = graphql(THREADS_QUERY, { owner: id.owner, repo: id.repo, pr, ...(cursor === null ? {} : { cursor }) })
    const body = r.code === 0 ? parseObject(r.stdout) : null
    const threadPage = body?.data?.repository?.pullRequest?.reviewThreads
    if (!Array.isArray(threadPage?.nodes)) { failures.push(`the review-thread query failed: ${said(r)}`); break }
    for (const node of threadPage.nodes) {
      threads.total += 1
      if (node?.isResolved === true) continue
      const comments = Array.isArray(node?.comments?.nodes) ? node.comments.nodes : []
      const last = comments.at(-1) ?? {}
      threads.unresolved.push({
        id: node?.id ?? null, path: nonEmpty(last.path) ?? nonEmpty(comments[0]?.path), url: scrubUserinfo(last.url ?? '') || null,
        author: nonEmpty(last.author?.login), lastBody: truncate(last.body ?? '', 400), isOutdated: node?.isOutdated ?? null,
      })
    }
    if (threadPage.pageInfo?.hasNextPage !== true) { threadsReadable = true; break }
    cursor = nonEmpty(threadPage.pageInfo?.endCursor)
    if (cursor === null) { failures.push('the review-thread query reported another page and no cursor'); break }
    if (page === MAX_THREAD_PAGES - 1) failures.push(`the review-thread query was still paging after ${MAX_THREAD_PAGES} pages`)
  }
  if (!threadsReadable) stop('threads-unreadable', `the review threads of #${pr} could not be read to the end, and a truncated read looks exactly like a clean one`)
  else if (threads.unresolved.length > 0) stop('threads-unresolved', `${threads.unresolved.length} review thread(s) are unresolved: ${threads.unresolved.map((t) => t.path ?? t.id).join(', ')}`)

  // ---- 7. the arming
  const autoMerge = view.autoMergeRequest != null
  if (autoMerge) stop('auto-merge-armed', `#${pr} has auto-merge armed, so it would land out of sight; that is the human's call`)
  let mergeQueue = 'unknown'
  if (baseRef !== null) {
    const r = graphql(QUEUE_QUERY, { owner: id.owner, repo: id.repo, pr, base: baseRef })
    const repository = r.code === 0 ? parseObject(r.stdout)?.data?.repository : null
    if (repository == null) failures.push(`the merge-queue query failed: ${said(r)}`)
    else mergeQueue = repository.mergeQueue != null || repository.pullRequest?.isInMergeQueue === true
  }
  if (mergeQueue === true) stop('merge-queue', `${id.slug} uses a merge queue on ${baseRef}, and the land performs an immediate merge`)
  else if (mergeQueue === 'unknown') stop('merge-queue', `the merge-queue status of ${baseRef ?? 'the base branch'} could not be read, and unknown is not "no queue"`)

  // ---- 8. linked issues and the follow-up draft
  const linkedIssues = readLinkedIssues({ closing: view.closingIssuesReferences, headRef, title: view.title, body: view.body })
  const strays = linkedIssues.recovered
  const noLink = linkedIssues.linked.length === 0
  if (strays.length > 0 || (noLink && linkedIssues.mentions.length > 0)) {
    const candidates = [...strays, ...(noLink ? linkedIssues.mentions : [])]
    attend('linked-issues-ambiguous', `${noLink ? 'GitHub parsed no closing link' : `GitHub parsed ${linkedIssues.linked.map((n) => `#${n}`).join(', ')} and the text points at more`}; ` +
      `candidates are ${candidates.map((n) => `#${n}`).join(', ')}. Ask the human which to close, with an explicit close-none`)
  }
  let followUpDraft = null
  const commentPages = readPages(`repos/${id.owner}/${id.repo}/issues/${pr}/comments?per_page=100`, 'gh api over the top-level comments')
  if (commentPages !== null && !commentPages.every(Array.isArray)) failures.push('gh api over the top-level comments returned a page that is not a list')
  else if (commentPages !== null) {
    const found = commentPages.flat().find((c) => typeof c?.body === 'string' && FOLLOW_UP_DRAFT.test(c.body))
    if (found) followUpDraft = { id: found.id ?? null, url: scrubUserinfo(found.html_url ?? found.url ?? '') || null, body: found.body }
  }
  if (followUpDraft !== null) attend('follow-up-draft', 'the pull request carries a `## follow-up draft` comment; file it or drop it before the land closes')

  const error = failures.length > 0 ? failures.join('; ') : null
  const payload = {
    command: 'land-gates', pr, url: scrubUserinfo(view.url ?? '') || null, title: view.title ?? null, state,
    isDraft: view.isDraft ?? null, isCrossRepository: view.isCrossRepository ?? null,
    head: { ref: headRef, sha: headSha }, base: { ref: baseRef, isDefault: baseIsDefault, default: defaultBranch },
    stacked: { children }, ci, threads, linkedIssues, followUpDraft, arming: { autoMerge, mergeQueue },
    ...(error === null ? {} : { error }), attention, stops, verdict: stops.length === 0 && error === null ? 'pass' : 'stop',
  }
  const code = error !== null ? EXIT_UNKNOWN : stops.length === 0 ? EXIT_PASS : EXIT_STOP
  const stderr = code === EXIT_PASS ? '' : `land-gates: #${pr} ${code === EXIT_UNKNOWN ? `is unknown (${error})` : `stops on ${stops.map((s) => s.code).join(', ')}`}\n`
  return { code, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runExecutor(landGates({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), runGh: ghRunner(process.env) }))
}
