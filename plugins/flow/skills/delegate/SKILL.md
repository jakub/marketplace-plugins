---
name: delegate
description: How to run a seat on another model, through flow_delegate jobs or T3 seats. Read it before your first delegate_to_codex, delegate_to_claude or delegate_task call in a session. Use when the user says "ask Sol", "ask Codex", "ask Fable" or "ask Claude".
---

# delegate

The charter says when to cross the family line. This page says how.

There are two routes:

- **In T3 Code**, route each seat the way T3's own prompt says. A seat that goes through `delegate_task` is a T3 seat, a child that flow's own hooks hold to the Seat Contract. See "T3 seats" below. `flow_delegate` is the cross-family fallback.
- **Everywhere else**, `flow_delegate` reaches the other family. It drives Codex from a Claude host through `codex app-server`, and Claude from a Codex host through `claude -p`'s stream-json channel. Same-family seats are native (`Agent`, `spawn_agent`).

Never call a model CLI through the shell. Flow can't contain or track it there.

`reference.md`, next to this file, has every error kind, every envelope field, the provider protocol flow depends on, and what the seat hooks enforce. Read it when something fails in a way this page doesn't cover.

## flow_delegate

Five tools:

- `delegate_to_codex` (on a Claude host) or `delegate_to_claude` (on a Codex host) starts a job.
- `delegation_result` reads a job. With `waitSeconds`, it blocks until the job ends or the wait runs out.
- `delegation_cancel` stops a job and kills its whole process group.
- `delegation_steer` adds an instruction to a running job's turn without stopping it.
- `delegation_doctor` checks that the provider is installed and signed in, lists the usable roots, and runs the provider's handshake with no turn. Run it before your first call. It costs a second and no tokens.

### Start a job

Set `model` and `effort` on every call. Claude takes an alias (`sonnet`, `opus`, `fable`) or a full id like `claude-opus-5-5`, never a charter name like "Opus high". Codex takes its own ids, like `gpt-6-sol`. `effort` is `low`, `medium`, `high`, `xhigh` or `max`. The doctor's `transport.catalog` lists what the provider takes, and a listed model without that effort fails `BAD_MODEL` before it costs a turn.

- **`cwd`**: an absolute directory inside a workspace root and inside a Git worktree. A worktree under `<repo>/.flow-worktrees/` counts as inside its repo. Anything else fails `OUTSIDE_ROOTS`. On Claude Code 2.1.309 the one root is `CLAUDE_PROJECT_DIR`, so an `--add-dir` directory doesn't count. On Codex it's the directory the session started in, when that's a repo's top level.
- **`access`**: `read-only` (the default) or `workspace-write`. A writer may edit its worktree and nothing else, and holds that worktree's one write lease, so a second writer there fails `WORKSPACE_BUSY`. No flow hook runs inside a job, so `access` is the whole confinement. Never point a writer at a worktree with another seat's uncommitted work.
- **What the job sees**: the repo, and nothing else from your host. No MCP servers, plugins or hooks. Anything else it needs goes inline in `prompt`.
- **`mode`**: `task` (the default) or `adversarial-review`. A review needs `base` and takes `head` (default `HEAD`). Both resolve to SHAs before the job starts, so the diff can't move under it. Flow writes the reviewer instruction itself, treats your `prompt` as extra focus, forces read-only, and answers in a fixed findings schema.
- **`outputSchema`**: a typed answer, parsed into `structured`. The root is `type: "object"`, at most 64 KiB. Write closed objects with every property required, because Codex quietly narrows anything else. A keyword flow can't check fails `BAD_SCHEMA`; `reference.md` lists the ones it can.
- **`continue`**: a finished job's id. It starts a new task on the same provider thread, with the same `cwd` and access. A running job refuses with `JOB_STATE`: steer it, or cancel it and continue once it ends. An `unknown` job can't be continued.
- **`timeBudgetSeconds`**: 30 to 7200, default 900. Claude targets also take `maxTurns` and `maxBudgetUsd`. Set caps only when the user asks.

### Wait or detach

