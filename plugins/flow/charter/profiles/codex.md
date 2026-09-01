# flow host profile: Codex

Injected beside the charter. Each section binds one of its `[[role:…]]` names to this
host's mechanism; the charter says what a role is for, this file says what it is here.

## Bindings

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

### role: human-choice

The suspended turn. There is no in-turn question tool, and a PreToolUse hook cannot ask:
a hook's `ask` result reads as a failure and the command runs anyway. So write the
question, list up to 4 numbered options with a one-line consequence each and the
recommended one first, then end the turn. The human's next message is the answer. Do not
guess an answer to keep a run moving, and do not stack two questions into one suspension.

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
