// The licence in packed pages (patch 0012): every packed page carries, once and right after the doctype, a comment that names
// the upstream work and holds the Apache-2.0 text byte for byte as NOTICE's marked section. Packing a packed page keeps one
// comment. pack finds NOTICE from its own folder, whatever the working directory, and refuses to write when the section is
// missing or holds "--". pack runs on import, so each case spawns it; the fixtures sit under the system temp directory, which
// the section removes at the end.

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const RUNTIME = 'plugins/plans/skills/doc/runtime'
const MARK = '<!-- html-plan runtime by Thariq Shihipar,'
const URL_AT_PIN = 'https://github.com/anthropics/claude-plugins-community/tree/f60f0454df3045f724c43c6346ec80bdcc3472b2/html-plan'
const PAGE = '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<title>Fixture</title>\n<link rel="stylesheet" href="htmlplan.css">\n' +
  '<body>\n<main>\n<h1>Fixture</h1>\n<p>One line.</p>\n</main>\n<script src="htmlplan.js" defer></script>\n</body>\n</html>\n'
const SECTION = /\n-----BEGIN APACHE-2\.0-----\n([\s\S]*)-----END APACHE-2\.0-----\n$/
const count = (text, s) => text.split(s).length - 1
const listing = (dir) => readdirSync(dir).sort().map((f) => `${f} ${statSync(join(dir, f), { bigint: true }).mtimeNs}`).join('\n')

