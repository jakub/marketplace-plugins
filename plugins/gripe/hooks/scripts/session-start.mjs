#!/usr/bin/env node
// gripe: SessionStart. One advertisement line to the main agent and nothing else, per
// decision 7. On the way past: write the session mark that gives distinct-session
// counting its denominator, publish the PATH shim, and sweep stale state files.
//
// Contract: read hook JSON on stdin, print the advertisement to stdout, always exit 0.

import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { readHookEvent } from '../../lib/context.mjs'
import { heredocDelim, stateDir } from '../../lib/gate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SWEEP_AGE_MS = 3 * 24 * 60 * 60 * 1000
const EPOCH_RE = /^\/\/ gripe-shim-epoch: (\d+)$/m

async function markSession(sessionId) {
  try {
    const store = await import('../../lib/store.mjs')
    const db = store.openStore()
    try {
      store.markSession(db, sessionId)
    } finally {
      db.close()
    }
  } catch (e) {
    process.stderr.write(`gripe: session mark skipped: ${String(e?.message ?? e).split('\n')[0]}\n`)
  }
}

// The epoch a shim declares. A file with no marker reads as -1, so a corrupt copy or one
// from before the marker existed counts as older and gets replaced.
const epochOf = (text) => Number(text.match(EPOCH_RE)?.[1] ?? -1)

/**
 * Copy bin/shim.mjs to ~/.local/bin/gripe when the file there is missing or declares a
 * lower epoch. Both harnesses run this hook from their own install, often at different
 * versions, so a plain overwrite would let the older one revert the newer shim every
 * session. The epoch counts shim behavior changes, never releases, so an equal epoch is
 * left alone. Any failure, including losing a race with the other harness's session, is
 * retried by the next SessionStart.
 */
function publishShim() {
  // Presence, not truthiness, and the same rule the shim's own resolver uses: any
  // GRIPE_HOME in the environment means a working tree is under test, and publishing
  // would clobber the developer's shim and send traffic back to the installed copy.
  if (Object.hasOwn(process.env, 'GRIPE_HOME')) return
  const dest = join(homedir(), '.local', 'bin', 'gripe')
  const temp = `${dest}.${process.pid}.tmp`
  try {
    const source = readFileSync(join(HERE, '..', '..', 'bin', 'shim.mjs'), 'utf8')
    // Only a regular file, through any symlink, is read: a FIFO there would block the read,
    // and this hook, until its timeout. Anything else is not a shim and is left alone.
    const found = statSync(dest, { throwIfNoEntry: false })
    if (found && !found.isFile()) return
    let current = null
    try { current = readFileSync(dest, 'utf8') } catch {}
    if (current !== null && epochOf(current) >= epochOf(source)) {
      // Left as it is, except that a shim which lost its executable bits gets them back.
      if ((found.mode & 0o111) === 0) chmodSync(dest, 0o755)
      return
    }
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(temp, source)
    chmodSync(temp, 0o755) // the create mode is subject to umask
    // One rename, so a concurrent `gripe` sees the old shim or the new one, never half.
    renameSync(temp, dest)
  } catch {
    try { unlinkSync(temp) } catch {}
  }
}

function sweep() {
  const now = Date.now()
  for (const sub of ['scan', 'gate']) {
    try {
      const dir = join(stateDir(), sub)
      for (const f of readdirSync(dir)) {
        try {
          const p = join(dir, f)
          if (now - statSync(p).mtimeMs > SWEEP_AGE_MS) unlinkSync(p)
        } catch {}
      }
    } catch {}
  }
}

async function main() {
  const { sessionId } = await readHookEvent()

  await markSession(sessionId)
  publishShim()
  sweep()

  // The delimiter is random per advertisement; see heredocDelim for why a fixed one is
  // an injection path.
  const d = heredocDelim()
  process.stdout.write(
    [
      `gripe: a local friction log. When tooling or workflow friction costs you real time, annoys you, or just doesn't seem right, file it in one command (always exits 0, no reply expected, never required). This is a tool just for you. No need to inform the human - they will read your gripes later and address them. Usage:`,
      `gripe add <<'${d}'`,
      `<what you expected, what happened instead, what it cost>`,
      d,
    ].join('\n'),
  )
}

// No process.exit(): an explicit exit can truncate stdout before the pipe drains, and a
// swallowed rejection already leaves the default exit code of 0.
main().catch(() => {})
