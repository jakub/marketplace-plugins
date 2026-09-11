# marketplace-plugins - how to work in this repo

This is jakub's Claude Code plugin marketplace (README.md is the user-facing tour). The repo root holds the marketplace manifest at `.claude-plugin/marketplace.json` (marketplace name `jakub`) and shared docs; everything else is a self-contained plugin under `plugins/`. Install strings are `<plugin>@jakub`.

The charter you already have in context says how we build. This file is only about what's specific to editing the plugins themselves, and it carries only what you need *before* you open a file: the traps, the contracts between files, and where things live. Why a mechanism works the way it does lives in that file's own header, which you are reading by the time it matters. When something here starts explaining a mechanism, move it into the header and leave a pointer.

## Versions and publishing

Each plugin has one version, written in up to three places that must agree: `plugins/<name>/.claude-plugin/plugin.json`, its entry in the marketplace manifest, and `plugins/<name>/.codex-plugin/plugin.json` when the plugin ships one. The marketplace entry is the number that matters, because both plugin managers name the cache directory after it. The description is mirrored across the same files and checked the same way. A Codex manifest exists only where Codex needs it, for a `hooks` or `mcpServers` pointer; a skills-only plugin (grill) has none, since Codex discovers `skills/*/SKILL.md` on its own. There is no catalog version. `scripts/smoke-plugin-manifests.mjs` enforces all of it.

Flow also pins that version in `plugins/flow/.mcp.json` as `--flow-version`. Keep the pin aligned when changing its manifests. The manifest smoke checks it.

Before every push containing Flow changes or a new Flow version, rebuild and verify `plugins/flow/dist/delegation.mjs`. The bundle embeds the charter and version, so prose-only charter edits and version bumps need a rebuild too. Run these commands from the repo root after all source, charter, dependency and manifest edits are final:

```sh
npm --prefix plugins/flow/deps run build
node plugins/flow/scripts/smoke-bundle-drift.mjs
node plugins/flow/scripts/smoke-charter-conformance.mjs
node plugins/flow/scripts/smoke-stage-conformance.mjs
node scripts/smoke-plugin-manifests.mjs
```

If the build dependencies are missing or `plugins/flow/deps/package-lock.json` changed, run `npm --prefix plugins/flow/deps ci` first. Include the regenerated bundle in the same commit as its inputs; never hand-edit `dist/`. All checks must pass before the push. If any build input changes afterward, rebuild and rerun the checks. These checks do not grant permission to bump a version or publish.

Installs pull from the pinned GitHub clone, never from this working tree. To test a change: commit, push, then `claude plugin uninstall flow@jakub && claude plugin install flow@jakub`. On Codex, run `codex plugin marketplace upgrade` FIRST: `codex plugin add` resolves the version from a cached marketplace snapshot, so without the refresh it reinstalls the old version and says so only in the cache path it prints. Hook scripts can be exercised without a reinstall - `echo '<json>' | node plugins/flow/hooks/scripts/no-backlog-guard.mjs`.

Desktop and claude.ai bridge sessions load plugins from service-pushed snapshots with hooks stripped, so a bridge session never sees the charter or the guards; don't debug "the hook didn't fire" from one.

Adding a plugin: `plugins/<name>/` with a `.claude-plugin/plugin.json`, plus an entry in the manifest's `plugins` array with `"source": "./plugins/<name>"`. Plugins don't reach into each other's files - flow's prep stage uses `grill-with-docs` when it's installed and falls back to an inline grill otherwise, and that one-way, soft dependency is the model.

## flow

Codex starts delegation through the installed `flow-delegate` command with no MCP `cwd` override. `scripts/install-delegate.mjs` owns its installation and package registration; read its header and `docs/DELEGATION.md` before changing that contract. `scripts/smoke-codex-app-workspace.mjs` checks the installed plugin against a real App Server in disposable homes. Issue worktrees live under the canonical checkout's ignored `.flow-worktrees/` directory on both hosts.

