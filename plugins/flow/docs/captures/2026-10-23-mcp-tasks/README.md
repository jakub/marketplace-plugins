# MCP tasks capture, issue #34

Raw bidirectional stdio frames between two MCP clients and flow's delegate server, taken for the acceptance criteria of issue #34 (flow_delegate jobs served as MCP tasks under protocol 2026-07-28). `HEAD.txt` names the server SHA, the tree state and the CLI versions of the final take. Everything here was taken on fractal on 2026-10-24 UTC (the evening of 2026-10-23 local).

## How it was taken

- `harness/tee.mjs` sits between the client and `plugins/flow/delegate/main.mjs mcp --host <host>` and appends one JSON line per frame to the arm's `.jsonl`: `dir` (`client->server`, `server->client` or `meta`), wall-clock `t`, `ms` since the server started, and the `frame`. It redacts `prompt`, `requestPreview`, `output`, `text` and `message` values, so no prompt text or model output is in a `.jsonl`; the envelope's `summary` line and the `.out` turn logs quote the request too, and `assemble.sh` redacts those with the same marker when it copies the files. A `meta` line records the environment the server saw and its exit code.
- `harness/make-fake.mjs` builds the fake `codex` and `claude` binaries from the `FAKE` template in `scripts/smoke-delegate.mjs`; `FLOW_FAKE_MODE=happy` answers at once and `FLOW_FAKE_MODE=hang` never answers. They sit first on the server's `PATH` through the `env` in `harness/mcp-*.json`, so no real model ran in arms (a) to (d).
- `harness/drive.mjs` runs `claude -p --input-format stream-json --output-format stream-json --verbose --model sonnet --strict-mcp-config --settings harness/settings-plain.json` with every `CLAUDE*` variable stripped, `CLAUDE_AUTO_BACKGROUND_TASKS=1` for the flagged arms, and writes the model's turns to the arm's `.out`. A 7th argument ending in `.txt` is a second user message sent after the first result.
- `harness/arm-d.sh` runs `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox` with the tee configured through `-c mcp_servers.flowtasks.*` and the user's other servers disabled, once against the PR's server and once against the base server (`git archive b92afec plugins/flow`).
- The disposable repository and the tee live under the issue worktree's `.flow-scratch/capture/`, not `/tmp`, because the issue stage keeps run files there. `harness/run-all.sh` re-takes arms (a) to (d) against the worktree's current head and `harness/assemble.sh` copies this directory.

Reproduce: check out `HEAD.txt`'s SHA, run `harness/make-fake.mjs` into a `bin/`, point the `mcp-*.json` paths at your checkout, and run `harness/run-all.sh`.

## Arms at the final head

Server SHA, tree state and versions: `HEAD.txt`. Client: Claude Code 2.1.309 for (a), (b), (c), (e); Codex 0.164.0 for (d). Launch settings per arm are the `drive.mjs` arguments in `harness/run-all.sh`.

### (a) `arm-a.jsonl`, `arm-a.out`: flagged main thread, happy job

`CLAUDE_AUTO_BACKGROUND_TASKS=1`, prompt `harness/prompt-a.txt`, no `waitSeconds`. Observed: `server/discover` with the tasks extension declared in `_meta` at 7 ms, `tools/list` at 40 ms, `tools/call` at 5.59 s with the extension declared, `resultType: task` with `status: working` 7 ms later, `tasks/get` 7 ms after that (`working`), the next `tasks/get` 1005 ms later (`completed` with the envelope). Post-completion polls: not observed. The model saw the server task id and the client task id in the background stub ("started server-side task <job id> ... moved to the background as task <id>") before the job finished, and quoted the envelope after the completion notification. A server-written request: not observed.

### (b) `arm-b.jsonl`, `arm-b.out`: flagged main thread, hanging job, then `TaskStop`

Prompt `harness/prompt-b.txt` (`FLOW_FAKE_MODE=hang`, `timeBudgetSeconds` 120), then `harness/prompt-b2.txt` in a second turn asking for `TaskStop`. Observed: the same discover and call shape, then `tasks/get` about every 1000 ms, six polls, then `TaskStop` at 9.7 s produced two `tasks/cancel` frames 0.1 ms apart, both acknowledged with the empty result within 0.5 ms. The job ended `cancelled` with a cancel marker. A `tasks/get` after the cancel: not observed. The `TaskStop` result the model saw names only the client task id.

