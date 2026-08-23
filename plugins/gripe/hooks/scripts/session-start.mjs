#!/usr/bin/env node
// gripe: SessionStart. One advertisement line to the main agent and nothing else, per
// decision 7. On the way past: write the session mark that gives distinct-session
// counting its denominator, keep the PATH shim pointed, and sweep stale state files.
//
// Contract: read hook JSON on stdin, print the advertisement to stdout, always exit 0.

import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { heredocDelim, stateDir } from '../../lib/gate.mjs'

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

function pointShim() {
  // A set GRIPE_HOME means a working tree is under test; re-pointing would clobber the
  // developer's shim and silently send traffic back to the stale installed copy.
  if (process.env.GRIPE_HOME) return
  try {
    const desired = readFileSync(join(HERE, '..', '..', 'bin', 'shim.mjs'), 'utf8')
    const shimPath = join(homedir(), '.local', 'bin', 'gripe')
    let current = null
    try { current = readFileSync(shimPath, 'utf8') } catch {}
    if (current === desired) return
    mkdirSync(dirname(shimPath), { recursive: true })
    writeFileSync(shimPath, desired)
    chmodSync(shimPath, 0o755)
  } catch {
    // No shim just means `gripe` is not on PATH yet; the next session retries.
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
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input = {}
  try { input = JSON.parse(raw) } catch {}

  await markSession(input.session_id)
  pointShim()
  sweep()

  // The delimiter is random per advertisement; see heredocDelim for why a fixed one is
  // an injection path.
  const d = heredocDelim()
  process.stdout.write(
    [
      `gripe: a local friction log. When tooling or workflow friction costs you real time, annoys you, or just doesn't seem right, file it in one command (always exits 0, no reply expected, never required). This is a tool just for you. The human will read your gripes later and address them. Usage:`,
      `gripe add <<'${d}'`,
      `<what you expected, what happened instead, what it cost>`,
      d,
    ].join('\n'),
  )
}

// No process.exit(): an explicit exit can truncate stdout before the pipe drains, and a
// swallowed rejection already leaves the default exit code of 0.
main().catch(() => {})
