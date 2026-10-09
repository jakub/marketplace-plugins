// pack and media (patch 0005): pack leaves local media as literal files beside the page, for the plans CLI to upload at publish
// time, and inlines nothing else but the runtime, once, from its own folder. Each doc-shot gets a literal <img> child and loses
// its own src. Every refusal exits 1 with nothing written, under --lint-only too, and leaves an existing output byte for byte.
// The media allowlist is held to the extension table in skills/publish/SKILL.md. pack runs on import, so every case spawns it
// on a fixture folder under the system temp directory, which the section removes at the end.

import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'

const RUNTIME = 'plugins/plans/skills/doc/runtime'
const SENTINEL = 'an existing output, which a refused pack must leave alone\n'

const page = (body, head = '') => '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<title>Fixture</title>\n' +
  `<link rel="stylesheet" href="htmlplan.css">\n${head}<body>\n<main>\n<h1>Fixture</h1>\n${body}\n</main>\n` +
  '<script src="htmlplan.js" defer></script>\n</body>\n</html>\n'
const count = (text, s) => text.split(s).length - 1
const cp = String.fromCharCode; const BOM = cp(0xfeff), NBSP = cp(0xa0)
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
  // The plans CLI opens media through os.Root, which follows some symlinks and refuses others. pack follows none: a symlink
  // anywhere in a media path, a folder or the file, is refused by name, wherever it points, and so is a symlinked stylesheet.
  { name: 'symlink-out', setup: (d) => symlinkSync('../outside.png', join(d, 'link.png')), body: '<img src="link.png" alt="">', why: /src="link\.png" goes through "link\.png", a symlink/ },
  { name: 'symlink-to-file-inside', setup: (d) => symlinkSync('shot.png', join(d, 'link.png')), body: '<img src="link.png" alt="">', why: /src="link\.png" goes through "link\.png", a symlink/ },
  { name: 'symlink-directory', setup: (d) => { writeFileSync(join(d, 'sub/clip.mp4'), 'mp4'); symlinkSync('sub', join(d, 'via')) }, body: '<video src="via/clip.mp4"></video>', why: /src="via\/clip\.mp4" goes through "via", a symlink/ },
  { name: 'symlink-stylesheet', setup: (d) => { writeFileSync(join(d, 'local.css'), '.p{color:blue}\n'); symlinkSync('local.css', join(d, 'link.css')) }, head: '<link rel="stylesheet" href="link.css">\n', body: '<p>x</p>', why: /stylesheet "link\.css" goes through "link\.css", a symlink/ },
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
  // CSS reads a backslash escape in an identifier, so u\72l( is url( and @\69mport is @import. pack decodes none and refuses an
  // escape in the name of a function or an at-rule, in a <style>, a style="" and the page's own stylesheet; comments and strings
  // are blanked in CSS's own order first, so neither a fake string nor a comment opened inside a string hides a reference.
  { name: 'css-escaped-url', head: '<style>.x{background:u\\72l(shot.png)}</style>\n', body: '<p class="x">x</p>', why: /<style>: "u\\72l\(" holds a backslash escape in the name of a CSS function or at-rule/ },
  { name: 'css-escaped-url-hex-space', head: '<style>.x{background:u\\72 l(shot.png)}</style>\n', body: '<p class="x">x</p>', why: /"u\\72 l\(" holds a backslash escape/ },
  { name: 'css-escaped-url-upper', head: '<style>.x{background:U\\52L("shot.png")}</style>\n', body: '<p class="x">x</p>', why: /"U\\52L\(" holds a backslash escape/ },
  { name: 'css-escaped-import', head: '<style>@\\69mport "more.css";</style>\n', body: '<p>x</p>', why: /"@\\69mport" holds a backslash escape/ },
  { name: 'css-escaped-import-inside', head: '<style>@im\\70 ort url(more.css);</style>\n', body: '<p>x</p>', why: /"@im\\70 ort" holds a backslash escape/ },
  { name: 'css-escaped-url-attribute', body: '<div style="background:u\\72l(shot.png)">x</div>', why: /style="": "u\\72l\(" holds a backslash escape/ },
  { name: 'css-escaped-url-linked', setup: (d) => writeFileSync(join(d, 'local.css'), ".x{background:u\\72l('shot.png')}\n"),
    head: '<link rel="stylesheet" href="local.css">\n', body: '<p class="x">x</p>', why: /local\.css: "u\\72l\(" holds a backslash escape/ },
  { name: 'css-escape-after-fake-string', head: '<style>a{b:\\"x u\\72l(shot.png)"}</style>\n', body: '<p>x</p>', why: /"u\\72l\(" holds a backslash escape/ },
  { name: 'css-url-after-comment-in-string', head: '<style>a{content:"/*"} .x{background:url(shot.png)} i{content:"*/"}</style>\n', body: '<p class="x">x</p>', why: /<style>: CSS url\(\) "shot\.png"/ },
  { name: 'css-url-after-escaped-quote', head: '<style>a{content:\\" } .x{background:url(shot.png)} i{content:"}</style>\n', body: '<p class="x">x</p>', why: /<style>: CSS url\(\) "shot\.png"/ },
  // CSS Syntax §3.3 turns CRLF, CR and FF into LF before tokenizing, so a bad string ends at any of them, in a <style>, a style=""
  // and the page's own stylesheet. pack preprocesses the text the same way before every CSS scan.
  { name: 'css-cr-ends-string', head: '<style>.x{content:"bad\r;background:url(shot.png)}</style>\n', body: '<p class="x">x</p>', why: /<style>: CSS url\(\) "shot\.png"/ },
  { name: 'css-ff-ends-string', head: '<style>.x{content:"bad\f;background:url(shot.png)}</style>\n', body: '<p class="x">x</p>', why: /<style>: CSS url\(\) "shot\.png"/ },
  { name: 'css-cr-before-import', head: '<style>a{content:"bad\r}@import "more.css";</style>\n', body: '<p>x</p>', why: /CSS @import/ },
  { name: 'css-cr-ends-string-linked', setup: (d) => writeFileSync(join(d, 'local.css'), '.x{content:"bad\r;background:url(shot.png)}\n'),
    head: '<link rel="stylesheet" href="local.css">\n', body: '<p class="x">x</p>', why: /local\.css: CSS url\(\) "shot\.png"/ },
  { name: 'css-cr-ends-string-attribute', body: '<div style="content:&quot;bad&#13;;background:url(shot.png)">x</div>', why: /style="": CSS url\(\) "shot\.png"/ },
  { name: 'css-ff-ends-string-attribute', body: '<div style="content:&quot;bad&#12;;background:url(shot.png)">x</div>', why: /style="": CSS url\(\) "shot\.png"/ },
  // CSS loads an image through more than url(): image-set() and -webkit-image-set() take a quoted string, image(), cross-fade()
  // and -webkit-cross-fade() take strings or url()s, src() is url() under another name, and element() or -moz-element() paints an
  // element of the page. The plans CLI uploads none of them, so pack refuses each unless every string or url() in it is a data:
  // URI, and element() outright, in a <style>, a style="" and the page's own stylesheet, to the matching ")" or the end of the
  // text, which closes an open function in CSS. A string inside type() names a MIME type and is not a URL.
  { name: 'css-image-set', head: '<style>.x{background:image-set("shot.png" 1x)}</style>\n', body: '<p class="x">x</p>', why: /<style>: CSS image-set\(\) "shot\.png"/ },
  { name: 'css-image-set-attribute', body: '<div style="background:image-set(&quot;shot.png&quot; 1x)">x</div>', why: /style="": CSS image-set\(\) "shot\.png"/ },
  { name: 'css-image-set-linked', setup: (d) => writeFileSync(join(d, 'local.css'), ".x{background:image-set('shot.png' 1x)}\n"),
    head: '<link rel="stylesheet" href="local.css">\n', body: '<p class="x">x</p>', why: /local\.css: CSS image-set\(\) "shot\.png"/ },
  { name: 'css-webkit-image-set', head: "<style>.x{background:-webkit-image-set('shot.png' 1x, 'shot@2x.png' 2x)}</style>\n", body: '<p class="x">x</p>', why: /CSS -webkit-image-set\(\) "shot\.png"/ },
  { name: 'css-image-set-upper', head: '<style>.x{background:IMAGE-SET("shot.png" 1x)}</style>\n', body: '<p class="x">x</p>', why: /CSS IMAGE-SET\(\) "shot\.png"/ },
  { name: 'css-image-set-mixed', head: '<style>.x{background:image-set("data:image/png;base64,iVBORw0KGgo=" 1x, "shot.png" 2x)}</style>\n', body: '<p class="x">x</p>', why: /CSS image-set\(\) "shot\.png"/ },
  { name: 'css-image-set-unclosed', head: '<style>.x{background:image-set("shot.png" 1x</style>\n', body: '<p class="x">x</p>', why: /CSS image-set\(\) "shot\.png"/ },
  { name: 'css-image-set-after-block', head: '<style>.x{background:image-set([)] "shot.png" 1x)}</style>\n', body: '<p class="x">x</p>', why: /CSS image-set\(\) "shot\.png"/ },
  { name: 'css-image-set-nested', head: '<style>.x{background:image-set(image("shot.png") 1x)}</style>\n', body: '<p class="x">x</p>', why: /CSS image\(\) "shot\.png"/ },
  { name: 'css-image-set-escaped-name', head: '<style>.x{background:imag\\65-set("shot.png" 1x)}</style>\n', body: '<p class="x">x</p>', why: /"imag\\65-set\(" holds a backslash escape/ },
  { name: 'css-cr-before-image-set', head: '<style>a{content:"bad\r}.x{background:image-set("shot.png" 1x)}</style>\n', body: '<p class="x">x</p>', why: /CSS image-set\(\) "shot\.png"/ },
  { name: 'css-image-function', head: '<style>.x{background:image("x.png")}</style>\n', body: '<p class="x">x</p>', why: /<style>: CSS image\(\) "x\.png"/ },
  { name: 'css-cross-fade', head: '<style>.x{background:cross-fade(url(a.png), "b.png", 50%)}</style>\n', body: '<p class="x">x</p>', why: /CSS cross-fade\(\) "b\.png"/ },
  { name: 'css-cross-fade-url', head: '<style>.x{background:cross-fade(url(a.png), url(b.png), 50%)}</style>\n', body: '<p class="x">x</p>', why: /CSS url\(\) "a\.png"/ },
  { name: 'css-webkit-cross-fade', head: '<style>.x{background:-webkit-cross-fade("a.png", "b.png", 50%)}</style>\n', body: '<p class="x">x</p>', why: /CSS -webkit-cross-fade\(\) "a\.png"/ },
  { name: 'css-src-function', head: '<style>.x{background:src("shot.png")}</style>\n', body: '<p class="x">x</p>', why: /CSS src\(\) "shot\.png"/ },
  { name: 'css-element', head: '<style>.x{background:element(#y)}</style>\n', body: '<p class="x">x</p>', why: /<style>: CSS element\(\)/ },
  { name: 'css-moz-element', body: '<div style="background:-moz-element(#y)">x</div>', why: /style="": CSS -moz-element\(\)/ },
  // A custom property is substituted after pack reads the sheet, so var() inside an image function can name any file, and env()
  // and attr() are read as late. pack refuses each anywhere in the arguments of image-set(), -webkit-image-set(), image(),
  // cross-fade(), -webkit-cross-fade() and src(), in a <style>, a style="" and the page's own stylesheet, and accepts them
  // everywhere else. An escape in the name is refused by the escaped-name rule.
  { name: 'css-image-set-var', head: '<style>:root{--r11-image:"secret.png"}#p{background-image:image-set(var(--r11-image) 1x)}</style>\n', body: '<p id="p">x</p>', why: /<style>: CSS image-set\(\) holds var\(\)/ },
  { name: 'css-image-set-var-attribute', body: '<div style="background-image:image-set(var(--r11-image) 1x)">x</div>', why: /style="": CSS image-set\(\) holds var\(\)/ },
  { name: 'css-image-set-var-linked', setup: (d) => writeFileSync(join(d, 'local.css'), ':root{--r11-image:"secret.png"}#p{background-image:image-set(var(--r11-image) 1x)}\n'),
    head: '<link rel="stylesheet" href="local.css">\n', body: '<p id="p">x</p>', why: /local\.css: CSS image-set\(\) holds var\(\)/ },
  { name: 'css-image-set-var-upper', head: '<style>.x{background:IMAGE-SET(VAR(--i) 1x)}</style>\n', body: '<p class="x">x</p>', why: /CSS IMAGE-SET\(\) holds VAR\(\)/ },
  { name: 'css-image-set-var-after-data', head: '<style>.x{background:image-set("data:image/png;base64,iVBORw0KGgo=" var(--res))}</style>\n', body: '<p class="x">x</p>', why: /CSS image-set\(\) holds var\(\)/ },
  { name: 'css-image-set-var-nested', head: '<style>.x{background:image-set(image(var(--i)) 1x)}</style>\n', body: '<p class="x">x</p>', why: /CSS image\(\) holds var\(\)/ },
  { name: 'css-image-set-var-unclosed', head: '<style>.x{background:image-set(var(--i) 1x</style>\n', body: '<p class="x">x</p>', why: /CSS image-set\(\) holds var\(\)/ },
  { name: 'css-cross-fade-env', head: '<style>.x{background:cross-fade(url("data:image/png;base64,iVBORw0KGgo="), env(--i), 50%)}</style>\n', body: '<p class="x">x</p>', why: /CSS cross-fade\(\) holds env\(\)/ },
  { name: 'css-webkit-image-set-env', body: '<div style="background:-webkit-image-set(env(safe-area-inset-top) 1x)">x</div>', why: /style="": CSS -webkit-image-set\(\) holds env\(\)/ },
  { name: 'css-src-attr', head: '<style>.x{background:src(attr(data-src))}</style>\n', body: '<p class="x">x</p>', why: /CSS src\(\) holds attr\(\)/ },
  { name: 'css-image-attr-linked', setup: (d) => writeFileSync(join(d, 'local.css'), '.x{background:image(attr(data-src url))}\n'),
    head: '<link rel="stylesheet" href="local.css">\n', body: '<p class="x">x</p>', why: /local\.css: CSS image\(\) holds attr\(\)/ },
  { name: 'css-image-set-var-escaped-name', head: '<style>.x{background:image-set(v\\61r(--i) 1x)}</style>\n', body: '<p class="x">x</p>', why: /"v\\61r\(" holds a backslash escape/ },
  // The end of the text closes a url() as it closes an image function: an unquoted url runs to ")" or the end, and a quoted one
  // is a function the end closes, with or without its closing quote. The browser fetches each, so pack checks each, in a
  // <style>, a style="" and the page's own stylesheet. The closed forms above are the controls.
  { name: 'css-url-eof-attribute', body: '<div style="background:url(shot.png">x</div>', why: /style="": CSS url\(\) "shot\.png"/ },
  { name: 'css-url-eof-attribute-quoted', body: '<div style="background:url(&quot;shot.png&quot;">x</div>', why: /style="": CSS url\(\) "shot\.png"/ },
  { name: 'css-url-eof-style', head: '<style>.x{background:url(shot.png</style>\n', body: '<p class="x">x</p>', why: /<style>: CSS url\(\) "shot\.png"/ },
  { name: 'css-url-eof-style-newline', head: '<style>.x{background:url(shot.png\n</style>\n', body: '<p class="x">x</p>', why: /<style>: CSS url\(\) "shot\.png"/ },
  { name: 'css-url-eof-style-quoted', head: '<style>.x{background:url("shot.png"</style>\n', body: '<p class="x">x</p>', why: /<style>: CSS url\(\) "shot\.png"/ },
  { name: 'css-url-eof-style-quoted-space', head: "<style>.x{background:url( 'shot.png' </style>\n", body: '<p class="x">x</p>', why: /<style>: CSS url\(\) "shot\.png"/ },
  { name: 'css-url-eof-style-unclosed-string', head: '<style>.x{background:url("shot.png</style>\n', body: '<p class="x">x</p>', why: /<style>: CSS url\(\) "shot\.png"/ },
  { name: 'css-url-eof-linked', setup: (d) => writeFileSync(join(d, 'local.css'), ".x{background:url('shot.png'"),
    head: '<link rel="stylesheet" href="local.css">\n', body: '<p class="x">x</p>', why: /local\.css: CSS url\(\) "shot\.png"/ },
  { name: 'css-url-eof-linked-unquoted', setup: (d) => writeFileSync(join(d, 'local.css'), '.x{background:url(shot.png'),
    head: '<link rel="stylesheet" href="local.css">\n', body: '<p class="x">x</p>', why: /local\.css: CSS url\(\) "shot\.png"/ },
  { name: 'css-url-eof-upper', head: '<style>.x{background:URL(shot.png</style>\n', body: '<p class="x">x</p>', why: /<style>: CSS url\(\) "shot\.png"/ },
  // JavaScript's trim() and \s take U+FEFF, U+00A0 and the other Unicode spaces as whitespace. HTML's attribute and srcset rules
  // know ASCII whitespace alone, and CSS, after its preprocessing, LF, TAB and SPACE; the URL parser keeps the rest, so a value
  // that is data: only once a Unicode space is trimmed is a path beside the page to the browser.
  { name: 'poster-bom', body: `<video src="clip.webm" poster="${BOM}data:image/png;base64,iVBORw0KGgo="></video>`, why: /poster "\uFEFFdata:/ },
  { name: 'poster-nbsp', body: `<video src="clip.webm" poster="${NBSP}data:image/png;base64,iVBORw0KGgo="></video>`, why: /poster "\u00A0data:/ },
  { name: 'srcset-bom', body: `<img src="shot.png" srcset="${BOM}data:image/png;base64,iVBORw0KGgo= 1x" alt="">`, why: /srcset "\uFEFFdata:/ },
  { name: 'srcset-nbsp', body: `<img src="shot.png" srcset="data:image/png;base64,iVBORw0KGgo= 1x,${NBSP}data:image/png;base64,iVBORw0KGgo= 2x" alt="">`, why: /srcset "\u00A0data:/ },
  { name: 'css-url-bom', head: `<style>.x{background:url(${BOM}data:image/png;base64,iVBORw0KGgo=)}</style>\n`, body: '<p class="x">x</p>', why: /<style>: CSS url\(\) "\uFEFFdata:/ },
  { name: 'css-url-quoted-nbsp', head: `<style>.x{background:url("${NBSP}data:image/png;base64,iVBORw0KGgo=")}</style>\n`, body: '<p class="x">x</p>', why: /<style>: CSS url\(\) "\u00A0data:/ },
  { name: 'css-url-bom-attribute', body: '<div style="background:url(&#xFEFF;data:image/png;base64,iVBORw0KGgo=)">x</div>', why: /style="": CSS url\(\) "\uFEFFdata:/ },
  { name: 'css-url-bom-linked', setup: (d) => writeFileSync(join(d, 'local.css'), `.x{background:url('${BOM}data:image/png;base64,iVBORw0KGgo=')}\n`),
    head: '<link rel="stylesheet" href="local.css">\n', body: '<p class="x">x</p>', why: /local\.css: CSS url\(\) "\uFEFFdata:/ },
  { name: 'css-image-set-bom', head: `<style>.x{background:image-set("${BOM}data:image/png;base64,iVBORw0KGgo=" 1x)}</style>\n`, body: '<p class="x">x</p>', why: /CSS image-set\(\) "\uFEFFdata:/ },
  // pack reads a src as the CLI's tokenizer (golang.org/x/net/html) does, or refuses. &sol; names public/private.png to the CLI; pack
  // holds no entity table, so it refuses the reference instead of checking the literal file. An unquoted value ends at HTML
  // whitespace only, so U+00A0 is part of the name the CLI reads.
  { name: 'entity-unknown', setup: (d) => { mkdirSync(join(d, 'public')); writeFileSync(join(d, 'public/private.png'), 'the file the CLI would upload'); writeFileSync(join(d, 'public&sol;private.png'), 'the file pack once checked') },
    body: '<img src="public&sol;private.png" alt="">', why: /src="public&sol;private\.png" holds "&sol;"/ },
  { name: 'unquoted-nbsp', setup: (d) => { writeFileSync(join(d, 'a.png'), 'png'); writeFileSync(join(d, 'a.png b'), 'the file the CLI would read') },
    body: '<img src=a.png b alt="">', why: /src="a\.png b" — "\.png b" is not a media type/ },
  // The same rule holds for every attribute of every tag: &Tab; is whitespace to the CLI and to a browser, so this rel names a
  // stylesheet to both, and pack refuses the reference rather than read the tag under another value.
  { name: 'entity-in-rel', head: '<link rel="&Tab;stylesheet" href="https://example.com/x.css">\n', body: '<p>x</p>', why: /<link>: rel="&Tab;stylesheet" holds "&Tab;"/ },
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
      ['<img src="shot.png" alt="again">', '<video controls src="clip.webm">', '<source src="sub/clip.mp4"',
        '<img src="shot.png?v=2#top"', '<img src="shot.png?x=1&copy=2"', '<img src="a&amp;b.png"', '<img src="a&#38;b.png"', '<img src="a&#x26;b.png"',
        '<template><img src="shot.png" alt="in a mock">'].every((s) => o.includes(s)))
    check('nothing is base64-inlined beyond the authored data: URIs', count(o, ';base64,') === count(GOOD, ';base64,') && !o.includes('data:video') && !o.includes('png bytes'))
    check('the runtime CSS and JS are inlined once each', count(o, '<style data-htmlplan>') === 1 && count(o, '<script data-htmlplan>') === 1 && !/<link[^>]*htmlplan|<script[^>]*src=/i.test(o))
    check('the inlined runtime is pack\'s own, not the copy beside the page',
      o.includes(`<style data-htmlplan>\n${css}\n</style>`) && o.includes(`<script data-htmlplan>\n${js}\n</script>`) && !o.includes('DECOY-RUNTIME'))
    check('the page\'s own stylesheet is inlined from its folder', o.includes('<style>/* page.css */\n.p { color: blue }\n\n</style>') && !/rel="stylesheet"/.test(o),
      o.match(/[^\n]{0,80}(page\.css|rel="stylesheet")[^\n]{0,80}/g)?.join(' | '))
    check('pack reports the five distinct paths it left for the CLI, as the CLI counts uploads', /5 local media files stay beside the page/.test(r.stdout) && /5 media files beside it/.test(r.stdout), r.stdout.slice(-400))
    check('the three spellings of a&b.png are one file to pack, listed once by the name the CLI reads', /: [^\n]*\ba&b\.png/.test(r.stdout) && !/a&amp;b|a&#38;b|a&#x26;b/.test(r.stdout), r.stdout.match(/[^\n]*a&[^\n]*/g)?.join(' | '))
    check('commented-out and text/plain markup is never scanned', !/commented-out|not-a-tag/.test(r.stdout))

    const lintDir = fixture('good-lint', GOOD, (d) => {
      writeFileSync(join(d, 'my shot.png'), 'png'); writeFileSync(join(d, 'sub/clip.mp4'), 'mp4'); writeFileSync(join(d, 'a&b.png'), 'png')
      writeFileSync(join(d, 'page.css'), '.p { color: blue }\n')
    })
    const before = listing(lintDir); const rl = run(lintDir, '--lint-only', 'page.html')
    check('--lint-only passes the positive fixture and writes nothing', rl.status === 0 && listing(lintDir) === before, out(rl))

    // Escapes outside a function or at-rule name, and anything inside a string or a comment, are not refused.
    const benign = fixture('css-escapes-benign', page('<div style="font-family:\\41 rial">x</div>',
      '<style>.md\\:flex{display:flex} .\\31 0{color:red} .a::before{content:"\\201C u\\72l(x) @\\69mport"} /* u\\72l(y) */ .b{fill:url(#g)}</style>\n'))
    const rb = run(benign, 'page.html')
    check('CSS escapes in selectors, property values, strings and comments are accepted', rb.status === 0, out(rb))

    // A backslash before a newline continues a CSS string, and CSS reads CRLF, a lone CR and FF as that newline too, so a url()
    // after any of them is still inside the string. The LF form is the control.
    const continued = fixture('css-newline-continuation', page('<div style="content:&quot;a\\&#13;&#10;url(shot.png)&quot;">x</div>',
      '<style>.a::before{content:"b\\\r\nurl(shot.png)"} .b::before{content:"c\\\nurl(shot.png)"} .c::before{content:"d\\\rurl(shot.png)"} .d::before{content:"e\\\furl(shot.png)"}</style>\n'))
    const rc = run(continued, 'page.html')
    check('a url() after an escaped LF, CRLF, CR or FF inside a CSS string is accepted', rc.status === 0, out(rc))

    // The image functions pass when every string and url() in them is a data: URI, with a type() MIME string beside them; the
    // names inside a string, a comment or a longer identifier are not function calls.
    const D = 'data:image/png;base64,iVBORw0KGgo='
    const imageFns = fixture('css-image-functions-data', page(`<div style="background:image-set(&quot;${D}&quot; 1x)">x</div>`,
      `<style>.a{background:image-set("${D}" 1x, url(${D}) 2x type("image/png"))} .b{background:-webkit-image-set('${D}' 1x)} .c{background:cross-fade(url("${D}"), url(${D}), 50%)} .d{background:src("${D}")} .e{background:image(rtl "${D}", red)} .f::before{content:"image-set('shot.png' 1x) element(#y)"} /* image-set("shot.png") */ .my-image-set{background:my-image(x) x-element(#y)}</style>\n`))
    const ri = run(imageFns, 'page.html')
    check('image-set, cross-fade, src and image that hold only data: URIs are accepted, as are the names in a string, a comment or a longer identifier', ri.status === 0, out(ri))

    // var(), env() and attr() outside the image functions, in other functions, and as parts of longer names are not refused.
    const subst = fixture('css-substitution-outside-image-functions', page('<div style="color:var(--plans-ink);margin-top:env(safe-area-inset-top)">x</div>',
      `<style>:root{--plans-x:"shot.png"} .a{color:var(--plans-ink)} .b{padding:env(safe-area-inset-bottom, 0px)} .c::before{content:attr(title)} .d{width:calc(var(--w) * 2)} .e{background:var(--bg, red)} .f{background:image-set("${D}" 1x)} .g{background:my-var(x) x-env(y) --attr(z)} .h::after{content:"image-set(var(--i))"}</style>\n`))
    const rv = run(subst, 'page.html')
    check('var(), env() and attr() outside the image functions are accepted', rv.status === 0, out(rv))

    // A url() the end of the text closes is read like a closed one, so a data: URI there passes.
    const eof = fixture('css-url-eof-data', page(`<div style="background:url(&quot;${D}&quot;">x</div>`,
      `<link rel="stylesheet" href="local.css">\n<style>.a{background:url(${D}</style>\n`), (d) => writeFileSync(join(d, 'local.css'), `.b{background:url('${D}' `))
    const re = run(eof, 'page.html')
    check('a data: URI in a url() the end of the text closes is accepted, unquoted, quoted and in the page\'s own stylesheet', re.status === 0, out(re))

    // ASCII whitespace around a data: URI is what the browser strips, so it is trimmed before the check.
    const padded = fixture('data-ascii-padding', page([
      `<video src="clip.webm" poster="\t ${D} \n"></video>`,
      `<img src="shot.png" srcset="\t ${D} 1x,\n ${D} 2x \f" alt="">`,
      `<div style="background:url( \t ${D} \n )">x</div>`,
    ].join('\n'), `<style>.a{background:url(\n\t"${D}"\n)} .b{background:image-set( "${D}" 1x )} .c{background:url( '${D}' )}</style>\n`))
    const rp = run(padded, 'page.html')
    check('a data: URI padded with ASCII whitespace in poster, srcset, a CSS url() or an image function is accepted', rp.status === 0, out(rp))

    // A named reference in text is not an attribute value, so pack leaves it to the browser.
    const text = fixture('entity-in-text', page('<p>a tab &Tab; a space &nbsp; an ellipsis &hellip; and a copy sign &copy; in text</p>'))
    const rt = run(text, 'page.html')
    check('a named character reference in text content is accepted', rt.status === 0, out(rt))

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

    // A write that fails part way: under a 1 KiB file-size limit the temp file's write stops with EFBIG after one block. pack
    // must exit 1 and say so, leave the old output as it was, and remove the temp file, whose identity it took at the exclusive
    // open and not after a write that never completed.
    const fails = fixture('write-fails', page('<p>x</p>')); writeFileSync(join(fails, 'page.packed.html'), SENTINEL)
    const snapF = listing(fails)
    const rf = spawnSync('bash', ['-c', 'ulimit -f 1 && exec "$0" "$@"', process.execPath, pack, 'page.html'], { cwd: fails, encoding: 'utf8' })
    check('a write cut short by a file-size limit exits 1 and names EFBIG', rf.status === 1 && /could not write page\.packed\.html: EFBIG/.test(rf.stdout + rf.stderr), out(rf))
    check('after the failed write the old output is untouched and no temp file remains', listing(fails) === snapF && readFileSync(join(fails, 'page.packed.html'), 'utf8') === SENTINEL, readdirSync(fails).join(' '))

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

    // The path the CLI opens. The plans CLI reads a src with Go's strings.TrimSpace, net/url's Parse on the value cut at "#",
    // and filepath's Clean, then counts uploads by that cleaned path, so pack must check, list and count that file and no other.
    // Each case writes `files` beside the page (a Buffer names a file whose name is not UTF-8); a positive case names in `lists`
    // the reference the media line must show, as the CLI trims it, and a refusal names its reason. JavaScript's trim() strips
    // U+FEFF and keeps U+0085, Go's does the reverse, and neither of url.Parse's refusals is JavaScript's, so each row pins one
    // rule of the CLI's.
    const NEL = cp(0x85), LSEP = cp(0x2028), ZWSP = cp(0x200b), RC = cp(0xfffd), E_ACUTE = cp(0xe9)
    const PATHS = [
      { name: 'nel-leading', src: `${NEL}public.png`, files: ['public.png', `${NEL}public.png`], lists: 'public.png' },
      { name: 'nel-leading-missing', src: `${NEL}nope.png`, files: [`${NEL}nope.png`], why: /src="\u0085nope\.png" is not in the page's folder/ },
      { name: 'bom-leading', src: `${BOM}public.png`, files: ['public.png', `${BOM}public.png`], lists: `${BOM}public.png` },
      { name: 'bom-leading-missing', src: `${BOM}nope.png`, files: ['nope.png'], why: new RegExp('src="' + BOM + 'nope[.]png" is not in the page.s folder') },
      { name: 'bom-sixty-five', body: Array.from({ length: 65 }, (_, i) => `<img src="${BOM.repeat(i + 1)}public.png" alt="">`).join('\n'),
        files: ['public.png', ...Array.from({ length: 65 }, (_, i) => `${BOM.repeat(i + 1)}public.png`)], why: /65 distinct local media files/ },
      { name: 'nbsp-leading', src: NBSP + 'public.png', files: ['public.png', NBSP + 'public.png'], lists: 'public.png' },
      { name: 'line-separator-leading', src: LSEP + 'public.png', files: ['public.png', LSEP + 'public.png'], lists: 'public.png' },
      { name: 'vertical-tab-leading', src: '\u000bpublic.png', files: ['public.png'], lists: 'public.png' },
      { name: 'zero-width-space-leading', src: ZWSP + 'public.png', files: ['public.png', ZWSP + 'public.png'], lists: ZWSP + 'public.png' },
      { name: 'nel-inside', src: `pub${NEL}lic.png`, files: ['public.png', `pub${NEL}lic.png`], lists: `pub${NEL}lic.png` },
      { name: 'nbsp-inside', src: 'pub' + NBSP + 'lic.png', files: ['pub' + NBSP + 'lic.png'], lists: 'pub' + NBSP + 'lic.png' },
      { name: 'trailing-space', src: 'public.png ', files: ['public.png', 'public.png '], lists: 'public.png' },
      { name: 'percent-space-leading', src: '%20public.png', files: ['public.png', ' public.png'], lists: '%20public.png' },
      { name: 'percent-space-trailing', src: 'public.png%20', files: ['public.png', 'public.png '], why: /src="public\.png%20" — "\.png " is not a media type/ },
      { name: 'percent-tab', src: '%09public.png', files: ['public.png', '\tpublic.png'], lists: '%09public.png' },
      { name: 'percent-newline', src: '%0Apublic.png', files: ['\npublic.png'], lists: '%0Apublic.png' },
      { name: 'percent-nel', src: '%C2%85public.png', files: ['public.png', `${NEL}public.png`], lists: '%C2%85public.png' },
      { name: 'percent-bom', src: '%EF%BB%BFpublic.png', files: ['public.png', `${BOM}public.png`], lists: '%EF%BB%BFpublic.png' },
      { name: 'tab-inside', src: 'pub\tlic.png', files: ['pub\tlic.png'], why: /src="pub\tlic\.png" holds a control character \(U\+0009\)/ },
      { name: 'tab-in-query', src: 'public.png?a\tb', files: ['public.png'], why: /holds a control character \(U\+0009\)/ },
      { name: 'tab-in-fragment', src: 'public.png#a\tb', files: ['public.png'], lists: 'public.png#a\tb' },
      { name: 'delete-inside', src: 'pub\u007flic.png', files: ['pub\u007flic.png'], why: /holds a control character \(U\+007F\)/ },
      { name: 'colon-first-segment', src: '1:public.png', files: ['1:public.png'], why: /src="1:public\.png" has ":" in its first segment/ },
      { name: 'colon-leading', src: ':public.png', files: [':public.png'], why: /has ":" in its first segment/ },
      { name: 'colon-later-segment', src: 'sub/a:b.png', files: ['sub/a:b.png'], lists: 'sub/a:b.png' },
      { name: 'colon-after-query', src: 'public.png?a:b', files: ['public.png'], lists: 'public.png?a:b' },
      { name: 'percent-short', src: 'public.png%4', files: ['public.png', 'public.png%4'], why: /src="public\.png%4" has a "%" that two hex digits do not follow/ },
      { name: 'percent-not-hex', src: 'pu%4Gblic.png', files: ['pu%4Gblic.png'], why: /has a "%" that two hex digits do not follow/ },
      { name: 'percent-invalid-utf8', src: '%FFpublic.png', files: [Buffer.concat([Buffer.from([0xff]), Buffer.from('public.png')]), RC + 'public.png'], why: /src="%FFpublic\.png" holds U\+FFFD/ },
      { name: 'replacement-char', src: RC + 'public.png', files: [RC + 'public.png'], why: /holds U\+FFFD/ },
      { name: 'percent-utf8', src: 'caf%C3%A9.png', files: ['caf' + E_ACUTE + '.png'], lists: 'caf%C3%A9.png' },
      { name: 'dot-segment', src: './public.png', files: ['public.png'], lists: './public.png' },
      { name: 'dotdot-inside', src: 'sub/../public.png', files: ['public.png'], lists: 'sub/../public.png' },
      { name: 'dotdot-percent', src: '%2e%2e/outside.png', files: [], why: /src="%2e%2e\/outside\.png" climbs out of the page's folder/ },
      { name: 'dotdot-through-missing', src: 'nowhere/../public.png', files: ['public.png'], lists: 'nowhere/../public.png' },
      { name: 'folder-itself', src: 'sub/..', files: [], why: /src="sub\/\.\." names the page's folder/ },
      { name: 'percent-slash', src: 'sub%2Fclip.mp4', files: ['sub/clip.mp4'], lists: 'sub%2Fclip.mp4' },
      { name: 'percent-absolute', src: '%2Fetc/passwd.png', files: [], why: /is an absolute path/ },
      { name: 'double-slash-inside', src: 'sub//clip.mp4', files: ['sub/clip.mp4'], lists: 'sub//clip.mp4' },
      { name: 'trailing-slash', src: 'sub/', files: [], why: /src="sub\/" — a name with no extension/ },
      { name: 'query-only', src: '?x', files: [], why: /src="\?x" names no file beside the page/ },
      { name: 'dot-only-name', src: '.png', files: ['.png'], lists: '.png' },
      { name: 'upper-extension', src: 'PUBLIC.PNG', files: ['PUBLIC.PNG'], lists: 'PUBLIC.PNG' },
      // Every symlink is refused, wherever it points: to an absolute path, to a folder, along a chain, beside its target, and the
      // two that leave the page's folder and come back, which realpath alone would pass and os.Root refuses.
      { name: 'symlink-absolute', src: 'abs.png', files: ['public.png'], setup: (d) => symlinkSync(join(d, 'public.png'), join(d, 'abs.png')), why: /src="abs\.png" goes through "abs\.png", a symlink/ },
      { name: 'symlink-absolute-folder', src: 'via/public.png', files: ['sub/public.png'], setup: (d) => symlinkSync(join(d, 'sub'), join(d, 'via')), why: /src="via\/public\.png" goes through "via", a symlink/ },
      { name: 'symlink-chain', src: 'l3.png', files: ['public.png'], setup: (d) => { for (let i = 1; i <= 3; i++) symlinkSync(i === 1 ? 'public.png' : `l${i - 1}.png`, join(d, `l${i}.png`)) }, why: /src="l3\.png" goes through "l3\.png", a symlink/ },
      { name: 'symlink-twin', body: '<img src="public.png" alt=""><img src="twin.png" alt="">', files: ['public.png'], setup: (d) => symlinkSync('public.png', join(d, 'twin.png')), why: /src="twin\.png" goes through "twin\.png", a symlink/ },
      { name: 'symlink-out-and-back-absolute', src: 'link.png', files: ['sub/public.png'], setup: (d) => { symlinkSync(join(d, 'sub'), join(d, 'via')); symlinkSync('via/public.png', join(d, 'link.png')) }, why: /src="link\.png" goes through "link\.png", a symlink/ },
      { name: 'symlink-out-and-back-dotdot', src: 'sub/link.png', files: ['public.png'], setup: (d) => symlinkSync(`../../${basename(d)}/public.png`, join(d, 'sub/link.png')), why: /src="sub\/link\.png" goes through "sub\/link\.png", a symlink/ },
      { name: 'two-paths-one-file', body: '<img src="public.png" alt=""><img src="./public.png" alt=""><img src="sub/../public.png" alt="">', files: ['public.png'], lists: 'public.png' },
    ]
    for (const c of PATHS) {
      const d = fixture(`path-${c.name}`, page(c.body ?? `<img src="${c.src}" alt="">`), (dd) => {
        for (const f of c.files) writeFileSync(Buffer.isBuffer(f) ? Buffer.concat([Buffer.from(dd + '/'), f]) : join(dd, f), 'the file')
        c.setup?.(dd)
      })
      writeFileSync(join(d, 'page.packed.html'), SENTINEL)
      const snap = listing(d); const rr = run(d, 'page.html'); const said = rr.stdout + rr.stderr
      if (c.why) {
        check(`path-${c.name}: refused with exit 1, for the right reason`, rr.status === 1 && c.why.test(said), out(rr))
        check(`path-${c.name}: nothing written, the existing output untouched`, listing(d) === snap && readFileSync(join(d, 'page.packed.html'), 'utf8') === SENTINEL)
      } else {
        const line = said.match(/\d+ local media files? stay beside the page for the plans CLI to upload: (.*)/)?.[1]
        check(`path-${c.name}: packed, listing the file the CLI uploads and no other`, rr.status === 0 && line === c.lists, `${out(rr)} | listed ${JSON.stringify(line)}, wanted ${JSON.stringify(c.lists)}`)
      }
    }

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
