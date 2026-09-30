#!/usr/bin/env node
// The delegate's one entry. `mcp --host claude|codex` serves MCP on stdio; `run --job <id>` is the
// detached runner the server spawns for each job. On Codex, bin/flow-delegate imports this file
// after rewriting process.argv, so the arguments are read the same way on both hosts.
import { readFileSync } from 'node:fs'
import { runJob } from './runner.mjs'
import { serve } from './server.mjs'

const [mode, ...rest] = process.argv.slice(2)
const flag = (name) => {
  const at = rest.indexOf(`--${name}`)
  return at >= 0 ? rest[at + 1] : undefined
}

if (mode === 'mcp' && ['claude', 'codex'].includes(flag('host'))) {
  const { version } = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  await serve({ host: flag('host'), version })
} else if (mode === 'run' && flag('job')) {
  await runJob(flag('job'))
} else {
  process.stderr.write('usage: main.mjs mcp --host claude|codex | main.mjs run --job <id>\n')
  process.exitCode = 2
}
