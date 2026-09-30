#!/usr/bin/env node
// Smoke for the claim verb of scripts/issue-claim.mjs, driven in process with every git call real
// and gh injected as a function that answers from a per-case state object and records each call.
//
// Each case gets a bare repository standing in for origin at git@github.com:jakub/demo.git,
// reached through a GIT_SSH_COMMAND script that runs upload-pack or receive-pack against it on
// disk, so every gh call has a host, owner and repository to be pinned to and nothing leaves the
// machine. Assertions read the bare repository and the clone, not the JSON alone. Git hooks fail
// real commands at chosen moments: a post-checkout that fails the first worktree add after git
// created the branch, and a pre-receive that writes the pushed ref and then refuses, which is a
// lost push response.
//
// Run: node plugins/flow/scripts/smoke-issue-claim-verb.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { issueClaim } from './issue-claim.mjs'

let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad += 1
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` -> ${detail}`}`)
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-claim-verb-')))
// In process, so the isolation goes on process.env: no developer gitconfig, no prompt, no proxy.
Object.assign(process.env, {
  HOME: tmp, GIT_CONFIG_GLOBAL: join(tmp, 'none'), GIT_CONFIG_SYSTEM: join(tmp, 'none'),
  GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 'smoke@example.invalid', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
  GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', GIT_SSH_COMMAND: 'false',
})
for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete process.env[key]

const ISSUE = 7
const SLUG = 'add-the-claim-verb'
const BRANCH = `feat/issue-${ISSUE}-${SLUG}`
const TAG = `refs/tags/flow-claim-issue-${ISSUE}`
const AC = '## Acceptance Criteria\n\n- [ ] one command replaces the prose steps\n  - evidence: this smoke\n'
const BODY = `Why this exists.\n\n${AC}## Notes\n\nOutside the digest.\n`
const AC_DIGEST = createHash('sha256').update(AC, 'utf8').digest('hex')
const PIN = 'github.com/jakub/demo'

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const refSha = (dir, ref) => {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}
const allRefs = (dir) => spawnSync('git', ['-C', dir, 'show-ref'], { encoding: 'utf8' }).stdout
const worktreeCount = (repo) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length
const writeHook = (gitDir, name, body) => { writeFileSync(join(gitDir, 'hooks', name), body); chmodSync(join(gitDir, 'hooks', name), 0o755) }
const FAIL_FIRST_CHECKOUT = '#!/bin/sh\nrm -f "$0"\nexit 1\n'
const PLANT_THEN_REFUSE = '#!/bin/sh\nwhile read -r old new ref; do env -u GIT_QUARANTINE_PATH git update-ref "$ref" "$new"; done\necho "the answer went missing" >&2\nexit 1\n'
const REFUSE_TAGS = '#!/bin/sh\nwhile read -r old new ref; do case "$ref" in refs/tags/*) echo "tags are protected" >&2; exit 1;; esac; done\nexit 0\n'
const DROP_BRANCHES = '#!/bin/sh\nwhile read -r old new ref; do case "$ref" in refs/heads/feat/*) git update-ref -d "$ref";; esac; done\n'
const REFUSE_DELETES = '#!/bin/sh\nwhile read -r old new ref; do case "$new" in 0000000000000000000000000000000000000000) echo "no deletes" >&2; exit 1;; esac; done\nexit 0\n'

/** A clone whose origin names a host and is still a bare repository on disk. */
const makeWorld = (name, remote = 'git@github.com:jakub/demo.git') => {
  const dir = join(tmp, name)
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
  return { dir, origin, repo, ssh, gitDir: join(repo, '.git'), mainSha: git(repo, 'rev-parse', 'HEAD'), path: (slug = SLUG) => join(repo, '.flow-worktrees', `repo-issue-${ISSUE}-${slug}`) }
}

