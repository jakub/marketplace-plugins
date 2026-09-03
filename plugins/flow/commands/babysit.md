---
description: Watch one open PR through external review and CI to green - validate findings, fix, reply, rebase - then hand it to the land stage.
argument-hint: [<pr-number>]
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Bash(node:*), Read, Edit, Write, Agent, TaskOutput, TaskStop, SendMessage, Monitor, PushNotification, AskUserQuestion, Skill, mcp__plugin_flow_flow_delegate__delegate_to_codex, mcp__plugin_flow_flow_delegate__delegation_status, mcp__plugin_flow_flow_delegate__delegation_result, mcp__plugin_flow_flow_delegate__delegation_events, mcp__plugin_flow_flow_delegate__delegation_cancel, mcp__plugin_flow_flow_delegate__delegation_steer, mcp__plugin_flow_flow_delegate__delegation_continue
---

# /flow:babysit - the watch between push and land

The work lives in the `babysit` skill. Read `${CLAUDE_PLUGIN_ROOT}/skills/babysit/SKILL.md` and execute it against `$ARGUMENTS`, following the Claude Code subsection of its host mechanics.
