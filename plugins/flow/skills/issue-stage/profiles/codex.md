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

Three paths matter here, this host lets two of them diverge, and a run that treats them as one
passes preflight, claims the issue, and then dies at the first edit. Name all three before
deciding anything.

The bridge root is the launch shell's PWD, meaning the value the environment carried when the
human started this session. `mcp-client-roots` reads `supported: false` with assurance
`mechanism`: the Codex 0.151.0 MCP client advertises no roots capability and sets no project-dir
variable, so `src/delegation/main.mjs` falls back to `process.env.PWD` on this host. That is the
root every delegation call validates a job's `cwd` against, and nothing else uses it.

The session root is the cwd this session actually runs in, which `codex -C` sets. It is the
sandbox root, so your own writes obey it and a native `spawn_agent` child inherits that cwd and
that sandbox unchanged. Nothing narrows it per seat and nothing widens it while the session runs.

After a plain launch the two are the same path. `cd parent; codex -C repo` splits them, leaving
the bridge root at `parent` and the session root at `repo`, and that split is the whole trap. The
sibling worktree under `parent` then satisfies every delegation check while no native seat can
write a byte in it. Preflight goes green and the run dies at `git worktree add` or the first
edit. So read the session root from the session's own cwd, never from the environment's PWD, and
treat diverged roots as their own stop with that name on it.

The third path is the worktree this run intends to create, `../<repo>-issue-N-<slug>`, a sibling
of the repository. It has to sit inside the SESSION root, and it does only when the operator
launched from the directory HOLDING the repository with no `-C` in play. That plain launch is
this stage's operating requirement on this host. Launched at the repository root, the run cannot
create its worktree at all, because `git worktree add` writes outside the sandbox and the sandbox
refuses. Say that at preflight, name the directory to relaunch from, and stop. Do not claim the
issue first, and do not move the worktree inside the repository to get around it.

So this gate's test is small, because the worktree does not exist yet: the session root is the
directory holding the repository, the intended path sits inside that root, the repository's
common git directory resolves inside that root, and the two roots have not diverged. The common
directory earns its place in that list. A repository that is itself a linked worktree of
something outside the root passes every other check here and then fails at creation, after the
claim, because `git worktree add` writes the new registration into that out-of-bounds directory.

The linked-worktree rule is a different check at a different time, and it is bridge-scoped.
`canonicalWorkspace` in `src/delegation/workspace.mjs` decides which `cwd` a delegation job may
run in, and it accepts a path two ways. Either the path resolves inside the bridge root, or an
approved repository registered it as a linked worktree. The second way takes two proofs and both
are required: the path's `git rev-parse --git-common-dir` has to resolve inside that root, and
that repository's own `git worktree list --porcelain` has to name this worktree. The pointer
alone proves nothing, because a `.git` file is caller-writable and any directory can claim to
belong to an approved repository, which is why a forged one fails. A path with neither proof
fails closed with `OUTSIDE_ROOTS`.

That rule cannot be applied to a path that does not exist yet, since nothing has registered it.
Creating the worktree is what completes the second proof: `git worktree add` writes the
registration the listing reports. Every bridge call runs the check afterwards against the real
path, which is a mechanical backstop and not this gate. And passing it is never proof of native
write authority. It says a delegation job may run in the path, not that your shell or a native
child can write a byte there, and those two answers come apart exactly when the roots diverge.

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
carries `client`, the MCP client identity observed in the initialize handshake, as a name and a
version, with nulls where no handshake supplied one. That version is bare, `0.151.0`. The
`verifiedAgainst` record beside it is product-qualified, `codex-cli 0.151.0`. Compare those two
whole and they never match, so the run would stop at preflight on exactly the versions the table
does support.

The comparison is this. Split `verifiedAgainst` on its single space into a product part and a
version part. Compare `client.version` against the version part for string equality. Equal is
undrifted, anything else is drift. `client.name` is corroboration and not the comparison, and its
equivalence is a fixed set and not a judgement call: on this host the names that count as this
product are `codex` and `codex-cli`. A non-null name outside that set is a different product and
reads drifted whatever the version says. A null name lets the version decide. A missing
`client`, a null `client.version`, or a `verifiedAgainst` that does not split into exactly two
parts is drift as well. An operand you cannot read is never a pass.

Drift makes every capability the run depends on read `unverified`, and `unverified` on a
dimension a needed write-seat class depends on stops the run with `needs-human`, naming the
capability id.

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

A bridge writer edits and cannot commit. Its sandbox allows writes under the job's workspace key
and nowhere else, and this stage works in a linked worktree whose object store, refs and logs sit
in the parent repository's Git directory, outside that key, so `git commit` in that seat fails on
the first object write. Network off rules out a push as well. The pasted contract still applies,
with one adaptation you write into the task text above it: its scope and milestone discipline
governs the seat's EDITS, and the commit and report obligations move to you. When the seat comes
back, do invariant 10's read yourself, `git -C <wt> status` and `git -C <wt> diff` against the
milestone that seat was given, then stage ONLY that seat's files by explicit path and commit with
the seat named in the message body. Never `git add -A` after a bridge seat: the worktree may be
holding a sibling's work. None of this loosens anything for a native writer, which runs under the
plugin's guards and commits its own milestones.

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

The mandatory reviewer is the family opposite the one that WROTE the diff, not the family
opposite the host. Read the writer's family off the seat that produced the code, then pick the
reviewer from the other one. This host settles only the mechanism: a Codex-family seat is a
native `spawn_agent`, and a Claude-family seat is `delegate_to_claude`.

Two cases, and the second is the one a cold reader skips. A diff from a native `spawn_agent`
writer is Codex-written, so its mandatory review is `delegate_to_claude` in
`mode: "adversarial-review"`, against an immutable `base`, at `access: "read-only"`. That is the
common case here. A diff from a bridge writer, meaning `delegate_to_claude` at workspace-write, is
Claude-written, so its mandatory review is a native Codex seat on `gpt-5.6-sol` at high effort.
Do not send that one across the bridge. A Claude model reading a Claude-written diff is the
correlation failure the invariant names, and here you would pay metered budget for a review that
proves nothing. Track which seat wrote which file. A PR holding both native-written and
bridge-written work needs one of each, judged per diff and not per run.

Read the structured findings and do not parse the prose. When a bridge review comes back clean,
its coverage list and verdict arrive through `delegation_continue` on that review's job id, as
plain text in a second turn of the same job. The Claude target supports session continuation,
which is the capability the charter's delegation paragraph already records, so the second turn
keeps the reviewer's own session and costs no re-read of the diff. Read that text for coverage
only. The findings array is still the only place a finding comes from. The economics invert here.
The outside family is metered on this host rather than flat-rate, so a wide fabric of lenses has
a bill attached. The review is still mandatory. Decorrelation is not a budget line, and the thing to
trim when the bill matters is the number of optional lenses on a quiet diff, never the mandatory
opposite-family pass. A same-family lens is an extra and never a replacement.
Security-flavored seats still prefer `gpt-daybreak-blue-latest` natively, and the retry for a
null security seat is a seat of the other family.

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
