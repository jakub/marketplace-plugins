#!/usr/bin/env node
// Smoke harness for the SHA-bound release path: hooks/scripts/publish-guard-codex.mjs,
// lib/release-sanction.mjs, and scripts/release-sanction.mjs together.
//
// It builds a throwaway git repository with real commits and a fake origin, fabricates the
// hook JSON Codex sends, and runs the real guard as a child process with FLOW_STATE pointed
// at a temp directory. Nothing here reimplements the guard's logic: every case asserts what
// the guard actually decided and why.
//
// Run: node plugins/flow/scripts/smoke-release-path.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { publishOperations, publishReason } from '../lib/hook-policy.mjs'

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
let head = commit('first')

// -------------------------------------------------------------------- driving the guard
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

const sanction = (overrides = {}) => {
  const issued = Date.now()
  const body = {
    schema: 1,
    repo: SLUG,
    branch: 'main',
    head,
    operations: ['gh-pr-merge'],
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + 10 * 60_000).toISOString(),
    ...overrides,
  }
  writeFileSync(SANCTION, JSON.stringify(body, null, 2))
  return body
}
const clearSanction = () => { rmSync(SANCTION, { force: true }) }
const tombstones = () => readdirSync(state).filter((f) => f.startsWith('release-sanction.consumed.'))

const MERGE = 'gh pr merge 12 --squash --delete-branch'

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
denies('a merge with no sanction is denied', MERGE, 'no release sanction is on file')
denies('a registry publication with no sanction is denied', 'npm publish', 'no release sanction is on file')

console.log('\nwith a sanction that does not match')
sanction({ head: 'b'.repeat(40) })
denies('a stale head is denied', MERGE, 'the head has moved')
sanction({ branch: 'feat/other' })
denies('another branch is denied', MERGE, 'the sanction is for branch')
sanction({ repo: 'someone/else' })
denies('another repository is denied', MERGE, 'the sanction is for repository')
sanction({ operations: ['npm-publish'] })
denies('an operation outside the sanction is denied', MERGE, 'does not cover gh-pr-merge')
// A real expiry: issued half an hour ago, ran out a minute ago.
sanction({
  issuedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
})
denies('an expired sanction is denied', MERGE, 'expired at')
sanction({ expiresAt: new Date(Date.now() - 1000).toISOString() })
denies('a sanction that expires before it was issued is denied', MERGE, 'expires no later than it was issued')
sanction({ expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() })
denies('a far-future expiry is denied', MERGE, 'more than 30 minutes out')
sanction({ schema: 2 })
denies('another schema version is denied', MERGE, 'schema')
writeFileSync(SANCTION, '{ this is not json')
denies('a malformed sanction is denied', MERGE, 'no release sanction is on file')

console.log('\nfacts the guard re-derives')
sanction()
writeFileSync(join(repo, 'untracked.txt'), 'work in progress\n')
denies('a dirty tree is denied', MERGE, 'working tree is dirty')
rmSync(join(repo, 'untracked.txt'))
denies('a repository git cannot read is denied', MERGE, 'no readable owner/name slug', { cwd: join(tmp, 'nowhere') })
denies('a scheduled job is denied despite a valid sanction', MERGE, 'scheduled jobs cannot publish', { env: { FLOW_CRON_JOB: 'lint' } })
check('the scheduled job did not consume the sanction', existsSync(SANCTION))

console.log('\nthe model may not approve itself')
denies('writing the sanction path is denied', `echo '{}' > ${SANCTION}`, 'directly')
denies('naming the sanction file is denied', 'mv /tmp/x.json ~/.local/state/flow/release-sanction.json', 'names the release sanction file')
denies('running the helper is denied', `node ${HELPER} approve --repo ${SLUG} --branch main --head ${head} --op gh-pr-merge`, 'runs the release sanction helper')
denies('revoking through the helper is denied', 'node plugins/flow/scripts/release-sanction.mjs revoke', 'runs the release sanction helper')
allows('staging the helper file is ordinary work', 'git add plugins/flow/scripts/release-sanction.mjs')

console.log('\nordinary commands are untouched')
allows('git status', 'git status --porcelain')
allows('a test run', 'npm test -- --watch=false')
allows('a dry run', 'cargo publish --dry-run')
allows('a merge described in prose', 'gh pr comment 12 -b "run gh pr merge once CI is green"')

console.log('\nthe approved operation, once')
head = commit('second')
sanction()
allows('the approved merge runs', MERGE)
check('the sanction was consumed', !existsSync(SANCTION))
check('a tombstone records the use', tombstones().length === 1, JSON.stringify(tombstones()))
denies('the same merge a second time is denied', MERGE, 'no release sanction is on file')

sanction({ operations: ['npm-publish'] })
allows('a registry publication is sanctionable the same way', 'npm publish --access public')
check('the registry sanction was consumed too', !existsSync(SANCTION))

sanction()
head = commit('third')
denies('a sanction is void once the head moves', MERGE, 'the head has moved')
clearSanction()

// ------------------------------------------------------------------------------ the helper
console.log('\nthe human helper')
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
const approved = helper(['approve', '--repo', SLUG, '--branch', 'main', '--head', head, '--op', 'gh-pr-merge'])
check('approve succeeds', approved.code === 0, approved.stderr)
check('the sanction is mode 0600', (statSync(SANCTION).mode & 0o777) === 0o600, (statSync(SANCTION).mode & 0o777).toString(8))
allows('the guard honors what the helper wrote', MERGE)

const cron = helper(['approve', '--repo', SLUG, '--branch', 'main', '--head', head, '--op', 'gh-pr-merge'], { FLOW_CRON_JOB: 'lint' })
check('approve refuses under FLOW_CRON_JOB', cron.code === 2 && cron.stderr.includes('unattended'), cron.stderr)
check('and wrote nothing', !existsSync(SANCTION))

const typo = helper(['approve', '--repo', SLUG, '--branch', 'main', '--head', head, '--op', 'gh-pr-mrege'])
check('an unknown operation id is refused', typo.code === 2 && typo.stderr.includes('unknown operation'), typo.stderr)
const longTtl = helper(['approve', '--repo', SLUG, '--branch', 'main', '--head', head, '--op', 'gh-pr-merge', '--ttl-minutes', '600'])
check('a ttl beyond 30 minutes is refused', longTtl.code === 2 && longTtl.stderr.includes('between 1 and 30'), longTtl.stderr)
const shortSha = helper(['approve', '--repo', SLUG, '--branch', 'main', '--head', head.slice(0, 12), '--op', 'gh-pr-merge'])
check('an abbreviated SHA is refused', shortSha.code === 2 && shortSha.stderr.includes('40-character'), shortSha.stderr)
check('none of the refusals left a sanction behind', !existsSync(SANCTION))

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nrelease path: ALL PASS' : `\nrelease path: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
