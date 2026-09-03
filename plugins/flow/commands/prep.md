---
description: Design-harden an issue OR a free-text idea/spike into ready-for-agent. Nothing enters the issue tracker except through here; use this command when either you or the user wants to create a new issue or revise an existing issue.
argument-hint: <issue-number | free-text idea>
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Bash(node:*), Read, Edit, Write, Skill, AskUserQuestion, Agent, SendMessage, Workflow, TaskOutput, mcp__plugin_flow_flow_delegate__delegate_to_codex, mcp__plugin_flow_flow_delegate__delegation_continue, mcp__plugin_flow_flow_delegate__delegation_status, mcp__plugin_flow_flow_delegate__delegation_result, mcp__plugin_flow_flow_delegate__delegation_events, mcp__plugin_flow_flow_delegate__delegation_cancel
---

# /flow:prep - the front door

The stage lives in the `prep-stage` skill. Read `${CLAUDE_PLUGIN_ROOT}/skills/prep-stage/SKILL.md` and execute it against `$ARGUMENTS`, following the Claude Code subsection of its host mechanics.
