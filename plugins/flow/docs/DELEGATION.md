# Cross-family delegation

As of 2026-09-01, against Codex CLI 0.152.0 and Claude Code 2.1.257 as installed. Both deterministic smokes pass on those versions; the live-turn validations keep their own dates below, because nothing re-ran them today.

Flow provides one durable delegation service in both directions. A Claude Code host calls Codex through Codex App Server. A Codex host calls Claude through the Claude Agent SDK. Each host receives one native MCP server named `flow_delegate`, which exposes the new-call tool for the other model family and the small set of job controls listed below. It exposes nothing else.

The local job record belongs to Flow. The provider owns its native session and turn. This split keeps model work in the provider's supported protocol while Flow owns workspace checks, write leases, progress, cancellation, continuation, bounded recovery, and the public result type.

## Goals

The service must provide these properties:

- Both directions use MCP tools, not a shell wrapper agent.
- Every call states the model, effort, working directory, and access mode.
- Calls can stay attached to one tool call or run detached under a durable job ID.
- Attached calls report bounded progress from the same journal a detached caller can poll.
- Both providers support status, events, typed results, cancellation, and continuation.
- The service reports provider differences instead of claiming unsupported controls work.
- JSON Schema output is checked by the provider and checked again before Flow returns it.
- A process crash cannot turn an unknown write into success or trigger a blind retry.
- Two write jobs cannot own the same canonical worktree at once.
- A delegated model cannot call its own family or start another cross-family call.
- Installed plugins run a committed bundle and never install packages at runtime.

Both routes require Linux with cgroup v2 and a working systemd user manager, and Node 22 or newer. Every provider process runs in a transient systemd scope, which is what makes a write lease safe to release; there is no fallback for another platform, so containment fails closed with `UNSUPPORTED_HOST` and no job starts. The source carries no Windows or macOS branches, because a branch nothing can reach is a claim nobody checks.

## Route policy

Each plugin manifest starts the MCP server with a trusted `--host` argument. Tool input cannot replace it, and MCP mode refuses to start when the argument is missing or names an unknown family. The Codex manifest also names `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` and `PWD` in `env_vars`: Codex starts a stdio MCP server with a curated environment, and without the first two `systemd-run --user` cannot reach the user bus, so every provider scope fails with `CONTAINMENT_UNAVAILABLE`. `PWD` is there for a different reason. The Codex MCP client advertises no `roots` capability and sets no project-dir variable, so without it the server has no workspace and every tool call fails with `NO_ROOTS`. On the Codex host the server therefore takes `PWD`, the shell cwd the human launched `codex` from, as the workspace boundary. A session started with `codex -C <elsewhere>` works on a directory outside that boundary and fails closed with `OUTSIDE_ROOTS`, which is the intended answer. The Claude host never reads `PWD`, because it has real roots and `CLAUDE_PROJECT_DIR`. A worker adds `FLOW_DELEGATION_DEPTH=1` and its parent job ID to the provider process environment.

| Host | Target | Depth | Result |
|---|---|---:|---|
| Claude | Codex | 0 | allowed |
| Codex | Claude | 0 | allowed |
| Claude | Claude | any | denied |
| Codex | Codex | any | denied |
| either | either | 1 or more | denied |

The server checks the route when it creates a job. The worker checks it again before it starts a provider process. A child MCP server sees the depth variable and refuses new work. Job read and control methods also verify that the requesting host owns the stored route. Both hosts use the same default database, so a UUID from the other route is not authority.

## MCP tools and capabilities

The Claude manifest registers `delegate_to_codex`. The Codex manifest registers `delegate_to_claude`. Alongside it each host gets `delegation_status`, `delegation_result`, `delegation_events`, `delegation_cancel`, `delegation_continue` and `delegation_doctor`. A Claude host also gets `delegation_steer`, because its target is Codex. That is the whole tool set, and both smokes assert it as a set.

