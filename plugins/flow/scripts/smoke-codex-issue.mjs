#!/usr/bin/env node
// Smoke the host-side launcher without opening Codex or reaching GitHub. A fake gh supplies one
// ready issue and a fake codex records its argv, cwd and inherited project root. Real git supplies
// the repository paths the read-only plan canonicalizes.
//
// Run: node plugins/flow/scripts/smoke-codex-issue.mjs

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const launcher = join(root, 'scripts', 'codex-issue.mjs')
const temp = mkdtempSync(join(tmpdir(), 'flow-codex-issue-'))
const repo = join(temp, 'repo')
const bin = join(temp, 'bin')
const capture = join(temp, 'codex.json')
const gitEnv = {
  ...process.env,
  HOME: temp,
  GIT_CONFIG_GLOBAL: join(temp, 'no-such-gitconfig'),
  GIT_CONFIG_SYSTEM: join(temp, 'no-such-gitconfig'),
}

try {
  mkdirSync(bin)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv })
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:jakub/demo.git'], { env: gitEnv })

  const fakeGh = join(bin, 'gh')
  writeFileSync(fakeGh, `#!/usr/bin/env node
const issue = JSON.parse(process.env.FLOW_FAKE_ISSUE)
if (process.argv[2] === 'issue' && process.argv[3] === 'view') console.log(JSON.stringify(issue))
else process.exit(19)
`)
  chmodSync(fakeGh, 0o755)

  const fakeCodex = join(bin, 'codex')
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { readdirSync, writeFileSync } from 'node:fs'
const target = process.env.CODEX_PROJECT_DIR
const before = readdirSync(target)
writeFileSync(process.env.FLOW_FAKE_CAPTURE, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), projectDir: target, pwd: process.env.PWD, before,
}))
if (process.env.FLOW_FAKE_POPULATE === '1') writeFileSync(target + '/claimed.txt', 'worktree contents\\n')
`)
  chmodSync(fakeCodex, 0o755)

  const run = ({ issue, title, kind = null, populate = false }) => spawnSync(
    process.execPath,
    [launcher, String(issue), ...(kind === null ? [] : ['--kind', kind])],
    {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...gitEnv,
        PATH: `${bin}:${process.env.PATH}`,
        FLOW_FAKE_CAPTURE: capture,
        FLOW_FAKE_POPULATE: populate ? '1' : '0',
        FLOW_FAKE_ISSUE: JSON.stringify({
          number: issue,
          title,
          state: 'OPEN',
          labels: [{ name: 'ready-for-agent' }],
          assignees: [],
          body: '## Acceptance Criteria\n\n- [ ] launch inside one worktree\n',
          url: `https://github.com/jakub/demo/issues/${issue}`,
        }),
      },
    },
  )

  const firstPath = join(temp, 'repo-issue-7-launch-one')
  const first = run({ issue: 7, title: 'Launch one', kind: 'chore' })
  assert.equal(first.status, 0, first.stderr)
  const firstCapture = JSON.parse(readFileSync(capture, 'utf8'))
  assert.deepEqual(firstCapture.argv, [
    '-C', repo,
    '--add-dir', firstPath,
    'Use the flow issue skill for issue #7. Pass --kind chore to issue-claim.',
  ])
  assert.equal(firstCapture.cwd, repo)
  assert.equal(firstCapture.pwd, repo)
  assert.equal(firstCapture.projectDir, firstPath)
  assert.deepEqual(firstCapture.before, [])
  assert.equal(existsSync(firstPath), false, 'an unused reservation created by the launcher is removed')
  assert.ok(!firstCapture.argv.includes(temp), 'the parent that holds every repository is never granted')

  const secondPath = join(temp, 'repo-issue-8-launch-two')
  const second = run({ issue: 8, title: 'Launch two', populate: true })
  assert.equal(second.status, 0, second.stderr)
  assert.ok(existsSync(join(secondPath, 'claimed.txt')), 'a populated worktree is left in place')

  const thirdPath = join(temp, 'repo-issue-9-existing-reservation')
  mkdirSync(thirdPath)
  const third = run({ issue: 9, title: 'Existing reservation' })
  assert.equal(third.status, 0, third.stderr)
  assert.deepEqual(readdirSync(thirdPath), [], 'an existing reservation stays empty')
  assert.equal(existsSync(thirdPath), true, 'the launcher removes only a directory it created')

  console.log('codex issue launcher: ALL PASS')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
