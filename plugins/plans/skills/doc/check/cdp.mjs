// The CDP driver build.mjs's browser check talks to Chromium through. It speaks NUL-delimited JSON
// over --remote-debugging-pipe (the child's fds 3 and 4), with no TCP listener, no WebSocket and no
// npm. Node built-ins only.
//
//   findChromium(env, platform) -> { path, reason }
//     path is the executable to launch, or null. reason is null with a path, else an unknown
//     reason { kind: 'no-chromium', detail }.
//   launch(path, { tmp, env, handshakeMs }) -> Promise<Browser>
//     Browser: { pid, profile, send(method, params, sessionId, { timeout }), on(sessionId, fn),
//     off(sessionId, fn), ping(), close(), killSync() }. Rejects with a CdpError of kind 'launch'
//     or 'handshake', after removing everything it made.
//   new Pipe(writable, readable, { timeout }) -> the transport alone, for the smoke's fake pipes.
//   CdpError { kind, message }, with kind one of:
//     'launch'     Chromium could not be started
//     'handshake'  it started but never answered Browser.getVersion
//     'transport'  the pipe failed: EPIPE, EOF, a truncated or malformed frame, or the child exited
//     'protocol'   Chromium answered a command with an error
//     'timeout'    one command passed its deadline; the transport is still up
//
// Discovery, in order, with no silent fallback:
//   1. PLANS_CHROMIUM, when the variable is set at all. It is used exactly when it names an
//      executable regular file (a symlink to one counts), and otherwise the result is unknown.
//      A set but unusable PLANS_CHROMIUM never falls through to PATH.
//   2. chromium, chromium-browser, google-chrome-stable and google-chrome, in that order, in each
//      absolute PATH entry in order. Empty and relative entries are skipped, so the working
//      directory is never searched.
//   3. On darwin, /Applications/Google Chrome.app/Contents/MacOS/Google Chrome.
// It never looks in an npx or Playwright cache.
//
// Launch. The profile is mkdtemp(<tmp>/plans-chromium-), where tmp defaults to os.tmpdir(), so
// TMPDIR moves it. The child gets stdio ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] and
// detached: true, so Chromium leads its own process group and a terminal's Ctrl-C reaches only the
// builder, which then kills the group. stderr is drained and its last 4 KB kept for the launch and
// handshake details. The handshake is one Browser.getVersion within handshakeMs (10 s).
//
// Framing. A message is JSON plus `\0`, written to fd 3. fd 4 is read as a list of Buffer chunks:
// each new chunk is searched for a NUL, and UTF-8 is decoded (fatally) only over a complete frame,
// so a multi-byte character or a JSON token split across reads is never decoded in halves. Replies
// are matched by id and may arrive in any order; events go to the listeners registered for their
// sessionId (undefined for browser-level events), in arrival order, so an event that arrives before
// a reply is delivered first. A request is registered before it is written. A terminal failure
// (EPIPE, EOF, a frame left incomplete at EOF, an undecodable frame, the child's exit) rejects every
// pending request with a 'transport' CdpError, cancels its timer and refuses new requests. A
// command's own deadline (30 s by default) rejects only that command, with kind 'timeout', and its
// late reply is dropped.
//
// Close ladder, idempotent: Browser.close (2 s), wait for exit (3 s), SIGKILL the process group,
// wait for exit (3 s), then rmSync(profile, { recursive, force, maxRetries: 5, retryDelay: 100 }).
// The group is killed even after a clean exit, so a renderer the browser left behind dies too.
//
// Signals. While any browser is open, SIGINT, SIGTERM and SIGHUP handlers kill every open browser's
// group synchronously, remove its profile and exit 128+n, and a process.on('exit') fallback does
// the same kill and removal. build.mjs registers its own handlers first, which remove its temp file
// and exit; that exit runs the fallback here, so either order cleans both. The handlers come off
// when the last browser closes. A SIGKILL of the builder leaves the profile and the browser behind:
// nothing can run then, so that is documented, not tested.

import { spawn } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

const NAMES = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']
const MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export const HANDSHAKE_MS = 10000
export const COMMAND_MS = 30000

export const FLAGS = [
  '--headless',
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-extensions',
  '--mute-audio',
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
]

