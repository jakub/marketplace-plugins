---
name: delegate
description: The operating manual for Flow's `flow_delegate` MCP tools. Read it before the first bridge call of a session, and for any question about cross-model or cross-family work, `delegate_to_codex`, `delegate_to_claude`, a delegation job, its result envelope, or the approval fork.
---

# delegate - reaching the other model family

Flow runs one durable delegation service in both directions. A Claude host reaches Codex through
Codex App Server; a Codex host reaches Claude through the Claude Agent SDK. Either way it is one
MCP server named `flow_delegate`, never a shell wrapper.

The charter says when to cross the family line and what to do with a refusal. This skill says
how the call works.

## The tools

Your host registers the new-call tool for the other family only. A Claude host has
`delegate_to_codex`, a Codex host has `delegate_to_claude`. Asking for your own family is
rejected as `SAME_FAMILY`, and a delegated job that tries to start another one is rejected as
`NESTED_DELEGATION`. The bridge is one hop deep.

Beside it you get `delegation_status` (read and reconcile one job), `delegation_result` (its
typed envelope), `delegation_events` (an ordered page of the durable journal),
`delegation_cancel`, `delegation_continue` (a new job resuming the provider's thread or
session), and `delegation_doctor`. `delegation_steer` adds text to an active turn and exists
only where the target is Codex, so only on a Claude host.

The job record is also readable as MCP resources: `flow://jobs` for this route's jobs newest
first, then `flow://jobs/{jobId}`, `flow://jobs/{jobId}/events` and
`flow://jobs/{jobId}/capabilities`. All JSON, filtered to jobs inside your workspace roots,
since the database is shared across workspaces.

Name the model and the effort on every call. Efforts are `low`, `medium`, `high`, `xhigh` and
`max` on both sides. Provider ids are not the charter table's short names: the Claude side takes
an alias (`sonnet`, `opus`, `fable`) or a full id (`claude-sonnet-5`, `claude-opus-5`,
`claude-fable-5-1`), and the Codex side takes `gpt-5.6-luna`, `gpt-5.6-sol` or
`gpt-daybreak-blue-latest`. Every Codex turn runs at the `default` service tier.

## Arguments that matter

`cwd` is an absolute directory inside a workspace root your client advertised, and Flow resolves
it to its Git worktree root before granting the provider anything. A path outside fails
`OUTSIDE_ROOTS`.

`access` is `read-only` or `workspace-write`, and it is the whole confinement of a delegated
writer. No plugin hook fires inside a delegated job: the delegated Claude query loads no
settings, plugins or skills, and the delegated Codex thread has plugin loading and every
discovered MCP server disabled. A `workspace-write` job leases that worktree exclusively, so a
second one fails with `WORKSPACE_BUSY` before a provider starts.

`delivery` is `attached` or `detached`. Attached blocks the tool call, streams progress, and
returns the finished envelope. Detached returns a job id straight away; poll `delegation_status`
or read `delegation_result` later.

`mode` is `task` or `adversarial-review`. Review requires `base` and takes `head` (default
`HEAD`), and Flow resolves both to full commit ids before the worker starts, so the diff under
review cannot move. It writes the reviewer instruction itself, keeps your `prompt` as extra
focus, and forces the strict findings schema.

`outputSchema` gets you a typed result on a task. Codex accepts only a subset, which Flow checks
before creating the job: an object root, an explicit type on every node,
`additionalProperties: false`, `required` listing every property, an item schema on every
array. Anything else is `BAD_SCHEMA`, as is a schema over 64 KiB.

`timeBudgetSeconds` runs from 30 to 7200 and defaults to 900. A Claude target also takes
`maxTurns` and `maxBudgetUsd` as native hard limits. A Codex target takes neither.

## Reading the envelope

Every tool answers `{ ok, job?, error? }`, and `delegation_events` answers
`{ ok, events?, error? }`. A rejected request is `{ ok: false, error }`; an attached job that
ended badly is `{ ok: false, job }` with the whole envelope still in it.

`status` is an active state (`queued`, `starting`, `running`, `reconciling`), or `quarantined`
(a provider outlived termination and still holds the write lease, so it is settled for you but
not terminal), or terminal: `succeeded`, `failed`, `cancelled`, `unknown`, `awaiting_approval`.

