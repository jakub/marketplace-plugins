#!/usr/bin/env node
// A native Agent call can override an agent definition's model. For flow:bridge, take the
// model from the shipped definition even when the caller asks for another one. Leave the
// prompt, including the delegated worker's model and effort, byte-for-byte unchanged.
// The definition also sets effort because Agent has no per-call effort parameter.
// This hook does not approve the spawn or claim to intercept Workflow's internal agent().
// Model substitution by host-wide settings or the provider remains outside this hook.

import { readFileSync } from 'node:fs'
import { preToolDeny, preToolUpdate, readHookInput } from './wire.mjs'

const event = await readHookInput()
if (event?.hook_event_name === 'PreToolUse' && event.tool_name === 'Agent' &&
    event.tool_input?.subagent_type === 'flow:bridge') {
  let definition = ''
  try { definition = readFileSync(new URL('../../agents/bridge.md', import.meta.url), 'utf8') } catch {}
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(definition)?.[1]
  const model = /^model: ([a-z0-9-]+)$/m.exec(frontmatter ?? '')?.[1]
  if (!model || model === 'inherit') {
    // A broken install must not silently restore the expensive inherited model.
    console.log(JSON.stringify(preToolDeny('flow:bridge needs an explicit model in agents/bridge.md. Reinstall Flow.')))
  } else if (event.tool_input.model !== model) {
    console.log(JSON.stringify(preToolUpdate({ ...event.tool_input, model })))
  }
}
