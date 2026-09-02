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
// failures. Review threads are paged to the end and a page that never arrives is unreadable
// rather than clean. An armed auto-merge and a merge queue both stop. Children based on this
// branch, a follow-up draft comment, an allowlist entry added on the branch and an ambiguous set
// of linked issues are reported as attention rather than as stops. And through all of it the
// executor calls nothing that mutates: the whole point of splitting it out of land-merge.mjs is
// that running it can never change anything, which now includes the local clone - the allowlist
// arrives over the contents API, and the two git reads left are `git remote get-url origin` and,
// only on the run that was given no number, `git rev-parse --abbrev-ref HEAD`.
//
// The last sections are one case per finding from the reviews of 2026-09-01, kept together and
// named by finding so that a regression says which rule came back. G1 to G7 are the first two
// reviews; J1 to J3 are the third, and they are the ones that cost a real green: a details url
// that two checks share, a repository identity that swallowed a query string, and a per-test
// flake entry that could never reach the pass the merge needs. S2 is the fourth review's: the
// pull request gh resolves from the current branch, which was taken on trust and could belong to
// another repository entirely. P1 and P2 are the two smaller ones beside it, both about a check
// whose name this program then wrote down wrong.
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
const checkRun = (name, conclusion, extra = {}) => ({
  name, status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED', conclusion, detailsUrl: `https://ci.example/${name}`, ...extra,
})

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
  rollup: [checkRun('unit', 'SUCCESS'), checkRun('lint', 'SKIPPED')],
  checks: [],            // what `gh pr checks --json` answers; null means the subcommand fails
  checksExit: 0,
  checksStderr: '',      // what it says alongside, which is where "no checks reported" arrives
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
    return ok({ ...st.pr, statusCheckRollup: st.rollup, comments: st.comments })
  }
  if (args[0] === 'repo' && args[1] === 'view') {
    return st.defaultBranch === null
      ? { code: 1, stdout: '', stderr: 'fake gh: repo view failed\n' }
      : ok({ defaultBranchRef: { name: st.defaultBranch } })
  }
  if (args[0] === 'pr' && args[1] === 'list') return ok(st.children)
  if (args[0] === 'pr' && args[1] === 'checks') {
    // The real `gh pr checks` exits non-zero whenever a check is failing or pending, and still
    // prints its JSON. The executor has to read the body regardless of the exit code.
    if (st.checks === null) return { code: 1, stdout: '', stderr: 'fake gh: unknown flag --json\n' }
    return { code: st.checksExit, stdout: JSON.stringify(st.checks), stderr: st.checksStderr }
  }
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
check('it read the pull request, the repo, the children and the checks', ['pr view', 'repo view', 'pr list', 'pr checks'].every(
  (pair) => clean.st.calls.some((a) => `${a[0]} ${a[1]}` === pair),
), JSON.stringify(clean.st.calls.map((a) => `${a[0]} ${a[1]}`)))
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
  st: freshState({ rollup: [checkRun('unit', 'SUCCESS'), checkRun('e2e', null)] }),
})
check('the pending check is named', JSON.stringify(pending.json?.ci?.pending) === '["e2e"]', JSON.stringify(pending.json?.ci))

const failed = stopsOn('a failed check', 'ci-failed', {
  st: freshState({ rollup: [checkRun('unit', 'SUCCESS'), checkRun('e2e', 'FAILURE')] }),
})
check('the failure carries its link', failed.json?.ci?.failed?.[0]?.link === 'https://ci.example/e2e', JSON.stringify(failed.json?.ci?.failed))
stopsOn('a timed-out check', 'ci-failed', { st: freshState({ rollup: [checkRun('e2e', 'TIMED_OUT')] }) })
stopsOn('an errored commit status', 'ci-failed', { st: freshState({ rollup: [{ name: 'coderabbit', state: 'ERROR', targetUrl: 'https://cr.example/1' }] }) })

const armed = stopsOn('an armed auto-merge', 'auto-merge-armed', {
  st: freshState({ pr: { autoMergeRequest: { enabledBy: { login: 'bot' } } } }),
})
check('and the arming is reported', armed.json?.arming?.autoMerge === true)

const queued = stopsOn('a merge queue on the base', 'merge-queue', { st: freshState({ mergeQueue: { id: 'MQ_kwABC' } }) })
check('and the queue is reported', queued.json?.arming?.mergeQueue === true)
const enqueued = stopsOn('a pull request already in the queue', 'merge-queue', { st: freshState({ isInMergeQueue: true }) })
check('and that also reads as a queue', enqueued.json?.arming?.mergeQueue === true)

