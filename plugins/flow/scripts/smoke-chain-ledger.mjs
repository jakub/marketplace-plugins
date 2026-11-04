#!/usr/bin/env node
// Smoke for scripts/chain-ledger.mjs, driven in process with every git call real and gh injected
// as a function that answers from a per-case state object, records each call, and fails the case
// on any call it doesn't know.
//
// Each case gets a bare repository standing in for origin at git@github.com:jakub/demo.git, reached
// through a GIT_SSH_COMMAND script that runs upload-pack against it on disk, so the ledger's one
// ls-remote is real and nothing leaves the machine. Claim tags and run branches are planted on the
// bare repository directly. One case runs the printed footer through sh with a gh on PATH that
// replays the answers the in-process run got, so the footer is shown to re-run byte for byte. One
// case hands the ledger's body digest to issueClaim itself, so parity with the claim's own check
// is a run and not a reading.
//
// Run: node plugins/flow/scripts/smoke-chain-ledger.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chainLedger, parseRequest } from './chain-ledger.mjs'
import { bodyDigest, issueClaim } from './issue-claim.mjs'

let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad += 1
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` -> ${detail}`}`)
}

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'chain-ledger.mjs')
/** How a footer word is quoted for sh: bare when it is plain, else single-quoted. */
const quote = (word) => (/^[A-Za-z0-9_/.:,=@+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-chain-ledger-')))
// In process, so the isolation goes on process.env: no developer gitconfig, no prompt, no proxy.
Object.assign(process.env, {
  HOME: tmp, GIT_CONFIG_GLOBAL: join(tmp, 'none'), GIT_CONFIG_SYSTEM: join(tmp, 'none'),
  GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 'smoke@example.invalid', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
  GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', GIT_SSH_COMMAND: 'false',
})
for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'GIT_TRACE', 'FLOW_GH_HOSTS']) delete process.env[key]

const PIN = 'github.com/jakub/demo'
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const AC = '## Acceptance Criteria\n\n- [ ] the ledger reads it\n  - evidence: this smoke\n'
const bodyOf = (n) => `Why issue ${n} exists.\n\n${AC}`
const ATTRIBUTION = '> [!NOTE]\n> 🤖 **Claude Opus 5.5 responding on behalf of jakub**\n\n'

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const allRefs = (dir) => spawnSync('git', ['-C', dir, 'show-ref'], { encoding: 'utf8' }).stdout

/** A clone whose origin names a host and is still a bare repository on disk. */
let worlds = 0
const makeWorld = (remote = 'git@github.com:jakub/demo.git') => {
  const dir = join(tmp, `w${worlds += 1}`)
  const base = join(dir, 'base')
  const origin = join(base, 'jakub', 'demo.git')
  const repo = join(dir, 'repo')
  mkdirSync(join(base, 'jakub'), { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'first')
  git(repo, 'remote', 'add', 'origin', 'git@github.com:jakub/demo.git')
  const ssh = join(dir, 'ssh')
  writeFileSync(ssh, `#!/bin/sh\ncd ${base} || exit 1\nfor a; do last=$a; done\nexec /bin/sh -c "$last"\n`)
  chmodSync(ssh, 0o755)
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'main'], { env: { ...process.env, GIT_SSH_COMMAND: ssh }, stdio: 'ignore' })
  git(repo, 'remote', 'set-url', 'origin', remote)
  const mainSha = git(repo, 'rev-parse', 'HEAD')
  return { dir, origin, repo, ssh, mainSha, plant: (ref) => git(origin, 'update-ref', ref, mainSha) }
}

const linkTo = (number, repo = { name: 'demo', owner: { login: 'jakub' } }) => ({ id: `PR_${number}`, number, repository: repo, url: `https://github.com/jakub/demo/pull/${number}` })
const issue = (n, over = {}) => ({
  number: n, title: `Issue ${n}`, state: 'OPEN', labels: [{ name: 'ready-for-agent' }], body: bodyOf(n),
  url: `https://github.com/jakub/demo/issues/${n}`, comments: [], closedByPullRequestsReferences: [], ...over,
})
const hex = (seed) => createHash('sha1').update(String(seed)).digest('hex')
const pr = (number, issueN, over = {}) => ({
  number, state: 'OPEN', headRefName: `feat/issue-${issueN}-issue-${issueN}`, headRefOid: hex(`head-${number}`), isCrossRepository: false,
  mergeCommit: null, mergedBy: null, closingIssuesReferences: [{ id: `I_${issueN}`, number: issueN, repository: { name: 'demo', owner: { login: 'jakub' } } }], ...over,
})
const merged = (number, issueN, by = 'jakub', over = {}) => pr(number, issueN, { state: 'MERGED', mergeCommit: { oid: hex(`merge-${number}`) }, mergedBy: { login: by }, ...over })
const comment = (body, login = 'jakub', createdAt = '2026-11-03T10:00:00Z') => ({ author: { login }, body, createdAt })
const cleanComment = (prNumber, head, over = {}) => comment(`${ATTRIBUTION}babysit: clean #${prNumber} ${head}\n\nAll green.\n`, over.login, over.createdAt)

const ISSUE_FIELDS = 'number,title,state,labels,body,url,comments,closedByPullRequestsReferences'
const PR_FIELDS = 'number,state,headRefName,headRefOid,isCrossRepository,mergeCommit,mergedBy,closingIssuesReferences'
/** Every gh call any ledger run made, across every case, for the no-mutation sweep at the end. */
const everyCall = []
const everyUnexpected = []

const freshState = (over = {}) => ({ login: 'jakub', defaultBranch: 'main', issues: {}, prs: {}, compares: {}, fail: new Set(), calls: [], ...over })
/** Dispatch on the whole argv. Anything not listed here is unexpected and fails the run's case and the sweep. */
const makeRunGh = (st) => (args, options) => {
  const answer = (() => {
    const ok = (value) => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' })
    const nope = (what) => ({ code: 1, stdout: '', stderr: `fake gh: ${what} failed for git@github.com:jakub/demo.git\n` })
    const line = args.join(' ')
    let m
    if (line === `repo view ${PIN} --json defaultBranchRef`) return st.fail.has('repo') ? nope('repo view') : ok({ defaultBranchRef: { name: st.defaultBranch } })
    if (line === 'api --hostname github.com user --jq .login') return st.fail.has('user') ? nope('user') : ok(`${st.login}\n`)
    if ((m = line.match(new RegExp(`^issue view ([0-9]+) --repo ${PIN} --json ${ISSUE_FIELDS}$`))) !== null) {
      const n = Number(m[1])
      if (st.fail.has(`issue:${n}`) || st.issues[n] === undefined) return nope(`issue view ${n}`)
      return ok(st.issues[n])
    }
    if ((m = line.match(new RegExp(`^pr view ([0-9]+) --repo ${PIN} --json ${PR_FIELDS}$`))) !== null) {
      const p = Number(m[1])
      if (st.fail.has(`pr:${p}`) || st.prs[p] === undefined) return nope(`pr view ${p}`)
      return ok(st.prs[p])
    }
    if ((m = line.match(/^api --hostname github\.com repos\/jakub\/demo\/compare\/([0-9a-f]{40})\.\.\.main$/)) !== null) {
      if (st.fail.has(`compare:${m[1]}`) || st.compares[m[1]] === undefined) return nope('compare')
      return ok(st.compares[m[1]])
    }
    st.unexpected = [...(st.unexpected ?? []), args]
    everyUnexpected.push(args)
    return { code: 3, stdout: '', stderr: `fake gh: unexpected ${line}\n` }
  })()
  st.calls.push({ args, cwd: options?.cwd, answer })
  everyCall.push(args)
  return answer
}

