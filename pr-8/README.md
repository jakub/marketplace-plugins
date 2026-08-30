# PR #8 live-capture evidence (issue #6, slice 2)

Codex host, flow 0.27.0 branch-pinned at 077263c, codex-cli 0.151.0, 2026-08-30.

- `capture-bindings-injected.txt` - the AC capture: a fresh Codex session answers three
  binding questions (search seat, prep availability, spawn context inheritance) citing
  `<flow-profile host="codex">` sections by name as in-context sources - profile-sourced,
  not improvised Claude vocabulary. Run with the hook-trust prompt bypassed for this
  repo's own hooks: the codex.json SessionStart entry changed in this PR
  (additionalContextLimit 5000->6000), so codex holds the hook until its one-time
  interactive re-bless - expected after any hook-entry change.
- `capture-bindings-presence-rule.txt` - the same questions in a session where that
  trust gate had skipped injection: the model detected the missing <flow-charter> and
  <flow-profile> blocks on its own, reported them, distinguished installed-file facts
  from active-session bindings, and refused the pipeline stages - the narrow-refusal
  presence rule executing live, unprompted. Also confirms fork_turns defaults to "all"
  from the platform's own spawn_agent contract text.
