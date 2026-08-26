#!/usr/bin/env node
// Codex cannot turn a PreToolUse hook result into an approval prompt. Direct publication
// therefore fails closed instead of returning unsupported permissionDecision: "ask".

import { preToolDeny, publishReason } from '../../lib/hook-policy.mjs'

let raw = ''
for await (const chunk of process.stdin) raw += chunk
let input
try { input = JSON.parse(raw) } catch { input = null }
const command = input?.tool_input?.command
if (typeof command !== 'string') {
  process.stdout.write(JSON.stringify(preToolDeny(
    'flow: Codex sent a Bash call without an inspectable command; refusing an operation whose publication status cannot be verified.',
  )))
} else {
  const reason = publishReason(command)
  if (reason) {
    process.stdout.write(JSON.stringify(preToolDeny(
      `${reason} Codex PreToolUse hooks cannot request confirmation, so direct publication is blocked. ` +
      'Run the publish command yourself after reviewing the version and package contents.',
    )))
  }
}