`delegate_to_codex` or `delegate_to_claude` starts a task or an adversarial review. Required fields are `prompt`, `cwd`, `model`, and `effort`. Access is `read-only` or `workspace-write`. Delivery is `attached` or `detached`. Both families take the same five effort levels, `low` through `max`.

Every job has a wall-clock limit from 30 through 7,200 seconds. Claude jobs may also set `maxTurns` from 1 through 1,000 and `maxBudgetUsd` from 0.01 through 1,000. Flow passes both values to the Agent SDK as native hard limits and records `MAX_TURNS` or `MAX_BUDGET` when the provider stops the query. Codex App Server does not expose matching fields on `turn/start`. The Codex MCP tool omits both fields, so a Codex-target job has no way to name a limit the provider cannot enforce, and the capability report marks both controls unavailable. Flow does not claim that a usage notification received after consumption is a hard limit.

`delegation_status`, `delegation_result`, and `delegation_events` read durable state for the current route. Status reconciles a stale record when the provider has a supported recovery method.

`delegation_cancel` records a cancel request. A queued job becomes cancelled without starting a provider. A live Codex turn receives `turn/interrupt`. A live Claude query receives the SDK `interrupt()` call. Both workers terminate their child process after a grace period when cooperative cancellation does not finish. On a quarantined job it does something else entirely, described under state and write safety.

`delegation_steer` sends text to Codex through `turn/steer`. Claude Agent SDK 0.3.251 has no equivalent control for an active query, so on a Codex host the tool is not registered at all and the capability report says `liveSteer: false`. A tool whose only behaviour is a typed refusal is worse than an absent one: the caller has to try it to learn what the capability report already said.

`delegation_continue` creates a new local job linked to the prior one. Codex resumes the saved thread. Claude resumes the saved session ID. The new job gets its own status, events, result, and time budget. An active job cannot continue. An `unknown` job cannot continue because Flow cannot prove the earlier write turn stopped.

`delegation_doctor` reports named checks for Node, provider containment, the provider runtime, account state, the job database, and provider initialization. Linux containment requires cgroup v2 plus a working systemd user manager. The Codex route also checks the Linux host requirement, minimum CLI version, experimental permission-profile API, active restricted profile, and MCP isolation on a real ephemeral thread. Doctor reports the MCP client identity, capabilities, advertised roots, usable roots, and project-directory input. Missing roots produce a normal diagnostic result with `ok: false`; they do not prevent unrelated checks from running. The MCP SDK does not expose the negotiated protocol version after initialization, so doctor marks that field unavailable instead of guessing. It returns the provider capability object.

Doctor is also the only tool that answers without a workspace, because explaining a missing root is what it is for. Every other tool needs one.

Doctor also returns `hostCapabilities`, a sibling of the target capability object rather than another named check. It answers a different question. `capabilities` says what Flow can do to a delegated job on the target. `hostCapabilities` says what the harness Flow is running under can do at all, so a command can decide whether to ask a question through a permission prompt or end the turn and wait. It carries `schemaVersion`, the host name, the `verifiedAgainst` provider version the entries were checked against, and one entry per capability id with `supported`, `verifiedAt`, `assurance`, and a `note`. Every id names both hosts. Beside it, doctor returns a top-level `client: { name, version }`, the MCP client identity observed in the initialize handshake, and nulls where no handshake supplied one.

`hostCapabilities.drift` is the service's own verdict on whether that record still describes the machine it is running on, so no caller compares version strings by hand. It carries `installed`, the bare version the host CLI reports right now, `verifiedAgainst`, the bare version half of the record, and `status`, one of `match`, `newer`, `older`, or `unknown`. On a Claude host the installed version is the MCP client version from the initialize handshake, because a Claude host is its own MCP client. On a Codex host it is what `codex --version` prints, because the Codex MCP client reports its own component version rather than the CLI's. The comparison is numeric on dot-separated integers, so 2.10.0 is newer than 2.9.0. A missing or unparseable operand is `unknown`, which the issue stage's preflight treats exactly like `older`: a preflight that cannot read its own record has verified nothing.

