#!/usr/bin/env node
// Codex apply_patch adapter. Codex matches Edit/Write aliases but sends the full patch
// under tool_input.command, so target extraction belongs here rather than in policy.

import { applyPatchPaths, preToolDeny, protectedFileReason } from '../../lib/hook-policy.mjs'

let raw = ''
for await (const chunk of process.stdin) raw += chunk

let input
try { input = JSON.parse(raw) } catch { input = null }
const command = input?.tool_input?.command
if (typeof command !== 'string') {
  process.stdout.write(JSON.stringify(preToolDeny(
    'flow: Codex sent an apply_patch call without an inspectable command; refusing an edit whose target paths cannot be verified.',
  )))
} else {
  const parsed = applyPatchPaths(command)
  if (!parsed.complete) {
    process.stdout.write(JSON.stringify(preToolDeny(
      'flow: could not enumerate every target in this apply_patch call; refusing an edit whose protected-file status cannot be verified.',
    )))
  } else {
    for (const path of parsed.paths) {
      const reason = protectedFileReason(path)
      if (reason) {
        process.stdout.write(JSON.stringify(preToolDeny(reason)))
        break
      }
    }
  }
}
