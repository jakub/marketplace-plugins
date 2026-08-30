#!/usr/bin/env node
// Smoke harness for flow's release path: hooks/scripts/publish-guard-codex.mjs (the tripwire
// that routes merges to the executor) and scripts/land-merge.mjs (the executor that actually
// merges).
//
// The executor is a cooperative guardrail, not a security boundary: at one uid a model could
// ignore it. What the cases below prove is that the ordinary path is verified - the executor
// pins every gh call to the host-qualified repository the origin remote names, refuses a
// closed or draft pull request, a non-default base, a merge queue or an armed auto-merge
// before mutating, merges with --match-head-commit pinned to the head it verified, and
// reports honest outcomes afterwards: our confirmed merge, a foreign merge of the same number
// that it will not claim, an authoritative failure, or a genuinely unknown result it tells
// the operator to verify by hand rather than retry.
//
// The executor is driven in process through its exported landMerge() with a fake gh injected as
// a plain function across the module boundary. No environment variable selects the gh binary.
//
// "managed" is a property of the repository: a committed .flow/managed marker enrols it, and a
// deleted working-tree copy does not un-enrol it. The marker probe reads the committed tree, so a
// repository with no HEAD yet cannot be probed and fails closed to managed. These repositories
// cover that - marked, marked-but-worktree-copy-deleted, unmarked-with-a-commit,
// marker-only-untracked, and no-commit-yet - plus one directory that is no repository at all.
//
// Run: node plugins/flow/scripts/smoke-release-path.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mergeShapes, publishOperations, publishOperationsStrict, publishReason } from '../lib/hook-policy.mjs'
import { landMerge } from './land-merge.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = join(ROOT, 'hooks', 'scripts', 'publish-guard-codex.mjs')
const CLAUDE_GUARD = join(ROOT, 'hooks', 'scripts', 'publish-guard.mjs')
const EXECUTOR = join(ROOT, 'scripts', 'land-merge.mjs')

