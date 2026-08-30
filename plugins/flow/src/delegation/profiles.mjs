import { readFileSync } from 'node:fs'

// A delegated worker reads the charter of the family it is running in, so it needs that
// family's binding profile too. Without one it finds no bindings and announces the gap.
//
// The bundle takes each profile from esbuild's define (scripts/build-delegation.mjs).
// Running straight from src has no define, so the file is read instead. A read that fails
// is null rather than a throw: the caller hands null to profileBlock, which renders the
// no-bindings note, and a broken install never costs the job its whole instruction block.
function readProfileSource(host) {
  try {
    return readFileSync(new URL('../../charter/profiles/' + host + '.md', import.meta.url), 'utf8')
  } catch {
    return null
  }
}

export const FLOW_PROFILE_CLAUDE = typeof __FLOW_PROFILE_CLAUDE__ !== 'undefined'
  ? __FLOW_PROFILE_CLAUDE__
  : readProfileSource('claude')

export const FLOW_PROFILE_CODEX = typeof __FLOW_PROFILE_CODEX__ !== 'undefined'
  ? __FLOW_PROFILE_CODEX__
  : readProfileSource('codex')

/** The raw profile text for the family being delegated to, or null when it is unreadable. */
export function profileForTarget(target) {
  if (target === 'claude') return FLOW_PROFILE_CLAUDE
  if (target === 'codex') return FLOW_PROFILE_CODEX
  return null
}
