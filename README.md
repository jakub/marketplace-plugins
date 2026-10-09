# marketplace-plugins

Jakub's personal plugin marketplace for Claude Code and Codex. Flow and gripe carry a Codex manifest, because Codex reads hook and MCP registrations only from one. Grill, unslop, and plans ship skills alone and need none, since Codex finds `skills/*/SKILL.md` by itself. Both hosts read the one catalog at `.claude-plugin/marketplace.json`.

```bash
claude plugin marketplace add jakub/marketplace-plugins
claude plugin install flow@jakub
```

`@jakub` is the marketplace name from `.claude-plugin/marketplace.json`, not a repository name. Hooks arm at the next session start. Installs pull from the pinned GitHub clone, so after editing this repo, push and then reinstall. `AGENTS.md` covers working on the repo itself, and `node scripts/smoke-all.mjs` is the check to run before a push.

## Install and update

The two hosts have different plugin CLIs, so each gets its own lane. The spellings below come from `--help` on Claude Code 2.1.284 and codex-cli 0.159.0, read on 2026-09-30. Re-check them when you upgrade either CLI.

### Claude Code

```bash
claude plugin marketplace add jakub/marketplace-plugins
claude plugin install flow@jakub
claude plugin list
```

To update, refresh the marketplace clone, update the plugin, then quit and reopen Claude Code, because `claude plugin update` applies only after a restart:

```bash
claude plugin marketplace update jakub
claude plugin update flow@jakub
```

`claude plugin install` defaults to `--scope user`. Keep the default: flow's scheduled jobs find the plugin through the user-scope registry and nothing else. For a clean re-registration, run `claude plugin uninstall flow@jakub` and install again.

### Codex

```bash
codex plugin marketplace add jakub/marketplace-plugins
codex plugin add flow@jakub
codex plugin list --marketplace jakub
```

Codex has no update verb: `codex plugin update` answers `unrecognized subcommand 'update'`. To update, refresh the marketplace snapshot, then register the plugin again:

```bash
codex plugin marketplace upgrade jakub
codex plugin remove flow@jakub
codex plugin add flow@jakub
```

The refresh changes the bytes Codex could install, not the registration you already made. Until `remove` and `add` run, every session loads the version you added. Start a new thread afterwards, because a running thread keeps the registration it read when it started. Codex also asks you to review a plugin's hook definitions before they run.

Flow needs one more step on each machine before its first Codex session. Codex reaches flow's delegate server through a `flow-delegate` command on PATH, and it starts MCP servers before any hook runs. Ask an agent to run the flow skill's `setup`, or run the installer from the copy Codex installed:

```bash
node ~/.codex/plugins/cache/jakub/flow/<version>/scripts/install-delegate.mjs install
```

The installer copies the dispatcher to `~/.local/bin/flow-delegate`, which must be on the PATH Codex starts with. From then on, flow's Codex SessionStart hook keeps that copy current.

### Update both hosts in one sitting

If a plugin is registered on both hosts, update both before you go back to work. Gripe's `~/.local/bin/gripe` shim is replaced only by one that declares a higher epoch, so an older install on the other host never reverts it. Hooks import their own install's storage code, though, so an old hook still opens the shared database. Schema migrations are numbered and additive only, and code older than the database refuses to touch it rather than corrupting it: `gripe add` still exits 0 with one stderr line, and the read commands report the failure.

## Plugins

