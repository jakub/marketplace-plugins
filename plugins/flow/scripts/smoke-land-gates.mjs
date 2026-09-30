#!/usr/bin/env node
// Smoke for scripts/land-gates.mjs, the land's read-only verdict.
//
// The executor runs in process against a real clone under mktemp, whose origin and checked-out
// branch it reads with real git, and a fake gh injected as a function that answers from a per-case
// state object in the shapes GitHub serves: `gh api --paginate --slurp` prints an outer array with
// one element per page (a check-runs page is an object carrying check_runs, a statuses or comments
// page is the array itself), paged at the 100 the executor asks for, so a 101st check really is on
// a second page. Every case asserts the verdict and, where it matters, that no gh call mutated
// anything and every call named origin's repository.
//
// Run: node plugins/flow/scripts/smoke-land-gates.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { landGates } from './land-gates.mjs'

let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad += 1
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` -> ${detail}`}`)
}

const SLUG = 'jakub/marketplace-plugins'
const IDENTITY = `github.com/${SLUG}`
const PR = 12
const BRANCH = 'feat/issue-6-land-gates'
const HEAD = 'a'.repeat(40)
const PR_URL = `https://github.com/${SLUG}/pull/${PR}`

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-land-gates-')))
const gitEnv = { ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: join(tmp, 'none'), GIT_CONFIG_SYSTEM: join(tmp, 'none'), GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@example.invalid', GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@example.invalid' }
let repos = 0
/** A real clone-shaped repository: one commit on the named branch and origin set, nothing else. */
const repoWith = (origin, branch = BRANCH) => {
  const dir = join(tmp, `repo-${repos += 1}`)
  mkdirSync(dir)
  execFileSync('git', ['init', '-q', '-b', branch, dir], { env: gitEnv })
  execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'first'], { env: gitEnv })
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin], { env: gitEnv })
  return dir
}
const REPO = repoWith(`git@github.com:${SLUG}.git`)

let nextId = 1000
const checkRun = (name, conclusion, extra = {}) => ({ id: nextId++, name, status: conclusion === null ? 'in_progress' : 'completed', conclusion, details_url: `https://ci.example/${name}`, ...extra })
const status = (context, state) => ({ id: nextId++, context, state, target_url: `https://cr.example/${context}` })
const thread = (id, resolved = true) => ({ id, isResolved: resolved, isOutdated: false, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'a word', path: 'scripts/x.mjs', url: `${PR_URL}#r1` }] } })
const pagesOf = (list) => { const pages = []; for (let i = 0; i < list.length; i += 100) pages.push(list.slice(i, i + 100)); return pages.length ? pages : [[]] }

