# Cross-family delegation

This is the maintenance record for `plugins/flow/delegate/`. To call the tools, read `skills/delegate/SKILL.md` instead. Nothing here repeats it.

The provider behavior below was checked on 2026-09-29 against Codex CLI 0.159.0 and Claude Code 2.1.284, with real read-only jobs in both directions through the server. `node plugins/flow/scripts/smoke-delegate.mjs` proves the contract against fake providers in about 30 seconds, most of it one job running out its 30-second budget.

## What each file owns

The server is six files that need Node 22 or later and Node built-ins only. There is no build step, no bundle and no npm dependency, so an edit takes effect on the next server start.

| File | Owns |
| --- | --- |
| `main.mjs` | The entry. `mcp --host claude\|codex` serves MCP on stdio. `run --job <id>` runs one job. |
| `server.mjs` | MCP over stdio, by hand: `initialize`, `ping`, `tools/list`, `tools/call`, `notifications/cancelled`, and one outbound request, `roots/list`. |
| `jobs.mjs` | Admission, the job directory, the write lease, the runner spawn, waiting, cancel, reconciliation and the 14-day prune. |
| `providers.mjs` | Per target: the PATH lookup, argv, stdin, environment, the Claude sandbox settings and the fold from JSONL to an outcome. |
| `runner.mjs` | The detached process that runs one job, and `delegatedInstructions`, which builds the seat block. |
| `schema.mjs` | The JSON Schema subset a structured answer is checked against: `schemaProblem` at admission, and `checkAnswer`, which runs `validate` in a child process before success. |

`bin/flow-delegate` is the Codex launcher. Codex passes a plugin MCP server's command to the launcher without expanding variables, so a command on PATH is the only way to start the server in the thread's project directory. The launcher reads `--flow-version`, imports `$CODEX_HOME/plugins/cache/jakub/flow/<version>/delegate/main.mjs` into its own process, and exits 1 naming that path when the file is missing. `scripts/install-delegate.mjs install` copies the launcher to `~/.local/bin/flow-delegate` when that copy is missing or differs. Codex starts MCP servers before SessionStart hooks run, so the flow skill's `setup` runs the installer once, and the Codex SessionStart hook keeps the copy current after that.

## Contracts that bind an edit

- The tools declare an `inputSchema` and no `outputSchema`, so no client validates `structuredContent`. Every result is `{ok, job?, error?}`, and the doctor adds its own fields. The same object goes out twice: as `structuredContent`, and as JSON text whose first line is `summary`.
- `error.kind` is the closed set listed in the delegate skill. Add a new kind to that list in the same commit as the code.
- A delegated prompt starts with `seatPayload(charter.md)`, byte for byte, read from `charter/charter.md` when the job runs. The `<delegated-seat>` block follows it. On Codex both go to stdin ahead of the caller's prompt. On Claude both go in `seat.md` through `--append-system-prompt-file`, and stdin carries the caller's prompt alone. No rule rides in caller prose. `smoke-delegate.mjs` checks the bytes.
- Provider stderr and stack traces go to `stderr.txt` and `server.log`, never into a tool result. An error message the provider put in its own JSONL may appear, clipped to 500 characters.
- An outcome needs native proof. Success needs a terminal event (`turn.completed` from Codex, a `result` frame from Claude) and an answer. A running job whose runner is gone reads `unknown` with `RUNNER_LOST`.
- A job with a schema succeeds only when its answer conforms to it, checked by `schema.mjs` and not taken on trust from either provider, since Codex narrows a schema outside its subset without saying so. A schema is admitted only when every keyword in it is one `schema.mjs` checks or an annotation, so no admitted schema is checked in part. A new keyword goes into both of its functions at once. The check runs in a child process that is killed after 10 seconds, and an answer it did not finish checking fails `SCHEMA_OUTPUT`. Admission bounds the schema but not the check: shared references can multiply the work at every level, and a pattern can backtrack without end. The runner holds the job and its lease until the outcome is written, so the check must not run in the runner itself.

## Roots

A root comes from the host, never from the call or the environment. On Claude the roots are the client's `roots/list` answer and `CLAUDE_PROJECT_DIR`, asked for again on every call. On Codex the one root is `process.cwd()` when it equals `git rev-parse --show-toplevel` and is not `$HOME`. Otherwise there is no root and every start fails `NO_ROOTS`.

A job's `cwd` and its Git top level must both resolve, through `realpath`, inside a root. Inherited `PWD`, `CODEX_PROJECT_DIR`, `GIT_DIR` and `GIT_WORK_TREE` are ignored: the server runs Git with every `GIT_*` variable removed and with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`. A job is visible only to a server for the same host whose roots contain the job's `cwd`. The state directory is shared by every session, so a job id from another workspace reads `JOB_NOT_FOUND`.

## Job state

The state directory is `${FLOW_DELEGATION_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/flow}`. It holds `jobs/<uuid>/`, `leases/` and `server.log`. A job directory holds `job.json`, `prompt.txt`, `schema.json` when a schema applies, `seat.md`, `events.jsonl`, `last.txt` from Codex, `stderr.txt` and a private `tmp/` that becomes the provider's `TMPDIR`.

