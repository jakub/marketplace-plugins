#!/usr/bin/env node
// Smoke for scripts/land-merge.mjs, the land gate and the only merge. The executor runs in process
// against real repositories under mktemp, whose origin it reads with real git, and a fake gh
// injected as a function that answers from a per-case state object in the shapes GitHub serves:
// `gh api --paginate --slurp` prints an outer array with one element per page (a check-runs page
// is an object carrying check_runs, a statuses page is the array itself), paged at the 100 the
// executor asks for, so a 101st check really is on a second page. The fake records every call and
// every merge. `gh pr view` answers with exactly the --json fields asked for, so a gate that stops
// asking for a field it needs reads null rather than a value the fake volunteered, and the commit
// headlines come only from the paged commits query, 100 to a page like GitHub's. Every case reads the one JSON line and the exit; each refusal asserts that nothing
// merged, and each unproven outcome asserts that it does not read as a refusal. One case runs the
// real gh runner against a fake gh binary to prove that GH_REPO and GH_HOST never reach gh, and
// two prove that a gh or git planted behind a relative PATH entry never runs.
//
// Run: node plugins/flow/scripts/smoke-land-merge.mjs

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { execCapture, ghRunner } from '../lib/gh-exec.mjs'
import { landMerge } from './land-merge.mjs'

let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad += 1
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` -> ${detail}`}`)
}

const SLUG = 'jakub/marketplace-plugins'
const IDENTITY = `github.com/${SLUG}`
const PR = 12
const HEAD = 'b'.repeat(40)
const BRANCH = 'feat/issue-6-merge-gate'
const PR_URL = `https://github.com/${SLUG}/pull/${PR}`
const ARGS = [String(PR), HEAD]
const TITLE = 'feat(flow): gate the merge'
const HEADLINES = ['feat(flow): read the gate once', 'fix(flow): re-read before the merge']
const CAPABILITY_URL = 'https://plans.example.ts.net/p/AbCdEf0123456789'
const PR_BODY = `Evidence: ${CAPABILITY_URL}\n\nAlso see https://github.com/${SLUG}/pull/${PR}#issuecomment-1`
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-land-merge-')))
const repoWith = (name, origin) => {
  const dir = join(tmp, name)
  mkdirSync(dir)
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  if (origin !== null) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin])
  return dir
}
const REPO = repoWith('repo', `git@github.com:${SLUG}.git`)
const NO_ORIGIN = repoWith('no-origin', null)

let nextId = 1000
const checkRun = (name, conclusion) => {
  const id = nextId++
  return { id, name, status: conclusion === null ? 'in_progress' : 'completed', conclusion, details_url: `https://ci.example/${name}/${id}` }
}
const status = (context, state) => ({ id: nextId++, context, state, target_url: `https://cr.example/${context}` })
const thread = (id, resolved = true) => ({ id, isResolved: resolved, isOutdated: false, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'a word', path: 'scripts/x.mjs', url: `${PR_URL}#r-${id}` }] } })
const pagesOf = (list) => { const pages = []; for (let i = 0; i < list.length; i += 100) pages.push(list.slice(i, i + 100)); return pages.length ? pages : [[]] }

