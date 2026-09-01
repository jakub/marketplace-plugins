// gripe: the PATH shim's publication rule.
//
// Every harness's SessionStart hook runs the code of its own install and points
// ~/.local/bin/gripe at that install's bin/shim.mjs. On a host where Claude has 0.2.0 and
// Codex has 0.3.0, a plain overwrite is last-writer-wins: the newer shim gets published,
// the next Claude session reverts it, and the human watches a fix undo itself once a day.
//
// So the shim carries a protocol epoch, and publishing is upgrade-only: overwrite unless
// the file already there declares a strictly higher epoch. Missing, lower, equal, drifted
// or unparseable all get overwritten, which is what makes corruption self-repairing. The
// epoch is a property of shim behavior and not of the release: it moves when the resolver
// or the exit contract changes, and stays put through ordinary version bumps.

import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const EPOCH_RE = /^[ \t]*\/\/[ \t]*gripe-shim-epoch:[ \t]*(\d{1,9})[ \t]*\r?$/gm
const MODE = 0o755
// A published shim is a few kilobytes. Anything past this is not a shim whose epoch is
// worth parsing, and reading it in full would be the only unbounded read on this path.
const DESTINATION_CAP = 64 * 1024
// Lock acquisition: a small backoff, and enough attempts to outwait a legitimate holder
// that is writing a shim (microseconds) without wedging if something truly hangs.
const LOCK_BACKOFF_MS = 2
const LOCK_MAX_ATTEMPTS = 5000

let counter = 0

/**
 * The epoch a shim's text declares, or null when it declares none it can be held to.
 * More than one marker is null too: two answers is not an answer, and the safe reading of
 * an ambiguous file is that it has no claim on staying put.
 *
 * This is a text parse and never an import. Importing an on-disk shim to ask its version
 * would execute the very file the ratchet exists to distrust.
 */
export function shimEpoch(text) {
  if (typeof text !== 'string') return null
  const matches = [...text.matchAll(EPOCH_RE)]
  if (matches.length !== 1) return null
  const epoch = Number(matches[0][1])
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null
}

function readCapped(path, cap) {
  let fd
  try {
    // Non-blocking, so a FIFO or other special file planted at the shim path can never hang
    // publication; fstat then rejects anything that is not a regular file, and the caller
    // treats that as an absent destination and replaces it.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > cap) return null
    const buffer = Buffer.alloc(Number(stat.size))
    let offset = 0
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (read <= 0) break
      offset += read
    }
    return buffer.subarray(0, offset)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* the read already decided the outcome */ }
    }
  }
}

/** A synchronous pause with no wall clock, so a resumed run reproduces it exactly. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Whether the pid recorded in a held lock is gone, so a stale lock can be reclaimed. */
function lockHolderDead(lockPath) {
  let pid
  try {
    pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
  } catch {
    return true
  }
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    // Signal 0 is an existence probe: it delivers nothing and only reports whether the
    // process is there. ESRCH means it is gone; EPERM means it is alive but someone else's.
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

/**
 * An exclusive lock in the shim's own directory. It makes the epoch re-read and the rename
 * one step, so a writer that decided to publish from a now-stale pre-check cannot clobber a
 * higher epoch another writer published in between. The lock file carries the holder's pid:
 * a crashed holder is detected as gone and reclaimed, so a dead process never wedges
 * publication forever. Returns the held fd, or null when the lock could not be taken (a
 * later SessionStart tries again).
 */
function acquireLock(lockPath) {
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    let fd
    try {
      fd = openSync(lockPath, 'wx', 0o644)
    } catch (error) {
      if (error?.code !== 'EEXIST') return null
      if (lockHolderDead(lockPath)) {
        try { unlinkSync(lockPath) } catch { /* another racer already reclaimed it */ }
        continue
      }
      sleep(LOCK_BACKOFF_MS)
      continue
    }
    try { writeSync(fd, String(process.pid)) } catch { /* the pid is a best-effort hint */ }
    return fd
  }
  return null
}

/** A correctly published shim is a regular file (not a symlink) at exactly 0755. */
function publishedRegular(path) {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && (stat.mode & 0o777) === MODE
  } catch {
    return false
  }
}

