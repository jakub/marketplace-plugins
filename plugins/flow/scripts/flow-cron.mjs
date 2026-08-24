#!/usr/bin/env node
// Run one of flow's scheduled jobs headlessly and file its report.
//
//   flow-cron.mjs <lint|doc-sweep> [--dry-run]
//
// Each job is a prompt file under skills/flow/cron/<job>.md plus a tool allowlist
// declared here. The allowlist is the job's entire write authority: the session runs
// with --permission-mode dontAsk, so anything outside it is refused rather than
// waiting on a prompt nobody will answer. SessionStart hooks fire under `claude -p`,
// so the job sees the charter and both guards like any other session.
//
// Output: the session's final text goes to $FLOW_STATE/reports/<job>-<date>.md
// (default ~/.local/state/flow), the last 30 reports are kept, and a desktop
// notification carries the report's first line. Non-zero exit on a failed or
// timed-out session so `systemctl --user status flow-<job>` shows it.
//
// Env: FLOW_WORKSPACE (default ~/code), FLOW_STATE, FLOW_MODEL (default sonnet),
// FLOW_CRON_TIMEOUT_MIN (default 40).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Allowlists are the job's entire write authority and stay deliberately narrow: no
// bare `bash`/`node` (arbitrary execution), no `gh api`/`gh repo` (exfiltration and
// arbitrary REST writes), gh verbs enumerated per job, scripts allowed by exact
// installed path. `git` stays broad ONLY because reads need `git -C <repo>` and prefix
// patterns cannot see the subcommand; the git-guard hook closes that gap: it reads
// FLOW_CRON_JOB from its env (exported below, unforgeable from inside the session) and
// denies every git subcommand outside the job's standing permissions, ignoring
// FLOW_SANCTION. Keep the guard's write set, these lists, and the prompts' standing
// permissions in step - they are three views of one contract.
const jobs = (root) => ({
  lint: {
    allowedTools: [
      "Read", "Glob", "Grep", "Agent",
      "Bash(git:*)", // guarded: reads + `worktree remove|prune` + `branch -D` (git-guard.mjs cron mode)
      "Bash(gh issue list:*)", "Bash(gh issue view:*)", "Bash(gh issue edit:*)", "Bash(gh issue comment:*)",
      "Bash(gh pr list:*)", "Bash(gh pr view:*)",
      "Bash(gh run list:*)", "Bash(gh run view:*)",
      "Bash(gh label list:*)",
      `Bash(bash ${root}/scripts/worktree-audit.sh:*)`,
      `Bash(node ${root}/scripts/lint-actions.mjs:*)`, // the ONLY mutating git path

      // drift-audit §5 on the marketplace repo:
      `Bash(node ${root}/hooks/scripts/inject-charter.mjs:*)`,
      `Bash(node ${root}/scripts/smoke-codex-exec.mjs:*)`,
      "Bash(claude plugin list:*)",
    ],
    summary: "flow nightly lint",
  },
  "doc-sweep": {
    allowedTools: [
      "Read", "Glob", "Grep", "Agent",
      "Bash(git:*)", // guarded read-only in cron mode (git-guard.mjs)
      "Bash(gh issue list:*)", "Bash(gh issue view:*)",
      "Bash(gh pr list:*)", "Bash(gh pr view:*)",
      "Bash(gh label list:*)",
    ],
    summary: "flow weekly doc sweep",
  },
});

