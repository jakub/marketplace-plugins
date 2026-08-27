#!/usr/bin/env node
import { build } from '../deps/node_modules/esbuild/lib/main.js'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = process.env.FLOW_BUILD_OUT || join(root, 'dist', 'delegation.mjs')
const manifest = JSON.parse(await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))

await build({
  // esbuild writes each module's path into the bundle relative to its working directory, so
  // pinning it to plugins/flow makes the output byte-identical wherever the build is run from.
  absWorkingDir: root,
  entryPoints: [join(root, 'src', 'delegation', 'main.mjs')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'bundle',
  nodePaths: [join(root, 'deps', 'node_modules')],
  define: { __FLOW_VERSION__: JSON.stringify(manifest.version) },
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
  legalComments: 'none',
})
const bundled = await readFile(outfile, 'utf8')
await writeFile(outfile, bundled.replace(/[ \t]+$/gm, ''))
await chmod(outfile, 0o755)
