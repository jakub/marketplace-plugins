# Cross-family delegation

This is the design and maintenance record for `src/delegation`. If you are calling the tools
rather than editing them, read `skills/delegate/SKILL.md` instead: it is the operating manual,
and nothing here repeats it.

As of 2026-09-01, against Codex CLI 0.152.0 and Claude Code 2.1.257 as installed. Both
deterministic smokes pass on those versions; the live-turn validations keep their own dates below,
because nothing re-ran them today.

Both routes need Linux with cgroup v2, a working systemd user manager, and Node 22 or newer. Every
provider process runs in a transient systemd scope, which is what makes a write lease safe to
release. Containment fails closed with `UNSUPPORTED_HOST`.

## Route and workspace policy

Each plugin manifest starts the server with a trusted `--host` argument. Tool input cannot replace
it, and MCP mode refuses to start when it is missing or names an unknown family.

The Codex manifest also names `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` and `PWD` in
`env_vars`. Codex curates the environment of a stdio MCP server, and without the first two
`systemd-run --user` cannot reach the user bus, so every provider scope fails with
`CONTAINMENT_UNAVAILABLE`. `PWD` is there because that client advertises no `roots` capability and
sets no project-dir variable, so without it every call fails with `NO_ROOTS`. The server takes it,
the shell cwd the human launched `codex` from, as the workspace boundary, so
`codex -C <elsewhere>` fails closed with `OUTSIDE_ROOTS`. The Claude host has real roots and
`CLAUDE_PROJECT_DIR`, and never reads `PWD`.

The route is checked three times: at job creation, again in the worker before it starts a
provider, and in every read and control method, resource reads included, which verify that the
requesting host owns the stored route and that the job sits inside the client's roots. Both hosts
share one database, so a UUID from the other route is not authority. The worker also adds
`FLOW_DELEGATION_DEPTH=1` and its parent job ID to the provider environment, so a child MCP server
refuses new work.

A requested working directory must resolve inside a client root or the host's canonical project
directory, and Flow rejects missing paths, symlink escapes and unrelated checkouts. At least one
usable root must exist before any job starts, continues or is read back; `delegation_doctor` is
the exception, because it has to explain a missing-root failure. Flow checks the Git worktree root
before granting access: a linked worktree beside the approved repository passes only when its
common Git directory belongs to the approved root and Git lists that worktree, since a
caller-writable `.git` pointer alone is not proof.

## Contracts that bind an edit

`resultEnvelope()` in `contracts.mjs` builds the envelope and `envelope-schema.mjs` is its shape.
The two are one field list or the smoke fails. Every tool declares that shape as its
`outputSchema`, so a success, an attached job that ended badly (`{ ok: false, job }`) and a
rejected request (`{ ok: false, error }`) must all validate against it: a client that checks every
structured result, as MCP Client 1.30.0 does, must find an error result valid too. `error.kind` is
enumerated from `ERROR_KINDS`, which the Codex smoke greps the source for and fails on a missing
kind.

`capabilities.json` at the plugin root is the host capability table, read at runtime and
deliberately not injected into the bundle, so re-verifying a row needs no rebuild and no version
bump. It is hand-maintained and biased false: an unprobed id is `supported: false` with assurance
`unverified`, `mechanism` means a named feature was observed doing the thing, and `contract` means
the behaviour rests on an agreement with no receipt to check. Every id names both hosts, and a
false entry never changes doctor's `ok`. `capabilityDrift` reads the installed version from the
initialize handshake on Claude and from `codex --version` on Codex, whose MCP client reports its
own component version rather than the CLI's.

## Job record

Flow stores data under `${XDG_STATE_HOME}/flow/delegation`, or `~/.local/state/flow/delegation`
when unset; tests replace it with `FLOW_DELEGATION_STATE_DIR`. `jobs.sqlite3` uses WAL mode,
foreign keys, a busy timeout and a schema version.

A database written by an older Flow is dropped and recreated rather than migrated: it holds at
most 14 days of history, and a migration ladder for rows nobody reads is more risk than the rows
are worth. One written by a NEWER Flow is refused, because its jobs may still be running. The
reset is also refused while the old database holds a live job, since a detached worker outlives
the MCP process that started it and a workspace-write row holds a worktree lease. Flow counts rows
whose `status` is active, `awaiting_approval` or `quarantined`, throws `STORE_UPGRADE_BLOCKED`
naming the count, and leaves the file alone.

