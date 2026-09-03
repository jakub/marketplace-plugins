#!/usr/bin/env node
// Codex publish guard. Two jobs, and they are not the same job.
//
// 1. Registry publication. crates.io, npm, PyPI and RubyGems have no real undo, and Codex
//    cannot turn a PreToolUse hook result into an approval prompt. An unsupported `ask` reads
//    as a hook failure and the command runs anyway, first captured on Codex CLI 0.149.1
//    (2026-08-26) and still the behaviour on 0.152.0 (2026-09-01). So publication fails closed
//    here instead of asking, everywhere, with no way through from inside a session. The human
//    types it in their own terminal. This is the one job the two hosts do differently: the
//    Claude guard asks about the same commands.
//
// 2. Pull request merges, in a repository that opts in. Identical on both hosts, so the whole
//    decision and the reasoning behind it live in lib/hook-policy.mjs above mergeDenialFor().
//    Read it there; this file only puts the answer on the wire.
//
// A cooperative guardrail, not a security boundary. Reading shell text well enough to
// authorize on it is not a fight this code can win, so nothing here authorizes anything: the
// deny is a tripwire that points at the executor, and over-matching costs one rephrase.

import { mergeDenialFor, publishOperationsStrict, registryReason } from '../../lib/hook-policy.mjs'
import { preToolDeny } from './wire.mjs'

const REGISTRY_TAIL =
  'Codex PreToolUse hooks cannot request confirmation, so direct publication is blocked. ' +
  'Run the publish command yourself after reviewing the version and package contents.'
const REGISTRY_MANUAL =
  'Registry publication stays manual. Ask the human to run it in their own terminal.'

const decide = (input) => {
  const command = input?.tool_input?.command
  if (typeof command !== 'string') {
    return 'flow: Codex sent a Bash call without an inspectable command; refusing an operation whose publication status cannot be verified.'
  }

  // Registry publication is denied everywhere, opted-in repository or not. This is the wording
  // the guard has always used, and it reaches no state and no subprocess.
  const registry = registryReason(publishOperationsStrict(command))
  if (registry) return `${registry} ${REGISTRY_TAIL}\n${REGISTRY_MANUAL}`

  return mergeDenialFor({ command, cwd: input?.cwd, env: process.env })
}

let raw = ''
for await (const chunk of process.stdin) raw += chunk
let input
try { input = JSON.parse(raw) } catch { input = null }

const denial = decide(input)
if (denial !== null) process.stdout.write(JSON.stringify(preToolDeny(denial)))
