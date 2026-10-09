// Theme tokens (patch 0003): the runtime owns only --plans-* custom properties, reads T3's theme
// variables without ever declaring one, and shares its token block byte for byte with
// skills/show/tokens.css. Mockup content keeps its authored palette.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const T3 = ['background', 'foreground', 'muted', 'muted-foreground', 'card', 'border', 'primary', 'primary-foreground',
  'accent', 'accent-surface', 'destructive', 'destructive-surface', 'warning', 'warning-surface', 'success', 'info']
const START = '/* plans-tokens:start */', END = '/* plans-tokens:end */'

const block = (text) => {
  const s = text.indexOf(START), e = text.indexOf(END)
  if (s < 0 || e < s || text.indexOf(START, s + 1) >= 0 || text.indexOf(END, e + 1) >= 0) return null
  return text.slice(s, e + END.length)
}

export default async function ({ ROOT, check }) {
  const runtime = join(ROOT, 'plugins/plans/skills/doc/runtime')
  const files = {
    'htmlplan.css': readFileSync(join(runtime, 'htmlplan.css'), 'utf8'),
    'htmlplan.js': readFileSync(join(runtime, 'htmlplan.js'), 'utf8'),
    'tokens.css': readFileSync(join(ROOT, 'plugins/plans/skills/show/tokens.css'), 'utf8'),
  }

  // Every custom property name is --plans-*, or a T3 name read as var(--name, fallback).
  for (const [name, text] of Object.entries(files)) {
    const stray = []
    for (const m of text.matchAll(/--[a-zA-Z][\w-]*/g)) {
      const id = m[0].slice(2)
      if (id.startsWith('plans-')) continue
      const read = T3.includes(id) && text.slice(m.index - 4, m.index) === 'var(' && text[m.index + m[0].length] === ','
      if (!read) stray.push(m[0])
    }
    check(`${name}: every custom property is --plans-* or a T3 name read with a fallback`, stray.length === 0, [...new Set(stray)].join(' '))
  }

  // No T3 name is declared, in CSS or from JavaScript.
  const t3 = T3.map((n) => n.replace(/-/g, '\\-')).join('|')
  const declares = new RegExp(`(?:^|[\\s;{"'\`])--(?:${t3})\\s*:|setProperty\\(\\s*['"\`]--(?:${t3})['"\`]`, 'm')
  for (const [name, text] of Object.entries(files)) check(`${name}: declares no T3 name`, !declares.test(text))

  // The token block is byte-identical in both files.
  const a = block(files['htmlplan.css']), b = block(files['tokens.css'])
  check('htmlplan.css holds one marked token block', !!a)
  check('tokens.css holds one marked token block', !!b)
  check('the two token blocks are byte-identical', !!a && a === b)

  // No --plans-* is read without a declaration: in CSS, in a JS style string, or by setProperty.
  const declared = (text) => new Set([
    ...[...text.matchAll(/(?:^|[\s;{"'`])(--plans-[\w-]+)\s*:/gm)].map((m) => m[1]),
    ...[...text.matchAll(/setProperty\(\s*['"`](--plans-[\w-]+)['"`]/g)].map((m) => m[1]),
  ])
  const used = (text) => new Set([...text.matchAll(/var\(\s*(--plans-[\w-]+)/g)].map((m) => m[1]))
  const runtimeDeclared = new Set([...declared(files['htmlplan.css']), ...declared(files['htmlplan.js'])])
  const runtimeUndeclared = [...used(files['htmlplan.css']), ...used(files['htmlplan.js'])].filter((n) => !runtimeDeclared.has(n))
  check('the runtime reads no undeclared --plans-* property', runtimeUndeclared.length === 0, [...new Set(runtimeUndeclared)].join(' '))
  const tokensDeclared = declared(files['tokens.css'])
  const tokensUndeclared = [...used(files['tokens.css'])].filter((n) => !tokensDeclared.has(n))
  check('tokens.css reads no --plans-* property it does not declare', tokensUndeclared.length === 0, tokensUndeclared.join(' '))
  for (const generated of ['--plans-d', '--plans-tr-depth', '--plans-top']) {
    check(`htmlplan.js generates ${generated} and htmlplan.css reads it`, declared(files['htmlplan.js']).has(generated) && used(files['htmlplan.css']).has(generated))
  }

  // Text on a solid accent follows the host's primary-foreground.
  check('no white text sits on a solid accent', !/background: var\(--plans-accent\); color: #fff/.test(files['htmlplan.css']))

  // Mockup content keeps its authored palette and upstream baseline, in the normal and zoom views.
  const mock = files['htmlplan.js'].match(/const MOCK_BASE = `([^`]*)`;/)?.[1]
  check('MOCK_BASE is still a literal stylesheet', !!mock && !mock.includes('var(') && mock.includes('.nw-root{font:14px/1.45') && mock.includes('color:#1b1a18'))
  check('both the normal and the zoom shadow roots load MOCK_BASE', (files['htmlplan.js'].match(/h\('style', null, MOCK_BASE\)/g) ?? []).length === 2)
  check('the mockup frame keeps its literal white interior', /\n\.mk-frame \{ background: #fff; color: #111;/.test(files['htmlplan.css']))
}
