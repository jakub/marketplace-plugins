---
name: delegate
description: The operating manual for Flow's `flow_delegate` MCP tools. Read it before the first bridge call of a session, and for any question about cross-model or cross-family work, `delegate_to_codex`, `delegate_to_claude`, `delegation_result`, `delegation_steer`, a delegation job or its result envelope. Apply this when the user says "ask Sol", "ask Codex", "ask Fable" or "ask Claude".
---

# delegate: reaching the other model family

One MCP server, `flow_delegate`, reaches the other family in both directions. A Claude host runs Codex through `codex app-server`, and a Codex host runs Claude through the stream-json control channel of `claude -p`, each as a job the server starts and watches. Each job opens the provider's session, checks your model and effort against the provider's catalog, reads back what the session can reach, and only then sends your prompt. The charter says when to cross the family line and what to do with a refusal. This skill says how the call works.

## The five tools

- `delegate_to_codex` on a Claude host, or `delegate_to_claude` on a Codex host, starts a job. It waits for the outcome unless you detach.
- `delegation_result` reads one job: its status, its outcome and its last event lines. With `waitSeconds` it blocks until the job ends or the wait runs out.
- `delegation_cancel` stops a queued or running job and kills its provider's whole process group.
- `delegation_steer` adds an instruction to a running job's turn without stopping the job.
- `delegation_doctor` reports whether the provider is installed and signed in, the usable workspace roots and the state directory.

## Start a job

Set `model` and `effort` on every call. Claude takes an alias (`sonnet`, `opus`, `fable`) or a full id such as `claude-opus-5-5`, never a charter display name. Codex takes its own ids, such as `gpt-6-sol` or `gpt-6-luna`. `effort` is `low`, `medium`, `high`, `xhigh` or `max`.

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
- `unknown` means the job never answered. An `unknown` steer is never a delivered one.

A job that is queued, has not sent its prompt yet, or has ended is refused with `JOB_STATE`, and nothing reaches it. A job refused before its prompt went out can be steered a moment later, once its turn is open.

On Codex the steer joins the running turn. On Claude it is the next user message, and the CLI either folds it into the running turn or runs it as the next turn. Either way the job's answer is the last one the provider gives, so it answers the steer too. To give a finished job more work, continue it instead.

## Read the envelope

Every tool answers `{ok, job?, error?}`, and the JSON text opens with a one-line `summary`. A refused call is `{ok: false, error}`. A job that ended badly is `{ok: false, job}` with the whole job in it. `job.status` is `queued`, `running`, `succeeded`, `failed`, `cancelled` or `unknown`.

`job.error.kind` is one of `BAD_REQUEST`, `BAD_SCHEMA`, `NO_ROOTS`, `OUTSIDE_ROOTS`, `WORKSPACE_BUSY`, `NESTED_DELEGATION`, `JOB_NOT_FOUND`, `JOB_STATE`, `GIT_REF`, `PROVIDER_NOT_INSTALLED`, `PROVIDER_AUTH`, `PROVIDER_ERROR`, `BAD_MODEL`, `APPROVAL_REQUIRED`, `REFUSAL`, `MODEL_MISMATCH`, `ISOLATION`, `SCHEMA_OUTPUT`, `EMPTY_OUTPUT`, `TIMEOUT`, `STALL`, `CANCELLED`, `RUNNER_LOST` or `INTERNAL`. A `REFUSAL` carries the provider's category in `details` when it names one.

- `output` is the final answer, and `structured` is the parsed answer when a schema applied.
- `SCHEMA_OUTPUT` means the answer did not parse, did not conform, or could not be checked against the schema within 10 seconds. `details.errors` lists up to ten `path: problem` lines when it did not conform, `structured` is null and `output` keeps the raw answer. A review is checked against the findings schema the same way.
- `servedModel` is the model the provider reported serving: the thread's model on Codex, and the model the `system/init` frame names on Claude. A session or an answer on any other model fails `MODEL_MISMATCH` and stops at once. A Claude alias that the catalog lists must be served by the model it resolves to, so `opus` reports `claude-opus-5-5`.
- `catalog` is `listed` when the provider's catalog listed the model and `absent` when it did not. It is null when the job ended before the catalog was read, or failed `BAD_MODEL`.
- `BAD_MODEL` means the catalog lists the model but not the effort, or lists no effort levels for it. `details.efforts` names the efforts it takes.
- `ISOLATION` means a check of the live session failed. On Codex, the thread ran under another permission profile than `flow_delegation`, or left an MCP server reachable. On Claude, `mcp_status` reported an MCP server, or the `system/init` frame named a tool you did not ask for, an MCP server or a plugin. `details` names what the check found.
- `isolation` is what the live session read back: `{profile, mcpServers, instructionSources}` on Codex and `{mcpServers, tools}` on Claude. `promptSent` is false when the job ended before the prompt left the server, so the provider ran no turn for it.
- `steers` lists every steer the job answered, in order, as `{id, at, status, error}`.
- `commandFailures` counts shell commands that failed. A succeeded job with a nonzero count answered without working shell evidence.
- `APPROVAL_REQUIRED` means the provider asked for more than the job grants. Its `output` is kept. Start a new job with the access the task needs.
- `eventsPath` is the provider's full JSONL journal. `delegation_result` includes the last 20 lines, each cut to 400 characters. Set `events` for more or fewer, and read the file itself for the rest.

A succeeded review with `findings: []` is not yet a pass. A reviewer that never looked answers in the same shape. Continue the finished job as a task and ask which files it read and which it skipped before you treat the empty array as clean. An `unknown` job is never a pass.

## Before the first call

Run `delegation_doctor` as the preflight. It answers without a workspace, which is what you need when the answer is that you have none. Codex starts MCP servers before any hook runs, so on a new machine the flow skill's `setup` runs `node <plugin-root>/scripts/install-delegate.mjs install` once before the first Codex session. After that, the Codex SessionStart hook keeps `~/.local/bin/flow-delegate` current.

The server depends on these provider interfaces, checked against Codex CLI 0.159.0 and Claude Code 2.1.284 on 2026-09-30.

- Codex: `app-server --stdio` with `experimentalApi`, and the methods `initialize`, `model/list`, `config/read`, `thread/start`, `thread/resume`, `mcpServerStatus/list`, `turn/start`, `turn/steer` and `turn/interrupt`. The thread fields `permissions`, `runtimeWorkspaceRoots`, `allowProviderModelFallback` and `activePermissionProfile` appear only in the experimental schema.
- Claude: `-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`, `--model`, `--effort`, `--permission-mode dontAsk`, `--permission-prompts none`, `--setting-sources`, `--strict-mcp-config`, `--settings`, `--tools`, `--allowedTools`, `--session-id`, `--resume`, `--append-system-prompt-file`, `--json-schema`, `--max-turns` and `--max-budget-usd`, and the control requests `initialize`, `mcp_status` and `interrupt`. A steer is a user message with `priority: "next"`, acknowledged when the CLI replays its `uuid`. That field and the replay come from the Agent SDK's type definitions, and no live turn has shown them yet.

When the doctor reports a newer version and jobs start failing with `PROVIDER_ERROR`, check these first: the Codex methods against `codex app-server generate-ts --experimental --out <dir>`, and the Claude flags against `claude --help`.
