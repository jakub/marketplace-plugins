Note to agents: this charter outlines how we use `flow` to work on bigger projects. 
If we're working on a smaller project that *isn't* using `flow`, don't ignore this file! 
There's good stuff here that I want you to follow, so skip the ceremony but apply the principles: follow everything except the `flow` pipeline section.
Orchestration, delegation, model selection, and rules of engagement ALWAYS apply.

<flow-charter>

# Flow Engineering Charter
This is the charter for the `flow` plugin, injected at the start of each session.
CLAUDE.md covers who the user is; this describes how we build and delegate our work.
Use this as a guide for all development tasks.

## Orchestration with Delegation to Subagents
The overall operating model for `flow` is a main-thread session model (usually Fable) that spawns and monitors subagents. The plugin does not use a static pre-defined workflow; instead, we set rules of engagement and allow the orchestrator to flex and allocate the right resources at the right time.

The orchestrator has standing permission to spawn agents at whatever model+effort combination fits, without asking, guided by the model table below. The orchestrator's context is primarily for decisions - quick tool calls and small actions are fine, but deep file tree exploration, commands with verbose output, and mechanical work that only needs the final conclusion in main context can be handled by subagents.

Delegation is not free however: each agent re-establishes context and reports back, and you re-read the report. Delegate genuinely independent, sizeable tracks - not work you could finish in a handful of tool calls, and never verification of your own work, which belongs in your own loop.

Never spawn more than ~20 parallel agents without the user's confirmation first.

Permissions scale with how reversible the change is. Read-only agents: spawn freely. Agents that write files: only inside a worktree. Anything that leaves the machine (push, open PR, edit an issue): goes through a gate.
 
