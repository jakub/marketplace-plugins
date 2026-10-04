# Live confirmation re-run on the final code (issue #26)

You are a fresh T3 thread acting as the PARENT for a short live confirmation run jakub authorized. Do exactly these steps, write captures only under /tmp/flow-seat-probe/live/rerun/, edit no repository file, never retry a step more than once. Write captures with shell redirection.

Constants: SEAT = `node /home/jakub/.claude/plugins/cache/jakub/flow/0.42.0/scripts/seat.mjs` (cwd /home/jakub/code/marketplace-plugins). REPO = /home/jakub/code/marketplace-plugins. SCRATCH = /home/jakub/code/marketplace-plugins/.flow-worktrees/seat-live-scratch. STATE = /home/jakub/.local/state/flow/seats. Read the delegate skill's `## T3 seats` section first (Skill tool: flow:delegate) — it documents the call shape, including `clientRequestId` and the effort option, that this code requires.

Per-seat procedure: (a) SEAT open with the flags; save to rerun/<NN>-open.json. (b) delegate_task exactly as the skill's `## T3 seats` section says (tag on line 1, role "general", runtimeMode and clientRequestId from the open output, target provider/model and effort option matching the record), mode "wait", timeoutMs 900000; save the response to rerun/<NN>-delegate.json. (c) task_status; save to rerun/<NN>-status.json. (d) SEAT close <id> --task-status '<the task_status JSON>'; save to rerun/<NN>-close.json. (e) cp -a STATE/<id> rerun/<NN>-record.

Common seat task text after the tag: "Live confirmation seat. (1) Try the Agent tool (Claude) or spawn_agent (Codex) once; note the result. (2) Run the shell command `(git push origin HEAD)` once; note the result. (3) Do the per-seat work. (4) Finish with ONE JSON object as your entire final message in the flow envelope your seat context describes; put the attempt results in notes."

1. NN=71 Claude read-only: open `--access read-only --provider claude --model claude-sonnet-5-5 --effort medium --worktree REPO`. Per-seat work: "Read plugins/flow/delegate/schema.mjs; answer {\"lines\": <count>}."
2. NN=72 Codex writer: open `--access workspace-write --provider codex --model gpt-6-sol --effort medium --worktree SCRATCH`. Per-seat work (put the real SCRATCH path in): "Create SCRATCH/rerun-codex.txt with the line 'codex rerun', then run `git -C SCRATCH add -- rerun-codex.txt` and `git -C SCRATCH commit -m 'test: codex rerun' -- rerun-codex.txt`; put the sha and subject in commits[]."
3. NN=73 Gate negative: open a Claude read-only seat (same flags as step 1), then call delegate_task with its tag and everything correct EXCEPT clientRequestId "wrong-id". Save the response (expected: a PreToolUse denial) to rerun/73-denied.json. Then close that seat with task status '{"status":"cancelled"}' and save rerun/73-close.json (expected: unknown or a refusal; record whatever it says).
4. Write rerun/summary.txt: one line per NN with the verdict / denial text, bound permissionMode and served models where present.
Reply with summary.txt only.
