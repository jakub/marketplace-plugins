# Cross-harness hooks

This repository keeps hook behavior portable without pretending Claude Code and Codex
have the same event protocol. The stable unit is the plugin's policy or domain state.
Each harness gets a small adapter and its own registration file.

Prompt text follows the same split. A stage that both harnesses run is one host-neutral
skill body plus one profile per harness, and the command file that used to hold the steps
becomes an alias that reads its own profile first.

This document describes the implemented contract as of 2026-08-30. Product behavior
that can change is based on the current Codex hooks documentation and must be rechecked
before changing an adapter.

## Layout

Each compatible plugin is still a self-contained deployment unit:

```text
plugins/<name>/
  .claude-plugin/plugin.json     Claude manifest
  .codex-plugin/plugin.json      Codex manifest, points at hooks/codex.json
  hooks/hooks.json               Claude event registrations
  hooks/codex.json               Codex event registrations
  hooks/scripts/                 wire adapters and simple direct handlers
  lib/                           harness-neutral policy, rendering, or state
  skills/<stage>/SKILL.md        harness-neutral prose, one [[gate:<id>]] per checkpoint
  skills/<stage>/profiles/       one file per harness, one section per gate
  skills/<stage>/agents/         Codex-side skill metadata and invocation policy
```

There is no cross-plugin runtime package. Copying a small adapter boundary inside each
plugin is cheaper and safer than making one installed plugin depend on another plugin's
files. The shared code is shared between harnesses inside one plugin, where versioning and
installation remain atomic.

The dependency direction is one way:

```text
Claude adapter ─┐
                ├─> policy, rendering, state ─> plugin-owned effects
Codex adapter ──┘
```

Policy modules never emit a hook event name. Adapters never reimplement a policy rule.
Registration files contain paths, matchers, timeouts, and context limits, not business
logic.

Cross-family model calls use a related adapter shape, but they are not hooks. Flow's Claude
manifest starts a local MCP server, while its shared job service owns route checks, state,
events, and recovery. A Codex App Server worker is the Phase 1 backend. The delegated seat's
instructions carry the target host's binding profile between the charter and the
`<delegated-seat>` block, built into the bundle rather than read from a hook at delegation
time. See [`plugins/flow/docs/DELEGATION.md`](../plugins/flow/docs/DELEGATION.md) for that
contract.

## Implemented mapping

| Behavior | Claude Code | Codex | Shared core |
| --- | --- | --- | --- |
| Flow charter | Two `SessionStart` commands split below Claude's output cap, then a third that runs `inject-profile.mjs` and emits the `<flow-profile>` block | One ordered `SessionStart` command that emits the charter and the Codex profile in a single payload, under a 6,000-token inline limit | Host-neutral `charter/charter.md`, whose `[[role:<id>]]` markers each host's `charter/profiles/<host>.md` binds |
| Flow Bash guards | `PreToolUse` on `Bash` | `PreToolUse` on `Bash` | Existing no-backlog and Git guards; publication policy in `lib/hook-policy.mjs` |
| Flow protected files | `file_path` from Edit/Write input | Paths parsed from `apply_patch`'s `tool_input.command` | `protectedFileReason()` |
| Flow registry publication gate | `permissionDecision: "ask"` | Deterministic deny with a manual-publish instruction | `publishReason()` |
| Flow pull request merge | Pre-approved `gh pr merge --squash --match-head-commit`, no per-command prompt. The human's explicit `/flow:land` invocation, then the stage's CI-green and unresolved-thread checks, are the gate | Same gate (the human asked in words), same checks; a repo with a committed `.flow/managed` marker routes the merge through `scripts/land-merge.mjs`, which re-derives every fact from GitHub before merging | `mergeShapes()` classifies the routed commands; the executor holds the checks |
| Flow prep stage | `/flow:prep` is an alias that reads `skills/prep-stage/profiles/claude.md`, then the skill | The plugin-namespaced `prep-stage` skill, with `agents/openai.yaml` setting `allow_implicit_invocation: false` | `skills/prep-stage/SKILL.md`, whose `[[gate:<id>]]` markers both profiles must bind |
| Flow land stage | `/flow:land` is an alias that reads `skills/land-stage/profiles/claude.md`, then the skill | The plugin-namespaced `land-stage` skill, with `agents/openai.yaml` setting `allow_implicit_invocation: false` | `skills/land-stage/SKILL.md`, whose `[[gate:<id>]]` markers both profiles must bind |
| Gripe advertisement | `SessionStart`, `SubagentStart` | Same events | Existing advertisement and storage code |
| Gripe repeated failures | `PostToolUseFailure` and top-level `error` | Not mapped; `PostToolUse` has no reliable failure status | `recordRepeatedFailure()` in the Claude adapter |
| Gripe checkpoint | Claude transcript folded incrementally at `Stop` and `SubagentStop` | `PostToolUse` folds counters, parent `Stop` evaluates them | `lib/checkpoint.mjs` |
| Gripe denial and turn-failure observations | `PermissionDenied`, `StopFailure` | Not registered; Codex has no equivalent after-the-fact events | Existing Claude-only observed-row code |
| Unslop rules | `SessionStart`, `SubagentStart` | Same events | `lib/rules.mjs` and `lib/agent-selection.mjs` |

