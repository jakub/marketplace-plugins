# MCP resource-tool capture, issue #37

Live evidence that a T3 seat on each host cannot read MCP resources. Two probe seats ran on the installed branch bytes, called every resource tool their host offers, and got the `(MCP resources)` deny from `toolProblem` in `lib/seat-policy.mjs`. The smoke cases in `scripts/smoke-seat.mjs` inject hook inputs. This capture shows the tool names the real hosts send.

## What the capture proves

| Host | Seat | Calls | Result | First tool in `receipt.json` | Close |
|---|---|---|---|---|---|
| Claude Code 2.1.310 | Haiku low, read-only | `ListMcpResourcesTool`, `ReadMcpResourceTool`, `ReadMcpResourceDirTool` | each denied, `(MCP resources)` | `ToolSearch` | `valid` |
| Codex 0.164.0 | Sol 6.1 low, read-only | `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` | each denied, `(MCP resources)` | `list_mcp_resources` | `valid` |

- The receipt records the first tool name the seat hook received, and nothing later. On Codex the first call was `list_mcp_resources`, so the receipt proves that Codex sends that name to PreToolUse without a prefix. On Claude Code the seat loaded the deferred tool schemas with `ToolSearch` first, so its receipt names `ToolSearch`.
- The deny lines come from each child's own transcript, not from the seat's report. Each line names the tool the hook denied.
- Codex ran each call inside its code-mode `exec` wrapper (`tools.list_mcp_resources(...)`). PreToolUse still received the inner tool name. The receipt shows that the first wrapper made no seat-hook call before its inner call, or the receipt would name the wrapper. For the second and third wrappers the capture cannot tell: the policy allows a wrapper by default, so a hook call for one would leave no deny line and no receipt change.
- A denied call does not void the seat. Both seats finished with a valid envelope and closed `valid` with no Stop block.

## Files

- `claude/tool-results.jsonl` and `codex/tool-results.jsonl`: one line per tool result in the child's transcript, with the tool name and the result text. The Claude `ToolSearch` result is a schema list, so its text is left out.
- `claude/receipt.json` and `codex/receipt.json`: each seat's write-once receipt, copied from `<state-dir>/seats/<id>/`.
- `claude/close.json` and `codex/close.json`: the verdict fields of `seat.mjs close`. The envelope body is left out.
- `probe-schema.json`: the answer schema both seats were opened with.
- `overlay-hashes.txt`: the sha256 of the policy, guard, store and wire files on the branch and in both installed caches during the probe. They are equal.
- `restore-hashes.txt`: the policy file in both caches after a reinstall from main, equal to the base commit.
- `mutations.log`: the `fastpath-silent` case against two mutations of `lib/seat-store.mjs`, under the old and the new smoke. See below.
- `smoke-all.log` and `HEAD.txt`: `node scripts/smoke-all.mjs` on the code head that `HEAD.txt` names, with a clean tree.

## The crypto mutations

`fastpath-silent` asserts that a PreToolUse call in a session that is no seat never loads `node:crypto`. The old check read a `registerHooks` resolve trace, which never sees `process.getBuiltinModule`. The new check reads `process.moduleLoadList` from an `--import` preload, and a seat bind in its own state directory must show `NativeModule crypto` first.

| Mutation in `seat-store.mjs` | Old smoke (`92c9117`) | New smoke |
|---|---|---|
| a top-level `process.getBuiltinModule("node:crypto")` | passes | fails: `a non-seat tool call loaded node:crypto` |
| a static `import "node:crypto"` | fails | fails |
| none | — | passes |

The first row is the vacuous pass that the issue reported.

## Retake it

Use a checkout at the code head under test, with `claude`, `codex` and `node` on `PATH`, inside a T3 thread. The state directory is `$FLOW_DELEGATION_STATE_DIR`, or `${XDG_STATE_HOME:-$HOME/.local/state}/flow` when that is unset.

1. Check that both installed caches equal the base commit. Extract the base tree with `git archive <base> plugins/flow | tar -x -C <tmp> --strip-components=2`, then run `diff -rq <tmp> <cache>` for each cache. Ignore the `.in_use` file in the Claude Code cache.
2. Copy the branch's changed files over `~/.claude/plugins/cache/jakub/flow/<version>/` and `~/.codex/plugins/cache/jakub/flow/<version>/`. Record their hashes.
3. The copy marks every flow hook in Codex `modified`, although `hooks/codex.json` and every hook script stayed the same. So Codex's `currentHash` covers more than the command string. On 2026-10-24 the trust digest was `967a9666…` at the base, `af7b1a6d…` with the overlay, and `967a9666…` again after the restore. Run `node plugins/flow/scripts/seat.mjs trust`, check the key list, then run `seat.mjs trust --write --expect <digest>`.
4. Open one read-only seat per host with `--schema <checkout>/plugins/flow/docs/captures/2026-10-24-resources/probe-schema.json`. `seat.mjs open` requires an absolute path. Start each with `delegate_task`, as `flow:delegate` describes, and prescribe the three calls. On Codex, make `list_mcp_resources` the first tool call so that the receipt records its name.
5. Read the deny lines from the child transcripts. Claude Code: `~/.claude/projects/<project>/<sessionId>.jsonl`, with the `sessionId` from `seats/<id>/bound.json`. Codex: `~/.codex/sessions/<date>/rollout-*-<sessionId>.jsonl`.
6. Close each seat with `seat.mjs close <id> --task-status <json>`.
7. Restore both hosts from main. Run `claude plugin uninstall flow@jakub && claude plugin install flow@jakub`, then `codex plugin marketplace upgrade && codex plugin remove flow@jakub && codex plugin add flow@jakub`. Grant Codex hook trust again as in step 3.
