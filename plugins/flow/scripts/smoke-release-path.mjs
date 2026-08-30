#!/usr/bin/env node
// Smoke harness for flow's release path: hooks/scripts/publish-guard-codex.mjs (the tripwire),
// scripts/land-merge.mjs (the executor that actually merges), lib/release-sanction.mjs (the
// policy both sides of that split agree on), and scripts/release-sanction.mjs (the human's
// half).
//
// Two throwaway git repositories, because "managed" is now a property of the repository: one
// with a committed .flow/managed marker, one without. A fake `gh` on PATH records every argv
// it is handed and answers from a canned state file, so the executor's GitHub reads and its
// one merge call are observable without an account, a network, or a real pull request.
//
// Nothing here reimplements what it tests. Every case asserts what the guard decided, or what
// the executor did and what it left behind.
//
// Every sanction is good for one attempt, pass or fail, so each executor case writes a fresh
// one first. That is the executor's claim-then-verify behavior showing through the test, not
// bookkeeping noise.
//
// Run: node plugins/flow/scripts/smoke-release-path.mjs

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mergeShapes, publishOperations, publishOperationsStrict, publishReason } from '../lib/hook-policy.mjs'
import { releaseVerdict } from '../lib/release-sanction.mjs'

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

// --------------------------------------------------------------- two throwaway repositories
const tmp = mkdtempSync(join(tmpdir(), 'flow-release-path-'))
const repo = join(tmp, 'repo')       // opts into flow: .flow/managed is committed
const plain = join(tmp, 'plain')     // does not
const norepo = join(tmp, 'norepo')   // not a git repository at all
const state = join(tmp, 'state')
const bin = join(tmp, 'bin')
const SANCTION = join(state, 'release-sanction.json')
for (const dir of [repo, plain, norepo, state, bin]) mkdirSync(dir)

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

const SLUG = 'jakub/marketplace-plugins'
const PR = 12
const BRANCH = 'feat/thing'

git('init', '-q', '-b', 'main')
git('remote', 'add', 'origin', `git@github.com:${SLUG}.git`)
mkdirSync(join(repo, '.flow'))
writeFileSync(join(repo, '.flow', 'managed'), 'this repository opts into flow\n')
mkdirSync(join(repo, 'src'))
git('add', '.flow/managed')
const head = commit('first')

const plainGit = gitIn(plain)
plainGit('init', '-q', '-b', 'main')
plainGit('remote', 'add', 'origin', 'git@github.com:someone/unmanaged.git')

// ------------------------------------------------------------------------------- a fake gh
// A shell wrapper so the shim is unambiguously a program on PATH, and an ESM implementation
// behind it so it can read and write JSON without ceremony.
const ghLog = join(tmp, 'gh-calls.log')
const ghState = join(tmp, 'gh-state.json')
const ghImpl = join(tmp, 'gh-impl.mjs')
writeFileSync(ghImpl, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(argv) + '\\n')
const path = process.env.FAKE_GH_STATE
const state = JSON.parse(readFileSync(path, 'utf8'))
const say = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0) }

if (argv[0] === 'repo' && argv[1] === 'view') say({ defaultBranchRef: { name: state.defaultBranch } })
if (argv[0] === 'pr' && argv[1] === 'view') say(state.merged ? { ...state.pr, state: 'MERGED' } : state.pr)
if (argv[0] === 'pr' && argv[1] === 'merge') {
  if (state.mergeExit) {
    process.stderr.write(state.mergeStderr || 'fake gh: refusing to merge\\n')
    process.exit(state.mergeExit)
  }
  if (state.mergeLandsNothing !== true) {
    state.merged = true
    writeFileSync(path, JSON.stringify(state))
  }
  process.stdout.write('fake gh: merged\\n')
  process.exit(0)
}
process.stderr.write('fake gh: unexpected call ' + argv.join(' ') + '\\n')
process.exit(3)
`)
writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(ghImpl)} "$@"\n`, { mode: 0o755 })

