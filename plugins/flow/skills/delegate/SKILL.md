---
name: delegate
description: How to run a seat on another model, through flow_delegate jobs or T3 seats. Read it before your first delegate_to_codex, delegate_to_claude or delegate_task call in a session. Use when the user says "ask Sol", "ask Codex", "ask Fable", "ask Claude", "ask Neon" or "ask Gemini".
---

# delegate

The charter says when to cross lab lines; this page says how.

- **In T3 Code**, route seats through `delegate_task` (`## T3 seats` for Claude and Codex; `### 5. Antigravity / Gemini in T3` for Neon). `flow_delegate` is the Claude/Codex cross-family fallback.
- **Outside T3 Code**, `flow_delegate` reaches the other family (Codex from Claude Code, Claude from Codex). Same-family seats are native (`Agent`, `spawn_agent`).

Never call a model CLI through the shell: flow can't contain or track it there. `reference.md`, next to this file, holds every error kind, schema keyword, refusal table, Codex host setup, provider protocol and store contract. Read it when something fails or you need an advanced option.

## T3 seats (Claude and Codex)

A T3 seat is a `delegate_task` child held to the Seat Contract by flow's hooks. Don't mix up a T3 seat task id (`seat.mjs close`) with a `flow_delegate` job id (`delegation_result`).

### 1. Open

```sh
node <plugin-root>/scripts/seat.mjs open --access <read-only|workspace-write|review> \
  --provider <claude|codex> [--provider-instance-id <id>] --model <id> [--expected-served-model <id>] \
  --effort <level> [--worktree <absolute-path>] [--base <rev> --head <rev>] [--schema <absolute-file>]
```

- `--provider` is the hook host family (`claude` or `codex`), not the model vendor. `--provider-instance-id` defaults to `claudeAgent` or `codex`; pass exact spelling from `orchestrator_capabilities`. Pass `--expected-served-model` only for router models.
- Writers pass `--worktree`. Reviews pass `--base` and `--head` (`open` pins a detached review worktree under `.flow-worktrees/` and supplies the findings schema).
- `open` prints JSON with `tag`, `clientRequestId`, `runtimeMode`, `providerInstanceId`, `model` and `worktree`. On `HOOKS_UNTRUSTED` for Codex, see `reference.md` §Codex host setup; any refused seat falls back.

### 2. Start

Call `delegate_task` with:

- `task`: `tag` alone on line 1 (anywhere else voids the seat), worktree, checkpoints/work, reminder that the final message is the JSON envelope below, and verbatim line: `Follow the Seat Contract's "Stay in the foreground" rule.` For T3 writers, include exact commit form `git -C <worktree> commit -- <paths>` without quoted git/gh arguments (hooks deny bare `git commit` in the canonical checkout and read quoted args as missing). Tell the seat to report missing input in its envelope (question tools are denied).
- `role: "general"`, `mode: "async"`, `runtimeMode` from `open` (`auto` today; never `full-access` or `inherit`, and required on every `delegate_task` call in a flow session), `clientRequestId` from `open`.
- `target`: exact `providerInstanceId` and `model` from `open`, with effort in `options` as `effort` (Claude) or `reasoningEffort` (Codex).

### 3. The envelope and follow-ups

The child's final message is one JSON object (Stop hook blocks up to 3 times to enforce it):

```json
{"status": "done | partial | blocked",
 "coverage": {"read": [], "partial": [], "unopened": [], "checksRun": []},
 "notes": "",
 "answer": {}}
```

Writers add `commits: [{sha, subject}]`. To steer a running seat with verified state, call `t3_thread_send` (`mode: "steer"`) to `childThreadId` and verify in its envelope. To give a finished non-review seat another round (such as a dialectic critique), send via `t3_thread_send` before closing. A review or re-review is always a brand-new seat pinned to the head under review.

### 4. Wait and close

End your turn instead of polling; T3 wakes you when the child finishes. **Never take the answer from `summary`** (after a Stop block it holds the wrong text). Close every opened seat, cancelled ones included (`--abandon` if `delegate_task` never created a task):

```sh
node <plugin-root>/scripts/seat.mjs close <seat-id>
```

Retry `TASK_NOT_TERMINAL` or `T3_STORE_BUSY` up to 3 times with backoff; see `reference.md` §seat.mjs close for all refusals. Act on the verdict alone:

| Verdict | Do this |
|---|---|
| `valid` | Use `result`. Still verify a writer's commits in git. |
| `coverage-gap` | Use its findings; never count missed files (`reasons`) as reviewed. Open one scoped review seat on the same head for the missed files (second gap steps up a rung). |
| `invalid`, `capped` | Rerun once with Stop's `errors` on the same rung, then step up a rung. |
| `model-mismatch` | Discard the answer (not a refusal). |
| `unknown`, `tree-moved` | Nothing proves hooks held the seat. Fall back. |

### 5. Antigravity / Gemini in T3

`seat.mjs` supports `--provider claude` and `--provider codex` only. To run `Gemini 4 Neon` in T3 Code (when `orchestrator_capabilities` lists `antigravity` enabled), call `delegate_task` directly with no `<flow-seat>` tag:

- `target`: `{providerInstanceId: "antigravity", model: "gemini-4-neon", options: {thought_level: "<low|medium|high|xhigh>"}}` (note `thought_level`, not `effort`).
- `runtimeMode: "auto"`, `role: "general"`, `mode: "async"`.
- `task`: state read-only scope (or exact disjoint paths for a docs/writing lane), pin the commit range or `markup.mjs` screenshot paths for reviews, and tell the child to stay in the foreground.

Because no seat-guard hook holds an Antigravity child, snapshot the tree before and after with `node <plugin-root>/scripts/tree-snapshot.mjs <wt>`, read the answer from the completed task or thread instead of `seat.mjs close`, and never let an unseated Neon pass stand alone as the only gate on a `high`-risk PR. Outside T3 Code, `flow_delegate` reaches Claude and Codex only, so skip Gemini steps there.

## flow_delegate (outside T3 or fallback)

Five MCP tools: `delegate_to_codex` (on Claude) or `delegate_to_claude` (on Codex), `delegation_result`, `delegation_cancel`, `delegation_steer`, and `delegation_doctor` (run once as preflight before your first call).

- Always pass `model` (Claude alias like `opus`/`fable` or full id like `claude-opus-5-5`; Codex id like `gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6.1-terra`), `effort` (`low`..`max`), and `cwd` (absolute path inside a workspace root and Git worktree).
- `access`: `read-only` (default) or `workspace-write` (edits without committing; holds one write lease per worktree). The job sees only the repo, no MCP servers, hooks or host context, so inline everything it needs in `prompt`.
- `mode`: `task` (default) or `adversarial-review` (pass `base` and `head`; returns findings schema). Always require a file coverage list before counting a review clean (continue with `continue: <jobId>` if omitted).
- On clients declaring MCP tasks (`tasks.declaredOnThisCall`), omit `waitSeconds` to run async; elsewhere pass `waitSeconds: 0` (or use `flow:bridge` in Claude Code) and collect with `delegation_result`.
- Check `servedModel`, `commandFailures` (nonzero invalidates "tests pass") and `error.kind` (`REFUSAL` follows the charter refusal rule). See `reference.md` for `outputSchema`, steering, timeouts and full error kinds.
