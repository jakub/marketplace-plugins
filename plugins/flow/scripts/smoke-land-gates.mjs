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
// that running it can never change anything.
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
  children: [],
  comments: [],
  threadPages: [[thread('T_resolved')]],
  threadsFail: false,
  queueFails: false,
  mergeQueue: null,
  isInMergeQueue: false,
  baseFlakes: null,      // file content on the base branch; null means the file is absent
  prFlakes: null,        // the pull request's own copy
  viewFails: false,
  currentBranchPr: null, // what `gh pr view --json number` answers with no argument
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
    const fields = argValue(args, '--json') || ''
    if (fields === 'number') {
      return st.currentBranchPr === null
        ? { code: 1, stdout: '', stderr: 'fake gh: no pull request found for the current branch\n' }
        : ok({ number: st.currentBranchPr })
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
    return { code: st.checksExit, stdout: JSON.stringify(st.checks), stderr: '' }
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
  if (rest[0] === 'fetch') return { code: 0, stdout: '', stderr: '' }
  if (rest[0] === 'show') {
    const spec = String(rest[1] || '')
    const content = spec.startsWith('origin/') ? st.baseFlakes : st.prFlakes
    return content === null
      ? { code: 128, stdout: '', stderr: `fatal: path '.github/known-flakes.txt' does not exist in '${spec.split(':')[0]}'\n` }
      : { code: 0, stdout: content, stderr: '' }
  }
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

// Every gh call must name the repository derived from origin. The one exception is the read that
// resolves a pull request from the current branch, which gh refuses to do once --repo is given.
const isPinned = (args) => {
  if (args[0] === 'api' && args[1] === 'graphql') {
    return argValue(args, '--hostname') === 'github.com' &&
      formField(args, 'owner') === 'jakub' && formField(args, 'repo') === 'marketplace-plugins'
  }
  if (args[0] === 'repo' && args[1] === 'view') return args[2] === IDENTITY
  if (args[0] === 'pr' && args[1] === 'view' && argValue(args, '--json') === 'number') return true
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
const READ_ONLY_GIT = new Set(['remote', 'fetch', 'show'])
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
check('and read the flake allowlist off the base branch', clean.st.gitCalls.some(
  (a) => a.includes('show') && a.includes('origin/main:.github/known-flakes.txt'),
), JSON.stringify(clean.st.gitCalls))

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
stopsOn('an unreadable head', 'head-unreadable', { st: freshState({ pr: { headRefOid: 'short' } }) })

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
  fromBranch.st.calls.some((a) => a[0] === 'pr' && a[1] === 'view' && argValue(a, '--json') === 'number' && !a.includes('--repo')),
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

console.log(bad === 0 ? `\nland gates: ALL PASS (${total} checks)` : `\nland gates: ${bad} FAILURE(S) of ${total} checks`)
process.exit(bad === 0 ? 0 : 1)
