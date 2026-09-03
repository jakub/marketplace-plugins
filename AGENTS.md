# marketplace-plugins - how to work in this repo

This is jakub's Claude Code plugin marketplace (README.md is the user-facing tour). The repo root holds the marketplace manifest at `.claude-plugin/marketplace.json` (marketplace name `jakub`) and shared docs; everything else is a self-contained plugin under `plugins/`. Install strings are `<plugin>@jakub`.

The charter you already have in context says how we build. This file is only about what's specific to editing the plugins themselves, and it carries only what you need *before* you open a file: the traps, the contracts between files, and where things live. Why a mechanism works the way it does lives in that file's own header, which you are reading by the time it matters. When something here starts explaining a mechanism, move it into the header and leave a pointer.

## Versions and publishing

Each plugin has one version, written in up to three places that must agree: `plugins/<name>/.claude-plugin/plugin.json`, its entry in the marketplace manifest, and `plugins/<name>/.codex-plugin/plugin.json` when the plugin ships one. The marketplace entry is the number that matters, because both plugin managers name the cache directory after it. The description is mirrored across the same files and checked the same way. A Codex manifest exists only where Codex needs it, for a `hooks` or `mcpServers` pointer; a skills-only plugin (grill) has none, since Codex discovers `skills/*/SKILL.md` on its own. There is no catalog version. `scripts/smoke-plugin-manifests.mjs` enforces all of it.

Installs pull from the pinned GitHub clone, never from this working tree. To test a change: commit, push, then `claude plugin uninstall flow@jakub && claude plugin install flow@jakub`. Hook scripts can be exercised without a reinstall - `echo '<json>' | node plugins/flow/hooks/scripts/no-backlog-guard.mjs`.

Desktop and claude.ai bridge sessions load plugins from service-pushed snapshots with hooks stripped, so a bridge session never sees the charter or the guards; don't debug "the hook didn't fire" from one.

Adding a plugin: `plugins/<name>/` with a `.claude-plugin/plugin.json`, plus an entry in the manifest's `plugins` array with `"source": "./plugins/<name>"`. Plugins don't reach into each other's files - flow's prep stage uses `grill-with-docs` when it's installed and falls back to an inline grill otherwise, and that one-way, soft dependency is the model.

## flow

`plugins/flow/charter/charter.md` is hand-authored by jakub and is the source of truth. It is one file in two halves, separated by one marker line; above the marker is doctrine for the orchestrator, below it the rules every seat follows. `hooks/scripts/inject-charter.mjs` is the one injector on both hosts and `lib/charter-payload.mjs` owns the marker, the split and the byte budgets.

Claude Code caps one hook's stdout at 10,000 characters and swaps anything larger for a 2KB preview plus a file path, so the charter ships as two SessionStart hooks there. **Keep each half under 9,000 bytes**, or the session silently runs on a fragment while the global CLAUDE.md's presence check still passes. The injector prints a warning line when a half gets close.

The charter is prose to a capable colleague, and it should stay that way. Every line costs context in every session, so anything that isn't true in every session goes somewhere else.

The orchestrator picks the model and effort of every seat from the charter's rankings table and its `## Model Selection` bullets. **Nothing outside the charter names a model.** `scripts/smoke-charter-conformance.mjs` is the lint.

`lib/hook-policy.mjs` owns protected-file, publication and merge policy; `hooks/scripts/wire.mjs` owns the harness wire formats every hook answers with (`preToolDeny`, `preToolAsk`, `readHookInput`) so policy stays free of event names and envelopes; the Claude and Codex adapters own their different tool inputs. **Never return Claude's publication `ask` result to Codex**: Codex CLI treats that unsupported value as a hook failure and lets the command continue (observed on 0.149.1, still true on 0.152.0), so its adapter denies and directs the human to publish manually. If a later Codex gains `ask` support, that adapter can retire.

`agents/implementer.md` keeps only the claims a Claude seat can make. The rules a seat follows arrive from the charter's seat half through the SubagentStart hook, so no agent definition carries a copy.

Doctrine lives in two places and no more. The charter holds what must be true in every session; the stage bodies hold the steps a stage executes. If something appears in both, delete one copy. The skill under `skills/flow/` holds what neither needs at runtime: setup, the doc stack, the ambient crons and hooks, the label contract, and the drift audit.

### Stages

Each stage is one file and nothing else: `skills/prep/SKILL.md`, `skills/issue/SKILL.md`, `skills/land/SKILL.md`. The skill is the invocation on both hosts - `/flow:prep` on Claude, the plugin-namespaced `prep` skill on Codex - and there is no command alias, because Claude Code resolves commands and skills in one namespace and an alias would both collide with the skill's name and re-expose a stage the model is not allowed to start. The body is host-neutral prose that names no host, no host-only tool, and no model, effort tier or role: it describes the shape of a seat and lets the orchestrator pick. It ends with a `## Host mechanics` section holding exactly two subsections, `### Claude Code` and `### Codex`, carrying only what genuinely differs and is not already in the charter's `## Hosts` section.

