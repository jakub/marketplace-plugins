# flow

A Claude Code plugin marketplace carrying one plugin: **flow** — a disciplined
prep → issue → land development pipeline for solo/greenfield projects, plus the
engineering charter that governs it.

The shape: an interactive design gate at the front (`/flow:prep`), a hands-off
implementation run that ends at a pushed, reviewed, evidenced PR (`/flow:issue`), and a
human-gated merge ritual (`/flow:land`). Multi-model by design — judgment stages, heavy
lifting, mechanical work, and an independent cross-model review are routed to different
models on different effort levels.

## What the plugin ships

| Component | Path | Purpose |
|---|---|---|
| Charter | `plugins/flow/charter/charter.md` | The "how we build" engineering charter, injected into every session by a SessionStart hook — delegation policy, model routing, verification semantics, git discipline. |
| Skill | `plugins/flow/skills/flow/` | Self-documenting framework: doctrine, doc-stack setup, drift audit, label contract. `/flow setup`, `/flow drift`, `/flow labels`, `/flow charter`. |
| Commands | `plugins/flow/commands/` | `/flow:prep` (the single front door for issues, ideas, and spikes), `/flow:issue` (through-the-PR run), `/flow:land` (the only merge path). |
| Workflow | `plugins/flow/workflows/issue.mjs` | The hands-off implementation workflow — design fan-out → synthesis → TDD → review fabric → fix loop → PR → post-push reviews (self ∥ external) → per-criterion evidence ledger. |
| Agent | `plugins/flow/agents/codex-delegate.md` | Generic "delegate anything to Codex" subagent (role/effort/write/schema parameters, typed returns). Optional — degrades gracefully when the [openai-codex plugin](https://github.com/openai/codex-plugin-cc) isn't installed. |
| Hooks | `plugins/flow/hooks/` | SessionStart charter injection · PreToolUse no-backlog guard (blocks unsanctioned `gh issue create` — PRs ship complete). |

## Install

Works from a local clone — no remote required:

```bash
claude plugin marketplace add <path-or-url-of-this-repo>
claude plugin install flow@flow
```

Hooks arm at the next session start. Installs are cache copies: after editing this repo,
uninstall/reinstall to go live. Commands are namespaced (`/flow:prep`, `/flow:issue`,
`/flow:land`); the short forms resolve when nothing shadows them.

## Recommended: the CLAUDE.md split

flow works best when the global `~/.claude/CLAUDE.md` carries only persona and interaction
preferences, and ALL engineering doctrine arrives via the injected charter — versioned,
portable, drift-auditable. See `docs/claude-md-split.md`.

## Layout

```
.claude-plugin/marketplace.json   marketplace manifest (this repo IS the marketplace)
plugins/flow/                     the plugin
docs/claude-md-split.md           the recommended global CLAUDE.md split
```
