# flow host profile: Codex

Injected beside the charter. Each section binds one of its `[[role:…]]` names to this
host's mechanism; the charter says what a role is for, this file says what it is here.

## Bindings

### role: orchestrator-model

The session model the human launched conducts. The model table governs every other seat.

### role: sub-seat

Native subagents, with model and effort named per spawn. Read-only seats spawn freely;
a substantial write seat runs contained - same-family in a native seat carrying the
seat contract in its spawn prompt, cross-family through `delegate_to_claude` with
workspace-write. The ~20-parallel cap and the worktree rule apply as written.

### role: context-inheritance

Native spawns can inherit your turns - the fork_turns knob - and the platform's
defaults lean toward inheriting, so treat inheritance as ON unless you explicitly
set it off. That makes turn inheritance this host's context-inheriting spawn: choose
the boundary deliberately per seat, and never hand an inheriting seat a session
holding material it shouldn't see. Carry the charter's non-negotiables in the spawn
prompt for every seat regardless - a cold seat needs them, and an inheriting seat
must not depend on having seen them scroll by.

### role: search-seat

A native read-only subagent on `gpt-5.6-luna`, medium effort. Escalate the model when
the search itself needs judgment.

### role: pipeline-entry

No slash commands - this host ignores a plugin's commands directory. All three stages run
here: the human names the plugin's `prep-stage`, `issue-stage` or `land-stage` skill, or
asks for that stage in words. A discovered defect, adjacent discussion, or a PR that merely
looks ready is never an invocation. Do not slide into implementing inline after the
triviality gate declined it - a stage without its body skips the claim rules and the
containment that make it safe.

### role: artifact-publish

The plans CLI directly (`plans publish`, `--keep` for PR evidence); there is no skill
wrapper on this host. Artifacts stay tailnet-private.

### role: gripe-cli

Unavailable. The `gripe` CLI does not resolve in a Codex session until the dual
resolver lands (issue #6, slice 5). Skip filing - do not fake a gripe, do not invent
another store, and do not claim one was filed.
