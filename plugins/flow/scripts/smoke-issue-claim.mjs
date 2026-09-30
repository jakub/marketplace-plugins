#!/usr/bin/env node
// Smoke for the lock under scripts/issue-claim.mjs: acquire, which creates the claim tag, and
// dropTag, which deletes it only at the SHA its acquire created it at.
//
// Everything is real git against a bare repository under mktemp standing in for origin, with
// clones pointed at it. The failure this exists to catch is a false win. `git push` exits 0 both
// when it creates the tag and when the tag already holds the object pushed, and every racer
// pushes the head of main, so the second case is the ordinary shape of losing. An upload-pack
// wrapper (the ambush) lands a rival tag between the preflight read and the push, which is the
// race without the timing; the concurrent rounds are the race with it, several racers per round.
//
// Run: node plugins/flow/scripts/smoke-issue-claim.mjs

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeRedactor } from '../lib/redact.mjs'
import { acquire, dropTag } from './issue-claim.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'issue-claim.mjs')
let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad += 1
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` -> ${detail}`}`)
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-issue-claim-')))
Object.assign(process.env, {
  HOME: tmp, GIT_CONFIG_GLOBAL: join(tmp, 'none'), GIT_CONFIG_SYSTEM: join(tmp, 'none'),
  GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 'smoke@example.invalid', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
  GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', GIT_SSH_COMMAND: 'false',
})
for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete process.env[key]

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tagRef = (issue) => `refs/tags/flow-claim-issue-${issue}`
const tagIn = (bare, issue) => {
  const r = spawnSync('git', ['-C', bare, 'rev-parse', '--verify', '--quiet', tagRef(issue)], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}
const ctx = (cwd) => ({ cwd, redact: (s) => String(s ?? '') })

/** A bare origin with one commit on main and a second object on refs/heads/decoy, plus clones. */
const makeOrigin = (name, clones) => {
  const origin = join(tmp, `${name}.git`)
  const seed = join(tmp, `${name}-seed`)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', seed])
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'first')
  git(seed, 'remote', 'add', 'origin', origin)
  const decoy = git(seed, 'commit-tree', git(seed, 'rev-parse', 'HEAD^{tree}'), '-m', 'a rival object')
  git(seed, 'push', '-q', 'origin', 'main', `${decoy}:refs/heads/decoy`)
  for (const clone of clones) execFileSync('git', ['clone', '-q', origin, join(tmp, clone)])
  return { origin, seed, main: git(seed, 'rev-parse', 'HEAD'), decoy }
}

/** An upload-pack wrapper that points the issue's tag at `sha` on origin right after its `after`th run. */
const arm = (clone, origin, issue, sha, after) => {
  const counter = join(clone, '.git', 'uploads')
  const wrapper = join(clone, '.git', 'upload-pack-ambush')
  writeFileSync(wrapper, `#!/bin/sh\nn=$(($(cat ${counter} 2>/dev/null || echo 0)+1))\nprintf %s $n > ${counter}\ngit upload-pack "$@"\ns=$?\n` +
    `[ "$n" = ${after} ] && git -C ${origin} update-ref ${tagRef(issue)} ${sha}\nexit $s\n`)
  chmodSync(wrapper, 0o755)
  git(clone, 'config', 'remote.origin.uploadpack', wrapper)
}

/** acquire in a child process, so racers really run at once. */
const acquireAsync = (cwd, issue) => new Promise((resolve) => {
  const code = `import { acquire } from ${JSON.stringify(SCRIPT)}; process.stdout.write(JSON.stringify(acquire({ cwd: process.env.CLONE, redact: (s) => s }, ${issue})))`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CLONE: cwd }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.on('close', () => { try { resolve(JSON.parse(out)) } catch { resolve({ result: `unparseable: ${out}` }) } })
})

const o = makeOrigin('origin', ['a', 'b', 'c', 'ambush-same', 'ambush-other', 'lease'])
const [a, b, c] = ['a', 'b', 'c'].map((n) => join(tmp, n))

console.log('a claim is taken once, and the second run is told it lost')
{
  git(o.seed, 'push', '-q', 'origin', `${o.main}:${tagRef(60)}`)
  const won = acquire(ctx(a), 6)
  check('the first run acquires at the head of main', won.result === 'acquired' && won.sha === o.main && tagIn(o.origin, 6) === o.main, JSON.stringify(won))
  check('issue 60\'s tag was not read as issue 6\'s', won.result === 'acquired', JSON.stringify(won))
  const lost = acquire(ctx(b), 6)
  check('the second run is held, read before it pushed', lost.result === 'held' && lost.observed === 'pre-push' && lost.sha === o.main, JSON.stringify(lost))
  const raw = spawnSync('git', ['-C', b, 'push', '--porcelain', 'origin', `${o.main}:${tagRef(6)}`], { encoding: 'utf8' })
  const line = raw.stdout.split('\n').find((l) => l.includes(tagRef(6))) ?? ''
  check('raw git exits 0 pushing the same object at a tag it did not create, flagged = not *', raw.status === 0 && line.startsWith('=\t'), `${raw.status} ${line}`)
}

