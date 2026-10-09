// Fragment state (patch 0004): the pure codec htmlplan.js exports as HtmlPlan.fragment. The state
// round-trips through #pl1.<base64url(UTF-8 JSON)>~<percent-encoded anchor>, both bounds hold to the
// byte, and every malformed class restores nothing, keeps a valid anchor, and neither throws nor
// quotes the payload. The runtime loads here with no DOM, which also proves the codec sits above the
// HAS_DOM boundary. The runtime keeps nothing in localStorage and writes the URL in one place.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const b64url = (bytes) => Buffer.from(bytes).toString('base64url')
const json = (v) => b64url(Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8'))
const bytes = (s) => Buffer.byteLength(s, 'utf8')
const EMPTY = { answers: {}, comments: {}, drafts: {}, strikes: {}, seen: {} }

// Every persisted map, each holding text from several scripts.
const UNICODE = 'emoji 👩🏽‍💻 🇺🇦 · CJK 漢字かな한글 · RTL שלום مرحبا · astral 𝒜𝓈𝓉𝓇𝒶𝓁 𓀀 · combining é Z̤͔ͧ̑ · zero-width ‍‏'
const STATE = {
  answers: { limit: '500', note: `${UNICODE}\nsecond line\r\nthird`, picks: ['a', '漢字', '👍'], agree: true, retry: null, rank: ['𝒜', 'b'] },
  comments: { 'el:p:3': { label: '§1 › “שלום”', text: `${UNICODE}\n> quoted\n\nlast`, t: 1759999999999 }, 'code:x.ts:L4': { label: 'x.ts:L4', text: '漢', t: 2 } },
  drafts: { 'draft-0': `CREATE TABLE 表 (\n  id uuid -- ${UNICODE}\n);\n`, table: '' },
  strikes: { 'calls:c0:n2': { label: 'path › x() · 𝒜.ts:3', reason: '', t: 1, drops: ['a.ts', '𝒜.ts'] }, 'calls:c0:n3': { label: 'y', reason: 'מאוחר', t: 3 } },
  seen: { limit: 1, 'ask-日本': 1 },
}
const ANCHORS = [null, 'claim-1-2', 'a~b c%d', '§ 漢字 ~%25 👍', 'ask-n1']

export default async function ({ ROOT, check }) {
  const file = join(ROOT, 'plugins/plans/skills/doc/runtime/htmlplan.js')
  const source = readFileSync(file, 'utf8')

  check('the codec loads with no DOM', typeof document === 'undefined')
  createRequire(import.meta.url)(file)
  const F = globalThis.HtmlPlan?.fragment
  check('HtmlPlan.fragment exports VERSION, LIMITS, encode and decode',
    !!F && F.VERSION === 1 && isDeepStrictEqual(F.LIMITS, { fragment: 32768, json: 24576 }) && typeof F.encode === 'function' && typeof F.decode === 'function')
  if (!F) return

  // Round trip: every map, unicode throughout, with and without an anchor.
  for (const anchor of ANCHORS) {
    const { hash, oversize } = F.encode(STATE, anchor)
    check(`encode(state, ${JSON.stringify(anchor)}) writes an ASCII, URL-safe pl1 fragment`,
      oversize === null && /^#pl1\.[A-Za-z0-9_-]+(~[A-Za-z0-9\-_.!~*'()%]+)?$/.test(hash ?? ''), String(hash).slice(0, 80))
    check(`state and anchor ${JSON.stringify(anchor)} round-trip`, isDeepStrictEqual(F.decode(hash), { state: STATE, anchor, problem: null }))
    check(`re-encoding the restored state with ${JSON.stringify(anchor)} writes the same fragment`, F.encode(F.decode(hash).state, anchor).hash === hash)
  }
  check('decode reads a fragment with or without its #', isDeepStrictEqual(F.decode(F.encode(STATE, 'x').hash.slice(1)), F.decode(F.encode(STATE, 'x').hash)))
  const one = { ...EMPTY, drafts: { d: '𓀀' } }
  check('missing maps decode as empty maps', isDeepStrictEqual(F.decode(F.encode(one, null).hash).state, one))

  // No state: the fragment is the bare anchor, or nothing.
  check('no state and no anchor encode to the empty fragment', F.encode(null, null).hash === '' && F.encode(EMPTY, null).hash === '' && F.encode({}, '').hash === '')
  check('empty maps with an anchor encode to the bare, percent-encoded anchor', F.encode(EMPTY, 'a b~%').hash === '#a%20b~%25')
  check('the empty fragment decodes to nothing', ['', '#', undefined].every((h) => isDeepStrictEqual(F.decode(h), { state: null, anchor: null, problem: null })))
  check('a bare #id decodes to its anchor only', isDeepStrictEqual(F.decode('#s3'), { state: null, anchor: 's3', problem: null }))
  check('a bare #id is percent-decoded', F.decode('#caf%C3%A9').anchor === 'café' && F.decode(F.encode(EMPTY, 'a b~%').hash).anchor === 'a b~%')

  // Bounds, to the byte. JSON of n bytes: {"drafts":{"d":"xxx…"}} carries 19 bytes around n - 19 x's.
  const sized = (n) => ({ drafts: { d: 'x'.repeat(n - 19) } })
  check('the sizing fixture is exact', bytes(JSON.stringify(sized(24576))) === 24576)
  const atJson = F.encode(sized(24576), null), overJson = F.encode(sized(24577), null)
  check('JSON of exactly 24 KiB passes the JSON bound', atJson.oversize !== 'json', atJson.oversize)
  check('JSON one byte over 24 KiB is refused, with no fragment', overJson.oversize === 'json' && overJson.hash === null)
  // 24570 bytes of JSON is 32760 base64url characters; '#pl1.' and '~ab' make the fragment 32768 bytes.
  const atFrag = F.encode(sized(24570), 'ab'), overFrag = F.encode(sized(24570), 'abc')
  check('a fragment of exactly 32 KiB is written', atFrag.oversize === null && bytes(atFrag.hash) === 32768, atFrag.oversize ?? bytes(atFrag.hash))
  check('a fragment one byte over 32 KiB is refused, with no fragment', overFrag.oversize === 'fragment' && overFrag.hash === null)
  check('a 32 KiB fragment decodes', isDeepStrictEqual(F.decode(atFrag.hash), { state: { ...EMPTY, ...sized(24570) }, anchor: 'ab', problem: null }))
  const tooBig = F.decode(atFrag.hash + 'c')
  check('a fragment one byte over 32 KiB restores nothing and keeps its anchor', tooBig.state === null && tooBig.anchor === 'abc' && !!tooBig.problem)
  const wide = '#pl1.' + json({ drafts: { d: 'x' } }) + '~' + 'é'.repeat(16380)
  check('the fragment bound counts UTF-8 bytes, not characters', wide.length <= 32768 && bytes(wide) > 32768 && F.decode(wide).state === null)
  // The bound covers the whole fragment before decode or encode tells a payload from a plain anchor.
  const TOO_LARGE = { state: null, anchor: null, problem: 'too large' }
  const atBare = F.encode(EMPTY, 'x'.repeat(32767)), overBare = F.encode(EMPTY, 'x'.repeat(32768))
  check('a bare anchor fragment of exactly 32 KiB is written', atBare.oversize === null && bytes(atBare.hash ?? '') === 32768, atBare.oversize ?? bytes(atBare.hash ?? ''))
  check('a bare anchor fragment one byte over 32 KiB is refused, with no fragment', overBare.oversize === 'fragment' && overBare.hash === null, JSON.stringify(overBare).slice(0, 80))
  const wideBare = F.encode(null, 'é'.repeat(5462))   // each é is %C3%A9, six bytes: 32773 with the '#'
  check('a bare anchor is bounded by its percent-encoded UTF-8 bytes', wideBare.oversize === 'fragment' && wideBare.hash === null, JSON.stringify(wideBare).slice(0, 80))
  check('a bare #id of exactly 32 KiB decodes to its anchor', isDeepStrictEqual(F.decode('#' + 'x'.repeat(32767)), { state: null, anchor: 'x'.repeat(32767), problem: null }))
  for (const [name, frag] of [['a bare #id one byte over 32 KiB', '#' + 'x'.repeat(32768)], ['a 40,000-character bare #id', '#' + 'x'.repeat(40000)],
    ['a bare #id over 32 KiB in UTF-8 bytes', '#' + 'é'.repeat(16384)], ['a percent-encoded bare #id over 32 KiB', '#' + '%C3%A9'.repeat(5462)],
    ['a payload whose anchor alone is over 32 KiB', `#pl1.${json({ seen: { a: 1 } })}~${'x'.repeat(40000)}`]]) {
    const r = F.decode(frag)
    check(`${name} restores nothing, names no anchor and is too large`, isDeepStrictEqual(r, TOO_LARGE), JSON.stringify(r).slice(0, 120))
  }

  // Malformed payloads: nothing restored, nothing thrown, the anchor kept, the payload never quoted.
  const valid = json({ seen: { a: 1 } })
  const MALFORMED = [
    ['unknown version', `pl2.${valid}`], ['unknown version', `pl01.${valid}`], ['unknown version', `pl10.${valid}`],
    ['bad alphabet +', 'pl1.eyJz+WVuIjp7fX0'], ['bad alphabet /', 'pl1.eyJz/WVuIjp7fX0'], ['padding =', `pl1.${json('{"seen":{}}')}=`],
    ['bad alphabet .', `pl1.${valid}.x`], ['bad alphabet space', 'pl1.eyJz ZWVuIjp7fX0'], ['bad alphabet %', 'pl1.eyJz%41ZWVuIjp7fX0'],
    ['impossible length', `pl1.${'A'.repeat(5)}`], ['impossible length', `pl1.${valid.slice(0, 13)}`],
    ['invalid UTF-8', `pl1.${b64url([0xff, 0xfe, 0x7b, 0x7d])}`], ['invalid UTF-8', `pl1.${b64url([0xc3, 0x28])}`],
    ['overlong UTF-8', `pl1.${b64url([0xc0, 0xaf])}`], ['UTF-8 surrogate', `pl1.${b64url([0xed, 0xa0, 0x80])}`],
    ['empty payload', 'pl1.'], ['invalid JSON', `pl1.${json('{')}`], ['invalid JSON', `pl1.${json("{'seen':{}}")}`], ['invalid JSON', `pl1.${json('{"seen":{}} x')}`],
    ['scalar root', `pl1.${json('1')}`], ['string root', `pl1.${json('"seen"')}`], ['boolean root', `pl1.${json('true')}`],
    ['array root', `pl1.${json('[]')}`], ['null root', `pl1.${json('null')}`],
    ['unknown map', `pl1.${json({ seen: {}, extra: {} })}`], ['null map', `pl1.${json({ answers: null })}`],
    ['array map', `pl1.${json({ answers: [] })}`], ['scalar map', `pl1.${json({ drafts: 'x' })}`],
    ['answer of wrong type', `pl1.${json({ answers: { a: 1 } })}`], ['answer list of wrong type', `pl1.${json({ answers: { a: ['x', 2] } })}`],
    ['comment as text', `pl1.${json({ comments: { k: 'text' } })}`], ['comment without t', `pl1.${json({ comments: { k: { label: 'l', text: 't' } } })}`],
    ['comment with an extra key', `pl1.${json({ comments: { k: { label: 'l', text: 't', t: 1, x: 1 } } })}`],
    ['draft as number', `pl1.${json({ drafts: { d: 1 } })}`], ['strike drops of wrong type', `pl1.${json({ strikes: { k: { label: 'l', reason: '', t: 1, drops: [1] } } })}`],
    ['seen as true', `pl1.${json({ seen: { a: true } })}`], ['seen as list', `pl1.${json({ seen: ['a'] })}`],
    ['__proto__ at the root', `pl1.${json('{"__proto__":{"polluted":1}}')}`],
    ['__proto__ as a map key', `pl1.${json('{"comments":{"__proto__":{"label":"l","text":"t","t":1}}}')}`],
    ['__proto__ in an entry', `pl1.${json('{"comments":{"k":{"label":"l","text":"t","t":1,"__proto__":{"polluted":1}}}}')}`],
    ['__proto__ as an answer name', `pl1.${json('{"answers":{"__proto__":"x"}}')}`],
  ]
  for (const [name, frag] of MALFORMED) {
    const body = frag.slice(frag.indexOf('.') + 1)
    for (const anchor of [null, 'keep me~%']) {
      const hash = '#' + frag + (anchor ? '~' + encodeURIComponent(anchor) : '')
      let r, threw = null
      try { r = F.decode(hash) } catch (e) { threw = e }
      const said = JSON.stringify(r ?? {})
      check(`${name}${anchor ? ', with an anchor,' : ''} restores nothing and keeps ${anchor ? 'the' : 'no'} anchor`,
        !threw && r.state === null && r.anchor === anchor && typeof r.problem === 'string' && r.problem.length > 0,
        threw ? String(threw) : said.slice(0, 160))
      check(`${name}${anchor ? ', with an anchor,' : ''} is reported without quoting the payload`,
        !threw && /^[A-Za-z0-9 -]{1,40}$/.test(r.problem ?? '') && (body.length < 4 || !said.includes(body)), said.slice(0, 160))
    }
  }
  check('decoding a __proto__ payload pollutes no prototype', ({}).polluted === undefined && Object.prototype.polluted === undefined)

  // A wrong prefix is not a payload. It stays a plain #id, so nothing is restored and nothing is reported.
  for (const prefix of ['PL1.', 'pl.', 'p1.', 'pl1', 'xpl1.', 'pl1-']) {
    const r = F.decode(`#${prefix}${valid}`)
    check(`a fragment opening "${prefix}" is a plain anchor, not a payload`, r.state === null && r.problem === null && r.anchor === prefix + valid)
  }
  check('decode never throws on a non-string', [undefined, null, 42, {}, [], () => 1].every((h) => { try { return isDeepStrictEqual(F.decode(h), { state: null, anchor: null, problem: null }) } catch { return false } }))
  check('a malformed anchor after a valid payload is dropped and the state kept', (() => { const r = F.decode('#pl1.' + valid + '~%E0%A4%A'); return r.anchor === null && isDeepStrictEqual(r.state?.seen, { a: 1 }) })())

  // The runtime keeps nothing in storage and writes the URL in one place.
  check('the shipped runtime does not use localStorage', !source.includes('localStorage'))
  check('the runtime writes the URL only through one history.replaceState',
    (source.match(/history\.replaceState\(/g) ?? []).length === 1 && !/pushState|location\.(hash|href)\s*=[^=]|location\.(assign|replace)\(/.test(source))
}
