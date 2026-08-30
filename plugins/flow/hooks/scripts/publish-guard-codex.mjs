#!/usr/bin/env node
// Codex publish guard. Three jobs, and they are not the same job.
//
// 1. Registry publication. crates.io, npm, PyPI and RubyGems have no real undo, and Codex
//    cannot turn a PreToolUse hook result into an approval prompt: as of Codex CLI 0.149.1 an
//    unsupported `ask` reads as a hook failure and the command runs anyway. So publication
//    fails closed here instead of asking, everywhere, with no way through from inside a
//    session. The human types it in their own terminal.
//
// 2. Pull request merges, in a repository that opts in. A repository opts in by committing
//    a `.flow/managed` file, which is how flow tells "a repo whose merges I am responsible
//    for" from "some clone the session happens to be sitting in". The marker being committed
//    at HEAD is the opt-in, so deleting the working-tree copy does not turn the guardrail off.
//    In an opted-in repository every merge command this guard can recognize is denied and the
//    denial names scripts/land-merge.mjs, the executor that performs the merge after
//    re-deriving every fact from GitHub. In any other repository this guard does no merge
//    gating at all.
//
// 3. The model may not write its own approval. The commands that would obviously produce a
//    release sanction are denied here, and the file itself is protected from the editor tools
//    by the protected-file rule.
//
// A cooperative guardrail, not a security boundary. This guard used to authorize merges: it
// parsed `gh pr merge` out of the command, matched its flags against the sanction, and let one
// exact spelling through. Reading shell text well enough to authorize on it is not a fight this
// code can win. So the merge no longer trusts anything this classifier concludes; the deny is a
// tripwire that points at the executor, and over-matching costs a human one rephrase.
//
// The classifier is coarse on purpose, and the ways past it are known and accepted, because
// closing them would buy nothing at same-uid. A shell option before -c (`bash -O ... -c '...'`),
// a gh flag wedged between `pr` and `merge`, a `cd` into the repo, or a GH_REPO redirect can all
// slip a merge-shaped command past this text match. None of that matters, because everything
// here runs as one uid: a model that wanted to merge unreviewed could ignore this hook entirely
// and call the GitHub API with the token. The real, cooperative enforcement is downstream and
// deterministic - the committed `.flow/managed` marker enrolls the repository, and the executor
// claims one human-written release sanction and re-checks it against live GitHub state before it
// merges. This guard's job is to keep the ordinary land path running through that executor, not
// to stop a determined adversary, which on a single-uid homelab would be theater.
//
// Ordinary work must not notice this file. Commands that publish nothing take a few passes
// over their own text and start no subprocess; only a merge-shaped command pays for the one
// `git rev-parse`.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mergeShapes, publishOperationsStrict, registryReason } from '../../lib/hook-policy.mjs'
import { sanctionPath } from '../../lib/release-sanction.mjs'
import { preToolDeny } from './wire.mjs'

const REGISTRY_TAIL =
  'Codex PreToolUse hooks cannot request confirmation, so direct publication is blocked. ' +
  'Run the publish command yourself after reviewing the version and package contents.'
const REGISTRY_MANUAL =
  'A release sanction does not cover this and never will: registry publication stays manual. ' +
  'Ask the human to run it in their own terminal.'

const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const EXECUTOR = join(PLUGIN_ROOT, 'scripts', 'land-merge.mjs')
const MANAGED_MARKER = join('.flow', 'managed')

const SANCTION = sanctionPath(process.env)

// The model may not write its own approval. These are the spellings that would do it
// through a shell: touching the sanction file by resolved path or by name, and running
// the approval helper. Deliberately narrow around the helper - it matches the helper's
// own verbs, so `git add plugins/flow/scripts/release-sanction.mjs` stays ordinary work.
const selfApproval = (command) => {
  if (command.includes(SANCTION)) return `it writes or reads ${SANCTION} directly`
  if (/\brelease-sanction\.json\b/.test(command)) return 'it names the release sanction file'
  if (/release-sanction\.mjs\b[^;&|]*\b(?:approve|revoke)\b/.test(command)) return 'it runs the release sanction helper'
  return null
}

const git = (root, args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
})

/**
 * Does this session's repository opt into flow's merge guardrail?
 *
 * Two bounded git reads, and only for a command that already looks like a merge. The hook runs
 * before every Bash call and hooks.json gives the whole hook 10 seconds, so a git that cannot
 * answer is treated as an answer of "managed": failing closed here costs a denial the human can
 * resolve, and failing open costs an unreviewed merge.
 *
 * The opt-in lives in git, not in the working tree. A worktree copy of `.flow/managed` is the
 * fast answer, but the marker being committed at HEAD is what actually enrolls the repository,
 * so a deleted or never-checked-out worktree copy does not un-enroll it. `git cat-file -e`
 * exits 0 when the object exists and nonzero when it does not; a clean nonzero is a real "not
 * committed", while an error finding the repository at all falls through to the managed default.
 */
const isManagedRepo = (cwd) => {
  let root
  try {
    root = git(cwd, ['rev-parse', '--show-toplevel']).trim()
  } catch {
    return true
  }
  if (root === '') return true
  if (existsSync(join(root, MANAGED_MARKER))) return true
  try {
    git(root, ['cat-file', '-e', 'HEAD:.flow/managed'])
    return true
  } catch {
    return false
  }
}

const mergeDenial = (shapes) =>
  `flow: this looks like a pull request merge (${shapes.join('; ')}), and this repository opts into flow's ` +
  'merge guardrail with a committed .flow/managed file. Merging by hand is denied here whatever the ' +
  'command spells, because nothing on this host can put a confirmation prompt in front of the human at the ' +
  `moment the command runs.\nThe merge runs through the executor instead: \`node ${EXECUTOR} <pr-number>\`. ` +
  'It takes the pull request number and nothing else, and re-derives the repository, the head SHA, the ' +
  'state, the draft flag and the base branch from GitHub before it merges anything.\nThe executor needs a ' +
  "release sanction, which is the human's approval of one specific head. Tell them the repository slug, the " +
  'branch, the full 40-character head SHA, the base branch and the pull request number, and ask them to run ' +
  '`node <flow>/scripts/release-sanction.mjs approve --repo <owner/name> --branch <branch> --head <sha> ' +
  '--base <branch> --pr <number> --op gh-pr-merge` in their own terminal. Relay what you need; do not run it yourself.'

const decide = (input) => {
  const command = input?.tool_input?.command
  if (typeof command !== 'string') {
    return 'flow: Codex sent a Bash call without an inspectable command; refusing an operation whose publication status cannot be verified.'
  }

  const forged = selfApproval(command)
  if (forged) {
    return `flow: this command is refused because ${forged}. A release sanction is the human's approval ` +
      'of one specific head SHA, so the session that wants to publish never writes it. Ask the human ' +
      'to run scripts/release-sanction.mjs in their own terminal, and tell them the repository, ' +
      'branch, head SHA, pull request number, and operation you need approved.'
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