const [job, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");

const root = process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const JOBS = jobs(root);
if (!JOBS[job]) {
  console.error(`usage: flow-cron.mjs <lint|doc-sweep> [--dry-run]`);
  process.exit(2);
}
const workspace = process.env.FLOW_WORKSPACE || join(homedir(), "code");
const state = process.env.FLOW_STATE || join(homedir(), ".local", "state", "flow");
const model = process.env.FLOW_MODEL || "sonnet";
const timeoutMs = Number(process.env.FLOW_CRON_TIMEOUT_MIN || 40) * 60_000;
const reports = join(state, "reports");
const date = new Date().toISOString().slice(0, 10);
// Full timestamp in the name so a rerun never overwrites the failure it is diagnosing.
const stamp = new Date().toISOString().replace(/:/g, "-").replace(/\..*/, "Z");
const reportPath = join(reports, `${job}-${stamp}.md`);

const promptFile = join(root, "skills", "flow", "cron", `${job}.md`);
const prompt = readFileSync(promptFile, "utf8")
  .replaceAll("${FLOW_WORKSPACE}", workspace)
  .replaceAll("${CLAUDE_PLUGIN_ROOT}", root)
  .replaceAll("${DATE}", date);

// The prompt goes first: --allowedTools is variadic and would swallow a trailing
// positional. --output-format json emits an array of messages; the report is the
// entry with type "result".
const args = [
  "-p", prompt,
  "--model", model,
  "--permission-mode", "dontAsk",
  "--allowedTools", JOBS[job].allowedTools.join(","),
  "--output-format", "json",
];

if (dryRun) {
  console.log(`cwd: ${workspace}\nreport: ${reportPath}\nclaude -p '<prompt ${prompt.length} chars from ${promptFile}>' ${args.slice(2).join(" ")}`);
  process.exit(0);
}

mkdirSync(reports, { recursive: true });
const started = Date.now();
const run = spawnSync("claude", args, {
  cwd: workspace,
  encoding: "utf8",
  timeout: timeoutMs,
  maxBuffer: 64 * 1024 * 1024,
  env: {
    ...process.env,
    FLOW_CRON_JOB: job,
    // ssh must never prompt in an unattended session; a prompt is a silent hang.
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=10",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const minutes = ((Date.now() - started) / 60_000).toFixed(1);

let text = "";
let cost = "";
let failure = null;
if (run.error) failure = run.error.code === "ETIMEDOUT" ? `timed out after ${minutes} min` : run.error.message;
else if (run.status !== 0) failure = `claude exited ${run.status}`;
try {
  const messages = JSON.parse(run.stdout || "[]");
  const parsed = (Array.isArray(messages) ? messages : [messages]).find((m) => m.type === "result") || {};
  text = parsed.result || "";
  if (parsed.is_error) failure = failure || `session reported an error: ${text.slice(0, 200)}`;
  if (parsed.total_cost_usd != null) cost = `$${parsed.total_cost_usd.toFixed(2)}, ${parsed.num_turns} turns`;
} catch {
  text = run.stdout || "";
}
if (!text.trim() && !failure) failure = "session returned no report text";
// In -p mode the first tool-free assistant message ends the session, so a report that
// doesn't start with its heading is a stray progress line from a session that quit early.
else if (!failure && !/^\s*# flow /.test(text)) failure = `session ended before the report (got: ${text.trim().slice(0, 120)})`;

const header = `<!-- ${JOBS[job].summary} · ${new Date().toISOString()} · ${model} · ${minutes} min${cost ? ` · ${cost}` : ""}${failure ? ` · FAILED: ${failure}` : ""} -->\n`;
const body = failure && !text.trim() ? `# ${JOBS[job].summary} - ${date}\n\nFAILED: ${failure}\n\n\`\`\`\n${(run.stderr || "").slice(-4000)}\n\`\`\`\n` : text;
writeFileSync(reportPath, header + body);

// Keep the last 30 reports per job.
const old = readdirSync(reports).filter((f) => f.startsWith(`${job}-`)).sort().slice(0, -30);
for (const f of old) unlinkSync(join(reports, f));

const headline = (body.split("\n").find((l) => l.trim() && !l.startsWith("<!--") && !l.startsWith("#")) || "").slice(0, 200);
notify(failure ? `${JOBS[job].summary} FAILED` : JOBS[job].summary, failure || headline || `report: ${reportPath}`, failure ? "critical" : "normal");

console.log(header.trim());
console.log(`report: ${reportPath}`);
if (failure) {
  console.error(failure);
  if (run.stderr) console.error(run.stderr.slice(-2000));
  process.exit(1);
}

function notify(title, message, urgency) {
  if (!existsSync("/usr/bin/notify-send")) return;
  spawnSync("/usr/bin/notify-send", ["--app-name=flow", `--urgency=${urgency}`, title, message], { stdio: "ignore" });
}