The `jobs` table records the request, route, canonical working directory, immutable review SHAs,
model settings and limits, native session and turn IDs, heartbeat, provider process identities,
result, error, usage and parent job. `events` is an append-only ordered journal, and it omits
hidden reasoning and raw command output, keeping phase changes, tool names, bounded answer
previews, changed paths and usage. `controls` carries cancel and steer requests, cleared after
handling and again when a job ends. `leases` gives one write job exclusive ownership of one
canonical worktree. Terminal jobs are pruned after 14 days with `ON DELETE CASCADE` on the other
three tables.

The database and state directory are owner-only. Prompts live in the job record, never in
command-line arguments or process listings, and each worker clears the prompt at its acceptance
boundary.

## State and write safety

```text
queued -> starting -> running -> terminal state
  |          |          |
  +----------+----------+-- stale worker -> reconciling -> terminal state or deferred recovery
                        |
                        +-- provider survives termination -> quarantined -> terminal state
                        +-- worker dies first -> quarantined -> reconciling
```

The `job.starting` event records the worker PID and an operating-system process-start token, and
recovery checks both, so PID reuse cannot make an unrelated process look like the worker.

A workspace-write job takes its lease on the canonical worktree root in the same SQLite
transaction that claims the job. A normal terminal result releases the lease only after the worker
proves the provider process tree stopped, and a second write job on that worktree fails with
`WORKSPACE_BUSY` before a provider starts.

If a provider or a recorded descendant survives repeated termination, Flow stores `quarantined`
with the systemd scope, process group, process-start identities, resume status, usage and error.
It keeps the write lease, refuses continuation and never prunes that row; the same barrier applies
when an uncatchable worker exit leaves a recorded provider alive. `delegation_status` checks the
kernel scope first, then the recorded group and identities, and after they stop it applies the
intended terminal state or resumes reconciliation, releasing the lease only after terminal proof.

`delegation_cancel` is the way out of a quarantine that cannot end by itself. It re-checks the
scope, the group and every recorded identity, refuses while anything is alive and names what is
alive, and otherwise resolves the quarantine as `unknown` and releases the lease.

The acceptance boundary differs by provider. For Codex, `turn/started` or the `turn/start`
response supplies the native turn ID; Flow stores it, marks the turn accepted and clears the
prompt, so a later worker death can be repaired by reading that exact turn through `thread/read`.
For Claude, a successful SDK initialize response proves the control channel is ready; Flow chooses
the session ID and user-message UUID, stores both, marks the write boundary, and only then
releases that exact user message to the input stream. A worker death after that makes a write job
`unknown`, because the Agent SDK has no API that can prove the lost query's result, and a
read-only job fails instead. Flow never replays an accepted write prompt automatically, and never
maps a missing process, empty response or transport error to success.

## The approval fork

A job started by an attached call from a client advertising `elicitation.form` carries
`elicitation: true`. When its provider asks to run a command or change a file, the worker renders
the request whole: the command with its working directory, the item's full path list for a file
change (read from the item notifications that preceded the request), or the tool with the host's
own title and its whole input on the Claude route. A request that cannot be shown whole is
declined unasked and journaled as `approval.undisclosed`, which covers a command or input longer
than 4,000 characters, a file change with no item on record, and network or stdin kinds with no
command.

A showable request is parked in the store as `approval.requested`, carrying the summary and never
the raw request. The server process, the only one holding the MCP session, sends
`elicitation/create` with a two-value form. The attached wait loop does not await the form; it
keeps reading the job, the caller's abort signal and the terminal state, and the form races that
same signal. An explicit accept is written back as `approval.decided` and the worker answers the
provider (`approval.granted`). Anything else is a decline: a declined or dismissed form, a client
error, or the 240-second window closing, which sits under the 420-second stall ceiling. A decline
is journaled as `approval.denied` with `asked: true` and ends the job as `awaiting_approval`.

A cancel on record beats an accept, checked before and after the worker reads the decision and
inside the store's write lock, so a cancel landing before the human's accept turns that accept
into a decline. A permissions request is never put to the human, because granting it would widen
the sandbox doctor proved, and a detached job is never asked.

