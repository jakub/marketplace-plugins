---
name: mini-stage
description: A deliberately broken two-gate stage whose second marker sits between an indented HTML comment opener and its later, indented closer. The conformance smoke runs its checker over this pair and requires a failure; nothing loads it at runtime.
---

# mini-stage

## 1. Open [[gate:mini-open]]

The profile binds this one, and the marker is canonical and live. Right after it, an indented
line quotes a comment opener:

    <!-- opened here, four spaces in

The line above is not inside a fenced block, so the checker's code stripper leaves it standing
as ordinary text.

## 2. Close [[gate:mini-close]]

This marker is canonical and live, and it sits between the opener above and the closer below.

    closed here -->

The comment terminates, so a check that only looks for an opener with no later closer would not
catch this: everything between the two indented lines, including the mini-close marker above,
reads as commented out once comments are stripped, and the profile below still names both gates.
