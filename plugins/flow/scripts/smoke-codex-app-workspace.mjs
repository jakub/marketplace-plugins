#!/usr/bin/env node
// Exercise the real Codex plugin loader without a model turn or provider credentials.
// The caller must install Codex first. Everything else, including the plugin cache and
// PATH command, lives in a disposable home. Two concurrent threads must start separate
// Flow servers in their own Git roots even though App Server starts outside either root.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const plugin = join(dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(join(tmpdir(), 'flow-app-workspace-'))
const home = join(temp, 'home')
const codexHome = join(home, '.codex')
const market = join(temp, 'market')
const version = JSON.parse(readFileSync(join(plugin, '.codex-plugin/plugin.json'))).version
const executable = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim()
const env = Object.fromEntries(['PATH', 'LANG', 'TERM', 'SHELL', 'USER', 'LOGNAME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
Object.assign(env, { HOME: home, CODEX_HOME: codexHome, PATH: `${home}/.local/bin:${env.PATH}`, PWD: temp, CODEX_PROJECT_DIR: temp, CLAUDE_PROJECT_DIR: temp })
let child
let stderr = ''
let nextId = 0
const pending = new Map()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function rpc(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 30_000)
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
}

async function waitServer(threadId) {
  for (let n = 0; n < 100; n++) {
    const result = await rpc('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' })
    const server = result.data.find(s => s.pluginId === 'flow@flow-app-test' && s.name === 'flow_delegate')
    assert.ok(server, 'installed Flow server appears in the thread inventory')
    assert.notEqual(server.runtimeStatus, 'failed', `Flow startup failed: ${stderr.slice(-2000)}`)
    if (server.runtimeStatus === 'connected') {
      assert.equal(server.serverInfo.version, version)
      assert.ok(server.tools.delegation_doctor, 'doctor is callable')
      return server
    }
    await delay(100)
  }
  throw new Error('Flow never connected')
}

function serverDirectories() {
  const result = []
  for (const pid of readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      if (!args.some(a => a === join(home, '.local/bin/flow-delegate'))) continue
      result.push(readlinkSync(`/proc/${pid}/cwd`))
    } catch {}
  }
  return result.sort()
}

try {
  mkdirSync(codexHome, { recursive: true })
  mkdirSync(join(market, '.claude-plugin'), { recursive: true })
  cpSync(plugin, join(market, 'flow'), { recursive: true, filter: path => !path.includes('/deps/node_modules') })
  writeFileSync(join(market, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'flow-app-test', plugins: [{ name: 'flow', source: './flow', version, description: 'Disposable Flow integration test' }] }))
  const run = (args, cwd = temp) => execFileSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  const codexVersion = run(['--version']).trim()
  run(['plugin', 'marketplace', 'add', market, '--json'])
  const installed = JSON.parse(run(['plugin', 'add', 'flow@flow-app-test', '--json'])).installedPath
  execFileSync(process.execPath, [join(installed, 'scripts/install-delegate.mjs'), 'install'], { cwd: temp, env, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.ok(existsSync(join(home, '.local/bin/flow-delegate')))
  const roots = ['project-a', 'project-b'].map(name => join(temp, name))
  for (const root of roots) {
    mkdirSync(root)
    execFileSync('git', ['init', '-q', root], { env, stdio: 'pipe' })
  }
  child = spawn(executable, ['app-server', '--stdio'], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-8000) })
  child.on('error', error => { for (const request of pending.values()) request.reject(error); pending.clear() })
  child.on('exit', () => { for (const request of pending.values()) request.reject(new Error('App Server exited')); pending.clear() })
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  })
  await rpc('initialize', { clientInfo: { name: 'flow-app-workspace-smoke', version: '1' }, capabilities: { experimentalApi: true } })
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
  for (const root of roots) {
    const result = await rpc('thread/start', { cwd: root, experimentalRawEvents: false, persistExtendedHistory: false })
    await waitServer(result.thread.id)
  }
  assert.deepEqual(serverDirectories(), roots.sort(), 'each installed Flow process inherits exactly its own thread project, without PWD or project-variable authority')
  console.log(`Codex app workspace: ALL PASS (${codexVersion}; Flow ${version}; two isolated project threads; no model turns)`)
} finally {
  if (child && child.exitCode === null) {
    child.stdin.end()
    for (let n = 0; n < 50 && child.exitCode === null; n++) await delay(100)
    if (child.exitCode === null) child.kill('SIGTERM')
    for (let n = 0; n < 50 && child.exitCode === null; n++) await delay(100)
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'App Server stopped before fixture cleanup')
  }
  rmSync(temp, { recursive: true, force: true })
}
