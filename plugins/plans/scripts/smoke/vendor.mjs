// Vendored html-plan: the shipped files rebuild byte for byte from upstream through the patch
// chain. NOTICE's fixed sections are the contract: the path map, the pristine SHA-256 ledger,
// the ordered patch list and the Apache-2.0 text, each between -----BEGIN X----- and
// -----END X----- lines. The pass runs on a copy of the shipped tree in a temporary directory,
// with no upstream checkout and no network: reverse the chain to the ledger, then forward
// again to the shipped bytes. git apply runs with no --3way, -C, --unidiff-zero or whitespace
// option, and with no user or system git config, so nothing is fuzzed or fixed up.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

const PLUGIN = 'plugins/plans'
const DOC = `${PLUGIN}/skills/doc`
const VENDORED_DIRS = ['runtime', 'references', 'examples']
const NOTICE_LINE = 'Modified by the plans plugin. Upstream pin and local patches: plugins/plans/NOTICE.'
const PATCH_NAME = /^\d{4}-[a-z0-9-]+\.patch$/

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const walk = (dir, base = dir) => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name))])
const same = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i])
const listDiff = (got, want) => `extra [${got.filter((x) => !want.includes(x)).join(', ')}], missing [${want.filter((x) => !got.includes(x)).join(', ')}]`

function section(text, name) {
  const m = text.match(new RegExp(`(?:^|\\n)-----BEGIN ${name}-----\\n([\\s\\S]*?)-----END ${name}-----(?:\\n|$)`))
  return m ? m[1] : null
}
// Lines of a section without the trailing newline's empty element.
const lines = (body) => (body ?? '').split('\n').filter((l) => l !== '')