const freshState = (over = {}) => ({
  defaultBranch: 'main', checkRuns: [checkRun('unit', 'success'), checkRun('lint', 'skipped')], totalCount: null, statuses: [],
  apiFail: null, children: [], comments: [], threadPages: [[thread('T1')]], threadsFail: false, queueFails: false, mergeQueue: null,
  baseFlakes: null, prFlakes: null, flakesHttp: null, current: null, calls: [], ...over,
  pr: { number: PR, title: 'feat(flow): gates', body: 'The gate.', state: 'OPEN', headRefName: BRANCH, headRefOid: HEAD, baseRefName: 'main', url: PR_URL,
    isDraft: false, isCrossRepository: false, autoMergeRequest: null, closingIssuesReferences: [{ number: 6 }], ...(over.pr || {}) },
})
const field = (args, key) => { const hit = args.find((a) => String(a).startsWith(`${key}=`)); return hit === undefined ? null : String(hit).slice(key.length + 1) }
const makeRunGh = (st) => (args) => {
  st.calls.push(args)
  const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
  const fail = (code, stderr) => ({ code, stdout: '', stderr })
  if (args[0] === 'pr' && args[1] === 'view') {
    if (String(args[2]).startsWith('--')) return st.current === null ? fail(1, 'no pull request found\n') : ok(st.current)
    return ok(st.pr)
  }
  if (args[0] === 'repo' && args[1] === 'view') return st.defaultBranch === null ? fail(1, 'repo view failed\n') : ok({ defaultBranchRef: { name: st.defaultBranch } })
  if (args[0] === 'pr' && args[1] === 'list') return ok(st.children)
  if (args[0] === 'api' && args[1] === 'graphql') {
    const query = field(args, 'query') ?? ''
    if (query.includes('reviewThreads')) {
      if (st.threadsFail) return fail(1, "Field 'reviewThreads' doesn't exist\n")
      const index = field(args, 'cursor') === null ? 0 : Number(field(args, 'cursor').slice(1))
      const more = index < st.threadPages.length - 1
      return ok({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: more, endCursor: more ? `c${index + 1}` : null }, nodes: st.threadPages[index] } } } } })
    }
    if (st.queueFails) return fail(1, "Field 'mergeQueue' doesn't exist\n")
    return ok({ data: { repository: { mergeQueue: st.mergeQueue, pullRequest: { isInMergeQueue: false } } } })
  }
  const path = String(args.at(-1))
  if (path.includes('/contents/')) {
    if (st.flakesHttp) return { code: 1, stdout: '{"message":"Server Error"}', stderr: `gh: Server Error (HTTP ${st.flakesHttp})\n` }
    const text = decodeURIComponent(path.split('ref=')[1]) === st.pr.baseRefName ? st.baseFlakes : st.prFlakes
    if (text === null) return { code: 1, stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)\n' }
    return ok({ encoding: 'base64', content: Buffer.from(text).toString('base64') })
  }
  const endpoint = ['check-runs', 'statuses', 'comments'].find((e) => path.includes(`/${e}?`))
  if (endpoint === undefined || !args.includes('--paginate') || !args.includes('--slurp')) return fail(3, `fake gh: unexpected ${args.join(' ')}\n`)
  if (st.apiFail === endpoint) return { code: 1, stdout: '{"message":"Server Error"}', stderr: 'gh: Server Error (HTTP 500)\n' }
  if (endpoint === 'check-runs') return ok(pagesOf(st.checkRuns).map((page) => ({ total_count: st.totalCount ?? st.checkRuns.length, check_runs: page })))
  return ok(pagesOf(endpoint === 'statuses' ? st.statuses : st.comments))
}

