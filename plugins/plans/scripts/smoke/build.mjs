// The builder's static half, Node only and never skipped. Every CLI case spawns
// skills/doc/build.mjs with process.execPath on pages written into a fresh mkdtemp directory,
// always with PLANS_CHROMIUM=/nonexistent, so a static success is exit 3 with kind no-chromium.
// It covers argv (exit 2), every refusal (exit 1, nothing written, a previous output and its hard
// link kept byte for byte, no temp file left), the marker, the --out rules, diff placeholders,
// the build id and digest recomputed from the written file, the two assemblies, the pure helpers
// in memory, static rules over kit/ask.js, findChromium and the MEDIA table. Every spawn has a
// SIGKILL deadline, so a build that blocks fails its check instead of hanging the smoke. A few
// cases put a stand-in for Chromium in PLANS_CHROMIUM: a shell script that acts where the browser
// check would run, then exits 1, so the check is unknown and nothing needs a real browser.

import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const OLD = 'previous output, kept byte for byte\n'
const sha = (b) => createHash('sha256').update(b).digest('hex')

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">'
const page = ({ head = '<!-- plans:kit -->', body = '<p>Body text.</p>', title = 'Fixture', before = '', viewport = VIEWPORT } = {}) =>
  `${before}<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n${viewport}\n<title>${title}</title>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`

