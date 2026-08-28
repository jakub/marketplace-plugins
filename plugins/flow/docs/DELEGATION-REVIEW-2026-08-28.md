# Delegation review ledger, 2026-08-28

This file keeps the full Codex App Server, Claude Agent SDK, and MCP review in one place. It separates completed work from deferred work so a later release does not have to reconstruct the review from chat history.

The completed items below are present on the unreleased `fix/delegation-hardening` branch. They are not installed, pushed, or published. Flow remains at version 0.22.0 until release preparation updates both plugin manifests, the marketplace entry, and the catalog version.

## Main findings

### 1. Delegated Codex inherited host MCP authority

Status: fixed, unreleased.

A normal App Server thread loaded standalone MCP servers, plugin MCP servers, and app tools from the host's effective Codex configuration. The observed set included Flow itself, browser automation, developer documentation, Node REPL, and app tools. The delegated model therefore received more authority than the job contract declared.

Flow now performs these checks before it releases a prompt:

1. Read the effective MCP inventory without loading a thread.
2. Disable plugin loading and app loading in the thread's session config.
3. Disable every discovered standalone MCP server by name.
4. Start or resume the thread.
5. Read that thread's MCP inventory.
6. Refuse the job unless every remaining server is disabled and exposes zero tools.

The last check is the security boundary. If a future Codex release changes config merging or adds a new tool source, delegation fails before `turn/start` instead of continuing with extra tools.

Reference: <https://learn.chatgpt.com/docs/app-server> and <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>.

### 2. Some MCP clients provide no usable workspace roots

Status: partly fixed, with client integration still open.

The T3 Code client did not provide `roots/list` entries or a project-directory environment value during the review. Calls that need workspace authority must still fail with `NO_ROOTS`; accepting an arbitrary caller path would remove the containment check.

`delegation_doctor` now works without a root. It reports the MCP client identity, client capabilities, advertised root URIs, usable roots, project-directory input, and the selected working directory. It continues with database, runtime, account, and provider checks. The result uses `ok: false` with a named workspace error instead of returning an MCP tool failure.

Future client work should supply either MCP roots or the canonical project directory when it starts Flow. That change belongs in the client integration, not in Flow's trust rule.

### 3. The MCP client timeout was shorter than the job budget

Status: fixed, unreleased.

Codex defaults an MCP tool call to 60 seconds. Flow allows attached jobs to run for up to 7,200 seconds. The client could therefore abandon a healthy job while the worker continued in the background.

The Codex MCP definition now sets `tool_timeout_sec` to 7,500 seconds. The Claude MCP definition sets `timeout` to 7,500,000 milliseconds. Both values leave 300 seconds after the maximum job budget for interruption, terminal reporting, and transport cleanup.

Reference: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>.

### 4. The deprecated fixed workflow builds shell text from unchecked values

Status: deferred.

`workflows/issue-fixed.mjs` still has three shell-construction risks:

- `pluginRoot` receives weak validation before it enters generated shell commands.
- `contextPack` uses a fixed heredoc delimiter.
- `base` enters a shell command without shell-safe argument handling.

The fixed workflow is deprecated and receives no new features, but it remains a supported fallback. A future hardening change should replace shell interpolation with argument arrays or a structured command boundary. It should include malicious-path, delimiter-collision, and revision-input tests. This work was not mixed into the delegation service change.

### 5. App Server stdin errors could crash the Node process

Status: fixed, unreleased.

The App Server client handled child process errors and exits but did not attach an error listener to the writable stdin pipe. A write that raced child shutdown could emit `EPIPE` as an uncaught stream error.

The client now listens for stdin errors, rejects all pending requests with `APP_SERVER_EXIT`, terminates the child, and lets the worker apply the existing conservative read or write outcome. It also treats malformed JSON lines as `APP_SERVER_PROTOCOL` instead of ignoring them.

### 6. Codex read-only jobs could read outside the assigned workspace

Status: fixed, unreleased.

Codex's built-in `readOnly` sandbox and `:read-only` permission profile both grant host-root read access. `runtimeWorkspaceRoots` labels the project but does not narrow that read grant. A controlled live job read a marker file outside the assigned repository.

Flow now requires Linux and Codex CLI 0.150.1 or newer. It starts App Server with the experimental API and defines a custom `flow_delegation` profile in the thread config. That profile grants only Codex's minimal runtime reads, the canonical worktree, exact Git metadata, and one private job temporary directory. Network access is off. A write job keeps `.git`, `.agents`, `.codex`, and linked-worktree Git metadata read-only. Flow proves the whole worktree against the client roots for read and write jobs, so a nested root cannot widen into its parent repository. It checks App Server's `activePermissionProfile` before it sends the prompt. A second controlled live probe could no longer read the outside marker.

Doctor now tests the permission-profile API, starts an ephemeral thread with the same restricted profile, verifies the active profile ID, and checks that thread's MCP inventory. It reports the host and minimum-version requirements as separate checks.

### 7. Claude schema jobs denied the provider's structured-output tool

Status: fixed, unreleased.

Claude Code emits a native `StructuredOutput` tool call when the Agent SDK requests JSON Schema output. Flow supplied the output format but omitted that tool from its allowlist, so Flow's own PreToolUse hook denied valid schema completion.

Schema jobs now add `StructuredOutput` to both Claude tool lists and to the policy hook's allowed set. Plain jobs still deny it. The existing Ajv check remains the final result boundary.

### 8. Delegated review workers did not receive the Flow charter

Status: fixed, unreleased.

Codex review workers read the repository instructions, saw the required `<flow-charter>` block was missing, and could spend the turn diagnosing the missing session contract. The old developer instruction was also too short to carry current seat rules.

