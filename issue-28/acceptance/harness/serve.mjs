// A local stand-in for the plans viewer (plansd), for the acceptance run before anything is published. It serves one packed
// page at /<key> and the files beside it at /<name>, with the headers plansd's view handler and security middleware set
// (~/code/plans internal/httpserver/server.go: artifactCSP, setArtifactPolicyHeaders, securityHeaders), and answers Range
// requests with 206 the way http.ServeContent does. The key is random, 22 base64url characters like a real one, so the
// capture harness's redaction runs against the same shape it meets live.
// Run: node serve.mjs <packed.html> [port]   → prints the page URL on stdout and serves until killed.
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// plansd's artifactCSP at ~/code/plans HEAD. Issue #28 quotes an older, shorter form without worker-src, object-src,
// base-uri and frame-ancestors; this one is what the server code sends.
export const VIEWER_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src data:; media-src 'self' data: blob:; worker-src blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm' }
const SECURITY = { 'permissions-policy': 'camera=(), geolocation=(), microphone=()', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow, noarchive' }
const POLICY = { 'cache-control': 'private, no-store', 'content-disposition': 'inline', 'content-security-policy': VIEWER_CSP }

/** A key of the real shape: base64url of 16 random bytes, 22 characters, ending in A, Q, g or w. */
export const fakeKey = () => randomBytes(16).toString('base64url')

export function serve(packedPath, port = 0) {
  const dir = dirname(packedPath), key = fakeKey()
  const server = http.createServer((q, r) => {
    const path = decodeURIComponent(new URL(q.url, 'http://x').pathname)
    if (q.method !== 'GET' && q.method !== 'HEAD') { r.writeHead(405, SECURITY); r.end(); return }
    let file = null
    if (path === `/${key}`) file = packedPath
    else if (/^\/[^/]+$/.test(path) && TYPES[extname(path)] && extname(path) !== '.html') file = join(dir, basename(path))
    let bytes; try { if (file && statSync(file).isFile()) bytes = readFileSync(file) } catch {}
    if (!bytes) { r.writeHead(404, { ...SECURITY, 'content-type': 'text/plain; charset=utf-8' }); r.end('not found\n'); return }
    const head = { ...SECURITY, ...POLICY, 'content-type': TYPES[extname(file)], 'accept-ranges': 'bytes' }
    const m = (q.headers.range || '').match(/^bytes=(\d*)-(\d*)$/)
    if (m && (m[1] || m[2])) {
      let a = m[1] ? +m[1] : Math.max(0, bytes.length - +m[2]), b = m[1] && m[2] ? Math.min(+m[2], bytes.length - 1) : bytes.length - 1
      if (a > b || a >= bytes.length) { r.writeHead(416, { ...head, 'content-range': `bytes */${bytes.length}` }); r.end(); return }
      r.writeHead(206, { ...head, 'content-range': `bytes ${a}-${b}/${bytes.length}`, 'content-length': b - a + 1 }); r.end(q.method === 'HEAD' ? undefined : bytes.subarray(a, b + 1)); return
    }
    r.writeHead(200, { ...head, 'content-length': bytes.length }); r.end(q.method === 'HEAD' ? undefined : bytes)
  })
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, key, url: `http://127.0.0.1:${server.address().port}/${key}` })))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, port] = process.argv.slice(2)
  if (!file) { console.error('usage: node serve.mjs <packed.html> [port]'); process.exit(2) }
  const { url } = await serve(file, port ? +port : 0)
  console.log(url)
}