function executable(path) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function findChromium(env = process.env, platform = process.platform) {
  if (env.PLANS_CHROMIUM !== undefined) {
    const p = env.PLANS_CHROMIUM
    if (p !== '' && executable(p)) return { path: p, reason: null }
    return { path: null, reason: { kind: 'no-chromium', detail: `PLANS_CHROMIUM=${p} is not an executable regular file` } }
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    for (const name of NAMES) {
      const p = join(dir, name)
      if (executable(p)) return { path: p, reason: null }
    }
  }
  if (platform === 'darwin' && executable(MAC)) return { path: MAC, reason: null }
  return { path: null, reason: { kind: 'no-chromium', detail: `no Chromium found: set PLANS_CHROMIUM, or put one of ${NAMES.join(', ')} on PATH` } }
}

export class CdpError extends Error {
  constructor(kind, message) { super(message); this.kind = kind }
}

/* ---------------------------------------------------------------- the transport */

export class Pipe {
  constructor(writable, readable, { timeout = COMMAND_MS } = {}) {
    this.w = writable
    this.r = readable
    this.timeout = timeout
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.chunks = []
    this.error = null
    this.decoder = new TextDecoder('utf-8', { fatal: true })
    readable.on('data', (chunk) => this.#data(chunk))
    readable.on('end', () => this.#eof())
    readable.on('close', () => this.#eof())
    readable.on('error', (e) => this.fail(new CdpError('transport', `the read pipe failed (${e.code ?? e.message})`)))
    writable.on('error', (e) => this.fail(new CdpError('transport', `the write pipe failed (${e.code ?? e.message})`)))
  }

  get closed() { return this.error !== null }

  #eof() {
    if (this.error) return
    const left = this.chunks.reduce((n, c) => n + c.length, 0)
    this.fail(new CdpError('transport', left ? `the pipe closed inside a frame (${left} bytes left)` : 'the pipe closed'))
  }

  #data(chunk) {
    if (this.error) return
    let from = 0
    for (let nul = chunk.indexOf(0); nul !== -1; nul = chunk.indexOf(0, from)) {
      this.chunks.push(chunk.subarray(from, nul))
      const frame = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks)
      this.chunks = []
      from = nul + 1
      let msg
      try {
        msg = JSON.parse(this.decoder.decode(frame))
      } catch {
        this.fail(new CdpError('transport', `an undecodable frame of ${frame.length} bytes`))
        return
      }
      this.#dispatch(msg)
      if (this.error) return
    }
    if (from < chunk.length) this.chunks.push(chunk.subarray(from))
  }

  #dispatch(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new CdpError('protocol', `${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`))
      else p.resolve(msg.result ?? {})
      return
    }
    const set = this.listeners.get(msg.sessionId)
    if (set) for (const fn of [...set]) fn(msg)
  }

  on(sessionId, fn) {
    if (!this.listeners.has(sessionId)) this.listeners.set(sessionId, new Set())
    this.listeners.get(sessionId).add(fn)
  }

  off(sessionId, fn) {
    const set = this.listeners.get(sessionId)
    if (!set) return
    set.delete(fn)
    if (set.size === 0) this.listeners.delete(sessionId)
  }

  send(method, params = {}, sessionId, { timeout = this.timeout } = {}) {
    if (this.error) return Promise.reject(new CdpError('transport', `${method}: ${this.error.message}`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError('timeout', `${method} got no reply within ${timeout} ms`))
      }, timeout)
      this.pending.set(id, { method, resolve, reject, timer })
      const msg = { id, method, params }
      if (sessionId !== undefined) msg.sessionId = sessionId
      try {
        this.w.write(JSON.stringify(msg) + '\0', (e) => { if (e) this.fail(new CdpError('transport', `the write pipe failed (${e.code ?? e.message})`)) })
      } catch (e) {
        this.fail(new CdpError('transport', `the write pipe failed (${e.code ?? e.message})`))
      }
    })
  }

  // Terminal: every pending request is rejected and its timer cancelled, and new ones are refused.
  fail(err) {
    if (this.error) return
    this.error = err
    this.chunks = []
    for (const [id, p] of this.pending) {
      this.pending.delete(id)
      clearTimeout(p.timer)
      p.reject(new CdpError(err.kind, `${p.method}: ${err.message}`))
    }
  }
}

/* ---------------------------------------------------------------- open browsers and signals */

const live = new Set()
const SIGNALS = [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]
const handlers = new Map()

