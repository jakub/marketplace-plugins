#!/usr/bin/env node
// Smoke for scripts/land-merge.mjs, the only merge. The executor runs in process against real
// repositories under mktemp, whose origin it reads with real git, and a fake gh injected as a
// function that answers from a per-case state object and records every call and every merge.
// Each refusal case asserts that nothing merged; each unproven outcome asserts that it does not
// read as a refusal. One case runs the real gh runner against a fake gh binary to prove that
// GH_REPO and GH_HOST never reach gh.
//
// Run: node plugins/flow/scripts/smoke-land-merge.mjs

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ghRunner } from '../lib/gh-exec.mjs'
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

const freshState = (over = {}) => ({
  defaultBranch: 'main', mergeExit: 0, landsNothing: false, confirmFails: false, queue: null, queueFails: false, recheck: {}, after: {},
  queueAfter: undefined, queueAfterFails: false, merged: false, calls: [], merges: [], ...over,
  pr: { headRefOid: HEAD, state: 'OPEN', isDraft: false, baseRefName: 'main', url: `https://github.com/${SLUG}/pull/${PR}`, autoMergeRequest: null, ...(over.pr || {}) },
})
const makeRunGh = (st) => (args) => {
  st.calls.push(args)
  const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
  if (args[0] === 'pr' && args[1] === 'view') {
    const fields = args[args.indexOf('--json') + 1]
    if (fields === 'baseRefName,headRefOid') return ok({ baseRefName: st.pr.baseRefName, headRefOid: st.pr.headRefOid, ...st.recheck })
    if (fields.startsWith('state,')) {
      if (st.confirmFails) return { code: 1, stdout: '', stderr: 'fake gh: view failed\n' }
      return ok({ ...st.pr, state: st.merged ? 'MERGED' : st.pr.state, autoMergeRequest: null, ...st.after })
    }
    return ok(st.pr)
  }
  if (args[0] === 'repo' && args[1] === 'view') return ok({ defaultBranchRef: { name: st.defaultBranch } })
  if (args[0] === 'api' && args[1] === 'graphql') {
    const afterMerge = st.merges.length > 0
    if (afterMerge ? st.queueAfterFails : st.queueFails) return { code: 1, stdout: '', stderr: 'fake gh: graphql failed\n' }
    return ok({ data: { repository: { mergeQueue: afterMerge && st.queueAfter !== undefined ? st.queueAfter : st.queue } } })
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    st.merges.push(args)
    if (st.mergeExit) return { code: st.mergeExit, stdout: '', stderr: 'X Pull request is not mergeable\n' }
    if (!st.landsNothing) st.merged = true
    return { code: 0, stdout: '', stderr: '' }
  }
  return { code: 3, stdout: '', stderr: `fake gh: unexpected ${args.join(' ')}\n` }
}
const pinnedTo = (identity, host) => (a) => (a[0] === 'api' ? a[a.indexOf('--hostname') + 1] === host && a.includes(`owner=${identity.split('/')[1]}`) && a.includes(`name=${identity.split('/')[2]}`)
  : a[0] === 'repo' ? a[2] === identity : a[a.indexOf('--repo') + 1] === identity)
const run = (args = ARGS, { st = freshState(), cwd = REPO, env = {} } = {}) => ({ ...landMerge({ argv: args, env, cwd, runGh: makeRunGh(st) }), st })

console.log('the executor merges once, pinned to the gated head')
{
  const r = run()
  check('exit 0, and it says what it merged', r.code === 0 && r.stdout.includes(`merged #${PR} on ${IDENTITY}`), `${r.stdout}${r.stderr}`)
  check('exactly one merge: --repo, --squash, --match-head-commit at the caller\'s head', r.st.merges.length === 1 &&
    JSON.stringify(r.st.merges[0]) === JSON.stringify(['pr', 'merge', String(PR), '--repo', IDENTITY, '--squash', '--match-head-commit', HEAD]), JSON.stringify(r.st.merges))
  check('every gh call names origin\'s repository', r.st.calls.every(pinnedTo(IDENTITY, 'github.com')), JSON.stringify(r.st.calls.filter((a) => !pinnedTo(IDENTITY, 'github.com')(a))))
}

