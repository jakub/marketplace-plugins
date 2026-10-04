# Issue #26 live evidence (T3 seats), 2026-10-04

Branch head under test: `2ba79eb` (code), deployed into both flow plugin caches for the test window only; restored byte-for-byte afterwards. T3 Code nightly 0.0.46 (2632), Claude Code 2.1.288, Codex 0.160.0. Seat records (`NN-record/`) are copies of `~/.local/state/flow/seats/<id>/` after `seat close`.

| Criterion | Evidence |
|---|---|
| Setup trust step lists flow's keys with a digest, writes only flow's keys, reads back trusted | `01-trust-list.json` (7 existing keys trusted at their old positions, 3 new seat-guard keys untrusted), `03-trust-write.json`. The `config.toml` diff after the write added exactly the three `flow@jakub:hooks/codex.json:{pre_tool_use:2:0, stop:0:0, user_prompt_submit:0:0}` entries. |
| `seat open` refuses a Codex seat while a flow key is untrusted | `02-open-refused-untrusted.json` (`HOOKS_UNTRUSTED`, names the 3 keys) |
| Fallback rerun through `flow_delegate` | `31-flow-delegate.json` (fresh session's server, `succeeded`, served `gpt-6-luna`) |
| Claude parent: Claude child read-only / writer / review, verdict `valid` | `11-*`, `12-*`, `13-*` (bound `permissionMode: auto`, served `claude-sonnet-5-5`, spawn + MCP denied per `notes`, writer commit by path, review `coverage` lists all 7 diffed files) |
| Claude parent: Codex child read-only / writer / review, verdict `valid` | `21-*`, `22-*`, `23-*` (bound `permissionMode: default`, served `gpt-6-luna`/`gpt-6-sol`, `collaborationspawn_agent` denied, receipt stamps) |
| Codex parent: one Claude read-only seat, verdict `valid` | `52-*` (first attempt `51-first-attempt/`: the seat ran and was bound, but the parent's own capture tool failed and its retry was correctly refused by the admission gate, "already admitted once") |
| Full-access parent launches an explicit `auto` seat that reads back `auto` | every `NN-record/bound.json` (parents were full-access threads; children read back `auto` / `default`) |
| Critique continuation | `41-*`, `41-notes.txt` (`t3_thread_send` reached the finished child; turn 2 recorded a fresh valid result; close judged turn 2) |
| Plain sessions outside T3 write no seat state | `61-plain-claude.txt`, `62-plain-codex-excerpt.txt`, `61-seats-before.txt` == `61-seats-after.txt` |
| Runbooks the parents followed | `runbook-claude-parent.md`, `runbook-codex-parent.md` |