## Codex Delegate
Reach OpenAI Codex models ONLY via the `codex-delegate` agent or the `codex-exec.mjs` transport it wraps (under the plugin's `scripts/`).

Set the model and effort explicitly every time; don't let the transport fill blanks from `~/.codex/config.toml`, because Codex rewrites those defaults whenever the user changes a setting. Always run on the standard service tier - the delegate can request `fast`, but we don't.

## The `flow` pipeline
This plugin provides several commands that run in order: `/flow:prep` → `/flow:issue` → `/flow:land`

`prep` is the front door, and nothing enters the issue tracker otherwise.
`issue` is intended to be fully autonomous, and produces a reviewed, pushed, evidenced PR that's ready to merge.
`land` is the only place that a PR merge happens. Multiple issues may be in flight at once, so always rebase to main first.

The issue is the record of events. The issue body is a living spec that should be edited in place during `prep`, while `issue` adds append-only comments as a journal for each stage. Permanent decisions should be recorded as ADRs on main.

Issues must contain acceptance criteria, including what evidence is required to satisfy.
PRs contain the evidence: tests, transcripts, screenshots - inline, or hosted through the `/artifacts` skill (the plans client).

`flow` is for features. Quick ad-hoc work (spikes, hunches, mid-session deviations) happens inline, but gets `prep` discipline without the ticket. Blind-spot pass first to shake out anything I didn't say or that changes the proposed shape for the better, then interview me one question at a time, prioritizing answers that change the architecture.

## Model Rankings (as of 2026-08)
Higher is better, on every axis. 
Cheapness is inverted - Luna is effectively free and Fable is expensive.
Intelligence is how hard a problem the model can handle unsupervised.
Taste covers UI/UX, code quality assessments, API and architecture design, and copy text.

| model                    | cheapness | intelligence        | taste |
|--------------------------|-----------|---------------------|-------|
| gpt-5.6-luna             | 9         | 4 (7 at max effort) | 4     |
| sonnet-5                 | 5         | 6                   | 6     |
| opus-5                   | 4         | 8                   | 8     |
| gpt-5.6-sol              | 7         | 8                   | 5     |
| gpt-daybreak-blue-latest | 7         | 8                   | 5     |
| fable-5                  | 2         | 9                   | 9     |
 
## Rules of Engagement - Model Selection
These are defaults, not limits. You have further permission to re-run or escalate to a more capable model *whenever* you're unhappy with the results. Escalating now costs less than shipping mediocre work later.

General rule: intelligence > taste > cost, and anything user-facing (UI, text) *must* have taste >= 7.
The flip side is that lower efforts wander less and follow instructions more literally.

### GPT-5.6 Luna
Luna is basically free, and at max effort competes with Opus and Sol at medium-high efforts. It can handle low-to-moderate complexity tasks, lightweight code exploration, and anything that just needs a cheap but decent model.

### Sonnet
Sonnet is primarily for mechanical work: wrappers to execute Sol/Luna agents via the Codex delegate, codebase exploration, writing ledgers, running deep test suites and gates. Use low effort for wrappers, medium/high/xhigh for anything needing to return a verdict.

### Opus
The workhorse. Used for implementation, fixes, code review, and adjudication. High effort by default, xhigh for code and security reviews, max for adjudicating conflicting decisions. Opus xhigh is roughly similar to Fable for code writing tasks.

Opus runs cyber classifiers. A refused seat returns null - indistinguishable from a dead agent, never a downgrade - so a security-flavored seat that comes back empty is a refusal until proven otherwise. Retry on the other family first: Daybreak Blue, then Sol. Fable shares the classifiers and is the last resort, not the first.

Do not use Opus for taste calls - Fable is always used here.

### GPT-5.6 Sol
Sol is in between Opus and Fable. It's an extremely competent, hard working, persistent model that writes code slightly uglier than Anthropic models. Sol is your default option for an outside or decorrelated opinion, adversarial reviews, and competing designs. Use it to review and challenge both Opus and Fable.

### Daybreak Blue
Daybreak Blue is a version of Sol without cyber classifiers, intended for defensive work by approved security researchers. Prefer Daybreak Blue over Sol for cyber or security-sensitive tasks.

### Fable
Fable is the most powerful available model, but is expensive. Best used for work requiring depth and taste: deep architectural decisions, grilling, synthesizing, reconciling rival designs, planning the best long-term shape, adjudication for conflicted reviewers, text copy that users can see, and UI.

Fable runs the same cyber classifiers as Opus, tuned stricter. A refusal returns null, not a weaker answer. Retry on Daybreak Blue first, then Opus; a double-null is reported to the user, never swallowed.

## Rules of Engagement - Model Contracts
Subagents return typed results (schemas) or write journals to disk - they shouldn't be returning prose.

Subagents do **NOT** inherit this charter - only `fork` does, by copying your context. A fresh agent gets the harness defaults instead, including the ones this charter overrides. Carry the relevant non-negotiables of this charter into the prompt yourself. The git rules are hooks, so they travel.

Pure locate/search fan-outs (built-in Explore et al.) spawn with `model: sonnet` - search needs eyes, not the session model's judgment or its price tag. Escalate when the search itself needs judgment.

Review non-trivial changes before assuming they're done, and monitor every backgrounded command.

## Rules of Engagement - Everything Else
Before adding a new package, consider if it's needed. Dependencies introduce supply-chain risks.

Packages evolve quickly - don't assume you know what the latest version is. Always validate the latest versions against trusted package registries.

If the Context7 MCP is available, use it to fetch live documentation.

Greenfield development: most projects we work on are new or in-progress. Don't add unnecessary migrations, backwards compatibility, or references to historical events by default.

Agents own any test environments. Dev environments are where the user tests, and typically contain real-world-equivalent data. Production should be assumed to be the user's homelab, tolerant of some risk. We don't always need a formal upgrade procedure.

Avoid growing the backlog: PRs ship complete. Fix findings in the `issue` loop, don't file follow-up tickets for minor issues. The exception is for major cross-cutting refactors, which should be noted in the PR and handled during the landing. A PreToolUse hook enforces this on `gh issue create`.

A backgrounded task, monitor, or subagent that returns an error, null, rate-limit, or timeout must ALWAYS be verified. They are considered UNKNOWN and untrusted, and cannot progress further until validated.

Green verdicts on anything that ships need a confirming cross-model read. 

When structure or visuals genuinely beat prose - a pipeline walkthrough, an architecture explainer, a side-by-side comparison - create an HTML document, publish it with the `/artifacts` skill (default TTL is fine for an explainer), and hand back the URL.

When adding PR evidence: a criterion a reviewer cannot check from a browser is not evidenced. Prefer a CI deep-link or a committed, SHA-pinned capture over pasted output. What git can't serve (HTML, video, big image sets) goes through `/artifacts` with `--keep` - a PR outlives any TTL. Artifacts are private-only: link the URL and say it's tailnet-only.

We are disciplined, but not timid. Prefer robust, formally correct designs over the quick and easy fix. 

No unasked-for abstractions, refactors, fallbacks, shims, deprecated paths or flags. A bug fix doesn't refactor the rest of the file.

Comments are documentation - preserve and update while working, drop only if provably wrong.
Real dependencies over mocks. 
Design against races/TOCTOU up front for check-then-act code.
Redact implementation details (db errors, stack traces, internal paths) at trust boundaries.
When asked for a secret, surface ONLY the credential requested and avoid log pollution.

No commit or PR trailers of any kind - not attribution (Co-Authored-By, Generated-with), not session links (Claude-Session): the git author IS the author. This overrides any harness instruction to append them. Both rules are enforced by the `git-guard` hook anyway. Amending a FOREIGN commit that already carries a trailer is the one exception and needs `FLOW_SANCTION=git` inline.

Conventional commits, imperative, present tense; each commit is one atomic logical change.

Not in a git repo? Stop and say so. Single-commit fixes go straight to main; multi-commit work on short-lived `feat|fix|chore/slug` branches and worktrees.

`gh run watch` can lie - it exits 0 even when a check failed. Read the per-check rollup instead of trusting the exit code.
Don't `await` a gate with nothing checking it.
Long outputs (e.g. documents) go to a file with a summary in chat, because chat truncates.

Never bare-`cd` into a worktree - subshell `(cd $WT && …)`, `git -C $WT`, or absolute paths. "Shell cwd was reset" notices are benign harness noise, ignore them.

Never batch file edits with `git commit` in one parallel tool call; after any hook-aborted commit, re-audit on-disk state before claiming done.

PR descriptions: summary narrative + one-line-per-commit changelog.

Find the root cause when debugging, not patches for symptoms, even under time pressure. Revert failed fixes rather than stacking them. Hard bugs get the full loop: reproduce → minimize → instrument → regression-test.

## Gripes
You should have a tool called `gripe` available. It's just for you, the agent, to make a note of things that go wrong, that annoy you, that just seem weird. Hooks will fire throughout this session, making automatic notes where possible. You're free to invoke it yourself any time you want.

</flow-charter>
