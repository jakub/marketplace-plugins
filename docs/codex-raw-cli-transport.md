# Plan: rebuild the codex callout on the raw CLI

Full model/effort/fast-mode support, streaming-aware execution, hardened error handling,
input/output validation. Replaces the dead companion-plugin transport. Facts below verified
live on this machine, **as-of 2026-08-02, codex-cli 0.146.0** — re-verify per drift-audit
policy after a quarter.

## 0. Verified ground truth

Everything in this section was established empirically this session, not from memory.

**The companion is gone.** `~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs`
matches nothing; the `openai-codex` marketplace is absent from `installed_plugins.json`,
`known_marketplaces.json`, and the cache. Every codex leg in `issue.mjs` currently degrades
to its `CODEX_UNAVAILABLE` sentinel; the delegate agent reports-and-stops. The `/codex:*`
commands and `codex-rescue` agent referenced in the docs shipped with that plugin and no
longer exist — those references are stale.

**Models** (embedded catalog + live probes; catalog is server-driven via `ModelsResponse`,
so treat the local list as advisory):
- `gpt-5.6-sol` — flagship tier; the alias `gpt-5.6` routes here. Config default.
- `gpt-5.6-terra` — mid tier (present in catalog; role between sol and luna).
- `gpt-5.6-luna` — **nano-like tier** "for high-throughput, simple, or strict-latency
  tasks" (CLI's own docs). Luna+`max` verified working. It is the cheap-fast seat, not a
  premium one.
- `gpt-5.5`, `gpt-5.4` — previous generations, still routable.

**Reasoning efforts:** `minimal | low | medium | high | xhigh | max` (binary also carries
`ultra`/`custom` variants, not advertised — exclude). Per-model support is server-advertised
(`supported_reasoning_levels`). There is **no `--effort` flag** — only
`-c model_reasoning_effort=<v>`. The user config default is now `xhigh`
(`~/.codex/config.toml`), not `high` as framework.md claims — pre-existing doc drift.

**Fast mode:** feature flag `fast_mode` is stable + enabled. Per-run knob:
`-c service_tier=priority`. Critical behavior verified: an unsupported/bogus tier value
exits 0 with only a stderr warning — `Configured service tier 'X' is not advertised as
supported for model 'Y' and will be omitted from requests` — i.e. **fail-open silent
degrade**. The transport must detect that warning and report `fast: {requested, applied}`
honestly.

**Error surfaces:**
- Bad model → exit 1, parseable `ERROR: {"type":"error","status":400,...}` line.
- Bad effort → exit 1, status 400.
- Bad service_tier → exit 0, warning only (see above).
- Missing binary → spawn ENOENT. Usage error → exit 2.
- Auth expiry strings exist ("Please log out and sign in again") — map to an AUTH kind.

**Output surfaces:**
- `--json`: JSONL events — `thread.started`, `turn.started`, `item.started`,
  `item.completed` (item.type: `agent_message` | `command_execution` | `reasoning` |
  `error`), `turn.completed` with
  `usage {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}`.
  Enabled under-development features inject `error`-type items whose message starts
  "Under-development features enabled" — filter, don't fail on them.
- `-o <file>`: last agent message written to a file.
- `--output-schema <file>`: exec only (not `exec review`); server-enforced JSON shape.
- `exec review --base <ref> | --uncommitted --json`: findings arrive as a final prose
  `agent_message` using the `[P1] title — file:line-range` convention, **not** structured
  JSON. A custom PROMPT argument conflicts with `--uncommitted`/`--base` (usage error).
- The binary embeds a canned instruction for numeric `priority` (0–3 for P0–P3) in
  JSON-emitting review paths — the `[P#]` convention is load-bearing upstream, safe to parse.

## 1. Architecture — one transport script

New file: `plugins/flow/scripts/codex-exec.mjs`. Plain JS, Node ≥ 18, zero dependencies.
Single source of truth for every codex invocation: the delegate agent and both `issue.mjs`
legs call this script and nothing else. This kills the current split-brain (companion for
task/review, raw CLI for schema mode) and gives one place to harden.

