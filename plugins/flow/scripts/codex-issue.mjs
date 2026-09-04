#!/usr/bin/env node
// Start one Codex issue run without granting the directory that holds every repository.
//
// Flow's issue worktree has a deterministic sibling path, but Codex fixes its writable roots
// before the issue stage can create that worktree. This launcher asks issue-claim's read-only plan
// for the exact path, creates only that empty directory, and starts Codex with the repository as
// its primary workspace plus that one --add-dir. CODEX_PROJECT_DIR gives Flow's MCP server the
// worktree itself as its fallback root, so delegated Claude jobs do not inherit the repository's
// whole parent from PWD. The Codex manifest explicitly forwards that variable.
//
// The directory reservation is deliberately weak and narrow. It accepts only the exact real,
// empty directory from the plan. issue-claim checks the same facts before taking the tag and again
// under the tag. A same-uid process can still race it, just as it can rewrite the repository; the
// executor leaves any foreign contents alone.
//
// If Codex exits before claim fills the directory, this removes a reservation it created with
// rmdir, which succeeds only while the directory is still empty. A directory that predates the
// launcher or contains a worktree is never removed here.

import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const USAGE = 'usage: codex-issue.mjs <issue-number> [--kind feat|fix|chore]\n'
const issueClaim = fileURLToPath(new URL('./issue-claim.mjs', import.meta.url))

const fail = (message, code = 2) => {
  process.stderr.write(`codex-issue: ${message}\n`)
  process.exitCode = code
}

const exactEmptyDirectory = (path) => {
  try {
    const stat = lstatSync(path)
    return !stat.isSymbolicLink() && stat.isDirectory() && realpathSync(path) === path && readdirSync(path).length === 0
  } catch { return false }
}

const argv = process.argv.slice(2)
if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
  process.stdout.write(USAGE)
} else {
  const planned = spawnSync(process.execPath, [issueClaim, 'plan', ...argv], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  if (planned.error) {
    fail(`could not run the read-only issue plan: ${planned.error.code || planned.error.message}`, 1)
  } else if (planned.status !== 0) {
    if (planned.stdout) process.stdout.write(planned.stdout)
    if (planned.stderr) process.stderr.write(planned.stderr)
    process.exitCode = planned.status ?? 1
  } else {
    let plan = null
    try { plan = JSON.parse(planned.stdout) } catch {}
    const valid = plan?.command === 'plan' && plan?.result === 'planned' &&
      Number.isInteger(plan?.issue) && plan.issue > 0 &&
      (plan?.kind === 'feat' || plan?.kind === 'fix' || plan?.kind === 'chore') &&
      (plan?.target === 'absent' || plan?.target === 'prepared') &&
      typeof plan?.repoRoot === 'string' && isAbsolute(plan.repoRoot) &&
      typeof plan?.parent === 'string' && isAbsolute(plan.parent) &&
      typeof plan?.worktree === 'string' && isAbsolute(plan.worktree) &&
      dirname(plan.repoRoot) === plan.parent && dirname(plan.worktree) === plan.parent
    if (!valid) {
      fail('the read-only issue plan did not return one valid repository and worktree', 1)
    } else {
      let created = false
      try {
        if (plan.target === 'absent') {
          mkdirSync(plan.worktree, { mode: 0o700 })
          created = true
        }
      } catch (error) {
        fail(`could not reserve ${plan.worktree}: ${error.code || error.message}`, 1)
      }

      if (process.exitCode === undefined && !exactEmptyDirectory(plan.worktree)) {
        fail(`${plan.worktree} is not the exact empty directory from the plan`, 1)
      }

      if (process.exitCode === undefined) {
        process.stderr.write(`codex-issue: granting Codex ${plan.repoRoot} and ${plan.worktree}\n`)
        const explicitKind = argv.includes('--kind')
        const prompt = `Use the flow issue skill for issue #${plan.issue}.` +
          (explicitKind ? ` Pass --kind ${plan.kind} to issue-claim.` : '')
        const child = spawnSync('codex', [
          '-C', plan.repoRoot,
          '--add-dir', plan.worktree,
          prompt,
        ], {
          cwd: plan.repoRoot,
          env: { ...process.env, CODEX_PROJECT_DIR: plan.worktree, PWD: plan.repoRoot },
          stdio: 'inherit',
        })

        if (created) {
          try { rmdirSync(plan.worktree) } catch {}
        }
        if (child.error) fail(`Codex could not be started: ${child.error.code || child.error.message}`, 1)
        else if (child.signal) fail(`Codex stopped on signal ${child.signal}`, 1)
        else process.exitCode = child.status ?? 1
      } else if (created) {
        try { rmdirSync(plan.worktree) } catch {}
      }
    }
  }
}
