// The MCP stdio client both delegation smokes drive the server with.
//
// deps/node_modules is gitignored, so a clone and every installed copy of the plugin lack the
// MCP SDK. This speaks the stdio transport directly instead: newline-delimited JSON-RPC 2.0 on
// the server's stdin and stdout. It covers only what the smokes drive - initialize, tools/list,
// tools/call with progress, and a roots/list answer. MCP is the service's only entry mode, so
// every call in both smokes goes through here. `elicit` is the answer policy for an
// elicitation/create request: absent, the client advertises no elicitation and refuses one;
// a function receives the request params and returns the ElicitResult.
import { spawn } from 'node:child_process'

const PROTOCOL_VERSION = '2025-06-18'

export class McpStdioClient {
  constructor({ command, args, cwd, env, roots, elicit = null }) {
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.roots = roots
    this.elicit = elicit
    this.elicitations = []
    this.child = null
    this.exited = null
    this.pending = new Map()
    this.progress = new Map()
    this.buffer = ''
    this.stderr = ''
    this.nextId = 1
    this.nextToken = 1
  }

  async start() {
    this.child = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.receive(chunk))
    // Drain stderr so a chatty server cannot fill the pipe and stall, and keep the tail
    // for the failure message when the server dies mid-request.
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000) })
    this.exited = new Promise((resolve) => this.child.on('exit', (code, signal) => {
      const reason = new Error(`MCP server exited early (code ${code}, signal ${signal})\n${this.stderr}`)
      for (const entry of this.pending.values()) entry.fail(reason)
      this.pending.clear()
      resolve()
    }))
    this.child.on('error', (error) => {
      for (const entry of this.pending.values()) entry.fail(error)
      this.pending.clear()
    })

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: true }, ...(this.elicit ? { elicitation: { form: {} } } : {}) },
      clientInfo: { name: 'flow-smoke', version: '1.0.0' },
    })
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
  }

  send(message) {
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  receive(chunk) {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.dispatch(JSON.parse(line))
      newline = this.buffer.indexOf('\n')
    }
  }

  dispatch(message) {
    if (message.method && message.id !== undefined) return this.answer(message)
    if (message.method) return this.notified(message)
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    if (message.error) entry.fail(new Error(`${entry.method} failed: ${message.error.code} ${message.error.message}`))
    else entry.succeed(message.result)
  }

  answer(message) {
    if (message.method === 'roots/list') {
      this.send({ jsonrpc: '2.0', id: message.id, result: { roots: this.roots } })
    } else if (message.method === 'ping') {
      this.send({ jsonrpc: '2.0', id: message.id, result: {} })
    } else if (message.method === 'elicitation/create' && this.elicit) {
      this.elicitations.push(message.params)
      Promise.resolve(this.elicit(message.params)).then((result) => this.send({ jsonrpc: '2.0', id: message.id, result }))
    } else {
      this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unhandled request ${message.method}` } })
    }
  }

  notified(message) {
    if (message.method !== 'notifications/progress') return
    const entry = this.progress.get(message.params?.progressToken)
    if (!entry) return
    entry.onprogress(message.params)
    entry.extend()
  }

  request(method, params, { timeout = 60_000, onprogress = null } = {}) {
    const id = this.nextId++
    const body = { ...params }
    let token = null
    if (onprogress) {
      token = `progress-${this.nextToken++}`
      body._meta = { ...body._meta, progressToken: token }
    }
    return new Promise((resolve, reject) => {
      let timer = null
      const clear = () => {
        if (timer) clearTimeout(timer)
        if (token !== null) this.progress.delete(token)
      }
      const arm = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          this.pending.delete(id)
          clear()
          reject(new Error(`${method} timed out after ${timeout}ms\n${this.stderr}`))
        }, timeout)
      }
      this.pending.set(id, {
        method,
        succeed: (result) => { clear(); resolve(result) },
        fail: (error) => { clear(); reject(error) },
      })
      if (token !== null) this.progress.set(token, { onprogress, extend: arm })
      arm()
      this.send({ jsonrpc: '2.0', id, method, params: body })
    })
  }

  listTools() {
    return this.request('tools/list', {})
  }

  callTool(name, args, options = {}) {
    return this.request('tools/call', { name, arguments: args }, options)
  }

  listResources() { return this.request('resources/list', {}) }

  listResourceTemplates() { return this.request('resources/templates/list', {}) }

  readResource(uri) { return this.request('resources/read', { uri }) }

  async close() {
    if (!this.child || this.closed) return
    this.closed = true
    this.child.stdin.end()
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 5_000)
    await this.exited
    clearTimeout(kill)
  }
}
