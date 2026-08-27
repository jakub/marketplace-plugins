# Cross-family delegation

Flow can call Codex from Claude Code through a local MCP server. The MCP server owns the job
record and starts one worker process per job, and each worker runs one Codex App Server. Codex
App Server owns the native thread and turn. This split gives Claude a normal tool call while preserving enough
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

The CLI mode carries a weaker guarantee. No manifest sits behind a shell invocation, so the
CLI requires an explicit `--host` and trusts whoever passed it. A caller at depth 0 can name
the wrong family there and get a route the MCP path would refuse. The depth check holds on
both paths: a delegated process runs with `FLOW_DELEGATION_DEPTH=1` in its environment, and
the CLI refuses it exactly as the server does. CLI `--host` is therefore a local operator's
declaration about their own shell rather than proof of anything, while a delegated seat stays
blocked whichever entry mode it uses.

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
own status, events, result, and time budget. An active job cannot continue, and neither can an
`unknown` one, because Flow cannot prove that the earlier turn stopped.

`delegation_models` and `delegation_doctor`

Models asks App Server for the live catalog. Doctor checks the Node version, Codex binary, job
database, App Server initialization, and account state, and its `cwd` passes the same
workspace-root check as any other call. The checks return named results instead of one
unqualified green value.

## Job record

Flow stores data under `${XDG_STATE_HOME}/flow/delegation`, or
`~/.local/state/flow/delegation` when `XDG_STATE_HOME` is unset. Tests and local development
can replace the location with `FLOW_DELEGATION_STATE_DIR`.

`jobs.sqlite3` uses WAL mode, foreign keys, a busy timeout, and a schema version. The `jobs`
table records the request, route, canonical working directory, immutable review SHAs, model
settings, App Server thread and turn IDs, process heartbeat, result, error, usage, and parent
job. The `events` table is an append-only ordered journal. The `controls` table carries cancel
and steer requests to the worker. Flow clears control payloads after handling them and clears
all remaining payloads when a job ends. The `leases` table gives one write job exclusive ownership
of one canonical worktree.