Each stage carries its own `allowed-tools` line and sets `disable-model-invocation: true`; `agents/openai.yaml` beside it sets `allow_implicit_invocation: false`. Both exist because a stage that merges, opens issues or spawns write seats must never start itself, and the Codex half is unverified on the plugin-loader path, so the human is the actual gate. `skills/babysit/` is the same document shape without either gate, on purpose: it is the watch between a pushed PR and the land, and an issue run hands off to it.

`scripts/smoke-stage-conformance.mjs` holds the pipeline as an explicit list with each skill's gate as its value, checks all of the above, and fails if any skill outside that list carries a `## Host mechanics` section - which is what stops a fourth stage being written and quietly never linted. There is no fixtures directory.

### Executors and guards

Four deterministic executors do the pipeline's irreversible work, and each one's header is the spec. Read the header before editing; none of the reasoning is repeated here.

- `scripts/issue-claim.mjs` - claims an issue through a tag push origin decides. **Two runs on one issue both see a green re-read**, so never replace this with an assignment check.
- `scripts/land-gates.mjs` - the land's read-only verdict. Mutates nothing.
- `scripts/land-merge.mjs` - the only merge, on either host.
- `scripts/lint-actions.mjs` - the nightly lint's only path to a worktree, branch or label mutation.

`.flow/managed` is a committed marker that opts a repository into merge enforcement. In a repository that has one, both publish guards deny every merge command they recognize through the same `mergeDenialFor` and name `land-merge.mjs`; in a repository without one, neither guard gates a merge at all. That classification is a coarse tripwire whose **only real requirement is that it never matches the executor's own invocation**, which `scripts/smoke-release-path.mjs` asserts.

