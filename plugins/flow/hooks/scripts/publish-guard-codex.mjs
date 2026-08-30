#!/usr/bin/env node
// Codex publish guard. Two jobs, and they are not the same job.
//
// 1. Registry publication. crates.io, npm, PyPI and RubyGems have no real undo, and Codex
//    cannot turn a PreToolUse hook result into an approval prompt: as of Codex CLI 0.151.0 an
//    unsupported `ask` reads as a hook failure and the command runs anyway. So publication
//    fails closed here instead of asking, everywhere, with no way through from inside a
//    session. The human types it in their own terminal.
//
// 2. Pull request merges, in a repository that opts in. A repository opts in by committing
//    a `.flow/managed` file, which is how flow tells "a repo whose merges I am responsible
//    for" from "some clone the session happens to be sitting in". The marker being committed
//    at HEAD is the opt-in, so deleting the working-tree copy does not turn the guardrail off.
//    In an opted-in repository every merge command this guard can recognize is denied and the
//    denial names scripts/land-merge.mjs, the executor that performs the merge after deriving
//    the repository from the origin remote and the pull request's live facts from GitHub.
//    This is routing, not approval: the human asking to land is the authorization, exactly as
//    on the Claude host, and in an attended session the executor invocation passes this guard
//    untouched - the deny just keeps the merge on the path that verifies what it merges.
//    (Scheduled jobs are the exception below: cron merges nothing, executor included.) In any
//    other repository this guard does no merge gating at all.
//
// A cooperative guardrail, not a security boundary. Reading shell text well enough to
// authorize on it is not a fight this code can win, so nothing here authorizes anything: the
// deny is a tripwire that points at the executor, and over-matching costs one rephrase.
//
// The classifier is coarse on purpose, and the ways past it are known and accepted, because
// closing them would buy nothing at same-uid. A shell option before -c (`bash -O ... -c '...'`),
// a gh flag wedged between `pr` and `merge`, a `cd` into the repo, or a GH_REPO redirect can all
// slip a merge-shaped command past this text match. None of that matters, because everything
// here runs as one uid: a model that wanted to merge unverified could ignore this hook entirely
// and call the GitHub API with the token. The real value is downstream and deterministic - the
// executor re-derives the repository, head, state and base from GitHub, merges with
// --match-head-commit, and proves the outcome by re-reading. This guard's job is to keep the
// ordinary land path running through that executor, not to stop a determined adversary, which
// on a single-uid homelab would be theater.
//
// Ordinary work must not notice this file. Commands that publish nothing take a few passes
// over their own text and start no subprocess; only a merge-shaped command pays for the one
// `git rev-parse`.

import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mergeShapes, publishOperationsStrict, registryReason } from '../../lib/hook-policy.mjs'
import { preToolDeny } from './wire.mjs'

const REGISTRY_TAIL =
  'Codex PreToolUse hooks cannot request confirmation, so direct publication is blocked. ' +
  'Run the publish command yourself after reviewing the version and package contents.'
const REGISTRY_MANUAL =
  'Registry publication stays manual. Ask the human to run it in their own terminal.'

const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const EXECUTOR = join(PLUGIN_ROOT, 'scripts', 'land-merge.mjs')

const git = (root, args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
})

/**
 * Does this session's repository opt into flow's merge guardrail?
 *
 * Two bounded git reads, and only for a command that already looks like a merge. The hook runs
 * before every Bash call and hooks.json gives the whole hook 10 seconds, so a git that cannot
 * answer is treated as an answer of "managed": failing closed here costs a denial the human can
 * resolve, and failing open costs a merge that skipped the verifying path.
 *
 * The opt-in lives in git, not in the working tree: the marker committed at HEAD is what
 * enrolls the repository, exactly as documented, so a deleted worktree copy does not un-enroll
 * it and an untracked or merely staged copy does not enroll some unrelated clone the session
 * happens to be sitting in. `git ls-tree` lists the
 * path when it is committed at HEAD and prints nothing when it is not, both on a clean exit 0.
 * Empty output is a real "not committed" and leaves the repository unmanaged; non-empty output
 * is managed. Any nonzero exit or error from the probe - a repository with no HEAD yet, a broken
 * object store - is treated as managed, because failing closed here costs a denial the human can
 * resolve. `git cat-file -e` could not tell an absent path from an operational failure: both
 * exit nonzero, so it failed open on the second.
 */
const isManagedRepo = (cwd) => {
  let root
  try {
    root = git(cwd, ['rev-parse', '--show-toplevel']).trim()
  } catch {
    return true
  }
  if (root === '') return true
  try {
    return git(root, ['ls-tree', '--name-only', 'HEAD', '--', '.flow/managed']).trim() !== ''
  } catch {
    return true
  }
}

const mergeDenial = (shapes) =>
  `flow: this looks like a pull request merge (${shapes.join('; ')}), and this repository opts into flow's ` +
  'merge guardrail with a committed .flow/managed file. Merges here run through the executor, not a raw gh ' +
  `command: \`node ${EXECUTOR} <pr-number>\`. It takes the pull request number and nothing else, derives the ` +
  'repository from the origin remote, reads the head SHA, the state, the draft flag and the base branch from ' +
  'GitHub, merges with --match-head-commit pinned to that verified head, and confirms the outcome by ' +
  're-reading the pull request. Run it when the human has asked to land this pull request and the land gates ' +
  'have passed.'

const decide = (input) => {
  const command = input?.tool_input?.command
  if (typeof command !== 'string') {
    return 'flow: Codex sent a Bash call without an inspectable command; refusing an operation whose publication status cannot be verified.'
  }

  // Registry publication is denied everywhere, opted-in repository or not. This is the wording
  // the guard has always used, and it reaches no state and no subprocess.
  const registry = registryReason(publishOperationsStrict(command))
  if (registry) return `${registry} ${REGISTRY_TAIL}\n${REGISTRY_MANUAL}`

  const shapes = mergeShapes(command)
  const invokesExecutor = /\bland-merge\.mjs\b/.test(command)

  // Scheduled jobs read untrusted text and nobody is watching them, so merging is simply off
  // there, opted-in repository or not, and that includes the executor. FLOW_CRON_JOB is read
  // from the hook's own environment, which is the cron session's, so a command that strips the
  // variable off its own child - `env -u FLOW_CRON_JOB node land-merge.mjs 12` - is still
  // denied here even though the executor it launches would no longer see the variable itself.
  // This is checked before the merge-shape early return so the executor invocation, which is
  // not merge-shaped, is caught too.
  if (process.env.FLOW_CRON_JOB && (shapes.length > 0 || invokesExecutor)) {
    const what = shapes.length > 0 ? `this looks like a pull request merge (${shapes.join('; ')})` : 'this runs flow\'s merge executor'
    return `flow: ${what}, and scheduled jobs do not merge anything. FLOW_CRON_JOB is set, which means ` +
      'nobody is watching this run. Leave the pull request for a human session to land.'
  }

  if (shapes.length === 0) return null

  const cwd = typeof input?.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd()
  return isManagedRepo(cwd) ? mergeDenial(shapes) : null
}

let raw = ''
for await (const chunk of process.stdin) raw += chunk
let input
try { input = JSON.parse(raw) } catch { input = null }

const denial = decide(input)
if (denial !== null) process.stdout.write(JSON.stringify(preToolDeny(denial)))