// A commit status a passing state cannot be attributed to any check name is unknown, not green.
console.log('\na check nobody can name is unknown, never green')
const nameless = { name: null, state: null, conclusion: null, targetUrl: 'https://cr.example/status' }
const unnamed = stopsOn('a nameless rollup entry the cross-read cannot place', 'ci-unknown', {
  st: freshState({ rollup: [checkRun('unit', 'SUCCESS'), nameless], checks: null }),
})
check('it is reported with a null name', unnamed.json?.ci?.unknown?.[0]?.name === null, JSON.stringify(unnamed.json?.ci?.unknown))
check('and keeps the link it had', unnamed.json?.ci?.unknown?.[0]?.link === 'https://cr.example/status', JSON.stringify(unnamed.json?.ci?.unknown))

const crossed = run([String(PR)], {
  st: freshState({
    rollup: [checkRun('unit', 'SUCCESS'), nameless],
    checks: [
      { name: 'unit', state: 'SUCCESS', bucket: 'pass', link: 'https://ci.example/unit' },
      { name: 'CodeRabbit', state: 'SUCCESS', bucket: 'pass', link: 'https://cr.example/status' },
    ],
  }),
})
check('the checks cross-read gives it a name and a state', crossed.code === 0 && crossed.json?.ci?.success?.includes('CodeRabbit'),
  `code ${crossed.code}: ${JSON.stringify(crossed.json?.ci)}`)
check('and nothing is left unknown', JSON.stringify(crossed.json?.ci?.unknown) === '[]', JSON.stringify(crossed.json?.ci?.unknown))

const ambiguous = run([String(PR)], {
  st: freshState({
    rollup: [nameless, { name: null, state: null, conclusion: null }],
    checks: [{ name: 'one', state: 'SUCCESS', bucket: 'pass', link: null }],
  }),
})
check('two nameless entries and one leftover name are not guessed at',
  ambiguous.code === 1 && ambiguous.json?.ci?.unknown?.length === 2 && has(ambiguous.json?.stops, 'ci-unknown'),
  JSON.stringify(ambiguous.json?.ci))

// ------------------------------------------------------------------------------ known flakes
console.log('\nthe base branch decides what counts as a known flake')
const flakeState = (base, pr = null) => freshState({
  rollup: [checkRun('unit', 'SUCCESS'), checkRun('e2e', 'FAILURE')],
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
      { id: 'C1', url: `${PR_URL}#issuecomment-1`, body: 'looks good to me' },
      { id: 'C2', url: `${PR_URL}#issuecomment-2`, body: '## Follow-up draft\n\nThe resolver wants its own issue.' },
    ],
  }),
})
check('a follow-up draft comment is found', draft.json?.followUpDraft?.id === 'C2', JSON.stringify(draft.json?.followUpDraft))
check('with its body kept whole', String(draft.json?.followUpDraft?.body).includes('resolver wants its own issue'), JSON.stringify(draft.json?.followUpDraft))
check('and is attention, not a stop', draft.code === 0 && has(draft.json?.attention, 'follow-up-draft'),
  `${draft.code}: ${JSON.stringify(draft.json?.attention)}`)
