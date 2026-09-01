#!/usr/bin/env node
// One snapshot of a worktree, as four sha256 digests. The prep and issue stages take one before
// they let a read-only seat loose and one after the last seat reports, and any digest that moved
// means something wrote inside the worktree while nothing in the session was supposed to.
//
// Four digests rather than one, because which one moved says what happened: the porcelain status
// covers tracked paths and the untracked path list, the two diffs cover unstaged and staged
// content, and the tar stream covers every untracked unignored path by name, type, mode and
// content, with a symlink stored by its target text rather than followed.
//
// What it does not see is the boundary the stages state out loud: ignored paths, the inside of an
// untracked nested repository (git reports one entry and never descends), the interior of a
// tracked submodule (a gitlink and a coarse status line), and anything outside the worktree. It
// is a detector for a misbehaving seat, not containment.
//
// Usage: node tree-snapshot.mjs <path>

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const at = process.argv[2]
if (!at) {
  process.stderr.write('tree-snapshot: usage: tree-snapshot.mjs <path>\n')
  process.exit(1)
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

const git = (...args) => spawnSync('git', ['-C', at, ...args], { maxBuffer: 1 << 28 })

const inside = git('rev-parse', '--is-inside-work-tree')
if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') {
  process.stderr.write(`tree-snapshot: ${at} is not a git worktree\n`)
  process.exit(1)
}

const digestOf = (label, ...args) => {
  const run = git(...args)
  if (run.status !== 0) {
    process.stderr.write(`tree-snapshot: git ${args[0]} failed for ${label}: ${String(run.stderr).trim()}\n`)
    process.exit(1)
  }
  return sha256(run.stdout)
}

// The untracked half is a tar stream and not a list of paths, because a seat that rewrites an
// untracked file leaves the name list identical. Every field tar would otherwise take from the
// clock or the caller is pinned, so two runs over the same bytes hash the same: mtime to the
// epoch, owner and group to numeric zero. -T - with --null reads the NUL-delimited, sorted path
// list, and --no-recursion keeps tar to exactly the paths git named, so an untracked nested
// repository stays the one entry git reports rather than a directory this walks into.
// pipefail is what makes a failing git or sort a failure here instead of a digest of nothing.
const UNTRACKED = 'set -o pipefail; '
  + 'git ls-files --others --exclude-standard -z | sort -z | '
  + 'tar --null --no-recursion -T - --mtime=@0 --owner=0 --group=0 --numeric-owner -cf -'
const untracked = spawnSync('bash', ['-c', UNTRACKED], { cwd: at, maxBuffer: 1 << 28 })
if (untracked.status !== 0) {
  process.stderr.write(`tree-snapshot: the untracked scan failed: ${String(untracked.stderr).trim()}\n`)
  process.exit(1)
}

process.stdout.write(`${JSON.stringify({
  status: digestOf('status', 'status', '--porcelain=v2', '--untracked-files=all'),
  diff: digestOf('diff', 'diff'),
  cached: digestOf('cached', 'diff', '--cached'),
  untracked: sha256(untracked.stdout),
})}\n`)
