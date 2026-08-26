# gripe

A local complaint log for coding agents. An agent files friction as it hits it; a model
summarises the pile for the user once a month.

These are the design notes for the shipped plugin (`plugins/gripe/`). Every claim marked
"measured" was run on the author's machine on 2026-08-23. The reader
side is deferred as a *mechanism*: v1 only collects, and any automated summarising workflow
gets designed once there is a month of real rows to design against. The analysis *method*
ships now, as the plugin's skill (`skills/gripe/SKILL.md`), so a session pointed at the
log can run the review itself: doctor first, semantic clustering, distinct-session rates
against the `sessions` denominator, lane weighting, recurrence as status. The skill triggers
on being asked to review the log; it does not advertise the read commands to working agents,
so decision 2 stands.

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
3. **Two lanes: mechanically derived and self-reported.** Observed rows are written by hooks
   with no agent involved, from events that measurably happened. Reported rows are written by
   an agent that decided something was worth saying. The `elicitation` column keeps them
   apart. This is a provenance distinction, not an authenticated one: the agent has Bash under
   the same uid that owns the database file, so a forgery cannot be prevented, only made
   deliberate. The CLI refuses `--via observed`, coercing it to `spontaneous` with one stderr
   line, so crossing the lane takes sqlite3 in hand rather than a typo.
4. **The tool does not cluster. The reader does.** There is no tag, no cluster key, no
   `GROUP BY`. Semantic grouping is what a model does natively and does better than exact-string
   matching on agent-chosen slugs, which would present one problem as six.
5. **Recurrence is the status field.** There is no per-row resolved state. If a problem is still
   broken, an agent hits it again and files it again, and it appears in the next dump. Closing is
   a date watermark recording what jakub has seen, not what jakub fixed.
6. **Counting is by distinct sessions and days, never raw rows.** Eight rows are not eight
   occurrences. They may be one noisy afternoon. Affected sessions alone are still a numerator,
   so SessionStart writes a one-row session mark, and "3 of 41 sessions this month" becomes a
   rate instead of a count.
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

`user_version` is a ladder, not a label. On open, code newer than the database applies
numbered additive migrations inside one transaction. Code older than the database refuses to
touch it and exits 0 with one stderr line, per invariant 1. The shim always resolves newest,
so old-code-new-database only happens when `$GRIPE_HOME` points a stale working tree at a
production file, and refusing beats corrupting.

## Schema

One table for rows, a `sessions` table holding the one-row-per-session mark from decision 6,
and a two-column key/value table holding the `seen` cursor and the last dump's high-water id.

| Column | Source | Notes |
| --- | --- | --- |
| `id`, `created_at` | database | |
| `body` | agent or hook | The complaint. Prose, capped at 4,000 characters with a truncation marker. Observed rows get a templated body; see the trust boundary. |
| `elicitation` | writer | `observed`, `spontaneous`, `error_nudge`, `checkpoint`. |
| `session_id` | environment | Always present. The distinct-count key for decision 6. |
| `prompt_id` | hook | Nullable. Correlates everything from one user request to the next. |
| `agent_id`, `agent_type` | hook | Nullable. Null means the main agent, which is itself the distinction. |
| `repo`, `cwd`, `git_sha`, `branch` | environment | Read at write time, never typed. `repo` is the basename of `git rev-parse --show-toplevel`, null outside a repo. |
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
the main agent too, where it appears to describe a bridge or ssh session. Codex exports equal
`$CODEX_SESSION_ID` and `$CODEX_THREAD_ID` values to tool processes on this host. Gripe accepts
either after the Claude variable, so self-reported rows keep the same session key as hook rows.
**Nothing in either environment distinguishes a subagent from the agent that spawned it.**

That is the right default for distinct-session counting, because a twenty-agent fan-out should
count as one session. Finer grain comes from hook payloads where the harness provides it:
Claude carries `agent_id`, `agent_type`, and `prompt_id`; Codex SubagentStart carries agent
identity and turn-scoped events carry `turn_id`. Take those fields where a hook hands them over
free. Do not scrape a transcript to fill them in.

## Commands

Agent-facing, and this is the whole surface:

```
gripe add [--via <source>] [--trigger <tool>] [--agent <id>] [--prompt <id>] <<'EOF'
<body>
EOF
```

