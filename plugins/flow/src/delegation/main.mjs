import { fileURLToPath } from 'node:url'
import { startMcp } from './mcp.mjs'
import { HOSTS } from './contracts.mjs'
import { runWorker } from './worker.mjs'
import { defaultStateDir } from './store.mjs'
import { envelopeJsonSchema } from './envelope-schema.mjs'

// Two runtime modes. A host starts the MCP server; the service starts one worker per job, so
// the prompt never crosses a shell boundary. `schema envelope` prints the result envelope's
// JSON Schema for a caller composing its own schema around it, and runs nothing.
const argv = process.argv.slice(2)
const mode = argv[0]
const entryPath = fileURLToPath(import.meta.url)
const flags = {}
for (let index = 1; index < argv.length; index += 2) {
  if (argv[index]?.startsWith('--')) flags[argv[index].slice(2)] = argv[index + 1]
}

if (mode === 'mcp') {
  if (!HOSTS.includes(flags.host)) {
    process.stderr.write(`--host is required for MCP mode and must be one of: ${HOSTS.join(', ')}.\n`)
    process.exitCode = 2
  } else {
    const depth = Number(process.env.FLOW_DELEGATION_DEPTH || 0)
    // Codex 0.151.0 hands a plugin MCP server no workspace at all: its MCP client advertises no
    // roots capability, and it sets no project-dir variable, so every tool call used to fail with
    // NO_ROOTS. On that host the launch shell's PWD is the boundary, meaning the directory the
    // human was standing in when they started codex. A session started with `codex -C <elsewhere>`
    // then fails closed with OUTSIDE_ROOTS, which is the intended answer rather than a bug. The
    // Claude host has real roots and CLAUDE_PROJECT_DIR, so it never reads PWD.
    const projectDir = process.env.CODEX_PROJECT_DIR
      || process.env.CLAUDE_PROJECT_DIR
      || (flags.host === 'codex' ? process.env.PWD || null : null)
    await startMcp({
      host: flags.host,
      depth,
      stateDir: flags['state-dir'] || defaultStateDir(),
      entryPath,
      projectDir,
    })
  }
} else if (mode === 'worker') {
  await runWorker({
    jobId: flags.job || null,
    stateDir: flags['state-dir'] || defaultStateDir(),
  })
} else if (mode === 'schema' && argv[1] === 'envelope') {
  process.stdout.write(JSON.stringify(envelopeJsonSchema(), null, 2) + '\n')
} else {
  process.stderr.write('usage: delegation.mjs mcp|worker|schema envelope\n')
  process.exitCode = 2
}
