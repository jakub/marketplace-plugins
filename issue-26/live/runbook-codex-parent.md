# Live runbook: Codex parent (issue #26 evidence)

You are a fresh T3 thread running on Codex, acting as the PARENT orchestrator for one live acceptance step of flow's "T3 seats" (issue #26). jakub authorized this run. Do exactly the steps below and nothing else. Do not edit any repository file. Write captures only under /tmp/flow-seat-probe/live/captures/. If a step fails, record the failure in its capture and stop.

IMPORTANT: write every capture with a shell command (e.g. `cat > FILE <<'EOF'` or `printf %s ... > FILE`). Never use code-mode functions.exec / btoa for captures; it is unavailable here.

Constants:
- SEAT = `node /home/jakub/.codex/plugins/cache/jakub/flow/0.42.0/scripts/seat.mjs` (run with cwd /home/jakub/code/marketplace-plugins)
- STATE = /home/jakub/.local/state/flow/seats

Steps (NN=52):
1. Run SEAT `open --access read-only --provider claude --model claude-sonnet-5-5 --effort medium --worktree /home/jakub/code/marketplace-plugins`. Save stdout to /tmp/flow-seat-probe/live/captures/52-open.json.
2. Call the T3 MCP tool delegate_task (it appears as mcp__t3_code__delegate_task) with: task = the open output's `tag` on line 1, a newline, then: "You are a flow T3 seat in a live acceptance test. (1) Try the Agent tool once with a trivial task and note the result. (2) Try mcp__t3-code__orchestrator_capabilities once and note the result. (3) Read plugins/flow/delegate/schema.mjs and set answer to {\"lines\": <line count>}. (4) Finish with ONE JSON object as your entire final message, in the flow envelope your seat context describes; put the two attempt results in notes."; role "general"; runtimeMode = the open output's runtimeMode; target {providerInstanceId: "claudeAgent", model: "claude-sonnet-5-5", options: {effort: "medium"}}; mode "wait"; timeoutMs 900000; clientRequestId "issue26-live-52"; title "issue26 live 52". Save the full response to captures/52-delegate.json.
3. Call task_status (mcp__t3_code__task_status) with the taskId; save to captures/52-status.json.
4. Run SEAT `close <id> --task-status '<that task_status JSON>'`; save stdout to captures/52-close.json.
5. `cp -a STATE/<id> /tmp/flow-seat-probe/live/captures/52-record`.
6. Reply with one line: the close verdict, the bound permissionMode, and the served models.
