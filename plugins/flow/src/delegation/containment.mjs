import { randomUUID } from 'node:crypto'
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

function probeProviderContainment() {
  const scopeName = providerScopeName(`probe-${process.pid}-${randomUUID()}`)
  try {
    // Leave a detached grandchild in the probe scope after systemd-run returns. A zero exit only
    // proves that systemd accepted the command; Flow also needs cgroup.events for later liveness
    // checks, quarantine, and lease release.
    const probe = 'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true}); child.unref()'
    const result = spawnSync('systemd-run', [...scopeOptions(scopeName), '--', process.execPath, '-e', probe], {
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
  }
}

// The whole subsystem requires Linux, and this is where that requirement is enforced for
// both routes: no transient systemd scope, no delegation.
export function providerContainmentSupport({ fresh = false } = {}) {
  if (process.platform !== 'linux') {
    return { ok: false, kind: 'UNSUPPORTED_HOST', mode: null, platform: process.platform, required: 'linux' }
  }
  if (!fresh && cachedContainmentSupport) return cachedContainmentSupport
  cachedContainmentSupport = probeProviderContainment()
  return cachedContainmentSupport
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