The build now reads `charter/charter.md` and injects that exact source into the committed bundle. Both Codex and Claude workers receive it. A final `<delegated-seat>` block then narrows the main-session charter: no subagents, no nested provider invocation, no publication, and no authority outside the assigned workspace and access mode. The charter remains hand-authored in one file.

### 9. Provider schema failures and failed turns exposed avoidable raw errors

Status: fixed, unreleased.

Claude Code rejected a valid Draft 2020-12 schema when it contained the top-level `$schema` marker. Codex rejected schemas that passed generic Ajv validation but did not meet its strict structured-output rules, such as a `const` node without an explicit type. A failed Codex turn could also return the provider's raw error string, including account data, internal paths, and rejected model names.

Flow now validates schemas for the selected provider before it creates a job. Codex schemas must use the object-root, explicit-type, closed-object, required-property, array-item, `anyOf`, and plain-reference rules that Flow supports. Unsupported schema applicators fail with `BAD_SCHEMA`. Flow removes only the top-level dialect marker from the provider copy and keeps the original schema for its local Ajv check. Failed Codex turns map to fixed public errors such as `BAD_MODEL`, `BAD_SCHEMA`, `CODEX_AUTH`, and `RATE_LIMIT`. Raw provider strings never enter the public result.

## Completed supporting work

### Job listing

`delegation_list` returns recent jobs for the current host and target. It supports exact status filters, limits from 1 through 100, and opaque cursor pagination. Before returning each row, Flow rechecks the stored working directory against the roots advertised on the current MCP connection. The response omits prompts, final output, structured output, and usage details.

### Doctor output

Doctor now distinguishes workspace discovery from provider health. It can show a healthy database and provider account while also naming a missing-root failure. The Codex route checks the Linux host, minimum CLI version, experimental permission API, active restricted profile, and MCP inventory on an ephemeral thread.

The current MCP SDK exposes the client name, version, and capabilities after initialization. It does not expose the negotiated protocol version. Doctor returns `null` for that value with an explanation rather than reading a private SDK field.

### Explicit host selection

MCP mode now requires `--host claude` or `--host codex`. The manifests already provide the correct value. A manual start without it exits with status 2. This matches the existing CLI rule and removes the old Claude default.

### Small hardening fixes

- Claude read policy includes credential files and config directories named by provider environment variables.
- Claude authentication error classification matches authentication terms without misclassifying words such as `Authoring`.
- SQLite transaction cleanup preserves the original error if `ROLLBACK` also fails.
- The delegation build no longer rewrites trailing whitespace across the generated bundle after esbuild finishes. The repository exempts that generated file from the blank-at-end-of-line diff check because bundled dependency string literals contain whitespace-only lines.
- Documentation now includes `reconciling`, root prerequisites, list behavior, timeout units, and Codex MCP isolation.
- Codex and Claude provider instructions use the current charter source instead of a copied summary.
- Provider schema validation happens before a rejected prompt can enter the durable job table.

## Deferred App Server features

These features are useful, but they need product decisions or a larger protocol change.

- Handle `item/tool/requestUserInput` and `mcpServer/elicitation/request` with a durable caller interaction model.
- Handle experimental dynamic `item/tool/call` requests only after Flow has an explicit tool allowlist and result schema.
- Add request attestation only after the trust and verification rules are defined.
- Expose provider quota, rate-limit reset time, and usage summaries through doctor or a separate read-only tool.
- Add first-class maximum turn count and provider cost limits where the provider supports them.
- Add context attachments and file checkpoints without widening workspace authority.
- Evaluate App Server tasks after the MCP client and server task semantics are stable enough for durable job mapping.
- Evaluate server instructions and native thread forks. Continuation currently resumes the same provider session through a new Flow job.
- Coordinate Flow's 14-day job retention with the longer lifetime of native provider sessions.
- Improve MCP tool annotations when the protocol can express that write behavior depends on the `access` input.
- Add a safe quarantine state for a provider process that survives repeated termination attempts. Do not release a write lease while that process may still write.

## Provider differences to preserve

Claude Agent SDK 0.3.251 does not provide live steering or a read API that can recover the terminal result of a lost query. Flow must not synthesize those features from transcript files. An accepted Claude write with a lost worker remains `unknown`.

Codex recovery may change a stale job only when `thread/read` proves the exact native turn reached a terminal state. Flow must not replay an accepted write prompt automatically.

Both routes must keep route ownership, depth checks, canonical-root containment, exclusive write leases, typed terminal states, and approval denial.

## Review claims rejected after verification

The review also produced claims that did not match the installed versions or the current design:

- `claude auth status --json` is supported by the installed Claude Code version.
- The Claude command sandbox already blocks writes outside the assigned worktree. Hook checks add diagnostics but do not replace that operating-system boundary.
- LavaMoat `allowScripts` guidance does not apply to the current pinned dependency and build path.
- Git versions older than 2.31 are outside this repository's supported machine baseline.
- A fixed retry count for process termination is unsafe if it releases the write lease while a child may still run.

## Release gate

Before publishing this work:

- rebuild `dist/delegation.mjs` from the pinned dependencies;
- run both deterministic delegation smoke suites;
- run manifest, bundle-drift, and repository smoke checks;
- run one authenticated read-only task through each route when both accounts have allowance;
- prove a delegated Codex job cannot read a controlled marker outside its workspace;
- run one structured-output task through each route and one review through each route;
- verify the delegated Codex thread reports no callable MCP tools;
- bump the Flow version in both plugin manifests and the marketplace entry;
- bump the marketplace catalog version;
- reinstall both host copies and start fresh client processes before the final live check.