```
node codex-exec.mjs <task|review|adversarial-review>
  --cwd <dir>                          # required, always explicit
  [--model <id>] [--effort minimal|low|medium|high|xhigh|max]
  [--fast]                             # -c service_tier=priority
  [--write]                            # -s workspace-write (default read-only)
  [--schema <file>]                    # task mode: --output-schema passthrough
  [--base <ref>]                       # review/adversarial modes
  [--timeout-secs N] [--stall-secs N]
  [--events <file>]                    # JSONL event journal (default: tmpdir, path echoed)
  prompt on stdin (task/adversarial modes)
```

**Result envelope** — exactly one JSON object on stdout, machine-first:

```json
{
  "ok": true,
  "mode": "task", "model": "gpt-5.6-luna", "effort": "max",
  "fast": { "requested": true, "applied": true },
  "exitCode": 0, "durationMs": 48211,
  "tokens": { "input": 19409, "cachedInput": 0, "output": 5, "reasoning": 0 },
  "output": "…final agent message…",
  "findings": [ { "priority": 1, "title": "…", "file": "…", "lines": "2-2", "detail": "…" } ],
  "error": null,
  "eventsPath": "/tmp/codex-exec-…/events.jsonl"
}
```

Wrapper exit code: 0 whenever an envelope was produced (even `ok:false` — the envelope IS
the report); nonzero only if the wrapper itself blew up. Callers branch on `.ok`/`.error.kind`,
never on grep.

**Error taxonomy** (`error.kind`): `NOT_INSTALLED`, `AUTH`, `BAD_MODEL`, `BAD_EFFORT`,
`RATE_LIMIT`, `TIMEOUT`, `STALL`, `EMPTY_OUTPUT`, `SCHEMA_MISMATCH`, `PARSE`, `USAGE`,
`UNKNOWN` — plus `retried: bool` and a verbatim `detail`.

**Input validation** (fail fast, before spawn, kind `USAGE`):
- prompt non-empty for task/adversarial; effort ∈ enum; model matches
  `^[a-z0-9][a-z0-9.-]*$` but unknown models are *passed through* (catalog is
  server-driven — the server 400 maps to `BAD_MODEL`); `--cwd` exists and is a directory;
  `--write` refuses without an explicit `--cwd`; `--schema` file exists, parses, is
  `type: object`; `--base` resolves via `git rev-parse` in cwd; timeouts within sane bounds.

**Spawn:** `child_process.spawn` (argv array, no shell — prompt via stdin, no heredoc
quoting bugs), detached process group so kill reaps codex's children. Base argv:
`codex exec --skip-git-repo-check -s read-only --ephemeral -C <cwd> --json --color never`
plus `-m`, `-c model_reasoning_effort=`, `-c service_tier=priority`, `--output-schema`,
`-s workspace-write` as requested.

**Streaming & liveness** (the honest version of "streaming UX"): true token-streaming to
the end user is not reachable across the subagent boundary — what the event stream *does*
buy is used fully:
- every JSONL event appended to `--events` journal on disk as it arrives (charter: disk
  over chat; post-mortems read the journal, and a caller polling `BashOutput` in background
  mode sees `item.started`/`item.completed` progress lines live);
- **stall watchdog**: no event for `--stall-secs` (default 300 — `max`-effort reasoning
  gaps are long) → kill process group, `STALL`, one retry;
- **hard deadline** `--timeout-secs` (defaults: task 900, review 1200) owned by the
  wrapper and TOTAL across attempts (a per-attempt deadline would silently double under
  retry). Foreground callers must fit inside the Bash tool's 10-minute ceiling: pass
  `--timeout-secs 540` and set the tool timeout to 600000; anything longer runs in
  background with an explicit `--events` path;
- ERROR lines, usage, and the final `agent_message` captured from the same stream;
  under-development warning items filtered by prefix match.

