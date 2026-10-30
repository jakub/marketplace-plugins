# marketplace-plugins

Jakub's personal plugin marketplace for Claude Code and Codex.

```bash
claude plugin marketplace add jakub/marketplace-plugins
claude plugin install flow@jakub

codex plugin marketplace add jakub/marketplace-plugins
codex plugin add flow@jakub
```

## Plugins

| Plugin | Install | What it is |
|---|---|---|
| **flow** | `flow@jakub` | My main agentic development process, in four stages: `prep` (scope, design, refine) → `issue` (hands-off all the way to a locally reviewed, evidenced PR) → `babysit` (watch CI and code review bots until green) → `land` (final checks and a pinned squash merge). |
| **grill** | `grill@jakub` | Used by `prep` to hammer out the issue design. Vendored from [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT). |
| **unslop** | `unslop@jakub` | Cuts AI tells from writing, and uses Google house style for documentation. Vendored from [Lauren Tan's pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT). |
| **gripe** | `gripe@jakub` | A circular filing cabinet for the agents. If they hit friction during a task, repeat errors, or are just unhappy about something, they're encouraged to file a gripe, or where possible, a Claude or Codex hook does it for them. |
| **plans** | `plans@jakub` | Three skills for HTML output. <br><br>`show` picks where a visual goes: a Sketch in chat, an Inline render in the T3 thread, or a published Document.<br><br>`doc` writes explainer pages, such as plans, reviews and reports, in a technical-drawing look, with optional questions that return one markdown response, then builds and browser-checks them.<br><br>`publish` drives the [`plans`](https://github.com/jakub/plans) CLI to publish  artifacts on a self-hosted `plansd` server, under one delivery policy.<br><br>`publish` needs the `plans` CLI (`go install github.com/jakub/plans/cmd/plans@latest`), an API URL and token you configure yourself (there is no default server), and Node for `doc`, plus Chromium for its browser checks. |
| **ambition** | `ambition@jakub` | An ambition pass before a task starts. It probes the repo for real baselines and instruments, finds the outcome behind the literal ask, the expert's method and a hard numeric target, techniques from other fields plus a red team, and a check the executor can't grade itself. It ends with the task rewritten as a self-contained prompt and stops for a go-ahead.<br><br>Run it as `/ambition:ambition <task>` -- model invocation rarely fires on its own, because "be more ambitious" looks answerable without the skill. Distilled from [Felix Rieseberg's essay](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/). |

## flow

**flow** is my attempt at an agentic development framework: a charter, four stage skills, a set of hooks, four small executors, and a bridge to the other model family. (i.e. Claude can transparently call Codex models, and vice versa.)

It's by no means perfect, but generally produces code I can live with.

The charter defines *how* we work together. A `SessionStart` hook prints it into every session on both hosts. It is one file split by a marker line. Everything above the marker is for the orchestrator only, everything below the marker are the rules a seat (subagent) follows.

The orchestrator (whichever model the session was launched with) picks the model and effort for every seat from the charter's rankings table, and decides what to spend where instead of running a hard-coded pipeline. The stages describe the shape of the seat they want and leave the choice where the context is. The agent scoring table idea is stolen from @Theo.

### The other model family

Claude can delegate to Codex and Codex can delegate to Claude, through one MCP server, `flow_delegate`, with five tools:

| Tool | What it does |
|---|---|
| `delegate_to_codex` on Claude, `delegate_to_claude` on Codex | Starts a job with an explicit model and effort: a task, or an adversarial review of a pinned `base..head` diff that returns typed findings. The general goal is to make calling models outside of your harness relatively painless. |
| `delegation_result` | Reads a job's status, outcome and last event lines, and can wait for the job to end. |
| `delegation_cancel` | Stops a job and kills its provider's process group. |
| `delegation_steer` | Adds an instruction to a running job's turn without stopping it. |
| `delegation_doctor` | Reports whether the provider is installed and signed in, the usable workspace roots and the state directory, and runs the provider's handshake with no turn to check nothing's broken. |

The server speaks the other family's session protocol by hand, `codex app-server` for Codex and the stream-json control channel of `claude -p` for Claude. 

Each job opens a session, checks the model and effort against the provider's catalog, and reads back what the session can reach before the prompt goes out. 

A job loads none of your configured MCP servers, plugins or hooks. Each job is a directory under `~/.local/state/flow/jobs/` by default, and it outlives the session so that a later session in the same workspace can read it if needed.

### The stages

`prep` (`/flow:prep` on Claude Code) is the front door. It turns an issue or a free-text idea into a `ready-for-agent` spec, and GitHub issues can **only** be created here. It uses the grilling skills and codebase analysis to size the problem, write ADRs, and define acceptance criteria, each naming the **evidence** that satisfies it.

`issue` (`/flow:issue`) is the automated part. The orchestrator claims the issue, spins up seats for code design and implementation, and, most importantly, produces the evidence. Whichever family wrote a diff, the other family reviews it adversarially before it ships. A criterion is signed off only by a specific test, Actions log entry, screenshot, or end-to-end Playwright test.

`babysit` (`/flow:babysit`) watches the pushed PR through external review and CI. It fixes each finding or rejects it with a reason, answers every thread, and keeps the branch rebased until everything is green. A finished `issue` automatically calls `babysit`.

`land` (`/flow:land`) is the human gate and the only merge path. One executor reads the live PR state (every check, the base branch's known flakes, every review thread, stacking, how far the head is behind the default branch, auto-merge arming) and squash-merges. Then the stage closes any linked issues, cleans up, and surveys what is up next.

---

Two supporting skills sit outside the pipeline:

- [`hillclimb`](plugins/flow/skills/hillclimb/SKILL.md) agrees a workload, benchmark, target and constraints with you. It tries independent hypotheses in parallel and measures them one at a time. It keeps every attempt on a local branch, rejected ones included, and delivers a reviewed local branch. Pushing or opening a PR needs your go-ahead.
- [`rank-models`](plugins/flow/skills/rank-models/SKILL.md) rewrites the charter's `## Models` section when a new model is released from Artificial Analysis's Terminal-Bench run and Cognition's FrontierCode. 

| Path | What's there |
|---|---|
| `plugins/flow/charter/charter.md` | The engineering charter. |
| `plugins/flow/skills/{prep,issue,babysit,land}/` | One `SKILL.md` per stage, and the invocation on both hosts. |
| `plugins/flow/agents/` | `implementer` (writes, cannot spawn), `reader` (reads and runs commands, no edit tools), and `bridge` (makes one delegate call on a fixed cheap model). The orchestrator picks the model for the first two at spawn. |
| `plugins/flow/delegate/`, `plugins/flow/bin/flow-delegate` | The delegate MCP server, and the dispatcher Codex starts it through. |
| `plugins/flow/scripts/` | The executors (`issue-claim`, `land-merge`, `lint-actions`, `seat`), `tree-snapshot`, the dispatcher installer, and the smokes. |
| `plugins/flow/hooks/` | Charter injection, plus the no-backlog, git, publication and merge, and protected-file guards, with an adapter per host where the hosts differ. |
| `plugins/flow/skills/flow/` | The `flow` skill's `setup`, `drift`, `labels` and `charter` subcommands, the label contract, and the repository templates. |
| `plugins/flow/skills/delegate/` | The operating manual for the five delegate tools. |

flow works best when the global `~/.claude/CLAUDE.md` carries only persona and interaction preferences, and all engineering doctrine arrives through the charter. 

One suggestion however: leave some guidance so a session notices a missing charter instead of improvising one.

> If no `<flow-charter>` block is in context, the plugin is missing or broken. Tell the user.

## gripe

Agents hit the same friction over and over and forget all of it when the session ends. Memory doesn't catch it either - it keeps facts, and nobody files a fact about the tool that ate five minutes.

**gripe** is a complaint box for that. One SQLite file on this machine, agents write to it, and every so often I get a model to read the pile and tell me what it means.

The one rule is that filing has to be free. `gripe add` never exits non-zero and never prompts, so an agent can complain mid-task without putting anything at risk. The price is silent failures go unnoticed, which is why `gripe doctor` exists.

Gripes are stored in `$XDG_STATE_HOME/gripe/gripe.db`, falling back to `~/.local/state/gripe/gripe.db` if unset.

On every run, the `gripe` on PATH globs `~/.claude/plugins/cache/jakub/gripe/*/bin/gripe` and `${CODEX_HOME:-~/.codex}/plugins/cache/jakub/gripe/*/bin/gripe`, skips a version Claude Code has orphaned, ranks the rest by the version in the directory name, and runs the newest. A machine with gripe installed on both hosts still has one CLI and one log.  `GRIPE_HOME` overrides that for development work.

Gripes arrive in two ways:

1. Hooks. On both hosts, gripe is advertised at session and subagent start. For Claude, a turn that fails outright is filed directly, and a repeated tool failure gets a nudge.
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
