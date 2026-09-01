# issue-stage host profile: Claude Code

Read this with `SKILL.md`. The stage is host-neutral prose; this file says what each of its
`[[gate:<id>]]` markers binds to in a Claude Code session. Where a gate has nothing
host-specific about it, the section says so rather than inventing a difference.

Tool allowance for the stage, and the one `/flow:issue` declares in its frontmatter:

allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Bash(node:*), Read, Write, Workflow, TaskOutput, TaskStop, PushNotification, Agent, SendMessage, AskUserQuestion, Skill, mcp__plugin_flow_flow_delegate__delegate_to_codex, mcp__plugin_flow_flow_delegate__delegation_status, mcp__plugin_flow_flow_delegate__delegation_result, mcp__plugin_flow_flow_delegate__delegation_events, mcp__plugin_flow_flow_delegate__delegation_list, mcp__plugin_flow_flow_delegate__delegation_cancel, mcp__plugin_flow_flow_delegate__delegation_steer, mcp__plugin_flow_flow_delegate__delegation_continue, mcp__plugin_flow_flow_delegate__delegation_models, mcp__plugin_flow_flow_delegate__delegation_doctor

`Bash(node:*)` is in that line for two callers: `scripts/issue-claim.mjs`, the claim helper of §3,
and the scratch scripts the conductor runs itself. There is no Edit in it, so the conductor's own
minor inline edits go through Write, and anything larger goes to a seat where it belonged anyway.

The human-choice binding is the AskUserQuestion tool: up to 4 questions per call, each with
selectable options and the recommendation first, and the answer comes back inside the same turn.
Asking does not end the run, which is why this host asks optional forks at all. Never replace it
with a prose question the human has to answer in an essay.

## Gates

### gate: resolve-issue

`$ARGUMENTS` from the `/flow:issue` invocation is the issue number. Empty, or anything that is
not a positive integer, aborts with usage and mutates nothing. The invocation is the
authorization: the human typed the command, and nothing else in the session is a request to run
this stage. A finished `/flow:prep` that ends by naming this stage wrote a hand-off line, not an
invocation; the human's next message carrying the number is the invocation.

### gate: workspace-boundary

The boundary starts at the session's workspace roots: the directory the session was opened in,
plus any directory the human has added to it. `mcp-client-roots` is true with assurance
`mechanism` on this host, so the delegation server reads those roots over `roots/list`.

