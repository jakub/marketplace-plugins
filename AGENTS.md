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
  SessionStart hook, wrapped in `<flow-charter>` tags that the global CLAUDE.md checks for.
  It is the source of truth for how we build: delegation, the model rankings and per-model
  rules of engagement, pipeline, verification, git. Written as prose to a capable colleague,
  not as a config file — keep it that way. It reaches the main session only (not subagents;
  CLAUDE.md and hooks do), and every line costs context in every session, so anything that
  isn't true in every session goes in the skill or a command body instead. Currently ~140
  lines.
- Doctrine lives in exactly two places. The **charter** holds what must be true in every
  session. The **command bodies** (`prep.md`, `issue.md`, `land.md`) hold the steps each
  command executes. The skill (`plugins/flow/skills/flow/`) holds only what neither needs
  at runtime: setup, the doc stack, ambient machinery, label contract, drift audit. If a
  rule appears twice, one copy is a bug — `framework.md` was retired for exactly this.
- `/flow:issue` is the dynamic run — the conductor composes the fabric per issue. The fixed
  pipeline is deprecated at `/flow:issue-fixed` + `workflows/issue-fixed.mjs` — fallback and
  parts library only, no new behavior lands there.
- `workflows/issue-fixed.mjs` (and any ad-hoc Workflow script) is plain JavaScript for the
  Workflow tool — no TypeScript syntax,
  no `Date.now()`/`Math.random()`/argless `new Date()` (they break resume).
- A behavioral change to an `issue-fixed.mjs` stage updates that stage in `skills/flow/SKILL.md`
  § Inside the v1 run. That section is the one sanctioned duplicate in the plugin — reference,
  not instruction, with the script as source of truth — so it only stays honest if the person
  editing the script mirrors it. Both drifts found so far came from editing the script, never
  from reading the doc.
- On any behavioral change to flow, bump `version` in `plugins/flow/.claude-plugin/plugin.json`,
  mirror it in the plugin's entry in `.claude-plugin/marketplace.json`, and bump the
  marketplace `metadata.version`.
- Version-pinned facts (model pricing, codex CLI surface) carry an `as-of` date. Distrust
  and re-verify anything older than a quarter.

## grill plugin invariants

- `plugins/grill/skills/` is **vendored** from https://github.com/mattpocock/skills (MIT),
  upstream-plus-one-patch. Do not hand-edit those files ad hoc — every local change lives in
  `plugins/grill/patches/` so a re-sync stays mechanical: copy the three upstream dirs over,
  `git apply` each patch in order, bump the SHA in `plugins/grill/NOTICE`. If a patch stops
  applying, regenerate it rather than editing files in place and leaving the patch stale.
- Doc-artifact filenames are lowercase repo-wide (`context.md`, `context-map.md`) — that is
  what patch 0001 enforces inside the vendored tree. `SKILL.md`, `AGENTS.md`, and `CLAUDE.md`
  keep their uppercase names: the skill loader and the two agent tools discover them by exact
  filename, so lowercasing those would silently unload them.
- The three skills are the minimal closure: `grill-with-docs` is a thin wrapper that runs
  `/grilling` using `/domain-modeling`. Upstream ships 41 skills; carrying more is a
  deliberate decision, not a default.
- `flow`'s `/flow:prep` calls `grill-with-docs` when present and falls back to an inline
  grill otherwise — the dependency is one-way and soft. Do not make flow require grill.

## unslop plugin invariants

- `plugins/unslop/skills/unslop/SKILL.md` is **vendored verbatim** from Lauren Tan's pstack
  skill in `cursor/plugins` (MIT). No patches dir yet, by design. If it needs changing, add
  `plugins/unslop/patches/0001-*.patch` following the grill pattern rather than hand-editing,
  and bump the SHA in `plugins/unslop/NOTICE`.
- Delivery is the SessionStart hook (`hooks/scripts/inject-unslop.mjs`), not the skill
  description — "Must always apply" in the frontmatter is an advertisement the model acts on
  unreliably, so the hook injects the body every session inside a plugin-local scoping
  wrapper: full ruleset for deliverables; jargon + plain-speech rules for technical
  explanations in chat; the output style wins mechanical style conflicts (em dashes,
  "harness"/"surface") in conversation. Scoping changes go in the wrapper, never in a patch
  to the vendored file.

## Testing changes

Reinstall to pick up changes: `claude plugin uninstall flow@jakub && claude plugin install flow@jakub`
(the install pulls the pinned GitHub clone, not this working tree — commit and push first, or the reinstall picks up the old version).
Hook scripts run standalone: `echo '<json>' | node plugins/flow/hooks/scripts/no-backlog-guard.mjs`.