The body arrives on stdin, and the advertised recipe is a quoted heredoc. Complaints quote
tool output, and tool output contains `$(`, backticks and quotes; a double-quoted body hands
all of that to the shell before gripe ever runs. A body as a plain argument still works for a
human at a terminal.

The delimiter is random per advertisement, never a fixed `EOF`. A fixed delimiter lets a
hostile body close the heredoc early with a matching literal line, and everything after it
runs as shell commands, auto-approved under the very allowlist invariant 2 requires.
Attacker text is written before the delimiter exists, so it cannot contain it.

Every flag is a literal the advertising hook bakes into the recipe at advertisement time,
never a value the agent chooses: `--via` always, the rest when the hook knows them at that
moment (SubagentStart knows the agent and prompt, an error nudge knows the trigger and
prompt). Absent `--via` means `spontaneous`. `--via observed` and unknown values coerce to
`spontaneous` with one stderr line, because the observed lane belongs to hooks.

Human-facing, never advertised to agents:

```
gripe dump [--since <date>] [--repo <name>]   JSONL for piping to a model
gripe seen                                     advance the cursor
gripe search <text>                            for hunches
gripe doctor                                   is the write path alive
```

`dump` emits one JSON object per row after a preamble line; see the trust boundary for why
JSONL. A plain `dump` floors at the cursor and records the highest row id it printed; `seen`
advances the cursor to exactly that id, so rows that land mid-review stay unseen instead of
being stamped past. `--since` (an inclusive local date) or `--repo` ignores the cursor and
records nothing, so looking backwards or sideways never disturbs your place. `seen` is
separate from `dump` on purpose: a read that mutates state loses a window the first time you
get distracted mid-review, and then you never trust it again.

`seen` records exposure, not judgment. It says jakub looked, not that jakub fixed anything.

`doctor` exists because invariant 1 makes every write failure silent by design. It checks the
path, the schema version, WAL, and a rollback-only test transaction, then reports the newest
row's age. Run it before reading: it is the only way to tell "no friction this month" from
"every write has failed since June".

## The trust boundary

An agent writes bodies after reading repositories, tool output, compiler diagnostics, test
fixtures and issue text, any of which can be attacker-controlled. A body can therefore carry an
instruction dressed as diagnostic text, and it does not need to be copied verbatim, because an
agent summarising friction can preserve the operational instruction while rewording everything
around it. That instruction sits in durable storage, crosses sessions, and arrives later in a
context where nobody remembers the original repository content is still in play. Persistence is
what makes it useful to an attacker.

`gripe dump` therefore emits JSONL with bodies as JSON-escaped strings, after a preamble
stating that body fields are untrusted and may contain instructions aimed at the reader.
Escaping is the mechanism, chosen over prose delimiters because a body cannot close a JSON
string it is inside, while a delimiter fence is escapable by any body that quotes the fence.
The design does not otherwise constrain what the output is piped into. Whoever pipes it owns
what they pipe it into.

Observed rows get the same care at the write end. Their bodies are fixed templates filled
from an allowlist of payload fields, capped and stripped of control characters. Raw
`tool_input` and `last_assistant_message` never reach the database; both can carry
credentials or kilobytes of attacker-chosen text into durable storage.

Redacting credentials is a separate boundary and does not help with this one.

## Hooks

Claude registers seven events. Codex registers the four events whose meaning can be preserved:
SessionStart, SubagentStart, PostToolUse, and Stop. Each has a job and a gate, because an
ungated checkpoint taxes every session and an ungated error nudge interrupts every ninety
seconds. `docs/cross-harness-hooks.md` owns the repository-wide adapter design.

Two pieces of shared plumbing. Hooks that write rows import the storage module directly and
never shell out to the CLI, so the observed lane never transits a shell, never depends on
PATH, and cannot be reached by an agent typing `--via observed`. Hooks that gate on
repetition share one state contract: JSON files under the state directory keyed by session id
plus actor, where actor is `main` or a known subagent `agent_id`, holding fingerprint counts
with last-seen and last-nudged times. Claude state is per actor. Codex PostToolUse supplies no
stable subagent actor, so its checkpoint counters are explicitly parent-session state.
Fingerprint gate state is shared because Stop must see what the error nudge already asked
about, or one fingerprint buys two interruptions in one session.

