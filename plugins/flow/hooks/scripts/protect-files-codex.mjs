#!/usr/bin/env node
// Codex protected-file adapter. As of Codex CLI 0.149.1 (2026-08-26) edits arrive as
// apply_patch with the full patch under tool_input.command; the registration also
// matches Edit/Write so an alias route, if one exists, cannot bypass the check.
//
// Every target-bearing field present is checked - a benign file_path must not vouch
// for a patch riding in the same envelope. One decision per invocation, first deny
// wins, and the process exits naturally so stdout always drains.

import { protectedFileReason } from '../../lib/hook-policy.mjs'
import { applyPatchPaths, preToolDeny } from './wire.mjs'

let raw = ''
for await (const chunk of process.stdin) raw += chunk

let decided = false
const deny = (reason) => {
  if (decided) return
  decided = true
  // The reason can embed a request-controlled path; cap it so the decision JSON
  // stays small enough to always arrive whole.
  process.stdout.write(JSON.stringify(preToolDeny(String(reason).slice(0, 1024))))
}

let input
try { input = JSON.parse(raw) } catch { input = null }
const filePath = input?.tool_input?.file_path
const command = input?.tool_input?.command
const hasFilePath = typeof filePath === 'string' && filePath !== ''

if (hasFilePath) {
  const reason = protectedFileReason(filePath)
  if (reason) deny(reason)
}

if (typeof command === 'string') {
  const parsed = applyPatchPaths(command)
  if (!parsed.complete) {
    deny('flow: could not enumerate every target in this apply_patch call; refusing an edit whose protected-file status cannot be verified.')
  } else {
    for (const path of parsed.paths) {
      const reason = protectedFileReason(path)
      if (reason) {
        deny(reason)
        break
      }
    }
  }
} else if (!hasFilePath) {
  deny('flow: Codex sent an edit call with neither an inspectable command nor a file path; refusing an edit whose target cannot be verified.')
}
