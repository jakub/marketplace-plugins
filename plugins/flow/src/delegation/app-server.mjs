import { spawn, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { resolveExecutablePaths } from './claude-policy.mjs'
import { captureProcessDescendants, providerScopeName, providerScopeRunning, scopedProviderCommand, signalProviderScope, signalTrackedProcessTree, trackedDescendantRunning } from './containment.mjs'
import { DelegationError } from './contracts.mjs'
import { processStartToken } from './store.mjs'
import { VERSION } from './version.mjs'

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
])

const MCP_PAGE_LIMIT = 100
const MCP_MAX_PAGES = 10
export const CODEX_PERMISSION_PROFILE = 'flow_delegation'
const MIN_CODEX_VERSION = [0, 150, 1]

export const isApprovalRequest = (method) => APPROVAL_METHODS.has(method)

export class AppServerClient {
  constructor({ cwd, env = {}, experimentalApi = false, scopeName = null, onNotification = () => {}, onServerRequest = () => {}, onClose = () => {} } = {}) {
    this.cwd = cwd
    this.env = env
    this.experimentalApi = experimentalApi
    this.onNotification = onNotification
    this.onServerRequest = onServerRequest
    this.onClose = onClose
    this.scopeName = process.platform === 'linux' ? scopeName || providerScopeName() : null
    this.child = null
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.transportError = null
    this.closeInfo = null
    this.knownDescendants = new Map()
    this.closePromise = new Promise((resolve) => { this.resolveClose = resolve })
  }

