// The browser check's half for the page shell: the `chrome` state and the question counts. run.mjs
// calls it, and its header defines `drive` and the rules every function here keeps. Node built-ins
// only, and no import of run.mjs, which imports this file.
//
//   chrome(drive)          the `chrome` state on a Document whose bytes hold body[data-base-shell]:
//                          the theme switch, every zoom, the dock and the sections sheet. Returns
//                          { faults, steps }.
//   counts(drive, model)   during the kit's `interaction` state on the same pages, after the
//                          initial response and after each step that moves a question between
//                          open, changed and kept. model is a copy of the interaction's own record,
//                          { title, build, questions: [{ id, legend, type, kept, options: [{ value,
//                          label, defaultChecked, checked }] }], notes: [{ name, text }] }. Returns
//                          one check row { name: 'interaction: base counts', result, detail }, or
//                          null for no row.
//
// Stubs until the shell seat fills them in.

export async function chrome(drive) {
  return { faults: [], steps: [] }
}

export async function counts(drive, model) {
  return null
}
