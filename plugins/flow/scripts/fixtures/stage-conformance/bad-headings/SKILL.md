---
name: mini-stage
description: A deliberately broken two-gate stage whose profile declares one gate twice and mis-cases the other heading. The conformance smoke runs its checker over this pair and requires a failure; nothing loads it at runtime.
---

# mini-stage

## 1. Open [[gate:mini-open]]

Both markers here are canonical. The breakage is entirely on the profile side.

## 2. Close [[gate:mini-close]]

The profile heading for this one is capitalized, so a checker that matches only the
lowercase spelling reads it as missing or, worse, never looks.
