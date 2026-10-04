---
name: delegate
description: The operating manual for Flow's `flow_delegate` MCP tools and for T3 seats, the flow seats that run through T3 Code's `delegate_task`. Read it before the first bridge call or the first `delegate_task` call of a session, and for any question about cross-model or cross-family work, `delegate_to_codex`, `delegate_to_claude`, `delegation_result`, `delegation_steer`, a delegation job, a T3 seat, `scripts/seat.mjs` or a result envelope. Apply this when the user says "ask Sol", "ask Codex", "ask Fable" or "ask Claude".
---

# delegate: reaching the other model family

Outside T3 Code, one MCP server, `flow_delegate`, reaches the other family in both directions. Inside T3, every seat is a T3 seat instead, which `## T3 seats` covers, and `flow_delegate` is the cross-family fallback. A Claude host runs Codex through `codex app-server`, and a Codex host runs Claude through the stream-json control channel of `claude -p`, each as a job the server starts and watches. Each job opens the provider's session, checks your model and effort against the provider's catalog, reads back what the session can reach, and only then sends your prompt. The charter says when to cross the family line and what to do with a refusal. This skill says how the call works.

## The five tools

- `delegate_to_codex` on a Claude host, or `delegate_to_claude` on a Codex host, starts a job. It waits for the outcome unless you detach.
- `delegation_result` reads one job: its status, its outcome and its last event lines. With `waitSeconds` it blocks until the job ends or the wait runs out.
- `delegation_cancel` stops a queued or running job and kills its provider's whole process group.
- `delegation_steer` adds an instruction to a running job's turn without stopping the job.
- `delegation_doctor` reports whether the provider is installed and signed in, the usable workspace roots and the state directory. It also runs the provider's handshake with no turn, which proves the protocol the server speaks.

## Start a job

Set `model` and `effort` on every call. Claude takes an alias (`sonnet`, `opus`, `fable`) or a full id such as `claude-opus-5-5`, never a charter display name. Codex takes its own ids, such as `gpt-6-sol` or `gpt-6-luna`. `effort` is `low`, `medium`, `high`, `xhigh` or `max`. The doctor's `transport.catalog` lists the models and efforts the provider takes. The server accepts only the five efforts above, even when the catalog lists another.

The server checks both against the provider's own model catalog before the prompt goes out. If the catalog lists the model but not the effort, the job fails `BAD_MODEL` and costs no turn. On Claude Code 2.1.284, for example, `haiku` takes no effort level, so it fails at every effort. An id the catalog does not list still runs, and the envelope says `catalog: "absent"`.

`cwd` is an absolute directory inside a workspace root and inside a Git worktree. On Claude the roots are the session's MCP roots and `CLAUDE_PROJECT_DIR`. On Codex the one root is the directory the session started in, and only when that directory is a repository's top level and not your home. A worktree under `<repo>/.flow-worktrees/` sits inside its repository's root. A path outside every root, or a symlink that leads out of one, fails `OUTSIDE_ROOTS`.

`access` is `read-only` (the default) or `workspace-write`. A write job may edit its worktree and nothing else, and it holds that worktree's one write lease, so a second write job there fails `WORKSPACE_BUSY` while read-only jobs still run beside it. No Flow hook runs inside a delegated job, so the access level is the whole confinement. Never point a writer at a worktree that holds another seat's uncommitted work. The job sees no host MCP server, plugin or hook, so anything it needs that is not in the repository goes inline in `prompt`.

`mode` is `task` (the default) or `adversarial-review`. A review needs `base` and takes `head` (default `HEAD`). The server resolves both to commit SHAs before the job exists, so the diff under review cannot move. It writes the reviewer instruction itself, keeps your `prompt` as extra focus, forces read-only access and answers in the fixed findings schema.

