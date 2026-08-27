import { fileURLToPath } from 'node:url'
import { startMcp } from './mcp.mjs'
import { safeRunCli } from './cli.mjs'
import { runWorker } from './worker.mjs'
import { defaultStateDir } from './store.mjs'

function flag(argv, name, fallback = null) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : fallback
}

const argv = process.argv.slice(2)
const mode = argv[0]
const entryPath = fileURLToPath(import.meta.url)

if (mode === 'mcp') {
  const depth = Number(process.env.FLOW_DELEGATION_DEPTH || 0)
  await startMcp({
    host: flag(argv, 'host', 'claude'),
    depth,
    stateDir: flag(argv, 'state-dir', defaultStateDir()),
    entryPath,
    projectDir: process.env.CLAUDE_PROJECT_DIR || null,
  })
} else if (mode === 'worker') {
  await runWorker({
    jobId: flag(argv, 'job'),
    stateDir: flag(argv, 'state-dir', defaultStateDir()),
  })
} else if (mode === 'cli') {
  await safeRunCli({ argv: argv.slice(1), entryPath })
} else {
  process.stderr.write('usage: delegation.mjs mcp|worker|cli\n')
  process.exitCode = 2
}
