// The pack CLI (patch 0006): strict node:util parseArgs with --root (repeatable), -o/--out, --lint-only, --quiet, --help, -- and
// exactly one input. A syntax error exits 2 and a validation error exits 1, and neither writes anything; --help exits 0. The
// output rules of patch 0005 are here too: the output sits in the input's folder, a relative -o is relative to that folder, and
// the output is never the input under another name. pack runs on import, so every case spawns it on a fixture folder under the
// system temp directory, which the section removes at the end.

import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const PAGE = '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<title>Fixture</title>\n<link rel="stylesheet" href="htmlplan.css">\n' +
  '<body>\n<main>\n<h1>Fixture</h1>\n<doc-code src="a.txt" lines="1"></doc-code>\n</main>\n<script src="htmlplan.js" defer></script>\n</body>\n</html>\n'
const listing = (dir) => readdirSync(dir, { recursive: true }).sort().map((f) => {
  const s = statSync(join(dir, f), { bigint: true, throwIfNoEntry: false })
  return `${f} ${s?.isFile() ? s.size : '-'} ${s?.mtimeNs ?? '-'}`
}).join('\n')

// [name, argv, exit code, what stderr or stdout must say]
const SYNTAX = [
  ['--artifact is gone', ['--artifact', 'page.html'], /Unknown option '--artifact'/],
  ['there is no --target', ['--target', 'x', 'page.html'], /Unknown option '--target'/],
  ['an unknown flag', ['--bogus', 'page.html'], /Unknown option '--bogus'/],
  ['-o with no value', ['page.html', '-o'], /argument missing/],
  ['-o followed by a flag', ['-o', '--quiet', 'page.html'], /argument is ambiguous/],
  ['--root with no value', ['page.html', '--root'], /argument missing/],
  ['an empty --root', ['--root=', 'page.html'], /a value for each -o and --root/],
  ['a value on a boolean flag', ['--lint-only=yes', 'page.html'], /does not take an argument/],
  ['two inputs', ['page.html', 'other.html'], /one INPUT, not 2/],
  ['zero inputs', [], /an INPUT page/],
]
const VALIDATION = [
  ['the input as -o', ['-o', 'page.html', 'page.html'], /is the input itself/],
  ['the input as --out by an absolute path', (d) => ['--out', join(d, 'page.html'), 'page.html'], /is the input itself/],
  ['a hard link to the input as -o', ['-o', 'hard.html', 'page.html'], /is the input itself/],
  ['a symlink to the input as -o', ['-o', 'soft.html', 'page.html'], /is a symlink/],
  ['an output in a subfolder', ['-o', 'sub/out.html', 'page.html'], /is outside the page's folder/],
  ['an output in the parent folder', ['-o', '../out.html', 'page.html'], /is outside the page's folder/],
  ['an output in a folder that does not exist', ['-o', 'nope/out.html', 'page.html'], /is outside the page's folder/],
  ['an output that is a folder', ['-o', 'sub', 'page.html'], /is not a file/],
  ['an input that does not exist', ['missing.html'], /missing\.html is not a file/],
  ['an input that is a folder', ['sub'], /sub is not a file/],
]

export default async function ({ ROOT, check }) {
  const pack = join(ROOT, 'plugins/plans/skills/doc/runtime/pack.mjs')
  const base = mkdtempSync(join(tmpdir(), 'plans-argv-'))
  const run = (dir, args, env = process.env) => spawnSync(process.execPath, [pack, ...args], { cwd: dir, encoding: 'utf8', env })
  const said = (r) => `exit ${r.status}: ${(r.stdout + r.stderr).trim().split('\n').slice(-4).join(' | ')}`
  const fixture = (name) => {
    const d = join(base, name); mkdirSync(join(d, 'sub'), { recursive: true })
    writeFileSync(join(d, 'page.html'), PAGE); writeFileSync(join(d, 'other.html'), PAGE); writeFileSync(join(d, 'a.txt'), 'beside the page\n')
    linkSync(join(d, 'page.html'), join(d, 'hard.html')); symlinkSync('page.html', join(d, 'soft.html'))
    return d
  }
  try {
    for (const [kind, code, cases] of [['syntax', 2, SYNTAX], ['validation', 1, VALIDATION]]) {
      for (const [name, args, why] of cases) {
        const d = fixture(`${kind}-${name.replace(/[^a-z0-9]+/gi, '-')}`); const snap = listing(d); const parent = listing(base)
        const r = run(d, typeof args === 'function' ? args(d) : args)
        check(`${kind}: ${name} exits ${code}, saying why`, r.status === code && why.test(r.stdout + r.stderr), said(r))
        check(`${kind}: ${name} writes nothing`, listing(d) === snap && listing(base) === parent)
      }
    }

    const h = fixture('help'); const snap = listing(h); const rh = run(h, ['--help'])
    check('--help exits 0 with the usage and every option, and writes nothing',
      rh.status === 0 && /^usage: node pack\.mjs/.test(rh.stdout) && ['--root DIR', '-o, --out FILE', '--lint-only', '--quiet', '--help', '--  '].every((s) => rh.stdout.includes(s)) && listing(h) === snap, said(rh))
    check('--help never mentions --artifact', !/artifact/i.test(rh.stdout))

    // Accepted forms.
    const w = fixture('weird'); writeFileSync(join(w, '-weird.html'), PAGE)
    const rw = run(w, ['--', '-weird.html'])
    check('-- lets an input start with "-"', rw.status === 0 && statSync(join(w, '-weird.packed.html'), { throwIfNoEntry: false })?.isFile(), said(rw))

    const o = fixture('out-relative'); const ro = run(base, ['-o', 'named.html', join(o, 'page.html')])
    check('a relative -o is relative to the input\'s folder, not the working directory',
      ro.status === 0 && statSync(join(o, 'named.html'), { throwIfNoEntry: false })?.isFile() && statSync(join(base, 'named.html'), { throwIfNoEntry: false }) === undefined, said(ro))
    const ol = fixture('out-long'); const rl = run(ol, ['--out', 'long.html', 'page.html'])
    check('--out is the long spelling of -o', rl.status === 0 && statSync(join(ol, 'long.html'), { throwIfNoEntry: false })?.isFile(), said(rl))

    const old = fixture('out-existing'); writeFileSync(join(old, 'page.packed.html'), 'old output\n'); linkSync(join(old, 'page.packed.html'), join(old, 'kept.html'))
    const re = run(old, ['page.html'])
    check('packing over an old output replaces it without writing through its hard links',
      re.status === 0 && readFileSync(join(old, 'page.packed.html'), 'utf8').includes('<script data-htmlplan>') && readFileSync(join(old, 'kept.html'), 'utf8') === 'old output\n', said(re))
    check('no temporary file is left behind', !readdirSync(old).some((f) => f.endsWith('.tmp')))

    // --root repeats and expands ~/; a code excerpt comes from the first root that holds it.
    const r = fixture('roots'); mkdirSync(join(r, 'home/one'), { recursive: true }); mkdirSync(join(r, 'home/two'))
    writeFileSync(join(r, 'home/two/a.txt'), 'from the second root\n')
    const rr = run(r, ['--root', '~/one', '--root=~/two', '--quiet', 'page.html'], { ...process.env, HOME: join(r, 'home') })
    check('--root repeats, expands ~/, and is searched in order', rr.status === 0 && readFileSync(join(r, 'page.packed.html'), 'utf8').includes('from the second root'), said(rr))
    check('--quiet prints the result line and no lint lines', rr.status === 0 && !/^ {2}[·⚠✗] /m.test(rr.stdout) && /✓ page\.packed\.html/.test(rr.stdout), said(rr))

    const l = fixture('lint-only'); const ls = listing(l); const rlo = run(l, ['--lint-only', 'page.html'])
    check('--lint-only exits 0 on a clean page and writes nothing', rlo.status === 0 && listing(l) === ls, said(rlo))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  check('the fixture folder is removed', statSync(base, { throwIfNoEntry: false }) === undefined, relative(tmpdir(), base))
}