// `fail` names one read that answers HTTP 500, and `malformed` one that answers in the wrong shape.
// `commits` is the pull request's commit list; commitTotal overrides the totalCount every commit
// page reports, commitPageFails names a page (0-based) whose read fails, and commitsNoCursor drops
// the cursor that leads past the first page.
const commit = (messageHeadline, i) => ({ oid: String(i % 10).repeat(40), messageHeadline, messageBody: `see ${CAPABILITY_URL}` })
const freshState = (over = {}) => ({
  defaultBranch: 'main', mergeExit: 0, landsNothing: false, confirmFails: false, queue: null, queueFails: false, recheck: {}, after: {},
  queueAfter: undefined, queueAfterFails: false, merged: false, fail: null, malformed: null, behindBy: 0, baseTip: 'f'.repeat(40), tipAtMerge: null, suiteCount: null,
  suites: [{ id: 501, status: 'completed', conclusion: 'success' }, { id: 502, status: 'completed', conclusion: 'success' }],
  checkRuns: [checkRun('unit', 'success'), checkRun('lint', 'skipped')], totalCount: null, statuses: [],
  commits: HEADLINES.map(commit), commitTotal: null, commitPageFails: null, commitsNoCursor: false,
  threadPages: [[thread('T1')]], threadsNoCursor: false, baseFlakes: null, headFlakes: null, flakesHttp: null, flakesEncoding: 'base64',
  calls: [], merges: [], ...over,
  pr: { headRefOid: HEAD, headRefName: BRANCH, state: 'OPEN', isDraft: false, baseRefName: 'main', url: PR_URL, autoMergeRequest: null,
    title: TITLE, body: PR_BODY, ...(over.pr || {}) },
})
// What `gh pr view --json <fields>` prints: every field asked for, null when the pull request has none, and nothing else.
const project = (value, fields) => Object.fromEntries(fields.split(',').map((key) => [key, value[key] ?? null]))
const field = (args, key) => { const hit = args.find((a) => String(a).startsWith(`${key}=`)); return hit === undefined ? null : String(hit).slice(key.length + 1) }
const makeRunGh = (st) => (args) => {
  st.calls.push(args)
  const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
  const fail = (stderr, stdout = '') => ({ code: 1, stdout, stderr })
  const serverError = () => fail('gh: Server Error (HTTP 500)\n', '{"message":"Server Error"}')
  // The gate is read twice, for the verdict and again right before the merge. A second read of the
  // pull request, its threads or the base's known-flakes sees st.later's version (st.recheck for the
  // pull request), and failLater names a source whose second read fails.
  const reads = (st.reads ??= {})
  const again = (source) => (reads[source] = (reads[source] ?? 0) + 1) > 1
  if (args[0] === 'pr' && args[1] === 'view') {
    const fields = args[args.indexOf('--json') + 1]
    if (fields.startsWith('state,')) {
      if (st.confirmFails) return fail('fake gh: view failed\n')
      return ok(project({ ...st.pr, state: st.merged ? 'MERGED' : st.pr.state, autoMergeRequest: null, ...st.after }, fields))
    }
    if (again('pr')) return st.fail === 'recheck' || st.failLater === 'pr' ? serverError() : ok(project({ ...st.pr, ...st.recheck, ...st.later?.pr }, fields))
    return st.fail === 'view' ? serverError() : ok(project(st.pr, fields))
  }
  if (args[0] === 'repo' && args[1] === 'view') return st.fail === 'repo' ? serverError() : ok({ defaultBranchRef: { name: st.defaultBranch } })
  if (args[0] === 'api' && args[1] === 'graphql') {
    if ((field(args, 'query') ?? '').includes('commits(')) {
      const pages = pagesOf(st.commits)
      const index = field(args, 'cursor') === null ? 0 : Number(field(args, 'cursor').slice(1))
      if (st.commitPageFails === index) return fail('fake gh: graphql failed\n')
      const more = index < pages.length - 1
      const nodes = pages[index].map((c) => ({ commit: { oid: c.oid, messageHeadline: c.messageHeadline, messageBody: c.messageBody } }))
      return ok({ data: { repository: { pullRequest: { commits: { totalCount: st.commitTotal ?? st.commits.length,
        pageInfo: { hasNextPage: more, endCursor: more && !st.commitsNoCursor ? `k${index + 1}` : null }, nodes } } } } })
    }
    if ((field(args, 'query') ?? '').includes('reviewThreads')) {
      if (st.fail === 'threads') return fail("gh: Field 'reviewThreads' doesn't exist\n")
      if (field(args, 'cursor') === null) st.threadRead = again('threads') ? 'later' : 'first'
      if (st.threadRead === 'later' && st.failLater === 'threads') return fail('fake gh: graphql failed\n')
      const late = (key) => (st.threadRead === 'later' && st.later?.[key] !== undefined ? st.later[key] : st[key])
      const pages = late('threadPages')
      const index = field(args, 'cursor') === null ? 0 : Number(field(args, 'cursor').slice(1))
      const more = index < pages.length - 1
      return ok({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: more, endCursor: more && !late('threadsNoCursor') ? `c${index + 1}` : null }, nodes: pages[index] } } } } })
    }
    const afterMerge = st.merges.length > 0
    if (afterMerge ? st.queueAfterFails : st.queueFails) return fail('fake gh: graphql failed\n')
    return ok({ data: { repository: { mergeQueue: afterMerge && st.queueAfter !== undefined ? st.queueAfter : st.queue } } })
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    st.merges.push(args)
    if (st.mergeExit) return { code: st.mergeExit, stdout: '', stderr: 'X Pull request is not mergeable\n' }
    if (!st.landsNothing) st.merged = true
    return { code: 0, stdout: '', stderr: '' }
  }
  if (args[0] === 'api') {
    const path = String(args.at(-1))
    if (path.includes('/contents/')) {
      if (st.flakesHttp) return fail(`gh: Server Error (HTTP ${st.flakesHttp})\n`, '{"message":"Server Error"}')
      const baseFlakes = again('flakes') && st.later?.baseFlakes !== undefined ? st.later.baseFlakes : st.baseFlakes
      const text = decodeURIComponent(path.split('ref=')[1] ?? '') === st.pr.baseRefName ? baseFlakes : st.headFlakes
      if (text === null) return fail('gh: Not Found (HTTP 404)\n', '{"message":"Not Found"}')
      return ok({ encoding: st.flakesEncoding, content: st.flakesEncoding === 'base64' ? Buffer.from(text).toString('base64') : '' })
    }
    if (path.includes('/compare/')) {
      if (st.fail === 'compare') return serverError()
      if (st.malformed === 'compare') return ok({ status: 'behind' })
      return ok({ status: st.behindBy > 0 ? 'diverged' : 'ahead', ahead_by: 1, behind_by: st.behindBy, ...(st.malformed === 'compare-base' ? {} : { base_commit: { sha: st.baseTip } }) })
    }
    // The default branch's tip, read again straight before the merge: tipAtMerge is a land elsewhere meanwhile.
    if (path.includes('/git/ref/heads/')) {
      if (st.fail === 'tip') return serverError()
      return ok({ ref: `refs/heads/${st.defaultBranch}`, object: { type: 'commit', sha: st.tipAtMerge ?? st.baseTip } })
    }
    // The commit's check-suite count, read on its own because check-runs serves only the newest 1000 suites.
    // A CI read is made twice, once for the verdict and once right before the merge. `later`
    // holds what the second read of each source sees instead, and `failLater` a source whose
    // second read fails: CI that moved, or could not be re-read, between the two.
    const source = path.includes('/check-suites?') ? 'check-suites' : ['check-runs', 'statuses'].find((e) => path.includes(`/${e}?`))
    if (source !== undefined) reads[source] = (reads[source] ?? 0) + 1
    const second = source !== undefined && reads[source] > 1
    if (second && st.failLater === source) return serverError()
    const seen = (key) => (second && st.later?.[key] !== undefined ? st.later[key] : st[key])
    if (source !== undefined && args.includes('--paginate') && args.includes('--slurp')) {
      if (st.fail === source) return serverError()
      if (st.malformed === source) return ok([{ message: 'not a page' }])
      // A suiteCount stands in for a total_count past the suites listed, such as the 1000-suite window.
      // pageTotals gives one page of a source its own total_count, as when a run or suite is added mid-read.
      const totalOn = (i, fallback) => st.pageTotals?.[source]?.[i] ?? fallback
      if (source === 'check-suites') return ok(pagesOf(seen('suites')).map((page, i) => ({ total_count: totalOn(i, seen('suiteCount') ?? seen('suites').length), check_suites: page })))
      if (source === 'check-runs') return ok(pagesOf(seen('checkRuns')).map((page, i) => ({ total_count: totalOn(i, seen('totalCount') ?? seen('checkRuns').length), check_runs: page })))
      return ok(pagesOf(seen('statuses')))
    }
    // One unpaged page of suites, as a count-only read asks for.
    if (source === 'check-suites') return st.fail === source ? serverError() : ok({ total_count: seen('suiteCount') ?? seen('suites').length, check_suites: seen('suites').slice(0, 1) })
  }
  return { code: 3, stdout: '', stderr: `fake gh: unexpected ${args.join(' ')}\n` }
}
const pinnedTo = (identity, host) => {
  const [, owner, repo] = identity.split('/')
  return (a) => (a[0] === 'api' ? a[a.indexOf('--hostname') + 1] === host &&
    (a[1] === 'graphql' ? field(a, 'owner') === owner && field(a, 'name') === repo : String(a.at(-1)).startsWith(`repos/${owner}/${repo}/`))
    : a[0] === 'repo' ? a[2] === identity : a[a.indexOf('--repo') + 1] === identity)
}
const run = (args = ARGS, { st = freshState(), cwd = REPO, env = {} } = {}) => {
  const result = landMerge({ argv: args, env, cwd, runGh: makeRunGh(st) })
  let json = null
  try { json = JSON.parse(result.stdout) } catch {}
  return { ...result, json, st }
}
const codes = (r) => (r.json?.stops ?? []).map((s) => s.code)
const detailOf = (r, code) => (r.json?.stops ?? []).filter((s) => s.code === code).map((s) => s.detail).join(' | ')
const refusedWith = (r, code, text = '') => r.code === 1 && r.json?.result === 'refused' && codes(r).includes(code) && detailOf(r, code).includes(text) && r.st.merges.length === 0
const shown = (r) => `exit ${r.code}: ${r.stdout.trim()} ${r.stderr.trim()}`
const merged = (r) => r.code === 0 && r.json?.result === 'merged' && r.st.merges.length === 1
const contentsCalls = (st) => st.calls.filter((a) => a[0] === 'api' && String(a.at(-1)).includes('/contents/'))

