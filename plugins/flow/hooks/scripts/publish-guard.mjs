#!/usr/bin/env node
// Claude publish guard. Two jobs, and they are not the same job.
//
// 1. Registry publication: ask before a command that publishes to a public registry. The rule
//    is not about cargo - it is that these registries have no unpublish. crates.io refuses
//    outright; npm allows it for 72 hours and only if nothing depends on you. A wrong version
//    number is permanent, and the fix is always a new release rather than a retraction.
//
//    `ask`, not `deny`: publishing is a thing you legitimately do, so this is the gate the
//    charter asks for on anything that leaves the machine, not a ban. Codex has no ask, which
//    is why its guard denies the same commands.
//
//    Deliberately NOT here: `docker push`. That usually means a private registry where a retag
//    costs nothing, and gating it would be friction with no irreversibility behind it. `gh release create` is likewise absent - a release deletes cleanly.
//
// 2. Pull request merges, in a repository that opts in. Identical on both hosts, so the whole
//    decision and the reasoning behind it live in lib/hook-policy.mjs above mergeDenialFor().
//    Read it there; this file only puts the answer on the wire. A merge is denied rather than
//    asked about because the point is routing it to scripts/land-merge.mjs, and an approved ask
//    would run the raw command instead.

import { mergeDenialFor, publishReason } from '../../lib/hook-policy.mjs'
import { preToolDeny } from './wire.mjs'

// The merge decision runs first. A command that both publishes and merges would otherwise be
// asked about once and then run whole, and one approval must not carry a merge past the
// executor. A registry publish is never merge-shaped, so no publication changed its answer.
const decide = (input) => {
  const command = input?.tool_input?.command
  if (typeof command !== 'string' || command === '') return null

  const merge = mergeDenialFor({ command, cwd: input?.cwd, env: process.env })
  if (merge !== null) return { decision: 'deny', reason: merge }

  const registry = publishReason(command)
  return registry ? { decision: 'ask', reason: registry } : null
}

let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  const answer = decide(input)
  if (answer?.decision === 'deny') process.stdout.write(JSON.stringify(preToolDeny(answer.reason)))
  else if (answer?.decision === 'ask') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: answer.reason,
        },
      }),
    )
  }
  process.exit(0)
})
