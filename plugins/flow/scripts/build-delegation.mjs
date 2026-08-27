#!/usr/bin/env node
import { build } from '../deps/node_modules/esbuild/lib/main.js'
import { chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = join(root, 'dist', 'delegation.mjs')

await build({
  entryPoints: [join(root, 'src', 'delegation', 'main.mjs')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'bundle',
  nodePaths: [join(root, 'deps', 'node_modules')],
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
  legalComments: 'none',
})
await chmod(outfile, 0o755)
