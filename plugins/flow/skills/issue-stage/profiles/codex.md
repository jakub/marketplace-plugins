# issue-stage host profile: Codex

Read this with `SKILL.md`. The stage is host-neutral prose; this file says what each of its
`[[gate:<id>]]` markers binds to in a Codex session. Where a gate has nothing host-specific
about it, the section says so rather than inventing a difference.

There is no in-turn question tool here, and a PreToolUse hook cannot ask for confirmation: as of
Codex CLI 0.151.0 an `ask` result reads as a hook failure and the command runs anyway. So the
human-choice binding is the suspended turn. Write the question, list up to 4 numbered options
with a one-line consequence each and the recommended one first, then end the turn. The human's
next message is the answer. Do not guess an answer to keep the run moving, and do not stack two
questions into one suspension.

There is no tool-allowance line on this host: a plugin skill carries no per-skill allowlist, and
the session's sandbox and approval policy apply as they are. The same absence reaches the seats
below: nothing narrows a native child, which is why two of its three dimensions read `contract`.
The other host's native writer reads `contract` on descendants for its own reason, so do not
expect this row to be the odd one out. State it in the ledger and compose inside it.

## Gates

### gate: resolve-issue

There is no slash-command argument. The number comes from the human's message naming the
plugin's `issue-stage` skill, or asking in words to run an issue: a bare integer or `#N` in that
request is the subject, and a message that mentions `#N` while describing something else
suspends the turn to ask which. `agents/openai.yaml` sets `allow_implicit_invocation: false` as
the intended way to keep this stage out of automatic selection, but that suppression is
unverified on Codex's plugin-loader path (`implicit-skill-suppression` reads `supported: false`),
so do not lean on it. The human is the actual gate. A hand-off line out of the prep stage that
names this stage is not an invocation; their next message is. An issue that merely looks ready,
a defect noticed on the way past, and a "what next" survey are none of them a request.

### gate: workspace-boundary

The boundary is the launch shell's PWD. `mcp-client-roots` reads `supported: false` with
assurance `mechanism`: the Codex 0.151.0 MCP client advertises no roots capability and sets no
project-dir variable, so the delegation server takes that PWD as the workspace and a job pointed
anywhere else fails closed with `OUTSIDE_ROOTS`. Two things follow. Create the worktree under
that directory, not as a sibling of it, and check with `git worktree list` before the first
mutation. And a session started with `codex -C` somewhere other than the repository has moved the
boundary out from under the run: that is a stop, not something to pass a longer path around.

### gate: write-seat-preflight

Read the live host capabilities through the delegation doctor tool and use the `hostCapabilities`
block it returns beside `checks`. That block carries `verifiedAgainst`, the provider version the
entries were checked against, and one entry per capability id with `supported`, `verifiedAt`,
`assurance` and a note. Answer the three dimensions from that read, never from this file.

Read a `supported: false` entry carrying `assurance: mechanism` for what it is: the absence was
verified in the provider source, so the entry is trustworthy and the thing it describes is
genuinely not there. What is left holding that dimension is the spawn prompt, and a prompt is
`contract`.

Two write-seat classes exist on this host.

`native-writer`, a multi-agent v2 seat started with `spawn_agent`:

- workspace: `contract`. `per-seat-authority-narrowing` reads `supported: false` with assurance
  `mechanism`: v2 `spawn_agent` accepts only a model, a reasoning effort and a fork policy, and
  the child inherits your cwd, approval policy and sandbox. Nothing narrows the child below the
  session, so keeping its writes inside the worktree is the contract it was handed.
- descendants: `contract`. `agent-depth-limit` reads `supported: false` with assurance
  `mechanism`: `agents.max_depth` is v1-only and ignored by v2, and the v2 spawn path has no
  depth check. A no-spawn prohibition here is prompt text, so it has to be in the prompt.
- hooks: `mechanism`. `hooks-in-native-children` reads `supported: true` with assurance
  `mechanism`, dated: a v2 child gets a Config derived from the parent's turn and the plugin's
  PreToolUse guards fire inside it, which a live capture confirmed by watching a child's
  unsanctioned issue create and its `git push --no-verify` both get denied.