`outputSchema` gets a typed answer from a task, parsed into `structured`. The root must be `type: "object"`, and the schema can be at most 64 KiB. Write closed objects with every property required, because Codex quietly narrows a schema outside that subset. The server checks the answer against your schema before the job can succeed, so it admits only the keywords it can check: `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, the numeric, length, item and property-count bounds, `pattern`, `uniqueItems`, `anyOf`, `oneOf`, `allOf`, `not`, and `$ref` into the schema's own `$defs`, plus annotations such as `description` and `format`. Any other keyword is refused as `BAD_SCHEMA`.

`continue` takes the id of a finished job and starts a new task on the same provider thread, in the same `cwd` and with the same access. A running job is refused with `JOB_STATE` and keeps running. Steer it with `delegation_steer`, or cancel it and continue it once it ends. A job whose outcome is `unknown` cannot be continued.

`timeBudgetSeconds` runs from 30 to 7200 and defaults to 900. A Claude target also takes `maxTurns` and `maxBudgetUsd`. Set them only when the human asks for a cap.

## Wait or detach

By default the call waits for the whole budget and returns the finished job. `waitSeconds: 0` returns as soon as the job starts. Collect it later with `delegation_result` and a `waitSeconds` of your own. A job keeps running when the session that started it ends, and any later session in the same workspace can collect it. If you interrupt a `delegate_to_*` call while it waits, the job is cancelled with it. An interrupted `delegation_result` wait leaves the job running.

On Claude Code, run a call beside other work through the `flow:bridge` seat. It returns the envelope when the job ends. Its definition fixes its model, so do not pass one. On Codex there is no transport seat. Detach with `waitSeconds: 0` and collect with `delegation_result`.

## Steer a running job

`delegation_steer` takes `jobId` and `prompt`, a non-empty instruction of at most 64 KiB. It puts the instruction into the job's open turn. The job keeps running, with the same id and the same thread, and nothing in flight is killed. Call it yourself, not through `flow:bridge`, because the bridge seat does not carry it.

The call waits up to 30 seconds for the job to answer, then returns the job and `steer: {id, status}`:

- `delivered` means the provider took the steer. Codex accepted `turn/steer` for the open turn, or Claude replayed the message.
- `failed` means the provider refused the steer, or the turn ended before the steer reached it. `steer.error` says which.
- `unknown` means the job never answered, or the provider had neither taken nor refused the steer yet. A Claude steer with no replay after 10 seconds is `unknown`, because the CLI may still take it. The job's `steers` entry changes to `delivered` at the replay, or to `failed` if the CLI exits first. An `unknown` steer is never a delivered one.

A job that is queued, has not sent its prompt yet, or has ended is refused with `JOB_STATE`, and nothing reaches it. A job refused before its prompt went out can be steered a moment later, once its turn is open.

On Codex the steer joins the running turn. On Claude it is the next user message, and the CLI either folds it into the running turn or runs it as the next turn. Either way the job's answer is the last one the provider gives, so it answers the steer too. To give a finished job more work, continue it instead.

## Read the envelope

Every tool answers `{ok, job?, error?}`, and the JSON text opens with a one-line `summary`. A refused call is `{ok: false, error}`. A job that ended badly is `{ok: false, job}` with the whole job in it. `job.status` is `queued`, `running`, `succeeded`, `failed`, `cancelled` or `unknown`.

`job.error.kind` is one of `BAD_REQUEST`, `BAD_SCHEMA`, `NO_ROOTS`, `OUTSIDE_ROOTS`, `WORKSPACE_BUSY`, `NESTED_DELEGATION`, `JOB_NOT_FOUND`, `JOB_STATE`, `GIT_REF`, `PROVIDER_NOT_INSTALLED`, `PROVIDER_AUTH`, `PROVIDER_ERROR`, `BAD_MODEL`, `APPROVAL_REQUIRED`, `REFUSAL`, `MODEL_MISMATCH`, `ISOLATION`, `SCHEMA_OUTPUT`, `EMPTY_OUTPUT`, `TIMEOUT`, `STALL`, `CANCELLED`, `RUNNER_LOST` or `INTERNAL`. A `REFUSAL` carries the provider's category in `details` when it names one.

- `output` is the final answer, and `structured` is the parsed answer when a schema applied.
- `SCHEMA_OUTPUT` means the answer did not parse, did not conform, or could not be checked against the schema within 10 seconds. `details.errors` lists up to ten `path: problem` lines when it did not conform, `structured` is null and `output` keeps the raw answer. A review is checked against the findings schema the same way.
- `servedModel` is the model the provider reported serving. On Codex it is the thread's model, or the model a `model/rerouted` notification moved the turn to. On Claude it is the model the `system/init` frame names. A session, a turn or an answer on any other model fails `MODEL_MISMATCH` and stops at once. `details` names the model expected and the model served, and on a Codex reroute the reason Codex gave. A Claude alias that the catalog lists must be served by the model it resolves to, so `opus` reports `claude-opus-5-5`.
- `catalog` is `listed` when the provider's catalog listed the model and `absent` when it did not. It is null when the job ended before the catalog was read, or failed `BAD_MODEL`.
- `BAD_MODEL` means the catalog lists the model but not the effort, or lists no effort levels for it. `details.efforts` names the efforts it takes.
- `ISOLATION` means a check of the live session failed. On Codex, the thread ran under another permission profile than the one flow named for it, that profile came back with a parent profile, network access or a writable root flow did not grant, or the thread left an MCP server reachable. On Claude, `mcp_status` reported an MCP server, or the `system/init` frame named a tool you did not ask for, an MCP server or a plugin other than the CLI's built-ins. A built-in passes only when its `path` is exactly `builtin` and its `source` is exactly `<name>@builtin`. `details` names what the check found.
- `isolation` is what the live session read back: `{profile, mcpServers, instructionSources}` on Codex and `{mcpServers, tools}` on Claude. `promptSent` is false when the job ended before the prompt left the server, so the provider ran no turn for it.
- `steers` lists every steer the job answered, in order, as `{id, at, status, error}`.
- `commandFailures` counts shell commands that failed. A succeeded job with a nonzero count answered without working shell evidence.
- `APPROVAL_REQUIRED` means the provider asked for more than the job grants. Its `output` is kept. Start a new job with the access the task needs.
- `eventsPath` is the provider's full JSONL journal. `delegation_result` includes the last 20 lines, each cut to 400 characters. Set `events` for more or fewer, and read the file itself for the rest.

A succeeded review with `findings: []` is not yet a pass. A reviewer that never looked answers in the same shape. Continue the finished job as a task and ask which files it read and which it skipped before you treat the empty array as clean. An `unknown` job is never a pass.

## Before the first call

Run `delegation_doctor` as the preflight. It answers without a workspace, which is what you need when the answer is that you have none. It starts the provider for a handshake that runs no turn, so it costs a second or two and no tokens. `ok` is true only when the provider is installed and signed in, its handshake passed, and a usable root exists.

The handshake's result is `transport`:

- `ok` and `error` say whether it passed. A failure is typed like a job's. The two common kinds are `ISOLATION` and `PROVIDER_ERROR`. `ISOLATION` means the session could reach an MCP server, or the Codex thread ran under another permission profile or a widened one. `PROVIDER_ERROR` means the CLI refused a step, answered in a shape the server does not know, stayed silent for 30 seconds, or exited.
- `protocol` lists the steps that passed, in order: `initialize`, `model/list`, `config/read`, `thread/start` and `mcpServerStatus/list` on Codex, and `initialize` and `mcp_status` on Claude. After a failure, the step that failed is the first one missing.
- `catalog` is the provider's model catalog: `{id, efforts}` on Codex, and `{id, resolvedModel, efforts}` on Claude, where `resolvedModel` is the model an alias runs.
- `profile` is the permission profile the Codex thread read back: `flow_delegation_` and a random suffix, a name no config layer can define first. It is null on Claude.
- `mcpServersDisabled` counts the MCP servers the session read back as disabled. On Codex these are the servers your Codex config defines. On Claude it is 0, because the CLI loads none.

Codex starts MCP servers before any hook runs, so on a new machine the flow skill's `setup` runs `node <plugin-root>/scripts/install-delegate.mjs install` once before the first Codex session. After that, the Codex SessionStart hook keeps `~/.local/bin/flow-delegate` current.

The server depends on these provider interfaces, checked against Codex CLI 0.159.0 and Claude Code 2.1.284 on 2026-09-30.

- Codex: `app-server --stdio` with `experimentalApi`, and the methods `initialize`, `model/list`, `config/read`, `thread/start`, `thread/resume`, `mcpServerStatus/list`, `turn/start`, `turn/steer` and `turn/interrupt`. The thread fields `permissions`, `runtimeWorkspaceRoots`, `allowProviderModelFallback` and `activePermissionProfile` appear only in the experimental schema.
- Claude: `-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`, `--model`, `--effort`, `--permission-mode dontAsk`, `--permission-prompts none`, `--setting-sources`, `--strict-mcp-config`, `--settings`, `--tools`, `--allowedTools`, `--session-id`, `--resume`, `--append-system-prompt-file`, `--json-schema`, `--max-turns` and `--max-budget-usd`, and the control requests `initialize`, `mcp_status` and `interrupt`. A steer is a user message with `priority: "next"`, acknowledged when the CLI replays its `uuid`. That field and the replay come from the Agent SDK's type definitions, and no live turn has shown them yet.

The doctor proves the handshake part of this list on every call. The rest runs only inside a turn. If the doctor passes on a newer CLI and jobs still fail with `PROVIDER_ERROR`, check `turn/start`, `turn/steer`, `turn/interrupt` and `thread/resume` against `codex app-server generate-ts --experimental --out <dir>`. For Claude, check `--model`, `--effort`, `--session-id`, `--resume`, `--append-system-prompt-file`, `--json-schema`, `--max-turns` and `--max-budget-usd` against `claude --help`.

## T3 seats

A T3 seat is a T3 Code child that `delegate_task` starts for a flow stage, held to the Seat Contract by flow's own hooks. It is neither a native seat (`Agent` or `spawn_agent`) nor a delegated job. Like a native seat, it runs with flow's hooks, the user's config, their credentials and the network. The hooks deny what the Seat Contract forbids and stamp each step they see. They are a guardrail under your authority, not a sandbox. A child that runs as the same user can edit its seat record through Bash. The shell rules catch the plain forms a confused seat writes. They do not catch a command that is quoted, escaped or expanded, run by `source`, run from a command substitution or built at run time, and they do not see a Bash write outside the worktree. Native seats (`flow:reader`, `flow:implementer` and Explore) run Bash with the same posture, under the git, publish and protect-files guards, which also load in a T3 child. A Codex T3 seat also runs in Codex's sandbox with the network off under `auto`. A read-only seat is read-only for Bash by instruction alone. `close` checks trees only for a review seat, the pinned review worktree and the canonical checkout.

### Inside T3

A session is inside T3 when `delegate_task` is in its tool list and `orchestrator_capabilities` answers for the current thread. Outside T3, nothing in this section applies.

Every `delegate_task` call in a flow session names `runtimeMode`, with or without a seat tag, and the hooks deny a call without one. A child copies its parent's mode at spawn, so a parent switched to full access would widen every later child. Pass the mode `seat open` prints, `auto` today. Never pass `full-access`, and never `inherit`, which brings the parent's mode back.

On Claude Code the T3 tools are `mcp__t3-code__<tool>`, and on Codex they are `mcp__t3_code__<tool>`.

### Open the seat

Run `seat open` once per seat:

```sh
node <plugin-root>/scripts/seat.mjs open --access <read-only|workspace-write|review> \
  --provider <claude|codex> --model <id> --effort <level> \
  [--worktree <absolute-path>] [--base <rev> --head <rev>] [--schema <absolute-file>]
