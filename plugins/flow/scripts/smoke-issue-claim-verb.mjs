#!/usr/bin/env node
// Smoke harness for the claim verb of scripts/issue-claim.mjs, the one command the issue stage
// runs instead of executing nine prose steps by hand.
//
// Everything git is real. Each case gets its own bare repository standing in for origin and a
// clone beside it, under mktemp, and every assertion about what happened reads that bare
// repository or the clone's worktree list directly rather than believing the JSON line. The
// claim's mutual exclusion is git's own, so faking git would test nothing.
//
// Everything GitHub is a fake gh injected in process, the same way scripts/smoke-release-path.mjs
// injects one: a plain function across the module boundary, answering `issue view`, the paged
// `api` read of the open pull requests and `issue edit` from a per-case state object, and
// recording every call it was handed. No environment variable selects it, and nothing here needs
// a network or a GitHub account. The fake applies an `issue edit` to its own copy of the issue,
// because the executor reads the issue back afterwards to confirm the labels moved; a case that
// wants the other thing GitHub can do, accepting the request and changing nothing, sets
// applyEdit false.
//
// Two shapes of origin. Most worlds push to a bare repository at a filesystem path, which has no
// host to pin a gh call to: there the stripped environment is all that stands between gh and a
// default repository of its own choosing, and the assertion is that nothing is pinned. One world
// has a host-qualified origin, git@github.com:jakub/demo.git, served locally through a
// GIT_SSH_COMMAND script that ignores the host it is handed and runs upload-pack or receive-pack
// against a bare repository on disk. That is the shape where the pin is real, and the assertion
// is that every gh call carries it. Still no network.
//
// The two live-run cases are the ones worth reading. The first plants a rival branch on origin
// before the run starts, which the pre-scan sees, and the assertion is that no claim tag was ever
// created. The second plants the rival between the first scan and the acquire, using the fake
// gh's pull request read as the hook: the paged pull request read is the last read of a scan, so a branch planted
// there is invisible to the scan that just finished and visible to the one that runs while the
// tag is held. That is the delayed contender the second scan exists for, and the assertions are
// that the run stood down, gave the tag back, and left no worktree.
//
// The ordering rule the verb rests on gets its own case: gh's `issue edit` fails after the branch
// is already on origin. That must not abandon the tag, because the branch is now the marker every
// other run scans for and a claim that reads as never-taken would be a lie. The run exits 4 with
// the branch and the tag both still there for a human.
//
// The failure paths are the second half, and each one is a defect two reviewers reproduced by
// hand before it was fixed. Git hooks are what make them happen on demand, since they are the one
// way to fail a real git command at a chosen moment:
//
//   post-checkout in the clone, exiting 1 after deleting itself, makes the first `git worktree
//     add` fail after git has already created both the worktree and the branch, and lets the
//     second run through untouched. The branch used to survive that cleanup and refuse every
//     retry with `a branch named ... already exists`, forever.
//   pre-receive on origin, refusing anything that deletes a ref, lets the claim tag be created
//     and then refuses to let it be given back. A refusal that reports itself as clean while the
//     tag is still on the remote is the lie this checks for.
//   pre-receive on origin, planting the pushed ref itself and then exiting 1, is a lost push
//     response: receive-pack updated the branch and the client still saw a failure. Treating that
//     as "nothing was published" would delete the marker that keeps the next run out.
//
// That same hook, armed before the run starts, fires on the claim tag instead of the branch, and
// that is the acquire's own ambiguity: the tag is on origin and the client was told the push
// failed, so it might be this run's tag or a rival's. Two cases sit on either side of it. A tag
// planted before the run is a rival's beyond doubt and the stand-down is clean, at phase
// pre-acquire. A tag first seen after this run's own push is an unknown that keeps the tag. The
// third case is the other half of the same field: an acquire that fails before it pushes
// anything, made by breaking origin's URL in the clone once the scan has finished with it, has no
// tag to report and must not send a human looking for one.
//
// Run: node plugins/flow/scripts/smoke-issue-claim-verb.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { issueClaim } from './issue-claim.mjs'

let bad = 0
let checks = 0
const check = (name, ok, detail = '') => {
  checks += 1
  if (!ok) bad += 1
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` → ${detail}`}`)
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-issue-claim-verb-')))

// The executor runs in this process, so its git calls inherit this environment rather than one
// handed to a child. The isolation therefore goes on process.env: no developer gitconfig, an
// identity that needs none, and nothing that could prompt or reach a network.
Object.assign(process.env, {
  HOME: tmp,
  GIT_CONFIG_GLOBAL: join(tmp, 'no-such-gitconfig'),
  GIT_CONFIG_SYSTEM: join(tmp, 'no-such-gitconfig'),
  GIT_AUTHOR_NAME: 'flow smoke',
  GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
  GIT_COMMITTER_NAME: 'flow smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  GIT_SSH_COMMAND: 'false',
})
for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[key]
}

// ------------------------------------------------------------------------------ the fixture
const ISSUE = 7
const TITLE = 'Add the claim verb'
const SLUG = 'add-the-claim-verb'
const TAG_REF = `refs/tags/flow-claim-issue-${ISSUE}`
// The section the digest covers: from the heading through the byte before the next `## `, which
// is the trailing newline of the last bullet.
const AC = '## Acceptance Criteria\n\n- [ ] one command replaces the nine prose steps\n- [ ] it prints one JSON line\n'
const BODY = `Two runs on one issue is the failure this closes.\n\n${AC}## Notes\n\nThe digest covers the section above and nothing else.\n`
const AC_DIGEST = createHash('sha256').update(Buffer.from(AC, 'utf8')).digest('hex')

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
const tryGit = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  return r.status === 0 ? String(r.stdout).trim() : null
}
const refSha = (dir, ref) => tryGit(dir, 'rev-parse', '--verify', '--quiet', ref)
const allRefs = (dir) => tryGit(dir, 'show-ref') ?? ''
const worktreePaths = (repo) => git(repo, 'worktree', 'list', '--porcelain')
  .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length))

/**
 * A hook, executable, in a repository's hooks directory. Both directories already exist: git init
 * writes them, bare or not.
 */
const writeHook = (gitDir, name, body) => {
  const path = join(gitDir, 'hooks', name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

// Exits 1 after removing itself, so the first `git worktree add` in a clone fails and the next
// one does not. git 2.55 leaves the worktree and the new branch behind when this fires.
const FAIL_FIRST_CHECKOUT = '#!/bin/sh\nrm -f "$0"\nexit 1\n'
// Refuses any update whose new value is the null SHA, which is every delete. A tag can be created
// through this and cannot be given back, which is what makes a failed abandon reproducible.
const REFUSE_DELETES = '#!/bin/sh\nwhile read -r old new ref; do\n' +
  '  case "$new" in 0000000000000000000000000000000000000000) echo "no deletes here" >&2; exit 1;; esac\n' +
  'done\nexit 0\n'
// A lost push response. The hook writes the ref itself, outside the quarantine environment that
// would otherwise refuse the update, and then declines: the branch is on origin at the pushed
// head and the client's `git push` still exits non-zero.
const PLANT_THEN_REFUSE = '#!/bin/sh\nwhile read -r old new ref; do\n' +
  '  env -u GIT_QUARANTINE_PATH git update-ref "$ref" "$new"\n' +
  'done\necho "the answer went missing" >&2\nexit 1\n'

// A remote that will not have refs/tags/ written at all, which is what a protected tag pattern
// is. The claim tag push fails and origin positively holds no tag afterwards, so a run that
// reports a tag it may have left sends a human hunting one that was never created.
const REFUSE_TAGS = '#!/bin/sh\nwhile read -r old new ref; do\n' +
  '  case "$ref" in refs/tags/*) echo "refs/tags/ is protected here" >&2; exit 1;; esac\n' +
  'done\nexit 0\n'

/** A bare origin with one commit on main, and a clone of it to claim from. */
const makeWorld = (name) => {
  const dir = join(tmp, name)
  mkdirSync(dir)
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'repo')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'file.txt'), 'first\n')
  git(repo, 'add', 'file.txt')
  git(repo, 'commit', '-q', '-m', 'first')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main')
  const world = { name, dir, origin, repo, gitDir: join(repo, '.git'), mainSha: git(repo, 'rev-parse', 'HEAD') }
  world.pathFor = (slug) => join(dir, `repo-issue-${ISSUE}-${slug}`)
  return world
}