`bridge-writer`, `delegate_to_claude` at `access: "workspace-write"`:

- workspace: `mechanism`. The delegated worker runs under a sandbox whose only write path is the
  job's workspace key and whose network allowlist is empty, so it is confined to the canonical
  worktree it was handed as `cwd`.
- descendants: `mechanism`. Service policy rejects a delegation started from inside a job with
  `NESTED_DELEGATION`, and the delegated-worker policy denies a shell command that launches a
  provider, including one hidden behind an interpreter or a second shell.
- hooks: `mechanism`, and read the word narrowly. The plugin's own PreToolUse guards do not
  travel: git-guard and the no-backlog guard do not run inside a delegated worker, and a ledger
  line implying they do is claiming an enforcement nobody wrote. What holds instead is the
  delegation permission profile plus the delegated-worker policy, both enforcement and not prompt
  text. The sandbox allows writes on the job's workspace alone, denies reads of credential paths
  and of the provider executables, and runs an empty network allowlist. The policy denies a tool
  outside the job's access set, a read or a write outside the workspace, a protected-file write,
  and a publication command. What that leaves open is local and destructive. A bridge writer can
  run `git checkout .` or `git clean -f` in the worktree and throw away a sibling seat's
  uncommitted work, which git-guard denies natively and nothing denies there. With network off
  nothing leaves the machine, so the damage stops at the disk. Compose around it: do not point a
  bridge writer at a worktree holding another seat's uncommitted work.

Version drift is a string comparison against a live operand, not a probe. The doctor result
carries `client`, the MCP client identity the service reads out of the initialize handshake, with
a name and a version, and that version is the CLI this session is running under. Compare
`client.version` against `verifiedAgainst` for this host. If they differ, or if `client` is
missing or its version does not parse, the host reads drifted and every capability the run
depends on reads `unverified`. An operand you cannot read is drift, never a pass. `unverified` on
a dimension a needed class depends on stops the run with `needs-human`, naming the capability id.

### gate: write-seat

A native writer seat carries the ENTIRE canonical seat contract, pasted verbatim into its spawn
prompt. A path reference does not satisfy this: the seat reads the prompt it was handed and gets
no second fetch, so a line pointing at a file is a spawn prompt with no contract in it. The
contract is `../../seat-contract.md` relative to this skill's own directory in the installed
plugin, which is `plugins/flow/seat-contract.md` in the repository. Read it at preflight, as §2
requires, and paste what you read.

Above the pasted contract, one host wrapper line: the plugin's hooks fire inside this seat, so
git-guard and the no-backlog guard deny there exactly as they deny here, and a spawn from this
seat is a contract breach with nothing to stop it. Every pipeline seat gets `fork_turns: "none"`,
so it starts from its own prompt and not from a copy of your turn. Seats that change nothing,
meaning scouts, reviewers and transports, carry the read-only prohibitions instead and not this
contract.

A cross-family write goes through `delegate_to_claude` at `access: "workspace-write"` with the
worktree as `cwd`, and it needs the same paste. The delegated payload carries the seat contract's
Containment section and nothing else, which is a floor and not the contract: the
synchronous-execution, scope and reporting sections never reach that seat unless you put them
there. So paste the ENTIRE canonical contract into the delegation task text of any substantial
bridge writer, exactly as a native spawn prompt carries it.

### gate: design-pass-legs

The native leg is a Codex-family seat: `spawn_agent` on `gpt-5.6-sol` at high effort,
`fork_turns: "none"`, read-only by its prompt. The bridge leg is `delegate_to_claude` with
`claude-opus-5`, the charter's `opus-5`, at high effort, `access: "read-only"`,
`delivery: attached`, `serviceTier: default`, the repository root as `cwd`; the delegation tools
take the provider's own model ids, not the charter table's short names. Launch the native leg
first, then the bridge attached, so both sheets land in this turn. Neither sees the other.

The outside opinion on this host is a Claude model. The charter's model table is written from a
Claude host, where Sol is the decorrelated seat, and a cold reader gets that inversion wrong in
the same direction every time. Widening to a taste leg also reaches through the bridge, on
`claude-fable-5`.

### gate: review-fabric

