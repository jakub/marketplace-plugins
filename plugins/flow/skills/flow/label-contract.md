# Label taxonomy & the ready-for-agent contract

## Taxonomy (the state machine)

```
 intake               staging                active          terminal
 ──────               ───────                ──────          ────────
 needs-triage  ──►    ready-for-agent  ──►   in-progress ──► closed (landed)
 agent-found   ─┘          │  ▲                  │
                 (via /flow:prep only)           │
                                                 ▼
                 blocked lane (wait on human, ping phone):
                 needs-info · needs-human · needs-rebase

                 terminal-buried: wontfix · deferred  (never resurrected by agents)
```

The tuple (name, color, description) is the contract - `/flow labels` reconciles all three,
so a label with the right name but a drifted color or description is still drift. One color
per lane, and the descriptions below are verbatim.

| label | lane | color | description (verbatim) | set by | cleared by |
|---|---|---|---|---|---|
| `needs-triage` | intake | `fbca04` | Untriaged intake; exits only through /flow:prep | human / tooling / lint | /flow:prep |
| `agent-found` | intake | `fbca04` | Scheduled-hunter quarantine: verified + deduped, not human-reviewed | hunters (`FLOW_SANCTION=hunter`) | /flow:prep |
| `ready-for-agent` | staging | `0e8a16` | Design-hardened per the label contract; eligible for /flow:issue | /flow:prep only | claim step of /flow:issue |
| `in-progress` | active | `1d76db` | Atomically claimed by a /flow:issue run | /flow:issue claim | /flow:land or escalation |
| `needs-info` | blocked | `b60205` | Blocked on an answer only the human has | prep or run escalation | human answer + re-prep |
| `needs-human` | blocked | `b60205` | Run escalated: adjudicated-real blockers survived the fix loop | /flow:issue | human review |
| `needs-rebase` | blocked | `b60205` | Worktree conflicts with moved main | /flow:issue | human/agent rebase |
| `wontfix` | buried | `6e6e6e` | Buried by human decision; agents never resurrect | human | human |
| `deferred` | buried | `6e6e6e` | Consciously parked; agents never resurrect | human | human |

Type modifiers - orthogonal, stack with anything, GitHub stock colors and descriptions:
`bug` (`d73a4a`), `enhancement` (`a2eeef`), `documentation` (`0075ca`).

Rules:
- Every open issue carries exactly ONE lifecycle label - no limbo. An open issue with none
  is drift; the lint adds `needs-triage` with a comment. Blocked-lane labels stack on top of
  the lifecycle label they interrupt.
- The taxonomy is CLOSED: the table plus the three modifiers is the complete legal set. Any
  other label is drift - the lint reports it and never deletes it (deletion strips the label
  from every issue repo-wide with no undo; that is a human's call).
- No agent creates issues outside `FLOW_SANCTION` lanes (enforced by the no-backlog hook).
- Nothing self-promotes: `agent-found → ready-for-agent` requires a /flow:prep pass.

Retired - do not recreate:
- `ready-for-human` (2026-08): staging for human-shaped work. Killed because the category
  was empty in practice - prep hardens the spec, the assignee field records who builds it,
  and umbrella epics live in `needs-triage` until prep decomposes them into bounded issues.
- `evidence-public` (2026-08): the public-publish ack, killed together with the
  per-criterion `visibility:` field. Runs publish artifact evidence to the tailnet-private
  plans host, always; there is no public-publish path from a run. If a repo ever declares
  `public-by-intent`, design that interlock fresh.

## The ready-for-agent contract

An issue may hold `ready-for-agent` only while ALL of these validate. The nightly lint
removes the label (and comments why) from any issue that stops conforming - the label is a
contract, not a vibe. This contract is the safety case for eventual unattended
auto-implementation; keep it strict.

1. **Restated why**: the body opens with goal + why, current enough that a cold reader
   needs no archaeology.
2. **Agreed approach - design closure is explicit**: the design decision(s), with ADR
   links where permanent. Either the shape is decided (ADR / body records it) or the body
   explicitly declares the shape free within stated bounds. An open design question
   anywhere in the spec fails the contract - design debate belongs in prep's dialectic,
   not in a run.
3. **`## Acceptance Criteria`** - the heading spelled exactly that way. The claim step
   snapshots the section by exact string match, so `Acceptance criteria` or `acceptance
   criteria` silently snapshots nothing and the run judges against an empty set. Every
   criterion:
   - is observable/testable as written (no "works well", no "should be fast" without a number);
   - is a task-list item (`- [ ]`) carrying an `evidence:` sub-bullet - the test, command,
     transcript, or capture that will prove it;
   - resolves to something a reviewer can open in a browser. Evidence obtainable only by
     cloning and running locally fails the point;
   - is in scope for ONE PR.

   One optional sub-bullet: `surface:` one of `ci` | `code` | `commit` | `artifact`.
   Absent → the ledger infers it from the evidence text. Artifact evidence publishes to
   the tailnet-private plans host, always.
4. **No open questions**: no `needs-info`/`needs-triage`/blocked labels; no unresolved
   question marks in the body's spec sections.
5. **Bounded scope**: one repo, one PR, no "and also refactor X across crates".
6. **Prior art checked**: related closed/`wontfix` work is linked, not re-proposed.

## Lint procedure (`/flow labels`)

1. `gh label list` → reconcile the full tuple: create missing taxonomy labels, repaint
   drifted colors, rewrite drifted descriptions. Delete nothing; labels outside the closed
   taxonomy are reported as drift for a human to remove.
2. For every open `ready-for-agent` issue: validate the six contract points (a scoped
   sonnet agent per issue; judgment calls escalate to the conductor). Non-conforming →
   remove label, add `needs-triage`, comment the specific failures.
3. For every `in-progress` issue: verify a live worktree/branch/PR actually exists;
   orphaned claims → clear back to `ready-for-agent` with a comment.
4. For every open issue with NO lifecycle label: add `needs-triage` with a comment.
5. Report: per-issue verdicts + what changed.

The nightly cron runs a narrower version: its allowlist has `gh label list` only, so step 1
is report-only there (tuple drift is a finding, not a fix), and it performs only the label
moves its standing permissions name - steps 2-4. Full reconciliation is this subcommand's
job, run interactively.
