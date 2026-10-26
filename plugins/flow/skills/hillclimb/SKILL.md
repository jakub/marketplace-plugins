---
name: hillclimb
description: Make a measurable thing better (faster, smaller, cheaper) with an agreed benchmark, then an autonomous loop of parallel attempts and one-at-a-time measurements. Use when the user says "hillclimb" or asks you to optimize a metric. Delivers a reviewed local branch.
---

# Hillclimb

You own the experiment and its evidence. The charter still governs models, containment, review and git. This starts no pipeline stage. If a workflow called you, return the results to it.

Setup is a conversation. The loop isn't. Don't start the loop until the user says go.

## Agree on the experiment

Read the code and run the baseline tests yourself. Then settle the open decisions with the user one question at a time, each with a suggested answer. Don't re-ask what's already answered.

**Get a workload that shows the problem.** Pick a representative workload before you pick a metric. For a reported symptom, reproduce it first. Check what can change the result: data size, history, cache state, concurrency. If the workload doesn't show the symptom, fix the workload.

**Build a measurement you trust.** Reuse a suitable benchmark or write the smallest repeatable command. Check that it moves on contrasting realistic cases, and sample enough to tell a change from noise. Make it report its error count and how much work it did, so a run that errored or did less work can't look like a win. Record a baseline and passing correctness checks before you optimize anything.

**Agree on:** the workload, the metric and unit, which direction is better, the target, the correctness checks, secondary constraints such as memory, how to compare, the smallest improvement that counts, and which builds and tests workers may run in parallel. Plus a stopping rule: a target, which stops once it passes final confirmation, or a minimum number of distinct hypotheses to try before judging whether more is worth it. Don't make up a time, token or attempt limit.

**Keep a run record** outside every worker's write scope: the agreement, the baseline, and for each attempt its hypothesis, base and candidate commits, outcome and evidence paths.

Show the user the concrete setup, then wait for an explicit start like "run it". Silence isn't a yes. A calling workflow can supply an approved experiment and its start.

## Run a batch

1. Pick independent hypotheses from the code and the attempt log. Name the mechanism each one should improve. Start every candidate in a batch from the same accepted commit.
2. Give each worker its own worktree, attempt ID, scope and allowed checks, with separate build outputs, test data and ports. Workers never run the reserved benchmark.
3. Keep every candidate on a local attempt branch before you discard or integrate it, rejected and partial ones too. A SHA in a log doesn't keep a commit alive.
4. Wait for the whole batch, then make sure every worker's builds, tests and services have actually stopped. A completion message, an error or a timeout doesn't prove the machine is idle. Sort out unknown process state before you measure, and only stop processes you own.

## Measure and decide

Measure one candidate at a time on an idle machine, with the frozen method, data, build settings and cache treatment. Build each candidate before you time it, and recheck the baseline as agreed, so machine drift can't look like a win. Each candidate gets one outcome:

- **Accepted**: it beats noise, passes correctness, holds the constraints, and is worth the complexity it adds. A change that removes complexity and holds the metric within noise counts too.
- **Rejected**: a valid measurement or check disproves it, or it breaks a constraint.
- **Inconclusive**: instrumentation failed, noise won, or it didn't finish. Never use one as the next baseline.

Bring a real architectural tradeoff to the user with its evidence, and keep working on independent ideas while you wait. Integrate accepted candidates one logical change per commit, then measure the combination, because things that help separately can interfere. A broken benchmark means a new agreement and a new baseline, never a comparison across methods.

## Stop, review and return

A plateau isn't the top. When batches keep coming back rejected, change approach before you call it: a different kind of change, a combination of near-misses, a reread of the code on the measured path, or something radical. Don't stop while cheap untried ideas remain.

Stop at a confirmed target, or after the exploration minimum when what's left isn't worth it. If you missed the goal, say so. Compare the final branch with the original baseline, and run the charter's cross-family review on the final diff and on the evidence for the improvement.

Report the metric with units, the baseline and final values, each attempt's outcome, the correctness and review results, the evidence paths, and why you stopped. Keep the accepted branch, the attempt branches and the logs. Deliver a reviewed local branch unless the user authorized a push or a PR. Never merge.