const run = (w, st, { argv, request, confirmed, repo = PIN, env = {} } = {}) => {
  const args = argv ?? [repo, request, ...(confirmed === undefined ? [] : ['--confirmed', confirmed])]
  const result = chainLedger({ argv: args, cwd: w?.repo ?? tmp, env: { ...process.env, GIT_SSH_COMMAND: w?.ssh ?? 'false', ...env }, runGh: makeRunGh(st) })
  let json = null
  try { json = JSON.parse(result.stdout) } catch {}
  return { ...result, json, st }
}
const node = (r, n) => r.json?.nodes?.find((x) => x.issue === n)
const show = (r) => `${r.code} ${r.stdout}${r.stderr}${r.st?.unexpected ? ` unexpected=${JSON.stringify(r.st.unexpected)}` : ''}`
/** The fields a case pins, compared as one JSON string so a mismatch prints whole. */
const pick = (x, keys) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, x?.[k]])))
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

// ---------------------------------------------------------------------------------------------
console.log('the request grammar')
const CANON = 'issues: #1, #2, #3, #4; after: #1 -> #3, #2 -> #3; land: #1, #2'
for (const [name, text, canonical] of [
  ['unicode arrows with land tokens and a join', '#1 → land → #3; #2 → land → #3; #4', CANON],
  ['ascii arrows', '#1 -> land -> #3; #2 -> land -> #3; #4', CANON],
  ['arrows with no spaces, newline-separated', '#1->land->#3\n#2→land→#3\n#4', CANON],
  ['the canonical form, echoed', CANON, CANON],
  ['the canonical form, shuffled', 'land: #2, #1; after: #2 -> #3, #1 -> #3; issues: #4, #3, #2, #1', CANON],
  ['a trailing land grants the last issue', '#1 → #2 → land', 'issues: #1, #2; after: #1 -> #2; land: #2'],
  ['the trawl chain', '#333 → land → #334 → land → #335 → #336', 'issues: #333, #334, #335, #336; after: #333 -> #334, #334 -> #335, #335 -> #336; land: #333, #334'],
  ['one issue, no edges, no land', '#5', 'issues: #5'],
  ['numbers sort as numbers', '#10; #9 → land', 'issues: #9, #10; land: #9'],
  ['a qualified reference prints bare', 'jakub/demo#5 → land', 'issues: #5; land: #5'],
  ['empty after: and land: are left out', 'issues: #2, #1; after: ; land:', 'issues: #1, #2'],
]) {
  const parsed = parseRequest(text)
  check(`${name}: canonical`, parsed.canonical === canonical, JSON.stringify(parsed))
  check(`${name}: chainId is the first 8 hex of the canonical sha256`, parsed.chainId === sha256(canonical).slice(0, 8), JSON.stringify(parsed))
}
check('two spellings of one chain share a chainId', parseRequest('#1 → land → #3; #2 → land → #3; #4').chainId === parseRequest(CANON).chainId)
check('another land set is another chain', parseRequest('#1 → #3; #2 → land → #3; #4').chainId !== parseRequest(CANON).chainId)

for (const [name, text, reason, cycle] of [
  ['an empty request', '', 'parse'],
  ['only separators', ' ; \n ;', 'parse'],
  ['a segment opening with land', 'land → #1', 'parse'],
  ['two arrows in a row', '#1 → → #2', 'parse'],
  ['land twice in a row', '#1 → land → land', 'parse'],
  ['a word where an issue goes', '#1 → issue-two', 'parse'],
  ['commas in the arrow form', '#1 → #2, #3', 'parse'],
  ['issue zero', '#0', 'parse'],
  ['a leading zero', '#01', 'parse'],
  ['arrows mixed into the canonical form', 'issues: #1, #2; #1 → #2', 'parse'],
  ['a canonical form with no issues:', 'after: #1 -> #2', 'parse'],
  ['an empty issues:', 'issues: ; land: #1', 'parse'],
  ['a section given twice', 'issues: #1; issues: #2', 'parse'],
  ['a section that does not exist', 'issues: #1; blockers: #1', 'parse'],
  ['an after: item that is not one edge', 'issues: #1, #2, #3; after: #1 -> #2 -> #3', 'parse'],
  ['a self-edge in arrows', '#1 → #1', 'self-edge'],
  ['a self-edge in after:', 'issues: #1; after: #1 -> #1', 'self-edge'],
  ['a duplicate edge across segments', '#1 → #2; #1 → #2', 'duplicate'],
  ['a duplicate edge in after:', 'issues: #1, #2; after: #1 -> #2, #1 -> #2', 'duplicate'],
  ['a duplicate in issues:', 'issues: #1, #1', 'duplicate'],
  ['a duplicate in land:', 'issues: #1, #2; land: #1, #1', 'duplicate'],
  ['a grant written twice', '#1 → land; #1 → land → #2', 'duplicate'],
  ['an edge to an issue outside issues:', 'issues: #1; after: #1 -> #2', 'unknown-issue'],
  ['a land outside issues:', 'issues: #1; land: #2', 'unknown-issue'],
  ['a cycle in arrows', '#1 → #2 → #3 → #1', 'cycle', '#1 -> #2 -> #3 -> #1'],
  ['a cycle in after:', 'issues: #1, #2, #3; after: #1 -> #2, #2 -> #1', 'cycle', '#1 -> #2 -> #1'],
  ['a cycle behind a join', '#1 → #3; #2 → #3 → #4 → #2', 'cycle', '#2 -> #3 -> #4 -> #2'],
]) {
  const st = freshState()
  const r = run(null, st, { request: text })
  check(`${name}: refused ${reason}, exit 2, before any gh call`, r.code === 2 && r.json?.result === 'refused' && r.json?.reason === reason && st.calls.length === 0, show(r))
  if (cycle) check(`${name}: the cycle is printed`, r.json?.cycle === cycle, r.stdout)
  else check(`${name}: the refusal carries result, reason and detail only`, same(Object.keys(r.json ?? {}), ['result', 'reason', 'detail']) && typeof r.json.detail === 'string', r.stdout)
}

