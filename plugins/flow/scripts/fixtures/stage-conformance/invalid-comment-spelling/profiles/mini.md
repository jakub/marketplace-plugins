# mini-stage host profile: fixture

allowed-tools: Read

### gate: mini-open

Bound here.

### gate: mini-close

Bound here too, matching the heading the stage marks. The stage's own marker for this id sits
after a bare "<!-->" opener that never actually closes, so the checker never gets far enough to
compare this section against a marked set; it should report the unterminated comment instead of
silently agreeing that the pair is complete.
