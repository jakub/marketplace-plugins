# The CLAUDE.md split

The principle: `~/.claude/CLAUDE.md` answers **who the user is** — voice, tone,
epistemic calibration, interaction contract (how to disagree, when to ask, how to batch
questions). The flow **charter** answers **how we build** — delegation, model routing,
pipeline rules, verification semantics, git discipline — and is injected into every
session by this plugin's SessionStart hook.

Why split:

- **Versioned**: the engineering half lives in a git repo instead of a loose dotfile;
  changes are diffable, revertable, and reviewable.
- **Portable**: one `plugin install` carries the whole practice to a new machine; the
  personal file stays personal.
- **Drift-auditable**: `/flow drift` can lint the charter against the framework; nobody
  lints a dotfile.
- **Same cost**: what leaves CLAUDE.md arrives via the hook — net context is ~flat.

What stays in the personal CLAUDE.md: style/tone, reasoning and hedging calibration,
response-format preferences, anti-patterns, disagreement and autonomy contracts — plus a
short pointer so sessions can DETECT a missing charter instead of improvising:

```markdown
<flow>
the engineering charter — how we build: delegation, models, pipeline, git, debugging — is
injected every session by the flow plugin (SessionStart hook). deep doctrine, project
setup, and drift audits live in the /flow skill. if a <flow-charter> block is NOT present
in context, the plugin is missing or broken: say so and fix that before substantive
engineering work, don't wing it from memory.
</flow>
```

Migration: install the plugin, move engineering/workflow/debugging content out of the
personal file (keep a dated backup), add the pointer block, start a fresh session, and
compare `/flow charter` output against what got injected. Customise the charter by editing
`plugins/flow/charter/charter.md` in your clone and reinstalling — it is deliberately
short (~80 lines); every line is a standing order paid for in every session's context.
