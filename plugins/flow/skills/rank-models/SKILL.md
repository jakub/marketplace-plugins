---
name: rank-models
description: Re-rank the charter's Models section (the 3-lab roster, subagent pool, mentors and starting rows) from benchmark data, with one fixed procedure. Use when a new model ships, when the user asks to re-rank or retarget models, or when the as-of date is more than a quarter old.
---

# Rank models

The charter's `## Models` section comes from this procedure and nothing else, so two runs on the same data give the same table. Do the steps in order. The numbers live only in the charter.

The user wants strong output first, fast turnaround on long chains, and cost visibility so one session doesn't burn a daily subscription quota. Code quality alone misses tool discipline, hallucination rates and writing judgment, so the table tracks four 100%-coverage axes per rung alongside minutes and dollars per task.

As of 2026-11-20, three labs form the roster: Anthropic orchestrates and writes (`Opus` default, `Fable` non-default, `Sonnet` subagent pool), OpenAI reviews (`Sol`, `Astra`, `Terra` subagent pool), and Google (`Gemini 4 Neon`) is the default third POV. Fireworks open-weights stay off unless the user asks to add them. Each lab can supply a mentor, which advises and never writes.

## 1. Candidates

List every model each included lab can run, new releases included, and find each one's release page on Artificial Analysis (`artificialanalysis.ai/models/<release>`). Separate candidates into the **primary roster** (`Opus`, `Fable`, `Sol`, `Astra`, `Neon`) and the **subagent pool** (`Sonnet`, `Terra`), which the orchestrator spawns cheaply in parallel. `Haiku`, `max` and `ultra` stay off by the user's choice. On 2026-11-20 `Astra max` scored lower than `Astra xhigh` at nearly twice the time and cost, and `Fable high` tied `Fable xhigh` at half the time and cost. A model's highest effort (`max` for Claude/OpenAI, `xhigh` for Gemini 4) lives on the bare release slug, not a `-max` or `-xhigh` slug.

Ask the user for what no benchmark publishes:

- which labs hold the default write, review and third-POV roles, and which models belong in the primary roster vs. the subagent pool;
- which models their plans run, on which host, and any plan quota that makes one model abundant or scarce (as of 2026-11-20, `Opus 5.5` is plan-abundant on the $200 sub, so it stays default over `Fable 5.2` even where `Fable` beats it on AA);
- a taste score from 0 to 10 for each new model, split by domain if relevant. Show its rank on arena.ai's Code Arena WebDev board and Design Arena first. The score stays theirs (as of 2026-11-20: `Fable 5.2` 10, `Opus 5.5` 9 general, `Neon 4` 9 writing and trial elsewhere; OpenAI weaker aside from occasional `Astra` UI design).

A model with no public score, price or time is unmeasured and stays off the table. It keeps a mapping line only when the user keeps it for something benchmarks don't measure, like having no cyber classifiers.

## 2. Sources

- **Artificial Analysis** (`artificialanalysis.ai/models/<slug>`), four 100%-coverage evals as of 2026-11-20:
  - **Code:** `mean(Terminal-Bench 4.0, FrontierCode 2.0)` (`terminalBench40`, `frontierCode20`), mini-swe-agent (66 tasks) and stirrup (132 tasks), three repeats each.
  - **AutoB:** `AutomationBench` (`automationBenchPartialScore`, 657 multi-step tool tasks) for agent/tool discipline.
  - **Halluc:** `Omniscience` hallucination rate (`omniscienceHallucinationRate`, lower is better) for groundedness in scouting and review.
  - **Brief:** `AA-Briefcase v1.1` Elo (`briefcaseBreakdown.overall.elo`) for prose, specs and non-coding judgment.
- **Slopalytics** (`slopalytics.com`), which mirrors AA's per-model code token count (`code.tokens`), output speed (`speed`) and arithmetic mean code cost (`code.cost`). Note its `Code only` score weights FrontierCode ~60% and Terminal-Bench ~40%, so it reads 1 to 2 points below the charter's 50/50 mean. Never use its `Code only` score directly; use AA's `terminalBench40` and `frontierCode20`.
- **FrontierCode v1.1**, Cognition's vendor-harness run at `cognition.com/data/frontiercode-leaderboard/data.json` (`v1_1.data.<model>.<effort>.main`: `new_score`, `cost`, `duration_min`). It cross-checks real latency and never sets a rung. Flag models missing from Cognition (`GPT-6.2`, `Fable 5.2` and `Gemini 4 Neon` were absent on 2026-11-20) and any step whose direction disagrees: `Sol 6.1` took 5 to 8 minutes on AA and 14 to 17 in Codex.

Record each eval's version and task count, using the newest version of each. A rung needs positive `Code`, `Min` and `$/task` plus all three secondary AA metrics. Never fill a gap from another source, a vendor card or an older eval version.

## 3. Extract the numbers

No extractor ships with this skill. Write a throwaway Node script in a temp directory outside the repo.

On Artificial Analysis (as of 2026-11-20), each variant page embeds its own model JSON object inside `self.__next_f.push([1,"…"])` chunks. Decode each chunk as a JSON string literal, concatenate them, and find the balanced JSON object containing `"slug":"<slug>"`, `"terminalBench40"` and `"intelligenceIndexCostPerTask"`. Read:

