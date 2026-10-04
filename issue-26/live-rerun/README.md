# Issue #26 live confirmation re-run on the final code (`a0a8caf`)

The first live matrix (`../live/`) ran at `2ba79eb`. Fix round 5 changed the protocol (the gate requires `clientRequestId: flow-seat-<id>` and the record's effort; close is bound to the task and the latest turn; the shell rules shrank to a confused-seat guardrail), so this re-run confirms the final code end to end. Same window discipline: branch build deployed to both plugin caches, trust granted through `seat.mjs trust --write --expect` (`01-`, `02-`), caches and Codex config restored byte-for-byte afterwards.

- `71-*`: Claude read-only seat, verdict `valid`, bound `auto`, served `claude-sonnet-5-5`; `Agent` and the plain form `(git push origin HEAD)` denied.
- `72-*`: Codex writer seat, verdict `valid`, bound `default`, served `gpt-6-sol`; `spawn_agent` and `(git push origin HEAD)` denied; commit `36afadc` made by path in the scratch worktree.
- `73-*`: the parent gate refuses a tagged call with the wrong `clientRequestId` (names the required id); that seat closes `unknown` (admitted stamp missing).
