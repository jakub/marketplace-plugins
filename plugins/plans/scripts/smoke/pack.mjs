// pack and media (patch 0005): pack leaves local media as literal files beside the page, for the plans CLI to upload at publish
// time, and inlines nothing else but the runtime, once, from its own folder. Each doc-shot gets a literal <img> child and loses
// its own src. Every refusal exits 1 with nothing written, under --lint-only too, and leaves an existing output byte for byte.
// The media allowlist is held to the extension table in skills/publish/SKILL.md. pack runs on import, so every case spawns it
// on a fixture folder under the system temp directory, which the section removes at the end.

import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const RUNTIME = 'plugins/plans/skills/doc/runtime'
const SENTINEL = 'an existing output, which a refused pack must leave alone\n'

const page = (body, head = '') => '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<title>Fixture</title>\n' +
  `<link rel="stylesheet" href="htmlplan.css">\n${head}<body>\n<main>\n<h1>Fixture</h1>\n${body}\n</main>\n` +
  '<script src="htmlplan.js" defer></script>\n</body>\n</html>\n'
const count = (text, s) => text.split(s).length - 1
// Every file under dir with its size and its mtime in nanoseconds, so any write shows.
const listing = (dir) => readdirSync(dir, { recursive: true }).sort().map((f) => {
  const s = statSync(join(dir, f), { bigint: true, throwIfNoEntry: false })
  return `${f} ${s?.isFile() ? s.size : '-'} ${s?.mtimeNs ?? '-'}`
}).join('\n')