It is wider than "inside a root", and the difference is exactly the layout this pipeline uses.
`canonicalWorkspace` in `src/delegation/workspace.mjs` accepts a path two ways. Either the path
resolves inside one of the roots, or an approved repository registered it as a linked worktree.
The second way takes two proofs and both are required: the path's `git rev-parse
--git-common-dir` has to resolve inside a root, and that repository's own
`git worktree list --porcelain` has to name this worktree. The pointer alone proves nothing,
because a `.git` file is caller-writable and any directory can claim to belong to an approved
repository, which is why a forged one fails. A path with neither proof fails closed with
`OUTSIDE_ROOTS`. So `../<repo>-issue-N-<slug>`, the sibling worktree this stage creates beside
the repository, is a `cwd` a delegation job may run in even though it sits outside every root.
That is what the rule decides and nothing more. It speaks for bridge jobs, so a worktree it
accepts still has to be a place this session and its native seats may write.

Two checks exist, at different times, and this gate is the first. It runs at preflight, before
the worktree exists, so it applies to the path the run INTENDS to create. Two things to check on
that prospective path: the parent directory it will live in is a place this run may write, and
the repository's common git directory resolves inside the boundary. The two-proof rule cannot be
applied here at all, because nothing has registered a worktree that does not exist. Creating it
completes the second proof: `git worktree add` writes the registration that
`git worktree list --porcelain` reports. Do not reach for that listing at this gate. It cannot
name a worktree nobody has created yet, and a gate that waits for it has already let the
mutations start. From creation onward the two-proof rule is the mechanical check, bridge-scoped,
which every delegation call runs against the real path and which refuses the job with
`OUTSIDE_ROOTS` if it does not hold. A prospective path you cannot place inside the boundary is a
stop before the first mutation, not something to route around with a longer path.

### gate: write-seat-preflight

Read the live host capabilities with `delegation_doctor` and use the `hostCapabilities` block it
returns beside `checks`. That block carries `verifiedAgainst`, the provider version the entries
were checked against, and one entry per capability id with `supported`, `verifiedAt`, `assurance`
and a note. Answer the three dimensions from that read, never from this file.

Two write-seat classes exist on this host.

`native-writer`, the `flow:implementer` agent definition:

- workspace: `contract`. `per-seat-tool-allowlist` is true with assurance `mechanism`, and what
  that mechanism fixes is the seat's TOOL LIST, not where its tools may write. Nothing confines
  an Edit path, and the seat keeps Bash and the session's permission mode. Staying inside the
  worktree is the seat contract plus the repository's git hooks, which is `contract`.
- descendants: `contract`. `agent-depth-limit` is true with assurance `mechanism`, and what that
  mechanism covers is narrower than the dimension. The definition omits the Agent tool, so a
  native subagent call is impossible rather than discouraged. That much is mechanical. The seat
  still holds Bash, this stage's own allowance pre-approves `Bash(node:*)`, and no native hook
  denies a raw provider launch from a shell, so a writer that reached for `claude -p` or
  `codex exec` would start a descendant nobody counted. The seat contract's no-delegation line is
  the only thing in front of that, and told-but-unchecked is `contract`. The row reads the same
  as the other host's native writer, which is what to expect: neither host confines a seat's
  shell.
- hooks: `mechanism`. `hooks-in-native-children` is true with assurance `mechanism`: a subagent's
  tool calls run the session's PreToolUse hooks, so git-guard and the no-backlog guard fire
  inside the seat.

`bridge-writer`, a cross-family delegation at `access: "workspace-write"`:

- workspace: `mechanism`. The delegation sandbox grants write on the job's own workspace key and
  nothing else, and it disables network, so the job is confined to the canonical worktree it was
  handed as `cwd`.
- descendants: `mechanism`. Service policy rejects a delegation started from inside a job with
  `NESTED_DELEGATION`. A nested provider started from the job's own shell has no way to work
  either: the permission profile never grants the provider's credential directory and network is
  off, so the launch has no auth and nowhere to call.
- hooks: `mechanism`, and read the word narrowly. The plugin's own guards do not travel. A
  delegated Codex job runs with the plugin feature gate off, so git-guard and the no-backlog
  guard load nowhere inside it. What holds instead is the delegation permission profile, which is
  enforcement and not prompt text: minimal read, write on the job's workspace and nowhere else,
  `.git`, `.agents` and `.codex` read-only, network disabled. What that leaves open is local and
  destructive. A bridge writer can run `git checkout .` or `git clean -f` in the worktree and
  throw away a sibling seat's uncommitted work, which git-guard denies natively and nothing
  denies there. With network off nothing leaves the machine, so the damage stops at the disk, but
  compose around it: do not point a bridge writer at a worktree holding another seat's
  uncommitted work.

Version drift is a string comparison against a live operand, not a probe. The doctor result
carries `client`, the MCP client identity observed in the initialize handshake, as a name and a
version, with nulls where no handshake supplied one. That version is bare, `2.1.252`. The
`verifiedAgainst` record beside it is product-qualified, `claude-code 2.1.252`. Compare those two
whole and they never match, so the run would stop at preflight on exactly the versions the table
does support.

The comparison is this. Split `verifiedAgainst` on its single space into a product part and a
version part. Compare `client.version` against the version part for string equality. Equal is
undrifted, anything else is drift. `client.name` is corroboration and not the comparison, and its
equivalence is a fixed set and not a judgement call: on this host the names that count as this
product are `claude` and `claude-code`. A non-null name outside that set is a different product
and reads drifted whatever the version says. A null name lets the version decide. A missing
`client`, a null `client.version`, or a `verifiedAgainst` that does not split into exactly two
parts is drift as well. An operand you cannot read is never a pass.

Drift makes every capability the run depends on read `unverified`, and `unverified` on a
dimension a needed write-seat class depends on stops the run with `needs-human`, naming the
capability id.

### gate: write-seat

Every substantial native write seat is `flow:implementer`. Its toolset has no Agent tool, so a
native subagent call is impossible rather than discouraged. That is the whole of the mechanism:
the seat keeps Bash, so a provider launched from its shell is still a way out, and the contract's
no-delegation line is what stands in front of that. A `general-purpose` seat holding Edit is a
containment violation whatever its prompt says, and so is the conductor doing the writing after a
failed preflight. The canonical contract rides the definition as its byte-equal tail, so the
spawn prompt carries the worktree path and the milestones and no contract text at all. Seats that
change nothing, meaning scouts, reviewers and transports, keep their own definitions and carry no
contract.

A cross-family write goes through `delegate_to_codex` at `access: "workspace-write"` with the
worktree as `cwd`, and there the contract does not ride anything. The delegated payload carries
the seat contract's Containment section and nothing else, which is a floor and not the contract:
the synchronous-execution, scope and reporting sections never reach that seat unless you put them
there. So paste the ENTIRE canonical contract, meaning `plugins/flow/seat-contract.md` as you
read it at preflight, into the delegation task text of any substantial bridge writer, the same
way the other host's native spawns carry it.

A bridge writer edits and cannot commit. The delegation permission profile keeps the exact Git
metadata paths read-only even on a workspace-write job, and for a write job `.git`, `.agents` and
`.codex` under the worktree stay read-only too, which `docs/DELEGATION.md` states in its
paragraph on the `flow_delegation` profile. So `git add` and `git commit` fail in that seat by
design, and network off rules out a push. The pasted contract still applies, with one adaptation
you write into the task text above it: its scope and milestone discipline governs the seat's
EDITS, and the commit and report obligations move to you. When the seat comes back, do invariant
10's read yourself, `git -C <wt> status` and `git -C <wt> diff` against the milestone that seat
was given, then stage ONLY that seat's files by explicit path and commit with the seat named in
the message body. Never `git add -A` after a bridge seat: the worktree may be holding a sibling's
work. None of this loosens anything for a native writer, which commits its own milestones.

### gate: design-pass-legs

The native leg is `flow:code-architect` at `model: opus`, the charter's `opus-5`, effort high:
the minimal framing and the anchor of the synthesis. Its definition holds no Edit, Write or Agent
tool, so it is not a write seat and carries no seat contract. The bridge leg is
`delegate_to_codex` with `gpt-5.6-sol` at high effort, `access: "read-only"`,
`delivery: attached`, `serviceTier: default`, the repository root as `cwd`. Launch the native leg
first, in the background, then the bridge attached, so both sheets land in this turn. Neither
sees the other. The outside opinion on this host is the Codex-family model. Widen to a third
taste leg on `fable-5` for a new subsystem, a public API, taste-heavy work, or a pair that
disagrees hard.

### gate: review-fabric

The mandatory reviewer is the family opposite the one that WROTE the diff, not the family
opposite the host. Read the writer's family off the seat that produced the code, then pick the
reviewer from the other one. This host settles only the mechanism: a Claude-family seat is a
native Agent call, and a Codex-family seat is `delegate_to_codex`.

Two cases, and the second is the one a cold reader skips. A diff from `flow:implementer` is
Claude-written, so its mandatory review is `delegate_to_codex` with `mode: "adversarial-review"`,
an immutable `base` and `access: "read-only"`. That is the common case. A diff from a bridge
writer, meaning `delegate_to_codex` at workspace-write, is Codex-written, so its mandatory review
is a native Claude seat: `flow:code-reviewer` at `model: opus`, effort xhigh. Sending that diff
back across the bridge is Codex reviewing Codex, and it slips through because the bridge call is
the same one that reviews everything else. Track which seat wrote which file. A PR holding both
native-written and bridge-written work needs one of each, judged per diff and not per run.

Read the structured findings and do not parse the prose. When a bridge review comes back clean,
its coverage list and verdict arrive through `delegation_continue` on that review's job id, as
plain text in a second turn of the same job. Read that text for coverage only. The findings array
is still the only place a finding comes from. Sol is flat-rate on the subscription
here, so extra lenses cost turnaround and not money: widen on a hunch and journal it. A
same-family lens is an extra on top of the mandatory opposite-family one and never a replacement
for it. Security-flavored seats go to `gpt-daybreak-blue-latest` first. The retry for a null
security seat is a seat of the other family.

### gate: fanout-medium

Direct Agent calls when a stage is adaptive or small. When the fan-out is deterministic, wide,
and worth resume plus a progress readout, write a short ad-hoc script under the `Workflow`
allowance: plain JavaScript, no TypeScript syntax, and no `Date.now()`, `Math.random()` or argless
`new Date()`, because resume replays the script and those three break it. Read a seat back with
`TaskOutput` and end one with `TaskStop`.

### gate: seat-verification

A running seat is reached with `SendMessage`, and what it carries is conductor-verified state:
read `git -C <wt> log` and `git -C <wt> status` first, then tell the seat which commits exist and
what the tree holds. Never ask the seat what it did instead. `TaskOutput` reads its stream when
the final message is the thing in doubt. A seat that fabricates twice is re-run on a stronger
model and journaled as an event.

### gate: fork-ask

AskUserQuestion, one call, options with the recommendation first and a consequence on each. The
answer arrives inside the turn, so an optional fork costs the human a tap and the run keeps its
place: ask. If the human dismisses the question, decide it, journal a `fork guessed` event naming
the alternative you rejected and why, and keep moving.

### gate: trust-fork-ask

AskUserQuestion, one question per fork, mandatory for anything that sets a trust posture, never
guessed. Unanswered, the outcome has no host difference: take the conservative posture, label
`needs-human`, write the durable journal entry, and stop. What this host makes cheap is the
asking, not the continuing.

### gate: escalation-notice

`PushNotification`, one line naming the issue number and what is blocking, fired after the label
and the comment are already on the issue. It is best effort. The durable part is the label plus
the comment, and a notification that never reaches the human must never be the reason a clean
escalation reads as a silent one.

### gate: journal-assurance

No host difference in the grammar: the ledger's host line, anchors line, and one line per
write-seat class are the same shape everywhere. The three words come from the class mappings in
the write-seat-preflight section above, so on an undrifted host `native-writer` reads
`workspace: contract | descendants: contract | hooks: mechanism` and `bridge-writer` reads
`mechanism` on all three. State them and move on; the assurance is never a question to the human.
Do not round a `contract` up to `mechanism` because the seat has never misbehaved.

## The seat ladder

The design pass names a difficulty per milestone, and difficulty routes both the model and the
effort on the write seat:

- `mechanical`: `sonnet-5` at medium effort, and only when the seat is transcribing a complete
  spec whose shape is already decided.
- `standard`: `opus-5` at high effort. The default, and the default for a reason.
- `hard`: `opus-5` at xhigh effort, for work where a miss ships.

Dropping a write seat below `opus-5` is the exception you justify in the launch journal. Bulk
sweeps, meaning comment rot, evidence collection and transcript reads, go to `gpt-5.6-luna`
through `delegate_to_codex`, at maximum effort when the sweep needs depth. That combination is
the cheap-depth seat and never the decorrelation seat.
