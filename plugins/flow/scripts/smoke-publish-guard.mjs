#!/usr/bin/env node
// Smoke harness for hooks/scripts/publish-guard.mjs, the Claude adapter. It has two answers:
// registry publication is an "ASK", and a merge in a repository that opts into flow's merge
// guardrail is a "DENY" that names the executor. Everything else produces no output at all.
// Run: node plugins/flow/scripts/smoke-publish-guard.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const G = join(ROOT, 'hooks', 'scripts', 'publish-guard.mjs')
const EXECUTOR = join(ROOT, 'scripts', 'land-merge.mjs')

let bad = 0

// FLOW_CRON_JOB is blanked everywhere it is not the point of the case: a stray one in the
// operator's own shell must not change what these prove.
const decide = (command, { cwd, env = {} } = {}) => {
  const out = execFileSync('node', [G], {
    input: JSON.stringify(cwd === undefined ? { tool_input: { command } } : { tool_input: { command }, cwd }),
    encoding: 'utf8',
    env: { ...process.env, FLOW_CRON_JOB: '', ...env },
  }).trim()
  return out ? JSON.parse(out).hookSpecificOutput : null
}

// ------------------------------------------------------------------ registry publication
const asks = (command) => decide(command)?.permissionDecision === 'ask'
const expect = (want, command, name) => {
  const got = asks(command)
  if (got !== want) bad++
  console.log(`  ${got === want ? 'ok' : 'FAIL'}: ${name} → ${got ? 'ASK' : 'pass'} (want ${want ? 'ASK' : 'pass'})`)
}
console.log('must ASK')
expect(true, 'cargo publish', 'cargo publish')
expect(true, 'cargo publish -p example-core', 'cargo publish a member')
expect(true, 'npm publish --access public', 'npm publish')
expect(true, 'pnpm publish', 'pnpm publish')
expect(true, 'twine upload dist/*', 'twine upload')
expect(true, 'uv publish', 'uv publish')
expect(true, 'gem push pkg/x.gem', 'gem push')
expect(true, 'cargo publish --dry-run && cargo publish', 'a dry run does not exempt a later publish')
expect(true, 'cargo publish && echo --dry-run', 'a later dry-run token does not exempt publish')
expect(true, 'cargo publish --dry-run \\\\\ncargo publish', 'an escaped backslash is not a continuation')
console.log('must PASS')
expect(false, 'cargo publish --dry-run', 'dry run is the safe rehearsal')
expect(false, 'npm publish --dry-run', 'npm dry run')
expect(false, 'cargo publish --dry-run && echo done', 'dry-run segment followed by ordinary work')
expect(false, 'npm publish \\\n  --dry-run', 'a continuation is one command, not two segments')
expect(false, 'npm publish 2>&1 --dry-run', 'a fd redirect is not the & separator')
expect(false, 'cargo build --release', 'ordinary build')
expect(false, 'cargo test', 'tests')
expect(false, 'docker push registry.internal.example/app:dev', 'private registry, retag is free')
expect(false, 'gh release create v1.2.3', 'a release deletes cleanly')
expect(false, 'git push origin main', 'git push is git-guard territory')
expect(false, 'echo "remember to run cargo publish after the tag"', 'publishing named in prose')

// ------------------------------------------------------------------------- merge routing
//
// Two throwaway repositories, because the answer is a property of the repository: `managed`
// commits the .flow/managed marker and `plain` does not. The guard reads the committed tree,
// so the marker has to be in a commit, not merely written to the working tree.
const tmp = mkdtempSync(join(tmpdir(), 'flow-publish-guard-'))
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
const build = (dir, marker) => {
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv })
  git('init', '-q', '-b', 'main')
  if (marker) {
    mkdirSync(join(dir, '.flow'), { recursive: true })
    writeFileSync(join(dir, '.flow', 'managed'), 'flow manages merges in this repository\n')
    git('add', '.flow/managed')
  }
  writeFileSync(join(dir, 'file.txt'), 'hello\n')
  git('add', 'file.txt')
  git('commit', '-q', '-m', 'first')
  return dir
}
const managed = build(join(tmp, 'managed'), true)
const plain = build(join(tmp, 'plain'), false)

const check = (name, ok, detail = '') => {
  if (!ok) bad++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` → ${detail}`}`)
}
const denies = (name, command, substring, options) => {
  const out = decide(command, options)
  const denied = out?.permissionDecision === 'deny'
  const reason = out?.permissionDecisionReason || ''
  check(name, denied && reason.includes(substring), denied ? `denied for the wrong reason: ${reason}` : 'allowed')
}
const allows = (name, command, options) => {
  const out = decide(command, options)
  check(name, out === null, `${out?.permissionDecision}: ${out?.permissionDecisionReason}`)
}

const MERGE = 'gh pr merge 12 --squash --match-head-commit 0123456789abcdef0123456789abcdef01234567'
const RUN_EXECUTOR = `node ${EXECUTOR} 12 0123456789abcdef0123456789abcdef01234567`

console.log('in a repo with .flow/managed, a merge is denied and routed to the executor')
denies('a plain merge is denied', MERGE, 'land-merge.mjs', { cwd: managed })
denies('and the denial names the executor', MERGE, EXECUTOR, { cwd: managed })
denies('and shows the two-argument form', MERGE, '<pr-number> <expected-head-sha>', { cwd: managed })
denies('and says the repository opted in', MERGE, '.flow/managed', { cwd: managed })
denies('a merge wrapped in bash -lc is denied', `bash -lc '${MERGE}'`, 'land-merge.mjs', { cwd: managed })
allows('the executor invocation itself passes', RUN_EXECUTOR, { cwd: managed })

console.log('in a repo with no committed marker, flow gates no merges')
allows('a plain merge passes', MERGE, { cwd: plain })
allows('so does one wrapped in bash -lc', `bash -lc '${MERGE}'`, { cwd: plain })
allows('and so does the executor', RUN_EXECUTOR, { cwd: plain })

console.log('scheduled jobs merge nothing, executor included')
denies('a merge is denied', MERGE, 'scheduled jobs do not merge', { cwd: managed, env: { FLOW_CRON_JOB: 'lint' } })
denies('and so is the executor', RUN_EXECUTOR, 'merge executor', { cwd: managed, env: { FLOW_CRON_JOB: 'lint' } })
denies('in an unmanaged repo too', MERGE, 'scheduled jobs do not merge', { cwd: plain, env: { FLOW_CRON_JOB: 'lint' } })

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\npublish-guard: ALL PASS' : `\npublish-guard: ${bad} FAILURE(S)`)
if (bad > 0) process.exitCode = 1