// ------------------------------------------------------------------- the fake gh, in process
const freshState = (overrides = {}) => ({
  viewExit: 0,
  editExit: 0,
  prs: [],
  onPrScan: null,
  // What GitHub does with an accepted edit. False is the other thing it can do: take the request
  // and leave the issue exactly as it was.
  applyEdit: true,
  // An issue read that differs from the one before it, keyed by which read it is. Read 0 is the
  // one before the acquire, read 1 the one under the claim tag, read 2 the one after the edit.
  viewAt: {},
  views: 0,
  calls: [],
  ...overrides,
  issue: {
    number: ISSUE,
    title: TITLE,
    state: 'OPEN',
    labels: [{ name: 'ready-for-agent' }],
    assignees: [],
    body: BODY,
    url: `https://github.com/jakub/marketplace-plugins/issues/${ISSUE}`,
    ...(overrides.issue || {}),
  },
})

/** The label and assignee moves an accepted `gh issue edit` makes, applied to the fake's issue. */
const applyEdit = (st, args) => {
  const labels = st.issue.labels.map((label) => label.name)
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--remove-label') {
      const at = labels.indexOf(args[i + 1])
      if (at >= 0) labels.splice(at, 1)
    }
    if (args[i] === '--add-label' && !labels.includes(args[i + 1])) labels.push(args[i + 1])
    if (args[i] === '--add-assignee') st.issue.assignees = [{ login: 'jakub' }]
  }
  st.issue.labels = labels.map((name) => ({ name }))
}

const makeRunGh = (st) => (args, options) => {
  st.calls.push({ args, cwd: options?.cwd })
  if (args[0] === 'issue' && args[1] === 'view') {
    const nth = st.views
    st.views += 1
    if (st.viewExit) return { code: st.viewExit, stdout: '', stderr: 'fake gh: issue view failed\n' }
    return { code: 0, stdout: JSON.stringify(st.viewAt[nth] ?? st.issue), stderr: '' }
  }
  // The pull request scan. `gh api --paginate` merges the pages it walks into one array, so one
  // array is what the executor parses, and the objects are GitHub's REST shape: head.ref rather
  // than the headRefName `gh pr list` invents.
  if (args[0] === 'api') {
    if (st.onPrScan) st.onPrScan()
    return { code: 0, stdout: JSON.stringify(st.prs), stderr: '' }
  }
  if (args[0] === 'issue' && args[1] === 'edit') {
    if (st.editExit) return { code: st.editExit, stdout: '', stderr: 'fake gh: issue edit failed\n' }
    if (st.applyEdit) applyEdit(st, args)
    return { code: 0, stdout: '', stderr: '' }
  }
  return { code: 3, stdout: '', stderr: `fake gh: unexpected ${args.join(' ')}\n` }
}

const callsTo = (st, verb) => st.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === verb)
const apiCalls = (st) => st.calls.filter((c) => c.args[0] === 'api')

const run = (world, args, st = freshState(), cwd = world.repo) => {
  const result = issueClaim({ argv: args, cwd, runGh: makeRunGh(st) })
  let json = null
  try { json = JSON.parse(result.stdout) } catch {}
  return { ...result, json, st }
}

/**
 * A world whose origin is host-qualified and still entirely local. git talks to
 * git@github.com:jakub/demo.git through a GIT_SSH_COMMAND script that ignores the host it is
 * handed and runs the upload-pack or receive-pack command it was given against a bare repository
 * under this directory, so every read of the remote URL sees a host, an owner and a repository
 * while nothing leaves the machine. It is the only shape in which a gh --repo pin exists.
 */
const makeHostWorld = (name) => {
  const dir = join(tmp, name)
  const base = join(dir, 'base')
  const origin = join(base, 'jakub', 'demo.git')
  const repo = join(dir, 'repo')
  mkdirSync(join(base, 'jakub'), { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'file.txt'), 'first\n')
  git(repo, 'add', 'file.txt')
  git(repo, 'commit', '-q', '-m', 'first')
  git(repo, 'remote', 'add', 'origin', 'git@github.com:jakub/demo.git')
  const ssh = join(dir, 'fake-ssh')
  writeFileSync(ssh, `#!/bin/sh\ncd ${base} || exit 1\nfor a; do last=$a; done\nexec /bin/sh -c "$last"\n`)
  chmodSync(ssh, 0o755)
  const saved = process.env.GIT_SSH_COMMAND
  process.env.GIT_SSH_COMMAND = ssh
  git(repo, 'push', '-q', 'origin', 'main')
  process.env.GIT_SSH_COMMAND = saved
  const world = { name, dir, origin, repo, ssh, gitDir: join(repo, '.git'), mainSha: git(repo, 'rev-parse', 'HEAD') }
  world.pathFor = (slug) => join(dir, `repo-issue-${ISSUE}-${slug}`)
  return world
}

/** Run a claim with the fake ssh in place, and put the environment back afterwards. */
const runOverSsh = (world, args, st = freshState()) => {
  const saved = process.env.GIT_SSH_COMMAND
  process.env.GIT_SSH_COMMAND = world.ssh
  try { return run(world, args, st) } finally { process.env.GIT_SSH_COMMAND = saved }
}

