---
name: rank-models
description: Re-rank the charter's Models section (the Claude ladder, the reviewer, the mentors and the starting rungs) from benchmark data, with one fixed procedure. Use when a new model ships, when the user asks to re-rank or retarget models, or when the as-of date is more than a quarter old.
---

# Rank models

The charter's `## Models` section comes from this procedure and nothing else, so two runs on the same data give the same ladder. Do the steps in order. The numbers only live in the charter.

One family does the work and the other reviews. As of 2026-10-07, Claude works and OpenAI reviews. Each family has a mentor the user picks, which advises and never writes.

## 1. Candidates

List every model each family can run, new releases included, and find each one's release page on Artificial Analysis (`artificialanalysis.ai/models/<release>`). Every work-family model is a ladder candidate. Every other-family model is a reviewer candidate.

Ask the user for what no benchmark publishes:

- which family does the work;
- which models their plans run, and on which host;
- a taste score from 0 to 10 for each new model. Show its rank and 95% interval on arena.ai's Code Arena WebDev board and on Design Arena first. The score stays theirs;
- any plan quota that makes a model expensive in practice.

A model with no public score or price is unmeasured and stays off the ladder. It keeps a starting-rung row only if the user keeps it for something benchmarks don't measure, like having no refusal classifiers.

## 2. Sources

- **Terminal-Bench**, from the Artificial Analysis Intelligence Index: `terminalbench-4-0` as of 2026-10-07. Hard agentic terminal tasks on one harness, pass@1, with a cost per task from the same run.
- **FrontierCode**, Cognition's mergeability benchmark, at `cognition.com/data/frontiercode-leaderboard/data.json`: version `v1_1` as of 2026-10-07, the `main` subset's `new_score` and `cost`. Private tasks, run in each vendor's own agent.
- **AutomationBench** (`automationbench-aa` in the same index) picks the tool-call rung.

Record each eval's version, task count, harness and repeats, from its evaluation page and from the data file's `subsets` field and the changelog at `cognition.com/frontiercode`. Use the newest version of each and say which. Don't trust either one alone: Terminal-Bench runs a harness neither host uses, and FrontierCode is private, partly graded by an undisclosed model, and published by a company that sells a competing model. The ladder uses both.

**The tie band** is 49 × √(1/n₁ + 1/n₂) points, rounded, from the two coding evals' task counts: 8 points for 66 and 100 tasks. It's a policy tolerance for calling two rungs a tie, never proof that they differ.

A rung needs a positive score and a positive, finite cost on both coding evals. Never fill a gap from another source, a vendor's card or an older eval version. As of 2026-09-27, Sonar's leaderboard, SWE-rebench, Vals.ai, Epoch AI, METR, Scale's SWE-Bench Pro and Martian's Code Review Bench were checked and left out, because none covers every candidate at every effort with a cost per task from the same run. Check them again.

`slopalytics.com` plots the Artificial Analysis Intelligence Index against cost per task, with a Pareto line. It scores general ability, not coding, so it never sets a rung. Use it as a cross-check: with `frontier=true` and the work family selected, its line should hold the same variants rule 2 keeps. On 2026-10-07 it did, for Haiku 5.5 and Opus 5.5.

## 3. Extract the numbers

No extractor ships with this skill. Write a throwaway Node script in a temp directory outside the repo. Artificial Analysis has no public API: each variant page embeds the model in its React Server Components payload, as `self.__next_f.push([1,"…"])` chunks. Decode each chunk as a JSON string literal and concatenate them before you search. The release page lists the effort variants as `<release>-<effort>` slugs.

Read each eval from its score record, `{"slug":"terminalbench-4-0","score":…,"outputTokensPerTask":…,"costPerTask":…}`, the first one on the variant's page. **Never use `weightedCostPerTask`** from the page's `evaluations` list. It's about a tenth of the real cost per task and makes every number wrong. As a sanity check, the 2026-10-07 run reproduced the 2026-09-28 Opus rows to the cent.

Join FrontierCode on the release name and the effort label. For every candidate, record the Terminal-Bench, FrontierCode and AutomationBench score and cost per task, and show the user the raw table before you apply any rule.

## 4. Build the ladder

