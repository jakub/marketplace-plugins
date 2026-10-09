// The runtime's small pure views, run in node with no DOM. The changes label (patch 0007): HtmlPlan.changesView takes the
// doc-changes attributes as getAttribute returns them, so an absent label reads "Proposed", an empty one draws none, any other
// value stays plain text, and zero counts hide the element.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const RUNTIME = 'plugins/plans/skills/doc/runtime'

export default async function ({ ROOT, check }) {
  const file = join(ROOT, RUNTIME, 'htmlplan.js')
  const source = readFileSync(file, 'utf8')
  createRequire(import.meta.url)(file)
  const NW = globalThis.HtmlPlan

  // The changes label.
  const view = NW?.changesView
  check('HtmlPlan.changesView is exported above the DOM boundary', typeof view === 'function')
  if (typeof view === 'function') {
    const counts = { new: '5', changed: '4', deleted: '1' }
    const parts = [['add', 5, '+', 'new'], ['mod', 4, '~', 'changed'], ['del', 1, '−', 'deleted']]
    check('an absent label reads "Proposed"', isDeepStrictEqual(view({ ...counts, label: null }), { hidden: false, label: 'Proposed', total: 10, parts }))
    check('a missing label key also reads "Proposed"', view(counts).label === 'Proposed')
    check('a custom label is kept as written', view({ ...counts, label: 'Landed' }).label === 'Landed')
    check('an empty label draws no label', view({ ...counts, label: '' }).label === '' && !view({ ...counts, label: '' }).hidden)
    const markup = '<img src=x onerror=alert(1)>&amp;'
    check('a label that looks like markup stays the same text', view({ ...counts, label: markup }).label === markup)
    check('zero counts are left out', isDeepStrictEqual(view({ new: '2', changed: '0', deleted: null, label: null }).parts, [['add', 2, '+', 'new']]))
    for (const [name, attrs] of [['no counts', {}], ['all zero', { new: '0', changed: '0', deleted: '0' }], ['negative and junk', { new: '-3', changed: 'x', deleted: '' }]]) {
      const v = view({ ...attrs, label: 'Landed' })
      check(`${name}: the element is hidden`, v.hidden === true && v.total === 0 && v.parts.length === 0)
    }
  }
  const define = source.match(/define\('doc-changes', \(el\) => \{\n([\s\S]*?)\n\}\);/)?.[1] ?? ''
  check('doc-changes reads the label with getAttribute and draws it with h(), never as HTML',
    /label: el\.getAttribute\('label'\)/.test(define) && /h\('span', \{ class: 'ch-tag' \}, v\.label\)/.test(define) && !/html:|innerHTML/.test(define), define)
}