// --------------------------------------------------------------------------- the happy path
console.log('\na claim on a ready issue')
{
  const w = makeWorld('happy')
  const worktree = w.pathFor(SLUG)
  const r = run(w, ['claim', String(ISSUE)])
  const branch = `feat/issue-${ISSUE}-${SLUG}`
  check('exits 0 with result claimed', r.code === 0 && r.json?.result === 'claimed', `exit ${r.code} ${r.stdout}`)
  check('the branch is the derived one', r.json?.branch === branch, String(r.json?.branch))
  check('base and head are the object the acquire verified', r.json?.base === w.mainSha && r.json?.head === w.mainSha, `${r.json?.base} ${r.json?.head}`)
  check('the acceptance criteria digest is the sha256 of the section', r.json?.acDigest === AC_DIGEST, String(r.json?.acDigest))
  check('the worktree path is the sibling of the repository', r.json?.worktree === worktree, String(r.json?.worktree))
  check('the title and url come back from the issue read', r.json?.title === TITLE && String(r.json?.url).endsWith(`/issues/${ISSUE}`), r.stdout)
  check('nothing is written to stderr on a win', r.stderr === '', JSON.stringify(r.stderr))

  check('origin holds the branch at the base', refSha(w.origin, `refs/heads/${branch}`) === w.mainSha, String(refSha(w.origin, `refs/heads/${branch}`)))
  check('the claim tag is gone from origin', refSha(w.origin, TAG_REF) === null, String(refSha(w.origin, TAG_REF)))
  check('the worktree exists on disk', existsSync(worktree), worktree)
  check('git has it registered', worktreePaths(w.repo).includes(worktree), worktreePaths(w.repo).join(','))
  check('the worktree is on the claim branch', tryGit(worktree, 'symbolic-ref', '--short', 'HEAD') === branch, String(tryGit(worktree, 'symbolic-ref', '--short', 'HEAD')))

  const edits = callsTo(r.st, 'edit')
  const edit = edits[0]?.args ?? []
  check('gh issue edit ran exactly once', edits.length === 1, `${edits.length} calls`)
  check('and it carried the assignee and both label moves in one call',
    edit.includes('--add-assignee') && edit.includes('@me') &&
    edit[edit.indexOf('--remove-label') + 1] === 'ready-for-agent' &&
    edit[edit.indexOf('--add-label') + 1] === 'in-progress', JSON.stringify(edit))
  check('every gh call ran in the repository', r.st.calls.every((c) => c.cwd === w.repo), JSON.stringify(r.st.calls.map((c) => c.cwd)))
  check('the issue is read three times: before the acquire, under the claim tag, and after the edit',
    callsTo(r.st, 'view').length === 3, `${callsTo(r.st, 'view').length} reads`)
  check('the pull request scan is the paged api read, once per scan, and gh pr list is never called',
    apiCalls(r.st).length === 2 && apiCalls(r.st).every((c) => c.args.includes('--paginate')) &&
    r.st.calls.every((c) => !(c.args[0] === 'pr' && c.args[1] === 'list')), JSON.stringify(r.st.calls.map((c) => c.args.slice(0, 2).join(' '))))
  check('an origin with no host pins nothing, because there is no host to pin to',
    r.st.calls.every((c) => !c.args.includes('--repo') && !c.args.includes('--hostname')), JSON.stringify(r.st.calls.map((c) => c.args)))
}

// ------------------------------------------------------------ refusals that mutate nothing
console.log('\nrefusals before the first write')
{
  const w = makeWorld('refusals')
  const before = allRefs(w.origin)
  const untouched = (label, r) => {
    check(`${label}: origin is unchanged`, allRefs(w.origin) === before, allRefs(w.origin))
    check(`${label}: no gh issue edit`, callsTo(r.st, 'edit').length === 0, 'an edit went out')
    check(`${label}: no worktree`, worktreePaths(w.repo).length === 1, worktreePaths(w.repo).join(','))
  }

  const closed = run(w, ['claim', String(ISSUE)], freshState({ issue: { state: 'CLOSED' } }))
  check('a closed issue refuses with issue-closed', closed.code === 2 && closed.json?.reason === 'issue-closed', `exit ${closed.code} ${closed.stdout}`)
  untouched('closed', closed)

  const notReady = run(w, ['claim', String(ISSUE)], freshState({ issue: { labels: [{ name: 'enhancement' }] } }))
  check('a missing ready-for-agent refuses with not-ready', notReady.code === 2 && notReady.json?.reason === 'not-ready', `exit ${notReady.code} ${notReady.stdout}`)
  untouched('not-ready', notReady)

  for (const label of ['needs-human', 'needs-info', 'needs-rebase']) {
    const blocked = run(w, ['claim', String(ISSUE)], freshState({ issue: { labels: [{ name: 'ready-for-agent' }, { name: label }] } }))
    check(`${label} beside the ready label refuses with blocked`, blocked.code === 2 && blocked.json?.reason === 'blocked', `exit ${blocked.code} ${blocked.stdout}`)
    check(`${label} is named in the refusal`, String(blocked.json?.detail).includes(label) && (blocked.json?.blocking ?? []).includes(label), blocked.stdout)
    untouched(label, blocked)
  }

  const noHeading = run(w, ['claim', String(ISSUE)], freshState({ issue: { body: 'No criteria anywhere in this body.\n' } }))
  check('a body with no criteria heading refuses', noHeading.code === 2 && noHeading.json?.reason === 'no-acceptance-criteria', `exit ${noHeading.code} ${noHeading.stdout}`)
  untouched('no heading', noHeading)

  const lowercase = run(w, ['claim', String(ISSUE)], freshState({ issue: { body: BODY.replace('## Acceptance Criteria', '## Acceptance criteria') } }))
  check('"## Acceptance criteria" is not the heading and refuses too', lowercase.code === 2 && lowercase.json?.reason === 'no-acceptance-criteria', `exit ${lowercase.code} ${lowercase.stdout}`)
  untouched('lowercase heading', lowercase)
}

// ------------------------------------------------------------------------- a run already live
console.log('\na run already live on the issue')
{
  const w = makeWorld('live-prescan')
  git(w.origin, 'update-ref', `refs/heads/feat/issue-${ISSUE}-someone-elses-run`, w.mainSha)
  const r = run(w, ['claim', String(ISSUE)])
  check('the pre-scan refuses with live-run', r.code === 2 && r.json?.reason === 'live-run', `exit ${r.code} ${r.stdout}`)
  check('and names the branch it found under found.remoteBranches',
    (r.json?.found?.remoteBranches ?? []).some((hit) => hit.ref === `refs/heads/feat/issue-${ISSUE}-someone-elses-run`), r.stdout)
  check('the phase says nothing was written', r.json?.phase === 'pre-acquire' && (r.json?.retained ?? null)?.length === 0, r.stdout)
  check('no claim tag was ever created', refSha(w.origin, TAG_REF) === null, String(refSha(w.origin, TAG_REF)))
  check('no worktree was added', worktreePaths(w.repo).length === 1, worktreePaths(w.repo).join(','))
  check('the issue was not touched', callsTo(r.st, 'edit').length === 0, 'an edit went out')
}
{
  // The delayed contender: a rival branch appears after the first scan and before the acquire.
  // the paged pull request read is the last read of a scan, so planting there is invisible to the scan that just
  // finished and visible to the one that runs under the tag.
  const w = makeWorld('live-rescan')
  const rival = `refs/heads/fix/issue-${ISSUE}-a-rival-run`
  let seen = 0
  const st = freshState()
  st.onPrScan = () => { if (seen++ === 0) git(w.origin, 'update-ref', rival, w.mainSha) }
  const r = run(w, ['claim', String(ISSUE)], st)
  check('the second scan catches it and refuses with live-run', r.code === 2 && r.json?.reason === 'live-run', `exit ${r.code} ${r.stdout}`)
  check('the scan ran twice', seen === 2, `${seen} pull request reads`)
  check('and names the branch that appeared under found.remoteBranches', (r.json?.found?.remoteBranches ?? []).some((hit) => hit.ref === rival), r.stdout)
  check('the phase says the tag had been taken, and the cleanup confirmed',
    r.json?.phase === 'acquired' && (r.json?.retained ?? null)?.length === 0 && r.json?.cleanup === null, r.stdout)
  check('the claim tag was given back', r.json?.abandon === 'abandoned' && refSha(w.origin, TAG_REF) === null, `${r.json?.abandon} ${refSha(w.origin, TAG_REF)}`)
  check('this run published no branch', refSha(w.origin, `refs/heads/feat/issue-${ISSUE}-${SLUG}`) === null, 'a branch was pushed')
  check('and added no worktree', worktreePaths(w.repo).length === 1, worktreePaths(w.repo).join(','))
  check('the issue was not touched', callsTo(r.st, 'edit').length === 0, 'an edit went out')
}