The table itself is `capabilities.json` at the plugin root, beside the bundle that reads it at runtime. Re-verifying a row is an edit to that file, with no rebuild and no version bump of the bundle. The inventory is hand-maintained, so it is biased false. An id nobody has probed on a host is `supported: false` with assurance `unverified`, which keeps a reader from mistaking silence for support. `mechanism` means a named feature was observed doing the thing, such as Claude's `disable-model-invocation` frontmatter keeping a skill out of automatic selection. A feature that only looks like it should work stays `unverified` until something watches it work: Codex's `allow_implicit_invocation: false` is honoured by the 0.151.0 source, but nothing has yet shown the plugin-loader path reaching that code, so its entry is `supported: false`, not a `mechanism`. `contract` means the behaviour rests on an agreement both sides keep with no receipt from the platform to check, such as a Codex turn that ends with a question and trusts the human to answer in the next one. A false entry never changes doctor's `ok`, because it reports a fact about the harness and not a failed probe.

| Control | Codex | Claude |
|---|---|---|
| durable status, events, and result | yes | yes |
| attached progress | yes | yes |
| cancel | yes | yes |
| continue native context | yes | yes |
| structured output | yes | yes |
| steer the active turn | yes | no, tool not registered |
| recover a result after worker death | yes, through `thread/read` | no |
| hard turn limit | no | yes, `maxTurns` |
| hard provider cost limit | no | yes, `maxBudgetUsd` |

## Job record

Flow stores data under `${XDG_STATE_HOME}/flow/delegation`, or `~/.local/state/flow/delegation` when `XDG_STATE_HOME` is unset. Tests and local development can replace the location with `FLOW_DELEGATION_STATE_DIR`.

`jobs.sqlite3` uses WAL mode, foreign keys, a busy timeout, and a schema version. A database written by an older Flow is dropped and recreated rather than migrated: it holds at most 14 days of operational history, and a migration ladder for rows nobody reads is more risk than the rows are worth. A database written by a NEWER Flow is refused, because its jobs may still be running.

The reset is refused while the older database still holds a live job. A detached worker and its provider outlive the MCP process that started them, and a workspace-write row holds the lease on its worktree, so dropping it would free a worktree something may still be writing to. Flow counts rows whose `status` is `queued`, `starting`, `running`, `reconciling`, `awaiting_approval` or `quarantined` (`status` is the one column every schema has, and an old `awaiting_approval` row counts as live), and if any exist it throws `STORE_UPGRADE_BLOCKED` naming the count and leaves the file untouched. Let those jobs finish, or cancel them with the previous Flow version, then upgrade. Doctor's `database` check reports the same kind. The `jobs` table records the request, route, canonical working directory, immutable review SHAs, model settings and limits, native session and turn IDs, heartbeat, provider process identities, result, error, usage, and parent job. The public envelope keeps the existing `threadId` field for both providers. For Claude that value is the native session ID.

The `events` table is an append-only ordered journal. The `controls` table carries cancel and steer requests. Flow clears control payloads after handling them and clears every remaining payload when a job ends. The `leases` table gives one write job exclusive ownership of one canonical worktree.

Flow prunes terminal jobs 14 days after they end. Events, controls, and leases use `ON DELETE CASCADE`. A terminal parent stays while a newer continuation refers to it, so pruning cannot break a live chain.

The database and state directory use owner-only permissions. Prompts live in the job record, not command-line arguments or process listings. Each worker clears the prompt at its conservative acceptance boundary. Events omit hidden reasoning and raw command output. They retain phase changes, tool names, bounded answer previews, changed paths, and usage.

## State and write safety

The stored states are:

