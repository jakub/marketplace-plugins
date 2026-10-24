// Extracts the smoke's fake provider (one script, two names) from smoke-delegate.mjs and writes it
// into the capture's bin directory with the capture's state and calls directories baked in.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const [smokePath, binDir, state, calls] = process.argv.slice(2)
const src = readFileSync(smokePath, 'utf8')
const start = src.indexOf('const FAKE = String.raw`') + 'const FAKE = String.raw`'.length
const end = src.indexOf('\n`', start)
const body = src.slice(start, end)
const text = new Function('state', 'calls', 'return String.raw`' + body + '\n`')(state, calls)
mkdirSync(binDir, { recursive: true }); mkdirSync(calls, { recursive: true })
for (const name of ['codex', 'claude']) writeFileSync(join(binDir, name), text, { mode: 0o755 })
console.log('fake written:', binDir, text.length, 'chars')