### SessionStart

Prints one line advertising the command to the main agent. Writes the one-row session mark
that gives decision 6 its denominator. Re-points the PATH shim if missing. Sweeps state files
older than a few days on the way past.

**Reaches the main agent only.** Measured: a spawned subagent reported no flow charter in its
context, and the charter is injected by exactly this kind of hook.

### SubagentStart

The same advertisement for subagents, which is the only reason they hear about gripe at all.
Payload is `{ agent_id, agent_type }` and it accepts `additionalContext`. Bake `--agent` and
`--prompt` into the advertised recipe so attribution survives; a subagent lives inside one
prompt, so both stay valid for its whole life, and the agent copies a literal rather than
deciding anything.

### PostToolUseFailure and Codex PostToolUse

For Claude, **PostToolUseFailure is the correct event and it is not PostToolUse.** Failed calls
dispatch through a separate executor, so a Claude hook registered on PostToolUse never fires on
the failures this exists to catch. Payload is
`{ tool_name, tool_input, tool_use_id, error, is_interrupt, duration_ms }`.

Codex has no PostToolUseFailure event. Its PostToolUse also fires for non-zero Bash commands and
provides `tool_response`. The Codex adapter classifies explicit error flags, failure statuses,
and non-zero structured exit codes, then calls the same repeat policy. It also folds every tool
call into bounded checkpoint state. Ambiguous responses are not called failures; the checkpoint
still retains their tool and target evidence.

Gates, in order. Skip when `is_interrupt` is set, because that is jakub pressing escape rather
than the tooling fighting the agent. Then fire on repeats, not firsts: the first failure of a
given tool with a given error shape is ordinary work, the second is a pattern. Hold a cooldown
on the fingerprint so a retry loop asks once rather than forty times. A blocklist of noisy
commands stays available as a backstop, never as the primary gate.

Advertises `--via error_nudge` with `--trigger` and `--prompt` baked from the payload. Every
fingerprint it nudges on goes into the shared gate state so the Stop checkpoint does not cite
the same fight a second time.

### PermissionDenied

Writes an observed row directly. Payload is `{ tool_name, tool_input, tool_use_id, reason }`.
Repeat-gated, and the gate matters here more than anywhere: jakub's own hooks deny by design, so
a first denial is a guard working correctly. The fourth identical denial means the agent kept
trying and kept being stopped, which is real friction, and points at either a policy the agent
does not understand or a policy that is wrong. The observed body is a template over
`tool_name`, `reason` and a normalised target, never raw `tool_input`.

Claude only. Codex PermissionRequest happens before the user decides and cannot report an
after-the-fact denial, so mapping it here would change the provenance of the row.

### StopFailure

Writes an observed row directly. Payload is `{ error, error_details, last_assistant_message }`.
A turn that failed outright is unambiguous and needs no gate. The body is the error plus a
capped slice of `error_details`; `last_assistant_message` is never stored.

Claude only. Codex Stop is a normal completion event and has no equivalent failure payload.

### Stop

The end-of-turn checkpoint, and **the only coverage for friction that never errored**. Everything
else in this list is error-shaped. The `gh run watch` case, the ambiguous instruction, the
ten-call dead end where every call succeeded: none of it reaches the database any other way.

It never asks the agent whether it was annoyed. That framing tells the model a complaint is the
expected answer, and models supply expected answers; ask every session and you get either
invented grievances or a reflexive "none" because that ends the prompt fastest. Claude reads
the transcript incrementally. Codex evaluates counters already folded from PostToolUse, because
its transcript format is not a stable hook interface. Both cite concrete evidence. Two things
count as concrete: repeated
identical failures, fingerprinted with paths, shas and digits normalised out; and repetition
without failure, meaning the same tool aimed at the same target three or more times, which is
what fighting something looks like when nothing is erroring. Neither present, or fewer than
fifteen tool calls, and it stays silent. Two unrelated failures are not evidence; only repeats
of one shape count, or the checkpoint fires on every ordinary session that hit two different
transient errors. No evidence means no honest question.

