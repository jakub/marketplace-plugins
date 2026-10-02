#!/usr/bin/env node
// Codex publish guard: the Codex adapter over lib/hook-policy.mjs, which holds both rules.
//
// Registry publication is denied here where Claude asks. Codex cannot turn a PreToolUse result
// into an approval prompt: it reads an unsupported `ask` as a hook failure and runs the command
// anyway (first captured on Codex CLI 0.149.1, 2026-08-26; still so on 0.152.0, 2026-09-01). So
// publication fails closed, and the human types it in their own terminal. Never return the
// Claude ask result from this file.
//
// The merge rule is the same decision the Claude adapter takes. Unlike Claude's adapter, this
// one fails closed on a call it cannot inspect: a deny-by-default path must not open on a
// harness change.

import { mergeDenialFor, publishReason } from '../../lib/hook-policy.mjs'
import { preToolDeny, readHookInput } from './wire.mjs'

const decide = (input) => {
  const command = input?.tool_input?.command
  if (typeof command !== 'string') {
    return 'flow: Codex sent a Bash call without an inspectable command; refusing an operation whose publication status cannot be verified.'
  }

  const registry = publishReason(command)
  if (registry) {
    return `${registry} Codex PreToolUse hooks cannot request confirmation, so publication from a session is blocked.\n` +
      'Registry publication stays manual. Ask the human to run the publish command in their own terminal after they check the version number and the package contents.'
  }

  return mergeDenialFor({ command, cwd: input?.cwd, env: process.env })
}

const denial = decide(await readHookInput())
if (denial !== null) process.stdout.write(JSON.stringify(preToolDeny(denial)))
