// The browser check's half for the base parts: the parts model, the `panes` state's walk and the
// chart oracle. run.mjs calls it, and its header defines `drive` and the rules every function here
// keeps. Node built-ins only, and no import of run.mjs, which imports this file.
//
// In-page functions are serialized with toString and run in the check's isolated world, so each
// is a function declaration or an arrow function that uses only its own arguments, the page's DOM
// and globalThis.plansCheck = { source, model }, which run.mjs sets once per page load: the built
// bytes as a string and model below.
//
//   model(source)            in-page. Parses the built bytes with DOMParser and returns
//     { switches: [{ i, keys: [{ name, values, initial }], panes: [i], charts: [i] }],
//       panes: [{ i, box, terms: [[key, value]] }], compares: [{ i }],
//       charts: [{ i, kind, caption, unit, stack, min, max, from, to, box, rows: [{ status, values }],
//                  items: [{ lane, start, end }] }],
//       errors: [detail] }
//     i is the document-order index among [data-base-switch], [data-base-when], figure.pb-compare
//     or [data-base-chart], and times are UTC milliseconds.
//   panes(drive)             the `panes` state: every switch combination and both sides of every
//                            compare. Returns { faults, steps }.
//   chartFaults(source)      in-page, after every probe in every state of a page whose bytes hold
//                            a chart. Returns an array of faults { kind, detail }, and may add
//                            check rows { name, result, detail } named `chart: …`, told apart by
//                            `name`.
//   reveal(drive, paneIndex) shows the pane with that model index through real input. Returns
//                            whether it is shown.
//
// Stubs until the parts seat fills them in.

export function model(source) {
  return { switches: [], panes: [], compares: [], charts: [], errors: [] }
}

export async function panes(drive) {
  return { faults: [], steps: [] }
}

export function chartFaults(source) {
  return []
}

export async function reveal(drive, paneIndex) {
  return false
}
