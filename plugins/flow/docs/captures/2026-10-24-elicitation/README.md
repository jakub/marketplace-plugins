# Elicitation capture, issue #33

Live evidence for the `Elicitation` hook of issue #33 (`hooks/scripts/elicitation-guard.mjs`). A scratch MCP server asks the client for input nobody requested, and three runs show what each kind of session does with the request.

## What the capture proves

The hook is the guarantee that a T3 seat never puts a dialog in front of the human. A T3 `claudeAgent` child already auto-declines elicitations without any hook (measured 2026-10-24, about 2 ms, no pending request). So a decline in the server log cannot prove the hook ran. The hook's own fingerprint can: it files a `flow-seat-elicitation` gripe with the seat's session id. Each run reads a different part of that evidence.

| Run | Session | Server log | Gripe `flow-seat-elicitation` | Proves |
|---|---|---|---|---|
| 1 | T3 seat | `decline` for form and url | one per request, `session_id` equals the seat's | the hook runs in a seat and declines |
| 2 | T3 child, not a seat | `decline` for form and url | none | the decline in run 1 alone is not the hook, and a non-member is left alone |
| 3 | tty `claude` in tmux, not a seat | `cancel` for form and url | none | without a hook or T3, a human sees a dialog |

## Files

- `harness/server.mjs` is the scratch server. Its header explains why it elicits unprompted and how it gets Claude Code to service the request.
- `harness/tty-control.sh` takes run 3.
- `harness/summarize.mjs` prints each server log as request times, answers and latencies.

The server log holds methods, ids, modes and actions only. The committed files are protocol logs and the structure of the seat's close verdict. They hold no transcript and no envelope body.

## Retake it

Use a checkout at the commit under test, with `claude`, `tmux`, `node` and `gripe` on `PATH`. The state directory below is `$FLOW_DELEGATION_STATE_DIR`, or `${XDG_STATE_HOME:-$HOME/.local/state}/flow` when that is unset.

Installs pull from GitHub, so the branch's hook bytes do not reach a session by themselves. Before runs 1 and 2, copy the branch's `plugins/flow/` over the installed plugin cache directory for `flow@jakub`. After the runs, reinstall from main: `claude plugin uninstall flow@jakub && claude plugin install flow@jakub`. Check that the cache holds the branch's `hooks/hooks.json` with an `Elicitation` group before you start.

### Run 1: a T3 seat

1. Open a read-only Claude seat: `node plugins/flow/scripts/seat.mjs open --access read-only --provider claude --model <model> --effort <level> --worktree <checkout>`. Note the `id` it prints.
2. In the canonical checkout, register the server at local scope. The gate is the seat's receipt stamp, so the requests arrive only after the seat is a member:

   ```sh
   claude mcp add -s local elicit \
     -e ELICIT_LOG=<capture-dir>/run1-seat.jsonl \
     -e ELICIT_GATE=<state-dir>/seats/<id>/receipt.json \
     -- node <checkout>/plugins/flow/docs/captures/2026-10-24-elicitation/harness/server.mjs
   ```

   The server name goes before the first `-e`, because `-e` takes every argument up to `--`.

3. Start the seat with `delegate_task`, tagged as `flow:delegate` describes. Prompt the seat to read one file, run `timeout 20 tail -f /dev/null` in the foreground, and answer. Claude Code refuses a foreground `sleep`. Its first tool call writes `receipt.json`. The server waits 2 s, sends the form request, and sends the url request 1.5 s later.
4. Close the seat with `seat.mjs close <id> --task-status <json>` and keep the verdict.
5. File the evidence: `gripe dump --since <date> | grep '"trigger":"flow-seat-elicitation"'` shows the gripe rows, and `seats/<id>/bound.json` holds the seat's `sessionId`. `gripe search` matches the body alone, so it cannot find the trigger.
6. Remove the registration: `claude mcp remove -s local elicit`.

The seat cannot call the server's tool, because seat-guard denies `mcp__` tools outside the Context7 allowlist. That is why the server elicits unprompted.

### Run 2: a T3 child that is not a seat

Register the server again with a new `ELICIT_LOG` (`run2-child.jsonl`) and no `ELICIT_GATE`. Start a child with `delegate_task` and no seat tag. Prompt it to read one file and answer. Expect `decline` in the log and no new `flow-seat-elicitation` gripe. Remove the registration afterward.

### Run 3: a tty session

Run `bash plugins/flow/docs/captures/2026-10-24-elicitation/harness/tty-control.sh <new-output-dir>`. It starts `claude` in a detached tmux session with `--mcp-config` and `--strict-mcp-config`, saves the pane after each request, presses Escape, and waits for the summary line. A folder-trust prompt in the scratch directory gets one Enter. `CLAUDE_BIN` overrides the binary. The script exits 1 and prints the pane if any wait runs out.

Expect the form dialog in `form-dialog.txt`, the url dialog in `url-dialog.txt`, and `cancel` for both in `server.jsonl`.

### Read the logs

`node plugins/flow/docs/captures/2026-10-24-elicitation/harness/summarize.mjs <log>...` prints the request times, the answers and the latency from request to answer per log. The T3 runs answer in milliseconds. The tty run answers when the key press arrives.

## Results

Taken 2026-10-24, 17:48 to 17:50 UTC. The logs are under `runs/`.

- Claude Code version: 2.1.310. The issue names 2.1.309, which was current at prep.
- T3 Code version: v0.1.3-nightly.20261024.3617
- Tested code SHA: `6692985c73abce8452d3eff8f648dc7e0687e31e`, tree clean. The harness and guard bytes are that commit's.
- Hook bytes: `git archive 6692985 plugins/flow` overlaid on `~/.claude/plugins/cache/jakub/flow/0.42.0`, with `hooks/hooks.json`'s `Elicitation` group checked first. The plugin cache was reinstalled from main (`608f345`) afterward, and the check found no `Elicitation` group and no guard script.

| Run | Log file | Form action | Url action | Latency form / url (ms) | Gripe rows | Seat verdict |
|---|---|---|---|---|---|---|
| 1 seat | `runs/run1-seat.jsonl` | `decline` | `decline` | 30 / 28 | 2 (`runs/run1-gripe-rows.jsonl`); `session_id` matches `bound.json`'s `088a47a4-…`: yes | `valid` (`runs/run1-seat-close.json`) |
| 2 child | `runs/run2-child.jsonl` | `decline` | `decline` | 24 / 22 | 0 new | n/a |
| 3 tty | `runs/run3-tty/server.jsonl` | `cancel` | `cancel` | 2373 / 2877 | 0 new | n/a |

Notes:

- In run 1 the gate opened on the seat's `receipt.json`, so both requests arrived after the session was a member. The seat's envelope said no server asked it for input. The decline happened in the hook, and the model never saw the request.
- Run 2's child ran the same branch hook, which stayed silent for a non-member. T3's provider then declined on its own. The same auto-decline showed in a hookless probe before the run, at about 2 ms.
- Run 3's `form-dialog.txt` and `url-dialog.txt` show the "requests your input" form and the "wants to open a URL" dialog. The pane also shows the plan name the session runs under.
- `runs/run1-seat-close.json` keeps the verdict fields and the envelope's `status` alone. The envelope body is left out, because the shared agent rules keep agent-session message bodies out of commits.