let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` → ${detail}`}`)
}

// --------------------------------------------------------------- the throwaway repositories
const tmp = mkdtempSync(join(tmpdir(), 'flow-release-path-'))
const repo = join(tmp, 'repo')       // opts into flow: .flow/managed is committed and present
const mdel = join(tmp, 'mdel')       // .flow/managed is committed but the worktree copy is gone
const plain = join(tmp, 'plain')     // no marker, one commit so HEAD is readable
const muntr = join(tmp, 'muntr')     // .flow/managed exists only untracked: NOT enrolled
const nohead = join(tmp, 'nohead')   // a repository with no commit yet: the marker probe errors
const ghe = join(tmp, 'ghe')         // origin on a GitHub Enterprise host, same owner/name slug
const norepo = join(tmp, 'norepo')   // not a git repository at all
for (const dir of [repo, mdel, plain, muntr, nohead, ghe, norepo]) mkdirSync(dir)

const SLUG = 'jakub/marketplace-plugins'
const IDENTITY = 'github.com/jakub/marketplace-plugins'
const GHE_HOST = 'ghe.example.com'
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

// plain: no marker, but one commit, so `git ls-tree HEAD` reads back cleanly empty (unmanaged).
const plainGit = gitIn(plain)
plainGit('init', '-q', '-b', 'main')
plainGit('remote', 'add', 'origin', 'git@github.com:someone/unmanaged.git')
writeFileSync(join(plain, 'file.txt'), 'plain\n')
plainGit('add', 'file.txt')
plainGit('commit', '-q', '-m', 'first')

// muntr: the marker exists in the working tree but was never committed. Enrollment is the
// marker committed at HEAD, so this repository is NOT managed - a stray file dropped into an
// unrelated clone must not turn the merge guardrail on there.
const muntrGit = gitIn(muntr)
muntrGit('init', '-q', '-b', 'main')
muntrGit('remote', 'add', 'origin', 'git@github.com:someone/untracked.git')
writeFileSync(join(muntr, 'file.txt'), 'muntr\n')
muntrGit('add', 'file.txt')
muntrGit('commit', '-q', '-m', 'first')
mkdirSync(join(muntr, '.flow'))
writeFileSync(join(muntr, '.flow', 'managed'), 'never committed\n')

// nohead: initialized with a remote but no commit, so HEAD is unborn and the marker probe
// errors rather than answering. The guard must fail closed to managed on that error.
const noheadGit = gitIn(nohead)
noheadGit('init', '-q', '-b', 'main')
noheadGit('remote', 'add', 'origin', 'git@github.com:someone/nohead.git')

// ghe: same owner/name as the managed repo, but the origin is a GitHub Enterprise host. The
// executor must derive and pin the host-qualified identity, not assume github.com.
const gheGit = gitIn(ghe)
gheGit('init', '-q', '-b', 'main')
gheGit('remote', 'add', 'origin', `git@${GHE_HOST}:${SLUG}.git`)

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
  // The confirming read after the merge, and the post-merge queue re-read. These default to
  // matching the first read (an honest, clean merge); a case that wants a foreign or armed
  // outcome overrides them.
  afterHead: null,
  afterBase: null,
  afterUrl: null,
  afterAutoMerge: null,
  afterGraphqlFails: false,
  afterMergeQueue: undefined,
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
    if (fields === 'state,headRefOid,baseRefName,url,autoMergeRequest') {
      if (st.confirmFails) return { code: 4, stdout: '', stderr: 'fake gh: view failed\n' }
      return ok({
        state: st.merged ? 'MERGED' : st.pr.state,
        headRefOid: st.afterHead ?? st.pr.headRefOid,
        baseRefName: st.afterBase ?? st.pr.baseRefName,
        url: st.afterUrl ?? st.pr.url,
        autoMergeRequest: st.afterAutoMerge ?? null,
      })
    }
    if (fields === 'baseRefName,headRefOid') {
      return ok({ baseRefName: st.recheckBase ?? st.pr.baseRefName, headRefOid: st.recheckHead ?? st.pr.headRefOid })
    }
    return ok({ ...st.pr })
  }
  if (args[0] === 'repo' && args[1] === 'view') return ok({ defaultBranchRef: { name: st.defaultBranch } })
  if (args[0] === 'api' && args[1] === 'graphql') {
    // The executor reads the merge queue twice: once before mutating, once after a non-MERGED
    // outcome. st.merges records the merge attempt, so a call after it is the post-merge re-read
    // and can carry its own failure or armed-queue answer.
    const afterMerge = st.merges.length > 0
    if (afterMerge ? st.afterGraphqlFails : st.graphqlFails) return { code: 5, stdout: '', stderr: 'fake gh: graphql failed\n' }
    const q = afterMerge && st.afterMergeQueue !== undefined ? st.afterMergeQueue : st.mergeQueue
    return ok({ data: { repository: { mergeQueue: q } } })
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
const pinnedTo = (identity, host) => (args) => {
  if (args[0] === 'api' && args[1] === 'graphql') {
    const hi = args.indexOf('--hostname')
    return hi >= 0 && args[hi + 1] === host
  }
  // `gh repo view` names the repository as a positional; `gh pr view` and `gh pr merge` use --repo.
  if (args[0] === 'repo' && args[1] === 'view') return args[2] === identity
  const ri = args.indexOf('--repo')
  return ri >= 0 && args[ri + 1] === identity
}
const isPinned = pinnedTo(IDENTITY, 'github.com')

const runExecutor = (args, { cwd = repo, env = {}, st } = {}) => {
  const s = st || freshState()
  const result = landMerge({ argv: args, env: { FLOW_CRON_JOB: '', HOME: tmp, ...env }, cwd, runGh: makeRunGh(s) })
  return { code: result.code, stdout: result.stdout, stderr: result.stderr, calls: s.calls, merges: s.merges, st: s }
}

// --------------------------------------------------------------------- the guard, in process
const guard = (command, { env = {}, cwd = repo } = {}) => {
  const out = execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8',
    env: { ...gitEnv, FLOW_CRON_JOB: '', ...env },
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
// Same isolated environment as guard(): a stray FLOW_CRON_JOB in the operator's shell must
// not change what these checks prove.
const claude = (command) => execFileSync(process.execPath, [CLAUDE_GUARD], {
  input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
  env: { ...gitEnv, FLOW_CRON_JOB: '' },
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
console.log('\nin a repo with .flow/managed, merging by hand is routed to the executor')
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
denies('a repo whose HEAD the marker probe cannot list fails closed', MERGE, EXECUTOR, { cwd: nohead })
denies('a committed marker with a deleted worktree copy is still managed', MERGE, EXECUTOR, { cwd: mdel })
allows('the executor itself is not denied', `node ${EXECUTOR} ${PR}`)
allows('nor is it from another install path', `node /home/x/.claude/plugins/flow/scripts/land-merge.mjs ${PR}`)
allows('nor is it by relative path', `node plugins/flow/scripts/land-merge.mjs ${PR}`)

console.log('\nin a repo without the marker, flow gates no merges')
allows('a plain merge passes', MERGE, { cwd: plain })
allows('so does the REST endpoint', `gh api repos/someone/unmanaged/pulls/${PR}/merge -X PUT`, { cwd: plain })
allows('so does a merge wrapped in bash -lc', QUOTED, { cwd: plain })
allows('an uncommitted marker does not enroll a repo', MERGE, { cwd: muntr })

console.log('\nregistry publication is denied in both')
const PLAIN = 'This publishes to crates.io, which you cannot take back - crates.io has no unpublish at all. ' +
  'Confirm the version number and the contents are what you mean to ship. ' +
  'Codex PreToolUse hooks cannot request confirmation, so direct publication is blocked. ' +
  'Run the publish command yourself after reviewing the version and package contents.'
const plainDecision = guard('cargo publish -p flow')
check('the plain publication deny text is unchanged', reasonOf(plainDecision).startsWith(PLAIN), reasonOf(plainDecision))
denies('npm publish, managed', 'npm publish', 'Registry publication stays manual')
denies('npm publish, unmanaged', 'npm publish', 'Registry publication stays manual', { cwd: plain })
denies('a quoted registry publish, managed', "bash -lc 'npm publish'", 'Registry publication stays manual')
denies('a quoted registry publish, unmanaged', "bash -lc 'npm publish'", 'Registry publication stays manual', { cwd: plain })

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

console.log('\nordinary commands are untouched')
allows('git status', 'git status --porcelain')
allows('git add', 'git add -A plugins/flow')
allows('git commit', 'git commit -m "fix(flow): route the land through the executor"')
allows('git push', 'git push -u origin feat/issue-6-land-cross-harness')
allows('git commit describing a merge', 'git commit -m "chore: note that gh pr merge is the only land path"')
allows('a test run', 'npm test -- --watch=false')
allows('a dry run', 'cargo publish --dry-run')
allows('a dry run through a shell', "bash -lc 'cargo publish --dry-run'")
allows('a merge described in prose', `gh pr comment ${PR} -b "run gh pr merge once CI is green"`)
allows('reading a PR', `gh pr view ${PR} --json state,mergeCommit`)
allows('a local merge', 'git merge --ff-only origin/main')

// ------------------------------------------------------------------------------ the executor
console.log('\nthe executor merges once, pinning every call to the origin repository')
const merged = runExecutor([String(PR)])
check('it exits 0', merged.code === 0, `${merged.stdout}${merged.stderr}`)
check('and says what it merged', merged.stdout.includes(`merged #${PR} on ${IDENTITY}`), merged.stdout)
check('it merged exactly once', merged.merges.length === 1, JSON.stringify(merged.merges))
check(
  'with --repo, --squash and the verified head',
  JSON.stringify(merged.merges[0]) === JSON.stringify(['pr', 'merge', String(PR), '--repo', IDENTITY, '--squash', '--match-head-commit', head]),
  JSON.stringify(merged.merges[0]),
)
check('every gh call is pinned to the origin repository', merged.calls.every(isPinned), JSON.stringify(merged.calls.filter((a) => !isPinned(a))))
check('it read the live pull request first', merged.calls.some((a) => a[0] === 'pr' && a[1] === 'view'))
check('and the repository default branch', merged.calls.some((a) => a[0] === 'repo' && a[1] === 'view'))
check('and checked the base for a merge queue', merged.calls.some((a) => a[0] === 'api' && a[1] === 'graphql'))

