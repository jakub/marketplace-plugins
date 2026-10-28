#!/usr/bin/env node
// The plans plugin's smoke. It runs every scripts/smoke/*.mjs section module in filename order,
// so writers who own different sections never share a file.
//
// A section module is `export default async function (t)`, where t = { ROOT, check, skip }. ROOT
// is the repository root. check(name, ok, detail) records one assertion and prints it; detail is
// shown only on a failure. skip(name, reason) prints `skip: <name> → <reason>` and counts it in a
// separate tally: a skip is never a check and never a failure, and the final line reports the
// count so a green run cannot hide work that did not run. A section that throws counts as one
// failed check and the run goes on to the next section. The run exits 1 if any check failed, else 0.
// Run: node plugins/plans/scripts/smoke-plans.mjs

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

let bad = 0, checks = 0, skipped = 0
const check = (name, ok, detail = '') => {
  checks++
  if (!ok) bad++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` → ${detail}`}`)
}

const skip = (name, reason) => {
  skipped++
  console.log(`  skip: ${name} → ${reason}`)
}

const sections = readdirSync(join(HERE, 'smoke')).filter((f) => f.endsWith('.mjs')).sort()
for (const file of sections) {
  console.log(`${file.replace(/\.mjs$/, '')}:`)
  try {
    const { default: run } = await import(pathToFileURL(join(HERE, 'smoke', file)).href)
    await run({ ROOT, check, skip })
  } catch (e) {
    check(`section ${file} runs to the end`, false, e?.stack ?? String(e))
  }
}

console.log(bad === 0 ? `\nplans: ALL PASS (${checks} checks, ${skipped} skipped)` : `\nplans: ${bad} FAILURE(S) of ${checks} checks, ${skipped} skipped`)
process.exit(bad === 0 ? 0 : 1)