## Codex App Server contract

Validated with live delegated turns against Codex CLI 0.151.0 on Linux on 2026-08-29; the
deterministic smoke passes against 0.152.0 as of the header date. Delegation requires Codex CLI
0.150.1 or newer, and an older or unreadable version fails before Flow creates a job.

The worker starts `codex app-server` over JSON lines with the experimental API enabled. The thread
config disables plugin loading, app loading and every discovered standalone MCP server, and after
the thread starts or resumes Flow reads that thread's inventory back and refuses to send the
prompt unless every remaining server is disabled and exposes zero tools. Reading it back is the
difference between the two routes: here isolation and the permission profile are configured and
then PROVEN against the live thread, and a mismatch stops the job before the prompt goes out.

Flow does not use Codex's built-in read-only sandbox, which can read the whole host filesystem.
Each thread gets a custom `flow_delegation` profile granting read access to Codex's minimal
runtime paths, the requested access to the canonical worktree, and write access to one owner-only
temporary directory per job, removed after the provider stops. Network access is disabled. Git
metadata stays read-only, including linked-worktree metadata outside the checkout, and for write
jobs `.git`, `.agents` and `.codex` stay read-only when present. Flow sets the profile on
`thread/start` or `thread/resume`, verifies App Server reports it active, and does not replace it
at `turn/start`.

The profile also grants read access to the resolved Codex executable and, for an npm install, its
`@openai/codex` package root. Codex re-execs its own binary inside the bubblewrap namespace for
every shell command, and without that grant every delegated command breaks with execvp ENOENT
while the turn still completes (openai/codex#29049; validated against Codex CLI 0.151.0 on
2026-08-29).

The turn starts with `approvalPolicy: "never"`, the requested model and effort,
`serviceTier: "default"`, `summary: "detailed"`, the canonical working directory, the active
profile with network disabled, and the caller's output schema when present. The worker builds the
final answer from completed `agentMessage` items, and Ajv checks structured output again on the
way back. Before job creation Flow walks the schema against Codex's structured-output subset by
hand, since no Ajv strictness rejects a well-formed schema for sitting outside that subset.

App Server notifications reset a 420 second quiet-period timer, and a timeout or stall first sends
`turn/interrupt`, then terminates the process. The transient scope keeps App Server and its
descendants together across `setsid`, double-forking and parent exit, and the worker snapshots
descendants with stable process-start identities, which stay useful after a user-manager restart
or a scope lookup failure.

## Claude Agent SDK contract

Validated against Claude Code 2.1.250 and `@anthropic-ai/claude-agent-sdk` 0.3.251 on 2026-08-28;
its deterministic smoke passes against Claude Code 2.1.257 on 2026-09-01. The bundle carries the
SDK library but no Claude Code executable, and uses the installed `claude` binary and its current
authentication. Agent SDK and `claude -p` usage draws from Claude plan limits under the current
policy, and Anthropic's planned June 15, 2026 change is paused; verified 2026-08-27, so recheck
<https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan>
before changing authentication.

The worker calls `query()` with the requested model and effort, the native `maxTurns` and
`maxBudgetUsd` limits, the canonical working directory and exact session ID, streaming input, the
caller's schema minus the dialect marker Claude Code rejects, `permissionMode: "dontAsk"` with a
host callback that never grants a new approval, no setting sources, plugins, skills, MCP servers,
browser, web tools or subagents, and a sandbox that fails closed when unavailable. Every item on
that list is CONFIGURED and none of it is read back: the Agent SDK has no call that reports the
tool set, the MCP inventory or the sandbox a running query ended up with, so the isolation rests
on the SDK doing what its options say. The SDK also has no `TMPDIR` knob, so unlike a Codex job a
delegated Claude process uses the worker's own temporary directory.

The sandbox blocks network access, local binding, Unix sockets and unsandboxed commands. Read-only
jobs deny worktree writes; write jobs grant the canonical worktree and no other checkout. It
denies the Claude and Codex executable paths and every credential store, including provider-named
ones and `/proc` with its process environments, which still holds when the worktree sits below a
protected credential directory. The network allowlist is empty, so a provider a delegated command
manages to start has no authentication and no egress. The process gets an explicit environment
allowlist instead of the host's whole environment, auto-memory is off, and secret and proxy
variables are stripped from sandboxed commands. A PreToolUse policy also checks direct edits,
shell writers, wildcard write targets, inline evaluators and publication commands, but it does not
try to spot a nested provider launch in command text, because a text check is walked around in a
dozen ways. The sandbox is the control that holds, and none of it depends on prompt compliance.

