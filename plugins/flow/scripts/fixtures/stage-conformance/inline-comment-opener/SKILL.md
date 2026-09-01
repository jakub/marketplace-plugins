---
name: mini-stage
description: A deliberately broken two-gate stage whose prose quotes an unterminated HTML comment opener in an inline code span, ahead of the second marker. The conformance smoke runs its checker over this pair and requires a failure; nothing loads it at runtime.
---

# mini-stage

## 1. Open [[gate:mini-open]]

The profile binds this one, and the marker is canonical and live. The text also quotes the
comment grammar inline, as an example of what not to write: `<!-- example only`. The span
never closes its comment either.

## 2. Close [[gate:mini-close]]

This marker is canonical and live. A checker that strips comments before it strips inline code
spans reads the quoted opener above as a real one and, finding no closing `-->` anywhere after
it, erases every line from the span to the end of the file, including this marker, before a
single marker gets extracted.
