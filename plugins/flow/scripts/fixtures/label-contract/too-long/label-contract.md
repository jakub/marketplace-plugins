# Mini label contract

A copy of the taxonomy that is legal except in one place: `mini-ready` carries a description
past the 100-code-point ceiling, which GitHub would accept and no reviewer would ever read to
the end. The label smoke runs its checker over this file and requires that one problem and no
other. Nothing loads it at runtime.

## Taxonomy (the state machine)

| label | lane | color | description (verbatim) | set by | cleared by |
|---|---|---|---|---|---|
| `mini-triage` | intake | `fbca04` | Untriaged intake; exits only through the prep stage | human | the prep stage |
| `mini-found` | intake | `fbca04` | Hunter quarantine: verified and deduped, not human-reviewed | hunters | the prep stage |
| `mini-ready` | staging | `0e8a16` | Design-hardened per the contract and eligible for the issue stage, with every reason it got there spelled out at length | the prep stage | the issue stage |
| `mini-active` | active | `1d76db` | Claimed by an issue stage run: assignee + this label | the issue stage | the land stage |
| `mini-info` | blocked | `b60205` | Blocked on an answer only the human has | prep escalation | human answer |
| `mini-human` | blocked | `b60205` | Escalated: a real blocker survived the fix loop | the issue stage | human review |
| `mini-rebase` | blocked | `b60205` | Worktree conflicts with moved main | the issue stage | human rebase |
| `mini-wontfix` | buried | `6e6e6e` | Buried by human decision; agents never resurrect | human | human |
| `mini-deferred` | buried | `6e6e6e` | Consciously parked; agents never resurrect | human | human |

Type modifiers - orthogonal, stack with anything, stock colors and descriptions:
`mini-bug` (`d73a4a`), `mini-enhancement` (`a2eeef`), `mini-documentation` (`0075ca`).

## Rules

- Every open issue carries exactly one lifecycle label.
- The taxonomy is closed: the table plus the three modifiers is the whole legal set.
