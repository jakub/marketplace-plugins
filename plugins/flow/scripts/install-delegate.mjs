#!/usr/bin/env node
// Copies bin/flow-delegate to ~/.local/bin/flow-delegate when it is missing or differs. Codex
// starts MCP servers before any SessionStart hook runs, so setup runs this once before the first
// Codex session; the Codex SessionStart hook then runs it on every session, and a new plugin
// version's dispatcher is in place for the session after. It reports on stderr, because a Codex
// SessionStart hook's stdout becomes session context.
//
// Differing bytes do not make a file ours. The installer replaces a file only when it opens with
// the shebang and a `// flow-delegate-` line, which every flow dispatcher has carried, and refuses
// with exit 1 to replace anything else at that path.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

if (process.argv[2] !== 'install') {
  process.stderr.write('usage: install-delegate.mjs install\n')
  process.exit(2)
}
const source = readFileSync(new URL('../bin/flow-delegate', import.meta.url))
const bin = join(homedir(), '.local', 'bin')
const target = join(bin, 'flow-delegate')
let current = null
try { current = readFileSync(target) } catch (error) {
  if (error.code !== 'ENOENT') {
    process.stderr.write(`flow-delegate: refusing to replace ${target}, which cannot be read (${error.code})\n`)
    process.exit(1)
  }
}
const OURS = /^#!\/usr\/bin\/env node\n\/\/ flow-delegate-/
if (current?.equals(source)) {
  process.stderr.write(`flow-delegate: ${target} is up to date\n`)
} else if (current && !OURS.test(current.toString('latin1'))) {
  process.stderr.write(`flow-delegate: refusing to replace ${target}, which is not a flow dispatcher; move it aside and rerun\n`)
  process.exitCode = 1
} else {
  mkdirSync(bin, { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, source, { mode: 0o755 })
  renameSync(temp, target)
  process.stderr.write(`flow-delegate: ${current ? 'updated' : 'installed'} ${target}\n`)
}
if (!(process.env.PATH || '').split(delimiter).some((entry) => entry.replace(/\/+$/, '') === bin)) {
  process.stderr.write(`flow-delegate: ${bin} is not on PATH; Codex needs it there to start the delegate server\n`)
}
