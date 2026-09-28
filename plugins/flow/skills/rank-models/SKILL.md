---
name: rank-models
description: Re-rank the models in the charter's Model Rankings and Model Selection sections from independent benchmark data, through one fixed procedure. Use when a new model ships, when the human asks to re-rank, re-score or retarget models, or when the rankings' as-of date is more than a quarter old.
---

# Rank models

The charter's rankings come from this procedure and nothing else, so two runs on the same data produce the same ladder. Follow the steps in order. The numbers live only in the charter. This skill holds the method, and `scripts/ladder.mjs` in this skill's directory does the arithmetic.

## 1. List the candidates

List every model that each family can run, including new releases. Find each model's release slug on Artificial Analysis. The release page, `artificialanalysis.ai/models/<release>`, is the model's max variant, or its only variant. The script reads the other efforts from that page, so pass it the release slug alone.

Ask the human for the facts that no benchmark publishes:

- which models their plans can run, and on which host
- a taste rating from 0 to 10 for each new model, or `?` if they have not rated it
- any plan quota that makes a model expensive in practice

When you ask for taste ratings, show each candidate's rank and 95% interval on arena.ai's Code Arena WebDev board (`arena.ai/leaderboard/code`) and on Design Arena (`designarena.ai/leaderboard`). Both rank models by human votes on front-end builds. They inform the rating, and the rating stays the human's.

A model with no public page or no public price is unmeasured. It stays off the ladder. It keeps a Model Selection row only when the human keeps it there for a need the benchmarks do not measure, such as a model with no refusal classifiers.

## 2. Check the sources before you trust them

The ladder reads two coding evaluations and one tool-use evaluation:

- Terminal-Bench, from the Artificial Analysis Intelligence Index. It is `terminalbench-4-0` as of 2026-09-27: hard agentic terminal tasks on one harness, pass@1, with the cost per task from the same run.
- FrontierCode, Cognition's mergeability benchmark, at `cognition.com/data/frontiercode-leaderboard/data.json`. It is version `v1_1` as of 2026-09-27: private tasks graded on whether the maintainer would merge the patch, run in each vendor's own agent, with a cost per task. The script reads its main subset.
- AutomationBench, `automationbench-aa` in the same index, which scores agentic workflow tasks from 0 to 1 and picks the tool-call rung.

Before you run the script, record each evaluation's version, task count, harness and number of repeats. For Terminal-Bench and AutomationBench, read the evaluation page at `artificialanalysis.ai/evaluations/<eval>`. For FrontierCode, read the `subsets` field in the data file and the changelog on `cognition.com/frontiercode`. If a newer Terminal-Bench replaced the current one, pass its slug with `--coding`. If a newer FrontierCode version appears, the script uses the newest key and prints which one; pin an older one with `--fc-version`.

Each source has a known weakness, so the ladder uses both and trusts neither alone. Terminal-Bench runs a harness that neither host uses, on terminal tasks rather than repository patches. FrontierCode runs the hosts' own agents, but Cognition sells a competing model, the tasks are private, and an undisclosed model grades part of the score.

Compute the tie band from the two coding evaluations' task counts, n₁ and n₂: band ≈ 49 × √(1/n₁ + 1/n₂) points, rounded. For 66 and 100 tasks the band is 8 points. The band is the worst-case 95% half-width of one rung's mean score. Use it as a policy tolerance for calling two rungs a tie, never as proof that two rungs differ: a real difference between two models needs their paired per-task outcomes, which neither source publishes.

A rung without a positive score and a positive cost on both coding evaluations is unmeasured. Never fill a gap from another source, from a vendor's model card or from an older version of an evaluation.

As of 2026-09-27, these sources were checked and are not used. Check each again when you run this skill, and add one only if it covers every candidate at every effort with a cost per task from the same run:

- Sonar's LLM code-quality leaderboard: single-shot Java generation with no agent loop, two efforts at most, and no Luna or Fable 5.1.
- SWE-rebench: its task window ended 2026-07-01, and it had one candidate.
- Vals.ai: max effort only, and it substituted older models when a candidate refused.
- Epoch AI's benchmarking hub, METR's time horizons and Scale's SWE-Bench Pro: no current candidates.
- Code review: no independent benchmark ranks models. Martian's Code Review Bench ranks review products, not models.

## 3. Run the script

Name each family once, followed by its releases. Pass the band from step 2:

```sh
node <this skill's directory>/scripts/ladder.mjs --band 8 \
  openai=gpt-6-luna,gpt-6-sol,gpt-6-astra \
  claude=claude-opus-5-5,claude-fable-5-1,claude-sonnet-5-5
```

