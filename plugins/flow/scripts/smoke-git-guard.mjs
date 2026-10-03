#!/usr/bin/env node
// Smoke harness for the two Bash guards that are one script on both hosts: hooks/scripts/
// git-guard.mjs (the charter git rules, plus the cron regex) and no-backlog-guard.mjs. Deny
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
    env: { ...process.env, FLOW_CRON_JOB: '', ...env },
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
console.log('cron mode (FLOW_CRON_JOB): the executor line and nothing else')
// Every cron case pins the root: CLAUDE_PLUGIN_ROOT first, then PLUGIN_ROOT, then the guard's own
// location, blanked here so the ambient environment cannot decide a case.
const cronOut = (command, { job = 'lint', root = '/x/flow', pluginRoot = '' } = {}) =>
  execFileSync(process.execPath, [G], {
    input: JSON.stringify(SHAPES.claude(command)),
    env: { ...process.env, FLOW_CRON_JOB: job, CLAUDE_PLUGIN_ROOT: root, PLUGIN_ROOT: pluginRoot },
  }).toString().trim()
const cron = (want, command, name, opts) => {
  const got = cronOut(command, opts) !== ''
  const ok = got === want
  if (!ok) bad++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: cron: ${name} → ${got ? 'DENY' : 'allow'} (want ${want ? 'DENY' : 'allow'})`)
}
const EX = 'node /x/flow/scripts/lint-actions.mjs'
const R = '/home/x/code/r'
cron(false, `${EX} survey ${R}`, 'survey')
cron(false, `${EX} remove-worktree ${R} ${R}/.flow-worktrees/feat-issue-7-x`, 'remove-worktree')
cron(false, `${EX} delete-branch ${R} feat/issue-7-x`, 'delete-branch')
cron(false, `${EX} delete-remote-branch ${R} feat/issue-7-x`, 'delete-remote-branch')
cron(false, `${EX} delete-remote-branch ${R} feat/issue-7-x --expect ${'0123456789abcdef'.repeat(2)}01234567`, 'delete-remote-branch --expect <sha>')
cron(true, `${EX} delete-remote-branch ${R} feat/issue-7-x; git push origin --delete main`, 'delete-remote-branch with a git write behind a semicolon')
cron(true, `${EX} delete-remote-branch ${R} $(git rev-parse HEAD)`, 'delete-remote-branch with a command substitution')
cron(true, `${EX} delete-remote-branch ${R} 'feat/a b'`, 'delete-remote-branch with a quoted argument')
cron(true, `${EX} delete-remote-branchx ${R} feat/x`, 'a verb that only starts with delete-remote-branch')
cron(false, `${EX} relabel ${R} 7 --from in-progress --to ready-for-agent --seen 2026-09-29T03:30:00Z --reason no_live_run_for_six_hours`, 'relabel an orphan')
cron(false, `${EX} relabel ${R} 9 --from none --to needs-triage --seen 2026-09-29T03:30:00Z --reason no_lifecycle_label`, 'relabel an unlabelled issue')
cron(false, `${EX} survey ${R}`, 'the doc sweep runs the same line (its allowlist narrows it to survey)', { job: 'doc-sweep' })
cron(false, `node ${ROOT}/scripts/lint-actions.mjs survey ${R}`, 'no root variable: the guard\'s own plugin', { root: '' })
cron(false, `node /p/scripts/lint-actions.mjs survey ${R}`, 'PLUGIN_ROOT when CLAUDE_PLUGIN_ROOT is empty', { root: '', pluginRoot: '/p' })
cron(true, `node /p/scripts/lint-actions.mjs survey ${R}`, 'CLAUDE_PLUGIN_ROOT wins over PLUGIN_ROOT', { pluginRoot: '/p' })
// Every character outside the argument class, inside an argument, at the end, and as its own word.
for (const c of [';', '&', '|', '>', '<', '$', '`', '(', ')', '{', '}', '[', ']', '\\', "'", '"', '\n', '\t', '*', '?', '~', '#', '!', '=', '%', ',', '^']) {
  const shown = JSON.stringify(c)
  cron(true, `${EX} survey /home/x/co${c}de/r`, `${shown} inside an argument`)
  cron(true, `${EX} survey ${R}${c}`, `${shown} at the end`)
  cron(true, `${EX} survey ${R} ${c} x`, `${shown} as a word`)
}
// The shapes the old grammar was attacked with, each riding behind a legitimate executor call.
cron(true, `${EX} survey ${R}; git push origin main`, 'a git write behind a semicolon')
cron(true, `${EX} survey ${R} && gh issue edit 7 --repo x/y --add-label ready-for-agent`, 'a gh write behind &&')
cron(true, `${EX} survey ${R} || bash /x/flow/scripts/install-cron.sh uninstall`, 'a plugin script behind ||')
cron(true, `${EX} survey ${R} | sh`, 'a pipe into a shell')
cron(true, `${EX} survey ${R}\ngit push origin main`, 'a second line')
cron(true, `${EX} survey $(git push origin main)`, 'a command substitution')
cron(true, `${EX} survey "$(cat /home/x/.ssh/id_ed25519)"`, 'a substitution in double quotes')
cron(true, `${EX} relabel ${R} 7 --from none --to needs-triage --seen 2026-09-29T03:30:00Z --reason 'two words'`, 'a quoted reason')
cron(true, `${EX} survey ${R} > /home/x/.bashrc`, 'a redirection')
cron(true, `${EX} survey ${R} &`, 'the background operator')
cron(true, ` ${EX} survey ${R}`, 'a leading space')
cron(true, `${EX} survey ${R} `, 'a trailing space')
cron(true, `${EX}  survey ${R}`, 'a doubled space')
// Every other command word, and every other way of naming the executor.
for (const [command, name] of [
  ['git status', 'git status'],
  [`git -C ${R} log -1`, 'a git read'],
  [`git -C ${R} fetch --prune origin`, 'git fetch'],
  ['gh issue list --repo x/y --json number', 'a gh read'],
  ['gh issue edit 7 --repo x/y --add-label ready-for-agent', 'a gh write'],
  ['gh api graphql -f query=x', 'gh api'],
  ['bash /x/flow/scripts/install-cron.sh uninstall', 'bash on a plugin script'],
  [`sh -c '${EX} survey ${R}'`, 'the executor inside sh -c'],
  [`node -e "require('child_process').execSync('git push')"`, 'node -e'],
  ['node /x/flow/scripts/land-merge.mjs 12 0123456789abcdef', 'the merge executor'],
  ['node /x/flow/scripts/issue-claim.mjs claim 7', 'the claim executor'],
  [`${EX} clear-orphan ${R} 7`, 'a retired verb'],
  [`${EX} survey-all ${R}`, 'a verb prefix'],
  [EX, 'no verb'],
  [`node /x/flow/scripts/lint-actions.mjsx survey ${R}`, 'a longer script name'],
  [`node /x/flow/scripts/../scripts/lint-actions.mjs survey ${R}`, 'a path through ..'],
  [`node /x/flowX/scripts/lint-actions.mjs survey ${R}`, 'a sibling of the root'],
  [`node /tmp/scripts/lint-actions.mjs survey ${R}`, 'another root'],
  [`/usr/bin/node /x/flow/scripts/lint-actions.mjs survey ${R}`, 'a path-qualified node'],
  [`node --require /tmp/x.js /x/flow/scripts/lint-actions.mjs survey ${R}`, 'a node option before the script'],
  [`NODE_OPTIONS=--require=/tmp/x.js ${EX} survey ${R}`, 'an assignment prefix'],
  [`FLOW_SANCTION=git ${EX} survey ${R}`, 'the sanction string on the executor'],
  ['FLOW_SANCTION=git git push origin main', 'the sanction string on a git write'],
  ['claude plugin list', 'claude'],
  ["gripe add <<'G'\nx\nG", 'gripe'],
  ['echo ok', 'echo'],
  ['', 'an empty command'],
]) cron(true, command, name)
const unreadable = execFileSync(process.execPath, [G], { input: '{', env: { ...process.env, FLOW_CRON_JOB: 'lint', CLAUDE_PLUGIN_ROOT: '/x/flow' } }).toString().trim()
if (unreadable === '') bad++
console.log(`  ${unreadable !== '' ? 'ok' : 'FAIL'}: cron: an unparseable body → ${unreadable !== '' ? 'DENY' : 'allow'} (want DENY)`)
// The root is matched as a literal, and a root the shell would split or expand admits nothing.
cron(true, `node /x/flow/scripts/lint-actions.mjs survey ${R}`, 'a dot in the root is literal', { root: '/x/fl.w' })
cron(false, `node /x/fl.w/scripts/lint-actions.mjs survey ${R}`, 'the dotted root itself', { root: '/x/fl.w' })
cron(true, `node /x/aab/scripts/lint-actions.mjs survey ${R}`, 'a plus in the root is literal', { root: '/x/a+b' })
cron(false, `node /x/a+b/scripts/lint-actions.mjs survey ${R}`, 'the plus root itself', { root: '/x/a+b' })
cron(true, `node /x/my flow/scripts/lint-actions.mjs survey ${R}`, 'a root with a space', { root: '/x/my flow' })
cron(true, `node /x/a;b/scripts/lint-actions.mjs survey ${R}`, 'a root with a semicolon', { root: '/x/a;b' })
const told = cronOut('git status')
const names = told.includes('node /x/flow/scripts/lint-actions.mjs <survey|remove-worktree|delete-branch|delete-remote-branch|relabel>')
if (!names) bad++
console.log(`  ${names ? 'ok' : 'FAIL'}: cron: the denial spells out the one line a job may run`)
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
expect(false, `${EX} survey ${R}`, 'the lint executor outside cron mode')
// A body the guard cannot read blocks nothing: never block on our own bug.
const unparseable = execFileSync(process.execPath, [G], { input: '{', env: { ...process.env, FLOW_CRON_JOB: '' } }).toString().trim()
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
