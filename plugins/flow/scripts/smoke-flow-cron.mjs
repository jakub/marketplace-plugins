#!/usr/bin/env node
// Smoke harness for scripts/flow-cron.mjs: its report extraction, its allowlists against
// git-guard's cron regex, and the dry run through install-cron.sh.
//
// The jobs deliver their report and then keep talking (filing a gripe, answering a question), so
// the session's last message is routinely not the report. Reading only the type:"result" entry
// filed ten of twelve runs between 2026-08-24 and 2026-09-01 as failures whose text was "Gripe
// filed." and nothing else. Every case here is stdout as `claude -p` really writes it.
// Run: node plugins/flow/scripts/smoke-flow-cron.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractReport, jobs } from "./flow-cron.mjs";

let bad = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok" : "FAIL"}: ${name}${ok ? "" : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`);
};

const line = (o) => `${JSON.stringify(o)}\n`;
const assistant = (text, parent = null) =>
  line({ type: "assistant", parent_tool_use_id: parent, message: { role: "assistant", content: [{ type: "text", text }] } });
const toolCall = (id) =>
  line({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: {} }] } });
const result = (text, extra = {}) =>
  line({ type: "result", subtype: "success", is_error: false, num_turns: 42, total_cost_usd: 4.7, result: text, ...extra });

const REPORT = "# flow nightly lint - 2026-09-01\n6 repos audited, 0 actions taken.\n\n## clean\n- marketplace-plugins: labels ok\n";

console.log("stream-json");
const trailing =
  line({ type: "system", subtype: "init", session_id: "s1" }) +
  toolCall("t1") +
  assistant(REPORT) +
  toolCall("t2") +
  assistant("Filed. Nothing further to add.") +
  result("Filed. Nothing further to add.");
const t = extractReport(trailing);
check("report survives a trailing gripe turn", t.report, REPORT);
check("the session's last word is kept separately", t.resultText, "Filed. Nothing further to add.");
check("cost header intact", t.cost, "$4.70, 42 turns");
check("not flagged as an error", t.isError, false);

// A per-repo subagent can echo the heading; only the main thread files the report.
const subagentOnly =
  line({ type: "system", subtype: "init", session_id: "s2" }) +
  assistant("# flow nightly lint - subagent pass on repo r\n", "toolu_sub") +
  assistant("Done, see above.") +
  result("Done, see above.");
check("a subagent heading is not the report", extractReport(subagentOnly).report, "");

const clean =
  line({ type: "system", subtype: "init", session_id: "s3" }) + assistant(REPORT) + result(REPORT);
check("the ordinary run still files its report", extractReport(clean).report, REPORT);

const errored = line({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "nope" }] } }) +
  result("Error: ran out of turns", { is_error: true });
check("is_error is reported", extractReport(errored).isError, true);
check("an errored run carries no report", extractReport(errored).report, "");

console.log("other stdout shapes");
check("single json object (older --output-format json)", extractReport(JSON.stringify({ type: "result", result: REPORT, num_turns: 3, total_cost_usd: 1 })).report, REPORT);
check("array of messages", extractReport(JSON.stringify([{ type: "assistant", message: { content: [{ type: "text", text: REPORT }] } }, { type: "result", result: "ok" }])).report, REPORT);
check("plain text stdout", extractReport(REPORT).report, REPORT);
check("empty stdout", extractReport("").report, "");
check("empty stdout has no result text", extractReport("").resultText, "");
check("a truncated line does not throw", extractReport(assistant(REPORT) + '{"type":"resu').report, REPORT);
check("a bare null on stdout is not a message", extractReport("null").report, "");
check("a null entry in a message array is skipped", extractReport(JSON.stringify([null, { type: "assistant", message: { content: [{ type: "text", text: REPORT }] } }, 7, "x"])).report, REPORT);
check("a null line in stream-json is skipped", extractReport("null\n" + assistant(REPORT) + result("ok")).report, REPORT);

// Each job's Bash authority is one entry, and it has to be a prefix of the one line git-guard's
// cron regex admits: an entry the guard refuses is a job that can run nothing, and a second entry
// is a widening nobody reviewed. So each entry is checked against the real guard, not a copy.
console.log("allowlists");
const G = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "scripts", "git-guard.mjs");
const guardAllows = (job, command) =>
  execFileSync(process.execPath, [G], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    env: { ...process.env, FLOW_CRON_JOB: job, CLAUDE_PLUGIN_ROOT: "/x", PLUGIN_ROOT: "" },
  }).toString().trim() === "";
const want = { lint: "Bash(node /x/scripts/lint-actions.mjs:*)", "doc-sweep": "Bash(node /x/scripts/lint-actions.mjs survey:*)" };
for (const [job, { allowedTools }] of Object.entries(jobs("/x"))) {
  const bash = allowedTools.filter((t) => t.startsWith("Bash"));
  check(`${job}: exactly one Bash entry`, bash.length, 1);
  check(`${job}: the Bash entry`, bash[0], want[job]);
  check(`${job}: the other tools`, allowedTools.filter((t) => !t.startsWith("Bash")).join(","), "Read,Glob,Grep,Agent");
  const prefix = bash[0].slice("Bash(".length, -":*)".length);
  const line = prefix.endsWith(" survey") ? `${prefix} /home/x/code/r` : `${prefix} delete-branch /home/x/code/r feat/x`;
  check(`${job}: git-guard admits its entry (${line})`, guardAllows(job, line), true);
  check(`${job}: git-guard still refuses git`, guardAllows(job, "git -C /home/x/code/r log -1"), false);
}

// `install-cron.sh run <job> --dry-run` is how a prompt change is tried without installing
// anything. It has to pass the flag through (a dropped --dry-run is a real headless session) and
// run the plugin CLAUDE_PLUGIN_ROOT names, even with a launcher installed that would resolve
// another one. That plugin is a second root linking this one's scripts and skills, so its prompt
// path differs from the one the script-location fallback would print. A fake claude and a fake
// launcher each leave a marker if anything calls them.
console.log("install-cron.sh run");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "flow-cron-"));
try {
  mkdirSync(join(tmp, "bin"));
  mkdirSync(join(tmp, ".local", "libexec"), { recursive: true });
  writeFileSync(join(tmp, "bin", "claude"), `#!/bin/sh\ntouch ${tmp}/claude-ran\n`, { mode: 0o755 });
  writeFileSync(join(tmp, ".local", "libexec", "flow-cron"), `#!/bin/sh\ntouch ${tmp}/launcher-ran\n`, { mode: 0o755 });
  const named = join(tmp, "plugin");
  mkdirSync(named);
  for (const dir of ["scripts", "skills"]) symlinkSync(join(ROOT, dir), join(named, dir));
  const run = spawnSync("bash", [join(ROOT, "scripts", "install-cron.sh"), "run", "lint", "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, HOME: tmp, PATH: `${join(tmp, "bin")}:${process.env.PATH}`, CLAUDE_PLUGIN_ROOT: named, FLOW_STATE: tmp, FLOW_WORKSPACE: tmp },
  });
  const out = run.stdout ?? "";
  check("exits 0", run.status, 0);
  check("prints the composed command", /^claude -p .* --permission-mode dontAsk --allowedTools /m.test(out), true);
  check("from the named plugin", out.includes(join(named, "skills", "flow", "cron", "lint.md")), true);
  check("starts no session", existsSync(join(tmp, "claude-ran")), false);
  check("does not go through the installed launcher", existsSync(join(tmp, "launcher-ran")), false);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(bad === 0 ? "\nflow-cron: ALL PASS" : `\nflow-cron: ${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
