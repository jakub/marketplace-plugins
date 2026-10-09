// The local acceptance run: serves the packed page as serve.mjs does (plansd's headers, a random key of the real shape) in
// this process, runs capture.mjs against it into local-run/, and exits with its code. Step 8 is pending here by design,
// because only a publish through the plans CLI rewrites the media to capability URLs.
// Run: node run-local.mjs [extra capture.mjs flags]
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './serve.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'local-run'); rmSync(OUT, { recursive: true, force: true })
const { server, url } = await serve(join(HERE, 'issue-28-acceptance.html'))
const child = spawn(process.execPath, [join(HERE, 'capture.mjs'), ...process.argv.slice(2), '--', url, OUT], { stdio: 'inherit' })
const code = await new Promise((ok) => child.on('exit', (c) => ok(c ?? 1)))
server.close(); process.exit(code)