## Deliberate non-equivalences

### Publication asks become denies

Claude can return `permissionDecision: "ask"` from `PreToolUse`. Codex currently parses
that value but treats it as an unsupported hook result, reports a hook failure, and lets the
tool continue. Returning the Claude result from a shared handler would therefore fail open
on the exact irreversible operation the guard exists to stop.

The shared policy returns a reason. Claude's adapter turns it into an approval request.
Codex's adapter denies the command and tells the agent that the human can run it after
review. This is a capability difference, not a policy fork.

### The Codex merge path is a cooperative guardrail, not a boundary

Claude does not prompt per command. The `gh pr merge --squash` runs pre-approved under the
session's `Bash(gh:*)` allowance, and the Claude publish guard asks only about package-registry
publishes, not this merge. The gate is upstream of the command: the land stage runs only when the
human invokes `/flow:land`, and its own CI-green and unresolved-thread checks decide whether the
merge is warranted. Codex has the same gate in different clothes: the human asks for the land in
words, the same stage gates run, and in a repo carrying a committed `.flow/managed` marker the
publish guard routes the merge through `scripts/land-merge.mjs` instead of a raw gh command. (An
earlier design added a human-written release sanction here; it was retired 2026-08-29 - the
per-land ceremony cost more than it bought at this trust level, and the Claude path never had it.)

None of this is a security boundary. Everything runs as one uid, where a determined model could
substitute its own gh, call the GitHub API with the token, or curl the merge endpoint, and no
hook would see it. The guard's classifier is also coarse by design: a shell option before `-c`,
a gh flag between `pr` and `merge`, a `cd` into the repo, or a `GH_REPO` redirect can slip a
merge-shaped command past the text match. These are known and accepted limits, not defects to
chase, because closing them buys nothing at same-uid.

What the guardrail actually enforces is downstream and deterministic. The committed
`.flow/managed` marker enrols the repository (a deleted worktree copy does not un-enrol it, and
the marker is a protected file). The executor takes only a pull request number, pins every
gh call to the repository derived from the origin remote, reads the head, state, draft flag and
base from live GitHub state, refuses an armed auto-merge or a merge-queue base, merges with
`--match-head-commit` pinned to the head it verified, and reports merged, failed, or genuinely
unknown rather than guessing. It stops the accident: a merge of the wrong pull request, of a
head nobody saw, onto a base nobody was shown. It does not pretend to stop an adversary who
already owns the uid.

### Codex protected-file checks parse the patch envelope

Claude Edit and Write calls expose `tool_input.file_path`. Codex performs file edits through
`apply_patch`, whose hook input puts the complete patch in `tool_input.command`. The Codex
adapter enumerates Add, Update, Delete, and Move targets, then calls the same protected-file
policy for every path.

If the envelope is missing, malformed, empty, or contains an unknown target directive, the
adapter denies it. An allow-on-parser-error path would make a new patch syntax a bypass.

### Gripe does not parse Codex transcripts

Codex exposes `transcript_path`, but explicitly does not promise a stable transcript format.
The Codex Gripe adapter therefore folds bounded counters from structured `PostToolUse`
events. `Stop` reads that state and uses the same evidence thresholds and note builder as
Claude.

Codex `PostToolUse` does not expose a stable subagent actor identifier. Codex checkpoint
evidence is therefore aggregated for the parent session and evaluated only on the main
`Stop`. A Codex `SubagentStop` checkpoint is intentionally absent. False attribution would
be worse than reduced coverage.