Take history. Take 1 (at 3ad170d) sent a stream-json `control_request interrupt` at 12 s; it landed while the tool call awaited its start, Claude rejected the tool use, no job and no task existed, and `tasks/cancel` was not observed. Take 2 (at 3ad170d) created the task and then the driver closed stdin at the first result; Claude exited, reported the task `stopped` in its own stream, sent no `tasks/cancel`, and the server died with the client, leaving the job `running` with no marker (a later server start settled it `failed/TIMEOUT`). Take 2's frames were not retained. Take 3 (at 3ad170d) was the `TaskStop` design above; it showed eleven polls, one 1383 ms gap where the server took 382 ms to answer, and the same two `tasks/cancel` frames. Its frames were overwritten by a later re-take and are not retained; `takes/36eb98f/arm-b.jsonl` shows eleven polls and the same cancel pair, and `takes/b993d39/arm-b.jsonl` eight.

### (c) `arm-c.jsonl`, `arm-c.out`: `Agent` subagent lane

Prompt `harness/prompt-c.txt`: the main thread spawns one `general-purpose` subagent that makes the call. Observed: discover and `tools/list` from the main thread carry the extension; the subagent's `tools/call` at 7.79 s carries modern `_meta` with `clientCapabilities` but no tasks extension, the server sends `notifications/progress` at 8.05 s and the synchronous `resultType: complete` envelope right after. `resultType: task` from a subagent: not observed.

### (d) `arm-d-pr.jsonl`, `arm-d-base.jsonl`, `arm-d-*.last.txt`: Codex 0.164.0 legacy control

Prompt `harness/prompt-d.txt` (`waitSeconds: 0`, so a queued envelope). Both runs: `initialize` with `protocolVersion: 2025-06-18`, the server's `initialize` result with the same version, `notifications/initialized`, `tools/list`, one `tools/call`, the queued envelope. Codex puts a `_meta` on `tools/list` (`progressToken`) and `tools/call` (`callId`, turn metadata) without a protocol version key, so both are legacy requests. Server frames compared PR against base with ids, timestamps and the job's own fields removed: `initialize` result identical, `tools/call` result identical, `tools/list` result differs only in the `delegate_to_claude` description's new task clause, the one tools/list deviation the issue names. `server/discover`, any `tasks/*` and any `-32021`: not observed, because Codex never sends them.

Take history. Take 1 hung because `codex exec` reads extra prompt text from stdin until EOF; take 2 reached the legacy handshake but stopped at "MCP tool call requires approval, but approval policy is never" and, on the base run, the model picked the installed `flow_delegate` server; take 3 bypassed approvals and named the server in the prompt, and the base run then failed to start because `git archive` had extracted only three directories (`serverExit: 1` in the meta lines). The final take extracts all of `plugins/flow`; the `takes/*/arm-d-*.jsonl` runs at 36eb98f and b993d39 have the same shape and the same single difference.

### (e) `arm-e.md`: a launched T3 thread on a worktree

Thread launched with `t3_thread_launch`, `workspaceStrategy: worktree`, Claude Haiku 5.5 high. The report holds `pwd`, the installed server's `CLAUDE_PROJECT_DIR` read from `/proc/<pid>/environ` (equal to the worktree path), the installed legacy doctor's `roots` (worktree plus the attachments root from `roots/list`), and `harness/doctor-probe.mjs` run against the PR's server with that value: `rootsSource: fixed`, `roots: [<worktree path>]`. The probe ran against the server at 3ad170d, before the fix round, which changed no root code; `doctor-probe.mjs` reruns it against any SHA.

## Earlier takes

`takes/36eb98f/` and `takes/b993d39/` hold the takes of arms (a) to (d) at the two heads before the final one, each a complete run of the same harness. The 3ad170d frames were overwritten when the first version of `run-all.sh` moved the previous take aside under fixed names, and survive only in the take-history notes above; the script now files a take under `takes/<head>/`. Between 3ad170d and the final head the server changed only in `tasks/cancel`'s decision path and in `context()`'s metadata validation; `smoke-all.log` is the full smoke run at the final head.