const run = (argv = [String(PR)], { st = freshState(), cwd = REPO, env = {} } = {}) => {
  const result = landGates({ argv, env, cwd, runGh: makeRunGh(st) })
  let json = null
  try { json = JSON.parse(result.stdout) } catch {}
  return { ...result, json, st }
}
const stops = (r) => (r.json?.stops ?? []).map((s) => s.code)
const attention = (r) => (r.json?.attention ?? []).map((s) => s.code)
const MUTATING = (a) => (a[0] === 'pr' && ['merge', 'edit', 'close', 'comment', 'ready'].includes(a[1])) || (a[0] === 'issue') ||
  (a[0] === 'api' && (a.includes('-X') || a.includes('--method') || a.some((w) => /mutation\s*[({]/.test(String(w)))))
const pinned = (a) => (a[0] === 'api' ? a[a.indexOf('--hostname') + 1] === 'github.com' && (a[1] === 'graphql' ? field(a, 'owner') === 'jakub' && field(a, 'repo') === 'marketplace-plugins' : String(a.at(-1)).startsWith(`repos/${SLUG}/`))
  : a[0] === 'repo' ? a[2] === IDENTITY : a[a.indexOf('--repo') + 1] === IDENTITY)
const withStop = (name, code, over, exit = 1) => {
  const r = run(undefined, { st: freshState(over) })
  check(`${name}: exit ${exit}, stops on ${code}`, r.code === exit && stops(r).includes(code) && r.json?.verdict === 'stop', `${r.code} ${JSON.stringify(r.json?.stops)} ${r.stderr}`)
  return r
}

console.log('a pull request with nothing wrong with it')
{
  const r = run()
  check('exit 0, pass, no stops and no attention', r.code === 0 && r.json?.verdict === 'pass' && stops(r).length === 0 && attention(r).length === 0, `${r.stderr}${JSON.stringify(r.json?.attention)}`)
  check('it reports the head the merge is pinned to, and a default base', r.json?.head?.sha === HEAD && r.json?.base?.isDefault === true, JSON.stringify(r.json?.head))
  check('checks, threads, links and arming read back', r.json?.ci?.success.join() === 'unit,lint' && r.json?.threads?.total === 1 && r.json?.linkedIssues?.linked.join() === '6' &&
    r.json?.arming?.autoMerge === false && r.json?.arming?.mergeQueue === false, JSON.stringify(r.json))
  check('nothing it ran mutates, and every gh call names origin\'s repository', !r.st.calls.some(MUTATING) && r.st.calls.every(pinned), JSON.stringify(r.st.calls.filter((a) => !pinned(a))))
}

console.log('\neach stop')
withStop('a closed pull request', 'not-open', { pr: { state: 'CLOSED' } })
withStop('a draft', 'draft', { pr: { isDraft: true } })
withStop('an unreadable head is also a failed read', 'head-unreadable', { pr: { headRefOid: 'short' } }, 4)
withStop('a base that is not the default branch', 'stacked-on-non-default', { pr: { baseRefName: 'release' } })
withStop('a pending check', 'ci-pending', { checkRuns: [checkRun('unit', null)] })
withStop('a failed check', 'ci-failed', { checkRuns: [checkRun('unit', 'failure')] })
withStop('a conclusion nobody knows', 'ci-unknown', { checkRuns: [checkRun('unit', 'stale')] })
withStop('an unresolved thread', 'threads-unresolved', { threadPages: [[thread('T1', false)]] })
withStop('a thread read that failed', 'threads-unreadable', { threadsFail: true }, 4)
withStop('an armed auto-merge', 'auto-merge-armed', { pr: { autoMergeRequest: { enabledBy: { login: 'bot' } } } })
withStop('a merge queue on the base', 'merge-queue', { mergeQueue: { id: 'MQ' } })
withStop('an unreadable merge queue is a stop and a failed read', 'merge-queue', { queueFails: true }, 4)

console.log('\nwhat counts as a check')
{
  const nameless = withStop('a nameless green check run', 'ci-unknown', { checkRuns: [checkRun('unit', 'success'), checkRun(undefined, 'success')] })
  check('it is listed unknown with its link, not counted green', nameless.json?.ci?.unknown[0]?.name === null && nameless.json?.ci?.unknown[0]?.link !== null, JSON.stringify(nameless.json?.ci))
  withStop('a nameless commit status', 'ci-unknown', { statuses: [status(undefined, 'success')] })
  const none = withStop('no checks at all', 'ci-unknown', { checkRuns: [] })
  check('no checks is a stop, not a failed read', none.json?.error === undefined, none.json?.error)
  const superseded = run(undefined, { st: freshState({ statuses: [status('coderabbit', 'success'), status('coderabbit', 'failure')] }) })
  check('only the newest status of a context counts', superseded.code === 0 && superseded.json?.ci?.success.includes('coderabbit'), JSON.stringify(superseded.json?.ci))
  const many = Array.from({ length: 100 }, (unused, i) => checkRun(`c${i}`, 'success')).concat(checkRun('the-101st', 'failure'))
  const paged = withStop('a failing 101st check, on the second page', 'ci-failed', { checkRuns: many })
  check('it is the one named failed', paged.json?.ci?.failed.map((f) => f.name).join() === 'the-101st', JSON.stringify(paged.json?.ci?.failed))
  const short = withStop('a read short of total_count', 'ci-unknown', { totalCount: 3 }, 4)
  check('the mismatch is the error', String(short.json?.error).includes('total_count 3'), short.json?.error)
  for (const endpoint of ['check-runs', 'statuses', 'comments']) {
    const r = run(undefined, { st: freshState({ apiFail: endpoint }) })
    check(`a failed ${endpoint} read exits 4, never a pass`, r.code === 4 && r.json?.verdict === 'stop' && String(r.json?.error).includes('500'), `${r.code} ${r.json?.error}`)
  }
}

console.log('\nknown flakes come from the base, never the branch')
{
  const failing = [checkRun('unit', 'success'), checkRun('e2e', 'failure')]
  const base = run(undefined, { st: freshState({ checkRuns: failing, baseFlakes: '# flaky\ne2e\n', prFlakes: '# flaky\ne2e\n' }) })
  check('a base-listed failure merges through, flagged for the report', base.code === 0 && base.json?.ci?.flaky.join() === 'e2e' && attention(base).includes('flaky-merged-through'), JSON.stringify(base.json?.ci))
  const branch = run(undefined, { st: freshState({ checkRuns: failing, prFlakes: 'e2e\n' }) })
  check('the same line added on the branch excuses nothing', branch.code === 1 && stops(branch).includes('ci-failed'), JSON.stringify(branch.json?.stops))
  check('and is attention', attention(branch).includes('flakes-added-on-pr'), JSON.stringify(branch.json?.attention))
  const perTest = { checkRuns: failing, baseFlakes: 'e2e:test_login\n' }
  const candidate = run(undefined, { st: freshState(perTest) })
  check('a check:test entry excuses nothing on its own, and names the log to read', candidate.code === 1 && candidate.json?.ci?.flakeCandidates?.e2e?.join() === 'test_login', JSON.stringify(candidate.json?.ci))
  const accepted = run(['--accept-flake', 'e2e:test_login', String(PR)], { st: freshState(perTest) })
  check('--accept-flake on a declared entry passes, recorded and reported', accepted.code === 0 && accepted.json?.ci?.acceptedFlakes[0]?.test === 'test_login' && attention(accepted).includes('flaky-merged-through'), `${accepted.code} ${accepted.stderr}`)
  const invented = run(['--accept-flake', 'e2e:test_other', String(PR)], { st: freshState(perTest) })
  check('--accept-flake cannot invent an entry', invented.code === 2 && invented.stderr.includes('not an entry'), invented.stderr)
  const twice = run(['--accept-flake', 'e2e:test_login', String(PR)], { st: freshState({ ...perTest, checkRuns: [...failing, checkRun('e2e', 'failure')] }) })
  check('--accept-flake refuses a name two failed jobs carry', twice.code === 2 && twice.stderr.includes('one job log'), twice.stderr)
  const colon = run(['--accept-flake', 'ci/circleci: build:flaky_test', String(PR)], { st: freshState({ checkRuns: [], statuses: [status('ci/circleci: build', 'failure')], baseFlakes: 'ci/circleci: build:flaky_test\n' }) })
  check('a context with its own colon splits after the reported name', colon.code === 0 && colon.json?.ci?.acceptedFlakes[0]?.check === 'ci/circleci: build', `${colon.code} ${colon.stderr}`)
  const broken = run(undefined, { st: freshState({ checkRuns: failing, flakesHttp: 500 }) })
  check('an allowlist nobody could read excuses nothing and exits 4', broken.code === 4 && broken.json?.ci?.failed.length === 1, `${broken.code} ${broken.json?.error}`)
}

console.log('\nthreads, children, links and the follow-up draft')
{
  const paged = run(undefined, { st: freshState({ threadPages: [Array.from({ length: 100 }, (u, i) => thread(`T${i}`)), [thread('T-late', false)]] }) })
  check('an unresolved thread on the second page stops the land', paged.code === 1 && stops(paged).includes('threads-unresolved') && paged.json?.threads?.total === 101, JSON.stringify(paged.json?.threads?.unresolved))
  const kids = run(undefined, { st: freshState({ children: [{ number: 13, title: 'child', url: 'https://github.com/x/y/pull/13' }] }) })
  check('a pull request stacked on this branch is attention, not a stop', kids.code === 0 && attention(kids).includes('children'), JSON.stringify(kids.json?.attention))
  const body = 'Closes #6. This does not fix #17.\n\n```\nCloses #9\n```\n\nPart of #20.'
  const links = run(undefined, { st: freshState({ pr: { closingIssuesReferences: [], body } }) })
  const li = links.json?.linkedIssues
  check('linked issues come back three ways', li?.linked.length === 0 && li?.recovered.join() === '6' && li?.mentions.join() === '17,9,20', JSON.stringify(li))
  check('and an unlinked set is a question for the human', attention(links).includes('linked-issues-ambiguous'), JSON.stringify(links.json?.attention))
  const comments = Array.from({ length: 100 }, (u, i) => ({ id: i, body: 'lgtm', html_url: `${PR_URL}#c${i}` })).concat({ id: 101, body: '## Follow-up draft\n\nlater', html_url: `${PR_URL}#c101` })
  const draft = run(undefined, { st: freshState({ comments }) })
  check('a follow-up draft on the second comment page is found', attention(draft).includes('follow-up-draft') && draft.json?.followUpDraft?.id === 101, JSON.stringify(draft.json?.followUpDraft))
}

console.log('\nthe origin and the pull request have to be this repository\'s')
for (const [name, origin, env, text] of [
  ['an origin with a port', `https://github.com:8443/${SLUG}.git`, {}, 'names a port'],
  ['an origin off the host allowlist', `git@ghe.example.com:${SLUG}.git`, {}, 'FLOW_GH_HOSTS'],
  ['an origin with a query string', `https://github.com/${SLUG}.git?access_token=sekret`, {}, 'query string'],
]) {
  const r = run(undefined, { cwd: repoWith(origin), env })
  check(`${name} is refused before any gh call, and not quoted`, r.code === 2 && r.stderr.includes(text) && r.st.calls.length === 0 && !r.stderr.includes('sekret'), r.stderr)
}
{
  const ghe = run(undefined, { cwd: repoWith(`git@ghe.example.com:${SLUG}.git`), env: { FLOW_GH_HOSTS: 'ghe.example.com' }, st: freshState({ pr: { url: `https://ghe.example.com/${SLUG}/pull/${PR}` } }) })
  check('FLOW_GH_HOSTS admits that host, and every api call pins it', ghe.code === 0 && ghe.st.calls.filter((a) => a[0] === 'api').every((a) => a[a.indexOf('--hostname') + 1] === 'ghe.example.com'), `${ghe.code} ${ghe.stderr}`)
  const honest = run([], { st: freshState({ current: { number: PR, url: PR_URL, headRefName: BRANCH } }) })
  check('with no number, a pull request of origin heading this branch is gated', honest.code === 0 && honest.json?.pr === PR, `${honest.code} ${honest.stderr}`)
  const fork = run([], { st: freshState({ current: { number: PR, url: `https://github.com/upstream/marketplace-plugins/pull/${PR}`, headRefName: BRANCH } }) })
  check('with no number, a pull request of another repository is refused', fork.code === 2 && fork.stderr.includes('upstream/marketplace-plugins'), fork.stderr)
  const renamed = run([], { st: freshState({ current: { number: PR, url: PR_URL, headRefName: 'feat/other' } }) })
  check('with no number, a pull request heading another branch is refused', renamed.code === 2 && renamed.stderr.includes('feat/other'), renamed.stderr)
  const junk = run(['twelve'])
  check('a number that is not one is a usage refusal', junk.code === 2 && junk.stderr.includes('not a pull request number'), junk.stderr)
}

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nland-gates: ALL PASS' : `\nland-gates: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
