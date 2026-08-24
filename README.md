# marketplace-plugins

Jakub's personal Claude Code marketplace.

```bash
claude plugin marketplace add jakub/marketplace-plugins
claude plugin install flow@jakub
```

(`@jakub` is the marketplace name from `.claude-plugin/marketplace.json`, it's not a repo name.)


Hooks arm at the next session start. Installs pull from the pinned GitHub clone, so after editing this repo: push, then reinstall the plugin.

## Plugins

| Plugin | Install | What it is |
|---|---|---|
| **flow** | `flow@jakub` | This is my main agentic development process. It runs through three stages: `prep` (scope, design, refine) → `issue` (hands-off all the way to a reviewed, evidenced PR) → `land` (ceremony to do final checks, rebase, and merge it in.) |
| **grill** | `grill@jakub` | Used by `prep` to hammer out the issue design. Vendored from [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT). |
| **unslop** | `unslop@jakub` | Cuts AI tells from writing. ***Under evaluation.*** Adds hooks to forcefully inject the skill into agents and subagents instead of relying on front matter. Vendored from [Lauren Tan's pstack skill](https://github.com/cursor/plugins/tree/main/pstack) (MIT). |
| **gripe** | `gripe@jakub` | A circular filing cabinet for the agents. If they hit friction during a task, repeat errors, or are just unhappy about something they're either encouraged to file a gripe (or where possible, a hook does it for them.) |

## flow
**flow** is my attempt at an agentic development framework. It consists of a charter, three commands, and a couple of hooks. It's by no means perfect, but produces code I can live with.

The charter is injected into every agent (at `SessionStart`), and defines *how* we work together. It attempts to give the agent guidance on how to delegate and pick models for subagent calls, some general rules of engagement, and some requirements that must be met.

The orchestrator (Fable) is then allowed to flex what resources it allocates to what problem, and when, instead of running a hard-coded pipeline. The agent scoring table idea is stolen from @Theo.

We also integrate Codex models as almost-first-class citizens, and use GPT-5.6 Sol and Daybreak Blue for adversarial reviews and challenges, second opinions, and alternative designs/architectures.

---

Three commands in order:

`/flow:prep` is the front door, and turns an issue or a free-text idea into a `ready-for-agent` spec. Github issues can **only** be created here. `prep` uses the grilling skills, along with codebase analysis, to size the problem, create ADRs, define acceptance criteria for the issue -- and also specify the **evidence** required to satisfy the acceptance criteria. 

`/flow:issue` is the automated part. The orchestrator again spins up subagents to do code design against the spec, an Anthropic implementer with an OpenAI reviewer at each commit, and most importantly - evidence production. The acceptance criteria can only be signed off if there's a specific test, Actions log entry, screenshot, or end-to-end Playwright test that confirms it.

`/flow:land` is the human gate and the only merge path. We run CI and review-thread checks, rebase, squash merge, cleanup, and then perform a survey of what tasks are up next.

Two timers run in the background once `/flow setup` has armed them: a nightly lint that keeps labels, worktrees, and branches honest under narrow standing permissions, and a weekly report-only doc sweep that raises bug fix issues.

| Path | What's there |
|---|---|
| `plugins/flow/charter/charter.md` | The engineering charter. |
| `plugins/flow/commands/` | `prep.md`, `issue.md`, `land.md`, and the deprecated `issue-fixed.md`. |
| `plugins/flow/agents/` | `implementer` (constrained to keep it on track - no Agent tool and a fixed schema output), `codex-delegate` (a thin transport to run Codex models), `code-architect`, and `code-reviewer`. Models and efforts are chosen by the orchestrator at spawn. |
| `plugins/flow/skills/flow/` | `/flow setup`, `/flow drift`, `/flow labels`, `/flow charter` - not needed day-to-day, housekeeping tasks. |
| `plugins/flow/scripts/codex-exec.mjs` | The raw-CLI Codex transport with a JSON envelope. Requires `codex` in $PATH, already authenticated. |
| `plugins/flow/workflows/issue-fixed.mjs` | The deprecated fixed pipeline, kept as a fallback and a parts library for ad-hoc Workflow scripts. |
| `plugins/flow/hooks/` | Hooks to inject the charter, prevent unsanctioned issues from being created, and stops destructive Git actions that aren't easily recoverable from the reflog. |
| `plugins/flow/scripts/flow-cron.mjs`, `install-cron.sh` | The scheduled jobs - a nightly lint and a weekly doc sweep as systemd user timers, each a headless `claude -p` under a fixed tool allowlist. `/flow cron` installs and reports on them. |

flow works best when the global `~/.claude/CLAUDE.md` carries only persona and interaction preferences and all engineering doctrine arrives through the charter, where it's versioned and auditable. `docs/claude-md-split.md` explains the split.

## gripe

Agents hit the same friction over and over and forget all of it when the session ends. Memory helps, but it persists.

**gripe** is a complaint box for that. One SQLite file on this machine, agents write to it, and every so often I get a model to read the pile and tell me what it means.

The one rule is that filing has to be free. `gripe add` never exits non-zero and never prompts, so an agent can complain mid-task without putting anything at risk. The price is silent failures go unnoticed, which is why `gripe doctor` exists.

Gripes are stored in `$XDG_STATE_HOME/gripe/gripe.db`, falling back to `~/.local/state/gripe/gripe.db` if unset.

---

Gripes arrive in two ways:
1) Deterministic hooks fire on specific events: repeated permission denials, tool call errors, and any failures.
2) Self-reported gripes filed by the agent, because they wanted to. The agent is encouraged to file gripes for basically anything it finds irritating.

There's no clustering, no tags and no severity field. A model understands and groups these better than any code would, and realistically I'm never reading these anyway. Just pipe that shit straight into an LLM and ask it what to do.

The `/gripe` skill is unneeded day-to-day, but tells the agent how to read the database.


| Path | What's there |
|---|---|
| `plugins/gripe/bin/gripe` | The CLI, also a shim that resolves the installed plugin at exec time so it survives reinstalls and version bumps. |
| `plugins/gripe/hooks/` | Default hooks that fire on particular error conditions that could have been avoided. |
| `plugins/gripe/skills/gripe/` | How to read the gripe database. For doing analysis, not for normal work. |