`bin/flow-delegate.mjs` is copied verbatim into `~/.local/bin/flow-delegate`. After its first release, every byte change requires increasing both `flow-delegate-launcher-epoch` and the exported `epoch`, including comment edits. Same-epoch content drift is deliberately refused. This epoch changes when the dispatcher changes, never for a Flow version bump alone.

`plugins/flow/charter/charter.md` is hand-authored by jakub and is the source of truth. One file in two halves split by a marker line, orchestrator doctrine above it and seat rules below. `hooks/scripts/inject-charter.mjs` is the one injector on both hosts; `lib/charter-payload.mjs` owns the marker, the split and the byte budgets.

Claude Code caps one hook's stdout at 10,000 characters and swaps anything larger for a 2KB preview plus a file path, so the charter ships as two SessionStart hooks there. **Keep each half under 9,000 bytes**, or the session silently runs on a fragment while the global CLAUDE.md's presence check still passes. The injector warns when a half gets close.

The charter is prose to a capable colleague. Every line costs context in every session, so anything that isn't true in every session goes somewhere else. The orchestrator picks each worker's model and effort from its rankings table and `## Model Selection` guidance. Model choices live in the charter, except the fixed transport configuration in `agents/bridge.md` and its invocation examples. `scripts/smoke-charter-conformance.mjs` checks charter structure and delivery; `scripts/smoke-bridge-seat.mjs` checks the transport binding.

`lib/hook-policy.mjs` owns protected-file, publication and merge policy, kept free of event names and envelopes by `hooks/scripts/wire.mjs`, which owns the wire formats every hook answers with (`preToolDeny`, `preToolAsk`, `readHookInput`); the Claude and Codex adapters own their different tool inputs. **Never return Claude's publication `ask` result to Codex**: Codex CLI treats that unsupported value as a hook failure and lets the command continue (observed on 0.149.1, still true on 0.152.0), so its adapter denies and directs the human to publish manually. If a later Codex gains `ask` support, that adapter can retire.

`agents/implementer.md` keeps only the claims a Claude seat can make. Seat rules arrive from the charter through the SubagentStart hook, so no agent definition carries a copy.

Doctrine lives in two places and no more: the charter holds what must be true in every session, the stage bodies hold the steps a stage executes. If something appears in both, delete one copy. The skill under `skills/flow/` holds what neither needs at runtime - setup, the doc stack, the ambient crons and hooks, the label contract, and the drift audit.

### Stages

Each stage is one file and nothing else: `skills/prep/SKILL.md`, `skills/issue/SKILL.md`, `skills/land/SKILL.md`. The skill is the invocation on both hosts (`/flow:prep` on Claude, the plugin-namespaced `prep` skill on Codex) and **there is no command alias**: Claude Code resolves commands and skills in one namespace, so an alias would collide with the skill's name and re-expose a stage the model may not start. The body is host-neutral prose naming no host, no host-only tool, and no model, effort tier or role: it describes the shape of a seat and lets the orchestrator pick. It ends with a `## Host mechanics` section holding exactly two subsections, `### Claude Code` and `### Codex`, carrying only what genuinely differs and is not already in the charter's `## Hosts` section.

Each stage carries its own `allowed-tools` line and sets `disable-model-invocation: true`. Its `agents/openai.yaml` carries display metadata only, with no `allow_implicit_invocation` field. The charter requires the human to name a stage before it starts. `skills/babysit/` is the same document shape without the SKILL.md invocation gate, on purpose: it is the watch between a pushed PR and the land, and an issue run hands off to it.

`scripts/smoke-stage-conformance.mjs` holds the pipeline as an explicit list with each skill's gate as its value, checks all of the above, and fails if any skill outside that list carries a `## Host mechanics` section - which is what stops a fourth stage being written and quietly never linted. There is no fixtures directory.

### Executors and guards

