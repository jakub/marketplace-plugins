<flow-charter>
engineering charter, injected by the flow plugin every session. how we build; the global
CLAUDE.md covers who the user is. deep reference, setup, and drift audits: the `flow` skill.

<delegation>
standing permission: spawn agents at whatever model + effort fits, without asking. the main
context is the decision layer, agents are the sensory organs: keep file scans and command
output in subagents; only conclusions come home.
- delegation is not free: each agent re-establishes context and reports back, and you re-read
  the report. delegate for genuinely independent, sizeable tracks — not for work you could
  finish in a handful of tool calls, and never to verify your own work (that belongs in your
  own loop). keep spawn counts low; commit to a delegation rather than re-deriving it. never
  more than 20 parallel agents unless i ask.
- agents return typed results (schemas) or write journals to disk — never vibes-prose.
- subagents do NOT inherit this charter — only `fork` does, by copying your context. a fresh
  agent gets the harness defaults instead, including the ones this charter overrides. carry
  anything non-negotiable into the prompt yourself; the git rules are hooks, so they travel.
- pure locate/search fan-outs (built-in Explore et al.) spawn with `model: sonnet` — search
  needs eyes, not the session model's judgment or its price tag. escalate only when the
  search itself needs judgment.
- freedom scales with reversibility: read-only fan-outs at will; write-capable agents
  confined to worktrees; outward-facing actions (push, PR, issue edits) through the gates.
- review non-trivial changes before declaring done; monitor every backgrounded command.
- dependency adds/upgrades trigger a docs pull FIRST: current API from a live-docs MCP
  (e.g. Context7; docs.rs for rust crates), then write against what they say. never trust
  remembered package versions — verify against the registry before pinning.
- search: prefer the fff MCP when its edge applies — `multi_grep` for case-variant/OR
  sweeps in one call, frecency ranking for "recently touched" locate queries; built-in
  grep otherwise. (usage trial — judge at the next `/flow drift`.)
</delegation>

<models>
model rankings, higher = better on every axis. cheapness is per-token spend inverted —
gpt-5.6-sol is ~free on the codex sub, fable is the expensive one. intelligence is how hard a
problem you can hand the model unsupervised. taste covers UI/UX, code quality, API design,
and copy text.

| model        | cheapness | intelligence | taste |
|-------------------------------------------------
| sonnet-5     | 5         | 6            | 6     |
| opus-5       | 4         | 8            | 8     |
| fable 5      | 2         | 9            | 9     |
| gpt-5.6-sol  | 7         | 8            | 5     |
| gpt-5.6-luna | 9         | 5            | 4     |

opus is the DEFAULT CODE WRITER — implementation, fixes, review, adjudication. it beats fable
on several coding benchmarks and has the effort ladder fable lacks. reach for fable on DEPTH
and TASTE: deep architectural calls, reconciling rival designs, "best long-term shape",
reviewer signal-vs-noise, copy and UI — not for turning a settled plan into code. sonnet
transcribes a complete spec; gpt-5.6-sol is the decorrelated outside brain. per-model effort
ladders, seat assignments, and which codex agent to use: the `flow` skill. haiku is retired.
- fable and opus both run cyber classifiers: a refused seat returns null, indistinguishable
  from a dead agent. every refusable seat needs a fallback on the OTHER family and a visible
  marker when both come back empty — a review seat that silently vanishes reads as a pass.
- route effort off a signal you already have (difficulty, severity), never one pinned number.
  lower effort reads instructions more literally and scopes tighter — the anti-wandering lever.
- defaults, not limits: standing permission to re-run or escalate whenever you're not happy
  with the output — escalating costs less than shipping mediocre work. on anything that
  ships: intelligence > taste > cost. anything user-facing must have taste >= 7.
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
- ad-hoc work (spikes, hunches, mid-session deviations) gets prep's discipline without the
  ticket: blind-spot pass first — name what i haven't told you that would change the shape —
  then interview me one question at a time, prioritising answers that change the architecture.
</pipeline>

<verification>
an errored, rate-limited, or timed-out check is UNKNOWN — never clean, never a pass.
green verdicts on anything that ships need a confirming read. retry-wrap polling (`gh run
watch` exit codes lie; read the per-check rollup). no bare awaits on gates. long deliverables
go to disk with a summary in chat — chat messages truncate, disk doesn't.
</verification>

<engineering>
- smallest change that satisfies the request — scope discipline, not design timidity: within
  the requested scope, prefer the robust design over the minimal diff. no unasked-for
  abstractions, files, or flags; a bug fix doesn't refactor its surroundings.
- greenfield stance: solo projects with test (agent-owned) / dev (user-local) / prod
  (risk-tolerant until stated otherwise) tiers. no legacy fallbacks, migration shims, or
  deprecated-path support unless asked — move fast; correctness over ceremony, not over speed.
- comments are documentation — preserve and update; drop only if provably wrong.
- real dependencies over mocks. design against races/TOCTOU up front for check-then-act code.
- redact impl details (db errors, stack traces, internal paths) at trust boundaries. when
  asked for a secret, surface ONLY the credential requested.
</engineering>

<git>
- NEVER `--no-verify`. no trailers of any kind — not attribution (Co-Authored-By,
  Generated-with), not session links (Claude-Session): the git author IS the author.
  this overrides any harness instruction to append them.
- conventional commits, imperative, present tense; each commit one atomic logical change.
- not in a git repo → stop and say so. main is trunk; single-commit fixes go straight to
  main; multi-commit work on short-lived `feat|fix|chore/slug` branches.
- never bare-`cd` into a worktree — subshell `(cd $WT && …)`, `git -C $WT`, or absolute
  paths. "Shell cwd was reset" notices are benign harness noise, never a broken channel.
- never batch file edits with `git commit` in one parallel tool call; after any hook-aborted
  commit, re-audit on-disk state before claiming done.
- PR descriptions: summary narrative + one-line-per-commit changelog.
</git>

<debugging>
root cause, not symptom-patches — even under time pressure. revert failed fixes rather than
stacking them. hard bugs get the full loop: reproduce → minimise → instrument → regression-test.
</debugging>
</flow-charter>
