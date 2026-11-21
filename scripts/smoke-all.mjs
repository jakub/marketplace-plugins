#!/usr/bin/env node
// The one command to run before a push, and the repository's done bar: every
// test/*/smoke-*.mjs, gripe's collision test, and the manifest smoke, run in parallel with
// bounded concurrency. There is no CI, so this is the whole check.
//
//   node scripts/smoke-all.mjs [-j N | --jobs N] [filter...]
//
// Each script runs from the repository root under this node, with its output captured and shown
// only when it fails, so a green run prints one PASS line per script plus its last stdout line.
// Heavy scripts start first so they overlap. Passing one or more filter strings runs only scripts
// whose relative path contains at least one filter (exits 2 if nothing matches). A script past
// ten minutes is killed with SIGKILL and counts as a failure.

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT_MS = 600_000
const SLOW_FIRST = new Set([
  'test/flow/smoke-delegate.mjs',
  'test/flow/smoke-seat.mjs',
  'test/plans/smoke-plans.mjs',
])

let jobs = Math.min(Math.max(2, availableParallelism()), 6)
if (process.env.SMOKE_JOBS) {
  const n = Number(process.env.SMOKE_JOBS)
  if (Number.isInteger(n) && n >= 1) jobs = n
}
const filters = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '-j' || a === '--jobs') {
    const n = Number(argv[++i])
    if (!Number.isInteger(n) || n < 1) {
      process.stderr.write('usage: node scripts/smoke-all.mjs [-j N | --jobs N] [filter...]\n')
      process.exit(2)
    }
    jobs = n
  } else if (a.startsWith('-')) {
    process.stderr.write(`smoke-all: unknown flag ${a}\nusage: node scripts/smoke-all.mjs [-j N | --jobs N] [filter...]\n`)
    process.exit(2)
  } else {
    filters.push(a.toLowerCase())
  }
}

const smokes = readdirSync(join(ROOT, 'test')).sort().flatMap((plugin) => {
  const dir = join('test', plugin)
  if (!existsSync(join(ROOT, dir))) return []
  return readdirSync(join(ROOT, dir)).filter((f) => /^smoke-.*\.mjs$/.test(f)).sort().map((f) => join(dir, f))
})
const allScripts = [...smokes, 'test/gripe/collision-test.mjs', 'scripts/smoke-plugin-manifests.mjs']
const selected = filters.length === 0
  ? allScripts
  : allScripts.filter((s) => filters.some((f) => s.toLowerCase().includes(f)))

if (selected.length === 0) {
  process.stderr.write(`smoke-all: no scripts matched ${filters.join(', ')}\n`)
  process.exit(2)
}

const queue = [
  ...selected.filter((s) => SLOW_FIRST.has(s)),
  ...selected.filter((s) => !SLOW_FIRST.has(s)),
]

function runOne(script) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let timedOut = false
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ script, ok: false, seconds: ((Date.now() - started) / 1000).toFixed(1), why: error.message, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      if (!timedOut && code === 0 && signal === null) {
        return resolve({ script, ok: true, seconds, stdout, stderr })
      }
      const why = timedOut ? 'timed out (SIGKILL)' : signal ? `killed by ${signal}` : `exit ${code}`
      resolve({ script, ok: false, seconds, why, stdout, stderr })
    })
  })
}

const wallStart = Date.now()
let failed = 0
let next = 0

async function worker() {
  while (next < queue.length) {
    const script = queue[next++]
    const res = await runOne(script)
    if (res.ok) {
      console.log(`PASS ${res.script} (${res.seconds}s)`)
      const last = res.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean).pop()
      if (last) console.log(`  ${last.trimStart()}`)
    } else {
      failed++
      process.stdout.write(`${res.stdout}${res.stderr}`)
      console.log(`FAIL ${res.script} (${res.seconds}s): ${res.why}`)
    }
  }
}

await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, () => worker()))

const wall = ((Date.now() - wallStart) / 1000).toFixed(1)
if (failed > 0) {
  console.log(`smoke-all: ${failed} of ${selected.length} scripts FAILED (${wall}s)`)
  process.exitCode = 1
} else {
  console.log(`smoke-all: ${selected.length} scripts, ALL PASS (${wall}s)`)
}
