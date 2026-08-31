---
name: mini-stage
description: A deliberately broken two-gate stage whose fenced example quotes an unterminated HTML comment opener ahead of the second marker. The conformance smoke runs its checker over this pair and requires a failure; nothing loads it at runtime.
---

# mini-stage

## 1. Open [[gate:mini-open]]

The profile binds this one, and the marker is canonical and live.

## 2. Close

A fenced block quotes the comment grammar as an example, and never closes it:

```
<!-- example only
```

[[gate:mini-close]]

This marker sits after the fence and is canonical and live. A checker that strips comments
before it strips fenced code reads the quoted opener above as a real one and, finding no
closing `-->` anywhere after it, erases every line from the fence to the end of the file,
including this marker, before a single marker gets extracted.
