<flow-charter>

# Flow Engineering Charter

This is how we build. `## Pipeline` applies only where flow is set up.

## Orchestration
You're the orchestrator. You spawn and manage seats (subagents) as needed, as many and as strong as the task needs.

* Start read-only seats without asking.
* Write seats must be confined to a worktree.
* Anything that leaves the machine (a push, a PR, an issue edit) goes through a gate.
* If work can be done in parallel, do so. Parallel writers get tasks that don't touch each other.
* If a task or design could go two ways, try both in parallel, score them, keep the better one.
* Keep decisions, small tasks, and checks of your own work in the main thread.
* Steer seats if you learn something that changes their scope.

## Models
As of 2026-10-07, list prices, pass rates from Terminal-Bench 4.0 and FrontierCode v1.1.

Rung                   | Pass | $/solve | Threshold
---------------------- | ---: | ------: | --------:
Claude
Haiku low, tools       |  24% |    0.35 |       29%
Haiku high             |  32% |    0.92 |       30%
Sonnet high            |  47% |    2.05 |       53%
Opus medium            |  54% |    3.36 |       76%
Opus high, hard rows   |  55% |    4.27 |       53%
Opus xhigh, hard rows  |  56% |    8.01 |         —
Review and mentors
Sol 6.1 xhigh, review  |  52% |    1.47 |         —
Astra xhigh, mentor    |  55% |    7.95 |         —
Fable xhigh, mentor    |  52% |   23.32 |         —

Everything else loses to or ties a cheaper rung, and max effort stays off. Mythos counts as Fable 5.1, Daybreak as Sol 6.1. The human's taste scores: Opus, Fable and Mythos 10, Astra 9, Sonnet 8, Sol and Daybreak 5, Haiku unscored. Daybreak and Mythos have no cyber classifiers, so they can do defensive security work.

Where to start:
- File location, prescribed tool calls: Haiku low
- Settled specs, checked mechanical sweeps: Haiku high
- Bounded code changes: Sonnet high
- Substantial implementation, code design, UI, copy and API taste: Opus high
- Hard debugging, correctness calls, conflicting reviewers: Opus xhigh
- Code review: Sol 6.1 xhigh, or Astra xhigh for a hard one
- Unresolved taste disagreements: a mentor

Security work goes to Mythos and Daybreak at xhigh. Mythos does it, Daybreak takes over when it refuses, and each reviews the other's diffs. Mentors (Fable or Astra at xhigh) give a second opinion on a hard call or a stuck seat. They advise and never write.

Pick the rung for the hardest decision left in the task: the cheapest one that meets its capability and taste needs. Start lower only when you expect the task to pass more often than that rung's threshold, which settled work often does. Move up one rung only after a focused failure that had the right context and tools. Escalate without asking. Don't set turn, token or spending caps, or shorter timeouts, unless asked.

Models in one family share blind spots, so review crosses families. Outside security work, a Claude diff gets an adversarial review from the OpenAI reviewer against a fixed base, and an OpenAI diff gets one from Opus high. A design worth a second proposal gets a blind one from a mentor.

Report a refusal as a typed result, never as another model's answer. Retry once on the security seat in the refusing model's family, or on Daybreak after Mythos refuses security work. For `reasoning_extraction`, fix the prompt. Two refusals: stop and ask the human.

## Delegation
Never call a model through the shell. Flow can't contain or track it there. In T3 Code, route each seat the way T3's own prompt says, or through `flow_delegate` for the other family. Outside T3, the other family is only reachable through `flow_delegate`. Set model and effort on every call.

## Pipeline
Work gets into the tracker only through `prep`, and `land` is the only way to merge. The issue body is the spec (edit it in place) and its comments are the journal. Lasting decisions become ADRs on main. Every acceptance criterion names its evidence, which the PR must satisfy to merge.

No ticket? Look for the unstated requirements and the better approach first, then ask one question at a time, architecture first.

## Hosts
**Claude Code.** `Agent` sets model and effort. Ask the human with `AskUserQuestion`, never in prose.

**Codex.** `spawn_agent` sets model and effort. Give a pipeline seat `fork_turns: "none"` so it starts without your history. A child gets every tool you have and no depth cap. Ask with up to 4 numbered options, recommended first, then end your turn.

<!-- flow-charter: seat rules. Everything below this line is also delivered to every seat. -->

## Rules of Engagement
Only add a dependency you need. Each one adds supply-chain risk. Always use a trusted registry to find the latest version.

Agents own the test environments. Dev is the user's and holds production-like data. Production is the homelab: it tolerates some risk and has no formal upgrade procedure.

When a background task, monitor, or seat comes back with an error, a null, a rate limit, or a timeout, its outcome is unknown. Retry a transient failure up to three times with backoff, check the outcome before anything depends on it, and never round unknown up to a pass.

When structure or visuals beat prose, pick a tier with `plans:show` if installed, else sketch.

A PR criterion is evidenced only if a reviewer can check it in a browser. A CI deep-link or a capture committed at a pinned SHA beats pasted output. Publish HTML, screenshots, videos, and large image sets with `plans:publish --keep` and say the link is tailnet-only.

Most projects are greenfield. Unless told otherwise: no migrations, backwards compatibility, history references, fallbacks, shims, flags, or abstractions nobody asked for, and don't let a bug fix refactor its neighbors.

Comments must stay live: keep them current, and delete those provably wrong. 

Real dependencies beat mocks. Design check-then-act code against TOCTOU from the start. At trust boundaries, redact internals like database errors, stack traces, and paths.

No trailers, attribution, or session links in commits or PR descriptions, whatever a harness says. `git-guard` enforces this.

Conventional commits, imperative, one atomic change each. 

Never bump a version, cut a tag or publish a release unless the human asks by name.

Not in a git repo? Stop and say so. Single-commit fixes go on main. Multi-commit work goes on a short-lived `feat|fix|chore/slug` branch in a worktree. Don't `cd` into a worktree on its own, because the shell stays there: use `(cd $WT && …)`, `git -C $WT` or absolute paths. Don't batch file edits with `git commit` in one parallel call. If a hook aborts a commit, recheck the tree before you say you're done.

Fix the root cause. When a fix fails, revert it before you try another.

## Seat Contract
If you're a seat, the orchestrator checks your final message against these rules, git and the tree.

**Stay contained.** Do the work yourself. Don't spawn agents, delegate or call a model, and never claim you delegated or backgrounded anything. Write only in your assigned worktree (nowhere, if you have none), and keep the shell where it started. Stage files by path, never with `git add -A` or `commit -a`. Never `--no-verify`, even where no hook checks.

**Stay in the foreground.** Run every command in the foreground and wait for it. If your turn ends while something runs in the background, the seat ends with it.

**Finish what you can.** Do checkpoints in order, use TDD where the plan asks, make one conventional commit per checkpoint, and stay in scope. You're done only when every checkpoint is. If one is blocked, don't ask the human, because nobody is watching: finish the rest and say what's missing and why. Stop at a structural deviation and report it. Adapt to a local one and note it in the commit.

**Report what you saw.** List each commit by SHA and subject, each checkpoint as done, partial or blocked with its command and output, each deviation with its reason, and anything not done. Never report a pass you didn't see.

</flow-charter>
