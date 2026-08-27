#!/usr/bin/env node
// Prove the committed dist/delegation.mjs is what src/delegation builds today. The build is
// byte-reproducible with the esbuild pinned in deps/package-lock.json, but only from the same
// directory: esbuild writes every module's path into the output relative to the working
// directory, so this reruns the build from plugins/flow/deps the way `npm run build` does.
// Dev-tree only. An installed plugin has no deps/node_modules and must not run this.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const deps = join(ROOT, 'deps')
const buildScript = join(ROOT, 'scripts', 'build-delegation.mjs')
const committed = join(ROOT, 'dist', 'delegation.mjs')

const refuse = (message) => {
  console.error(`bundle drift: ${message}`)
  process.exit(1)
}

if (!existsSync(join(deps, 'node_modules'))) {
  refuse('plugins/flow/deps/node_modules is missing, so there is no pinned toolchain to rebuild with.\n' +
    'Run `npm ci` in plugins/flow/deps and try again. This is a missing prerequisite, not a pass.')
}
if (!existsSync(committed)) refuse(`no committed bundle at ${committed}`)
// Without the output override the rebuild would land on dist/delegation.mjs and destroy the
// artifact under test, so check for the override before spending a build on it.
if (!readFileSync(buildScript, 'utf8').includes('FLOW_BUILD_OUT')) {
  refuse('scripts/build-delegation.mjs does not read FLOW_BUILD_OUT, so a rebuild would overwrite dist/delegation.mjs.')
}

const temp = mkdtempSync(join(tmpdir(), 'flow-bundle-drift-'))
const rebuilt = join(temp, 'delegation.mjs')
try {
  execFileSync(process.execPath, [buildScript], {
    cwd: deps,
    stdio: 'inherit',
    env: { ...process.env, FLOW_BUILD_OUT: rebuilt },
  })
  if (!existsSync(rebuilt)) throw new Error(`the build ignored FLOW_BUILD_OUT: nothing was written to ${rebuilt}`)

  const shipped = readFileSync(committed)
  const fresh = readFileSync(rebuilt)
  if (shipped.equals(fresh)) {
    console.log(`committed delegation bundle: ALL PASS (${shipped.length} bytes, byte-identical to a fresh build)`)
  } else {
    let offset = 0
    while (offset < Math.min(shipped.length, fresh.length) && shipped[offset] === fresh[offset]) offset++
    const line = shipped.subarray(0, offset).toString('utf8').split('\n').length
    const window = (buffer) => JSON.stringify(buffer.subarray(offset, offset + 60).toString('utf8'))
    console.error('committed delegation bundle: DRIFT')
    console.error(`  committed ${shipped.length} bytes, rebuilt ${fresh.length} bytes`)
    console.error(`  first difference at byte ${offset} (line ${line})`)
    console.error(`  committed: ${window(shipped)}`)
    console.error(`  rebuilt:   ${window(fresh)}`)
    console.error('  Rebuild with `npm run build` in plugins/flow/deps and commit dist/delegation.mjs.')
    process.exitCode = 1
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
