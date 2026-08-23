# gripe

A local complaint log for coding agents. An agent files friction as it hits it; a model
summarises the pile for jakub once a month.

Status: designed and partly measured. The Stop hook is built and tested. The CLI is not
written yet. Every claim marked "measured" was run on this machine on 2026-08-23.

## What it is

Agents hit friction in every session and forget it at the end of every session. `gh run watch`
exits 0 even when a check failed, so an agent believes CI passed and moves on. Nothing errored,
nothing logged, and the knowledge dies at compaction. Next week a different agent pays the same
cost.

Gripe writes that down. One SQLite file, local only, no server and no sync. The agent is the
only writer. A model is the reader, and jakub reads what the model says.

## Invariants

A violation of any of these kills the write path silently, which is why they sit above the
design decisions rather than among them.

- **`gripe add` never fails a run.** Exit 0 unconditionally, errors to stderr as one line, no
  network, no prompts. An agent that sees a non-zero exit stops its real work and starts
  debugging the complaint tool.
- **`gripe add` never triggers a permission prompt.** The plugin ships `Bash(gripe add:*)` on
  the allowlist. One approval dialog teaches an agent that filing is expensive and it stops.
- **Filing costs one command and no reading.** No lookup, no duplicate check, no status query.
  Every field an agent has to think about is a reason to skip filing.
- **Bodies are evidence, never instruction.** See the trust boundary section.

## Decisions

1. **Writers are every session, including subagents and ad-hoc work.** Most friction happens
   outside the /flow pipeline. The two populations are reached by different events; see hooks.
2. **Agents are write-only.** `gripe add` is the entire agent-facing surface. The read commands
   exist and are never advertised. An agent that can search will search before struggling,
   which turns a two-second write into a research task.
3. **Two lanes, and they are not equally trustworthy.** Observed rows are written by hooks with
   no agent involved, from events that measurably happened. Reported rows are written by an
   agent that decided something was worth saying. The `elicitation` column keeps them apart.
4. **The tool does not cluster. The reader does.** There is no tag, no cluster key, no
   `GROUP BY`. Semantic grouping is what a model does natively and does better than exact-string
   matching on agent-chosen slugs, which would present one problem as six.
5. **Recurrence is the status field.** There is no per-row resolved state. If a problem is still
   broken, an agent hits it again and files it again, and it appears in the next dump. Closing is
   a date watermark recording what jakub has seen, not what jakub fixed.
6. **Counting is by distinct sessions and days, never raw rows.** Eight rows are not eight
   occurrences. They may be one noisy afternoon. Raw counts have no denominator and cannot
   separate more friction from more coding.
7. **No open-count banner at session start.** One advertisement line and nothing else. Printing
   open items into every session is context tax for something read monthly.
8. **Storage is SQLite via `node:sqlite`** at `$XDG_STATE_HOME/gripe/gripe.db`, defaulting to
   `~/.local/state/gripe/gripe.db`. State, not data: history nobody would back up or sync.
9. **Delivery is a plugin in the jakub marketplace.** Flow gets a one-way soft dependency: its
   journal stages mention gripe when installed and work fine when it is not. Nothing in gripe
   knows about flow.
10. **Invocation is a `gripe` shim on PATH** at `~/.local/bin/gripe`, resolving the plugin at
    exec time. See the shim section, which has a sharp edge.

## Storage

`node:sqlite` needs Node 24 or newer. It exists from 22.5 but throws on import without
`--experimental-sqlite` until 23.4, so "built into Node 22" is wrong in the way that costs an
afternoon. Check the version at startup and exit 0 with one stderr line below the floor.

WAL allows concurrent readers alongside a single writer. It does not let parallel subagents
write at once, and a twenty-agent fan-out will try. Measured with twenty processes each holding
a transaction open for 60ms to force collisions:

| configuration | rows landed |
| --- | --- |
| no `timeout` option | 1 of 20. Nineteen failed with "database is locked" and vanished. |
| `timeout: 5000` | 20 of 20, serialised roughly 100ms apart. |

