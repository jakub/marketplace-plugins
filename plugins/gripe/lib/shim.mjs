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

import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const EPOCH_RE = /^[ \t]*\/\/[ \t]*gripe-shim-epoch:[ \t]*(\d{1,9})[ \t]*\r?$/gm
const MODE = 0o755
// A published shim is a few kilobytes. Anything past this is not a shim whose epoch is
// worth parsing, and reading it in full would be the only unbounded read on this path.
const DESTINATION_CAP = 64 * 1024

let counter = 0

/**
 * The epoch a shim's text declares, or null when it declares none it can be held to.
 * More than one marker is null too: two answers is not an answer, and the safe reading of
 * an ambiguous file is that it has no claim on staying put.
 *
 * This is a text parse and never an import. Importing an on-disk shim to ask its version
 * would execute the very file the upgrade-only rule exists to distrust.
 */
export function shimEpoch(text) {
  if (typeof text !== 'string') return null
  const matches = [...text.matchAll(EPOCH_RE)]
  if (matches.length !== 1) return null
  const epoch = Number(matches[0][1])
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null
}

export function readCapped(path, cap) {
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
 * What to do with the destination given the source and its epoch. Returns the action and
 * the destination bytes it read (null when there is no readable regular file there):
 *   unchanged   - already the source bytes AND already a regular file at 0755
 *   kept-newer  - declares a strictly higher epoch, so it is a newer shim, not downgraded
 *   write       - missing, drifted, wrong mode, a symlink, or a lower/equal epoch: replace
 *
 * The mode-and-type check is why an identical file at 0644, or a symlink whose target holds
 * the bytes, is still rewritten: either advertises a command that will not actually run.
 */
function classify(shimPath, source, sourceEpoch) {
  const current = readCapped(shimPath, DESTINATION_CAP)
  if (current === null) return { action: 'write', current: null }
  const currentEpoch = shimEpoch(current.toString('utf8'))
  if (currentEpoch !== null && currentEpoch > sourceEpoch) return { action: 'kept-newer', current }
  if (current.equals(source) && publishedRegular(shimPath)) return { action: 'unchanged', current }
  return { action: 'write', current }
}

/**
 * Write bytes as a regular 0755 file at shimPath, through a same-directory temp file and one
 * rename, so a reader sees the old file or the new one and never a half-written script.
 * Rename replaces the directory entry, which is also how a symlink at the shim path stops
 * being one instead of getting written through. No fsync: the promise is what concurrent
 * readers see, not what survives a power cut. Returns whether the rename landed.
 */
function writeRegular(shimPath, bytes) {
  const directory = dirname(shimPath)
  try {
    mkdirSync(directory, { recursive: true })
  } catch {
    return false
  }
  // pid plus a bounded counter: unique against every other writer without a clock or a
  // random source, both of which a resumed run would have to reproduce.
  let temp = null
  let fd
  try {
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
    if (fd === undefined) return false
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    // The open mode is subject to umask; this is what makes the published shim executable.
    fchmodSync(fd, MODE)
    closeSync(fd)
    fd = undefined
    renameSync(temp, shimPath)
    temp = null
    return true
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* nothing left to salvage */ }
    }
    if (temp !== null) {
      try { unlinkSync(temp) } catch { /* a leftover temp is worse than a failed unlink */ }
    }
  }
}

/**
 * A destination that declares a strictly higher epoch is a newer shim, so its bytes are
 * kept. But "kept" still has to leave a command PATH can run: if the entry there is a
 * symlink pinned to an external target, or a regular file at the wrong mode, `gripe` would
 * resolve to something that will not execute. So preserve those exact higher-epoch bytes and,
 * only when the entry is not already a regular 0755 file, re-materialize them as one.
 *
 * kept-newer is reported ONLY once the entry is verified a regular 0755 file. A
 * re-materialize that did not land (a full disk, a permission error, a rename failure) leaves
 * the symlink or wrong-mode entry in place, which breaks the regular-0755 postcondition, so
 * it reports 'failed' and the caller treats it as a failed publish that a later SessionStart
 * retries. Claiming kept-newer over an entry PATH cannot run would be a false success.
 */
function materializeKeptNewer(shimPath, currentBytes) {
  if (publishedRegular(shimPath)) return 'kept-newer'
  writeRegular(shimPath, currentBytes)
  return publishedRegular(shimPath) ? 'kept-newer' : 'failed'
}

/**
 * Point shimPath at sourcePath's bytes, upgrade-only. Returns what it did:
 *   written     - the file was missing, older, or drifted, and now matches the source
 *   unchanged   - byte-identical already
 *   kept-newer  - the file there declares a higher epoch and its bytes were preserved (and
 *                 re-materialized as a regular 0755 file if the entry was a symlink or the
 *                 wrong mode)
 *   refused     - the source declares no epoch, so publishing it would restart the flapping
 *   failed      - the write did not happen; a later SessionStart tries again
 *
 * beforeRecheck is a test-only seam, undefined in production. It fires once, after the temp
 * file is written and just before the pre-rename re-read, so a smoke can plant a higher-epoch
 * destination deterministically and prove the downgrade guard without a timing race.
 */
export function pointShim({ sourcePath, shimPath, beforeRecheck } = {}) {
  // Read the source through the same capped, non-blocking, regular-file-only helper the
  // destination uses. A FIFO or other special file planted at the source path (a corrupted
  // or partial install) would hang a plain readFileSync forever and stall every SessionStart
  // to its hook timeout; here it fails closed to 'failed', and a later SessionStart retries.
  const source = readCapped(sourcePath, DESTINATION_CAP)
  if (source === null) return 'failed'
  const sourceEpoch = shimEpoch(source.toString('utf8'))
  if (sourceEpoch === null) return 'refused'

  const pre = classify(shimPath, source, sourceEpoch)
  if (pre.action === 'unchanged') return 'unchanged'
  if (pre.action === 'kept-newer') return materializeKeptNewer(shimPath, pre.current)

  const directory = dirname(shimPath)
  try {
    mkdirSync(directory, { recursive: true })
  } catch {
    return 'failed'
  }

  let temp = null
  let fd
  try {
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

    if (typeof beforeRecheck === 'function') beforeRecheck()

    // Lock-free downgrade guard: re-read and re-parse the on-disk destination epoch
    // immediately before the rename. If it is now strictly higher than the source, another
    // writer published a newer shim between the initial classify and here, so abort instead
    // of clobbering it (and re-materialize those higher-epoch bytes when the entry there is
    // not a runnable regular 0755 file). This shrinks the downgrade window to the gap between
    // this re-read and the rename below.
    //
    // The residual window - two writers carrying different versions both pass this check, and
    // the later rename wins - is accepted: contention is fine, because a later SessionStart
    // re-runs and converges. An exclusive lock would close it, but a lock
    // on this path reintroduces the FIFO-hang, non-atomic-acquire, and recycled-PID hazards
    // that removing it fixed, so the guard stays lock-free.
    const recheck = classify(shimPath, source, sourceEpoch)
    if (recheck.action === 'unchanged') return 'unchanged'
    if (recheck.action === 'kept-newer') return materializeKeptNewer(shimPath, recheck.current)

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
  }
}
