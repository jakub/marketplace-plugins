// Pinned refs (patch 0011): when a block asks for a git ref and git cannot read the file at it, pack exits 1 and writes nothing,
// at both call sites, doc-code src and doc-calls rows, instead of stamping working-tree bytes with that ref. A ref git can
// read packs the committed bytes, even when the working tree differs. A doc-calls file that only + rows name is one the change
// adds, so at a ref it opens nothing and packs, while a file any other row names still refuses. pack runs on import, so each case spawns it against a
// throwaway git repository under the system temp directory, which the section removes at the end.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const page = (body) => '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<title>Fixture</title>\n' +
  `<link rel="stylesheet" href="htmlplan.css">\n<body>\n<main>\n<h1>Fixture</h1>\n${body}\n</main>\n` +
  '<script src="htmlplan.js" defer></script>\n</body>\n</html>\n'
const code = (ref) => `<doc-code src="a.txt" lines="1-3"${ref ? ` ref="${ref}"` : ''}></doc-code>`
const calls = (ref) => `<doc-calls${ref ? ` ref="${ref}"` : ''} caption="One changed call."><script type="text/plain">\n~ main() @ a.txt:2\n</script></doc-calls>`
const rows = (ref, text) => `<doc-calls ref="${ref}" caption="Rows on files HEAD lacks."><script type="text/plain">\n${text}\n</script></doc-calls>`
const listing = (dir) => readdirSync(dir).sort().map((f) => `${f} ${statSync(join(dir, f), { bigint: true }).mtimeNs}`).join('\n')
// No user or system git config, so no hook, signing or template from this machine touches the fixture repository.
const GITENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

export default async function ({ ROOT, check }) {
  const pack = join(ROOT, 'plugins/plans/skills/doc/runtime/pack.mjs')
  const base = mkdtempSync(join(tmpdir(), 'plans-gitref-'))
  const out = (r) => `exit ${r.status}: ${(r.stdout + r.stderr).trim().split('\n').slice(-4).join(' | ')}`
  try {
    const repo = join(base, 'repo'); mkdirSync(repo)
    const git = (...args) => spawnSync('git', ['-C', repo, ...args], { env: GITENV, encoding: 'utf8' })
    writeFileSync(join(repo, 'a.txt'), 'committed one\ncommitted two\ncommitted three\n')
    writeFileSync(join(repo, 'big.txt'), Buffer.alloc(65e6 + 1, 0x78))   // one byte over pack's 64e6 read buffer, so git can read it and pack cannot
    const made = [git('init', '-q'), git('add', 'a.txt', 'big.txt'), git('-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', 'commit', '-q', '-m', 'a')]
    check('the fixture repository has one commit', made.every((r) => r.status === 0), made.map((r) => r.stderr).join(' '))
    writeFileSync(join(repo, 'a.txt'), 'working one\nworking two\nworking three\n')   // the working tree now differs from HEAD

    let n = 0
    const run = (body, ...args) => {
      const dir = join(base, `page-${++n}`); mkdirSync(dir); writeFileSync(join(dir, 'page.html'), page(body))
      const before = listing(dir)
      const r = spawnSync(process.execPath, [pack, '--root', repo, ...args, 'page.html'], { cwd: dir, encoding: 'utf8' })
      return { r, dir, same: listing(dir) === before, packed: () => readFileSync(join(dir, 'page.packed.html'), 'utf8') }
    }

    for (const [name, body, why] of [['doc-code src', code('nope-0000'), /ref="nope-0000" — git cannot read a\.txt at that ref/],
      ['doc-calls row', calls('nope-0000'), /<doc-calls>: ref="nope-0000" — git cannot resolve that ref/],
      ['doc-calls + row', rows('nope-0000', '+   **newFn()**   @ new.ts:10'), /<doc-calls>: ref="nope-0000" — git cannot resolve that ref/]]) {
      for (const mode of [[], ['--lint-only']]) {
        const { r, same } = run(body, ...mode); const said = r.stdout + r.stderr
        const tag = `${name} with a ref git cannot read${mode.length ? ' (--lint-only)' : ''}`
        check(`${tag}: exit 1 with nothing written`, r.status === 1 && same, out(r))
        check(`${tag}: the error names the ref${name.endsWith('src') ? ' and the file' : ''}`, why.test(said), out(r))
        check(`${tag}: git's own message is not echoed`, !/fatal:|Not a valid object name|invalid object/i.test(said), out(r))
      }
    }

    const head = run(code('HEAD'))
    check('a doc-code src at ref=HEAD packs', head.r.status === 0, out(head.r))
    if (head.r.status === 0) {
      const o = head.packed()
      check('it carries the committed bytes, not the working tree\'s', o.includes('committed two') && !o.includes('working two'))
      check('it carries sha="HEAD"', /<doc-code src="a\.txt" lines="1-3" ref="HEAD" file="a\.txt" start="1" sha="HEAD">/.test(o), o.match(/<doc-code[^>]*>/)?.[0])
    }
    const headCalls = run(calls('HEAD'))
    check('a doc-calls row at ref=HEAD packs', headCalls.r.status === 0, out(headCalls.r))
    if (headCalls.r.status === 0) {
      const o = headCalls.packed()
      check('its excerpt is the committed bytes, marked with the ref', /<script type="text\/plain" data-excerpt="a\.txt:2" data-start="1" data-sha="HEAD">\ncommitted one\ncommitted two/.test(o) && !o.includes('working two'))
    }
    // new.ts and old.ts are absent at HEAD but present in the working tree, so a fallback would show their working bytes.
    writeFileSync(join(repo, 'new.ts'), 'working new\n'.repeat(12))
    writeFileSync(join(repo, 'old.ts'), 'working old\n'.repeat(12))
    const added = run(rows('HEAD', '~ main()          @ a.txt:2\n+   **newFn()**   @ new.ts:10'))
    check('a + row on a file missing at the ref packs', added.r.status === 0 && !/git cannot read new\.ts/.test(added.r.stdout + added.r.stderr), out(added.r))
    if (added.r.status === 0) {
      const o = added.packed()
      check('with no excerpt for the added file and none from the working tree, and the readable row\'s excerpt kept',
        !o.includes('data-excerpt="new.ts:10"') && !o.includes('working new') && /data-excerpt="a\.txt:2" data-start="1" data-sha="HEAD">\ncommitted one/.test(o))
    }
    for (const [name, text] of [['a ~ row', '~ old()           @ old.ts:3'], ['a + row on a file git holds but pack cannot read whole', '+   **big()**     @ big.txt:1'],
      ['a ~ row on a file git holds but pack cannot read whole', '~ big()           @ big.txt:1'],
      ['a context row on a file a + row also names', '~ main()          @ a.txt:2\n+   **newFn()**   @ old.ts:10\n    helper()      @ old.ts:4']]) {
      const { r, same } = run(rows('HEAD', text))
      check(`${name} at the ref still exits 1 with nothing written`, r.status === 1 && same && /ref="HEAD" — git cannot read (old\.ts|big\.txt) at that ref/.test(r.stdout + r.stderr), out(r))
      check(`${name}: git's own message is not echoed`, !/fatal:|Not a valid object name|invalid object|ENOBUFS|maxBuffer/i.test(r.stdout + r.stderr), out(r))
    }
    const plain = run(code(null))
    check('with no ref, doc-code reads the working tree and marks it +wt', plain.r.status === 0 && plain.packed().includes('working two') && /sha="[0-9a-f]+\+wt"/.test(plain.packed()), out(plain.r))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  check('the fixture folder is removed', statSync(base, { throwIfNoEntry: false }) === undefined, relative(tmpdir(), base))
}