/**
 * What to do with the destination given the source and its epoch:
 *   unchanged   - already the source bytes AND already a regular file at 0755
 *   kept-newer  - declares a strictly higher epoch, so it is a newer shim, left untouched
 *   write       - missing, drifted, wrong mode, a symlink, or a lower/equal epoch: replace
 *
 * The mode-and-type check is why an identical file at 0644, or a symlink whose target holds
 * the bytes, is still rewritten: either advertises a command that will not actually run.
 */
function classify(shimPath, source, sourceEpoch) {
  const current = readCapped(shimPath, DESTINATION_CAP)
  if (current === null) return 'write'
  const currentEpoch = shimEpoch(current.toString('utf8'))
  if (currentEpoch !== null && currentEpoch > sourceEpoch) return 'kept-newer'
  if (current.equals(source) && publishedRegular(shimPath)) return 'unchanged'
  return 'write'
}

/**
 * Point shimPath at sourcePath's bytes, upgrade-only. Returns what it did:
 *   written     - the file was missing, older, or drifted, and now matches the source
 *   unchanged   - byte-identical already
 *   kept-newer  - the file there declares a higher epoch and was left alone, byte for byte
 *   refused     - the source declares no epoch, so publishing it would restart the flapping
 *   failed      - the write did not happen; a later SessionStart tries again
 *
 * The write goes through a temp file in the target's own directory and one rename, so a
 * reader sees the old shim or the new one and never a half-written script. Rename replaces
 * the directory entry, which is also how a symlink at the shim path stops being one
 * instead of getting written through. No fsync: the promise is what concurrent readers
 * see, not what survives a power cut.
 */
export function pointShim({ sourcePath, shimPath }) {
  let source
  try {
    source = readFileSync(sourcePath)
  } catch {
    return 'failed'
  }
  const sourceEpoch = shimEpoch(source.toString('utf8'))
  if (sourceEpoch === null) return 'refused'

  // A cheap pre-check outside the lock skips the work when the file is already right or
  // newer. It is re-decided under the lock before the rename, so a race here costs at most
  // one wasted lock, never a wrong outcome.
  const pre = classify(shimPath, source, sourceEpoch)
  if (pre !== 'write') return pre

  const directory = dirname(shimPath)
  try {
    mkdirSync(directory, { recursive: true })
  } catch {
    return 'failed'
  }

  const lockPath = join(directory, `.${basename(shimPath)}.lock`)
  const lockFd = acquireLock(lockPath)
  if (lockFd === null) return 'failed'

  // pid plus a bounded counter: unique against every other writer without a clock or a
  // random source, both of which a resumed run would have to reproduce.
  let temp = null
  let fd
  try {
    // Re-decide under the lock, immediately before promoting. If another writer published a
    // strictly higher epoch since the pre-check, this returns kept-newer and the rename
    // never happens, which is what makes a downgrade impossible rather than merely unlikely.
    const locked = classify(shimPath, source, sourceEpoch)
    if (locked !== 'write') return locked

    for (let attempt = 0; attempt < 16 && fd === undefined; attempt++) {
      counter = (counter + 1) % 1_000_000
      const candidate = join(directory, `.${basename(shimPath)}.${process.pid}.${counter}.tmp`)
      try {
        fd = openSync(candidate, 'wx', MODE)
        temp = candidate
      } catch {
        fd = undefined
      }
    }
    if (fd === undefined) return 'failed'
    let offset = 0
    while (offset < source.length) offset += writeSync(fd, source, offset, source.length - offset)
    // The open mode is subject to umask; this is what makes the published shim executable.
    fchmodSync(fd, MODE)
    closeSync(fd)
    fd = undefined
    renameSync(temp, shimPath)
    temp = null
    return 'written'
  } catch {
    return 'failed'
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* nothing left to salvage */ }
    }
    if (temp !== null) {
      try { unlinkSync(temp) } catch { /* a leftover temp is worse than a failed unlink */ }
    }
    try { closeSync(lockFd) } catch { /* the lock is released by the unlink below */ }
    try { unlinkSync(lockPath) } catch { /* a crashed reader reclaims a stale lock by pid */ }
  }
}
