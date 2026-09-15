---
name: hillclimb
description: Improve a measurable behavior through an interactive experiment setup, then an explicitly started autonomous loop of parallel hypotheses and sequential measurements. Preserve attempts and evidence, and deliver a reviewed local branch by default.
---

# Hillclimb

Own the experiment and its evidence. Use Flow's charter for orchestration, model
selection, containment, review, and Git policy. This supporting skill does not start
a pipeline stage. When called inside an active workflow, return the results to it.

## Agree on the experiment

Keep setup interactive. Read and apply [how](../how/SKILL.md) to understand the relevant
behavior and workload. Investigate and run baseline tests autonomously, then discuss the
decisions with the human one at a time. Offer a suggested answer to each actual open
question. Reuse answers already supplied.

Establish a representative workload before choosing the metric. For a reported symptom,
reproduce it first. For exploratory improvement, establish which behavior matters to the
human. Check dimensions that can change the result, such as data size, history, cache state,
and concurrency. If the workload misses the symptom, repair the reproduction first.

Reuse a suitable benchmark or build the smallest repeatable measurement command. Check
its sensitivity with contrasting realistic cases. Sample enough to distinguish change
from noise, with a statistic appropriate to the metric. Record a baseline and passing
correctness checks before optimization. Diagnose unreliable checks during setup.

Agree on the workload, metric and unit, direction of improvement, target, correctness
checks, and secondary constraints such as memory use. Establish the measurement method,
repetition and comparison procedure, and minimum meaningful improvement. Decide which
builds and tests workers can run concurrently on the available resources.

Choose a stopping rule:

- **Target.** Stop when the target and constraints pass final confirmation. A confirmed
  result under 10 ms does not require pursuing 5 ms. No minimum attempt count is required.
- **Exploration.** Agree on a minimum number of distinct hypotheses before assessing
  whether further work is worthwhile. Repeated samples, retries, and unfinished attempts
  do not satisfy that minimum. Do not invent a time, token, or attempt maximum.

Create the run record using [the experiment format](references/experiment-record.md).
Summarize the agreement, including delivery scope. Standalone runs finish with a reviewed
local branch and report. Include a push or PR only when authorized during setup or later.
Wait for an explicit instruction to start, such as "run it", after presenting the concrete
setup. Silence is not agreement. An active calling workflow may supply an already approved
experiment and start instruction. Do not ask for those again.

## Run a batch

1. Choose independent hypotheses grounded in `how` and the prior attempt log. Name the
   mechanism each change should improve and the expected effect. Start every candidate
   in this batch from the same recorded accepted commit.
2. Assign each worker its own worktree, attempt ID, scope, and permitted checks. Isolate
   build outputs, test data, ports, and other mutable resources. Keep the benchmark method
   and canonical run record outside workers' write scope. Workers do not run the reserved
   benchmark or coordinate access to it through messages.
3. Let workers implement and run permitted checks in parallel. Collect their candidate
   files, commands, evidence paths, and process state. Read [delegate](../delegate/SKILL.md)
   before a cross-family call. Some delegated workers can edit but cannot commit in a
   linked worktree. The orchestrator then inspects and commits their exact changes.
4. Preserve each candidate on a local attempt branch before discarding or integrating it.
   Record the full base and candidate commits. Preserve rejected attempts too. If a worker
   fails before producing a complete candidate, retain any safe partial work and label it
   partial. Never commit secrets, generated build outputs, or unrelated changes.
5. Wait for the whole batch to finish or be explicitly stopped. Verify that every worker's
   builds, tests, and services have ended. A timeout, error, or completion message alone
   does not establish an idle environment. Resolve unknown process state before measurement.
   Stop only owned processes. Record any remaining unrelated load that affects comparability.

Use the charter's native workers and Flow delegation on each host. The same assignment and
result format works on both. Only the orchestrator starts reserved measurements. No worker
messaging protocol, background watcher, or new scheduler is needed.

## Measure and decide

Run candidate comparisons sequentially once the batch is idle. Use the frozen measurement
method with the same data, build settings, cache treatment, and workload. Build each exact
candidate before timing it, and finish the build before measurement. Recheck the batch
baseline as prescribed by the comparison procedure so machine drift does not become a win.

Inspect each diff, measure it, and run its correctness checks. Record one of these outcomes:

- **Accepted.** Improvement exceeds noise, correctness passes, constraints hold, and the
  maintenance cost is justified within the existing design.
- **Rejected.** A valid measurement or check disproves the benefit, violates a constraint,
  or shows that the added complexity is not justified.
- **Inconclusive.** Failed instrumentation, noise, or incomplete execution prevents a decision.
  Retry or investigate as appropriate. Do not use the candidate as the next baseline.

Bring a material architectural tradeoff back to the human with its candidate and evidence.
Record it as awaiting a decision. Continue independent ideas within the agreement while
waiting, but do not adopt the tradeoff without an answer.

Integrate accepted candidates onto the local accepted branch in a deliberate order, one
logical change per commit. Rerun comparisons and correctness checks on the combined result.
Candidates that help separately can overlap or interfere. Keep a combination only when its
own evidence supports it. Start the next batch from that verified accepted commit.

If the benchmark is defective, record the defect and propose a revised method during an
interactive checkpoint. After agreement, establish a new baseline and remeasure contenders.
Do not compare numbers across incompatible measurement revisions or quietly weaken the goal.

## Stop, review, and return

For a clear target, stop new exploration once final confirmation succeeds. For an exploratory
run, complete the agreed minimum before judging remaining ideas. On a plateau, investigate
another cause or category before giving up. If worthwhile ideas are exhausted or execution
is blocked, report the unmet goal and completed work without claiming success.

Compare the final accepted branch with the original baseline under the agreed measurement
revision. Apply the charter's independent review to the final diff and the evidence behind
the claimed improvement. Fix findings and revalidate affected measurements. If the accepted
head or method changes, update the final comparison and review coverage before claiming done.

Return the achieved metric with units, baseline and final values, target or exploration
status, attempt outcomes, accepted changes, correctness results, review status, and evidence
paths. Name remaining uncertainty and the reason for stopping.

Retain the accepted branch, attempt branches, and logs locally. Retire owned candidate
worktrees only after their code and evidence are preserved. A Git SHA in a log alone does
not retain a commit. Do not delete attempt branches as routine worktree cleanup.

When a calling workflow owns delivery, return the same record to it. Publish evidence only
within its authorized scope, using the charter's durable evidence rules. This skill does
not start `prep`, `issue`, or `land`, and does not merge.