const freshState = (over = {}) => ({
  login: 'jakub', prs: [], applyEdit: true, editExit: 0, viewAt: {}, views: 0, calls: [], onPrScan: null, ...over,
  issue: { number: ISSUE, title: 'Add the claim verb', state: 'OPEN', labels: [{ name: 'ready-for-agent' }], assignees: [], body: BODY, url: `https://github.com/jakub/demo/issues/${ISSUE}`, ...(over.issue || {}) },
})
const makeRunGh = (st) => (args, options) => {
  st.calls.push({ args, cwd: options?.cwd })
  const ok = (value) => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' })
  if (args[0] === 'issue' && args[1] === 'view') { st.views += 1; return ok(st.viewAt[st.views - 1] ?? st.issue) }
  if (args[0] === 'api' && args.at(-1) === 'user') return ok(`${st.login}\n`)
  if (args[0] === 'api') { st.pullReads = (st.pullReads ?? 0) + 1; st.onPrScan?.(st.pullReads); return ok([st.prs]) }
  if (args[0] === 'issue' && args[1] === 'edit') {
    if (st.editExit) return { code: st.editExit, stdout: '', stderr: 'fake gh: edit failed\n' }
    if (st.applyEdit) {
      const labels = st.issue.labels.map((l) => l.name)
      const rm = args.indexOf('--remove-label')
      st.issue.labels = labels.filter((l) => l !== args[rm + 1]).concat(args[args.indexOf('--add-label') + 1]).map((name) => ({ name }))
      st.issue.assignees = [{ login: st.assignAs ?? st.login }]
    }
    return ok('')
  }
  return { code: 3, stdout: '', stderr: `fake gh: unexpected ${args.join(' ')}\n` }
}
const edits = (st) => st.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'edit')

const run = (w, st = freshState(), { argv = ['claim', String(ISSUE)], cwd = w.repo, env = {} } = {}) => {
  process.env.GIT_SSH_COMMAND = w.ssh
  const result = issueClaim({ argv, cwd, env, runGh: makeRunGh(st) })
  process.env.GIT_SSH_COMMAND = 'false'
  let json = null
  try { json = JSON.parse(result.stdout) } catch {}
  return { ...result, json, st }
}
/** Nothing of this run anywhere: origin as it was, one worktree, no issue branch here, no edit. */
const untouched = (w, r, before) =>
  allRefs(w.origin) === before && worktreeCount(w.repo) === 1 && refSha(w.repo, `refs/heads/${BRANCH}`) === null && edits(r.st).length === 0

console.log('a claim on a ready issue')
{
  const w = makeWorld('happy')
  const r = run(w)
  check('exits 0 with result claimed', r.code === 0 && r.json?.result === 'claimed', `${r.code} ${r.stdout}${r.stderr}`)
  check('on the derived branch, at origin main, with the section digest', r.json?.branch === BRANCH && r.json?.base === w.mainSha && r.json?.head === w.mainSha && r.json?.acDigest === AC_DIGEST, r.stdout)
  check('the worktree is registered at the planned path on that branch', r.json?.worktree === w.path() && git(w.path(), 'symbolic-ref', 'HEAD') === `refs/heads/${BRANCH}`, r.stdout)
  check('the branch is on origin and the claim tag is gone', refSha(w.origin, `refs/heads/${BRANCH}`) === w.mainSha && refSha(w.origin, TAG) === null, allRefs(w.origin))
  check('the issue reads in-progress and assigned', r.st.issue.labels.map((l) => l.name).join() === 'in-progress' && r.st.issue.assignees[0]?.login === 'jakub', JSON.stringify(r.st.issue))
  check('the container is private and ignored', (lstatSync(join(w.repo, '.flow-worktrees')).mode & 0o777) === 0o700 &&
    readFileSync(join(w.gitDir, 'info', 'exclude'), 'utf8').split('\n').includes('/.flow-worktrees/'), 'container or exclude')
  const issueCalls = r.st.calls.filter((c) => c.args[0] === 'issue')
  const apiCalls = r.st.calls.filter((c) => c.args[0] === 'api')
  check('every issue call is pinned with --repo', issueCalls.length === 4 && issueCalls.every((c) => c.args[c.args.indexOf('--repo') + 1] === PIN), JSON.stringify(issueCalls.map((c) => c.args)))
  check('every api call is pinned with --hostname and its endpoint', apiCalls.length === 3 && apiCalls.every((c) => c.args[c.args.indexOf('--hostname') + 1] === 'github.com' &&
    ['user', 'repos/jakub/demo/pulls?state=open&per_page=100'].includes(c.args.at(-1))), JSON.stringify(apiCalls.map((c) => c.args)))
}
{
  const w = makeWorld('non-ascii')
  const r = run(w, freshState({ issue: { title: '修复登录' } }))
  const slug = `t-${createHash('sha256').update('修复登录', 'utf8').digest('hex').slice(0, 12)}`
  check('a title with no ASCII letters still claims, on a hashed slug', r.code === 0 && r.json?.branch === `feat/issue-${ISSUE}-${slug}`, r.stdout)
  const fix = run(makeWorld('bug-kind'), freshState({ issue: { labels: [{ name: 'ready-for-agent' }, { name: 'bug' }] } }))
  check('a bug label makes a fix/ branch', fix.json?.branch === `fix/issue-${ISSUE}-${SLUG}`, fix.stdout)
}