// -------------------------------------------------------------------------------- the kind
console.log('\nthe kind of branch a claim builds')
{
  const w = makeWorld('kind-override')
  const r = run(w, ['claim', String(ISSUE), '--kind', 'chore'])
  check('--kind overrides the labels', r.code === 0 && r.json?.branch === `chore/issue-${ISSUE}-${SLUG}`, `exit ${r.code} ${r.json?.branch}`)
}
{
  const w = makeWorld('kind-bug')
  const st = freshState({ issue: { title: 'Fix: two runs, one issue!', labels: [{ name: 'ready-for-agent' }, { name: 'bug' }] } })
  const r = run(w, ['claim', String(ISSUE)], st)
  const slug = 'fix-two-runs-one-issue'
  check('a bug label builds a fix branch', r.code === 0 && r.json?.branch === `fix/issue-${ISSUE}-${slug}`, `exit ${r.code} ${r.json?.branch}`)
  check('and the slug drops the punctuation', r.json?.worktree === w.pathFor(slug), String(r.json?.worktree))
}
{
  const w = makeWorld('kind-docs')
  const st = freshState({ issue: { labels: [{ name: 'ready-for-agent' }, { name: 'documentation' }] } })
  const r = run(w, ['claim', String(ISSUE)], st)
  check('a documentation label builds a chore branch', r.code === 0 && r.json?.branch === `chore/issue-${ISSUE}-${SLUG}`, `exit ${r.code} ${r.json?.branch}`)
}
{
  const w = makeWorld('kind-docs-feature')
  const st = freshState({ issue: { labels: [{ name: 'ready-for-agent' }, { name: 'documentation' }, { name: 'enhancement' }] } })
  const r = run(w, ['claim', String(ISSUE)], st)
  check('documentation beside enhancement is still a feat', r.code === 0 && r.json?.branch === `feat/issue-${ISSUE}-${SLUG}`, `exit ${r.code} ${r.json?.branch}`)
}

// ------------------------------------------------------------------- someone else holds it
console.log('\nthe claim tag is already on origin')
{
  const w = makeWorld('held')
  git(w.origin, 'update-ref', TAG_REF, w.mainSha)
  const before = allRefs(w.origin)
  const r = run(w, ['claim', String(ISSUE)])
  check('exits 3 with result held', r.code === 3 && r.json?.result === 'held', `exit ${r.code} ${r.stdout}`)
  // The tag was there before this run pushed anything, so it is a rival's and the stand-down is
  // clean. The ambiguous case further down looks like this one and is not.
  check('at phase pre-acquire, with nothing retained',
    r.json?.phase === 'pre-acquire' && JSON.stringify(r.json?.retained) === '[]', r.stdout)
  check('and nothing for a human to clean up', r.json?.cleanup === null && /Leave it alone/.test(r.stderr), `${r.json?.cleanup} ${JSON.stringify(r.stderr)}`)
  check('the tag is left exactly where it was', allRefs(w.origin) === before, allRefs(w.origin))
  check('no worktree, no branch, no issue edit',
    worktreePaths(w.repo).length === 1 && refSha(w.origin, `refs/heads/feat/issue-${ISSUE}-${SLUG}`) === null && callsTo(r.st, 'edit').length === 0,
    'something was mutated')
}

// ---------------------------------------------------------------- a failure after the push
console.log('\ngh issue edit fails after the branch is on origin')
{
  const w = makeWorld('edit-fails')
  const r = run(w, ['claim', String(ISSUE)], freshState({ editExit: 1 }))
  const branch = `feat/issue-${ISSUE}-${SLUG}`
  check('exits 4 with result unknown', r.code === 4 && r.json?.result === 'unknown', `exit ${r.code} ${r.stdout}`)
  check('and names the step that failed', r.json?.reason === 'issue-edit', String(r.json?.reason))
  check('the branch stays on origin, where every other run can see it', refSha(w.origin, `refs/heads/${branch}`) === w.mainSha, String(refSha(w.origin, `refs/heads/${branch}`)))
  check('the claim tag is NOT given back', refSha(w.origin, TAG_REF) === w.mainSha, String(refSha(w.origin, TAG_REF)))
  check('the worktree is left in place for whoever finishes this', existsSync(w.pathFor(SLUG)) && worktreePaths(w.repo).includes(w.pathFor(SLUG)), worktreePaths(w.repo).join(','))
  check('the human is told not to re-run it', /do not re-run the claim/.test(r.stderr), JSON.stringify(r.stderr))
}

// ----------------------------------------------------------------- the path is already there
console.log('\nthe worktree path already exists')
{
  const w = makeWorld('worktree-path')
  mkdirSync(w.pathFor(SLUG))
  const before = allRefs(w.origin)
  const r = run(w, ['claim', String(ISSUE)])
  check('refuses with worktree-path', r.code === 2 && r.json?.reason === 'worktree-path', `exit ${r.code} ${r.stdout}`)
  check('origin is unchanged', allRefs(w.origin) === before, allRefs(w.origin))
  check('no claim tag was taken', refSha(w.origin, TAG_REF) === null, String(refSha(w.origin, TAG_REF)))
  check('the issue was not touched', callsTo(r.st, 'edit').length === 0, 'an edit went out')
}

// ------------------------------------------------ a worktree add that fails after it made both
console.log('\na worktree add that fails after git created the branch')
{
  // The strand. `git worktree add` runs post-checkout in the new checkout, and a hook that fails
  // there leaves git with both the directory and the branch already created and an exit code of
  // 1. The cleanup has to take the branch as well, or every retry for the rest of the day meets
  // `a branch named ... already exists` for a branch nobody ever published.
  const w = makeWorld('worktree-add-strands')
  const branch = `feat/issue-${ISSUE}-${SLUG}`
  writeHook(w.gitDir, 'post-checkout', FAIL_FIRST_CHECKOUT)

  const first = run(w, ['claim', String(ISSUE)])
  check('the first run refuses with worktree-add', first.code === 2 && first.json?.reason === 'worktree-add', `exit ${first.code} ${first.stdout}`)
  check('at phase acquired, with an empty retained list', first.json?.phase === 'acquired' && (first.json?.retained ?? null)?.length === 0, first.stdout)
  check('and no cleanup step to report', first.json?.cleanup === null, String(first.json?.cleanup))
  check('the branch git created is deleted again', refSha(w.repo, `refs/heads/${branch}`) === null, String(refSha(w.repo, `refs/heads/${branch}`)))
  check('the worktree is gone', !existsSync(w.pathFor(SLUG)) && worktreePaths(w.repo).length === 1, worktreePaths(w.repo).join(','))
  check('the claim tag was given back', first.json?.abandon === 'abandoned' && refSha(w.origin, TAG_REF) === null, `${first.json?.abandon} ${refSha(w.origin, TAG_REF)}`)
  check('and the issue was never touched', callsTo(first.st, 'edit').length === 0, 'an edit went out')

  const second = run(w, ['claim', String(ISSUE)])
  check('the retry claims, instead of meeting the branch the first run left', second.code === 0 && second.json?.result === 'claimed', `exit ${second.code} ${second.stdout}`)
  check('and its branch is on origin at the base', refSha(w.origin, `refs/heads/${branch}`) === w.mainSha, String(refSha(w.origin, `refs/heads/${branch}`)))
}

