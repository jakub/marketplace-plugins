// Theme tokens: skills/show/tokens.css owns only --plans-* custom properties, reads T3's theme
// variables without ever declaring one, and reads no --plans-* property it does not declare.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const T3 = ['background', 'foreground', 'muted', 'muted-foreground', 'card', 'border', 'primary', 'primary-foreground',
  'accent', 'accent-surface', 'destructive', 'destructive-surface', 'warning', 'warning-surface', 'success', 'info']

export default async function ({ ROOT, check }) {
  const name = 'tokens.css'
  const text = readFileSync(join(ROOT, 'plugins/plans/skills/show/tokens.css'), 'utf8')

  // Every custom property name is --plans-*, or a T3 name read as var(--name, fallback).
  const stray = []
  for (const m of text.matchAll(/--[a-zA-Z][\w-]*/g)) {
    const id = m[0].slice(2)
    if (id.startsWith('plans-')) continue
    const read = T3.includes(id) && text.slice(m.index - 4, m.index) === 'var(' && text[m.index + m[0].length] === ','
    if (!read) stray.push(m[0])
  }
  check(`${name}: every custom property is --plans-* or a T3 name read with a fallback`, stray.length === 0, [...new Set(stray)].join(' '))

  // No T3 name is declared.
  const t3 = T3.map((n) => n.replace(/-/g, '\\-')).join('|')
  const declares = new RegExp(`(?:^|[\\s;{"'\`])--(?:${t3})\\s*:`, 'm')
  check(`${name}: declares no T3 name`, !declares.test(text))

  // No --plans-* is read without a declaration.
  const declared = new Set([...text.matchAll(/(?:^|[\s;{"'`])(--plans-[\w-]+)\s*:/gm)].map((m) => m[1]))
  const undeclared = [...new Set([...text.matchAll(/var\(\s*(--plans-[\w-]+)/g)].map((m) => m[1]))].filter((n) => !declared.has(n))
  check(`${name} reads no --plans-* property it does not declare`, undeclared.length === 0, undeclared.join(' '))
}
