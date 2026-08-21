# marketplace-plugins

jakub's personal **Claude Code marketplace** — a single repo that publishes a growing set
of plugins and skill bundles. Add it once; install the pieces you want à la carte.

```bash
claude plugin marketplace add jakub/marketplace-plugins
claude plugin install flow@jakub
```

The `@jakub` suffix is the marketplace name (set in `.claude-plugin/marketplace.json`),
independent of the repo name. Hooks arm at the next session start. Installs are cache
copies — after editing this repo, reinstall the affected plugin to go live.

## Plugins

| Plugin | Install | What it is |
|---|---|---|
| **flow** | `flow@jakub` | A disciplined prep → issue → land development pipeline for solo/greenfield projects, plus the engineering charter that governs it. See below. |
| **grill** | `grill@jakub` | Relentless design interrogation and the domain-model doc discipline it feeds — `grill-with-docs`, `grilling`, `domain-modeling`. Vendored from [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT); see `plugins/grill/NOTICE`. |
| **unslop** | `unslop@jakub` | Cut AI tells from writing and put a voice back in — puffery, filler, hedging, synonym cycling, boldface spam, and the rest of the slop taxonomy. Vendored from [Lauren Tan's pstack skill](https://github.com/cursor/plugins/tree/main/pstack) (MIT); see `plugins/unslop/NOTICE`. |

_More to come — each new plugin is a directory under `plugins/` listed in the marketplace manifest._

## flow

An interactive design gate at the front (`/flow:prep`), a hands-off implementation run that
ends at a pushed, reviewed, evidenced PR (`/flow:issue`), and a human-gated merge ritual
(`/flow:land`). Multi-model by design — judgment stages, heavy lifting, mechanical work, and
an independent cross-model review are routed to different models on different effort levels.

| Component | Path | Purpose |
|---|---|---|
| Charter | `plugins/flow/charter/charter.md` | The "how we build" engineering charter, injected into every session by a SessionStart hook — delegation policy, model routing, verification semantics, git discipline. |
| Skill | `plugins/flow/skills/flow/` | Self-documenting framework: doctrine, doc-stack setup, drift audit, label contract. `/flow setup`, `/flow drift`, `/flow labels`, `/flow charter`. |
| Commands | `plugins/flow/commands/` | `/flow:prep` (the single front door for issues, ideas, and spikes), `/flow:issue` (through-the-PR run), `/flow:land` (the only merge path). |
| Workflow | `plugins/flow/workflows/issue.mjs` | The hands-off implementation workflow — design fan-out → synthesis → TDD → review fabric → fix loop → PR → post-push reviews (self ∥ external) → per-criterion evidence ledger. |
| Agent | `plugins/flow/agents/codex-delegate.md` | Generic "delegate anything to Codex" subagent (mode/model/effort/fast/write/schema parameters, typed envelope returns) over the vendored raw-CLI transport `plugins/flow/scripts/codex-exec.mjs`. Needs the `codex` CLI on PATH; degrades to a visible error envelope otherwise. |
| Hooks | `plugins/flow/hooks/` | SessionStart charter injection · PreToolUse no-backlog guard (blocks unsanctioned `gh issue create` — PRs ship complete). |

Commands are namespaced (`/flow:prep`, `/flow:issue`, `/flow:land`); the short forms resolve
when nothing shadows them.

### Recommended: the CLAUDE.md split

flow works best when the global `~/.claude/CLAUDE.md` carries only persona and interaction
preferences, and ALL engineering doctrine arrives via the injected charter — versioned,
portable, drift-auditable. See `docs/claude-md-split.md`.

## Layout

```
.claude-plugin/marketplace.json   marketplace manifest (this repo IS the marketplace)
plugins/
  flow/                           the flow plugin
  grill/                          vendored grill/domain-modeling skills (MIT, see its NOTICE)
  unslop/                         vendored anti-slop writing skill (MIT, see its NOTICE)
docs/claude-md-split.md           the recommended global CLAUDE.md split
```

## Adding a plugin to this marketplace

1. Create `plugins/<name>/` with a `.claude-plugin/plugin.json` (`name`, `version`, `description`).
2. Add whatever it ships — `skills/`, `commands/`, `agents/`, `hooks/`.
3. Append an entry to `plugins` in `.claude-plugin/marketplace.json` with `"source": "./plugins/<name>"`.
4. Bump `metadata.version` in the marketplace manifest (the catalog version, tracked separately from each plugin's own version).
