# mini-stage host profile: fixture

Read this with `SKILL.md`. Nothing loads either file at runtime; the conformance smoke reads
them and expects one named defect in this plugin root.

Tool allowance for the stage, and the one the alias declares in its frontmatter:

allowed-tools: Bash(gh:*), Read

### gate: mini-open

The argument the alias passes through is the pull request number.

### gate: mini-close

The merge is a pre-approved command here.