function killAllSync() { for (const b of [...live]) b.killSync() }

function install() {
  if (handlers.size) return
  for (const [sig, n] of SIGNALS) {
    const fn = () => { killAllSync(); process.exit(128 + n) }
    handlers.set(sig, fn)
    process.on(sig, fn)
  }
  handlers.set('exit', killAllSync)
  process.on('exit', killAllSync)
}

function uninstall() {
  if (live.size) return
  for (const [sig, fn] of handlers) process.off(sig, fn)
  handlers.clear()
}

// Sleeps the thread without the event loop, for the synchronous kill path only.
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// True once pid is gone or a zombie. A child is reaped only by the event loop, so a synchronous
// caller sees its SIGKILLed child as a zombie, which is dead enough.
function deadSync(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z'
  } catch {
    try { process.kill(pid, 0); return false } catch { return true }
  }
}

class Browser {
  constructor(child, profile) {
    this.child = child
    this.pid = child.pid
    this.profile = profile
    this.stderr = ''
    this.exited = false
    this.closing = null
    this.exit = new Promise((resolve) => child.once('exit', (code, signal) => { this.exited = true; resolve({ code, signal }) }))
    this.pipe = new Pipe(child.stdio[3], child.stdio[4])
    child.stdio[2].on('data', (b) => { this.stderr = (this.stderr + b.toString('utf8')).slice(-4096) })
    child.stdio[2].on('error', () => {})
    this.exit.then(({ code, signal }) => this.pipe.fail(new CdpError('transport', `Chromium exited (${signal ?? `code ${code}`})`)))
  }

  send(method, params, sessionId, opts) { return this.pipe.send(method, params, sessionId, opts) }
  on(sessionId, fn) { this.pipe.on(sessionId, fn) }
  off(sessionId, fn) { this.pipe.off(sessionId, fn) }

  // True when the browser answers a Browser.getVersion within 2 s.
  async ping() {
    try { await this.send('Browser.getVersion', {}, undefined, { timeout: 2000 }); return true } catch { return false }
  }

  #waitExit(ms) {
    if (this.exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms)
      this.exit.then(() => { clearTimeout(t); resolve(true) })
    })
  }

  #killGroup() {
    try { process.kill(-this.pid, 'SIGKILL') } catch {}
  }

  close() {
    if (this.closing) return this.closing
    this.closing = (async () => {
      if (!this.pipe.closed) { try { await this.send('Browser.close', {}, undefined, { timeout: 2000 }) } catch {} }
      if (!(await this.#waitExit(3000))) {
        this.#killGroup()
        await this.#waitExit(3000)
      }
      this.#killGroup()
      this.pipe.fail(new CdpError('transport', 'the browser was closed'))
      rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      live.delete(this)
      uninstall()
    })()
    return this.closing
  }

  killSync() {
    this.#killGroup()
    for (let i = 0; i < 200 && !this.exited && !deadSync(this.pid); i++) nap(10)
    try { rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
    live.delete(this)
  }
}

export async function launch(path, { tmp = tmpdir(), env = process.env, handshakeMs = HANDSHAKE_MS } = {}) {
  const profile = mkdtempSync(join(tmp, 'plans-chromium-'))
  let child
  try {
    child = spawn(path, [...FLAGS, `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true, env })
  } catch (e) {
    rmSync(profile, { recursive: true, force: true })
    throw new CdpError('launch', `cannot start ${path} (${e.code ?? e.message})`)
  }
  if (child.pid === undefined) {
    // spawn reports a missing or unrunnable executable through an 'error' event and no pid.
    const e = await new Promise((resolve) => child.once('error', resolve))
    rmSync(profile, { recursive: true, force: true })
    throw new CdpError('launch', `cannot start ${path} (${e.code ?? e.message})`)
  }
  child.on('error', () => {})
  const browser = new Browser(child, profile)
  live.add(browser)
  install()
  try {
    await browser.send('Browser.getVersion', {}, undefined, { timeout: handshakeMs })
  } catch (e) {
    await browser.close()
    const tail = browser.stderr.trim().split('\n').slice(-3).join(' | ')
    throw new CdpError('handshake', `Chromium did not answer Browser.getVersion: ${e.message}${tail ? ` (stderr: ${tail})` : ''}`)
  }
  return browser
}
