#!/usr/bin/env node
// Smoke harness for scripts/land-gates.mjs, the read-only executor behind flow's land gates.
//
// The executor is driven in process through its exported landGates() with a fake gh and a fake
// git injected as plain functions across the module boundary. No environment variable selects a
// binary, no network is touched, and nothing here needs a real repository: every fact the program
// reads arrives from a per-case state object, which is also what lets one case make the review
// threads span two pages and another make the GraphQL read fail outright.
//
// What the cases below prove. The verdict is a pass only when nothing stops the land; a check
// that is pending, failed or unreadable stops it, and so does a nameless check however green it
// looks. A failure the base branch's known-flakes allowlist names is merged through, and the same
// entry added on the pull request side is not, because a branch does not get to approve its own
// failures. Check runs, commit statuses, top-level comments and review threads are all read to
// the end, and a page that never arrived is unreadable rather than a short list. An armed
// auto-merge and a merge queue both stop. Children based on this branch, a follow-up draft
// comment, an allowlist entry added on the branch and an ambiguous set of linked issues are
// reported as attention rather than as stops. And through all of it the
// executor calls nothing that mutates: the whole point of splitting it out of land-merge.mjs is
// that running it can never change anything, which now includes the local clone - the allowlist
// arrives over the contents API, and the two git reads left are `git remote get-url origin` and,
// only on the run that was given no number, `git rev-parse --abbrev-ref HEAD`.
//
// The last sections are one case per finding from the reviews of 2026-09-01, kept together and
// named by finding so that a regression says which rule came back. G2 to G7 are the first two
// reviews; J2 and J3 are the third: a repository identity that swallowed a query string, and a
// per-test flake entry that could never reach the pass the merge needs. S2 is the fourth
// review's: the pull request gh resolves from the current branch, which was taken on trust and
// could belong to another repository entirely. P1 and P2 are the two smaller ones beside it, both
// about a check whose name this program then wrote down wrong. T1 is the one that exited 0 on a
// red pull request: `gh pr view` answered with the first hundred checks and the first hundred
// comments and no page after either. T2 is the last, and it is T1's other half. Paging the
// check-runs endpoint to exhaustion still does not prove the list is whole, because the endpoint
// serves from a window of the 1000 most recent check suites, so the read now has to prove itself
// or exit 4, and the suite count it proves itself against comes from the suite collection. T3 is
// the last, and it is what T2's counts could not see on their own. The collection and the count
// that proves it whole are two snapshots, so the counts now bracket the collection and any
// movement between them stops the land. T4 is the hole left in T3. A count cannot see a run that
// changed where it stood, so the closing bracket reads the runs in full and compares their state.
//
// G1, J1 and O2 went with the mechanism they guarded. All three were ways the `gh pr checks`
// cross-read could put a passing name on a failing check, and there is no cross-read now, because
// every entry is named by the endpoint that served it.
//
// The fake gh answers the three paginated endpoints in the shape `gh api --paginate --slurp`
// really prints: an outer array with one element per page walked, a page of check runs an object
// carrying a check_runs array, a page of statuses or of comments the array itself. It pages at
// the 100 the endpoints ask for, so a case that hands it 101 check runs gets two pages without
// saying so, which is the whole of the T1 section.
//
// Run: node plugins/flow/scripts/smoke-land-gates.mjs

import { landGates } from './land-gates.mjs'

let bad = 0
let total = 0
const check = (name, ok, detail = '') => {
  total++
  if (!ok) bad++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` -> ${detail}`}`)
}

const SLUG = 'jakub/marketplace-plugins'
const IDENTITY = `github.com/${SLUG}`
const ORIGIN = `git@github.com:${SLUG}.git`
const CWD = '/tmp/not-a-real-checkout'
const PR = 12
const BRANCH = 'feat/issue-6-land-gates'
const HEAD = 'a'.repeat(40)
const PR_URL = `https://github.com/${SLUG}/pull/${PR}`
const FLAKES_PATH = '.github/known-flakes.txt'

// ------------------------------------------------------------------ the fixtures, per case
// The REST shapes, spelled the way GitHub serves them. A check run has name, status and
// conclusion, all lowercase, with details_url and the check suite it belongs to beside them. A
// commit status has context, state and target_url, and no conclusion at all. A comment has id,
// body and both urls, the html one being the one a human opens.
//
// Every run here has an id that goes up and belongs to suite 1 unless a case says otherwise,
// which is what one workflow run on a commit really looks like. The id is what the closing
// bracket compares a run's status and conclusion against, so a case that changes a run in place
// spreads the first one and overrides those two fields. How many suites the commit carries is not derived from these
// ids, it is the checkSuites total the check-suites collection reports, so a case that wants a
// crowded commit sets that and leaves the runs alone.
let nextRunId = 1000
const checkRun = (name, conclusion, extra = {}) => ({
  id: nextRunId++, name, status: conclusion === null ? 'in_progress' : 'completed', conclusion,
  details_url: `https://ci.example/${name}`, check_suite: { id: 1 }, ...extra,
})

// A run GitHub served without naming its suite. The executor cannot place it against the suite
// count, so it is an unreadable check response rather than one entry to skip.
const suitelessRun = (name, conclusion) => {
  const run = checkRun(name, conclusion)
  delete run.check_suite
  return run
}

// The id goes up with every status this file builds, the way GitHub's do. The closing bracket
// compares the newest id under each context, so two statuses on one context are two ids here.
let nextStatusId = 1
const commitStatus = (context, state, extra = {}) => ({
  id: nextStatusId++, context, state, target_url: `https://cr.example/${context}`, ...extra,
})

const comment = (id, body) => ({
  id, body,
  url: `https://api.github.com/repos/${SLUG}/issues/comments/${id}`,
  html_url: `${PR_URL}#issuecomment-${id}`,
})

const many = (n, make) => Array.from({ length: n }, (unused, i) => make(i))

// The page size the three endpoints are asked for. gh walks the pages itself under --paginate, so
// a hundred and first entry is a second page here exactly as it is against GitHub.
const PAGE = 100
const pagesOf = (list) => {
  const pages = []
  for (let i = 0; i < list.length; i += PAGE) pages.push(list.slice(i, i + PAGE))
  return pages.length === 0 ? [[]] : pages
}

const thread = (id, overrides = {}) => {
  const o = { resolved: true, outdated: false, path: 'plugins/flow/scripts/land-gates.mjs', author: 'reviewer', body: 'this needs a word', ...overrides }
  return {
    id,
    isResolved: o.resolved,
    isOutdated: o.outdated,
    comments: {
      nodes: [
        { author: { login: 'jakub' }, body: 'opening comment', path: o.path, url: `${PR_URL}#discussion_r1` },
        { author: { login: o.author }, body: o.body, path: o.path, url: `${PR_URL}#discussion_r2` },
      ],
    },
  }
}

const freshState = (overrides = {}) => ({
  origin: ORIGIN,
  defaultBranch: 'main',
  checkRuns: [checkRun('unit', 'success'), checkRun('lint', 'skipped')],
  checkRunsTotal: null,  // the total_count the check-runs reads report; null serves the honest count
  checkSuites: 1,        // the total_count the check-suites collection reports; an array is one value per read
  checkRunsAfter: null,  // the check runs served on every read after the first; null keeps them steady
  statusesAfter: null,   // the statuses served on every read after the first; null keeps them steady
  reads: {},             // how many times each commit endpoint has been read, so a sequence can advance
  commitReads: [],       // every commit-scoped read in order, which is what proves the bracketing
  statuses: [],          // the commit statuses on the head, newest first, as the endpoint serves them
  apiFail: null,         // 'check-runs', 'check-suites', 'statuses' or 'comments': that read fails with a 500
  apiShape: null,        // 'not-pages' or 'no-check-runs-key': that read answers something unreadable
  pagesServed: [],       // one record per paginated read, so a case can prove two pages were walked
  children: [],
  comments: [],
  threadPages: [[thread('T_resolved')]],
  threadsFail: false,
  queueFails: false,
  mergeQueue: null,
  isInMergeQueue: false,
  baseFlakes: null,      // file content on the base branch; null means the contents API answers 404
  prFlakes: null,        // the pull request's own copy
  flakesHttp: null,      // an HTTP status the contents API fails with instead of answering
  flakesEncoding: 'base64', // what the contents API says the body is encoded as
  viewFails: false,
  currentBranchPr: null,       // the number `gh pr view` answers with when the run was given none
  currentBranchUrl: undefined, // its url: undefined serves the honest one, null omits it, a string is served as is
  currentBranchHeadRef: undefined, // its head branch; undefined is the branch this clone has checked out
  currentBranch: BRANCH,       // what `git rev-parse --abbrev-ref HEAD` answers; null is a read that failed
  calls: [],
  gitCalls: [],
  cursors: [],
  ...overrides,
  pr: {
    number: PR,
    title: 'feat(flow): add land-gates',
    body: 'The read-only gate executor.',
    state: 'OPEN',
    headRefName: BRANCH,
    headRefOid: HEAD,
    baseRefName: 'main',
    url: PR_URL,
    isDraft: false,
    isCrossRepository: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    autoMergeRequest: null,
    closingIssuesReferences: [{ number: 6 }],
    ...(overrides.pr || {}),
  },
})

const argValue = (args, flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : null
}
const formField = (args, key) => {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-f' || args[i] === '-F') && String(args[i + 1]).startsWith(`${key}=`)) return String(args[i + 1]).slice(key.length + 1)
  }
  return null
}

