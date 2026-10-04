# Live runbook: Claude parent (issue #26 evidence)

You are a fresh T3 thread acting as the PARENT orchestrator for a live acceptance run of flow's "T3 seats" (issue #26). jakub authorized this run. The branch build of flow is installed in both plugin caches for this test window; you loaded it at session start. Do exactly the steps below, in order, and nothing else. Do not edit any repository file. Write captures only under /tmp/flow-seat-probe/live/captures/. If a step fails, record the failure in its capture and continue with the next step; never retry a step more than once.

Tools: Bash, and the t3-code MCP tools `delegate_task` and `task_status`, and `t3_thread_send`/`t3_thread_read` for step 8. Load T3 tools with ToolSearch as needed.

Constants:
- SEAT = `node /home/jakub/.claude/plugins/cache/jakub/flow/0.42.0/scripts/seat.mjs`
- REPO = /home/jakub/code/marketplace-plugins (run SEAT with cwd REPO)
- SCRATCH = /home/jakub/code/marketplace-plugins/.flow-worktrees/seat-live-scratch (a throwaway git worktree on branch scratch/issue26-seat-live)
- STATE = /home/jakub/.local/state/flow/seats
- Review range: base 2c77e49b6a22741ff2ee41a4cb0aad32802ef542, head 87015df (7 files)

## Per-seat procedure (steps 1-6 use it)
a. Run SEAT `open` with the flags given. Save its stdout JSON to captures/<NN>-open.json. If ok is false, stop this seat (capture shows why) and go on.
b. Call `delegate_task` with: `task` = the open output's `tag` on line 1, then a newline, then the seat task text given below; `role: "general"`; `runtimeMode` = the open output's `runtimeMode`; `target` = {providerInstanceId: "claudeAgent" for claude / "codex" for codex, model: the model you passed to open, options: {effort: <effort>} for claude or {reasoningEffort: <effort>} for codex}; `mode: "wait"`; `timeoutMs: 900000`; `clientRequestId: "issue26-live-<NN>"`; `title: "issue26 live <NN>"`. Save the full delegate_task response to captures/<NN>-delegate.json.
c. Call `task_status` with the taskId. Save it to captures/<NN>-status.json.
d. Run SEAT `close <id> --task-status '<the task_status JSON>'` (pass the JSON exactly). Save stdout to captures/<NN>-close.json.
e. Copy the seat record directory: `cp -a STATE/<id> /tmp/flow-seat-probe/live/captures/<NN>-record` (stamps, state.json, results).

Seat task text, common to all seats (append the per-seat line after it):
"You are a flow T3 seat in a live acceptance test. Do these in order: (1) try to call the Agent tool (Claude) or spawn_agent (Codex) once with a trivial task, and note the result; (2) try to call the MCP tool mcp__t3-code__orchestrator_capabilities (Claude) or mcp__t3_code__orchestrator_capabilities (Codex) once, and note the result; (3) do the per-seat work below; (4) finish with ONE JSON object as your entire final message, in the flow envelope your seat context describes (status, coverage, notes, answer). Put the two attempt results in notes."

## Steps
1. NN=11 Claude read-only: open `--access read-only --provider claude --model claude-sonnet-5-5 --effort medium --worktree REPO`. Per-seat work: "Read plugins/flow/delegate/schema.mjs and set answer to {\"lines\": <line count>, \"exports\": [<exported names>]}." (No schema flag: answer may be any object.)
2. NN=12 Claude writer: open `--access workspace-write --provider claude --model claude-sonnet-5-5 --effort medium --worktree SCRATCH`. Per-seat work: "In the worktree SCRATCH, create the file live-claude.txt containing the line 'claude writer seat', then commit only that file with exactly: git -C SCRATCH commit -m 'test: claude writer seat' -- live-claude.txt (after git -C SCRATCH add live-claude.txt). Also try a bare `git commit -m x` once (expect a denial) and note it. Put the commit sha and subject in commits[]." Replace SCRATCH with the real path in the text you send.
3. NN=13 Claude review: open `--access review --provider claude --model claude-sonnet-5-5 --effort medium --worktree REPO --base 2c77e49b6a22741ff2ee41a4cb0aad32802ef542 --head 87015df`. Per-seat work: "Review the diff between the base and head named in your seat context, reading the files in the review worktree your seat context names. answer = {\"findings\": [...]} per the findings schema (an empty array if you find nothing real). coverage must list every changed file in read, partial or unopened."
4. NN=21 Codex read-only: same as step 1 with `--provider codex --model gpt-6-luna --effort medium`.
5. NN=22 Codex writer: same as step 2 with `--provider codex --model gpt-6-sol --effort medium`, file live-codex.txt, line 'codex writer seat', commit message 'test: codex writer seat'.
6. NN=23 Codex review: same as step 3 with `--provider codex --model gpt-6-sol --effort medium`.
7. NN=31 Fallback through flow_delegate: call the flow_delegate MCP tool `delegate_to_codex` (load it with ToolSearch) with cwd REPO, model gpt-6-luna, effort medium, access read-only, prompt "Fallback rerun for a refused T3 seat (issue #26 live check). Read plugins/flow/delegate/schema.mjs; reply with its line count and exported function names in two lines." Save the full response to captures/31-flow-delegate.json.
8. NN=41 Critique continuation: open a Claude read-only seat (same flags as step 1), delegate_task with per-seat work "Set answer to {\"round\": 1}.", wait for it. Then, BEFORE closing, call `t3_thread_send` to the delegate_task response's childThreadId with message "Second round: produce a new final envelope with answer {\"round\": 2}." (use mode "auto"; if the tool refuses, save the refusal and skip to closing). Wait for that run (t3_thread_wait on the child thread, or task_status until terminal). Then task_status + close as in c-d, copy the record as in e. Save every response under captures/41-*.json. In captures/41-notes.txt write one line: whether t3_thread_send reached the finished child, and whether state.json shows turn 2 with a valid result.
9. Write captures/summary.txt: one line per NN with the close verdict (or the open error kind), and the bound stamp's permissionMode and the served models from close.

When done, reply with the contents of summary.txt and 41-notes.txt only.
