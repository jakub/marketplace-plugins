# Cross-family delegation

Flow can call Codex from Claude Code through a local MCP server. The MCP server owns the
job record and starts one Codex App Server process for each job. Codex App Server owns the
native thread and turn. This split gives Claude a normal tool call while preserving enough
state to inspect, cancel, or recover a call after either process exits.

This document defines Phase 1. It covers Claude calling Codex. The shared route policy and
job format reserve a Claude backend so a later release can call Claude from Codex without
changing the lifecycle contract.

## Goals

Phase 1 must provide these properties:

- Claude calls Codex through MCP tools, with no shell wrapper agent.
- Every call states the model, effort, service tier, working directory, and access mode.
- Calls can run attached to one tool call or detached under a durable job ID.
- Attached calls report bounded progress while Codex works.
- A caller can read status, events, and results, then cancel or steer a running turn.
- JSON Schema output is checked by Codex and checked again before Flow returns it.
- A process crash cannot turn an unknown write into a successful result or a blind retry.
- Two write jobs cannot own the same canonical worktree at once.
- A delegated model cannot call its own family or start another cross-family call.
- Installed plugins run from a committed bundle. They do not install packages at runtime.

## Route policy

The MCP server starts with a trusted `--host` argument from the plugin manifest. It does not
accept the caller family in tool input. The worker adds `FLOW_DELEGATION_DEPTH=1` and the
parent job ID to the Codex process environment.

| Host | Target | Depth | Result |
|---|---|---:|---|
| Claude | Codex | 0 | allowed |
| Claude | Claude | any | denied |
| Codex | Codex | any | denied |
| Codex | Claude | 0 | reserved until the Claude backend exists |
| either | either | 1 or more | denied |

The server checks the route when it creates a job. The worker checks it again before it
starts a model process. A child MCP server also sees the depth variable and refuses new
jobs. Tool input cannot lower the depth or replace the host.

## Tools

The Claude manifest registers the server as `flow_delegate`. It exposes these tools:

`delegate_to_codex`

Starts a task, review, or adversarial review. Required fields are `prompt`, `cwd`, `model`,
and `effort`. The default service tier is `default`. Access is `read-only` or
`workspace-write`. Delivery is `attached` or `detached`. An attached call follows events
until the job reaches a terminal state. A detached call returns the job ID after the worker
starts.

`delegation_status`, `delegation_result`, and `delegation_events`

Read durable state. Result returns a typed envelope. Events returns a bounded page ordered by
sequence number. Status reconciles a stale active record before it answers.

`delegation_cancel`

Records a cancel request. The worker sends `turn/interrupt` when a native turn exists. A job
that has not started becomes cancelled without starting Codex.

`delegation_steer`

Adds text to a running turn through `turn/steer`. The command stays in the job database until
the worker records the App Server response. Steering a terminal job fails.

`delegation_continue`

Creates a new job linked to the prior job and resumes its native thread. The new job gets its
own status, events, result, and time budget. A write job in `unknown` cannot continue because
Flow cannot prove what the earlier turn changed.

`delegation_models` and `delegation_doctor`

Models asks App Server for the live catalog. Doctor checks the Node version, Codex binary,
App Server initialization, account state, database, and workspace roots. The checks return
named results instead of one unqualified green value.

## Job record

Flow stores data under `${XDG_STATE_HOME}/flow/delegation`, or
`~/.local/state/flow/delegation` when `XDG_STATE_HOME` is unset. Tests and local development
can replace the location with `FLOW_DELEGATION_STATE_DIR`.

`jobs.sqlite3` uses WAL mode, foreign keys, a busy timeout, and a schema version. The `jobs`
table records the request, route, canonical working directory, immutable review SHAs, model
settings, App Server thread and turn IDs, process heartbeat, result, error, usage, and parent
job. The `events` table is an append-only ordered journal. The `controls` table carries cancel
and steer requests to the worker. The `leases` table gives one write job exclusive ownership
of one canonical worktree.

The database and state directory use owner-only permissions. Prompts live in the job record,
not command-line arguments or process listings. The worker clears the stored prompt after App
Server accepts the turn. Events omit reasoning text and raw command output. They retain phase
changes, tool names, bounded agent-message previews, command exit state, changed paths, and
usage.

## State machine

The stored states are:

```text
queued -> starting -> running -> succeeded
                     |       -> failed
                     |       -> cancelled
                     |       -> awaiting_approval
                     |       -> unknown
unknown -> reconciling -> succeeded | failed | cancelled | unknown
```

`queued`, `starting`, `running`, and `reconciling` are active states. The others are terminal.
`awaiting_approval` means Flow denied an unexpected request and the caller must start a new
job with a different access policy. A worker updates its heartbeat while it owns an active job.

Status performs recovery when an active job has a stale heartbeat. It reads the saved native
thread with `thread/read`. A terminal native turn repairs the local record. A process that
cannot prove the native outcome moves the job to `unknown`. Flow never maps a missing process,
an empty response, or a transport error to success.