The cross-family reviewer is a Claude model reached with `delegate_to_claude`, in
`mode: "adversarial-review"`, against an immutable `base`, at `access: "read-only"`; read the
structured findings and do not parse the prose. The economics invert here. The outside family is
metered on this host rather than flat-rate, so a wide fabric of lenses has a bill attached. The
review is still mandatory. Decorrelation is not a budget line, and the thing to trim when the
bill matters is the number of lenses on a quiet diff, never the one cross-family pass.
Security-flavored seats still prefer `gpt-daybreak-blue-latest` natively, and the retry for a
null security seat is a seat of the other family through the bridge.

### gate: fanout-medium

There is no script medium on this host: no scripted fan-out with resume and a progress readout,
so nothing to reach for when a stage is deterministic. A deterministic fan-out is a batch of
native spawns issued in one turn, and the verification between batches is git: read
`git -C <wt> log` and `git -C <wt> status` and see what actually landed before issuing the next
batch. Size the batch to what you can check that way.

### gate: seat-verification

`followup_task` on a completed seat starts its next turn carrying the conductor-verified state:
which commits exist and what the tree holds, read out of git first. `send_message` only queues
text for that seat and is not a resume, so a nudge sent with it changes nothing until something
else starts a turn.

A running seat is opaque here. There is no live output to read and no way in until it finishes,
so the composition has to absorb that: prefer one milestone per spawn, because a seat that
wandered can only be corrected after it stops. Four to six concurrent write seats on disjoint
files is this host's working ceiling, and the bound is not the platform, it is what the conductor
can verify against git in one turn. The stage's 20-seat cap is still the cap; this is the number
you actually run.

### gate: fork-ask

Never ask an optional fork on this host. The binding ends the turn, so asking costs the human a
turn and buys nothing on a question you can answer: decide it, journal a `fork guessed` event
naming the alternative you rejected and why, and keep going.

### gate: trust-fork-ask

Mandatory, and the suspended turn is what it costs. Finish every mutation first: commit, push,
the journal event, the label, the escalation notice. THEN read the anchors, meaning the AC
snapshot digest, the head sha and the issue's `updatedAt`, immediately before asking. Reading
them earlier lets your own work expire your own question. Ask one question, up to four numbered
options, the recommendation first, each option carrying its consequence in a line, then end the
turn. The human's next message resumes the run. Re-read the anchors before acting on the answer:
an answer that arrives over moved anchors is expired, so journal `stale-answer-rejected`, keep
`needs-human`, and ask fresh against the state you just read.

### gate: escalation-notice

`notify-send`, one line naming the issue number and what is blocking, fired after the label and
the comment are already on the issue. It is best effort and it is silent over SSH, where there is
no session bus to reach: that gap is documented, not worked around, and a failed notify is never
worth a turn. The durable part is the label plus the comment.

### gate: journal-assurance

No host difference in the grammar: the ledger's host line, anchors line, and one line per
write-seat class are the same shape everywhere. The three words come from this host's mappings in
the write-seat-preflight section above, so on an undrifted host `native-writer` reads
`workspace: contract | descendants: contract | hooks: mechanism` and `bridge-writer` reads
`mechanism` on all three. The host line says Codex and the CLI version it reports. State the
assurance and move on; two `contract` answers are the posture that was settled at design time,
not a question to re-open per run.

## The seat ladder

The design pass names a difficulty per milestone, and difficulty routes both the model and the
effort on the write seat:

- `mechanical`: `gpt-5.6-luna` at high effort, and only when the seat is transcribing a complete
  spec whose shape is already decided.
- `standard`: `gpt-5.6-sol` at medium effort. The default.
- `hard`: `gpt-5.6-sol` at high effort, for work where a miss ships.

When torn between two rungs take the higher one, and the price of doing that here is small: Sol
at medium costs little more than Luna at high. Bulk sweeps, meaning
comment rot, evidence collection and transcript reads, go to `gpt-5.6-luna`, at maximum effort
when the sweep needs depth. A Claude-family writer at any rung is not a native spawn: it is
`delegate_to_claude` at `access: "workspace-write"`, and it is a `bridge-writer` in the ledger.
