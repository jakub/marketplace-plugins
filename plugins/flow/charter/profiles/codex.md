# flow host profile: Codex

Injected beside the charter. Each section binds one of its `[[role:…]]` names to this
host's mechanism; the charter says what a role is for, this file says what it is here.

### role: orchestrator-model
The session model the human launched conducts. The model table governs every other seat.

### role: sub-seat
Native subagents, with model and effort named per spawn. Read-only seats spawn freely;
a substantial write seat runs contained - same-family in a native seat carrying the
seat contract in its spawn prompt, cross-family through `delegate_to_claude` with
workspace-write. The ~20-parallel cap and the worktree rule apply as written.

### role: context-inheritance
No spawn copies your context on this host. Every seat starts cold, so carry the
charter's non-negotiables in the spawn prompt, every time.

### role: search-seat
A native read-only subagent on `gpt-5.6-luna`, medium effort. Escalate the model when
the search itself needs judgment.

### role: pipeline-entry
No slash commands - this host ignores a plugin's commands directory. The human asks
for a stage in words, or names the plugin's skill; a stage never starts itself, and a
PR that merely looks ready is not an invocation.

### role: artifact-publish
The plans CLI directly (`plans publish`, `--keep` for PR evidence); there is no skill
wrapper on this host. Artifacts stay tailnet-private.

### role: gripe-cli
Unavailable. The `gripe` CLI does not resolve in a Codex session until the dual
resolver lands (issue #6, slice 5). Skip filing - do not fake a gripe, do not invent
another store, and do not claim one was filed.