// ------------------------------------------------------------------- a stale branch in the clone
console.log('\na branch for the issue already in this clone')
{
  // Wreckage of a run that died, or a run working here right now. Either way it is a human's
  // call, and the pre-scan has to see it: this clone's branches are the one place a run leaves a
  // mark that no ls-remote and no pull request read will ever show.
  const w = makeWorld('stale-local-branch')
  const stale = `refs/heads/fix/issue-${ISSUE}-a-dead-run`
  git(w.repo, 'update-ref', stale, w.mainSha)
  const before = allRefs(w.origin)
  const r = run(w, ['claim', String(ISSUE)])
  check('the pre-scan refuses with live-run', r.code === 2 && r.json?.reason === 'live-run', `exit ${r.code} ${r.stdout}`)
  check('at phase pre-acquire', r.json?.phase === 'pre-acquire' && (r.json?.retained ?? null)?.length === 0, r.stdout)
  check('and names it under found.localBranches', (r.json?.found?.localBranches ?? []).some((hit) => hit.ref === stale), r.stdout)
  check('the stale branch is left exactly where it was', refSha(w.repo, stale) === w.mainSha, String(refSha(w.repo, stale)))
  check('origin is unchanged and no tag was taken', allRefs(w.origin) === before && refSha(w.origin, TAG_REF) === null, allRefs(w.origin))
  check('no worktree, no issue edit', worktreePaths(w.repo).length === 1 && callsTo(r.st, 'edit').length === 0, worktreePaths(w.repo).join(','))
}

// --------------------------------------------------------------------- a push whose answer was lost
console.log('\nthe push fails after origin already took the branch')
{
  // receive-pack updated the ref and the client still exited non-zero. Reading that as "nothing
  // was published" would delete the branch every other run scans for and hand the tag back on
  // top of it, so the executor asks origin what it holds before it undoes anything.
  const w = makeWorld('push-answer-lost')
  const branch = `feat/issue-${ISSUE}-${SLUG}`
  const st = freshState()
  let scans = 0
  // the paged pull request read is the last read of a scan, so arming here is invisible to the scan that just
  // finished. The second scan is the one that runs while the tag is held; the push comes after it.
  st.onPrScan = () => { if (scans++ === 1) writeHook(w.origin, 'pre-receive', PLANT_THEN_REFUSE) }
  const r = run(w, ['claim', String(ISSUE)], st)
  check('exits 4 with result unknown', r.code === 4 && r.json?.result === 'unknown', `exit ${r.code} ${r.stdout}`)
  check('naming the push as the step that failed', r.json?.reason === 'push', String(r.json?.reason))
  check('at phase published, because the branch did reach origin', r.json?.phase === 'published', String(r.json?.phase))
  check('retaining all four artifacts', ['claim-tag', 'worktree', 'local-branch', 'remote-branch'].every((a) => (r.json?.retained ?? []).includes(a)), JSON.stringify(r.json?.retained))
  check('origin holds the branch at the head this run pushed', refSha(w.origin, `refs/heads/${branch}`) === w.mainSha, String(refSha(w.origin, `refs/heads/${branch}`)))
  check('the claim tag was NOT given back', refSha(w.origin, TAG_REF) === w.mainSha, String(refSha(w.origin, TAG_REF)))
  check('the worktree is left in place', existsSync(w.pathFor(SLUG)) && worktreePaths(w.repo).includes(w.pathFor(SLUG)), worktreePaths(w.repo).join(','))
  check('and so is the local branch', refSha(w.repo, `refs/heads/${branch}`) === w.mainSha, String(refSha(w.repo, `refs/heads/${branch}`)))
  check('the issue was not touched', callsTo(r.st, 'edit').length === 0, 'an edit went out')
  check('the human is told not to re-run it', /do not re-run the claim/.test(r.stderr), JSON.stringify(r.stderr))
}

// ------------------------------------------------------------------------ a cleanup that failed
console.log('\nthe claim tag cannot be given back')
{
  // A refusal has to mean nothing of this run is left anywhere. Here the second scan says stand
  // down and origin refuses the tag delete, so the honest answer is an unknown that names the tag.
  const w = makeWorld('abandon-refused-rescan')
  writeHook(w.origin, 'pre-receive', REFUSE_DELETES)
  const rival = `refs/heads/fix/issue-${ISSUE}-a-rival-run`
  const st = freshState()
  let scans = 0
  st.onPrScan = () => { if (scans++ === 0) git(w.origin, 'update-ref', rival, w.mainSha) }
  const r = run(w, ['claim', String(ISSUE)], st)
  check('the stand-down is reported as unknown, not as a clean refusal', r.code === 4 && r.json?.result === 'unknown', `exit ${r.code} ${r.stdout}`)
  check('the reason is still the live run it found', r.json?.reason === 'live-run', String(r.json?.reason))
  check('at phase acquired, retaining the claim tag', r.json?.phase === 'acquired' && JSON.stringify(r.json?.retained) === JSON.stringify(['claim-tag']), r.stdout)
  check('and naming the cleanup step that would not go', r.json?.cleanup === 'abandon' && r.json?.abandon !== 'abandoned', `${r.json?.cleanup} ${r.json?.abandon}`)
  check('the tag really is still on origin', refSha(w.origin, TAG_REF) === w.mainSha, String(refSha(w.origin, TAG_REF)))
  check('the stderr names where the tag is', r.stderr.includes(TAG_REF), JSON.stringify(r.stderr))
  check('this run published nothing', refSha(w.origin, `refs/heads/feat/issue-${ISSUE}-${SLUG}`) === null && worktreePaths(w.repo).length === 1, 'something was published')
}
{
  // Same rule one step further in: the worktree add fails and the tag cannot go back either.
  const w = makeWorld('abandon-refused-worktree-add')
  writeHook(w.origin, 'pre-receive', REFUSE_DELETES)
  writeHook(w.gitDir, 'post-checkout', FAIL_FIRST_CHECKOUT)
  const r = run(w, ['claim', String(ISSUE)])
  check('a worktree-add failure with a stuck tag is an unknown', r.code === 4 && r.json?.result === 'unknown', `exit ${r.code} ${r.stdout}`)
  check('the reason is still worktree-add', r.json?.reason === 'worktree-add', String(r.json?.reason))
  check('the retained list is the claim tag alone', JSON.stringify(r.json?.retained) === JSON.stringify(['claim-tag']), JSON.stringify(r.json?.retained))
  check('the local parts of the cleanup did go through',
    refSha(w.repo, `refs/heads/feat/issue-${ISSUE}-${SLUG}`) === null && !existsSync(w.pathFor(SLUG)), 'something local was left behind')
  check('and the tag is on origin, as the answer says', refSha(w.origin, TAG_REF) === w.mainSha, String(refSha(w.origin, TAG_REF)))
}

