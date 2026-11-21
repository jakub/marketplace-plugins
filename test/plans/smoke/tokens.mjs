// Theme tokens. skills/show/tokens.css is the one palette: it owns only --plans-* custom
// properties, maps each token to the T3 theme variable the issue #40 token contract names, reads
// that variable with a --plans-fb-* fallback, and never declares a T3 name. The kit CSS under
// skills/doc/kit/ declares and reads only the --plans-* names the contract lets it read. The
// fallback colors meet contrast on their ground. Each rule is a function that returns its
// offenders, so the negative controls at the end run the same rule on a mutated in-memory copy.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const T3 = ['background', 'foreground', 'muted', 'muted-foreground', 'card', 'border', 'primary', 'primary-foreground',
  'accent', 'accent-surface', 'destructive', 'destructive-surface', 'warning', 'warning-surface', 'success', 'info',
  'code-background', 'ring', 'radius', 'font-sans', 'font-mono', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6']

// The token contract: each non-fallback token and the T3 variable it reads. Accent text reads
// --warning like the accent, so it follows a T3 theme; its contrast is checked on the fallbacks.
const CONTRACT = {
  panel: 'card', code: 'code-background', ink: 'foreground', 'ink-2': 'muted-foreground', rule: 'border', hair: 'border',
  accent: 'warning', 'accent-text': 'warning', 'accent-surface': 'warning-surface', focus: 'ring', radius: 'radius',
  sans: 'font-sans', mono: 'font-mono',
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`chart-${n}`, `chart-${n}`])),
}
// The only names kit CSS may read: the contract's tokens, plus the ground that look.css paints.
const KIT_READS = new Set([...Object.keys(CONTRACT).map((n) => `--plans-${n}`), '--plans-fb-ground'])

// Contrast floors, per scheme: [fallback, floor] pairs measured on the ground, and text also on
// the panel. Marks are non-text (WCAG 1.4.11), text is WCAG 1.4.3 AA.
const MARKS = ['accent', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6']
const TEXT = ['ink', 'ink-2', 'accent-text']

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const decls = (css) => [...stripComments(css).matchAll(/(?:^|[\s;{])(--[\w-]+)\s*:\s*([^;}]*)/g)].map((m) => ({ name: m[1], value: m[2].trim() }))
const reads = (css) => [...stripComments(css).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1])

// Split tokens.css into the light :root body and the dark @media body.
function schemes(css) {
  const text = stripComments(css)
  const at = text.search(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/)
  if (at === -1) return { light: text, dark: '' }
  let depth = 0, end = -1
  for (let i = text.indexOf('{', at); i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) { end = i; break }
  }
  return { light: text.slice(0, at) + (end === -1 ? '' : text.slice(end + 1)), dark: text.slice(at, end === -1 ? undefined : end + 1) }
}

// --- rules on tokens.css

