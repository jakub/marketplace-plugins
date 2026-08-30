#!/usr/bin/env node
// Smoke harness for the SHA-bound release path: hooks/scripts/publish-guard-codex.mjs,
// lib/release-sanction.mjs, and scripts/release-sanction.mjs together.
//
// It builds a throwaway git repository with real commits and a fake origin, fabricates the
// hook JSON Codex sends, and runs the real guard as a child process with FLOW_STATE pointed
// at a temp directory. Nothing here reimplements the guard's logic: every case asserts what
// the guard actually decided and why.
//
// Every sanction is good for one attempt, pass or fail, so most cases write a fresh one
// first. That is the guard's claim-then-verify behavior showing through the test, not
// bookkeeping noise.
//
// Run: node plugins/flow/scripts/smoke-release-path.mjs

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mergeCommandFacts, publishOperations, publishOperationsStrict, publishReason } from '../lib/hook-policy.mjs'
import { releaseVerdict } from '../lib/release-sanction.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = join(ROOT, 'hooks', 'scripts', 'publish-guard-codex.mjs')
const CLAUDE_GUARD = join(ROOT, 'hooks', 'scripts', 'publish-guard.mjs')
const HELPER = join(ROOT, 'scripts', 'release-sanction.mjs')

let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` → ${detail}`}`)
}

// ---------------------------------------------------------------- a throwaway repository
const tmp = mkdtempSync(join(tmpdir(), 'flow-release-path-'))
const repo = join(tmp, 'repo')
const state = join(tmp, 'state')
const SANCTION = join(state, 'release-sanction.json')
mkdirSync(repo)
mkdirSync(state)

// Isolated from the developer's own git config, and with an identity that needs none.
const gitEnv = {
  ...process.env,
  HOME: tmp,
  GIT_CONFIG_GLOBAL: join(tmp, 'no-such-gitconfig'),
  GIT_CONFIG_SYSTEM: join(tmp, 'no-such-gitconfig'),
  GIT_AUTHOR_NAME: 'flow smoke',
  GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
  GIT_COMMITTER_NAME: 'flow smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
}
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: gitEnv }).trim()
const commit = (text) => {
  writeFileSync(join(repo, 'file.txt'), `${text}\n`)
  git('add', 'file.txt')
  git('commit', '-q', '-m', text)
  return git('rev-parse', 'HEAD')
}

git('init', '-q', '-b', 'main')
git('remote', 'add', 'origin', 'git@github.com:jakub/marketplace-plugins.git')
const SLUG = 'jakub/marketplace-plugins'
const PR = 12
let head = commit('first')

// -------------------------------------------------------------------- driving the guard
const guardEnv = (env) => ({ ...gitEnv, FLOW_CRON_JOB: '', FLOW_STATE: state, ...env })
const guard = (command, { env = {}, cwd = repo } = {}) => {
  const out = execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8',
    env: guardEnv(env),
  }).trim()
  return out ? JSON.parse(out) : null
}
const reasonOf = (decision) => decision?.hookSpecificOutput?.permissionDecisionReason || ''
const denies = (name, command, substring, options) => {
  const decision = guard(command, options)
  const denied = decision?.hookSpecificOutput?.permissionDecision === 'deny'
  const matched = denied && reasonOf(decision).includes(substring)
  check(name, matched, denied ? `denied for the wrong reason: ${reasonOf(decision)}` : 'allowed')
}
const allows = (name, command, options) => {
  const decision = guard(command, options)
  check(name, decision === null, `denied: ${reasonOf(decision)}`)
}

const sanction = (overrides = {}) => {
  const issued = Date.now()
  const body = {
    schema: 1,
    repo: SLUG,
    branch: 'main',
    head,
    prNumber: PR,
    operations: ['gh-pr-merge'],
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + 10 * 60_000).toISOString(),
    ...overrides,
  }
  writeFileSync(SANCTION, JSON.stringify(body, null, 2))
  return body
}
const clearSanction = () => { rmSync(SANCTION, { force: true }) }
const tombstones = (verdict) => readdirSync(state).filter((f) => f.startsWith(`release-sanction.${verdict}.`))
const clearTombstones = () => {
  for (const file of readdirSync(state)) {
    if (file !== 'release-sanction.json') rmSync(join(state, file), { force: true })
  }
}

// The one command form the guard accepts, and the knobs each case turns on it.
const mergeCommand = ({ pr = PR, sha = head, squash = true, match = true, extra = '' } = {}) =>
  ['gh pr merge', pr, squash ? '--squash' : '', match ? `--match-head-commit ${sha}` : '', extra]
    .filter((part) => part !== '' && part !== false).join(' ')
// Called, never captured: the head moves during the run and a stale --match-head-commit
// would fail for the wrong reason.
const merge = () => mergeCommand()

// ------------------------------------------------------------------------- classification
console.log('operation classification')
check('gh pr merge is an operation', JSON.stringify(publishOperations(merge())) === '["gh-pr-merge"]')
check('npm publish is an operation', JSON.stringify(publishOperations('npm publish --access public')) === '["npm-publish"]')
check('a dry run publishes nothing', JSON.stringify(publishOperations('cargo publish --dry-run')) === '[]')
check('merge in prose is not a merge', JSON.stringify(publishOperations('echo "gh pr merge after review"')) === '[]')
check('ordinary work publishes nothing', JSON.stringify(publishOperations('git status --porcelain')) === '[]')
// The Claude guard asks about registry publication and nothing else. The merge op must not
// have changed that, so it is checked against the real Claude guard too.
check('publishReason ignores the merge op', publishReason(merge()) === null)
const claude = (command) => execFileSync(process.execPath, [CLAUDE_GUARD], {
  input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
}).trim()
check('the Claude guard says nothing about a merge', claude(merge()) === '')
check('the Claude guard still asks about cargo publish', claude('cargo publish').includes('permissionDecision'))
// Quoting hides a command from the Claude classifier, which is the prose exemption doing its
// job. The release path reads through it instead.
const QUOTED = `bash -lc 'gh pr merge ${PR} --squash --match-head-commit ${head}'`
check('a quoted merge is invisible to the shallow read', JSON.stringify(publishOperations(QUOTED)) === '[]')
check('the strict read finds it', JSON.stringify(publishOperationsStrict(QUOTED)) === '["gh-pr-merge"]')
check('the Claude guard is untouched by the strict read', claude(QUOTED) === '')
check(
  'eval hides nothing either',
  JSON.stringify(publishOperationsStrict(`eval "gh pr merge ${PR} --squash"`)) === '["gh-pr-merge"]',
)
check(
  'a quoted registry publish is found too',
  JSON.stringify(publishOperationsStrict("bash -lc 'npm publish --access public'")) === '["npm-publish"]',
)
check(
  'prose inside a quoted payload is still prose',
  JSON.stringify(publishOperationsStrict(`bash -lc 'echo "run gh pr merge once CI is green"'`)) === '[]',
)
check(
  'a merge is parsed out of its quoted payload',
  mergeCommandFacts(QUOTED).invocations.length === 1 &&
  mergeCommandFacts(QUOTED).invocations[0].targets.join() === String(PR) &&
  mergeCommandFacts(QUOTED).invocations[0].squash === true &&
  mergeCommandFacts(QUOTED).invocations[0].matchHead === head,
  JSON.stringify(mergeCommandFacts(QUOTED)),
)
check(
  'a semicolon inside a quoted flag value does not split the segment',
  mergeCommandFacts(`gh pr merge ${PR} --squash -b "one; two" --match-head-commit ${head}`)
    .invocations[0].matchHead === head,
)

// ------------------------------------------------------------------------- the deny matrix
console.log('\nwithout a sanction')
clearSanction()
// The wording that was in place before the release path existed, preserved exactly.
const PLAIN = 'This publishes to crates.io, which you cannot take back - crates.io has no unpublish at all. ' +
  'Confirm the version number and the contents are what you mean to ship. ' +
  'Codex PreToolUse hooks cannot request confirmation, so direct publication is blocked. ' +
  'Run the publish command yourself after reviewing the version and package contents.'
const plainDecision = guard('cargo publish -p flow')
check('the plain publication deny text is unchanged', reasonOf(plainDecision).startsWith(PLAIN), reasonOf(plainDecision))
denies('a merge with no sanction is denied', merge(), 'no release sanction is on file')
denies('a quoted merge with no sanction is denied', QUOTED, 'no release sanction is on file')
denies('a registry publication is denied', 'npm publish', 'registry publication stays manual')

console.log('\nregistry publication is never sanctionable')
sanction({ operations: ['npm-publish'] })
denies('npm publish is denied despite a sanction naming it', 'npm publish --access public', 'registry publication stays manual')
check('and the sanction was not even claimed', existsSync(SANCTION))
denies('a quoted registry publish is denied too', "bash -lc 'npm publish'", 'registry publication stays manual')
denies(
  'a sanction that lists a registry op cannot be used for the merge either',
  merge(), 'no sanction covers registry publication',
)
clearSanction()
check(
  'the verdict refuses a registry op on its own terms',
  releaseVerdict({ operations: ['npm-publish'], command: 'npm publish', sanction: sanction({ operations: ['npm-publish'] }), repo: { slug: SLUG, branch: 'main', head, dirty: false }, nowMs: Date.now() })
    .reason.includes('never sanctioned'),
)
clearSanction()

console.log('\nwith a sanction that does not match')
sanction({ head: 'b'.repeat(40) })
denies('a stale head is denied', merge(), 'the head has moved')
sanction({ branch: 'feat/other' })
denies('another branch is denied', merge(), 'the sanction is for branch')
sanction({ repo: 'someone/else' })
denies('another repository is denied', merge(), 'the sanction is for repository')
sanction({ operations: ['gh-pr-close'] })
denies('an operation outside the sanction is denied', merge(), 'does not cover gh-pr-merge')
// A real expiry: issued half an hour ago, ran out a minute ago.
sanction({
  issuedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
})
denies('an expired sanction is denied', merge(), 'expired at')
sanction({ expiresAt: new Date(Date.now() - 1000).toISOString() })
denies('a sanction that expires before it was issued is denied', merge(), 'expires no later than it was issued')
sanction({ expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() })
denies('an oversized window is denied', merge(), 'more than 30 minutes')
// Backdating the issue time is how a hand-written file would try to buy a standing
// approval: the window from issue to expiry is what gets measured, not the time left.
sanction({
  issuedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
})
denies('a backdated issue time is denied', merge(), 'more than 30 minutes')
sanction({
  issuedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
})
denies('a sanction issued in the future is denied', merge(), 'in the future')
// Two minutes of clock skew between machines is tolerated rather than denied.
sanction({
  issuedAt: new Date(Date.now() + 30_000).toISOString(),
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
})
allows('a sanction thirty seconds ahead of this clock still passes', merge())
sanction({ schema: 2 })
denies('another schema version is denied', merge(), 'schema')
writeFileSync(SANCTION, '{ this is not json')
denies('a malformed sanction is denied', merge(), 'no release sanction is on file')
sanction({ prNumber: undefined })
denies('a sanction with no pull request number is denied', merge(), 'names no pull request number')
sanction({ prNumber: '12' })
denies('a pull request number that is a string is denied', merge(), 'names no pull request number')

console.log('\nthe merge command has to be the sanctioned merge')
sanction()
denies('another pull request is denied', mergeCommand({ pr: 13 }), 'the merge is for #13')
sanction()
denies('a merge with no target is denied', 'gh pr merge --squash', 'names no pull request')
sanction()
denies('a missing --match-head-commit is denied', mergeCommand({ match: false }), 'no readable --match-head-commit')
sanction()
denies('a mismatched --match-head-commit is denied', mergeCommand({ sha: 'c'.repeat(40) }), 'and the sanction approved')
sanction()
denies('an abbreviated --match-head-commit is denied', mergeCommand({ sha: head.slice(0, 12) }), 'no readable --match-head-commit')
sanction()
denies('a merge without --squash is denied', mergeCommand({ squash: false }), 'does not pass --squash')
sanction()
denies('--admin is denied', mergeCommand({ extra: '--admin' }), '--admin')
sanction()
denies('--auto is denied', mergeCommand({ extra: '--auto' }), '--auto')
sanction()
denies('--delete-branch is denied', mergeCommand({ extra: '--delete-branch' }), '--delete-branch')
sanction()
denies('-R is denied', `gh pr merge -R other/repo ${PR} --squash --match-head-commit ${head}`, '--repo')
sanction()
denies('a GH_REPO assignment is denied', `GH_REPO=other/repo ${merge()}`, 'GH_REPO')
sanction()
denies('a GH_HOST assignment is denied', `GH_HOST=example.invalid ${merge()}`, 'GH_HOST')
sanction()
denies(
  'a pull request url for another repository is denied',
  mergeCommand({ pr: `https://github.com/someone/else/pull/${PR}` }), 'and the sanction is for',
)
sanction()
denies('two merges in one command are denied', `${merge()} && ${merge()}`, 'runs 2 merges')
sanction()
denies('a merge hidden in a quoted payload without --match-head-commit is denied',
  `bash -lc 'gh pr merge ${PR} --squash'`, 'no readable --match-head-commit')
