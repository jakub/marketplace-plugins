#!/usr/bin/env node
// Smoke for T3 seats: runs every test/flow/seat/*.mjs section module in parallel (excluding
// helpers.mjs), each in its own process with its own temp state directory and T3 fixture store.
// Supports `--case-prefix <p>`, failing if no case across any section matches.
// Run: node test/flow/smoke-seat.mjs [--case-prefix <p>]

import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SEAT_DIR = join(HERE, 'seat')
const argv = process.argv.slice(2)
const prefixAt = argv.indexOf('--case-prefix')
const prefix = prefixAt >= 0 ? argv[prefixAt + 1] ?? '' : ''

const sections = readdirSync(SEAT_DIR)
  .filter((f) => f.endsWith('.mjs') && f !== 'helpers.mjs')
  .sort()

function runSection(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(SEAT_DIR, file), ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = []
    const err = []
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.on('close', (code, signal) => {
      resolve({
        file,
        ok: code === 0 && signal === null,
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
  })
}

const results = await Promise.all(sections.map(runSection))
let totalChecks = 0
let totalCases = 0
let failed = false

for (const r of results) {
  const lines = r.stdout.split('\n')
  const summaryLine = lines.find((l) => l.startsWith('__SECTION_SUMMARY__ '))
  const body = lines.filter((l) => !l.startsWith('__SECTION_SUMMARY__ ')).join('\n').trimEnd()
  if (body) console.log(body)
  if (!r.ok) {
    failed = true
    if (r.stderr) process.stderr.write(r.stderr)
    console.error(`FAIL seat/${r.file}: ${r.signal ? `killed by ${r.signal}` : `exit ${r.code}`}`)
    continue
  }
  if (!summaryLine) {
    failed = true
    console.error(`FAIL seat/${r.file}: missing section summary`)
    continue
  }
  const s = JSON.parse(summaryLine.slice('__SECTION_SUMMARY__ '.length))
  totalChecks += s.checks
  totalCases += s.cases
}

if (failed) process.exit(1)
if (totalCases === 0) {
  console.error(`no case matches --case-prefix ${JSON.stringify(prefix)}`)
  process.exit(1)
}
console.log(`\nsmoke-seat: ALL PASS (${totalChecks} checks, ${totalCases} cases across ${sections.length} sections)`)
