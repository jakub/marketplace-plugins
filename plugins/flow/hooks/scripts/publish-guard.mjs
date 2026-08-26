#!/usr/bin/env node
// publish-guard: ask before a command that publishes to a public registry.
//
// The rule is not about cargo - it is that these registries have no unpublish. crates.io refuses
// outright; npm allows it for 72 hours and only if nothing depends on you. A wrong version
// number is permanent, and the fix is always a new release rather than a retraction.
//
// `ask`, not `deny`: publishing is a thing you legitimately do, so this is the gate the
// charter asks for on anything that leaves the machine, not a ban.
//
// Deliberately NOT here: `docker push`. That usually means a private registry where a retag
// costs nothing, and gating it would be friction with no irreversibility behind it. `gh release create` is likewise absent - a release deletes cleanly.

import { publishReason } from '../../lib/hook-policy.mjs'

let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let cmd = ''
  try {
    cmd = JSON.parse(raw)?.tool_input?.command || ''
  } catch {
    process.exit(0)
  }
  if (!cmd) process.exit(0)

  const reason = publishReason(cmd)
  if (reason) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: reason,
        },
      }),
    )
  }
  process.exit(0)
})
