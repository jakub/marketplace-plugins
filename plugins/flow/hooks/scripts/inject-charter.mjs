#!/usr/bin/env node
// Emit one half of the charter. Claude Code caps a single hook's stdout at
// 10,000 characters and replaces anything larger with a 2KB preview plus a file
// path, so the charter ships as two SessionStart hooks, each under the cap.
// Usage: inject-charter.mjs <1|2>. The split lands on the `## ` heading nearest
// the middle of the file, so the hand-authored charter stays one file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_HOOK_CAP, CLAUDE_PART_BUDGET } from "../../lib/charter-payload.mjs";

const CAP = CLAUDE_HOOK_CAP;
const WARN = CLAUDE_PART_BUDGET;
const part = process.argv[2];
const root = process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const text = readFileSync(join(root, "charter", "charter.md"), "utf8");

const headings = [...text.matchAll(/^## .*$/gm)].map((m) => m.index);
const mid = text.length / 2;
const cut = headings.reduce((best, i) => (Math.abs(i - mid) < Math.abs(best - mid) ? i : best), headings[0] ?? 0);

const halves = [
  text.slice(0, cut).trimEnd() + "\n\n<!-- flow-charter continues in the next SessionStart block -->\n",
  "<!-- flow-charter, part 2 of 2 -->\n\n" + text.slice(cut),
];

const out = halves[part === "2" ? 1 : 0];
const over = halves.map((h, i) => (h.length >= WARN ? `part ${i + 1} is ${h.length} chars` : null)).filter(Boolean);
if (over.length && part !== "2") {
  console.log(`<!-- flow-charter WARNING: ${over.join("; ")}; the per-hook cap is ${CAP}. Trim the charter or move text out of it. -->\n`);
}
process.stdout.write(out);
