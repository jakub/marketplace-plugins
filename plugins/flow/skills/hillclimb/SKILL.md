---
name: hillclimb
description: Improve a measurable behavior through an interactive experiment setup, then an explicitly started autonomous loop of parallel hypotheses and sequential measurements. Preserve attempts and evidence, and deliver a reviewed local branch by default.
---

# Hillclimb

Own the experiment and its evidence. The charter governs orchestration, model selection,
containment, review and git. This skill starts no pipeline stage. When a calling workflow
invokes it, return the results to that workflow.

## Agree on the experiment

Keep setup interactive. Read the code and run the baseline tests yourself, then settle the
open decisions with the human one question at a time, each with a suggested answer. Reuse
answers already given.

Establish a representative workload before choosing the metric. For a reported symptom,
reproduce it first. Check the dimensions that can change the result, such as data size,
history, cache state and concurrency. If the workload misses the symptom, fix the
reproduction first.

Reuse a suitable benchmark or build the smallest repeatable measurement command. Check its
sensitivity with contrasting realistic cases, and sample enough to tell a change from noise.
Record a baseline and passing correctness checks before any optimization.

Agree on the workload, the metric and unit, the direction, the target, the correctness checks,
secondary constraints such as memory, the comparison procedure, the minimum meaningful
improvement, and which builds and tests workers may run at the same time. Agree on a stopping
rule: a target, which stops once it passes final confirmation, or an exploration minimum of
distinct hypotheses before judging whether more work is worthwhile. Do not invent a time,
token or attempt limit.

Keep a run record outside every worker's write scope: the agreement, the baseline, and each
attempt's hypothesis, base and candidate commits, outcome and evidence paths. Present the
concrete setup, then wait for an explicit start such as "run it". Silence is not agreement.
A calling workflow can supply an approved experiment and its start instruction.

## Run a batch

1. Choose independent hypotheses from the code and the attempt log. Name the mechanism each
   change should improve. Start every candidate in the batch from the same accepted commit.
2. Give each worker its own worktree, attempt ID, scope and permitted checks, with isolated
   build outputs, test data and ports. Workers never run the reserved benchmark.
3. Preserve each candidate on a local attempt branch before discarding or integrating it,
   rejected and partial attempts included. A SHA in a log does not retain a commit.
4. Wait for the whole batch to finish, then verify that every worker's builds, tests and
   services have ended. A completion message, an error or a timeout does not prove the
   machine is idle. Resolve unknown process state before any measurement, and stop only
   processes you own.

## Measure and decide

Measure candidates one at a time on the idle machine, with the frozen method, data, build
settings and cache treatment. Build each candidate before timing it, and recheck the baseline
as the comparison procedure says, so machine drift does not read as a win. Record one outcome:

- **Accepted.** The improvement exceeds noise, correctness passes, constraints hold, and the
  added complexity is justified.
- **Rejected.** A valid measurement or check disproves the benefit or breaks a constraint.
- **Inconclusive.** Instrumentation failed, noise dominated or execution did not finish.
  Never use an inconclusive candidate as the next baseline.

Bring a material architectural tradeoff to the human with its evidence, and keep working on
independent ideas while you wait. Integrate accepted candidates one logical change per commit,
then measure and check the combination, because candidates that help separately can
interfere. A defective benchmark is a new agreement and a new baseline, never a comparison
across incompatible methods.

## Stop, review and return

Stop at a confirmed target, or after the exploration minimum when the remaining ideas are not
worth it. If the goal is unmet, say so. Compare the final branch with the original baseline,
and apply the charter's cross-family review to the final diff and to the evidence for the
improvement. Return the metric with units, the baseline and final values, each attempt's
outcome, the correctness and review results, the evidence paths, and the reason for stopping.
Keep the accepted branch, the attempt branches and the logs. Deliver a reviewed local branch
unless the human authorized a push or a PR. This skill never merges.
