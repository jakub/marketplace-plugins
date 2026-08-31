---
description: Hands-off implementation of a ready-for-agent issue, through a pushed, reviewed, evidenced PR.
argument-hint: <issue-number>
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Bash(node:*), Read, Write, Workflow, TaskOutput, TaskStop, PushNotification, Agent, SendMessage, AskUserQuestion, Skill, mcp__plugin_flow_flow_delegate__delegate_to_codex, mcp__plugin_flow_flow_delegate__delegation_status, mcp__plugin_flow_flow_delegate__delegation_result, mcp__plugin_flow_flow_delegate__delegation_events, mcp__plugin_flow_flow_delegate__delegation_list, mcp__plugin_flow_flow_delegate__delegation_cancel, mcp__plugin_flow_flow_delegate__delegation_steer, mcp__plugin_flow_flow_delegate__delegation_continue, mcp__plugin_flow_flow_delegate__delegation_models, mcp__plugin_flow_flow_delegate__delegation_doctor
---

# /flow:issue - the autonomous middle

The stage itself lives in the `issue-stage` skill, so every host runs the same gates. Read `${CLAUDE_PLUGIN_ROOT}/skills/issue-stage/profiles/claude.md` first, then `${CLAUDE_PLUGIN_ROOT}/skills/issue-stage/SKILL.md`. Execute the stage against `$ARGUMENTS` under the bindings that profile declares for each gate.