Losing 95 percent of a fan-out is the default behaviour, and because the write path exits 0
regardless, it is invisible. So: WAL on, a generous `timeout` passed to the `DatabaseSync`
constructor, nothing inside the transaction that could be done outside it, one retry on a busy
failure, and `PRAGMA user_version` set at creation.

## Schema

One table for rows, plus a two-column key/value table holding the `seen` watermark.

| Column | Source | Notes |
| --- | --- | --- |
| `id`, `created_at` | database | |
| `body` | agent or hook | The complaint. Prose. Observed rows get a body generated from the hook payload. |
| `elicitation` | writer | `observed`, `spontaneous`, `error_nudge`, `checkpoint`. |
| `session_id` | environment | Always present. The denominator. |
| `prompt_id` | hook | Nullable. Correlates everything from one user request to the next. |
| `agent_id`, `agent_type` | hook | Nullable. Null means the main agent, which is itself the distinction. |
| `repo`, `cwd`, `git_sha`, `branch` | environment | Read at write time, never typed. |
| `trigger` | hook | Nullable. The tool that provoked the row. |

Three things are deliberately absent. **No `tag` or `cluster`**, because the reader groups.
**No `kind` or `sev`**, because both ask an agent to classify its own experience and neither
answer is observable; a self-reported 1-3 rating is mostly tone, and cluster size measures
frequency rather than severity anyway. **No `status`, `issue` or `model`**: the first two have
nothing to attach to now that closing is a watermark, and the third would need transcript
scraping, which this design rejects everywhere else.

### What the environment can and cannot tell you

Measured, not assumed. A subagent's `$CLAUDE_CODE_SESSION_ID` is byte-identical to its parent's,
and so is `$CLAUDE_PID`. `$CLAUDE_CODE_CHILD_SESSION` is not a subagent marker; it reads `1` in
the main agent too, where it appears to describe a bridge or ssh session. **Nothing in the
environment distinguishes a subagent from the agent that spawned it.**

That is the right default for the denominator, because a twenty-agent fan-out should count as one
session. Finer grain comes from hook payloads, which carry `agent_id` and `agent_type`, and from
the common hook input base, which carries `prompt_id`. Take those where a hook hands them over
free. Do not scrape the transcript to fill them in.

## Commands

Agent-facing, and this is the whole surface:

```
gripe add [--via <source>] "<body>"
```

`--via` is a literal the hook bakes into the command it advertises, never a value the agent
chooses. Absent means `spontaneous`.

Human-facing, never advertised to agents:

```
gripe dump [--since <date>] [--repo <name>]   rows for piping to a model
gripe seen                                     stamp the watermark
gripe search <text>                            for hunches
```

`dump` with no `--since` floors at the watermark. Passing `--since` ignores the watermark
entirely, so looking backwards never disturbs your place. `seen` is separate from `dump` on
purpose: a read that mutates state loses a window the first time you get distracted mid-review,
and then you never trust it again.

`seen` records exposure, not judgment. It says jakub looked, not that jakub fixed anything.

## The trust boundary

An agent writes bodies after reading repositories, tool output, compiler diagnostics, test
fixtures and issue text, any of which can be attacker-controlled. A body can therefore carry an
instruction dressed as diagnostic text, and it does not need to be copied verbatim, because an
agent summarising friction can preserve the operational instruction while rewording everything
around it. That instruction sits in durable storage, crosses sessions, and arrives later in a
context where nobody remembers the original repository content is still in play. Persistence is
what makes it useful to an attacker.

`gripe dump` therefore wraps every body in explicit data delimiters, with a preamble stating
that the enclosed text is untrusted and may contain instructions aimed at the reader. The
delimiters and the warning are the mechanism; the design does not otherwise constrain what the
output is piped into. Whoever pipes it owns what they pipe it into.

Redacting credentials is a separate boundary and does not help with this one.

## Hooks

