#!/usr/bin/env node
// Codex protected-file adapter. As of Codex CLI 0.149.1 (2026-08-26) edits arrive as
// apply_patch with the full patch under tool_input.command; the registration also
// matches Edit/Write so an alias route, if one exists, cannot bypass the check.

import { applyPatchPaths, preToolDeny, protectedFileReason } from '../../lib/hook-policy.mjs'

let raw = ''
for await (const chunk of process.stdin) raw += chunk

let input
try { input = JSON.parse(raw) } catch { input = null }
// The matcher also covers Edit/Write-style aliases. If one fires with a plain
// file_path instead of a patch envelope, check that path directly.
const filePath = input?.tool_input?.file_path
if (typeof filePath === 'string' && filePath) {
  const reason = protectedFileReason(filePath)
  if (reason) process.stdout.write(JSON.stringify(preToolDeny(reason)))
  process.exit(0)
}
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