// ---------------------------------------------------------------------------------------------
console.log('\nusage, origin and the repository')
for (const [name, argv] of [
  ['no arguments', []],
  ['the repository alone', [PIN]],
  ['an extra argument', [PIN, '#1', 'extra']],
  ['owner/name where host/owner/name goes', ['jakub/demo', '#1']],
  ['--confirmed with no value', [PIN, '#1', '--confirmed']],
  ['--confirmed twice', [PIN, '#1', '--confirmed', `1:${'a'.repeat(64)}`, '--confirmed', `1:${'a'.repeat(64)}`]],
  ['--confirmed with a short digest', [PIN, '#1', '--confirmed', '1:abc']],
  ['--confirmed with an upper-case digest', [PIN, '#1', '--confirmed', `1:${'A'.repeat(64)}`]],
  ['--confirmed with no issue number', [PIN, '#1', '--confirmed', `x:${'a'.repeat(64)}`]],
]) {
  const st = freshState()
  const r = run(null, st, { argv })
  check(`${name}: usage, exit 2, before any gh call`, r.code === 2 && r.json?.reason === 'usage' && st.calls.length === 0 && r.stderr.includes('usage: chain-ledger.mjs'), show(r))
}
{
  const st = freshState()
  const r = run(null, st, { argv: ['--help'] })
  check('--help prints the usage and exits 0', r.code === 0 && r.stdout.startsWith('usage: chain-ledger.mjs') && st.calls.length === 0, show(r))
  const twice = run(null, freshState(), { request: '#1; #2', confirmed: `1:${'a'.repeat(64)},1:${'b'.repeat(64)}` })
  check('--confirmed naming one issue twice is refused duplicate', twice.code === 2 && twice.json?.reason === 'duplicate', show(twice))
  const outside = run(null, freshState(), { request: '#1; #2', confirmed: `3:${'a'.repeat(64)}` })
  check('--confirmed naming an issue outside the chain is refused unknown-issue', outside.code === 2 && outside.json?.reason === 'unknown-issue', show(outside))
}
{
  const w = makeWorld()
  const st = freshState()
  const r = run(w, st, { repo: 'github.com/jakub/other', request: '#1' })
  check('a repository other than origin is refused foreign-repo before any gh call', r.code === 2 && r.json?.reason === 'foreign-repo' && st.calls.length === 0, show(r))
  const st2 = freshState()
  const q = run(w, st2, { request: '#1 → other/demo#2' })
  check('an owner/name#N from another repository is refused foreign-repo', q.code === 2 && q.json?.reason === 'foreign-repo' && st2.calls.length === 0, show(q))
  const cased = run(w, freshState({ issues: { 1: issue(1) } }), { repo: 'github.com/Jakub/Demo', request: 'JAKUB/demo#1' })
  check('the repository compares case-insensitively and prints as origin spells it', cased.code === 0 && cased.json?.repo === PIN && cased.json?.request === 'issues: #1', show(cased))
}
{
  const dir = join(tmp, 'no-origin')
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  const st = freshState()
  const r = chainLedger({ argv: [PIN, '#1'], cwd: dir, env: process.env, runGh: makeRunGh(st) })
  const json = JSON.parse(r.stdout)
  check('no origin is unknown origin-unreadable, exit 4, before any gh call', r.code === 4 && json.result === 'unknown' && json.reason === 'origin-unreadable' && st.calls.length === 0, `${r.code} ${r.stdout}`)
}
{
  const w = makeWorld('git@ghe.example.com:jakub/demo.git')
  const st = freshState()
  const r = run(w, st, { repo: 'ghe.example.com/jakub/demo', request: '#1' })
  check('an origin host off the allowlist is origin-unreadable, exit 4, before any gh call', r.code === 4 && r.json?.reason === 'origin-unreadable' && st.calls.length === 0, show(r))
}
{
  const w = makeWorld('https://user:ghp_ledgertoken@github.com/jakub/demo.git')
  const st = freshState({ issues: { 1: issue(1) } })
  const r = run(w, st, { request: '#1', env: { https_proxy: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' } })
  check('an unreachable https origin with a token: the refs read fails, the node is unknown, the token is printed nowhere',
    r.code === 0 && node(r, 1)?.state === 'unknown' && node(r, 1)?.reason === 'refs-unreadable' && !`${r.stdout}${r.stderr}`.includes('ghp_ledgertoken'), show(r))
}
for (const [name, over, reason] of [
  ['an unreadable default branch', { fail: new Set(['repo']) }, 'default-branch-unreadable'],
  ['an unreadable login', { fail: new Set(['user']) }, 'login-unreadable'],
]) {
  const w = makeWorld()
  const r = run(w, freshState(over), { request: '#1' })
  check(`${name}: unknown ${reason}, exit 4`, r.code === 4 && r.json?.result === 'unknown' && r.json?.reason === reason, show(r))
  check(`${name}: the gh error is redacted to the repository`, !r.stdout.includes('git@github.com') && r.stdout.includes(PIN), r.stdout)
}
{
  const w = makeWorld()
  const st = freshState({ defaultBranch: 'trunk' })
  const r = run(w, st, { request: '#1' })
  check('a default branch other than main is refused not-main, and no issue is read', r.code === 2 && r.json?.reason === 'not-main' && !st.calls.some((c) => c.args[0] === 'issue'), show(r))
}

// ---------------------------------------------------------------------------------------------
console.log('\nadmission: the preflight holds an issue with no run marks to what the claim checks; a confirmed chain reads it a state')
/** --confirmed with every issue's body as it reads now: a chain the user confirmed and nobody edited since. */
const confirmAll = (issues) => Object.values(issues).map((i) => `${i.number}:${sha256(i.body)}`).join(',')
const states = (r) => r.json?.nodes?.map((x) => `${x.state}:${x.next}`)
for (const [name, request, issues, reason, confirmedStates, unknownReason] of [
  ['a closed leaf', '#1', { 1: issue(1, { state: 'CLOSED' }) }, 'issue-closed', ['parked:closed:user']],
  ['an issue with no ready label', '#1', { 1: issue(1, { labels: [{ name: 'needs-triage' }] }) }, 'not-ready', ['parked:needs-triage:user']],
  ['an issue with no lifecycle label at all', '#1', { 1: issue(1, { labels: [{ name: 'enhancement' }] }) }, 'not-ready', ['unknown:user'], 'not-ready'],
  ['a blocker beside the ready label', '#1', { 1: issue(1, { labels: [{ name: 'ready-for-agent' }, { name: 'needs-human' }] }) }, 'blocked', ['parked:needs-human:user']],
  ['a lower-case criteria heading', '#1', { 1: issue(1, { body: 'Why.\n\n## Acceptance criteria\n\n- [ ] lower case\n' }) }, 'no-acceptance-criteria', ['unknown:user'], 'no-acceptance-criteria'],
  ['an empty criteria section', '#1', { 1: issue(1, { body: 'Why.\n\n## Acceptance Criteria\n\n## Notes\n' }) }, 'no-acceptance-criteria', ['unknown:user'], 'no-acceptance-criteria'],
  ['a parent closed with no merged pull request and no run', '#1 → #2', { 1: issue(1, { state: 'CLOSED' }), 2: issue(2) }, 'dead-parent', ['parked:closed:user', 'dead-parent:user']],
  ['a dead parent with an unmerged closed pull request', '#1 → #2', { 1: issue(1, { state: 'CLOSED', closedByPullRequestsReferences: [linkTo(11)] }), 2: issue(2) }, 'dead-parent', ['parked:closed:user', 'dead-parent:user']],
]) {
  const w = makeWorld()
  const st = () => freshState({ issues, prs: { 11: pr(11, 1, { state: 'CLOSED' }) } })
  const r = run(w, st(), { request })
  check(`${name}: the preflight refuses ${reason}, exit 2`, r.code === 2 && r.json?.result === 'refused' && r.json?.reason === reason && same(Object.keys(r.json), ['result', 'reason', 'detail']), show(r))
  const c = run(w, st(), { request, confirmed: confirmAll(issues) })
  check(`${name}: a confirmed chain reads ${confirmedStates.join(', ')}, exit 0`, c.code === 0 && same(states(c), confirmedStates) &&
    (unknownReason === undefined || (node(c, 1)?.reason === unknownReason && c.json?.warnings?.some((x) => x.startsWith('#1 is unknown: issue #1 ')))), show(c))
}
{
  // #1 runs, #2 waits on it, #3 is independent. Then someone parks the waiting #2.
  const w = makeWorld()
  w.plant('refs/heads/feat/issue-1-issue-1')
  const issuesWith = (labels2) => ({ 1: issue(1, { labels: [{ name: 'in-progress' }] }), 2: issue(2, { labels: labels2 }), 3: issue(3) })
  const ready = issuesWith([{ name: 'ready-for-agent' }])
  const baseline = run(w, freshState({ issues: ready }), { request: '#1 → #2; #3', confirmed: confirmAll(ready) })
  check('(baseline) the confirmed chain before the relabel: running, waiting, launch', same(states(baseline), ['running:watch', 'waiting:wait', 'ready:launch']), show(baseline))
  const parked = issuesWith([{ name: 'ready-for-agent' }, { name: 'needs-info' }])
  const pre = run(w, freshState({ issues: parked }), { request: '#1 → #2; #3' })
  check('a relabelled waiting dependent: the preflight refuses blocked', pre.code === 2 && pre.json?.reason === 'blocked', show(pre))
  const conf = run(w, freshState({ issues: parked }), { request: '#1 → #2; #3', confirmed: confirmAll(parked) })
  check('a relabelled waiting dependent: a confirmed chain reads it parked:needs-info, next user, exit 0', conf.code === 0 &&
    pick(node(conf, 2), ['state', 'reason', 'next']) === JSON.stringify({ state: 'parked:needs-info', reason: null, next: 'user' }), show(conf))
  check('and its siblings keep the states they had before it was parked', same(node(conf, 1), node(baseline, 1)) && same(node(conf, 3), node(baseline, 3)) &&
    conf.json?.active === baseline.json?.active, `${JSON.stringify(node(conf, 1))} ${JSON.stringify(node(conf, 3))}`)
}
{
  // A confirmed chain whose root, never started, was closed without a merge.
  const w = makeWorld()
  const issues = { 1: issue(1, { state: 'CLOSED', closedByPullRequestsReferences: [linkTo(11)] }), 2: issue(2), 3: issue(3) }
  const r = run(w, freshState({ issues, prs: { 11: pr(11, 1, { state: 'CLOSED' }) } }), { request: '#1 → land → #2; #3', confirmed: confirmAll(issues) })
  check('a confirmed chain\'s root with no run marks, closed unmerged: parked:closed, its child dead-parent, the rest go on', r.code === 0 &&
    same(states(r), ['parked:closed:user', 'dead-parent:user', 'ready:launch']) && same(node(r, 2)?.waitsOn, [1]) && r.json?.active === 0, show(r))
}
{
  const w = makeWorld()
  const cut = { 1: issue(1, { body: 'Why, with the criteria cut.\n' }) }
  const moved = run(w, freshState({ issues: cut }), { request: '#1', confirmed: `1:${sha256(bodyOf(1))}` })
  check('a confirmed body whose criteria were cut reads waiting body-moved, never ready', pick(node(moved, 1), ['state', 'reason', 'next']) ===
    JSON.stringify({ state: 'waiting', reason: 'body-moved', next: 'wait' }), show(moved))
  const unconfirmed = run(w, freshState({ issues: { ...cut, 2: issue(2) } }), { request: '#1; #2', confirmed: `2:${sha256(bodyOf(2))}` })
  check('the same body with no confirmed digest to compare reads unknown no-acceptance-criteria, never ready', pick(node(unconfirmed, 1), ['state', 'reason', 'next']) ===
    JSON.stringify({ state: 'unknown', reason: 'no-acceptance-criteria', next: 'user' }) && node(unconfirmed, 2)?.state === 'ready', show(unconfirmed))
}
{
  // The grammar and repository refusals hold on a confirmed run too.
  const digest = `1:${sha256(bodyOf(1))}`
  const cycle = run(null, freshState(), { request: '#1 → #2 → #1', confirmed: digest })
  check('a confirmed run still refuses a cycle', cycle.code === 2 && cycle.json?.reason === 'cycle', show(cycle))
  const w = makeWorld()
  const foreign = run(w, freshState(), { repo: 'github.com/jakub/other', request: '#1', confirmed: digest })
  check('a confirmed run still refuses foreign-repo', foreign.code === 2 && foreign.json?.reason === 'foreign-repo', show(foreign))
  const trunk = run(w, freshState({ defaultBranch: 'trunk', issues: { 1: issue(1) } }), { request: '#1', confirmed: digest })
  check('a confirmed run still refuses not-main', trunk.code === 2 && trunk.json?.reason === 'not-main', show(trunk))
}
{
  const w = makeWorld()
  w.plant('refs/heads/feat/issue-2-issue-2')
  const st = freshState({
    issues: {
      1: issue(1, { state: 'CLOSED', labels: [{ name: 'in-progress' }], closedByPullRequestsReferences: [linkTo(11)] }),
      2: issue(2, { labels: [{ name: 'in-progress' }] }),
      3: issue(3, { labels: [{ name: 'in-progress' }], body: 'An issue whose criteria were cut after its claim.\n' }),
    },
    prs: { 11: merged(11, 1) },
    compares: { [hex('merge-11')]: { status: 'identical', behind_by: 0, ahead_by: 0 } },
  })
  const r = run(w, st, { request: '#1 → land → #2; #3' })
  check('a landed parent, a running issue with no ready label and one with no criteria are all accepted: the resume path',
    r.code === 0 && node(r, 1)?.state === 'landed' && node(r, 2)?.state === 'running' && node(r, 3)?.state === 'running', show(r))
}

// ---------------------------------------------------------------------------------------------
console.log('\nthe fork/join fixture: A→C, B→C, D independent and parked; A landed, B running')
const FORK_JOIN = '#1 → land → #3; #2 → land → #3; #4'
const forkJoin = (w) => {
  w.plant('refs/heads/feat/issue-2-issue-2')
  w.plant('refs/heads/feat/issue-4-issue-4')
  return freshState({
    issues: {
      1: issue(1, { state: 'CLOSED', labels: [{ name: 'in-progress' }], closedByPullRequestsReferences: [linkTo(11)] }),
      2: issue(2, { labels: [{ name: 'in-progress' }], closedByPullRequestsReferences: [linkTo(12)] }),
      3: issue(3),
      4: issue(4, { labels: [{ name: 'in-progress' }, { name: 'needs-info' }] }),
    },
    prs: { 11: merged(11, 1), 12: pr(12, 2) },
    compares: { [hex('merge-11')]: { status: 'ahead', behind_by: 0, ahead_by: 2 } },
  })
}
const NODE_KEYS = ['issue', 'title', 'state', 'reason', 'pr', 'head', 'mergeCommit', 'mergedBy', 'granted', 'parents', 'waitsOn', 'bodySha256', 'next']
let forkJoinLine = null
{
  const w = makeWorld()
  const st = forkJoin(w)
  const originBefore = allRefs(w.origin)
  const cloneBefore = allRefs(w.repo)
  const trace = join(w.dir, 'trace')
  const r = run(w, st, { request: FORK_JOIN, env: { GIT_TRACE: trace } })
  forkJoinLine = r.stdout
  check('exits 0 with one JSON line and an empty stderr', r.code === 0 && r.json?.result === 'ledger' && r.stdout.split('\n').length === 2 && r.stderr === '', show(r))
  check('the top-level fields, in order', same(Object.keys(r.json ?? {}), ['result', 'repo', 'request', 'chainId', 'login', 'defaultBranch', 'cap', 'active', 'nodes', 'warnings', 'footer']), r.stdout)
  check('the repository, canonical request, chain id, login, branch, cap and active count', pick(r.json, ['repo', 'request', 'chainId', 'login', 'defaultBranch', 'cap', 'active']) ===
    JSON.stringify({ repo: PIN, request: CANON, chainId: sha256(CANON).slice(0, 8), login: 'jakub', defaultBranch: 'main', cap: 4, active: 1 }), r.stdout)
  check('every node carries the frozen fields, in order, ascending by issue', r.json?.nodes?.length === 4 && r.json.nodes.every((x) => same(Object.keys(x), NODE_KEYS)) &&
    same(r.json.nodes.map((x) => x.issue), [1, 2, 3, 4]), r.stdout)
  check('A is landed, with its merge commit, who merged it and its grant', same(node(r, 1), {
    issue: 1, title: 'Issue 1', state: 'landed', reason: null, pr: 11, head: hex('head-11'), mergeCommit: hex('merge-11'), mergedBy: 'jakub',
    granted: true, parents: [], waitsOn: [], bodySha256: sha256(bodyOf(1)), next: 'none',
  }), JSON.stringify(node(r, 1)))
  check('B is running on its open pull request: watch', pick(node(r, 2), ['state', 'reason', 'pr', 'head', 'granted', 'next']) ===
    JSON.stringify({ state: 'running', reason: null, pr: 12, head: hex('head-12'), granted: true, next: 'watch' }), JSON.stringify(node(r, 2)))
  check('C waits on B alone: A has landed', pick(node(r, 3), ['state', 'reason', 'pr', 'granted', 'parents', 'waitsOn', 'next']) ===
    JSON.stringify({ state: 'waiting', reason: 'waits-on', pr: null, granted: false, parents: [1, 2], waitsOn: [2], next: 'wait' }), JSON.stringify(node(r, 3)))
  check('D is parked on needs-info and holds no slot', pick(node(r, 4), ['state', 'pr', 'next']) === JSON.stringify({ state: 'parked:needs-info', pr: null, next: 'user' }) && r.json?.active === 1, JSON.stringify(node(r, 4)))
  check('no warnings', same(r.json?.warnings, []), r.stdout)
  check('no unexpected gh call', st.unexpected === undefined, JSON.stringify(st.unexpected))
  check('every gh call is pinned to origin\'s repository or host', st.calls.every(({ args }) =>
    (args[0] === 'api' ? args[args.indexOf('--hostname') + 1] === 'github.com' : args.includes(PIN) && (args[0] === 'repo' || args[args.indexOf('--repo') + 1] === PIN))), JSON.stringify(st.calls.map((c) => c.args)))
  check('every gh call runs in the checkout it was given', st.calls.every((c) => c.cwd === w.repo), JSON.stringify(st.calls.map((c) => c.cwd)))
  // git ran remote get-url and ls-remote here, and upload-pack on the far side of the ssh shim. Nothing else.
  const builtins = existsSync(trace) ? [...readFileSync(trace, 'utf8').matchAll(/trace: built-in: git ([a-z-]+)(?: ([a-z-]+))?/g)].map((m) => (m[1] === 'remote' ? `remote ${m[2]}` : m[1])) : []
  check('git ran only remote get-url, ls-remote and the far side\'s upload-pack', builtins.length > 0 && builtins.every((c) => ['remote get-url', 'ls-remote', 'upload-pack'].includes(c)) && builtins.filter((c) => c === 'ls-remote').length === 1, JSON.stringify(builtins))
  check('no ref moved in the clone or on origin, and no fetch left a FETCH_HEAD', allRefs(w.origin) === originBefore && allRefs(w.repo) === cloneBefore && !existsSync(join(w.repo, '.git', 'FETCH_HEAD')), allRefs(w.repo))
}
{
  const w = makeWorld()
  const st = forkJoin(w)
  st.issues[2] = { ...st.issues[2], state: 'CLOSED' }
  st.prs[12] = merged(12, 2)
  st.compares[hex('merge-12')] = { status: 'identical', behind_by: 0, ahead_by: 0 }
  git(w.origin, 'update-ref', '-d', 'refs/heads/feat/issue-2-issue-2')
  const r = run(w, st, { request: FORK_JOIN })
  check('once B lands, C is ready and launched', node(r, 2)?.state === 'landed' && pick(node(r, 3), ['state', 'reason', 'waitsOn', 'next']) ===
    JSON.stringify({ state: 'ready', reason: null, waitsOn: [], next: 'launch' }) && r.json?.active === 0, show(r))
}
{
  const w = makeWorld()
  const st = forkJoin(w)
  st.prs[11] = merged(11, 1, 'someone-else')
  const r = run(w, st, { request: '#1 → #3; #2 → land → #3; #4' })
  check('a merge outside the chain counts, and prints who merged it and that no grant was given', pick(node(r, 1), ['state', 'mergedBy', 'granted', 'next']) ===
    JSON.stringify({ state: 'landed', mergedBy: 'someone-else', granted: false, next: 'none' }) && node(r, 3)?.waitsOn?.join() === '2', show(r))
}

// ---------------------------------------------------------------------------------------------
console.log('\nunknown is never rounded up')
{
  const w = makeWorld()
  const st = forkJoin(w)
  st.fail.add('issue:3')
  const r = run(w, st, { request: FORK_JOIN })
  check('a failed issue read: that node is unknown, exit 0, the rest read on', r.code === 0 && pick(node(r, 3), ['state', 'reason', 'title', 'bodySha256', 'next']) ===
    JSON.stringify({ state: 'unknown', reason: 'issue-unreadable', title: null, bodySha256: null, next: 'user' }) && node(r, 1)?.state === 'landed' && node(r, 2)?.state === 'running', show(r))
  check('the unknown node holds a slot, and the warning says why without the remote', r.json?.active === 2 && r.json?.warnings?.some((x) => x.startsWith('#3 is unknown: ')) && !r.stdout.includes('git@github.com'), r.stdout)
}
{
  const w = makeWorld()
  const st = forkJoin(w)
  const r = run(w, st, { request: FORK_JOIN, env: { GIT_SSH_COMMAND: 'false' } })
  check('origin\'s refs unread: every node is unknown refs-unreadable, exit 0, none admitted or refused', r.code === 0 && r.json?.nodes?.every((x) => x.state === 'unknown' && x.reason === 'refs-unreadable' && x.next === 'user') && r.json?.active === 4, show(r))
}
{
  const w = makeWorld()
  const st = freshState({ issues: { 1: issue(1, { state: 'CLOSED' }) } })
  const r = run(w, st, { request: '#1', env: { GIT_SSH_COMMAND: 'false' } })
  check('a closed issue whose run marks can\'t be read is unknown, not refused issue-closed', r.code === 0 && node(r, 1)?.state === 'unknown', show(r))
}
for (const [name, issueOver, prs, compares, fail, reason, extra] of [
  ['a failed pull request read', { closedByPullRequestsReferences: [linkTo(12)] }, { 12: pr(12, 1) }, {}, ['pr:12'], 'pr-unreadable'],
  ['two open candidates', { closedByPullRequestsReferences: [linkTo(12), linkTo(13)] }, { 12: pr(12, 1), 13: pr(13, 1, { headRefName: 'fix/issue-1-again' }) }, {}, [], 'candidates-ambiguous', { pr: null, head: null }],
  ['a merged and an open candidate', { state: 'CLOSED', closedByPullRequestsReferences: [linkTo(12), linkTo(13)] }, { 12: merged(12, 1), 13: pr(13, 1) }, { [hex('merge-12')]: { status: 'ahead', behind_by: 0 } }, [], 'candidates-ambiguous'],
  ['MERGED with main not containing the merge commit', { state: 'CLOSED', closedByPullRequestsReferences: [linkTo(12)] }, { 12: merged(12, 1) }, { [hex('merge-12')]: { status: 'diverged', behind_by: 1, ahead_by: 3 } }, [], 'merged-off-main', { pr: 12, mergeCommit: hex('merge-12') }],
  ['MERGED with main behind the merge commit', { state: 'CLOSED', closedByPullRequestsReferences: [linkTo(12)] }, { 12: merged(12, 1) }, { [hex('merge-12')]: { status: 'behind', behind_by: 1, ahead_by: 0 } }, [], 'merged-off-main'],
  ['MERGED with behind_by 0 and a status that is not ahead or identical', { state: 'CLOSED', closedByPullRequestsReferences: [linkTo(12)] }, { 12: merged(12, 1) }, { [hex('merge-12')]: { status: 'diverged', behind_by: 0 } }, [], 'merged-off-main'],
  ['MERGED with the compare failing', { state: 'CLOSED', closedByPullRequestsReferences: [linkTo(12)] }, { 12: merged(12, 1) }, {}, [`compare:${hex('merge-12')}`], 'compare-unreadable'],
  ['MERGED with a compare that has no behind_by', { state: 'CLOSED', closedByPullRequestsReferences: [linkTo(12)] }, { 12: merged(12, 1) }, { [hex('merge-12')]: { status: 'ahead' } }, [], 'compare-unreadable'],
  ['MERGED with no merge commit', { state: 'CLOSED', closedByPullRequestsReferences: [linkTo(12)] }, { 12: merged(12, 1, 'jakub', { mergeCommit: null }) }, {}, [], 'pr-unreadable'],
  ['a candidate with no readable head', { closedByPullRequestsReferences: [linkTo(12)] }, { 12: pr(12, 1, { headRefOid: 'nope' }) }, {}, [], 'pr-unreadable'],
  ['a linked pull request in no state gh knows', { closedByPullRequestsReferences: [linkTo(12)] }, { 12: pr(12, 1, { state: 'LIMBO' }) }, {}, [], 'pr-unreadable'],
  ['a linked pull request with no fork flag', { closedByPullRequestsReferences: [linkTo(12)] }, { 12: pr(12, 1, { isCrossRepository: undefined }) }, {}, [], 'pr-unreadable'],
  ['an issue read with no linked pull request list', { closedByPullRequestsReferences: undefined }, {}, {}, [], 'issue-unreadable'],
  ['an issue read with no comment list', { comments: null }, {}, {}, [], 'issue-unreadable'],
  ['an issue read that answers for another number', { number: 9 }, {}, {}, [], 'issue-unreadable'],
  ['an issue read that answers from another repository', { url: 'https://github.com/someone/else/issues/1' }, {}, {}, [], 'issue-unreadable'],
]) {
  const w = makeWorld()
  const st = freshState({ issues: { 1: issue(1, issueOver) }, prs, compares, fail: new Set(fail) })
  const r = run(w, st, { request: '#1 → land' })
  check(`${name}: unknown ${reason}, next user, exit 0`, r.code === 0 && node(r, 1)?.state === 'unknown' && node(r, 1)?.reason === reason && node(r, 1)?.next === 'user' && st.unexpected === undefined, show(r))
  if (extra) check(`${name}: prints ${Object.keys(extra).join(', ')} as ${JSON.stringify(extra)}`, pick(node(r, 1), Object.keys(extra)) === JSON.stringify(extra), JSON.stringify(node(r, 1)))
}

// ---------------------------------------------------------------------------------------------
console.log('\nwhich pull requests are candidates')
for (const [name, prs, links, state, prNumber] of [
  ['a CLOSED pull request that never merged is ignored', { 12: pr(12, 1, { state: 'CLOSED' }) }, [12], 'ready', null],
  ['a CLOSED one beside an open one leaves the open one', { 12: pr(12, 1, { state: 'CLOSED' }), 13: pr(13, 1) }, [12, 13], 'running', 13],
  ['a pull request from a fork is ignored', { 12: pr(12, 1, { isCrossRepository: true }) }, [12], 'ready', null],
  ['a pull request off the claim\'s branch pattern is ignored', { 12: pr(12, 1, { headRefName: 'jakub/issue-1-by-hand' }) }, [12], 'ready', null],
  ['a branch for issue 11 is not issue 1\'s', { 12: pr(12, 1, { headRefName: 'feat/issue-11-other' }) }, [12], 'ready', null],
  ['a pull request whose closing references lack the issue is ignored', { 12: pr(12, 1, { closingIssuesReferences: [{ number: 2, repository: { name: 'demo', owner: { login: 'jakub' } } }] }) }, [12], 'ready', null],
  ['a closing reference to issue 1 of another repository is ignored', { 12: pr(12, 1, { closingIssuesReferences: [{ number: 1, repository: { name: 'demo', owner: { login: 'someone' } } }] }) }, [12], 'ready', null],
]) {
  const w = makeWorld()
  const st = freshState({ issues: { 1: issue(1, { closedByPullRequestsReferences: links.map((p) => linkTo(p)) }) }, prs })
  const r = run(w, st, { request: '#1' })
  check(`${name}: ${state}${prNumber ? ` on #${prNumber}` : ''}`, r.code === 0 && node(r, 1)?.state === state && node(r, 1)?.pr === prNumber && st.unexpected === undefined, show(r))
}
{
  const w = makeWorld()
  const st = freshState({ issues: { 1: issue(1, { closedByPullRequestsReferences: [linkTo(12, { name: 'fork', owner: { login: 'someone' } })] }) } })
  const r = run(w, st, { request: '#1' })
  check('a linked pull request in another repository is never read', r.code === 0 && node(r, 1)?.state === 'ready' && !st.calls.some((c) => c.args[0] === 'pr'), show(r))
}

// ---------------------------------------------------------------------------------------------
console.log('\nthe clean line')
const cleanCase = (comments, { labels = [{ name: 'in-progress' }], request = '#1 → land', head = hex('head-12') } = {}) => {
  const w = makeWorld()
  w.plant('refs/heads/feat/issue-1-issue-1')
  const st = freshState({ issues: { 1: issue(1, { labels, comments, closedByPullRequestsReferences: [linkTo(12)] }) }, prs: { 12: pr(12, 1, { headRefOid: head }) } })
  return run(w, st, { request })
}
const H = hex('head-12')
for (const [name, comments, opts, state, next] of [
  ['the login\'s clean line at the current head, granted', [cleanComment(12, H)], {}, 'clean', 'land'],
  ['the same line, not granted', [cleanComment(12, H)], { request: '#1' }, 'clean', 'user-merge'],
  ['a clean line written with CRLF', [comment(`${ATTRIBUTION}babysit: clean #12 ${H}\n`.replaceAll('\n', '\r\n'))], {}, 'clean', 'land'],
  ['a blocked label outranks a clean line', [cleanComment(12, H)], { labels: [{ name: 'in-progress' }, { name: 'needs-rebase' }] }, 'parked:needs-rebase', 'user'],
  ['two blocked labels: the first in the contract\'s order', [], { labels: [{ name: 'deferred' }, { name: 'needs-human' }, { name: 'in-progress' }] }, 'parked:needs-human', 'user'],
  ['a clean line from another login', [cleanComment(12, H, { login: 'mallory' })], {}, 'running', 'watch'],
  ['a clean line at a stale head', [cleanComment(12, hex('older'))], {}, 'running', 'watch'],
  ['a clean line for another pull request', [cleanComment(99, H)], {}, 'running', 'watch'],
  ['a clean line that is not first after the attribution block', [comment(`${ATTRIBUTION}Status.\nbabysit: clean #12 ${H}\n`)], {}, 'running', 'watch'],
  ['a clean line with no attribution block', [comment(`babysit: clean #12 ${H}\n`)], {}, 'running', 'watch'],
  ['a clean line after an attribution block with no blank line', [comment(`> [!NOTE]\n> 🤖 **Claude responding on behalf of jakub**\nbabysit: clean #12 ${H}\n`)], {}, 'running', 'watch'],
  ['a clean line with trailing words', [comment(`${ATTRIBUTION}babysit: clean #12 ${H} probably\n`)], {}, 'running', 'watch'],
  ['the latest clean line decides, and it names a stale head', [cleanComment(12, H, { createdAt: '2026-11-03T10:00:00Z' }), cleanComment(12, hex('older'), { createdAt: '2026-11-03T11:00:00Z' })], {}, 'running', 'watch'],
  ['latest is by time, not list order', [cleanComment(12, hex('older'), { createdAt: '2026-11-03T11:00:00Z' }), cleanComment(12, H, { createdAt: '2026-11-03T12:00:00Z' })].reverse(), {}, 'clean', 'land'],
  ['a later clean line from another login does not unseat the login\'s', [cleanComment(12, H), cleanComment(12, hex('older'), { login: 'mallory', createdAt: '2026-11-03T12:00:00Z' })], {}, 'clean', 'land'],
]) {
  const r = cleanCase(comments, opts)
  check(`${name}: ${state}, next ${next}`, r.code === 0 && node(r, 1)?.state === state && node(r, 1)?.next === next, show(r))
}

// ---------------------------------------------------------------------------------------------
console.log('\nslots, claims, early starts, dead parents and moved bodies')
{
  const w = makeWorld()
  const issues = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, issue(n)]))
  const r = run(w, freshState({ issues }), { request: '#5; #4; #3; #2; #1' })
  check('five ready issues and no active ones: four launch in ascending order, the fifth is queued', r.code === 0 && r.json?.active === 0 &&
    same(r.json?.nodes?.map((x) => x.next), ['launch', 'launch', 'launch', 'launch', 'queued']), show(r))
}
{
  const w = makeWorld()
  for (const n of [1, 2, 3]) w.plant(`refs/heads/fix/issue-${n}-issue-${n}`)
  w.plant('refs/tags/flow-claim-issue-6')
  const issues = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [n, issue(n)]))
  issues[7] = issue(7, { labels: [{ name: 'in-progress' }, { name: 'needs-human' }] })
  w.plant('refs/heads/feat/issue-7-issue-7')
  const st = freshState({ issues, fail: new Set() })
  const r = run(w, st, { request: '#1; #2; #3; #4; #5; #6; #7' })
  check('three running and one claiming hold all four slots; a parked one holds none; both ready issues queue', r.code === 0 && r.json?.active === 4 &&
    same(r.json?.nodes?.map((x) => `${x.state}:${x.next}`), ['running:watch', 'running:watch', 'running:watch', 'ready:queued', 'ready:queued', 'claiming:watch', 'parked:needs-human:user']), show(r))
}
{
  const w = makeWorld()
  w.plant('refs/heads/fix/issue-1-issue-1')
  const issues = Object.fromEntries([1, 2, 3, 4].map((n) => [n, issue(n)]))
  const st = freshState({ issues, fail: new Set(['issue:2']) })
  const r = run(w, st, { request: '#1; #2; #3; #4' })
  check('an unknown node holds a slot: one running, one unknown, two launches', r.json?.active === 2 && same(r.json?.nodes?.map((x) => x.next), ['watch', 'user', 'launch', 'launch']), show(r))
}
{
  const w = makeWorld()
  w.plant('refs/tags/flow-claim-issue-1')
  w.plant('refs/heads/chore/issue-1-issue-1')
  const r = run(w, freshState({ issues: { 1: issue(1) } }), { request: '#1' })
  check('a claim tag beside a run branch is running, not claiming', node(r, 1)?.state === 'running', show(r))
}
{
  const w = makeWorld()
  w.plant('refs/heads/feat/issue-2-issue-2')
  const st = freshState({ issues: { 1: issue(1, { labels: [{ name: 'in-progress' }], closedByPullRequestsReferences: [linkTo(11)] }), 2: issue(2), 3: issue(3) }, prs: { 11: pr(11, 1) } })
  const r = run(w, st, { request: '#1 → land → #2 → #3' })
  check('a dependent with a run branch while its parent runs is started-early: user, and it holds a slot', pick(node(r, 2), ['state', 'waitsOn', 'next']) ===
    JSON.stringify({ state: 'started-early', waitsOn: [1], next: 'user' }) && r.json?.active === 2, show(r))
  check('and its own dependent waits on it', pick(node(r, 3), ['state', 'reason', 'waitsOn']) === JSON.stringify({ state: 'waiting', reason: 'waits-on', waitsOn: [2] }), show(r))
}
{
  const w = makeWorld()
  const st = freshState({
    issues: { 1: issue(1, { state: 'CLOSED', labels: [{ name: 'in-progress' }] }), 2: issue(2), 3: issue(3), 4: issue(4) },
  })
  const r = run(w, st, { request: '#1 → #2 → #3; #4' })
  check('a parent closed mid-run with no merged pull request: every descendant is dead-parent, the rest go on', r.code === 0 &&
    same(r.json?.nodes?.map((x) => `${x.state}:${x.next}`), ['running:watch', 'dead-parent:user', 'dead-parent:user', 'ready:launch']), show(r))
}
{
  const w = makeWorld()
  const st = forkJoin(w)
  st.issues[2] = { ...st.issues[2], state: 'CLOSED' }
  st.prs[12] = merged(12, 2)
  st.compares[hex('merge-12')] = { status: 'identical', behind_by: 0 }
  git(w.origin, 'update-ref', '-d', 'refs/heads/feat/issue-2-issue-2')
  const confirmedAt = [1, 2, 3, 4].map((n) => `${n}:${sha256(bodyOf(n))}`).join(',')
  const confirmedMoved = [1, 2, 4].map((n) => `${n}:${sha256(bodyOf(n))}`).concat(`3:${sha256('the body the user confirmed')}`).sort().join(',')
  const r = run(w, st, { request: FORK_JOIN, confirmed: confirmedMoved })
  check('a dependent whose body moved since confirmation reads waiting body-moved', pick(node(r, 3), ['state', 'reason', 'waitsOn', 'next']) ===
    JSON.stringify({ state: 'waiting', reason: 'body-moved', waitsOn: [], next: 'wait' }), show(r))
  const ok = run(w, st, { request: FORK_JOIN, confirmed: confirmedAt })
  check('the same dependent with its confirmed digest is ready', node(ok, 3)?.state === 'ready' && node(ok, 3)?.next === 'launch', show(ok))
}
{
  const w = makeWorld()
  const st = forkJoin(w)
  const moved = run(w, st, { request: FORK_JOIN, confirmed: `3:${sha256('the body the user confirmed')}` })
  check('a dependent still waiting on a parent says waits-on, even when its body moved too', node(moved, 3)?.reason === 'waits-on', show(moved))
  check('a --confirmed missing some issues warns for each', same(moved.json?.warnings, ['--confirmed has no digest for #1', '--confirmed has no digest for #2', '--confirmed has no digest for #4']), moved.stdout)
}
{
  const w = makeWorld()
  const st = freshState({ issues: { 1: issue(1), 2: issue(2, { body: `Follows on from #1 and #3, and see #99.\n\n${AC}` }), 3: issue(3, { body: `Builds on #2.\n\n${AC}` }) } })
  const r = run(w, st, { request: '#1 → #2; #3' })
  check('a body that mentions a chain issue with no edge between them is a warning, never an edge', same(r.json?.warnings, [
    "#2's body mentions #3, and the request has no edge between them; edges come only from the request",
    "#3's body mentions #2, and the request has no edge between them; edges come only from the request",
  ]) && same(node(r, 3)?.parents, []) && node(r, 3)?.state === 'ready', show(r))
}

