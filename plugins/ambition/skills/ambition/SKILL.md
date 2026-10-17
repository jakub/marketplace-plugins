---
name: ambition
description: "Ambition pass on a task before any work starts. Invoke this skill FIRST, before any other tool call, whenever the user asks you to be more ambitious, think bigger, aim higher or push a task further; asks what they should really be asking for, or what a top expert would do that they have not asked for; or asks you to level up or sharpen a task or prompt before an agent runs it. Use it even when you could answer directly: it probes the environment for real baselines and instruments, finds the outcome behind the literal ask, the expert method and a hard numeric target, techniques from other fields plus a red team, and a verification the executor cannot grade itself, then rewrites the task as a self-contained prompt and stops for a go-ahead. Not for tasks the user simply wants done, and not mid-execution."
argument-hint: "the task to be more ambitious about"
---

# ambition

people under-ask models. the limit is usually what the asker believes is possible, so they request one crash fix when they want a crash-free app, or a 4s page load when 200ms is reachable. this pass widens the ask on three axes, pins it to a check the executor can't grade itself, and ends with a rewritten prompt and a stop.

source: Felix Rieseberg, [How to be more ambitious: a tutorial for humans with models](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/). the article also names speed (the same work, faster). this pass leaves speed out.

## what good looks like

the deliverable is the rewritten prompt. everything else is a short argument for it.

- **deeper, not bigger.** ambition shows up as a higher outcome and more rigor. it does not show up as more features or a longer roadmap.
- **do, don't write.** name instruments the executor will run (a profiler, a query, a holdout test), not expert vocabulary. this applies to the pass itself, so probe the environment instead of imagining it.
- **measured or labelled.** every number about the user's world comes from a file or command you can cite, or is marked unknown. never present an estimate as a measurement. this is the skill's main edge over a template prompt, so protect it.
- **specific or cut.** if a sentence would fit any task ("use profiling tools", "consider edge cases"), make it concrete or delete it.
- **say it once.** a fact appears in the analysis or in the prompt, never both.
- **no outside judge, no claim.** the executor's own read of its work is not verification.
- **the literal ask survives.** the ambitious version contains what the user asked for.

## 1. fit check and budget

pick the tier before recon, and state it in the output. the tier sets hard caps on what you present. the part above the prompt should read in about two minutes. the prompt is reference that the executor reads in full.

| tier | use for | reframe | findings | rewritten prompt | questions |
|---|---|---|---|---|---|
| small | a well-specified task with one obvious deliverable (bump a version, add a flag, fix a named bug) | 2 lines | up to 3 bullets | up to 25 lines | 1 |
| full | outcome-driven work: a number could move, a decision gets made, or the work would normally need a meeting | 3 lines | up to 5 bullets | up to 70 lines | up to 3 |

- the caps bound the presentation, not the thinking. when something has to go, cut analysis prose first, then CONTEXT detail the executor can rediscover with one command. never cut a move: the durable version, the measurement protocol, the red team. a worthwhile move that is out of scope for this run gets one line under LATER in the prompt instead of being dropped.
- recon may move a small task to full only by naming the specific finding that justifies it, in one line of the output. "recon turned up more work" is not a reason. most of what recon finds on a small task belongs in the prompt's CONTEXT, not in a bigger pass.
- creative and taste work (a post, a page design, naming) uses the full tier's caps with light altitude, because altitude fits creative work poorly. depth and range still help, especially a tool from another craft.
- if the task is already the right size, say so in one line and recommend running it as asked. that is a valid result.
- if the user already stated the outcome and target, don't argue with them. spend the pass on depth and verification.

## 2. recon

look at what exists before you propose anything. keep it bounded: a handful of read-only tool calls, or one read-only subagent if the surface is large. no writes, no deploys, nothing that touches remote hosts.

