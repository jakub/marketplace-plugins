#!/usr/bin/env node
// Real installer and copied dispatcher, isolated homes and Codex cache fixtures.
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const source = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), 'flow-entrypoint-'))
const probe = `let input = ''; for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), entry: import.meta.url, input }));\n`
function fixture(env, version = '1.0.0', marketplace = 'jakub', bundle = probe, slot = version) {
  const root = join(env.CODEX_HOME, 'plugins/cache', marketplace, 'flow', slot)
  for (const path of ['bin', 'scripts', '.codex-plugin', 'dist']) mkdirSync(join(root, path), { recursive: true })
  for (const path of ['bin/flow-delegate.mjs', 'scripts/install-delegate.mjs']) copyFileSync(join(source, path), join(root, path))
  writeFileSync(join(root, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'flow', version }))
  writeFileSync(join(root, 'dist/delegation.mjs'), bundle)
  return root
}
function environment(name) {
  const home = join(temp, name)
  mkdirSync(home, { recursive: true })
  return { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), PATH: `${home}/.local/bin:${process.env.PATH}` }
}
function install(root, env, action = 'install', expected = 0) {
  const result = spawnSync(process.execPath, [join(root, 'scripts/install-delegate.mjs'), action], { env, encoding: 'utf8' })
  assert.ifError(result.error)
  assert.equal(result.status, expected, `${action}: ${result.stderr}`)
  return result
}
function run(env, version, expected = 0, cwd = temp) {
  const path = join(env.HOME, '.local/bin/flow-delegate')
  const result = spawnSync(path, ['--flow-version', version, 'mcp', '--host', 'codex'], { env, cwd, input: 'input untouched', encoding: 'utf8' })
  assert.ifError(result.error)
  assert.equal(result.status, expected, `dispatch: ${result.stderr}`)
  return result
}
function asyncInstall(root, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/install-delegate.mjs'), 'install'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''; child.stderr.on('data', data => { error += data })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)))
  })
}
try {
  const env = environment('home')
  const first = fixture(env)
  const cwd = join(temp, 'actual project'); mkdirSync(cwd)
  install(first, env)
  assert.match(install(first, { ...env, PATH: '/usr/bin' }).stderr, /Codex host PATH/)
  const result = JSON.parse(run(env, '1.0.0', 0, cwd).stdout)
  assert.equal(result.cwd, cwd)
  assert.deepEqual(result.argv, ['mcp', '--host', 'codex'])
  assert.equal(result.entry, pathToFileURL(join(first, 'dist/delegation.mjs')).href)
  assert.equal(result.input, 'input untouched')
  // A package-manager upgrade is usable BEFORE its SessionStart hook runs.
  const second = fixture(env, '2.0.0')
  assert.match(run(env, '2.0.0').stdout, /2.0.0/)
  assert.match(run(env, '1.0.0').stdout, /1.0.0/)
  run(env, '3.0.0', 1)
  install(fixture(env, '1.0.0', 'other-marketplace'), env, 'install', 1)
  await Promise.all(Array.from({ length: 8 }, (_, i) => asyncInstall(i % 2 ? first : second, env)))

  const anotherHome = { ...env, CODEX_HOME: join(env.HOME, 'alternate-codex') }
  install(first, anotherHome, 'install', 1)
  run(anotherHome, '1.0.0', 1)
  const anotherFirst = fixture(anotherHome)
  install(anotherFirst, anotherHome)
  install(first, env, 'uninstall')
  run(env, '1.0.0', 1)
  run(anotherHome, '1.0.0')
  assert.ok(existsSync(join(env.HOME, '.local/bin/flow-delegate')), 'other Codex home retains launcher')
  install(anotherFirst, anotherHome, 'uninstall')
  assert.ok(!existsSync(join(env.HOME, '.local/bin/flow-delegate')))
  install(first, env)
  writeFileSync(join(first, '.orphaned_at'), 'uninstalled')
  run(env, '1.0.0', 1)
  install(first, env, 'install', 1)
  rmSync(join(first, '.orphaned_at'))
  writeFileSync(join(first, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'foreign', version: '1.0.0' }))
  run(env, '1.0.0', 1)
  writeFileSync(join(first, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'flow', version: '9.0.0' }))
  run(env, '1.0.0', 1)
  writeFileSync(join(first, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'flow', version: '1.0.0' }))
  rmSync(join(first, 'dist/delegation.mjs'))
  run(env, '1.0.0', 1)
  install(first, env, 'uninstall')
  writeFileSync(join(first, 'dist/delegation.mjs'), probe)

  const foreign = environment('foreign')
  const foreignRoot = fixture(foreign)
  mkdirSync(join(foreign.HOME, '.local/bin'), { recursive: true })
  writeFileSync(join(foreign.HOME, '.local/bin/flow-delegate'), 'unrelated')
  install(foreignRoot, foreign, 'install', 1)
  assert.equal(readFileSync(join(foreign.HOME, '.local/bin/flow-delegate'), 'utf8'), 'unrelated')
  const victim = join(temp, 'victim'); writeFileSync(victim, 'safe')
  rmSync(join(foreign.HOME, '.local/bin/flow-delegate'))
  symlinkSync(victim, join(foreign.HOME, '.local/bin/flow-delegate'))
  install(foreignRoot, foreign, 'install', 1)
  assert.equal(readFileSync(victim, 'utf8'), 'safe')
  const linked = environment('linked')
  const linkedRoot = fixture(linked)
  symlinkSync(temp, join(linked.HOME, '.local'))
  install(linkedRoot, linked, 'install', 1)

  const mappingEnv = environment('mapping')
  const mappingRoot = fixture(mappingEnv)
  install(mappingRoot, mappingEnv)
  const registry = join(mappingEnv.HOME, '.local/share/flow-delegate/registrations')
  const mapping = join(registry, readdirSync(registry)[0])
  rmSync(mapping); symlinkSync(victim, mapping)
  install(mappingRoot, mappingEnv, 'install', 1)
  install(mappingRoot, mappingEnv, 'uninstall', 1)
  run(mappingEnv, '1.0.0', 1)
  assert.equal(readFileSync(victim, 'utf8'), 'safe')

  const upgradeEnv = environment('protocol-upgrade')
  const oldRoot = fixture(upgradeEnv)
  install(oldRoot, upgradeEnv)
  const newRoot = fixture(upgradeEnv, '2.0.0')
  const newSource = join(newRoot, 'bin/flow-delegate.mjs')
  const future = readFileSync(newSource, 'utf8').replace('launcher-epoch: 1', 'launcher-epoch: 2').replace('export const epoch = 1', 'export const epoch = 2')
  writeFileSync(newSource, future)
  install(newRoot, upgradeEnv)
  const launcher = join(upgradeEnv.HOME, '.local/bin/flow-delegate')
  assert.equal(readFileSync(launcher, 'utf8'), future)
  install(oldRoot, upgradeEnv)
  assert.equal(readFileSync(launcher, 'utf8'), future, 'rollback does not downgrade dispatcher')
  run(upgradeEnv, '1.0.0')
  run(upgradeEnv, '2.0.0')
  writeFileSync(launcher, future + '// altered\n')
  install(newRoot, upgradeEnv, 'install', 1)

  const localEnv = environment('local-slot')
  const local = fixture(localEnv, '1.0.0', 'jakub', probe, 'local')
  install(local, localEnv)
  run(localEnv, '1.0.0')
  fixture(localEnv, '2.0.0', 'jakub', probe, 'local')
  run(localEnv, '2.0.0')
  run(localEnv, '1.0.0', 1)

  const symlinkEnv = environment('bundle-symlink')
  const symlinkRoot = fixture(symlinkEnv)
  install(symlinkRoot, symlinkEnv)
  rmSync(join(symlinkRoot, 'dist/delegation.mjs'))
  symlinkSync(victim, join(symlinkRoot, 'dist/delegation.mjs'))
  run(symlinkEnv, '1.0.0', 1)
  const third = fixture(symlinkEnv, '3.0.0')
  rmSync(third, { recursive: true })
  symlinkSync(symlinkRoot, third)
  run(symlinkEnv, '3.0.0', 1)

  const preserved = environment('preserve-foreign-state')
  const preservedRoot = fixture(preserved)
  install(preservedRoot, preserved)
  const unknown = join(preserved.HOME, '.local/share/flow-delegate/registrations/unrelated')
  writeFileSync(unknown, 'unrelated')
  install(preservedRoot, preserved, 'uninstall')
  assert.equal(readFileSync(unknown, 'utf8'), 'unrelated')
  assert.ok(existsSync(join(preserved.HOME, '.local/bin/flow-delegate')))

  const lock = join(preserved.HOME, '.local/share/flow-delegate/install.lock')
  symlinkSync(temp, lock)
  install(preservedRoot, preserved, 'install', 1)
  rmSync(lock)
  mkdirSync(lock)
  const waiting = Date.now()
  assert.match(install(preservedRoot, preserved, 'install', 1).stderr, /lock is busy/)
  assert.ok(Date.now() - waiting < 6000, 'lock wait is bounded')
  assert.ok(existsSync(lock), 'installer does not steal a stale lock')
  rmSync(lock, { recursive: true })

  const signalEnv = environment('signals')
  const signalRoot = fixture(signalEnv, '4.0.0', 'jakub', `process.on('SIGTERM', () => process.exit(42)); console.log('ready'); setInterval(() => {}, 1000);\n`)
  install(signalRoot, signalEnv)
  await new Promise((resolve, reject) => {
    const child = spawn(join(signalEnv.HOME, '.local/bin/flow-delegate'), ['--flow-version', '4.0.0'], { env: signalEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('signal probe timed out')) }, 5000)
    child.stdout.once('data', () => child.kill('SIGTERM'))
    child.on('error', reject)
    child.on('exit', code => { clearTimeout(timer); try { assert.equal(code, 42); resolve() } catch (error) { reject(error) } })
  })
  console.log('delegate entrypoint: ALL PASS')
} finally { rmSync(temp, { recursive: true, force: true }) }
