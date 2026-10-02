#!/usr/bin/env node
// land-merge.mjs <pr> <head-sha> [--accept-flake <check>:<test>]...
//
// The land gate and the only merge, on either host. Every fact that can stop a land is read and
// judged here, in the one process that can merge, so no reading of a verdict stands between the
// gate and the merge. The caller passes the pull request and the head it read, and nothing else is
// taken from the conversation: the repository comes from origin (github.com or a host in
// FLOW_GH_HOSTS, no port, query or userinfo), and every gh call is pinned to it.
//
// The cron, usage, origin and pull-request reads end the run at the first refusal. After that
// every stop is collected before deciding: the pull request is open, not a draft, at exactly the
// argument head, based on the default branch, with no auto-merge armed and no merge queue on the
// base; `compare/<default>...<head>` shows it 0 commits behind; its checks are all green; and no
// review thread is unresolved. Every list is read to the end, because a gate that reads the first
// page fails green: check runs and commit statuses on the argument head over `gh api --paginate
// --slurp`, with the check runs collected equal to the total_count GitHub reported and the head
// carrying fewer than the 1000 check suites the check-runs endpoint serves from, and review
// threads over paged GraphQL, 20 pages at most. A check run is pending until it is completed; a
// commit status counts only as the newest of its context; a nameless entry, a conclusion outside
// the known sets and no checks at all are each unknown, which is how a pull request looks in the
// seconds after a push.
//
// Known flakes are the base ref's .github/known-flakes.txt over the contents API, never the head's,
// so a branch cannot approve its own failures. A line equal to a reported check name excuses that
// check. Any other line splits after the longest reported name it starts with (a status context
// like `ci/circleci: build` has a colon of its own) into check:test, which excuses nothing unless
// --accept-flake names it: the caller's statement that the job log shows that test as the check's
// only failure, so one flag speaks for exactly one failed job, and two flags cannot share a check.
//
// With no stop, it re-reads base and head, then the default branch's tip, which has to be the one
// the compare was made against: a land elsewhere during the reads above moves that tip, and the
// merge pins only the head. Then it runs `gh pr merge --squash --match-head-commit <head>` so
// GitHub re-checks the head itself, and proves the outcome by re-reading the url, state, head and
// base rather than trusting gh's exit code. It prints one JSON line: exit 0 `merged`, exit 1
// `refused` with every stop found (nothing merged), exit 4 `unknown`, which a human looks at before
// anything is retried. stderr carries one human line. A cooperative guardrail at one uid: a
// retarget or a land elsewhere between the last re-read and the merge is a race no client can
// close, and only branch protection's up-to-date rule closes it on the server.

import { fileURLToPath } from 'node:url'

import { execCapture, ghRunner, parseJson, parseObject, runExecutor } from '../lib/gh-exec.mjs'
import { firstLine, makeRedactor, scrubUserinfo } from '../lib/redact.mjs'
import { allowedHostsFrom, identityOfRemote, prUrlMismatch } from '../lib/remote-identity.mjs'

const SHA = /^[0-9a-f]{40}$/
// The check-runs endpoint serves from at most this many of a ref's most recent check suites.
const MAX_CHECK_SUITES = 1000
const MAX_THREAD_PAGES = 20
const FLAKES_PATH = '.github/known-flakes.txt'
const HTTP_404 = /\(HTTP 404\)|\bNot Found\b/
const PR_FIELDS = 'headRefOid,headRefName,state,isDraft,baseRefName,url,autoMergeRequest'
const USAGE_LINE = 'usage: land-merge.mjs <pull-request-number> <expected-head-sha> [--accept-flake <check-name>:<test_name>]...'
const USAGE = `${USAGE_LINE}

Merges the pull request when nothing stops the land, and prints one JSON line: exit 0 merged,
1 refused (nothing merged, every stop listed), 4 unknown. Origin must name github.com or a host in
FLOW_GH_HOSTS, with no port. --accept-flake takes a check-name:test_name entry from the base
branch's ${FLAKES_PATH}, for a failed check whose job log shows that test as its only failure.
`

