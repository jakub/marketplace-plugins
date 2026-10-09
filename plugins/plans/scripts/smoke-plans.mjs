#!/usr/bin/env node
// The plans plugin's smoke. It runs every scripts/smoke/*.mjs section module in filename order,
// so writers who own different sections never share a file.
//
// A section module is `export default async function (t)`, where t = { ROOT, check }. ROOT is
// the repository root. check(name, ok, detail) records one assertion and prints it; detail is
// shown only on a failure. A section that throws counts as one failed check and the run goes on
// to the next section. The run exits 1 if any check failed, else 0.
// Run: node plugins/plans/scripts/smoke-plans.mjs

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

let bad = 0, checks = 0
const check = (name, ok, detail = '') => {
  checks++
  if (!ok) bad++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` → ${detail}`}`)
}

const sections = readdirSync(join(HERE, 'smoke')).filter((f) => f.endsWith('.mjs')).sort()
for (const file of sections) {
  console.log(`${file.replace(/\.mjs$/, '')}:`)
  try {
    const { default: run } = await import(pathToFileURL(join(HERE, 'smoke', file)).href)
    await run({ ROOT, check })
  } catch (e) {
    check(`section ${file} runs to the end`, false, e?.stack ?? String(e))
  }
}

console.log(bad === 0 ? `\nplans: ALL PASS (${checks} checks)` : `\nplans: ${bad} FAILURE(S) of ${checks} checks`)
process.exit(bad === 0 ? 0 : 1)
