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

import { closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs'
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
    fd = openSync(path, 'r')
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

  const current = readCapped(shimPath, DESTINATION_CAP)
  if (current !== null) {
    if (current.equals(source)) return 'unchanged'
    const currentEpoch = shimEpoch(current.toString('utf8'))
    // Strictly greater, and nothing else about the file matters. A newer shim that looks
    // corrupt to this older code is still a newer shim, and guessing is how downgrades
    // get reintroduced.
    if (currentEpoch !== null && currentEpoch > sourceEpoch) return 'kept-newer'
  }

  const directory = dirname(shimPath)
  try {
    mkdirSync(directory, { recursive: true })
  } catch {
    return 'failed'
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
  }
}