- `terminalBench40 * 100` and `frontierCode20 * 100` for `Code`;
- `automationBenchPartialScore * 100` for `AutoB`;
- `omniscienceHallucinationRate * 100` for `Halluc`;
- `briefcaseBreakdown.overall.elo` for `Brief`;
- `intelligenceIndexCostPerTask.evaluations`: multiply `weightedCostPerTask` by 8 (the Intelligence Index equal-eighth weight) for `terminalbench-4-0` and `frontiercode-2-0` to get exact per-eval task cost. Verify `(tb4Cost + fc2Cost) / 2` matches Slopalytics' `code.cost` to the cent; never use raw `weightedCostPerTask` without the ×8 unweighting.
- `Min`: AA no longer embeds separate per-eval `timePerTask` in RSC. Compute `code.tokens / speed / 60` from Slopalytics (the same output-tokens-over-speed formula AA's own chart bundle uses). Sanity check on 2026-11-20: `Opus 5.5 medium` reads TB4 `52.5`, FC2 `33.1`, Code `42.8`, geom. `$2.58` (arith. `$2.64`), `7.7` min, AutoB `61%`, Halluc `67%`, Brief `1617`.

Show the user the raw table and Pareto chart (via `plans:show`) before applying overrides.

## 4. Build the per-lab Pareto roster

1. `Code` is the arithmetic mean of TB4 and FC2. `$/task` is the geometric mean of TB4 and FC2 task cost. `Min` is `code.tokens / speed / 60`.
2. **Two tie bands**, both policy tolerances: scores within 4 points tie, and times within 1.5× tie.
3. Run Pareto elimination **inside each lab** so one lab never crowds out cross-lab diversity: a rung leaves if another rung in its lab scores at least as high and is either more than 1.5× faster, or within 1.5× and no more expensive.
4. Group top-down within each lab (4-point band; among rungs within 1.5× of the group's fastest time, the cheapest wins). Also check the **time-first frontier** (fastest wins in the tie band) to identify chain-throughput picks such as `Fable 5.2 low`, `Sol 6.2 med` and `Astra 6.2 med`.
5. Keep 1 representative row per subagent-pool model (`Sonnet`, `Terra`) and 2 to 3 anchor rungs per primary model so the charter stays compact while the effort dial handles intermediate steps.

Ask the user about each change to a current row, any plan-quota override (such as keeping `Opus 5.5 med` as default over `Fable 5.2 low`), and any taste or secondary-axis override.

## 5. Roles, mentors and security seats

Confirm with the user:

- **Default write, review and 3rd-POV anchors:** as of 2026-11-20, `Opus 5.5 med/xhigh` writes (`Fable 5.2 low/high` for chain speed or taste-10 step-ups), `Sol 6.2 xhigh` and `Astra 6.2 xhigh` review (`Astra 6.2 med` and `Sol 6.2 med` for chain speed and split lanes), and `Neon 4 med/high/xhigh` handles wide scouting, writing/visual QA, and 3rd-POV parallel review in rounds 1 to 3.
- **Subagent pool:** `Sonnet 5.5 high` (tight-oracle parallel writes) and `Terra 6.1 med` (low-noise parallel narrow checks).
- **Mentors:** one per lab (`Fable 5.2 high`, `Astra 6.2 xhigh`, `Neon 4 xhigh`), advising only.
- **Security seats:** unmeasured classifier-free models stay off the table and live in one mapping line. As of 2026-11-20, `Mythos 5.2` equals `Fable 5.2` and `Daybreak Blue` equals `Sol 6.2` without cyber classifiers, both at `xhigh`, reviewing each other. These are the only gaps ever filled from another model.

## 6. Start here for

Give each row the task class that starts there, keeping descriptions short so the table fits the charter cap. Subagent rows start with `subagent:`. Primary rows distinguish default work, chain-throughput picks, taste/writing strengths, and hard review or mentor roles. Show every changed row and ask before changing a taste, quota or security call.

## 7. Rewrite the charter

Generate the table with a script from the extracted numbers, never by hand, so rounding agrees. Then edit `## Models` in `plugins/flow/charter/charter.md`:

- **The table**: columns `Rung | Code | Min | $/task | AutoB | Halluc | Brief | Start here for`, padded so raw markdown aligns, no outer pipes, text left-aligned, numbers right-aligned (`---: |`), and no trailing spaces. Order Anthropic, then OpenAI, then Google. Whole numbers for `Code`, `Min`, `AutoB`, `Halluc` and `Brief`; two decimals for `$/task`.
- **The sentence above the table**: as-of date, the four AA axes and cost/time basis, and Cognition cross-check caveats.
- **The paragraphs below it**: model-vs-effort triage and mid-flight movement rules, defaults/subagent-pool/chain-throughput guidance, taste scores and security mappings, cross-family and 3rd-POV review rules, and refusal handling.

Check every claim against the new numbers, and search `plugins/flow` for any stale model IDs or examples.

## 8. Verify and report

Run `node plugins/flow/scripts/smoke-charter.mjs` (and `node scripts/smoke-all.mjs` before pushing). `smoke-charter.mjs` fails over 9,500 characters. A rankings change needs no version bump. Report the old and new tables, each row change and override, cross-check caveats, and any unverified source.