```

- The seat's worktree is the top level of the Git worktree that `--worktree` names, or of the working directory when it names none.
- A writer (`workspace-write`) names its `--worktree`.
- A review names `--base` and `--head`. `open` resolves both to SHAs in `--worktree`, or in the working directory, and creates a detached worktree at the head under the canonical checkout's `.flow-worktrees/`. The seat reviews there.
- `--schema` is the JSON Schema for the envelope's `answer`, at most 16 KiB, admitted under the keyword rules of `outputSchema` above. A review answers in the findings schema and takes no `--schema`. The child's seat context repeats the schema only while the whole context stays within 6000 bytes, so that Codex's 6000-token hook limit never cuts it. Past that, the context names the absolute path of the record's `schema.json` and tells the child to read that file before it writes its final message.

`open` writes the seat record under the state directory and prints one JSON line:

```json
{"ok": true, "id": "<32 hex>", "tag": "<flow-seat id=<32 hex>>", "clientRequestId": "flow-seat-<32 hex>", "runtimeMode": "auto",
 "provider": "claude", "model": "<id>", "effort": "<level>", "worktree": "<path>", "reviewWorktree": null}
```

Copy its `tag`, `clientRequestId` and `runtimeMode` into the call below, and give a review seat the `worktree` the line names. A refused `open` prints `{"ok": false, "error": {"kind", "message", "details"?}}` and exits 1, with nothing left behind. The kinds are `BAD_REQUEST`, `BAD_SCHEMA`, `GIT_REF`, `WORKSPACE_BUSY`, `HOOKS_UNTRUSTED` and `INTERNAL`. `open` refuses a writer while a `flow_delegate` write job holds that worktree. Before a Codex-family seat, it reads Codex's hook trust and refuses the seat with `HOOKS_UNTRUSTED` unless every flow hook is listed, enabled and trusted, because Codex skips an untrusted hook without a word. Either host's flow copy may open a Codex-family seat. It counts as flow's hooks only those of `flow@<marketplace>`, the plugin id of the copy you run, and only when their `hooks/codex.json` matches that copy's byte for byte, so both hosts must carry one version of flow. The flow skill's `setup` grants that trust once per machine in two steps: `seat.mjs trust` lists flow's keys with a `digest` for the human to see, and `seat.mjs trust --write --expect <digest>` writes trust only for that list, refusing with `HOOKS_CHANGED` if the hooks changed since. A refused seat goes to the fallback.

### Start it

Call `delegate_task` with these fields:

- `task`: the seat tag alone on line 1, then the worktree, the checkpoints and the work. A tag below line 1 voids the seat.
- `role: "general"`, so T3 prepends nothing to the task.
- `runtimeMode`: the value `open` printed.
- `clientRequestId`: the value `open` printed, `flow-seat-<id>`. T3 builds the task's id from it, which is how `close` knows the task status is this seat's.
- `target`: the provider instance and `model` you gave `open`, as `orchestrator_capabilities` lists them, with the effort you gave `open` in `options` under the option id that call advertises for the model: `effort` on Claude and `reasoningEffort` on Codex, as `[{"id": "effort", "value": "high"}]` or `{"effort": "high"}`.
- `mode`: leave it at `async`, the default.

Your own PreToolUse hook admits a tagged call only when its `runtimeMode`, provider, model, effort and `clientRequestId` equal the record's and the record has not been admitted before.

The child's hooks then hold the seat. UserPromptSubmit binds the child's session to the record and tells it that the Seat Contract governs it. PreToolUse holds it to its access: no spawns, no MCP tool outside a short read-only allowlist, edits only inside a writer's worktree, and nothing at all once the seat is closed. In the shell it reads each command word, through `env`, `sudo`, `timeout`, `npx` and the other common wrappers, and through a `bash -c` string. It denies a model CLI, `seat.mjs`, any `gh` but its reads, a `gh api` with clustered short flags, git off the read allowlist, git with `-c`, a `GIT_*` variable, `--output`, `-O` or `--ext-diff`, `git stash` and `git push`. It also denies anything run in the background: a lone `&`, `setsid`, `disown`, `coproc` or `run_in_background`. A writer also runs `git add`, `rm`, `mv`, `commit`, `restore` and `apply`, each only as `git -C <worktree>`. Its commits and its `add -A` name their paths. The shell reads a quoted argument as missing, so tell a seat to write its git and gh arguments out. Stop checks the final message and blocks the child, at most 3 times, with the problems it found.

### The result envelope

The child's final message is one JSON object in the flow envelope:

```json
{"status": "done | partial | blocked",
 "coverage": {"read": [], "partial": [], "unopened": [], "checksRun": []},
 "notes": "",
 "answer": {}}
