#!/usr/bin/env node
// Smoke harness for flow's release path: hooks/scripts/publish-guard-codex.mjs (the tripwire),
// scripts/land-merge.mjs (the executor that actually merges), lib/release-sanction.mjs (the
// policy both sides of that split agree on), and scripts/release-sanction.mjs (the human's
// half).
//
// The executor is a cooperative guardrail, not a security boundary: at one uid a model could
// ignore it. What the cases below prove is that the ordinary and casually-injected paths get
// caught - the executor pins every gh call to the repository the origin remote names, refuses a
// merge queue or an armed auto-merge before mutating, reads back three honest terminal states,
// and spends its single-use approval whatever happens.
//
// The executor is driven in process through its exported landMerge() with a fake gh injected as
// a plain function across the module boundary. No environment variable selects the gh binary.
// The one exception is the two-process race, which needs real operating-system processes to
// prove the rename() lock; that one uses a fake gh on PATH, the way the production CLI resolves
// the real one.
//
// "managed" is a property of the repository: a committed .flow/managed marker enrols it, and a
// deleted working-tree copy does not un-enrol it. Three git repositories cover that - marked,
// marked-but-worktree-copy-deleted, and unmarked - plus one directory that is no repository.
//
// Run: node plugins/flow/scripts/smoke-release-path.mjs

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mergeShapes, publishOperations, publishOperationsStrict, publishReason } from '../lib/hook-policy.mjs'
import { releaseVerdict } from '../lib/release-sanction.mjs'
import { landMerge } from './land-merge.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = join(ROOT, 'hooks', 'scripts', 'publish-guard-codex.mjs')
const CLAUDE_GUARD = join(ROOT, 'hooks', 'scripts', 'publish-guard.mjs')
const EXECUTOR = join(ROOT, 'scripts', 'land-merge.mjs')
const HELPER = join(ROOT, 'scripts', 'release-sanction.mjs')

let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` → ${detail}`}`)
}

// --------------------------------------------------------------- the throwaway repositories
const tmp = mkdtempSync(join(tmpdir(), 'flow-release-path-'))
const repo = join(tmp, 'repo')       // opts into flow: .flow/managed is committed and present
const mdel = join(tmp, 'mdel')       // .flow/managed is committed but the worktree copy is gone
const plain = join(tmp, 'plain')     // no marker, and no commits
const norepo = join(tmp, 'norepo')   // not a git repository at all
const state = join(tmp, 'state')
const bin = join(tmp, 'bin')
const SANCTION = join(state, 'release-sanction.json')
for (const dir of [repo, mdel, plain, norepo, state, bin]) mkdirSync(dir)

const SLUG = 'jakub/marketplace-plugins'
const IDENTITY = 'github.com/jakub/marketplace-plugins'
const PR = 12
const BRANCH = 'feat/thing'

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
const gitIn = (dir) => (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv }).trim()
const git = gitIn(repo)
const commit = (text) => {
  writeFileSync(join(repo, 'file.txt'), `${text}\n`)
  git('add', 'file.txt')
  git('commit', '-q', '-m', text)
  return git('rev-parse', 'HEAD')
}

git('init', '-q', '-b', 'main')
git('remote', 'add', 'origin', `git@github.com:${SLUG}.git`)
mkdirSync(join(repo, '.flow'))
writeFileSync(join(repo, '.flow', 'managed'), 'this repository opts into flow\n')
mkdirSync(join(repo, 'src'))
git('add', '.flow/managed')
const head = commit('first')

// mdel: marker committed at HEAD, then removed from the working tree. Still managed.
const mdelGit = gitIn(mdel)
mdelGit('init', '-q', '-b', 'main')
mdelGit('remote', 'add', 'origin', `git@github.com:${SLUG}.git`)
mkdirSync(join(mdel, '.flow'))
writeFileSync(join(mdel, '.flow', 'managed'), 'this repository opts into flow\n')
mdelGit('add', '.flow/managed')
mdelGit('commit', '-q', '-m', 'managed')
rmSync(join(mdel, '.flow', 'managed'))

const plainGit = gitIn(plain)
plainGit('init', '-q', '-b', 'main')
plainGit('remote', 'add', 'origin', 'git@github.com:someone/unmanaged.git')

// ---------------------------------------------------------- the fake gh, injected in process
const freshState = (overrides = {}) => ({
  defaultBranch: 'main',
  merged: false,
  mergeExit: 0,
  mergeStderr: '',
  mergeLandsNothing: false,
  confirmFails: false,
  graphqlFails: false,
  mergeQueue: null,
  recheckBase: null,
  recheckHead: null,
  calls: [],
  merges: [],
  ...overrides,
  pr: {
    headRefOid: head,
    headRefName: BRANCH,
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    url: `https://github.com/${SLUG}/pull/${PR}`,
    autoMergeRequest: null,
    ...(overrides.pr || {}),
  },
})

