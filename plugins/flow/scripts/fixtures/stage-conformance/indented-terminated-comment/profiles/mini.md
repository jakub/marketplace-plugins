# mini-stage host profile: fixture

allowed-tools: Read

### gate: mini-open

Bound here.

### gate: mini-close

Bound here too, matching the heading the stage marks. The stage's own marker for this id sits
inside a real, terminated HTML comment quoted across two indented lines, so the checker never
gets far enough to compare this section against a marked set; it should report the indented
comment delimiters instead of silently agreeing that the pair is complete.
