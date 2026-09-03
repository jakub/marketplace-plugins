#!/usr/bin/env node
// Smoke harness for scripts/flow-cron.mjs's report extraction. The jobs deliver their report
// and then keep talking (filing a gripe, answering a question), so the session's last message
// is routinely not the report. Reading only the type:"result" entry filed ten of twelve runs
// between 2026-08-24 and 2026-09-01 as failures whose text was "Gripe filed." and nothing
// else. Every case here is stdout as `claude -p` really writes it.
// Run: node plugins/flow/scripts/smoke-flow-cron.mjs
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

// The lint's mutating authority is one allowlist entry per executor verb and never a bare
// script prefix: a verb added to lint-actions.mjs widens nothing until it is named here.
console.log("lint allowlist");
const lint = jobs("/x").lint.allowedTools;
const executorEntries = lint.filter((t) => t.includes("lint-actions.mjs"));
check("no bare lint-actions prefix", executorEntries.some((t) => t.endsWith("lint-actions.mjs:*")), false);
for (const verb of ["remove-worktree", "delete-branch", "clear-orphan"]) {
  check(`verb entry: ${verb}`, executorEntries.includes(`Bash(node /x/scripts/lint-actions.mjs ${verb}:*)`), true);
}
check("exactly the three verbs", executorEntries.length, 3);

console.log(bad === 0 ? "\nflow-cron: ALL PASS" : `\nflow-cron: ${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
