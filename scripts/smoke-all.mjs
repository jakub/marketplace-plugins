#!/usr/bin/env node
// The one command to run before a push, and the repository's done bar: every
// plugins/*/scripts/smoke-*.mjs, then gripe's collision test, then the manifest smoke, one at a
// time, stopping at the first failure. There is no CI, so this is the whole of the check.
//
// Each script runs from the repository root under this node, with its output captured and shown
// only when it fails, so a green run is one line per script. A script that runs past ten minutes
// is killed and counts as a failure, because a hung smoke must not read as a slow pass.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const smokes = readdirSync(join(ROOT, 'plugins')).sort().flatMap((plugin) => {
  const dir = join('plugins', plugin, 'scripts')
  if (!existsSync(join(ROOT, dir))) return []
  return readdirSync(join(ROOT, dir)).filter((f) => /^smoke-.*\.mjs$/.test(f)).sort().map((f) => join(dir, f))
})
const scripts = [...smokes, 'plugins/gripe/scripts/collision-test.mjs', 'scripts/smoke-plugin-manifests.mjs']

for (const script of scripts) {
  const started = Date.now()
  const run = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 << 20 })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (run.status === 0) {
    console.log(`PASS ${script} (${seconds}s)`)
    continue
  }
  const why = run.error ? run.error.message : run.signal ? `killed by ${run.signal}` : `exit ${run.status}`
  process.stdout.write(`${run.stdout ?? ''}${run.stderr ?? ''}`)
  console.log(`FAIL ${script} (${seconds}s): ${why}`)
  process.exitCode = 1
  break
}
if (!process.exitCode) console.log(`smoke-all: ${scripts.length} scripts, ALL PASS`)
