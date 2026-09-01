---
name: mini-stage
description: A deliberately broken two-gate stage whose example quotes an unterminated HTML comment opener inside a 4-space indented code block, ahead of the second marker. The conformance smoke runs its checker over this pair and requires a failure; nothing loads it at runtime.
---

# mini-stage

## 1. Open [[gate:mini-open]]

The profile binds this one, and the marker is canonical and live.

## 2. Close

CommonMark reads four leading spaces as a code block, the same as three backticks, but the
engine's code stripper only knows the fenced and inline forms:

    <!-- example only

That indented line never closes its comment.

[[gate:mini-close]]

This marker sits after the indented block. It is canonical and live, but it is unreachable by
the ordinary id comparison: everything from the unclosed opener to end of file disappears once
comments are stripped, so the engine has to name the unterminated comment as its own problem
instead of silently losing the marker.
