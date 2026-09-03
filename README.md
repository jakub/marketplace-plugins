# marketplace-plugins

Jakub's personal Claude Code marketplace. Everything here installs on Codex too. Flow,
Gripe, and Unslop carry a Codex manifest, because Codex reads hook and MCP registrations
only from one; Grill ships skills alone and needs none, since Codex finds
`skills/*/SKILL.md` by itself. The Claude marketplace remains the publishing catalog.

```bash
claude plugin marketplace add jakub/marketplace-plugins
claude plugin install flow@jakub
```

(`@jakub` is the marketplace name from `.claude-plugin/marketplace.json`, it's not a repo name.)


Hooks arm at the next session start. Installs pull from the pinned GitHub clone, so after editing this repo: push, then reinstall the plugin. Codex hook definitions also require an explicit trust review before they run. On Codex the commands are different and there is no update verb, so see the lanes below.

## Installing and updating

The two harnesses have different plugin CLIs, so they get separate lanes. The spellings below come from the help output of the versions named, not from memory. One exception. I did not capture the arguments the `marketplace` subcommands take on either side, so read their `--help` rather than trusting a copy here. Re-check the rest when you upgrade either CLI.

### Claude Code

Verified against Claude Code 2.1.257, 2026-09-01.

```bash
claude plugin marketplace add jakub/marketplace-plugins
claude plugin install flow@jakub
claude plugin update flow@jakub
claude plugin list
```

`claude plugin install` defaults to `--scope user`. Take the default, because user scope is the only registry flow's cron launcher reads. `claude plugin update` says "restart required to apply", so quit and reopen Claude Code afterwards. Uninstall is `claude plugin uninstall flow@jakub`, and uninstall-then-install is the blunt version of an update when you want a clean re-registration.

### Codex

Verified against codex-cli 0.152.0, 2026-09-01.

Register the marketplace once with `codex plugin marketplace add`, which adds a local or Git marketplace to the configured sources. Then:

```bash
codex plugin add flow@jakub
codex plugin list
codex plugin list --available --json
```

Codex 0.152.0 has no update verb. `codex plugin --help` lists `add`, `list`, `marketplace`, `remove`, and `help`, and `codex plugin update` answers `error: unrecognized subcommand 'update'`. Updating is therefore two moves, refresh the snapshot and re-register the plugin:

```bash
codex plugin marketplace upgrade
codex plugin remove flow@jakub
codex plugin add flow@jakub
```

`codex plugin marketplace upgrade` refreshes the configured Git marketplace snapshots, and `codex plugin marketplace upgrade --help` says whether it wants a marketplace name. Refreshing updates the bytes Codex could install; it does not touch a registration you already made. Until `codex plugin remove` and `codex plugin add` run, the installed plugin stays on the version it was added at, and every session keeps loading that version's hooks. Start a new Codex thread after re-adding. A thread already running read the old registration at its own session start and will not notice a newer one.

### Upgrade both harnesses in one sitting

If you have flow or gripe registered in both Claude Code and Codex, update both before you go back to work.

Gripe's `~/.local/bin/gripe` shim carries a protocol epoch marker, and the SessionStart hook that maintains it replaces a shim whose marker is missing, lower, or unparseable, repairs one whose marker matches but whose bytes have drifted, and leaves a strictly higher one alone. That ratchet lives in the shim's own code, so a harness still registered on gripe 0.2.x has no ratchet at all. Its SessionStart hook overwrites whatever it finds, including the newer shim you just installed, and you end up with a shim that flips back and forth depending on which harness you last opened.

The same reasoning is why the shim running the newest install it can find is mitigation and not a guarantee. Hooks import their own install's storage code directly and never run through the shim, so an old hook can still open the database whatever the shim decides. The durable guarantee sits underneath. Schema migrations are numbered and additive only, and code older than the database refuses to touch it rather than corrupting it: `gripe add` still exits 0 with one stderr line, and the read commands report the failure.

## Plugins

| Plugin | Install | What it is |
|---|---|---|
| **flow** | `flow@jakub` | This is my main agentic development process. It runs through three stages: `prep` (scope, design, refine) → `issue` (hands-off all the way to a reviewed, evidenced PR) → `land` (final checks and a pinned squash merge). |
| **grill** | `grill@jakub` | Used by `prep` to hammer out the issue design. Vendored from [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT). |
| **unslop** | `unslop@jakub` | Cuts AI tells from writing. ***Under evaluation.*** Adds Claude and Codex hooks to forcefully inject the skill into agents and subagents instead of relying on front matter. Vendored from [Lauren Tan's pstack skill](https://github.com/cursor/plugins/tree/main/pstack) (MIT). |
| **gripe** | `gripe@jakub` | A circular filing cabinet for the agents. If they hit friction during a task, repeat errors, or are just unhappy about something they're either encouraged to file a gripe, or where possible, a Claude or Codex hook does it for them. |

## flow
**flow** is my attempt at an agentic development framework. It consists of a charter, three commands, and a couple of hooks. It's by no means perfect, but produces code I can live with.

The charter is injected at `SessionStart` and defines *how* we work together. It's one file in two halves: everything below a marker line is the rules a seat follows, and a `SubagentStart` hook hands exactly those bytes to every seat that gets spawned, on both harnesses, so a spawn prompt never carries contract text and a seat reached across the bridge gets the same block in its preamble. It attempts to give the agent guidance on how to delegate and pick models for subagent calls, some general rules of engagement, and some requirements that must be met.

The orchestrator (whichever model the session was launched with) picks the model and effort for every seat it spawns, and flexes what resources it allocates to what problem, and when, instead of running a hard-coded pipeline. Nothing else names a model: the stages describe the shape of the seat they want and leave the choice where the context is. The agent scoring table idea is stolen from @Theo.

We also integrate the other model family as an almost-first-class participant. Claude can delegate to Codex, Codex can delegate to Claude, and both routes keep durable jobs, typed results, cancellation, and native context continuation. The job record is readable as MCP resources as well as through the tools, and an approval a delegated seat asks for is put to you as a form in the session that started it, never granted by flow on its own. We use GPT-5.6 Sol for adversarial reviews, second opinions, and competing designs, and Daybreak Blue for the security seat. The `flow:delegate` skill is the operating manual for that route, and a session reads it before its first bridge call.

---

Three commands in order:

`/flow:prep` is the front door, and turns an issue or a free-text idea into a `ready-for-agent` spec. Github issues can **only** be created here. `prep` uses the grilling skills, along with codebase analysis, to size the problem, create ADRs, define acceptance criteria for the issue -- and also specify the **evidence** required to satisfy the acceptance criteria. 

`/flow:issue` is the automated part. The orchestrator again spins up subagents to do code design against the spec, a write seat native to the orchestrating host's family or reached across the bridge, and most importantly - evidence production. Whichever family wrote a diff, a seat from the other one reviews it before it ships: a shadow reader triaging at milestone boundaries, then an adversarial pass over the finished diff before convergence. The reviewing family is always the one that didn't write the diff, so which family that is shifts with the host's native seats and the bridge, and the ban never does. The acceptance criteria can only be signed off if there's a specific test, Actions log entry, screenshot, or end-to-end Playwright test that confirms it.

`/flow:land` is the human gate and the only merge path. A read-only executor re-reads the live PR state (the CI rollup, every review thread, stacking, auto-merge arming), then a second executor squash-merges pinned to the head those gates ran against, cleans up, and surveys what tasks are up next. That executor is the merge on both harnesses: in a repo carrying a committed `.flow/managed` marker, a hook denies a raw merge command and names it.

All three run on Codex too. Each one is a single stage skill: one host-neutral body, then a `## Host mechanics` section at the end holding only what genuinely differs between the two harnesses, since the charter already describes both. The slash command is a one-sentence alias to that file.

Two timers run in the background once `/flow:flow setup` has armed them: a nightly lint that keeps labels, worktrees, and branches honest under narrow standing permissions, and a weekly doc sweep. The sweep has no write tools at all, so it files nothing and opens nothing; it reports the doc drift it found and, for a small fix, the diff you can paste.

| Path | What's there |
|---|---|
| `plugins/flow/charter/charter.md` | The engineering charter. |
| `plugins/flow/skills/prep/`, `skills/issue/`, `skills/land/` | One `SKILL.md` per stage, and the invocation on both hosts: the steps written once, then a `## Host mechanics` section per host. |
| `plugins/flow/agents/` | `implementer` (constrained to keep it on track - no Agent tool, and a report the orchestrator checks against git), `code-architect`, `code-reviewer`, and `bridge` (the transport seat for a call across the family bridge: the delegate tools and nothing else, returning the envelope verbatim). Models and efforts are chosen by the orchestrator at spawn. |
| `plugins/flow/skills/flow/` | `/flow:flow setup`, `/flow:flow drift`, `/flow:flow labels`, `/flow:flow charter`, `/flow:flow cron` - not needed day-to-day, housekeeping tasks. |
| `plugins/flow/skills/delegate/` | `flow:delegate` - how a cross-family call works: attached against detached delivery, the review mode, the envelope, the approval fork. |
| `plugins/flow/src/delegation/`, `plugins/flow/dist/delegation.mjs` | The shared delegation service and its committed runtime bundle. Claude calls Codex through App Server; Codex calls Claude through the Agent SDK. |
| `plugins/flow/hooks/` | Claude and Codex hook registrations and adapters. One `inject-charter.mjs` serves both harnesses at session and subagent start; beside it are unsanctioned-issue prevention, protected-file checks, publication and merge gates, and destructive Git guards. |
| `plugins/flow/scripts/flow-cron.mjs`, `install-cron.sh` | The scheduled jobs - a nightly lint and a weekly doc sweep as systemd user timers, each a headless `claude -p` under a fixed tool allowlist. `/flow:flow cron` installs and reports on them. |

flow works best when the global `~/.claude/CLAUDE.md` carries only persona and interaction preferences and all engineering doctrine arrives through the charter. The engineering half then lives in a git repo, where a change is diffable and reviewable, and one `plugin install` carries the whole practice to a new machine. The context cost is the same, because what leaves the dotfile arrives through the hook. Leave one pointer behind in the personal file so a session can notice a missing charter instead of improvising one: if no `<flow-charter>` block is in context, the plugin is missing or broken, and it says so rather than winging it from memory. That matters on desktop and claude.ai bridge sessions, which load plugins from service-pushed snapshots with hooks stripped, so the charter never arrives there at all.

The cross-harness module boundary and the deliberate Claude/Codex non-equivalences are
documented in `docs/cross-harness-hooks.md`. Flow's cross-family job contract is in
`plugins/flow/docs/DELEGATION.md`.

## gripe

Agents hit the same friction over and over and forget all of it when the session ends. Memory doesn't catch it either - it keeps facts, and nobody files a fact about the tool that ate five minutes.

**gripe** is a complaint box for that. One SQLite file on this machine, agents write to it, and every so often I get a model to read the pile and tell me what it means.

The one rule is that filing has to be free. `gripe add` never exits non-zero and never prompts, so an agent can complain mid-task without putting anything at risk. The price is silent failures go unnoticed, which is why `gripe doctor` exists.

Gripes are stored in `$XDG_STATE_HOME/gripe/gripe.db`, falling back to `~/.local/state/gripe/gripe.db` if unset.

One database, one command, both harnesses. On every run the `gripe` on PATH globs `~/.claude/plugins/cache/jakub/gripe/*/bin/gripe` and `${CODEX_HOME:-~/.codex}/plugins/cache/jakub/gripe/*/bin/gripe`, skips a version Claude Code has orphaned, ranks the rest by the version in the directory name, and runs the newest, so a host with gripe installed in both harnesses still has one CLI and one log. No registry file is read; the cache directory name is the whole of what it trusts. `GRIPE_HOME` overrides that for development work, and a `GRIPE_HOME` that points nowhere usable stops with one stderr line instead of quietly filing into the live database through the installed copy.

---

Gripes arrive in two ways:
1) Deterministic hooks fire on specific events. Claude can observe repeated permission denials and explicit tool failures; Claude and Codex both advertise gripe and run evidence-gated end-of-turn checkpoints.
2) Self-reported gripes filed by the agent, because they wanted to. The agent is encouraged to file gripes for basically anything it finds irritating.

There's no clustering, no tags and no severity field. A model understands and groups these better than any code would, and realistically I'm never reading these anyway. Just pipe that shit straight into an LLM and ask it what to do.

The `/gripe` skill is unneeded day-to-day, but tells the agent how to read the database.


| Path | What's there |
|---|---|
| `plugins/gripe/bin/gripe` | The CLI. `add`, `dump`, `seen`, `search`, and `doctor` all live here. |
| `plugins/gripe/bin/shim.mjs` | The resolver. A copy of it sits on PATH at `~/.local/bin/gripe`, picks the newest live install of this plugin in either plugin cache at exec time, and hands off to that install's `bin/gripe`, so reinstalls and version bumps don't strand it. |
| `plugins/gripe/hooks/` | Claude and Codex registrations plus thin wire adapters for advertisements, harness-specific observations, and checkpoints. |
| `plugins/gripe/skills/gripe/` | How to read the gripe database. For doing analysis, not for normal work. |
