# mini-stage host profile: fixture

allowed-tools: Read

### gate: mini-open

Bound here.

### gate: mini-close

Bound here too, matching the heading the stage used to mark. The stage's own marker for this
id now sits inside an HTML comment, so it is not live: a checker has to report this section
as binding a gate the stage never marks, not treat the pair as complete.