  async start() {
    const bin = process.env.FLOW_DELEGATION_CODEX_BIN || 'codex'
    const launch = scopedProviderCommand(bin, ['app-server', '--stdio'], this.scopeName)
    try {
      this.child = spawn(launch.command, launch.args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        // A separate POSIX process group lets Flow prove that App Server and every ordinary
        // descendant stopped before it releases a workspace-write lease.
        detached: process.platform !== 'win32',
      })
    } catch (cause) {
      throw new DelegationError('CODEX_NOT_INSTALLED', 'Codex could not be started.')
    }
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line))
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-16_384) })
    this.child.stdin.on('error', (cause) => this.handleTransportFailure(cause))
    this.child.on('error', (cause) => this.handleClose(null, cause))
    this.child.on('close', (code, signal) => this.handleClose({ code, signal }, null))
    await this.request('initialize', {
      clientInfo: { name: 'flow-delegation', title: 'Flow delegation', version: VERSION },
      capabilities: {
        experimentalApi: this.experimentalApi,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: null,
        extensions: null,
      },
    }, 20_000)
    this.notify('initialized')
    return this
  }

  handleClose(info, cause) {
    if (this.closeInfo) return
    this.closeInfo = { ...info, cause }
    const error = this.transportError || (cause instanceof DelegationError
      ? cause
      : cause?.code === 'ENOENT'
      ? new DelegationError('CODEX_NOT_INSTALLED', 'Codex could not be started.')
      : new DelegationError('APP_SERVER_EXIT', 'Codex App Server exited before the request completed.', {
        exitCode: info?.code ?? null,
        signal: info?.signal ?? null,
      }))
    if (!this.transportError) {
      try { this.onClose(error) } catch {}
      for (const { reject } of this.pending.values()) reject(error)
      this.pending.clear()
    }
    this.resolveClose(this.closeInfo)
  }

  handleTransportFailure(cause) {
    if (this.transportError || this.closeInfo) return
    this.transportError = cause instanceof DelegationError
      ? cause
      : new DelegationError('APP_SERVER_EXIT', 'Codex App Server exited before the request completed.', {
        exitCode: null,
        signal: null,
      })
    try { this.onClose(this.transportError) } catch {}
    for (const { reject } of this.pending.values()) reject(this.transportError)
    this.pending.clear()
    try { this.child?.kill('SIGTERM') } catch {}
  }

  handleLine(line) {
    let message
    try { message = JSON.parse(line) } catch {
      const error = new DelegationError('APP_SERVER_PROTOCOL', 'Codex App Server wrote an invalid protocol message.')
      this.handleTransportFailure(error)
      return
    }
    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new DelegationError('APP_SERVER_ERROR', 'Codex App Server rejected a request.', {
          code: message.error.code ?? null,
        }))
      } else pending.resolve(message.result)
      return
    }
    if (Object.hasOwn(message, 'id') && message.method) {
      this.handleServerRequest(message)
      return
    }
    if (message.method) this.onNotification(message.method, message.params || {})
  }

  handleServerRequest(message) {
    this.onServerRequest(message.method, message.params || {})
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      this.respond(message.id, { decision: 'decline' })
    } else if (message.method === 'item/permissions/requestApproval') {
      this.respond(message.id, { permissions: {} })
    } else if (message.method === 'applyPatchApproval' || message.method === 'execCommandApproval') {
      this.respond(message.id, { decision: { denied: { rejection: 'Flow does not grant delegated approvals.' } } })
    } else {
      this.respondError(message.id, -32601, APPROVAL_METHODS.has(message.method)
        ? 'Flow denied an unsupported approval request.'
        : 'Flow does not implement this App Server request.')
    }
  }

  write(message) {
    if (this.transportError) throw this.transportError
    if (!this.child || this.closeInfo) throw new DelegationError('APP_SERVER_EXIT', 'Codex App Server is not running.')
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`) } catch (cause) {
      this.handleTransportFailure(cause)
      throw this.transportError
    }
  }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new DelegationError('APP_SERVER_TIMEOUT', `Codex App Server did not answer ${method}.`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      try {
        this.write({ method, id, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method, params) {
    const message = { method }
    if (params !== undefined) message.params = params
    this.write(message)
  }

  respond(id, result) { this.write({ id, result }) }
  respondError(id, code, message) { this.write({ id, error: { code, message } }) }

  // The loser of the race must not hold the event loop open: without the clear, an exit that
  // wins in 5ms still waits out the full guard timer.
  waitClose(ms) {
    let timer
    return Promise.race([
      this.closePromise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms) }),
    ]).finally(() => clearTimeout(timer))
  }

  treeRunning() {
    if (!this.child?.pid) return false
    if (process.platform === 'win32') return this.child.exitCode === null && !this.child.signalCode
    if (providerScopeRunning(this.scopeName)) return true
    let groupRunning = false
    try {
      process.kill(-this.child.pid, 0)
      groupRunning = true
    } catch (error) {
      groupRunning = error?.code === 'EPERM'
    }
    return groupRunning || this.descendantRunning()
  }

  descendantRunning() {
    return trackedDescendantRunning(this.knownDescendants)
  }

  captureDescendants({ freeze = false } = {}) {
    captureProcessDescendants(this.child?.pid, this.knownDescendants, { freeze })
  }

  trackedProcesses() {
    const tracked = []
    if (this.child?.pid) {
      const token = processStartToken(this.child.pid)
      if (token) tracked.push({ pid: this.child.pid, startToken: token })
    }
    for (const [pid, token] of this.knownDescendants) {
      if (processStartToken(pid) === token) tracked.push({ pid, startToken: token })
      else this.knownDescendants.delete(pid)
    }
    return tracked
  }

  signalTree(signal) {
    if (!this.child?.pid) return
    signalProviderScope(this.scopeName, signal)
    if (process.platform === 'win32') {
      try { this.child.kill(signal) } catch {}
    } else signalTrackedProcessTree(this.child.pid, this.knownDescendants, signal)
  }

  async waitTree(ms) {
    const deadline = Date.now() + ms
    while (this.treeRunning() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return !this.treeRunning()
  }

  async stop(graceMs = 2_000) {
    if (!this.child) return this.closeInfo
    // Capture children before asking the server to exit. A command may have moved into a new
    // process group, so the server group alone is not a complete process inventory.
    this.captureDescendants()
    if (!this.closeInfo && !this.transportError) {
      try { this.child.stdin.end() } catch {}
    }
    if (this.treeRunning() && !this.closeInfo) await this.waitClose(graceMs)
    if (this.treeRunning()) {
      this.captureDescendants({ freeze: true })
      this.signalTree('SIGTERM')
      await this.waitTree(1_000)
    }
    if (this.treeRunning()) {
      this.signalTree('SIGKILL')
      await this.waitTree(1_000)
    }
    if (!this.treeRunning() && !this.closeInfo) await this.waitClose(100)
    return this.treeRunning() ? null : (this.closeInfo || { code: null, signal: null, cause: null })
  }
}

async function mcpStatusPages(client, threadId = null) {
  const statuses = []
  const cursors = new Set()
  let cursor = null
  for (let page = 0; page < MCP_MAX_PAGES; page++) {
    const response = await client.request('mcpServerStatus/list', {
      threadId,
      detail: 'toolsAndAuthOnly',
      limit: MCP_PAGE_LIMIT,
      cursor,
    }, 30_000)
    if (!Array.isArray(response?.data)) {
      throw new DelegationError('MCP_ISOLATION', 'Codex returned an invalid MCP inventory.')
    }
    statuses.push(...response.data)
    const next = response.nextCursor || null
    if (!next) return statuses
    if (cursors.has(next)) {
      throw new DelegationError('MCP_ISOLATION', 'Codex repeated an MCP inventory cursor.')
    }
    cursors.add(next)
    cursor = next
  }
  throw new DelegationError('MCP_ISOLATION', 'The Codex MCP inventory is too large to verify safely.')
}

// thread/start config is a session-flags layer. Plugin selection ignores per-thread
// plugins.* entries, so Flow disables the plugin and app feature gates, then explicitly
// disables every standalone MCP discovered from the effective global configuration.
export async function isolatedThreadConfig(client) {
  const statuses = await mcpStatusPages(client)
  const mcpServers = {}
  for (const status of statuses) {
    if (typeof status?.name !== 'string' || !status.name) {
      throw new DelegationError('MCP_ISOLATION', 'Codex returned an unnamed MCP server.')
    }
    if (!status.pluginId && status.name !== 'codex_apps') {
      mcpServers[status.name] = { enabled: false }
    }
  }
  return {
    'features.plugins': false,
    'features.apps': false,
    mcp_servers: mcpServers,
    apps: { _default: { enabled: false } },
  }
}

export async function assertThreadMcpIsolated(client, threadId) {
  const statuses = await mcpStatusPages(client, threadId)
  const exposed = statuses.filter((status) =>
    Object.keys(status?.tools || {}).length > 0 || status?.runtimeStatus !== 'disabled')
  if (exposed.length) {
    throw new DelegationError('MCP_ISOLATION', 'Flow refused to send the prompt because Codex exposed delegated MCP tools.', {
      servers: exposed.slice(0, 20).map((status) => status?.name || 'unknown'),
    })
  }
  return { servers: statuses.length }
}

export function codexVersion() {
  const bin = process.env.FLOW_DELEGATION_CODEX_BIN || 'codex'
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (result.error?.code === 'ENOENT') return { ok: false, kind: 'CODEX_NOT_INSTALLED', version: null }
  if (result.status !== 0) return { ok: false, kind: 'CODEX_VERSION', version: null }
  const version = result.stdout.trim()
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(version)
  if (!match) return { ok: false, kind: 'CODEX_VERSION', version }
  const actual = match.slice(1).map(Number)
  let comparison = 0
  for (let index = 0; index < MIN_CODEX_VERSION.length; index++) {
    if (actual[index] === MIN_CODEX_VERSION[index]) continue
    comparison = actual[index] > MIN_CODEX_VERSION[index] ? 1 : -1
    break
  }
  const compatible = comparison >= 0
  return compatible
    ? { ok: true, kind: null, version }
    : { ok: false, kind: 'CODEX_TOO_OLD', version, minimum: MIN_CODEX_VERSION.join('.') }
}

export function codexHostSupport() {
  if (process.platform !== 'linux') {
    return { ok: false, kind: 'UNSUPPORTED_HOST', platform: process.platform, required: 'linux' }
  }
  return { ok: true, kind: null, platform: process.platform, required: 'linux' }
}

// Codex implements profile filesystem restrictions with bubblewrap and re-execs its own
// binary inside that namespace to run every shell command. A profile that omits the Codex
// install tree therefore breaks all delegated commands with execvp ENOENT while the job
// still reports success (openai/codex#29049; npm installs under ~/.local are #24341). For
// an npm install the re-exec target is the vendor ELF nested inside the @openai/codex
// package, so the grant covers the whole package root, not just the resolved wrapper.
// Read access here does let the sandboxed process launch a nested codex, but the profile
// never grants ~/.codex and network stays disabled, so a nested launch has no auth and no
// egress. Retire this grant when upstream binds its own runtime unconditionally.
function packageRootFor(binaryPath) {
  const segments = binaryPath.split(sep)
  const index = segments.lastIndexOf('node_modules')
  if (index === -1 || index + 1 >= segments.length) return binaryPath
  const packageDepth = segments[index + 1].startsWith('@') ? 2 : 1
  return segments.slice(0, index + 1 + packageDepth).join(sep) || binaryPath
}

let cachedCodexRuntimePaths = null
export function codexRuntimeReadPaths() {
  if (cachedCodexRuntimePaths) return cachedCodexRuntimePaths
  const paths = new Set()
  for (const binary of resolveExecutablePaths([process.env.FLOW_DELEGATION_CODEX_BIN || 'codex'])) {
    // resolveExecutablePaths returns both the PATH entry (usually a symlink into the
    // package) and its realpath; granting each keeps both exec routes readable without
    // widening past the file or its package.
    paths.add(packageRootFor(binary))
    paths.add(binary)
  }
  cachedCodexRuntimePaths = [...paths].sort()
  return cachedCodexRuntimePaths
}

export function restrictedPermissionConfig(job, { gitMetadataPaths = [], tempDir = null } = {}) {
  const filesystem = {
    ':minimal': 'read',
    [job.workspaceKey]: job.access === 'workspace-write' ? 'write' : 'read',
  }
  if (job.access === 'workspace-write') {
    for (const name of ['.git', '.agents', '.codex']) {
      const path = join(job.workspaceKey, name)
      if (!existsSync(path)) continue
      filesystem[path] = 'read'
      try { filesystem[realpathSync(path)] = 'read' } catch {}
    }
  }
  for (const path of gitMetadataPaths) filesystem[path] = 'read'
  for (const path of codexRuntimeReadPaths()) filesystem[path] ??= 'read'
  if (tempDir) filesystem[tempDir] = 'write'
  return {
    permissions: {
      [CODEX_PERMISSION_PROFILE]: {
        description: 'Flow delegated workspace access.',
        filesystem,
        network: { enabled: false },
      },
    },
  }
}

export function assertRestrictedPermissionProfile(response) {
  if (response?.activePermissionProfile?.id !== CODEX_PERMISSION_PROFILE) {
    throw new DelegationError('PERMISSION_PROFILE', 'Codex did not activate Flow\'s restricted permission profile.')
  }
  return { profile: CODEX_PERMISSION_PROFILE }
}
