# flow host profile: Claude Code

Injected beside the charter. Each section binds one of its `[[role:…]]` names to this
host's mechanism; the charter says what a role is for, this file says what it is here.
A seat role's section opens with the charter table's model name and an effort, and the
conformance lint reads exactly that opening pair against the role's floors. The Agent tool
takes `model` only, so a native seat runs at the session's effort: a native binding's
"session effort" is the effort this session must be running at when it spawns that role.
Raise it before the spawn, and journal the effort you were at. A bridge binding's effort
is set on the call.

## Bindings

### role: sub-seat

The Agent tool. Read-only seats use the built-in agent types; write-capable pipeline
seats spawn as `flow:implementer`, whose toolset has no Agent tool. The ~20-parallel
cap and the worktree rule apply as written.

### role: context-inheritance

`fork` - the one spawn that copies your context, charter included. Every other agent
type starts from harness defaults, so carry the non-negotiables in the prompt.

### role: search-seat

`sonnet-5` at low session effort: `Explore` agents (`model: sonnet`). Escalate the model when the
search itself needs judgment.

### role: outside-scout

`gpt-5.6-sol` at medium effort through `delegate_to_codex`, `access: read-only`, the
repository root as `cwd`.

### role: design-leg-native

`opus-5` at xhigh session effort as `flow:code-architect` (`model: opus`), in the background.

### role: design-leg-bridge

`gpt-5.6-sol` at high effort through `delegate_to_codex`, `access: read-only`,
`delivery: attached`, the repository root as `cwd`. The outside opinion on this host is
the Codex family.

### role: taste-leg

`fable-5-1` at high session effort as `flow:code-architect` (`model: fable`).

### role: write-seat-mechanical

`sonnet-5` at medium session effort as `flow:implementer` (`model: sonnet`).

### role: write-seat-standard

`opus-5` at high session effort as `flow:implementer` (`model: opus`). The default rung.

### role: write-seat-hard

`opus-5` at xhigh session effort as `flow:implementer` (`model: opus`).

### role: bulk-seat

`gpt-5.6-luna` at max effort through `delegate_to_codex`, the repository root as `cwd`.
The cheap-depth seat, never the decorrelation seat.

### role: review-seat-native

`opus-5` at xhigh session effort as `flow:code-reviewer` (`model: opus`), for a diff a bridge
writer produced.

### role: review-seat-bridge

`gpt-5.6-sol` at high effort through `delegate_to_codex` in `mode: "adversarial-review"`
against an immutable `base`, `access: read-only`, for a diff `flow:implementer` produced.
Sol is flat-rate on this host, so extra lenses cost turnaround and not money: widen on a
hunch.

### role: security-seat

`gpt-daybreak-blue-latest` at high effort through `delegate_to_codex`, `access: read-only`,
the repository root as `cwd`.

### role: adjudicator

`opus-5` at max session effort (`model: opus`).

### role: human-choice

The AskUserQuestion tool: up to 4 questions per call, each with selectable options and
the recommendation first. The answer comes back inside the same turn, so asking does not
end a run. Never replace it with a prose question the human has to answer in an essay.

### role: pipeline-entry

The slash commands: `/flow:prep` → `/flow:issue` → `/flow:land`, typed by the human.
The invocation is the authorization.

### role: artifact-publish

The `/artifacts` skill (plans client). PR evidence publishes with `--keep`; artifacts
stay tailnet-private.