const makeRunGh = (st) => (args) => {
  st.calls.push(args)
  const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
  if (args[0] === 'pr' && args[1] === 'view') {
    const ji = args.indexOf('--json')
    const fields = ji >= 0 ? args[ji + 1] : ''
    if (fields === 'state') {
      if (st.confirmFails) return { code: 4, stdout: '', stderr: 'fake gh: view failed\n' }
      return ok({ state: st.merged ? 'MERGED' : st.pr.state })
    }
    if (fields === 'baseRefName,headRefOid') {
      return ok({ baseRefName: st.recheckBase ?? st.pr.baseRefName, headRefOid: st.recheckHead ?? st.pr.headRefOid })
    }
    return ok({ ...st.pr })
  }
  if (args[0] === 'repo' && args[1] === 'view') return ok({ defaultBranchRef: { name: st.defaultBranch } })
  if (args[0] === 'api' && args[1] === 'graphql') {
    if (st.graphqlFails) return { code: 5, stdout: '', stderr: 'fake gh: graphql failed\n' }
    return ok({ data: { repository: { mergeQueue: st.mergeQueue } } })
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    st.merges.push(args)
    if (st.mergeExit) return { code: st.mergeExit, stdout: '', stderr: st.mergeStderr || 'fake gh: refusing to merge\n' }
    if (!st.mergeLandsNothing) st.merged = true
    return { code: 0, stdout: 'fake gh: merged\n', stderr: '' }
  }
  return { code: 3, stdout: '', stderr: `fake gh: unexpected ${args.join(' ')}\n` }
}

// Every gh call the executor makes must name the repository derived from origin, so no ambient
// GH_REPO or GH_HOST can redirect it. graphql pins the host instead of --repo.
const isPinned = (args) => {
  if (args[0] === 'api' && args[1] === 'graphql') {
    const hi = args.indexOf('--hostname')
    return hi >= 0 && args[hi + 1] === 'github.com'
  }
  // `gh repo view` names the repository as a positional; `gh pr view` and `gh pr merge` use --repo.
  if (args[0] === 'repo' && args[1] === 'view') return args[2] === IDENTITY
  const ri = args.indexOf('--repo')
  return ri >= 0 && args[ri + 1] === IDENTITY
}

const envBase = () => ({ FLOW_CRON_JOB: '', FLOW_STATE: state, HOME: tmp })
const runExecutor = (args, { cwd = repo, env = {}, st } = {}) => {
  const s = st || freshState()
  const result = landMerge({ argv: args, env: { ...envBase(), ...env }, cwd, runGh: makeRunGh(s), nowMs: Date.now() })
  return { code: result.code, stdout: result.stdout, stderr: result.stderr, calls: s.calls, merges: s.merges, st: s }
}

