#!/usr/bin/env node
// gripe: the write-collision test behind the design's busy-timeout decision, kept
// repeatable. Twenty processes each hold a write transaction for 60ms to force
// contention; the design requires all twenty rows to land. Without the timeout option,
// measured 2026-08-23, nineteen of twenty vanished silently.
//
// Usage: node collision-test.mjs   (uses a throwaway state dir, exits 1 on any loss)

import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WRITERS = 20
const HOLD_MS = 60

if (process.env.GRIPE_COLLISION_CHILD) {
  const store = await import(join(HERE, '..', 'lib', 'store.mjs'))
  const db = store.openStore()
  db.exec('BEGIN IMMEDIATE')
  const until = Date.now() + HOLD_MS
  while (Date.now() < until) { /* hold the write lock to force collisions */ }
  db.prepare('INSERT INTO gripes (body, session_id) VALUES (?, ?)')
    .run(`collision writer ${process.env.GRIPE_COLLISION_CHILD}`, 'collision-test')
  db.exec('COMMIT')
  db.close()
  process.exit(0)
}

const stateHome = mkdtempSync(join(tmpdir(), 'gripe-collision-'))
try {
  const children = []
  for (let i = 1; i <= WRITERS; i++) {
    children.push(new Promise((resolve) => {
      fork(fileURLToPath(import.meta.url), [], {
        env: { ...process.env, XDG_STATE_HOME: stateHome, GRIPE_COLLISION_CHILD: String(i) },
      }).on('exit', (code) => resolve(code))
    }))
  }
  const codes = await Promise.all(children)
  process.env.XDG_STATE_HOME = stateHome // stateDir() reads the env at open time
  const check = (await import(join(HERE, '..', 'lib', 'store.mjs'))).openStore()
  const n = check.prepare('SELECT COUNT(*) AS n FROM gripes').get().n
  check.close()
  console.log(`${n}/${WRITERS} rows landed (child exit codes: ${codes.join(',')})`)
  process.exit(n === WRITERS ? 0 : 1)
} finally {
  rmSync(stateHome, { recursive: true, force: true })
}