Four deterministic executors do the pipeline's irreversible work: `scripts/issue-claim.mjs` (claims an issue through a tag push origin decides; **two runs on one issue both see a green re-read**, so never replace this with an assignment check), `scripts/land-gates.mjs` (the land's read-only verdict, mutates nothing), `scripts/land-merge.mjs` (the only merge, on either host) and `scripts/lint-actions.mjs` (the nightly lint's only path to a worktree, branch or label mutation). Each one's header is the spec, including why it is code and not stage prose. Read the header before editing; none of that reasoning is repeated here.

`.flow/managed` is a committed marker that opts a repository into merge enforcement. In a repository that has one, both publish guards deny every merge command they recognize through the same `mergeDenialFor` and name `land-merge.mjs`; in a repository without one, neither guard gates a merge at all. That classification is a coarse tripwire whose **only real requirement is that it never matches the executor's own invocation**, which `scripts/smoke-release-path.mjs` asserts.

The executors share `lib/gh-exec.mjs` (finding gh, pinning its environment, reading its output), `lib/remote-identity.mjs` (the origin grammar and the two policies over it) and `lib/redact.mjs` (making a command's own words safe to quote). Each exists because a copy had already drifted. Don't reintroduce a local copy of any of them.

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

Facts that go stale (model pricing, the Codex App Server protocol) carry an as-of date; re-verify anything older than a quarter, and re-verify the host capability table on every CLI bump since both CLIs ship weekly. The protocol lives in `docs/DELEGATION.md` and `src/delegation/`, validated against Codex CLI 0.152.0 as of 2026-09-01; `skills/delegate/SKILL.md` is the operating manual a session reads before its first bridge call. Delegation requires Linux with cgroup v2 and a working systemd user manager; there is no other platform path.

`capabilities.json` is the hand-maintained host capability table the issue stage's write-seat preflight reads through `delegation_doctor`, a plain file on purpose so editing it needs no rebuild. The doctor computes drift and the stage stops only on `older` or `unknown`; `newer` is a journal event asking for a re-check, because the table is biased false.

Read `docs/DELEGATION.md` before editing `src/delegation`; its `## Contracts that bind an edit` section is the list, and the closed `ERROR_KINDS` set and the verbatim `seatPayload(charter)` rule live there. Follow the rebuild and pre-push checks under `Versions and publishing` above.

`agents/bridge.md` is the Claude transport seat. Its frontmatter owns the fixed model and effort; `hooks/scripts/bridge-model.mjs` reads it to normalize native Agent calls. `scripts/smoke-bridge-seat.mjs` checks the binding, argument preservation and exact tool list. Workflow limits live in the delegate skill. Codex binds no transport seat, because `spawn_agent` narrows nothing.

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

Two skills vendored from Lauren Tan's pstack in `cursor/plugins` (MIT) under one pin, because upstream designed them as a pair: `skills/unslop/SKILL.md` is the slop-pattern catalog and `skills/technical-writing/SKILL.md` is the four-layer document standard that cites it. Three patches under `plugins/unslop/patches/` in the grill pattern, and `plugins/unslop/NOTICE` is the record. Upstream retires a rule by leaving its number as a gap, so **never renumber the rules**.

No hooks, no `lib/`, no Codex manifest: since 0.6.0 this is a plugin of skills alone, like grill. It was hook-delivered through 0.5.0 and that history holds the working machinery if the experiment fails. Patch 0003 takes upstream's `disable-model-invocation` off unslop, patch 0001 takes it off technical-writing, and each skill's `agents/openai.yaml` is a local addition carrying the Codex half of that decision.

**Both skills are reached by model invocation and nothing else now**, so two guarantees the hook gave are gone. There is no scoping, so an invoked skill applies every rule to whatever is being written, chat included. And a seat with no `Skill` tool gets no rules at all, which is why flow's `implementer`, `code-reviewer` and `code-architect` carry `Skill` in their `tools:` lists.