console.log('\nrefused before mutating anything')
for (const [name, text, over, opts = {}] of [
  ['a head other than the gated one', 'head moved', { pr: { headRefOid: 'c'.repeat(40) } }],
  ['a closed pull request', 'only an open pull request', { pr: { state: 'CLOSED' } }],
  ['a merged one', 'only an open pull request', { pr: { state: 'MERGED' } }],
  ['a draft', 'is a draft', { pr: { isDraft: true } }],
  ['an unreadable draft flag', 'cannot be shown ready', { pr: { isDraft: null } }],
  ['a base other than the default branch', 'the default branch is', { pr: { baseRefName: 'release' } }],
  ['an unreadable default branch', 'default branch could not be read', { defaultBranch: null }],
  ['an armed auto-merge', 'auto-merge armed', { pr: { autoMergeRequest: { enabledBy: { login: 'bot' } } } }],
  ['a merge queue on the base', 'uses a merge queue', { queue: { id: 'MQ' } }],
  ['an unreadable merge queue', 'could not be read', { queueFails: true }],
  ['a read GitHub redirected elsewhere', 'was redirected', { pr: { url: 'https://github.com/someone/evil/pull/12' } }],
  ['a retarget before the merge', 'was retargeted', { recheck: { baseRefName: 'release' } }],
  ['a head moved before the merge', 'moved mid-run', { recheck: { headRefOid: 'd'.repeat(40) } }],
  ['a directory with no origin', 'no readable origin remote', {}, { cwd: NO_ORIGIN }],
  ['an unattended job, before even the origin read', 'nobody is watching', {}, { cwd: NO_ORIGIN, env: { FLOW_CRON_JOB: 'lint' } }],
]) {
  const r = run(ARGS, { st: freshState(over), ...opts })
  check(`${name} is refused and nothing merged`, r.code === 1 && r.stderr.startsWith('land-merge: refused,') && r.stderr.includes(text) && r.st.merges.length === 0, r.stderr)
}
for (const [name, args] of [['no arguments', []], ['the number alone', [String(PR)]], ['a number that is not one', ['twelve', HEAD]],
  ['an abbreviated head', [String(PR), HEAD.slice(0, 12)]], ['an uppercase head', [String(PR), HEAD.toUpperCase()]], ['a third argument', [...ARGS, '--admin']]]) {
  const r = run(args)
  check(`${name} is a refusal that calls no gh`, r.code === 1 && r.stderr.startsWith('land-merge: refused,') && r.st.calls.length === 0, r.stderr)
}

console.log('\nthe outcome is proven by a re-read, or reported unproven')
{
  const failed = run(ARGS, { st: freshState({ mergeExit: 1 }) })
  check('gh refusing the merge with the pull request cleanly open is a refusal', failed.code === 1 && failed.stderr.includes('refused, gh pr merge failed') && failed.st.merges.length === 1, failed.stderr)
  for (const [name, text, over] of [
    ['a MERGED read at another head', 'someone else may have merged it', { after: { headRefOid: 'e'.repeat(40) } }],
    ['auto-merge armed by the merge call', 'auto-merge armed', { mergeExit: 1, after: { autoMergeRequest: { enabledBy: { login: 'bot' } } } }],
    ['a queue armed only after the merge call', 'merge-queue status is armed', { mergeExit: 1, queueAfter: { id: 'MQ' } }],
    ['an unreadable queue after the merge call', 'merge-queue status is unreadable', { mergeExit: 1, queueAfterFails: true }],
    ['a merge gh reported that landed nothing', 'reported success', { landsNothing: true }],
    ['a confirming read that failed', 'could not confirm whether', { mergeExit: 1, confirmFails: true }],
  ]) {
    const r = run(ARGS, { st: freshState(over) })
    check(`${name} is unproven, not refused and not merged`, r.code === 1 && r.stderr.includes(text) && !r.stderr.includes('refused') && r.stdout === '', r.stderr)
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
  check(`${name} is refused before any gh call, quoting nothing secret`, r.code === 1 && r.stderr.includes(text) && r.st.calls.length === 0 && !r.stderr.includes('ghp_sekret'), r.stderr)
}
{
  const ghe = run(ARGS, { cwd: repoWith('ghe', `git@ghe.example.com:${SLUG}.git`), env: { FLOW_GH_HOSTS: 'ghe.example.com' }, st: freshState({ pr: { url: `https://ghe.example.com/${SLUG}/pull/${PR}` } }) })
  check('FLOW_GH_HOSTS admits that host, and every call pins it', ghe.code === 0 && ghe.st.calls.every(pinnedTo(`ghe.example.com/${SLUG}`, 'ghe.example.com')), ghe.stderr)
  const crossed = run(ARGS, { cwd: repoWith('ghe-crossed', `git@ghe.example.com:${SLUG}.git`), env: { FLOW_GH_HOSTS: 'ghe.example.com' } })
  check('a github.com url answering for a GHE origin is a redirect', crossed.code === 1 && crossed.stderr.includes('was redirected') && crossed.st.merges.length === 0, crossed.stderr)
}
{
  const bin = join(tmp, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nenv\n')
  chmodSync(join(bin, 'gh'), 0o755)
  const seen = ghRunner({ PATH: `${bin}:/usr/bin:/bin`, GH_REPO: 'someone/evil', GH_HOST: 'evil.example', KEEP: 'kept' })([]).stdout
  check('the gh runner never hands GH_REPO or GH_HOST to gh', !/^GH_(REPO|HOST)=/m.test(seen) && /^KEEP=kept$/m.test(seen), seen)
}

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nland-merge: ALL PASS' : `\nland-merge: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
