# mini-stage host profile: fixture

Read this with `SKILL.md`. Nothing loads either file at runtime; the conformance smoke reads
them and expects one named defect in this plugin root.

Tool allowance for the stage. The second line sits one space in, so the loader never reads it
and the stage never gets Write:

allowed-tools: Bash(gh:*), Read
 allowed-tools: Bash(gh:*), Read, Write

### gate: mini-open

The argument the alias passes through is the pull request number.

### gate: mini-close

The merge is a pre-approved command here.