// One fixture per refusal. Each folder also holds shot.png and clip.webm, so a refusal is never a missing file by accident.
// why is what the error must say, so a case cannot pass on some other error.
const REFUSALS = [
  { name: 'dotdot', body: '<img src="../outside.png" alt="">', why: /climbs out of the page's folder/ },
  { name: 'absolute', body: (d) => `<img src="${d}/shot.png" alt="">`, why: /absolute path/ },
  { name: 'file-url', body: (d) => `<img src="file://${d}/shot.png" alt="">`, why: /file: URL/ },
  { name: 'symlink-out', setup: (d) => symlinkSync('../outside.png', join(d, 'link.png')), body: '<img src="link.png" alt="">', why: /symlink out of the page's folder/ },
  { name: 'root-only', root: true, body: '<img src="only-root.png" alt="">', why: /exists only under --root/ },
  { name: 'missing', body: '<img src="nope.png" alt="">', why: /"nope\.png" is not in the page's folder/ },
  { name: 'doc-shot-missing', body: '<doc-shot src="nope.png"></doc-shot>', why: /<doc-shot>: src="nope\.png" is not in the page's folder/ },
  { name: 'remote', body: '<img src="https://example.com/x.png" alt="">', why: /is remote/ },
  { name: 'remote-protocol-relative', body: '<video src="//example.com/x.webm"></video>', why: /is remote/ },
  { name: 'remote-source', body: '<video><source src="https://example.com/x.mp4" type="video/mp4"></video>', why: /<source>: .*is remote/ },
  { name: 'doc-shot-remote', body: '<doc-shot src="https://example.com/x.png"></doc-shot>', why: /<doc-shot>: .*is remote/ },
  { name: 'html-src', setup: (d) => writeFileSync(join(d, 'other.html'), '<p>x</p>\n'), body: '<img src="other.html" alt="">', why: /is an HTML file/ },
  { name: 'extension', setup: (d) => writeFileSync(join(d, 'notes.txt'), 'x\n'), body: '<img src="notes.txt" alt="">', why: /"\.txt" is not a media type/ },
  { name: 'audio-extension', setup: (d) => writeFileSync(join(d, 'clip.mp3'), 'x'), body: '<audio controls src="clip.mp3"></audio>', why: /<audio>: .*"\.mp3" is not a media type/ },
  { name: 'too-many', setup: (d) => { for (let i = 0; i < 65; i++) writeFileSync(join(d, `m${i}.png`), `png ${i}`) },
    body: Array.from({ length: 65 }, (_, i) => `<img src="m${i}.png" alt="">`).join('\n'), why: /65 distinct local media files/ },
  { name: 'srcset', body: '<img src="shot.png" srcset="data:image/png;base64,iVBORw0KGgo= 1x, shot.png 2x" alt="">', why: /srcset "shot\.png"/ },
  { name: 'poster', body: '<video src="clip.webm" poster="shot.png"></video>', why: /poster "shot\.png"/ },
  { name: 'css-url-style', head: '<style>.x { background: url(shot.png) }</style>\n', body: '<p class="x">x</p>', why: /<style>: CSS url\(\) "shot\.png"/ },
  { name: 'css-url-linked', setup: (d) => writeFileSync(join(d, 'local.css'), ".x { background: url('shot.png') }\n"),
    head: '<link rel="stylesheet" href="local.css">\n', body: '<p class="x">x</p>', why: /local\.css: CSS url\(\) "shot\.png"/ },
  { name: 'css-import', head: '<style>@import "more.css";</style>\n', body: '<p>x</p>', why: /CSS @import/ },
  { name: 'style-attribute', body: '<div style="background-image: url(&quot;shot.png&quot;)">x</div>', why: /style="": CSS url\(\) "shot\.png"/ },
  { name: 'external-script', body: '<script src="https://cdn.example.com/x.js"></script>', why: /<script src="https:\/\/cdn\.example\.com\/x\.js">/ },
  { name: 'local-script', setup: (d) => writeFileSync(join(d, 'extra.js'), 'void 0\n'), body: '<script src="extra.js"></script>', why: /<script src="extra\.js">/ },
  { name: 'external-stylesheet', head: '<link rel="stylesheet" href="https://cdn.example.com/x.css">\n', body: '<p>x</p>', why: /stylesheet "https:\/\/cdn\.example\.com\/x\.css" is remote/ },
  { name: 'missing-stylesheet', head: '<link rel="stylesheet" href="gone.css">\n', body: '<p>x</p>', why: /stylesheet "gone\.css" is not in the page's folder/ },
  { name: 'meta-csp', head: '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">\n', body: '<p>x</p>', why: /<meta> Content-Security-Policy/ },
  { name: 'runtime-twice', head: '<link rel="stylesheet" href="../runtime/htmlplan.css">\n', body: '<p>x</p>', why: /htmlplan\.css appears 2 times/ },
  // pack reads a src as the CLI's tokenizer (golang.org/x/net/html) does, or refuses. &sol; names public/private.png to the CLI; pack
  // holds no entity table, so it refuses the reference instead of checking the literal file. An unquoted value ends at HTML
  // whitespace only, so U+00A0 is part of the name the CLI reads.
  { name: 'entity-unknown', setup: (d) => { mkdirSync(join(d, 'public')); writeFileSync(join(d, 'public/private.png'), 'the file the CLI would upload'); writeFileSync(join(d, 'public&sol;private.png'), 'the file pack once checked') },
    body: '<img src="public&sol;private.png" alt="">', why: /src="public&sol;private\.png" holds "&sol;"/ },
  { name: 'unquoted-nbsp', setup: (d) => { writeFileSync(join(d, 'a.png'), 'png'); writeFileSync(join(d, 'a.png b'), 'the file the CLI would read') },
    body: '<img src=a.png b alt="">', why: /src="a\.png b" — "\.png b" is not a media type/ },
  // A comment ends at --!> for the CLI. With the runtime linked before it, 65 media tags after it once passed pack unseen.
  { name: 'comment-bang-close', setup: (d) => { for (let i = 0; i < 65; i++) writeFileSync(join(d, `m${i}.png`), `png ${i}`) },
    html: () => '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<title>Fixture</title>\n<link rel="stylesheet" href="htmlplan.css">\n<script src="htmlplan.js" defer></script>\n' +
      `<body>\n<main>\n<h1>Fixture</h1>\n<!-- x --!>\n${Array.from({ length: 65 }, (_, i) => `<img src="m${i}.png" alt="">`).join('\n')}\n</main>\n</body>\n</html>\n`, why: /65 distinct local media files/ },
  // Markup the CLI's tokenizer steps over, or ends where pack once did not, followed by a media reference the CLI acts on.
  ...[
    ['comment-empty', '<!-->'], ['comment-dash', '<!--->'], ['comment-bang', '<!-- x --!>'],
    ['end-tag-quoted-gt', '</a x="><script>">'],
    ['script-double-escaped', '<script><!--<script></script><style>--></script>'],
    ['raw-text-end-tag-attrs', '<style></style x="><script>">'],
    ['bogus-comment', '<!x>'], ['processing-instruction', '<?x>'], ['end-tag-bogus', '</ x>'],
  ].map(([name, markup]) => ({ name: `seen-after-${name}`, body: `${markup}<img src="nope.png" alt="">`, why: /<img>: src="nope\.png" is not in the page's folder/ })),
]

// The positive fixture: every form of media pack must leave literal, and every control a refusal must not catch.
const GOOD = page([
  '<doc-shot data-src="keep.png" src="shot.png" label="Shot"><doc-pin at="10%,10%" title="Here">The button.</doc-pin></doc-shot>',
  "<doc-shot src='my%20shot.png'></doc-shot>",
  '<img src="shot.png" alt="again">',
  '<img src="inside-link.png" alt="a symlink that stays in the folder">',
  '<video controls src="clip.webm"></video>',
  '<video controls poster="data:image/png;base64,iVBORw0KGgo="><source src="sub/clip.mp4" type="video/mp4"></video>',
  '<img src="data:image/png;base64,iVBORw0KGgo=" srcset="data:image/png;base64,iVBORw0KGgo= 2x" alt="data">',
  '<img src="shot.png?v=2#top" alt="query and fragment">',
  '<img src="shot.png?x=1&copy=2" alt="a reference before = stays literal for the CLI">',
  '<img src="a&amp;b.png" alt="named"><img src="a&#38;b.png" alt="decimal"><img src="a&#x26;b.png" alt="hex">',
  '<div style="color: red; background: url(data:image/png;base64,iVBORw0KGgo=)">styled</div>',
  '<doc-mock frame="none" w="300"><template><img src="shot.png" alt="in a mock"></template></doc-mock>',
  '<!-- <img src="../commented-out.png"> -->',
  '<doc-code lang="html"><script type="text/plain"><img src="../not-a-tag.png"></script></doc-code>',
  '<script>document.documentElement.dataset.fixture = "1"</script>',
].join('\n'), '<link rel="stylesheet" href="page.css">\n<style>.g { fill: url(#grad) }</style>\n')

export default async function ({ ROOT, check }) {
  const pack = join(ROOT, RUNTIME, 'pack.mjs')
  const css = readFileSync(join(ROOT, RUNTIME, 'htmlplan.css'), 'utf8')
  const js = readFileSync(join(ROOT, RUNTIME, 'htmlplan.js'), 'utf8').replace(/<\/script/gi, '<\\/script')
  const base = mkdtempSync(join(tmpdir(), 'plans-pack-'))
  const run = (dir, ...args) => spawnSync(process.execPath, [pack, ...args], { cwd: dir, encoding: 'utf8' })
  const out = (r) => `exit ${r.status}: ${(r.stdout + r.stderr).trim().split('\n').slice(-6).join(' | ')}`
  const fixture = (name, html, extra = () => {}) => {
    const d = join(base, name); mkdirSync(join(d, 'sub'), { recursive: true })
    writeFileSync(join(d, 'shot.png'), 'png bytes'); writeFileSync(join(d, 'clip.webm'), 'webm bytes')
    extra(d); writeFileSync(join(d, 'page.html'), typeof html === 'function' ? html(d) : html); return d
  }
  try {
    writeFileSync(join(base, 'outside.png'), 'outside the page folder')

    // Positive: literal media, one runtime from pack's own folder, the output beside the input.
    const good = fixture('good', GOOD, (d) => {
      writeFileSync(join(d, 'my shot.png'), 'png'); writeFileSync(join(d, 'sub/clip.mp4'), 'mp4'); writeFileSync(join(d, 'a&b.png'), 'png')
      symlinkSync('shot.png', join(d, 'inside-link.png'))
      writeFileSync(join(d, 'page.css'), '.p { color: blue }\n')
      // decoys beside the page: pack must take the runtime from its own folder, never these
      writeFileSync(join(d, 'htmlplan.css'), '/* DECOY-RUNTIME */\n'); writeFileSync(join(d, 'htmlplan.js'), '/* DECOY-RUNTIME */\n')
    })
    const r = run(good, 'page.html')
    check('pack packs the positive fixture', r.status === 0, out(r))
    const o = readFileSync(join(good, 'page.packed.html'), 'utf8')
    check('the input is unchanged', readFileSync(join(good, 'page.html'), 'utf8') === GOOD)
    const shots = [...o.matchAll(/<doc-shot\b[^>]*>/g)]
    check('each doc-shot loses its src and keeps data-src', shots.length === 2 && shots.every((m) => !/\ssrc=/.test(m[0])) && shots[0][0].includes('data-src="keep.png"'), shots.map((m) => m[0]).join(' '))
    check('each doc-shot gets one literal <img> child, quoted as written',
      o.includes('<doc-shot data-src="keep.png" label="Shot"><img src="shot.png"><doc-pin') && o.includes("<doc-shot><img src='my%20shot.png'></doc-shot>"))
    check('img, video and source keep their literal src',
      ['<img src="shot.png" alt="again">', '<img src="inside-link.png"', '<video controls src="clip.webm">', '<source src="sub/clip.mp4"',
        '<img src="shot.png?v=2#top"', '<img src="shot.png?x=1&copy=2"', '<img src="a&amp;b.png"', '<img src="a&#38;b.png"', '<img src="a&#x26;b.png"',
        '<template><img src="shot.png" alt="in a mock">'].every((s) => o.includes(s)))
    check('nothing is base64-inlined beyond the authored data: URIs', count(o, ';base64,') === count(GOOD, ';base64,') && !o.includes('data:video') && !o.includes('png bytes'))
    check('the runtime CSS and JS are inlined once each', count(o, '<style data-htmlplan>') === 1 && count(o, '<script data-htmlplan>') === 1 && !/<link[^>]*htmlplan|<script[^>]*src=/i.test(o))
    check('the inlined runtime is pack\'s own, not the copy beside the page',
      o.includes(`<style data-htmlplan>\n${css}\n</style>`) && o.includes(`<script data-htmlplan>\n${js}\n</script>`) && !o.includes('DECOY-RUNTIME'))
    check('the page\'s own stylesheet is inlined from its folder', o.includes('<style>/* page.css */\n.p { color: blue }\n\n</style>') && !/rel="stylesheet"/.test(o),
      o.match(/[^\n]{0,80}(page\.css|rel="stylesheet")[^\n]{0,80}/g)?.join(' | '))
    check('pack reports the five distinct media files it left for the CLI', /5 local media files stay beside the page/.test(r.stdout) && /5 media files beside it/.test(r.stdout), r.stdout.slice(-400))
    check('the three spellings of a&b.png are one file to pack, listed once by the name the CLI reads', /: [^\n]*\ba&b\.png/.test(r.stdout) && !/a&amp;b|a&#38;b|a&#x26;b/.test(r.stdout), r.stdout.match(/[^\n]*a&[^\n]*/g)?.join(' | '))
    check('commented-out and text/plain markup is never scanned', !/commented-out|not-a-tag/.test(r.stdout))

    const lintDir = fixture('good-lint', GOOD, (d) => {
      writeFileSync(join(d, 'my shot.png'), 'png'); writeFileSync(join(d, 'sub/clip.mp4'), 'mp4'); writeFileSync(join(d, 'a&b.png'), 'png')
      symlinkSync('shot.png', join(d, 'inside-link.png')); writeFileSync(join(d, 'page.css'), '.p { color: blue }\n')
    })
    const before = listing(lintDir); const rl = run(lintDir, '--lint-only', 'page.html')
    check('--lint-only passes the positive fixture and writes nothing', rl.status === 0 && listing(lintDir) === before, out(rl))

    const src = fixture('src-name', page('<p>x</p>')); writeFileSync(join(src, 'doc.src.html'), page('<p>x</p>'))
    const rs = run(src, 'doc.src.html')
    check('NAME.src.html packs to NAME.html beside it', rs.status === 0 && statSync(join(src, 'doc.html'), { throwIfNoEntry: false })?.isFile(), out(rs))

    // Refusals: exit 1, the folder unchanged (names, sizes, mtimes), an existing output untouched, in both modes.
    const rootDir = join(base, 'a-root'); mkdirSync(rootDir); writeFileSync(join(rootDir, 'only-root.png'), 'only under the root')
    for (const c of REFUSALS) {
      const d = fixture(c.name, (dd) => c.html ? c.html(dd) : page(typeof c.body === 'function' ? c.body(dd) : c.body, c.head), c.setup)
      writeFileSync(join(d, 'page.packed.html'), SENTINEL)
      const args = [...(c.root ? ['--root', rootDir] : []), 'page.html']
      for (const mode of [[], ['--lint-only']]) {
        const snap = listing(d); const rr = run(d, ...mode, ...args); const said = rr.stdout + rr.stderr
        check(`${c.name}${mode.length ? ' (--lint-only)' : ''}: refused with exit 1, for the right reason`, rr.status === 1 && c.why.test(said), out(rr))
        check(`${c.name}${mode.length ? ' (--lint-only)' : ''}: nothing written, the existing output untouched`,
          listing(d) === snap && readFileSync(join(d, 'page.packed.html'), 'utf8') === SENTINEL)
      }
    }

    // The page's folder swapped between the lint and the write. pack runs git through PATH for a pinned ref, so a fake git, the
    // only git this run can find, moves the page's folder away and puts a symlink to another folder in its place while pack
    // waits for it. pack must then refuse to write, and that other folder must stay as it was.
    const swap = join(base, 'swap'); const victim = join(swap, 'victim'), pageD = join(swap, 'page'), moved = join(swap, 'moved'), bin = join(swap, 'bin'), rootD = join(swap, 'root')
    for (const d of [victim, pageD, bin, rootD]) mkdirSync(d, { recursive: true })
    writeFileSync(join(pageD, 'page.html'), page('<doc-code src="f.txt" ref="HEAD"></doc-code>'))
    writeFileSync(join(bin, 'git'), ['#!/bin/sh', 'if [ ! -e "$SWAP_DONE" ]; then mv "$SWAP_PAGE" "$SWAP_MOVED" && ln -s "$SWAP_VICTIM" "$SWAP_PAGE" && : > "$SWAP_DONE"; fi', "printf 'one\\ntwo\\nthree\\n'", ''].join('\n'), { mode: 0o755 })
    const quiet = listing(victim)
    const rw = spawnSync(process.execPath, [pack, '--root', rootD, 'page/page.html'], { cwd: swap, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SWAP_PAGE: pageD, SWAP_MOVED: moved, SWAP_VICTIM: victim, SWAP_DONE: join(swap, 'done') } })
    check('the fake git ran during the lint and swapped the page\'s folder for a symlink', statSync(join(swap, 'done'), { throwIfNoEntry: false }) !== undefined && lstatSync(pageD).isSymbolicLink(), out(rw))
    check('a page folder swapped during the run is refused, with the reason', rw.status === 1 && /folder [^\n]* changed during the (run|write)/.test(rw.stdout + rw.stderr), out(rw))
    check('nothing landed in the folder the symlink points at, and no temp file remains', listing(victim) === quiet && readdirSync(moved).join(' ') === 'page.html', `victim: ${readdirSync(victim).join(' ')}; moved: ${readdirSync(moved).join(' ')}`)

    // Drift guard: MEDIA_EXT is the publish table without .html and .htm.
    const table = readFileSync(join(ROOT, 'plugins/plans/skills/publish/SKILL.md'), 'utf8').split('\n')
    const head = table.findIndex((l) => /^\| Extension \| Content type \|$/.test(l))
    const rows = head < 0 ? [] : table.slice(head + 2).filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith('|')))
    const published = rows.flatMap((l) => [...l.split('|')[1].matchAll(/`(\.[a-z0-9]+)`/g)].map((m) => m[1]))
    check('the publish table lists .html and .htm', published.includes('.html') && published.includes('.htm'), published.join(' '))
    const want = published.filter((e) => e !== '.html' && e !== '.htm').sort()
    const decl = readFileSync(pack, 'utf8').match(/^const MEDIA_EXT = \[([^\]\n]*)\];$/m)
    const have = decl ? [...decl[1].matchAll(/'(\.[a-z0-9]+)'/g)].map((m) => m[1]).sort() : []
    check('pack declares MEDIA_EXT on one line', !!decl)
    check('MEDIA_EXT equals the publish table without .html and .htm', want.length > 0 && want.join(' ') === have.join(' ') && new Set(have).size === have.length,
      `publish: ${want.join(' ')}; pack: ${have.join(' ')}`)
    for (const ext of want) {
      const tag = /^\.(mp4|webm)$/.test(ext) ? `<video controls src="f${ext}"></video>` : `<img src="f${ext}" alt="">`
      const d = fixture(`ext${ext.replace('.', '-')}`, page(tag), (dd) => writeFileSync(join(dd, `f${ext}`), 'bytes'))
      const re = run(d, 'page.html')
      check(`a ${ext} file packs as a literal reference`, re.status === 0 && readFileSync(join(d, 'page.packed.html'), 'utf8').includes(tag), out(re))
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  check('the fixture folder is removed', statSync(base, { throwIfNoEntry: false }) === undefined, relative(tmpdir(), base))
}
