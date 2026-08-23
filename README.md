# marketplace-plugins

jakub's personal Claude Code marketplace — one repo publishing a small set of plugins. Add it once, install what you want.

```bash
claude plugin marketplace add jakub/marketplace-plugins
claude plugin install flow@jakub
```

`@jakub` is the marketplace name from `.claude-plugin/marketplace.json`, not the repo name. Hooks arm at the next session start. Installs pull from the pinned GitHub clone, so after editing this repo: push, then reinstall the plugin.

## Plugins

| Plugin | Install | What it is |
|---|---|---|
| **flow** | `flow@jakub` | The prep → issue → land development pipeline and the engineering charter that governs it. Details below. |
| **grill** | `grill@jakub` | Relentless design interrogation and the domain-model doc discipline it feeds: `grill-with-docs`, `grilling`, `domain-modeling`. Vendored from [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT); see `plugins/grill/NOTICE`. |
| **unslop** | `unslop@jakub` | Cuts AI tells from writing — puffery, filler, hedging, synonym cycling, boldface spam — and puts a voice back in. Vendored from [Lauren Tan's pstack skill](https://github.com/cursor/plugins/tree/main/pstack) (MIT); see `plugins/unslop/NOTICE`. |

## flow

Three commands in order. `/flow:prep` is the front door: an interactive design gate that turns an issue or a free-text idea into a `ready-for-agent` spec, with a cross-model dialectic and a grill where decisions get minted as ADRs. `/flow:issue` is the hands-off run: the session model conducts a fabric of subagents — design pair, contained implementer, cross-family adversarial review, evidence ledger — to a pushed, reviewed, evidenced PR and stops there. `/flow:land` is the human gate and the only merge path: CI and review-thread checks, squash merge, cleanup, and a survey of what to do next.

The charter is the other half. It's injected into every session by a SessionStart hook and says how we build — delegation, the model table and per-model rules of engagement, verification, git. Two PreToolUse hooks back up the parts that shouldn't depend on memory: a no-backlog guard that blocks unsanctioned `gh issue create` (PRs ship complete), and a git guard that blocks `--no-verify` and commit trailers.

| Path | What's there |
|---|---|
| `plugins/flow/charter/charter.md` | The engineering charter. Hand-authored; source of truth. |
| `plugins/flow/commands/` | `prep.md`, `issue.md`, `land.md`, and the deprecated `issue-fixed.md`. |
| `plugins/flow/agents/` | `implementer` (the contained write seat — no Agent tool, synchronous runs, claim-shaped reports), `codex-delegate` (a thin transport to Codex: sol, daybreak, luna), `code-architect`, `code-reviewer`. Models and efforts are set by the conductor at spawn. |
| `plugins/flow/skills/flow/` | `/flow setup`, `/flow drift`, `/flow labels`, `/flow charter`: project setup, the doc stack, the label contract, the drift audit. |
| `plugins/flow/scripts/codex-exec.mjs` | The raw-CLI Codex transport with a JSON envelope. Needs `codex` on PATH; returns a visible error envelope otherwise. |
| `plugins/flow/workflows/issue-fixed.mjs` | The deprecated fixed pipeline, kept as a fallback and a parts library for ad-hoc Workflow scripts. |
| `plugins/flow/hooks/` | Charter injection, no-backlog guard, git guard. |

flow works best when the global `~/.claude/CLAUDE.md` carries only persona and interaction preferences and all engineering doctrine arrives through the charter, where it's versioned and auditable. `docs/claude-md-split.md` explains the split.

## Layout

```
.claude-plugin/marketplace.json   the marketplace manifest (this repo IS the marketplace)
plugins/flow/                     the flow plugin
plugins/grill/                    vendored grill skills (MIT, see its NOTICE)
plugins/unslop/                   vendored anti-slop skill (MIT, see its NOTICE)
docs/claude-md-split.md           the recommended global CLAUDE.md split
AGENTS.md                         how to work in this repo (CLAUDE.md symlinks to it)
```

Adding a plugin: create `plugins/<name>/` with a `.claude-plugin/plugin.json` (`name`, `version`, `description`) and whatever it ships (`skills/`, `commands/`, `agents/`, `hooks/`), append an entry to `plugins` in the manifest with `"source": "./plugins/<name>"`, and bump the manifest's `metadata.version` — the catalog version, separate from each plugin's own.