The script prints three sections:

- the ladder, in the charter's table format
- every rung that left the ladder, with its reason: unmeasured, beaten by a named rung, tied with a named rung, or an error on its page. When the rung that beats it also tied away, the reason names the ladder rung it tied with, and a tool-call rung that left the coding ladder is listed here too
- every rung's full numbers, including each evaluation's score and cost, the Intelligence Index and the list prices

Add `--json` to get the raw rungs instead.

## 4. Apply the rules in order

The script applies rules 1 to 5. Check its output against them, then apply rule 6 yourself.

1. A rung is measured only with a positive score and a positive, finite cost on both coding evaluations. Its pass rate is the mean of the two scores. Its cost is the geometric mean of the two costs per task, which keeps the ratio between two rungs when both costs scale together. Cost per solve is cost divided by pass rate.
2. A measured rung leaves its family's ladder when another rung in the same family passes at least as often for less per solve.
3. Ties collapse from the top down. The strongest rung left opens a group, every rung within the band below it joins that group, and the group's cheapest rung stays on the ladder. Repeat with the rungs left.
4. The tool-call rung is the family's rung with the lowest cost per solve on the tool-use evaluation, on the ladder or not.
5. Each ladder rung except the top gets a try-first threshold: its cost divided by the next rung's. Trying rung A before rung B costs c_A + (1 − p_A) × c_B, and that is less than c_B only when p_A is greater than c_A ÷ c_B. The rule assumes that a failed attempt is detectable and that B solves every task A solves. So a cheaper rung is worth a first attempt only on a task it passes more often than its threshold.
6. A model with no rung left leaves the rankings. Move each Model Selection row that named it to the ladder rung that replaced it, the last rung its reason names. A model that the human rates highest for taste keeps its taste rows, and an unmeasured model keeps the rows the human kept in step 1.

The human may keep a rung that rule 2 or rule 3 removed, most often a higher effort for the hardest rows. Ask about each rung that a current Model Selection row names and the rules removed. Rerun the script with `--keep <slug>[,<slug>…]` for each rung the human keeps. A kept rung rejoins its ladder, marked as kept, and gets a try-first threshold like the others. As of 2026-09-27, the human keeps Astra xhigh, Opus high and Opus xhigh for the hardest rows, on Terminal-Bench's direction alone.

## 5. Choose a starting rung for each task class

Each Model Selection row names a starting rung per family. For each row, estimate how often that kind of task passes compared with the coding evaluations. The evaluations' tasks are hard, so settled, well-specified work passes more often than their pass rates. Start at the lowest rung whose try-first threshold you expect the task to clear. The rows for file location and prescribed tool calls start at the tool-call rung.

Show the human every row that changes, with its reason. Ask before you change a taste row or a security row.

## 6. Rewrite the charter

Edit `plugins/flow/charter/charter.md` in the marketplace repository:

1. Replace the table in `## Model Rankings` with the script's ladder. Shorten each rung to its model and effort, such as "Opus medium", and write "hard rows" for a rung the script marks as kept.
2. Update the as-of date, each evaluation's name, version and task count, and the tie band.
3. Rewrite the off-the-ladder paragraph with one reason per model, taken from the script's second section.
4. Update the taste line and the classifier line.
5. Update the `## Model Selection` table and the paragraph under it.
6. Check each claim in both sections against the new numbers. Every "ties", "beats" and "costs less" must still hold.

Then search `plugins/flow`, outside `dist/`, for each model you removed or added. Model choices live in the charter, so a model named anywhere else is an example, a test fixture or drift. Fix the drift:

- `scripts/flow-cron.mjs` owns the scheduled jobs' model default, and it names the ladder's cheapest Claude coding rung.
- `skills/delegate/SKILL.md` shows example calls. Keep them on models that exist.
- `agents/bridge.md` is the transport seat. Its model is fixed configuration outside the ladder, because a transport seat makes one tool call and its cost is mostly input tokens. Change it only when the human asks.

## 7. Verify and report

The delegation bundle embeds the charter, so rebuild it and run the pre-push checks in the repository's `CLAUDE.md`, under "Versions and publishing". The charter conformance check fails when either half of the charter passes its size budget, and a longer ladder is the usual cause. A rankings change needs no version bump. Bump the version only when the human asks for a release.

Report to the human:

- the old ladder and the new ladder side by side
- each Model Selection row that changed, with its reason
- each source you could not verify, and each candidate you left unmeasured
