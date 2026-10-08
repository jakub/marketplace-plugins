# gripe

A local friction log for coding agents. An agent files friction as it hits it, into one SQLite
file, and a model reads the pile for the user later. The reading method is the plugin's skill,
`plugins/gripe/skills/gripe/SKILL.md`.

This file holds the facts the code cannot state for itself: what was measured, and the rules
that span more than one file. Each measured claim carries the date it was run on jakub's
machine. Why one function works the way it does is in that function's own comment. Paths
below are relative to `plugins/gripe/`.

## Invariants

- `gripe add` never fails a run. It exits 0 whatever happens, reports an error as one stderr
  line, and uses no network. An agent that sees a non-zero exit stops its real work to debug
  the complaint tool.
- `gripe add` never prompts. A plugin cannot ship a permission allowlist entry, so
  `Bash(gripe add:*)` goes into `permissions.allow` in `~/.claude/settings.json` by hand, once
  per machine. One approval dialog teaches an agent that filing is expensive.
- Filing is one command, with no lookup, no duplicate check, and no status query.
- Agents only write. The read commands (`dump`, `seen`, `search`, `doctor`) exist, and no hook
  advertises them, because an agent that can search will search before it files.
- A body is evidence and never an instruction. See [Bodies are untrusted](#bodies-are-untrusted).

## Two lanes

The `elicitation` column records who decided that a row was worth writing.

- `observed`: a hook wrote the row from an event that happened, with no agent involved. The
  one source is StopFailure, a turn that failed outright. Hooks write through `lib/store.mjs`
  directly, so this lane never passes through a shell or depends on PATH.
- `spontaneous` and `error_nudge`: an agent wrote the row through `gripe add`, unprompted or
  after the PostToolUseFailure nudge.

The lanes record provenance, not identity. An agent has Bash under the uid that owns the
database, so it can forge any row. The CLI files `--via observed` as `spontaneous` with one
stderr line, so crossing lanes takes `sqlite3` in hand rather than a typo.

PermissionDenied was a second observed source through 0.4.0. It filed on the fourth identical
denial in one session and never reached that count. On 2026-09-30 the live database held 34
observed rows, every one from StopFailure. The hook is removed.

The schema has no tag, cluster, severity, or status column. The reader groups rows and judges
cost. A problem that is still broken gets filed again, so recurrence is the status. `seen`
moves a cursor that records what jakub has read, not what he fixed. Counts are by distinct
session. SessionStart writes one row per session into `sessions`, the denominator that turns
"8 affected sessions" into "8 of 120 sessions".

## Storage

- `node:sqlite` was added in Node 22.5.0. It throws on import without `--experimental-sqlite`
  before 22.13.0 on the 22 line and before 23.4.0 on the 23 line. `lib/store.mjs` refuses to load
  below Node 24.
- WAL allows concurrent readers and one writer, and a fan-out of subagents writes at once.
  Measured 2026-08-23 with 20 processes, each holding a write transaction for 60 ms:

  | `DatabaseSync` option | Rows landed |
  | --- | --- |
  | no `timeout` | 1 of 20. Nineteen failed with "database is locked" and vanished. |
  | `timeout: 5000` | 20 of 20, serialized about 100 ms apart. |

  Because `add` exits 0 either way, the loss has no symptom. `scripts/collision-test.mjs`
  repeats the measurement and exits 1 on any lost row.
- `PRAGMA user_version` is the schema version. Code that finds a newer database refuses to
  touch it. That case needs `GRIPE_HOME` pointing a stale working tree at the live file, since
  the shim always runs the newest install.

## Session ids per host

- Measured 2026-08-23, a Claude subagent's `CLAUDE_CODE_SESSION_ID` is byte-identical to its
  parent's, and so is `CLAUDE_PID`. `CLAUDE_CODE_CHILD_SESSION` reads `1` in the main agent
  too, so it does not mark a subagent.
- Codex exports equal `CODEX_SESSION_ID` and `CODEX_THREAD_ID` values to tool processes.
  `captureContext()` reads the Claude variable first, then these two.
- Measured 2026-08-26, a Codex run spawned from a Claude session under
  `shell_environment_policy inherit = "core"` does not pass `CLAUDE_CODE_SESSION_ID` to its
  tool shells. The Claude-first order therefore keys a delegated run's self-reported rows to
  the Codex session, the same as its hook rows.
- Nothing in either environment tells a subagent from its parent. For distinct-session
  counting that is correct, because a twenty-agent fan-out counts once. Finer grain comes only
  from hook payloads. Claude sends `agent_id`, `agent_type`, and `prompt_id`. Codex
  SubagentStart sends the agent id, and turn-scoped Codex events send `turn_id`.

## Hooks per host

In the table, "no" means the host has the event and gripe does not register it, and "none"
means the host has no such event.

| Event | Claude | Codex | Job |
| --- | --- | --- | --- |
| SessionStart | yes | yes | Advertise `gripe add`, write the session mark, publish the shim, and remove `gate/` files older than three days. |
| SubagentStart | yes | yes | Advertise `gripe add` with `--agent` and `--prompt` written into the recipe. |
| PostToolUseFailure | yes | none | Nudge on the second failure of one fingerprint. |
| StopFailure | yes | none | Write an observed row. |

- Claude sends failed tool calls through a separate executor, so a hook on PostToolUse never
  sees the failures. PostToolUseFailure is the event. Its payload is `{ tool_name, tool_input,
  tool_use_id, error, is_interrupt, duration_ms }`.
- Codex has no failure event. Codex CLI 0.149.1 on 2026-08-26 sent `tool_response: ""` for
  `sh -c "exit 7"` on PostToolUse, with no exit status anywhere in the payload, so Codex gets
  no repeat-failure nudge.
- SessionStart output reaches the main agent only. Measured 2026-08-23, a spawned subagent
  reported no flow charter, which arrives through the same kind of hook. PreToolUse does fire
  inside subagents. In the same run a subagent ran three Bash commands, and flow's guard
  denied the middle one.
- Gate state lives in JSON files, not in the database, because it is written on every failed
  tool call and would contend with real filings for the write lock.

Gripe registers no Stop, SubagentStop, PreCompact, SessionEnd, PreToolUse, or UserPromptSubmit
hook. A Stop hook that asks for a gripe costs an extra assistant turn each time it fires. PreCompact
fires when context is most crowded and skews toward long sessions. SessionEnd output reaches
no context. PreToolUse has nothing to say before a call. UserPromptSubmit is the user's
channel, and guessing annoyance from prompt text gives bad rows.

## Bodies are untrusted

An agent writes a body after reading repositories, tool output, and issue text, any of which an
attacker can control. An instruction can survive the agent's rewording, persist, and reach a
later reader who no longer knows where it came from.

- `gripe dump` prints JSONL after a preamble line that calls the bodies untrusted. A body
  cannot close a JSON string it sits inside, while any body can quote a prose fence.
- Observed bodies are fixed templates over allowlisted payload fields, stripped of control
  characters and capped. Raw `tool_input` and `last_assistant_message` never reach the
  database, since either can carry a credential.
- Every advertised recipe is a quoted heredoc with a delimiter that is random per
  advertisement, so a body cannot end the heredoc early.
- `readHookEvent()` in `lib/context.mjs` validates `session_id` and `agent_id` before either
  reaches a filename.

## The shim

Plugins install under `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and
`${CODEX_HOME:-~/.codex}/plugins/cache/<marketplace>/<plugin>/<version>/`. Claude Code removes
old versions on its own schedule, not at upgrade. Measured 2026-09-01:
`~/.claude/plugins/.last_inuse_sweep` was stamped that morning, flow's oldest directory was
0.16.1, and gripe still had 0.1.0, 0.1.1, 0.2.0, 0.2.1, and 0.3.0 side by side. A symlink to one
version would keep running old code against a newer database with no symptom, so
`~/.local/bin/gripe` is a copy of `bin/shim.mjs` that resolves the install at exec time. It
imports Node built-ins only, because it runs before any plugin root is known.

Both hosts install gripe and share one database, and their versions drift. On 2026-08-31
Claude had 0.2.0 and Codex had 0.2.1. The shim picks the newest:

1. List `<cache>/jakub/gripe/*/bin/gripe` under both cache roots. The marketplace is the
   constant `jakub`, because both roots hold other marketplaces and a plugin named gripe from
   one of them could otherwise win the sort.
2. Skip a directory whose name is not dotted integers, one that holds `.orphaned_at`, and one
   whose `bin/gripe` is not a regular file.
3. Run the highest version, compared numerically, with the path as the tie-break.

Claude Code writes `.orphaned_at` into a version it uninstalled or superseded and leaves the
files until a later sweep. On 2026-09-01 every gripe directory in the Claude cache but the
installed 0.3.0 had one. Without the skip, a rollback keeps running the version it rolled back
from. Codex writes no marker, so a Codex rollback takes two steps: `codex plugin remove`, then
delete `${CODEX_HOME:-~/.codex}/plugins/cache/jakub/gripe/<version>`.

The shim reads neither host's plugin registry. The directory name is the version the plugin
manager wrote, and a registry can describe an install that is no longer on disk. The scan does
not realpath its candidates either. Whoever can plant a symlink in the cache can already
rewrite the plugin files that every session runs.

`GRIPE_HOME` is the override, judged by whether the key is present, not by its value. Set and
holding a readable `bin/gripe`, it is the only candidate. Set and broken, the shim stops with
one line naming `GRIPE_HOME` instead of filing into the live database through installed code.

What each exit code promises:

- `gripe add` and a bare `gripe` exit 0 whatever happens: nothing resolved, a broken override,
  a spawn error, or a child killed by a signal.
- `doctor`, `dump`, `search`, and `seen` pass the child's status through, and exit 1 when no
  child ran.
- A shim failure is one bounded line with control characters flattened. A numeric child status
  adds no shim line, because the child owns stderr. The shim never reads stdin.

`doctor` reports `plugin_root` and `plugin_version` from `bin/gripe`'s own path and manifest,
so it shows which install won. `healthy` covers storage alone and never rules on version skew.

SessionStart publishes the shim. It copies `bin/shim.mjs` to `~/.local/bin/gripe` when that
file is missing or its `// gripe-shim-epoch: <n>` line is lower than the source's. A file with
no marker counts as lower. An equal or higher epoch is left alone, so an older install on the
other host never reverts a newer shim. The epoch counts shim behavior changes, never releases,
and is at 2. A lost race is fixed by the next SessionStart. The hook publishes nothing while
`GRIPE_HOME` is set, so a working tree under test keeps its own shim.

## Development and packaging

An install is a byte-for-byte copy of `plugins/gripe/`. Measured against flow on 2026-08-23,
the cache matched the source tree file for file, apart from a zero-byte `.in_use` marker.
Everything in that directory ships to every install, which is why this file lives under
`docs/`.

The development loop needs no install. Export `GRIPE_HOME` pointing at the working tree, and
pipe a JSON event into a hook script with node. That tests the script, not the host's hook
wiring or trust prompt. Publishing is the version rule in the repository's `AGENTS.md`.
