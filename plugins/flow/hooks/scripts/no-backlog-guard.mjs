#!/usr/bin/env node
// no-backlog guard: blocks `gh issue create` from Bash unless the caller carries a
// FLOW_SANCTION marker. Sanctioned lanes set it inline, e.g.:
//   FLOW_SANCTION=prep gh issue create ...      (the prep stage, the front door)
//   FLOW_SANCTION=land gh issue create ...      (escape-hatch filing after human ack)
// Policy: PRs ship complete; nothing enters the tracker except through the front door.
// PreToolUse protocol: read tool call JSON on stdin; deny via hookSpecificOutput JSON.

import { preToolDeny, readHookInput } from './wire.mjs'

// An unparseable body is the harness's problem, not a policy breach: never block on our own bug.
const input = await readHookInput()
const cmd = input?.tool_input?.command || ''
// Match `gh issue create` allowing flag/quote noise between the words, but not
// substrings of other commands. Cheap heuristic, deliberately narrow: false negatives
// are acceptable (the policy is also in the charter), false positives are not.
const creates = /\bgh\s+issue\s+create\b/.test(cmd)
const sanctioned = /\bFLOW_SANCTION=(prep|land)\b/.test(cmd)
if (creates && !sanctioned) {
  process.stdout.write(JSON.stringify(preToolDeny(
    'no-backlog policy (flow): only the prep stage, or land after the human acknowledges the filing, creates issues. ' +
    'Fix the finding in the current PR instead of filing it. In one of those two lanes, ' +
    'prefix the command with FLOW_SANCTION=prep or FLOW_SANCTION=land.',
  )))
}