console.log('\nevery refusal before the claim mutates nothing')
const refusals = [
  ['a closed issue', 'issue-closed', { issue: { state: 'CLOSED' } }],
  ['no ready label', 'not-ready', { issue: { labels: [{ name: 'needs-triage' }] } }],
  ['a blocker beside the ready label', 'blocked', { issue: { labels: [{ name: 'ready-for-agent' }, { name: 'needs-human' }] } }],
  ['no acceptance criteria heading', 'no-acceptance-criteria', { issue: { body: 'Why.\n\n## Acceptance criteria\n\n- [ ] lower case\n' } }],
  ['an empty acceptance criteria section', 'no-acceptance-criteria', { issue: { body: `Why.\n\n## Acceptance Criteria\n\n## Notes\n` } }],
  ['an empty title', 'bad-slug', { issue: { title: '   ' } }],
]
for (const [name, reason, over] of refusals) {
  const w = makeWorld(`refuse-${reason}-${name.length}`)
  const before = allRefs(w.origin)
  const r = run(w, freshState(over))
  check(`${name}: refused ${reason} with nothing retained`, r.code === 2 && r.json?.reason === reason && r.json?.retained?.length === 0, r.stdout)
  check(`${name}: nothing mutated`, untouched(w, r, before), allRefs(w.origin))
}
for (const [name, reason, prepare] of [
  ['an occupied worktree path', 'worktree-path', (w) => { mkdirSync(w.path(), { recursive: true }); writeFileSync(join(w.path(), 'x'), 'x') }],
  ['a symlinked .git', 'not-main-worktree', (w) => { renameSync(w.gitDir, join(w.dir, 'moved.git')); symlinkSync(join(w.dir, 'moved.git'), w.gitDir) }],
  ['a symlinked container', 'worktree-path', (w) => { mkdirSync(join(w.dir, 'elsewhere')); symlinkSync(join(w.dir, 'elsewhere'), join(w.repo, '.flow-worktrees')) }],
]) {
  const w = makeWorld(`refuse-${name.replace(/\W+/g, '-')}`)
  prepare(w)
  const before = allRefs(w.origin)
  const r = run(w)
  check(`${name}: refused ${reason}`, r.code === 2 && r.json?.reason === reason, r.stdout)
  check(`${name}: no claim tag was taken`, allRefs(w.origin) === before && edits(r.st).length === 0, allRefs(w.origin))
}
{
  const w = makeWorld('linked-checkout')
  git(w.repo, 'worktree', 'add', '-q', join(w.dir, 'linked'))
  const r = run(w, freshState(), { cwd: join(w.dir, 'linked') })
  check('a linked checkout is refused not-main-worktree', r.code === 2 && r.json?.reason === 'not-main-worktree', r.stdout)
}
{
  const w = makeWorld('held')
  git(w.origin, 'update-ref', TAG, w.mainSha)
  const before = allRefs(w.origin)
  const r = run(w)
  check('a tag already on origin is held, exit 3, nothing retained', r.code === 3 && r.json?.result === 'held' && r.json?.retained?.length === 0, r.stdout)
  check('and the rival tag is untouched', untouched(w, r, before), allRefs(w.origin))
}