Known limit: the advertised `gripe` CLI resolves the installed plugin through Claude's
`installed_plugins.json`, so on a Codex-only host every advertised filing quietly drops.
The hooks still run; the shim needs a Codex resolution path before a Codex-only install
can file anything.

Codex `PostToolUse` runs after a non-zero Bash exit, but its `tool_response` is tool-specific
model-facing output rather than stable result metadata. In a 2026-08-26 capture from Codex CLI
0.149.1, `sh -c "exit 7"` produced `tool_response: ""`; no exit status reached the hook. Gripe
does not infer failure from prose or guessed object fields. The Codex adapter folds only tool
and target repetition into checkpoint state, while the repeated-failure nudge remains
Claude-only. The captured shape is retained as a smoke-test fixture.

### Unsupported observed signals stay unsupported

Claude's `PermissionDenied` event records a human denial after it happened. Codex's
`PermissionRequest` runs before the approval UI and cannot report what the human chose.
Likewise, Codex has no equivalent of Claude's `StopFailure` payload. Neither event is mapped
to a nearby event with different meaning.

## State and output boundaries

- Claude and Codex checkpoint scan files use separate names. Gate fingerprints remain
  shared because they prevent a Claude repeated-failure nudge and a later checkpoint from
  buying two interruptions.
- Gripe recognizes `CLAUDE_CODE_SESSION_ID`, `CODEX_SESSION_ID`, and `CODEX_THREAD_ID` when
  a self-reported filing captures its session.
- Every state map is bounded. A corrupt or missing state file degrades to a missed advisory
  nudge, never a blocked task.
- Codex PostToolUse and Stop serialize their shared checkpoint state through a bounded
  per-session lock. Contention loses advisory evidence after one second, and a lock left
  behind by a killed holder is broken once it is ten seconds old; neither delays the hook
  past its five-second timeout or blocks the agent's work.
- Flow enforcement adapters deny when the target cannot be inspected. Gripe and Unslop are
  advisory and exit quietly when their own input cannot be parsed.
- Codex SessionStart context limits are sized above the current Flow and Unslop payloads so
  both arrive inline. Flow's smoke test holds the charter under a conservative 15,000-byte
  maintenance budget and the Codex profile under 3,000 bytes, an 18,000-byte combined
  maintenance budget for the raised 6,000-token inline limit; Unslop retains Claude's
  10,000-byte output checks. Codex spills oversized output to a file and supplies a
  preview, so spilling is a degraded fallback rather than silent loss.

## Testing without installation

The adapters are ordinary stdin/stdout programs and can be tested from a working tree:

```bash
node scripts/smoke-plugin-manifests.mjs
node plugins/flow/scripts/smoke-delegation.mjs
node plugins/flow/scripts/smoke-codex-hooks.mjs
node plugins/flow/scripts/smoke-charter-conformance.mjs
node plugins/flow/scripts/smoke-stage-conformance.mjs
node plugins/gripe/scripts/smoke-hooks.mjs
node plugins/unslop/scripts/smoke-hooks.mjs
```

The manifest test derives each plugin's version from the marketplace manifest and checks
Claude/Codex/marketplace parity, supported Codex event names, `${PLUGIN_ROOT}` use, and
every registered command target. Plugin smoke tests cover
both positive and negative wire cases with throwaway state, including the captured Codex
failure payload that deliberately remains unclassified. The charter conformance lint checks
that every `[[role:<id>]]` marker in the charter is bound in both host profiles, that the
charter stays free of host names outside its three model-naming sections, and that both
charter halves and each profile hold under their byte budgets; it runs the same checks over
the per-case broken fixtures under `scripts/fixtures/charter-conformance/`. The stage
conformance lint finds every stage by structure, any directory under `skills/` holding a
`profiles/` subdirectory, and per stage compares the skill's gate ids against each profile's
sections in both directions, rejects a host name in the shared body, and holds the alias's
tool allowance equal to the Claude profile's. It runs the same checks over the per-case
broken fixtures, both the bare skill-and-profile pairs and the miniature plugin roots, so a
green run also shows the check can still fail.

These tests do not enable, install, or trust a plugin. Codex skips untrusted plugin hook
definitions until the user reviews them. Claude plugin installs still pull from the pinned
repository clone, so testing a published Claude install remains a separate commit, push,
reinstall, and new-session operation.