export default async function ({ ROOT, check, skip }) {
  const DOC = join(ROOT, 'plugins/plans/skills/doc')
  const BUILD = join(DOC, 'build.mjs')
  const mod = await import(pathToFileURL(BUILD).href)
  const { findChromium } = await import(pathToFileURL(join(DOC, 'check/cdp.mjs')).href)
  const { MEDIA } = await import(pathToFileURL(join(DOC, 'check/serve.mjs')).href)

  const base = mkdtempSync(join(tmpdir(), 'plans-build-smoke-'))
  try {
    let n = 0
    const fresh = () => { const d = join(base, `c${++n}`); mkdirSync(d); return d }
    const run = (args, cwd = base, { env = {}, timeout = 60000 } = {}) => {
      const r = spawnSync(process.execPath, [BUILD, ...args], { cwd, encoding: 'utf8', timeout, killSignal: 'SIGKILL', env: { ...process.env, PLANS_CHROMIUM: '/nonexistent', ...env } })
      let json = null
      try { json = JSON.parse(r.stdout) } catch {}
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
    }
    const temps = (dir) => readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
    const mkfifo = (p) => spawnSync('mkfifo', [p]).status === 0
    // A stand-in for Chromium that runs the shell lines given, then exits 1.
    const fakeChromium = (d, lines) => {
      const p = join(d, 'fake-chromium')
      writeFileSync(p, `#!/bin/sh\n${lines}\nexit 1\n`)
      chmodSync(p, 0o755)
      return p
    }

    // --- argv: exit 2, usage on stderr, nothing on stdout, nothing written.
    {
      const d = fresh()
      writeFileSync(join(d, 'p.html'), page())
      const p = join(d, 'p.html')
      const usage = [
        ['no arguments', []],
        ['an unknown flag', ['--nope', p]],
        ['--help', ['--help', p]],
        ['a --flag=value form', ['--out=x.html', p]],
        ['--out with no value', [p, '--out']],
        ['--out followed by a flag', ['--out', '--json', p]],
        ['--shots with no value', [p, '--shots']],
        ['a second input', [p, p]],
        ['a bare -', ['-']],
        ['a bare - after --', ['--', '-']],
        ['--inline twice', ['--inline', '--inline', p]],
        ['--json and an unknown flag', ['--json', '--nope', p]],
        ['-- then a second input', [p, '--', p]],
      ]
      for (const [what, args] of usage) {
        const r = run(args)
        check(`build argv: ${what} exits 2 with usage on stderr only`, r.status === 2 && /usage: build\.mjs/.test(r.stderr) && r.stdout === '', `status ${r.status} stdout ${JSON.stringify(r.stdout)} stderr ${r.stderr}`)
      }
      check('build argv: exit 2 writes nothing', readdirSync(d).join(',') === 'p.html', readdirSync(d).join(','))
      const r = run(['--', p])
      check('build argv: -- then INPUT builds', r.status === 3, r.stderr)
    }

    // --- a static success: exit 3, unknown no-chromium, the file written, the id and digest real.
    {
      const d = fresh()
      writeFileSync(join(d, 'p.html'), page())
      const r = run(['--json', join(d, 'p.html')])
      const out = join(d, 'p.built.html')
      const j = r.json ?? {}
      check('build: a static success exits 3', r.status === 3, `${r.status} ${r.stderr}`)
      check('build: its result is unknown with kind no-chromium', j.result === 'unknown' && j.reason?.kind === 'no-chromium', JSON.stringify(j.reason))
      const keys = ['result', 'reason', 'buildId', 'digest', 'out', 'bytes', 'matrix', 'checks', 'copy', 'undriven', 'skippedMedia']
      check('build --json: prints every result field', keys.every((k) => k in j) && Array.isArray(j.matrix) && Array.isArray(j.checks) && Array.isArray(j.undriven) && Array.isArray(j.skippedMedia), Object.keys(j).join(','))
      check('build --json: stdout holds the one object and nothing else', r.stdout.trim().split('\n').length === 1)
      check('build --json: no check reports a pass for the browser', !j.checks?.some((c) => c.name === 'browser' && c.result === 'pass'))
      const bytes = readFileSync(out)
      check('build: writes <stem>.built.html beside the input', j.out === out && bytes.length === j.bytes, `${j.out} ${j.bytes}`)
      check('build: the digest is SHA-256 of the written file', j.digest === sha(bytes))
      const text = bytes.toString('utf8')
      const metas = text.split('<meta name="plans-build"').length - 1
      check('build: the file holds one plans-build meta with the full id', metas === 1 && text.includes(`<meta name="plans-build" content="${j.buildId}">`) && /^[0-9a-f]{64}$/.test(j.buildId ?? ''))
      const emptied = Buffer.from(text.replace(`content="${j.buildId}"`, 'content=""'), 'utf8')
      check('build: the build id is SHA-256 of the file with the meta content empty', sha(emptied) === j.buildId)
      check('build: the marker is gone and the kit sits where it was', !text.includes('<!-- plans:kit -->') && text.indexOf('<meta name="plans-build"') > text.indexOf('<title>') && text.indexOf('</head>') > text.indexOf('<script data-plans-kit>'))
      const heads = ['tokens.css', 'look.css', 'marks.css', 'ask.css', 'ask.js'].map((f) => text.indexOf(`/* plans-kit:${f} */`))
      check('build: Document assembly holds the five kit files in order', heads.every((x, i) => x !== -1 && (i === 0 || x > heads[i - 1])), heads.join(','))
      check('build: Document assembly is meta, one style, one script', /<meta name="plans-build" content="[0-9a-f]{64}">\n<style data-plans-kit>\n\/\* plans-kit:tokens\.css \*\//.test(text) && text.split('<style data-plans-kit>').length === 2 && text.split('<script data-plans-kit>').length === 2)
      check('build: no temp file is left', temps(d).length === 0, temps(d).join(','))
      const again = run(['--json', join(d, 'p.html')])
      check('build: the same input builds the same id and bytes', again.json?.buildId === j.buildId && sha(readFileSync(out)) === j.digest)

      // A built output is refused as input.
      const rebuilt = run(['--json', '--out', 'again.html', out])
      check('build: a built output is refused as input', rebuilt.status === 1 && rebuilt.json?.result === 'fail' && rebuilt.json?.reason?.kind === 'built', `${rebuilt.status} ${rebuilt.stderr}`)
    }

    // --- Inline assembly.
    {
      const d = fresh()
      writeFileSync(join(d, 'p.html'), page({ body: '<p>Inline.</p><img src="/abs/shot.png" alt="">' }))
      const r = run(['--inline', '--json', join(d, 'p.html')])
      const out = join(d, 'p.inline.html')
      const text = r.status === 3 ? readFileSync(out, 'utf8') : ''
      check('build --inline: exits 3 and writes <stem>.inline.html', r.status === 3 && r.json?.out === out, `${r.status} ${r.stderr}`)
      check('build --inline: holds tokens.css and marks.css', text.includes('/* plans-kit:tokens.css */') && text.includes('/* plans-kit:marks.css */'))
      check('build --inline: holds no look.css or ask.* header and no script', !/plans-kit:(look\.css|ask\.css|ask\.js)/.test(text) && !text.includes('<script data-plans-kit>'))
      check('build --inline: still carries the build meta', /<meta name="plans-build" content="[0-9a-f]{64}">/.test(text))
      check('build --inline: reports an absolute image path as skipped media', JSON.stringify(r.json?.skippedMedia) === '["/abs/shot.png"]', JSON.stringify(r.json?.skippedMedia))
    }

    // --- Refusals: exit 1, --json fail, nothing written, the old output and its hard link intact.
    const refuse = (what, { input = page(), name = 'p.html', setup, args = [], kind, also = [], inline = false, timeout } = {}) => {
      const d = fresh()
      const inPath = join(d, name)
      if (input !== null) writeFileSync(inPath, input)
      const out = join(d, `p.${inline ? 'inline' : 'built'}.html`)
      writeFileSync(out, OLD)
      linkSync(out, join(d, 'linked.html'))
      const ino = statSync(out).ino
      setup?.(d, inPath)
      const before = readdirSync(d).sort().join(',')
      const r = run([...(inline ? ['--inline'] : []), '--json', ...args, inPath], base, { timeout })
      const kept = readFileSync(out, 'utf8') === OLD && statSync(out).ino === ino && readFileSync(join(d, 'linked.html'), 'utf8') === OLD
      const after = readdirSync(d).sort().join(',')
      const named = new Set(r.json?.checks?.map((c) => c.name))
      const ok = r.status === 1 && r.json?.result === 'fail' && (!kind || r.json?.reason?.kind === kind) && also.every((k) => named.has(k)) && r.json?.digest === null && r.stderr.trim() !== ''
      check(`build refuses ${what}`, ok && kept && before === after && temps(d).length === 0,
        `status ${r.status} kind ${r.json?.reason?.kind} also ${[...named].join('+')} kept ${kept} files ${before} → ${after} stderr ${r.stderr.trim()}`)
      return r
    }

    // Input.
    refuse('an input that does not end in .html', { name: 'p.htm', kind: 'input' })
    refuse('a missing input', { input: null, kind: 'input' })
    refuse('an input that is a symlink', { input: null, kind: 'input', setup: (d, p) => { writeFileSync(join(d, 'real.html'), page()); symlinkSync('real.html', p) } })
    refuse('an input that is a directory', { input: null, kind: 'input', setup: (d, p) => mkdirSync(p) })
    refuse('an input that is not UTF-8', { input: Buffer.concat([Buffer.from(page()), Buffer.from([0xff, 0xfe])]), kind: 'input' })
    // A FIFO with no writer blocks a plain open forever, so these run under a 5 s SIGKILL.
    if (mkfifo(join(fresh(), 'probe'))) {
      refuse('an input that is a FIFO, without blocking', { input: null, kind: 'input', timeout: 5000, setup: (d, p) => mkfifo(p) })
      refuse('a diff input that is a FIFO, without blocking', { input: page({ body: '<div data-diff-before="a.md" data-diff-after="b.md"></div>' }), kind: 'diff', timeout: 5000, setup: (d) => { writeFileSync(join(d, 'b.md'), 'b\n'); mkfifo(join(d, 'a.md')) } })
    } else {
      skip('build refuses a FIFO input or diff input without blocking', 'mkfifo is unavailable here')
    }

    // The marker.
    refuse('a missing marker', { input: page({ head: '' }), kind: 'marker' })
    refuse('a marker given twice', { input: page({ head: '<!-- plans:kit -->\n<!-- plans:kit -->' }), kind: 'marker' })
    refuse('a marker inside <script>', { input: page({ head: '<script>// <!-- plans:kit -->\n</script>' }), kind: 'marker' })
    refuse('a marker inside an escaped script', { input: page({ head: '<script><!--<script></script><!-- plans:kit --></script>' }), kind: 'marker' })
    refuse('a marker inside <style>', { input: page({ head: '<style>/* <!-- plans:kit --> */</style>' }), kind: 'marker' })
    refuse('a marker inside <title>', { input: page({ head: '', title: '<!-- plans:kit -->' }), kind: 'marker' })
    refuse('a marker in <body>', { input: page({ head: '', body: '<!-- plans:kit -->' }), kind: 'marker' })
    refuse('a marker inside another comment', { input: page({ head: '<!-- note <!-- plans:kit --> -->' }), kind: 'marker' })
    refuse('a real marker plus one inside <style>', { input: page({ head: '<!-- plans:kit -->\n<style>/* <!-- plans:kit --> */</style>' }), kind: 'marker' })
    refuse('a page with no <head> tags', { input: '<!doctype html><title>T</title><!-- plans:kit --><p>x</p>\n', kind: 'marker' })
    // A template's content is inert, so a marker there would leave the kit dead.
    refuse('a marker inside a <template> in <head>', { input: page({ head: '<template><!-- plans:kit --></template>' }), kind: 'marker' })
    refuse('a marker after a nested template, still inside the outer one', { input: page({ head: '<template><template></template><!-- plans:kit --></template>' }), kind: 'marker' })
    refuse('a live marker plus one inside a <template>', { input: page({ head: '<!-- plans:kit -->\n<template><!-- plans:kit --></template>' }), kind: 'marker' })
    // Foreign content: CDATA is text there, and a comment there is no place for the kit.
    refuse('a marker inside CDATA in an <svg> in <head>', { input: page({ head: '<svg><![CDATA[> <!-- plans:kit --> ]]></svg>' }), kind: 'marker' })
    refuse('a marker inside an <svg>', { input: page({ head: '<svg><!-- plans:kit --></svg>' }), kind: 'marker' })
    refuse('a marker inside an <svg> <desc>', { input: page({ head: '<svg><desc>text <!-- plans:kit --></desc></svg>' }), kind: 'marker' })

    // Built code in the input.
    refuse('an input holding a plans-build meta', { input: page({ head: '<!-- plans:kit -->\n<meta name="plans-build" content="">' }), kind: 'built' })
    refuse('an input holding a kit header line', { input: page({ body: '<pre>/* plans-kit:look.css */</pre>' }), kind: 'built' })
    refuse('an input holding a data-plans-kit style', { input: page({ head: '<!-- plans:kit -->\n<style data-plans-kit>p{}</style>' }), kind: 'built' })
    // In foreign content a style, script or textarea is no raw-text element, and an SVG title
    // holds HTML, so a meta in any of them is live.
    refuse('a plans-build meta inside an <svg> <title>', { input: page({ body: '<svg><title><meta name="plans-build" content="old"></title></svg>' }), kind: 'built', also: ['foreign'] })
    for (const el of ['style', 'script', 'textarea', 'xmp']) {
      refuse(`a plans-build meta inside an <svg> <${el}>`, { input: page({ body: `<svg><${el}><meta name="plans-build" content="old"></${el}></svg>` }), kind: 'built' })
    }

    // A Document needs a viewport meta with width=device-width, or the 390 px views lay it out at
    // 980 px, as a phone in the Plans viewer would.
    refuse('a Document page with no viewport meta', { input: page({ viewport: '' }), kind: 'viewport' })
    refuse('a viewport meta without width=device-width', { input: page({ viewport: '<meta name="viewport" content="initial-scale=1">' }), kind: 'viewport' })
    refuse('a viewport meta with width=980', { input: page({ viewport: '<meta name="viewport" content="width=980">' }), kind: 'viewport' })
    refuse('a viewport meta inside a <template>', { input: page({ viewport: '<template><meta name="viewport" content="width=device-width"></template>' }), kind: 'viewport' })
    // Chromium applies only the last viewport meta and the last width in one, so each of these lays
    // the 390 px view out 980 px wide (measured in Chromium 155). The fault names the conflict.
    {
      const r = refuse('a second viewport meta with width=980', { input: page({ viewport: '<meta name="viewport" content="width=device-width"><meta name="viewport" content="width=980">' }), kind: 'viewport' })
      check('the second-meta fault names the conflict', /2 viewport metas: Chromium applies only the last one/.test(r.stderr), r.stderr)
      const s = refuse('width=980 after width=device-width in one viewport meta', { input: page({ viewport: '<meta name="viewport" content="width=device-width, width=980">' }), kind: 'viewport' })
      check('the in-content fault names the conflict', /sets width=980 as well as width=device-width, and Chromium applies the last width/.test(s.stderr), s.stderr)
    }
    for (const [what, viewport] of [
      ['a viewport name with spaces, which Chromium ignores', '<meta name=" viewport " content="width=device-width">'],
      ['a viewport key with no value', '<meta name="viewport" content="width=device-width initial-scale">'],
      ['a loose viewport list Chromium reads as another width', '<meta name="viewport" content="width=device-width; foo width x=980">'],
      ['a viewport initial-scale below 1', '<meta name="viewport" content="width=device-width, initial-scale=0.5">'],
      ['a viewport maximum-scale below 1', '<meta name="viewport" content="width=device-width, maximum-scale=0.5">'],
      ['a viewport content with a named character reference', '<meta name="viewport" content="width=device-width&comma; initial-scale=1">'],
    ]) refuse(what, { input: page({ viewport }), kind: 'viewport' })

    // Media.
    refuse('a media src holding an unknown named entity', { input: page({ body: '<img src="a&nbsp;b.png" alt="">' }), kind: 'media' })

    // Inline mode.
    for (const hook of ['data-ask="q"', 'data-note="n"', 'data-ask-summary', 'data-respond']) {
      refuse(`the kit hook ${hook.split('=')[0]} in Inline mode`, { input: page({ body: `<div ${hook}></div>` }), inline: true, kind: 'inline-hook' })
    }
    refuse('Inline output over 500,000 bytes', { input: page({ body: `<p>${'x'.repeat(500000)}</p>` }), inline: true, kind: 'inline-size' })
    refuse('a data-note textarea inside an <svg> <title> in Inline mode', { input: page({ body: '<svg><title><textarea data-note="x"></textarea></title></svg>' }), inline: true, kind: 'inline-hook', also: ['foreign'] })
    refuse('a data-note div inside an <svg> <style> in Inline mode', { input: page({ body: '<svg><style><div data-note="n"></div></style></svg>' }), inline: true, kind: 'inline-hook' })

    // Foreign content the scanner can't follow is refused with its own kind.
    refuse('markup inside an <svg> <desc>', { input: page({ body: '<svg viewBox="0 0 8 8"><desc>a <b>bold</b> word</desc></svg>' }), kind: 'foreign' })
    refuse('markup inside an <svg> <foreignObject>', { input: page({ body: '<svg viewBox="0 0 8 8"><foreignObject><div>x</div></foreignObject></svg>' }), kind: 'foreign' })
    refuse('markup inside a MathML <mi>', { input: page({ body: '<math><mi><span>x</span></mi></math>' }), kind: 'foreign' })
    refuse('an end tag that closes no open <svg> element', { input: page({ body: '<div><svg viewBox="0 0 8 8"><g></div>' }), kind: 'foreign' })

    // Diff placeholders.
    const ph = (attrs, content = '') => page({ body: `<div ${attrs}>${content}</div>` })
    const pair = (d) => { writeFileSync(join(d, 'a.md'), 'Old text here.\n'); writeFileSync(join(d, 'b.md'), 'New text here.\n') }
    refuse('a diff input that is a symlink', { input: ph('data-diff-before="a.md" data-diff-after="b.md"'), kind: 'diff', setup: (d) => { pair(d); rmSync(join(d, 'a.md')); writeFileSync(join(d, 'real.md'), 'x\n'); symlinkSync('real.md', join(d, 'a.md')) } })
    refuse('a diff input named ../x.md', { input: ph('data-diff-before="../x.md" data-diff-after="b.md"'), kind: 'diff', setup: pair })
    refuse('a diff input named sub/x.md', { input: ph('data-diff-before="sub/x.md" data-diff-after="b.md"'), kind: 'diff', setup: (d) => { pair(d); mkdirSync(join(d, 'sub')); writeFileSync(join(d, 'sub', 'x.md'), 'x\n') } })
    refuse('a diff input of 524,289 bytes', { input: ph('data-diff-before="a.md" data-diff-after="b.md"'), kind: 'diff', setup: (d) => { pair(d); writeFileSync(join(d, 'a.md'), 'x'.repeat(524289)) } })
    refuse('a diff input that is not UTF-8', { input: ph('data-diff-before="a.md" data-diff-after="b.md"'), kind: 'diff', setup: (d) => { pair(d); writeFileSync(join(d, 'a.md'), Buffer.from([0x61, 0xc3, 0x28])) } })
    refuse('a diff input that is a directory', { input: ph('data-diff-before="a.md" data-diff-after="b.md"'), kind: 'diff', setup: (d) => { pair(d); rmSync(join(d, 'a.md')); mkdirSync(join(d, 'a.md')) } })
    refuse('a missing diff input', { input: ph('data-diff-before="a.md" data-diff-after="gone.md"'), kind: 'diff', setup: pair })
    refuse('a placeholder with content', { input: ph('data-diff-before="a.md" data-diff-after="b.md"', 'x'), kind: 'diff', setup: pair })
    refuse('a placeholder holding only whitespace', { input: ph('data-diff-before="a.md" data-diff-after="b.md"', ' '), kind: 'diff', setup: pair })
    refuse('a placeholder with an unknown attribute', { input: ph('data-diff-before="a.md" data-diff-after="b.md" style="color:red"'), kind: 'diff', setup: pair })
    refuse('a placeholder with a duplicate attribute', { input: ph('data-diff-before="a.md" data-diff-after="b.md" data-diff-after="a.md"'), kind: 'diff', setup: pair })
    refuse('a placeholder with one side', { input: ph('data-diff-before="a.md"'), kind: 'diff', setup: pair })
    refuse('a placeholder on a <span>', { input: page({ body: '<span data-diff-before="a.md" data-diff-after="b.md"></span>' }), kind: 'diff', setup: pair })
    for (const v of ['0', '10001', '12.5', '012', 'abc', '', ' 12']) {
      refuse(`data-diff-notes="${v}"`, { input: ph(`data-diff-before="a.md" data-diff-after="b.md" data-diff-notes="${v}"`), kind: 'diff', setup: pair })
    }

    // --out.
    refuse('--out in a subdirectory', { args: ['--out', 'sub/x.html'], kind: 'out', setup: (d) => mkdirSync(join(d, 'sub')) })
    refuse('--out in the parent directory', { args: ['--out', '../x.html'], kind: 'out' })
    refuse('--out not ending in .html', { args: ['--out', 'x.htm'], kind: 'out' })
    refuse('--out naming the input', { args: ['--out', 'p.html'], kind: 'out' })
    refuse('--out naming a hard link to the input', { args: ['--out', 'hard.html'], kind: 'out', setup: (d, p) => linkSync(p, join(d, 'hard.html')) })
    {
      const r = refuse('--out naming an existing symlink', { args: ['--out', 'sym.html'], kind: 'out', setup: (d) => { writeFileSync(join(d, 'target.html'), OLD); symlinkSync('target.html', join(d, 'sym.html')) } })
      const d = join(base, `c${n}`)
      check('build: a refused symlink --out leaves its target alone', readFileSync(join(d, 'target.html'), 'utf8') === OLD, r.stderr)
    }
    refuse('--out naming a directory', { args: ['--out', 'dir.html'], kind: 'out', setup: (d) => mkdirSync(join(d, 'dir.html')) })

    // A relative --out resolves against the input's directory, never the working directory.
    {
      const d = fresh(), elsewhere = fresh()
      writeFileSync(join(d, 'p.html'), page())
      const r = run(['--json', '--out', 'named.html', join(d, 'p.html')], elsewhere)
      check('build --out: a relative name lands in the input directory', r.status === 3 && r.json?.out === join(d, 'named.html') && statSync(join(d, 'named.html')).isFile() && readdirSync(elsewhere).length === 0, `${r.status} ${r.stderr}`)
      const abs = run(['--json', '--out', join(d, 'abs.html'), join(d, 'p.html')], elsewhere)
      check('build --out: an absolute path in the input directory is fine', abs.status === 3 && abs.json?.out === join(d, 'abs.html'))
    }

    // An existing output is replaced by rename, so a hard link to it keeps the old bytes.
    {
      const d = fresh()
      writeFileSync(join(d, 'p.html'), page())
      writeFileSync(join(d, 'p.built.html'), OLD)
      linkSync(join(d, 'p.built.html'), join(d, 'linked.html'))
      const r = run(['--json', join(d, 'p.html')])
      check('build: a rebuild replaces the output by rename and leaves its hard link alone', r.status === 3 && readFileSync(join(d, 'p.built.html'), 'utf8') !== OLD && readFileSync(join(d, 'linked.html'), 'utf8') === OLD && temps(d).length === 0)
    }

    // --shots writes result.json, on fail too.
    {
      const d = fresh()
      writeFileSync(join(d, 'p.html'), page())
      writeFileSync(join(d, 'bad.html'), page({ head: '' }))
      run(['--shots', 'shots', join(d, 'p.html')])
      const ok = JSON.parse(readFileSync(join(d, 'shots', 'result.json'), 'utf8'))
      run(['--shots', 'badshots', join(d, 'bad.html')])
      const bad = JSON.parse(readFileSync(join(d, 'badshots', 'result.json'), 'utf8'))
      check('build --shots: result.json holds the build id and result, on fail too', /^[0-9a-f]{64}$/.test(ok.buildId) && ok.result === 'unknown' && bad.result === 'fail', JSON.stringify([ok, bad]))
    }

    // --shots replaces result.json by rename, so whatever held that name keeps its bytes.
    {
      const d = fresh()
      writeFileSync(join(d, 'p.html'), page({ head: '' }))
      writeFileSync(join(d, 'p.built.html'), OLD)
      linkSync(join(d, 'p.built.html'), join(d, 'result.json'))
      const r = run(['--json', '--shots', '.', join(d, 'p.html')])
      const receipt = readJson(join(d, 'result.json'))
      check('build --shots: a refusal replaces a hard-linked result.json and leaves its other link alone',
        r.status === 1 && readFileSync(join(d, 'p.built.html'), 'utf8') === OLD && receipt?.result === 'fail' && temps(d).length === 0,
        `status ${r.status} p.built.html ${JSON.stringify(readFileSync(join(d, 'p.built.html'), 'utf8').slice(0, 40))} files ${readdirSync(d).join(',')}`)
    }
    {
      const d = fresh()
      writeFileSync(join(d, 'p.html'), page())
      writeFileSync(join(d, 'target.txt'), OLD)
      symlinkSync('target.txt', join(d, 'result.json'))
      const r = run(['--json', '--shots', '.', join(d, 'p.html')])
      check('build --shots: a symlink at result.json is replaced, and its target keeps its bytes',
        r.status === 3 && readFileSync(join(d, 'target.txt'), 'utf8') === OLD && !lstatSync(join(d, 'result.json')).isSymbolicLink() && readJson(join(d, 'result.json'))?.result === 'unknown' && temps(d).length === 0,
        `status ${r.status} ${r.stderr}`)
    }

    // Screenshots are written into a fresh staging directory inside DIR and renamed into place,
    // so no existing file in DIR is opened. The stand-in writes where run.mjs would.
    {
      const d = fresh()
      const shots = join(d, 'shots')
      writeFileSync(join(d, 'p.html'), page())
      mkdirSync(shots)
      writeFileSync(join(shots, '390-light-initial.png'), OLD)
      linkSync(join(shots, '390-light-initial.png'), join(shots, 'kept.png'))
      const chromium = fakeChromium(d, `for s in "${shots}"/.plans-shots.*.tmp; do printf new > "$s/390-light-initial.png"; done`)
      const r = run(['--json', '--shots', 'shots', join(d, 'p.html')], base, { env: { PLANS_CHROMIUM: chromium } })
      const files = readdirSync(shots).sort().join(',')
      check('build --shots: a screenshot replaces its name by rename and leaves a hard link alone',
        r.status === 3 && readFileSync(join(shots, '390-light-initial.png'), 'utf8') === 'new' && readFileSync(join(shots, 'kept.png'), 'utf8') === OLD,
        `status ${r.status} files ${files} ${r.stderr}`)
      check('build --shots: the staging directory is gone afterwards', files === '390-light-initial.png,kept.png,result.json', files)
    }

    // The input's directory and the shots directory are pinned when the build starts. The stand-in
    // runs where the browser check would: it stages one PNG, then renames live/ to moved/ and sh/
    // to sh-moved/ and puts a symlink to an outside directory at each old name. Every file must
    // still land where the input was read from, and nothing may reach the outside directories.
    {
      const d = fresh()
      const live = join(d, 'live'), moved = join(d, 'moved'), outside = join(d, 'outside')
      const sh = join(d, 'sh'), shMoved = join(d, 'sh-moved'), shOutside = join(d, 'sh-outside')
      for (const x of [live, outside, sh, shOutside]) mkdirSync(x)
      writeFileSync(join(live, 'p.html'), page())
      writeFileSync(join(outside, 'p.built.html'), OLD)
      const chromium = fakeChromium(d, [
        `for s in "${sh}"/.plans-shots.*.tmp; do printf new > "$s/390-light-initial.png"; done`,
        `mv "${live}" "${moved}" && ln -s "${outside}" "${live}"`,
        `mv "${sh}" "${shMoved}" && ln -s "${shOutside}" "${sh}"`,
      ].join('\n'))
      const r = run(['--json', '--shots', sh, join(live, 'p.html')], base, { env: { PLANS_CHROMIUM: chromium } })
      const built = existsSync(join(moved, 'p.built.html')) ? readFileSync(join(moved, 'p.built.html')) : Buffer.alloc(0)
      check('build: a directory swapped mid-build still gets the output, and the symlink target keeps its bytes',
        r.status === 3 && sha(built) === r.json?.digest && readFileSync(join(outside, 'p.built.html'), 'utf8') === OLD && readdirSync(outside).join(',') === 'p.built.html' && temps(moved).length === 0,
        `status ${r.status} moved ${readdirSync(moved).join(',')} outside ${readdirSync(outside).join(',')} ${r.stderr}`)
      check('build --shots: a shots directory swapped mid-build still gets the PNGs and result.json',
        readdirSync(shOutside).length === 0 && readdirSync(shMoved).sort().join(',') === '390-light-initial.png,result.json' && readJson(join(shMoved, 'result.json'))?.result === 'unknown',
        `sh-moved ${readdirSync(shMoved).join(',')} sh-outside ${readdirSync(shOutside).join(',')}`)
    }

    // pinDir in memory: through /proc/self/fd where it exists, and the stat-checked path elsewhere.
    {
      const d = fresh()
      mkdirSync(join(d, 'a'))
      const viaPath = mod.pinDir(join(d, 'a'), join(d, 'no-proc'))
      const before = viaPath.at('x')
      renameSync(join(d, 'a'), join(d, 'b'))
      mkdirSync(join(d, 'a'))
      let refused = null
      try { viaPath.at('x') } catch (e) { refused = e.code }
      check('pinDir without /proc: a name resolves by path until the path names another directory', !viaPath.viaProc && before === join(d, 'a', 'x') && refused === 'EPINNED', `${before} ${refused}`)
      closeSync(viaPath.fd)
      if (existsSync('/proc/self/fd')) {
        const pin = mod.pinDir(join(d, 'b'))
        renameSync(join(d, 'b'), join(d, 'c'))
        writeFileSync(pin.at('y'), 'y')
        check('pinDir with /proc: a name resolves through the descriptor after the directory moves', pin.viaProc && readFileSync(join(d, 'c', 'y'), 'utf8') === 'y' && !existsSync(join(d, 'a', 'y')))
        closeSync(pin.fd)
      } else {
        skip('pinDir with /proc', '/proc/self/fd is missing on this platform')
      }
    }

    // The viewport rule's accepted forms, and Inline mode, which T3 renders in an iframe.
    for (const [what, viewport, args] of [
      ['an Inline page with no viewport meta', '', ['--inline']],
      ['a viewport meta with its keys reordered', '<meta name="viewport" content="initial-scale=1, width=device-width">', []],
      ['a viewport meta with spaces around =', '<meta name="viewport" content="width = device-width">', []],
      ['an upper-case viewport name and value', '<meta name="Viewport" content="WIDTH=DEVICE-WIDTH">', []],
      ['a viewport meta with extra directives', '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, minimum-scale=0.5, user-scalable=no, viewport-fit=cover">', []],
      ['a viewport meta with semicolons', '<meta name="viewport" content="width=device-width;initial-scale=1">', []],
      ['a second viewport meta inside a <template>', `${VIEWPORT}<template><meta name="viewport" content="width=980"></template>`, []],
      ['an Inline page with two viewport metas', '<meta name="viewport" content="width=device-width"><meta name="viewport" content="width=980">', ['--inline']],
    ]) {
      const d = fresh()
      writeFileSync(join(d, 'p.html'), page({ viewport }))
      const r = run(['--json', ...args, join(d, 'p.html')])
      check(`build: ${what} builds`, r.status === 3 && r.json?.result === 'unknown', `${r.status} ${r.stderr}`)
    }

    // Foreign content the scanner follows builds: the guide's figure shape, MathML, CDATA in SVG
    // text, a breakout that leaves the svg, and templates outside the marker's way.
    {
      const d = fresh()
      const figure = '<svg viewBox="0 0 80 40" role="img"><title>Fig 1: two boxes</title><desc>One box & another</desc>' +
        '<style>.f1 text { font-size: 14px; }</style><defs><marker id="f1-m"><path d="M0 0L8 4z"/></marker></defs>' +
        '<g class="f1"><rect x="0" y="0" width="8" height="8"/><text x="8" y="16">a &lt; b <tspan>c</tspan></text>' +
        '<text><![CDATA[x <y> z]]></text><path d="M0 0" marker-end="url(#f1-m)"/></g></svg>'
      const body = `${figure}\n<math><mi>x</mi><mo>=</mo><mn>1</mn></math>\n<svg viewBox="0 0 8 8"><title>t</title></svg><p>after</p>\n<template><p>inert</p></template>`
      writeFileSync(join(d, 'p.html'), page({ body, head: '<!-- plans:kit -->\n<template><p>x</p></template>' }))
      const r = run(['--json', join(d, 'p.html')])
      check('build: SVG figures, MathML, CDATA in SVG text and templates away from the marker build', r.status === 3 && r.json?.result === 'unknown', `${r.status} ${r.stderr}`)
    }

    // Diff expansion.
    {
      const d = fresh()
      const cut = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen'
      writeFileSync(join(d, 'a.md'), `# Title\n\nKeep this. ${cut}. End.\n`)
      writeFileSync(join(d, 'b.md'), '# Title\n\nKeep this. End, with new words.\n')
      const body = '<div id="d1" class="wide rev" aria-label="The rewrite" data-diff-before="a.md" data-diff-after="b.md"></div>\n' +
        '<div data-diff-before=a.md data-diff-after=b.md data-diff-notes="20"></div>\n' +
        '<div data-diff-after="b.md" data-diff-before="b.md"></div>'
      writeFileSync(join(d, 'p.html'), page({ body }))
      const r = run(['--json', join(d, 'p.html')])
      const text = r.status === 3 ? readFileSync(join(d, 'p.built.html'), 'utf8') : ''
      check('build diff: placeholders expand', r.status === 3 && !text.includes('data-diff-'), `${r.status} ${r.stderr}`)
      check('build diff: id, class and aria-* stay on div.plans-diff', text.includes('<div class="plans-diff wide rev" id="d1" aria-label="The rewrite">'))
      check('build diff: a cut over 12 words becomes a caret and a note', (text.match(/<sup class="plans-caret"/g) ?? []).length === 1 && (text.match(/<span class="plans-note">/g) ?? []).length === 1)
      check('build diff: data-diff-notes="20" keeps that cut inline', (text.match(/<div class="plans-diff">/g) ?? []).length === 2 && text.includes('<del class="plans-cut">'))
      check('build diff: the page ships no diff code', !/\b(diffDoc|diffText|renderBlocks|toBlocks)\b|<script(?! data-plans-kit)/.test(text))
    }

    // --- pure helpers, in memory.
    {
      const shipped = mod.readKit()
      for (const name of Object.keys(mod.KIT_FILES)) {
        const bad = mod.kitRefusals(name, shipped[name])
        check(`kitRefusals: the shipped ${name} passes`, bad.length === 0, bad.join('; '))
      }
      const h = '/* plans-kit:look.css */\n'
      for (const [what, text] of [['</style', `${h}a { } </style> b`], ['</SCRIPT', `${h}x </SCRIPT> y`], ['<!--', `${h}<!-- x`], ['a missing header', 'a { }\n'], ['the wrong header', '/* plans-kit:marks.css */\na { }\n']]) {
        check(`kitRefusals: refuses ${what}`, mod.kitRefusals('look.css', text).length > 0)
      }
      // A kit file with a refusal stops assembly before any output exists.
      const kit = { ...shipped, 'ask.js': `${shipped['ask.js']}\n// </script>\n` }
      const got = mod.assemble(page(), { kit, readSibling: () => { throw new Error('unused') } })
      check('assemble: a refused kit file yields a kit-file fault and no buffer', got.buffer === null && got.faults.some((f) => f.kind === 'kit-file'))
      const inline = mod.assemble(page(), { inline: true, kit, readSibling: () => '' })
      check('assemble: Inline mode does not read ask.js', inline.buffer !== null && inline.faults.length === 0)
      check('build limits match the contract', mod.DIFF_MAX === 524288 && mod.INLINE_MAX === 500000 && mod.NOTES_DEFAULT === 12 && mod.NOTES_MAX === 10000)
    }

    // --- static rules over kit/ask.js.
    {
      const js = readFileSync(join(DOC, 'kit/ask.js'), 'utf8')
      const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(),])\/\/[^\n]*/g, '$1')
      const body = code.trim()
      check('ask.js: is one IIFE', body.startsWith('(() => {') && /\}\)\(\)\s*;?$/.test(body) && (body.match(/^\(\(\) => \{/gm) ?? []).length === 1, body.slice(0, 40))
      const forbidden = [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write(?:ln)?\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\bcookie\b/, /\bwindow\.open\b/, /\bopen\s*\(/]
      for (const re of forbidden) check(`ask.js: never uses ${re.source.replace(/\\b|\\/g, '')}`, !re.test(code))
      const calls = [...code.matchAll(/\.(querySelector|querySelectorAll|closest|matches)\s*\(/g)]
      const bad = calls.filter((m) => !/^\s*(?:'[^'\n]*'|"[^"\n]*")\s*\)/.test(code.slice(m.index + m[0].length)))
      check('ask.js: every selector argument is a string literal', calls.length > 0 && bad.length === 0, bad.map((m) => code.slice(m.index, m.index + 60)).join(' | '))
    }

    // --- findChromium.
    {
      const d = fresh()
      const bin = join(d, 'bin'), plain = join(d, 'plain')
      mkdirSync(bin)
      writeFileSync(join(bin, 'chromium'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(bin, 'chromium'), 0o755)
      writeFileSync(plain, 'not executable\n')
      chmodSync(plain, 0o644)
      const r1 = findChromium({ PLANS_CHROMIUM: plain, PATH: bin }, 'linux')
      check('findChromium: a non-executable PLANS_CHROMIUM is unknown even with chromium on PATH', r1.path === null && r1.reason?.kind === 'no-chromium', JSON.stringify(r1))
      const r2 = findChromium({ PLANS_CHROMIUM: '/nonexistent', PATH: bin }, 'linux')
      check('findChromium: a missing PLANS_CHROMIUM is unknown', r2.path === null && r2.reason?.kind === 'no-chromium')
      const r3 = findChromium({ PLANS_CHROMIUM: bin, PATH: bin }, 'linux')
      check('findChromium: a directory PLANS_CHROMIUM is unknown', r3.path === null)
      const r4 = findChromium({ PLANS_CHROMIUM: join(bin, 'chromium') }, 'linux')
      check('findChromium: an executable PLANS_CHROMIUM is used exactly', r4.path === join(bin, 'chromium') && r4.reason === null)
      const r5 = findChromium({ PATH: `relative:${bin}` }, 'linux')
      check('findChromium: finds chromium on PATH', r5.path === join(bin, 'chromium'))
      const r6 = findChromium({ PATH: '' }, 'linux')
      check('findChromium: nothing on PATH is unknown no-chromium', r6.path === null && r6.reason?.kind === 'no-chromium')
      const r7 = findChromium({ PATH: `${d}/nowhere` }, 'darwin')
      check('findChromium: darwin checks only the Chrome app path after PATH', r7.path === null || r7.path === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    }

    // --- the MEDIA table equals the publish table.
    {
      const publish = readFileSync(join(ROOT, 'plugins/plans/skills/publish/SKILL.md'), 'utf8')
      const table = {}
      for (const m of publish.matchAll(/^\| ((?:`\.[a-z0-9]+`(?:, )?)+) \| `([^`]+)` \|$/gm)) {
        for (const ext of m[1].match(/\.[a-z0-9]+/g)) table[ext] = m[2]
      }
      const a = JSON.stringify(Object.entries(table).sort()), b = JSON.stringify(Object.entries(MEDIA).sort())
      check('serve.mjs MEDIA equals the table in publish/SKILL.md', Object.keys(table).length > 0 && a === b, `${a} vs ${b}`)
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}