console.log('\norigin is pinned, allowlisted and never quoted')
for (const [name, remote, reason, secret] of [
  ['a query string', 'git@github.com:jakub/demo.git?access_token=sekret', 'origin-unparseable', 'sekret'],
  ['a port', 'ssh://git@github.com:2222/jakub/demo.git', 'origin-unparseable', null],
  ['an scp token', 'user:ghp_sekrettoken@github.com:jakub/demo.git', 'origin-unparseable', 'ghp_sekrettoken'],
  ['a host off the allowlist', 'git@ghe.example.com:jakub/demo.git', 'origin-host-not-allowed', null],
]) {
  const w = makeWorld(`origin-${name.replace(/\W+/g, '-')}`, remote)
  const before = allRefs(w.origin)
  const r = run(w)
  check(`${name}: refused ${reason} before any gh call`, r.code === 2 && r.json?.reason === reason && r.st.calls.length === 0, r.stdout)
  check(`${name}: nothing mutated${secret ? ' and the secret is in neither stream' : ''}`, untouched(w, r, before) && (!secret || !`${r.stdout}${r.stderr}`.includes(secret)), `${r.stdout}${r.stderr}`)
}
{
  const w = makeWorld('ghe-allowed', 'git@ghe.example.com:jakub/demo.git')
  const r = run(w, freshState(), { env: { FLOW_GH_HOSTS: 'ghe.example.com' } })
  check('FLOW_GH_HOSTS widens the allowlist, and every call pins that host', r.code === 0 &&
    r.st.calls.every((c) => c.args.includes('ghe.example.com/jakub/demo') || c.args[c.args.indexOf('--hostname') + 1] === 'ghe.example.com'), r.stdout)
}
{
  const w = makeWorld('pushurl')
  git(w.repo, 'config', 'remote.origin.pushurl', 'git@github.com:jakub/other.git')
  const r = run(w)
  check('a push URL that differs from the fetch URL is refused', r.code === 2 && r.json?.reason === 'push-fetch-mismatch' && r.st.calls.length === 0, r.stdout)
}
{
  const w = makeWorld('https-token', 'https://user:ghp_httpstoken@github.com/jakub/demo.git')
  process.env.https_proxy = process.env.HTTPS_PROXY = 'http://127.0.0.1:9'
  const r = run(w)
  delete process.env.https_proxy; delete process.env.HTTPS_PROXY
  check('an unreachable https origin with a token fails without printing it', r.code === 4 && !`${r.stdout}${r.stderr}`.includes('ghp_httpstoken') && r.json?.repo === PIN, `${r.stdout}${r.stderr}`)
}

console.log('\na run already live on the issue')
for (const [name, where, plant] of [
  ['a branch on origin', 'remoteBranches', (w) => git(w.origin, 'update-ref', `refs/heads/fix/issue-${ISSUE}-rival`, w.mainSha)],
  ['a branch in this clone', 'localBranches', (w) => git(w.repo, 'branch', `chore/issue-${ISSUE}-stale`)],
]) {
  const w = makeWorld(`live-${where}`)
  plant(w)
  const before = allRefs(w.origin)
  const r = run(w)
  check(`${name}: refused live-run, found under ${where}`, r.code === 2 && r.json?.reason === 'live-run' && r.json?.found?.[where]?.length === 1, r.stdout)
  check(`${name}: no claim tag was ever created`, allRefs(w.origin) === before && edits(r.st).length === 0, allRefs(w.origin))
}
{
  const w = makeWorld('live-fork-pr')
  const r = run(w, freshState({ prs: [{ number: 42, head: { ref: `feat/issue-${ISSUE}-from-a-fork`, repo: { fork: true } }, html_url: 'https://github.com/jakub/demo/pull/42' }] }))
  check('an open pull request from a fork is a live run', r.code === 2 && r.json?.found?.pullRequests?.[0]?.number === 42, r.stdout)
}
{
  // The pull-request read is the last read of a scan, so a branch planted there is missed by the
  // scan that just finished and seen by the one under the tag.
  const w = makeWorld('live-under-tag')
  const st = freshState({ onPrScan: (n) => { if (n === 1) git(w.origin, 'update-ref', `refs/heads/feat/issue-${ISSUE}-rival`, w.mainSha) } })
  const r = run(w, st)
  check('a contender found under the tag: refused live-run, nothing retained', r.code === 2 && r.json?.reason === 'live-run' && r.json?.retained?.length === 0, r.stdout)
  check('the tag went back and no worktree was added', refSha(w.origin, TAG) === null && worktreeCount(w.repo) === 1 && edits(st).length === 0, allRefs(w.origin))
}
{
  const w = makeWorld('closed-under-tag')
  const r = run(w, freshState({ viewAt: { 1: { ...freshState().issue, state: 'CLOSED' } } }))
  check('an issue closed between the reads is refused under the tag, and the tag goes back', r.code === 2 && r.json?.reason === 'issue-closed' && refSha(w.origin, TAG) === null, r.stdout)
}

