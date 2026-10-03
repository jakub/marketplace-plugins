---
name: rank-models
description: Re-rank the models in the charter's Models section, the ladder and the starting rungs, from independent benchmark data, through one fixed procedure. Use when a new model ships, when the human asks to re-rank, re-score or retarget models, or when the rankings' as-of date is more than a quarter old.
---

# Rank models

The charter's `## Models` section comes from this procedure and nothing else, so two runs on the same data produce the same ladder. Follow the steps in order. The numbers live only in the charter.

## 1. List the candidates

List every model each family can run, new releases included, and find each model's release page on Artificial Analysis (`artificialanalysis.ai/models/<release>`). Ask the human for what no benchmark publishes: which models their plans run and on which host, a taste rating from 0 to 10 for each new model (show its rank and 95% interval on arena.ai's Code Arena WebDev board and on Design Arena first; the rating stays the human's), and any plan quota that makes a model expensive in practice.

A model with no public score or price is unmeasured and stays off the ladder. It keeps a starting-rung row only when the human keeps it for a need the benchmarks do not measure, such as having no refusal classifiers.

## 2. Check the sources

- Terminal-Bench, from the Artificial Analysis Intelligence Index: `terminalbench-4-0` as of 2026-09-27, hard agentic terminal tasks on one harness, pass@1, with a cost per task from the same run.
- FrontierCode, Cognition's mergeability benchmark, at `cognition.com/data/frontiercode-leaderboard/data.json`: version `v1_1` as of 2026-09-27, the main subset, private tasks run in each vendor's own agent, with a cost per task.
- AutomationBench (`automationbench-aa` in the same index), which picks each family's tool-call rung.

Record each evaluation's version, task count, harness and repeats from its evaluation page, and from the data file's `subsets` field and the changelog on `cognition.com/frontiercode`. Use the newest version of each and say which. Terminal-Bench runs a harness neither host uses; FrontierCode is private, partly graded by an undisclosed model, and published by a company that sells a competing model. The ladder uses both and trusts neither alone.

The tie band is 49 × √(1/n₁ + 1/n₂) points, rounded, for the two coding evaluations' task counts: 8 points for 66 and 100 tasks. It is a policy tolerance for calling two rungs a tie, never proof that two rungs differ.

A rung needs a positive score and a positive, finite cost on both coding evaluations. Never fill a gap from another source, a vendor's card or an older evaluation version. Sonnet is the standing exception while the index has not run it: its FrontierCode row and Anthropic's own Terminal-Bench scaled per effort by Opus's index-to-card ratios, marked as such in the charter. As of 2026-09-27 Sonar's leaderboard, SWE-rebench, Vals.ai, Epoch AI, METR, Scale's SWE-Bench Pro and Martian's Code Review Bench were checked and left out, because none covers every candidate at every effort with a cost per task from the same run. Check them again.

## 3. Extract the numbers

No extractor ships with this skill. Write a throwaway Node script in a temporary directory, outside the repository. Artificial Analysis has no public API: each variant page embeds one `currentModel` object in its React Server Components payload, sent as `self.__next_f.push([1,"…"])` chunks. Decode each chunk as a JSON string literal and concatenate them before searching. The release page lists the effort variants. Join FrontierCode on the release name and the effort label. For every rung, record the Terminal-Bench score and cost per task, the FrontierCode score and cost per task, and the AutomationBench score, and show the human the raw table before you apply any rule.

## 4. Build the ladder

1. A measured rung's pass rate is the mean of its two scores. Its cost is the geometric mean of its two costs per task, and its cost per solve is cost over pass rate.
2. A rung leaves its family's ladder when another rung in the family passes at least as often for less per solve.
3. Ties collapse from the top down. The strongest rung left opens a group, every rung within the band below it joins, and the group's cheapest rung stays. Repeat with the rungs left.
4. The tool-call rung is the family's lowest cost per solve on AutomationBench, on the ladder or not.
5. Each ladder rung but the top gets a try-first threshold: its cost over the next rung's cost. Trying A before B costs c_A + (1 − p_A) × c_B, which beats c_B only when p_A > c_A ÷ c_B, assuming a failed attempt is detectable and B solves whatever A solves.
6. A model with no rung left leaves the rankings, and each starting-rung row that named it moves to the rung that replaced it. A model the human rates highest for taste keeps its taste rows.

Ask the human about each rung a current row names that rules 2 and 3 removed. A rung the human keeps rejoins the ladder as a hard-rows rung and gets a threshold like the others. As of 2026-09-27 the human keeps Astra xhigh, Opus high and Opus xhigh for the hardest rows.

## 5. Choose starting rungs

For each task class, estimate how often it passes compared with the evaluations; settled, well-specified work passes more often. Start at the lowest rung whose threshold you expect the task to clear, and start file location and prescribed tool calls at the tool-call rung. Show the human every row that changes and why, and ask before changing a taste or security row.

## 6. Rewrite the charter

Edit `## Models` in `plugins/flow/charter/charter.md`:

- The table's columns are `Rung | Pass | $/solve | Threshold`, padded so the raw file reads aligned: no outer pipes, the rung left-aligned, the numbers right-aligned (`---: |`) and no trailing spaces. A bare family row, `OpenAI` or `Claude` with no pipes, comes before each ladder. A rung is its model and effort, such as `Opus medium`, plus `, tools` for the tool-call rung and `, hard rows` for a kept rung. Pass is a whole percent, $/solve has two decimals, and the top rung's threshold is `—`.
- The sentence above the table carries the as-of date, both evaluations with their versions, the tie band, and the Sonnet note while it applies.
- One line each for the off-ladder models with their reasons, the taste ratings, and the classifiers that can refuse.
- The starting-rung list: one line per task class, `task: OpenAI rung / Claude rung`.

Check every "ties", "beats" and "costs less" against the new numbers. Then search `plugins/flow` for each model you removed or added: `scripts/flow-cron.mjs` names the scheduled jobs' default model, `skills/delegate/SKILL.md` shows example calls, and `agents/bridge.md` fixes the transport model, which changes only when the human asks.

## 7. Verify and report

Run `node plugins/flow/scripts/smoke-charter.mjs`. It fails when the charter passes 9,500 characters, and a longer ladder is the usual cause. A rankings change needs no version bump. Report the old and new ladders side by side, each starting-rung row that changed and why, and each source you could not verify or candidate you left unmeasured.