// Every custom property name is --plans-*, or a T3 name read as var(--name, fallback).
function strayNames(css) {
  const text = stripComments(css), out = []
  for (const m of text.matchAll(/--[a-zA-Z][\w-]*/g)) {
    const id = m[0].slice(2)
    if (id.startsWith('plans-')) continue
    const read = T3.includes(id) && /var\(\s*$/.test(text.slice(0, m.index)) && /^\s*,/.test(text.slice(m.index + m[0].length))
    if (!read) out.push(m[0])
  }
  return [...new Set(out)]
}

// Declared custom properties that are not --plans-*: a T3 name, or anything else.
const foreignDeclarations = (css) => decls(css).map((d) => d.name).filter((n) => !n.startsWith('--plans-'))

// --plans-* names read but never declared.
function undeclaredReads(css) {
  const declared = new Set(decls(css).map((d) => d.name))
  return [...new Set(reads(css).filter((n) => n.startsWith('--plans-') && !declared.has(n)))]
}

// Each contract token is declared once in the light block and reads exactly its T3 source, with a
// --plans-fb-* fallback, and no other T3 variable.
function contractFaults(css) {
  const { light } = schemes(css), out = []
  const tokens = decls(light).filter((d) => d.name.startsWith('--plans-') && !d.name.startsWith('--plans-fb-'))
  for (const { name, value } of tokens) {
    const key = name.slice('--plans-'.length)
    if (!(key in CONTRACT)) { out.push(`${name} is not in the token contract`); continue }
    const src = CONTRACT[key]
    const t3Read = reads(value).filter((n) => !n.startsWith('--plans-'))
    if (!new RegExp(`var\\(\\s*--${src}\\s*,\\s*var\\(\\s*--plans-fb-[\\w-]+\\s*\\)\\s*\\)`).test(value)) out.push(`${name} does not read var(--${src}, var(--plans-fb-*)): ${value}`)
    if (t3Read.some((n) => n !== `--${src}`)) out.push(`${name} reads another T3 variable: ${t3Read.join(' ')}`)
  }
  const seen = tokens.map((d) => d.name)
  for (const key of Object.keys(CONTRACT)) {
    const n = seen.filter((s) => s === `--plans-${key}`).length
    if (n !== 1) out.push(`--plans-${key} is declared ${n} times`)
  }
  return out
}

// The dark block switches fallbacks only, and only ones the light block declares.
function darkFaults(css) {
  const { light, dark } = schemes(css)
  if (!dark) return ['no @media (prefers-color-scheme: dark) block']
  const lightNames = new Set(decls(light).map((d) => d.name))
  return decls(dark).map((d) => d.name).filter((n) => !n.startsWith('--plans-fb-') || !lightNames.has(n))
}

// --primary is never the accent, so nothing names it at all.
const primaryMentions = (css) => [...stripComments(css).matchAll(/--primary(?![\w-])/g)].map((m) => m[0])

// The retired runtime's equality header and theme overrides.
const headerLeftovers = (css) => [...css.matchAll(/plans-tokens:|byte[- ]identical|byte for byte|htmlplan|data-theme/gi)].map((m) => m[0])

// --- rules on kit CSS

// Kit CSS declares only --plans-* names that tokens.css declares, and reads only KIT_READS.
function kitFaults(css, declared) {
  const out = []
  for (const { name } of decls(css)) if (!name.startsWith('--plans-') || !declared.has(name)) out.push(`declares ${name}`)
  for (const name of reads(css)) if (!KIT_READS.has(name) || !declared.has(name)) out.push(`reads ${name}`)
  // A custom property named outside a declaration or a var() read is a stray.
  const text = stripComments(css).replace(/var\(\s*--[\w-]+/g, '').replace(/(^|[\s;{])--[\w-]+\s*:/g, '$1')
  for (const m of text.matchAll(/--[a-zA-Z][\w-]*/g)) out.push(`names ${m[0]}`)
  return [...new Set(out)]
}

// --- contrast

function luminance(hex) {
  let h = hex.slice(1)
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }

function contrastFaults(css) {
  const { light, dark } = schemes(css), out = []
  const lightFb = Object.fromEntries(decls(light).filter((d) => d.name.startsWith('--plans-fb-')).map((d) => [d.name.slice(11), d.value]))
  const darkFb = { ...lightFb, ...Object.fromEntries(decls(dark).filter((d) => d.name.startsWith('--plans-fb-')).map((d) => [d.name.slice(11), d.value])) }
  for (const [scheme, fb] of [['light', lightFb], ['dark', darkFb]]) {
    // A token's fallback, resolved through its var(--plans-fb-*) reference.
    const color = (key) => {
      const ref = CONTRACT[key] === undefined ? key : (decls(light).find((d) => d.name === `--plans-${key}`)?.value.match(/--plans-fb-([\w-]+)/)?.[1] ?? key)
      const v = fb[ref]
      return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v ?? '') ? v : null
    }
    const ground = color('ground'), panel = color('panel')
    if (!ground || !panel) { out.push(`${scheme}: ground or panel fallback is not a hex color`); continue }
    const pairs = [...MARKS.map((k) => [k, ground, 'ground', 3]), ...TEXT.flatMap((k) => [[k, ground, 'ground', 4.5], [k, panel, 'panel', 4.5]])]
    for (const [key, bg, bgName, floor] of pairs) {
      const fg = color(key)
      if (!fg) { out.push(`${scheme}: --plans-${key} has no hex fallback`); continue }
      const r = ratio(fg, bg)
      if (r < floor) out.push(`${scheme}: --plans-${key} ${fg} on ${bgName} ${bg} is ${r.toFixed(2)}:1, under ${floor}:1`)
    }
  }
  return out
}

export default async function ({ ROOT, check }) {
  const name = 'tokens.css'
  const text = readFileSync(join(ROOT, 'plugins/plans/skills/show/tokens.css'), 'utf8')
  const kitDir = join(ROOT, 'plugins/plans/skills/doc/kit')
  const kit = readdirSync(kitDir).filter((f) => f.endsWith('.css')).sort().map((f) => [f, readFileSync(join(kitDir, f), 'utf8')])
  const declared = new Set(decls(text).map((d) => d.name))
  const show = (list) => list.join('; ')

  const tokenRules = [
    ['every custom property is --plans-* or a T3 name read with a fallback', strayNames],
    ['declares no T3 name, nor any name outside --plans-*', foreignDeclarations],
    ['reads no --plans-* property it does not declare', undeclaredReads],
    ['each contract token reads its T3 variable with a --plans-fb-* fallback', contractFaults],
    ['the dark scheme switches only --plans-fb-* fallbacks', darkFaults],
    ['never names --primary', primaryMentions],
    ['keeps no equality header or [data-theme] override', headerLeftovers],
    ['mark accents reach 3:1 and text accents 4.5:1 on their ground', contrastFaults],
  ]
  for (const [rule, fn] of tokenRules) { const bad = fn(text); check(`${name}: ${rule}`, bad.length === 0, show(bad)) }

  check('kit: look.css and marks.css are present', ['look.css', 'marks.css'].every((f) => kit.some(([k]) => k === f)), kit.map(([k]) => k).join(' '))
  for (const [file, css] of kit) {
    const bad = [...kitFaults(css, declared), ...primaryMentions(css).map((m) => `names ${m}`)]
    check(`kit/${file}: declares and reads only the --plans-* names tokens.css lets it`, bad.length === 0, show(bad))
  }

  // Negative controls: each mutation must trip its rule.
  const mutate = (from, to) => { if (!text.includes(from)) throw new Error(`negative control anchor missing: ${from}`); return text.replace(from, to) }
  const negatives = [
    ['a T3 read with no fallback', contractFaults, mutate('var(--card, var(--plans-fb-panel))', 'var(--card)')],
    ['a T3 read with no fallback (stray name)', strayNames, mutate('var(--card, var(--plans-fb-panel))', 'var(--card)')],
    ['a declared T3 name', foreignDeclarations, mutate(':root {', ':root {\n  --background: #fff;')],
    ['the accent read from --primary', primaryMentions, mutate('var(--warning, var(--plans-fb-accent))', 'var(--primary, var(--plans-fb-accent))')],
    ['accent text reading only its fallback', contractFaults, mutate('var(--warning, var(--plans-fb-accent-text))', 'var(--plans-fb-accent-text)')],
    ['a token reading the wrong T3 variable', contractFaults, mutate('var(--ring, var(--plans-fb-ink))', 'var(--accent, var(--plans-fb-ink))')],
    ['a token outside the contract', contractFaults, mutate('--plans-panel:', '--plans-bg: var(--background, var(--plans-fb-ground));\n  --plans-panel:')],
    ['an undeclared --plans-* read', undeclaredReads, mutate('var(--plans-fb-panel))', 'var(--plans-fb-sunk))')],
    ['a non-fallback token switched in the dark block', darkFaults, mutate('--plans-fb-ground: #0f1113;', '--plans-fb-ground: #0f1113;\n    --plans-ink: #fff;')],
    ['a light mark accent under 3:1', contrastFaults, mutate('--plans-fb-accent: #f25500;', '--plans-fb-accent: #ffb07a;')],
    ['a dark text accent under 4.5:1', contrastFaults, mutate('--plans-fb-accent-text: #ff8a4c;', '--plans-fb-accent-text: #b83a00;')],
    ['the equality header', headerLeftovers, `/* byte-identical to the runtime block */\n${text}`],
  ]
  for (const [what, fn, copy] of negatives) check(`negative: ${what} is caught`, fn(copy).length > 0)
  const look = kit.find(([f]) => f === 'look.css')?.[1] ?? ''
  const kitNegatives = [
    ['kit reading a T3 name', `${look}\n.x { color: var(--foreground); }`],
    ['kit reading a --plans-* name tokens.css lacks', `${look}\n.x { color: var(--plans-bg); }`],
    ['kit reading a fallback other than the ground', `${look}\n.x { color: var(--plans-fb-ink); }`],
    ['kit declaring its own name', `${look}\n.x { --plans-gap: 1rem; }`],
    ['kit declaring a T3 name', `${look}\n.x { --radius: 0; }`],
  ]
  for (const [what, copy] of kitNegatives) check(`negative: ${what} is caught`, kitFaults(copy, declared).length > 0)
}