// --------------------------------------------------------- what a worktree-add refusal is worth
console.log('\nwhat a failed worktree add tells the caller')
{
  // `git worktree add` prints `Preparing worktree ...` to stderr before it fails, so a detail
  // built from the first line names nothing. The branch here is planted between the second scan
  // and the add, at an object this run did not create it at, so the guarded delete leaves it
  // alone and says so.
  const w = makeWorld('worktree-add-detail')
  const branch = `feat/issue-${ISSUE}-${SLUG}`
  const other = git(w.repo, 'commit-tree', '-m', 'not this run\'s object', '-p', w.mainSha, `${w.mainSha}^{tree}`)
  const st = freshState()
  let scans = 0
  st.onPrScan = () => { if (scans++ === 1) git(w.repo, 'update-ref', `refs/heads/${branch}`, other) }
  const r = run(w, ['claim', String(ISSUE)], st)
  check('the detail carries git\'s fatal line, not its progress line',
    /fatal: a branch named/.test(String(r.json?.detail)) && !String(r.json?.detail).includes('Preparing worktree'), String(r.json?.detail))
  check('a branch this run did not create is left alone', refSha(w.repo, `refs/heads/${branch}`) === other, String(refSha(w.repo, `refs/heads/${branch}`)))
  check('so the result is an unknown that retains it', r.code === 4 && r.json?.result === 'unknown' && (r.json?.retained ?? []).includes('local-branch'), `exit ${r.code} ${r.stdout}`)
  check('naming the delete as the step that did not confirm', String(r.json?.cleanup).includes('local-branch-delete'), String(r.json?.cleanup))
  check('the claim tag still went back', r.json?.abandon === 'abandoned' && refSha(w.origin, TAG_REF) === null, `${r.json?.abandon} ${refSha(w.origin, TAG_REF)}`)
}

// ------------------------------------------------------- the tag push whose answer was lost
console.log('\nthe tag lands on origin and the push still fails')
{
  // The hook is armed before the run starts, so it fires on the claim tag rather than on the
  // branch: origin ends up holding refs/tags/flow-claim-issue-7 and the acquire is told its push
  // failed. Its re-read finds the tag and cannot say whose it is, because both racers push the
  // same object. Reporting that as a clean hold would tell the stage this run left nothing while
  // its own tag sits on origin refusing every later claim on the issue.
  const w = makeWorld('acquire-answer-lost')
  writeHook(w.origin, 'pre-receive', PLANT_THEN_REFUSE)
  const r = run(w, ['claim', String(ISSUE)])
  check('exits 4 with result unknown, not 3 with a clean hold', r.code === 4 && r.json?.result === 'unknown', `exit ${r.code} ${r.stdout}`)
  check('the reason separates it from a rival\'s tag', r.json?.reason === 'acquire-ambiguous', String(r.json?.reason))
  check('at phase acquired, retaining the claim tag',
    r.json?.phase === 'acquired' && JSON.stringify(r.json?.retained) === JSON.stringify(['claim-tag']), r.stdout)
  check('the tag really is on origin, at the object the acquire pushed', refSha(w.origin, TAG_REF) === w.mainSha, String(refSha(w.origin, TAG_REF)))
  check('the stderr names where it is', r.stderr.includes(TAG_REF), JSON.stringify(r.stderr))
  check('this run published no branch and added no worktree',
    refSha(w.origin, `refs/heads/feat/issue-${ISSUE}-${SLUG}`) === null && worktreePaths(w.repo).length === 1, 'something was published')
  check('the issue was not touched', callsTo(r.st, 'edit').length === 0, 'an edit went out')
}

// ----------------------------------------------------- an acquire that fails before it pushes
console.log('\nthe acquire cannot read origin at all')
{
  // Origin's URL in the clone is broken from the fake gh's pull request read, which is the last read of
  // the scan, so the scan finishes against the real remote and the acquire fails on its first
  // read, refs/heads/main, having pushed nothing. Every acquire failure used to come back as a
  // tag that may exist, which sends an issue to manual recovery over a remote that was briefly
  // unreachable.
  const w = makeWorld('acquire-unreadable')
  const st = freshState()
  st.onPrScan = () => { git(w.repo, 'remote', 'set-url', 'origin', join(w.dir, 'no-such-origin.git')) }
  const r = run(w, ['claim', String(ISSUE)], st)
  check('exits 4 with result unknown', r.code === 4 && r.json?.result === 'unknown', `exit ${r.code} ${r.stdout}`)
  check('naming the acquire as the step that failed', r.json?.reason === 'acquire-unknown', String(r.json?.reason))
  check('at phase pre-acquire, because no push was ever attempted',
    r.json?.phase === 'pre-acquire' && JSON.stringify(r.json?.retained) === '[]', r.stdout)
  check('with no cleanup step to report', r.json?.cleanup === null, String(r.json?.cleanup))
  check('and the human is not sent looking for a tag', /Nothing of this run is left anywhere/.test(r.stderr), JSON.stringify(r.stderr))
  check('origin holds no claim tag', refSha(w.origin, TAG_REF) === null, String(refSha(w.origin, TAG_REF)))
  check('no branch, no worktree, no issue edit',
    refSha(w.origin, `refs/heads/feat/issue-${ISSUE}-${SLUG}`) === null && worktreePaths(w.repo).length === 1 && callsTo(r.st, 'edit').length === 0,
    'something was mutated')
}

// --------------------------------------------------------- the boundary a worktree stays inside
console.log('\nthe git directory is a symlink out of the parent')
{
  // The check used to be lexical. `git rev-parse --git-common-dir` answers `.git` for an ordinary
  // clone, and a `.git` that is a symlink to a directory outside the parent resolves to a path
  // inside it, so the comparison passed and `git worktree add` then wrote its registration, and
  // the new branch, through the link and out of bounds.
  const w = makeWorld('outside-common-dir')
  const outside = join(tmp, 'outside-git-of-outside-common-dir')
  mkdirSync(outside)
  const moved = join(outside, 'repo.git')
  renameSync(join(w.repo, '.git'), moved)
  symlinkSync(moved, join(w.repo, '.git'))
  const before = allRefs(w.origin)
  const r = run(w, ['claim', String(ISSUE)])
  check('refuses with outside-parent', r.code === 2 && r.json?.reason === 'outside-parent', `exit ${r.code} ${r.stdout}`)
  check('at phase pre-acquire, with nothing retained', r.json?.phase === 'pre-acquire' && JSON.stringify(r.json?.retained) === '[]', r.stdout)
  check('and names the real git directory it resolved to', String(r.json?.detail).includes(moved), String(r.json?.detail))
  check('origin is unchanged and no claim tag was taken', allRefs(w.origin) === before && refSha(w.origin, TAG_REF) === null, allRefs(w.origin))
  check('nothing was registered through the link', !existsSync(join(moved, 'worktrees')), join(moved, 'worktrees'))
  check('no worktree was created beside the repository', !existsSync(w.pathFor(SLUG)), w.pathFor(SLUG))
  check('no branch was created in the clone', refSha(w.repo, `refs/heads/feat/issue-${ISSUE}-${SLUG}`) === null, 'a branch was created')
  check('the issue was not touched', callsTo(r.st, 'edit').length === 0, 'an edit went out')
}
{
  // The other half of the same rule: canonicalizing has to refuse only what actually leaves the
  // parent. This link points at a directory beside the repository, inside the boundary, and the
  // claim goes through with its worktree at the canonical sibling path.
  const w = makeWorld('inside-common-dir')
  const inside = join(w.dir, 'gitdirs')
  mkdirSync(inside)
  const moved = join(inside, 'repo.git')
  renameSync(join(w.repo, '.git'), moved)
  symlinkSync(moved, join(w.repo, '.git'))
  const r = run(w, ['claim', String(ISSUE)])
  check('a git directory symlinked to somewhere inside the parent still claims', r.code === 0 && r.json?.result === 'claimed', `exit ${r.code} ${r.stdout}`)
  check('and the worktree is the canonical sibling of the repository',
    r.json?.worktree === w.pathFor(SLUG) && existsSync(w.pathFor(SLUG)), String(r.json?.worktree))
}

