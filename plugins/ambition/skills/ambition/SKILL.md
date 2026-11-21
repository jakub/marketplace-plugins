---
name: ambition
description: "Ambition pass on a task before any work starts. Invoke this skill FIRST, before any other tool call, whenever the user asks you to be more ambitious, think bigger, aim higher or push a task further; asks what they should really be asking for, or what a top expert would do that they have not asked for; or asks you to level up or sharpen a task or prompt before an agent runs it. Use it even when you could answer directly: it probes the environment for real baselines and instruments, finds the outcome behind the literal ask, the expert method and a hard numeric target, techniques from other fields plus a red team, and a verification the executor cannot grade itself, then rewrites the task as a self-contained prompt and stops for a go-ahead. Not for tasks the user simply wants done, and not mid-execution."
argument-hint: "the task to be more ambitious about"
---

# ambition

People under-ask models. The limit is usually what the asker believes is possible, so they request one crash fix when they want a crash-free app, or a 4s page load when 200ms is reachable. This pass widens the ask on three axes, pins it to a check the executor can't grade itself, and ends with a rewritten prompt and a stop.

Source: Felix Rieseberg, [How to be more ambitious: a tutorial for humans with models](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/). The article also names speed (the same work, faster). This pass leaves speed out.

## What good looks like

The deliverable is the rewritten prompt. Everything else is a short argument for it.

- **Deeper, not bigger.** Ambition shows up as a higher outcome and more rigor. It does not show up as more features or a longer roadmap.
- **Do, don't write.** Name instruments the executor will run (a profiler, a query, a holdout test), not expert vocabulary. This applies to the pass itself, so probe the environment instead of imagining it.
- **Measured or labelled.** Every number about the user's world comes from a file or command you can cite, or is marked unknown. Never present an estimate as a measurement. This is the skill's main edge over a template prompt, so protect it.
- **Specific or cut.** If a sentence would fit any task ("use profiling tools", "consider edge cases"), make it concrete or delete it.
- **Say it once.** A fact appears in the analysis or in the prompt, never both.
- **No outside judge, no claim.** The executor's own read of its work is not verification.
- **The literal ask survives.** The ambitious version contains what the user asked for.

## 1. Fit check and budget

Pick the tier before recon, and state it in the output. The tier sets hard caps on what you present. The part above the prompt should read in about two minutes. The prompt is reference that the executor reads in full.

| Tier | Use for | Reframe | Findings | Rewritten prompt | Questions |
|---|---|---|---|---|---|
| small | a well-specified task with one obvious deliverable (bump a version, add a flag, fix a named bug) | 2 lines | up to 3 bullets | up to 25 lines | 1 |
| full | outcome-driven work: a number could move, a decision gets made, or the work would normally need a meeting | 3 lines | up to 5 bullets | up to 70 lines | up to 3 |

- The caps bound the presentation, not the thinking. When something has to go, cut analysis prose first, then CONTEXT detail the executor can rediscover with one command. Never cut a move: the durable version, the measurement protocol, the red team. A worthwhile move that is out of scope for this run gets one line under LATER in the prompt instead of being dropped.
- Recon may move a small task to full only by naming the specific finding that justifies it, in one line of the output. "Recon turned up more work" is not a reason. Most of what recon finds on a small task belongs in the prompt's CONTEXT, not in a bigger pass.
- Creative and taste work (a post, a page design, naming) uses the full tier's caps with light altitude, because altitude fits creative work poorly. Depth and range still help, especially a tool from another craft.
- If the task is already the right size, say so in one line and recommend running it as asked. That is a valid result.
- If the user already stated the outcome and target, don't argue with them. Spend the pass on depth and verification.

## 2. Recon

Look at what exists before you propose anything. Keep it bounded: a handful of read-only tool calls, or one read-only subagent if the surface is large. No writes, no deploys, nothing that touches remote hosts.

