#!/usr/bin/env node
import { build } from '../deps/node_modules/esbuild/lib/main.js'
import { chmod, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = process.env.FLOW_BUILD_OUT || join(root, 'dist', 'delegation.mjs')
const manifest = JSON.parse(await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
const dependencies = JSON.parse(await readFile(join(root, 'deps', 'package.json'), 'utf8')).dependencies
const charter = await readFile(join(root, 'charter', 'charter.md'), 'utf8')
const claudeProfile = await readFile(join(root, 'charter', 'profiles', 'claude.md'), 'utf8')
const codexProfile = await readFile(join(root, 'charter', 'profiles', 'codex.md'), 'utf8')
const seatContract = await readFile(join(root, 'seat-contract.md'), 'utf8')

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
  define: {
    __FLOW_VERSION__: JSON.stringify(manifest.version),
    __CLAUDE_AGENT_SDK_VERSION__: JSON.stringify(dependencies['@anthropic-ai/claude-agent-sdk']),
    __FLOW_CHARTER__: JSON.stringify(charter),
    __FLOW_PROFILE_CLAUDE__: JSON.stringify(claudeProfile),
    __FLOW_PROFILE_CODEX__: JSON.stringify(codexProfile),
    __FLOW_SEAT_CONTRACT__: JSON.stringify(seatContract),
  },
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
  legalComments: 'none',
})
await chmod(outfile, 0o755)