```text
queued -> starting -> running -> terminal state
  |          |          |
  +----------+----------+-- stale worker -> reconciling -> terminal state or deferred recovery
                        |
                        +-- provider survives termination -> quarantined -> terminal state
                        +-- worker dies first -> quarantined -> reconciling
```

`queued`, `starting`, `running`, and `reconciling` are active. `quarantined` is settled for an attached caller but is not terminal. The other states are terminal. `awaiting_approval` means Flow denied an unexpected request. The caller must create a new job with a different contract.

The `job.starting` event records the worker PID and an operating-system process-start token. Recovery checks both values so PID reuse cannot make an unrelated process look like the worker. Flow fails before starting a provider when the operating system cannot supply a stable token.

A workspace-write job acquires a lease on the canonical Git worktree root in the same SQLite transaction that claims the job. A normal terminal result releases the lease only after the worker proves the provider process tree stopped. A second write job on that worktree fails with `WORKSPACE_BUSY` before it starts a provider.

If App Server, Claude Code, or a recorded descendant survives repeated termination attempts, Flow stores `quarantined` with the Linux systemd scope, provider process group, stable process-start identities, resume status, usage, and error. It keeps the write lease, returns the quarantine state to an attached caller, refuses continuation, and never prunes that row. The same barrier applies when an uncatchable worker exit leaves a recorded provider alive. `delegation_status` checks the kernel scope first, then the recorded group and identities. After they stop, Flow either applies the intended terminal state or resumes stale-job reconciliation. It releases the lease only after terminal proof. Missing identity data keeps the job quarantined there, because a status read has nothing to observe and recovery never guesses. Doctor reports the number of quarantined jobs in its database check, and reports `STORE_UPGRADE_BLOCKED` there when a legacy database still holding live jobs is what stopped the store from opening.

`delegation_cancel` is the way out of a quarantine that cannot end by itself. On a quarantined job it re-checks the scope, the process group and every recorded process identity. If anything is alive it refuses, and the refusal names what is alive so a human can go and look. If nothing is alive, including the case where nothing was ever recorded, it resolves the quarantine as `unknown` and releases the write lease: `unknown` because nothing proved what the turn did, and released because the alternative is a worktree no job can ever claim again.

For Codex, `turn/started` or the `turn/start` response supplies the native turn ID. Flow stores that ID, marks the turn accepted, and clears the prompt. If the worker later dies, status can read the exact turn through App Server and repair a proven terminal result.

For Claude, a successful SDK initialize response proves the CLI control channel is ready. Flow chooses the session ID and user-message UUID, stores both, marks the conservative write boundary, and only then releases that exact user message to the SDK input stream. A worker death after this point makes a write job `unknown`. Claude Agent SDK does not provide an API that can prove the lost query's terminal result. A read-only job fails instead.

Flow never maps a missing process, empty response, or transport error to success.

## Codex App Server contract

Validated with live delegated turns against Codex CLI 0.151.0 on Linux on 2026-08-29; the deterministic smoke passes against 0.152.0 as of the header date. Codex delegation requires Codex CLI 0.150.1 or newer. A missing provider-containment boundary fails with `CONTAINMENT_UNAVAILABLE`. Older or unreadable Codex versions fail before Flow creates a job.

The worker starts `codex app-server` over JSON lines with the experimental API enabled. Before it creates a thread, it reads the effective MCP inventory. The thread config disables plugin loading, app loading, and every discovered standalone MCP server. After the thread starts or resumes, Flow reads that thread's MCP inventory. It refuses to send the prompt unless every remaining server is disabled and exposes zero tools. This check prevents the delegated Codex process from inheriting the host's Flow server, browser tools, apps, or other local MCP authority.

Reading it back is the point, and it is the difference between the two routes. On Codex, MCP isolation and the restricted permission profile are both configured and then PROVEN: Flow asks the live thread what servers it has and what profile is active, and a mismatch stops the job before the prompt goes out. On Claude, the equivalents are configured and not read back, because the Agent SDK offers nothing to read them from. See the Claude section for what that means there.

