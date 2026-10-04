# marketplace-plugins - how to work in this repo

This is jakub's plugin marketplace for Claude Code and Codex (README.md is the user-facing tour). The repo root holds the marketplace manifest at `.claude-plugin/marketplace.json` (marketplace name `jakub`); everything else is a self-contained plugin under `plugins/`. Install strings are `<plugin>@jakub`. `CLAUDE.md` is a symlink to this file.

This file carries what you need before you open a file: the traps and the contracts between files. Why a mechanism works the way it does lives in that file's own header. When something here starts explaining a mechanism, move it into the header and leave a pointer.

## Before a push

Run `node scripts/smoke-all.mjs` from the repo root. It runs every `plugins/*/scripts/smoke-*.mjs`, gripe's collision test and the manifest smoke, and stops at the first failure. There is no CI, so this is the whole check. Nothing is built: there is no bundle, no lockfile and no npm dependency, and an edit takes effect at the next session or server start. A green run grants no permission to bump a version or publish.

## Versions

Each plugin has one version, written in up to three places that must agree: `plugins/<name>/.claude-plugin/plugin.json`, its entry in the marketplace manifest, and `plugins/<name>/.codex-plugin/plugin.json` when the plugin has one. Flow also pins it as `--flow-version` in `plugins/flow/.mcp.json`, which names the cache directory the Codex dispatcher loads. The marketplace entry is the number that matters, because both plugin managers name the cache directory after it. The description is mirrored across the same files. A Codex manifest exists only to point at `hooks` or `mcpServers`. Grill and unslop ship skills alone and have none, because Codex finds `skills/*/SKILL.md` by itself. `scripts/smoke-plugin-manifests.mjs` checks all of it.

## Testing an installed change

Installs pull from the pinned GitHub clone, never from this working tree. To test a change, commit and push, then reinstall. On Claude Code, run `claude plugin uninstall flow@jakub && claude plugin install flow@jakub`. On Codex, run `codex plugin marketplace upgrade` first: `codex plugin add` resolves the version from a cached marketplace snapshot, so without the refresh it reinstalls the old version and says so only in the cache path it prints. Then run `codex plugin remove flow@jakub && codex plugin add flow@jakub`.

A hook script runs without a reinstall: `echo '<json>' | node plugins/flow/hooks/scripts/no-backlog-guard.mjs`. Desktop and claude.ai bridge sessions load plugins from service-pushed snapshots with hooks stripped, so a bridge session never sees the charter or the guards. Don't debug "the hook didn't fire" from one.

Two files leave the plugin cache for `~/.local/bin`, and each has its own update rule:

- `plugins/flow/bin/flow-delegate` is copied by `scripts/install-delegate.mjs` whenever the installed copy differs, but only over a file that opens with a `// flow-delegate-` marker line; anything else there is refused with exit 1. Codex starts MCP servers before SessionStart hooks run, so the flow skill's `setup` runs the installer once per machine, and the Codex SessionStart hook keeps the copy current after that.
- `plugins/gripe/bin/shim.mjs` is copied only when the installed copy is missing or its `// gripe-shim-epoch: <n>` line is lower. A byte change without an epoch bump never reaches an installed shim. Bump the epoch when shim behavior changes, never per release.

Adding a plugin: `plugins/<name>/` with a `.claude-plugin/plugin.json`, plus an entry in the manifest's `plugins` array with `"source": "./plugins/<name>"`. Plugins don't reach into each other's files. Flow's prep stage uses `grill-with-docs` when it is installed and grills inline otherwise, and that one-way, soft dependency is the model.

## flow

`charter/charter.md` is hand-authored by jakub and is the source of truth: one file, one marker line, orchestrator doctrine above it and seat rules below. `hooks/scripts/inject-charter.mjs` prints the whole file at SessionStart and the seat half at SubagentStart on both hosts, and `delegate/runner.mjs` gives every delegated job the same seat bytes as its instructions. **The charter stays under 9,500 characters.** `smoke-charter.mjs` fails above that, and the injector refuses above 9,800 rather than let Claude Code swap the charter for a 2KB preview. The charter sits close to the cap, so an edit that adds a line cuts one. `skills/rank-models/` regenerates the `## Models` section; follow it for a new model rather than scoring one by hand.

Doctrine lives in two places and no more: the charter holds what must be true in every session, and the stage bodies hold the steps a stage executes. If something appears in both, delete one copy.

