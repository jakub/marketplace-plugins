---
name: rank-models
description: Re-rank the charter's Models section (the Claude ladder, the reviewer, the mentors and the starting rows) from benchmark data, with one fixed procedure. Use when a new model ships, when the user asks to re-rank or retarget models, or when the as-of date is more than a quarter old.
---

# Rank models

The charter's `## Models` section comes from this procedure and nothing else, so two runs on the same data give the same ladder. Do the steps in order. The numbers only live in the charter.

The user wants the best output first, then the fastest, and only then the cheapest. A cheap rung that passes isn't the same quality as a strong one that passes, so the ladder ranks quality, speed and cost in that order and never trades quality for price.

One family does the work and the other reviews. As of 2026-10-28, Claude works and OpenAI reviews. Each family has a mentor the user picks, which advises and never writes.

## 1. Candidates

List every model each family can run, new releases included, and find each one's release page on Artificial Analysis (`artificialanalysis.ai/models/<release>`). Every work-family model is a ladder candidate. Every other-family model is a reviewer candidate. Max effort stays off by the user's choice. On 2026-10-28 no max rung won its tie group, although Sonnet, Terra and Haiku max scored 4 to 7 points over xhigh on AA. A max rung lives on the bare release page, not a `-max` slug, and that page's first score record belongs to another model, so read the max model's own record when you check it.

Ask the user for what no benchmark publishes:

- which family does the work;
- which models their plans run, and on which host;
- a taste score from 0 to 10 for each new model. Show its rank and 95% interval on arena.ai's Code Arena WebDev board and on Design Arena first. The score stays theirs;
- any plan quota that makes a model expensive in practice.

A model with no public score, price or time is unmeasured and stays off the ladder. It keeps a row only if the user keeps it for something benchmarks don't measure, like having no refusal classifiers.

## 2. Sources

- **Terminal-Bench 4.0** (`terminalbench-4-0`) and **FrontierCode 2.0** (`frontiercode-2-0`), both run by Artificial Analysis, as of 2026-10-28. Each eval runs every model on one fixed harness, Terminal-Bench on mini-swe-agent (66 tasks) and FrontierCode on stirrup (132 tasks), three repeats each, and each record carries score, cost per task and time per task from the same run. The ladder ranks on these two.
- **FrontierCode v1.1**, Cognition's own run at `cognition.com/data/frontiercode-leaderboard/data.json`: the `v1_1` key's `main` subset, with `new_score`, `cost` and `duration_min`. It runs each model in its vendor's own agent, so it's the only source with times from a harness close to ours. `duration_min` is missing for some models. It cross-checks the ladder and never sets a rung.

Record each eval's version and task count, from its evaluation page and the data file's `subsets` field. Use the newest version of each and say which. AA's harnesses are neither host's, and its times can disagree with the vendor-agent times: on 2026-10-28, Sol 6.1 took 5–8 minutes on AA and 14–17 on FrontierCode v1.1. Flag every pick whose step disagrees in direction between the two sources.

`slopalytics.com` plots the same data. Its **Code only** toggle is this ladder's composite (the two AA evals, weighted equally), and its headline number is the overall Intelligence Index, which mixes in knowledge and QA evals. Its copy lagged AA by 1–2 points on 2026-10-28. Use it to see the shape, never for a number.

As of 2026-09-27, Sonar's leaderboard, SWE-rebench, Vals.ai, Epoch AI, METR, Scale's SWE-Bench Pro and Martian's Code Review Bench were checked and left out, because none covers every candidate at every effort with a cost and a time per task from the same run. Check them again.

A rung needs a positive score, a positive cost and a positive time on both AA evals. Never fill a gap from another source, a vendor's card or an older eval version.

## 3. Extract the numbers

No extractor ships with this skill. Write a throwaway Node script in a temp directory outside the repo. Artificial Analysis has no public API: each variant page embeds the model in its React Server Components payload, as `self.__next_f.push([1,"…"])` chunks. Decode each chunk as a JSON string literal and concatenate them before you search. The release page lists the effort variants as `<release>-<effort>` slugs.

Read each eval from its score record, `{"slug":"frontiercode-2-0","score":…,"outputTokensPerTask":…,"costPerTask":…,"timePerTask":…}`, the first one on the variant's page with a `score`. **Never use `weightedCostPerTask`** from the page's `evaluations` list. It's a fraction of the real cost per task and makes every number wrong. As a sanity check, on 2026-10-28 Opus 5.5 medium read 52.5 and 33.1, $2.63 and 6.1 minutes.