const QUEUE_QUERY = 'query($owner: String!, $name: String!, $base: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: $base) { id } } }'
const THREADS_QUERY = `query($owner: String!, $name: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id isResolved comments(last: 20) { nodes { author { login } body path url } } }
  } } }
}`

// REST serves conclusions lowercase; anything outside both sets (stale among them) is unknown.
const RUN_SUCCESS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const RUN_FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'])
const STATUS_BUCKET = { SUCCESS: 'success', PENDING: 'pending', FAILURE: 'failed', ERROR: 'failed' }

const nonEmpty = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const upper = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '')
const truncate = (text, limit) => { const s = String(text ?? ''); return s.length <= limit ? s : `${s.slice(0, limit)}...` }
const oneLine = (text) => String(text).replace(/\s*\n\s*/g, ' ').trim()
const refPath = (ref) => ref.split('/').map(encodeURIComponent).join('/')

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
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (names.has(line)) { bare.add(line); continue }
    const split = splitEntry(line, names)
    // No colon: a check that is not running today. A colon that splits into nothing: dropped.
    if (split === null) { if (!line.includes(':')) bare.add(line); continue }
    if (!tests.has(split.check)) tests.set(split.check, [])
    tests.get(split.check).push(split.test)
  }
  return { bare, tests }
}

/**
 * Gate and merge. Returns { code, stdout, stderr } rather than exiting. `runGh(args, { timeoutMs })`
 * is injected; `env` is read for FLOW_CRON_JOB and FLOW_GH_HOSTS.
 */
