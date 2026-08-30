# PR #7 live-capture evidence

Codex-host live tests of the cross-harness land stage, run 2026-08-29 against
flow 0.25.0 at 7bd7e88 (branch-pinned marketplace install,
`codex plugin marketplace add …@feat/issue-6-land-cross-harness`), codex-cli 0.151.0.

- `capture-implicit-invocation.txt` - AC: explicit-invocation-only. A plain Codex
  conversation asking how to merge an approved PR. The land-stage skill never fires;
  the model reads the installed stage docs, answers in conditional mood, and refuses
  to act without a named PR. Bonus: the skill catalog surfaces only `flow:flow` -
  land-stage is absent from automatic selection entirely.
- `capture-explicit-probe.txt` - the skill catalog as the model sees it, plus
  `delegation_doctor` surfacing the dated host-capability inventory live on a Codex host.
- `capture-guard-managed.txt` - in a repo with a committed `.flow/managed`:
  `gh pr merge` denied (denial names the executor), `npm publish` denied (registry,
  fail-closed), the release-sanction helper denied (self-approval). All three via the
  real PreToolUse hook wiring.
- `capture-guard-unmanaged.txt` - control: in an unenrolled repo the same merge
  command is not flow-denied (it runs and hits the sandbox's network wall).

The two sanctioned-merge captures (full Codex land run, full Claude land run) are the
deferred criteria and land here as `pr-7/land-run-*.txt` from the joint session.
