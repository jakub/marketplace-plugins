import { readFileSync } from 'node:fs'

// The bundle takes __FLOW_VERSION__ from esbuild's define (scripts/build-delegation.mjs).
// Running straight from src has no define, so the plugin manifest is read instead: both
// paths report the version the manifest actually carries.
export const VERSION = typeof __FLOW_VERSION__ !== 'undefined'
  ? __FLOW_VERSION__
  : JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version