console.log('the executor merges once, pinned to the gated head')
{
  const r = run()
  check('exit 0, and the JSON line says what it merged', merged(r) && r.json.repo === IDENTITY && r.json.pr === PR && r.json.head === HEAD &&
    r.json.detail.includes(`merged #${PR} as a squash of ${HEAD.slice(0, 12)}`), shown(r))
  check('exactly one merge: --repo, --squash, --match-head-commit at the caller\'s head', r.st.merges.length === 1 &&
    JSON.stringify(r.st.merges[0].slice(0, 8)) === JSON.stringify(['pr', 'merge', String(PR), '--repo', IDENTITY, '--squash', '--match-head-commit', HEAD]), JSON.stringify(r.st.merges))
  check('and the exact argument array carries the title with (#N) as --subject and one headline line per commit as --body', JSON.stringify(r.st.merges[0]) === JSON.stringify([
    'pr', 'merge', String(PR), '--repo', IDENTITY, '--squash', '--match-head-commit', HEAD,
    '--subject', `${TITLE} (#${PR})`, '--body', HEADLINES.map((h) => `- ${h}`).join('\n')]), JSON.stringify(r.st.merges))
  check('no merge argument carries the description\'s capability URL, any URL from the description, or a commit body', r.st.merges[0].every((a) =>
    !String(a).includes(CAPABILITY_URL) && !(PR_BODY.match(/https?:\/\/[^\s)]+/g) ?? []).some((u) => String(a).includes(u)) && !String(a).includes('see ')), JSON.stringify(r.st.merges))
  check('a URL in the title or in a commit headline is replaced by <link removed> and reaches no merge argument', (() => {
    const titleUrl = `evidence ${CAPABILITY_URL} done`
    const headlineUrl = 'http://plans.example.ts.net/p/ZzYy9876543210'
    const leaky = run(ARGS, { st: freshState({ pr: { title: titleUrl }, commits: [`docs: see ${headlineUrl}, then stop`, 'fix: plain headline'].map(commit) }) })
    const args = leaky.st.merges[0] ?? []
    return merged(leaky) && args.every((a) => !/https?:\/\//.test(String(a)) && !String(a).includes('plans.example.ts.net')) &&
      args[args.indexOf('--subject') + 1] === `evidence <link removed> done (#${PR})` &&
      args[args.indexOf('--body') + 1] === '- docs: see <link removed> then stop\n- fix: plain headline'
  })(), 'a URL in the title or a headline reached the squash message')
  // A plans capability is the bare 22-character base64url key, so it is redacted wherever it sits,
  // whatever URL spelling carries it. The gate reads the same calls whether or not a key was there.
  const KEY = 'AbCdEf0123456789_-xYzA'
  const SHA40 = 'a1b2c3d4e5'.repeat(4)
  const leakCase = (name, { title = TITLE, headline = null, key = KEY }, subject, body) => {
    const r = run(ARGS, { st: freshState({ pr: { title }, commits: [commit(headline ?? 'fix: plain headline', 1)] }) })
    const args = r.st.merges[0] ?? []
    const subjectGot = args[args.indexOf('--subject') + 1]
    const bodyGot = args[args.indexOf('--body') + 1]
    const gateCalls = (x) => JSON.stringify(x.st.calls.filter((a) => !(a[0] === 'pr' && a[1] === 'merge')))
    check(name, merged(r) && args.every((a) => !String(a).includes(key)) && subjectGot === subject && bodyGot === body &&
      gateCalls(r) === gateCalls(run()), JSON.stringify({ subjectGot, bodyGot, merges: r.st.merges }))
  }
  const LR = '<link removed>'
  leakCase('a bare capability key in the title is replaced by <link removed>', { title: `ship ${KEY} now` }, `ship ${LR} now (#${PR})`, '- fix: plain headline')
  leakCase('a bare key in a headline is replaced', { headline: `see ${KEY}.` }, `${TITLE} (#${PR})`, `- see ${LR}.`)
  leakCase('a scheme-relative //host/key in a headline is replaced', { headline: `see //plans.example/${KEY} ok` }, `${TITLE} (#${PR})`, `- see ${LR} ok`)
  leakCase('a host/key with no scheme keeps the host and loses the key', { headline: `see plans.example/${KEY} ok` }, `${TITLE} (#${PR})`, `- see plans.example/${LR} ok`)
  leakCase('an angle-bracket URL in a headline is replaced', { headline: `see <https://plans.example/${KEY}> ok` }, `${TITLE} (#${PR})`, `- see <${LR} ok`)
  leakCase('a markdown link in a headline loses the key', { headline: `see [doc](https://plans.example/${KEY}) ok` }, `${TITLE} (#${PR})`, `- see [doc](${LR} ok`)
  leakCase('a URL folded across a newline loses both halves', { headline: `see https://plans.example/\n${KEY}` }, `${TITLE} (#${PR})`, `- see ${LR} ${LR}`)
  leakCase('an uppercase scheme is replaced', { headline: `see HTTPS://PLANS.EXAMPLE/${KEY} ok` }, `${TITLE} (#${PR})`, `- see ${LR} ok`)
  // The canonical key is base64url of 16 bytes: 22 characters, the last always one of A, Q, g, w.
  // So an all-lowercase key is still a capability and goes, whatever letters it holds.
  const LOWER = 'abcdefghijklmnopqrstug'
  leakCase('an all-lowercase capability key bare in the title is replaced', { title: `ship ${LOWER} now`, key: LOWER }, `ship ${LR} now (#${PR})`, '- fix: plain headline')
  leakCase('an all-lowercase key after plans.internal/ keeps the host and loses the key', { headline: `see plans.internal/${LOWER} ok`, key: LOWER }, `${TITLE} (#${PR})`, `- see plans.internal/${LR} ok`)
  leakCase('an all-lowercase key folded after https://plans.internal/ across a newline loses both halves', { headline: `see https://plans.internal/\n${LOWER}`, key: LOWER }, `${TITLE} (#${PR})`, `- see ${LR} ${LR}`)
  for (const last of ['A', 'Q', 'g', 'w']) {
    const key = `abcdefghijklmnopqrstu${last}`
    leakCase(`a lowercase-bodied capability key ending in ${last} is replaced`, { headline: `see ${key} ok`, key }, `${TITLE} (#${PR})`, `- see ${LR} ok`)
  }
  for (const [what, token] of [['a lowercase kebab word of 22 characters', 'smoke-plugin-manifests'], ['a 40-character commit SHA', SHA40],
    ['a 21-character mixed token', KEY.slice(0, 21)], ['a 23-character mixed token', `Z${KEY.slice(1)}B`],
    ['a 22-character mixed-case token whose last character cannot end a key (a deliberate false negative)', `${KEY.slice(0, 21)}B`]]) {
    leakCase(`${what} survives unchanged`, { headline: `fix: ${token} again` }, `${TITLE} (#${PR})`, `- fix: ${token} again`)
  }
  check('the title and commits are not in the gate snapshot: a title edit between the reads still lands, with the newer title', (() => {
    const edited = run(ARGS, { st: freshState({ recheck: { title: 'feat(flow): gate the merge, reworded' } }) })
    return merged(edited) && edited.st.merges[0].includes(`feat(flow): gate the merge, reworded (#${PR})`)
  })())
  check('an unreadable title or a commit list with no headline refuses read-failed and nothing merges', (() => {
    const noTitle = run(ARGS, { st: freshState({ pr: { title: '' } }) })
    const noCommits = run(ARGS, { st: freshState({ commits: [] }) })
    return refusedWith(noTitle, 'read-failed', 'title') && refusedWith(noCommits, 'read-failed', 'commit headlines')
  })())
  check('gh pr view is never asked for commits, which it serves only the first 100 of', r.st.calls.filter((a) => a[0] === 'pr' && a[1] === 'view')
    .every((a) => !a[a.indexOf('--json') + 1].split(',').includes('commits')), JSON.stringify(r.st.calls.filter((a) => a[0] === 'pr')))
  // GitHub pages the commits connection at 100, and the body has to list every commit, not the first page.
  const longHeadlines = Array.from({ length: 150 }, (unused, i) => `fix: step ${i + 1}`)
  const long = run(ARGS, { st: freshState({ commits: longHeadlines.map(commit) }) })
  const longBody = long.st.merges[0]?.[long.st.merges[0].indexOf('--body') + 1]
  check('150 commits across two pages all reach the squash body, in order', merged(long) && longBody === longHeadlines.map((h) => `- ${h}`).join('\n') &&
    long.st.calls.filter((a) => a[1] === 'graphql' && (field(a, 'query') ?? '').includes('commits(') && field(a, 'cursor') === 'k1').length === 2, shown(long))
  for (const [name, over, text] of [
    ['a failed second commit page', { commits: longHeadlines.map(commit), commitPageFails: 1 }, 'failed on page 2'],
    ['another commit page with no cursor', { commits: longHeadlines.map(commit), commitsNoCursor: true }, 'no cursor'],
    ['a commit count short of totalCount', { commitTotal: 3 }, 'collected 2 commit(s) and reported totalCount 3'],
    ['one commit with an empty headline among readable ones', { commits: ['fix: one', '', 'fix: three'].map(commit) }, '1 of 3 commit(s) have no readable headline'],
    ['one commit with no headline at all', { commits: [commit('fix: one', 1), { oid: '2'.repeat(40) }] }, '1 of 2 commit(s) have no readable headline'],
  ]) {
    const r = run(ARGS, { st: freshState(over) })
    check(`${name} refuses read-failed and nothing merges`, refusedWith(r, 'read-failed', text), shown(r))
  }
  const endlessCommits = run(ARGS, { st: freshState({ commits: Array.from({ length: 2001 }, (unused, i) => commit(`fix: ${i}`, i)) }) })
  check('a commit read still paging after 20 pages refuses read-failed', refusedWith(endlessCommits, 'read-failed', '20 pages'), shown(endlessCommits))
  check('every gh call names origin\'s repository', r.st.calls.every(pinnedTo(IDENTITY, 'github.com')), JSON.stringify(r.st.calls.filter((a) => !pinnedTo(IDENTITY, 'github.com')(a))))
}