Writers replace `job.json` only by rename, so a reader sees the old record or the new one. While a runner lives, it is the only writer of its job. The server writes a record to create it, to cancel a job no runner has claimed, and to settle a job whose runner is gone. A `claim` file decides who moves a queued job. It is linked into place already holding its holder's pid and start token, so a late runner, a cancel and a lease takeover never both act on one job, and a job whose holder died can still be settled. A `cancel` file asks a running job to stop. When a server starts, it removes terminal job directories older than 14 days.

A write job holds `leases/<sha256 of its worktree's real path>/`, a directory holding one file named for the job. The lease is built under a private name and renamed into place whole, and `rename(2)` onto a directory that is not empty fails, so two admissions cannot both take it. It is keyed on the job's Git top level rather than its `cwd`, so two write jobs in different subdirectories of one worktree still collide. Before a lease is taken over, its holder is reconciled: a job queued past its minute is claimed and settled, so its runner can never start it later, and a running job whose runner is gone has its provider group killed and reads `unknown`. A lease whose holder has ended is then taken over by moving out the file under that job's own name and removing the directory only if it is then empty. A lease that changed hands in between has a different file name, so no release and no takeover can remove it. Read-only jobs take no lease.

## The runner

The server spawns `node main.mjs run --job <id>` detached, with its stdio closed, so a job outlives the server and the session. The runner records its pid and its start time (field 22 of `/proc/<pid>/stat`) in `job.json`. A reader compares both to tell a live runner from a recycled pid.

The runner spawns the provider in its own process group, with a fixed set of environment variables, and records the group's leader pid and start time. A recorded group is signalled only while its leader is that process, or while the leader is gone and members remain, which the kernel keeps unambiguous by never reusing an id a live group carries. A leader pid that names a process with another start time means the id was reused, and nothing is sent, however long after the job a reader settles it. It appends every stdout line to `events.jsonl` unchanged and folds the lines that parse as JSON. Three things stop a job: its time budget, 420 seconds with no stdout line, and the `cancel` file, which the runner polls every 500 ms. A stop sends `SIGTERM` to the group and `SIGKILL` 10 seconds later. The runner writes the provider's thread id into `job.json` as soon as the stream names it, so a running job can be steered: a `continue` naming it stops the job through the `cancel` file, waits up to 15 seconds for it to end, and starts the continuation on the same thread. A job with no thread yet is refused and left running. When the provider exits, the runner kills whatever is left in its group, releases the lease, and then writes the outcome. A native success stands even when a stop raced it. A refusal or a model swap that the provider already showed outranks the stop that followed it.

## Why each provider runs the way it does

The argv lives in `providers.mjs`. These choices are the ones an edit is most likely to undo.

- `codex exec --ignore-user-config` skips `$CODEX_HOME/config.toml`, which is where the host's MCP servers, plugins and hook trust live, so a delegated Codex job loads none of them. Sign-in still works. `-s read-only` or `-s workspace-write` is the OS sandbox.
- `codex exec resume` accepts neither `-s` nor `-C`. A continuation sets `-c sandbox_mode=...` and runs in the spawn's `cwd`.
- `claude -p --setting-sources "" --strict-mcp-config` loads no settings file, plugin, skill or MCP server. Settings passed with `--settings` still apply, and they carry the containment.
- Claude's sandbox covers Bash only. `Read`, `Grep` and `Glob` use permission rules, so the credential paths and `/proc` appear twice: as `sandbox.filesystem.denyRead` for Bash, and as `Read(//path)` deny rules for the file tools. `Edit` is allowed inside the worktree on a write job and nowhere else.
- The sandbox masks a provider executable only when its real path names the provider. On this machine `codex` is a mise shim that resolves to `/usr/bin/mise`, and masking it replaced mise with `/dev/null` inside the sandbox, which broke `node` and every tool mise serves.
- `--permission-mode dontAsk --permission-prompts none` turns every would-be prompt into a denial. The result frame lists the denials, and a turn with any fails `APPROVAL_REQUIRED` with its answer kept.
- The Claude environment carries `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` and `CLAUDE_CODE_NO_MODEL_FALLBACK=1`. Neither is public API, so the fold also compares every assistant frame's model with the `system` init frame's, ignoring `<synthetic>` and a `[1m]` suffix. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` keeps a job out of the human's project memory.
- A provider sees `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `TERM`, `TZ`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_*` and `LC_*`, plus `TMPDIR`, `FLOW_DELEGATION_DEPTH=1` and `FLOW_DELEGATION_JOB`. A server that finds `FLOW_DELEGATION_DEPTH` in its own environment refuses to start a job, so delegation is one hop deep.
- Only absolute PATH entries count when the server looks for a provider, so a worktree can never supply the executable.

## Limits accepted on purpose

- A provider that double-forks out of its process group survives cancel and can outlive the lease. Every recorded job to date was read-only. If a write job ever needs proof of death, run the provider under a systemd scope and read the scope's cgroup before releasing the lease.
- `--ignore-user-config` skips only `$CODEX_HOME/config.toml`. A repository's own `.codex/config.toml` still loads inside a delegated Codex job.
- Codex's `-s` modes confine writes, not reads, so a Codex job can read files that a Claude job cannot.
- Flow's PreToolUse hooks do not load inside a delegated job. A write job is confined to its worktree and nothing narrower, so it can edit a lockfile or an `.env` file there.
- Codex reports no served model, so the model-swap check covers Claude only.