Each stage (`skills/prep/`, `skills/issue/`, `skills/babysit/`, `skills/land/`) is one `SKILL.md`: a host-neutral body that names no model, then `## Host mechanics` with exactly `### Claude Code` and `### Codex`. Stages are model-invocable on both hosts and gated by the description's MUST clause, so a `SKILL.md` sets no `disable-model-invocation` and its `agents/openai.yaml` carries display metadata only. **No command alias may share a stage's name**: Claude Code resolves commands and skills in one namespace, so the alias would collide with the skill.

The `tools:` list on an agent definition is load-bearing. `implementer` has no Agent tool, so it cannot spawn. `reader` has no Edit, Write or Agent tool, and no Skill tool either, because whether a skill's `allowed-tools` can widen a seat is untested. `bridge` holds ToolSearch and every delegate tool except `delegation_steer`, and its frontmatter fixes its model and effort.

### Hooks

`lib/hook-policy.mjs` holds the protected-file, publication and merge policy and knows no event names. `hooks/scripts/wire.mjs` holds the answer shapes, and each host has its own adapter. The two hosts differ on purpose in three ways:

- **Publication.** Claude's `publish-guard.mjs` asks, and `publish-guard-codex.mjs` denies. Codex reads an unsupported `ask` as a hook failure and runs the command anyway (observed on 0.149.1 and 0.152.0), so never return `preToolAsk` to Codex.
- **Unreadable input.** The Claude adapters fail open on a call they cannot read. `publish-guard-codex.mjs` and `protect-files-codex.mjs` fail closed.
- **The edit envelope.** Codex edits arrive as `apply_patch` with the whole patch in `tool_input.command`. `protect-files-codex.mjs` checks every target in it and refuses a patch it cannot enumerate, and a benign `file_path` never vouches for the patch beside it.

`.flow/managed` is a committed marker that opts a repository into merge enforcement. With it, both publish guards deny every merge command they recognize and name `scripts/land-merge.mjs`. The tripwire's **one hard requirement is that it never matches the executor's own invocation**, which `smoke-publish-guard.mjs` asserts.

`hooks/scripts/seat-guard.mjs <prompt|pre|stop> <claude|codex>` holds a T3 seat to the Seat Contract. Its policy is `lib/seat-policy.mjs`, which knows no event names, and `lib/seat-store.mjs` is the only reader and writer of seat records. Five contracts bind an edit to it:

- **Append Codex groups, never insert them.** Codex keys a hook's trust by position (`<source>:<event>:<group>:<handler>`) and hashes the command string, not the script. A group inserted ahead of another moves that one's key and silently untrusts it, so a new group goes at the end of its event's array. `smoke-charter.mjs` holds the existing positions as a literal table. Changing a command string untrusts that hook until setup's trust step runs again.
- **Answer only in `wire.mjs`'s shapes.** Codex fails open on a `hookSpecificOutput` with a key it does not know, so a misspelled deny is an allow.
- **Keep the fast path cheap.** The catch-all PreToolUse group sees every tool call in every session. Outside a seat it reads stdin, makes one `existsSync` on the session index and exits, and only a `delegate_task` call goes on to the admission gate. The prompt path makes one string test for a seat tag and, with none, the same one `existsSync`, so a follow-up turn in a seat is recorded. `smoke-seat.mjs` measures that cost, so new work goes behind the check.
- **An unreadable body exits open.** The seat guard lets through a call it cannot read, on both hosts, unlike the two Codex guards above, because a catch-all that failed closed would block every Codex tool call after a harness change. Once the session index names a seat, a missing or corrupt record or an unreadable tool input is denied.
- **The shell rules are a guardrail, not a parser.** They catch the plain forms a confused seat writes, at the parity native seats have under git-guard and the publish and protect-files guards. Quoting, escapes, expansions, `source`, command substitution, commands built at run time and Bash writes outside the worktree are not caught. `smoke-seat.mjs` asserts those forms stay allowed in its `bash-accepted-*` cases, so a change to the gap is a deliberate one. Don't grow a shell lexer back.

### Executors and the scheduled jobs

Four executors do the irreversible or contested work, and each one's header is its spec. `scripts/issue-claim.mjs` claims an issue through a tag push that origin decides: **two runs on one issue both see a green re-read, so never replace the tag with an assignment check**. `scripts/land-merge.mjs` is the land gate and the only merge, on either host. It reads every fact that can stop a land and merges only when none does. **Never split the gate back out of the merge**, because then the merge trusts a verdict a model read. `scripts/lint-actions.mjs` is the nightly lint's only shell command and its only way to change worktrees, local and remote branches, and labels. `scripts/seat.mjs` opens a T3 seat's record, closes the seat with the one verdict the parent acts on, and writes flow's Codex hook trust: **a parent acts on the verdict, never on T3's `summary`**, which after a Stop block is not the answer. The first three share `lib/gh-exec.mjs`, `lib/remote-identity.mjs` and `lib/redact.mjs`, and the claim and `seat.mjs` share `lib/git-exclude.mjs`, which adds `/.flow-worktrees/` to `.git/info/exclude`. Each exists because a copy had already drifted or would. Don't reintroduce a local copy.