console.log('\na tag that appears between the preflight and the push is still a loss')
for (const [name, issue, rival, flag] of [['an up-to-date push', 61, o.main, '"="'], ['a rejected push', 62, o.decoy, '"!"']]) {
  const clone = join(tmp, issue === 61 ? 'ambush-same' : 'ambush-other')
  arm(clone, o.origin, issue, rival, 2) // the fetch, then the preflight read; the tag lands before the push
  const r = acquire(ctx(clone), issue)
  check(`${name} is held after the push, never acquired`, r.result === 'held' && r.observed === 'post-push' && r.sha === rival && String(r.detail).includes(flag), JSON.stringify(r))
  check(`${name}: the rival tag is untouched`, tagIn(o.origin, issue) === rival, String(tagIn(o.origin, issue)))
}

console.log('\nracers started together: exactly one wins')
for (let round = 1; round <= 5; round += 1) {
  const issue = 70 + round
  const results = await Promise.all([a, b, c].map((clone) => acquireAsync(clone, issue)))
  const won = results.filter((r) => r.result === 'acquired')
  check(`round ${round}: one acquired, the rest held`, won.length === 1 && results.filter((r) => r.result === 'held').length === 2 && tagIn(o.origin, issue) === o.main,
    JSON.stringify(results.map((r) => `${r.result}/${r.observed ?? ''}`)))
}

console.log('\na clone that has not fetched since origin moved can still claim')
{
  const s = makeOrigin('stale-origin', ['stale', 'stale-twin'])
  git(s.seed, 'commit', '-q', '--allow-empty', '-m', 'second')
  git(s.seed, 'push', '-q', 'origin', 'main')
  const advanced = git(s.seed, 'rev-parse', 'HEAD')
  git(s.seed, 'push', '-q', 'origin', `${advanced}:${tagRef(12)}`) // a live claim a fetch could drag in
  const stale = join(tmp, 'stale')
  check('the fixture is stale: the clone lacks origin\'s main', spawnSync('git', ['-C', stale, 'cat-file', '-e', `${advanced}^{commit}`]).status !== 0)
  const r = acquire(ctx(stale), 13)
  check('it acquires, at origin\'s current main', r.result === 'acquired' && r.sha === advanced && tagIn(s.origin, 13) === advanced, JSON.stringify(r))
  const twins = await Promise.all([stale, join(tmp, 'stale-twin')].map((clone) => acquireAsync(clone, 14)))
  check('two stale clones racing: exactly one acquires', twins.filter((t) => t.result === 'acquired').length === 1, JSON.stringify(twins))
  const localTags = git(stale, 'tag', '--list', 'flow-claim-issue-*') + git(join(tmp, 'stale-twin'), 'tag', '--list', 'flow-claim-issue-*')
  check('no claim tag was copied into either clone by the fetch', localTags === '', localTags)
}

console.log('\ndropTag deletes only the tag this run created')
{
  const taken = acquire(ctx(a), 15)
  const wrong = dropTag(ctx(a), 15, o.decoy)
  check('a receipt for another object is refused, and the tag stays', wrong.result === 'refused' && wrong.reason === 'receipt-mismatch' && !wrong.gone && tagIn(o.origin, 15) === taken.sha, JSON.stringify(wrong))
  const absent = dropTag(ctx(a), 16, o.main)
  check('an absent tag reads as gone, with nothing pushed', absent.reason === 'tag-absent' && absent.gone === true, JSON.stringify(absent))
  const lease = join(tmp, 'lease')
  arm(lease, o.origin, 15, o.decoy, 1) // after the receipt read, before the delete
  const swapped = dropTag(ctx(lease), 15, taken.sha)
  check('a tag swapped between the read and the delete is left alone: the lease rejects it', swapped.result === 'unknown' && !swapped.gone && tagIn(o.origin, 15) === o.decoy, JSON.stringify(swapped))
  git(o.origin, 'update-ref', tagRef(15), taken.sha)
  const dropped = dropTag(ctx(a), 15, taken.sha)
  check('the right receipt drops the tag and reads it back gone', dropped.result === 'dropped' && dropped.gone && tagIn(o.origin, 15) === null, JSON.stringify(dropped))
}

console.log('\nwhat git says is quoted without the credential in the remote')
{
  const creds = join(tmp, 'creds')
  execFileSync('git', ['clone', '-q', o.origin, creds])
  const url = 'https://smokeuser:s3cr3t-PAT@127.0.0.1:9/jakub/demo.git'
  git(creds, 'remote', 'set-url', 'origin', url)
  const r = acquire({ cwd: creds, redact: makeRedactor([url], 'github.com/jakub/demo') }, 17)
  check('an unreachable origin is unknown before any push', r.result === 'unknown' && r.observed === 'pre-push', JSON.stringify(r))
  check('and neither the token nor the user is in what it says', !JSON.stringify(r).includes('s3cr3t-PAT') && !JSON.stringify(r).includes('smokeuser'), JSON.stringify(r))
}

console.log('\nthe source holds no bare force')
{
  const source = readFileSync(SCRIPT, 'utf8')
  check('no --force other than --force-with-lease', !/--force(?!-with-lease)/.test(source))
  check('no -f flag and no + refspec in any argument', !/['"`]-f['"`]/.test(source) && !/['"`]\+[^'"`]*:/.test(source))
}

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nissue-claim lock: ALL PASS' : `\nissue-claim lock: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
