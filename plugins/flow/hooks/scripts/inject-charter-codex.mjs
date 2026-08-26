#!/usr/bin/env node
// Codex adapter: one ordered SessionStart payload. Codex handles large context through
// additionalContextLimit/spilling, so it does not need Claude's two concurrent halves.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fallback = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const root = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || fallback
process.stdout.write(readFileSync(join(root, 'charter', 'charter.md'), 'utf8'))
