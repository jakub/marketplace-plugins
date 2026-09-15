---
name: how
description: Explain how a subsystem works, where behavior lives, and who owns its state. Use for code walkthroughs, ownership questions, and investigation before a change. Can run focused tests and flag concerns encountered without conducting a deep review.
---

# How

Build a source-grounded explanation of the requested behavior. Use the charter for
delegation and model selection. Size the investigation to the question.

## Trace the behavior

Start with the user's question and the repository's own terminology. Find the entry
point, then follow the relevant execution path, state owners, and external dependencies.
Read the implementation behind wrappers and generated interfaces when it affects the answer.

For a narrow question, investigate directly. For a subsystem with independent areas,
assign bounded investigations and reconcile their findings. A worker assigned this skill
does its own investigation within its seat contract.

Use focused tests, traces, or small experiments to settle material uncertainty. Create
test files and build outputs in an agent-owned worktree or disposable test environment.
Respect a caller's read-only restriction. Keep product changes outside this investigation.
Record the commands and observations, and stop any test services you started.

Follow confusing details far enough to explain their role. Flag obvious concerns and
obstacles encountered, such as stale documentation, misleading names, hidden writes,
or unclear state ownership. Link the evidence and explain the consequence. Do not expand
the search into an exhaustive correctness or security review, or fix unrelated problems.

## Explain what you found

Lead with the answer and a concrete path through the system. Include the relevant parts:

- The behavior, important concepts, and ownership of state.
- The execution path, with source links to the entry point and decisive implementation.
- Non-obvious behavior, concerns encountered, and details that hindered the investigation.
- Tests run and what they demonstrate, followed by remaining uncertainties and coverage limits.

Distinguish source observations, tested behavior, and inference. A function call in the
source establishes a possible path, not its frequency or cost under the user's workload.
Do not infer performance from code inspection or call an unexecuted check passing.

Answer in the conversation by default. Write standalone documentation when requested.
When another workflow calls `how`, return the findings and evidence pointers it needs
to retain in its own record. No separate report file is required.
