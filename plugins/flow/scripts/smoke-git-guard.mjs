#!/usr/bin/env node
// Smoke harness for the two Bash guards that are one script on both hosts: hooks/scripts/
// git-guard.mjs (the charter git rules) and no-backlog-guard.mjs. Deny
// cases are the rules; allow cases are the false positives that would make a guard something
// people route around. Every interactive case runs once in each host's PreToolUse envelope.
// Run: node plugins/flow/scripts/smoke-git-guard.mjs
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const G = join(ROOT, 'hooks', 'scripts', 'git-guard.mjs')
const NB = join(ROOT, 'hooks', 'scripts', 'no-backlog-guard.mjs')
// Claude's Bash envelope, and Codex's as captured on CLI 0.149.1 (the PostToolUse fixture in
// plugins/gripe/scripts/fixtures carries the same envelope). Both put the command in
// tool_input.command, and these prove the guards read it from each.
const SHAPES = {
  claude: (command) => ({ session_id: 's', transcript_path: '/tmp/t.jsonl', cwd: '/tmp', permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } }),
  codex: (command) => ({ session_id: 's', turn_id: 't', transcript_path: null, cwd: '/tmp', hook_event_name: 'PreToolUse', model: 'gpt-6-luna', permission_mode: 'default', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'u' }),
}
const run = (command, env = {}, shape = 'claude', script = G) => {
  const out = execFileSync(process.execPath, [script], {
    input: JSON.stringify(SHAPES[shape](command)),
    env: { ...process.env, ...env },
  }).toString()
  return out.trim().length > 0
}
let bad = 0
const expectIn = (script, label) => (want, command, name) => {
  for (const shape of Object.keys(SHAPES)) {
    const got = run(command, {}, shape, script)
    const ok = got === want
    if (!ok) bad++
    console.log(`  ${ok ? 'ok' : 'FAIL'}: ${label}${name} (${shape}) → ${got ? 'DENY' : 'allow'} (want ${want ? 'DENY' : 'allow'})`)
  }
}
const expect = expectIn(G, '')
console.log('must DENY')
expect(true, 'git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"', 'Co-Authored-By')
expect(true, 'git commit -m "fix: y\n\nClaude-Session: https://claude.ai/code/x"', 'Claude-Session')
expect(true, 'git -C /tmp/wt commit -m "chore\n\nCo-Authored-By: X"', 'git -C … commit + trailer')
expect(true, 'git commit -m "x\n\n🤖 Generated with [Claude Code](https://claude.com)"', 'robot trailer')
expect(true, 'git commit -m "x\n\nGenerated with [Claude Code]"', 'Generated-with trailer')
expect(true, 'git commit --no-verify -m hi', 'commit --no-verify')
expect(true, 'git push --no-verify', 'push --no-verify')
expect(true, 'cd /tmp/wt && git commit -m "a\n\nSigned-off-by: X"', 'compound cmd + trailer')
// Irreversible git.
expect(true, 'git push --force origin main', 'bare force-push')
expect(true, 'git push -f origin main', 'force-push short flag')
expect(true, 'git push origin main --force', 'force flag trailing')
expect(true, 'git log --oneline && git push --force origin main', 'force-push after a read')
expect(true, 'git push --force --force-if-includes', 'bare --force beside --force-if-includes')
expect(true, "cat <<'G' && git push --force origin main\nbody\nG", 'force-push on a heredoc opener line')
expect(true, 'git checkout .', 'checkout bare dot')
expect(true, 'git restore .', 'restore bare dot')
expect(true, 'git clean -fd', 'clean force')
expect(true, 'git clean --force -d', 'clean --force')
expect(true, 'git clean -xdf', 'clean force in a flag cluster')
// Text a shell runs is a command.
expect(true, "bash -lc 'git push --force origin main'", 'force-push in a bash -lc string')
expect(true, 'sh -c "git commit --no-verify -m hi"', '--no-verify in a sh -c string')
expect(true, "bash <<'S'\ngit clean -fd\nS", 'clean force in a heredoc on a shell\'s stdin')
console.log('must ALLOW')
expect(false, 'git commit -m "feat: add the thing"', 'clean commit')
expect(false, 'git commit -m "refactor: drop the Co-Authored-By trailers from docs"', 'trailer named mid-subject')
expect(false, 'git log --format=%B | grep -i co-authored-by', 'auditing history')
expect(false, 'git log --grep=commit --oneline', 'git log --grep=commit')
expect(false, 'grep -rn "Co-Authored-By" .', 'grepping repo')
// Writing about the flag is not passing the flag.
expect(false, 'gh pr comment -b "this repo bans --no-verify"', '--no-verify named in a PR comment')
expect(false, "echo 'git commit --no-verify is banned here'", '--no-verify inside single quotes')
expect(false, 'git commit -m "docs: explain why --no-verify is banned"', '--no-verify named in a commit subject')
expect(false, `gripe add <<'G'\ngit-guard fires on --no-verify in prose\nG`, '--no-verify in a heredoc body')
expect(false, 'FLOW_SANCTION=git git commit --amend --no-edit', 'sanctioned amend')
expect(false, `bash -c "git commit -m 'docs: why --no-verify is banned'"`, '--no-verify in prose inside a shell string')
expect(false, "bash -c 'git status' && git commit -m \"about git push --force\"", 'a shell string beside prose in another segment')
// The safe spellings of the rules above must stay usable, including the dry run the deny
// message tells you to run.
expect(false, 'git push --force-with-lease origin feat/x', 'force-with-lease')
expect(false, 'git push --force-with-lease', 'force-with-lease, no refspec')
expect(false, 'git push --force-with-lease --force-if-includes', 'force-with-lease plus force-if-includes')
expect(false, 'git push --force-if-includes origin feat/x', 'force-if-includes alone is a no-op')
expect(false, 'git checkout ./src/lib.rs', 'checkout a path starting with ./')
expect(false, 'git checkout -- src/lib.rs', 'checkout -- path')
expect(false, 'git restore --staged src/lib.rs', 'restore a named path')
expect(false, 'git clean -n', 'clean dry run')
expect(false, 'git clean -nd', 'clean dry run with -d')
expect(false, 'git clean --dry-run -d', 'clean --dry-run')
expect(false, 'gh pr comment -b "this repo bans git push --force"', 'force-push named in prose')
expect(false, 'cargo test --no-fail-fast', 'non-git')
expect(false, 'gh pr create --title x', 'gh')
// A body the guard cannot read blocks nothing: never block on our own bug.
const unparseable = execFileSync(process.execPath, [G], { input: '{' }).toString().trim()
if (unparseable !== '') bad++
console.log(`  ${unparseable === '' ? 'ok' : 'FAIL'}: an unparseable body → allow`)
console.log('no-backlog-guard: issues enter the tracker only through the two sanctioned lanes')
const backlog = expectIn(NB, 'no-backlog: ')
backlog(true, 'gh issue create --title x --body y', 'an unsanctioned issue')
backlog(true, 'cd /home/x/code/r && gh issue create -t x -b y', 'an issue after a cd')
backlog(true, "bash -lc 'gh issue create --title x'", 'an issue from a bash -lc string')
backlog(false, 'FLOW_SANCTION=prep gh issue create --title x', 'the prep lane')
backlog(false, 'FLOW_SANCTION=land gh issue create --title x', 'the land lane after the human acks')
backlog(false, 'gh issue list --label ready-for-agent', 'reading issues')
backlog(false, 'git commit -m "docs: no gh issue create for minor findings"', 'the command named in a commit message')
// Unquoted and unsanctioned, so only the heredoc masking keeps this body from reading as a command.
backlog(false, "python3 - <<'PY'\n# gh issue create runs only from prep\nprint(1)\nPY", 'the command named in a script heredoc')
console.log(bad === 0 ? '\ngit-guard: ALL PASS' : `\ngit-guard: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
