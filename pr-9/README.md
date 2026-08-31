# PR #9 live-capture evidence (issue #6, slice 3)

Codex host: codex-cli 0.151.0, flow 0.28.0 and grill 0.5.0 installed from the branch with
`codex plugin marketplace add jakub/marketplace-plugins --ref feat/issue-6-prep-stage` and
refreshed with `codex plugin marketplace upgrade jakub` after each fix (the commit each capture
ran at is named below). Claude host: Claude Code 2.1.251 with the branch's plugins loaded by
`--plugin-dir` in print mode. All captures ran against `jakub/flow-land-scratch`, a private
repository that exists for these tests, on 2026-08-30. Secret sweeps over every file: clean.

## The V2-child hook probe (AC: hooks fire inside a spawn_agent child)

Branch at dc1bdc0. A parent `codex exec` (sandbox workspace-write) spawned one native child
(`fork_turns: "none"`, gpt-5.6-luna, low) told to run an unsanctioned issue create and
`git push --no-verify`. Both were blocked inside the child by flow's PreToolUse hooks.

- `capture-child-hooks.txt` - the `script` transcript of the parent session, ending in the
  child's verbatim report and the parent's classification of each denial.
- `capture-child-hooks.parent-events.jsonl` - the parent's `--json` event stream from a second
  identical run, showing the `collab_tool_call` (the spawn) and the two error items.
- `capture-child-hooks.parent-rollout.jsonl` - that parent's full rollout, where the
  `spawn_agent` call carries `fork_turns: "none"`, `model: gpt-5.6-luna`, `reasoning_effort: low`.
- `capture-child-hooks.child-rollout.jsonl` - the child's own rollout. Its `session_meta.source`
  is `subagent.thread_spawn` with the parent's thread id at `depth: 1`, and both denial strings
  ("no-backlog policy (flow)" and "flow charter: NEVER --no-verify") sit in its transcript.

This is what flipped `hooks-in-native-children` to codex true/mechanism (18fa369). Plain
`git push` was not probed because git-guard allows it by design; `--no-verify` is the push the
hook gates.

## The Claude prep (AC: outcome unchanged through the installed alias)

Branch at ebba413, `claude -p --plugin-dir …/plugins/flow --plugin-dir …/plugins/grill`.
Print mode has no AskUserQuestion (the same limitation slice 1 recorded), so the stage was
told to write out each question, take its recommended option, and journal that it did.

- `capture-prep-claude-trivial.txt` - first run, a SECURITY.md idea. Fully specified, so the
  stage took the triviality exit: shipped the file to scratch main (cbd3050) and stopped, no
  issue. Kept because it is the stage working, and because its report quotes the new body's
  §7 wording, which proves the alias loaded the stage and not the old command.
- `capture-prep-claude.jsonl` - second run, a markdown link-check workflow with real forks,
  as a stream-json transcript. It shows the alias reading `skills/prep-stage/profiles/claude.md`
  then `SKILL.md`; two sonnet `Explore` scouts and a `delegate_to_codex` outside seat
  (gpt-5.6-sol, medium); the native leg as `flow:code-architect` on opus against a
  `delegate_to_codex` bridge (gpt-5.6-sol, high) and a `delegation_continue` critique; grill
  through the Skill tool (`grill:grill-with-docs` → `grilling` + `domain-modeling`); and
  scratch issue #3 created with the exact `## Acceptance Criteria` heading (11 criteria),
  `ready-for-agent`, and a journal comment. 40 turns.
- `capture-prep-claude-final.txt` - that run's closing message.

## The Codex prep (AC: a live Codex prep, free-text mode)

`capture-prep-codex.txt` is one `script` transcript across every turn of a single Codex
session, driven with `codex exec` and `codex exec resume` so each suspended-turn question and
its answer are real. It records, in order: the profile read, three native luna scouts, the
triviality gate suspending with two options (answered 2); the native Sol leg starting and
Codex's own risk policy refusing the `delegate_to_claude` call for a private repository, which
the stage turned into a suspended trust-fork question (answered 1); the anchor re-read and the
bridge failing `NO_ROOTS`; the clean stop with nothing created. Then, after the PWD fix
(ebba413) and the model-id fix (6e91e1c) were installed, the resumed session's dialectic,
critique, grill, and finalize. Three root causes surfaced by this capture and fixed on the
branch: the user-bus environment (f7a2952), the workspace root (ebba413), the bridge model
ids (6e91e1c). Turns 1-3 ran at dc1bdc0, turn 4 onward at 6e91e1c.

Outcome, after ten turns: scratch issue #4 ("docs: explain how work enters the repository")
created through `FLOW_SANCTION=prep`, four criteria each with an `evidence:` sub-bullet and
`surface: code`, a prep journal comment carrying a per-seat table (lane, model, fork policy,
access assurance, descendant assurance), `ready-for-agent` applied and `needs-triage` removed,
and the hand-off line in the profile's exact form with both prohibitions. Three suspended
grill rounds, one question each. The Fable blind leg ran as job `8ba8e611` (claude-fable-5,
xhigh - the subject is copy); two continuations died in a provider outage window
(`WORKER_EXIT`, CLAUDE_VERSION/CLAUDE_AUTH failing for about twenty minutes, nothing local
running), the seat refused to retry into an unhealthy provider, and the third continuation
completed the critique once the doctor was green. Turn 5 is the `skill-composition`
evidence: `grill-with-docs/SKILL.md` read from the installed grill 0.5.0, then
`../grilling/SKILL.md` and `../domain-modeling/SKILL.md` per patch 0005, and the grill run
under them. The repository was never touched: `HEAD` stayed at cbd3050 throughout.

## The no-grill run (AC: the inline grill fallback)

Branch at b50f4f0. `codex plugin remove grill@jakub`, a fresh `codex exec` in the scratch
checkout with a RUNBOOK.md idea, turn 1 only. `capture-prep-nogrill.txt` shows the scouts, the
dialectic (both legs and both continues on the first try this time, the bridge working from a
Codex host), and then the grill gate: "`$grill:grill-with-docs` does not resolve on this host.
It is absent from both the active skill registry exposed to this session and the callable
tool registry. I'm therefore running the prep stage's inline grill, one suspended question
per turn", followed by a three-option suspended round. The session was left there on purpose;
the criterion is the fallback, not a third scratch issue. Codex was then restored to the
GitHub main marketplace (flow 0.27.0, grill 0.4.2) until this PR lands.

## The grill vendor proof (AC: vendored tree = upstream + patches 0001-0005)

`capture-grill-vendor-diff.txt` - the M5 seat's transcript: fetch upstream `5b15a47`, build a
generation tree (upstream, 0001..0004, the three edits, `git diff -M` into 0005), then on a
second fresh upstream copy apply 0001..0005 and `diff -r` against the branch's
`plugins/grill/skills/`. Empty diff.