export function landMerge({ argv, env, cwd, runGh }) {
  const out = { pr: null, repo: null, head: null }
  const stops = []
  let checks = null
  let threads = null
  const stop = (code, detail) => stops.push({ code, detail: oneLine(detail) })
  const refused = () => ({
    code: 1,
    stdout: `${JSON.stringify({ result: 'refused', ...out, stops, ...(checks === null ? {} : { checks }), ...(threads === null ? {} : { threads }) })}\n`,
    stderr: `land-merge: refused${out.pr === null ? '' : ` #${out.pr}`} on ${stops.map((s) => s.code).join(', ')}; nothing merged\n`,
  })
  const refuseNow = (code, detail) => { stop(code, detail); return refused() }
  const unknown = (text) => {
    const detail = oneLine(`${text} Look at the pull request before anything else, and do not re-run this blindly.`)
    return { code: 4, stdout: `${JSON.stringify({ result: 'unknown', ...out, detail })}\n`, stderr: `land-merge: #${out.pr} is unknown: ${detail}\n` }
  }

  // ---- 1 to 3: nobody watching, the arguments, the origin
  if (env.FLOW_CRON_JOB) return refuseNow('cron', `FLOW_CRON_JOB=${env.FLOW_CRON_JOB} means nobody is watching this run, and an unattended job does not merge`)
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { code: 0, stdout: USAGE, stderr: '' }
  const acceptFlakes = []
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i])
    if (arg === '--accept-flake' || arg.startsWith('--accept-flake=')) {
      const value = (arg === '--accept-flake' ? String(argv[++i] ?? '') : arg.slice('--accept-flake='.length)).trim()
      if (value === '') return refuseNow('usage', `--accept-flake takes one check-name:test_name entry. ${USAGE_LINE}`)
      if (!acceptFlakes.includes(value)) acceptFlakes.push(value)
    } else positional.push(arg)
  }
  if (positional.length !== 2) return refuseNow('usage', `expected the pull request number and the head SHA it was read at. ${USAGE_LINE}`)
  const pr = Number(positional[0])
  if (!/^[0-9]+$/.test(positional[0]) || !Number.isSafeInteger(pr) || pr <= 0) return refuseNow('usage', `${JSON.stringify(positional[0])} is not a pull request number. ${USAGE_LINE}`)
  out.pr = pr
  const head = positional[1]
  if (!SHA.test(head)) return refuseNow('usage', `${JSON.stringify(head)} is not a full 40-character lowercase commit SHA. ${USAGE_LINE}`)
  out.head = head

  const origin = execCapture('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeoutMs: 5_000 })
  const originUrl = origin.code === 0 ? origin.stdout.trim() : ''
  const remote = identityOfRemote(originUrl, { purpose: 'merge in', allowedHosts: allowedHostsFrom(env) })
  if (remote.identity === undefined) return refuseNow('origin', remote.refusal)
  const id = remote.identity
  out.repo = id.full
  const redact = makeRedactor(originUrl, id.full)
  const said = (r) => redact(firstLine(r.stderr || r.stdout)) || `exit ${r.code}`
  const gh = (args, timeoutMs = 60_000) => runGh(args, { timeoutMs })
  const api = (path) => gh(['api', '--hostname', id.host, path])
  const readPages = (path) => gh(['api', '--hostname', id.host, '--paginate', '--slurp', path], 120_000)
  const graphql = (query, vars) => gh(['api', 'graphql', '--hostname', id.host, '-f', `query=${query}`,
    ...Object.entries(vars).flatMap(([key, value]) => [typeof value === 'number' ? '-F' : '-f', `${key}=${value}`])])
  const view = (fields) => {
    const r = gh(['pr', 'view', String(pr), '--repo', id.full, '--json', fields])
    const value = r.code === 0 ? parseObject(r.stdout) : null
    return { value, why: r.code === 0 ? 'gave no readable JSON' : `failed (${said(r)})` }
  }
  /** true, false, or null when the base's merge-queue status could not be read. */
  const queueOn = (base) => {
    const r = graphql(QUEUE_QUERY, { owner: id.owner, name: id.repo, base })
    const repository = r.code === 0 ? parseObject(r.stdout)?.data?.repository : null
    return repository == null || typeof repository !== 'object' ? null : repository.mergeQueue != null
  }

  // ---- 4: the pull request, which has to be origin's
  const first = view(PR_FIELDS)
  if (first.value === null) return refuseNow('read-failed', `gh pr view ${pr} ${first.why}, so the live state of the pull request is unknown`)
  const pull = first.value
  if (prUrlMismatch(pull.url, id, pr) !== null) {
    return refuseNow('redirected', `the pull request GitHub returned (${JSON.stringify(scrubUserinfo(pull.url ?? '') || null)}) is not #${pr} of ${id.full}, so the read was redirected`)
  }

  // ---- 5 to 7: state, head, base, arming. From here every stop is collected.
  const state = nonEmpty(pull.state)
  if (state !== 'OPEN') stop('not-open', `#${pr} is ${state ?? 'in an unreadable state'}, and only an open pull request is merged`)
  if (pull.isDraft !== false) stop('draft', pull.isDraft === true ? `#${pr} is a draft` : `the draft status of #${pr} could not be read, so it cannot be shown ready`)
  const headRef = nonEmpty(pull.headRefName)
  if (!SHA.test(String(pull.headRefOid ?? ''))) stop('head-unreadable', `the head of #${pr} did not read back as a 40-character SHA (found ${JSON.stringify(pull.headRefOid ?? null)})`)
  else if (pull.headRefOid !== head) {
    stop('head-moved', `head moved: ${scrubUserinfo(pull.url)} on branch ${JSON.stringify(headRef)} is at ${pull.headRefOid}, not ${head}. ` +
      'If that is not the pull request you named, stop and ask; otherwise wait for CI on the new head and land that')
  }
  const base = nonEmpty(pull.baseRefName)
  if (base === null) stop('read-failed', `the base branch of #${pr} could not be read`)
  const repoView = gh(['repo', 'view', id.full, '--json', 'defaultBranchRef'])
  const defaultBranch = nonEmpty((repoView.code === 0 ? parseObject(repoView.stdout) : null)?.defaultBranchRef?.name)
  if (defaultBranch === null) stop('read-failed', `the repository default branch could not be read${repoView.code === 0 ? '' : ` (${said(repoView)})`}, so the merge target cannot be checked`)
  else if (base !== null && base !== defaultBranch) stop('stacked-on-non-default', `#${pr} targets ${JSON.stringify(base)} and the default branch is ${JSON.stringify(defaultBranch)}; land the parent first or retarget`)
  if (pull.autoMergeRequest != null) stop('auto-merge-armed', `#${pr} already has auto-merge armed; this only performs an immediate squash-merge, so cancel it first or let it run`)
  if (base !== null) {
    const queued = queueOn(base)
    if (queued === null) stop('read-failed', `the merge-queue status of ${base} could not be read, and this will not merge without knowing whether a queue is required`)
    else if (queued) stop('merge-queue', `${id.slug} uses a merge queue on ${base}; land it through the queue by hand`)
  }

  // ---- 8: behind the default branch, at a tip kept for the re-read before the merge
  let baseTip = null
  if (defaultBranch !== null) {
    const r = api(`repos/${id.owner}/${id.repo}/compare/${refPath(defaultBranch)}...${head}`)
    const compared = r.code === 0 ? parseObject(r.stdout) : null
    const behind = compared?.behind_by
    const unread = r.code !== 0 ? `failed (${said(r)})` : !Number.isSafeInteger(behind) || behind < 0 ? 'gave no behind_by count'
      : !SHA.test(String(compared?.base_commit?.sha ?? '')) ? 'gave no base commit SHA' : null
    if (unread !== null) stop('read-failed', `the compare of ${defaultBranch}...${head.slice(0, 12)} ${unread}, so whether the head is behind ${defaultBranch} is unknown`)
    else {
      baseTip = compared.base_commit.sha
      if (behind > 0) stop('behind-base', `${head.slice(0, 12)} is ${behind} commit(s) behind ${defaultBranch}; rebase onto it, push, wait for CI on the new head and land that`)
    }
  }

  // ---- 9: every check on the argument head, both sources to the end
  const entries = []
  let checksComplete = true
  const commitPath = (kind) => `repos/${id.owner}/${id.repo}/commits/${head}/${kind}?per_page=100`
  const runsRead = readPages(commitPath('check-runs'))
  const runPages = runsRead.code === 0 ? parseJson(runsRead.stdout) : null
  if (!Array.isArray(runPages) || !runPages.every((page) => Array.isArray(page?.check_runs))) {
    stop('read-failed', `the check-run read on ${head.slice(0, 12)} ${runsRead.code === 0 ? 'returned a page with no check_runs array' : `failed (${said(runsRead)})`}`)
    checksComplete = false
  } else {
    const runs = runPages.flatMap((page) => page.check_runs)
    for (const run of runs) {
      entries.push({ kind: 'check-run', name: nonEmpty(run?.name), link: nonEmpty(run?.details_url) ?? nonEmpty(run?.html_url), status: run?.status, conclusion: run?.conclusion })
    }
    const reported = runPages[0]?.total_count
    if (!Number.isSafeInteger(reported) || reported !== runs.length) {
      stop('ci-unknown', `the check-run read on ${head.slice(0, 12)} collected ${runs.length} run(s) and GitHub reported total_count ${JSON.stringify(reported ?? null)}, so it cannot be shown to have seen every check`)
      checksComplete = false
    }
  }
  // The check-runs endpoint serves runs from only the 1000 most recent check suites on a ref, and
  // its total_count counts only those, so past that window a failing run in an older suite is
  // missing from a read that otherwise agrees with itself. The suite count comes from the commit's
  // check-suites collection, and a count at the window, or none, leaves CI unknown.
  const suitesRead = api(`repos/${id.owner}/${id.repo}/commits/${head}/check-suites?per_page=1`)
  const suiteCount = suitesRead.code === 0 ? parseObject(suitesRead.stdout)?.total_count : null
  if (!Number.isSafeInteger(suiteCount) || suiteCount < 0) {
    stop('ci-unknown', `the check-suite count on ${head.slice(0, 12)} ${suitesRead.code === 0 ? 'gave no total_count' : `could not be read (${said(suitesRead)})`}, so whether the check-run read fits the ${MAX_CHECK_SUITES}-suite window it is served from is unknown`)
    checksComplete = false
  } else if (suiteCount >= MAX_CHECK_SUITES) {
    stop('ci-unknown', `${head.slice(0, 12)} carries ${suiteCount} check suites, at or past the ${MAX_CHECK_SUITES}-suite window the check-runs endpoint serves from, so a failing run in an older suite would not appear in this read`)
    checksComplete = false
  }
  const statusRead = readPages(commitPath('statuses'))
  const statusPages = statusRead.code === 0 ? parseJson(statusRead.stdout) : null
  if (!Array.isArray(statusPages) || !statusPages.every(Array.isArray)) {
    stop('read-failed', `the commit-status read on ${head.slice(0, 12)} ${statusRead.code === 0 ? 'returned a page that is not a list' : `failed (${said(statusRead)})`}`)
    checksComplete = false
  } else {
    // Newest first: the first status of a context counts and later ones are superseded runs.
    const seen = new Set()
    for (const status of statusPages.flat()) {
      const context = nonEmpty(status?.context)
      if (context !== null && seen.has(context)) continue
      if (context !== null) seen.add(context)
      entries.push({ kind: 'status', name: context, link: nonEmpty(status?.target_url), state: status?.state })
    }
  }
  const reportedNames = new Set(entries.map((e) => e.name).filter((n) => n !== null))

  // ---- 10: known flakes, from the base ref alone
  let flakeText = null
  if (base !== null) {
    const r = api(`repos/${id.owner}/${id.repo}/contents/${FLAKES_PATH}?ref=${encodeURIComponent(base)}`)
    if (r.code === 0) {
      const body = parseObject(r.stdout)
      // An over-size file comes back with encoding "none": unreadable, not empty.
      if (typeof body?.content === 'string' && body.encoding === 'base64') flakeText = Buffer.from(body.content, 'base64').toString('utf8')
      else stop('read-failed', `${FLAKES_PATH} on ${base} came back with no base64 contents (encoding ${JSON.stringify(body?.encoding ?? null)}), so no failure is excused`)
    } else if (HTTP_404.test(r.stderr) || HTTP_404.test(r.stdout)) flakeText = ''
    else stop('read-failed', `the read of ${FLAKES_PATH} on ${base} failed (${said(r)}), so no failure is excused`)
  }
  const flakes = parseFlakes(flakeText ?? '', reportedNames)
  checks = { failed: [], pending: [], unknown: [], flakeCandidates: {}, excused: [] }
  for (const entry of entries) {
    const bucket = entry.name === null ? 'unknown' : bucketOf(entry)
    if (bucket === 'pending' || bucket === 'unknown') checks[bucket].push({ name: entry.name, link: entry.link })
    else if (bucket === 'failed' && flakes.bare.has(entry.name)) checks.excused.push({ check: entry.name, link: entry.link })
    else if (bucket === 'failed') checks.failed.push({ name: entry.name, link: entry.link })
  }

  // --accept-flake: validated in full before anything moves. One acceptance is a statement about
  // one job log, so a name carried by two failed jobs, or claimed by two flags, is refused. Against
  // a file nobody could read there is nothing to validate, and the read-failed stop says so.
  if (acceptFlakes.length > 0 && flakeText !== null) {
    const declared = new Map()
    for (const [check, tests] of flakes.tests) for (const test of tests) declared.set(`${check}:${test}`, { check, test })
    const accepted = []
    const invalid = []
    const claimedBy = new Map()
    for (const value of acceptFlakes) {
      const split = reportedNames.has(value) ? null : splitEntry(value, reportedNames)
      const entry = split === null ? undefined : declared.get(`${split.check}:${split.test}`)
      if (entry === undefined) {
        invalid.push(split === null
          ? `--accept-flake ${value} names no test; a bare check name on the allowlist moves on its own`
          : `--accept-flake ${value} is not an entry of ${FLAKES_PATH} on ${base}, and the flag accepts only what the base declared`)
        continue
      }
      const failing = checks.failed.filter((f) => f.name === entry.check)
      if (failing.length !== 1) {
        invalid.push(failing.length === 0
          ? `--accept-flake ${value} names ${entry.check}, which is not a failed check of #${pr}`
          : `--accept-flake ${value} names ${entry.check}, which ${failing.length} failed checks report (${failing.map((f) => f.link ?? 'no url').join(', ')}); one job log cannot speak for all of them`)
        continue
      }
      if (claimedBy.has(entry.check)) { invalid.push(`--accept-flake ${claimedBy.get(entry.check)} and --accept-flake ${value} both name ${entry.check}; pass the one the job log shows`); continue }
      claimedBy.set(entry.check, value)
      accepted.push({ ...entry, failure: failing[0] })
    }
    for (const reason of invalid) stop('accept-flake-refused', reason)
    if (invalid.length === 0) {
      for (const { check, test, failure } of accepted) {
        checks.excused.push({ check, test, link: failure.link })
        checks.failed = checks.failed.filter((f) => f !== failure)
      }
    }
  }
  for (const { name } of checks.failed) if (flakes.tests.has(name)) checks.flakeCandidates[name] = flakes.tests.get(name)

  // ---- 11: the verdict on the checks
  const names = (list) => list.map((c) => c.name ?? '(unnamed)').join(', ')
  if (checksComplete && entries.length === 0) stop('ci-unknown', `#${pr} reported no checks at all on ${head.slice(0, 12)}, which is also how a pull request looks in the seconds after a push`)
  if (checks.pending.length > 0) stop('ci-pending', `${checks.pending.length} check(s) have not finished: ${names(checks.pending)}`)
  if (checks.failed.length > 0) stop('ci-failed', `${checks.failed.length} check(s) failed: ${names(checks.failed)}`)
  if (checks.unknown.length > 0) stop('ci-unknown', `${checks.unknown.length} check(s) could not be read as pass or fail: ${names(checks.unknown)}`)

  // ---- 12: review threads, paged to the end
  threads = []
  let cursor = null
  for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
    const r = graphql(THREADS_QUERY, { owner: id.owner, name: id.repo, pr, ...(cursor === null ? {} : { cursor }) })
    const threadPage = (r.code === 0 ? parseObject(r.stdout) : null)?.data?.repository?.pullRequest?.reviewThreads
    if (!Array.isArray(threadPage?.nodes)) { stop('read-failed', `the review-thread query failed on page ${page + 1} (${r.code === 0 ? 'no reviewThreads in the answer' : said(r)})`); break }
    for (const node of threadPage.nodes) {
      if (node?.isResolved === true) continue
      const comments = Array.isArray(node?.comments?.nodes) ? node.comments.nodes : []
      const last = comments.at(-1) ?? {}
      threads.push({
        id: node?.id ?? null, path: nonEmpty(last.path) ?? nonEmpty(comments[0]?.path), url: scrubUserinfo(last.url ?? '') || null,
        author: nonEmpty(last.author?.login), lastBody: truncate(last.body ?? '', 400),
      })
    }
    if (threadPage.pageInfo?.hasNextPage !== true) break
    cursor = nonEmpty(threadPage.pageInfo?.endCursor)
    if (cursor === null) { stop('read-failed', 'the review-thread query reported another page and no cursor, and a truncated read looks exactly like a clean one'); break }
    if (page === MAX_THREAD_PAGES - 1) stop('read-failed', `the review-thread query was still paging after ${MAX_THREAD_PAGES} pages, and a truncated read looks exactly like a clean one`)
  }
  if (threads.length > 0) stop('threads-unresolved', `${threads.length} review thread(s) are unresolved: ${threads.map((t) => t.path ?? t.id).join(', ')}`)

  // ---- 13 and 14: any stop refuses; else the reads right before the merge, to shrink the
  // retarget and land-elsewhere windows it cannot close. The tip goes last, nearest the merge.
  if (stops.length > 0) return refused()
  const recheck = view('baseRefName,headRefOid')
  if (recheck.value === null) return refuseNow('read-failed', `the pull request could not be re-read immediately before the merge: gh pr view ${recheck.why}`)
  if (recheck.value.baseRefName !== base) stop('retargeted', `#${pr} was retargeted to ${JSON.stringify(recheck.value.baseRefName ?? null)} mid-run; it was read as targeting ${JSON.stringify(base)}`)
  if (recheck.value.headRefOid !== head) {
    stop('head-moved', `the head of #${pr} moved mid-run (read ${head.slice(0, 12)}, now ${String(recheck.value.headRefOid ?? '').slice(0, 12) || 'unreadable'}); wait for CI on the new head and land that`)
  }
  const tipRead = api(`repos/${id.owner}/${id.repo}/git/ref/heads/${refPath(defaultBranch)}`)
  const tipNow = tipRead.code === 0 ? parseObject(tipRead.stdout)?.object?.sha : undefined
  if (!SHA.test(String(tipNow ?? ''))) {
    return refuseNow('read-failed', `the tip of ${defaultBranch} could not be re-read immediately before the merge ${tipRead.code === 0 ? '(no commit SHA in the answer)' : `(${said(tipRead)})`}, so the head cannot be shown still current with it`)
  }
  if (tipNow !== baseTip) {
    stop('behind-base', `${defaultBranch} moved from ${baseTip.slice(0, 12)} to ${tipNow.slice(0, 12)} after the compare showed ${head.slice(0, 12)} current with it, ` +
      'so that comparison no longer holds; rebase onto it, push, wait for CI on the new head and land that')
  }
  if (stops.length > 0) return refused()

  // ---- 15: the merge, proven by a re-read
  const merge = gh(['pr', 'merge', String(pr), '--repo', id.full, '--squash', '--match-head-commit', head], 120_000)
  const failure = merge.code === 0 ? null : said(merge)
  const saidMerge = failure === null ? '' : ` (gh pr merge said: ${failure})`

  // Always re-read: a lost response does not prove the merge failed, and MERGED alone does not prove
  // this run merged what it verified, because a foreign merge of the same number is MERGED too.
  const after = view('state,headRefOid,baseRefName,url,autoMergeRequest').value
  if (after === null || typeof after.state !== 'string') return unknown(`could not confirm whether #${pr} merged${saidMerge}; it may or may not have landed.`)
  if (after.state === 'MERGED') {
    if (prUrlMismatch(after.url, id, pr) === null && after.headRefOid === head && after.baseRefName === base) {
      const detail = `merged #${pr} as a squash of ${head.slice(0, 12)}`
      return { code: 0, stdout: `${JSON.stringify({ result: 'merged', ...out, excused: checks.excused, detail })}\n`, stderr: `land-merge: ${detail} on ${id.full}\n` }
    }
    return unknown(`#${pr} reads back MERGED, but its url, head or base no longer match the verified merge (head ${JSON.stringify(after.headRefOid ?? null)}, base ${JSON.stringify(after.baseRefName ?? null)}); someone else may have merged it, so do not treat it as this merge.`)
  }
  // Not merged. Only a clean OPEN with nothing armed and a failure from gh is a refusal; an armed
  // auto-merge or queue may still land it, and anything else is inconsistent.
  if (after.autoMergeRequest != null) return unknown(`#${pr} is not merged, but it now has auto-merge armed${saidMerge}, so it may still land on its own.`)
  const queuedAfter = queueOn(after.baseRefName ?? base)
  if (queuedAfter !== false) return unknown(`#${pr} is not merged, and its base's merge-queue status is ${queuedAfter === null ? 'unreadable' : 'armed'}${saidMerge}, so it may be queued to land later.`)
  if (after.state === 'OPEN' && failure !== null) return refuseNow('merge-rejected', `gh pr merge failed: ${failure}`)
  return unknown(`could not confirm the merge of #${pr}: gh pr merge ${failure === null ? 'reported success' : `said: ${failure}`}, but the pull request reads back ${JSON.stringify(after.state)} rather than MERGED.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runExecutor(landMerge({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), runGh: ghRunner(process.env) }))
}