- Raw material: logs, crash reports, analytics, exports, git history, issues, prior results, the code itself. Raw beats summarized.
- Instruments: test runners, benchmarks, eval harnesses, profilers, CI, telemetry, staging environments, scripts.
- Judges: what could check the result independently. Name a reviewer (another model family, a teammate's tool) only if recon shows it is reachable from this host. Otherwise say what the judge will be.
- The baseline for whatever you will target. Measure it if that is cheap and safe. If not, mark it unknown and make measuring it milestone 1.

Label each item present (with the path or command), absent (where you looked), or not checked. Only absent items become requests to the user.

**Urgent findings come first.** If recon turns up something more pressing than the task (exposed secrets or credentials, a deadline that has lapsed or is about to, a data-loss or security risk), lead the output with it: one line each, with the evidence, and never the secret values. Don't bury it in the plan. Noticing what matters more right now is part of altitude.

## 3. Lenses

These are thinking tools. Their output lands in the rewritten prompt, and the presentation shows each lens as one line at most. An empty lens is fine. A padded one is not.

### Altitude: the outcome behind the ask

- Ask what the user wants to happen after this is done, then ask once more. "Fix this crash" becomes "keep the app crash-free".
- Stop at the highest outcome the user owns, can act on, and can measure with access that exists or can be granted.
- Name the durable version: the setup that lets this run without the user next time (crash reports wired up, a version-to-commit map, test machines). It is often the real deliverable.
- Name the assumption the original ask carries, if it has one ("one crash at a time", "a 10% speedup"), and whether recon supports it.

### Depth: work like the best practitioner

- Name what the best practitioner in this exact area would do that the user didn't ask for: the rawest material they would start from and the specific instruments (a named tool, query, statistical method, or harness).
- Test the one load-bearing assumption against raw data.
- Where it fits, produce new knowledge: model the system from history, predict, and check the prediction on data the model has not seen.
- Set a target as a number against the baseline, with how it is measured. Make it uncomfortably high but plausible (5s to 200ms, not 5s to 4s). A quick Fermi estimate keeps it honest.
- Spell out the measurement protocol wherever it decides pass/fail: repeats and a spread check for noisy measurements (LLM output, benchmarks, load tests), the matcher's rules when a matcher decides what counts as a hit, and set equality by name rather than counts for regressions, so nothing vanishes silently.

### Range: other fields, other tools

- Restate the task as verbs: what it must do, for whom, under what constraint. One line. It often exposes the real job.
- Ask which fields do that verb for a living and take a concrete technique, not a persona. "Reconcile the figure across three independent sources" is a method; "think like a forensic accountant" is a costume. Zero fields is fine. [references/techniques.md](references/techniques.md) has a starter list.
- Always red team: the party most motivated to prove the work wrong, what they would do, and the test that exposes each likely failure.
- If the work splits into independent perspectives, spec them as parallel tracks with separate deliverables.

## 4. Verification

- Write pass/fail before execution, and make the executor commit the criteria to a file before the first measurement, so git history proves they didn't move.
- Include at least one check the executor can run in-session: a test, benchmark, query, repro script, or holdout prediction. List checks that need the user separately.
- The executor's own judgment doesn't count, and neither does "review the code". A tool counts. A reachable independent reviewer counts.
- If no outside judge exists, building one is milestone 1, and the judge gets tested on a known-answer case (a synthetic fixture, a past result) before anyone trusts it.

## 5. Rewrite the prompt

Write the ambitious version as a prompt that a fresh executor can run with none of this conversation: a new session, a subagent, or `/flow:prep`. Respect the tier's line cap. Use the parts that apply and drop the rest.

```
GOAL: <the outcome, as verbs, with the literal ask inside it>
CONTEXT: <raw material and instruments with paths or commands, each labelled
  present / absent / not checked; numbers labelled measured (source) or unknown>
ASSUMPTIONS: <a default for every open question at the gate, so the prompt runs unanswered>
METHOD: <steps in order. milestone 1 measures the baseline or builds the judge if either is missing>
TARGET: <number> from <baseline | unknown, measure first>, measured by <how>.
PARALLEL TRACKS: <track: deliverable>
RED TEAM: <adversary, what they will try, the tests>
DONE WHEN: <criteria committed before measuring. in-session checks. checks that need the user>
NON-GOALS: <what is explicitly out>
LATER: <worthwhile moves outside this run, one line each>
CHECKPOINTS: <where to stop and show the user>
```

When the target is a performance or quality number that an executor might abandon early, add one line telling it to treat the target as reachable and to report a limit only with measurements showing the wall, after trying another route. An executor told the target is reachable keeps looking for routes. Leave the line out for decision criteria and deadlines, and never let it contradict your own feasibility estimate.

## 6. Present and gate

Use this shape, in this order, within the tier's caps:

1. Urgent findings, if any, one line each.
2. The tier, and the reframe: the outcome behind the ask and the verb restatement.
3. What recon changed: only findings that changed the plan, each with its source. The full inventory lives in the prompt's CONTEXT.
4. The moves: one line each for altitude, depth, range and the judge. Skip a lens that produced nothing.
5. The rewritten prompt, in a fenced block.
6. The gate.

Then stop. In an interactive session, don't start executing in the same turn.

- Offer the ambitious version first, as the recommendation unless you can say why not, and the literal ask second. Add a middle option only at a natural cut point, usually "ambitious minus the access the user may not grant".
- In an interactive session, ask with the host's question tool and fold access grants into the same question set: **In T3 Code**, follow your provider below; **In Claude Code**, use `AskUserQuestion`; **In Antigravity**, use `ask_question`; **In Codex**, write numbered options, recommended first, and end your turn.
- In a hands-off run with no human in the loop, take the ambitious version unless it needs access you lack, keep the ASSUMPTIONS defaults, and proceed.
- After the go-ahead, if the work is feature-sized and the repo uses flow, hand the rewritten prompt to `/flow:prep` as its input instead of executing inline. Otherwise run the rewritten prompt. It is now the spec.

## Before presenting, check for these

- Over the tier's caps, or a tier raised without a named finding.
- A fact stated in both the analysis and the prompt.
- An urgent finding buried in the plan instead of leading.
- A baseline, count or access item you didn't verify.
- Expert vocabulary with no instrument behind it, persona role-play, or fields added to hit a count.
- Verification that comes down to the executor's own judgment, or a reviewer you haven't confirmed is reachable.
- A bigger scope where a deeper one was available.
- The persistence line pasted onto a decision criterion, or a hedged target ("maybe 1s if possible").
- The literal ask missing from the ambitious version.
