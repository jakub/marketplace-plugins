---
name: mini-stage
description: A deliberately broken two-gate stage whose second marker sits inside an HTML comment. The conformance smoke runs its checker over this pair and requires a failure; nothing loads it at runtime.
---

# mini-stage

## 1. Open [[gate:mini-open]]

The profile binds this one, and the marker is canonical and live.

## 2. Close

<!-- [[gate:mini-close]] -->

This marker used to be live. Now it sits inside an HTML comment, so the rendered stage never
shows it to a session and no hook prints it. A checker that reads markers before stripping
comments still counts it, and calls the profile below complete for binding an id the stage
does not actually mark.
