---
name: mini-stage
description: A deliberately broken two-gate stage whose prose writes a bare, self-closing-looking comment opener ahead of the second marker. The conformance smoke runs its checker over this pair and requires a failure; nothing loads it at runtime.
---

# mini-stage

## 1. Open [[gate:mini-open]]

The profile binds this one, and the marker is canonical and live. Right after it, the prose
writes a bare comment opener spelled <!-->, borrowing its own trailing dashes as if they closed
the comment. HTML has no such shorthand: a closer has to come after the opener's four
characters, not inside them, so this spelling never actually closes and no `-->` appears
anywhere else in this file to close it either.

## 2. Close [[gate:mini-close]]

This marker is canonical and live, but it comes after the unterminated opener above. A checker
whose closer search starts at the opener's own position, instead of four characters past it,
reads the opener's own trailing dashes as the closer and calls the comment closed when it is
not, then leaves this marker standing as ordinary text. The correct search starts past the
opener and agrees with the comment stripper: nothing closes it, so everything from there to the
end of the file is invisible, and the checker has to say so instead of silently losing this
marker.