**Output validation:**
- `ok` requires exit 0 **and** a non-empty final agent message (`EMPTY_OUTPUT` otherwise —
  an errored check is UNKNOWN, never a pass);
- schema mode: wrapper re-validates the output against the schema (minimal structural
  check: required/type/enum, ~40 lines, no dependency) → `SCHEMA_MISMATCH`;
- fast mode: stderr scanned for the "not advertised as supported … omitted" warning →
  `fast.applied: false`;
- `review` mode: parse `[P#] title — file:lines` blocks into `findings[]`, keep the raw
  prose in `output` as fallback;
- `adversarial-review` mode: does **not** use `exec review` (prose-only, no custom prompt
  with `--base`). Instead: `exec` + `--output-schema` with a findings schema matching
  `issue.mjs`'s `FINDING` shape + an adversarial framing prompt over
  `git diff <base>...HEAD` — structured findings, no parsing heuristics.

**Retry policy** (inside the wrapper, max one retry per call):
- `RATE_LIMIT` (429 / "rate limit" in ERROR line): 30s backoff, retry once.
- `STALL` / `TIMEOUT`: retry once, same parameters.
- `AUTH`: no retry; `detail` says "run `codex login`".
- `BAD_MODEL` / `BAD_EFFORT` / `USAGE` / `NOT_INSTALLED`: no retry — caller decides.

## 2. `agents/codex-delegate.md` rewrite

- Contract gains `fast: bool` and the full effort enum incl. `max`; model examples become
  `sol | terra | luna` (drop stale `spark`); default-effort note corrected to `xhigh`
  (config default, as-of 2026-08).
- Locate step targets our own plugin:
  `${CLAUDE_PLUGIN_ROOT}/scripts/codex-exec.mjs`, with fallback glob
  `ls ~/.claude/plugins/cache/*/flow/*/scripts/codex-exec.mjs | sort -V | tail -1` — the
  script ships in the same plugin as the agent, so if the agent is running, the file
  exists. (Verify at impl time whether agent bodies interpolate `${CLAUDE_PLUGIN_ROOT}`;
  the glob works regardless.)
- `background: true` → pass an explicit `--events <file>` (the default journal lives in a
  random tmpdir named only by the final envelope, so it cannot be polled live), then
  `run_in_background` Bash + `BashOutput` polling of that file; report progress lines,
  return the envelope at completion. The companion's job broker is replaced by
  harness-native tracking.
- Output contract: keep the single header line, sourced from envelope fields, now
  including `fast=<requested>/<applied>`; below it the verbatim `output` (or the findings
  JSON, or the error envelope). Never fabricate on `ok:false` — pass the kind + detail.
- Delete: companion locate, the schema-mode raw-CLI escape hatch (unified now), retry
  instructions (wrapper owns retries; agent retries only `NOT_INSTALLED` → report).

## 3. `workflows/issue.mjs` changes

- **Args:** `codexModel`, `codexEffort`, `codexFast`, `pluginRoot` (threaded by the
  conductor like `implModel`/`implEffort`; conductor flags `--codex-model`,
  `--codex-effort`, `--codex-fast` added to `commands/issue.md` argument-hint + arg-parse).
- **`CODEX_LOCATE` (line ~65) replaced** with resolution of `codex-exec.mjs`:
  `A.pluginRoot` when provided, else the fallback glob. One constant, used by both prompts.