The executors share `lib/gh-exec.mjs` (finding gh, pinning its environment, reading its output), `lib/remote-identity.mjs` (the origin grammar, plus the two policies over it) and `lib/redact.mjs` (making a command's own words safe to quote). Each exists because a copy had already drifted. Don't reintroduce a local copy of any of them.

`scripts/tree-snapshot.mjs <path>` prints the four digests the prep and issue stages compare around every read-only seat.

The git guard has two modes. Interactive mode denies the hook-bypass flag, trailers, bare force-push and the narrow destructive set. Cron mode (`FLOW_CRON_JOB` in the env) is a fail-closed grammar over every command. **Two rules bind an edit**: a call is one command, so `;`, `&&` and `||` are denied whatever they join, because a job's allowlist is a prefix over the whole string; and do not go back to a scanner that blanks what it recognizes, because two review rounds found eleven ways past one. Both modes have cases in `scripts/smoke-git-guard.mjs`.

The scheduled jobs are three files each: the prompt in `skills/flow/cron/<job>.md`, the allowlist in `scripts/flow-cron.mjs`, and the unit pair in `skills/flow/templates/systemd/`. **A job's authority is the allowlist plus git-guard's cron mode plus `lint-actions.mjs`, never the prompt.** Widening what a job may do is an edit to `flow-cron.mjs` and a version bump, and the prompt's "standing permissions" paragraph must match it. Test a prompt change without installing anything:

```
CLAUDE_PLUGIN_ROOT=$PWD/plugins/flow FLOW_STATE=/tmp/x bash plugins/flow/scripts/install-cron.sh run lint
```

The timers resolve the plugin through `installed_plugins.json`, so a new version arrives at the next reinstall. That registry is Claude's user scope alone, so **`flow@jakub` has to be installed at user scope** or the launcher resolves nothing, whichever host orchestrates the pipeline.

`scripts/worktree-audit.sh` is ported from pstack (see `plugins/flow/NOTICE`); unlike grill's vendoring it is a fork, edit it freely.

The explicit `tools:` list on an agent def is load-bearing - a subagent without one can call Agent, and `implementer.md` relies on not having it.

### Delegation

Facts that go stale (model pricing, the Codex App Server protocol) carry an as-of date. Re-verify anything older than a quarter, and re-verify the host capability table on every CLI bump since both CLIs ship weekly. The protocol lives in `plugins/flow/docs/DELEGATION.md` and `plugins/flow/src/delegation/`, validated against Codex CLI 0.152.0 as of 2026-09-01; `skills/delegate/SKILL.md` is the operating manual a session reads before its first bridge call. Delegation requires Linux with cgroup v2 and a working systemd user manager, because every provider runs in a transient scope; there is no other platform path.

`plugins/flow/capabilities.json` is the hand-maintained host capability table the issue stage's write-seat preflight reads through `delegation_doctor`. It is a plain file on purpose: editing it needs no rebuild. The doctor computes drift and the stage stops only on `older` or `unknown`; `newer` is a journal event asking for a re-check, because the table is biased false.

Read `docs/DELEGATION.md` before editing `src/delegation`. Three rules bind every edit:

1. Every tool declares an `outputSchema` envelope, and `ERROR_KINDS` in `contracts.mjs` is the closed list the Codex smoke greps.
2. **An edit under `src/delegation`, a charter edit or a version bump is half a change until `npm run build` in `plugins/flow/deps` regenerates `dist/delegation.mjs` in the same commit.** `scripts/smoke-bundle-drift.mjs` is the one script that needs `npm ci` there.
3. A delegated job is handed `seatPayload(charter)` verbatim, the same bytes a subagent gets. The charter conformance smoke asserts the two payloads are equal.

`agents/bridge.md` is the Claude transport seat, held to exactly the delegate tools by `scripts/smoke-bridge-seat.mjs`. Codex binds no transport seat, because `spawn_agent` narrows nothing.

## gripe

`plugins/gripe/` is first-party, no vendoring. Three layers: `lib/` (`store.mjs` owns SQLite and migrations, `context.mjs` derives repo and session identity, and `gate.mjs`, `failure.mjs` and `checkpoint.mjs` own harness-neutral noise policy and bounded state), thin hook scripts under `hooks/scripts/`, and `bin/gripe` plus `bin/shim.mjs`. Claude registrations live in `hooks/hooks.json`, Codex registrations in `hooks/codex.json`. The design rationale with the measured claims is `docs/gripe/DESIGN.md`; the reader-side analysis method is the skill under `skills/gripe/`.

`bin/shim.mjs` is the copy at `~/.local/bin/gripe`: node builtins only, resolving the newest live install at exec time. It carries one `// gripe-shim-epoch: <n>` line that bumps when shim behavior changes and **never per release**. `docs/gripe/DESIGN.md` holds the resolution rules and `scripts/smoke-shim.mjs` holds the contract; read both before touching it.

Every hook reads its call through `readHookEvent` in `lib/context.mjs`, which validates `session_id` and `agent_id` before either reaches a filename, on both hosts. A hook that skips it cannot get an id at all.

Three things not to add, each for a reason the event stream has not yet fixed. Codex checkpoint state is folded from structured PostToolUse events, never the unstable Codex transcript format, and since Codex does not identify the subagent actor there, the checkpoint is parent-session state on main Stop only - **no Codex SubagentStop checkpoint** until the events can attribute their evidence. PostToolUse has no reliable failure status (observed on 0.149.1: a Bash command that exited 7 supplied `tool_response: ""`), so Codex records tool-target repetition but runs no repeated-failure nudge. PermissionDenied and StopFailure stay Claude-only, because a nearby Codex event with different meaning is not a compatibility layer.

**Filing must stay free**: `gripe add` always exits 0 and never prompts. Any change that can make it exit non-zero or block on input breaks the contract every hook relies on. `scripts/collision-test.mjs` exercises concurrent writers against one database.

## grill

`plugins/grill/skills/` is vendored from https://github.com/mattpocock/skills (MIT), upstream plus four patches. **Don't hand-edit the vendored files** - a local change is a patch in `plugins/grill/patches/`, so a re-sync stays mechanical. `plugins/grill/NOTICE` is the record: what each patch does and why, the order they apply in, the re-sync steps, and how to regenerate one that stops applying. Verify a re-sync by applying the chain to a fresh upstream copy and diffing against `skills/` - byte-identical or it is wrong.

Grill ships no Codex manifest: Codex finds `skills/*/SKILL.md` by itself. Three skills is the minimal closure; carrying a fourth is a decision, not a default.

## unslop

`plugins/unslop/skills/unslop/SKILL.md` is vendored verbatim from Lauren Tan's pstack skill in `cursor/plugins` (MIT), no patches yet. If it ever needs one, follow the grill pattern and bump the SHA in `plugins/unslop/NOTICE`.

`hooks/scripts/inject-unslop.mjs` delivers the rules, because "Must always apply" in frontmatter is advice the model follows unreliably. One script, both harnesses, two modes: `session` prints to stdout at SessionStart, `subagent` answers SubagentStart with `hookSpecificOutput.additionalContext`. Plugin-local scoping wrappers live in `lib/rules.mjs` and the source-aware skip policy in `lib/agent-selection.mjs`. **Scoping changes go in those wrappers, never in a patch to the vendored file.**

Watch the same 10,000-character Claude hook cap that forced flow's charter into two hooks. The subagent payload is JSON-wrapped and so is the larger of the two: 7,786 bytes as of unslop 0.4.1, about 2KB of headroom. Codex's handler uses a 3,000-token inline limit. A re-sync that grows `SKILL.md` past either bound eats or spills the rules, so measure after any vendor bump:

```
echo '{"agent_type":"claude"}' | node plugins/unslop/hooks/scripts/inject-unslop.mjs subagent claude | wc -c
```