// ---------------------------------------------------------------------------------------------
console.log('\nthe footer')
{
  const w = makeWorld()
  const preflight = run(w, forkJoin(w), { request: FORK_JOIN })
  check('with no --confirmed, the footer carries none, so no digest reads as confirmed', preflight.json?.footer === `node ${quote(SCRIPT)} ${PIN} '${CANON}'`, preflight.json?.footer)
  // What a status message carries: the request and the digests the user confirmed at preflight.
  const digests = preflight.json.nodes.map((x) => `${x.issue}:${x.bodySha256}`).join(',')
  const st = forkJoin(w)
  const r = run(w, st, { request: FORK_JOIN, confirmed: digests })
  check('with --confirmed, the footer carries the canonical request and the digests', r.code === 0 && r.json?.footer === `node ${quote(SCRIPT)} ${PIN} '${CANON}' --confirmed ${digests}` &&
    digests === [1, 2, 3, 4].map((n) => `${n}:${sha256(bodyOf(n))}`).join(','), r.json?.footer)
  // Replay every answer the in-process run got, through a gh found on PATH, and run the footer
  // through sh exactly as printed.
  const bin = join(w.dir, 'bin')
  mkdirSync(bin)
  const answers = Object.fromEntries(st.calls.map((c) => [c.args.join('\u0000'), c.answer]))
  writeFileSync(join(w.dir, 'answers.json'), JSON.stringify(answers))
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nconst fs = require('fs')\nconst args = process.argv.slice(2)\n` +
    `fs.appendFileSync(${JSON.stringify(join(w.dir, 'gh.log'))}, JSON.stringify(args) + '\\n')\n` +
    `const a = JSON.parse(fs.readFileSync(${JSON.stringify(join(w.dir, 'answers.json'))}, 'utf8'))[args.join('\\u0000')]\n` +
    "if (!a) { process.stderr.write('replay gh: unexpected ' + args.join(' ') + '\\n'); process.exit(3) }\n" +
    'process.stdout.write(a.stdout); process.stderr.write(a.stderr); process.exit(a.code)\n')
  chmodSync(join(bin, 'gh'), 0o755)
  const env = { ...process.env, GIT_SSH_COMMAND: w.ssh, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` }
  const again = spawnSync('sh', ['-c', r.json.footer], { cwd: w.repo, env, encoding: 'utf8' })
  const footer2 = JSON.parse(again.stdout || '{}').footer
  check('the footer, run through sh with the real CLI, exits 0 and prints the same line byte for byte', again.status === 0 && again.stdout === r.stdout && again.stderr === '', `${again.status} ${again.stdout}${again.stderr}`)
  check('so it re-runs to itself', footer2 === r.json.footer, footer2)
  const third = spawnSync('sh', ['-c', footer2], { cwd: w.repo, env, encoding: 'utf8' })
  check('and again', third.status === 0 && third.stdout === r.stdout, `${third.status} ${third.stdout}${third.stderr}`)
  const replayed = readFileSync(join(w.dir, 'gh.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  check('the CLI asked gh nothing the in-process run didn\'t', replayed.every((a) => answers[a.join('\u0000')] !== undefined), JSON.stringify(replayed))
  everyCall.push(...replayed)

  const confirmed = `1:${'a'.repeat(64)},2:${'b'.repeat(64)}`
  const echoed = run(w, forkJoin(w), { request: '#2 → land → #3; #1 → land → #3; #4', confirmed: `2:${'b'.repeat(64)},1:${'a'.repeat(64)}` })
  check('with --confirmed, the footer echoes it, sorted, with the canonical request', echoed.json?.footer === `node ${quote(SCRIPT)} ${PIN} '${CANON}' --confirmed ${confirmed}`, echoed.json?.footer)
  const usage = spawnSync(process.execPath, [SCRIPT], { cwd: w.repo, env, encoding: 'utf8' })
  check('the CLI with no arguments exits 2 with a usage refusal', usage.status === 2 && JSON.parse(usage.stdout || '{}').reason === 'usage', `${usage.status} ${usage.stdout}${usage.stderr}`)
  const plain = join(tmp, 'plain')
  execFileSync('git', ['init', '-q', '-b', 'main', plain])
  const four = spawnSync(process.execPath, [SCRIPT, PIN, '#1'], { cwd: plain, env, encoding: 'utf8' })
  check('the CLI in a checkout with no origin exits 4', four.status === 4 && JSON.parse(four.stdout || '{}').reason === 'origin-unreadable', `${four.status} ${four.stdout}${four.stderr}`)
}

