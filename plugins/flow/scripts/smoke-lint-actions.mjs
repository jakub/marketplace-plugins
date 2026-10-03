#!/usr/bin/env node
// Smoke for scripts/lint-actions.mjs, the nightly lint's survey and its only mutations, run as a
// child process the way the cron job runs it.
//
// Git is real: each world is a bare origin at git@github.com:jakub/demo.git, reached through a
// GIT_SSH_COMMAND shim that serves it from disk, and a clone that is a direct child of the
// FLOW_WORKSPACE the executor is bound to. GitHub is a fake `gh` first on PATH that answers from a
// JSON state file, records every call, and fails any call not pinned to github.com/jakub/demo or
// made with GH_REPO or GH_HOST in its environment, so a case that passes proved the pin.
//
// Run: node plugins/flow/scripts/smoke-lint-actions.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXECUTOR = join(dirname(fileURLToPath(import.meta.url)), 'lint-actions.mjs')
const HOUR = 3_600_000
const OLD = new Date(Date.now() - 10 * 24 * HOUR)
let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad += 1
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` -> ${detail}`}`)
}

const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_GH_STATE
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
const argv = process.argv.slice(2)
st.calls.push(argv)
const save = () => fs.writeFileSync(file, JSON.stringify(st))
const out = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); save(); process.exit(0) }
const fail = (m) => { process.stderr.write('fake gh: ' + m + '\\n'); st.unpinned = (st.unpinned || 0) + 1; save(); process.exit(1) }
if (process.env.GH_REPO || process.env.GH_HOST) fail('GH_REPO or GH_HOST reached gh')
const at = (flag) => argv[argv.indexOf(flag) + 1]
const [group, verb] = argv
const originGit = (...a) => require('node:child_process').execFileSync('git', ['--git-dir', st.origin, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const claimTag = () => { try { return originGit('rev-parse', '--verify', '--quiet', 'refs/tags/flow-claim-issue-7') } catch { return null } }
if (group === 'api') {
  const path = argv[argv.length - 1]
  if (at('--hostname') !== 'github.com' || !path.startsWith('repos/jakub/demo/')) fail('api off the pin: ' + argv.join(' '))
  if (path.startsWith('repos/jakub/demo/pulls?state=open')) {
    // An issue run that takes the claim tag while the lint is still scanning.
    if (st.claimDuringScan) { originGit('update-ref', 'refs/tags/flow-claim-issue-7', originGit('rev-parse', 'refs/heads/main')); delete st.claimDuringScan }
    out([st.openPrs])
  }
  if (path.startsWith('repos/jakub/demo/issues?')) out([st.issues])
  if (path.startsWith('repos/jakub/demo/labels?')) out([st.labels])
  if (path.startsWith('repos/jakub/demo/actions/runs?')) out({ workflow_runs: st.runs.map((r) => ({ id: r.id })) })
  const m = path.match(/actions\\/runs\\/(\\d+)\\/jobs/)
  if (m) out([{ jobs: st.runs.find((r) => String(r.id) === m[1]).jobs }])
  fail('unexpected api ' + path)
}
if (at('--repo') !== 'github.com/jakub/demo' && !(group === 'repo' && argv[2] === 'github.com/jakub/demo')) fail('unpinned: ' + argv.join(' '))
if (group === 'repo') out({ defaultBranchRef: { name: st.defaultBranch } })
if (group === 'pr' && verb === 'list') {
  // A git command that lands while the executor is still reading GitHub: a worktree that checks
  // the branch out, or a push that moves the branch on origin.
  if (st.checkoutDuringRead) { require('node:child_process').execFileSync('git', st.checkoutDuringRead, { stdio: 'ignore' }); delete st.checkoutDuringRead }
  // Each pull request carries only the fields asked for, the way gh answers, so a field the
  // executor forgets to request reads as missing here too.
  const fields = String(at('--json')).split(',')
  const project = (list) => list.slice(0, Number(at('--limit') ?? 30)).map((p) => Object.fromEntries(fields.filter((f) => f in p).map((f) => [f, p[f]])))
  if (argv.includes('--base')) {
    // Open pull requests on a base, and one that opens on its Nth read.
    st.baseReads = { ...st.baseReads, [at('--base')]: (st.baseReads?.[at('--base')] ?? 0) + 1 }
    if (st.baseOnRead?.base === at('--base') && st.baseOnRead.read === st.baseReads[at('--base')]) (st.basePrs[at('--base')] ||= []).push(st.baseOnRead.pr)
    out(project((st.basePrs || {})[at('--base')] || []))
  }
  // A pull request opened on a branch at its Nth read, as if between the executor's reads.
  st.prReads = { ...st.prReads, [at('--head')]: (st.prReads?.[at('--head')] ?? 0) + 1 }
  if (st.openOnRead?.head === at('--head') && st.openOnRead.read === st.prReads[at('--head')]) (st.prs[at('--head')] ||= []).push(st.openOnRead.pr)
  out(project(st.prs[at('--head')] || []))
}
if (group === 'issue' && verb === 'view') out(st.issue)
if (group === 'issue' && verb === 'edit') {
  st.tagAtEdit = claimTag()
  if (st.applyEdit !== false) {
    const rm = argv.indexOf('--remove-label')
    st.issue.labels = st.issue.labels.filter((l) => rm < 0 || l.name !== argv[rm + 1]).concat({ name: at('--add-label') })
    if (st.alsoAdd) st.issue.labels.push({ name: st.alsoAdd })
  }
  // An edit that exits non-zero while the labels still move: whose edit moved them is unknown.
  if (st.editFails) { save(); process.stderr.write('fake gh: edit failed\\n'); process.exit(1) }
  out('')
}
if (group === 'issue' && verb === 'comment') { st.comments.push(at('--body')); out('') }
fail('unexpected ' + argv.join(' '))
`

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-lint-actions-')))
const baseEnv = { ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: join(tmp, 'none'), GIT_CONFIG_SYSTEM: join(tmp, 'none'), GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@example.invalid', GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@example.invalid' }
for (const key of ['GH_REPO', 'GH_HOST', 'FLOW_CRON_JOB', 'FLOW_WORKSPACE', 'FLOW_GH_HOSTS']) delete baseEnv[key]
let worlds = 0