console.log('\na stray GH_REPO cannot redirect the executor')
const redirected = runExecutor([String(PR)], { env: { GH_REPO: 'someone/evil', GH_HOST: 'evil.example' } })
check('it still merges the origin repository', redirected.code === 0, `${redirected.stdout}${redirected.stderr}`)
check('and every call stayed pinned', redirected.calls.every(isPinned), JSON.stringify(redirected.calls.filter((a) => !isPinned(a))))

console.log('\na read GitHub redirected to another repository is refused')
const wrongUrl = runExecutor([String(PR)], { st: freshState({ pr: { url: 'https://github.com/someone/evil/pull/12' } }) })
check('it refuses on the mismatched url', wrongUrl.code === 1 && wrongUrl.stderr.includes('was redirected'), wrongUrl.stderr)
check('and merged nothing', wrongUrl.merges.length === 0, JSON.stringify(wrongUrl.merges))

console.log('\na GitHub Enterprise origin pins the GHE identity, not github.com')
const gheRun = runExecutor([String(PR)], {
  cwd: ghe,
  st: freshState({ pr: { url: `https://${GHE_HOST}/${SLUG}/pull/${PR}` } }),
})
check('it merges against the GHE host', gheRun.code === 0, `${gheRun.stdout}${gheRun.stderr}`)
check(
  'and every call is pinned to the GHE identity',
  gheRun.calls.every(pinnedTo(`${GHE_HOST}/${SLUG}`, GHE_HOST)),
  JSON.stringify(gheRun.calls.filter((a) => !pinnedTo(`${GHE_HOST}/${SLUG}`, GHE_HOST)(a))),
)
check('a github.com url against a GHE origin is refused', (() => {
  const crossed = runExecutor([String(PR)], { cwd: ghe })
  return crossed.code === 1 && crossed.stderr.includes('was redirected') && crossed.merges.length === 0
})())