console.log('\nrefused before mutating anything')
for (const [name, code, text, over, opts = {}] of [
  ['a head other than the gated one', 'head-moved', 'head moved', { pr: { headRefOid: 'c'.repeat(40) } }],
  ['a closed pull request', 'not-open', 'only an open pull request', { pr: { state: 'CLOSED' } }],
  ['a merged one', 'not-open', 'only an open pull request', { pr: { state: 'MERGED' } }],
  ['a draft', 'draft', 'is a draft', { pr: { isDraft: true } }],
  ['an unreadable draft flag', 'draft', 'cannot be shown ready', { pr: { isDraft: null } }],
  ['a base other than the default branch', 'stacked-on-non-default', 'the default branch is', { pr: { baseRefName: 'release' } }],
  ['an unreadable default branch', 'read-failed', 'default branch could not be read', { defaultBranch: null }],
  ['an armed auto-merge', 'auto-merge-armed', 'auto-merge armed', { pr: { autoMergeRequest: { enabledBy: { login: 'bot' } } } }],
  ['a merge queue on the base', 'merge-queue', 'uses a merge queue', { queue: { id: 'MQ' } }],
  ['an unreadable merge queue', 'read-failed', 'merge-queue status', { queueFails: true }],
  ['a read GitHub redirected elsewhere', 'redirected', 'was redirected', { pr: { url: 'https://github.com/someone/evil/pull/12' } }],
  ['a retarget before the merge', 'gate-moved', 'base changed', { recheck: { baseRefName: 'release' } }],
  ['a head moved before the merge', 'gate-moved', 'head changed', { recheck: { headRefOid: 'd'.repeat(40) } }],
  ['a directory with no origin', 'origin', 'no readable origin remote', {}, { cwd: NO_ORIGIN }],
  ['an unattended job, before even the origin read', 'cron', 'nobody is watching', {}, { cwd: NO_ORIGIN, env: { FLOW_CRON_JOB: 'lint' } }],
]) {
  const r = run(ARGS, { st: freshState(over), ...opts })
  check(`${name} is refused ${code} and nothing merged`, refusedWith(r, code, text), shown(r))
}
for (const [name, args] of [['no arguments', []], ['the number alone', [String(PR)]], ['a number that is not one', ['twelve', HEAD]],
  ['an abbreviated head', [String(PR), HEAD.slice(0, 12)]], ['an uppercase head', [String(PR), HEAD.toUpperCase()]], ['a third argument', [...ARGS, '--admin']]]) {
  const r = run(args)
  check(`${name} is a usage refusal that calls no gh`, refusedWith(r, 'usage') && r.st.calls.length === 0, shown(r))
}

console.log('\nthe outcome is proven by a re-read, or reported unknown')
{
  const failed = run(ARGS, { st: freshState({ mergeExit: 1 }) })
  check('gh refusing the merge with the pull request cleanly open is merge-rejected', failed.code === 1 && failed.json?.result === 'refused' &&
    codes(failed).join() === 'merge-rejected' && detailOf(failed, 'merge-rejected').includes('gh pr merge failed') && failed.st.merges.length === 1, shown(failed))
  for (const [name, text, over] of [
    ['a MERGED read at another head', 'someone else may have merged it', { after: { headRefOid: 'e'.repeat(40) } }],
    ['auto-merge armed by the merge call', 'auto-merge armed', { mergeExit: 1, after: { autoMergeRequest: { enabledBy: { login: 'bot' } } } }],
    ['a queue armed only after the merge call', 'merge-queue status is armed', { mergeExit: 1, queueAfter: { id: 'MQ' } }],
    ['an unreadable queue after the merge call', 'merge-queue status is unreadable', { mergeExit: 1, queueAfterFails: true }],
    ['a merge gh reported that landed nothing', 'reported success', { landsNothing: true }],
    ['a confirming read that failed', 'could not confirm whether', { mergeExit: 1, confirmFails: true }],
  ]) {
    const r = run(ARGS, { st: freshState(over) })
    check(`${name} is unknown, exit 4, not refused and not merged`, r.code === 4 && r.json?.result === 'unknown' && r.json.detail.includes(text) &&
      r.json.detail.includes('do not re-run this blindly') && r.json.stops === undefined, shown(r))
  }
}