sanction()
check(
  'the verdict refuses two publication operations outright',
  releaseVerdict({
    operations: ['gh-pr-merge', 'gh-pr-something'],
    command: merge(),
    sanction: { schema: 1, repo: SLUG, branch: 'main', head, prNumber: PR, operations: ['gh-pr-merge', 'gh-pr-something'], issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    repo: { slug: SLUG, branch: 'main', head, dirty: false },
    nowMs: Date.now(),
  }).reason.includes('publication operations'),
)

console.log('\nfacts the guard re-derives')
sanction()
writeFileSync(join(repo, 'untracked.txt'), 'work in progress\n')
denies('a dirty tree is denied', merge(), 'working tree is dirty')
rmSync(join(repo, 'untracked.txt'))
sanction()
denies('a repository git cannot read is denied', merge(), 'no readable owner/name slug', { cwd: join(tmp, 'nowhere') })
sanction()
denies('a scheduled job is denied despite a valid sanction', merge(), 'scheduled jobs cannot publish', { env: { FLOW_CRON_JOB: 'lint' } })
check('the scheduled job did not claim the sanction', existsSync(SANCTION))

console.log('\nthe model may not approve itself')
denies('writing the sanction path is denied', `echo '{}' > ${SANCTION}`, 'directly')
denies('naming the sanction file is denied', 'mv /tmp/x.json ~/.local/state/flow/release-sanction.json', 'names the release sanction file')
denies('running the helper is denied', `node ${HELPER} approve --repo ${SLUG} --branch main --head ${head} --pr ${PR} --op gh-pr-merge`, 'runs the release sanction helper')
denies('revoking through the helper is denied', 'node plugins/flow/scripts/release-sanction.mjs revoke', 'runs the release sanction helper')
allows('staging the helper file is ordinary work', 'git add plugins/flow/scripts/release-sanction.mjs')

console.log('\nordinary commands are untouched')
allows('git status', 'git status --porcelain')
allows('git add', 'git add -A plugins/flow')
allows('git commit', 'git commit -m "fix(flow): close release-sanction bypasses"')
allows('git push', 'git push -u origin feat/issue-6-land-cross-harness')
allows('git commit describing a merge', 'git commit -m "chore: note that gh pr merge is the only land path"')
allows('a test run', 'npm test -- --watch=false')
allows('a dry run', 'cargo publish --dry-run')
allows('a dry run through a shell', "bash -lc 'cargo publish --dry-run'")
allows('a merge described in prose', 'gh pr comment 12 -b "run gh pr merge once CI is green"')
allows('reading a PR', `gh pr view ${PR} --json state,mergeCommit`)
check('none of that touched the sanction', existsSync(SANCTION))

console.log('\nthe approved merge, once')
clearSanction()
clearTombstones()
head = commit('second')
sanction()
allows('the approved merge runs', merge())
check('the sanction was consumed', !existsSync(SANCTION))
check('a tombstone records the use', tombstones('consumed').length === 1, JSON.stringify(tombstones('consumed')))
denies('the same merge a second time is denied', merge(), 'no release sanction is on file')

clearTombstones()
sanction()
allows('the same merge written through a shell runs', `bash -lc 'gh pr merge ${PR} --squash --match-head-commit ${head}'`)
check('that spent the sanction too', !existsSync(SANCTION))

clearTombstones()
sanction()
denies('a denied attempt spends the sanction', mergeCommand({ pr: 99 }), 'the merge is for #99')
check('the denied claim is gone from the sanction path', !existsSync(SANCTION))
check('and left a denied tombstone', tombstones('denied').length === 1, JSON.stringify(tombstones('denied')))
denies('so the corrected command is denied too', merge(), 'no release sanction is on file')

sanction()
head = commit('third')
denies('a sanction is void once the head moves', merge(), 'the head has moved')
clearSanction()

// ------------------------------------------------------------------- two guards, one file
// rename() is the lock. Whichever process moves the file first owns the approval; the other
// gets ENOENT and denies. Run both at once and count the allows.
console.log('\ntwo commands racing for one sanction')
sanction()
const raceCommand = mergeCommand()
const guardAsync = (command) => new Promise((resolve) => {
  const child = spawn(process.execPath, [GUARD], { env: guardEnv({}), stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.on('close', () => resolve(out.trim()))
  child.stdin.end(JSON.stringify({ tool_input: { command }, cwd: repo }))
})
const race = await Promise.all([guardAsync(raceCommand), guardAsync(raceCommand)])
check('exactly one of the two is allowed', race.filter((out) => out === '').length === 1, JSON.stringify(race))
check(
  'the loser is told the sanction is gone',
  race.some((out) => out !== '' && out.includes('claimed it first')),
  JSON.stringify(race),
)
check('and the sanction is spent', !existsSync(SANCTION))

// ------------------------------------------------------------------------------ the helper
console.log('\nthe human helper')
clearSanction()
const helper = (args, env = {}) => {
  try {
    const stdout = execFileSync(process.execPath, [HELPER, ...args], {
      encoding: 'utf8', env: { ...gitEnv, FLOW_CRON_JOB: '', FLOW_STATE: state, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') }
  }
}
const approveArgs = (...extra) => ['approve', '--repo', SLUG, '--branch', 'main', '--head', head, '--pr', String(PR), '--op', 'gh-pr-merge', ...extra]
const approved = helper(approveArgs())
check('approve succeeds', approved.code === 0, approved.stderr)
check('the sanction is mode 0600', (statSync(SANCTION).mode & 0o777) === 0o600, (statSync(SANCTION).mode & 0o777).toString(8))
check('it records the pull request number', JSON.parse(readFileSync(SANCTION, 'utf8')).prNumber === PR)
allows('the guard honors what the helper wrote', mergeCommand())

const noPr = helper(['approve', '--repo', SLUG, '--branch', 'main', '--head', head, '--op', 'gh-pr-merge'])
check('approve without --pr is refused', noPr.code === 2 && noPr.stderr.includes('--pr <number> is required'), noPr.stderr)
const badPr = helper(approveArgs().map((arg) => (arg === String(PR) ? 'twelve' : arg)))
check('a pull request number that is not a number is refused', badPr.code === 2, badPr.stderr)

const registryOp = helper(['approve', '--repo', SLUG, '--branch', 'main', '--head', head, '--op', 'npm-publish'])
check(
  'approving a registry publication is refused',
  registryOp.code === 2 && registryOp.stderr.includes('registry publication stays manual'),
  registryOp.stderr,
)

const cron = helper(approveArgs(), { FLOW_CRON_JOB: 'lint' })
check('approve refuses under FLOW_CRON_JOB', cron.code === 2 && cron.stderr.includes('unattended'), cron.stderr)
check('and wrote nothing', !existsSync(SANCTION))

const typo = helper(['approve', '--repo', SLUG, '--branch', 'main', '--head', head, '--pr', String(PR), '--op', 'gh-pr-mrege'])
check('an unknown operation id is refused', typo.code === 2 && typo.stderr.includes('unknown operation'), typo.stderr)
const longTtl = helper(approveArgs('--ttl-minutes', '600'))
check('a ttl beyond 30 minutes is refused', longTtl.code === 2 && longTtl.stderr.includes('between 1 and 30'), longTtl.stderr)
const shortSha = helper(['approve', '--repo', SLUG, '--branch', 'main', '--head', head.slice(0, 12), '--pr', String(PR), '--op', 'gh-pr-merge'])
check('an abbreviated SHA is refused', shortSha.code === 2 && shortSha.stderr.includes('40-character'), shortSha.stderr)
check('none of the refusals left a sanction behind', !existsSync(SANCTION))

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nrelease path: ALL PASS' : `\nrelease path: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
