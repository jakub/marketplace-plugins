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
//     refused  [{ src, path, reason }] for each declared local src that was not admitted. path is
//              the cleaned relative path, or null when the src names none (it won't parse, or it
//              escapes the directory)
//   resolveRef(src) -> { local: false } | { path } | { reason }
//   mediaRoutes(dir, srcs, skipped, { read }) -> { routes: Map('/' + path -> { type, body }), refused }
//     read false opens and checks each file as admission does but holds no body, for build.mjs's
//     static refusal, so the builder and the double apply one rule
//
// Resolution. resolveRef is the plans CLI's rule for a media src, localRefPath in
// ~/code/plans/internal/cli/htmlref.go plus the filepath.Clean in openLocalRefs (cli.go), read
// 2026-10-27, and plans:publish's SKILL.md says the same. It trims the whitespace Go's TrimSpace
// trims. An empty value, or one that starts with `#` or `/` (`//` included) or opens with a URL
// scheme as RFC 3986 spells one, is not local: no route and no refusal, so `data:` and `https:`
// srcs pass through to the browser, which the CSP and the network checks judge. Otherwise it cuts
// at the first `#` and parses the rest as Go's url.Parse does: a control character, a leading
// colon, a colon in the first path segment or a malformed percent escape is a refusal, the query
// is dropped, and the path is percent-decoded, so `my%20shot.png` names `my shot.png`. A path that
// decodes to nothing or to a leading `/` is not local. The rest is cleaned as filepath.Clean does,
// so `./a.png` and `a/../b.png` name `a.png` and `b.png`, and a path that still starts with `..`
// escapes the directory and is refused, as the CLI's os.Root refuses it. Three refusals are
// stricter than the CLI, which would accept them: a path that decodes to bytes that are not UTF-8
// (a browser's request for it could never match), one holding NUL, and one holding a backslash,
// which the CLI reads as part of a file name and a browser rewrites to a slash.
//
// Admission. A resolved path is admitted when every component lstats as a non-symlink (a link
// that points inside the directory is refused too), every component but the last is a directory,
// the last opens with O_NOFOLLOW and O_NONBLOCK and fstats as a regular file with the same inode
// before any read, and its lowercased extension is in MEDIA and is not .html or .htm. O_NONBLOCK
// is there because the last component can be swapped after its lstat: a FIFO there would block a
// plain open, and with it the event loop and runChecks' deadline. Subpaths such as assets/x.png
// are allowed, as the plans CLI allows them. Srcs that resolve to one path share one admission.
//
// The route map is immutable and complete before the server listens, so before any navigation:
//   - the candidate, as text/html; charset=utf-8 with Cache-Control: no-store and the CSP literal
//   - each admitted media file at `/<path>`, held in memory
//   - /favicon.ico, answered 204
//   - /__plans-probe, an empty HTML page without the sandbox CSP, for clipboard read-back
// A request handler never touches the filesystem: a file that changes or vanishes after serve()
// returns changes nothing. The components are checked one lstat at a time and Node has no openat,
// so a directory swapped for a symlink between the lstat and the open is a race this does not
// close; the input directory is the author's own.
//
// Requests. The server listens on 127.0.0.1:0. A Host other than exactly `127.0.0.1:<port>` gets
// 400, as do an absolute-form or asterisk-form target, a malformed percent escape in the pathname,
// and a pathname holding NUL, a backslash or a `.` or `..` segment after one decode. The query is
// cut off first and never read, as the CLI drops it, so `shot.png?v=2` is a request for
// `/shot.png`. The decoded pathname, with empty segments dropped as Clean drops them (`a//b.png`,
// `a.png/`), must equal a route exactly, or the answer is 404, so a double-encoded `..` is a plain
// miss. A browser resolves `.` and `..` segments, encoded ones included, before it sends a
// request, so a page's `./a.png` arrives as `/a.png`. GET and HEAD are answered; any other method
// gets 405. Range is not supported: a Range request gets the whole body with 200, which the
// browser accepts.
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

// Opens and checks the file, then reads it, or with read false stops after the checks.
function readFile(path, ino, read) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.ino !== ino) throw new Error('changed while it was read')
    if (!read) return null
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

// The characters Go's strings.TrimSpace trims: unicode.IsSpace, which differs from JS's trim.
const GO_SPACE = '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const GO_TRIM = new RegExp(`^${GO_SPACE}+|${GO_SPACE}+$`, 'g')
const NOT_LOCAL = Object.freeze({ local: false })
// ignoreBOM keeps a leading U+FEFF in the name, as Go keeps it, instead of stripping it.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const isHex = (c) => /^[0-9A-Fa-f]$/.test(c)