const ghReset = (overrides = {}) => {
  writeFileSync(ghLog, '')
  writeFileSync(ghState, JSON.stringify({
    defaultBranch: 'main',
    merged: false,
    mergeExit: 0,
    ...overrides,
    pr: {
      headRefOid: head,
      headRefName: BRANCH,
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      url: `https://github.com/${SLUG}/pull/${PR}`,
      ...(overrides.pr || {}),
    },
  }))
}
const ghCalls = () => readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const mergeCalls = () => ghCalls().filter((argv) => argv[0] === 'pr' && argv[1] === 'merge')

// -------------------------------------------------------------------- driving the two sides
const runEnv = (env) => ({
  ...gitEnv,
  FLOW_CRON_JOB: '',
  FLOW_STATE: state,
  PATH: `${bin}:${process.env.PATH}`,
  FAKE_GH_LOG: ghLog,
  FAKE_GH_STATE: ghState,
  ...env,
})

const guard = (command, { env = {}, cwd = repo } = {}) => {
  const out = execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8',
    env: runEnv(env),
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

const executor = (args, { cwd = repo, env = {} } = {}) => {
  try {
    const stdout = execFileSync(process.execPath, [EXECUTOR, ...args], {
      cwd, encoding: 'utf8', env: runEnv(env), stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout: String(stdout), stderr: '' }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') }
  }
}

const sanction = (overrides = {}) => {
  const issued = Date.now()
  const body = {
    schema: 1,
    repo: SLUG,
    branch: BRANCH,
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
// The Claude guard asks about registry publication and nothing else. The merge op must not
// have changed that, so it is checked against the real Claude guard too.
check('publishReason ignores the merge op', publishReason(MERGE) === null)
const claude = (command) => execFileSync(process.execPath, [CLAUDE_GUARD], {
  input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
}).trim()
check('the Claude guard says nothing about a merge', claude(MERGE) === '')
check('the Claude guard still asks about cargo publish', claude('cargo publish').includes('permissionDecision'))
// Quoting hides a command from the Claude classifier, which is the prose exemption doing its
// job. The Codex side reads through it instead.
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
// The one thing the tripwire must never catch. It fires on the way in, and the executor is
// the way out; a tripwire that catches its own exit is a gate with nothing behind it.
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
allows('the executor itself is not denied', `node ${EXECUTOR} ${PR}`)
allows('nor is it from another install path', `node /home/x/.claude/plugins/flow/scripts/land-merge.mjs ${PR}`)
allows('nor is it by relative path', `node plugins/flow/scripts/land-merge.mjs ${PR}`)

console.log('\nin a repo without the marker, flow gates no merges')
allows('a plain merge passes', MERGE, { cwd: plain })
allows('so does the REST endpoint', `gh api repos/someone/unmanaged/pulls/${PR}/merge -X PUT`, { cwd: plain })
allows('so does a merge wrapped in bash -lc', QUOTED, { cwd: plain })

console.log('\nregistry publication is denied in both')
// The wording that was in place before the release path existed, preserved exactly.
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

console.log('\nscheduled jobs merge nothing anywhere')
denies('a cron job is denied in a managed repo', MERGE, 'scheduled jobs do not merge', { env: { FLOW_CRON_JOB: 'lint' } })
denies('and in an unmanaged one', MERGE, 'scheduled jobs do not merge', { cwd: plain, env: { FLOW_CRON_JOB: 'lint' } })

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
console.log('\nthe executor merges once')
clearSanction()
clearTombstones()
ghReset()
sanction()
const merged = executor([String(PR)])
check('it exits 0', merged.code === 0, `${merged.stdout}${merged.stderr}`)
check('and says what it merged', merged.stdout.includes(`merged #${PR} on ${SLUG}`), merged.stdout)
check('it merged exactly once', mergeCalls().length === 1, JSON.stringify(mergeCalls()))
check(
  'with --squash and the sanctioned head',
  JSON.stringify(mergeCalls()[0]) === JSON.stringify(['pr', 'merge', String(PR), '--squash', '--match-head-commit', head]),
  JSON.stringify(mergeCalls()[0]),
)
check('it read the live pull request first', ghCalls().some((argv) => argv[0] === 'pr' && argv[1] === 'view'))
check('and the repository default branch', ghCalls().some((argv) => argv[0] === 'repo' && argv[1] === 'view'))
check('and confirmed the merge afterwards', ghCalls().filter((argv) => argv[0] === 'pr' && argv[1] === 'view').length === 2)
check('the sanction is spent', !existsSync(SANCTION))
check('a tombstone records the use', tombstones('consumed').length === 1, JSON.stringify(tombstones('consumed')))

console.log('\nthe executor refuses, and spends the sanction doing it')
const executorDenies = (name, args, substring, { sanctionOverrides, gh, run, merges = 0 } = {}) => {
  clearTombstones()
  sanction(sanctionOverrides)
  ghReset(gh)
  const result = executor(args, run)
  check(name, result.code === 1 && result.stderr.includes(substring), `code ${result.code}: ${(result.stderr || result.stdout).trim()}`)
  check(`${name}: merged nothing`, mergeCalls().length === merges, JSON.stringify(mergeCalls()))
  check(
    `${name}: the claim is tombstoned as denied`,
    !existsSync(SANCTION) && tombstones('denied').length === 1,
    `sanction ${existsSync(SANCTION)}, tombstones ${JSON.stringify(tombstones('denied'))}`,
  )
}

executorDenies('another pull request number is refused', ['13'], 'asked to merge #13')
executorDenies('another repository is refused', [String(PR)], 'the sanction is for repository', { sanctionOverrides: { repo: 'someone/else' } })
executorDenies('another branch is refused', [String(PR)], 'the sanction is for branch', { sanctionOverrides: { branch: 'feat/other' } })
executorDenies('a moved head is refused', [String(PR)], 'the head has moved', { sanctionOverrides: { head: 'b'.repeat(40) } })
executorDenies('a closed pull request is refused', [String(PR)], 'only an open pull request', { gh: { pr: { state: 'CLOSED' } } })
executorDenies('an already merged one is refused', [String(PR)], 'only an open pull request', { gh: { pr: { state: 'MERGED' } } })
executorDenies('a draft is refused', [String(PR)], 'is a draft', { gh: { pr: { isDraft: true } } })
executorDenies(
  'a base other than the default branch is refused',
  [String(PR)], 'lands on the default branch', { gh: { pr: { baseRefName: 'release/1.x' } } },
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
// Backdating the issue time is how a hand-written file would try to buy a standing approval:
// the window from issue to expiry is what gets measured, not the time left.
executorDenies('a backdated issue time is refused', [String(PR)], 'more than 30 minutes', {
  sanctionOverrides: {
    issuedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  },
})
executorDenies('another schema version is refused', [String(PR)], 'schema', { sanctionOverrides: { schema: 2 } })
executorDenies('a sanction with no pull request number is refused', [String(PR)], 'names no pull request number', { sanctionOverrides: { prNumber: undefined } })
executorDenies('a registry operation is refused', [String(PR)], 'no sanction covers registry publication', { sanctionOverrides: { operations: ['npm-publish'] } })
executorDenies(
  'a sanction covering more than the merge is refused',
  [String(PR)], 'a merge is approved on its own', { sanctionOverrides: { operations: ['gh-pr-merge', 'gh-pr-close'] } },
)
executorDenies('a directory with no origin remote is refused', [String(PR)], 'no readable origin remote', { run: { cwd: norepo } })
// The merge ran and failed: gh's own --match-head-commit check is the usual reason. One merge
// call, and the approval is spent, which is the point of claiming before doing anything.
executorDenies('a gh merge that fails is reported', [String(PR)], '`gh pr merge` failed', {
  gh: { mergeExit: 1, mergeStderr: 'X Pull request #12 is not mergeable: the head commit has changed\n' },
  merges: 1,
})
executorDenies('a merge that reports success but lands nothing is refused', [String(PR)], 'rather than MERGED', {
  gh: { mergeLandsNothing: true },
  merges: 1,
})

clearTombstones()
clearSanction()
ghReset()
const noSanction = executor([String(PR)])
check('with no sanction it refuses', noSanction.code === 1 && noSanction.stderr.includes('no release sanction is on file'), noSanction.stderr)
check('and calls gh not at all', ghCalls().length === 0, JSON.stringify(ghCalls()))
check('and leaves no tombstone, having claimed nothing', tombstones('denied').length === 0)

sanction()
writeFileSync(SANCTION, '{ this is not json')
ghReset()
const malformed = executor([String(PR)])
check('a malformed sanction is refused', malformed.code === 1 && malformed.stderr.includes('could not be read as an object'), malformed.stderr)
check('and it was still spent', !existsSync(SANCTION))

console.log('\nthings the executor refuses before it claims anything')
clearTombstones()
sanction()
ghReset()
const cron = executor([String(PR)], { env: { FLOW_CRON_JOB: 'lint' } })
check('a scheduled job cannot merge', cron.code === 1 && cron.stderr.includes('nobody is watching'), cron.stderr)
check('and the sanction survives', existsSync(SANCTION))
const notANumber = executor(['twelve'])
check('a pull request number that is not a number exits 2', notANumber.code === 2, notANumber.stderr)
const noArgs = executor([])
check('no argument exits 2', noArgs.code === 2, noArgs.stderr)
const tooMany = executor([String(PR), '--admin'])
check('a second argument exits 2', tooMany.code === 2, tooMany.stderr)
check('none of those spent the sanction', existsSync(SANCTION))
check('and none of them called gh', ghCalls().length === 0, JSON.stringify(ghCalls()))

// ---------------------------------------------------------------- two executors, one sanction
// rename() is the lock. Whichever process moves the file first owns the approval; the other
// gets ENOENT and stops. Run both at once and count.
console.log('\ntwo runs racing for one sanction')
clearTombstones()
ghReset()
sanction()
const executorAsync = () => new Promise((resolve) => {
  const child = spawn(process.execPath, [EXECUTOR, String(PR)], { cwd: repo, env: runEnv({}), stdio: ['ignore', 'pipe', 'pipe'] })
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
// releaseVerdict is pure, so the shapes that are awkward to stage through a fake gh are
// checked against it directly.
console.log('\nthe policy on its own')
const facts = {
  slug: SLUG, number: PR, branch: BRANCH, head, state: 'OPEN', isDraft: false, base: 'main', defaultBranch: 'main',
}
const good = { schema: 1, repo: SLUG, branch: BRANCH, head, prNumber: PR, operations: ['gh-pr-merge'] }
const timed = (body) => ({
  ...body,
  issuedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
})
const verdict = (over = {}, pr = {}) => releaseVerdict({
  operations: ['gh-pr-merge'], sanction: timed({ ...good, ...over }), pr: { ...facts, ...pr }, nowMs: Date.now(),
})
check('the matching case allows', verdict().allowed, verdict().reason)
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
ghReset()
const endToEnd = executor([String(PR)])
check('the executor honors what the helper wrote', endToEnd.code === 0, `${endToEnd.stdout}${endToEnd.stderr}`)
check('and merged once', mergeCalls().length === 1, JSON.stringify(mergeCalls()))

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
check('and wrote nothing', !existsSync(SANCTION))

const typo = helper(['approve', '--repo', SLUG, '--branch', BRANCH, '--head', head, '--pr', String(PR), '--op', 'gh-pr-mrege'])
check('an unknown operation id is refused', typo.code === 2 && typo.stderr.includes('unknown operation'), typo.stderr)
const longTtl = helper(approveArgs('--ttl-minutes', '600'))
check('a ttl beyond 30 minutes is refused', longTtl.code === 2 && longTtl.stderr.includes('between 1 and 30'), longTtl.stderr)
const shortSha = helper(['approve', '--repo', SLUG, '--branch', BRANCH, '--head', head.slice(0, 12), '--pr', String(PR), '--op', 'gh-pr-merge'])
check('an abbreviated SHA is refused', shortSha.code === 2 && shortSha.stderr.includes('40-character'), shortSha.stderr)
check('none of the refusals left a sanction behind', !existsSync(SANCTION))
const revoked = helper(['revoke'])
check('revoke reports an empty path', revoked.code === 0 && revoked.stdout.includes('no sanction on file'), revoked.stdout)

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nrelease path: ALL PASS' : `\nrelease path: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