A scheduled job is three files: the prompt in `skills/flow/cron/<job>.md`, the allowlist in `scripts/flow-cron.mjs`, and the units in `skills/flow/templates/systemd/`. **Under `FLOW_CRON_JOB`, git-guard's cron regex is the authority.** It admits `node <root>/scripts/lint-actions.mjs <verb> <plain args>` and no other Bash command. Don't grow it back into a shell grammar or a scanner that blanks what it recognizes: two review rounds found eleven ways past the last one. A lint that needs another fact gets a `survey` field in `lint-actions.mjs`. Widening a job is an edit to `flow-cron.mjs` and a version bump, and the prompt's standing permissions must match it. To test a prompt without installing anything, run the line below, and drop `--dry-run` to spend a real session:

```sh
CLAUDE_PLUGIN_ROOT=$PWD/plugins/flow FLOW_STATE=/tmp/x bash plugins/flow/scripts/install-cron.sh run lint --dry-run
```

The timers find flow through `~/.claude/plugins/installed_plugins.json`, which is Claude's user scope alone, so **`flow@jakub` has to be installed at user scope** whichever host orchestrates the pipeline. Issue worktrees live under the canonical checkout's `.flow-worktrees/`, which the claim adds to `.git/info/exclude`.

### Delegation

`delegate/` is eight files on Node built-ins. They speak `codex app-server --stdio` and the stream-json control channel of `claude -p` by hand, and serve five tools on each host. `docs/DELEGATION.md` is the maintenance record, and its `## Contracts that bind an edit` section is the list to read before an edit. `skills/delegate/SKILL.md` is what a session reads before its first call, and it lists the provider methods and flags the server depends on with the CLI versions they were read from. `delegation_doctor` is the protocol drift check: it runs each transport's `check`, the job's handshake with no turn, so a CLI release that changes a handshake step fails every stage preflight with a typed kind. A new step before the prompt joins `check` in the same commit. The doctor cannot reach what runs only inside a turn, so re-check those methods and flags on every CLI bump, since both CLIs ship weekly. `.mcp.json` sets no `cwd`, because the directory Codex starts the dispatcher in is the server's only root there.

## gripe

`plugins/gripe/` is first-party. `lib/` holds `store.mjs` (SQLite and migrations), `context.mjs` (repo and session identity), and `gate.mjs` and `checkpoint.mjs` (noise policy and bounded state). The hook scripts under `hooks/scripts/` stay thin, and `bin/gripe` is the CLI. `docs/gripe/DESIGN.md` holds the measured facts and the shim's resolution rules, and `scripts/smoke-shim.mjs` holds the shim's contract. Read both before touching `bin/shim.mjs`.

**Filing must stay free**: `gripe add` always exits 0 and never prompts, and every hook relies on that. Every hook reads its call through `readHookEvent` in `lib/context.mjs`, which validates `session_id` and `agent_id` before either reaches a filename.

Three things not to add until the Codex event stream supports them:

- A Codex SubagentStop checkpoint. Codex does not name the subagent in PostToolUse, so the checkpoint is parent-session state on main Stop only.
- A Codex repeated-failure nudge. PostToolUse carries no reliable failure status: on 0.149.1, a Bash command that exited 7 supplied `tool_response: ""`.
- A Codex StopFailure lane. A nearby Codex event with a different meaning is not a compatibility layer.

## Vendored skills

`plugins/grill/skills/` comes from mattpocock/skills and `plugins/unslop/skills/` from Lauren Tan's pstack in cursor/plugins, both MIT. **Don't hand-edit a vendored file.** A local change is a patch under the plugin's `patches/`, so a re-sync stays mechanical. Each plugin's `NOTICE` holds the pin, the patches in order with one reason each, and the re-sync steps. Verify a re-sync by applying the chain to a fresh upstream copy and diffing against `skills/`: byte-identical or it is wrong.

Grill carries three skills, the minimal closure of `grill-with-docs`; carrying a fourth is a decision, not a default. Unslop's two skills share one pin because upstream designed them as a pair. Upstream retires a rule by leaving its number as a gap, so **never renumber the rules**. Unslop's skills are reached by model invocation only, so a seat without the Skill tool gets no writing rules; `implementer` carries Skill for that reason.