`error.kind` comes from `ERROR_KINDS` in `src/delegation/contracts.mjs`, the closed list every
tool declares. The ones you will actually meet are `SAME_FAMILY`, `NESTED_DELEGATION`,
`OUTSIDE_ROOTS`, `WORKSPACE_BUSY`, `BAD_SCHEMA`, `RATE_LIMIT`, `TIMEOUT`, `STALL` and `REFUSAL`.
A `REFUSAL` carries its category in `details`; the charter says where the single retry goes.

`commandFailures` counts recorded command completions that failed or exited nonzero, so a
succeeded job with a nonzero count answered without working shell evidence. On the Claude route
the field is always 0: the Agent SDK never reports an exit status, so Flow records nothing to
count and a zero there means the question was not asked.

A succeeded review with `findings: []` is not yet a pass. That is also the shape of a runner
that never started. Require a coverage finding, or call `delegation_continue` and ask which
files it read, before you treat an empty array as clean. An `unknown` job is never a pass; the
charter's UNKNOWN rule covers these exactly as it covers a native seat.

## What each provider can do

Both directions give you durable status, events, a typed result, cancel, continue and structured
output. Flow reports the differences instead of pretending:

- Steering an active turn works only against Codex.
- Recovering a result after the worker dies works only against Codex, through `thread/read`.
  An accepted Claude write whose worker died stays `unknown`: the SDK has nothing that could
  prove what the turn did.
- `maxTurns` and `maxBudgetUsd` exist only against Claude.

Do not infer symmetry from the tool names. `capabilities.json` at the plugin root is the
hand-maintained host table, biased false on purpose, and `delegation_doctor` returns it beside
the live target capabilities. Doctor also computes `hostCapabilities.drift` between the version
your host CLI reports now and the table's `verifiedAgainst`: `match`, `newer`, `older` or
`unknown`. Stop on `older` or `unknown`, because a record you cannot read has verified nothing.
Journal `newer` as a re-check and carry on. Verified against Codex CLI 0.152.0 and Claude Code
2.1.257 as of 2026-09-01.

## When the provider asks permission

A delegated provider runs with approvals off, so a request means it hit the edge of the sandbox
you gave it. When your MCP client advertises `elicitation.form` and the call is attached, the
envelope carries `elicitation: true` and Flow puts the request to the human as a two-value form:
the whole command with its working directory, the whole path list for a file change, or the tool
with its host title and its whole input.

A request Flow cannot show whole is declined without asking anyone, journaled as
`approval.undisclosed`. That covers a command or input over 4,000 characters, a file change with
no item on record, and network or stdin kinds with no command. A form that hides part of the
action would approve something the human did not see.

Anything other than an explicit accept is a decline: a dismissed or declined form, a client
error, or the 240-second window closing, which sits under the 420-second stall ceiling. A
decline ends the job as `awaiting_approval`, which is terminal and cannot be continued. Start a
new job with a different contract: wider `access`, or a prompt that does not need that command.
A permissions request is never put to the human, and a detached job is never asked because
nobody is waiting to answer.

## Running a call beside other work

Claude Code. The transport seat for a bridge call is `flow:bridge`, whose toolset is the
`flow_delegate` tools and ToolSearch and nothing else. Spawn it at a cheap model and low effort
with the call's arguments in its prompt. In a workflow script that is
`agent(prompt, {agentType: 'flow:bridge', effort: 'low', schema})`, where the delegated call's own
effort rides inside the prompt and the schema is what
`node <plugin-root>/dist/delegation.mjs schema envelope` prints.
It returns the envelope verbatim, and you read that as the tool result. Call the tool directly
instead when you want a synchronous answer.

Codex. This host binds no transport seat: `spawn_agent` narrows nothing, so a child carrying a
bridge call would hold the whole session's authority for one tool call. Call the tool directly.
A call that must not block the turn is `delivery: detached`, polled with `delegation_status`.

## Before the first call

Delegation needs Linux with cgroup v2 and a working systemd user manager, because every provider
process runs in a transient systemd scope, which is what makes releasing a write lease safe.
There is no path on another platform: containment fails closed with `UNSUPPORTED_HOST` and no
job starts. Run `delegation_doctor` as the preflight. It is the one tool that answers without a
workspace, which is what you need when the answer is that you have no workspace.