export default async function ({ ROOT, check }) {
  const notice = readFileSync(join(ROOT, PLUGIN, 'NOTICE'), 'utf8')

  // NOTICE's fixed fields.
  const pin = notice.match(/Upstream commit:\n\n {4}([0-9a-f]{40})\n/)?.[1]
  check('NOTICE names a 40-hex upstream pin', !!pin)
  const url = `https://github.com/anthropics/claude-plugins-community/tree/${pin}/html-plan`
  check('NOTICE carries the upstream URL at the pin', notice.includes(url), url)
  check('NOTICE attributes the runtime to Thariq Shihipar', notice.includes('Thariq Shihipar'))
  check('NOTICE notes that upstream plugin.json says MIT while LICENSE is Apache-2.0',
    notice.includes('"license": "MIT"') && /LICENSE`?, and it is the Apache License 2\.0/.test(notice))
  const licenceSha = notice.match(/Upstream LICENSE SHA-256:\n\n {4}([0-9a-f]{64})\n/)?.[1]
  const apache = notice.match(/\n-----BEGIN APACHE-2\.0-----\n([\s\S]*)-----END APACHE-2\.0-----\n$/)?.[1]
  check('NOTICE records the upstream LICENSE SHA-256', !!licenceSha)
  check('the Apache-2.0 section closes NOTICE and is the upstream LICENSE byte for byte',
    !!apache && sha256(Buffer.from(apache, 'utf8')) === licenceSha && apache.includes('Apache License\n                           Version 2.0, January 2004'),
    apache ? `sha256 ${sha256(Buffer.from(apache, 'utf8'))}` : 'section missing')

  // The path map, the ledger and the patch list.
  const map = lines(section(notice, 'PATH MAP')).map((l) => l.split(' -> '))
  check('the path map has rows of upstream -> pristine -> shipped', map.length > 0 && map.every((r) => r.length === 3 && r.every(Boolean)), JSON.stringify(map))
  const pristinePaths = map.map((r) => r[1]), shippedPaths = map.map((r) => r[2])
  const ledger = new Map(lines(section(notice, 'PRISTINE SHA-256')).map((l) => { const m = l.match(/^([0-9a-f]{64}) {2}(\S+)$/); return m ? [m[2], m[1]] : [l, null] }))
  check('every ledger line is "<sha256>  <path>"', [...ledger.values()].every(Boolean))
  check('the ledger keys equal the path map\'s pristine paths', same([...ledger.keys()], pristinePaths), listDiff([...ledger.keys()], pristinePaths))
  check('every vendored path sits under skills/doc/', [...pristinePaths, ...shippedPaths].every((p) => p.startsWith(DOC + '/')))

  const listed = lines(section(notice, 'PATCHES')).filter((l) => !/^\s/.test(l))
  const onDisk = readdirSync(join(ROOT, PLUGIN, 'patches')).sort()
  check('every patch list entry is a NNNN-name.patch line', listed.length > 0 && listed.every((l) => PATCH_NAME.test(l)), listed.join(', '))
  check('the patch list is in ascending order', listed.every((l, i) => i === 0 || l > listed[i - 1]))
  check('the patch list equals patches/', same(listed, onDisk) && listed.join() === onDisk.join(), listDiff(listed, onDisk))
  const reasons = section(notice, 'PATCHES') ?? ''
  check('every listed patch has an indented reason', listed.every((p) => new RegExp(`^${p.replace(/\./g, '\\.')}\\n {4}\\S`, 'm').test(reasons)))

  // Every patch touches only vendored paths.
  const known = new Set([...pristinePaths, ...shippedPaths])
  for (const p of onDisk) {
    const text = readFileSync(join(ROOT, PLUGIN, 'patches', p), 'utf8')
    const heads = [...text.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)]
    check(`${p} touches only vendored paths`, heads.length > 0 && heads.every((h) => known.has(h[1]) && known.has(h[2])),
      heads.map((h) => `${h[1]} ${h[2]}`).join('; '))
  }

  // The shipped vendored set is exactly the path map's final projection.
  const shippedOnDisk = VENDORED_DIRS.flatMap((d) => walk(join(ROOT, DOC, d)).map((f) => `${DOC}/${d}/${f}`))
  check('the shipped vendored set equals the path map\'s shipped paths', same(shippedOnDisk, shippedPaths), listDiff(shippedOnDisk, shippedPaths))

  // Reverse to pristine, then forward to shipped, in a scratch tree shaped like the repository.
  const tmp = mkdtempSync(join(tmpdir(), 'plans-smoke-vendor-'))
  const tree = join(tmp, 'r')
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: tmp, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const apply = (patch, reverse) => spawnSync('git', ['apply', ...(reverse ? ['-R'] : []), join(ROOT, PLUGIN, 'patches', patch)], { cwd: tree, env, encoding: 'utf8' })
  try {
    for (const p of shippedPaths) { mkdirSync(dirname(join(tree, p)), { recursive: true }); cpSync(join(ROOT, p), join(tree, p)) }

    let reversed = true
    for (const p of [...listed].reverse()) {
      const r = apply(p, true)
      check(`git apply -R ${p}`, r.status === 0, r.stderr.trim())
      if (r.status !== 0) { reversed = false; break }
    }
    if (reversed) {
      const files = walk(tree)
      check('after reversal the file set equals the ledger', same(files, [...ledger.keys()]), listDiff(files, [...ledger.keys()]))
      const wrong = [...ledger].filter(([p, sum]) => !existsSync(join(tree, p)) || sha256(readFileSync(join(tree, p))) !== sum).map(([p]) => p)
      check('after reversal every file matches its pristine SHA-256', wrong.length === 0, wrong.join(', '))

      // Shipped files that differ from pristine carry the notice; unmodified ones do not.
      const pristineOf = new Map(map.map(([, from, to]) => [to, from]))
      for (const p of shippedPaths) {
        const shipped = readFileSync(join(ROOT, p)), original = readFileSync(join(tree, pristineOf.get(p)))
        const modified = !shipped.equals(original)
        check(`${p.slice(DOC.length + 1)} ${modified ? 'is modified and carries' : 'is unmodified and lacks'} the notice`,
          shipped.toString('utf8').includes(NOTICE_LINE) === modified)
      }

      let forward = true
      for (const p of listed) {
        const r = apply(p, false)
        check(`git apply ${p}`, r.status === 0, r.stderr.trim())
        if (r.status !== 0) { forward = false; break }
      }
      if (forward) {
        const files = walk(tree)
        check('after the forward pass the file set equals the shipped set', same(files, shippedPaths), listDiff(files, shippedPaths))
        const differ = shippedPaths.filter((p) => !existsSync(join(tree, p)) || !readFileSync(join(tree, p)).equals(readFileSync(join(ROOT, p))))
        check('after the forward pass every file equals the shipped bytes', differ.length === 0, differ.join(', '))
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
