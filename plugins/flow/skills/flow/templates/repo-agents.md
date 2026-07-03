# <project> — agent operating notes

<!-- template: keep the whole file ≤ ~40 lines. It answers "how do I operate HERE";
     the flow charter answers "how do we work"; don't duplicate the charter. -->

<one paragraph: what this project is and its current phase.>

## Read next (when relevant)

- `CONTEXT.md` — the domain glossary; terms in it are load-bearing, use them precisely.
- `docs/adr/` — decision records; check before re-litigating architecture.
- <crate/module domain files, if any: `crates/<x>/AGENTS.md`>

## Operating notes

- Build/test: <the commands that matter, e.g. `cargo nextest run --workspace`>
- Environments: test (agent-owned) / dev (user-local) / <prod tier + its rules>
- <the 3-5 invariants that bite: DB conventions, feature-flag rules, codegen steps…>
