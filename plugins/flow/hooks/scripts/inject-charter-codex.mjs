#!/usr/bin/env node
// Codex adapter: one ordered SessionStart payload. Codex handles large context through
// additionalContextLimit/spilling, so it does not need Claude's two concurrent halves.
// The charter comes first, then the Codex binding profile, in that order and one write.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { profileBlock, readProfile } from '../../lib/charter-payload.mjs'

const fallback = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const root = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || fallback
const charter = readFileSync(join(root, 'charter', 'charter.md'), 'utf8')
process.stdout.write(charter + '\n' + profileBlock(readProfile(root, 'codex')))