Codex's built-in read-only sandbox can read the host filesystem. Flow does not use it. Each thread receives a custom `flow_delegation` permission profile. The profile grants read access to Codex's minimal runtime paths, grants the requested read or write access to the canonical worktree, and grants write access to one owner-only temporary directory for that job. It also grants read access to the resolved Codex executable and, for an npm install, its `@openai/codex` package root: Codex re-execs its own binary inside the bubblewrap namespace for every shell command, and a profile without that grant breaks all delegated commands with execvp ENOENT while the turn still completes (openai/codex#29049; validated against Codex CLI 0.151.0 on 2026-08-29). The grant can retire when upstream binds its own runtime unconditionally. Network access is disabled. Exact Git metadata paths remain read-only, including linked-worktree metadata outside the checkout. For write jobs, `.git`, `.agents`, and `.codex` also remain read-only when present. Flow sets the profile on `thread/start` or `thread/resume`, verifies that App Server reports it as active, and does not replace it at `turn/start`. The worker removes the private temporary directory after the provider stops.

After that check, the worker starts a turn with these values set explicitly:

- `approvalPolicy: "never"`
- the requested model and effort
- `serviceTier: "default"`
- `summary: "detailed"`
- the canonical working directory
- the active `flow_delegation` permission profile, with network disabled
- the caller's output schema when present

The worker builds the final answer from completed `agentMessage` items. Ajv parses and checks structured output again; one compile answers both questions, because compiling a schema validates it. Before job creation, Flow checks Codex schemas against the strict structured-output requirements it relies on: an object root, explicit types, closed objects, every property required, array item schemas, `anyOf`, and plain references. That walk is hand-written because no Ajv strictness rejects a well-formed schema for sitting outside Codex's subset, and sending constraints Flow did not inspect means a review shaped by rules the provider dropped. It removes the top-level JSON Schema dialect marker before sending an accepted schema to the provider. App Server notifications reset a 420 second quiet-period timer. A timeout or stall first sends `turn/interrupt`, then terminates the process if the turn does not end.

An approval request is unexpected under `never`. The worker denies it, records the method, and ends as `awaiting_approval`.

The App Server client treats malformed JSON lines, a closed stdin pipe, and early process exit as transport failures. It rejects every pending request and terminates the child. A broken pipe cannot become an uncaught Node process error. On Linux, Flow starts App Server inside one transient systemd scope. The cgroup keeps App Server and its descendants together across `setsid`, double-forking, and parent exit. The worker also snapshots descendants with stable process-start identities during the turn and before shutdown. Those identities remain useful after a user-manager restart or scope lookup failure.

## Claude Agent SDK contract

This contract was validated against Claude Code 2.1.250 and `@anthropic-ai/claude-agent-sdk` 0.3.251 on 2026-08-28, and its deterministic smoke passes against Claude Code 2.1.257 on 2026-09-01. The repository pins the exact SDK version used to build the committed bundle. The bundle contains the SDK library but not a Claude Code executable. It uses the installed `claude` binary and its current authentication.

Claude's current plan policy permits Agent SDK and `claude -p` usage to draw from Claude plan limits. Anthropic's planned June 15, 2026 usage-policy change is paused. Flow verified the linked policy on 2026-08-27. This is a dated operational dependency and must be rechecked before changing authentication or publishing guidance:

<https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan>

The worker calls `query()` with these controls:

- the requested model and a Claude-supported effort from `low` through `max`
- the optional native `maxTurns` and `maxBudgetUsd` hard limits
- the canonical working directory and exact native session ID
- streaming input, partial messages, and persistent sessions
- the caller's JSON Schema as the SDK output format when present, without the top-level dialect marker that Claude Code rejects
- `permissionMode: "dontAsk"` with a host callback that never grants a new approval
- no loaded setting sources, plugins, skills, MCP servers, browser, web tools, or subagents
- the Claude Code system prompt, Flow's current charter, and a final delegated-worker contract
- a sandbox that fails closed when unavailable

Every item on that list is CONFIGURED and none of it is read back. The Agent SDK has no call that reports the tool set, the MCP inventory, or the sandbox a running query actually ended up with, so Flow states the contract and trusts the SDK to apply it. The Codex route proves the same two properties against the live thread and refuses the job when the answer is wrong. That asymmetry is real and it is not a formatting difference: on Claude the isolation rests on the SDK doing what its options say.

The Claude worker also gives the provider no private temporary directory. The Codex worker creates one owner-only directory per job and points `TMPDIR` at it, and the permission profile grants write there and nowhere else outside the worktree. The Agent SDK has no equivalent knob, so a delegated Claude process uses the worker's own `TMPDIR`.

The sandbox blocks network access for commands, local binding, Unix sockets, and unsandboxed commands. Read-only jobs deny worktree writes. Write jobs grant the canonical worktree; Claude's own runtime temporary locations may remain writable, but another checkout does not. A PreToolUse policy also checks direct edits, direct shell writers, wildcard write targets, mutation-capable inline evaluators, and publication commands. It does not try to spot a nested provider launch in command text, because a text check is walked around in a dozen ways. The sandbox is the control that holds. It denies the effective Claude and Codex executable paths and every credential store, and the network allowlist is empty, so a provider a delegated command manages to start has no authentication and no egress. Direct reads and searches cannot enter common local credential stores or custom credential paths named by the provider environment. On Linux, the command sandbox and PreToolUse policy deny `/proc`, including process environments and descriptors. This still applies when the assigned worktree sits below a protected credential directory. The Claude process receives an explicit runtime, network, and provider-authentication environment allowlist instead of the host's complete environment. Auto-memory is disabled. Secret and proxy variables are removed from sandboxed commands. These checks do not depend on prompt compliance.

Workspace-write authority still covers the whole disposable worktree. The protected-file checks prevent direct hand edits and common opaque shell forms; they are workflow policy, not syscall mediation for every repository executable. Review the resulting Git diff before publishing, just as for a native agent with worktree-write access.

SDK initialization has a 30-second timeout. After prompt release, every SDK message resets the 420-second quiet-period timer. The job time budget and quiet-period limit both call `interrupt()` first, then close and terminate the process after a grace period. Flow starts Claude Code inside one transient systemd scope and checks the cgroup before it records a terminal write job. It also freezes and records descendants as fallback evidence.

The SDK `result` message is the native terminal proof. Flow records its text, provider usage, and typed provider failures such as `RATE_LIMIT`, `CLAUDE_AUTH`, or `BAD_MODEL`. A refusal is `REFUSAL`, with the category in `details`. Claude Code retries a refused turn on a fallback model by default, silently for a subagent-style query, so the delegated environment sets `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` and `CLAUDE_CODE_NO_MODEL_FALLBACK=1`, and the worker reads `stop_reason` on assistant messages and the `model_refusal_no_fallback` and `model_refusal_fallback` system messages. Neither variable is public API, and Claude Code 2.1.257 carries a third, feature-flagged fallback lane that reads neither, so the contract does not rest on them. Every assistant frame names the model that produced it; the worker compares that against the catalog id of the model it asked for, and a mismatch fails the job as `REFUSAL` when a refusal was seen and `MODEL_MISMATCH` otherwise. An answer from another model under the requested model's name is the one outcome the charter rules out. The model that actually answered is journaled as `model.served`. Schema jobs add Claude's native `StructuredOutput` tool to the delegated tool set. Plain jobs do not. For structured output, Ajv checks `structured_output` against the original schema before the job can succeed.

## Progress and public output

MCP progress notifications carry a monotonic event sequence and a bounded message. Codex events report native item types, command completion, changed paths, answer previews, usage, controls, and terminal state. Claude events report session setup, tool names, bounded answer previews, rate-limit state, controls, and terminal state. Neither route forwards hidden reasoning or unbounded shell output.

Every result uses one envelope:

```json
{
  "jobId": "UUID",
  "status": "succeeded",
  "host": "codex",
  "target": "claude",
  "model": "sonnet",
  "effort": "high",
  "mode": "task",
  "access": "read-only",
  "limits": {
    "timeBudgetSeconds": 900,
    "maxTurns": 20,
    "maxBudgetUsd": 2
  },
  "threadId": "native thread or session ID",
  "turnId": "native turn or user-message ID",
  "output": "final text or null",
  "structured": null,
  "findings": null,
  "usage": {},
  "commandFailures": 0,
  "error": null,
  "quarantine": null,
  "createdAt": 0,
  "updatedAt": 0
}
```

`commandFailures` counts the job's recorded command completions whose status was `failed` or whose exit code was nonzero, computed from the event journal on every read. A succeeded job with a nonzero count answered without working shell evidence; treat its output the way you would treat an unverified claim.

On the Claude route the field is ALWAYS 0. The Agent SDK reports a tool call starting and finishing but never its exit status, so Flow records no command completion events there and has nothing to count. A zero on a Claude job means the question was not asked, not that every command worked, and reading it as evidence is exactly the mistake the field exists to prevent.

Review mode uses one strict findings schema. A clean review returns an empty findings array. Both provider workers receive one section of the charter, `## Rules of Engagement - Everything Else`, read from `charter/charter.md` at build time and wrapped in a `<flow-charter scope="delegated-seat">` block. The rest of the charter is orchestrator doctrine a leaf seat cannot act on, and no binding profile rides with the section because it names no role. The narrower delegated-seat rule that forbids subagents and nested provider calls follows it. The payload ends with the Containment section of `seat-contract.md`, in a `<seat-contract scope="containment">` block. That section and no other. The remaining three are doctrine for a seat working an issue, so a caller that wants them puts them in its own task text. The public error contains a named kind, a short message, and bounded public details. It never contains a stack, raw provider payload, account identifier, model identifier from an error payload, or internal path. Owner-only `internal.error` events and `service.log` keep bounded diagnostic detail that the caller does not receive.

## Workspace trust

The MCP server asks the client for roots when the client supports `roots/list`. It also accepts the host's canonical project directory. At least one of those sources must name a usable directory before Flow can start or continue a job, or read one back. Doctor is the exception because it must explain a missing-root failure. A requested working directory must resolve inside one of those roots. Flow rejects missing paths, symlink escapes, and unrelated checkouts.

For every job, Flow checks the Git worktree root before it grants provider access to that root. A linked worktree beside the approved repository passes only when its common Git directory belongs to the approved root and Git lists that worktree. A caller-writable `.git` pointer alone is not proof. A nested client root does not silently widen into its parent worktree.

Review mode resolves base and head revisions to full commit IDs before the worker starts. The prompt names those immutable IDs.

## Retry and recovery rules

Flow does not replay accepted write prompts automatically. Codex may repair a stale job only when `thread/read` proves the exact native turn ended. Claude has no matching read API, so an accepted Claude write with a lost worker stays `unknown`.

A read-only caller may create a new job after a named failure. Continuation resumes native context but always uses a new local job and parent link. Cancellation is cooperative first. Forced termination after an accepted write produces `unknown` unless the provider already reported a terminal result.

## Packaging

Source lives under `src/delegation`. `deps/package.json` pins the MCP SDK, Ajv, esbuild, and the Claude Agent SDK. The build writes one committed ESM bundle at `dist/delegation.mjs`. That file has two entry modes, `mcp` and `worker`, and nothing else: a host starts the server, and the service starts one worker per job with a job ID, so the prompt does not cross a shell boundary. Both smokes drive the server the way a host does, over MCP.

The Claude manifest contains the direct `flow_delegate` server definition. It sets a 7,500,000 millisecond MCP call timeout. The Codex manifest points to plugin-root `.mcp.json`, which starts the same bundle with `--host codex` and a 7,500 second tool timeout. Both values exceed the maximum 7,200 second job budget so the MCP client does not cut off a valid attached call first. The build injects the Flow plugin version, the Agent SDK version, the current charter, and the seat contract into the bundle, the last through the `__FLOW_SEAT_CONTRACT__` define. The host capability table is deliberately not injected: it is read from `capabilities.json` at runtime, so re-verifying a row needs no rebuild. Both plugin manifests and Flow's marketplace entry carry that plugin version.

`scripts/smoke-bundle-drift.mjs` rebuilds from source and requires a byte-identical committed bundle. It needs a development checkout with `npm ci` already run in `plugins/flow/deps`. `.gitattributes` exempts the bundle from the blank-at-end-of-line diff check, because bundled dependency string literals contain whitespace-only lines.

A merged bundle is not a live bundle. Both host copies of the plugin have to be reinstalled and both clients restarted before a running session calls the new one.

## Acceptance checks

The deterministic test set covers:

- both allowed routes, same-family denial, nested denial, and route ownership
- workspace roots, linked worktrees, symlink escapes, job visibility, and write lease races
- full JSON Schema validation and immutable review revisions
- job transitions, event order, retention, the schema reset, the refusal to reset a legacy database that still holds live jobs, and concurrent database opens
- Codex App Server startup, deltas, controls, recovery, and unknown write outcomes
- the quarantine barrier, including the cancel that clears one nothing is left to observe
- the host capability inventory, its four drift statuses, and the table living outside the bundle
- delegated Codex MCP isolation, malformed protocol input, and broken App Server stdin
- delegated Codex permission-profile activation, workspace-only reads, protected Git metadata, and private temporary storage
- Claude SDK initialization, output, rate limits, approval denial, cancellation during startup, continuation, provider crashes, and unknown write outcomes
- Claude direct-tool and Bash permission policy
- conditional Claude `StructuredOutput` policy, provider-specific schema checks, charter delivery, and public provider-error redaction
- provider-specific MCP registration, host requirements, root diagnostics, capabilities, and progress
- plugin manifests, versions, hooks, charter injection, and byte-identical bundle generation

Both smokes drive the shipped bundle over MCP, because that is the only entry mode there is: the tested path and the shipped path are the same path. The Claude smoke uses the real SDK library against a fake Claude Code protocol process, and the Codex smoke a fake App Server, so neither spends plan usage and both can exercise failure cases. A human should still run one authenticated task through each route when both accounts have allowance; a fake proves the protocol, never the account.

## Deliberate limits

Flow does not pretend the providers have identical controls. Claude live steering and post-crash result recovery remain unsupported until the Agent SDK has native operations that can prove those outcomes. Flow will not infer them from transcript files.

The service does not grant model-requested approvals, expose raw chain-of-thought, share jobs across machines, bundle provider executables, or act as a general remote execution service. Those additions would increase authority or operational scope without making the current local cross-family calls more reliable.

Several App Server features are deliberately unused, because each needs a product decision before it needs code: caller-facing interaction (`item/tool/requestUserInput`, `mcpServer/elicitation/request`), experimental dynamic tool calls, request attestation, provider quota and rate-limit reporting, context attachments and file checkpoints, App Server tasks, server instructions and native thread forks, and any reconciliation between Flow's 14-day retention and the longer life of a native provider session. A delegated job continues by resuming the same provider session under a new Flow job, and that is the whole of it.

A thin `claude -p` text wrapper would lose native session continuation, structured control messages, cooperative cancellation and an honest acceptance boundary, which is why the Claude route uses the Agent SDK.