// ---------------------------------------------------------------------------------------------
console.log('\nbody digest parity with the claim')
{
  // CRLF, trailing blanks, non-ASCII and no final newline: everything a trim or a re-encode would change.
  const tricky = `  Why, with ünïcödé ✓.\r\n\r\n## Acceptance Criteria\r\n\r\n- [ ] the digest matches  \r\n  - evidence: this smoke\t\r\n\n\n  `
  const w = makeWorld()
  const st = freshState({ issues: { 7: issue(7, { title: 'Add the claim verb', body: tricky }) } })
  const r = run(w, st, { request: '#7' })
  const digest = node(r, 7)?.bodySha256
  check('the ledger digests the body as gh printed it, untrimmed, as UTF-8', digest === sha256(tricky) && digest === bodyDigest(tricky) && digest !== sha256(tricky.trim()), `${digest}`)
  const claimGh = () => {
    const state = { issue: { ...st.issues[7], assignees: [] } }
    return (args) => {
      const ok = (v) => ({ code: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' })
      if (args[0] === 'issue' && args[1] === 'view') return ok(state.issue)
      if (args[0] === 'api' && args.at(-1) === 'user') return ok('jakub\n')
      if (args[0] === 'api') return ok([[]])
      if (args[0] === 'issue' && args[1] === 'edit') { state.issue = { ...state.issue, labels: [{ name: 'in-progress' }], assignees: [{ login: 'jakub' }] }; return ok('') }
      return { code: 3, stdout: '', stderr: `claim gh: unexpected ${args.join(' ')}\n` }
    }
  }
  const claim = (expect) => {
    const cw = makeWorld()
    process.env.GIT_SSH_COMMAND = cw.ssh
    const out = issueClaim({ argv: ['claim', '7', '--expect-body', expect], cwd: cw.repo, env: {}, runGh: claimGh() })
    process.env.GIT_SSH_COMMAND = 'false'
    return JSON.parse(out.stdout)
  }
  const passed = claim(digest)
  check('issueClaim given the ledger\'s digest claims the issue', passed.result === 'claimed', JSON.stringify(passed))
  const trimmed = claim(sha256(tricky.trim()))
  check('and given the trimmed body\'s digest refuses body-moved', trimmed.result === 'refused' && trimmed.reason === 'body-moved', JSON.stringify(trimmed))
}

// ---------------------------------------------------------------------------------------------
console.log('\nthe sweep: every gh call any run made')
const mutation = (args) => {
  const line = args.join(' ')
  if (/^(issue|pr|label|repo|release|gist|secret|variable|workflow|run|cache|ruleset) (edit|create|close|reopen|merge|delete|comment|lock|unlock|pin|unpin|transfer|develop|ready|review|revert|update-branch|archive|rename|set|sync|fork|clone|upload|cancel|rerun)\b/.test(line)) return true
  if (args[0] === 'api') {
    const method = args.findIndex((a) => a === '-X' || a === '--method')
    if (method >= 0 && String(args[method + 1]).toUpperCase() !== 'GET') return true
    if (args.some((a) => /^(-f|-F|--field|--raw-field|--input)$/.test(a))) return true
  }
  return false
}
check(`no run issued a gh mutation (${everyCall.length} calls)`, everyCall.length > 100 && !everyCall.some(mutation), JSON.stringify(everyCall.filter(mutation)))
check('no run made a gh call the stub doesn\'t know', everyUnexpected.length === 0, JSON.stringify(everyUnexpected))
check('every kind of read the ledger makes was exercised', ['repo view', 'api --hostname github.com user', 'issue view', 'pr view', 'api --hostname github.com repos/jakub/demo/compare/']
  .every((prefix) => everyCall.some((a) => a.join(' ').startsWith(prefix))))
check('the fork/join run was captured', forkJoinLine !== null)

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nchain-ledger: ALL PASS' : `\nchain-ledger: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