// --------------------------------------------------------------------- the guard, in process
const guard = (command, { env = {}, cwd = repo } = {}) => {
  const out = execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8',
    env: { ...gitEnv, FLOW_CRON_JOB: '', FLOW_STATE: state, ...env },
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

// -------------------------------------------------------------------------- sanction helpers
const sanction = (overrides = {}) => {
  const issued = Date.now()
  const body = {
    schema: 1,
    repo: SLUG,
    branch: BRANCH,
    expectedBase: 'main',
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

const MERGE = `gh pr merge ${PR} --squash --match-head-commit ${head}`
const QUOTED = `bash -lc 'gh pr merge ${PR} --squash --match-head-commit ${head}'`

// ------------------------------------------------------------------------- classification
console.log('operation classification')
check('gh pr merge is an operation', JSON.stringify(publishOperations(MERGE)) === '["gh-pr-merge"]')
check('npm publish is an operation', JSON.stringify(publishOperations('npm publish --access public')) === '["npm-publish"]')
check('a dry run publishes nothing', JSON.stringify(publishOperations('cargo publish --dry-run')) === '[]')
check('merge in prose is not a merge', JSON.stringify(publishOperations('echo "gh pr merge after review"')) === '[]')
check('ordinary work publishes nothing', JSON.stringify(publishOperations('git status --porcelain')) === '[]')
check('publishReason ignores the merge op', publishReason(MERGE) === null)
const claude = (command) => execFileSync(process.execPath, [CLAUDE_GUARD], {
  input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
}).trim()
check('the Claude guard says nothing about a merge', claude(MERGE) === '')
check('the Claude guard still asks about cargo publish', claude('cargo publish').includes('permissionDecision'))
check('a quoted merge is invisible to the shallow read', JSON.stringify(publishOperations(QUOTED)) === '[]')
check('the strict read finds it', JSON.stringify(publishOperationsStrict(QUOTED)) === '["gh-pr-merge"]')
check('the Claude guard is untouched by the strict read', claude(QUOTED) === '')
check(
  'a quoted registry publish is found too',
  JSON.stringify(publishOperationsStrict("bash -lc 'npm publish --access public'")) === '["npm-publish"]',
)
check(
  'prose inside a quoted payload is still prose',
  JSON.stringify(publishOperationsStrict(`bash -lc 'echo "run gh pr merge once CI is green"'`)) === '[]',
)

console.log('\nthe merge tripwire')
check('a bare merge is merge-shaped', mergeShapes(`gh pr merge ${PR}`).length === 1, JSON.stringify(mergeShapes(`gh pr merge ${PR}`)))
check('so is one wrapped in a shell', mergeShapes(QUOTED).length === 1, JSON.stringify(mergeShapes(QUOTED)))
check('so is one under eval', mergeShapes(`eval "gh pr merge ${PR} --squash"`).length === 1)
check('so is the REST endpoint', mergeShapes(`gh api repos/${SLUG}/pulls/${PR}/merge -X PUT`).length === 1)
check('so is the GraphQL mutation', mergeShapes("gh api graphql -f query='mutation { mergePullRequest(input: {}) { number } }'").length === 1)
check(
  'a semicolon inside a quoted flag value does not hide the merge',
  mergeShapes(`gh pr merge ${PR} --squash -b "one; two"`).length === 1,
)
check('the executor is not merge-shaped', JSON.stringify(mergeShapes(`node ${EXECUTOR} ${PR}`)) === '[]')
check(
  'wherever it is installed',
  JSON.stringify(mergeShapes(`node /home/x/.claude/plugins/flow/scripts/land-merge.mjs ${PR}`)) === '[]',
)
check('a commit message about merging is not merge-shaped', JSON.stringify(mergeShapes('git commit -m "gh pr merge once CI is green"')) === '[]')
check('nor is a comment quoting the command', JSON.stringify(mergeShapes(`gh pr comment ${PR} -b "run gh pr merge once green"`)) === '[]')
check('nor is reading the pull request', JSON.stringify(mergeShapes(`gh pr view ${PR} --json state,mergeCommit`)) === '[]')
check('nor is git merge', JSON.stringify(mergeShapes('git merge --ff-only origin/main')) === '[]')

// ---------------------------------------------------------------- the guard, managed repo
console.log('\nin a repo with .flow/managed, merging by hand is denied')
clearSanction()
denies('a plain merge is denied', MERGE, 'node ')
denies('and the denial names the executor', MERGE, EXECUTOR)
denies('and says the repository opted in', MERGE, '.flow/managed')
denies('a bare merge is denied', `gh pr merge ${PR}`, 'gh pr merge')
denies('a merge wrapped in bash -lc is denied', QUOTED, 'gh pr merge')
denies('a merge under eval is denied', `eval "gh pr merge ${PR} --squash"`, 'gh pr merge')
denies('the -R form is denied', `gh -R ${SLUG} pr merge ${PR} --squash`, 'gh pr merge')
denies('the REST endpoint is denied', `gh api repos/${SLUG}/pulls/${PR}/merge -X PUT -f merge_method=squash`, 'merge endpoint')
denies('a quoted REST path is denied', `gh api -X PUT "repos/${SLUG}/pulls/${PR}/merge"`, 'merge endpoint')
denies(
  'the GraphQL mutation is denied',
  `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "abc"}) { clientMutationId } }'`,
  'mergePullRequest',
)
denies('a subdirectory of the repo is still the repo', MERGE, EXECUTOR, { cwd: join(repo, 'src') })
denies('a directory git cannot read fails closed', MERGE, EXECUTOR, { cwd: join(tmp, 'nowhere') })
denies('a committed marker with a deleted worktree copy is still managed', MERGE, EXECUTOR, { cwd: mdel })
allows('the executor itself is not denied', `node ${EXECUTOR} ${PR}`)
allows('nor is it from another install path', `node /home/x/.claude/plugins/flow/scripts/land-merge.mjs ${PR}`)
allows('nor is it by relative path', `node plugins/flow/scripts/land-merge.mjs ${PR}`)

console.log('\nin a repo without the marker, flow gates no merges')
allows('a plain merge passes', MERGE, { cwd: plain })
allows('so does the REST endpoint', `gh api repos/someone/unmanaged/pulls/${PR}/merge -X PUT`, { cwd: plain })
allows('so does a merge wrapped in bash -lc', QUOTED, { cwd: plain })

console.log('\nregistry publication is denied in both')
const PLAIN = 'This publishes to crates.io, which you cannot take back - crates.io has no unpublish at all. ' +
  'Confirm the version number and the contents are what you mean to ship. ' +
  'Codex PreToolUse hooks cannot request confirmation, so direct publication is blocked. ' +
  'Run the publish command yourself after reviewing the version and package contents.'
const plainDecision = guard('cargo publish -p flow')
check('the plain publication deny text is unchanged', reasonOf(plainDecision).startsWith(PLAIN), reasonOf(plainDecision))
denies('npm publish, managed', 'npm publish', 'registry publication stays manual')
denies('npm publish, unmanaged', 'npm publish', 'registry publication stays manual', { cwd: plain })
denies('a quoted registry publish, managed', "bash -lc 'npm publish'", 'registry publication stays manual')
denies('a quoted registry publish, unmanaged', "bash -lc 'npm publish'", 'registry publication stays manual', { cwd: plain })

console.log('\nscheduled jobs merge nothing anywhere, executor included')
denies('a cron job is denied in a managed repo', MERGE, 'scheduled jobs do not merge', { env: { FLOW_CRON_JOB: 'lint' } })
denies('and in an unmanaged one', MERGE, 'scheduled jobs do not merge', { cwd: plain, env: { FLOW_CRON_JOB: 'lint' } })
denies('a cron job may not invoke the executor', `node ${EXECUTOR} ${PR}`, 'merge executor', { env: { FLOW_CRON_JOB: 'lint' } })
denies(
  'even after stripping the variable off the child',
  `env -u FLOW_CRON_JOB node ${EXECUTOR} ${PR}`,
  'merge executor',
  { env: { FLOW_CRON_JOB: 'lint' } },
)
allows('but the executor invocation is fine in an attended session', `node ${EXECUTOR} ${PR}`)

console.log('\nthe model may not approve itself')
denies('writing the sanction path is denied', `echo '{}' > ${SANCTION}`, 'directly')
denies('naming the sanction file is denied', 'mv /tmp/x.json ~/.local/state/flow/release-sanction.json', 'names the release sanction file')
denies('running the helper is denied', `node ${HELPER} approve --repo ${SLUG} --branch ${BRANCH} --head ${head} --pr ${PR} --op gh-pr-merge`, 'runs the release sanction helper')
denies('revoking through the helper is denied', 'node plugins/flow/scripts/release-sanction.mjs revoke', 'runs the release sanction helper')
allows('staging the helper file is ordinary work', 'git add plugins/flow/scripts/release-sanction.mjs')

console.log('\nordinary commands are untouched')
sanction()
allows('git status', 'git status --porcelain')
allows('git add', 'git add -A plugins/flow')
allows('git commit', 'git commit -m "fix(flow): close release-sanction bypasses"')
allows('git push', 'git push -u origin feat/issue-6-land-cross-harness')
allows('git commit describing a merge', 'git commit -m "chore: note that gh pr merge is the only land path"')
allows('a test run', 'npm test -- --watch=false')
allows('a dry run', 'cargo publish --dry-run')
allows('a dry run through a shell', "bash -lc 'cargo publish --dry-run'")
allows('a merge described in prose', `gh pr comment ${PR} -b "run gh pr merge once CI is green"`)
allows('reading a PR', `gh pr view ${PR} --json state,mergeCommit`)
allows('a local merge', 'git merge --ff-only origin/main')
check('the guard never touches the sanction', existsSync(SANCTION))
check('not even when it denies a merge', (guard(MERGE), existsSync(SANCTION)))

// ------------------------------------------------------------------------------ the executor
console.log('\nthe executor merges once, pinning every call to the origin repository')
clearSanction()
clearTombstones()
sanction()
const merged = runExecutor([String(PR)])
check('it exits 0', merged.code === 0, `${merged.stdout}${merged.stderr}`)
check('and says what it merged', merged.stdout.includes(`merged #${PR} on ${IDENTITY}`), merged.stdout)
check('it merged exactly once', merged.merges.length === 1, JSON.stringify(merged.merges))
check(
  'with --repo, --squash and the sanctioned head',
  JSON.stringify(merged.merges[0]) === JSON.stringify(['pr', 'merge', String(PR), '--repo', IDENTITY, '--squash', '--match-head-commit', head]),
  JSON.stringify(merged.merges[0]),
)
check('every gh call is pinned to the origin repository', merged.calls.every(isPinned), JSON.stringify(merged.calls.filter((a) => !isPinned(a))))
check('it read the live pull request first', merged.calls.some((a) => a[0] === 'pr' && a[1] === 'view'))
check('and the repository default branch', merged.calls.some((a) => a[0] === 'repo' && a[1] === 'view'))
check('and checked the base for a merge queue', merged.calls.some((a) => a[0] === 'api' && a[1] === 'graphql'))
check('the sanction is spent', !existsSync(SANCTION))
check('a tombstone records the use', tombstones('consumed').length === 1, JSON.stringify(tombstones('consumed')))

console.log('\na stray GH_REPO cannot redirect the executor')
clearSanction()
clearTombstones()
sanction()
const redirected = runExecutor([String(PR)], { env: { GH_REPO: 'someone/evil', GH_HOST: 'evil.example' } })
check('it still merges the origin repository', redirected.code === 0, `${redirected.stdout}${redirected.stderr}`)
check('and every call stayed pinned', redirected.calls.every(isPinned), JSON.stringify(redirected.calls.filter((a) => !isPinned(a))))

console.log('\na read GitHub redirected to another repository is refused')
clearSanction()
clearTombstones()
sanction()
const wrongUrl = runExecutor([String(PR)], { st: freshState({ pr: { url: 'https://github.com/someone/evil/pull/12' } }) })
check('it refuses on the mismatched url', wrongUrl.code === 1 && wrongUrl.stderr.includes('was redirected'), wrongUrl.stderr)
check('and merged nothing', wrongUrl.merges.length === 0, JSON.stringify(wrongUrl.merges))

console.log('\nthe executor refuses, and spends the sanction doing it')
const executorDenies = (name, args, substring, { sanctionOverrides, st, env, cwd, merges = 0, verdict = 'denied' } = {}) => {
  clearTombstones()
  sanction(sanctionOverrides)
  const result = runExecutor(args, { st, env, cwd })
  check(name, result.code === 1 && result.stderr.includes(substring), `code ${result.code}: ${(result.stderr || result.stdout).trim()}`)
  check(`${name}: merged ${merges}`, result.merges.length === merges, JSON.stringify(result.merges))
  check(
    `${name}: the claim is tombstoned as ${verdict}`,
    !existsSync(SANCTION) && tombstones(verdict).length === 1,
    `sanction ${existsSync(SANCTION)}, ${verdict} tombstones ${JSON.stringify(tombstones(verdict))}`,
  )
}

executorDenies('another pull request number is refused', ['13'], 'asked to merge #13')
executorDenies('another repository is refused', [String(PR)], 'the sanction is for repository', { sanctionOverrides: { repo: 'someone/else' } })
executorDenies('another branch is refused', [String(PR)], 'the sanction is for branch', { sanctionOverrides: { branch: 'feat/other' } })
executorDenies('a moved head is refused', [String(PR)], 'the head has moved', { sanctionOverrides: { head: 'b'.repeat(40) } })
executorDenies('a closed pull request is refused', [String(PR)], 'only an open pull request', { st: freshState({ pr: { state: 'CLOSED' } }) })
executorDenies('an already merged one is refused', [String(PR)], 'only an open pull request', { st: freshState({ pr: { state: 'MERGED' } }) })
executorDenies('a draft is refused', [String(PR)], 'is a draft', { st: freshState({ pr: { isDraft: true } }) })
executorDenies(
  'a base other than the default branch is refused',
  [String(PR)], 'lands on the default branch', { st: freshState({ pr: { baseRefName: 'release/1.x' } }) },
)
executorDenies(
  'an expected-base mismatch is refused',
  [String(PR)], 'approved a merge onto', { sanctionOverrides: { expectedBase: 'release/1.x' } },
)
executorDenies('an expired sanction is refused', [String(PR)], 'expired at', {
  sanctionOverrides: {
    issuedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  },
})
executorDenies('a sanction issued in the future is refused', [String(PR)], 'in the future', {
  sanctionOverrides: {
    issuedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  },
})
executorDenies('an oversized window is refused', [String(PR)], 'more than 30 minutes', {
  sanctionOverrides: { expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() },
})
executorDenies('a backdated issue time is refused', [String(PR)], 'more than 30 minutes', {
  sanctionOverrides: {
    issuedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  },
})
executorDenies('another schema version is refused', [String(PR)], 'schema', { sanctionOverrides: { schema: 2 } })
executorDenies('a sanction with no pull request number is refused', [String(PR)], 'names no pull request number', { sanctionOverrides: { prNumber: undefined } })
executorDenies('a sanction with no expected base is refused', [String(PR)], 'no expected base branch', { sanctionOverrides: { expectedBase: undefined } })
executorDenies('a registry operation is refused', [String(PR)], 'no sanction covers registry publication', { sanctionOverrides: { operations: ['npm-publish'] } })
executorDenies(
  'a sanction covering more than the merge is refused',
  [String(PR)], 'a merge is approved on its own', { sanctionOverrides: { operations: ['gh-pr-merge', 'gh-pr-close'] } },
)
executorDenies('a directory with no origin remote is refused', [String(PR)], 'no readable origin remote', { cwd: norepo })

// Never leave an armed future merge behind. Both are caught before the merge call.
executorDenies(
  'a pull request with auto-merge already armed is refused',
  [String(PR)], 'auto-merge armed', { st: freshState({ pr: { autoMergeRequest: { enabledBy: { login: 'bot' } } } }) },
)
executorDenies(
  'a base carrying a merge queue is refused before mutating',
  [String(PR)], 'uses a merge queue', { st: freshState({ mergeQueue: { id: 'MQ_kwABC' } }) },
)
executorDenies(
  'an unreadable merge-queue status is refused',
  [String(PR)], 'could not be read', { st: freshState({ graphqlFails: true }) },
)

// The last re-read of base and head, right before the merge, catches a retarget the first read
// did not see.
executorDenies(
  'a retarget between the check and the merge is refused',
  [String(PR)], 'was retargeted to', { st: freshState({ recheckBase: 'release/9.x' }) },
)
executorDenies(
  'a head moved between the check and the merge is refused',
  [String(PR)], 'moved between the check and the merge', { st: freshState({ recheckHead: 'c'.repeat(40) }) },
)

// The merge ran and gh reported failure; the confirming read shows the pull request still open.
executorDenies('a gh merge that fails and stays open is reported', [String(PR)], '`gh pr merge` failed', {
  st: freshState({ mergeExit: 1, mergeStderr: 'X Pull request #12 is not mergeable: the head commit has changed\n' }),
  merges: 1,
})
executorDenies('a merge that reports success but lands nothing is refused', [String(PR)], 'rather than MERGED', {
  st: freshState({ mergeLandsNothing: true }),
  merges: 1,
})

// A lost confirming read is UNKNOWN, not denied: the merge may or may not have landed.
console.log('\nan unconfirmable outcome is reported UNKNOWN, not denied')
clearTombstones()
sanction()
const unknown = runExecutor([String(PR)], { st: freshState({ mergeExit: 1, confirmFails: true }) })
check('it reports it could not confirm', unknown.code === 1 && unknown.stderr.includes('could not confirm'), unknown.stderr)
check('it does not claim the merge was denied', !unknown.stderr.includes('refused'), unknown.stderr)
check('it merged once', unknown.merges.length === 1, JSON.stringify(unknown.merges))
check('the claim is tombstoned as unknown', !existsSync(SANCTION) && tombstones('unknown').length === 1, JSON.stringify(tombstones('unknown')))

console.log('\nthings the executor refuses before it claims anything')
clearTombstones()
clearSanction()
const noSanction = runExecutor([String(PR)])
check('with no sanction it refuses', noSanction.code === 1 && noSanction.stderr.includes('no release sanction is on file'), noSanction.stderr)
check('and calls gh not at all', noSanction.calls.length === 0, JSON.stringify(noSanction.calls))
check('and leaves no tombstone, having claimed nothing', tombstones('denied').length === 0)

sanction()
writeFileSync(SANCTION, '{ this is not json')
const malformed = runExecutor([String(PR)])
check('a malformed sanction is refused', malformed.code === 1 && malformed.stderr.includes('could not be read as an object'), malformed.stderr)
check('and it was still spent', !existsSync(SANCTION))

clearTombstones()
sanction()
const cron = runExecutor([String(PR)], { env: { FLOW_CRON_JOB: 'lint' } })
check('a scheduled job cannot merge', cron.code === 1 && cron.stderr.includes('nobody is watching'), cron.stderr)
check('and the sanction survives', existsSync(SANCTION))
const notANumber = runExecutor(['twelve'])
check('a pull request number that is not a number exits 2', notANumber.code === 2, notANumber.stderr)
const noArgs = runExecutor([])
check('no argument exits 2', noArgs.code === 2, noArgs.stderr)
const tooMany = runExecutor([String(PR), '--admin'])
check('a second argument exits 2', tooMany.code === 2, tooMany.stderr)
check('none of those spent the sanction', existsSync(SANCTION))

// ---------------------------------------------------------------- two executors, one sanction
// rename() is the lock. This one needs real processes, so it uses a fake gh on PATH the way the
// production CLI resolves the real one. Whichever process moves the file first owns the
// approval; the other gets ENOENT and never reaches gh.
console.log('\ntwo runs racing for one sanction')
const ghLog = join(tmp, 'gh-calls.log')
const ghState = join(tmp, 'gh-state.json')
const ghImpl = join(tmp, 'gh-impl.mjs')
writeFileSync(ghImpl, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(argv) + '\\n')
const path = process.env.FAKE_GH_STATE
const state = JSON.parse(readFileSync(path, 'utf8'))
const say = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0) }
if (argv[0] === 'pr' && argv[1] === 'view') {
  const ji = argv.indexOf('--json'); const fields = ji >= 0 ? argv[ji + 1] : ''
  if (fields === 'state') say({ state: state.merged ? 'MERGED' : state.pr.state })
  if (fields === 'baseRefName,headRefOid') say({ baseRefName: state.pr.baseRefName, headRefOid: state.pr.headRefOid })
  say({ ...state.pr })
}
if (argv[0] === 'repo' && argv[1] === 'view') say({ defaultBranchRef: { name: state.defaultBranch } })
if (argv[0] === 'api' && argv[1] === 'graphql') say({ data: { repository: { mergeQueue: null } } })
if (argv[0] === 'pr' && argv[1] === 'merge') {
  state.merged = true
  writeFileSync(path, JSON.stringify(state))
  process.stdout.write('fake gh: merged\\n'); process.exit(0)
}
process.stderr.write('fake gh: unexpected ' + argv.join(' ') + '\\n'); process.exit(3)
`)
writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(ghImpl)} "$@"\n`, { mode: 0o755 })
writeFileSync(ghLog, '')
writeFileSync(ghState, JSON.stringify({
  defaultBranch: 'main', merged: false,
  pr: { headRefOid: head, headRefName: BRANCH, state: 'OPEN', isDraft: false, baseRefName: 'main', url: `https://github.com/${SLUG}/pull/${PR}`, autoMergeRequest: null },
}))
const mergeCalls = () => readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((a) => a[0] === 'pr' && a[1] === 'merge')