| Plugin | Install | What it is |
|---|---|---|
| **flow** | `flow@jakub` | My main agentic development process, in four stages: `prep` (scope, design, refine) → `issue` (hands-off all the way to a reviewed, evidenced PR) → `babysit` (review and CI until green) → `land` (final checks and a pinned squash merge). |
| **grill** | `grill@jakub` | Used by `prep` to hammer out the issue design. Vendored from [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT). |
| **unslop** | `unslop@jakub` | Cuts AI tells from writing, and holds the technical-writing standard for docs a reader comes back to. ***Under evaluation.*** Both skills are model-invocable, with no hooks: an earlier version force-injected the rules at SessionStart, and 0.6.0 tests whether invocation alone covers the same ground. Vendored from [Lauren Tan's pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT). |
| **gripe** | `gripe@jakub` | A circular filing cabinet for the agents. If they hit friction during a task, repeat errors, or are just unhappy about something, they're encouraged to file a gripe, or where possible, a Claude or Codex hook does it for them. |
| **plans** | `plans@jakub` | Three skills for HTML output. `show` picks where a visual goes: a Sketch in chat, an Inline render in the T3 thread, or a published Document. `doc` writes plan, review, walkthrough and report pages on a vendored, patched copy of Thariq Shihipar's html-plan runtime, with a Respond loop that returns one markdown answer. `publish` drives the [`plans`](https://github.com/jakub/plans) CLI to publish, render-check and delete artifacts on a self-hosted `plansd` server, under one delivery policy. Needs the CLI (`go install github.com/jakub/plans/cmd/plans@latest`), an API URL and token you configure yourself (there is no default server), and Node for `doc`. |

## flow

**flow** is my attempt at an agentic development framework: a charter, four stage skills, a set of hooks, four small executors, and a bridge to the other model family. It's by no means perfect, but produces code I can live with.

The charter defines *how* we work together. A `SessionStart` hook prints it into every session on both hosts. It is one file split by a marker line. Everything below the marker is the rules a seat follows, and a `SubagentStart` hook hands exactly those bytes to every seat that gets spawned. A job sent to the other family gets the same bytes as its instructions, in Codex's developer instructions or Claude's appended system prompt, so a spawn prompt never carries contract text. The charter stays under one hook's 10,000-character cap, and the hook refuses an oversize charter rather than let the host cut it.

The orchestrator (whichever model the session was launched with) picks the model and effort for every seat from the charter's rankings table, and decides what to spend where instead of running a hard-coded pipeline. The stages describe the shape of the seat they want and leave the choice where the context is. The agent scoring table idea is stolen from @Theo.

### The other model family

Claude can delegate to Codex and Codex can delegate to Claude, through one MCP server, `flow_delegate`, with five tools:

| Tool | What it does |
|---|---|
| `delegate_to_codex` on Claude, `delegate_to_claude` on Codex | Starts a job with an explicit model and effort: a task, or an adversarial review of a pinned `base..head` diff that returns typed findings. It takes an `outputSchema` for a typed answer, `read-only` or `workspace-write` access confined to the named worktree, and `continue: <jobId>` to carry on a finished job's thread. It waits for the answer, or returns at once with `waitSeconds: 0`. |
| `delegation_result` | Reads a job's status, outcome and last event lines, and can wait for the job to end. |
| `delegation_cancel` | Stops a job and kills its provider's process group. |
| `delegation_steer` | Adds an instruction to a running job's turn without stopping it, and reports whether the provider took it. |
| `delegation_doctor` | Reports whether the provider is installed and signed in, the usable workspace roots and the state directory, and runs the provider's handshake with no turn to prove the protocol. |

The server speaks the other family's session protocol by hand, `codex app-server` for Codex and the stream-json control channel of `claude -p` for Claude. Each job opens a session, checks the model and effort against the provider's catalog, and reads back what the session can reach before the prompt goes out. A job loads none of your configured MCP servers, plugins or hooks. It uses Node built-ins only, so there is no build step and no npm dependency. Each job is a directory under `~/.local/state/flow/jobs/` by default, and it outlives the session, so a later session in the same workspace can collect it. The `flow:delegate` skill is the operating manual, and `plugins/flow/docs/DELEGATION.md` is the maintenance record.

### The stages

`prep` (`/flow:prep` on Claude Code) is the front door. It turns an issue or a free-text idea into a `ready-for-agent` spec, and GitHub issues can **only** be created here. It uses the grilling skills and codebase analysis to size the problem, write ADRs, and define acceptance criteria, each naming the **evidence** that satisfies it.

`issue` (`/flow:issue`) is the automated part. The orchestrator claims the issue, spins up seats for code design and implementation, and, most importantly, produces the evidence. Whichever family wrote a diff, the other family reviews it adversarially before it ships. A criterion is signed off only by a specific test, Actions log entry, screenshot, or end-to-end Playwright test.

`babysit` (`/flow:babysit`) watches the pushed PR through external review and CI. It fixes each finding or rejects it with a reason, answers every thread, and keeps the branch rebased until everything is green. An issue run always hands off to it.

`land` (`/flow:land`) is the human gate and the only merge path. One executor reads the live PR state (every check, the base branch's known flakes, every review thread, stacking, how far the head is behind the default branch, auto-merge arming) and squash-merges pinned to the head the stage read only when nothing stops it. When something does, it lists every stop at once, and the stage acts on each and runs it again. Then the stage closes the linked issues, cleans up, and surveys what is up next. In a repo with a committed `.flow/managed` marker, a hook denies a raw merge command and names that executor.

All four run on Codex too. Each stage is one skill: a host-neutral body, then a `## Host mechanics` section holding only what differs between the hosts. On Codex, open the canonical checkout and name the stage, for example "run issue #42".

Two timers run in the background once the flow skill's `setup` has installed them: a nightly lint that keeps labels, worktrees and branches honest, and a weekly doc sweep that reports doc drift. Both are headless `claude -p` sessions whose one shell command is `lint-actions.mjs`. The sweep may run only its read-only `survey`, so it changes nothing.

Two supporting skills sit outside the pipeline:

- [`hillclimb`](plugins/flow/skills/hillclimb/SKILL.md) agrees a workload, benchmark, target and constraints with you. After you say "run it", it tries independent hypotheses in parallel and measures them one at a time. It keeps every attempt on a local branch, rejected ones included, and delivers a reviewed local branch. Pushing or opening a PR needs your go-ahead.
- [`rank-models`](plugins/flow/skills/rank-models/SKILL.md) rewrites the charter's `## Models` section when a model ships: one Claude ladder, an OpenAI reviewer and two mentors, from Artificial Analysis's Terminal-Bench run and Cognition's FrontierCode. It asks you only for what no benchmark measures: which models your plans run, taste ratings and quota limits.

| Path | What's there |
|---|---|
| `plugins/flow/charter/charter.md` | The engineering charter. |
| `plugins/flow/skills/{prep,issue,babysit,land}/` | One `SKILL.md` per stage, and the invocation on both hosts. |
| `plugins/flow/agents/` | `implementer` (writes, cannot spawn), `reader` (reads and runs commands, no edit tools), and `bridge` (makes one delegate call on a fixed cheap model). The orchestrator picks the model for the first two at spawn. |
| `plugins/flow/delegate/`, `plugins/flow/bin/flow-delegate` | The delegate MCP server, and the dispatcher Codex starts it through. |
| `plugins/flow/scripts/` | The three executors (`issue-claim`, `land-merge`, `lint-actions`), `tree-snapshot`, the scheduled-job runner and the installers, and the smokes. |
| `plugins/flow/hooks/` | Charter injection, plus the no-backlog, git, publication and merge, and protected-file guards, with an adapter per host where the hosts differ. |
| `plugins/flow/skills/flow/` | The `flow` skill's `setup`, `drift`, `labels`, `charter` and `cron` subcommands, the label contract, and the scheduled-job prompts. |
| `plugins/flow/skills/delegate/` | The operating manual for the five delegate tools. |

flow works best when the global `~/.claude/CLAUDE.md` carries only persona and interaction preferences, and all engineering doctrine arrives through the charter. The doctrine then lives in a git repo, where a change is diffable and reviewable, and one `plugin install` carries the whole practice to a new machine. Leave one pointer in the personal file so a session notices a missing charter instead of improvising one: if no `<flow-charter>` block is in context, the plugin is missing or broken. That matters on desktop and claude.ai bridge sessions, which load plugins from service-pushed snapshots with hooks stripped, so the charter never arrives there.

## gripe

Agents hit the same friction over and over and forget all of it when the session ends. Memory doesn't catch it either - it keeps facts, and nobody files a fact about the tool that ate five minutes.

**gripe** is a complaint box for that. One SQLite file on this machine, agents write to it, and every so often I get a model to read the pile and tell me what it means.

The one rule is that filing has to be free. `gripe add` never exits non-zero and never prompts, so an agent can complain mid-task without putting anything at risk. The price is silent failures go unnoticed, which is why `gripe doctor` exists.

Gripes are stored in `$XDG_STATE_HOME/gripe/gripe.db`, falling back to `~/.local/state/gripe/gripe.db` if unset.

One database, one command, both hosts. On every run, the `gripe` on PATH globs `~/.claude/plugins/cache/jakub/gripe/*/bin/gripe` and `${CODEX_HOME:-~/.codex}/plugins/cache/jakub/gripe/*/bin/gripe`, skips a version Claude Code has orphaned, ranks the rest by the version in the directory name, and runs the newest. A machine with gripe installed on both hosts still has one CLI and one log. No registry file is read; the cache directory name is the whole of what it trusts. `GRIPE_HOME` overrides that for development work, and a `GRIPE_HOME` that points nowhere usable stops with one stderr line instead of quietly filing into the live database through the installed copy.

Gripes arrive in two ways:

1. Hooks. On both hosts, gripe is advertised at session and subagent start. On Claude, a turn that fails outright is filed directly, and a repeated tool failure gets a nudge.
2. Self-reported gripes, filed by the agent because it wanted to. The agent is encouraged to file gripes for basically anything it finds irritating.

There's no clustering, no tags and no severity field. A model understands and groups these better than any code would, and realistically I'm never reading these anyway. Just pipe that shit straight into an LLM and ask it what to do.

The `/gripe` skill is unneeded day-to-day, but tells the agent how to read the database.

| Path | What's there |
|---|---|
| `plugins/gripe/bin/gripe` | The CLI. `add`, `dump`, `seen`, `search`, and `doctor` all live here. |
| `plugins/gripe/bin/shim.mjs` | The resolver. A copy of it sits on PATH at `~/.local/bin/gripe`, picks the newest live install of this plugin in either plugin cache at exec time, and hands off to that install's `bin/gripe`, so reinstalls and version bumps don't strand it. |
| `plugins/gripe/hooks/` | Claude and Codex registrations plus thin adapters for advertisements, observations, and nudges. |
| `plugins/gripe/skills/gripe/` | How to read the gripe database. For doing analysis, not for normal work. |
| `docs/gripe/DESIGN.md` | The measured facts behind gripe's design, and the shim's resolution rules. |