console.log('\nthe origin decides the repository and the host')
for (const [name, origin, text] of [
  ['an origin with a port', `https://github.com:8443/${SLUG}.git`, 'names a port'],
  ['an ssh origin with a port', `ssh://git@github.com:2222/${SLUG}.git`, 'names a port'],
  ['an origin with a token in its query', `https://github.com/${SLUG}.git?access_token=ghp_sekret`, 'query string'],
  ['an scp host hiding a token', `git@ghp_sekret?x@github.com:${SLUG}.git`, 'does not read as a URL naming a host'],
  ['a host off the allowlist', `git@ghe.example.com:${SLUG}.git`, 'FLOW_GH_HOSTS'],
]) {
  const r = run(ARGS, { cwd: repoWith(name.replace(/\W+/g, '-'), origin) })
  check(`${name} is refused before any gh call, quoting nothing secret`, refusedWith(r, 'origin', text) && r.st.calls.length === 0 && !`${r.stdout}${r.stderr}`.includes('ghp_sekret'), shown(r))
}
{
  const ghe = run(ARGS, { cwd: repoWith('ghe', `git@ghe.example.com:${SLUG}.git`), env: { FLOW_GH_HOSTS: 'ghe.example.com' }, st: freshState({ pr: { url: `https://ghe.example.com/${SLUG}/pull/${PR}` } }) })
  check('FLOW_GH_HOSTS admits that host, and every call pins it', merged(ghe) && ghe.st.calls.every(pinnedTo(`ghe.example.com/${SLUG}`, 'ghe.example.com')), shown(ghe))
  const crossed = run(ARGS, { cwd: repoWith('ghe-crossed', `git@ghe.example.com:${SLUG}.git`), env: { FLOW_GH_HOSTS: 'ghe.example.com' } })
  check('a github.com url answering for a GHE origin is a redirect', refusedWith(crossed, 'redirected', 'was redirected'), shown(crossed))
}
{
  const bin = join(tmp, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nenv\n')
  chmodSync(join(bin, 'gh'), 0o755)
  const seen = ghRunner({ PATH: `${bin}:/usr/bin:/bin`, GH_REPO: 'someone/evil', GH_HOST: 'evil.example', KEEP: 'kept' })([]).stdout
  check('the gh runner never hands GH_REPO or GH_HOST to gh', !/^GH_(REPO|HOST)=/m.test(seen) && /^KEEP=kept$/m.test(seen), seen)
  // A relative PATH entry names a different gh in each directory, so the repository an executor
  // works in could supply one. Only absolute entries count, and with no gh in one, nothing runs.
  const planted = join(tmp, 'planted')
  mkdirSync(join(planted, 'bin'), { recursive: true })
  writeFileSync(join(planted, 'bin', 'gh'), '#!/bin/sh\necho PLANTED-GH\n')
  chmodSync(join(planted, 'bin', 'gh'), 0o755)
  const here = process.cwd()
  let first, none
  try {
    process.chdir(planted)
    first = ghRunner({ PATH: `bin:${bin}:/usr/bin:/bin` })([], { cwd: planted })
    none = ghRunner({ PATH: ':bin' })([], { cwd: planted })
  } finally { process.chdir(here) }
  check('the gh runner skips a relative PATH entry for the absolute one after it', first.code === 0 && !first.stdout.includes('PLANTED-GH'), JSON.stringify(first))
  check('with no gh in an absolute PATH entry the gh runner runs nothing', none.code !== 0 && !none.stdout.includes('PLANTED-GH'), JSON.stringify(none))
  const childPath = (first.stdout.match(/^PATH=(.*)$/m) ?? [])[1]
  check('gh is handed a PATH of absolute entries only', childPath !== undefined && childPath.split(':').every((dir) => isAbsolute(dir)), String(childPath))
}
{
  // git runs its own helpers by PATH from inside the repository it was pointed at: ssh for an
  // ssh remote. The PATH a child gets keeps absolute entries only, so a repository's bin/ssh never
  // runs with the executor's credentials. ls-remote on an ssh:// remote calls ssh without needing
  // the host to resolve.
  const inspected = repoWith('planted-ssh', 'ssh://example.invalid/x')
  const ran = join(tmp, 'planted-ssh-ran')
  mkdirSync(join(inspected, 'bin'))
  writeFileSync(join(inspected, 'bin', 'ssh'), `#!/bin/sh\n: > ${ran}\nexit 1\n`, { mode: 0o755 })
  // An ssh that fails at once in an absolute entry, so the case never waits on a real ssh's lookup,
  // and leaves a marker so the case proves git reached ssh at all. An inherited GIT_SSH or
  // GIT_SSH_COMMAND would bypass the PATH lookup and pass the case without testing it.
  const quickSsh = join(tmp, 'quick-ssh')
  const quickRan = join(tmp, 'quick-ssh-ran')
  mkdirSync(quickSsh)
  writeFileSync(join(quickSsh, 'ssh'), `#!/bin/sh\n: > ${quickRan}\nexit 1\n`, { mode: 0o755 })
  const sshEnv = { ...process.env, PATH: `bin:${quickSsh}:${process.env.PATH}` }
  delete sshEnv.GIT_SSH
  delete sshEnv.GIT_SSH_COMMAND
  const r = execCapture('git', ['-C', inspected, 'ls-remote', 'origin'], { timeoutMs: 20_000, env: sshEnv })
  check('git run through execCapture never reaches an ssh the repository plants behind a relative PATH entry', !existsSync(ran) && existsSync(quickRan), JSON.stringify(r))
  // git also takes a helper directory from the environment and resolves a relative one inside
  // the repository, so a relative GIT_EXEC_PATH is dropped. GIT_SSH and GIT_SSH_COMMAND are the
  // operator's and pass through; the nightly lint's own GIT_SSH_COMMAND still reaches ssh.
  const absEnv = { ...sshEnv, PATH: `${quickSsh}:${process.env.PATH}` }
  rmSync(ran, { force: true })
  rmSync(quickRan, { force: true })
  const viaExecPath = execCapture('git', ['-C', inspected, 'ls-remote', 'origin'], { timeoutMs: 20_000, env: { ...absEnv, GIT_EXEC_PATH: 'bin' } })
  check('a relative GIT_EXEC_PATH never runs the repository\'s ssh, and git still reaches the absolute one', !existsSync(ran) && existsSync(quickRan), JSON.stringify(viaExecPath))
  rmSync(ran, { force: true })
  rmSync(quickRan, { force: true })
  const lint = execCapture('git', ['-C', inspected, 'ls-remote', 'origin'], { timeoutMs: 20_000, env: { ...absEnv, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' } })
  check('the nightly lint\'s GIT_SSH_COMMAND still reaches ssh through the absolute PATH', existsSync(quickRan) && !existsSync(ran), JSON.stringify(lint))
}
{
  // The same rule for git, through the executor: the repository it is run in plants bin/git,
  // which would name another origin, and a relative PATH entry points at it.
  const inspected = repoWith('planted-git', `git@github.com:${SLUG}.git`)
  const ran = join(tmp, 'planted-git-ran')
  mkdirSync(join(inspected, 'bin'))
  writeFileSync(join(inspected, 'bin', 'git'), `#!/bin/sh\ntouch ${ran}\necho git@github.com:someone/evil.git\n`)
  chmodSync(join(inspected, 'bin', 'git'), 0o755)
  const [here, hostPath] = [process.cwd(), process.env.PATH]
  let first, none
  try {
    process.chdir(inspected)
    process.env.PATH = `bin:${hostPath}`
    first = run(ARGS, { cwd: inspected })
    process.env.PATH = 'bin'
    none = run(ARGS, { cwd: inspected })
  } finally { process.chdir(here); process.env.PATH = hostPath }
  check('the executor reads origin with the git an absolute PATH entry names, never one the repository plants', merged(first) && !existsSync(ran), shown(first))
  check('with no git in an absolute PATH entry the executor refuses at the origin read', refusedWith(none, 'origin') && !existsSync(ran), shown(none))
}

console.log('\nthe arguments')
{
  const help = run(['--help'])
  check('--help prints the usage and exits 0 with no gh call', help.code === 0 && help.stdout.startsWith('usage: land-merge.mjs') && help.st.calls.length === 0, shown(help))
  for (const [name, args] of [['--accept-flake with no value', [...ARGS, '--accept-flake']], ['an empty --accept-flake=', [...ARGS, '--accept-flake=']],
    ['an --accept-flake that is only spaces', [...ARGS, '--accept-flake', '  ']]]) {
    const r = run(args)
    check(`${name} is a usage refusal that calls no gh`, refusedWith(r, 'usage', 'accept-flake') && r.st.calls.length === 0, shown(r))
  }
  const moved = run(ARGS, { st: freshState({ pr: { headRefOid: 'c'.repeat(40) } }) })
  check('head-moved names the url, the head branch and both SHAs', [PR_URL, BRANCH, HEAD, 'c'.repeat(40)].every((s) => detailOf(moved, 'head-moved').includes(s)), detailOf(moved, 'head-moved'))
  const commitReads = moved.st.calls.filter((a) => a[0] === 'api' && String(a.at(-1)).includes('/commits/'))
  check('and the checks and the check-suite count are read on the argument head, not GitHub\'s', commitReads.length === 3 && commitReads.every((a) => String(a.at(-1)).includes(`/commits/${HEAD}/`)), JSON.stringify(commitReads))
}

console.log('\nwhat counts as a check')
{
  const many = Array.from({ length: 100 }, (unused, i) => checkRun(`c${i}`, 'success')).concat(checkRun('the-101st', 'failure'))
  const paged = run(ARGS, { st: freshState({ checkRuns: many }) })
  check('a failing 101st check, on the second page, refuses ci-failed', refusedWith(paged, 'ci-failed', 'the-101st'), shown(paged))
  check('it is the one listed failed, with its link', paged.json?.checks?.failed.map((f) => `${f.name} ${f.link}`).join() === `the-101st ${many[100].details_url}`, JSON.stringify(paged.json?.checks))
  const short = run(ARGS, { st: freshState({ totalCount: 3 }) })
  check('a read short of total_count refuses ci-unknown', refusedWith(short, 'ci-unknown', 'total_count 3'), shown(short))
  const nameless = run(ARGS, { st: freshState({ checkRuns: [checkRun('unit', 'success'), checkRun(undefined, 'success')] }) })
  check('a nameless green check run refuses ci-unknown', refusedWith(nameless, 'ci-unknown'), shown(nameless))
  check('and is listed unknown with its link, not counted green', nameless.json?.checks?.unknown[0]?.name === null && typeof nameless.json?.checks?.unknown[0]?.link === 'string', JSON.stringify(nameless.json?.checks))
  const namelessStatus = run(ARGS, { st: freshState({ statuses: [status(undefined, 'success')] }) })
  check('a nameless commit status refuses ci-unknown', refusedWith(namelessStatus, 'ci-unknown'), shown(namelessStatus))
  const pending = run(ARGS, { st: freshState({ checkRuns: [checkRun('unit', null)] }) })
  check('a check run not yet completed refuses ci-pending', refusedWith(pending, 'ci-pending', 'unit') && pending.json?.checks?.pending[0]?.name === 'unit', shown(pending))
  const pendingStatus = run(ARGS, { st: freshState({ statuses: [status('coderabbit', 'pending')] }) })
  check('a pending commit status refuses ci-pending', refusedWith(pendingStatus, 'ci-pending', 'coderabbit'), shown(pendingStatus))
  const stale = run(ARGS, { st: freshState({ checkRuns: [checkRun('unit', 'stale')] }) })
  check('a conclusion outside the known sets refuses ci-unknown', refusedWith(stale, 'ci-unknown', 'unit'), shown(stale))
  // Past 1000 check suites the check-runs read can miss a failing run while its total_count still
  // agrees, so the suite count is read on its own and a read at the window, or none, is unknown.
  const windowed = run(ARGS, { st: freshState({ suiteCount: 1000 }) })
  check('a head carrying 1000 check suites refuses ci-unknown, naming the window', refusedWith(windowed, 'ci-unknown', '1000-suite window'), shown(windowed))
  // Every page's total_count has to agree: 101 on page 1 and 102 on page 2 is a read that moved
  // under it, though the list it collected matches page 1.
  const manySuites = Array.from({ length: 101 }, (unused, i) => ({ id: 600 + i, status: 'completed', conclusion: 'success' }))
  const driftSuites = run(ARGS, { st: freshState({ suites: manySuites, pageTotals: { 'check-suites': [101, 102] } }) })
  check('check-suite pages that disagree on total_count refuse ci-unknown', refusedWith(driftSuites, 'ci-unknown', '101, 102'), shown(driftSuites))
  const manyRuns = Array.from({ length: 101 }, (unused, i) => checkRun(`r${i}`, 'success'))
  const driftRuns = run(ARGS, { st: freshState({ checkRuns: manyRuns, pageTotals: { 'check-runs': [101, 102] } }) })
  check('check-run pages that disagree on total_count refuse ci-unknown', refusedWith(driftRuns, 'ci-unknown', '101, 102'), shown(driftRuns))
  const partSuites = run(ARGS, { st: freshState({ suiteCount: 5 }) })
  check('a check-suite read short of its total_count refuses ci-unknown', refusedWith(partSuites, 'ci-unknown', 'every suite'), shown(partSuites))
  const unsuited = run(ARGS, { st: freshState({ fail: 'check-suites' }) })
  check('an unreadable check-suite count refuses ci-unknown', refusedWith(unsuited, 'ci-unknown', 'check-suite count'), shown(unsuited))
  const none = run(ARGS, { st: freshState({ checkRuns: [], statuses: [] }) })
  check('no checks at all refuses ci-unknown', refusedWith(none, 'ci-unknown', 'no checks at all'), shown(none))
  const superseded = run(ARGS, { st: freshState({ statuses: [status('coderabbit', 'success'), status('coderabbit', 'failure'), status('coderabbit', 'pending')] }) })
  check('only the newest status of a context counts: a green one over an old failure merges', merged(superseded), shown(superseded))
  const regressed = run(ARGS, { st: freshState({ statuses: [status('coderabbit', 'failure'), status('coderabbit', 'success')] }) })
  check('and a failure over an old green refuses ci-failed', refusedWith(regressed, 'ci-failed', 'coderabbit'), shown(regressed))
}

console.log('\na read that fails or answers in the wrong shape refuses read-failed, and nothing merges')
{
  const view = run(ARGS, { st: freshState({ fail: 'view' }) })
  check('the pull request read, which ends the run there', refusedWith(view, 'read-failed', 'gh pr view') && view.st.calls.length === 1 && view.json.checks === undefined, shown(view))
  for (const [name, over, text] of [
    ['the repository read', { fail: 'repo' }, 'default branch could not be read'],
    ['the compare', { fail: 'compare' }, 'HTTP 500'],
    ['a compare with no behind_by', { malformed: 'compare' }, 'behind_by'],
    ['a compare with no base commit', { malformed: 'compare-base' }, 'base commit'],
    ['the check runs', { fail: 'check-runs' }, 'HTTP 500'],
    ['a check-runs page with no check_runs', { malformed: 'check-runs' }, 'check_runs'],
    ['the commit statuses', { fail: 'statuses' }, 'HTTP 500'],
    ['a statuses page that is not a list', { malformed: 'statuses' }, 'not a list'],
    ['the known-flakes file', { flakesHttp: 500 }, 'HTTP 500'],
    ['a known-flakes file with no base64 contents', { baseFlakes: 'e2e\n', flakesEncoding: 'none' }, 'base64'],
    ['the review threads', { fail: 'threads' }, 'reviewThreads'],
    ['the re-read before the merge', { fail: 'recheck' }, 're-read'],
    ['the default branch tip before the merge', { fail: 'tip' }, 'tip of main'],
  ]) {
    const r = run(ARGS, { st: freshState(over) })
    check(name, refusedWith(r, 'read-failed', text), shown(r))
  }
}

console.log('\nknown flakes come from the base, never the branch')
{
  const failing = [checkRun('unit', 'success'), checkRun('e2e', 'failure')]
  const base = run(ARGS, { st: freshState({ checkRuns: failing, baseFlakes: '# flaky\ne2e\n' }) })
  check('a base-listed bare check merges through', merged(base), shown(base))
  check('and is in excused with its link', JSON.stringify(base.json?.excused) === JSON.stringify([{ check: 'e2e', link: failing[1].details_url }]), JSON.stringify(base.json?.excused))
  check('the file is read on the base ref, for the verdict and again before the merge', contentsCalls(base.st).length === 2 && contentsCalls(base.st).every((a) => String(a.at(-1)).endsWith('/contents/.github/known-flakes.txt?ref=main')), JSON.stringify(contentsCalls(base.st)))
  const branch = run(ARGS, { st: freshState({ checkRuns: failing, headFlakes: 'e2e\n' }) })
  check('the same line on the branch alone excuses nothing', refusedWith(branch, 'ci-failed', 'e2e') && branch.json?.checks?.excused.length === 0, shown(branch))
  check('and no contents call ever names the head', contentsCalls(branch.st).length > 0 && !branch.st.calls.some((a) => a[0] === 'api' && String(a.at(-1)).includes('/contents/') && String(a.at(-1)).includes(HEAD)), JSON.stringify(contentsCalls(branch.st)))
  const perTest = { checkRuns: failing, baseFlakes: 'e2e:test_login\n' }
  const candidate = run(ARGS, { st: freshState(perTest) })
  check('a check:test entry excuses nothing on its own', refusedWith(candidate, 'ci-failed', 'e2e'), shown(candidate))
  check('and names the test to look for in the log', JSON.stringify(candidate.json?.checks?.flakeCandidates) === '{"e2e":["test_login"]}', JSON.stringify(candidate.json?.checks))
  const accepted = run([...ARGS, '--accept-flake', 'e2e:test_login'], { st: freshState(perTest) })
  check('--accept-flake on the declared entry merges', merged(accepted), shown(accepted))
  check('and excused names the check, the test and the link', JSON.stringify(accepted.json?.excused) === JSON.stringify([{ check: 'e2e', test: 'test_login', link: failing[1].details_url }]), JSON.stringify(accepted.json?.excused))
  const equals = run([...ARGS, '--accept-flake=e2e:test_login'], { st: freshState(perTest) })
  check('the --accept-flake=<entry> spelling is the same flag', merged(equals), shown(equals))
  for (const [name, args, over, text] of [
    ['an invented entry', [...ARGS, '--accept-flake', 'e2e:test_other'], perTest, 'not an entry'],
    ['a name two failed jobs carry', [...ARGS, '--accept-flake', 'e2e:test_login'], { ...perTest, checkRuns: [...failing, checkRun('e2e', 'failure')] }, 'one job log'],
    ['two flags on one check', [...ARGS, '--accept-flake', 'e2e:test_a', '--accept-flake', 'e2e:test_b'], { checkRuns: failing, baseFlakes: 'e2e:test_a\ne2e:test_b\n' }, 'both name'],
    ['a flag naming no test', [...ARGS, '--accept-flake', 'e2e'], perTest, 'names no test'],
    ['a flag on a check that did not fail', [...ARGS, '--accept-flake', 'unit:test_x'], { checkRuns: failing, baseFlakes: 'unit:test_x\n' }, 'not a failed check'],
  ]) {
    const r = run(args, { st: freshState(over) })
    check(`${name} refuses accept-flake-refused, and the failure stays failed`, refusedWith(r, 'accept-flake-refused', text) && codes(r).includes('ci-failed') && r.json?.checks?.excused.length === 0, shown(r))
  }
  const colon = run([...ARGS, '--accept-flake', 'ci/circleci: build:flaky_test'], { st: freshState({ checkRuns: [], statuses: [status('ci/circleci: build', 'failure')], baseFlakes: 'ci/circleci: build:flaky_test\n' }) })
  check('a context with its own colon splits after the reported name', merged(colon) && colon.json?.excused[0]?.check === 'ci/circleci: build' && colon.json.excused[0].test === 'flaky_test', shown(colon))
  const broken = run(ARGS, { st: freshState({ checkRuns: failing, baseFlakes: 'e2e\n', flakesHttp: 500 }) })
  check('an unreadable file excuses nothing', refusedWith(broken, 'read-failed', 'known-flakes') && codes(broken).includes('ci-failed') && broken.json?.checks?.excused.length === 0, shown(broken))
  const brokenFlag = run([...ARGS, '--accept-flake', 'e2e:test_login'], { st: freshState({ ...perTest, flakesHttp: 500 }) })
  check('and a flag cannot excuse against a file nobody read', refusedWith(brokenFlag, 'read-failed') && codes(brokenFlag).includes('ci-failed') && brokenFlag.json?.checks?.excused.length === 0, shown(brokenFlag))
}

console.log('\nreview threads, the base, and every stop at once')
{
  const paged = run(ARGS, { st: freshState({ threadPages: [Array.from({ length: 100 }, (u, i) => thread(`T${i}`)), [thread('T-late', false)]] }) })
  check('an unresolved thread on the second page refuses threads-unresolved', refusedWith(paged, 'threads-unresolved'), shown(paged))
  const late = paged.json?.threads?.[0]
  check('and is listed with its id, path, url, author and newest message', paged.json?.threads?.length === 1 && late.id === 'T-late' && late.path === 'scripts/x.mjs' &&
    late.url === `${PR_URL}#r-T-late` && late.author === 'reviewer' && late.lastBody === 'a word', JSON.stringify(paged.json?.threads))
  const cursorless = run(ARGS, { st: freshState({ threadPages: [[thread('T1')], [thread('T2')]], threadsNoCursor: true }) })
  check('another page with no cursor refuses read-failed', refusedWith(cursorless, 'read-failed', 'cursor'), shown(cursorless))
  const endless = run(ARGS, { st: freshState({ threadPages: Array.from({ length: 21 }, (u, i) => [thread(`T${i}`)]) }) })
  check('a 21st page refuses read-failed', refusedWith(endless, 'read-failed', '20 pages'), shown(endless))
  const behind = run(ARGS, { st: freshState({ behindBy: 3 }) })
  check('a head behind the default branch refuses behind-base', refusedWith(behind, 'behind-base', '3 commit'), shown(behind))
  check('read off compare/<default>...<head>', behind.st.calls.some((a) => a[0] === 'api' && a.at(-1) === `repos/${SLUG}/compare/main...${HEAD}`), JSON.stringify(behind.st.calls.filter((a) => a[0] === 'api')))
  const both = run(ARGS, { st: freshState({ checkRuns: [checkRun('e2e', 'failure')], threadPages: [[thread('T1', false)]] }) })
  check('a red check and an open thread refuse with both codes in one run', refusedWith(both, 'ci-failed') && refusedWith(both, 'threads-unresolved') &&
    both.json?.checks?.failed[0]?.name === 'e2e' && both.json?.threads?.[0]?.id === 'T1', shown(both))
  check('and a gate stop refuses before the re-read', both.st.calls.filter((a) => a[0] === 'pr' && a[1] === 'view').length === 1, JSON.stringify(both.st.calls.filter((a) => a[0] === 'pr')))
  const current = run()
  const mergeAt = current.st.calls.findIndex((a) => a[0] === 'pr' && a[1] === 'merge')
  check('the default branch tip is the last read before the merge', mergeAt > 0 &&
    JSON.stringify(current.st.calls[mergeAt - 1]) === JSON.stringify(['api', '--hostname', 'github.com', `repos/${SLUG}/git/ref/heads/main`]), JSON.stringify(current.st.calls.slice(-3)))
  // CI is read again right before the merge, and anything that moved since the verdict refuses.
  for (const [name, later] of [
    ['a rerun of a check', { checkRuns: [checkRun('unit', 'success'), checkRun('lint', 'skipped')] }],
    ['a check that turned red', { checkRuns: null }],
    ['a new commit status', { statuses: [status('coderabbit', 'failure')] }],
    ['a new check suite', { suites: [...freshState().suites, { id: 503, status: 'queued', conclusion: null }] }],
    // A rerequest resets a suite to queued while its runs and the suite count stay as they were.
    ['a check suite rerequested', { suites: [{ id: 501, status: 'queued', conclusion: null }, freshState().suites[1]] }],
  ]) {
    const st = freshState()
    if (later.checkRuns === null) later.checkRuns = [{ ...st.checkRuns[0], conclusion: 'failure' }, st.checkRuns[1]]
    const moved = run(ARGS, { st: { ...st, later } })
    check(`${name} between the verdict and the merge refuses gate-moved naming ci, and nothing merges`, refusedWith(moved, 'gate-moved', 'ci changed'), shown(moved))
  }
  for (const source of ['check-runs', 'statuses', 'check-suites']) {
    const lost = run(ARGS, { st: freshState({ failLater: source }) })
    const code = source === 'check-suites' ? 'ci-unknown' : 'read-failed'
    check(`a ${source} re-read that fails before the merge refuses ${code}, and nothing merges`, refusedWith(lost, code, 'immediately before the merge'), shown(lost))
  }
  // Every gate fact is read again, not only CI: a thread opened, or a known flake withdrawn from
  // the base, between the verdict and the merge refuses gate-moved naming what moved, and a thread
  // re-read that cannot be shown whole refuses as unknown.
  const opened = run(ARGS, { st: freshState({ later: { threadPages: [[thread('T1'), thread('T2', false)]] } }) })
  check('a review thread opened between the verdict and the merge refuses gate-moved naming threads, and nothing merges', refusedWith(opened, 'gate-moved', 'threads'), shown(opened))
  const cutThreads = run(ARGS, { st: freshState({ later: { threadPages: [[thread('T1')], [thread('T2')]], threadsNoCursor: true } }) })
  check('a thread re-read that cannot be shown whole refuses, and nothing merges', refusedWith(cutThreads, 'read-failed', 'immediately before the merge'), shown(cutThreads))
  const withdrawn = run(ARGS, { st: freshState({ checkRuns: [checkRun('unit', 'success'), checkRun('e2e', 'failure')], baseFlakes: 'e2e\n', later: { baseFlakes: '' } }) })
  check('an excused flake withdrawn from the base between the verdict and the merge refuses gate-moved naming flakes, and nothing merges', refusedWith(withdrawn, 'gate-moved', 'flakes'), shown(withdrawn))
  // The re-read is held to the first read's completeness rule: the same runs under a total_count
  // that says there are more is an incomplete read, not an unchanged one.
  const short = run(ARGS, { st: freshState({ later: { totalCount: 3 } }) })
  check('a re-read that collects fewer runs than its total_count refuses ci-unknown, and nothing merges', refusedWith(short, 'ci-unknown', 'total_count 3'), shown(short))
  // A failing run excused as a known flake, renamed between the reads: same id, status and conclusion.
  const flaky = [checkRun('unit', 'success'), checkRun('e2e', 'failure')]
  const renamed = run(ARGS, { st: freshState({ checkRuns: flaky, baseFlakes: 'e2e\n', later: { checkRuns: [flaky[0], { ...flaky[1], name: 'e2e-renamed' }] } }) })
  check('an excused run renamed between the verdict and the merge refuses gate-moved naming ci, and nothing merges', refusedWith(renamed, 'gate-moved', 'ci changed'), shown(renamed))
  const landedMeanwhile = run(ARGS, { st: freshState({ tipAtMerge: 'a'.repeat(40) }) })
  check('a land elsewhere after the compare refuses behind-base, and nothing merges', refusedWith(landedMeanwhile, 'behind-base', 'moved from') &&
    ['f'.repeat(12), 'a'.repeat(12), HEAD.slice(0, 12)].every((s) => detailOf(landedMeanwhile, 'behind-base').includes(s)), shown(landedMeanwhile))
  const closedBehind = run(ARGS, { st: freshState({ pr: { state: 'MERGED' }, behindBy: 1 }) })
  check('a merged pull request behind main reports not-open and behind-base together', codes(closedBehind).join() === 'not-open,behind-base' && closedBehind.st.merges.length === 0, shown(closedBehind))
}

console.log('\none JSON line on stdout, one human line on stderr, and the exit says which')
for (const [name, over, code, result] of [
  ['merged', {}, 0, 'merged'],
  ['refused', { checkRuns: [checkRun('e2e', 'failure')] }, 1, 'refused'],
  ['unknown', { mergeExit: 1, confirmFails: true }, 4, 'unknown'],
]) {
  const r = run(ARGS, { st: freshState(over) })
  const lines = r.stdout.split('\n')
  check(`${name}: exit ${code}, one line of JSON with result ${result}, one line on stderr`, r.code === code && lines.length === 2 && lines[1] === '' &&
    r.json?.result === result && r.stderr.split('\n').filter(Boolean).length === 1 && r.stderr.endsWith('\n'), shown(r))
}
{
  const usage = run(['12', 'abc'])
  check('a usage refusal is a JSON line too, with exit 1', usage.code === 1 && usage.stdout.split('\n').length === 2 && usage.json?.result === 'refused' && codes(usage).join() === 'usage', shown(usage))
}

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nland-merge: ALL PASS' : `\nland-merge: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
