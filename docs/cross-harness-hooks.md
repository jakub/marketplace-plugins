# Cross-harness hooks

This repository keeps hook behavior portable without pretending Claude Code and Codex
have the same event protocol. The stable unit is the plugin's policy or domain state.
Each harness gets a small adapter and its own registration file.

Prompt text follows the same split, but in one file. A stage both harnesses run is a single
`SKILL.md`: a body that names no host, then a `## Host mechanics` section at the end with one
subsection per harness. The command file that used to hold the steps is a one-sentence alias
pointing at that skill.

This document describes the implemented contract as of 2026-09-03. Product behavior
that can change is based on the current Codex hooks documentation and must be rechecked
before changing an adapter.

## Layout

Each compatible plugin is still a self-contained deployment unit:

```text
plugins/<name>/
  .claude-plugin/plugin.json     Claude manifest
  .codex-plugin/plugin.json      Codex manifest, only where Codex needs one for hooks or MCP
  hooks/hooks.json               Claude event registrations
  hooks/codex.json               Codex event registrations
  hooks/scripts/                 wire adapters and simple direct handlers
  lib/                           harness-neutral policy, rendering, or state
  skills/<stage>/SKILL.md        the whole stage: neutral steps, then ## Host mechanics
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
events, and recovery. A Codex App Server worker is the Phase 1 backend. A delegated seat's
instructions open with the charter's seat half, the same bytes a native subagent gets from its
hook, followed by the `<delegated-seat>` block; both are built into the bundle rather than read
from a hook at delegation time. See
[`plugins/flow/docs/DELEGATION.md`](../plugins/flow/docs/DELEGATION.md) for that contract.

## Implemented mapping

| Behavior | Claude Code | Codex | Shared core |
| --- | --- | --- | --- |
| Flow charter | Two `SessionStart` commands, one per half, each below Claude's 10,000-character output cap, plus one `SubagentStart` command that emits the seat half and skips `Explore` and `fork` | One `SessionStart` command that emits the whole charter in a single payload, plus one `SubagentStart` command that emits the seat half and skips nothing | `charter/charter.md` in two halves split by one marker line, and `lib/charter-payload.mjs`, which owns the split, the seat block and the byte budgets. One `inject-charter.mjs` serves every cell |
| Flow Bash guards | `PreToolUse` on `Bash` | `PreToolUse` on `Bash` | Existing no-backlog and Git guards; publication policy in `lib/hook-policy.mjs` |
| Flow protected files | `file_path` from Edit/Write input, `notebook_path` from NotebookEdit | Paths parsed from `apply_patch`'s `tool_input.command` | `protectedFileReason()` |
| Flow registry publication gate | `permissionDecision: "ask"` built from `publishReason()`, which strips quoted text before classifying | Deterministic deny with a manual-publish instruction, built from `publishOperationsStrict()`, which also classifies what a shell-execution form would run | `registryReason()` over the one `PUBLISH` table |
| Flow pull request merge | The human's explicit `/flow:land` invocation, then the stage's CI-green and unresolved-thread checks, are the gate; in a repo with a committed `.flow/managed` marker the guard denies a raw merge command and the stage runs `scripts/land-merge.mjs` | Same gate (the human asked in words), same checks, same denial, same executor | `mergeDenialFor()` decides both denials over `mergeShapes()`; the executor re-derives every fact from GitHub before merging |
| Flow prep stage | `/flow:prep` is a one-sentence alias: read `skills/prep-stage/SKILL.md` and follow the Claude Code subsection of its host mechanics | The plugin-namespaced `prep-stage` skill, with `agents/openai.yaml` setting `allow_implicit_invocation: false` | `skills/prep-stage/SKILL.md` - one body, one `## Host mechanics` section, one subsection per host |
| Flow issue stage | `/flow:issue` is a one-sentence alias: read `skills/issue-stage/SKILL.md` and follow the Claude Code subsection of its host mechanics | The plugin-namespaced `issue-stage` skill, with `agents/openai.yaml` setting `allow_implicit_invocation: false` | `skills/issue-stage/SKILL.md` - one body, one `## Host mechanics` section, one subsection per host |
| Flow land stage | `/flow:land` is a one-sentence alias: read `skills/land-stage/SKILL.md` and follow the Claude Code subsection of its host mechanics | The plugin-namespaced `land-stage` skill, with `agents/openai.yaml` setting `allow_implicit_invocation: false` | `skills/land-stage/SKILL.md` - one body, one `## Host mechanics` section, one subsection per host |
| Gripe advertisement | `SessionStart`, `SubagentStart` | Same events | Existing advertisement and storage code |
| Gripe repeated failures | `PostToolUseFailure` and top-level `error` | Not mapped; `PostToolUse` has no reliable failure status | `recordRepeatedFailure()` in the Claude adapter |
| Gripe checkpoint | Claude transcript folded incrementally at `Stop` and `SubagentStop` | `PostToolUse` folds counters, parent `Stop` evaluates them | `lib/checkpoint.mjs` |
| Gripe denial and turn-failure observations | `PermissionDenied`, `StopFailure` | Not registered; Codex has no equivalent after-the-fact events | Existing Claude-only observed-row code |
| Gripe CLI resolution | `~/.claude/plugins/cache/jakub/gripe/*/bin/gripe` | `${CODEX_HOME:-~/.codex}/plugins/cache/jakub/gripe/*/bin/gripe` | `bin/shim.mjs` globs both roots every run, skips `.orphaned_at` versions, ranks by the version in the directory name, and execs the newest |
| Unslop rules | `SessionStart`, `SubagentStart` | Same events | `lib/rules.mjs` and `lib/agent-selection.mjs` |

