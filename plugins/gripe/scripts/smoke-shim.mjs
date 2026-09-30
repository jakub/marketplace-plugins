#!/usr/bin/env node
// gripe shim smoke. Every wrong pick the shim can make is invisible from a green `gripe add`:
// the wrong version, a development override silently ignored, a published shim downgraded by
// the older harness. So this covers which install wins across the two plugin caches, the
// GRIPE_HOME override, what each exit code promises, and SessionStart's epoch compare. Every
// synthetic home lives under one temp directory; nothing reads the real ~/.claude or ~/.codex.
//
// Usage: node plugins/gripe/scripts/smoke-shim.mjs

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { main, resolveGripeBin } from '../bin/shim.mjs'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHIM = join(PLUGIN, 'bin', 'shim.mjs')
const TMP = mkdtempSync(join(tmpdir(), 'gripe-shim-'))

let checks = 0
let failures = 0
function check(name, ok, detail) {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${!ok && detail !== undefined ? ` - ${detail}` : ''}`)
}

let serial = 0
function makeHome() {
  const home = join(TMP, `home-${serial++}`)
  mkdirSync(home, { recursive: true })
  return home
}

// A stub bin/gripe that records the arguments it was handed, so a case can prove which
// install ran, and exits with GRIPE_STUB_EXIT.
function plant(home, harness, version, { bin = true, marketplace = 'jakub', orphaned = false } = {}) {
  const root = join(home, `.${harness}`, 'plugins', 'cache', marketplace, 'gripe', version)
  mkdirSync(join(root, 'bin'), { recursive: true })
  // Claude Code's marker for a version it has uninstalled or superseded but not yet deleted.
  if (orphaned) writeFileSync(join(root, '.orphaned_at'), '1787531315877')
  if (bin) {
    writeFileSync(join(root, 'bin', 'gripe'),
      `require('fs').writeFileSync(${JSON.stringify(join(root, 'ran'))}, process.argv.slice(2).join(' '))\n` +
      'process.exitCode = Number(process.env.GRIPE_STUB_EXIT || 0)\n')
  }
  return join(root, 'bin', 'gripe')
}

const runShim = (home, argv, extra = {}) => spawnSync(process.execPath, [SHIM, ...argv],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ...extra } })

console.log('which install wins')
for (const [name, installs, winner] of [
  ['the newer Codex cache beats the older Claude one', [['claude', '0.2.0'], ['codex', '0.3.0']], 1],
  ['the newer Claude cache beats the older Codex one', [['claude', '0.4.0'], ['codex', '0.3.0']], 0],
  ['versions compare numerically, so 0.10.0 beats 0.9.0', [['claude', '0.9.0'], ['claude', '0.10.0']], 1],
  ['a higher version carrying .orphaned_at is skipped', [['claude', '0.3.0'], ['claude', '0.4.0', { orphaned: true }]], 0],
  ['a higher version under another marketplace is skipped',
    [['codex', '0.3.0'], ['claude', '9.9.9', { marketplace: 'someone-else' }]], 0],
  ['a directory that is not dotted integers is skipped', [['claude', '0.1.0'], ['claude', 'latest'], ['claude', '0.4.0-rc1']], 0],
  ['a version directory with no bin/gripe is skipped', [['codex', '0.1.0'], ['codex', '0.5.0', { bin: false }]], 0],
]) {
  const home = makeHome()
  const bins = installs.map(([harness, version, opts]) => plant(home, harness, version, opts))
  const got = resolveGripeBin({ home, env: {} }).bin
  check(name, got === bins[winner], got)
}
{
  const home = makeHome()
  const elsewhere = makeHome()
  const codex = plant(elsewhere, 'codex', '0.3.0')
  check('CODEX_HOME moves the Codex cache',
    resolveGripeBin({ home, env: { CODEX_HOME: join(elsewhere, '.codex') } }).bin === codex)
  const { bin, error } = resolveGripeBin({ home, env: {} })
  check('nothing installed names the directory scanned under both caches, never a version',
    bin === null && error.includes(join(home, '.claude', 'plugins', 'cache', 'jakub', 'gripe'))
      && error.includes(join(home, '.codex', 'plugins', 'cache', 'jakub', 'gripe')), error)
}

console.log('the GRIPE_HOME override')
{
  const home = makeHome()
  plant(home, 'claude', '9.9.9')
  check('a usable override beats every install',
    resolveGripeBin({ home, env: { GRIPE_HOME: PLUGIN } }).bin === join(PLUGIN, 'bin', 'gripe'))
  for (const value of ['', join(TMP, 'nope'), TMP]) {
    const { bin, error } = resolveGripeBin({ home, env: { GRIPE_HOME: value } })
    check(`a broken override (${JSON.stringify(value)}) stops instead of falling through`,
      bin === null && error.includes('GRIPE_HOME'), error)
  }
}

console.log('the exit split')
{
  const empty = makeHome()
  const filed = runShim(empty, ['add', 'friction'])
  check('add exits 0 with nothing installed and says why in one stderr line',
    filed.status === 0 && filed.stderr.trim().split('\n').length === 1, filed.stderr)
  check('bare gripe exits 0 with nothing installed', runShim(empty, []).status === 0)
  check('doctor exits 1 with nothing installed', runShim(empty, ['doctor']).status === 1)
  const broken = { GRIPE_HOME: join(TMP, 'nope') }
  check('a broken override is free for add and honest for doctor',
    runShim(empty, ['add'], broken).status === 0 && runShim(empty, ['doctor'], broken).status === 1)

  const home = makeHome()
  const root = dirname(dirname(plant(home, 'claude', '0.3.0')))
  const added = runShim(home, ['add', '--agent', 'a1'], { GRIPE_STUB_EXIT: '3' })
  check('add hands its arguments to the winner and exits 0 over a failing child',
    added.status === 0 && readFileSync(join(root, 'ran'), 'utf8') === 'add --agent a1', `status ${added.status}`)
  const dumped = runShim(home, ['dump'], { GRIPE_STUB_EXIT: '3' })
  check('dump passes the child status through with no shim line',
    dumped.status === 3 && dumped.stderr === '', `status ${dumped.status}`)
  // spawnSync reports an exec failure and a signal kill as a non-numeric status.
  for (const [label, result] of [
    ['an exec failure', { error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }],
    ['a signal kill', { status: null, signal: 'SIGKILL' }],
  ]) {
    const opts = { home, env: {}, spawn: () => result, stderr: () => {} }
    check(`${label} is free for add and honest for doctor`,
      main({ ...opts, argv: ['add'] }) === 0 && main({ ...opts, argv: ['doctor'] }) === 1)
  }
  const imported = spawnSync(process.execPath,
    ['-e', `import(${JSON.stringify(pathToFileURL(SHIM).href)})`],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } })
  check('importing the shim runs nothing',
    imported.status === 0 && imported.stdout === '' && imported.stderr === '', imported.stderr)
}

console.log('SessionStart publishes the shim by epoch')
{
  const text = readFileSync(SHIM, 'utf8')
  const markers = text.split('\n').filter((line) => line.includes('gripe-shim-epoch:'))
  const epoch = Number(text.match(/^\/\/ gripe-shim-epoch: (\d+)$/m)?.[1])
  check('the shipped shim carries exactly one epoch marker', markers.length === 1 && epoch >= 2, markers[0])

  // The real hook on stdin, with HOME pointed at a synthetic home so ~/.local/bin is ours.
  const home = makeHome()
  const bin = join(home, '.local', 'bin', 'gripe')
  const start = (extra = {}) => spawnSync(process.execPath, [join(PLUGIN, 'hooks', 'scripts', 'session-start.mjs')], {
    input: '{"session_id":"s1"}', encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(home, 'state'), ...extra },
  })
  const started = start()
  check('a missing shim is published at 0755',
    started.status === 0 && readFileSync(bin, 'utf8') === text && (statSync(bin).mode & 0o777) === 0o755,
    `status ${started.status}`)
  for (const [label, planted, replaced] of [
    ['a lower epoch is replaced', `// gripe-shim-epoch: ${epoch - 1}\n`, true],
    ['a file with no marker is replaced', 'not a shim\n', true],
    ['an equal epoch is left alone', `// gripe-shim-epoch: ${epoch}\n`, false],
    ['a higher epoch survives an older harness', `// gripe-shim-epoch: ${epoch + 1}\n`, false],
  ]) {
    writeFileSync(bin, planted)
    start()
    const now = readFileSync(bin, 'utf8')
    check(label, replaced ? now === text : now === planted)
  }
  writeFileSync(bin, 'not a shim\n')
  start({ GRIPE_HOME: PLUGIN })
  check('GRIPE_HOME in the environment publishes nothing', readFileSync(bin, 'utf8') === 'not a shim\n')

  // doctor names the install that answered, from its own path and manifest.
  const doctor = spawnSync(process.execPath, [join(PLUGIN, 'bin', 'gripe'), 'doctor'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(home, 'state') },
  })
  let facts = {}
  try { facts = JSON.parse(doctor.stdout) } catch {}
  const { version } = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'))
  check('doctor names the install that ran', facts.plugin_root === PLUGIN && facts.plugin_version === version,
    `${facts.plugin_root} ${facts.plugin_version}`)
}

rmSync(TMP, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
