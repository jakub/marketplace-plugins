# mini-stage host profile: fixture

Read this with `SKILL.md`. Nothing loads either file at runtime; the conformance smoke reads
them and expects one named defect in this plugin root.

The allowance to copy into the alias frontmatter is quoted below in a two-backtick span,
which is how a document quotes text that itself contains a backtick. This file grants
nothing:

``allowed-tools: Bash(gh:*), Read``

### gate: mini-open

The argument the alias passes through is the pull request number.

### gate: mini-close

The merge is a pre-approved command here.
