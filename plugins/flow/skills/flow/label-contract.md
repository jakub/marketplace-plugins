# Labels and the ready-for-agent contract

## The labels

Each label's name, color and description together are the contract, so a label with the right name and a drifted color or description is drift. `scripts/lint-actions.mjs survey` reads this table by its `label`, `color` and `description` header cells and reports drift against it. A name is lowercase letters and hyphens, a color is six lowercase hex digits, one lane has one color, and a description is at most 100 code points with no `/`. GitHub copies the description into label metadata on every repository, where a host's slash command does not belong.

| label | lane | color | description (verbatim) |
|---|---|---|---|
| `needs-triage` | intake | `fbca04` | Untriaged intake; exits only through the prep stage |
| `agent-found` | intake | `fbca04` | Scheduled-hunter quarantine: verified + deduped, not human-reviewed |
| `ready-for-agent` | staging | `0e8a16` | Design-hardened per the label contract; eligible for the issue stage |
| `in-progress` | active | `1d76db` | Claimed by an issue stage run: assignee + this label |
| `needs-info` | blocked | `b60205` | Blocked on an answer only the human has |
| `needs-human` | blocked | `b60205` | Run escalated: adjudicated-real blockers survived the fix loop |
| `needs-rebase` | blocked | `b60205` | Worktree conflicts with moved main |
| `wontfix` | buried | `6e6e6e` | Buried by human decision; agents never resurrect |
| `deferred` | buried | `6e6e6e` | Consciously parked; agents never resurrect |

Type modifiers stack with any label and keep GitHub's stock colors and descriptions: `bug` (`d73a4a`), `enhancement` (`a2eeef`), `documentation` (`0075ca`).

## Rules

- Every open issue carries exactly one lifecycle label. An open issue with none is drift. A blocked label stacks on top of the lifecycle label it interrupts.
- The set is closed: the table plus the three modifiers. Any other label is drift, reported and never deleted, because deleting a label strips it from every issue in the repository with no undo.
- Issues are born only in the two sanctioned lanes, `FLOW_SANCTION=prep` and `FLOW_SANCTION=land`, which the no-backlog hook enforces. Neither lane files into `agent-found`.
- Nothing promotes itself: only a prep pass sets `ready-for-agent`.
- A claim is the assignee plus `in-progress`. The claim tag on origin lives only from the claim's scan to the first push of the work branch. After that, the branch, the worktree and the PR mark the run as live, and a tag that stays is a stale claim for the human.
- The nightly lint moves labels only through `lint-actions.mjs relabel`, in three moves: an orphaned `in-progress` issue back to `ready-for-agent` after six hours, a `ready-for-agent` issue that fails the contract to `needs-triage`, and an issue with no lifecycle label to `needs-triage`.

## The ready-for-agent contract

An issue holds `ready-for-agent` only while all six points hold. The contract is the safety case for unattended implementation, so keep it strict.

1. **Restated why.** The body opens with the goal and why, current enough that a cold reader needs no archaeology.
2. **Agreed approach.** The design decisions are recorded, with ADR links where they are permanent, or the body declares the shape free within stated bounds. An open design question anywhere in the spec fails the contract, because design debate belongs in prep's dialectic.
3. **`## Acceptance Criteria`**, spelled exactly so. The claim snapshots the section by exact heading, so `Acceptance criteria` snapshots nothing and the run judges against an empty set. Every criterion is testable as written, is a `- [ ]` item with an `evidence:` sub-bullet naming the test, command, transcript or capture that proves it, resolves to something a reviewer can open in a browser, and fits in one PR. One optional sub-bullet, `surface:`, takes `ci`, `code`, `commit` or `artifact`. Without it, the ledger infers the surface from the evidence text. Artifact evidence always goes to the tailnet-private plans host.
4. **No open questions.** No `needs-info`, `needs-triage` or blocked label, and no unresolved question in the body's spec sections.
5. **Bounded scope.** One repository and one PR, with no "and also refactor X across crates".
6. **Prior art checked.** Related closed or `wontfix` work is linked, not proposed again.

## Reconciling labels

The `labels` subcommand does this interactively. The nightly lint does the same checks but only reports label drift, and moves issues only through `relabel`.

1. Run `node <plugin-root>/scripts/lint-actions.mjs survey <repo>`. Create each label in `labels.missing` with `gh label create`, and fix each one in `labels.drifted` with `gh label edit`. Report `labels.extra` for the human, and delete nothing.
2. Check every open `ready-for-agent` issue's body against the six points, with one read-only seat per issue when there are many. Move a failure with `lint-actions.mjs relabel <repo> <N> --from ready-for-agent --to needs-triage --seen <updatedAt> --reason <the_failed_point>`.
3. Make the other two moves the same way, with the survey's `updatedAt` as `--seen`. Report an issue with two lifecycle labels to the human.
4. Report a verdict per issue and what changed.