// htmlref.go's hasURLScheme: a letter, then letters, digits, '+', '-' or '.', then a colon.
function hasURLScheme(v) {
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (c === ':') return i > 0
    if (/[A-Za-z]/.test(c)) continue
    if (i === 0) return false
    if (!/[0-9+.-]/.test(c)) return false
  }
  return false
}

// Go's url.unescape in path mode: every `%` needs two hex digits after it, and the result is bytes.
function unescapePath(s) {
  const parts = s.split('%')
  const out = [Buffer.from(parts[0], 'utf8')]
  for (const part of parts.slice(1)) {
    if (!isHex(part[0] ?? '') || !isHex(part[1] ?? '')) return null
    out.push(Buffer.from([parseInt(part.slice(0, 2), 16)]), Buffer.from(part.slice(2), 'utf8'))
  }
  return Buffer.concat(out)
}

// Go's filepath.Clean, for a relative slash path.
function clean(p) {
  const out = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop()
    else out.push(seg)
  }
  return out.join('/') || '.'
}

export function resolveRef(src) {
  const v = src.replace(GO_TRIM, '')
  if (v === '' || v.startsWith('#') || v.startsWith('/') || hasURLScheme(v)) return NOT_LOCAL
  const cut = v.indexOf('#')
  const ref = cut === -1 ? v : v.slice(0, cut)
  if (/[\x00-\x1f\x7f]/.test(ref)) return { reason: 'holds a control character, so it will not parse as a URL' }
  if (ref.startsWith(':')) return { reason: 'opens with a colon, so it will not parse as a URL' }
  const q = ref.indexOf('?')
  const rest = q === -1 ? ref : ref.slice(0, q)
  if (rest.split('/')[0].includes(':')) return { reason: 'has a colon in its first path segment, so it will not parse as a URL' }
  const bytes = unescapePath(rest)
  if (bytes === null) return { reason: 'holds a malformed percent escape' }
  if (bytes.length === 0 || bytes[0] === 0x2f) return NOT_LOCAL
  let path
  try { path = UTF8.decode(bytes) } catch { return { reason: 'decodes to bytes that are not UTF-8' } }
  if (path.includes('\0')) return { reason: 'holds NUL' }
  if (path.includes('\\')) return { reason: 'holds a backslash, which a browser reads as a slash' }
  const cleaned = clean(path)
  if (cleaned === '..' || cleaned.startsWith('../')) return { reason: 'escapes the page\'s directory' }
  return { path: cleaned }
}

function admit(dir, path, read) {
  const parts = path.split('/')
  const ext = extname(path).toLowerCase()
  if (!Object.hasOwn(MEDIA, ext) || ext === '.html' || ext === '.htm') return { reason: `has an extension outside the publish table (${ext || 'none'})` }
  let full = dir, st
  for (let i = 0; i < parts.length; i++) {
    full = join(full, parts[i])
    try { st = lstatSync(full) } catch { return { reason: 'does not exist' } }
    if (st.isSymbolicLink()) return { reason: `${parts.slice(0, i + 1).join('/')} is a symlink` }
    if (i < parts.length - 1 && !st.isDirectory()) return { reason: `${parts.slice(0, i + 1).join('/')} is not a directory` }
  }
  if (!st.isFile()) return { reason: 'is not a regular file' }
  try {
    return { route: { type: MEDIA[ext], body: readFile(full, st.ino, read) } }
  } catch (e) {
    return { reason: `cannot be read (${e.code ?? e.message})` }
  }
}

export function mediaRoutes(dir, srcs, skipped = [], { read = true } = {}) {
  const routes = new Map()
  const refused = []
  const byPath = new Map()
  for (const src of new Set(srcs)) {
    if (skipped.includes(src)) continue
    const ref = resolveRef(src)
    if (ref.local === false) continue
    if (ref.reason) { refused.push({ src, path: null, reason: ref.reason }); continue }
    if (!byPath.has(ref.path)) byPath.set(ref.path, admit(dir, ref.path, read))
    const got = byPath.get(ref.path)
    if (got.route) routes.set('/' + ref.path, got.route)
    else refused.push({ src, path: ref.path, reason: got.reason })
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
    const q = target.indexOf('?')
    let path
    try { path = decodeURIComponent(q === -1 ? target : target.slice(0, q)) } catch { return end(400) }
    const segments = path.split('/')
    if (/[\0\\]/.test(path) || segments.some((s) => s === '.' || s === '..')) return end(400)
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(405, { allow: 'GET, HEAD' })
    const route = routes.get('/' + segments.filter((s) => s !== '').join('/'))
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