console.log('\nthe executor refuses what should not merge, before mutating anything')
const executorRefuses = (name, args, substring, { st, env, cwd, merges = 0 } = {}) => {
  const result = runExecutor(args, { st, env, cwd })
  check(name, result.code === 1 && result.stderr.includes(substring), `code ${result.code}: ${(result.stderr || result.stdout).trim()}`)
  check(`${name}: merged ${merges}`, result.merges.length === merges, JSON.stringify(result.merges))
}

executorRefuses('a closed pull request is refused', [String(PR)], 'only an open pull request', { st: freshState({ pr: { state: 'CLOSED' } }) })
executorRefuses('an already merged one is refused', [String(PR)], 'only an open pull request', { st: freshState({ pr: { state: 'MERGED' } }) })
executorRefuses('a draft is refused', [String(PR)], 'is a draft', { st: freshState({ pr: { isDraft: true } }) })
executorRefuses('an unreadable draft flag is refused', [String(PR)], 'cannot be shown ready', { st: freshState({ pr: { isDraft: null } }) })
executorRefuses('an unreadable head is refused', [String(PR)], '40-character', { st: freshState({ pr: { headRefOid: 'short' } }) })
executorRefuses(
  'a base other than the default branch is refused',
  [String(PR)], 'the default branch is', { st: freshState({ pr: { baseRefName: 'release/1.x' } }) },
)
executorRefuses(
  'an unreadable default branch is refused',
  [String(PR)], 'default branch could not be read', { st: freshState({ defaultBranch: null }) },
)
executorRefuses('a directory with no origin remote is refused', [String(PR)], 'no readable origin remote', { cwd: norepo })

// Never leave an armed future merge behind. Both are caught before the merge call.
executorRefuses(
  'a pull request with auto-merge already armed is refused',
  [String(PR)], 'auto-merge armed', { st: freshState({ pr: { autoMergeRequest: { enabledBy: { login: 'bot' } } } }) },
)
executorRefuses(
  'a base carrying a merge queue is refused before mutating',
  [String(PR)], 'uses a merge queue', { st: freshState({ mergeQueue: { id: 'MQ_kwABC' } }) },
)
executorRefuses(
  'an unreadable merge-queue status is refused',
  [String(PR)], 'could not be read', { st: freshState({ graphqlFails: true }) },
)

