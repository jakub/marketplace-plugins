#!/usr/bin/env node
// Smoke harness for hooks/scripts/protect-files.mjs. Deny cases are the rules; allow cases
// are the false positives that would make the guard something people route around.
// Run: node plugins/flow/scripts/smoke-protect-files.mjs
import { execFileSync } from 'node:child_process'
const G = 'plugins/flow/hooks/scripts/protect-files.mjs'
const run = (file_path) =>
  execFileSync('node', [G], { input: JSON.stringify({ tool_input: { file_path } }) })
    .toString()
    .trim().length > 0
// NotebookEdit is on the same hooks.json matcher but names its target differently.
const runNotebook = (notebook_path) =>
  execFileSync('node', [G], {
    input: JSON.stringify({ tool_name: 'NotebookEdit', tool_input: { notebook_path } }),
  })
    .toString()
    .trim().length > 0
let bad = 0
const expect = (want, file, name) => {
  const got = run(file)
  if (got !== want) bad++
  console.log(`  ${got === want ? 'ok' : 'FAIL'}: ${name} → ${got ? 'DENY' : 'allow'} (want ${want ? 'DENY' : 'allow'})`)
}
console.log('must DENY')
expect(true, '/home/x/p/.env', 'bare .env')
expect(true, '/home/x/p/.env.local', '.env.local')
expect(true, '/home/x/p/.env.production', '.env.production')
expect(true, '/home/x/p/Cargo.lock', 'Cargo.lock')
expect(true, '/home/x/p/package-lock.json', 'package-lock.json')
expect(true, '/home/x/p/uv.lock', 'uv.lock')
expect(true, '/home/x/p/flake.lock', 'flake.lock')
expect(true, '/home/x/p/go.sum', 'go.sum')
expect(true, '/home/x/p/target/debug/foo', 'target/')
expect(true, '/home/x/p/node_modules/left-pad/index.js', 'node_modules/')
expect(true, '/home/x/p/dist/bundle.js', 'dist/')
expect(true, '/home/x/p/.venv/lib/python3.13/site.py', '.venv/')
const expectNotebook = (want, file, name) => {
  const got = runNotebook(file)
  if (got !== want) bad++
  console.log(`  ${got === want ? 'ok' : 'FAIL'}: ${name} → ${got ? 'DENY' : 'allow'} (want ${want ? 'DENY' : 'allow'})`)
}
expectNotebook(true, '/home/x/p/node_modules/foo/a.ipynb', 'NotebookEdit into node_modules/')
console.log('must ALLOW')
expect(false, '/home/x/p/.env.example', '.env.example is a template')
expect(false, '/home/x/p/.env.sample', '.env.sample')
expect(false, '/home/x/p/.env.template', '.env.template')
expect(false, '/home/x/p/src/lib.rs', 'ordinary source')
expect(false, '/home/x/p/docs/environment.md', 'a doc about environments')
expect(false, '/home/x/p/Cargo.toml', 'the manifest, not the lockfile')
expect(false, '/home/x/p/src/target_selection.rs', 'a filename containing target')
expect(false, '/home/x/p/crates/build-info/src/lib.rs', 'a crate named build-info')
expect(false, '/home/x/p/README.md', 'readme')
expectNotebook(false, '/home/x/p/notebooks/analysis.ipynb', 'NotebookEdit on an ordinary notebook')
console.log(bad === 0 ? '\nprotect-files: ALL PASS' : `\nprotect-files: ${bad} FAILURE(S)`)
