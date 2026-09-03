#!/usr/bin/env node
// gripe: SessionStart. One advertisement line to the main agent and nothing else, per
// decision 7. On the way past: write the session mark that gives distinct-session
// counting its denominator, keep the PATH shim pointed, and sweep stale state files.
//
// Contract: read hook JSON on stdin, print the advertisement to stdout, always exit 0.

import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { readHookEvent } from '../../lib/context.mjs'
import { heredocDelim, stateDir } from '../../lib/gate.mjs'
import { pointShim } from '../../lib/shim.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SWEEP_AGE_MS = 3 * 24 * 60 * 60 * 1000

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

function publishShim() {
  // Presence, not truthiness, and the same rule the shim's own resolver uses: any
  // GRIPE_HOME in the environment means a working tree is under test, and re-pointing
  // would clobber the developer's shim and send traffic back to the installed copy.
  if (Object.hasOwn(process.env, 'GRIPE_HOME')) return
  // The verdict is deliberately ignored. Every outcome, including losing a race with the
  // other harness's session, is fixed by the next SessionStart trying again.
  pointShim({
    sourcePath: join(HERE, '..', '..', 'bin', 'shim.mjs'),
    shimPath: join(homedir(), '.local', 'bin', 'gripe'),
  })
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