/** A workspace holding one clone of a host-qualified origin served from disk, and a fake gh. */
const makeWorld = (state = {}, { branch = 'main' } = {}) => {
  const workspace = join(tmp, `ws-${worlds += 1}`)
  const base = join(workspace, '.base')
  const origin = join(base, 'jakub', 'demo.git')
  const repo = join(workspace, 'demo')
  const bin = join(workspace, '.bin')
  for (const d of [join(base, 'jakub'), bin]) mkdirSync(d, { recursive: true })
  const ssh = join(bin, 'ssh')
  writeFileSync(ssh, `#!/bin/sh\ncd ${base} || exit 1\nfor a; do last=$a; done\nexec /bin/sh -c "$last"\n`)
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  for (const f of [ssh, join(bin, 'gh')]) chmodSync(f, 0o755)
  const env = { ...baseEnv, GIT_SSH_COMMAND: ssh, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: join(workspace, '.gh.json'), FLOW_WORKSPACE: workspace }
  const oldEnv = { ...env, GIT_AUTHOR_DATE: OLD.toISOString(), GIT_COMMITTER_DATE: OLD.toISOString() }
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: oldEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  execFileSync('git', ['init', '-q', '--bare', '-b', branch, origin], { env })
  execFileSync('git', ['init', '-q', '-b', branch, repo], { env })
  mkdirSync(join(repo, '.github'))
  writeFileSync(join(repo, '.github', 'known-flakes.txt'), '# flaky\ne2e\nunit:test_x\ngone-check\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  git(repo, 'remote', 'add', 'origin', 'git@github.com:jakub/demo.git')
  git(repo, 'push', '-q', '-u', 'origin', branch)
  writeFileSync(env.FAKE_GH_STATE, JSON.stringify({
    calls: [], comments: [], prs: {}, basePrs: {}, openPrs: [], issues: [], labels: [], runs: [], origin, defaultBranch: branch,
    issue: { number: 7, state: 'OPEN', labels: [{ name: 'in-progress' }], updatedAt: new Date(Date.now() - 7 * HOUR).toISOString() }, ...state,
  }))
  return { workspace, origin, repo, env, git, tip: git(repo, 'rev-parse', 'HEAD') }
}
const run = (w, args, extra = {}) => {
  const r = spawnSync(process.execPath, [EXECUTOR, ...args], { encoding: 'utf8', env: { ...w.env, ...extra } })
  let json = null
  try { json = JSON.parse(r.stdout) } catch {}
  return { code: r.status, json, stderr: r.stderr, st: JSON.parse(readFileSync(w.env.FAKE_GH_STATE, 'utf8')) }
}
const edits = (r) => r.st.calls.filter((c) => c[0] === 'issue' && c[1] === 'edit')
const refused = (name, r, text) => check(`${name}: refused${text ? `, ${text}` : ''}`, r.code === 1 && r.json?.ok === false && (!text || r.json.reason.includes(text)), `${r.code} ${JSON.stringify(r.json)} ${r.stderr}`)
const relabel = (w, from, to, seen, reason = 'a_finding') => run(w, ['relabel', w.repo, '7', '--from', from, '--to', to, '--seen', seen, '--reason', reason])

console.log('relabel moves a label only through a fixed transition')
{
  const w = makeWorld()
  const seen = JSON.parse(readFileSync(w.env.FAKE_GH_STATE, 'utf8')).issue.updatedAt
  const r = relabel(w, 'in-progress', 'ready-for-agent', seen, 'no_branch_worktree_or_pull_request')
  check('an orphaned claim goes back to ready-for-agent, read back', r.code === 0 && r.json?.ok === true && r.st.issue.labels.map((l) => l.name).join() === 'ready-for-agent', `${JSON.stringify(r.json)} ${r.stderr}`)
  check('with one comment, underscores read as spaces', r.st.comments.length === 1 && r.st.comments[0].includes('no branch worktree or pull request'), JSON.stringify(r.st.comments))
  check('and no gh call off the pin', !r.st.unpinned, JSON.stringify(r.st.calls))
  check('the edit landed while the lint held the claim tag at origin\'s main', r.st.tagAtEdit === w.tip, String(r.st.tagAtEdit))
  check('and the tag was given back', spawnSync('git', ['--git-dir', w.origin, 'rev-parse', '--verify', '--quiet', 'refs/tags/flow-claim-issue-7']).status !== 0)
  const w2 = makeWorld()
  const ghRepo = run(w2, ['relabel', w2.repo, '7', '--from', 'in-progress', '--to', 'ready-for-agent', '--seen', JSON.parse(readFileSync(w2.env.FAKE_GH_STATE, 'utf8')).issue.updatedAt, '--reason', 'x'], { GH_REPO: 'someone/evil', GH_HOST: 'evil.example' })
  check('GH_REPO and GH_HOST in the environment never reach gh', ghRepo.code === 0 && !ghRepo.st.unpinned, `${JSON.stringify(ghRepo.json)} ${JSON.stringify(ghRepo.st.calls)}`)
}
{
  const fresh = () => { const w = makeWorld(); return { w, seen: JSON.parse(readFileSync(w.env.FAKE_GH_STATE, 'utf8')).issue.updatedAt } }
  let { w, seen } = fresh()
  refused('a moved updatedAt', relabel(w, 'in-progress', 'ready-for-agent', new Date(Date.parse(seen) - 60_000).toISOString()), 'moved since')
  ;({ w, seen } = fresh())
  refused('a wrong current label', relabel(w, 'ready-for-agent', 'needs-triage', seen), 'lifecycle labels')
  ;({ w, seen } = fresh())
  refused('a transition outside the table', relabel(w, 'in-progress', 'wontfix', seen), 'not a transition')
  const young = makeWorld({ issue: { number: 7, state: 'OPEN', labels: [{ name: 'in-progress' }], updatedAt: new Date(Date.now() - HOUR).toISOString() } })
  refused('an orphan younger than six hours', relabel(young, 'in-progress', 'ready-for-agent', JSON.parse(readFileSync(young.env.FAKE_GH_STATE, 'utf8')).issue.updatedAt), 'six hours')
  for (const [where, plant] of [
    ['a branch on origin', (x) => x.git(x.repo, 'push', '-q', 'origin', 'main:refs/heads/feat/issue-7-live')],
    ['a claim tag on origin', (x) => x.git(x.origin, 'update-ref', 'refs/tags/flow-claim-issue-7', x.tip)],
    ['a local branch', (x) => x.git(x.repo, 'branch', 'fix/issue-7-local')],
  ]) {
    ;({ w, seen } = fresh())
    plant(w)
    const r = relabel(w, 'in-progress', 'ready-for-agent', seen)
    refused(`a live run (${where})`, r, 'live')
    check(`a live run (${where}): no edit reached gh`, edits(r).length === 0, JSON.stringify(edits(r)))
  }
  ;({ w, seen } = fresh())
  const state = JSON.parse(readFileSync(w.env.FAKE_GH_STATE, 'utf8'))
  writeFileSync(w.env.FAKE_GH_STATE, JSON.stringify({ ...state, claimDuringScan: true }))
  const claimed = relabel(w, 'in-progress', 'ready-for-agent', seen)
  refused('a claim that takes the tag during the scan', claimed, 'live')
  check('a claim that takes the tag during the scan: no edit reached gh', edits(claimed).length === 0, JSON.stringify(edits(claimed)))
  check('and the claim\'s tag stays on origin', spawnSync('git', ['--git-dir', w.origin, 'rev-parse', '--verify', '--quiet', 'refs/tags/flow-claim-issue-7']).status === 0)
  const pr = makeWorld({ openPrs: [{ number: 42, head: { ref: 'feat/issue-7-from-a-fork' } }] })
  refused('a live run (an open pull request from a fork)', relabel(pr, 'in-progress', 'ready-for-agent', JSON.parse(readFileSync(pr.env.FAKE_GH_STATE, 'utf8')).issue.updatedAt), '#42')
  const raceWon = makeWorld({ editFails: true })
  const movedElsewhere = relabel(raceWon, 'in-progress', 'ready-for-agent', JSON.parse(readFileSync(raceWon.env.FAKE_GH_STATE, 'utf8')).issue.updatedAt)
  refused('a failed edit whose labels read back moved anyway', movedElsewhere, 'whose edit moved them is unknown')
  const inert = makeWorld({ applyEdit: false })
  refused('an edit that moved nothing', relabel(inert, 'in-progress', 'ready-for-agent', JSON.parse(readFileSync(inert.env.FAKE_GH_STATE, 'utf8')).issue.updatedAt), 'nothing moved')
  const raced = makeWorld({ alsoAdd: 'wontfix' })
  const r = relabel(raced, 'in-progress', 'ready-for-agent', JSON.parse(readFileSync(raced.env.FAKE_GH_STATE, 'utf8')).issue.updatedAt)
  refused('a conflicting read-back', r, 'nothing undone')
  check('a conflicting read-back is left as it is, with no second edit', edits(r).length === 1 && r.st.issue.labels.some((l) => l.name === 'wontfix'), JSON.stringify(r.st.issue))
  // Reads go to origin's fetch URL and pushes to its push URL, so a tag pushed to a second
  // repository would be a lock no claim reads, and the read-back would call it gone.
  ;({ w, seen } = fresh())
  const elsewhere = join(dirname(w.origin), 'other.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', elsewhere])
  w.git(w.repo, 'config', 'remote.origin.pushurl', 'git@github.com:jakub/other.git')
  w.git(w.repo, 'push', '-q', 'origin', 'main')
  const split = relabel(w, 'in-progress', 'ready-for-agent', seen)
  refused('an origin that pushes to another repository than it fetches from', split, 'not one URL')
  check('a split origin: no edit reached gh', edits(split).length === 0, JSON.stringify(edits(split)))
  const tagIn = (bare) => spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', 'refs/tags/flow-claim-issue-7']).status === 0
  check('a split origin: no claim tag in either repository', !tagIn(w.origin) && !tagIn(elsewhere))
}