const makeRunGh = (st) => (args) => {
  st.calls.push(args)
  const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })

  if (args[0] === 'pr' && args[1] === 'view') {
    // The resolution read is the one with no number in it, and it is recognized by that rather
    // than by its field list. A case that drives an executor asking for fewer fields still gets
    // this answer, so it measures what the executor does with the answer.
    if (args[2] === undefined || String(args[2]).startsWith('--')) {
      if (st.currentBranchPr === null) {
        return { code: 1, stdout: '', stderr: 'fake gh: no pull request found for the current branch\n' }
      }
      const url = st.currentBranchUrl === undefined
        ? `https://github.com/${SLUG}/pull/${st.currentBranchPr}`
        : st.currentBranchUrl
      return ok({
        number: st.currentBranchPr,
        headRefName: st.currentBranchHeadRef === undefined ? BRANCH : st.currentBranchHeadRef,
        ...(url === null ? {} : { url }),
      })
    }
    if (st.viewFails) return { code: 1, stdout: '', stderr: 'fake gh: could not read the pull request\n' }
    return ok({ ...st.pr })
  }
  if (args[0] === 'repo' && args[1] === 'view') {
    return st.defaultBranch === null
      ? { code: 1, stdout: '', stderr: 'fake gh: repo view failed\n' }
      : ok({ defaultBranchRef: { name: st.defaultBranch } })
  }
  if (args[0] === 'pr' && args[1] === 'list') return ok(st.children)
  if (args[0] === 'api' && args[1] !== 'graphql') {
    // `gh api repos/{owner}/{repo}/contents/<path>?ref=<ref>`: a JSON object whose base64 content
    // is the file, a 404 when the path is absent at that ref, and gh's own message on stderr for
    // anything else. gh exits non-zero on every HTTP error and prints the response body anyway.
    const path = args.find((a) => String(a).startsWith('repos/'))
    if (path !== undefined && path.includes('/contents/')) {
      if (st.flakesHttp !== null) {
        const label = st.flakesHttp === 404 ? 'Not Found' : 'Internal Server Error'
        return { code: 1, stdout: `{"message":"${label}"}`, stderr: `gh: ${label} (HTTP ${st.flakesHttp})\n` }
      }
      const ref = decodeURIComponent(String(path).split('ref=')[1] || '')
      const content = ref === st.pr.baseRefName ? st.baseFlakes : st.prFlakes
      if (content === null) {
        return { code: 1, stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)\n' }
      }
      return ok({
        name: 'known-flakes.txt', path: FLAKES_PATH, type: 'file',
        encoding: st.flakesEncoding,
        content: st.flakesEncoding === 'base64' ? Buffer.from(content, 'utf8').toString('base64') : '',
      })
    }

    // Every read that hangs off the head commit, whether it is one of the paginated collections
    // or one of the counts that bracket them. A case that hands a sequence instead of a number
    // gets one element per read of that endpoint, which is how a count that moves mid-gate is
    // served: checkSuites [1, 2] answers 1 to the opening bracket and 2 to the closing one.
    const endpoint = path === undefined ? null
      : path.includes('/check-suites?') ? 'check-suites'
        : path.includes('/check-runs?') ? 'check-runs'
          : path.includes('/statuses?') ? 'statuses'
            : path.includes('/comments?') ? 'comments' : null
    if (endpoint !== null) {
      const nth = (value, i) => (Array.isArray(value) ? value[Math.min(i, value.length - 1)] : value)
      const paginated = args.includes('--paginate')
      // --paginate alone prints one document per page and two adjacent documents are not JSON, so
      // a paginated read missing --slurp is a failure of the executor, not a gap in this fake.
      if (paginated && !args.includes('--slurp')) {
        return { code: 3, stdout: '', stderr: `fake gh: ${endpoint} was read with --paginate and no --slurp\n` }
      }
      const perPage = String(path).split('per_page=')[1] || null
      const readIndex = st.reads[endpoint] || 0
      st.reads[endpoint] = readIndex + 1
      if (endpoint !== 'comments') st.commitReads.push({ endpoint, paginated, perPage })

      if (st.apiFail === endpoint) {
        return { code: 1, stdout: '{"message":"Internal Server Error"}', stderr: 'gh: Internal Server Error (HTTP 500)\n' }
      }
      // The check-suites collection is never paged by the executor: it takes the total_count and
      // reads no suite. checkSuites set to something that is not a count is served as it is,
      // which is how the unreadable answer is driven.
      if (endpoint === 'check-suites') return ok({ total_count: nth(st.checkSuites, readIndex), check_suites: [] })

      if (endpoint === 'check-runs' && st.apiShape === 'not-pages') {
        return ok({ total_count: 1, check_runs: [checkRun('unit', 'success')] })
      }
      if (endpoint === 'check-runs' && st.apiShape === 'no-check-runs-key') {
        return ok([{ total_count: 1 }])
      }
      const after = (first, later) => (readIndex > 0 && later !== null ? later : first)
      const list = endpoint === 'check-runs' ? after(st.checkRuns, st.checkRunsAfter)
        : endpoint === 'statuses' ? after(st.statuses, st.statusesAfter)
          : st.comments
      const pages = pagesOf(Array.isArray(list) ? list : [])
      // GitHub reports total_count on every page of the check runs. It is the honest count here
      // unless a case sets checkRunsTotal, which is how a read that came back short of what
      // GitHub says is on the commit is served without any page failing.
      const totalCount = st.checkRunsTotal === null ? list.length : nth(st.checkRunsTotal, readIndex)
      // A read with no --paginate is one of the closing bracket's: it gets the first page alone,
      // trimmed to the page size it asked for, exactly as gh prints one page of one document.
      if (!paginated) {
        return ok(endpoint === 'check-runs'
          ? { total_count: totalCount, check_runs: pages[0].slice(0, Number(perPage) || 100) }
          : pages[0].slice(0, Number(perPage) || 100))
      }
      st.pagesServed.push({ endpoint, pages: pages.length })
      return ok(endpoint === 'check-runs'
        ? pages.map((page) => ({ total_count: totalCount, check_runs: page }))
        : pages)
    }
    return { code: 3, stdout: '', stderr: `fake gh: unexpected ${args.join(' ')}\n` }
  }
  if (args[0] === 'api' && args[1] === 'graphql') {
    const query = formField(args, 'query') || ''
    if (query.includes('reviewThreads')) {
      if (st.threadsFail) return { code: 1, stdout: '', stderr: 'fake gh: Field \'reviewThreads\' doesn\'t exist\n' }
      const cursor = formField(args, 'cursor')
      st.cursors.push(cursor)
      const index = cursor === null ? 0 : Number(String(cursor).replace('cursor-', ''))
      const nodes = st.threadPages[index] || []
      const hasNextPage = index < st.threadPages.length - 1
      return ok({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${index + 1}` : null }, nodes },
            },
          },
        },
      })
    }
    if (query.includes('mergeQueue')) {
      if (st.queueFails) return { code: 1, stdout: '', stderr: 'fake gh: Field \'mergeQueue\' doesn\'t exist on type \'Repository\'\n' }
      return ok({ data: { repository: { mergeQueue: st.mergeQueue, pullRequest: { isInMergeQueue: st.isInMergeQueue } } } })
    }
    return { code: 3, stdout: '', stderr: `fake gh: unexpected query ${query}\n` }
  }
  return { code: 3, stdout: '', stderr: `fake gh: unexpected ${args.join(' ')}\n` }
}

const makeRunGit = (st) => (args) => {
  st.gitCalls.push(args)
  const rest = args[0] === '-C' ? args.slice(2) : args
  if (rest[0] === 'remote' && rest[1] === 'get-url') {
    return st.origin === null
      ? { code: 128, stdout: '', stderr: 'fatal: No such remote \'origin\'\n' }
      : { code: 0, stdout: `${st.origin}\n`, stderr: '' }
  }
  if (rest[0] === 'rev-parse' && rest[1] === '--abbrev-ref' && rest[2] === 'HEAD') {
    return st.currentBranch === null
      ? { code: 128, stdout: '', stderr: "fatal: ambiguous argument 'HEAD': unknown revision\n" }
      : { code: 0, stdout: `${st.currentBranch}\n`, stderr: '' }
  }
  // No fetch and no show. The clone is shared with other sessions, so the executor is allowed two
  // reads, the origin remote and the checked-out branch, and anything else is a failure of this
  // smoke, not a fixture gap.
  return { code: 1, stdout: '', stderr: `fake git: unexpected ${rest.join(' ')}\n` }
}

const run = (argv = [String(PR)], { st, cwd = CWD, env = {} } = {}) => {
  const state = st || freshState()
  const result = landGates({ argv, env, cwd, runGh: makeRunGh(state), runGit: makeRunGit(state) })
  let json = null
  try { json = JSON.parse(result.stdout) } catch {}
  return { ...result, st: state, json }
}

const codes = (list) => (Array.isArray(list) ? list.map((item) => item.code) : [])
const has = (list, code) => codes(list).includes(code)
const detailOf = (list, code) => (list || []).find((item) => item.code === code)?.detail || ''

// Every gh call must name the repository derived from origin. The read that resolves a pull
// request from the current branch is the one that cannot, because gh refuses a branch once
// --repo is given. It used to be allowlisted here, which is another way of saying nothing checked
// what it came back with, so it fails this predicate now and the S2 cases prove the answer belongs
// to origin instead.
const isPinned = (args) => {
  if (args[0] === 'api' && args[1] === 'graphql') {
    return argValue(args, '--hostname') === 'github.com' &&
      formField(args, 'owner') === 'jakub' && formField(args, 'repo') === 'marketplace-plugins'
  }
  if (args[0] === 'repo' && args[1] === 'view') return args[2] === IDENTITY
  if (args[0] === 'api') {
    return argValue(args, '--hostname') === 'github.com' &&
      args.some((a) => String(a).startsWith(`repos/${SLUG}/`))
  }
  return argValue(args, '--repo') === IDENTITY
}

// Nothing this executor runs may change anything. Read-only is the whole contract, so it is
// asserted against a deny list of shapes rather than trusted from the code having no merge in it.
const MUTATIONS = [
  (a) => a[0] === 'pr' && ['merge', 'edit', 'close', 'comment', 'ready', 'review'].includes(a[1]),
  (a) => a[0] === 'issue' && ['close', 'create', 'edit', 'comment'].includes(a[1]),
  (a) => a[0] === 'run' && a[1] === 'rerun',
  (a) => a[0] === 'api' && a.some((word) => /mutation\s*[({]/.test(String(word))),
  (a) => a[0] === 'api' && (a.includes('-X') || a.includes('--method')),
]
const mutatingGh = (calls) => calls.filter((args) => MUTATIONS.some((shape) => shape(args)))
// `git remote get-url` and `git rev-parse`, and nothing else. A fetch writes objects, FETCH_HEAD
// and remote-tracking refs into a checkout other sessions share, so it counts as a mutation here.
const READ_ONLY_GIT = new Set(['remote', 'rev-parse'])
const mutatingGit = (calls) => calls.filter((args) => !READ_ONLY_GIT.has((args[0] === '-C' ? args.slice(2) : args)[0]))

// ------------------------------------------------------------------------------- a clean pass
console.log('a pull request with nothing wrong with it')
const clean = run()
check('it exits 0', clean.code === 0, `${clean.code}: ${clean.stderr}`)
check('and says pass', clean.json?.verdict === 'pass', JSON.stringify(clean.json?.stops))
check('and stops on nothing', JSON.stringify(clean.json?.stops) === '[]', JSON.stringify(clean.json?.stops))
check('and needs no attention', JSON.stringify(clean.json?.attention) === '[]', JSON.stringify(clean.json?.attention))
check('it names itself', clean.json?.command === 'land-gates')
check('and the pull request it read', clean.json?.pr === PR)
check('it reports the head the merge gets pinned to', clean.json?.head?.sha === HEAD, JSON.stringify(clean.json?.head))
check('and the head ref', clean.json?.head?.ref === BRANCH)
check('and that the base is the default branch', clean.json?.base?.isDefault === true && clean.json?.base?.ref === 'main')
check('the passing checks are named', JSON.stringify(clean.json?.ci?.success) === '["unit","lint"]', JSON.stringify(clean.json?.ci))
check('the resolved thread counts but does not block', clean.json?.threads?.total === 1 && clean.json?.threads?.unresolved.length === 0, JSON.stringify(clean.json?.threads))
check('the linked issue GitHub parsed is reported', JSON.stringify(clean.json?.linkedIssues?.linked) === '[6]', JSON.stringify(clean.json?.linkedIssues))
check('nothing is armed', clean.json?.arming?.autoMerge === false && clean.json?.arming?.mergeQueue === false, JSON.stringify(clean.json?.arming))
check('there is no follow-up draft', clean.json?.followUpDraft === null)
check('and no read failed', clean.json?.error === undefined, clean.json?.error)
check('nothing is written to stderr on a pass', clean.stderr === '', clean.stderr)
check('every gh call is pinned to the origin repository', clean.st.calls.every(isPinned), JSON.stringify(clean.st.calls.filter((a) => !isPinned(a))))
check('every git call names the working directory', clean.st.gitCalls.every((a) => a[0] === '-C' && a[1] === CWD), JSON.stringify(clean.st.gitCalls))
check('it mutates nothing through gh', mutatingGh(clean.st.calls).length === 0, JSON.stringify(mutatingGh(clean.st.calls)))
check('and nothing through git', mutatingGit(clean.st.gitCalls).length === 0, JSON.stringify(mutatingGit(clean.st.gitCalls)))
check('it read the pull request, the repository and the children', ['pr view', 'repo view', 'pr list'].every(
  (pair) => clean.st.calls.some((a) => `${a[0]} ${a[1]}` === pair),
), JSON.stringify(clean.st.calls.map((a) => `${a[0]} ${a[1]}`)))
check('and asked for the check runs, the statuses and the comments a page at a time',
  ['check-runs', 'statuses', 'comments'].every((what) => clean.st.calls.some(
    (a) => a[0] === 'api' && a.includes('--paginate') && a.includes('--slurp') &&
      a.some((word) => String(word).endsWith(`/${what}?per_page=100`)))),
  JSON.stringify(clean.st.calls.filter((a) => a[0] === 'api')))
check('the two check reads are keyed on the head the merge gets pinned to',
  ['check-runs', 'statuses'].every((what) => clean.st.calls.some(
    (a) => a[0] === 'api' && a.some((word) => String(word) === `repos/${SLUG}/commits/${HEAD}/${what}?per_page=100`))),
  JSON.stringify(clean.st.calls.filter((a) => a[0] === 'api')))
check('and gh pr checks is not called at all, because nothing needs a second naming of a check',
  !clean.st.calls.some((a) => a[0] === 'pr' && a[1] === 'checks'), JSON.stringify(clean.st.calls.map((a) => `${a[0]} ${a[1]}`)))
check('gh pr view is no longer asked for the rollup or the comments', (() => {
  const view = clean.st.calls.find((a) => a[0] === 'pr' && a[1] === 'view' && a.includes('--repo'))
  const fields = String(argValue(view || [], '--json'))
  return !fields.includes('statusCheckRollup') && !fields.includes('comments')
})(), JSON.stringify(clean.st.calls.find((a) => a[0] === 'pr' && a[1] === 'view' && a.includes('--repo'))))
check('and read the flake allowlist off the base branch through the contents API', clean.st.calls.some(
  (a) => a[0] === 'api' && a.some((word) => String(word) === `repos/${SLUG}/contents/${FLAKES_PATH}?ref=main`),
), JSON.stringify(clean.st.calls.filter((a) => a[0] === 'api')))
check('and asked git for the origin remote and nothing else',
  clean.st.gitCalls.length === 1 && clean.st.gitCalls[0].slice(2).join(' ') === 'remote get-url origin',
  JSON.stringify(clean.st.gitCalls))

// -------------------------------------------------------------------------- what stops a land
console.log('\nthe closed list of stops')
const stopsOn = (name, code, { st, argv = [String(PR)], exit = 1 } = {}) => {
  const result = run(argv, { st })
  check(name, result.code === exit && has(result.json?.stops, code) && result.json?.verdict === 'stop',
    `code ${result.code}, stops ${JSON.stringify(codes(result.json?.stops))}`)
  return result
}

stopsOn('a closed pull request', 'not-open', { st: freshState({ pr: { state: 'CLOSED' } }) })
stopsOn('an already merged one', 'not-open', { st: freshState({ pr: { state: 'MERGED' } }) })
stopsOn('a draft', 'draft', { st: freshState({ pr: { isDraft: true } }) })
stopsOn('an unreadable draft flag', 'draft', { st: freshState({ pr: { isDraft: null } }) })
// head-unreadable keeps its stop code, but it is a failed read, so it exits 4 like every other
// one. See the G6 case at the bottom.
stopsOn('an unreadable head', 'head-unreadable', { st: freshState({ pr: { headRefOid: 'short' } }), exit: 4 })

const stacked = stopsOn('a base that is not the default branch', 'stacked-on-non-default', {
  st: freshState({ pr: { baseRefName: 'feat/parent' } }),
})
check('and it says what the default branch is', detailOf(stacked.json?.stops, 'stacked-on-non-default').includes('main'),
  detailOf(stacked.json?.stops, 'stacked-on-non-default'))
check('and reports the base as not default', stacked.json?.base?.isDefault === false)

const pending = stopsOn('a check that has not finished', 'ci-pending', {
  st: freshState({ checkRuns: [checkRun('unit', 'success'), checkRun('e2e', null)] }),
})
check('the pending check is named', JSON.stringify(pending.json?.ci?.pending) === '["e2e"]', JSON.stringify(pending.json?.ci))

const failed = stopsOn('a failed check', 'ci-failed', {
  st: freshState({ checkRuns: [checkRun('unit', 'success'), checkRun('e2e', 'failure')] }),
})
check('the failure carries its link', failed.json?.ci?.failed?.[0]?.link === 'https://ci.example/e2e', JSON.stringify(failed.json?.ci?.failed))
stopsOn('a timed-out check', 'ci-failed', { st: freshState({ checkRuns: [checkRun('e2e', 'timed_out')] }) })
stopsOn('an errored commit status', 'ci-failed', {
  st: freshState({ checkRuns: [], statuses: [commitStatus('coderabbit', 'error')] }),
})

const armed = stopsOn('an armed auto-merge', 'auto-merge-armed', {
  st: freshState({ pr: { autoMergeRequest: { enabledBy: { login: 'bot' } } } }),
})
check('and the arming is reported', armed.json?.arming?.autoMerge === true)

const queued = stopsOn('a merge queue on the base', 'merge-queue', { st: freshState({ mergeQueue: { id: 'MQ_kwABC' } }) })
check('and the queue is reported', queued.json?.arming?.mergeQueue === true)
const enqueued = stopsOn('a pull request already in the queue', 'merge-queue', { st: freshState({ isInMergeQueue: true }) })
check('and that also reads as a queue', enqueued.json?.arming?.mergeQueue === true)

// Both endpoints name their own entries, so a nameless one is a malformed answer rather than the
// ordinary case the cross-read used to cover. It still has to stop the land: a check nobody can
// name is not a check anyone reviewed, however green its own field says it is.
console.log('\na check nobody can name is unknown, never green')
const unnamedRun = stopsOn('a check run with no name', 'ci-unknown', {
  st: freshState({
    checkRuns: [checkRun('unit', 'success'), { name: '', status: 'completed', conclusion: 'success', details_url: 'https://ci.example/anon', check_suite: { id: 1 } }],
  }),
})
check('it is reported with a null name', unnamedRun.json?.ci?.unknown?.[0]?.name === null, JSON.stringify(unnamedRun.json?.ci?.unknown))
check('and keeps the link it had', unnamedRun.json?.ci?.unknown?.[0]?.link === 'https://ci.example/anon', JSON.stringify(unnamedRun.json?.ci?.unknown))

const unnamedStatus = stopsOn('a commit status with no context', 'ci-unknown', {
  st: freshState({ statuses: [{ state: 'success', target_url: 'https://cr.example/status' }] }),
})
check('it is unknown however green its state', unnamedStatus.json?.ci?.unknown?.[0]?.name === null,
  JSON.stringify(unnamedStatus.json?.ci?.unknown))
check('and the named checks beside it are still counted', JSON.stringify(unnamedStatus.json?.ci?.success) === '["unit","lint"]',
  JSON.stringify(unnamedStatus.json?.ci))

// ------------------------------------------------------------------------------ known flakes
console.log('\nthe base branch decides what counts as a known flake')
const flakeState = (base, pr = null) => freshState({
  checkRuns: [checkRun('unit', 'success'), checkRun('e2e', 'failure')],
  baseFlakes: base,
  prFlakes: pr,
})

const flaky = run([String(PR)], { st: flakeState('# the browser suite is flaky\ne2e\n') })
check('a bare entry on the base moves the failure to flaky', JSON.stringify(flaky.json?.ci?.flaky) === '["e2e"]', JSON.stringify(flaky.json?.ci))
check('and nothing is left failing', JSON.stringify(flaky.json?.ci?.failed) === '[]', JSON.stringify(flaky.json?.ci?.failed))
check('so the land passes', flaky.code === 0 && flaky.json?.verdict === 'pass', `${flaky.code}: ${JSON.stringify(flaky.json?.stops)}`)
check('with the merge-through flagged for the report', has(flaky.json?.attention, 'flaky-merged-through'), JSON.stringify(flaky.json?.attention))

const added = run([String(PR)], { st: flakeState(null, 'e2e\n') })
check('the same entry added on the branch moves nothing', has(added.json?.stops, 'ci-failed') && added.code === 1,
  `${added.code}: ${JSON.stringify(codes(added.json?.stops))}`)
check('and is reported as a diff to look at', has(added.json?.attention, 'flakes-added-on-pr'), JSON.stringify(added.json?.attention))
check('naming the line the branch added', JSON.stringify(added.json?.ci?.flakesAddedOnPr) === '["e2e"]', JSON.stringify(added.json?.ci?.flakesAddedOnPr))

const sameBothSides = run([String(PR)], { st: flakeState('e2e\n', 'e2e\n') })
check('an entry present on both sides is not an addition', JSON.stringify(sameBothSides.json?.ci?.flakesAddedOnPr) === '[]',
  JSON.stringify(sameBothSides.json?.ci?.flakesAddedOnPr))

const perTest = run([String(PR)], { st: flakeState('e2e:renders_under_load\n') })
check('a check:test entry moves nothing', has(perTest.json?.stops, 'ci-failed') && perTest.code === 1,
  `${perTest.code}: ${JSON.stringify(codes(perTest.json?.stops))}`)
check('but surfaces the test to look for in the job log',
  JSON.stringify(perTest.json?.ci?.flakeCandidates) === '{"e2e":["renders_under_load"]}', JSON.stringify(perTest.json?.ci?.flakeCandidates))
check('a missing allowlist is not an error', flaky.json?.error === undefined && run([String(PR)]).json?.error === undefined)

// ---------------------------------------------------------------------------- review threads
console.log('\nreview threads are read to the end')
const paged = run([String(PR)], {
  st: freshState({
    threadPages: [
      [thread('T1'), thread('T2')],
      [thread('T3', { resolved: false, body: 'this one is still open', author: 'coderabbitai' })],
    ],
  }),
})
check('an unresolved thread on page two stops the land', paged.code === 1 && has(paged.json?.stops, 'threads-unresolved'),
  `${paged.code}: ${JSON.stringify(codes(paged.json?.stops))}`)
check('the cursor from page one is passed back', JSON.stringify(paged.st.cursors) === '[null,"cursor-1"]', JSON.stringify(paged.st.cursors))
check('all three threads are counted', paged.json?.threads?.total === 3, JSON.stringify(paged.json?.threads?.total))
check('the unresolved one carries its id, path and author',
  paged.json?.threads?.unresolved?.[0]?.id === 'T3' &&
  paged.json?.threads?.unresolved?.[0]?.author === 'coderabbitai' &&
  paged.json?.threads?.unresolved?.[0]?.path === 'plugins/flow/scripts/land-gates.mjs',
  JSON.stringify(paged.json?.threads?.unresolved))
check('and the newest comment, not the opening one',
  paged.json?.threads?.unresolved?.[0]?.lastBody === 'this one is still open', JSON.stringify(paged.json?.threads?.unresolved?.[0]))
check('a long comment body is truncated', (() => {
  const long = run([String(PR)], { st: freshState({ threadPages: [[thread('T4', { resolved: false, body: 'x'.repeat(900) })]] }) })
  const body = long.json?.threads?.unresolved?.[0]?.lastBody || ''
  return body.length === 403 && body.startsWith('x'.repeat(400))
})())

const resolvedOnly = run([String(PR)], { st: freshState({ threadPages: [[thread('T1'), thread('T2')], [thread('T3')]] }) })
check('every thread resolved is a pass', resolvedOnly.code === 0 && resolvedOnly.json?.threads?.unresolved?.length === 0,
  `${resolvedOnly.code}: ${JSON.stringify(resolvedOnly.json?.stops)}`)
check('and the second page was still read', resolvedOnly.json?.threads?.total === 3, JSON.stringify(resolvedOnly.json?.threads?.total))

// ------------------------------------------------------------------- a read that failed is not a pass
console.log('\na read that failed is unknown, never a pass')
const threadsDown = run([String(PR)], { st: freshState({ threadsFail: true }) })
check('a failed thread query exits 4', threadsDown.code === 4, `${threadsDown.code}: ${threadsDown.stderr}`)
check('and stops on threads-unreadable', has(threadsDown.json?.stops, 'threads-unreadable'), JSON.stringify(codes(threadsDown.json?.stops)))
check('and says which read failed', String(threadsDown.json?.error).includes('review-thread query'), threadsDown.json?.error)
check('and never reads as a pass', threadsDown.json?.verdict === 'stop')

const queueDown = run([String(PR)], { st: freshState({ queueFails: true }) })
check('a failed merge-queue query exits 4', queueDown.code === 4, `${queueDown.code}: ${queueDown.stderr}`)
check('and reports the queue as unknown, not absent', queueDown.json?.arming?.mergeQueue === 'unknown', JSON.stringify(queueDown.json?.arming))
check('and stops on merge-queue', has(queueDown.json?.stops, 'merge-queue'), JSON.stringify(codes(queueDown.json?.stops)))
check('the thread read survived the schema error there', queueDown.json?.threads?.total === 1, JSON.stringify(queueDown.json?.threads))

const viewDown = run([String(PR)], { st: freshState({ viewFails: true }) })
check('an unreadable pull request exits 4 with nothing to report', viewDown.code === 4 && viewDown.stdout === '', `${viewDown.code}: ${viewDown.stdout}`)
check('and says so on stderr', viewDown.stderr.includes('gh pr view'), viewDown.stderr)

const repoDown = run([String(PR)], { st: freshState({ defaultBranch: null }) })
check('an unreadable default branch exits 4', repoDown.code === 4, `${repoDown.code}: ${repoDown.stderr}`)
check('and reports the base as neither default nor not', repoDown.json?.base?.isDefault === null, JSON.stringify(repoDown.json?.base))

// -------------------------------------------------------------------------- linked issues
console.log('\nlinked issues are reported three ways and decided none')
const issuesOf = (overrides) => run([String(PR)], { st: freshState({ pr: { closingIssuesReferences: [], ...overrides } }) }).json?.linkedIssues

const byBranch = issuesOf({ headRefName: 'feat/issue-42-something', title: 'feat: something', body: 'no references here' })
check('the branch name recovers the issue', JSON.stringify(byBranch?.recovered) === '[42]', JSON.stringify(byBranch))
check('and nothing is claimed as linked', JSON.stringify(byBranch?.linked) === '[]', JSON.stringify(byBranch))

const byPhrase = issuesOf({ headRefName: 'quickfix', title: 'fix: the thing', body: 'Fixes #17 and nothing else.' })
check('a closing phrase in the body recovers the issue', JSON.stringify(byPhrase?.recovered) === '[17]', JSON.stringify(byPhrase))
check('and it is not also counted as a mention', JSON.stringify(byPhrase?.mentions) === '[]', JSON.stringify(byPhrase))

const byTitle = issuesOf({ headRefName: 'quickfix', title: 'fix: land the thing, closes #18', body: '' })
check('a closing phrase in the title recovers too', JSON.stringify(byTitle?.recovered) === '[18]', JSON.stringify(byTitle))

const partOf = issuesOf({ headRefName: 'quickfix', title: 'feat: slice 5', body: 'Part of #6, follow-up in #42.' })
check('"Part of #6" recovers nothing', JSON.stringify(partOf?.recovered) === '[]', JSON.stringify(partOf))
check('and reads as a mention instead', JSON.stringify(partOf?.mentions) === '[6,42]', JSON.stringify(partOf))

const ambiguousIssues = run([String(PR)], {
  st: freshState({ pr: { closingIssuesReferences: [], headRefName: 'feat/issue-42-thing', body: 'Part of #6.' } }),
})
check('no parsed link plus candidates is an attention item', has(ambiguousIssues.json?.attention, 'linked-issues-ambiguous'),
  JSON.stringify(ambiguousIssues.json?.attention))
check('and never a stop', !has(ambiguousIssues.json?.stops, 'linked-issues-ambiguous') && ambiguousIssues.code === 0,
  `${ambiguousIssues.code}: ${JSON.stringify(codes(ambiguousIssues.json?.stops))}`)

const parsedLink = run([String(PR)])
check('a parsed link asks nothing', !has(parsedLink.json?.attention, 'linked-issues-ambiguous'), JSON.stringify(parsedLink.json?.attention))

// --------------------------------------------------------------- children and the follow-up draft
console.log('\nfacts that need an action but are not refusals')
const withChildren = run([String(PR)], {
  st: freshState({ children: [{ number: 13, title: 'feat: the next slice', url: `https://github.com/${SLUG}/pull/13` }] }),
})
check('children are attention, not a stop', withChildren.code === 0 && has(withChildren.json?.attention, 'children'),
  `${withChildren.code}: ${JSON.stringify(withChildren.json?.attention)}`)
check('and are listed with their numbers', withChildren.json?.stacked?.children?.[0]?.number === 13, JSON.stringify(withChildren.json?.stacked))
check('the child query asked for pull requests based on this branch',
  withChildren.st.calls.some((a) => a[0] === 'pr' && a[1] === 'list' && argValue(a, '--base') === BRANCH),
  JSON.stringify(withChildren.st.calls.filter((a) => a[1] === 'list')))

const draft = run([String(PR)], {
  st: freshState({
    comments: [
      comment(1, 'looks good to me'),
      comment(2, '## Follow-up draft\n\nThe resolver wants its own issue.'),
    ],
  }),
})
check('a follow-up draft comment is found', draft.json?.followUpDraft?.id === 2, JSON.stringify(draft.json?.followUpDraft))
check('with the url a human can open, not the API one',
  draft.json?.followUpDraft?.url === `${PR_URL}#issuecomment-2`, JSON.stringify(draft.json?.followUpDraft))
check('with its body kept whole', String(draft.json?.followUpDraft?.body).includes('resolver wants its own issue'), JSON.stringify(draft.json?.followUpDraft))
check('and is attention, not a stop', draft.code === 0 && has(draft.json?.attention, 'follow-up-draft'),
  `${draft.code}: ${JSON.stringify(draft.json?.attention)}`)
check('an ordinary comment is not a draft', run([String(PR)], {
  st: freshState({ comments: [comment(1, 'we should follow up on this draft later')] }),
}).json?.followUpDraft === null)

// --------------------------------------------------------------------- arguments and refusals
console.log('\nresolving the pull request number')
const fromBranch = run([], { st: freshState({ currentBranchPr: PR }) })
check('no argument resolves from the current branch', fromBranch.code === 0 && fromBranch.json?.pr === PR, `${fromBranch.code}: ${fromBranch.stderr}`)
check('and that read names no repository, because gh refuses one there',
  fromBranch.st.calls.some((a) => a[0] === 'pr' && a[1] === 'view' && argValue(a, '--json') === 'number,url,headRefName' && !a.includes('--repo')),
  JSON.stringify(fromBranch.st.calls[0]))

const refuses = (name, argv, substring, options = {}) => {
  const result = run(argv, options)
  check(name, result.code === 2 && result.stderr.includes(substring), `code ${result.code}: ${(result.stderr || result.stdout).trim().split('\n')[0]}`)
  check(`${name}: printed no verdict`, result.stdout === '', result.stdout.slice(0, 80))
}
refuses('a branch with no pull request is a usage error', [], 'none resolves from the current branch')
refuses('a non-numeric argument is refused', ['twelve'], 'is not a pull request number')
refuses('so is a negative one', ['-3'], 'is not a pull request number')
refuses('so is zero', ['0'], 'is not a pull request number')
refuses('so is a second argument', [String(PR), HEAD], 'at most one argument')
refuses('a directory with no origin remote is refused', [String(PR)], 'no readable origin remote', { st: freshState({ origin: null }) })

const help = run(['--help'])
check('--help prints the usage and exits 0', help.code === 0 && help.stdout.includes('[<pull-request-number>]'), `${help.code}: ${help.stdout.slice(0, 80)}`)
check('and calls nothing at all', help.st.calls.length === 0 && help.st.gitCalls.length === 0, JSON.stringify(help.st.calls))

console.log('\nnothing printed carries a credential')
const leaky = run([String(PR)], { st: freshState({ origin: 'https://jakub:ghp_secrettoken@github.com/jakub/marketplace-plugins.git', threadsFail: true }) })
check('a token in the origin URL is out of the output', !leaky.stdout.includes('ghp_secrettoken') && !leaky.stderr.includes('ghp_secrettoken'),
  `${leaky.stdout}${leaky.stderr}`)
check('and the repository is still derived from it', leaky.json?.pr === PR, JSON.stringify(leaky.json?.pr))

// ------------------------------------------------------------- the findings of the two reviews
console.log('\nG1b: a commit status names itself in context, not name')
const statusContext = run([String(PR)], { st: freshState({ statuses: [commitStatus('coderabbit', 'success')] }) })
check('the context is read as the name', statusContext.json?.ci?.success?.includes('coderabbit'), JSON.stringify(statusContext.json?.ci))
check('so nothing has to join two reads to place it', statusContext.code === 0 && JSON.stringify(statusContext.json?.ci?.unknown) === '[]',
  `${statusContext.code}: ${JSON.stringify(statusContext.json?.ci?.unknown)}`)

console.log('\nG2: an allowlist read that failed is unknown, not empty')
const flakesDown = run([String(PR)], {
  st: freshState({
    checkRuns: [checkRun('unit', 'success'), checkRun('e2e', 'failure')],
    baseFlakes: 'e2e\n',
    flakesHttp: 500,
  }),
})
check('a 500 from the contents API exits 4', flakesDown.code === 4, `${flakesDown.code}: ${flakesDown.stderr}`)
check('and sets error', String(flakesDown.json?.error).includes('known-flakes'), flakesDown.json?.error)
check('and the verdict is stop', flakesDown.json?.verdict === 'stop', flakesDown.json?.verdict)
check('and the failure is not excused by an allowlist nobody read',
  JSON.stringify(flakesDown.json?.ci?.flaky) === '[]' && has(flakesDown.json?.stops, 'ci-failed'),
  JSON.stringify(flakesDown.json?.ci))

// The API answers a file over its inline size limit with empty content and encoding "none". That
// is a file nobody read, and it must not read as an allowlist with nothing in it.
const flakesUnencoded = run([String(PR)], {
  st: freshState({
    checkRuns: [checkRun('unit', 'success'), checkRun('e2e', 'failure')],
    baseFlakes: 'e2e\n',
    flakesEncoding: 'none',
  }),
})
check('an unencoded body is a failed read too', flakesUnencoded.code === 4 &&
  String(flakesUnencoded.json?.error).includes('no readable file contents'),
  `${flakesUnencoded.code}: ${flakesUnencoded.json?.error}`)

const flakesAbsent = run([String(PR)], { st: freshState({ baseFlakes: null, prFlakes: null }) })
check('G2b: a 404 is a proven-absent file and passes', flakesAbsent.code === 0 && flakesAbsent.json?.error === undefined,
  `${flakesAbsent.code}: ${flakesAbsent.json?.error}`)

console.log('\nG3: the executor never writes to the clone')
const gitOnly = run([String(PR)], { st: flakeState('e2e\n', 'e2e\nunit\n') })
const gitWords = gitOnly.st.gitCalls.map((a) => (a[0] === '-C' ? a.slice(2) : a)[0])
check('no git fetch is issued', !gitWords.includes('fetch'), JSON.stringify(gitOnly.st.gitCalls))
check('and no git show', !gitWords.includes('show'), JSON.stringify(gitOnly.st.gitCalls))
check('only the origin remote is read', JSON.stringify(gitWords) === '["remote"]', JSON.stringify(gitOnly.st.gitCalls))
check('and both allowlist copies still arrived', JSON.stringify(gitOnly.json?.ci?.flakesAddedOnPr) === '["unit"]' &&
  JSON.stringify(gitOnly.json?.ci?.flaky) === '["e2e"]', JSON.stringify(gitOnly.json?.ci))

console.log('\nG4: no checks at all is unknown, not green')
const noChecks = run([String(PR)], { st: freshState({ checkRuns: [], statuses: [] }) })
check('zero check runs and zero statuses stops on ci-unknown', noChecks.code === 1 && has(noChecks.json?.stops, 'ci-unknown'),
  `${noChecks.code}: ${JSON.stringify(codes(noChecks.json?.stops))}`)
check('and says both sources came back empty',
  detailOf(noChecks.json?.stops, 'ci-unknown').includes('no check runs and no commit statuses'),
  detailOf(noChecks.json?.stops, 'ci-unknown'))
check('and it is a stop and not a failed read, because both reads succeeded',
  noChecks.json?.error === undefined, noChecks.json?.error)

console.log('\nG5: the default branch is in the payload')
check('base.default names it', clean.json?.base?.default === 'main', JSON.stringify(clean.json?.base))
check('and it is there when the base is something else', stacked.json?.base?.default === 'main', JSON.stringify(stacked.json?.base))
check('and null when gh repo view failed', repoDown.json?.base?.default === null, JSON.stringify(repoDown.json?.base))

console.log('\nG6: an unreadable head is a failed read')
const headDown = run([String(PR)], { st: freshState({ pr: { headRefOid: 'short' } }) })
check('it exits 4', headDown.code === 4, `${headDown.code}: ${headDown.stderr}`)
check('with error set', String(headDown.json?.error).includes('head'), headDown.json?.error)
check('and keeps the stop code for the record', has(headDown.json?.stops, 'head-unreadable'), JSON.stringify(codes(headDown.json?.stops)))

console.log('\nG7: a check name may contain a colon')
const colonName = 'ci/circleci: build'
const colonCheck = run([String(PR)], {
  st: freshState({
    statuses: [commitStatus(colonName, 'failure', { target_url: 'https://circleci.example/1' })],
    baseFlakes: `${colonName}\n`,
  }),
})
check('a line that is the whole check name is a bare entry', JSON.stringify(colonCheck.json?.ci?.flaky) === `["${colonName}"]`,
  JSON.stringify(colonCheck.json?.ci))
check('so the land passes', colonCheck.code === 0 && colonCheck.json?.verdict === 'pass',
  `${colonCheck.code}: ${JSON.stringify(codes(colonCheck.json?.stops))}`)
check('and no phantom flakeCandidates were recorded', JSON.stringify(colonCheck.json?.ci?.flakeCandidates) === '{}',
  JSON.stringify(colonCheck.json?.ci?.flakeCandidates))

const stillSplits = run([String(PR)], { st: flakeState('e2e:renders_under_load\n') })
check('a check:test line that matches no check name still splits',
  JSON.stringify(stillSplits.json?.ci?.flakeCandidates) === '{"e2e":["renders_under_load"]}',
  JSON.stringify(stillSplits.json?.ci?.flakeCandidates))
check('and moves nothing', has(stillSplits.json?.stops, 'ci-failed') && stillSplits.code === 1,
  `${stillSplits.code}: ${JSON.stringify(codes(stillSplits.json?.stops))}`)

console.log('\nJ2: the remote is parsed as a URL, and a refused one is never quoted')
const TOKEN = 'ghp_sekrettoken'
// mergeQueue is armed so that a repository identity carrying the query string would be printed:
// the merge-queue stop is the one detail that quotes identity.slug.
const queryRemote = run([String(PR)], {
  st: freshState({ origin: `https://github.com/${SLUG}.git?access_token=${TOKEN}`, mergeQueue: { id: 'MQ_1' } }),
})
check('a remote with a query string is refused', queryRemote.code === 2, `${queryRemote.code}: ${queryRemote.stderr}`)
check('and prints no verdict', queryRemote.stdout === '', queryRemote.stdout.slice(0, 120))
check('the token is in neither stream', !queryRemote.stdout.includes(TOKEN) && !queryRemote.stderr.includes(TOKEN),
  `${queryRemote.stdout}${queryRemote.stderr}`)
check('and the refusal quotes no part of the remote', !queryRemote.stderr.includes('github.com'), queryRemote.stderr)
check('and says a query string is why', queryRemote.stderr.includes('query string or a fragment'), queryRemote.stderr)
check('and no gh call was made with it', queryRemote.st.calls.length === 0, JSON.stringify(queryRemote.st.calls))

const fragmentRemote = run([String(PR)], {
  st: freshState({ origin: `https://github.com/${SLUG}.git#${TOKEN}`, mergeQueue: { id: 'MQ_1' } }),
})
check('a remote with a fragment is refused too', fragmentRemote.code === 2, `${fragmentRemote.code}: ${fragmentRemote.stderr}`)
check('with the token in neither stream', !fragmentRemote.stdout.includes(TOKEN) && !fragmentRemote.stderr.includes(TOKEN),
  `${fragmentRemote.stdout}${fragmentRemote.stderr}`)

const scpRemote = run([String(PR)], { st: freshState({ origin: `git@github.com:${SLUG}.git` }) })
check('the scp-like form still yields owner and repo', scpRemote.code === 0 && scpRemote.st.calls.every(isPinned),
  `${scpRemote.code}: ${JSON.stringify(scpRemote.st.calls.filter((a) => !isPinned(a)))}`)
check('and reaches the contents API at repos/owner/repo', scpRemote.st.calls.some(
  (a) => a[0] === 'api' && a.some((word) => String(word) === `repos/${SLUG}/contents/${FLAKES_PATH}?ref=main`),
), JSON.stringify(scpRemote.st.calls.filter((a) => a[0] === 'api')))

const httpsRemote = run([String(PR)], { st: freshState({ origin: `https://github.com/${SLUG}.git` }) })
check('so does the https form with a .git suffix', httpsRemote.code === 0 && httpsRemote.st.calls.every(isPinned),
  `${httpsRemote.code}: ${JSON.stringify(httpsRemote.st.calls.filter((a) => !isPinned(a)))}`)

const noPathRemote = run([String(PR)], { st: freshState({ origin: `https://jakub:${TOKEN}@github.com/` }) })
check('a remote whose path names no repository is refused', noPathRemote.code === 2, `${noPathRemote.code}: ${noPathRemote.stderr}`)
check('without quoting the credential it carried', !noPathRemote.stderr.includes(TOKEN) && noPathRemote.stdout === '',
  `${noPathRemote.stdout}${noPathRemote.stderr}`)
check('and says the path is why', noPathRemote.stderr.includes('exactly one owner and one repository'), noPathRemote.stderr)

console.log('\nJ3: --accept-flake is the only way a check:test entry moves a check')
const perTestState = (base, conclusion = 'failure') => freshState({
  checkRuns: [checkRun('unit', 'success'), checkRun('suite', conclusion)],
  baseFlakes: base,
})

const acceptedFlake = run(['--accept-flake', 'suite:test_x', String(PR)], { st: perTestState('suite:test_x\n') })
check('an entry on the base for a failing check passes the land',
  acceptedFlake.code === 0 && acceptedFlake.json?.verdict === 'pass',
  `${acceptedFlake.code}: ${JSON.stringify(codes(acceptedFlake.json?.stops))}`)
check('the check moves from failed to flaky',
  JSON.stringify(acceptedFlake.json?.ci?.failed) === '[]' && JSON.stringify(acceptedFlake.json?.ci?.flaky) === '["suite"]',
  JSON.stringify(acceptedFlake.json?.ci))
check('and the acceptance is on the record, with the url of the job it moved',
  JSON.stringify(acceptedFlake.json?.ci?.acceptedFlakes) ===
    '[{"check":"suite","test":"test_x","link":"https://ci.example/suite"}]',
  JSON.stringify(acceptedFlake.json?.ci?.acceptedFlakes))
check('with an attention item saying it was accepted by flag',
  has(acceptedFlake.json?.attention, 'flaky-merged-through') &&
  detailOf(acceptedFlake.json?.attention, 'flaky-merged-through').includes('accepted by flag'),
  JSON.stringify(acceptedFlake.json?.attention))
check('and it names the entry for the land report',
  detailOf(acceptedFlake.json?.attention, 'flaky-merged-through').includes('--accept-flake suite:test_x'),
  detailOf(acceptedFlake.json?.attention, 'flaky-merged-through'))
check('and the read-the-log item is not also raised for it',
  acceptedFlake.json?.attention?.filter((item) => item.code === 'flaky-merged-through').length === 1,
  JSON.stringify(acceptedFlake.json?.attention))
check('the --accept-flake=entry spelling works the same way', (() => {
  const equals = run(['--accept-flake=suite:test_x', String(PR)], { st: perTestState('suite:test_x\n') })
  return equals.code === 0 && JSON.stringify(equals.json?.ci?.acceptedFlakes) ===
    '[{"check":"suite","test":"test_x","link":"https://ci.example/suite"}]'
})())

refuses('an entry the base allowlist does not declare is refused', ['--accept-flake', 'suite:test_x', String(PR)],
  '--accept-flake suite:test_x is not an entry', { st: perTestState('other:test_y\n') })
refuses('and so is one for a check that is not failing', ['--accept-flake', 'suite:test_x', String(PR)],
  'which is not among the failed checks', { st: perTestState('suite:test_x\n', 'success') })
refuses('a bare check name is refused, because the allowlist moves those itself',
  ['--accept-flake', 'suite', String(PR)], '--accept-flake suite names no test', { st: perTestState('suite:test_x\nsuite\n') })
refuses('and the flag with no value is refused', ['--accept-flake'], 'takes one check-name:test_name entry')

// Without the flag the per-test entry still moves nothing, which is the rule the flag overrides
// rather than replaces.
const unaccepted = run([String(PR)], { st: perTestState('suite:test_x\n') })
check('the same entry unaccepted still stops on ci-failed', unaccepted.code === 1 && has(unaccepted.json?.stops, 'ci-failed'),
  `${unaccepted.code}: ${JSON.stringify(codes(unaccepted.json?.stops))}`)
check('and records no acceptance', JSON.stringify(unaccepted.json?.ci?.acceptedFlakes) === '[]',
  JSON.stringify(unaccepted.json?.ci?.acceptedFlakes))
check('and still points at the job log', detailOf(unaccepted.json?.attention, 'flaky-merged-through').includes('job log'),
  detailOf(unaccepted.json?.attention, 'flaky-merged-through'))


console.log('\nJ4: one accepted test moves one check, and only where the name is unambiguous')
// Two CheckRuns can report the same name against two different jobs, and GitHub is happy to serve
// both. Acceptance used to be keyed on a set of check names and removed every failed entry whose
// name was in it, so one --accept-flake suite:test_x deleted both failures on the strength of one
// job log, which can only ever have been about one of them.
const twinSuite = (extra = {}) => freshState({
  checkRuns: [
    checkRun('unit', 'success'),
    { name: 'suite', status: 'completed', conclusion: 'failure', details_url: 'https://ci.example/suite/1', check_suite: { id: 1 } },
    { name: 'suite', status: 'completed', conclusion: 'failure', details_url: 'https://ci.example/suite/2', check_suite: { id: 1 } },
  ],
  baseFlakes: 'suite:test_x\n',
  ...extra,
})

const twinUnaccepted = run([String(PR)], { st: twinSuite() })
check('both failures of one name are reported separately', JSON.stringify(twinUnaccepted.json?.ci?.failed) ===
  '[{"name":"suite","link":"https://ci.example/suite/1"},{"name":"suite","link":"https://ci.example/suite/2"}]',
  JSON.stringify(twinUnaccepted.json?.ci?.failed))

const twinAccept = run(['--accept-flake', 'suite:test_x', String(PR)], { st: twinSuite() })
check('accepting a name two failed checks carry is refused', twinAccept.code === 2,
  `${twinAccept.code}: ${(twinAccept.stderr || twinAccept.stdout).trim().split('\n')[0]}`)
check('and no verdict is printed, so nothing reads as accepted', twinAccept.stdout === '', twinAccept.stdout.slice(0, 120))
check('the refusal names both job urls', twinAccept.stderr.includes('https://ci.example/suite/1') &&
  twinAccept.stderr.includes('https://ci.example/suite/2'), twinAccept.stderr)
check('and says the acceptance is ambiguous', twinAccept.stderr.includes('ambiguous'), twinAccept.stderr)
// The refusal prints nothing, so what became of the checks is read from the same state run without
// the flag: both are still failed and the land still stops.
check('and the same pull request without the flag still stops on both',
  twinUnaccepted.code === 1 && has(twinUnaccepted.json?.stops, 'ci-failed') &&
  twinUnaccepted.json?.ci?.failed?.length === 2 && JSON.stringify(twinUnaccepted.json?.ci?.flaky) === '[]',
  `${twinUnaccepted.code}: ${JSON.stringify(twinUnaccepted.json?.ci)}`)

// One entry of that name is the ordinary case and still moves, with the url of the job it moved.
const oneSuite = run(['--accept-flake', 'suite:test_x', String(PR)], { st: perTestState('suite:test_x\n') })
check('one failed check of that name still accepts', oneSuite.code === 0 && oneSuite.json?.verdict === 'pass',
  `${oneSuite.code}: ${JSON.stringify(codes(oneSuite.json?.stops))}`)
check('and the acceptance carries the url of the job it moved',
  oneSuite.json?.ci?.acceptedFlakes?.[0]?.link === 'https://ci.example/suite',
  JSON.stringify(oneSuite.json?.ci?.acceptedFlakes))

// Two tests of one check cannot each have been that check's only failure.
refuses('two accepted tests for one check are refused',
  ['--accept-flake', 'suite:test_a', '--accept-flake', 'suite:test_b', String(PR)],
  'both name suite', { st: perTestState('suite:test_a\nsuite:test_b\n') })

// One test each for two failing checks is not the same thing, and still works.
const twoChecks = run(['--accept-flake', 'suite:test_a', '--accept-flake', 'other:test_b', String(PR)], {
  st: freshState({
    checkRuns: [checkRun('suite', 'failure'), checkRun('other', 'failure')],
    baseFlakes: 'suite:test_a\nother:test_b\n',
  }),
})
check('but one test each for two failing checks is accepted', twoChecks.code === 0 && twoChecks.json?.verdict === 'pass',
  `${twoChecks.code}: ${JSON.stringify(codes(twoChecks.json?.stops))}`)
check('with both on the record and both checks flaky',
  JSON.stringify(twoChecks.json?.ci?.acceptedFlakes?.map((a) => `${a.check}:${a.test}`)) === '["suite:test_a","other:test_b"]' &&
  JSON.stringify(twoChecks.json?.ci?.failed) === '[]',
  JSON.stringify(twoChecks.json?.ci))

console.log('\nJ5: a closing phrase counts only where it reads as one')
// `does not fix #17` matched the same regex as `fixes #17`, so the gate recovered the issue the
// sentence said it was not closing, and with a linked issue beside it nothing asked the human.
const negated = issuesOf({
  headRefName: 'quickfix',
  title: 'fix: the thing',
  body: 'Closes #6.\nThis does not fix #17.\nIt doesn\'t close #18.\nIt never resolves #19.\n' +
    'It no longer fixes #20.\nLanded without closes #21.',
})
check('a negated closing phrase recovers nothing', JSON.stringify(negated?.recovered) === '[6]', JSON.stringify(negated))
check('and every negated number falls through to mentions', JSON.stringify(negated?.mentions) === '[17,18,19,20,21]',
  JSON.stringify(negated))

const afterNegation = issuesOf({ headRefName: 'quickfix', title: 'fix: the thing', body: 'This does not fix #17. Closes #22.' })
check('the negation reaches only its own sentence', JSON.stringify(afterNegation?.recovered) === '[22]', JSON.stringify(afterNegation))
check('and the negated one is still a mention', JSON.stringify(afterNegation?.mentions) === '[17]', JSON.stringify(afterNegation))

const quoted = issuesOf({
  headRefName: 'quickfix',
  title: 'docs: how the land stage writes a closing phrase',
  body: 'The stage writes `Closes #6` into the body.\n\n```\nFixes #17\n```\n',
})
check('a closing phrase in backticks or a fence recovers nothing', JSON.stringify(quoted?.recovered) === '[]', JSON.stringify(quoted))
check('and both numbers read as mentions instead', JSON.stringify(quoted?.mentions) === '[6,17]', JSON.stringify(quoted))

// The rule that made the negated phrase dangerous: the question was asked only when GitHub had
// parsed nothing, so one real link plus one stray phrase closed both without asking.
const strayClose = run([String(PR)], {
  st: freshState({ pr: { closingIssuesReferences: [{ number: 6 }], headRefName: 'quickfix', body: 'Also fixes #17.' } }),
})
check('a recovered number GitHub did not link is a question even beside a parsed link',
  has(strayClose.json?.attention, 'linked-issues-ambiguous'), JSON.stringify(strayClose.json?.attention))
check('the parsed link is still reported as linked', JSON.stringify(strayClose.json?.linkedIssues?.linked) === '[6]',
  JSON.stringify(strayClose.json?.linkedIssues))
check('the recovered one is named as the candidate', detailOf(strayClose.json?.attention, 'linked-issues-ambiguous').includes('#17'),
  detailOf(strayClose.json?.attention, 'linked-issues-ambiguous'))
check('and it is attention, not a stop', strayClose.code === 0 && !has(strayClose.json?.stops, 'linked-issues-ambiguous'),
  `${strayClose.code}: ${JSON.stringify(codes(strayClose.json?.stops))}`)


console.log("\nS2: the pull request resolved from the branch is proved to be this repository's")
// The one gh read this program cannot pin. In a fork checkout with an upstream remote, gh answers
// this from upstream, so the number could be upstream's; every read after it was pinned to origin,
// so an unrelated origin pull request wearing that number was gated and handed to the merge.
const branchState = (overrides = {}) => freshState({ currentBranchPr: PR, ...overrides })

const resolvedHere = run([], { st: branchState() })
check('the matching case still resolves', resolvedHere.code === 0 && resolvedHere.json?.pr === PR,
  `${resolvedHere.code}: ${resolvedHere.stderr}`)
check('and the resolution read asks for the url and the head branch too',
  resolvedHere.st.calls.some((a) => a[0] === 'pr' && a[1] === 'view' && argValue(a, '--json') === 'number,url,headRefName'),
  JSON.stringify(resolvedHere.st.calls[0]))
check('and it is the only gh call that names no repository',
  resolvedHere.st.calls.filter((a) => !isPinned(a)).length === 1 && !isPinned(resolvedHere.st.calls[0]),
  JSON.stringify(resolvedHere.st.calls.filter((a) => !isPinned(a))))
check('the branch it is checked against is read from git, and nothing else is',
  JSON.stringify(resolvedHere.st.gitCalls.map((a) => a.slice(2).join(' '))) ===
    '["remote get-url origin","rev-parse --abbrev-ref HEAD"]',
  JSON.stringify(resolvedHere.st.gitCalls))
check('and that read mutates nothing', mutatingGit(resolvedHere.st.gitCalls).length === 0,
  JSON.stringify(mutatingGit(resolvedHere.st.gitCalls)))

// Host, owner and repository are compared case-insensitively, because GitHub serves the owner and
// the repository in whatever case they were registered and a remote can spell them another way.
const casedUrl = run([], { st: branchState({ currentBranchUrl: `https://GitHub.com/Jakub/Marketplace-Plugins/pull/${PR}` }) })
check('a url differing only in case still resolves', casedUrl.code === 0 && casedUrl.json?.pr === PR,
  `${casedUrl.code}: ${casedUrl.stderr}`)

refuses('a url on another owner is refused', [], `not to ${IDENTITY}`,
  { st: branchState({ currentBranchUrl: `https://github.com/upstream/marketplace-plugins/pull/${PR}` }) })
refuses('a url on another repository is refused', [], `not to ${IDENTITY}`,
  { st: branchState({ currentBranchUrl: `https://github.com/jakub/some-other-repo/pull/${PR}` }) })
refuses('a url on another host is refused', [], `not to ${IDENTITY}`,
  { st: branchState({ currentBranchUrl: `https://ghe.example.com/jakub/marketplace-plugins/pull/${PR}` }) })
refuses('a url for another number is refused', [], 'is not the url of that pull request',
  { st: branchState({ currentBranchUrl: `https://github.com/${SLUG}/pull/${PR + 1}` }) })
refuses('a url that is not a pull request path is refused', [], 'is not the url of that pull request',
  { st: branchState({ currentBranchUrl: `https://github.com/${SLUG}/issues/${PR}` }) })
refuses('a url that does not read as a URL is refused', [], 'is not the url of that pull request',
  { st: branchState({ currentBranchUrl: 'not-a-url' }) })
refuses('a missing url is refused', [], 'reported no url for it',
  { st: branchState({ currentBranchUrl: null }) })

// The head branch is the second half of the proof: the right repository is not enough if gh
// answered from some other branch of it.
refuses('a head branch that is not the checked-out one is refused', [], 'head branch',
  { st: branchState({ currentBranchHeadRef: 'feat/issue-99-something-else' }) })
refuses('a branch that does not read back is refused', [], 'did not read back as a branch name',
  { st: branchState({ currentBranch: null }) })
refuses('and so is a detached HEAD', [], 'did not read back as a branch name',
  { st: branchState({ currentBranch: 'HEAD' }) })

const elsewhere = run([], {
  st: branchState({
    origin: 'https://jakub:ghp_secrettoken@github.com/jakub/marketplace-plugins.git',
    currentBranchUrl: `https://github.com/upstream/marketplace-plugins/pull/${PR}`,
  }),
})
check('the refusal names the repository the url pointed at',
  elsewhere.stderr.includes('github.com/upstream/marketplace-plugins'), elsewhere.stderr)
check('and quotes no part of the remote it refused for',
  !elsewhere.stderr.includes('ghp_secrettoken') && !elsewhere.stderr.includes('jakub:'), elsewhere.stderr)
check('and nothing after the refusal was read',
  elsewhere.st.calls.length === 1, JSON.stringify(elsewhere.st.calls.map((a) => `${a[0]} ${a[1]}`)))


console.log('\nP1: a per-test entry splits after the longest reported check name')
// CircleCI reports its contexts as `ci/circleci: build`, so the allowlist line
// `ci/circleci: build:flaky_test` split at the first colon into a check nobody reported. The
// entry then matched no failure, flakeCandidates came back empty, and --accept-flake refused the
// line verbatim off the allowlist it had been copied from.
const CIRCLE = 'ci/circleci: build'
const circleState = (base) => freshState({
  statuses: [commitStatus(CIRCLE, 'failure', { target_url: 'https://circleci.example/1' })],
  baseFlakes: base,
})

const circleCandidate = run([String(PR)], { st: circleState(`${CIRCLE}:flaky_test\n`) })
check('the check whose own name holds a colon owns the entry',
  JSON.stringify(circleCandidate.json?.ci?.flakeCandidates) === `{"${CIRCLE}":["flaky_test"]}`,
  JSON.stringify(circleCandidate.json?.ci?.flakeCandidates))
check('and unaccepted it still stops, which is the per-test rule',
  circleCandidate.code === 1 && has(circleCandidate.json?.stops, 'ci-failed'),
  `${circleCandidate.code}: ${JSON.stringify(codes(circleCandidate.json?.stops))}`)

const circleAccepted = run(['--accept-flake', `${CIRCLE}:flaky_test`, String(PR)], { st: circleState(`${CIRCLE}:flaky_test\n`) })
check('the line accepts in the spelling the allowlist wrote it',
  circleAccepted.code === 0 && circleAccepted.json?.verdict === 'pass',
  `${circleAccepted.code}: ${circleAccepted.stderr}`)
check('and the acceptance names the whole check',
  JSON.stringify(circleAccepted.json?.ci?.acceptedFlakes) ===
    `[{"check":"${CIRCLE}","test":"flaky_test","link":"https://circleci.example/1"}]`,
  JSON.stringify(circleAccepted.json?.ci?.acceptedFlakes))
check('which is flaky now and no longer failed',
  JSON.stringify(circleAccepted.json?.ci?.flaky) === `["${CIRCLE}"]` &&
  JSON.stringify(circleAccepted.json?.ci?.failed) === '[]',
  JSON.stringify(circleAccepted.json?.ci))

// A bare colonless name is still the whole check, and a plain check:test entry still splits at
// the colon it has.
const plainStill = run(['--accept-flake', 'suite:test_x', String(PR)], { st: perTestState('suite:test_x\n') })
check('a check name with no colon in it is unaffected',
  plainStill.code === 0 && JSON.stringify(plainStill.json?.ci?.acceptedFlakes?.map((a) => `${a.check}:${a.test}`)) === '["suite:test_x"]',
  `${plainStill.code}: ${JSON.stringify(plainStill.json?.ci?.acceptedFlakes)}`)

const noPrefix = run([String(PR)], { st: circleState('other/job: build:flaky_test\n') })
check('a line whose prefix matches no reported check still splits at the first colon',
  JSON.stringify(noPrefix.json?.ci?.flakeCandidates) === '{}' && JSON.stringify(noPrefix.json?.ci?.flaky) === '[]',
  JSON.stringify(noPrefix.json?.ci))

// Longest wins, and it has to: a repository can report both `suite` and `suite:slow`, and then
// `suite:slow:test_x` is the second one's test and not the first one's `slow:test_x`.
const bothPrefixes = run(['--accept-flake', 'suite:slow:test_x', String(PR)], {
  st: freshState({
    checkRuns: [checkRun('suite', 'success')],
    statuses: [commitStatus('suite:slow', 'failure', { target_url: 'https://ci.example/slow' })],
    baseFlakes: 'suite:slow:test_x\n',
  }),
})
check('the longer of two reported names that both fit takes the entry',
  bothPrefixes.code === 0 &&
  JSON.stringify(bothPrefixes.json?.ci?.acceptedFlakes) === '[{"check":"suite:slow","test":"test_x","link":"https://ci.example/slow"}]',
  `${bothPrefixes.code}: ${JSON.stringify(bothPrefixes.json?.ci?.acceptedFlakes)}`)

refuses('and a bare name that holds a colon is still refused as a bare name',
  ['--accept-flake', CIRCLE, String(PR)], `--accept-flake ${CIRCLE} names no test`,
  { st: circleState(`${CIRCLE}\n`) })

console.log('\nP2: a flaky name is listed once, however many jobs reported it')
// Two check runs of one name are two jobs, and the allowlist excuses the name, so the land report
// read "e2e, e2e failed and .github/known-flakes.txt lists it as flaky".
const twinFlaky = run([String(PR)], {
  st: freshState({
    checkRuns: [
      checkRun('unit', 'success'),
      { name: 'e2e', status: 'completed', conclusion: 'failure', details_url: 'https://ci.example/e2e/1', check_suite: { id: 1 } },
      { name: 'e2e', status: 'completed', conclusion: 'failure', details_url: 'https://ci.example/e2e/2', check_suite: { id: 1 } },
    ],
    baseFlakes: 'e2e\n',
  }),
})
check('both jobs of that name are excused', twinFlaky.code === 0 && twinFlaky.json?.verdict === 'pass',
  `${twinFlaky.code}: ${JSON.stringify(codes(twinFlaky.json?.stops))}`)
check('and the name is listed once', JSON.stringify(twinFlaky.json?.ci?.flaky) === '["e2e"]',
  JSON.stringify(twinFlaky.json?.ci?.flaky))
check('and named once in the attention detail',
  detailOf(twinFlaky.json?.attention, 'flaky-merged-through').split('e2e').length - 1 === 1,
  detailOf(twinFlaky.json?.attention, 'flaky-merged-through'))
check('two different flaky names are both still named',
  (() => {
    const two = run([String(PR)], {
      st: freshState({ checkRuns: [checkRun('e2e', 'failure'), checkRun('flow', 'failure')], baseFlakes: 'e2e\nflow\n' }),
    })
    return two.code === 0 && JSON.stringify(two.json?.ci?.flaky) === '["e2e","flow"]' &&
      detailOf(two.json?.attention, 'flaky-merged-through').startsWith('e2e, flow failed')
  })())


console.log('\nT1: the checks and the comments are read to the end, not to the first hundred')
// `gh pr view --json statusCheckRollup,comments` asks GraphQL for statusCheckRollup.contexts(first:
// 100) and comments(first: 100) and pages neither (gh 2.98.0). A hundred green checks with a
// hundred and first failing one exited 0 pass, and a `## follow-up draft` in the hundred and
// first comment was invisible. Both are read over the REST API now, paginated to exhaustion, so
// the size of a pull request no longer decides what the gate can see.
const past100 = run([String(PR)], {
  st: freshState({
    checkRuns: [...many(100, (i) => checkRun(`green-${i}`, 'success')), checkRun('e2e', 'failure')],
  }),
})
check('the hundred and first check run stops the land', past100.code === 1 && has(past100.json?.stops, 'ci-failed'),
  `${past100.code}: ${JSON.stringify(codes(past100.json?.stops))}`)
check('and it is named as the failure it is',
  JSON.stringify(past100.json?.ci?.failed) === '[{"name":"e2e","link":"https://ci.example/e2e"}]',
  JSON.stringify(past100.json?.ci?.failed))
check('with all hundred passing ones still counted', past100.json?.ci?.success?.length === 100,
  JSON.stringify(past100.json?.ci?.success?.length))
check('and the fake really served two pages, so the flattening is what was measured',
  past100.st.pagesServed.find((p) => p.endpoint === 'check-runs')?.pages === 2, JSON.stringify(past100.st.pagesServed))

const draftPage2 = run([String(PR)], {
  st: freshState({
    comments: [...many(100, (i) => comment(i, 'looks good to me')), comment(100, '## Follow-up draft\n\nThe resolver wants its own issue.')],
  }),
})
check('a follow-up draft in the hundred and first comment is found',
  draftPage2.code === 0 && has(draftPage2.json?.attention, 'follow-up-draft'),
  `${draftPage2.code}: ${JSON.stringify(draftPage2.json?.attention)}`)
check('and it is that comment', draftPage2.json?.followUpDraft?.id === 100, JSON.stringify(draftPage2.json?.followUpDraft))
check('and the comments read walked two pages too',
  draftPage2.st.pagesServed.find((p) => p.endpoint === 'comments')?.pages === 2, JSON.stringify(draftPage2.st.pagesServed))

// The statuses endpoint serves every status ever posted for a context, newest first. Counting the
// older one would stop the land on a failure the repository has already superseded with a rerun.
const rerun = run([String(PR)], {
  st: freshState({
    statuses: [
      commitStatus('coderabbit', 'success', { target_url: 'https://cr.example/2', created_at: '2026-09-01T10:20:00Z' }),
      commitStatus('coderabbit', 'failure', { target_url: 'https://cr.example/1', created_at: '2026-09-01T10:00:00Z' }),
    ],
  }),
})
check('the newest status of a context is the one that counts',
  rerun.code === 0 && rerun.json?.ci?.success?.includes('coderabbit'), `${rerun.code}: ${JSON.stringify(rerun.json?.ci)}`)
check('and the superseded failure is not reported beside it', JSON.stringify(rerun.json?.ci?.failed) === '[]',
  JSON.stringify(rerun.json?.ci?.failed))
check('and the context is counted once', rerun.json?.ci?.success?.filter((name) => name === 'coderabbit').length === 1,
  JSON.stringify(rerun.json?.ci?.success))

const mixed = run([String(PR)], {
  st: freshState({
    checkRuns: [
      checkRun('unit', 'success'),
      checkRun('e2e', 'failure'),
      { name: 'slow', status: 'queued', conclusion: null, details_url: 'https://ci.example/slow', check_suite: { id: 1 } },
    ],
    statuses: [commitStatus('coderabbit', 'success'), commitStatus('deploy', 'pending'), commitStatus('scan', 'error')],
  }),
})
check('a check run is partitioned on its conclusion and a commit status on its state',
  JSON.stringify(mixed.json?.ci?.success) === '["unit","coderabbit"]' &&
  JSON.stringify(mixed.json?.ci?.pending) === '["slow","deploy"]' &&
  JSON.stringify(mixed.json?.ci?.failed?.map((c) => c.name)) === '["e2e","scan"]',
  JSON.stringify(mixed.json?.ci))
check('and nothing from either source is left unknown', JSON.stringify(mixed.json?.ci?.unknown) === '[]',
  JSON.stringify(mixed.json?.ci?.unknown))

const inFlight = run([String(PR)], {
  st: freshState({
    checkRuns: [checkRun('unit', 'success'), { name: 'e2e', status: 'in_progress', conclusion: 'failure', details_url: 'https://ci.example/e2e', check_suite: { id: 1 } }],
  }),
})
check('a check run that has not completed is pending, whatever conclusion it still carries',
  has(inFlight.json?.stops, 'ci-pending') && !has(inFlight.json?.stops, 'ci-failed'),
  JSON.stringify(codes(inFlight.json?.stops)))

// A page that failed is a failed read, the same rule the review threads follow. None of these may
// come back as a short list, because a short list of checks is what a green verdict is made of.
const checkRunsDown = run([String(PR)], { st: freshState({ apiFail: 'check-runs' }) })
check('a check-runs read that failed exits 4', checkRunsDown.code === 4, `${checkRunsDown.code}: ${checkRunsDown.stderr}`)
check('and says which read it was', String(checkRunsDown.json?.error).includes('check runs'), checkRunsDown.json?.error)
check('and never reads as a pass', checkRunsDown.json?.verdict === 'stop', checkRunsDown.json?.verdict)

const statusesDown = run([String(PR)], { st: freshState({ apiFail: 'statuses' }) })
check('so does a statuses read that failed',
  statusesDown.code === 4 && String(statusesDown.json?.error).includes('commit statuses'),
  `${statusesDown.code}: ${statusesDown.json?.error}`)
check('and the check runs it did read are not a verdict on their own', statusesDown.json?.verdict === 'stop',
  statusesDown.json?.verdict)

const commentsDown = run([String(PR)], { st: freshState({ apiFail: 'comments' }) })
check('and a comments read that failed', commentsDown.code === 4 && String(commentsDown.json?.error).includes('comments'),
  `${commentsDown.code}: ${commentsDown.json?.error}`)
check('because comments nobody read cannot say there is no follow-up draft', commentsDown.json?.verdict === 'stop',
  commentsDown.json?.verdict)

const notPages = run([String(PR)], { st: freshState({ apiShape: 'not-pages' }) })
check('a document that is not an array of pages is a failed read too',
  notPages.code === 4 && String(notPages.json?.error).includes('array of pages'),
  `${notPages.code}: ${notPages.json?.error}`)
const noRunsKey = run([String(PR)], { st: freshState({ apiShape: 'no-check-runs-key' }) })
check('and so is a page with no check_runs array in it',
  noRunsKey.code === 4 && String(noRunsKey.json?.error).includes('check_runs'),
  `${noRunsKey.code}: ${noRunsKey.json?.error}`)
check('and neither is mistaken for a pull request with no checks',
  !has(notPages.json?.stops, 'ci-unknown') && !has(noRunsKey.json?.stops, 'ci-unknown'),
  JSON.stringify([codes(notPages.json?.stops), codes(noRunsKey.json?.stops)]))


console.log('\nT2: a check-run read that cannot be proven complete fails closed')
// The check-runs endpoint serves a ref's runs from at most the most recent 1000 check suites on
// it and truncates in silence, so walking every page it offers is not proof that the list is
// whole. Two facts stand in for that proof. The number of runs collected has to equal the
// total_count the first page reported, and the commit has to carry fewer than 1000 check suites,
// counted by one read of its check-suites collection. Failing either is ci-unknown and exit 4,
// because a list of checks that is short in a way nothing can see reads exactly like a list of
// checks that all passed.
//
// The suite count comes from the suite collection and never from the check_suite ids on the runs.
// A check suite can exist with no runs in it, and it takes up one of the 1000 places all the
// same, so counting ids off the runs undercounts and the undercount always reads green. That is
// also why a run GitHub served without a check_suite.id stops this read instead of being skipped.

const shortRead = run([String(PR)], {
  st: freshState({ checkRuns: many(100, (i) => checkRun(`green-${i}`, 'success')), checkRunsTotal: 101 }),
})
check('a first page reporting 101 runs when 100 arrived exits 4', shortRead.code === 4,
  `${shortRead.code}: ${shortRead.stderr}`)
check('and stops on ci-unknown', has(shortRead.json?.stops, 'ci-unknown'), JSON.stringify(codes(shortRead.json?.stops)))
check('and the detail names the count it collected and the count GitHub reported',
  /\b100\b/.test(detailOf(shortRead.json?.stops, 'ci-unknown')) && /\b101\b/.test(detailOf(shortRead.json?.stops, 'ci-unknown')),
  detailOf(shortRead.json?.stops, 'ci-unknown'))
check('and it never reads as a pass', shortRead.json?.verdict === 'stop', shortRead.json?.verdict)
check('and the hundred green runs it did read are not a verdict on their own',
  shortRead.json?.ci?.success?.length === 100, JSON.stringify(shortRead.json?.ci?.success?.length))

// 1000 suites on the commit, 999 of which served a green run. The thousandth is the empty one,
// and the failing run in the suite past it is what this read cannot see.
const atSuiteCap = run([String(PR)], {
  st: freshState({ checkRuns: many(999, (i) => checkRun(`green-${i}`, 'success')), checkSuites: 1000 }),
})
check('a commit carrying a thousand check suites exits 4 with every run it served green',
  atSuiteCap.code === 4, `${atSuiteCap.code}: ${atSuiteCap.stderr}`)
check('and stops on ci-unknown', has(atSuiteCap.json?.stops, 'ci-unknown'), JSON.stringify(codes(atSuiteCap.json?.stops)))
check('and the detail names the window and points at enumerating the suites',
  /\b1000\b/.test(detailOf(atSuiteCap.json?.stops, 'ci-unknown')) &&
    /Enumerate the check suites/.test(detailOf(atSuiteCap.json?.stops, 'ci-unknown')),
  detailOf(atSuiteCap.json?.stops, 'ci-unknown'))
check('and nothing calls it a pass', atSuiteCap.json?.verdict === 'stop', atSuiteCap.json?.verdict)

const underSuiteCap = run([String(PR)], {
  st: freshState({ checkRuns: many(999, (i) => checkRun(`green-${i}`, 'success')), checkSuites: 999 }),
})
check('999 suites is still a pass', underSuiteCap.code === 0, `${underSuiteCap.code}: ${underSuiteCap.stderr}`)
check('and stops on nothing', JSON.stringify(underSuiteCap.json?.stops) === '[]', JSON.stringify(underSuiteCap.json?.stops))
check('with every run counted', underSuiteCap.json?.ci?.success?.length === 999,
  JSON.stringify(underSuiteCap.json?.ci?.success?.length))

const suitesDown = run([String(PR)], { st: freshState({ apiFail: 'check-suites' }) })
check('a check-suite read that failed exits 4', suitesDown.code === 4, `${suitesDown.code}: ${suitesDown.stderr}`)
check('and stops on ci-unknown', has(suitesDown.json?.stops, 'ci-unknown'), JSON.stringify(codes(suitesDown.json?.stops)))
check('and the two green runs it did read are not a verdict on their own', suitesDown.json?.verdict === 'stop',
  suitesDown.json?.verdict)

const suitesNoTotal = run([String(PR)], { st: freshState({ checkSuites: null }) })
check('so does a check-suite answer with no total_count in it',
  suitesNoTotal.code === 4 && has(suitesNoTotal.json?.stops, 'ci-unknown'),
  `${suitesNoTotal.code}: ${JSON.stringify(codes(suitesNoTotal.json?.stops))}`)

const suiteless = run([String(PR)], {
  st: freshState({ checkRuns: [checkRun('unit', 'success'), suitelessRun('e2e', 'success')] }),
})
check('a check run served with no check_suite.id exits 4', suiteless.code === 4,
  `${suiteless.code}: ${suiteless.stderr}`)
check('and stops on ci-unknown naming the run', has(suiteless.json?.stops, 'ci-unknown') &&
  detailOf(suiteless.json?.stops, 'ci-unknown').includes('e2e'), detailOf(suiteless.json?.stops, 'ci-unknown'))
check('and is never a pass on the run that did name its suite', suiteless.json?.verdict === 'stop',
  suiteless.json?.verdict)

const suiteCalls = clean.st.calls.filter((a) => a[0] === 'api' && a.some((word) => String(word).includes('/check-suites?')))
check('the suite count is read twice, once on each side of the collection', suiteCalls.length === 2,
  JSON.stringify(suiteCalls))
check('both pinned to the host, asking for one page of one, and never paginated',
  suiteCalls.every((call) => argValue(call, '--hostname') === 'github.com' &&
    call.some((word) => String(word) === `repos/${SLUG}/commits/${HEAD}/check-suites?per_page=1`) &&
    !call.includes('--paginate')),
  JSON.stringify(suiteCalls))

const wholeRead = run([String(PR)], { st: freshState({ checkRuns: many(150, (i) => checkRun(`green-${i}`, 'success')) }) })
check('a total_count that matches what arrived passes', wholeRead.code === 0, `${wholeRead.code}: ${wholeRead.stderr}`)
check('over two pages, so the count is of the flattened list',
  wholeRead.st.pagesServed.find((p) => p.endpoint === 'check-runs')?.pages === 2,
  JSON.stringify(wholeRead.st.pagesServed))
check('with all 150 runs counted', wholeRead.json?.verdict === 'pass' && wholeRead.json?.ci?.success?.length === 150,
  JSON.stringify(wholeRead.json?.stops))

console.log('\nT3: the collection is bracketed by counts, and a count that moved stops the land')
// The check-runs pages and the count that proves them whole are two snapshots, and GitHub does
// not hold still between them. A suite plus a failing run created after the pages were walked
// used to land: the two runs collected were green, the suite count agreed with itself, and the
// verdict was pass. So the counts are taken twice, before the pages and after them, and anything
// that moved in between is ci-unknown. A check that registers after the closing bracket is not
// this program's to catch. The merge pins the head with --match-head-commit, and the stage runs
// it only on a pass with no mutation since.

const order = ['check-suites', 'check-runs', 'statuses', 'check-runs', 'check-suites', 'statuses']
check('the commit reads bracket the collection, suites first and statuses last',
  JSON.stringify(clean.st.commitReads.map((r) => r.endpoint)) === JSON.stringify(order),
  JSON.stringify(clean.st.commitReads))
check('the runs are read in full on both sides, and the suite counts are one page of one',
  JSON.stringify(clean.st.commitReads.map((r) => `${r.paginated ? 'paged' : 'one'}:${r.perPage}`)) ===
    JSON.stringify(['one:1', 'paged:100', 'paged:100', 'paged:100', 'one:1', 'one:100']),
  JSON.stringify(clean.st.commitReads))

const suiteAppeared = run([String(PR)], { st: freshState({ checkSuites: [1, 2] }) })
check('a suite count that answers 1 and then 2 exits 4', suiteAppeared.code === 4,
  `${suiteAppeared.code}: ${suiteAppeared.stderr}`)
check('and stops on ci-unknown naming both counts',
  has(suiteAppeared.json?.stops, 'ci-unknown') &&
    /moved from 1 to 2/.test(detailOf(suiteAppeared.json?.stops, 'ci-unknown')),
  detailOf(suiteAppeared.json?.stops, 'ci-unknown'))
check('and the two green runs it collected are not a verdict on their own',
  suiteAppeared.json?.verdict === 'stop', suiteAppeared.json?.verdict)

const runAppeared = run([String(PR)], {
  st: (() => {
    const st = freshState()
    return { ...st, checkRunsAfter: [...st.checkRuns, checkRun('e2e', 'success')] }
  })(),
})
check('a check-run count that answers 2 and then 3 exits 4', runAppeared.code === 4,
  `${runAppeared.code}: ${runAppeared.stderr}`)
check('and stops on ci-unknown naming both counts',
  has(runAppeared.json?.stops, 'ci-unknown') &&
    /moved from 2 to 3/.test(detailOf(runAppeared.json?.stops, 'ci-unknown')),
  detailOf(runAppeared.json?.stops, 'ci-unknown'))
check('and it is the check-run count that is named, not the suites',
  detailOf(runAppeared.json?.stops, 'ci-unknown').startsWith('the check-run count'),
  detailOf(runAppeared.json?.stops, 'ci-unknown'))

// The statuses endpoint reports no total_count, so the bracket re-reads its first page and
// compares the newest id under each context. CodeRabbit posting again mid-gate is this case.
const statusMoved = run([String(PR)], {
  st: freshState({
    statuses: [commitStatus('coderabbit', 'success')],
    statusesAfter: [commitStatus('coderabbit', 'failure')],
  }),
})
check('a commit status posted again while the gate was reading exits 4', statusMoved.code === 4,
  `${statusMoved.code}: ${statusMoved.stderr}`)
check('and stops on ci-unknown naming the statuses',
  has(statusMoved.json?.stops, 'ci-unknown') &&
    detailOf(statusMoved.json?.stops, 'ci-unknown').startsWith('the first page of commit statuses'),
  detailOf(statusMoved.json?.stops, 'ci-unknown'))

const steady = run([String(PR)], { st: freshState({ checkSuites: [2, 2], checkRunsTotal: [2, 2] }) })
check('counts that hold still across the brackets pass', steady.code === 0, `${steady.code}: ${steady.stderr}`)
check('and stop on nothing', JSON.stringify(steady.json?.stops) === '[]', JSON.stringify(steady.json?.stops))
check('and no read failed', steady.json?.error === undefined, steady.json?.error)

console.log('\nT4: a check run that changed where it stood between the brackets stops the land')
// The counts held still and the gate still had it wrong. GitHub PATCHes a check run in place, so
// a run someone re-requested goes back to in_progress under the same id, and a run that was green
// when the pages were walked can be red a second later. Neither moves the number of runs or the
// number of suites. So the closing bracket reads the runs in full and compares every one of them
// on id, name, status and conclusion, and a run that moved is ci-unknown with its id named. The
// name is in there because the flake allowlist keys on it, so a rename can launder an excuse.

const rerunning = checkRun('unit', 'success')
const steadyMate = checkRun('lint', 'skipped')

const requeued = run([String(PR)], {
  st: freshState({
    checkRuns: [rerunning, steadyMate],
    checkRunsAfter: [{ ...rerunning, status: 'in_progress', conclusion: null }, steadyMate],
  }),
})
check('a run re-requested back to in_progress under the same id exits 4', requeued.code === 4,
  `${requeued.code}: ${requeued.stderr}`)
check('and stops on ci-unknown naming that run id',
  has(requeued.json?.stops, 'ci-unknown') &&
    detailOf(requeued.json?.stops, 'ci-unknown').includes(`run id ${rerunning.id}`),
  detailOf(requeued.json?.stops, 'ci-unknown'))
check('and says one run changed state, not that a count moved',
  detailOf(requeued.json?.stops, 'ci-unknown').startsWith('1 check run(s)') &&
    detailOf(requeued.json?.stops, 'ci-unknown').includes('changed state'),
  detailOf(requeued.json?.stops, 'ci-unknown'))
check('and the run that held still is not named',
  !detailOf(requeued.json?.stops, 'ci-unknown').includes(`run id ${steadyMate.id}`),
  detailOf(requeued.json?.stops, 'ci-unknown'))
check('and the green it read first is never the verdict', requeued.json?.verdict === 'stop', requeued.json?.verdict)
check('and the closing read of the runs is paginated, the same read as the collection',
  requeued.st.commitReads.filter((r) => r.endpoint === 'check-runs')
    .every((r) => r.paginated && r.perPage === '100') &&
    requeued.st.commitReads.filter((r) => r.endpoint === 'check-runs').length === 2,
  JSON.stringify(requeued.st.commitReads))

const wentRed = run([String(PR)], {
  st: freshState({
    checkRuns: [rerunning, steadyMate],
    checkRunsAfter: [{ ...rerunning, conclusion: 'failure' }, steadyMate],
  }),
})
check('a run that flipped from success to failure in place exits 4', wentRed.code === 4,
  `${wentRed.code}: ${wentRed.stderr}`)
check('and stops on ci-unknown naming that run id',
  has(wentRed.json?.stops, 'ci-unknown') &&
    detailOf(wentRed.json?.stops, 'ci-unknown').includes(`run id ${rerunning.id}`),
  detailOf(wentRed.json?.stops, 'ci-unknown'))
check('and never reports the stale success as a pass', wentRed.json?.verdict === 'stop', wentRed.json?.verdict)

const steadyRuns = run([String(PR)], {
  st: freshState({ checkRuns: [rerunning, steadyMate], checkRunsAfter: [rerunning, steadyMate] }),
})
check('two reads of the same runs pass', steadyRuns.code === 0, `${steadyRuns.code}: ${steadyRuns.stderr}`)
check('and stop on nothing', JSON.stringify(steadyRuns.json?.stops) === '[]', JSON.stringify(steadyRuns.json?.stops))
check('and no read failed', steadyRuns.json?.error === undefined, steadyRuns.json?.error)

// The closing read has to prove itself the same way the collection does.
const secondShort = run([String(PR)], { st: freshState({ checkRunsTotal: [2, 3] }) })
check('a closing read that collected 2 while reporting total_count 3 exits 4', secondShort.code === 4,
  `${secondShort.code}: ${secondShort.stderr}`)
check('and says it was the second read that came back short',
  detailOf(secondShort.json?.stops, 'ci-unknown').startsWith('the second check-run read'),
  detailOf(secondShort.json?.stops, 'ci-unknown'))

// The name is in the fingerprint because GitHub's update endpoint accepts a new one and the
// allowlist keys on it. A failed run called e2e that the base branch excuses, renamed to
// security-scan under the same id and the same conclusion, would otherwise carry the excuse it
// earned under the old name straight into a pass.
const unitRun = checkRun('unit', 'success')
const excused = checkRun('e2e', 'failure')

const excusedSteady = run([String(PR)], {
  st: freshState({ checkRuns: [unitRun, excused], checkRunsAfter: [unitRun, excused], baseFlakes: 'e2e\n' }),
})
check('a failed run the base allowlist names is merged through when it holds still',
  excusedSteady.code === 0 && has(excusedSteady.json?.attention, 'flaky-merged-through'),
  `${excusedSteady.code}: ${JSON.stringify(excusedSteady.json?.attention)}`)

const renamed = run([String(PR)], {
  st: freshState({
    checkRuns: [unitRun, excused],
    checkRunsAfter: [unitRun, { ...excused, name: 'security-scan' }],
    baseFlakes: 'e2e\n',
  }),
})
check('the same run renamed between the reads exits 4', renamed.code === 4, `${renamed.code}: ${renamed.stderr}`)
check('and stops on ci-unknown naming that run id',
  has(renamed.json?.stops, 'ci-unknown') &&
    detailOf(renamed.json?.stops, 'ci-unknown').includes(`run id ${excused.id}`),
  detailOf(renamed.json?.stops, 'ci-unknown'))
check('and the excuse it earned under the old name is never a pass',
  renamed.json?.verdict === 'stop' && renamed.json?.ci?.flaky?.includes('e2e'),
  `${renamed.json?.verdict}: ${JSON.stringify(renamed.json?.ci?.flaky)}`)
check('and no count moved, so it is the name that stopped it',
  renamed.json?.ci?.failed?.length === 0 && !has(renamed.json?.stops, 'ci-failed'),
  JSON.stringify(codes(renamed.json?.stops)))

console.log('\nC1: an origin that names a port is refused, because the gh pin cannot carry one')
// `gh --hostname` and `--repo host/owner/repo` both take a bare host: everything after the colon
// is dropped. A clone whose origin is https://github.com:8443/owner/repo therefore has git
// talking to port 8443 while every gate here reads port 443, and no line of the verdict says the
// two answers came from different servers. Refused, in all three spellings a port arrives in.
const ported = (label, origin) => {
  const result = run([String(PR)], { st: freshState({ origin }) })
  check(`${label} is refused`, result.code === 2 && result.stderr.includes('names a port'),
    `${result.code}: ${result.stderr}`)
  check(`${label}: printed no verdict`, result.stdout === '', result.stdout.slice(0, 120))
  check(`${label}: gh was never called`, result.st.calls.length === 0, JSON.stringify(result.st.calls))
  check(`${label}: the remote is not quoted back`, !result.stderr.includes(SLUG), result.stderr)
}
ported('an https origin with a port', `https://github.com:8443/${SLUG}.git`)
ported('an ssh:// origin with a port', `ssh://git@github.com:2222/${SLUG}.git`)
ported('an scp-like origin whose path opens with a port', `git@github.com:2222/${SLUG}.git`)

console.log('\nC2: only a host on the allowlist is handed to gh')
// gh sends whatever credential it holds for a host, GH_ENTERPRISE_TOKEN included, to the host it
// is pinned to. That pin comes from .git/config, which is a file any branch of any pull request
// can rewrite, so the set of hosts worth sending a token to is read from the environment instead.
const GHE = 'ghe.example'
const gheOrigin = `git@${GHE}:${SLUG}.git`
const pinnedElsewhere = (host) => (args) => {
  if (args[0] === 'repo' && args[1] === 'view') return args[2] === `${host}/${SLUG}`
  if (args[0] === 'api') return argValue(args, '--hostname') === host
  return argValue(args, '--repo') === `${host}/${SLUG}`
}
const foreign = run([String(PR)], { st: freshState({ origin: gheOrigin }) })
check('a host the allowlist does not name is refused', foreign.code === 2 && foreign.stderr.includes(GHE),
  `${foreign.code}: ${foreign.stderr}`)
check('and gh was never called with it', foreign.st.calls.length === 0, JSON.stringify(foreign.st.calls))
check('and the refusal says which variable widens the list', foreign.stderr.includes('FLOW_GH_HOSTS'), foreign.stderr)
check('and quotes no other part of the remote', !foreign.stderr.includes(SLUG), foreign.stderr)

const widened = run([String(PR)], { st: freshState({ origin: gheOrigin }), env: { FLOW_GH_HOSTS: GHE } })
check('FLOW_GH_HOSTS admits that host', widened.st.calls.length > 0 && !widened.stderr.includes('FLOW_GH_HOSTS'),
  `${widened.code}: ${widened.stderr}`)
check('and every call is pinned to it', widened.st.calls.every(pinnedElsewhere(GHE)),
  JSON.stringify(widened.st.calls.filter((a) => !pinnedElsewhere(GHE)(a))))

const alsoDefault = run([String(PR)], { env: { FLOW_GH_HOSTS: GHE } })
check('and naming another host does not unseat github.com', alsoDefault.code === 0 && alsoDefault.st.calls.every(isPinned),
  `${alsoDefault.code}: ${alsoDefault.stderr}`)
const commaHosts = run([String(PR)], { st: freshState({ origin: gheOrigin }), env: { FLOW_GH_HOSTS: ` other.example , ${GHE.toUpperCase()} ` } })
check('the list splits on commas, trims, and is read case-insensitively',
  commaHosts.st.calls.length > 0, `${commaHosts.code}: ${commaHosts.stderr}`)

console.log(bad === 0 ? `\nland gates: ALL PASS (${total} checks)` : `\nland gates: ${bad} FAILURE(S) of ${total} checks`)
process.exit(bad === 0 ? 0 : 1)
