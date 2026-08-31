# prep-stage host profile: Claude Code

Read this with `SKILL.md`. The stage is host-neutral prose; this file says what each of its
`[[gate:<id>]]` markers binds to in a Claude Code session. Where a gate has nothing
host-specific about it, the section says so rather than inventing a difference.

Tool allowance for the stage, and the one `/flow:prep` declares in its frontmatter:

allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Read, Edit, Write, Skill, AskUserQuestion, Agent, mcp__plugin_flow_flow_delegate__delegate_to_codex, mcp__plugin_flow_flow_delegate__delegation_continue, mcp__plugin_flow_flow_delegate__delegation_status, mcp__plugin_flow_flow_delegate__delegation_result, mcp__plugin_flow_flow_delegate__delegation_events, mcp__plugin_flow_flow_delegate__delegation_list, mcp__plugin_flow_flow_delegate__delegation_cancel

The human-choice binding is the AskUserQuestion tool: up to 4 questions per call, each with
selectable options and the recommendation first, and the answer comes back inside the same
turn. Never replace it with a prose question the human has to answer in an essay.

## Gates

### gate: resolve-subject

`$ARGUMENTS` from the `/flow:prep` invocation is the subject. A bare integer or `#N` is
issue mode; anything else is free text. The invocation is the authorization: this stage
never picks a subject out of adjacent conversation, a discovered defect, or a "what next"
survey. The re-prep question (an issue already `ready-for-agent`), the offer to adopt an open
duplicate the dedupe turned up, and the buried-work exit (a closed, `wontfix`, or `deferred`
match the human may override) all go through AskUserQuestion.

### gate: scout-fanout

`Explore` agents at `model: sonnet`, one per lane - domain docs, code seams, prior art -
launched in one message so they run together. The outside perspective is `delegate_to_codex`
with `gpt-5.6-sol` at medium effort, `access: read-only`, the repository root as `cwd`. Every
seat is told to return paths and seams, not file dumps.

### gate: scout-containment

An `Explore` seat is the session's tool list minus Edit, Write, NotebookEdit, and Agent. It
keeps Bash, the session's permission mode, and the same `gh` token, so its read-only is a
prompt promise plus the PreToolUse hooks, and it cannot spawn. The journal says exactly
that per seat - `access: contract`, `descendant-spawn: mechanism` - and never calls it a
sandbox.

### gate: triviality-agreement

AskUserQuestion, one question, recommendation first: do it now (free-text mode) or go
straight to the implementation stage (issue mode), split into slices, or continue to the
dialectic.

### gate: dialectic-legs

The native leg is a Claude-family seat: `flow:code-architect` at `model: opus`, effort
xhigh, or `fable` when the subject is user-facing UI or copy. The bridge leg is
`delegate_to_codex` with `gpt-5.6-sol` at high effort, `access: read-only`,
`delivery: attached`, `serviceTier: default`, the repository root as `cwd`. Launch the native
leg first (it runs in the background), then the bridge attached, so both sheets land in this
turn. Neither sees the other.

### gate: mutual-critique

`delegation_continue` on the bridge job id carries the native sheet to the Codex leg with its
context intact; `SendMessage` to the native agent carries the bridge sheet back. A null,
error, or timeout from either side is UNKNOWN: read `delegation_status` and
`delegation_result` before any retry. Never average the two sheets.

### gate: trust-fork-ask

AskUserQuestion, one question per fork, mandatory for anything that sets a trust posture.
Cheap design forks are decided by the conductor and journaled, never asked.

### gate: grill-dependency

The `grill-with-docs` skill through the Skill tool when the grill plugin is installed;
otherwise the inline grill in the stage body. Either one is seeded with the doc-stack
conventions the body spells out.

### gate: grill-rounds

Rounds arrive as AskUserQuestion calls, up to 4 questions each, options with the
recommendation first; a wider frontier splits across back-to-back calls.

### gate: handoff

One line: `#N design-hardened → ready-for-agent → /flow:issue N` (or done-now / split /
needs-info), naming the decisions made and any doc touched.
