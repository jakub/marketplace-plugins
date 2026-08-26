#!/usr/bin/env node
// Smoke harness for hooks/scripts/publish-guard.mjs. This guard asks rather than denies, so
// "ASK" is the positive case. Run: node plugins/flow/scripts/smoke-publish-guard.mjs
import { execFileSync } from 'node:child_process'
const G = 'plugins/flow/hooks/scripts/publish-guard.mjs'
const run = (command) =>
  execFileSync('node', [G], { input: JSON.stringify({ tool_input: { command } }) })
    .toString()
    .trim().length > 0
let bad = 0
const expect = (want, command, name) => {
  const got = run(command)
  if (got !== want) bad++
  console.log(`  ${got === want ? 'ok' : 'FAIL'}: ${name} → ${got ? 'ASK' : 'pass'} (want ${want ? 'ASK' : 'pass'})`)
}
console.log('must ASK')
expect(true, 'cargo publish', 'cargo publish')
expect(true, 'cargo publish -p example-core', 'cargo publish a member')
expect(true, 'npm publish --access public', 'npm publish')
expect(true, 'pnpm publish', 'pnpm publish')
expect(true, 'twine upload dist/*', 'twine upload')
expect(true, 'uv publish', 'uv publish')
expect(true, 'gem push pkg/x.gem', 'gem push')
expect(true, 'cargo publish --dry-run && cargo publish', 'a dry run does not exempt a later publish')
expect(true, 'cargo publish && echo --dry-run', 'a later dry-run token does not exempt publish')
console.log('must PASS')
expect(false, 'cargo publish --dry-run', 'dry run is the safe rehearsal')
expect(false, 'npm publish --dry-run', 'npm dry run')
expect(false, 'cargo publish --dry-run && echo done', 'dry-run segment followed by ordinary work')
expect(false, 'cargo build --release', 'ordinary build')
expect(false, 'cargo test', 'tests')
expect(false, 'docker push registry.internal.example/app:dev', 'private registry, retag is free')
expect(false, 'gh release create v1.2.3', 'a release deletes cleanly')
expect(false, 'git push origin main', 'git push is git-guard territory')
expect(false, 'echo "remember to run cargo publish after the tag"', 'publishing named in prose')
console.log(bad === 0 ? '\npublish-guard: ALL PASS' : `\npublish-guard: ${bad} FAILURE(S)`)
