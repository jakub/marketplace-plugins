<flow-charter>
engineering charter, injected by the flow plugin every session. how we build; the global
CLAUDE.md covers who jakub is. deep reference, setup, and drift audits: the `flow` skill.

<delegation>
standing permission: spawn agents at whatever model + effort fits, without asking. prefer
many scoped agents living in the low end of their context windows over marathon threads —
the main context is the decision layer; agents are the sensory organs. keep file scans and
command output in subagents; only conclusions come home.
- agents return typed results (schemas) or write journals to disk — never vibes-prose.
- freedom scales with reversibility: read-only fan-outs at will; write-capable agents
  confined to worktrees; outward-facing actions (push, PR, issue edits) through the gates.
- review non-trivial changes before declaring done; monitor every backgrounded command.
- use Context7 MCP for current library docs; never trust remembered package versions —
  verify against the registry before pinning.
</delegation>

<models>
defaults, not limits: judge the output, not the price tag — escalating costs less than
shipping mediocre work. on anything that ships: intelligence > taste > cost.
- fable 5 (`high`): every judgment seat — orchestration, planning, architecture, synthesis,
  adjudication, grilling. the human replacement. skip for security-flavored payloads
  (classifier roulette): route those to opus, and auto-fallback to opus on any refusal/null.
- opus 4.8 (`high`/`xhigh` safe): the workhorse — implementation, correctness + security
  review, fix loops, anything where wrong answers are expensive.
- sonnet 5: mechanical work with a complete spec; `low` for pure command wrappers.
- gpt-5.5 via codex (~free, flat-rate sub): the decorrelated outside opinion — architecture
  second-passes, adversarial review — and general delegation whenever an independent brain
  helps. use the codex-delegate agent or /codex:* commands. avoid codex-reviewing-codex.
- haiku: retired. the floor here is "reads code, exercises judgment."
</models>

<pipeline>
prep → issue → land (flow plugin). /flow:prep is the single front door — issue number or
free text; nothing enters the tracker except through it. /flow:issue runs hands-off through
a pushed, reviewed, evidenced PR. /flow:land is the only place a merge happens.
- no-backlog: PRs ship complete. fix findings in the loop; never file minor follow-up
  tickets. the sole escape hatch (cross-crate-refactor scale) is drafted on the PR and
  filed only on human ack at /flow:land. a PreToolUse hook enforces this on `gh issue create`.
- the issue is the record: body = living spec (edit in place), comments = append-only stage
  journal. permanent decisions graduate to ADRs on main.
- acceptance criteria leave evidence: tests, transcripts, screenshots — linked per criterion.
</pipeline>

<verification>
an errored, rate-limited, or timed-out check is UNKNOWN — never clean, never a pass.
green verdicts on anything that ships need a confirming read. retry-wrap polling (`gh run
watch` exit codes lie; read the per-check rollup). no bare awaits on gates. long deliverables
go to disk with a summary in chat, not into a 500-token ceiling.
</verification>

<engineering>
- smallest change that satisfies the request; no unasked-for abstractions, files, or flags.
  a bug fix doesn't refactor its surroundings.
- greenfield stance: personal projects with test (yours) / dev (jakub's local) / homelab
  prod (changeable with awareness) tiers. no legacy fallbacks, migration shims, or
  deprecated-path support unless asked — move fast; correctness over ceremony, not over speed.
- comments are documentation — preserve and update; drop only if provably wrong.
- real dependencies over mocks. design against races/TOCTOU up front for check-then-act code.
- redact impl details (db errors, stack traces, internal paths) at trust boundaries. when
  asked for a secret, surface ONLY the credential requested.
</engineering>

<git>
- NEVER `--no-verify`. no attribution trailers of any kind — the git author IS the author.
- conventional commits, imperative, present tense; each commit one atomic logical change.
- not in a git repo → stop and say so. main is trunk; single-commit fixes go straight to
  main; multi-commit work on short-lived `feat|fix|chore/slug` branches.
- never bare-`cd` into a worktree — subshell `(cd $WT && …)`, `git -C $WT`, or absolute
  paths. "Shell cwd was reset" notices are benign harness noise, never a broken channel.
- never batch file edits with `git commit` in one parallel tool call; after any hook-aborted
  commit, re-audit on-disk state before claiming done.
- PR descriptions: summary narrative + one-line-per-commit changelog. `gh` for github ops.
</git>

<debugging>
root cause, not symptom-patches — even under time pressure. read the code before theorising.
one hypothesis at a time; revert failed fixes rather than stacking. say "i don't understand
X" instead of guessing. hard bugs: the /diagnose loop (reproduce → minimise → instrument →
regression-test).
</debugging>
</flow-charter>