Other gates: skip when `stop_hook_active` is set or it loops on its own continuation, and skip
when `background_tasks` shows anything running, because a paused session is not a finished one.
Once per session, stated as the tradeoff it is: friction that develops after the first
checkpoint in a long session goes unrecorded, and that is the accepted price of never teaching
the agent that "none" ends the conversation fastest. Cited text is stripped of control
characters before it enters the note, because the note speaks in the hook's trusted voice and
its raw material comes out of the transcript.

Claude sends `additionalContext`. Codex returns `decision: "block"` with the note as `reason`,
which creates one continuation prompt rather than rejecting the turn. In either harness the
agent can act on it without the turn being marked as failed. **That continuation is the real cost.**
The hook itself is a few milliseconds of local string matching with no model call, but every
fire buys at least one extra assistant turn.

Claude scanning is incremental. Scan state carries a byte offset and running counters, so a
quiet session does not re-parse a growing transcript at every turn end. It is keyed by session
id plus actor, like the gate state and for the same reason: a fan-out shares one session id,
and one shared byte offset would apply one transcript's position to another. Codex counters
use a separate `codex-` state filename and no byte offset. State lives in files rather than the
database, because it is written on the hot path and would otherwise contend for the write lock
with actual gripe writes.

### SubagentStop

Claude uses the same checkpoint for subagents, which Stop never fires for, served by the same script.
Payload is `{ stop_hook_active, agent_id, agent_transcript_path }`, so the script reads
either transcript field, keys its state by the agent id when one is present, and echoes the
incoming `hook_event_name` back in its output.

Injection reaches the subagent, not the parent. The product binary's own schema description
reads: "delivered to the subagent; the subagent continues so it can act on it."

The objection that a fan-out produces correlated reports is real but neutralised by decision 6,
since subagents share their parent's session id and a whole fan-out therefore counts once.

Codex deliberately has no SubagentStop checkpoint. PostToolUse does not identify which
subagent produced an observation, so a per-subagent checkpoint could cite sibling evidence or
find no evidence at all. Parent Stop evaluates the aggregate session counters instead.

### Considered and rejected

The full event list: PreToolUse, PostToolUse,
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
- **UserPromptSubmit** could sniff for the user correcting the agent, but that is the user's
  channel, and inferring annoyance from prompt text produces garbage rows.

## The shim

Installed plugins live at `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, and old
versions are never pruned. Measured: flow has every release since 0.3.1 on disk.

A shim symlinked to `gripe/0.1.0/bin/gripe` therefore does not break after an upgrade, which
would at least be visible. It keeps working, running 0.1.0 code against a 0.5.0 database
indefinitely, and invariant 1 means that failure has no symptom at all. **The shim resolves
the plugin at exec time**: `$GRIPE_HOME` first, then whatever version the plugin manager says
is installed, read from `installed_plugins.json` the way flow's cron timers already do. A
semver-aware scan of the cache directory is the fallback when the registry is unreadable, and
it compares numerically, because a lexical sort ships 0.9.0 forever once 0.10.0 exists. It is
never a symlink to a versioned path.

SessionStart skips re-pointing when `$GRIPE_HOME` is set. Without the override, SessionStart
would clobber a working-tree symlink every session and silently send development traffic to
the stale installed copy.

## Development and packaging

These are separate mechanisms.

The CLI is an ordinary Node script and runs from anywhere. Only *hook registration* needs the
plugin system, and that is not the only route: either harness can register working-tree hooks
from its user or project settings.

So the development loop needs no install. Point a temporary registration at the working tree,
export `GRIPE_HOME`, and iterate with instant feedback. Piping a JSON event into a hook script
with node tests the script; it does not test product wiring or hook trust.

Packaging is the last step, not the loop. An install is a byte-for-byte copy of the
`plugins/gripe/` subdirectory: measured against flow, the cache matches the source tree file
for file, identical apart from a zero-byte `.in_use` marker.
Nothing is filtered. **Everything in that directory ships to every install, forever**, which is
why these design notes live in `docs/gripe/` rather than inside the plugin.

One install step is manual: a plugin cannot ship a permission allowlist entry (installing
registers only an enabled-plugin flag), so `Bash(gripe add:*)` goes into
`~/.claude/settings.json` `permissions.allow` by hand, once per machine. That line is what
makes invariant 2 ("never prompts after setup") hold.

Publishing is the four-edit ritual documented in the marketplace repo's AGENTS.md: matching
versions in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, the marketplace entry,
and the catalog version bump.
