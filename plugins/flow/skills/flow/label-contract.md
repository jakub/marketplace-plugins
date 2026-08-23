# Label taxonomy & the ready-for-agent contract

## Taxonomy (the state machine)

```
 intake              staging                active          terminal
 ──────              ───────                ──────          ────────
 needs-triage  ──►   ready-for-agent  ──►   in-progress ──► closed (landed)
 agent-found   ─┘         │  ▲                  │
                (via /flow:prep only)           │
                                                ▼
                blocked lane (wait on human, ping phone):
                needs-info · needs-human · needs-rebase

                terminal-buried: wontfix · deferred  (never resurrected by agents)
```

| label | meaning | set by | cleared by |
|---|---|---|---|
| `needs-triage` | untriaged human-filed intake | human / tooling | /flow:prep |
| `agent-found` | scheduled-hunter quarantine; verified + deduped but not human-reviewed | hunters (`FLOW_SANCTION=hunter`) | /flow:prep |
| `ready-for-agent` | validates the contract below; eligible for /flow:issue | /flow:prep only | claim step of /flow:issue |
| `in-progress` | atomically claimed by a run | /flow:issue claim | /flow:land or escalation |
| `needs-info` | blocked on an answer only the human has | prep or run escalation | human answer + re-prep |
| `needs-human` | run escalated: adjudicated-real blockers survived the fix loop | /flow:issue | human review |
| `needs-rebase` | worktree conflicts with moved main | /flow:issue | human/agent rebase |
| `wontfix` / `deferred` | buried; prior-art scans note them, never re-propose them | human | human |
| `evidence-public` | modifier, NOT a lifecycle state: the human acked at prep that this issue may publish evidence to the public plans host | /flow:prep, on explicit human ack | human |

Rules:
- Exactly one lifecycle label at a time (intake/staging/active); blocked-lane labels stack
  on top of `in-progress`. `evidence-public` is orthogonal and stacks with anything.
- No agent creates issues outside `FLOW_SANCTION` lanes (enforced by the no-backlog hook).
- Nothing self-promotes: `agent-found → ready-for-agent` requires a /flow:prep pass.

## The ready-for-agent contract

An issue may hold `ready-for-agent` only while ALL of these validate. The nightly lint
removes the label (and comments why) from any issue that stops conforming — the label is a
contract, not a vibe. This contract is the safety case for eventual unattended
auto-implementation; keep it strict.

1. **Restated why**: the body opens with goal + why, current enough that a cold reader
   needs no archaeology.
2. **Agreed approach — design closure is explicit**: the design decision(s), with ADR
   links where permanent. Either the shape is decided (ADR / body records it) or the body
   explicitly declares the shape free within stated bounds. An open design question
   anywhere in the spec fails the contract — design debate belongs in prep's dialectic,
   not in a run.
3. **`## Acceptance Criteria`** — the heading spelled exactly that way. The claim step
   snapshots the section by exact string match, so `Acceptance criteria` or `acceptance
   criteria` silently snapshots nothing and the run judges against an empty set. Every
   criterion:
   - is observable/testable as written (no "works well", no "should be fast" without a number);
   - is a task-list item (`- [ ]`) carrying an `evidence:` sub-bullet — the test, command,
     transcript, or capture that will prove it;
   - resolves to something a reviewer can open in a browser. Evidence obtainable only by
     cloning and running locally fails the point;
   - is in scope for ONE PR.

   Two optional sub-bullets, carried only where they say something the repo's evidence
   posture (`AGENTS.md` § Operating notes) does not already:
   - `surface:` one of `ci` | `code` | `commit` | `artifact`. Absent → the ledger infers it
     from the evidence text.
   - `visibility:` `private` | `public`, meaningful ONLY under `surface: artifact` — every
     other surface inherits the repo's own access control. Absent means nobody decided, which
     resolves to private: the field records a decision, never a default.

   Publishing a capture to the public plans host needs `visibility: public` AND the
   `evidence-public` label. The label is the human's ack from prep, visible in the issue
   timeline; the field is the per-criterion selection. Both or neither — a stray field cannot
   expose a capture, and pulling the label demotes every criterion at once. A run that cannot
   resolve visibility from those two signals publishes privately and says so in the ledger.
4. **No open questions**: no `needs-info`/`needs-triage`/blocked labels; no unresolved
   question marks in the body's spec sections.
5. **Bounded scope**: one repo, one PR, no "and also refactor X across crates".
6. **Prior art checked**: related closed/`wontfix` work is linked, not re-proposed.

## Lint procedure (`/flow labels`)

1. `gh label list` → create any taxonomy labels missing (colors: intake gray, staging
   green, active blue, blocked red, buried dark gray).
2. For every open `ready-for-agent` issue: validate the six contract points (a scoped
   sonnet agent per issue; judgment calls escalate to the conductor). Non-conforming →
   remove label, add `needs-triage`, comment the specific failures.
3. For every `in-progress` issue: verify a live worktree/branch/PR actually exists;
   orphaned claims → clear back to `ready-for-agent` with a comment.
4. Report: per-issue verdicts + what changed.
