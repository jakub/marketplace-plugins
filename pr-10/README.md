# Evidence for marketplace-plugins PR #10 - slice 4, the issue stage cross-harness

Every capture names the commit of `feat/issue-6-issue-stage` it ran against. The smokes and the
codex runs used `9905d11`; the claude runs used `c0ea755` (the branch head, which adds only the
capability re-verification `6e4fd9d` and two example-string bumps on top of `9905d11`).

## Live captures

- `capture-claim-race.txt` - two fresh clones of jakub/flow-land-scratch racing
  `issue-claim.mjs acquire 99` against the real GitHub remote. One `acquired`, one `held` on the
  actual receive-pack lock, the loser's ref state byte-identical to its own pre-race snapshot,
  then a live `abandon` under the winner's lease receipt. Helper at `9905d11`.
- `capture-preflight-fail.txt` + `capture-preflight-fail.rollout.jsonl` - a codex-hosted run
  against flow-land-scratch#3 with the installed `seat-contract.md` set mode 000. The preflight
  reports every other condition passing - including the live `codex-mcp-client 0.151.0` handshake
  matching the re-verified record - and stops on `canonical-seat-contract-readable` with exactly
  the ratified exemption footprint: `needs-human` plus one comment, zero other mutations
  (verified: no tag, no branch, no assignee). Plugin at `9905d11`.
- `capture-issue-codex-t1.txt` + `capture-issue-codex.rollout.jsonl` - the full codex-hosted
  issue run on flow-land-scratch#3 (session `01a05a0b`, plugin at `9905d11`), producing
  [PR #5](https://github.com/jakub/flow-land-scratch/pull/5), open and never merged, with the
  claim ledger, blind design pair, native writer, shadow rounds, throwaway negative-CI PR #6,
  and the opposite-family final review with its coverage continuation. The t1 file is the tail
  of the first turn, killed by the driver's own timeout mid-run; the rollout carries both turns,
  including the interrupted-turn recovery the journal records as `check-name-tripwire`. The
  twelve journal comments on the issue are the run's own record.
- `capture-issue-claude.jsonl` - the claude-hosted issue run on flow-land-scratch#4 through the
  installed alias (`claude -p --plugin-dir`, branch at `c0ea755`), producing
  [PR #7](https://github.com/jakub/flow-land-scratch/pull/7), open and never merged. The session
  transcript is the capture; the issue's launch, event, and final journal comments are the run's
  record, including the cross-family disagreement tripwire, the opus adjudication lens, the
  voluntary trust-boundary convergence tier, and the disclosed interruption.
- `capture-issue-claude-driftstop.jsonl` - the first claude attempt, stopped fail-closed at
  preflight on GENUINE version drift: the machine runs claude-code 2.1.252 against a table
  verified at 2.1.251. The stop comment on issue #4 enumerates the affected capability ids; the
  recovery is commit `6e4fd9d`, which re-verifies the five rows against 2.1.252 on the basis of
  this branch's own eleven-round run exercising them.

## Smoke transcripts (at `9905d11`, clean tree)

`capture-smoke-stage-conformance.txt` (3 stages discovered, 28 checks, every fixture red),
`capture-smoke-charter-conformance.txt` (22), `capture-smoke-seat-contract.txt` (13, both
mirror fixtures red), `capture-smoke-issue-claim.txt` (138, concurrent races, ambush, stale
clone, abandon), `capture-smoke-delegation.txt` (contract payload, client identity, drift
decision against both real records), `capture-smoke-bundle-drift.txt` (byte-identical),
`capture-smoke-codex-hooks.txt`, `capture-smoke-git-guard.txt`, `capture-smoke-release-path.txt`,
`capture-smoke-claude-delegation.txt`, `capture-smoke-manifests.txt`.

## Honest gaps

Neither live run produced a suspended trust fork or a stale-anchor rejection, and the reason is
structural rather than accidental: both issues arrived with their trust posture settled at prep,
as the label contract requires, so the runs transcribed ratified rules instead of setting new
ones. Only a mid-run trust surprise triggers the suspension path, and neither issue held one.
The suspension machinery's stop shape is demonstrated by the two fail-closed preflight captures;
the stale-anchor path is exercised by no capture in this set.
