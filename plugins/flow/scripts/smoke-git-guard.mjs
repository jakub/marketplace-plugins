#!/usr/bin/env node
// Smoke harness for hooks/scripts/git-guard.mjs — the charter git rules that must survive
// delegation. Deny cases are the rules; allow cases are the false positives that would make
// the guard something people route around. Run: node plugins/flow/scripts/smoke-git-guard.mjs
import { execFileSync } from 'node:child_process'
const G = 'plugins/flow/hooks/scripts/git-guard.mjs'
const run = (command) => {
  const out = execFileSync('node', [G], { input: JSON.stringify({ tool_input: { command } }) }).toString()
  return out.trim().length > 0
}
let bad = 0
const expect = (want, command, name) => {
  const got = run(command)
  const ok = got === want
  if (!ok) bad++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name} → ${got ? 'DENY' : 'allow'} (want ${want ? 'DENY' : 'allow'})`)
}
console.log('must DENY')
expect(true, 'git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"', 'Co-Authored-By')
expect(true, 'git commit -m "fix: y\n\nClaude-Session: https://claude.ai/code/x"', 'Claude-Session')
expect(true, 'git -C /tmp/wt commit -m "chore\n\nCo-Authored-By: X"', 'git -C … commit + trailer')
expect(true, 'git commit -m "x\n\n🤖 Generated with [Claude Code](https://claude.com)"', 'robot trailer')
expect(true, 'git commit -m "x\n\nGenerated with [Claude Code]"', 'Generated-with trailer')
expect(true, 'git commit --no-verify -m hi', 'commit --no-verify')
expect(true, 'git push --no-verify', 'push --no-verify')
expect(true, 'cd /tmp/wt && git commit -m "a\n\nSigned-off-by: X"', 'compound cmd + trailer')
console.log('must ALLOW')
expect(false, 'git commit -m "feat: add the thing"', 'clean commit')
expect(false, 'git commit -m "refactor: drop the Co-Authored-By trailers from docs"', 'trailer named mid-subject')
expect(false, 'git log --format=%B | grep -i co-authored-by', 'auditing history')
expect(false, 'git log --grep=commit --oneline', 'git log --grep=commit')
expect(false, 'grep -rn "Co-Authored-By" .', 'grepping repo')
expect(false, 'FLOW_SANCTION=git git commit --amend --no-edit', 'sanctioned amend')
expect(false, 'cargo test --no-fail-fast', 'non-git')
expect(false, 'gh pr create --title x', 'gh')
console.log(bad === 0 ? '\ngit-guard: ALL PASS' : `\ngit-guard: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
