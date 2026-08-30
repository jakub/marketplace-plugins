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
  `gh pr merge` denied and routed to the executor, `npm publish` denied (registry,
  fail-closed). Both via the real PreToolUse hook wiring, at 3f32cfc (post
  sanction-retirement wording).
- `capture-guard-unmanaged.txt` - control: in an unenrolled repo the same merge
  command is not flow-denied (it runs and hits the sandbox's network wall).

- `land-run-codex.txt` - the full Codex land of flow-land-scratch#1 at flow 0.26.0:
  every gate reported, the executor merged --match-head-commit-pinned head 9030c4a as
  e9835a1, independent MERGED confirmation, remote+local branch cleanup, and a survey
  that correctly flagged the sibling PR as newly conflicting.
- `land-run-claude.txt` - the full Claude `/flow:land 2` via the installed alias:
  gates, pinned squash-merge verified as 7b9d43b, cleanup, plus two honest catches by
  the stage itself (a CI context green that was a rate-limit skip, and the ask tool
  being absent in -p mode - griped, not worked around).

Both land runs post-date the sanction retirement (3f32cfc): no human-terminal
approval step exists, the authorization is the explicit request to land.
