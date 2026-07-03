# flow — agent operating notes

This repo is a Claude Code **plugin marketplace** (see README.md). Everything user-facing
lives under `plugins/flow/`; the repo root only carries the marketplace manifest and docs.

## Invariants

- `plugins/flow/charter/charter.md` is injected into **every** Claude session via the
  SessionStart hook — keep it terse (~80 lines), directive, and free of anything that
  belongs in the skill's long-form docs. Every line costs context in every session.
- The skill (`plugins/flow/skills/flow/`) is the single source of doctrine. Commands and
  the charter POINT at it; they do not restate it. If a rule appears twice, one copy is a bug.
- `workflows/issue.mjs` is plain JavaScript for the Workflow tool — no TypeScript syntax,
  no `Date.now()`/`Math.random()`/argless `new Date()` (they break resume).
- Bump `version` in BOTH `.claude-plugin/marketplace.json` and
  `plugins/flow/.claude-plugin/plugin.json` on any behavioural change.
- Version-pinned facts (model pricing, codex CLI surface) carry an `as-of` date. Distrust
  and re-verify anything older than a quarter.

## Testing changes

Reinstall to pick up changes: `claude plugin uninstall flow@flow && claude plugin install flow@flow`
(the install copies the plugin — edits to this repo do not go live until reinstalled).
Hook scripts run standalone: `echo '<json>' | node plugins/flow/hooks/scripts/no-backlog-guard.mjs`.
