#!/usr/bin/env node
// Smoke harness for both publish adapters over lib/hook-policy.mjs: publish-guard.mjs (Claude)
// and publish-guard-codex.mjs (Codex). Registry publication is the one rule they answer
// differently: Claude asks, Codex denies, because Codex runs a command whose hook answered
// `ask`. The merge tripwire is one decision, so every merge case runs through both.
// Run: node plugins/flow/scripts/smoke-publish-guard.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXECUTOR = join(ROOT, 'scripts', 'land-merge.mjs')
const SHA = '0123456789abcdef0123456789abcdef01234567'

let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` → ${detail}`}`)
}

// Throwaway repositories, because "managed" is a property of the repository: the marker has to
// be committed at HEAD, not merely present in the working tree. FLOW_CRON_JOB is blanked
// wherever it is not the point, so a stray one in the operator's shell changes nothing here.
const tmp = mkdtempSync(join(tmpdir(), 'flow-publish-guard-'))
const env = {
  ...process.env, HOME: tmp, FLOW_CRON_JOB: '',
  GIT_CONFIG_GLOBAL: join(tmp, 'none'), GIT_CONFIG_SYSTEM: join(tmp, 'none'),
  GIT_AUTHOR_NAME: 'flow smoke', GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
  GIT_COMMITTER_NAME: 'flow smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
}
const repo = (name, { marker = false, commit = true, dropMarker = false, untracked = false } = {}) => {
  const dir = join(tmp, name)
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { env, stdio: 'ignore' })
  mkdirSync(join(dir, 'src'), { recursive: true })
  git('init', '-q', '-b', 'main')
  if (marker || untracked) {
    mkdirSync(join(dir, '.flow'))
    writeFileSync(join(dir, '.flow', 'managed'), 'flow manages merges here\n')
  }
  if (marker) git('add', '.flow/managed')
  writeFileSync(join(dir, 'file.txt'), 'hello\n')
  git('add', 'file.txt')
  if (commit) git('commit', '-q', '-m', 'first')
  if (dropMarker) rmSync(join(dir, '.flow', 'managed'))
  return dir
}
const managed = repo('managed', { marker: true })
const plain = repo('plain')
const dropped = repo('dropped', { marker: true, dropMarker: true }) // committed, then deleted: still managed
const untracked = repo('untracked', { untracked: true })           // never committed: not managed
const unborn = repo('unborn', { commit: false })                   // the probe cannot read HEAD: fails closed

const run = (script, command, { cwd = managed, cron, raw, spawnCwd } = {}) => {
  const out = execFileSync(process.execPath, [join(ROOT, 'hooks', 'scripts', script)], {
    input: raw ?? JSON.stringify(cwd === null ? { tool_name: 'Bash', tool_input: { command } } : { tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8', env: cron ? { ...env, FLOW_CRON_JOB: cron } : env, cwd: spawnCwd,
  }).trim()
  return out ? JSON.parse(out).hookSpecificOutput : null
}
const HOSTS = [['claude', 'publish-guard.mjs', 'ask'], ['codex', 'publish-guard-codex.mjs', 'deny']]
const answers = (want, command, name, options) => {
  for (const [host, script] of HOSTS) {
    const out = run(script, command, options)
    const got = out?.permissionDecision ?? 'pass'
    const expected = want === 'publish' ? HOSTS.find(([h]) => h === host)[2] : want
    check(`${name} (${host}) → ${expected}`, got === expected, `${got}: ${out?.permissionDecisionReason ?? ''}`)
  }
}
const deniesWith = (command, substring, name, options) => {
  for (const [host, script] of HOSTS) {
    const reason = run(script, command, options)?.permissionDecisionReason ?? ''
    check(`${name} (${host})`, reason.includes(substring), reason || 'allowed')
  }
}

console.log('registry publication: Claude asks, Codex denies')
for (const command of ['cargo publish', 'cargo publish -p example-core', 'npm publish --access public', 'pnpm publish',
  'yarn npm publish', 'twine upload dist/*', 'poetry publish', 'uv publish', 'gem push pkg/x.gem']) {
  answers('publish', command, command)
}
answers('publish', 'cargo publish --dry-run && cargo publish', 'a dry run exempts only its own segment')
answers('publish', 'cargo publish && echo --dry-run', 'a later dry-run token does not exempt a publish')
answers('publish', 'cargo publish --dry-run \\\\\ncargo publish', 'an escaped backslash is not a continuation')
answers('publish', 'npm publish --dry-run=false', 'a dry-run flag set false publishes')
check('the Claude ask names the registry and why', run('publish-guard.mjs', 'cargo publish').permissionDecisionReason.includes('crates.io has no unpublish'))
const codexPublish = run('publish-guard-codex.mjs', 'cargo publish', { cwd: plain })?.permissionDecisionReason ?? ''
check('the Codex deny says it cannot ask', codexPublish.includes('cannot request confirmation'), codexPublish)
check('and hands publication to the human', codexPublish.includes('Registry publication stays manual'), codexPublish)

console.log('\nnot publication, on both hosts')
answers('pass', 'cargo publish --dry-run', 'a dry run is the safe rehearsal')
answers('pass', 'cargo publish --dry-run && echo done', 'a dry-run segment followed by ordinary work')
answers('pass', 'npm publish \\\n  --dry-run', 'a continuation is one command')
answers('pass', 'npm publish 2>&1 --dry-run', 'a fd redirect is not the & separator')
answers('pass', 'cargo build --release', 'an ordinary build')
answers('pass', 'docker push registry.internal.example/app:dev', 'a private registry push')
answers('pass', 'gh release create v1.2.3', 'a release deletes cleanly')
answers('pass', 'echo "remember to run cargo publish after the tag"', 'publishing named in a quoted string')
answers('pass', "gripe add <<'G'\nthe guard asked about cargo publish\nG", 'publishing named in a heredoc body')
answers('pass', `bash -c "git commit -m 'notes on npm publish'"`, 'publishing named in prose inside a shell string')
answers('pass', "cat <<'G' > release.sh\ncargo publish\nG", 'a heredoc written to a file, not to a shell')
answers('pass', "bash -lc 'cargo publish --dry-run'", 'a dry run inside a shell string')

console.log('\ntext a shell runs is a command, on both hosts')
for (const [name, command] of [
  ['a publish in a bash -lc string', "bash -lc 'cd pkg && npm publish'"],
  ['a publish in a sh -c string after options', 'sh -e -c "cargo publish"'],
  ['a publish handed to eval', 'eval "twine upload dist/*"'],
  ['a publish in a heredoc on a shell\'s stdin', "bash <<'S'\ncd pkg\ncargo publish\nS"],
  ['a publish two shells deep', `bash -c "sh -c 'gem push pkg/x.gem'"`],
]) answers('publish', command, name)

console.log('\nan uninspectable call: Codex fails closed, Claude fails open')
for (const [name, raw] of [['an unparseable body', '{'], ['a call with no command', '{}']]) {
  const out = run('publish-guard-codex.mjs', '', { raw })
  check(`${name} (codex) → deny`, out?.permissionDecision === 'deny' && /without an inspectable command/.test(out.permissionDecisionReason), JSON.stringify(out))
  check(`${name} (claude) → pass`, run('publish-guard.mjs', '', { raw }) === null)
}

console.log('\nin a repo with a committed .flow/managed, a merge is denied and routed to the executor')
const MERGE = `gh pr merge 12 --squash --match-head-commit ${SHA}`
deniesWith(MERGE, EXECUTOR, 'the denial names the executor by path')
deniesWith(MERGE, '<pr-number> <expected-head-sha>', 'and shows its two arguments')
deniesWith(MERGE, '.flow/managed', 'and says the repository opted in')
for (const [name, command] of [
  ['a bare merge', 'gh pr merge 12'],
  ['the -R form', 'gh -R jakub/x pr merge 12 --squash'],
  ['a path-qualified gh', '/usr/bin/gh pr merge 12'],
  ['the REST endpoint', 'gh api repos/jakub/x/pulls/12/merge -X PUT -f merge_method=squash'],
  ['a quoted REST path', 'gh api -X PUT "repos/jakub/x/pulls/12/merge"'],
  ['the GraphQL mutation', `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`],
  ['the GraphQL mutation on a heredoc', "gh api graphql -F query=@- <<'Q'\nmutation { mergePullRequest(input: {}) { clientMutationId } }\nQ"],
  ['a merge after the executor', `node ${EXECUTOR} 12 ${SHA} && gh pr merge 12`],
  ['a merge on a heredoc opener line', "cat <<'G' && gh pr merge 12\nbody\nG"],
  ['a merge in a bash -lc string', "bash -lc 'gh pr merge 12'"],
  ['a merge in a sh -c string after a cd', `cd /tmp && sh -c "gh pr merge 12 --squash"`],
  ['the REST endpoint in a shell string', `bash -c 'gh api -X PUT "repos/jakub/x/pulls/12/merge"'`],
  ['a merge in a heredoc on a shell\'s stdin', "bash -s <<'S'\ngh pr merge 12\nS"],
]) answers('deny', command, name)
answers('deny', `cargo publish && ${MERGE}`, 'a publish beside a merge is denied, never asked')
answers('deny', MERGE, 'a subdirectory is still the repo', { cwd: join(managed, 'src') })
answers('deny', MERGE, 'a committed marker deleted from the worktree still counts', { cwd: dropped })
answers('deny', MERGE, 'a repo whose HEAD cannot be read fails closed', { cwd: unborn })
answers('deny', MERGE, 'a directory git cannot read fails closed', { cwd: join(tmp, 'nowhere') })
answers('deny', MERGE, 'with no cwd in the call, the hook reads its own directory', { cwd: null, spawnCwd: managed })

console.log('\nthe tripwire never matches the executor, and prose is not a merge')
for (const [name, command] of [
  ['the executor', `node ${EXECUTOR} 12 ${SHA}`],
  ['the executor from an installed cache', `node /home/x/.claude/plugins/cache/jakub/flow/0.42.0/scripts/land-merge.mjs 12 ${SHA}`],
  ['the executor by relative path', `node plugins/flow/scripts/land-merge.mjs 12 ${SHA}`],
  ['the executor under a path naming gh, api and merge', `node /srv/gh/api/merge/scripts/land-merge.mjs 12 ${SHA}`],
  ['a commit message about merging', 'git commit -m "chore: gh pr merge once CI is green"'],
  ['a comment quoting the command', 'gh pr comment 12 -b "run gh pr merge once green"'],
  ['a heredoc body naming it', "gripe add <<'G'\nthe guard denied gh pr merge 12\nG"],
  ['the executor in a shell string', `bash -lc 'node ${EXECUTOR} 12 ${SHA}'`],
  ['prose inside a shell string', `bash -c "git commit -m 'gh pr merge once green'"`],
  ['reading the pull request', 'gh pr view 12 --json state,mergeCommit'],
  ['a local merge', 'git merge --ff-only origin/main'],
]) answers('pass', command, name)

console.log('\nin a repo without a committed marker, flow gates no merges')
answers('pass', MERGE, 'a plain merge', { cwd: plain })
answers('pass', 'gh api repos/someone/x/pulls/12/merge -X PUT', 'the REST endpoint', { cwd: plain })
answers('pass', MERGE, 'an untracked marker opts nothing in', { cwd: untracked })

console.log('\nscheduled jobs merge nothing, executor included')
deniesWith(MERGE, 'scheduled jobs do not merge', 'a merge in a managed repo', { cron: 'lint' })
deniesWith(MERGE, 'scheduled jobs do not merge', 'a merge in an unmanaged repo', { cwd: plain, cron: 'lint' })
deniesWith(`node ${EXECUTOR} 12 ${SHA}`, 'merge executor', 'the executor', { cron: 'lint' })
deniesWith(`env -u FLOW_CRON_JOB node ${EXECUTOR} 12 ${SHA}`, 'merge executor', 'the executor with the variable stripped off the child', { cron: 'lint' })

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\npublish-guard: ALL PASS' : `\npublish-guard: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