## App Server contract

The worker starts `codex app-server` over JSON lines on standard input and output. It sends
`initialize`, then `initialized`, then either `thread/start` or `thread/resume`. It starts a
turn with these values set explicitly:

- `approvalPolicy: "never"`
- the requested model and effort
- `serviceTier: "default"` unless the caller states another allowed tier
- `summary: "detailed"`
- the canonical working directory
- a concrete sandbox policy for read-only or workspace-write access
- the caller's output schema, when present

The worker saves the thread ID before it starts the turn and saves the turn ID from
`turn/started`. It builds the final answer from completed `agentMessage` items. A missing
message is an `EMPTY_OUTPUT` failure. For structured output, Ajv compiles the full caller
schema and checks the parsed message. This catches a server or model returning invalid JSON
even when the native turn says it completed.

An approval request is unexpected because the policy is `never`. The worker denies the
request, records its type, and moves the job to `awaiting_approval`. It never grants approval
on the caller's behalf. Other unsupported server requests receive a JSON-RPC method error and
fail the job with a named protocol error.

## Progress and output

MCP progress notifications carry a monotonic event sequence and a short message. The server
reports thread and turn startup, current item type, command completion, file changes, bounded
agent-message previews, cancellation, and the terminal state. It does not forward hidden
reasoning or unbounded shell output.

Every result uses one envelope:

```json
{
  "jobId": "UUID",
  "status": "succeeded",
  "model": "gpt-5.6-sol",
  "effort": "high",
  "serviceTier": "default",
  "threadId": "native thread ID",
  "turnId": "native turn ID",
  "output": "final text or null",
  "structured": null,
  "findings": null,
  "usage": {},
  "error": null
}
```

Review modes use a strict findings schema with severity, confidence, title, file, line,
detail, and systemic fields. A clean review is an empty findings array, not an empty message
or prose parser guess.

## Workspace trust

At startup, the MCP server asks the client for roots when the client supports `roots/list`.
It also accepts the canonical `CLAUDE_PROJECT_DIR` supplied by Claude Code. A requested
working directory must resolve inside one of those roots. The server rejects missing paths,
symlink escapes, and the repository root of an unrelated checkout.

Review modes resolve the base and head revisions to full commit IDs before the worker starts.
The prompt names those immutable IDs. It never verifies a mutable branch name and then reuses
that name later.

A workspace-write job acquires a lease on the canonical Git worktree root in the same SQLite
transaction that moves it out of `queued`. The worker refreshes the lease with its heartbeat
and releases it only after recording a terminal result. A stale lease follows the same
reconciliation rules as its job.

## Retry and recovery rules

Flow may retry setup before App Server accepts a turn. After a write turn is accepted, Flow
does not replay the prompt automatically. A rate limit, disconnect, worker crash, or timeout
after that point yields `unknown` unless `thread/read` proves a terminal result.

Read-only callers may start a new job after a named failure. The retry is a new job with a
new ID and a parent link, so both attempts remain visible. Continuation uses the existing
native thread but always starts a new local job.

Cancellation is cooperative first. Flow sends `turn/interrupt`, waits for the native terminal
event, and then terminates the process if it does not respond before the grace period. A forced
termination after a write turn produces `unknown`, not `cancelled`, unless App Server confirms
the interruption.

## Packaging and migration

Source lives under `src/delegation`. `deps/package.json` pins the MCP SDK, Ajv, and esbuild.
The build writes one committed ESM bundle at `dist/delegation.mjs`. That file supports MCP,
worker, and CLI entry modes. The worker starts the same bundle with a job ID, so the prompt
does not cross a shell boundary.

The Claude plugin manifest starts the MCP mode. Dynamic `/flow:issue` calls its tools directly.
The deprecated fixed workflow uses the CLI mode over the same job database and worker. Flow
does not ship `agents/codex-delegate.md` or `scripts/codex-exec.mjs`. No second transport
remains as a fallback.

## Phase 1 acceptance checks

The test set must cover:

- route and depth denial
- workspace roots and symlink escapes
- full JSON Schema validation
- job transitions and append-only event order
- write lease races across independent processes
- App Server startup, streaming deltas, structured results, and unexpected requests
- cancel, steer, continuation, stale heartbeat recovery, and unknown write outcomes
- immutable review revisions
- MCP tool registration and progress
- CLI parity for the deprecated fixed workflow
- plugin manifest, version, hook, and workflow regressions
- one live Claude Code call that invokes `delegate_to_codex` and receives a Codex result

## Deferred work

Phase 1 does not implement Codex calling Claude. It does not share jobs across machines, grant
model-requested approvals, expose raw chain-of-thought text, or turn the service into a general
remote execution API. The route policy, backend interface, and job schema leave room for a
Claude service without claiming that the service exists.