```

`answer` follows the schema you gave `open`. A writer adds `commits: [{sha, subject}]`. A review's `answer` is the findings schema that `adversarial-review` jobs use, and its `coverage` replaces the follow-up question a delegated review's `findings: []` needs. Say in the task that the final message is this envelope. Stop holds the child to it either way.

Writers in one worktree run at the same time on disjoint files, as native writers do. Each T3 writer commits its own paths with `git -C <worktree> commit -- <paths>`. Put that form in the writer's task: the child's shell starts in the canonical checkout, where a bare `git commit` would land on the wrong branch, so the hooks deny it. A Codex writer's sandbox keeps `.git` read-only, so its first `git add` asks for a wider write, which T3's `auto` mode grants through its auto-reviewer.

To give a finished seat another round, send it a message with `t3_thread_send` to its `childThreadId` before you close it. The child answers in a new turn, and Stop requires a fresh envelope for that turn. The child's UserPromptSubmit hook records the turn your message opened, so `close` judges that turn, and reads it `unknown` (`turn-without-result`) when no stop of it was recorded.

### Wait

A finished child wakes your thread, so end the turn instead of polling. Call `task_status` with the `taskId` only when you need the outcome mid-turn. Never take the answer from its `summary`: after a Stop block, `summary` is the child's last message, not its answer. `task_cancel` stops a seat you no longer need.

### Close it and act on the verdict

When `task_status` reports the task finished, pass that `task_status` answer to `close` as JSON. Finished means its `status` is `completed`, `failed`, `cancelled` or `interrupted`, its `workState` is not `working` or `waiting_for_children`, and `hasPendingChildRuns` is not `true`. `close` refuses any other answer, a running task or an empty object included, with `TASK_NOT_TERMINAL`, writes nothing, and keeps a writer's lease. It refuses an admitted seat's close the same way, with `TASK_MISMATCH`, when the answer's `taskId` does not carry the seat's `clientRequestId`, so pass the status of this seat's own task:

```sh
node <plugin-root>/scripts/seat.mjs close <seat-id> --task-status '<task_status JSON>'
```

`close` records the task status beside the verdict and prints one JSON line:

```json
{"ok": true, "id": "<32 hex>", "verdict": "valid", "reasons": [], "turn": 1, "result": {},
 "servedModels": ["<id>"], "blocks": 0, "errors": []}
