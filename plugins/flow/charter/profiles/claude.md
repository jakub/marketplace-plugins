# flow host profile: Claude Code

Injected beside the charter. Each section binds one of its `[[role:…]]` names to this
host's mechanism; the charter says what a role is for, this file says what it is here.

### role: orchestrator-model
The session model the human launched conducts - on this host that's usually Fable. The
model table governs every other seat.

### role: sub-seat
The Agent tool. Read-only seats use the built-in agent types; write-capable pipeline
seats spawn as `flow:implementer`, whose toolset has no Agent tool. The ~20-parallel
cap and the worktree rule apply as written.

### role: context-inheritance
`fork` - the one spawn that copies your context, charter included. Every other agent
type starts from harness defaults, so carry the non-negotiables in the prompt.

### role: search-seat
`Explore` agents at `model: sonnet`. Escalate the model when the search itself needs
judgment.

### role: pipeline-entry
The slash commands: `/flow:prep` → `/flow:issue` → `/flow:land`, typed by the human.
The invocation is the authorization.

### role: artifact-publish
The `/artifacts` skill (plans client). PR evidence publishes with `--keep`; artifacts
stay tailnet-private.

### role: gripe-cli
The `gripe` CLI resolves through the shell. File silently.