- **`codexDesignPrompt` (~301):** run the script in `task` mode, default `--effort high`
  (today's pinned behavior), overridden by `codexEffort`/`codexModel`/`codexFast` when
  present. Sentinel contract unchanged, but the reason string now carries `error.kind`:
  `CODEX_UNAVAILABLE: RATE_LIMIT — …` — the journal finally distinguishes "not installed"
  from "rate-limited today".
- **`codexAdversarialPrompt` (~353):** `adversarial-review` mode → envelope `findings[]`
  map 1:1 onto the `FINDINGS` schema (priority→severity: P0→critical, P1→high, P2→medium,
  P3→low; keep the standing confidence=55 rule and the systemic-only escalation rule).
- **Degrade visibility:** transport agent instructed to prepend `CODEX_FAST_DEGRADED` to
  its report when `fast.requested && !fast.applied`; the workflow `log()`s it.
- Final codex re-verify + bonus gate (~805–815): shape unchanged, new prompt constants.
- **Seat defaults unchanged:** sol stays in both fabric seats. Luna is deliberately NOT
  routed into design/adversarial seats even as a fallback — the seat exists for
  decorrelated *intelligence*; a nano tier there weakens the only cross-model signal in
  the run. Luna's home is explicit bulk delegation via the delegate agent.

## 4. Docs

- **`skills/flow/framework.md` §2:** the `gpt-5.6-sol` row becomes a family row — sol
  (default, both fabric seats), terra (mid), luna (nano: bulk/latency work; never the
  adversarial seat); effort surface `minimal…max`, server-gated per model; config default
  corrected to `xhigh`; fast mode documented incl. the silent-omit caveat; **purge
  `/codex:*` and `codex-rescue` references** (died with the companion plugin); `as-of
  2026-08`.
- **`charter/charter.md`:** update the codex line(s) (~34, 50): delegate agent is the only
  route now; drop `/codex:*`. Keep it to existing line count — charter is context-budgeted.
- **`skills/flow/drift-audit.md`:** add one audit line: `node scripts/smoke-codex-exec.mjs`
  passes and the §0 facts here are < one quarter old.
- `commands/prep.md:40` (codex-delegate pass): compatible as-is; no change.

## 5. Tests

- **`scripts/smoke-codex-exec.mjs`** (pattern: existing smoke harnesses): a PATH-shimmed
  fake `codex` (shell/node stub that records argv and replays canned JSONL) driving the
  wrapper through: happy path; model/effort/fast argv mapping; pre-spawn `USAGE`
  rejections (bad effort, missing cwd, write-without-cwd, bad schema); ERROR-line →
  `BAD_MODEL`; rate-limit → one retry then envelope; stall → kill + retry; empty output;
  schema mismatch; `[P#]` review parsing incl. multi-finding and no-finding; fast-degrade
  warning detection; ENOENT → `NOT_INSTALLED`. No network, deterministic.
- **`scripts/smoke-issue.mjs`:** extend the result-contract checks for the new arg names
  and the sentinel-with-kind format (line ~144 already asserts codex in coverage).
- **Live smoke** (env-gated `CODEX_LIVE=1`, not in CI): luna/low task "Reply OK", assert
  envelope fields; one `--fast` run asserting `fast.applied`.

## 6. Rollout

1. Branch `feat/codex-raw-cli` (multi-commit). Commit sequence:
   `feat(flow): add codex-exec raw-CLI transport + smoke` →
   `feat(flow): rewrite codex-delegate on the transport` →
   `feat(issue): thread codex seat overrides through the workflow` →
   `docs(flow): codex model family, efforts, fast mode; purge companion refs` →
   `chore: bump flow to 0.5.0, mirror marketplace versions`.
2. Version bumps per repo invariants: `plugins/flow/.claude-plugin/plugin.json` 0.4.0 →
   0.5.0, mirrored in `.claude-plugin/marketplace.json` + `metadata.version` bump.
3. Reinstall `flow@jakub`; live verification: delegate task on luna/`max`, delegate
   `--fast` run, all smokes green — evidence linked per charter.

## Open decisions (defaults chosen; flag disagreement)

- **Raw CLI over reinstalling the companion** — settled in prior discussion.
- **Luna excluded from default fabric seats** — override flags exist for experiments.
- **Fast mode default off** everywhere; natural pairing is luna+fast for bulk mechanical
  delegation, opt-in per call.
- **Warning noise**: the `default_mode_request_user_input` under-development warning is
  filtered by the wrapper, not silenced in user config (wrapper must not edit
  `~/.codex/config.toml`).
- `ultra` effort exists internally but is unadvertised — excluded from the enum until the
  CLI documents it.