Seven events. Each has a job and a gate, because an ungated checkpoint taxes every session and
an ungated error nudge interrupts every ninety seconds.

### SessionStart

Prints one line advertising the command to the main agent. Re-points the PATH shim if missing.
Sweeps scan-state files older than a few days on the way past.

**Reaches the main agent only.** Measured: a spawned subagent reported no flow charter in its
context, and the charter is injected by exactly this kind of hook.

### SubagentStart

The same advertisement for subagents, which is the only reason they hear about gripe at all.
Payload is `{ agent_id, agent_type }` and it accepts `additionalContext`. Bake the agent id into
the advertised command string so per-agent attribution survives; the agent copies a literal
rather than deciding anything.

### PostToolUseFailure

**This is the correct event and it is not `PostToolUse`.** Failed calls dispatch through a
separate executor, so a hook registered on `PostToolUse` never fires on the failures this exists
to catch. Payload is `{ tool_name, tool_input, tool_use_id, error, is_interrupt, duration_ms }`.

Gates, in order. Skip when `is_interrupt` is set, because that is jakub pressing escape rather
than the tooling fighting the agent. Then fire on repeats, not firsts: the first failure of a
given tool with a given error shape is ordinary work, the second is a pattern. Hold a cooldown
on the fingerprint so a retry loop asks once rather than forty times. A blocklist of noisy
commands stays available as a backstop, never as the primary gate.

Advertises `--via error_nudge` and pre-fills `trigger` from the payload.

### PermissionDenied

Writes an observed row directly. Payload is `{ tool_name, tool_input, tool_use_id, reason }`.
Repeat-gated, and the gate matters here more than anywhere: jakub's own hooks deny by design, so
a first denial is a guard working correctly. The fourth identical denial means the agent kept
trying and kept being stopped, which is real friction, and points at either a policy the agent
does not understand or a policy that is wrong.

### StopFailure

Writes an observed row directly. Payload is `{ error, error_details, last_assistant_message }`.
A turn that failed outright is unambiguous and needs no gate.

### Stop

The end-of-turn checkpoint, and **the only coverage for friction that never errored**. Everything
else in this list is error-shaped. The `gh run watch` case, the ambiguous instruction, the
ten-call dead end where every call succeeded: none of it reaches the database any other way.

It never asks the agent whether it was annoyed. That framing tells the model a complaint is the
expected answer, and models supply expected answers; ask every session and you get either
invented grievances or a reflexive "none" because that ends the prompt fastest. Instead it reads
the transcript, finds something concrete, and cites it. Two things count as concrete: repeated
identical failures, fingerprinted with paths, shas and digits normalised out; and repetition
without failure, meaning the same tool aimed at the same target three or more times, which is
what fighting something looks like when nothing is erroring. Neither present, or fewer than
fifteen tool calls, and it stays silent. No evidence means no honest question.

Other gates: skip when `stop_hook_active` is set or it loops on its own continuation, and skip
when `background_tasks` shows anything running, because a paused session is not a finished one.
Once per session.

`additionalContext` on Stop is non-error feedback and the conversation continues, so the agent
can act on it without the turn being marked as failed. **That continuation is the real cost.**
The hook itself is a few milliseconds of local string matching with no model call, but every
fire buys at least one extra assistant turn.

Scanning is incremental. Per-session state carries a byte offset and the running counters, so a
quiet session does not re-parse a growing transcript at every turn end. State lives in files
rather than the database, because it is written at every turn end and would otherwise contend
for the write lock with actual gripe writes.

### SubagentStop

The same checkpoint for subagents, which Stop never fires for. Payload is
`{ stop_hook_active, agent_id, agent_transcript_path }`.

Injection reaches the subagent, not the parent. The product binary's own schema description
reads: "delivered to the subagent; the subagent continues so it can act on it."

The objection that a fan-out produces correlated reports is real but neutralised by decision 6,
since subagents share their parent's session id and a whole fan-out therefore counts once.

### Considered and rejected