- **On a caller that declares the MCP tasks extension**, leave out `waitSeconds`. The call returns a background task right away and the result arrives in a later turn, so you write no polling. Claude Code 2.1.309 declares it on an interactive main thread, on a stream-json main thread run with `CLAUDE_AUTO_BACKGROUND_TASKS=1`, and in T3 children. The doctor's `tasks.declaredOnThisCall` says whether this caller does. The task's `taskId` is the job id, and a failed job is still a completed task, with `isError` set.
- **Anywhere else** (subagents, `flow:bridge`, Codex, a stream-json thread without that variable), the call waits for the whole budget. To run beside other work, pass `waitSeconds: 0` and collect later with `delegation_result`. In Claude Code you can also put the call in a `flow:bridge` seat. Its definition fixes its own model, so don't pass one.

A job outlives the session that started it, and any later session in the same workspace can collect it. Interrupting a `delegate_to_*` call before it answers cancels the job. Once it has returned a task or a detached envelope, interrupting no longer reaches it.

### Steer a running job

`delegation_steer` takes `jobId` and `prompt` (up to 64 KiB) and puts the instruction into the job's open turn. Call it yourself, because `flow:bridge` doesn't carry it. It waits up to 30 seconds and returns `steer.status`:

- `delivered`: the provider took it.
- `failed`: the provider refused it, or the turn ended first. `steer.error` says which.
- `unknown`: no answer yet. That's not delivered. A Claude steer can still land later, so check the job's `steers`.

To give a finished job more work, `continue` it instead.

### Read the result

Every tool answers `{ok, job?, error?}`. `job.status` is `queued`, `running`, `succeeded`, `failed`, `cancelled` or `unknown`. The fields you'll use:

- `output` is the answer, and `structured` is the parsed one when a schema applied.
- `servedModel` is the model the provider actually served. Anything other than what you asked for fails `MODEL_MISMATCH`.
- `commandFailures` counts failed shell commands. A succeeded job with a nonzero count answered without working shell evidence, so don't trust its "tests pass".
- `error.kind` is typed. A `REFUSAL` carries the provider's category in `details`, and the charter's refusal rule handles it.

**A succeeded review with `findings: []` isn't a pass yet.** A reviewer that never looked answers in the same shape. Continue the job and ask which files it read and which it skipped. An `unknown` job is never a pass.

## T3 seats

A T3 seat is a `delegate_task` child that a flow stage starts and flow's hooks hold to the Seat Contract. It runs like a native seat: with flow's hooks, the user's config, their credentials and the network. The hooks deny what the contract forbids and stamp each step. They're a guardrail, not a sandbox, and a child running as the same user could edit its own seat record through Bash.

You're inside T3 when `delegate_task` is in your tool list and `orchestrator_capabilities` answers for this thread. The tools are `mcp__t3-code__<tool>` in Claude Code and `mcp__t3_code__<tool>` in Codex.

Don't mix up a seat and a job. A seat's task id comes from T3, and `seat.mjs close` ends it. A job's `taskId` comes from `flow_delegate`. Never pass one to the other's tools.

### 1. Open

Once per seat:

```sh
node <plugin-root>/scripts/seat.mjs open --access <read-only|workspace-write|review> \
  --provider <claude|codex> [--provider-instance-id <id>] --model <id> [--expected-served-model <id>] \
  --effort <level> [--worktree <absolute-path>] [--base <rev> --head <rev>] [--schema <absolute-file>]
```

- `--provider` is the hook host family the child runs under, not the model's vendor. A Claude Code instance that routes to GLM is still `claude`.
- `--provider-instance-id` is the T3 provider instance, spelled exactly as `orchestrator_capabilities` lists it. It defaults to `claudeAgent` or `codex`.
- `--expected-served-model` is the id the hooks must see serving the seat, for when `--model` names a router. Flow doesn't map routers, so you declare it. Measured once: instance `glm`, model `accounts/fireworks/routers/glm-5p3-us`, served as `accounts/fireworks/models/glm-5p3`.
- A writer names `--worktree`. A review names `--base` and `--head`, and `open` pins a detached worktree at the head under `.flow-worktrees/` for the seat to review in.
- `--schema` is the JSON Schema for the envelope's `answer`, 16 KiB at most. A review uses the findings schema and takes none.

`open` prints one JSON line with the `tag`, `clientRequestId`, `runtimeMode`, `providerInstanceId`, `model` and, for a review, the `worktree`. If it refuses, it exits 1 and leaves nothing behind. For a Codex-family seat it refuses with `HOOKS_UNTRUSTED` unless every flow hook is trusted, because Codex skips an untrusted hook without a word. The `flow` skill's `setup` fixes that. A refused seat goes to the fallback.