SDK initialization has a 30-second timeout, and after prompt release every SDK message resets the
420-second quiet-period timer. The job budget and the quiet-period limit both call `interrupt()`
first, then close and terminate the process after a grace period. Flow checks the scope's cgroup
before recording a terminal write job, and freezes and records descendants as fallback evidence.

The SDK `result` message is the native terminal proof. Flow records its text, usage and typed
failures such as `RATE_LIMIT`, `CLAUDE_AUTH` or `BAD_MODEL`. A refusal is `REFUSAL` with the
category in `details`. Claude Code retries a refused turn on a fallback model by default, and
silently for a subagent-style query, so the delegated environment sets
`CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` and `CLAUDE_CODE_NO_MODEL_FALLBACK=1` and the worker
reads `stop_reason` plus the `model_refusal_no_fallback` and `model_refusal_fallback` system
messages. Neither variable is public API, and 2.1.257 carries a third feature-flagged fallback
lane that reads neither, so the contract does not rest on them. The guard that does hold is that
every assistant frame names the model that produced it: the worker compares that against the
catalog id it asked for, and a mismatch fails the job as `REFUSAL` when a refusal was seen and
`MODEL_MISMATCH` otherwise, journaling the model that answered as `model.served`. Schema jobs add
Claude's native `StructuredOutput` tool and plain jobs do not; Ajv checks `structured_output`
against the original schema before the job can succeed.

## What the caller receives

Both workers receive the seat half of the charter: everything below the seat-rules marker line
in `charter/charter.md` (`## Rules of Engagement - Everything Else`, `## Seat Contract`,
`## Gripes`), read at build time and wrapped by `seatPayload` in `lib/charter-payload.mjs` in a
`<flow-charter scope="seat">` block, the same bytes a native subagent gets from the SubagentStart
hook. `instructions.mjs` refuses to load if the marker is missing or doubled. The delegated-seat
rule forbidding subagents and nested provider calls follows it, and nothing else.

The public error carries a named kind, a short message and bounded details, never a stack, raw
provider payload, account identifier, model identifier from an error payload, or internal path.
Owner-only `internal.error` events and `service.log` keep the detail the caller does not receive.

## Packaging and smokes

Source lives under `src/delegation`, and `deps/package.json` pins the MCP SDK, Ajv, esbuild and
the Claude Agent SDK. `npm run build` in `plugins/flow/deps` writes one committed ESM bundle at
`dist/delegation.mjs` with two entry modes, `mcp` and `worker`: a host starts the server, and the
service starts one worker per job with a job ID. Every install runs the bundle and never the
source, so an edit under `src/delegation` is half a change until the rebuild lands in the same
commit. The build injects the plugin version, the SDK
version and the charter (through `__FLOW_CHARTER__`), so a version bump or a charter edit
rebuilds the bundle too.

The Claude manifest holds the direct `flow_delegate` server definition with a 7,500,000 millisecond
call timeout. The Codex manifest points at plugin-root `.mcp.json`, which starts the same bundle
with `--host codex` and a 7,500 second tool timeout. Both exceed the maximum 7,200 second job
budget, so the client does not cut off a valid attached call.

`scripts/smoke-delegation.mjs` runs the service against a fake App Server and needs Linux with the
containment prerequisites. `scripts/smoke-claude-delegation.mjs` runs the Agent SDK path against a
fake Claude Code process. Both drive the committed bundle over MCP stdio, the same path an install
runs, and neither needs `npm ci`, an account or network. Between them they cover both routes and
every denial, the workspace and lease checks, the job state machine, both provider protocols with
their crash paths, the quarantine barrier and charter delivery.
`scripts/smoke-bundle-drift.mjs` rebuilds from source and requires a byte-identical committed
bundle; it is the one script that needs `npm ci` in `plugins/flow/deps`. `.gitattributes` exempts
the bundle from the blank-at-end-of-line diff check, because bundled dependency string literals
hold whitespace-only lines.
