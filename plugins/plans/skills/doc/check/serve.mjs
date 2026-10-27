// The viewer double: the loopback server build.mjs's browser check loads the candidate from. It
// serves the candidate with the viewer's CSP header and the declared sibling media, and nothing
// else. Node built-ins only.
//
//   serve({ html, dir, media, skipped }) -> Promise<{ port, origin, url, refused, close() }>
//     html     the candidate's exact bytes, a Buffer, served from memory
//     dir      the input's directory, which media srcs resolve against
//     media    the src values scan.mjs declared on img, video, audio and source
//     skipped  srcs the check skips (Inline absolute paths), never admitted
//     url      the candidate's URL, `<origin>/__plans-candidate.html`
//     refused  [{ src, reason }] for each declared src that was not admitted
//   mediaRoutes(dir, srcs) -> { routes: Map(path -> { type, body }), refused }
//
// The route map is immutable and complete before the server listens, so before any navigation:
//   - the candidate, as text/html; charset=utf-8 with Cache-Control: no-store and the CSP literal
//   - each admitted media file, held in memory. A src is admitted when it is a plain relative path
//     (no scheme, no leading slash, no `?`, `#`, `%`, backslash or NUL, and no empty, `.` or `..`
//     component), every component lstats as a non-symlink (a link that points inside the directory
//     is refused too), every component but the last is a directory, the last opens with O_NOFOLLOW
//     and O_NONBLOCK and fstats as a regular file with the same inode before any read, and its
//     lowercased extension is in MEDIA and is not .html or .htm. O_NONBLOCK is there because the
//     last component can be swapped after its lstat: a FIFO there would block a plain open, and
//     with it the event loop and runChecks' deadline. Subpaths such as assets/x.png are allowed, as
//     the plans CLI allows them.
//   - /favicon.ico, answered 204
//   - /__plans-probe, an empty HTML page without the sandbox CSP, for clipboard read-back
// A request handler never touches the filesystem: a file that changes or vanishes after serve()
// returns changes nothing. The components are checked one lstat at a time and Node has no openat,
// so a directory swapped for a symlink between the lstat and the open is a race this does not
// close; the input directory is the author's own.
//
// Requests. The server listens on 127.0.0.1:0. A Host other than exactly `127.0.0.1:<port>` gets
// 400, as do an absolute-form or asterisk-form target, a malformed percent escape, and a target
// holding NUL, a backslash or a `.` or `..` segment after one decode. The decoded target, query
// included, must equal a route exactly, or the answer is 404, so a double-encoded `..` is a plain
// miss. GET and HEAD are answered; any other method gets 405. Range is not supported: a Range
// request gets the whole body with 200, which the browser accepts.
//
// MEDIA maps each extension the plans CLI uploads to the content type it infers. It is the
// publish table as written, `.html` and `.htm` included, so the two can be compared whole. The
// server admits media by this table but never serves an HTML sibling, because the CLI rejects a
// `src` that names a local `.html` file.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'

export const MEDIA = Object.freeze({
  '.html': 'text/html',
  '.htm': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
})

// The viewer's artifact CSP, copied as a literal from artifactCSP in
// ~/code/plans/internal/httpserver/server.go, read 2026-10-26. Re-read it when the viewer changes.
export const CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src data:; media-src 'self' data: blob:; worker-src blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export const CANDIDATE = '/__plans-candidate.html'
export const PROBE = '/__plans-probe'
const PROBE_PAGE = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body></body></html>\n')

function readFile(path, ino) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.ino !== ino) throw new Error('changed while it was read')
    const chunks = []
    for (;;) {
      const buf = Buffer.allocUnsafe(65536)
      const got = readSync(fd, buf, 0, buf.length, null)
      if (got === 0) break
      chunks.push(buf.subarray(0, got))
    }
    return Buffer.concat(chunks)
  } finally {
    closeSync(fd)
  }
}

function admit(dir, src) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(src) || src.startsWith('/')) return { reason: 'is not a relative path' }
  if (/[?#%\\\0]/.test(src)) return { reason: 'holds ?, #, %, a backslash or NUL' }
  const parts = src.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return { reason: 'has an empty, . or .. component' }
  const ext = extname(src).toLowerCase()
  if (!Object.hasOwn(MEDIA, ext) || ext === '.html' || ext === '.htm') return { reason: `has an extension outside the publish table (${ext || 'none'})` }
  let path = dir, st
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i])
    try { st = lstatSync(path) } catch { return { reason: 'does not exist' } }
    if (st.isSymbolicLink()) return { reason: `${parts.slice(0, i + 1).join('/')} is a symlink` }
    if (i < parts.length - 1 && !st.isDirectory()) return { reason: `${parts.slice(0, i + 1).join('/')} is not a directory` }
  }
  if (!st.isFile()) return { reason: 'is not a regular file' }
  try {
    return { route: { type: MEDIA[ext], body: readFile(path, st.ino) } }
  } catch (e) {
    return { reason: `cannot be read (${e.code ?? e.message})` }
  }
}

export function mediaRoutes(dir, srcs, skipped = []) {
  const routes = new Map()
  const refused = []
  for (const src of new Set(srcs)) {
    if (skipped.includes(src)) continue
    const got = admit(dir, src)
    if (got.route) routes.set('/' + src, got.route)
    else refused.push({ src, reason: got.reason })
  }
  return { routes, refused }
}

export async function serve({ html, dir, media = [], skipped = [] }) {
  const { routes, refused } = mediaRoutes(dir, media, skipped)
  routes.set(CANDIDATE, { type: 'text/html; charset=utf-8', body: html })
  routes.set('/favicon.ico', { status: 204 })
  routes.set(PROBE, { type: 'text/html; charset=utf-8', body: PROBE_PAGE, open: true })
  Object.freeze(routes)

  let host = null
  const server = createServer((req, res) => {
    const end = (status, headers = {}) => { res.writeHead(status, { 'content-length': 0, ...headers }); res.end() }
    if (req.headers.host !== host) return end(400)
    const target = req.url ?? ''
    if (!target.startsWith('/')) return end(400)
    let path
    try { path = decodeURIComponent(target) } catch { return end(400) }
    if (/[\0\\]/.test(path) || path.split(/[/?]/).some((s) => s === '.' || s === '..')) return end(400)
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(405, { allow: 'GET, HEAD' })
    const route = routes.get(path)
    if (!route) return end(404)
    if (route.status) return end(route.status)
    const headers = { 'content-type': route.type, 'content-length': route.body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    if (!route.open) headers['content-security-policy'] = CSP
    res.writeHead(200, headers)
    res.end(req.method === 'HEAD' ? undefined : route.body)
  })
  server.on('clientError', (e, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n'); else socket.destroy() })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const { port } = server.address()
  host = `127.0.0.1:${port}`
  const origin = `http://${host}`
  return {
    port,
    origin,
    url: origin + CANDIDATE,
    refused,
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}