console.log('\nwhat a failure leaves behind')
{
  const w = makeWorld('worktree-strand')
  writeHook(w.gitDir, 'post-checkout', FAIL_FIRST_CHECKOUT)
  const first = run(w)
  check('a worktree add that fails after creating the branch is refused worktree-add', first.code === 2 && first.json?.reason === 'worktree-add' && first.json?.retained?.length === 0, first.stdout)
  check('the branch, the worktree and the tag are all gone', refSha(w.repo, `refs/heads/${BRANCH}`) === null && !existsSync(w.path()) && refSha(w.origin, TAG) === null, allRefs(w.repo))
  check('so the next claim goes through', run(w).json?.result === 'claimed', 'retry')
}
{
  const w = makeWorld('lost-push')
  const st = freshState({ onPrScan: (n) => { if (n === 2) writeHook(w.origin, 'pre-receive', PLANT_THEN_REFUSE) } })
  const r = run(w, st)
  check('a push whose answer was lost is unknown with everything retained', r.code === 4 && r.json?.reason === 'push' && r.json?.retained?.length === 4, r.stdout)
  check('the branch marker and the tag both stay on origin, and no label moved', refSha(w.origin, `refs/heads/${BRANCH}`) === w.mainSha && refSha(w.origin, TAG) === w.mainSha && edits(st).length === 0, allRefs(w.origin))
}
{
  const w = makeWorld('tag-lost-answer')
  writeHook(w.origin, 'pre-receive', PLANT_THEN_REFUSE)
  const r = run(w)
  check('a tag on origin after this run\'s own failed push is acquire-ambiguous, tag retained', r.code === 4 && r.json?.reason === 'acquire-ambiguous' && r.json?.retained?.join() === 'claim-tag', r.stdout)
}
{
  const w = makeWorld('tags-protected')
  writeHook(w.origin, 'pre-receive', REFUSE_TAGS)
  const r = run(w)
  check('a tag origin refuses to create is acquire-not-created, nothing retained', r.code === 4 && r.json?.reason === 'acquire-not-created' && r.json?.retained?.length === 0 && refSha(w.origin, TAG) === null, r.stdout)
}
{
  const w = makeWorld('tag-kept')
  const st = freshState({ onPrScan: (n) => { if (n === 1) { writeHook(w.origin, 'pre-receive', REFUSE_DELETES); git(w.origin, 'update-ref', `refs/heads/feat/issue-${ISSUE}-rival`, w.mainSha) } } })
  const r = run(w, st)
  check('a stand-down whose tag cannot be dropped is unknown, naming the tag', r.code === 4 && r.json?.reason === 'live-run' && r.json?.retained?.join() === 'claim-tag' && r.json?.cleanup === 'drop-tag', r.stdout)
  check('and the tag really is still on origin', refSha(w.origin, TAG) === w.mainSha, allRefs(w.origin))
}
{
  const w = makeWorld('branch-vanishes')
  writeHook(w.origin, 'post-receive', DROP_BRANCHES)
  const r = run(w)
  check('a branch that does not read back on origin keeps the tag: unknown release, everything retained', r.code === 4 && r.json?.reason === 'release' && r.json?.retained?.length === 4, r.stdout)
  check('and the tag really is still on origin', refSha(w.origin, TAG) === w.mainSha, allRefs(w.origin))
}
for (const [name, reason, over] of [
  ['a label edit gh accepted and never made', 'issue-edit-unconfirmed', { applyEdit: false }],
  ['a label edit gh refused', 'issue-edit', { editExit: 1 }],
  ['an assignment to another login', 'issue-edit-unconfirmed', { assignAs: 'someone-else' }],
]) {
  const w = makeWorld(`edit-${reason}-${name.length}`)
  const st = freshState(over)
  const r = run(w, st)
  check(`${name}: unknown ${reason}, everything retained`, r.code === 4 && r.json?.reason === reason && r.json?.retained?.length === 4, r.stdout)
  check(`${name}: the branch and the tag stay for a human`, refSha(w.origin, `refs/heads/${BRANCH}`) === w.mainSha && refSha(w.origin, TAG) === w.mainSha, allRefs(w.origin))
}

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nissue-claim verb: ALL PASS' : `\nissue-claim verb: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