```

`result` is the envelope the Stop hook recorded, and it is `null` for every verdict but `valid`. `reasons` says why the verdict is not `valid`, and `errors` holds the last turn's problem lines from Stop. A `cleanupProblems` list appears only when `close` did not remove a review worktree or a writer's lease holder. It removes a review worktree only while the path, its git directory and `git worktree list` still match what `open` recorded, and leaves anything else at that path alone. Act on the verdict alone:

| Verdict | Meaning | Action |
|---|---|---|
| `valid` | Every stamp is present and the result matches its recorded sha256. | Use the envelope. A writer's envelope is still a claim, so check its commits against git. |
| `invalid` | The hooks worked, and the last final message failed the envelope or the schema. | Rerun once with the errors on the same rung, then step up a rung. |
| `capped` | Stop blocked the child 3 times, then let it end. | Same as `invalid`. |
| `unknown` | A stamp is missing (`admitted`, `bound`, `receipt` or `result`), the seat is void, the record changed after the bind, the bound session's index entry is void (`session-index-void`) or missing or names another seat (`session-index-mismatch`), the latest turn a prompt opened has no stop on record (`turn-without-result`), the result does not match its sha256, the latest result names no served model of its own, or no served model is on record. Nothing proves the hooks held the seat. | Fall back. |
| `model-mismatch` | A model seen serving the seat, at the bind or at any stop in any turn, differs from the one you asked for. | Discard the answer. A mismatch is not a refusal, so the refusal rule does not count it. |
| `tree-moved` | The review worktree's HEAD left the head SHA or its tree is dirty, the canonical checkout's tree, HEAD commit or branch changed, or the coverage misses a file in the pinned diff. | Treat it as `unknown`. |

A seat that made no tool call has no `receipt`, so it reads `unknown`. On Codex, the served-model check covers the model the hooks saw at UserPromptSubmit and at Stop. On Claude, it reads every model the transcript records for the seat's own turns.

When the `delegate_task` call errors or returns no `taskId`, no `task_status` will ever name the seat. Close it with `--abandon` instead of `--task-status`:

```sh
node <plugin-root>/scripts/seat.mjs close <seat-id> --abandon
```

It records `unknown` with `abandoned-before-bind`, drops a writer's lease holder and removes a review worktree, as a normal `close` does. A child that starts after that is a void seat. `--abandon` refuses a seat whose child already bound it with `BAD_REQUEST` and writes nothing: that child ran, so its task exists, and you close it with its task status. If a child binds while the abandon runs, the reason is `abandon-raced-bind`. In that case `close` keeps the lease holder and the review worktree, says so in `cleanupProblems`, and denies every later tool call of the child. Find the child's task, wait for it to finish, then `close` it with `--task-status` to release them.

Close every seat you open, cancelled ones included. `close` records the verdict first, then drops a writer's lease holder and removes a review's worktree. A second `close` prints what the first recorded, verdict included. Its `result` is the recorded result while that file's bytes are unchanged, and `null` once they changed, with `result-changed-after-close` added to `reasons`. An unclosed T3 writer stays in the worktree's lease directory, and `flow_delegate` refuses a write job there with `WORKSPACE_BUSY` until the seat closes. A holder left by an `open` that died before writing its record holds for a minute, and then a write job drops it.

### Fall back

A seat whose `open` was refused, or whose verdict reads `unknown`, reruns outside T3's `delegate_task`:

- A cross-family seat reruns through `flow_delegate`.
- A same-family seat reruns as a native seat (`Agent` or `spawn_agent`), because `flow_delegate` reaches only the other family.

Route a family away from T3 only for a capability failure you saw, such as an untrusted Codex hook, and only while the hook configuration stays the same. One cancelled or invalid task does not move a whole family off T3.
