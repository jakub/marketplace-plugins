# flow

Personal Claude Code plugin marketplace carrying one plugin: **flow** — the
prep → issue → land development pipeline and the engineering charter that governs it.

Target-state design: https://claude.ai/code/artifact/aee926c9-5ba3-4294-a1f7-b939c7c30860

## What the plugin ships

| Component | Path | Purpose |
|---|---|---|
| Charter | `plugins/flow/charter/charter.md` | The "how we work" engineering charter, injected into every session by a SessionStart hook. Replaces the engineering/workflow/debugging sections of the global CLAUDE.md. |
| Skill | `plugins/flow/skills/flow/` | Self-documenting framework: doctrine, doc-stack setup, drift audit, label contract. `/flow setup`, `/flow drift`. |
| Commands | `plugins/flow/commands/` | `/flow:prep` (front door), `/flow:issue` (through-the-PR run), `/flow:land` (human gate). |
| Workflow | `plugins/flow/workflows/issue.mjs` | The hands-off implementation workflow v2 — design fan-out → synthesis → TDD → review fabric → fix loop → PR → post-push reviews → evidence ledger. |
| Agent | `plugins/flow/agents/codex-delegate.md` | Generic "delegate anything to codex" subagent (role/effort/write/schema parameters, typed returns). |
| Hooks | `plugins/flow/hooks/` | SessionStart charter injection · PreToolUse no-backlog guard (blocks unsanctioned `gh issue create`). |

## Install

```bash
claude plugin marketplace add ~/code/flow
claude plugin install flow@flow
```

Commands land namespaced (`/flow:prep`, `/flow:issue`, `/flow:land`); once the
loose `~/.claude/commands/{prep,issue,land}.md` files are retired there is no collision
and the short forms resolve.

## Layout

```
.claude-plugin/marketplace.json   marketplace manifest (this repo IS the marketplace)
plugins/flow/                     the plugin
docs/proposed-global-claude-md.md the global CLAUDE.md diet — review before switching
```
