# marketplace-plugins — agent operating notes

This repo is jakub's Claude Code **plugin marketplace** (see README.md). The repo root
carries only the marketplace manifest (`.claude-plugin/marketplace.json`, name `jakub`) and
shared docs. Each plugin is a self-contained directory under `plugins/`, listed in the
manifest's `plugins` array. Install strings are `<plugin>@jakub`.

## Marketplace invariants

- `.claude-plugin/marketplace.json` has its own `metadata.version` (the catalog version),
  bumped when the set of plugins or their listed versions changes. It is separate from each
  plugin's own `version`.
- A new plugin = a `plugins/<name>/` dir with `.claude-plugin/plugin.json` + an entry in the
  manifest's `plugins` array (`"source": "./plugins/<name>"`). Keep unrelated plugins
  decoupled — don't make one plugin depend on another's files.

## flow plugin invariants

- `plugins/flow/charter/charter.md` is injected into **every** Claude session via the
  SessionStart hook — keep it terse (~80 lines), directive, and free of anything that
  belongs in the skill's long-form docs. Every line costs context in every session.
- The skill (`plugins/flow/skills/flow/`) is the single source of doctrine. Commands and
  the charter POINT at it; they do not restate it. If a rule appears twice, one copy is a bug.
- `workflows/issue.mjs` is plain JavaScript for the Workflow tool — no TypeScript syntax,
  no `Date.now()`/`Math.random()`/argless `new Date()` (they break resume).
- On any behavioural change to flow, bump `version` in `plugins/flow/.claude-plugin/plugin.json`,
  mirror it in the plugin's entry in `.claude-plugin/marketplace.json`, and bump the
  marketplace `metadata.version`.
- Version-pinned facts (model pricing, codex CLI surface) carry an `as-of` date. Distrust
  and re-verify anything older than a quarter.

## Testing changes

Reinstall to pick up changes: `claude plugin uninstall flow@jakub && claude plugin install flow@jakub`
(the install copies the plugin — edits to this repo do not go live until reinstalled).
Hook scripts run standalone: `echo '<json>' | node plugins/flow/hooks/scripts/no-backlog-guard.mjs`.
