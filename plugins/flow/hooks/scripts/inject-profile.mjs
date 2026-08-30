#!/usr/bin/env node
// Emit the host binding profile as a third SessionStart block, beside the charter's two
// halves. Usage: inject-profile.mjs [host], defaulting to claude. A missing or unreadable
// profile still prints a block, so the session is told what it lost instead of silently
// running on the charter alone. Always exits 0: a non-zero SessionStart hook costs the
// session its payload.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { profileBlock, readProfile } from "../../lib/charter-payload.mjs";

const host = process.argv[2] || "claude";
const fallback = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT || fallback;

process.stdout.write(profileBlock(readProfile(root, host)));