1. A rung's pass rate is the mean of its two scores. Its cost is the geometric mean of its two costs per task, and its cost per solve is cost ÷ pass rate.
2. A work-family rung leaves if another rung in the family passes at least as often for less per solve.
3. Ties collapse from the top down. The strongest remaining rung opens a group, every rung within the band below it joins, and the group's cheapest rung per solve stays. Repeat with what's left.
4. The tool-call rung is the work family's lowest cost per solve on AutomationBench, on the ladder or not.
5. Every rung but the top gets a try-first threshold: its cost ÷ the next rung's cost. Trying A before B costs c_A + (1 − p_A) × c_B, which beats c_B only when p_A > c_A ÷ c_B, assuming a failure is detectable and B solves whatever A solves.
6. A model with no rung left leaves the rankings, and each starting-rung row that named it moves to the rung that replaced it.

Ask the user about each rung a current row names that rules 2 and 3 removed. A rung they keep rejoins as a hard-rows rung and gets a threshold like the others. As of 2026-10-07, they keep Opus high and Opus xhigh for the hardest rows.

## 5. Reviewer, mentors and security seats

Apply rule 2 to the other family and show the user what's left. They pick the reviewer, and a stronger rung for hard reviews. As of 2026-10-07, Sol 6.1 xhigh reviews and Astra xhigh takes the hard reviews.

The user picks the mentors, one per family at xhigh. Benchmarks don't. As of 2026-10-07 they're Fable 5.1 and Astra, and the orchestrator picks one per question. Reviewer and mentor rows carry a pass rate and a cost per solve, and no threshold.

The user also picks the security seats, and nothing measures them. As of 2026-10-07 they're Mythos 5.1 and Daybreak at xhigh. Mythos does vulnerability and defensive security work, Daybreak takes over after a refusal, and each reviews the other's diffs. Neither has a public score, so the user maps each to a measured model, and the charter states the mapping instead of a table row: Mythos 5.1 is Fable 5.1 without its cyber classifiers, and Daybreak is the current Sol, Sol 6.1, without its classifiers. These are the only gaps ever filled from another model.

## 6. Starting rungs

For each task class, estimate how often it passes compared with the evals. Settled, well-specified work passes more often. Start at the lowest rung whose threshold you expect the task to clear. File location and prescribed tool calls start at the tool-call rung, code review starts at the reviewer, and an unresolved taste disagreement goes to a mentor. Show the user every row that changes and why, and ask before you change a taste or security row.

## 7. Rewrite the charter

Edit `## Models` in `plugins/flow/charter/charter.md`:

- **The table**: columns `Rung | Pass | $/solve | Threshold`, padded so the raw file reads aligned. No outer pipes, the rung left-aligned, the numbers right-aligned (`---: |`), and no trailing spaces. A bare row with the work family's name goes before the ladder, and a bare `Review and mentors` row before the reviewer and the mentors. A rung is its model and effort, like `Opus medium`, plus `, tools` for the tool-call rung, `, hard rows` for a kept rung, `, review` for the reviewer and `, mentor` for a mentor. Pass is a whole percent, $/solve has two decimals, and the top rung's threshold is `—`, as is every reviewer and mentor row's.
- **The sentence above the table**: the as-of date, the price basis, and both evals with their versions. How the ladder is built and what a threshold means stay in this skill and the rung-picking paragraph.
- One line each for the off-ladder models and why, the taste scores, and the classifiers that can refuse.
- **The starting rungs**: one line per task class, `task: rung`.

Check every "ties", "beats" and "costs less" against the new numbers. Then search `plugins/flow` for each model you removed or added: `scripts/flow-cron.mjs` names the scheduled jobs' default model, `skills/delegate/SKILL.md` and `delegate/server.mjs` show example ids, and `agents/bridge.md` fixes the transport model, which changes only when the user asks.

## 8. Verify and report

Run `node plugins/flow/scripts/smoke-charter.mjs`. It fails when the charter passes 9,500 characters, and a longer ladder is the usual cause. A rankings change needs no version bump. Report the old and new ladders side by side, each starting-rung row that changed and why, and each source you couldn't verify or candidate you left unmeasured.