clearTombstones()
sanction()
const raceEnv = { ...gitEnv, FLOW_CRON_JOB: '', FLOW_STATE: state, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_LOG: ghLog, FAKE_GH_STATE: ghState }
const executorAsync = () => new Promise((resolve) => {
  const child = spawn(process.execPath, [EXECUTOR, String(PR)], { cwd: repo, env: raceEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  child.stderr.on('data', (chunk) => { err += chunk })
  child.on('close', (code) => resolve({ code, stderr: err }))
})
const race = await Promise.all([executorAsync(), executorAsync()])
check('exactly one of the two merges', race.filter((r) => r.code === 0).length === 1, JSON.stringify(race))
check('and gh saw exactly one merge', mergeCalls().length === 1, JSON.stringify(mergeCalls()))
check(
  'the loser is told the sanction is gone',
  race.some((r) => r.code === 1 && r.stderr.includes('another run claimed it first')),
  JSON.stringify(race),
)
check('and the sanction is spent', !existsSync(SANCTION))

// ------------------------------------------------------------------------ the policy itself
console.log('\nthe policy on its own')
const facts = {
  slug: SLUG, host: 'github.com', number: PR, branch: BRANCH, head, state: 'OPEN', isDraft: false, base: 'main', defaultBranch: 'main',
}
const good = { schema: 1, repo: SLUG, branch: BRANCH, expectedBase: 'main', head, prNumber: PR, operations: ['gh-pr-merge'] }
const timed = (body) => ({
  ...body,
  issuedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
})
const verdict = (over = {}, pr = {}) => releaseVerdict({
  operations: ['gh-pr-merge'], sanction: timed({ ...good, ...over }), pr: { ...facts, ...pr }, nowMs: Date.now(),
})
check('the matching case allows', verdict().allowed, verdict().reason)
check('the reason is host-qualified', verdict().reason.includes(`github.com/${SLUG}`), verdict().reason)
check('a registry operation is refused on its own terms', releaseVerdict({
  operations: ['npm-publish'], sanction: timed(good), pr: facts, nowMs: Date.now(),
}).reason.includes('never sanctioned'))
check('no sanction denies', releaseVerdict({ operations: ['gh-pr-merge'], sanction: null, pr: facts, nowMs: Date.now() }).reason.includes('could not be read'))
check('no facts deny', releaseVerdict({ operations: ['gh-pr-merge'], sanction: timed(good), pr: null, nowMs: Date.now() }).reason.includes('no pull request facts'))
check('an unreadable clock denies', releaseVerdict({ operations: ['gh-pr-merge'], sanction: timed(good), pr: facts, nowMs: NaN }).reason.includes('clock value'))
check('a string pull request number denies', verdict({ prNumber: '12' }).reason.includes('names no pull request number'))
check('an unreadable head denies', verdict({}, { head: 'not-a-sha' }).reason.includes('40-character'))
check('an unreadable draft flag denies', verdict({}, { isDraft: null }).reason.includes('cannot be shown ready'))
check('an unreadable default branch denies', verdict({}, { defaultBranch: null }).reason.includes('default branch could not be read'))
check('an unreadable state denies', verdict({}, { state: null }).reason.includes('only an open pull request'))
check('a missing expected base denies', verdict({ expectedBase: undefined }).reason.includes('no expected base branch'))
check('an expected-base mismatch denies', verdict({ expectedBase: 'release/1.x' }).reason.includes('approved a merge onto'))

// ------------------------------------------------------------------------------ the helper
console.log('\nthe human helper')
clearSanction()
clearTombstones()
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
const approveArgs = (...extra) => ['approve', '--repo', SLUG, '--branch', BRANCH, '--head', head, '--pr', String(PR), '--op', 'gh-pr-merge', ...extra]
const approved = helper(approveArgs())
check('approve succeeds', approved.code === 0, approved.stderr)
check('the sanction is mode 0600', (statSync(SANCTION).mode & 0o777) === 0o600, (statSync(SANCTION).mode & 0o777).toString(8))
check('it records the pull request number', JSON.parse(readFileSync(SANCTION, 'utf8')).prNumber === PR)
check('it defaults the expected base to main', JSON.parse(readFileSync(SANCTION, 'utf8')).expectedBase === 'main')
const endToEnd = runExecutor([String(PR)])
check('the executor honors what the helper wrote', endToEnd.code === 0, `${endToEnd.stdout}${endToEnd.stderr}`)
check('and merged once', endToEnd.merges.length === 1, JSON.stringify(endToEnd.merges))

const withBase = helper(approveArgs('--base', 'release/2.x'))
check('an explicit --base is recorded', withBase.code === 0 && JSON.parse(readFileSync(SANCTION, 'utf8')).expectedBase === 'release/2.x', withBase.stderr)

const noPr = helper(['approve', '--repo', SLUG, '--branch', BRANCH, '--head', head, '--op', 'gh-pr-merge'])
check('approve without --pr is refused', noPr.code === 2 && noPr.stderr.includes('--pr <number> is required'), noPr.stderr)
const badPr = helper(approveArgs().map((arg) => (arg === String(PR) ? 'twelve' : arg)))
check('a pull request number that is not a number is refused', badPr.code === 2, badPr.stderr)

const registryOp = helper(['approve', '--repo', SLUG, '--branch', BRANCH, '--head', head, '--op', 'npm-publish'])
check(
  'approving a registry publication is refused',
  registryOp.code === 2 && registryOp.stderr.includes('registry publication stays manual'),
  registryOp.stderr,
)

const cronApprove = helper(approveArgs(), { FLOW_CRON_JOB: 'lint' })
check('approve refuses under FLOW_CRON_JOB', cronApprove.code === 2 && cronApprove.stderr.includes('unattended'), cronApprove.stderr)

const typo = helper(['approve', '--repo', SLUG, '--branch', BRANCH, '--head', head, '--pr', String(PR), '--op', 'gh-pr-mrege'])
check('an unknown operation id is refused', typo.code === 2 && typo.stderr.includes('unknown operation'), typo.stderr)
const longTtl = helper(approveArgs('--ttl-minutes', '600'))
check('a ttl beyond 30 minutes is refused', longTtl.code === 2 && longTtl.stderr.includes('between 1 and 30'), longTtl.stderr)
const shortSha = helper(['approve', '--repo', SLUG, '--branch', BRANCH, '--head', head.slice(0, 12), '--pr', String(PR), '--op', 'gh-pr-merge'])
check('an abbreviated SHA is refused', shortSha.code === 2 && shortSha.stderr.includes('40-character'), shortSha.stderr)
const removed = helper(['revoke'])
check('revoke removes the sanction on file', removed.code === 0 && removed.stdout.includes('revoked'), removed.stdout)
const revoked = helper(['revoke'])
check('revoke reports an empty path when there is none', revoked.code === 0 && revoked.stdout.includes('no sanction on file'), revoked.stdout)

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nrelease path: ALL PASS' : `\nrelease path: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
