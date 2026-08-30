---
name: mini-stage
description: A deliberately broken two-gate stage whose second marker misspells its id. The conformance smoke runs its checker over this pair and requires a failure; nothing loads it at runtime.
---

# mini-stage

## 1. Open [[gate:mini-open]]

The profile binds this one, and the marker is canonical.

## 2. Close [[gate:bad_id]]

An underscore is not in the id grammar. A checker that only collects canonical markers never
sees this gate at all, so the profile below looks complete and the typo ships.