The full event list is longer than early drafts assumed: PreToolUse, PostToolUse,
PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion,
SessionStart, SessionEnd, Setup, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact,
PostCompact, PermissionRequest, PermissionDenied, TeammateIdle, TaskCreated, TaskCompleted,
Elicitation, ElicitationResult, ConfigChange, InstructionsLoaded, DirectoryAdded, CwdChanged,
FileChanged.

- **PreCompact** duplicates Stop's question in a subset of sessions, fires when context is most
  crowded and introspection least reliable, and skews toward long sessions in a way that
  corrupts the distinct-days metric.
- **SessionEnd** cannot nudge anything, since its output reaches no context. Its only real job
  was pruning state files, and SessionStart does that for free while managing the shim. Running
  `wal_checkpoint(TRUNCATE)` there is unnecessary at this volume and can collide with a session
  still writing.
- **PreToolUse** fires before every call and has nothing to say. Worth recording that it does
  fire for subagents: measured by having a subagent run three Bash commands, where the middle
  one tripped flow's PreToolUse guard and came back denied while the controls either side ran
  normally. That is the evidence that tool-call hooks reach subagents at all.
- **Notification** covers permission prompts and idle, but `PermissionDenied` carries the same
  friction with a structured payload.
- **UserPromptSubmit** could sniff for the user correcting the agent, but that is jakub's
  channel, and inferring annoyance from prompt text produces garbage rows.

## The shim

Installed plugins live at `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, and old
versions are never pruned. Measured: flow has every release from 0.3.1 to 0.16.1 on disk.

A shim symlinked to `gripe/0.1.0/bin/gripe` therefore does not break after an upgrade, which
would at least be visible. It keeps working, running 0.1.0 code against a 0.5.0 database
indefinitely, and invariant 1 means that failure has no symptom at all. **The shim resolves the
plugin at exec time and picks the highest version present.** It is never a symlink to a versioned
path.

It also honours `$GRIPE_HOME` ahead of the cache, and SessionStart skips re-pointing when that
is set. Without the override, SessionStart would clobber a working-tree symlink every session
and silently send development traffic to the stale installed copy.

## Development and packaging

These are separate mechanisms and early drafts conflated them.

The CLI is an ordinary Node script and runs from anywhere. Only *hook registration* needs the
plugin system, and that is not the only route: `~/.claude/settings.json` registers hooks by
absolute path, which this machine already does for `sudo-confirm.sh`.

So the development loop needs no install. Register the hooks in settings.json pointing at the
working tree, export `GRIPE_HOME`, and iterate with instant feedback. Piping a JSON event into a
hook script with node tests the script; it does not test the wiring.

Packaging is the last step, not the loop. An install is a byte-for-byte copy of the
`plugins/gripe/` subdirectory: measured against flow, 37 files and 380K in the source tree, 37
files and 380K in the cache, identical top-level listing apart from a zero-byte `.in_use` marker.
Nothing is filtered. **Everything in that directory ships to every install, forever**, which is
why these design notes live in `docs/gripe/` rather than inside the plugin.

Publishing is the three-edit ritual documented in the marketplace repo's CLAUDE.md: the plugin
directory with its `.claude-plugin/plugin.json`, a manifest entry with
`"source": "./plugins/gripe"`, and a catalog version bump.

## Open

- **Confirm PostToolUseFailure fires for subagent tool calls.** PreToolUse is verified to and the
  two share a mechanism, so this is a confirmation rather than an open risk. Fold it into the
  first install test.
- **Tune the gate thresholds.** Fifteen tool calls, two identical failures, three repetitions on
  one target. All guesses, all cheap to change.
- **Behaviour when `$XDG_STATE_HOME` and `$HOME` are both unusable.** Covered by invariant 1, but
  `$CLAUDE_CODE_ENVIRONMENT_KIND` reads `bridge` in some of jakub's day-to-day sessions, so this
  is not exotic and the CLI should be exercised there deliberately.
