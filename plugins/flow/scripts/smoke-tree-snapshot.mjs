#!/usr/bin/env node
// Smoke for the tree snapshot the prep and issue stages take around their read-only seats. The
// interesting property is not that the digests exist but that each one moves for its own reason,
// so this changes one thing at a time against a throwaway repository and asserts which digest
// noticed. No network and no fake git: the guarantee is git's own.
// Run: node plugins/flow/scripts/smoke-tree-snapshot.mjs

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), 'tree-snapshot.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'flow-tree-snapshot-'))
const repo = join(tmp, 'repo')

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
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: gitEnv })
const snapshot = (at = repo) => JSON.parse(execFileSync(process.execPath, [SNAPSHOT, at], { encoding: 'utf8', env: gitEnv }))
const moved = (before, after) => Object.keys(before).filter((key) => before[key] !== after[key]).sort()

let checks = 0
const ok = (line) => {
  checks++
  console.log(`  ok: ${line}`)
}

execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv })
writeFileSync(join(repo, 'tracked.txt'), 'one\n')
git('add', 'tracked.txt')
git('commit', '-qm', 'seed')
writeFileSync(join(repo, 'loose.txt'), 'before\n')

const first = snapshot()
assert.deepEqual(Object.keys(first).sort(), ['cached', 'diff', 'status', 'untracked'])
assert.ok(Object.values(first).every((digest) => /^[0-9a-f]{64}$/.test(digest)), 'a digest is not sha256 hex')
assert.deepEqual(moved(first, snapshot()), [], 'two snapshots of one unchanged tree disagree')
ok('four sha256 digests, and an unchanged tree snapshots the same twice')

// The case the porcelain status cannot see on its own: same path, same mode, different bytes.
// Without the tar stream a seat could rewrite every untracked file and every digest would hold.
writeFileSync(join(repo, 'loose.txt'), 'after\n')
const rewritten = snapshot()
assert.deepEqual(moved(first, rewritten), ['untracked'], 'rewriting an untracked file moved the wrong digests')
ok('rewriting an untracked file, name and all else equal, moves untracked and nothing else')

// Staging is the other direction: the index changes, and the untracked stream must not.
writeFileSync(join(repo, 'tracked.txt'), 'two\n')
git('add', 'tracked.txt')
const staged = snapshot()
assert.ok(moved(rewritten, staged).includes('cached'), 'staging a tracked file did not move the cached digest')
assert.equal(staged.untracked, rewritten.untracked, 'staging a tracked file moved the untracked digest')
ok(`staging a tracked file moves ${moved(rewritten, staged).join(' and ')}, and leaves untracked alone`)

// A path that is not a worktree has to fail loudly. A snapshot that quietly returns digests for
// the wrong tree is worse than no snapshot: the reconcile would compare two of them and pass.
let refused = null
try {
  execFileSync(process.execPath, [SNAPSHOT, tmp], { encoding: 'utf8', env: gitEnv, stdio: 'pipe' })
} catch (error) {
  refused = error
}
assert.ok(refused !== null, 'a path outside any repository returned a snapshot')
assert.equal(refused.status, 1, `expected exit 1, got ${refused.status}`)
assert.match(String(refused.stderr), /is not a git worktree/)
assert.equal(String(refused.stderr).trim().split('\n').length, 1, 'the refusal is more than one line')
ok(`a path that is not a worktree exits 1 with one line: ${String(refused.stderr).trim()}`)

console.log(`\ntree snapshot: ALL PASS (${checks} checks)`)