console.log('\ndelete-branch needs a death warrant and a recoverable tip')
{
  const w = makeWorld()
  for (const name of ['main', 'flow-evidence']) refused(`the protected ${name}`, run(w, ['delete-branch', w.repo, name]), 'protected')
  w.git(w.repo, 'branch', 'feat/spike', w.git(w.repo, 'commit-tree', `${w.tip}^{tree}`, '-p', w.tip, '-m', 'a spike'))
  w.git(w.repo, 'push', '-q', 'origin', 'feat/spike')
  refused('a pushed branch with no pull request', run(w, ['delete-branch', w.repo, 'feat/spike']), 'not shown dead')
  w.git(w.repo, 'branch', 'feat/done')
  const state = JSON.parse(readFileSync(w.env.FAKE_GH_STATE, 'utf8'))
  state.prs['feat/done'] = [{ number: 5, state: 'MERGED', headRefOid: w.tip, isCrossRepository: false }]
  writeFileSync(w.env.FAKE_GH_STATE, JSON.stringify(state))
  const r = run(w, ['delete-branch', w.repo, 'feat/done'])
  check('a merged branch is deleted and reads back gone', r.code === 0 && spawnSync('git', ['-C', w.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/done']).status !== 0, JSON.stringify(r.json))
  // A branch with a full page of pull requests may have more: gh pr list stops at its limit.
  w.git(w.repo, 'branch', 'feat/busy')
  const busy = JSON.parse(readFileSync(w.env.FAKE_GH_STATE, 'utf8'))
  busy.prs['feat/busy'] = Array.from({ length: 1000 }, (_, i) => ({ number: 100 + i, state: 'MERGED', headRefOid: w.tip, isCrossRepository: false }))
  writeFileSync(w.env.FAKE_GH_STATE, JSON.stringify(busy))
  refused('a branch whose pull request list fills the limit', run(w, ['delete-branch', w.repo, 'feat/busy']), 'may be partial')
  check('and the busy branch still exists', spawnSync('git', ['-C', w.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/busy']).status === 0)
  // A branch name reused after its old pull request closed: the closed PR's head is the old tip,
  // the branch has moved on and origin holds the new tip. The old PR is no death warrant for it.
  w.git(w.repo, 'branch', 'feat/reused', w.git(w.repo, 'commit-tree', `${w.tip}^{tree}`, '-p', w.tip, '-m', 'new work'))
  w.git(w.repo, 'push', '-q', 'origin', 'feat/reused')
  const reused = JSON.parse(readFileSync(w.env.FAKE_GH_STATE, 'utf8'))
  reused.prs['feat/reused'] = [{ number: 9, state: 'CLOSED', headRefOid: w.tip, isCrossRepository: false }]
  writeFileSync(w.env.FAKE_GH_STATE, JSON.stringify(reused))
  refused('a reused branch whose closed pull request had another head', run(w, ['delete-branch', w.repo, 'feat/reused']), 'not shown dead')
  check('and the reused branch still exists', spawnSync('git', ['-C', w.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/reused']).status === 0)
  // The control: a closed pull request at the branch's own tip is a warrant, even for a tip outside
  // the default branch, so the refusal above comes from the head match and not from ancestry.
  w.git(w.repo, 'branch', 'feat/closed-here', w.git(w.repo, 'commit-tree', `${w.tip}^{tree}`, '-p', w.tip, '-m', 'closed work'))
  const closedHere = JSON.parse(readFileSync(w.env.FAKE_GH_STATE, 'utf8'))
  closedHere.prs['feat/closed-here'] = [{ number: 10, state: 'CLOSED', headRefOid: w.git(w.repo, 'rev-parse', 'feat/closed-here'), isCrossRepository: false }]
  writeFileSync(w.env.FAKE_GH_STATE, JSON.stringify(closedHere))
  const closedRun = run(w, ['delete-branch', w.repo, 'feat/closed-here'])
  check('a branch whose closed pull request has its tip as head is deleted and reads back gone',
    closedRun.code === 0 && spawnSync('git', ['-C', w.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/closed-here']).status !== 0, `${JSON.stringify(closedRun.json)} ${closedRun.stderr}`)
  w.git(w.repo, 'branch', 'feat/taken')
  const taken = JSON.parse(readFileSync(w.env.FAKE_GH_STATE, 'utf8'))
  taken.prs['feat/taken'] = [{ number: 6, state: 'MERGED', headRefOid: w.tip, isCrossRepository: false }]
  taken.checkoutDuringRead = ['-C', w.repo, 'worktree', 'add', '-q', join(w.workspace, 'taken'), 'feat/taken']
  writeFileSync(w.env.FAKE_GH_STATE, JSON.stringify(taken))
  refused('a branch checked out while GitHub was being read', run(w, ['delete-branch', w.repo, 'feat/taken']), 'checked out')
  check('and the checked-out branch still exists', spawnSync('git', ['-C', w.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/taken']).status === 0)
}

console.log('\ndelete-remote-branch deletes on origin only a tip shown dead, and only at that tip')
{
  const w = makeWorld()
  const onOrigin = (b, bare = w.origin) => spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { encoding: 'utf8' }).stdout.trim() || null
  const setState = (change) => { const st = JSON.parse(readFileSync(w.env.FAKE_GH_STATE, 'utf8')); change(st); writeFileSync(w.env.FAKE_GH_STATE, JSON.stringify(st)) }
  /** A new commit off main, pushed to origin as <branch> and to nothing else. */
  const pushWork = (branch, msg) => {
    const c = w.git(w.repo, 'commit-tree', `${w.tip}^{tree}`, '-p', w.tip, '-m', msg)
    w.git(w.repo, 'push', '-q', 'origin', `${c}:refs/heads/${branch}`)
    return c
  }
  const del = (b, x = w) => run(x, ['delete-remote-branch', x.repo, b])

  const merged = pushWork('feat/merged', 'merged work')
  setState((st) => { st.prs['feat/merged'] = [{ number: 5, state: 'MERGED', headRefOid: merged, isCrossRepository: false }] })
  const m = del('feat/merged')
  check('a branch whose merged pull request has its tip as head is deleted on origin and reads back gone',
    m.code === 0 && m.json?.reason?.includes('#5') && onOrigin('feat/merged') === null, `${JSON.stringify(m.json)} ${m.stderr}`)
  check('and no gh call off the pin', !m.st.unpinned, JSON.stringify(m.st.calls))

  // Ancestry is no warrant on origin: a release branch behind main, or a run branch claimed a
  // moment ago at main's tip, has its tip in main and is alive.
  w.git(w.repo, 'push', '-q', 'origin', `${w.tip}:refs/heads/feat/in-main`)
  refused('a branch whose tip is in origin/main, with no pull request', del('feat/in-main'), 'ancestry is no warrant')
  check('and it is still on origin', onOrigin('feat/in-main') === w.tip)
  const claimed = join(w.workspace, 'claimed')
  w.git(w.repo, 'worktree', 'add', '-q', claimed, '-b', 'feat/issue-7-just-claimed', w.tip)
  w.git(claimed, 'push', '-q', 'origin', 'feat/issue-7-just-claimed')
  refused('a just-claimed branch at main\'s tip with a worktree here', del('feat/issue-7-just-claimed'), 'the worktree')
  check('and the claimed branch is still on origin', onOrigin('feat/issue-7-just-claimed') === w.tip)
  // The hold, apart from the warrant: a merged pull request at the tip, and a local branch here.
  const kept = pushWork('feat/kept-here', 'merged, still checked out locally')
  w.git(w.repo, 'branch', 'feat/kept-here', kept)
  setState((st) => { st.prs['feat/kept-here'] = [{ number: 19, state: 'MERGED', headRefOid: kept, isCrossRepository: false }] })
  refused('a merged branch that a local branch here still holds', del('feat/kept-here'), 'the local branch feat/kept-here')
  check('and the held branch is still on origin', onOrigin('feat/kept-here') === kept)
  // A worktree that takes the branch while GitHub is being read: the hold is checked again before the push.
  const taken = pushWork('feat/taken-late', 'merged, then checked out here')
  setState((st) => {
    st.prs['feat/taken-late'] = [{ number: 20, state: 'MERGED', headRefOid: taken, isCrossRepository: false }]
    st.checkoutDuringRead = ['-C', w.repo, 'worktree', 'add', '-q', join(w.workspace, 'taken-late'), '-b', 'feat/taken-late', taken]
  })
  refused('a branch a worktree here took while it was being judged', del('feat/taken-late'), 'since it was judged')
  check('and the taken branch is still on origin', onOrigin('feat/taken-late') === taken)

  const open = pushWork('feat/open', 'open work')
  setState((st) => { st.prs['feat/open'] = [{ number: 11, state: 'MERGED', headRefOid: open, isCrossRepository: false }, { number: 12, state: 'OPEN', headRefOid: open, isCrossRepository: false }] })
  refused('a branch an open pull request heads, even beside a merged one at the same tip', del('feat/open'), '#12')
  check('and the open branch is still on origin', onOrigin('feat/open') === open)

  w.git(w.repo, 'push', '-q', 'origin', `${w.tip}:refs/heads/flow-evidence`)
  for (const name of ['main', 'flow-evidence']) refused(`the protected ${name}`, del(name), 'protected')
  check('and both protected branches are still on origin', onOrigin('main') === w.tip && onOrigin('flow-evidence') === w.tip)

  const spike = pushWork('feat/spike', 'a spike')
  refused('a pushed branch with no pull request and a tip outside main', del('feat/spike'), 'not shown dead')
  check('and the spike is still on origin', onOrigin('feat/spike') === spike)

  // Reused name: the closed pull request's head is an older tip, so it is no warrant for this one.
  const reused = pushWork('feat/reused', 'new work on an old name')
  setState((st) => { st.prs['feat/reused'] = [{ number: 9, state: 'CLOSED', headRefOid: merged, isCrossRepository: false }] })
  refused('a branch whose closed pull request closed at another tip', del('feat/reused'), 'not shown dead')
  check('and the reused branch is still on origin', onOrigin('feat/reused') === reused)

  // A fork's pull request from a branch of the same name, closed at this exact tip: gh pr list
  // --head lists it, and it is no warrant for the branch here, on origin or local.
  const forked = pushWork('feat/forked', 'live work a fork also proposed')
  setState((st) => { st.prs['feat/forked'] = [{ number: 14, state: 'CLOSED', headRefOid: forked, isCrossRepository: true }] })
  refused('a closed fork pull request at the exact tip, for delete-remote-branch', del('feat/forked'), 'not shown dead')
  w.git(w.repo, 'branch', 'feat/forked', forked)
  refused('a closed fork pull request at the exact tip, for delete-branch', run(w, ['delete-branch', w.repo, 'feat/forked']), 'not shown dead')
  check('and the branch is still on origin and here', onOrigin('feat/forked') === forked &&
    spawnSync('git', ['-C', w.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/forked']).status === 0)
  const forkOpen = pushWork('feat/fork-open', 'work a fork has open')
  setState((st) => { st.prs['feat/fork-open'] = [{ number: 15, state: 'MERGED', headRefOid: forkOpen, isCrossRepository: false }, { number: 16, state: 'OPEN', headRefOid: 'f'.repeat(40), isCrossRepository: true }] })
  refused('an open fork pull request of the same name still blocks', del('feat/fork-open'), '#16')

  refused('a branch origin does not have', del('feat/never-pushed'), 'does not exist on origin')
  refused('a name that is not a branch name', del('feat/a..b'), 'not a valid branch name')
  refused('origin\'s HEAD, which names main', del('HEAD'), 'not a valid branch name')

  // The race, for real: the branch is judged dead at its merged tip, and while the executor is still
  // reading GitHub someone pushes new work to it. Origin must reject the delete as stale.
  const raced = pushWork('feat/raced', 'merged, then reused')
  const newer = w.git(w.origin, 'commit-tree', `${w.tip}^{tree}`, '-p', raced, '-m', 'pushed after the judgment')
  setState((st) => {
    st.prs['feat/raced'] = [{ number: 13, state: 'MERGED', headRefOid: raced, isCrossRepository: false }]
    st.checkoutDuringRead = ['--git-dir', w.origin, 'update-ref', 'refs/heads/feat/raced', newer, raced]
  })
  const r = del('feat/raced')
  refused('a branch pushed to between the judgment and the delete', r, 'origin refused the delete')
  check('and origin keeps the new work the lease protected', onOrigin('feat/raced') === newer, String(onOrigin('feat/raced')))

  // A pull request opened after the judgment's read and before the push: the lease cannot see it,
  // the uncached re-read straight before the push does.
  const late = pushWork('feat/late', 'merged, then proposed again')
  setState((st) => {
    st.prs['feat/late'] = [{ number: 17, state: 'MERGED', headRefOid: late, isCrossRepository: false }]
    st.openOnRead = { head: 'feat/late', read: 2, pr: { number: 18, state: 'OPEN', headRefOid: late, isCrossRepository: false } }
  })
  const lateRun = del('feat/late')
  refused('a pull request opened between the judgment and the push', lateRun, '#18')
  check('and the branch is still on origin, after two reads of its pull requests', onOrigin('feat/late') === late && lateRun.st.prReads['feat/late'] === 2, JSON.stringify(lateRun.st.prReads))

  // A merged branch that open pull requests still use as their base: deleting it would close them.
  const parent = pushWork('feat/parent', 'merged, with a child stacked on it')
  setState((st) => { st.prs['feat/parent'] = [{ number: 21, state: 'MERGED', headRefOid: parent, isCrossRepository: false }]; st.basePrs['feat/parent'] = [{ number: 22 }] })
  refused('a branch an open pull request uses as its base', del('feat/parent'), '#22')
  check('and the parent is still on origin', onOrigin('feat/parent') === parent)
  // A child opened on the branch between the judgment and the push.
  const lateParent = pushWork('feat/late-parent', 'merged, then stacked on')
  setState((st) => {
    st.prs['feat/late-parent'] = [{ number: 23, state: 'MERGED', headRefOid: lateParent, isCrossRepository: false }]
    st.baseOnRead = { base: 'feat/late-parent', read: 2, pr: { number: 24 } }
  })
  const lateBase = del('feat/late-parent')
  refused('a pull request based on the branch, opened between the judgment and the push', lateBase, '#24')
  check('and the late parent is still on origin, after two reads of its children', onOrigin('feat/late-parent') === lateParent && lateBase.st.baseReads['feat/late-parent'] === 2, JSON.stringify(lateBase.st.baseReads))

  // Reads go to origin's fetch URL and pushes to its push URL: a delete there would never read back.
  const split = makeWorld()
  const gone = split.git(split.repo, 'commit-tree', `${split.tip}^{tree}`, '-p', split.tip, '-m', 'merged')
  split.git(split.repo, 'push', '-q', 'origin', `${gone}:refs/heads/feat/merged`)
  const other = join(dirname(split.origin), 'other.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', other])
  split.git(split.repo, 'config', 'remote.origin.pushurl', 'git@github.com:jakub/other.git')
  const st = JSON.parse(readFileSync(split.env.FAKE_GH_STATE, 'utf8'))
  st.prs['feat/merged'] = [{ number: 5, state: 'MERGED', headRefOid: gone, isCrossRepository: false }]
  writeFileSync(split.env.FAKE_GH_STATE, JSON.stringify(st))
  refused('an origin that pushes to another repository than it fetches from', del('feat/merged', split), 'not one URL')
  check('and the branch is still on origin', onOrigin('feat/merged', split.origin) === gone)
}
{
  const w = makeWorld({}, { branch: 'trunk' })
  refused('the default branch GitHub names, protected or not', run(w, ['delete-remote-branch', w.repo, 'trunk']), 'default branch')
}

console.log('\na clone whose fetch refspec skips main judges against origin\'s real main')
{
  // origin/main here still holds a commit origin's main has since been rewound off. The clone's
  // remote.origin.fetch maps feature branches only, so its own fetch succeeds and leaves the stale
  // origin/main in place. A verb that judged against that ref would call the commit merged.
  const w = makeWorld()
  const gone = w.git(w.repo, 'commit-tree', `${w.tip}^{tree}`, '-p', w.tip, '-m', 'rewound off main')
  w.git(w.repo, 'push', '-q', 'origin', `${gone}:refs/heads/main`)
  w.git(w.repo, 'fetch', '-q', 'origin')
  w.git(w.repo, 'branch', 'feat/rewound-local', gone)
  w.git(w.origin, 'update-ref', 'refs/heads/main', w.tip)
  w.git(w.repo, 'config', 'remote.origin.fetch', '+refs/heads/feat/*:refs/remotes/origin/feat/*')
  check('the setup: the clone\'s origin/main is stale and holds the commit', w.git(w.repo, 'rev-parse', 'refs/remotes/origin/main') === gone)
  refused('delete-branch on a tip only the stale origin/main holds', run(w, ['delete-branch', w.repo, 'feat/rewound-local']), 'not shown dead')
  check('and the local branch still exists', spawnSync('git', ['-C', w.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/rewound-local']).status === 0)
}

console.log('\nremove-worktree refuses anything dirty or recent')
{
  const w = makeWorld()
  const add = (name) => {
    const path = join(w.workspace, name)
    w.git(w.repo, 'worktree', 'add', '-q', path, '-b', `feat/${name}`)
    w.git(path, 'push', '-q', 'origin', `feat/${name}`)
    return path
  }
  const age = (path) => { for (const f of w.git(path, 'ls-files').split('\n')) utimesSync(join(path, f), OLD, OLD) }
  const recent = add('recent')
  refused('a worktree changed inside four days', run(w, ['remove-worktree', w.repo, recent]), 'four-day')
  const dirty = add('dirty')
  age(dirty)
  writeFileSync(join(dirty, '.github', 'known-flakes.txt'), 'edited\n')
  refused('a worktree with a tracked change', run(w, ['remove-worktree', w.repo, dirty]), 'untracked')
  const untracked = add('untracked')
  age(untracked)
  writeFileSync(join(untracked, 'new.txt'), 'x')
  refused('a worktree with an untracked file', run(w, ['remove-worktree', w.repo, untracked]), 'untracked')
  const stale = add('stale')
  age(stale)
  const r = run(w, ['remove-worktree', w.repo, stale])
  check('an old clean worktree whose tip origin holds is removed and reads back gone', r.code === 0 && !w.git(w.repo, 'worktree', 'list').includes(stale), `${JSON.stringify(r.json)} ${r.stderr}`)
  refused('the main worktree', run(w, ['remove-worktree', w.repo, w.repo]), 'main worktree')
}

console.log('\nancestry is judged against the default branch, whatever it is named')
{
  // The default branch is trunk, and origin also carries a main a commit ahead of it: a tip only
  // that main holds has not been merged anywhere that counts.
  const w = makeWorld({}, { branch: 'trunk' })
  const spike = w.git(w.repo, 'commit-tree', `${w.tip}^{tree}`, '-p', w.tip, '-m', 'only on main')
  w.git(w.repo, 'push', '-q', 'origin', `${spike}:refs/heads/main`)
  w.git(w.repo, 'branch', 'feat/on-main-only', spike)
  refused('a branch whose tip only a non-default main holds', run(w, ['delete-branch', w.repo, 'feat/on-main-only']), 'not shown dead')
  w.git(w.repo, 'branch', 'feat/in-trunk', w.tip)
  const merged = run(w, ['delete-branch', w.repo, 'feat/in-trunk'])
  check('a branch whose tip is in origin/trunk is dead and deleted', merged.code === 0 && merged.json?.reason?.includes('origin/trunk'), `${JSON.stringify(merged.json)} ${merged.stderr}`)
  w.git(w.repo, 'checkout', '-q', '--detach')
  refused('the default branch itself, checked out nowhere', run(w, ['delete-branch', w.repo, 'trunk']), 'default branch')
  const detached = join(w.workspace, 'detached')
  w.git(w.repo, 'worktree', 'add', '-q', '--detach', detached, w.tip)
  for (const f of w.git(detached, 'ls-files').split('\n')) utimesSync(join(detached, f), OLD, OLD)
  const gone = run(w, ['remove-worktree', w.repo, detached])
  check('an old clean detached worktree at a trunk commit is removed', gone.code === 0 && gone.json?.reason?.includes('origin/trunk'), `${JSON.stringify(gone.json)} ${gone.stderr}`)
}

console.log('\nevery verb is bound to the workspace and fetches first')
{
  const w = makeWorld()
  const verbs = [['survey', w.repo], ['remove-worktree', w.repo, join(w.workspace, 'x')], ['delete-branch', w.repo, 'feat/x'], ['delete-remote-branch', w.repo, 'feat/x'],
    ['relabel', w.repo, '7', '--from', 'none', '--to', 'needs-triage', '--seen', new Date().toISOString(), '--reason', 'x']]
  for (const args of verbs) {
    refused(`${args[0]} under cron outside the workspace`, run(w, args, { FLOW_CRON_JOB: 'lint', FLOW_WORKSPACE: tmp }), 'direct child')
    refused(`${args[0]} under cron with no workspace`, run(w, args, { FLOW_CRON_JOB: 'lint', FLOW_WORKSPACE: '' }), 'unbounded')
  }
  w.git(w.repo, 'remote', 'set-url', 'origin', 'git@github.com:jakub/missing.git')
  for (const args of verbs) refused(`${args[0]} on a failed fetch`, run(w, args), 'fetch')
  check('a usage error prints the usage and exits 2', run(w, ['clear-orphan', w.repo, '7']).code === 2)
}

console.log('\nsurvey reads what the lint judges')
{
  const w = makeWorld({
    issues: [
      { number: 7, title: 'claimed', labels: [{ name: 'in-progress' }], updated_at: '2026-09-01T00:00:00Z', body: 'x' },
      { number: 8, title: 'ready', labels: [{ name: 'ready-for-agent' }, { name: 'bug' }], updated_at: '2026-09-02T00:00:00Z', body: '## Acceptance Criteria\n- [ ] y' },
      { number: 9, title: 'a pull request', labels: [], updated_at: '2026-09-03T00:00:00Z', pull_request: {} },
    ],
    labels: [{ name: 'needs-triage', color: '000000', description: 'drifted' }, { name: 'wip', color: 'ffffff', description: '' }],
    runs: [{ id: 1, jobs: [{ name: 'e2e', conclusion: 'failure' }, { name: 'unit', conclusion: 'success' }] }, { id: 2, jobs: [{ name: 'e2e', conclusion: 'success' }] }],
    prs: { 'feat/wt': [{ number: 3, state: 'OPEN', headRefOid: 'x', isCrossRepository: false }] },
  })
  w.git(w.repo, 'worktree', 'add', '-q', join(w.workspace, 'wt'), '-b', 'feat/wt')
  const work = (msg) => w.git(w.repo, 'commit-tree', `${w.tip}^{tree}`, '-p', w.tip, '-m', msg)
  const [mergedTip, openTip, spikeTip] = [work('merged'), work('open'), work('spike')]
  for (const [ref, sha] of [['feat/merged', mergedTip], ['feat/open', openTip], ['feat/spike', spikeTip], ['feat/in-main', w.tip], ['feat/held', mergedTip], ['feat/stacked', mergedTip], ['flow-evidence', w.tip]]) {
    w.git(w.repo, 'push', '-q', 'origin', `${sha}:refs/heads/${ref}`)
  }
  const st = JSON.parse(readFileSync(w.env.FAKE_GH_STATE, 'utf8'))
  w.git(w.repo, 'branch', 'feat/held', mergedTip)
  st.basePrs['feat/spike'] = [{ number: 7 }, { number: 8 }]
  st.basePrs['feat/stacked'] = [{ number: 9 }]
  Object.assign(st.prs, { 'feat/stacked': [{ number: 10, state: 'MERGED', headRefOid: mergedTip, isCrossRepository: false }], 'feat/held': [{ number: 6, state: 'MERGED', headRefOid: mergedTip, isCrossRepository: false }], 'feat/merged': [{ number: 4, state: 'MERGED', headRefOid: mergedTip, isCrossRepository: false }], 'feat/open': [{ number: 5, state: 'OPEN', headRefOid: openTip, isCrossRepository: false }] })
  writeFileSync(w.env.FAKE_GH_STATE, JSON.stringify(st))
  const originRefs = () => execFileSync('git', ['ls-remote', w.origin], { encoding: 'utf8' })
  const refsBefore = originRefs()
  const r = run(w, ['survey', w.repo])
  const s = r.json
  check('exit 0, pinned to origin\'s identity', r.code === 0 && s?.ok === true && s?.identity === 'github.com/jakub/demo', `${r.stderr} ${JSON.stringify(s)}`)
  check('worktrees with branch, cleanliness, last change and pull requests', s?.worktrees?.length === 1 && s.worktrees[0].branch === 'feat/wt' && s.worktrees[0].clean === true &&
    Number.isFinite(Date.parse(s.worktrees[0].lastChange)) && s.worktrees[0].prs[0]?.number === 3, JSON.stringify(s?.worktrees))
  check('local branches, main marked protected', s?.branches?.find((b) => b.name === 'main')?.protected === true && s.branches.find((b) => b.name === 'feat/wt')?.checkedOut === true, JSON.stringify(s?.branches))
  check('open issues without pull requests, the body only where ready-for-agent', s?.issues?.map((i) => i.number).join() === '7,8' && s.issues[0].body === undefined &&
    s.issues[1].body.includes('Acceptance') && s.issues[1].updatedAt === '2026-09-02T00:00:00Z', JSON.stringify(s?.issues))
  check('label tuples read back against the contract: drifted, missing and extra', s?.labels?.drifted?.[0]?.name === 'needs-triage' && s.labels.drifted[0].color?.have === '000000' &&
    s.labels.missing.includes('in-progress') && s.labels.extra.join() === 'wip', JSON.stringify(s?.labels))
  const flake = (entry) => s?.flakes?.entries?.find((e) => e.entry === entry)
  check('known flakes against the last runs', flake('e2e')?.runsSeen === 2 && flake('e2e')?.runsFailed === 1 && flake('unit:test_x')?.check === 'unit' && flake('gone-check')?.runsSeen === 0, JSON.stringify(s?.flakes))
  const remote = Object.fromEntries((s?.remoteBranches ?? []).map((b) => [b.name, b]))
  check('origin\'s branches without the default or the protected ones', Object.keys(remote).sort().join() === 'feat/held,feat/in-main,feat/merged,feat/open,feat/spike,feat/stacked', JSON.stringify(s?.remoteBranches))
  check('each with its tip, its open pull request and why it is dead, or null', remote['feat/merged']?.tip === mergedTip && remote['feat/merged'].openPr === null && remote['feat/merged'].dead?.includes('#4') &&
    remote['feat/in-main']?.dead === null && remote['feat/open']?.openPr === 5 && remote['feat/open'].dead === null &&
    remote['feat/spike']?.openPr === null && remote['feat/spike'].dead === null && remote['feat/spike'].basedPrs === 2 && remote['feat/merged'].basedPrs === 0 &&
    remote['feat/stacked']?.basedPrs === 1 && remote['feat/stacked'].dead === null &&
    remote['feat/held']?.heldHere?.includes('local branch') && remote['feat/held'].dead === null && remote['feat/merged'].heldHere === null, JSON.stringify(s?.remoteBranches))
  check('nothing was edited', edits(r).length === 0 && !r.st.unpinned, JSON.stringify(r.st.calls))
  check('nothing on origin moved: every ref at the same object', originRefs() === refsBefore && refsBefore.includes(`${mergedTip}\trefs/heads/feat/merged`), `${refsBefore}\n---\n${originRefs()}`)
}

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nlint-actions: ALL PASS' : `\nlint-actions: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
