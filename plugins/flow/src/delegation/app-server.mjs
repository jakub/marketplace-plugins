import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { DelegationError } from './contracts.mjs'
import { VERSION } from './version.mjs'

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
])

export const isApprovalRequest = (method) => APPROVAL_METHODS.has(method)

export class AppServerClient {
  constructor({ cwd, env = {}, onNotification = () => {}, onServerRequest = () => {}, onClose = () => {} } = {}) {
    this.cwd = cwd
    this.env = env
    this.onNotification = onNotification
    this.onServerRequest = onServerRequest
    this.onClose = onClose
    this.child = null
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.closeInfo = null
    this.closePromise = new Promise((resolve) => { this.resolveClose = resolve })
  }

  async start() {
    const bin = process.env.FLOW_DELEGATION_CODEX_BIN || 'codex'
    try {
      this.child = spawn(bin, ['app-server', '--stdio'], {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (cause) {
      throw new DelegationError('CODEX_NOT_INSTALLED', 'Codex could not be started.')
    }
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line))
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-16_384) })
    this.child.on('error', (cause) => this.handleClose(null, cause))
    this.child.on('close', (code, signal) => this.handleClose({ code, signal }, null))
    await this.request('initialize', {
      clientInfo: { name: 'flow-delegation', title: 'Flow delegation', version: VERSION },
      capabilities: {
        experimentalApi: false,
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
    const error = cause?.code === 'ENOENT'
      ? new DelegationError('CODEX_NOT_INSTALLED', 'Codex could not be started.')
      : new DelegationError('APP_SERVER_EXIT', 'Codex App Server exited before the request completed.', {
        exitCode: info?.code ?? null,
        signal: info?.signal ?? null,
      })
    try { this.onClose(error) } catch {}
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
    this.resolveClose(this.closeInfo)
  }

  handleLine(line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new DelegationError('APP_SERVER_ERROR', message.error.message || 'Codex App Server rejected a request.', {
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
    if (!this.child || this.closeInfo) throw new DelegationError('APP_SERVER_EXIT', 'Codex App Server is not running.')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
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

  async stop(graceMs = 2_000) {
    if (!this.child || this.closeInfo) return this.closeInfo
    try { this.child.stdin.end() } catch {}
    if (!await this.waitClose(graceMs)) {
      try { this.child.kill('SIGTERM') } catch {}
      await this.waitClose(1_000)
    }
    if (!this.closeInfo) {
      try { this.child.kill('SIGKILL') } catch {}
      await this.waitClose(1_000)
    }
    return this.closeInfo
  }
}

export function codexVersion() {
  const bin = process.env.FLOW_DELEGATION_CODEX_BIN || 'codex'
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (result.error?.code === 'ENOENT') return { ok: false, kind: 'CODEX_NOT_INSTALLED', version: null }
  if (result.status !== 0) return { ok: false, kind: 'CODEX_VERSION', version: null }
  return { ok: true, kind: null, version: result.stdout.trim() }
}

export function sandboxFor(job) {
  if (job.access === 'workspace-write') {
    return {
      type: 'workspaceWrite',
      writableRoots: [job.workspaceKey],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    }
  }
  return { type: 'readOnly', networkAccess: false }
}
