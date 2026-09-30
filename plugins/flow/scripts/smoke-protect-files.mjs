#!/usr/bin/env node
// Smoke harness for both protected-file adapters over lib/hook-policy.mjs: protect-files.mjs
// (Claude: file_path on Edit and Write, notebook_path on NotebookEdit) and protect-files-codex.mjs
// (Codex: the apply_patch envelope in tool_input.command, plus a file_path alias). Every path
// runs through each route. Deny cases are the rules; allow cases are the false positives that
// would make the guard something people route around.
// Run: node plugins/flow/scripts/smoke-protect-files.mjs
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'scripts')
const hook = (name, input) => {
  const out = execFileSync(process.execPath, [join(HOOKS, name)], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8',
  }).trim()
  return out ? JSON.parse(out).hookSpecificOutput : null
}
const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')

let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` → ${detail}`}`)
}
const denied = (out) => out?.permissionDecision === 'deny'

const ROUTES = [
  ['claude Edit', (file) => hook('protect-files.mjs', { tool_name: 'Edit', tool_input: { file_path: file } })],
  ['codex apply_patch', (file) => hook('protect-files-codex.mjs', { tool_name: 'apply_patch', tool_input: { command: patch(`*** Update File: ${file}`, '@@', '-a', '+b') } })],
  ['codex file_path', (file) => hook('protect-files-codex.mjs', { tool_name: 'Write', tool_input: { file_path: file } })],
]
const expect = (want, file, name) => {
  for (const [route, run] of ROUTES) {
    const out = run(file)
    check(`${name} (${route}) → ${want ? 'DENY' : 'allow'}`, denied(out) === want, JSON.stringify(out))
  }
}

console.log('must DENY on every route')
expect(true, '/home/x/p/.env', 'bare .env')
expect(true, '/home/x/p/.env.local', '.env.local')
expect(true, '/home/x/p/.env.production', '.env.production')
expect(true, '/home/x/p/.flow/managed', 'the merge-guardrail marker')
expect(true, '.flow/managed', 'the marker by relative path')
expect(true, '/home/x/p/Cargo.lock', 'Cargo.lock')
expect(true, '/home/x/p/package-lock.json', 'package-lock.json')
expect(true, '/home/x/p/uv.lock', 'uv.lock')
expect(true, '/home/x/p/flake.lock', 'flake.lock')
expect(true, '/home/x/p/go.sum', 'go.sum')
expect(true, '/home/x/p/target/debug/foo', 'target/')
expect(true, '/home/x/p/node_modules/left-pad/index.js', 'node_modules/')
expect(true, '/home/x/p/dist/bundle.js', 'dist/')
expect(true, '/home/x/p/.venv/lib/python3.13/site.py', '.venv/')

console.log('must ALLOW on every route')
expect(false, '/home/x/p/.env.example', '.env.example is a template')
expect(false, '/home/x/p/.env.sample', '.env.sample')
expect(false, '/home/x/p/.env.template', '.env.template')
expect(false, '/home/x/p/.flow/README.md', 'another file under .flow/')
expect(false, '/home/x/p/src/lib.rs', 'ordinary source')
expect(false, '/home/x/p/docs/environment.md', 'a doc about environments')
expect(false, '/home/x/p/Cargo.toml', 'the manifest, not the lockfile')
expect(false, '/home/x/p/src/target_selection.rs', 'a filename containing target')
expect(false, '/home/x/p/crates/build-info/src/lib.rs', 'a crate named build-info')
expect(false, '/home/x/p/README.md', 'readme')

console.log('Claude: NotebookEdit names its target notebook_path')
const notebook = (file) => hook('protect-files.mjs', { tool_name: 'NotebookEdit', tool_input: { notebook_path: file } })
check('a notebook inside node_modules/ is denied', denied(notebook('/home/x/p/node_modules/foo/a.ipynb')))
check('an ordinary notebook is allowed', notebook('/home/x/p/notebooks/analysis.ipynb') === null)
check('an unparseable body blocks nothing (the Claude adapters fail open)', hook('protect-files.mjs', '{') === null)

console.log('Codex: every target in the patch envelope is checked')
const codex = (tool_input) => hook('protect-files-codex.mjs', { tool_name: 'apply_patch', tool_input })
check('an added .env is denied', denied(codex({ command: patch('*** Add File: .env', '+TOKEN=secret') })))
check('a lockfile behind an ordinary file is denied', denied(codex({ command: patch('*** Update File: src/main.mjs', '@@', '-a', '+b', '*** Update File: Cargo.lock', '@@', '-a', '+b') })))
check('a move into dist/ is denied', denied(codex({ command: patch('*** Update File: src/main.mjs', '*** Move to: dist/main.mjs', '@@', '-a', '+b') })))
check('deleting the marker is denied', denied(codex({ command: patch('*** Delete File: .flow/managed') })))
check('an ordinary added file is allowed', codex({ command: patch('*** Add File: src/new.mjs', '+export const answer = 42') }) === null)
// CRLF is a line ending, not tampering: an ordinary CRLF envelope passes, and a protected
// target inside one is still caught.
check('an ordinary CRLF envelope is allowed', codex({ command: patch('*** Add File: src/win.mjs', '+ok').replaceAll('\n', '\r\n') }) === null)
check('a protected target in a CRLF envelope is denied', denied(codex({ command: patch('*** Add File: .env', '+TOKEN=x').replaceAll('\n', '\r\n') })))
// A benign file_path must not vouch for a patch riding in the same envelope, and two deniable
// fields still produce exactly one decision (hook() would throw on two concatenated objects).
check('a benign file_path does not vouch for the patch', denied(codex({ file_path: 'src/ok.mjs', command: patch('*** Add File: .env', '+TOKEN=x') })))
check('two deniable fields give one decision', denied(codex({ file_path: '.env', command: patch('*** Add File: .env.production', '+TOKEN=x') })))

console.log('Codex: an envelope it cannot fully enumerate is denied (the Codex adapters fail closed)')
for (const [name, command] of [
  ['an unknown directive', '*** Begin Patch\n*** Copy File: .env\n*** End Patch'],
  ['an unknown directive beside a known one', '*** Begin Patch\n*** Remove: .env\n*** Add File: src/a.mjs\n+x\n*** End Patch'],
  ['an empty patch', '*** Begin Patch\n*** End Patch'],
  ['a patch with no end marker', '*** Begin Patch\n*** Add File: src/a.mjs\n+x'],
]) {
  const out = codex({ command })
  check(name, denied(out) && /enumerate every target/.test(out.permissionDecisionReason), JSON.stringify(out))
}
check('a call with neither a command nor a file path is denied', denied(codex({})))
check('an unparseable body is denied', denied(hook('protect-files-codex.mjs', '{')))

console.log(bad === 0 ? '\nprotect-files: ALL PASS' : `\nprotect-files: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