- raw material: logs, crash reports, analytics, exports, git history, issues, prior results, the code itself. raw beats summarized.
- instruments: test runners, benchmarks, eval harnesses, profilers, CI, telemetry, staging environments, scripts.
- judges: what could check the result independently. name a reviewer (another model family, a teammate's tool) only if recon shows it is reachable from this host. otherwise say what the judge will be.
- the baseline for whatever you will target. measure it if that is cheap and safe. if not, mark it unknown and make measuring it milestone 1.

label each item present (with the path or command), absent (where you looked), or not checked. only absent items become requests to the user.

**urgent findings come first.** if recon turns up something more pressing than the task (exposed secrets or credentials, a deadline that has lapsed or is about to, a data-loss or security risk), lead the output with it: one line each, with the evidence, and never the secret values. don't bury it in the plan. noticing what matters more right now is part of altitude.

## 3. lenses

these are thinking tools. their output lands in the rewritten prompt, and the presentation shows each lens as one line at most. an empty lens is fine. a padded one is not.

### altitude: the outcome behind the ask

- ask what the user wants to happen after this is done, then ask once more. "fix this crash" becomes "keep the app crash-free".
- stop at the highest outcome the user owns, can act on, and can measure with access that exists or can be granted.
- name the durable version: the setup that lets this run without the user next time (crash reports wired up, a version-to-commit map, test machines). it is often the real deliverable.
- name the assumption the original ask carries, if it has one ("one crash at a time", "a 10% speedup"), and whether recon supports it.

### depth: work like the best practitioner

- name what the best practitioner in this exact area would do that the user didn't ask for: the rawest material they would start from and the specific instruments (a named tool, query, statistical method, or harness).
- test the one load-bearing assumption against raw data.
- where it fits, produce new knowledge: model the system from history, predict, and check the prediction on data the model has not seen.
- set a target as a number against the baseline, with how it is measured. make it uncomfortably high but plausible (5s to 200ms, not 5s to 4s). a quick Fermi estimate keeps it honest.
- spell out the measurement protocol wherever it decides pass/fail: repeats and a spread check for noisy measurements (LLM output, benchmarks, load tests), the matcher's rules when a matcher decides what counts as a hit, and set equality by name rather than counts for regressions, so nothing vanishes silently.

### range: other fields, other tools

- restate the task as verbs: what it must do, for whom, under what constraint. one line. it often exposes the real job.
- ask which fields do that verb for a living and take a concrete technique, not a persona. "reconcile the figure across three independent sources" is a method; "think like a forensic accountant" is a costume. zero fields is fine. [references/techniques.md](references/techniques.md) has a starter list.
- always red team: the party most motivated to prove the work wrong, what they would do, and the test that exposes each likely failure.
- if the work splits into independent perspectives, spec them as parallel tracks with separate deliverables.

## 4. verification

- write pass/fail before execution, and make the executor commit the criteria to a file before the first measurement, so git history proves they didn't move.
- include at least one check the executor can run in-session: a test, benchmark, query, repro script, or holdout prediction. list checks that need the user separately.
- the executor's own judgment doesn't count, and neither does "review the code". a tool counts. a reachable independent reviewer counts.
- if no outside judge exists, building one is milestone 1, and the judge gets tested on a known-answer case (a synthetic fixture, a past result) before anyone trusts it.

## 5. rewrite the prompt

write the ambitious version as a prompt that a fresh executor can run with none of this conversation: a new session, a subagent, or /flow:prep. respect the tier's line cap. use the parts that apply and drop the rest.

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

when the target is a performance or quality number that an executor might abandon early, add one line telling it to treat the target as reachable and to report a limit only with measurements showing the wall, after trying another route. an executor told the target is reachable keeps looking for routes. leave the line out for decision criteria and deadlines, and never let it contradict your own feasibility estimate.

## 6. present and gate

use this shape, in this order, within the tier's caps:

1. urgent findings, if any, one line each.
2. the tier, and the reframe: the outcome behind the ask and the verb restatement.
3. what recon changed: only findings that changed the plan, each with its source. the full inventory lives in the prompt's CONTEXT.
4. the moves: one line each for altitude, depth, range and the judge. skip a lens that produced nothing.
5. the rewritten prompt, in a fenced block.
6. the gate.

then stop. in an interactive session, don't start executing in the same turn.

- offer the ambitious version first, as the recommendation unless you can say why not, and the literal ask second. add a middle option only at a natural cut point, usually "ambitious minus the access the user may not grant".
- in an interactive session, ask with the host's structured question tool when it has one (AskUserQuestion in Claude Code), and fold access grants into the same question set. a host without one gets numbered options, recommended first, and the turn ends.
- in a hands-off run with no human in the loop, take the ambitious version unless it needs access you lack, keep the ASSUMPTIONS defaults, and proceed.
- after the go-ahead, if the work is feature-sized and the repo uses flow, hand the rewritten prompt to /flow:prep as its input instead of executing inline. otherwise run the rewritten prompt. it is now the spec.

## before presenting, check for these

- over the tier's caps, or a tier raised without a named finding.
- a fact stated in both the analysis and the prompt.
- an urgent finding buried in the plan instead of leading.
- a baseline, count or access item you didn't verify.
- expert vocabulary with no instrument behind it, persona role-play, or fields added to hit a count.
- verification that comes down to the executor's own judgment, or a reviewer you haven't confirmed is reachable.
- a bigger scope where a deeper one was available.
- the persistence line pasted onto a decision criterion, or a hedged target ("maybe 1s if possible").
- the literal ask missing from the ambitious version.
