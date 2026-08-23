# marketplace-plugins — how to work in this repo

This is jakub's Claude Code plugin marketplace (README.md is the user-facing tour). The repo root holds the marketplace manifest at `.claude-plugin/marketplace.json` (marketplace name `jakub`) and shared docs; everything else is a self-contained plugin under `plugins/`. Install strings are `<plugin>@jakub`.

The charter you already have in context says how we build. This file is only about what's specific to editing the plugins themselves.

## Versions and publishing

Two version numbers move independently. Each plugin has its own `version` in `plugins/<name>/.claude-plugin/plugin.json`, mirrored in its entry in the marketplace manifest. The manifest also has `metadata.version`, the catalog version, which bumps whenever the set of plugins or any listed version changes. A behavioral change to flow is three edits: plugin.json, the manifest entry, the catalog version.

Installs pull from the pinned GitHub clone, never from this working tree. To test a change: commit, push, then `claude plugin uninstall flow@jakub && claude plugin install flow@jakub`. Hook scripts can be exercised without a reinstall — `echo '<json>' | node plugins/flow/hooks/scripts/no-backlog-guard.mjs`.

Desktop and claude.ai bridge sessions load plugins from service-pushed snapshots with hooks stripped, so a bridge session never sees the charter or the guards; don't debug "the hook didn't fire" from one.

Adding a plugin: `plugins/<name>/` with a `.claude-plugin/plugin.json`, plus an entry in the manifest's `plugins` array with `"source": "./plugins/<name>"`. Plugins don't reach into each other's files — flow's `/flow:prep` uses `grill-with-docs` when it's installed and falls back to an inline grill otherwise, and that one-way, soft dependency is the model.

## flow

`plugins/flow/charter/charter.md` is hand-authored by jakub and is the source of truth. The SessionStart hook cats it into every session wrapped in `<flow-charter>` tags, which the global CLAUDE.md checks for. It's prose to a capable colleague, and it should stay that way. Every line costs context in every session, so anything that isn't true in every session goes somewhere else. The charter reaches the main session only — subagents get CLAUDE.md and the hooks, not the charter — which is why the implementer agent def restates the seat rules instead of assuming them.

Doctrine lives in two places and no more. The charter holds what must be true in every session; the command bodies (`commands/prep.md`, `issue.md`, `land.md`) hold the steps each command executes. If something appears in both, delete one copy. The skill under `skills/flow/` holds what neither needs at runtime: setup, the doc stack, the ambient crons and hooks, the label contract, the drift audit, and a reference description of the deprecated fixed pipeline.

`/flow:issue` is the dynamic run: the conductor composes the fabric per issue inside the invariants in `issue.md`. The fixed pipeline, `/flow:issue-fixed` plus `workflows/issue-fixed.mjs`, is deprecated and kept as a fallback and parts library; nothing new lands there. When a stage in the script does change, mirror it in SKILL.md under "Inside the v1 run" — that section is the one sanctioned duplicate, with the script as truth, and both drifts so far came from editing the script without touching the doc.

Workflow scripts (`issue-fixed.mjs` and any ad-hoc one) are plain JavaScript for the Workflow tool: no TypeScript syntax, and no `Date.now()`, `Math.random()`, or argless `new Date()`, because they break resume.

Agent defs under `agents/` don't pin a model; the conductor sets model and effort at spawn. The explicit `tools:` list is load-bearing — a subagent without one can call Agent, and `implementer.md` relies on not having it.

Facts that go stale (model pricing, the codex CLI surface encoded in `scripts/codex-exec.mjs`) carry an as-of date. Re-verify anything older than a quarter; `scripts/smoke-codex-exec.mjs` checks the transport's assumptions against the installed CLI.

## grill

`plugins/grill/skills/` is vendored from https://github.com/mattpocock/skills (MIT), upstream plus one patch. Don't hand-edit the vendored files. A local change is a patch in `plugins/grill/patches/`, so a re-sync stays mechanical: copy the three upstream dirs over, `git apply` each patch in order, bump the SHA in `plugins/grill/NOTICE`. If a patch stops applying, regenerate it.

Patch 0001 lowercases the doc-artifact filenames (`context.md`, `context-map.md`) to match the rest of the repo. `SKILL.md`, `AGENTS.md`, and `CLAUDE.md` keep their uppercase names because the loaders find them by exact filename.

Three skills is the minimal closure — `grill-with-docs` wraps `/grilling` using `/domain-modeling`. Upstream ships 41; carrying another one is a decision, not a default.

## unslop

`plugins/unslop/skills/unslop/SKILL.md` is vendored verbatim from Lauren Tan's pstack skill in `cursor/plugins` (MIT), no patches yet. If it ever needs one, follow the grill pattern and bump the SHA in `plugins/unslop/NOTICE`.

The rules are delivered by the SessionStart hook (`hooks/scripts/inject-unslop.mjs`), not by the skill description — "Must always apply" in frontmatter is advice the model follows unreliably. The hook wraps the body in a plugin-local scoping note: the full ruleset for deliverables, the jargon and plain-speech rules for technical explanations in chat, and the output style wins mechanical style conflicts (em dashes, "harness"/"surface") in conversation. Scoping changes go in that wrapper, never in a patch to the vendored file.