For every candidate, record both scores, costs and times, then show the user the raw table before you apply any rule.

## 4. Build the ladder

1. A rung's score is the mean of its two scores. Its cost and its time are the geometric means of its two costs and two times per task.
2. **Two tie bands**, both policy tolerances and never proof that two rungs differ: scores within 4 points tie, and times within 1.5× tie.
3. A rung leaves if another rung in its family scores at least as high and is either more than 1.5× faster, or within 1.5× and no more expensive.
4. Group from the top down. The strongest remaining rung opens a group, and every rung within 4 points below it joins. Of the group's rungs within 1.5× of its fastest time, the cheapest stays. Repeat with what's left.
5. A model with no rung left leaves the ladder, and each row that named it moves to the rung that replaced it.

Ask the user about each change to a current row: a rung the rules removed, and a rung the rules brought back that the user struck before. A rung they keep against the rules is an override, and the charter says so in one clause. As of 2026-10-28, Haiku stays off by their choice, although Haiku low won the bottom group, and Sonnet low holds the bottom row.

## 5. Reviewer, extras, mentors and security seats

Apply rules 3 and 4 to the other family and show the user what's left. They pick the reviewer and a stronger rung for hard reviews. **Review runs one column right of its pick**, because a review exists to catch wrong answers, and that's the charter's rule for moving right. As of 2026-10-28, the picks are Sol 6.1 high and Astra high, so Sol 6.1 xhigh reviews and Astra xhigh takes the hard reviews.

The user picks the extras, a rung of the other family run twice beside the reviewer. Show them the reviewer family's rungs that finish before the reviewer: the extras add no wall time, and their cost is the triage of their findings, which the orchestrator verifies. As of 2026-10-28, they're two Terra 6.1 high.

The user picks the mentors, one per family at xhigh. Benchmarks don't. As of 2026-10-28, they're Fable 5.1 and Astra, and the orchestrator picks one per question. Fable sits off the ladder on purpose: no benchmark here measures taste.

The user also picks the security seats, and nothing measures them. As of 2026-10-28, they're Mythos 5.1 and Daybreak at xhigh. Mythos does vulnerability and defensive security work, Daybreak takes over after a refusal, and each reviews the other's diffs. Neither has a public score, so the user maps each to a measured model, and the charter states the mapping instead of a table row: Mythos 5.1 is Fable 5.1 without its cyber classifiers, and Daybreak is the current Sol, Sol 6.1, without its classifiers. These are the only gaps ever filled from another model.

## 6. Start here for

Give each row the task classes that start there. The lowest row takes file location and prescribed tool calls. Settled specs and bounded changes take the next rows up. Substantial implementation, design, UI, copy and non-coding work start at the lowest rung of the taste-10 model. Hard debugging and correctness calls take the top row. Show the user every row that changes and why, and ask before you change a taste or security row.

## 7. Rewrite the charter

Generate the table with a script from the extracted numbers, never by hand, so the rounding and the steps agree. Then edit `## Models` in `plugins/flow/charter/charter.md`:

- **The table**: columns `Rung | Score | Min | $/task | Step up buys | Start here for`, padded so the raw file reads aligned. No outer pipes, text left-aligned, numbers right-aligned (`---: |`), and no trailing spaces. A bare row names each family and its role, like `Claude, does the work` and `OpenAI, reviews`. The work ladder comes first, then the extras, the reviewer, the hard reviewer and the mentors. Score and minutes are whole numbers, and $/task has two decimals. Step up buys is the row's score, minutes and dollars minus the row above's displayed values, like `+8 pts +2m +$1.34`, and it stays blank on a family's first row, the extras and the mentors.
- **The sentence above the table**: the as-of date, the price basis, both evals with their versions and harness, the ranking rule in one clause, and every disagreement the cross-check found.
- **The lines below it**: what stays off and why (max effort, each override), the review column rule, the taste scores, and the classifiers that can refuse.

Check every "ties", "beats" and "faster" against the new numbers. Then search `plugins/flow` for each model you removed or added: `scripts/flow-cron.mjs` names the scheduled jobs' default model, `skills/delegate/SKILL.md` and `delegate/server.mjs` show example ids, and `agents/bridge.md` fixes the transport model, which changes only when the user asks.

## 8. Verify and report

Run `node plugins/flow/scripts/smoke-charter.mjs`. It fails when the charter passes 9,500 characters, and a longer table is the usual cause. A rankings change needs no version bump. Report the old and new tables side by side, each row that changed and why, each override, each cross-check disagreement, and each source you couldn't verify or candidate you left unmeasured.