## Deliberate non-equivalences

### Publication asks become denies

Claude can return `permissionDecision: "ask"` from `PreToolUse`. Codex parses that value but
treats it as an unsupported hook result, reports a hook failure, and lets the tool continue.
That was first captured on Codex CLI 0.149.1 (2026-08-26) and is still the behaviour on
0.152.0 (2026-09-01). Returning the Claude result from a shared handler would therefore fail
open on the exact irreversible operation the guard exists to stop.

The shared policy returns a reason. Claude's adapter turns it into an approval request.
Codex's adapter denies the command and tells the agent that the human can run it after
review. This is a capability difference, not a policy fork.

The two adapters do not read the command the same way, and on this path Codex is the stricter
one. Claude's `publishReason()` treats a quoted string as inert text, so `cargo publish` asks
but `bash -lc 'cargo publish'` does not: the wrapper hides the operation from the classifier.
Codex's `publishOperationsStrict()` classifies the command and, when the command names a form
that executes a string, every quoted payload too, so it denies the wrapped publish. Both
directions were chosen. A false deny on a deny-by-default path costs a human one rephrase; a
false allow ships a release nobody can unship. The Claude guard keeps the prose exemption it has
always had, which is why a sentence about publishing can still be written in a commit message
there, and why a shell-wrapped publish gets no prompt from it.

### The merge path is a cooperative guardrail, not a boundary

Both harnesses route a merge the same way, so this is no longer a fork. The gate is upstream of
the command: the land stage runs only when the human asks for it, by `/flow:land` on Claude or in
words on Codex, and the stage's own CI-green and unresolved-thread checks decide whether the merge
is warranted. In a repo carrying a committed `.flow/managed` marker, each host's publish guard
denies a merge-shaped command through the shared `mergeDenialFor()` and names
`scripts/land-merge.mjs`, which the stage runs instead. Neither host asks for anything beyond that
pair, the request and the gates.

None of this is a security boundary. Everything runs as one uid, where a determined model could
substitute its own gh, call the GitHub API with the token, or curl the merge endpoint, and no
hook would see it. The guard's classifier is also coarse by design: a shell option before `-c`,
a gh flag between `pr` and `merge`, a `cd` into the repo, or a `GH_REPO` redirect can slip a
merge-shaped command past the text match. These are known and accepted limits, not defects to
chase, because closing them buys nothing at same-uid.

What the guardrail actually enforces is downstream and deterministic. The committed
`.flow/managed` marker enrols the repository (a deleted worktree copy does not un-enrol it, and
the marker is a protected file). The executor takes only a pull request number and the head the
gates ran against, pins every gh call to the repository derived from the origin remote, reads the
head, state, draft flag and base from live GitHub state, refuses an armed auto-merge or a
merge-queue base, merges with `--match-head-commit` pinned to the head it verified, and reports
merged, failed, or genuinely unknown rather than guessing. It stops the accident: a merge of the
wrong pull request, of a head nobody saw, onto a base nobody was shown. It does not pretend to
stop an adversary who already owns the uid.

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

Codex `PostToolUse` runs after a non-zero Bash exit, but its `tool_response` is tool-specific
model-facing output rather than stable result metadata. In a 2026-08-26 capture from Codex CLI
0.149.1, `sh -c "exit 7"` produced `tool_response: ""`; no exit status reached the hook. Gripe
does not infer failure from prose or guessed object fields. The Codex adapter folds only tool
and target repetition into checkpoint state, while the repeated-failure nudge remains
Claude-only. The captured shape is retained as a smoke-test fixture.

### The gripe CLI resolves both harnesses

`~/.local/bin/gripe` is a copy of `plugins/gripe/bin/shim.mjs`, never a symlink to a versioned
path, and it decides which install to run on every invocation. It imports node builtins only,
because it runs before any plugin root is known.

`GRIPE_HOME` comes first, judged by key presence rather than by value. Otherwise the shim globs
both plugin cache roots on every run, `~/.claude/plugins/cache` and `${CODEX_HOME:-~/.codex}/plugins/cache`,
taking `jakub/gripe/<version>/bin/gripe` under each, and runs the highest live version it finds
whichever harness installed it. Claude Code marks a removed version with `.orphaned_at` and the
shim skips it; Codex writes no such marker, so a removed-but-cached newer version keeps winning
there until its directory is deleted.