check('an ordinary comment is not a draft', run([String(PR)], {
  st: freshState({ comments: [{ id: 'C1', url: PR_URL, body: 'we should follow up on this draft later' }] }),
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
console.log('\nG1: a name is never guessed by position')
// Both reads list two entries, so the counts agree and the old code paired them by index. The
// order of a rollup and the order of `gh pr checks` are unrelated, so the failure drew the name
// on the allowlist and the whole land went green.
const positional = run([String(PR)], {
  st: freshState({
    rollup: [
      { name: null, conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: null },
      { name: null, conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: null },
    ],
    checks: [
      { name: 'unit', state: 'FAILURE', bucket: 'fail', link: null },
      { name: 'e2e', state: 'SUCCESS', bucket: 'pass', link: null },
    ],
    baseFlakes: 'unit\n',
  }),
})
check('nameless entries with no url stay unknown', positional.json?.ci?.unknown?.length === 2, JSON.stringify(positional.json?.ci))
check('and stop the land', positional.code === 1 && has(positional.json?.stops, 'ci-unknown'),
  `${positional.code}: ${JSON.stringify(codes(positional.json?.stops))}`)
check('and no failure is excused as flaky', JSON.stringify(positional.json?.ci?.flaky) === '[]', JSON.stringify(positional.json?.ci?.flaky))
check('and nothing was named unit', !JSON.stringify(positional.json?.ci).includes('unit'), JSON.stringify(positional.json?.ci))

console.log('\nG1b: a commit status names itself in context, not name')
const statusContext = run([String(PR)], {
  st: freshState({
    rollup: [checkRun('unit', 'SUCCESS'), { context: 'coderabbit', state: 'SUCCESS', targetUrl: 'https://cr.example/status' }],
    checks: null,
  }),
})
check('the context is read as the name', statusContext.json?.ci?.success?.includes('coderabbit'), JSON.stringify(statusContext.json?.ci))
check('so it needs no cross-read to place it', statusContext.code === 0 && JSON.stringify(statusContext.json?.ci?.unknown) === '[]',
  `${statusContext.code}: ${JSON.stringify(statusContext.json?.ci?.unknown)}`)

console.log('\nG2: an allowlist read that failed is unknown, not empty')
const flakesDown = run([String(PR)], {
  st: freshState({
    rollup: [checkRun('unit', 'SUCCESS'), checkRun('e2e', 'FAILURE')],
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
    rollup: [checkRun('unit', 'SUCCESS'), checkRun('e2e', 'FAILURE')],
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
const noChecks = run([String(PR)], { st: freshState({ rollup: [] }) })
check('an empty rollup stops on ci-unknown', noChecks.code === 1 && has(noChecks.json?.stops, 'ci-unknown'),
  `${noChecks.code}: ${JSON.stringify(codes(noChecks.json?.stops))}`)
check('and says no checks reported', detailOf(noChecks.json?.stops, 'ci-unknown').includes('no checks reported'),
  detailOf(noChecks.json?.stops, 'ci-unknown'))
const missingRollup = run([String(PR)], { st: freshState({ rollup: undefined }) })
check('a missing rollup key reads the same way', missingRollup.code === 1 && has(missingRollup.json?.stops, 'ci-unknown'),
  `${missingRollup.code}: ${JSON.stringify(codes(missingRollup.json?.stops))}`)
const noChecksSaid = run([String(PR)], {
  st: freshState({ rollup: [], checksExit: 1, checksStderr: 'no checks reported on the feat/issue-6-land-gates branch\n' }),
})
check('and what gh pr checks said is carried into the detail',
  detailOf(noChecksSaid.json?.stops, 'ci-unknown').includes('feat/issue-6-land-gates branch'),
  detailOf(noChecksSaid.json?.stops, 'ci-unknown'))

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
    rollup: [checkRun('unit', 'SUCCESS'), { context: colonName, state: 'FAILURE', targetUrl: 'https://circleci.example/1' }],
    checks: null,
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

console.log('\nJ1: a url joins only where it identifies one check on both sides')
// The collision a status provider produces for free. Every context it reports links to the one
// build page, so two nameless rollup entries and two cross-read names all carry one url. Joining
// on it gave the FAILURE whichever name came first; when that name was on the allowlist the
// failure was excused and the other check's failure was never reported at all.
const SHARED = 'https://ci.example/build/7'
const collision = run([String(PR)], {
  st: freshState({
    rollup: [
      { name: null, conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: SHARED },
      { name: null, conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: SHARED },
    ],
    checks: [
      { name: 'known-flake', state: 'FAILURE', bucket: 'fail', link: SHARED },
      { name: 'e2e', state: 'SUCCESS', bucket: 'pass', link: SHARED },
    ],
    baseFlakes: 'known-flake\n',
  }),
})
check('both entries sharing one url stay unknown', collision.json?.ci?.unknown?.length === 2, JSON.stringify(collision.json?.ci))
check('and keep a null name', collision.json?.ci?.unknown?.every((c) => c.name === null), JSON.stringify(collision.json?.ci?.unknown))
check('and stop the land', collision.code === 1 && has(collision.json?.stops, 'ci-unknown'),
  `${collision.code}: ${JSON.stringify(codes(collision.json?.stops))}`)
check('nothing is named known-flake', !JSON.stringify(collision.json?.ci).includes('known-flake'), JSON.stringify(collision.json?.ci))
check('and no failure is excused as flaky', JSON.stringify(collision.json?.ci?.flaky) === '[]', JSON.stringify(collision.json?.ci?.flaky))

// The same join, on a url only one check on each side carries, still names the entry - including
// when naming it is what turns the land red.
const uniqueJoin = run([String(PR)], {
  st: freshState({
    rollup: [checkRun('unit', 'SUCCESS'), { name: null, conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: 'https://ci.example/build/9' }],
    checks: [
      { name: 'unit', state: 'SUCCESS', bucket: 'pass', link: 'https://ci.example/unit' },
      { name: 'e2e', state: 'FAILURE', bucket: 'fail', link: 'https://ci.example/build/9' },
    ],
  }),
})
check('a unique url still joins', JSON.stringify(uniqueJoin.json?.ci?.failed?.map((c) => c.name)) === '["e2e"]',
  JSON.stringify(uniqueJoin.json?.ci))
check('and nothing is left unknown', JSON.stringify(uniqueJoin.json?.ci?.unknown) === '[]', JSON.stringify(uniqueJoin.json?.ci?.unknown))
check('and the named failure stops the land', uniqueJoin.code === 1 && has(uniqueJoin.json?.stops, 'ci-failed'),
  `${uniqueJoin.code}: ${JSON.stringify(codes(uniqueJoin.json?.stops))}`)

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
const perTestState = (base, conclusion = 'FAILURE') => freshState({
  rollup: [checkRun('unit', 'SUCCESS'), checkRun('suite', conclusion)],
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
  'which is not among the failed checks', { st: perTestState('suite:test_x\n', 'SUCCESS') })
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


console.log('\nO2: a cross-read name is handed out at most once')
// Both urls are unique on both sides, so the join is legitimate on each entry taken alone. What
// was missing is that the two entries are then the same check: the set of names already spoken
// for was built once, before the loop, so the second entry took `e2e` too. With `e2e` on the
// allowlist the failure was excused and the pull request went green on a check nobody could name.
const reusedName = run([String(PR)], {
  st: freshState({
    rollup: [
      { name: null, conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: 'https://ci.example/build/1' },
      { name: null, conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: 'https://ci.example/build/2' },
    ],
    checks: [
      { name: 'e2e', state: 'SUCCESS', bucket: 'pass', link: 'https://ci.example/build/1' },
      { name: 'e2e', state: 'FAILURE', bucket: 'fail', link: 'https://ci.example/build/2' },
    ],
    baseFlakes: 'e2e\n',
  }),
})
check('the first entry takes the name', JSON.stringify(reusedName.json?.ci?.success) === '["e2e"]',
  JSON.stringify(reusedName.json?.ci))
check('the second one does not take it again', reusedName.json?.ci?.unknown?.length === 1 &&
  reusedName.json?.ci?.unknown?.[0]?.name === null, JSON.stringify(reusedName.json?.ci?.unknown))
check('and keeps the url it had', reusedName.json?.ci?.unknown?.[0]?.link === 'https://ci.example/build/2',
  JSON.stringify(reusedName.json?.ci?.unknown))
check('so the land stops on ci-unknown', reusedName.code === 1 && has(reusedName.json?.stops, 'ci-unknown'),
  `${reusedName.code}: ${JSON.stringify(codes(reusedName.json?.stops))}`)
check('and the allowlist excuses no failure it could not name',
  JSON.stringify(reusedName.json?.ci?.flaky) === '[]' && JSON.stringify(reusedName.json?.ci?.failed) === '[]',
  JSON.stringify(reusedName.json?.ci))

console.log('\nJ4: one accepted test moves one check, and only where the name is unambiguous')
// Two CheckRuns can report the same name against two different jobs, and GitHub is happy to serve
// both. Acceptance used to be keyed on a set of check names and removed every failed entry whose
// name was in it, so one --accept-flake suite:test_x deleted both failures on the strength of one
// job log, which can only ever have been about one of them.
const twinSuite = (extra = {}) => freshState({
  rollup: [
    checkRun('unit', 'SUCCESS'),
    { name: 'suite', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/suite/1' },
    { name: 'suite', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/suite/2' },
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
    rollup: [checkRun('suite', 'FAILURE'), checkRun('other', 'FAILURE')],
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
  rollup: [checkRun('unit', 'SUCCESS'), { context: CIRCLE, state: 'FAILURE', targetUrl: 'https://circleci.example/1' }],
  checks: null,
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
    rollup: [checkRun('suite', 'SUCCESS'), { context: 'suite:slow', state: 'FAILURE', targetUrl: 'https://ci.example/slow' }],
    checks: null,
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
    rollup: [
      checkRun('unit', 'SUCCESS'),
      { name: 'e2e', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/e2e/1' },
      { name: 'e2e', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/e2e/2' },
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
      st: freshState({ rollup: [checkRun('e2e', 'FAILURE'), checkRun('flow', 'FAILURE')], baseFlakes: 'e2e\nflow\n' }),
    })
    return two.code === 0 && JSON.stringify(two.json?.ci?.flaky) === '["e2e","flow"]' &&
      detailOf(two.json?.attention, 'flaky-merged-through').startsWith('e2e, flow failed')
  })())


console.log(bad === 0 ? `\nland gates: ALL PASS (${total} checks)` : `\nland gates: ${bad} FAILURE(S) of ${total} checks`)
process.exit(bad === 0 ? 0 : 1)
