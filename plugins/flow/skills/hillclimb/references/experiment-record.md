# Experiment record

The orchestrator owns one run directory outside candidate worktrees. Its absolute path
is recorded in the conversation or calling workflow. Use an ignored directory under the
canonical checkout, such as `.flow/hillclimb/<run-id>/`, after checking local conventions.
Keep it out of source commits by default. Logs needed for delivery follow the calling
workflow's evidence rules.

The record has this layout:

```text
<run-id>/
  experiment.md
  attempts.jsonl
  attempts/<attempt-id>/
    worker.md
    <raw command output and measurements>
  final.md
```

`experiment.md` records:

- The repository, run ID, question, and relevant findings from `how` with evidence pointers.
- The original baseline SHA, current accepted SHA, and local accepted branch.
- The workload and data identity, environment, build settings, and cache treatment.
- The metric, unit, direction, target or exploration minimum, and secondary constraints.
- The exact measurement and correctness commands, sampling and comparison procedure,
  sensitivity evidence, baseline values, and minimum meaningful improvement.
- The allowed worker checks and resource isolation, including which work must be sequential.
- The agreed delivery scope and the human's setup agreement and start instruction.
- The measurement revision and any later agreed amendments, with reasons and evidence.

`attempts.jsonl` is an append-only sequence of JSON objects, one per attempt event. Serialize
objects as JSON rather than constructing lines by shell interpolation. The format preserves
tabs and newlines inside strings. Every event has these fields:

| Field | Value |
|---|---|
| `attempt_id` | Stable ID within the run. |
| `batch_id` | Batch whose common baseline the candidate uses. |
| `event` | `started`, `candidate`, `decision`, or `integration`. Later events can supersede earlier decisions without deleting them. |
| `base_sha` | Full Git commit for this attempt's comparison. |
| `candidate_sha` | Full candidate commit, or `null` before one exists. An integration event names the combined commit. |
| `retained_branch` | Local branch retaining that candidate, or `null` before one exists. |
| `measurement_revision` | Revision from `experiment.md`. |
| `hypothesis` | Mechanism and expected effect. Integration events also name their constituent attempts. |
| `worker` | Model, effort, host or delegation route, job ID when available, and worktree. |
| `processes` | Owned process or scope identities and evidence of completion. `unknown` when not established. |
| `measurements` | Baseline and candidate values with units and evidence paths, or `null` before measurement. |
| `checks` | Commands, observed outcomes, and evidence paths. An unrun check is explicitly unrun. |
| `decision` | `accepted`, `rejected`, `inconclusive`, `awaiting-human`, or `null` while pending. |
| `reason` | Why this event or decision occurred, including partial work and failures. |
| `evidence` | Paths relative to the run directory or durable links. |

The separate `worker.md` contains the worker's claim: attempt ID, base, candidate SHA when
it could commit, changed paths, commands and outcomes, evidence paths, remaining processes,
and completion state. Workers write only within their assigned worktrees. The orchestrator
copies their reports and outputs into the canonical run directory before retiring worktrees.
Worker reports are inputs to verification, not authoritative measurements or decisions.

Attempt branches use ordinary local branches, for example
`chore/hillclimb-<run-id>-<attempt-id>`. The accepted branch is separate. Retain refs for all
candidates and integration results cited by the record, including failed combinations.
Keep partial snapshots clearly labeled and off the accepted branch. No release tags are used.

Before resuming, reconcile the record with actual refs, worktrees, processes, and evidence
files. Establish which candidates are preserved and which decisions remain pending. Resolve
unknown activity before measurement. Resume under the existing agreement unless a material
change requires an interactive checkpoint.

`final.md` records the final comparison, stopping reason, accepted and rejected attempts,
inconclusive and pending work, correctness checks, review coverage, and retained paths and
branches. Its status distinguishes target achieved, exploration completed, stopped short,
and blocked. An unavailable review remains an explicit limitation.
