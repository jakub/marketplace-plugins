# The CLAUDE.md split

`~/.claude/CLAUDE.md` says who the user is: voice, how to disagree, when to ask, what the machine looks like. The flow charter says how we build: delegation, the model table, the pipeline, verification, git. The charter is injected into every session by the plugin's SessionStart hook, so the personal file never has to carry engineering doctrine.

Why split them:

- The engineering half lives in a git repo, so changes are diffable, revertable, and reviewable. Nobody reviews a dotfile.
- One `plugin install` carries the whole practice to a new machine. The personal file stays personal.
- `/flow drift` can audit the charter against the framework and flag stale facts by their as-of dates.
- The context cost is the same: what leaves CLAUDE.md arrives through the hook.

What stays in the personal file: style and tone, hedging calibration, response-format preferences, the autonomy and disagreement contract, system details — and a short pointer so a session can notice a missing charter instead of improvising one. This is what jakub's says:

```markdown
The engineering charter — how we build: delegation, models, pipeline, git, debugging — is
injected every session by the `flow` plugin (SessionStart hook). Deep doctrine, project
setup, and drift audits live in the /flow skill. If a <flow-charter> block is NOT present
in context, the plugin is missing or broken: say so and fix that before substantive
engineering work, don't wing it from memory.
```

Migrating: install the plugin, move the engineering and workflow content out of the personal file (keep a dated backup), add the pointer, start a fresh session, and compare `/flow charter` against what got injected. To change the charter, edit `plugins/flow/charter/charter.md` in your clone, push, and reinstall. It runs about 140 lines, and every one of them is read in every session, so anything that isn't true in every session belongs in a command body or the skill instead.

One caveat: desktop and claude.ai bridge sessions load plugins from service-pushed snapshots with hooks stripped, so the charter doesn't arrive there. The pointer is what makes that visible — the session says the block is missing rather than guessing.