// ------------------------------------------------- the issue changes while the tag is held
console.log('\nthe issue changes between the first read and the claim')
for (const [label, mutate, reason] of [
  ['a human closes it', (issue) => ({ ...issue, state: 'CLOSED' }), 'issue-closed'],
  ['a human blocks it', (issue) => ({ ...issue, labels: [{ name: 'ready-for-agent' }, { name: 'needs-human' }] }), 'blocked'],
  ['a human pulls the ready label', (issue) => ({ ...issue, labels: [{ name: 'enhancement' }] }), 'not-ready'],
]) {
  // The read that authorized the run happens before the acquire. Without a second one under the
  // tag, this run pushed a branch, relabelled a closed or blocked issue and reported itself
  // claimed. Read 1 is the one taken while the tag is held, immediately before the worktree add.
  const w = makeWorld(`recheck-${reason}`)
  const st = freshState()
  st.viewAt = { 1: mutate(st.issue) }
  const r = run(w, ['claim', String(ISSUE)], st)
  check(`${label}: refuses with ${reason}`, r.code === 2 && r.json?.reason === reason, `exit ${r.code} ${r.stdout}`)
  check(`${label}: at phase acquired, with nothing retained`,
    r.json?.phase === 'acquired' && JSON.stringify(r.json?.retained) === '[]' && r.json?.cleanup === null, r.stdout)
  check(`${label}: the claim tag was given back`, r.json?.abandon === 'abandoned' && refSha(w.origin, TAG_REF) === null, `${r.json?.abandon} ${refSha(w.origin, TAG_REF)}`)
  check(`${label}: no worktree and no branch on origin`,
    !existsSync(w.pathFor(SLUG)) && worktreePaths(w.repo).length === 1 && refSha(w.origin, `refs/heads/feat/issue-${ISSUE}-${SLUG}`) === null, 'something was published')
  check(`${label}: the issue was read twice and never edited`,
    callsTo(r.st, 'view').length === 2 && callsTo(r.st, 'edit').length === 0, `${callsTo(r.st, 'view').length} reads`)
}

console.log('\nthe label move gh accepted and never made')
{
  // gh exiting 0 says the request was accepted, not that the issue reads the way the next run
  // needs it to. The branch is already on origin, so nothing here can be undone: the honest
  // answer keeps all four artifacts and tells a human to finish it by hand.
  const w = makeWorld('edit-unconfirmed')
  const branch = `feat/issue-${ISSUE}-${SLUG}`
  const r = run(w, ['claim', String(ISSUE)], freshState({ applyEdit: false }))
  check('exits 4 with result unknown', r.code === 4 && r.json?.result === 'unknown', `exit ${r.code} ${r.stdout}`)
  check('naming the confirmation as what did not hold', r.json?.reason === 'issue-edit-unconfirmed', String(r.json?.reason))
  check('at phase published, retaining all four artifacts',
    r.json?.phase === 'published' && ['claim-tag', 'worktree', 'local-branch', 'remote-branch'].every((a) => (r.json?.retained ?? []).includes(a)), r.stdout)
  check('the claim tag is kept', refSha(w.origin, TAG_REF) === w.mainSha, String(refSha(w.origin, TAG_REF)))
  check('the branch stays on origin', refSha(w.origin, `refs/heads/${branch}`) === w.mainSha, String(refSha(w.origin, `refs/heads/${branch}`)))
  check('the worktree is left in place', existsSync(w.pathFor(SLUG)) && worktreePaths(w.repo).includes(w.pathFor(SLUG)), worktreePaths(w.repo).join(','))
  check('the detail names the labels the issue actually reads back with', /ready-for-agent/.test(String(r.json?.detail)), String(r.json?.detail))
  check('the human is told not to re-run it', /do not re-run the claim/.test(r.stderr), JSON.stringify(r.stderr))
  check('the issue was read three times', callsTo(r.st, 'view').length === 3, `${callsTo(r.st, 'view').length} reads`)
}

// ------------------------------------------------------------------ a pull request from a fork
console.log('\nan open pull request from a fork')
{
  // A fork's head branch is in the fork, so no ref under refs/heads/* on origin advertises it and
  // the branch scan cannot see it. `gh pr list --limit 100` would also have dropped it on a busy
  // repository. The paged api read over the pulls endpoint is what catches it.
  const w = makeWorld('fork-pull-request')
  const st = freshState({
    prs: [{
      number: 42,
      head: { ref: `feat/issue-${ISSUE}-from-a-fork`, repo: { fork: true } },
      title: 'the fork run',
      html_url: 'https://github.com/someone/marketplace-plugins/pull/42',
    }],
  })
  const r = run(w, ['claim', String(ISSUE)], st)
  check('the scan refuses with live-run', r.code === 2 && r.json?.reason === 'live-run', `exit ${r.code} ${r.stdout}`)
  check('and names the pull request it found',
    (r.json?.found?.pullRequests ?? []).some((hit) => hit.number === 42 && hit.headRefName === `feat/issue-${ISSUE}-from-a-fork`), r.stdout)
  check('the hit carries the html url, not gh pr list\'s url field',
    String((r.json?.found?.pullRequests ?? [])[0]?.url).endsWith('/pull/42'), r.stdout)
  check('gh pr list was never called', r.st.calls.every((c) => !(c.args[0] === 'pr' && c.args[1] === 'list')), JSON.stringify(r.st.calls.map((c) => c.args.slice(0, 2).join(' '))))
  check('the scan walked the pages of the pulls endpoint of the repository origin names',
    apiCalls(r.st).length === 1 && apiCalls(r.st)[0].args.includes('--paginate') &&
    apiCalls(r.st)[0].args[apiCalls(r.st)[0].args.length - 1] === `repos/${w.name}/origin/pulls?state=open&per_page=100`,
    JSON.stringify(apiCalls(r.st).map((c) => c.args)))
  check('no claim tag, no worktree, no issue edit',
    refSha(w.origin, TAG_REF) === null && worktreePaths(w.repo).length === 1 && callsTo(r.st, 'edit').length === 0, 'something was mutated')
}

