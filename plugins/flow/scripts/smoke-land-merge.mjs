#!/usr/bin/env node
// Smoke for scripts/land-merge.mjs, the land gate and the only merge. The executor runs in process
// against real repositories under mktemp, whose origin it reads with real git, and a fake gh
// injected as a function that answers from a per-case state object in the shapes GitHub serves:
// `gh api --paginate --slurp` prints an outer array with one element per page (a check-runs page
// is an object carrying check_runs, a statuses page is the array itself), paged at the 100 the
// executor asks for, so a 101st check really is on a second page. The fake records every call and
// every merge. Every case reads the one JSON line and the exit; each refusal asserts that nothing
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
const freshState = (over = {}) => ({
  defaultBranch: 'main', mergeExit: 0, landsNothing: false, confirmFails: false, queue: null, queueFails: false, recheck: {}, after: {},
  queueAfter: undefined, queueAfterFails: false, merged: false, fail: null, malformed: null, behindBy: 0, baseTip: 'f'.repeat(40), tipAtMerge: null,
  checkRuns: [checkRun('unit', 'success'), checkRun('lint', 'skipped')], totalCount: null, statuses: [],
  threadPages: [[thread('T1')]], threadsNoCursor: false, baseFlakes: null, headFlakes: null, flakesHttp: null, flakesEncoding: 'base64',
  calls: [], merges: [], ...over,
  pr: { headRefOid: HEAD, headRefName: BRANCH, state: 'OPEN', isDraft: false, baseRefName: 'main', url: PR_URL, autoMergeRequest: null, ...(over.pr || {}) },
})
const field = (args, key) => { const hit = args.find((a) => String(a).startsWith(`${key}=`)); return hit === undefined ? null : String(hit).slice(key.length + 1) }
const makeRunGh = (st) => (args) => {
  st.calls.push(args)
  const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
  const fail = (stderr, stdout = '') => ({ code: 1, stdout, stderr })
  const serverError = () => fail('gh: Server Error (HTTP 500)\n', '{"message":"Server Error"}')
  if (args[0] === 'pr' && args[1] === 'view') {
    const fields = args[args.indexOf('--json') + 1]
    if (fields === 'baseRefName,headRefOid') return st.fail === 'recheck' ? serverError() : ok({ baseRefName: st.pr.baseRefName, headRefOid: st.pr.headRefOid, ...st.recheck })
    if (fields.startsWith('state,')) {
      if (st.confirmFails) return fail('fake gh: view failed\n')
      return ok({ ...st.pr, state: st.merged ? 'MERGED' : st.pr.state, autoMergeRequest: null, ...st.after })
    }
    return st.fail === 'view' ? serverError() : ok(st.pr)
  }
  if (args[0] === 'repo' && args[1] === 'view') return st.fail === 'repo' ? serverError() : ok({ defaultBranchRef: { name: st.defaultBranch } })
  if (args[0] === 'api' && args[1] === 'graphql') {
    if ((field(args, 'query') ?? '').includes('reviewThreads')) {
      if (st.fail === 'threads') return fail("gh: Field 'reviewThreads' doesn't exist\n")
      const index = field(args, 'cursor') === null ? 0 : Number(field(args, 'cursor').slice(1))
      const more = index < st.threadPages.length - 1
      return ok({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: more, endCursor: more && !st.threadsNoCursor ? `c${index + 1}` : null }, nodes: st.threadPages[index] } } } } })
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
      const text = decodeURIComponent(path.split('ref=')[1] ?? '') === st.pr.baseRefName ? st.baseFlakes : st.headFlakes
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
    const endpoint = ['check-runs', 'statuses'].find((e) => path.includes(`/${e}?`))
    if (endpoint !== undefined && args.includes('--paginate') && args.includes('--slurp')) {
      if (st.fail === endpoint) return serverError()
      if (st.malformed === endpoint) return ok([{ message: 'not a page' }])
      if (endpoint === 'check-runs') return ok(pagesOf(st.checkRuns).map((page) => ({ total_count: st.totalCount ?? st.checkRuns.length, check_runs: page })))
      return ok(pagesOf(st.statuses))
    }
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
    JSON.stringify(r.st.merges[0]) === JSON.stringify(['pr', 'merge', String(PR), '--repo', IDENTITY, '--squash', '--match-head-commit', HEAD]), JSON.stringify(r.st.merges))
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
  ['a retarget before the merge', 'retargeted', 'was retargeted', { recheck: { baseRefName: 'release' } }],
  ['a head moved before the merge', 'head-moved', 'moved mid-run', { recheck: { headRefOid: 'd'.repeat(40) } }],
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
  check('and the checks are read on the argument head, not GitHub\'s', commitReads.length === 2 && commitReads.every((a) => String(a.at(-1)).includes(`/commits/${HEAD}/`)), JSON.stringify(commitReads))
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
  check('the file is read on the base ref', contentsCalls(base.st).length === 1 && String(contentsCalls(base.st)[0].at(-1)).endsWith('/contents/.github/known-flakes.txt?ref=main'), JSON.stringify(contentsCalls(base.st)))
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
  check('and a gate stop refuses before the re-read', !both.st.calls.some((a) => a[0] === 'pr' && a[a.indexOf('--json') + 1] === 'baseRefName,headRefOid'), JSON.stringify(both.st.calls.filter((a) => a[0] === 'pr')))
  const current = run()
  const mergeAt = current.st.calls.findIndex((a) => a[0] === 'pr' && a[1] === 'merge')
  check('the default branch tip is the last read before the merge', mergeAt > 0 &&
    JSON.stringify(current.st.calls[mergeAt - 1]) === JSON.stringify(['api', '--hostname', 'github.com', `repos/${SLUG}/git/ref/heads/main`]), JSON.stringify(current.st.calls.slice(-3)))
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
