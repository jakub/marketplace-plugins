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
// injects one: a plain function across the module boundary, answering `issue view`, `pr list` and
// `issue edit` from a per-case state object and recording every call it was handed. No
// environment variable selects it, and nothing here needs a network or a GitHub account.
//
// The two live-run cases are the ones worth reading. The first plants a rival branch on origin
// before the run starts, which the pre-scan sees, and the assertion is that no claim tag was ever
// created. The second plants the rival between the first scan and the acquire, using the fake
// gh's `pr list` call as the hook: `pr list` is the last read of a scan, so a branch planted
// there is invisible to the scan that just finished and visible to the one that runs while the
// tag is held. That is the delayed contender the second scan exists for, and the assertions are
// that the run stood down, gave the tag back, and left no worktree.
//
// The ordering rule the verb rests on gets its own case: gh's `issue edit` fails after the branch
// is already on origin. That must not abandon the tag, because the branch is now the marker every
// other run scans for and a claim that reads as never-taken would be a lie. The run exits 4 with
// the branch and the tag both still there for a human.
//
// Run: node plugins/flow/scripts/smoke-issue-claim-verb.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  const world = { name, dir, origin, repo, mainSha: git(repo, 'rev-parse', 'HEAD') }
  world.pathFor = (slug) => join(dir, `repo-issue-${ISSUE}-${slug}`)
  return world
}

// ------------------------------------------------------------------- the fake gh, in process
const freshState = (overrides = {}) => ({
  viewExit: 0,
  editExit: 0,
  prs: [],
  onPrList: null,
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

const makeRunGh = (st) => (args, options) => {
  st.calls.push({ args, cwd: options?.cwd })
  if (args[0] === 'issue' && args[1] === 'view') {
    if (st.viewExit) return { code: st.viewExit, stdout: '', stderr: 'fake gh: issue view failed\n' }
    return { code: 0, stdout: JSON.stringify(st.issue), stderr: '' }
  }
  if (args[0] === 'pr' && args[1] === 'list') {
    if (st.onPrList) st.onPrList()
    return { code: 0, stdout: JSON.stringify(st.prs), stderr: '' }
  }
  if (args[0] === 'issue' && args[1] === 'edit') {
    if (st.editExit) return { code: st.editExit, stdout: '', stderr: 'fake gh: issue edit failed\n' }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { code: 3, stdout: '', stderr: `fake gh: unexpected ${args.join(' ')}\n` }
}

const callsTo = (st, verb) => st.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === verb)

const run = (world, args, st = freshState()) => {
  const result = issueClaim({ argv: args, cwd: world.repo, runGh: makeRunGh(st) })
  let json = null
  try { json = JSON.parse(result.stdout) } catch {}
  return { ...result, json, st }
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
  // `pr list` is the last read of a scan, so planting there is invisible to the scan that just
  // finished and visible to the one that runs under the tag.
  const w = makeWorld('live-rescan')
  const rival = `refs/heads/fix/issue-${ISSUE}-a-rival-run`
  let seen = 0
  const st = freshState()
  st.onPrList = () => { if (seen++ === 0) git(w.origin, 'update-ref', rival, w.mainSha) }
  const r = run(w, ['claim', String(ISSUE)], st)
  check('the second scan catches it and refuses with live-run', r.code === 2 && r.json?.reason === 'live-run', `exit ${r.code} ${r.stdout}`)
  check('the scan ran twice', seen === 2, `${seen} pr list calls`)
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

rmSync(tmp, { recursive: true, force: true })

console.log(bad === 0 ? `\nissue claim verb: ALL PASS (${checks} checks)` : `\nissue claim verb: ${bad} FAILURE(S) of ${checks} checks`)
process.exit(bad === 0 ? 0 : 1)