// The last re-read of base and head, right before the merge, catches movement the first read
// did not see - a retarget, or a push that raced the gates.
executorRefuses(
  'a retarget between the check and the merge is refused',
  [String(PR)], 'was retargeted to', { st: freshState({ recheckBase: 'release/9.x' }) },
)
executorRefuses(
  'a head moved between the check and the merge is refused',
  [String(PR)], 'moved mid-run', { st: freshState({ recheckHead: 'c'.repeat(40) }) },
)

// The merge ran, gh reported failure, and the confirming read shows a clean OPEN with nothing
// armed. That is the one non-MERGED shape that is an authoritative failure rather than UNKNOWN.
executorRefuses('a gh merge that fails and stays cleanly open is a failure', [String(PR)], '`gh pr merge` failed', {
  st: freshState({ mergeExit: 1, mergeStderr: 'X Pull request #12 is not mergeable: the head commit has changed\n' }),
  merges: 1,
})

// A MERGED read is our success only if the merged pull request is still the one we verified. A
// foreign merge of the same number - a different head - is reported UNKNOWN, never claimed.
executorRefuses('a MERGED read whose head no longer matches is not claimed as our merge', [String(PR)], 'no longer matches', {
  st: freshState({ afterHead: 'd'.repeat(40) }), merges: 1,
})

// A non-MERGED read after the merge call is not automatically a failure. An armed auto-merge, an
// armed or unreadable merge queue, or gh reporting success while the pull request is still open
// are all UNKNOWN: the merge may still land, so a blind retry would be wrong.
executorRefuses('an armed auto-merge after a non-MERGED read is UNKNOWN', [String(PR)], 'auto-merge armed', {
  st: freshState({ mergeExit: 1, afterAutoMerge: { enabledBy: { login: 'bot' } } }), merges: 1,
})
executorRefuses('a merge queue armed only after the merge call is UNKNOWN', [String(PR)], 'merge-queue status is armed', {
  st: freshState({ mergeExit: 1, afterMergeQueue: { id: 'MQ_after' } }), merges: 1,
})
executorRefuses('an unreadable merge queue after the merge call is UNKNOWN', [String(PR)], 'merge-queue status is unreadable', {
  st: freshState({ mergeExit: 1, afterGraphqlFails: true }), merges: 1,
})
executorRefuses('a merge that reports success but lands nothing is UNKNOWN, not a failure', [String(PR)], 'could not confirm', {
  st: freshState({ mergeLandsNothing: true }), merges: 1,
})

// A lost confirming read is UNKNOWN, not refused: the merge may or may not have landed.
console.log('\nan unconfirmable outcome is reported UNKNOWN, not refused')
const unknown = runExecutor([String(PR)], { st: freshState({ mergeExit: 1, confirmFails: true }) })
check('it reports it could not confirm', unknown.code === 1 && unknown.stderr.includes('could not confirm'), unknown.stderr)
check('it does not claim the merge was refused', !unknown.stderr.includes('refused'), unknown.stderr)
check('it merged once', unknown.merges.length === 1, JSON.stringify(unknown.merges))

console.log('\nthings the executor refuses before reading anything')
const cron = runExecutor([String(PR)], { env: { FLOW_CRON_JOB: 'lint' } })
check('a scheduled job cannot merge', cron.code === 1 && cron.stderr.includes('nobody is watching'), cron.stderr)
check('and calls gh not at all', cron.calls.length === 0, JSON.stringify(cron.calls))
const notANumber = runExecutor(['twelve'])
check('a pull request number that is not a number exits 2', notANumber.code === 2, notANumber.stderr)
const noArgs = runExecutor([])
check('no argument exits 2', noArgs.code === 2, noArgs.stderr)
const tooMany = runExecutor([String(PR), '--admin'])
check('a second argument exits 2', tooMany.code === 2, tooMany.stderr)

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nrelease path: ALL PASS' : `\nrelease path: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