// ----------------------------------------------------------------- gh is pinned to one repository
console.log('\nevery gh call names the repository origin points at')
{
  // gh resolves a default repository of its own from remote.<name>.gh-resolved or, with several
  // GitHub remotes, from a preference in which upstream beats origin. On a fork clone an unpinned
  // call reads and labels the upstream issue while the tag and the branch land on origin.
  const w = makeHostWorld('pinned-gh')
  const r = runOverSsh(w, ['claim', String(ISSUE)])
  check('the claim goes through against a host-qualified origin', r.code === 0 && r.json?.result === 'claimed', `exit ${r.code} ${r.stdout} ${r.stderr}`)
  const issueCalls = r.st.calls.filter((c) => c.args[0] === 'issue')
  check('all four issue calls carry --repo github.com/jakub/demo',
    issueCalls.length === 4 && issueCalls.every((c) => c.args[c.args.indexOf('--repo') + 1] === 'github.com/jakub/demo'),
    JSON.stringify(issueCalls.map((c) => c.args)))
  check('and the api read is pinned by its endpoint and --hostname, since gh api takes no --repo',
    apiCalls(r.st).length === 2 && apiCalls(r.st).every((c) =>
      c.args[c.args.indexOf('--hostname') + 1] === 'github.com' &&
      c.args[c.args.length - 1] === 'repos/jakub/demo/pulls?state=open&per_page=100'),
    JSON.stringify(apiCalls(r.st).map((c) => c.args)))
  check('the branch really is on the origin the pin names', refSha(w.origin, `refs/heads/feat/issue-${ISSUE}-${SLUG}`) === w.mainSha, String(refSha(w.origin, `refs/heads/feat/issue-${ISSUE}-${SLUG}`)))
}
{
  // A remote with a query string cannot be parsed into an owner and a repository without
  // guessing, and guessing is how an API path gets built out of one. Nothing of the URL is
  // echoed back.
  const w = makeWorld('origin-with-a-query')
  git(w.repo, 'remote', 'set-url', 'origin', 'https://github.com/jakub/demo.git?redirect=elsewhere')
  const r = run(w, ['claim', String(ISSUE)])
  check('a remote carrying a query string refuses with origin-unparseable', r.code === 2 && r.json?.reason === 'origin-unparseable', `exit ${r.code} ${r.stdout}`)
  check('nothing of the remote is echoed back', !r.stdout.includes('redirect=elsewhere') && !r.stderr.includes('redirect=elsewhere'), `${r.stdout} ${r.stderr}`)
  check('and gh was never called at all', r.st.calls.length === 0, JSON.stringify(r.st.calls.map((c) => c.args)))
}

// ------------------------------------------------------------ a remote that refuses the tag
console.log('\norigin will not have a claim tag created on it')
{
  // Protected tags. The push fails and the re-read positively finds no tag, which is a different
  // answer from the ambiguous one above it: there is nothing to retain and nothing to unwind.
  const w = makeWorld('tags-protected')
  writeHook(w.origin, 'pre-receive', REFUSE_TAGS)
  const r = run(w, ['claim', String(ISSUE)])
  check('exits 4 with result unknown', r.code === 4 && r.json?.result === 'unknown', `exit ${r.code} ${r.stdout}`)
  check('naming the remote as what refused it', r.json?.reason === 'acquire-refused-by-remote', String(r.json?.reason))
  check('at phase pre-acquire, with nothing retained and no cleanup',
    r.json?.phase === 'pre-acquire' && JSON.stringify(r.json?.retained) === '[]' && r.json?.cleanup === null, r.stdout)
  check('origin really holds no tag', refSha(w.origin, TAG_REF) === null, String(refSha(w.origin, TAG_REF)))
  check('and the human is not sent hunting one', /Nothing of this run is left anywhere/.test(r.stderr), JSON.stringify(r.stderr))
  check('no branch, no worktree, no issue edit',
    refSha(w.origin, `refs/heads/feat/issue-${ISSUE}-${SLUG}`) === null && worktreePaths(w.repo).length === 1 && callsTo(r.st, 'edit').length === 0,
    'something was mutated')
}

// ------------------------------------------------------ a rival branch under this run's name
console.log('\na rival takes the branch name before this run can push it')
{
  // The push is refused because origin already holds that branch at another object. This run
  // published nothing, and the branch is not its to take away: it belongs under found, where the
  // caller reads what the scans saw, and never under retained, which is the list a human is told
  // to clear by hand.
  const w = makeWorld('push-rival-branch')
  const branch = `feat/issue-${ISSUE}-${SLUG}`
  const other = git(w.repo, 'commit-tree', '-m', 'a rival run\'s work', '-p', w.mainSha, `${w.mainSha}^{tree}`)
  const st = freshState()
  let scans = 0
  // The paged pull request read is the last read of a scan, so planting here is invisible to the
  // scan that just finished. The push comes after the second one.
  st.onPrScan = () => { if (scans++ === 1) tryGit(w.repo, 'push', 'origin', `${other}:refs/heads/${branch}`) }
  const r = run(w, ['claim', String(ISSUE)], st)
  check('exits 4 with result unknown', r.code === 4 && r.json?.result === 'unknown', `exit ${r.code} ${r.stdout}`)
  check('naming the push as the step that failed', r.json?.reason === 'push', String(r.json?.reason))
  check('the rival branch is reported under found.remoteBranches, with its object',
    (r.json?.found?.remoteBranches ?? []).some((hit) => hit.ref === `refs/heads/${branch}` && hit.sha === other), r.stdout)
  check('and never under retained, which is the list a human is told to clear',
    !(r.json?.retained ?? []).includes('remote-branch'), JSON.stringify(r.json?.retained))
  check('the stderr says the branch is not this run\'s to touch', /not this run's to touch/.test(r.stderr), JSON.stringify(r.stderr))
  check('the rival branch is left exactly where it was', refSha(w.origin, `refs/heads/${branch}`) === other, String(refSha(w.origin, `refs/heads/${branch}`)))
  check('this run\'s own worktree and branch are gone', !existsSync(w.pathFor(SLUG)) && refSha(w.repo, `refs/heads/${branch}`) === null, worktreePaths(w.repo).join(','))
  check('and the claim tag went back', r.json?.abandon === 'abandoned' && refSha(w.origin, TAG_REF) === null, `${r.json?.abandon} ${refSha(w.origin, TAG_REF)}`)
  check('the issue was not touched', callsTo(r.st, 'edit').length === 0, 'an edit went out')
}

// ------------------------------------------------------- a heading with nothing underneath it
console.log('\nan acceptance criteria heading with nothing under it')
{
  // A heading and no criteria gives a run nothing to be judged against, which is the same
  // position as an issue with no heading at all.
  // A world each, because a run that wrongly claims one of these bodies leaves a branch the next
  // one would refuse over, and that is not the answer under test.
  const atEndWorld = makeWorld('empty-criteria-at-end')
  const beforeAtEnd = allRefs(atEndWorld.origin)
  const atEnd = run(atEndWorld, ['claim', String(ISSUE)], freshState({ issue: { body: 'Two runs on one issue is the failure this closes.\n\n## Acceptance Criteria\n' } }))
  check('a heading at the end of the body refuses', atEnd.code === 2 && atEnd.json?.reason === 'no-acceptance-criteria', `exit ${atEnd.code} ${atEnd.stdout}`)

  const nextWorld = makeWorld('empty-criteria-next-heading')
  const beforeNext = allRefs(nextWorld.origin)
  const nextHeading = run(nextWorld, ['claim', String(ISSUE)], freshState({ issue: { body: 'Intro.\n\n## Acceptance Criteria\n\n## Notes\n\nThe criteria never got written.\n' } }))
  check('a heading followed straight by the next one refuses too', nextHeading.code === 2 && nextHeading.json?.reason === 'no-acceptance-criteria', `exit ${nextHeading.code} ${nextHeading.stdout}`)
  check('neither of them touched its origin',
    allRefs(atEndWorld.origin) === beforeAtEnd && allRefs(nextWorld.origin) === beforeNext &&
    refSha(atEndWorld.origin, TAG_REF) === null && refSha(nextWorld.origin, TAG_REF) === null,
    `${allRefs(atEndWorld.origin)} | ${allRefs(nextWorld.origin)}`)
  check('and neither edited the issue', callsTo(atEnd.st, 'edit').length === 0 && callsTo(nextHeading.st, 'edit').length === 0, 'an edit went out')
}

rmSync(tmp, { recursive: true, force: true })

console.log(bad === 0 ? `\nissue claim verb: ALL PASS (${checks} checks)` : `\nissue claim verb: ${bad} FAILURE(S) of ${checks} checks`)
process.exit(bad === 0 ? 0 : 1)
