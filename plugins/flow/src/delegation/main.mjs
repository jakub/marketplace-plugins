import { fileURLToPath } from 'node:url'
import { startMcp } from './mcp.mjs'
import { parse, safeRunCli } from './cli.mjs'
import { runWorker } from './worker.mjs'
import { defaultStateDir } from './store.mjs'

const argv = process.argv.slice(2)
const mode = argv[0]
const entryPath = fileURLToPath(import.meta.url)

if (mode === 'mcp') {
  const { flags } = parse(argv)
  const depth = Number(process.env.FLOW_DELEGATION_DEPTH || 0)
  await startMcp({
    host: flags.host || 'claude',
    depth,
    stateDir: flags['state-dir'] || defaultStateDir(),
    entryPath,
    projectDir: process.env.CODEX_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || null,
  })
} else if (mode === 'worker') {
  const { flags } = parse(argv)
  await runWorker({
    jobId: flags.job || null,
    stateDir: flags['state-dir'] || defaultStateDir(),
  })
} else if (mode === 'cli') {
  await safeRunCli({ argv: argv.slice(1), entryPath })
} else {
  process.stderr.write('usage: delegation.mjs mcp|worker|cli\n')
  process.exitCode = 2
}
