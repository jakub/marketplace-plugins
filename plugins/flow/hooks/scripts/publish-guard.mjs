#!/usr/bin/env node
// Claude publish guard: the Claude adapter over lib/hook-policy.mjs, which holds both rules.
//
// 1. Registry publication is an `ask`, not a `deny`: publishing is a thing you legitimately do,
//    so this is the gate the charter asks for on anything that leaves the machine. Codex has no
//    ask, which is why its adapter denies the same commands. Deliberately absent: `docker push`
//    (usually a private registry, where a retag costs nothing) and `gh release create` (a release
//    deletes cleanly).
// 2. A pull request merge in a repository that opts in is denied, not asked about: an approved
//    ask would run the raw command, and the point is routing it to scripts/land-merge.mjs.
//
// The merge decision runs first, so one approval of a publication can never carry a merge in
// the same command past the executor. An unparseable body decides nothing: the Claude adapters
// fail open on their own input, and never block on our own bug.

import { mergeDenialFor, publishReason } from '../../lib/hook-policy.mjs'
import { preToolAsk, preToolDeny, readHookInput } from './wire.mjs'

const decide = (input) => {
  const command = input?.tool_input?.command
  if (typeof command !== 'string' || command === '') return null

  const merge = mergeDenialFor({ command, cwd: input?.cwd, env: process.env })
  if (merge !== null) return preToolDeny(merge)

  const registry = publishReason(command)
  return registry ? preToolAsk(registry) : null
}

const answer = decide(await readHookInput())
if (answer) process.stdout.write(JSON.stringify(answer))
