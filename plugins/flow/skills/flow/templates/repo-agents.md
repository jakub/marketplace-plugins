# <project> - agent operating notes

<!-- template: keep the whole file ≤ ~40 lines. It answers "how do I operate HERE";
     the flow charter answers "how do we work"; don't duplicate the charter. -->

<one paragraph: what this project is and its current phase.>

## Read next (when relevant)

- `context.md` - the root domain glossary (cross-cutting ontology only); terms in it are
  important, use them precisely.
- `docs/adr/` - decision records; check before re-litigating architecture.
- <crate/module domain files, if any: `crates/<x>/AGENTS.md`>

## Contexts

<!-- This section IS the context map - that's why no context-map.md exists. List every
     crate/module carrying its own context.md slice, one line each, with the relationship
     to its neighbours where it isn't obvious. Delete the section in single-context repos. -->

- `crates/<x>/context.md` - <what this context owns, in one clause>
- `crates/<y>/context.md` - <…>

<relationships worth stating: which context emits what the other consumes, shared types.>

## Operating notes

- Build/test: <the commands that matter, e.g. `cargo nextest run --workspace`>
- Environments: test (agent-owned) / dev (user-local) / <prod tier + its rules>
- Evidence posture: <`public-by-intent` if this repo is open source or headed there, so PR
  evidence captures may publish to the public plans host on human ack | `private` otherwise>
- <the 3-5 invariants that bite: DB conventions, feature-flag rules, codegen steps…>
