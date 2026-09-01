#!/usr/bin/env node
// gripe shim smoke. The shim picks which installed gripe runs, and every way it can pick
// wrong is invisible from a green `gripe add`: the wrong version, a development override
// silently ignored, a published shim quietly downgraded. So this covers ranking across the
// two plugin caches, the GRIPE_HOME override, what each exit code promises, the epoch
// ratchet, and that importing the shim does not run it. Two of those wrong picks are narrow
// and were live bugs: a plugin named gripe in some other marketplace, and a version Claude
// Code has already orphaned but not yet deleted.
//
// Every synthetic home lives under one throwaway directory. Nothing here reads the real
// ~/.claude or ~/.codex, and nothing writes outside the temp tree.
//
// Usage: node plugins/gripe/scripts/smoke-shim.mjs

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { main, resolveGripeBin } from '../bin/shim.mjs'
import { pointShim, shimEpoch } from '../lib/shim.mjs'
import { installFacts } from '../lib/install.mjs'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHIM = join(PLUGIN, 'bin', 'shim.mjs')
const TMP = mkdtempSync(join(tmpdir(), 'gripe-shim-'))

let checks = 0
let failures = 0
function check(name, ok, detail) {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` - ${detail}` : ''}`)
}

// ------------------------------------------------------------- synthetic homes and installs

let serial = 0
function makeHome() {
  const home = join(TMP, `home-${serial++}`)
  mkdirSync(home, { recursive: true })
  return home
}

const cacheRoot = (home, harness) =>
  join(home, harness === 'claude' ? '.claude' : '.codex', 'plugins', 'cache')

// The stub stands in for a real bin/gripe: it records the arguments it was handed and prints
// the root it ran from, so a case can prove which install ran and, more importantly, that a
// refused resolution ran nothing at all.
function plantInstall(home, harness, version, { bin = true, marketplace = 'jakub', orphaned = false } = {}) {
  const root = join(cacheRoot(home, harness), marketplace, 'gripe', version)
  mkdirSync(bin ? join(root, 'bin') : root, { recursive: true })
  // Claude Code's own marker for a version it has uninstalled or superseded: one file holding
  // a millisecond timestamp, dropped in the version directory before the files go.
  if (orphaned) writeFileSync(join(root, '.orphaned_at'), '1787531315877')
  if (bin) {
    writeFileSync(join(root, 'bin', 'gripe'), [
      '#!/usr/bin/env node',
      `require('fs').writeFileSync(${JSON.stringify(join(root, 'ran'))}, process.argv.slice(2).join(' '))`,
      `console.log('ROOT=' + ${JSON.stringify(root)})`,
      'process.exitCode = Number(process.env.GRIPE_STUB_EXIT || 0)',
      '',
    ].join('\n'), { mode: 0o755 })
  }
  return join(root, 'bin', 'gripe')
}

const resolved = (home, env = {}) => resolveGripeBin({ env, home }).bin
const runShim = (home, argv, extra = {}) => spawnSync(
  process.execPath,
  [SHIM, ...argv],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ...extra } },
)

// ------------------------------------------------------------------------- ranking

console.log('ranking across the two caches')
{
  const home = makeHome()
  plantInstall(home, 'claude', '0.2.0')
  const codex = plantInstall(home, 'codex', '0.3.0')
  check('the newer Codex cache beats the older Claude one', resolved(home) === codex, resolved(home))
}
{
  const home = makeHome()
  const claude = plantInstall(home, 'claude', '0.4.0')
  plantInstall(home, 'codex', '0.3.0')
  check('the newer Claude cache beats the older Codex one', resolved(home) === claude, resolved(home))
}
{
  const home = makeHome()
  plantInstall(home, 'claude', '0.9.0')
  const ten = plantInstall(home, 'claude', '0.10.0')
  check('versions compare numerically, so 0.10.0 beats 0.9.0', resolved(home) === ten, resolved(home))
}
{
  const home = makeHome()
  plantInstall(home, 'claude', '0.3.0')
  const newest = plantInstall(home, 'claude', '0.4.0')
  check('with nothing orphaned the newest version still wins', resolved(home) === newest, resolved(home))
}
{
  const home = makeHome()
  const ours = plantInstall(home, 'claude', '0.3.0')
  plantInstall(home, 'claude', '0.4.0', { orphaned: true })
  check('a higher version carrying .orphaned_at is ignored', resolved(home) === ours, resolved(home))
}
{
  const home = makeHome()
  const ours = plantInstall(home, 'codex', '0.3.0')
  plantInstall(home, 'claude', '9.9.9', { marketplace: 'someone-else' })
  check('a higher version under another marketplace is ignored', resolved(home) === ours, resolved(home))
}
{
  const home = makeHome()
  plantInstall(home, 'codex', '9.9.9', { marketplace: 'someone-else' })
  const { bin, error } = resolveGripeBin({ home, env: {} })
  check('another marketplace alone resolves nothing', bin === null && error !== null, bin)
}
{
  const home = makeHome()
  const real = plantInstall(home, 'claude', '0.1.0')
  plantInstall(home, 'claude', 'latest')
  plantInstall(home, 'claude', '0.4.0-rc1')
  check('a directory that is not dotted integers is skipped', resolved(home) === real, resolved(home))
}
{
  const home = makeHome()
  const real = plantInstall(home, 'codex', '0.1.0')
  plantInstall(home, 'codex', '0.5.0', { bin: false })
  check('a version directory with no bin/gripe is skipped', resolved(home) === real, resolved(home))
}
{
  const home = makeHome()
  const claude = plantInstall(home, 'claude', '0.3.0')
  check('one cache empty still resolves the other', resolved(home) === claude, resolved(home))
}
{
  const home = makeHome()
  const codex = plantInstall(home, 'codex', '0.3.0')
  check('an absent Claude cache does not veto Codex', resolved(home) === codex, resolved(home))
}
{
  const home = makeHome()
  const elsewhere = makeHome()
  const codex = plantInstall(elsewhere, 'codex', '0.3.0')
  const bin = resolveGripeBin({ home, env: { CODEX_HOME: join(elsewhere, '.codex') } }).bin
  check('CODEX_HOME moves the Codex cache', bin === codex, bin)
}
{
  const home = makeHome()
  const { bin, error } = resolveGripeBin({ home, env: {} })
  check('nothing installed resolves nothing', bin === null && error !== null)
  check('the miss names the directory scanned under both caches',
    error.includes(join(cacheRoot(home, 'claude'), 'jakub', 'gripe'))
      && error.includes(join(cacheRoot(home, 'codex'), 'jakub', 'gripe')))
}

// ------------------------------------------------------------------------- GRIPE_HOME

console.log('the GRIPE_HOME override')
{
  const home = makeHome()
  plantInstall(home, 'claude', '9.9.9')
  const dev = join(TMP, 'dev-tree')
  mkdirSync(join(dev, 'bin'), { recursive: true })
  writeFileSync(join(dev, 'bin', 'gripe'), '#!/usr/bin/env node\n', { mode: 0o755 })
  check('a usable override beats every install',
    resolved(home, { GRIPE_HOME: dev }) === join(dev, 'bin', 'gripe'))

  for (const [label, value] of [['empty', ''], ['missing', join(TMP, 'nope')], ['no bin/gripe', TMP]]) {
    const { bin, error } = resolveGripeBin({ home, env: { GRIPE_HOME: value } })
    check(`a broken override (${label}) stops instead of falling through`,
      bin === null && error !== null && error.includes('GRIPE_HOME'))
  }
  check('an absent GRIPE_HOME key falls through to the caches', resolved(home, {}) !== null)
}

// ------------------------------------------------------------------- what the exit codes mean

console.log('the exit split')
{
  const empty = makeHome()
  const filed = runShim(empty, ['add', 'friction'])
  check('add exits 0 with nothing installed', filed.status === 0, `status ${filed.status}`)
  check('add still says what went wrong on stderr', filed.stderr.trim().split('\n').length === 1)
  check('bare gripe exits 0 with nothing installed', runShim(empty, []).status === 0)
  check('doctor exits 1 with nothing installed', runShim(empty, ['doctor']).status === 1)
  check('a broken override is honest for doctor too',
    runShim(empty, ['doctor'], { GRIPE_HOME: join(TMP, 'nope') }).status === 1)
  check('a broken override is still free for add',
    runShim(empty, ['add'], { GRIPE_HOME: join(TMP, 'nope') }).status === 0)
}
{
  const home = makeHome()
  const root = dirname(dirname(plantInstall(home, 'claude', '0.3.0')))
  const filed = runShim(home, ['add', '--agent', 'a1'], { GRIPE_STUB_EXIT: '3' })
  check('add passes its arguments to the winning install',
    readFileSync(join(root, 'ran'), 'utf8') === 'add --agent a1')
  check('add exits 0 even when the child fails', filed.status === 0, `status ${filed.status}`)
  const dumped = runShim(home, ['dump'], { GRIPE_STUB_EXIT: '3' })
  check('dump passes the child status through', dumped.status === 3, `status ${dumped.status}`)
  check('a real child status carries no shim line', dumped.stderr === '')
}
{
  // spawnSync reports an exec failure and a signal kill as a non-numeric status. Both are
  // free for add and honest for everything else.
  const home = makeHome()
  plantInstall(home, 'claude', '0.3.0')
  for (const [label, result] of [
    ['an exec failure', { error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }],
    ['a signal kill', { status: null, signal: 'SIGKILL' }],
  ]) {
    const opts = { home, env: {}, spawn: () => result, stderr: () => {} }
    check(`${label} is free for add`, main({ ...opts, argv: ['add'] }) === 0)
    check(`${label} is honest for doctor`, main({ ...opts, argv: ['doctor'] }) === 1)
  }
}

// ------------------------------------------------------------------------- the epoch ratchet

console.log('the epoch ratchet')
{
  const text = readFileSync(SHIM, 'utf8')
  const markers = text.split('\n').filter((line) => line.includes('gripe-shim-epoch:'))
  check('the shipped shim carries exactly one epoch marker', markers.length === 1, markers[0])
  const epoch = shimEpoch(text)
  check('pointShim can parse that marker', Number.isSafeInteger(epoch) && epoch >= 2, String(epoch))

  const bin = join(TMP, 'ratchet', 'gripe')
  check('a missing destination is written', pointShim({ sourcePath: SHIM, shimPath: bin }) === 'written')
  check('identical bytes are left alone', pointShim({ sourcePath: SHIM, shimPath: bin }) === 'unchanged')

  writeFileSync(bin, `// gripe-shim-epoch: ${epoch - 1}\n`, { mode: 0o755 })
  check('a lower epoch is replaced', pointShim({ sourcePath: SHIM, shimPath: bin }) === 'written')
  check('and the replacement is the source', readFileSync(bin, 'utf8') === text)

  const newer = `// gripe-shim-epoch: ${epoch + 1}\n`
  writeFileSync(bin, newer, { mode: 0o755 })
  check('a higher epoch survives an older harness',
    pointShim({ sourcePath: SHIM, shimPath: bin }) === 'kept-newer' && readFileSync(bin, 'utf8') === newer)
}

// -------------------------------------------------------------------- import, and self-report

console.log('importing and self-report')
{
  const home = makeHome()
  const imported = spawnSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(pathToFileURL(SHIM).href)}).then(() => {})`],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } },
  )
  check('importing the shim runs nothing',
    imported.status === 0 && imported.stdout === '' && imported.stderr === '',
    `status ${imported.status} stderr ${JSON.stringify(imported.stderr.slice(0, 80))}`)

  const facts = installFacts(pathToFileURL(join(PLUGIN, 'lib', 'install.mjs')).href)
  const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'))
  check('doctor can name the install that ran',
    facts.plugin_root === PLUGIN && facts.plugin_version === manifest.version,
    `${facts.plugin_root} ${facts.plugin_version}`)
}

rmSync(TMP, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