The shim carries one `// gripe-shim-epoch: <n>` marker, at 2 since the resolver stopped reading
manifests, and the SessionStart hook that maintains the published copy is an upgrade-only ratchet.
Gripe 0.2.x has no marker logic at all, so a harness still registered on it overwrites the newer
shim at every session start there, which is why the README says to upgrade both in one sitting.

Every exit code, the residual races accepted as shipped, and the reasoning behind each of these
decisions are in [`docs/gripe/DESIGN.md`](gripe/DESIGN.md).

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
  per-session lock. Contention loses advisory evidence after half a second (25 attempts, 20 ms
  apart), and a lock left behind by a killed holder is unlinked once it is ten seconds old;
  neither delays the hook past its five-second timeout or blocks the agent's work.
- Flow enforcement adapters deny when the target cannot be inspected. Gripe and Unslop are
  advisory and exit quietly when their own input cannot be parsed.
- Codex SessionStart context limits are sized above the current Flow and Unslop payloads so
  both arrive inline. Flow's charter hook declares an 8,000-token limit, and its conformance
  lint holds what the injector actually prints under a 22,000-byte maintenance budget; Unslop
  retains Claude's 10,000-byte output checks. Codex spills oversized output to a file and
  supplies a preview, so spilling is a degraded fallback rather than silent loss.

## Testing without installation

The adapters are ordinary stdin/stdout programs and can be tested from a working tree:

```bash
node scripts/smoke-plugin-manifests.mjs
node plugins/flow/scripts/smoke-delegation.mjs
node plugins/flow/scripts/smoke-codex-hooks.mjs
node plugins/flow/scripts/smoke-charter-conformance.mjs
node plugins/flow/scripts/smoke-stage-conformance.mjs
node plugins/flow/scripts/smoke-label-contract.mjs
node plugins/flow/scripts/smoke-git-guard.mjs
node plugins/flow/scripts/smoke-protect-files.mjs
node plugins/flow/scripts/smoke-publish-guard.mjs
node plugins/gripe/scripts/smoke-hooks.mjs
node plugins/gripe/scripts/smoke-shim.mjs
node plugins/unslop/scripts/smoke-hooks.mjs
```

That is the adapter and prompt-shape subset, not the whole suite. Every `smoke-*.mjs` under
`plugins/*/scripts/` runs the same way, so take the full list from `ls` rather than from this
block: a new smoke is picked up and a deleted one stops being reported.

The manifest test derives each plugin's version and description from the marketplace manifest
and checks that a plugin's Claude manifest, its Codex manifest where it has one, and its
marketplace entry all agree. It also holds the rule about which plugins get a Codex manifest at all: one that
registers Codex hooks or an MCP server must carry one, and a skills-only plugin needs none,
because Codex finds `skills/*/SKILL.md` by itself. Then it checks supported Codex event names
and that every `${PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` command target exists on disk.
There is no catalog version, so releasing a dual-harness plugin is three edits: the two plugin
manifests and the marketplace entry.

Plugin smoke tests cover both positive and negative wire cases with throwaway state, including
the captured Codex failure payload that deliberately remains unclassified. The lints that read
a document work the same way and keep no fixture tree on disk: each one carries its broken
examples as inline strings, runs its own checker over them, and asserts the defect it names,
so a green run also shows the check can still fail. The charter conformance lint checks that
the charter carries exactly one seat-rules marker, that each required heading lands on the side
of it that reaches the right reader, that what the injector prints in all four modes stays under
the caps, that `Explore` and `fork` are skipped on Claude and still delivered on Codex, and that
a delegated job's preamble is the seat half byte for byte. The stage conformance lint finds every
stage by structure and holds it to the one-file shape: no host named above the line, exactly
one `## Host mechanics` heading as the last section, a `### Claude Code` and a `### Codex`
subsection under it in that order with prose in each, implicit invocation off, and an alias
that is one heading plus one routing sentence naming the stage file, under its own
`allowed-tools` line.

`smoke-shim.mjs` builds synthetic Claude and Codex plugin caches under one temporary directory
and drives the resolver against them: version skew across the two caches, a directory name that
is not dotted integers, a version directory with no runnable `bin/gripe`, an absent cache on
either side, `CODEX_HOME`, the `GRIPE_HOME` override, the exit split between `gripe add` and
every other subcommand, and the epoch ratchet. `smoke-label-contract.mjs` parses the taxonomy
table out of `plugins/flow/skills/flow/label-contract.md` and holds the tuple to its rules,
unique names, six-hex colors, one color per lane, and descriptions that stay short and carry no
slash-command spelling, because those strings are copied into GitHub metadata in other
repositories.

These tests do not enable, install, or trust a plugin. Codex skips untrusted plugin hook
definitions until the user reviews them. Claude plugin installs still pull from the pinned
repository clone, so testing a published Claude install remains a separate commit, push,
reinstall, and new-session operation.