Terminal jobs do not accumulate forever. Flow prunes a job 14 days after it ended, and runs
that sweep when it opens the store. Every terminal state is in scope, `unknown` included.
Events, controls, and the write lease reference the job with `ON DELETE CASCADE`, so a pruned
job takes its journal, any leftover control payload, and its lease row with it. A terminal job
that is still the parent of a live or recent job is kept, so a continuation chain does not lose
the record it resumed from.

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
```

`queued`, `starting`, `running`, and `reconciling` are active states. The others are terminal.
`awaiting_approval` means Flow denied an unexpected request and the caller must start a new
job with a different access policy. A worker updates its heartbeat while it owns an active job.
The `job.starting` event records the worker PID and its operating-system process-start token.
Recovery checks both values, so PID reuse cannot make an unrelated process look like the worker.
Flow fails before starting App Server when the operating system cannot provide that token.
If Flow cannot read the live token later, it may repair a proven terminal native turn, but it
keeps an in-progress job and its write lease until a later check can prove the outcome.

Status performs recovery when an active job has a stale heartbeat. It reads the saved native
thread with `thread/read`. A terminal native turn repairs the local record. A process that
cannot prove the native outcome moves the job to `unknown`. Flow never maps a missing process,
an empty response, or a transport error to success.

## App Server contract

The worker starts `codex app-server` over JSON lines on standard input and output. It sends
`initialize`, then `initialized`, then either `thread/start` or `thread/resume`. It starts a
turn with these values set explicitly:

This contract was validated against Codex CLI 0.150.1 on 2026-08-26.

- `approvalPolicy: "never"`
- the requested model and effort
- `serviceTier: "default"` unless the caller states another allowed tier
- `summary: "detailed"`
- the canonical working directory
- a concrete sandbox policy for read-only or workspace-write access
- the caller's output schema, when present

The worker saves the thread ID before it starts the turn and saves the turn ID from
`turn/started`. That notification also marks the turn accepted and clears the stored prompt,
so a worker crash between the notification and the `turn/start` response cannot lose the write
boundary. It builds the final answer from completed `agentMessage` items. A missing
message is an `EMPTY_OUTPUT` failure. For structured output, Ajv compiles the full caller
schema and checks the parsed message. This catches a server or model returning invalid JSON
even when the native turn says it completed.

The worker also watches the App Server process. An unexpected exit ends the local wait at once.
A read-only job fails with the named transport error. An accepted write job becomes `unknown`
unless App Server already reported a terminal turn.

A live process that has stopped saying anything is the other failure to catch. Every App Server
notification resets a 420 second stall timer. When it fires, the worker runs the same
cooperative interrupt path as the time budget: `turn/interrupt` first, then process termination
if the native turn does not end within the grace period. The job fails with kind `STALL`. The
write boundary does not move for a stall. An accepted write turn with no native proof of a
terminal outcome still ends `unknown`, never `failed`.

An approval request is unexpected because the policy is `never`. The worker denies the
request, records its type, and moves the job to `awaiting_approval`. It never grants approval
on the caller's behalf. Any other server request Flow does not implement gets a JSON-RPC
method error and an `app_server.request_denied` event. The turn decides the job's outcome from
there; a denied request is not a failure on its own.

## Progress and output

MCP progress notifications carry a monotonic event sequence and a short message. The server
reports thread and turn startup, current item type, command completion, file changes, bounded
agent-message previews, cancellation, and the terminal state. It does not forward hidden
reasoning or unbounded shell output. Attached `delegate_to_codex` and attached
`delegation_continue` calls stream the same journal through the same path, so a continuation is
as visible as the call that started the thread.

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

The envelope's `error` carries the public shape only: a named kind and a short message, with no
stack, no internal path, and no raw server payload. Flow keeps the detail instead of discarding
it, in one of two places. An unexpected failure inside a job becomes an `internal.error` event
in that job's journal, carrying the message and a bounded stack. A failure with no job to
journal against, a rejected CLI invocation, a failed MCP tool call, or a database that will not
open, goes to `service.log` in the state directory, which Flow creates 0600 like the database.
Both records are for the machine's owner. Neither crosses back to the caller.

`delegation_doctor` reports a failure against the check that produced it. An account or read
failure is a failure of the account check, not of App Server, so a logged-out user reads as
logged out rather than as a broken protocol.

## Workspace trust

At startup, the MCP server asks the client for roots when the client supports `roots/list`.
It also accepts the canonical `CLAUDE_PROJECT_DIR` supplied by Claude Code. A requested
working directory must resolve inside one of those roots. The server rejects missing paths,
symlink escapes, and the repository root of an unrelated checkout.

For workspace-write jobs, Flow also checks the Git worktree root against the supplied roots.
It rejects a nested directory whose Git root sits above the approved client root instead of
widening Codex write access to the outer checkout.

A linked worktree is accepted when its common Git directory resolves inside an approved root.
Flow's own pipeline runs seats in worktrees beside the project, so a requested cwd of
`~/code/proj-fix-x` whose common Git dir is `~/code/proj/.git/worktrees/fix-x` passes on the
approved `~/code/proj` root. An unrelated checkout still fails, because its common Git dir
resolves nowhere near an approved root.

Review modes resolve the base and head revisions to full commit IDs before the worker starts.
The prompt names those immutable IDs. It never verifies a mutable branch name and then reuses
that name later.

A workspace-write job acquires a lease on the canonical Git worktree root in the same SQLite
transaction that moves it out of `queued`. The lease row has no clock of its own: the job's
heartbeat carries worker liveness, and only a terminal result releases the row. A second write
job on the same worktree never starts, and fails with kind `WORKSPACE_BUSY`. Its own worker
reports that, because a worker that loses the claim may write the job record only while the job
is still `queued`, which proves no other worker owns it.

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

The build reads the version from the plugin manifest and injects it into the bundle. That
injected value is what the MCP server reports and what App Server receives as `clientInfo`, so
there is one version number and `.claude-plugin/plugin.json` is where it lives.
`scripts/smoke-bundle-drift.mjs` keeps the committed bundle honest: it rebuilds from
`src/delegation` and fails unless the result is byte-identical to the committed file, so a
source edit that nobody rebuilt cannot ship. It rebuilds with esbuild from `deps`, so it needs
a dev checkout with `npm ci` already run and does not work from an installed plugin.

The store upgrades an older database in place when it opens one. Version 1 becomes version 2 by
dropping the two columns the service stopped writing, `jobs.delivery` and `leases.heartbeat_at`.
Rows survive the upgrade. A database written by a newer Flow is refused, not downgraded. The
upgrade and the first create both run inside one write transaction that re-reads the version, so
several processes opening a fresh state directory at once cannot collide.

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
- write lease races across independent processes, including a second worker for a job that
  already has one
- concurrent first opens of one state directory, the v1 to v2 upgrade, and retention pruning
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
