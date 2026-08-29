---
description: Land a PR - CI + unresolved-thread gates, escape-hatch ack, squash-merge, close issues explicitly, retire worktree, survey next moves. The only merge path.
argument-hint: <pr-number | empty for current branch>
allowed-tools: Bash(gh:*), Bash(git:*), Bash(docker:*), Bash(ls:*), Read, Edit, AskUserQuestion
---

# /flow:land - the human gate

The stage itself lives in the `land-stage` skill, so every host runs the same gates. Read `${CLAUDE_PLUGIN_ROOT}/skills/land-stage/profiles/claude.md` first, then `${CLAUDE_PLUGIN_ROOT}/skills/land-stage/SKILL.md`. Execute the stage against `$ARGUMENTS` under the bindings that profile declares for each gate.