export default async function ({ ROOT, check }) {
  const runtime = join(ROOT, RUNTIME)
  const notice = readFileSync(join(ROOT, 'plugins/plans/NOTICE'), 'utf8')
  const apache = notice.match(SECTION)?.[1]
  check('NOTICE ends with the marked Apache-2.0 section', !!apache)
  check('the Apache-2.0 text holds no "--", so it fits in one HTML comment', !!apache && !apache.includes('--'))
  const base = mkdtempSync(join(tmpdir(), 'plans-licence-'))
  const out = (r) => `exit ${r.status}: ${(r.stdout + r.stderr).trim().split('\n').slice(-4).join(' | ')}`
  const pack = (packMjs, dir, ...args) => spawnSync(process.execPath, [packMjs, ...args], { cwd: dir, encoding: 'utf8' })
  try {
    const dir = join(base, 'page'); mkdirSync(dir); writeFileSync(join(dir, 'page.html'), PAGE)
    writeFileSync(join(dir, 'NOTICE'), '-----BEGIN APACHE-2.0-----\nA DECOY IN THE WORKING DIRECTORY\n-----END APACHE-2.0-----\n')
    const r = pack(join(runtime, 'pack.mjs'), dir, 'page.html')
    check('pack packs the fixture', r.status === 0, out(r))
    const o = r.status === 0 ? readFileSync(join(dir, 'page.packed.html'), 'utf8') : ''
    check('the packed page carries the licence comment exactly once', count(o, MARK) === 1 && count(o, 'Licensed under the Apache License, Version 2.0:') === 1)
    check('the comment sits right after the doctype', o.startsWith(`<!doctype html>\n${MARK}`), o.slice(0, 80))
    const comment = o.slice(o.indexOf(MARK), o.indexOf('-->', o.indexOf(MARK)) + 3)
    check('the comment names the upstream URL at the pin, the author and NOTICE', comment.includes(URL_AT_PIN) && comment.includes('Thariq Shihipar') && comment.includes('Modified for the plans plugin (see plugins/plans/NOTICE): '))
    check('the comment holds no "--" between its delimiters', !comment.slice(4, -3).includes('--'))
    const text = comment.match(/\nLicensed under the Apache License, Version 2\.0:\n([\s\S]*)-->$/)?.[1]
    check('its Apache-2.0 text is NOTICE\'s section byte for byte', !!apache && text === apache)
    check('pack read NOTICE from its own folder, not the decoy in the working directory', !o.includes('A DECOY'))
    check('the page after the comment is the page as packed before', o.slice(comment.length + '<!doctype html>\n'.length).startsWith('\n<html data-htmlplan-packed lang="en">'))

    // Packing the packed page again keeps one comment, and the result is the same page.
    const again = pack(join(runtime, 'pack.mjs'), dir, '-o', 'again.html', 'page.packed.html')
    check('a packed page packs again', again.status === 0, out(again))
    const o2 = again.status === 0 ? readFileSync(join(dir, 'again.html'), 'utf8') : ''
    check('repacking keeps the licence comment once', count(o2, MARK) === 1 && count(o2, 'Licensed under the Apache License, Version 2.0:') === 1)
    check('repacking yields the same page byte for byte', o2 === o)

    // The old comment goes as the comment token the CLI's tokenizer reads, before any check, never as text after them. A planted
    // look-alike inside a tag name is no comment: it stays, and no <img> is synthesized out of its removal. One inside a script's
    // text stays too. And when removing a real comment does join text into a tag, that tag is checked like any other.
    const splice = join(base, 'splice'); mkdirSync(splice); writeFileSync(join(splice, 'private.png'), 'never to be uploaded unchecked')
    writeFileSync(join(splice, 'page.html'), PAGE.replace('<p>One line.</p>', '<im<!-- html-plan runtime by Thariq Shihipar,-->g src="private.png">\n' +
      '<script>var s = "<!-- html-plan runtime by Thariq Shihipar, -->"</script>'))
    const rs = pack(join(runtime, 'pack.mjs'), splice, 'page.html'); const os = rs.status === 0 ? readFileSync(join(splice, 'page.packed.html'), 'utf8') : ''
    check('a licence look-alike spliced into a tag name does not become an <img> in the packed page', !os.includes('<img src="private.png">') && !/private\.png/.test(rs.stdout), out(rs) + ' | ' + (os.match(/[^\n]*private\.png[^\n]*/g) || []).join(' | '))
    check('the planted text is left as written, and the licence comment still appears once at the top', rs.status === 0 && os.includes('<im<!-- html-plan runtime by Thariq Shihipar,-->g src="private.png">') && os.startsWith(`<!doctype html>\n${MARK}`) && count(os, 'Licensed under the Apache License, Version 2.0:') === 1, out(rs))
    check('a look-alike inside a script\'s text is not a comment and stays', os.includes('<script>var s = "<!-- html-plan runtime by Thariq Shihipar, -->"</script>'))
    const joined = join(base, 'joined'); mkdirSync(joined); writeFileSync(join(joined, 'private.png'), 'checked, so uploaded knowingly')
    writeFileSync(join(joined, 'page.html'), PAGE.replace('<p>One line.</p>', '<<!-- html-plan runtime by Thariq Shihipar, -->img src="private.png">'))
    const rj = pack(join(runtime, 'pack.mjs'), joined, 'page.html')
    check('a tag that a real comment\'s removal joins together is checked and reported as media', rj.status === 0 && /1 local media file stay[^\n]*private\.png/.test(rj.stdout), out(rj))

    // A runtime whose NOTICE has no usable section writes nothing.
    const fakes = [
      ['no NOTICE file', null],
      ['a NOTICE without the section', notice.replace(SECTION, '\n')],
      ['a NOTICE whose section holds "--"', notice.replace('   END OF TERMS AND CONDITIONS', '   END OF TERMS -- AND CONDITIONS')],
    ]
    for (const [name, body] of fakes) {
      const plugin = join(base, `fake-${fakes.findIndex((f) => f[0] === name)}`), rt = join(plugin, 'skills/doc/runtime')
      mkdirSync(rt, { recursive: true })
      for (const f of ['pack.mjs', 'htmlplan.js', 'htmlplan.css']) copyFileSync(join(runtime, f), join(rt, f))
      if (body != null) writeFileSync(join(plugin, 'NOTICE'), body)
      const d = join(plugin, 'page'); mkdirSync(d); writeFileSync(join(d, 'page.html'), PAGE)
      const before = listing(d); const rr = pack(join(rt, 'pack.mjs'), d, 'page.html')
      check(`${name}: pack exits 1 and writes nothing`, rr.status === 1 && listing(d) === before && /Apache-2\.0 text/.test(rr.stdout), out(rr))
    }
    const control = join(base, 'fake-control'), rtc = join(control, 'skills/doc/runtime'); mkdirSync(rtc, { recursive: true })
    for (const f of ['pack.mjs', 'htmlplan.js', 'htmlplan.css']) copyFileSync(join(runtime, f), join(rtc, f))
    writeFileSync(join(control, 'NOTICE'), notice); mkdirSync(join(control, 'page')); writeFileSync(join(control, 'page/page.html'), PAGE)
    const rc = pack(join(rtc, 'pack.mjs'), base, join(control, 'page/page.html'))
    check('a copied runtime with a whole NOTICE packs from another working directory', rc.status === 0 && readFileSync(join(control, 'page/page.packed.html'), 'utf8') === o, out(rc))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  check('the fixture folder is removed', statSync(base, { throwIfNoEntry: false }) === undefined, relative(tmpdir(), base))
}
