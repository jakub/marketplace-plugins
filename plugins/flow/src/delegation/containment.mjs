import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { processStartToken } from './store.mjs'

const probeWait = new Int32Array(new SharedArrayBuffer(4))
let cachedContainmentSupport = null
const controlGroupCache = new Map()

const scopeOptions = (scopeName) => [
  '--user',
  '--scope',
  '--quiet',
  '--collect',
  '--property=Delegate=no',
  `--unit=${scopeName}`,
]

export function providerScopeName(id = randomUUID()) {
  const safe = String(id).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80)
  return `flow-delegation-${safe}.scope`
}

function probeProviderContainment(env) {
  const scopeName = providerScopeName(`probe-${process.pid}-${randomUUID()}`)
  try {
    // Leave a detached grandchild in the probe scope after systemd-run returns. A zero exit only
    // proves that systemd accepted the command; Flow also needs cgroup.events for later liveness
    // checks, quarantine, and lease release.
    const probe = 'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true}); child.unref()'
    const launch = scopedProviderCommand(process.execPath, ['-e', probe], scopeName)
    const result = spawnSync(launch.command, launch.args, {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    })
    if (result.status !== 0) return { ok: false, kind: 'CONTAINMENT_UNAVAILABLE', mode: null }
    for (let attempt = 0; attempt < 20; attempt++) {
      if (providerScopeRunning(scopeName)) return { ok: true, kind: null, mode: 'systemd-scope' }
      Atomics.wait(probeWait, 0, 0, 25)
    }
    return { ok: false, kind: 'CONTAINMENT_UNAVAILABLE', mode: null }
  } finally {
    // Cleanup is unconditional because systemd-run can time out or lose its reply after
    // systemd creates the scope. Treating that as "not launched" would leak the probe child.
    signalProviderScope(scopeName, 'SIGKILL')
    for (let attempt = 0; attempt < 20 && providerScopeRunning(scopeName); attempt++) {
      Atomics.wait(probeWait, 0, 0, 25)
    }
    controlGroupCache.delete(scopeName)
  }
}

// The whole subsystem requires Linux, and this is where that requirement is enforced for
// both routes: no transient systemd scope, no delegation.
export function providerContainmentSupport({ fresh = false, env = process.env } = {}) {
  if (process.platform !== 'linux') {
    return { ok: false, kind: 'UNSUPPORTED_HOST', mode: null, platform: process.platform, required: 'linux' }
  }
  // Match the whole launch environment by value, including wrapper-specific variables.
  // Keep only its digest and the latest result, so the cache retains neither credentials
  // nor an entry for every environment seen. Doctor still forces a fresh probe.
  const key = createHash('sha256').update(JSON.stringify(Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
  if (!fresh && cachedContainmentSupport?.key === key) return cachedContainmentSupport.result
  const result = probeProviderContainment(env)
  cachedContainmentSupport = { key, result }
  return result
}

export function scopedProviderCommand(command, args, scopeName) {
  return {
    command: 'systemd-run',
    args: [...scopeOptions(scopeName), '--', command, ...args],
  }
}

function scopeControlGroup(scopeName) {
  if (!scopeName) return null
  const cached = controlGroupCache.get(scopeName)
  if (cached) return cached
  try {
    const value = execFileSync('systemctl', [
      '--user', 'show', scopeName, '--property=ControlGroup', '--value',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim()
    if (!value.startsWith('/')) return null
    controlGroupCache.set(scopeName, value)
    return value
  } catch { return null }
}

export function providerScopeRunning(scopeName) {
  const controlGroup = scopeControlGroup(scopeName)
  if (!controlGroup) return false
  try {
    const events = readFileSync(`/sys/fs/cgroup${controlGroup}/cgroup.events`, 'utf8')
    return /^populated 1$/m.test(events)
  } catch { return false }
}

export function signalProviderScope(scopeName, signal) {
  if (!scopeName) return
  try {
    execFileSync('systemctl', [
      '--user', 'kill', `--signal=${signal}`, '--kill-whom=all', scopeName,
    ], { stdio: 'ignore', timeout: 5_000 })
  } catch {}
}

export function trackedDescendantRunning(knownDescendants) {
  for (const [pid, token] of knownDescendants) {
    if (processStartToken(pid) === token) return true
    knownDescendants.delete(pid)
  }
  return false
}

export function captureProcessDescendants(rootPid, knownDescendants, { freeze = false } = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return
  if (freeze) try { process.kill(-rootPid, 'SIGSTOP') } catch {}
  for (let pass = 0; pass < 4; pass++) {
    let added = false
    const visited = new Set()
    const queue = [rootPid, ...knownDescendants.keys()]
    while (queue.length) {
      const parent = queue.shift()
      if (visited.has(parent)) continue
      visited.add(parent)
      let taskIds
      try { taskIds = readdirSync(`/proc/${parent}/task`) } catch { continue }
      for (const taskId of taskIds) {
        let children
        try { children = readFileSync(`/proc/${parent}/task/${taskId}/children`, 'utf8') } catch { continue }
        for (const value of children.trim().split(/\s+/)) {
          const pid = Number(value)
          if (!Number.isInteger(pid) || pid <= 0 || pid === rootPid) continue
          const token = processStartToken(pid)
          if (!token) continue
          queue.push(pid)
          const known = knownDescendants.get(pid) === token
          knownDescendants.set(pid, token)
          if (freeze) try { process.kill(pid, 'SIGSTOP') } catch {}
          if (known) continue
          added = true
        }
      }
    }
    if (!added) return
  }
}

export function signalTrackedProcessTree(rootPid, knownDescendants, signal) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return
  try { process.kill(-rootPid, signal) } catch {}
  for (const [pid, token] of knownDescendants) {
    if (processStartToken(pid) !== token) {
      knownDescendants.delete(pid)
      continue
    }
    try { process.kill(pid, signal) } catch {}
  }
  if (signal === 'SIGTERM') {
    try { process.kill(-rootPid, 'SIGCONT') } catch {}
    for (const [pid, token] of knownDescendants) {
      if (processStartToken(pid) === token) try { process.kill(pid, 'SIGCONT') } catch {}
    }
  }
}