### 2. Start

Call `delegate_task` with:

- `task`: the seat `tag` alone on line 1, then the worktree, the checkpoints and the work. A tag anywhere but line 1 voids the seat. Say that the final message is the flow envelope (step 3).
- `role: "general"`, so T3 prepends nothing.
- `runtimeMode`: what `open` printed, `auto` today. Never `full-access`, and never `inherit`: a child copies its parent's mode, so one widened parent widens every later child. Every `delegate_task` call in a flow session names a `runtimeMode`, seat or not, and the hooks deny one that doesn't.
- `clientRequestId`: what `open` printed.
- `target`: `providerInstanceId` and `model` exactly as `open` printed them, with the effort in `options` under `effort` for `claude` or `reasoningEffort` for `codex`.
- `mode`: leave it `async`.

Your hook admits the call only if all of that matches the seat record byte for byte, and only once. `delegate_task` takes only the models and options `orchestrator_capabilities` advertises. `reference.md` says how to add one.

A T3 writer commits its own paths with `git -C <worktree> commit -- <paths>`. Put that exact form in its task: the child's shell starts in the canonical checkout, where a bare `git commit` would hit the wrong branch, so the hooks deny it. Also tell it to write git and gh arguments without quotes, because the shell guard reads a quoted argument as missing.

The seat can't ask the user anything. The hooks deny the question tools, and in Claude Code they also decline MCP elicitations. Codex has no elicitation hook: it rejects them on its own unless `approval_policy.granular.mcp_elicitations = true`, and a Codex seat on a machine with that set can still show one. Either way, tell the seat to report missing input in its envelope.

### 3. The envelope

The child's final message is one JSON object:

```json
{"status": "done | partial | blocked",
 "coverage": {"read": [], "partial": [], "unopened": [], "checksRun": []},
 "notes": "",
 "answer": {}}
```

`answer` follows your schema. A writer adds `commits: [{sha, subject}]`. A review's `answer` is the findings schema, and its `coverage` is the file list you'd otherwise have to ask a `flow_delegate` review for. The Stop hook holds the child to this shape, blocking it up to 3 times.

To give a finished seat another round, send it a message with `t3_thread_send` to its `childThreadId` before you close it. It answers in a new turn with a fresh envelope.

### 4. Wait

A finished child wakes your thread, so end your turn instead of polling. Use `task_status` only when you need the outcome mid-turn. **Never take the answer from `summary`.** After a Stop block, it's the child's last message, not its answer. `task_cancel` stops a seat you don't need.

### 5. Close and act on the verdict

When `task_status` says the task finished (`completed`, `failed`, `cancelled` or `interrupted`, not `working` or `waiting_for_children`, and no pending child runs), pass that whole answer to `close`:

```sh
node <plugin-root>/scripts/seat.mjs close <seat-id> --task-status '<task_status JSON>'
```

If `delegate_task` errored or never returned a `taskId`, close with `--abandon` instead.

Close every seat you open, cancelled ones included. An unclosed T3 writer keeps its worktree lease, and `flow_delegate` refuses writers there until it closes.

Act on the verdict alone:

| Verdict | Do this |
|---|---|
| `valid` | Use the envelope. A writer's envelope is still a claim, so check its commits against git. |
| `invalid`, `capped` | The hooks worked, but the final message failed the envelope or the schema. Rerun once with the errors on the same rung, then go up a rung. |
| `model-mismatch` | The wrong model served it. Discard the answer. It isn't a refusal, so the refusal rule doesn't count it. |
| `unknown`, `tree-moved` | Nothing proves the hooks held the seat. Fall back. |

`reasons` and `errors` say why. `reference.md` lists every reason.

### 6. Fall back

A seat whose `open` refused, or whose verdict is `unknown`, reruns outside T3: through `flow_delegate` if it's cross-family, or as a native seat (`Agent`, `spawn_agent`) if it's same-family.

Route a whole family away from T3 only for a capability failure you actually saw, like an untrusted Codex hook, and only while the hook config stays the same. One cancelled or invalid task doesn't move a family off T3.
