# flow host profile: Codex

Injected beside the charter. Each section binds one of its `[[role:…]]` names to this
host's mechanism; the charter says what a role is for, this file says what it is here.
A seat role's section opens with the charter table's model name and an effort, and the
conformance lint reads exactly that opening pair against the role's floors. A bridge
binding also spells the provider id the delegation tool takes.

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

`gpt-5.6-luna` at medium effort: a native read-only `spawn_agent` seat with
`fork_turns: "none"`. Escalate the model when the search itself needs judgment.

### role: outside-scout

`sonnet-5` at medium effort through `delegate_to_claude` as `claude-sonnet-5`,
`access: read-only`, the repository root as `cwd`.

### role: design-leg-native

`gpt-5.6-sol` at high effort: a `spawn_agent` seat with `fork_turns: "none"`, read-only
by its prompt.

### role: design-leg-bridge

`opus-5` at high effort through `delegate_to_claude` as `claude-opus-5`,
`access: read-only`, `delivery: attached`, the repository root as `cwd`. The outside
opinion on this host is a Claude model; the charter's "Sol is the decorrelated seat" is
written from a Claude host.

### role: taste-leg

`fable-5-1` at high effort through `delegate_to_claude` as `claude-fable-5-1`,
`access: read-only`, the repository root as `cwd`.

### role: write-seat-mechanical

`gpt-5.6-luna` at max effort, native `spawn_agent`. Luna counts 7 only at max, which
is what the rung's floor needs; Sol at medium costs little more, so take the higher
rung when torn.

### role: write-seat-standard

`gpt-5.6-sol` at medium effort, native `spawn_agent`. The default rung.

### role: write-seat-hard

`gpt-5.6-sol` at high effort, native `spawn_agent`.

### role: bulk-seat

`gpt-5.6-luna` at max effort, native `spawn_agent`.

### role: review-seat-native

`gpt-5.6-sol` at high effort, native `spawn_agent`, for a diff a bridge writer produced.
Do not send that one across the bridge.

### role: review-seat-bridge

`opus-5` at xhigh effort through `delegate_to_claude` as `claude-opus-5` in
`mode: "adversarial-review"` against an immutable `base`, `access: read-only`, for a diff
a native writer produced. Where the Claude side is metered, trim optional lenses on a
quiet diff, never this pass.

### role: security-seat

`gpt-daybreak-blue-latest` at high effort, native `spawn_agent`.

### role: adjudicator

`gpt-5.6-sol` at max effort, native `spawn_agent`.

### role: human-choice

The suspended turn. There is no in-turn question tool, so write the question, list up to 4
numbered options with a one-line consequence each and the recommended one first, then end
the turn. The human's next message is the answer. Do not
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
