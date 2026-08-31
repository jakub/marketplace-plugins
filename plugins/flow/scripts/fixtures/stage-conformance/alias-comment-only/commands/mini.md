---
description: Fixture alias for the mini stage. Nothing loads it at runtime.
allowed-tools: Bash(gh:*), Read
---

# /flow:mini - the fixture alias

<!--
The stage itself lives in the `mini-stage` skill, so every host runs the same gates. Read
`${CLAUDE_PLUGIN_ROOT}/skills/mini-stage/profiles/claude.md` first, then
`${CLAUDE_PLUGIN_ROOT}/skills/mini-stage/SKILL.md`. Execute the stage against `$ARGUMENTS` under
the bindings that profile declares for each gate.
-->

Both paths are in this file and neither reaches a session, so a pair of substring searches calls
this alias routed and nothing runs the stage.
