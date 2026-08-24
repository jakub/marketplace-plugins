#!/usr/bin/env node
// publish-guard: ask before a command that publishes to a public registry.
//
// The rule is not about cargo - it is that these registries have no unpublish. crates.io refuses
// outright; npm allows it for 72 hours and only if nothing depends on you. A wrong version
// number is permanent, and the fix is always a new release rather than a retraction.
//
// `ask`, not `deny`: publishing is a thing you legitimately do, so this is the gate the
// charter asks for on anything that leaves the machine, not a ban.
//
// Deliberately NOT here: `docker push`. That usually means a private registry where a retag
// costs nothing, and gating it would be friction with no irreversibility behind it. `gh release create` is likewise absent - a release deletes cleanly.

const PUBLISH = [
  [/\bcargo\s+publish\b/, 'crates.io', 'crates.io has no unpublish at all'],
  [/\bnpm\s+publish\b/, 'npm', 'npm unpublish is a 72-hour window, and only while nothing depends on it'],
  [/\bpnpm\s+publish\b/, 'npm', 'npm unpublish is a 72-hour window, and only while nothing depends on it'],
  [/\byarn\s+npm\s+publish\b/, 'npm', 'npm unpublish is a 72-hour window, and only while nothing depends on it'],
  [/\bgem\s+push\b/, 'RubyGems', 'a yanked gem keeps its version number forever'],
  [/\btwine\s+upload\b/, 'PyPI', 'PyPI will not let you reuse a version number, even after deletion'],
  [/\bpoetry\s+publish\b/, 'PyPI', 'PyPI will not let you reuse a version number, even after deletion'],
  [/\buv\s+publish\b/, 'PyPI', 'PyPI will not let you reuse a version number, even after deletion'],
]

let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let cmd = ''
  try {
    cmd = JSON.parse(raw)?.tool_input?.command || ''
  } catch {
    process.exit(0)
  }
  if (!cmd) process.exit(0)

  // Prose about publishing is not publishing - same reasoning as git-guard's stripLiterals.
  const bare = cmd.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ')
  if (/--dry-run\b/.test(bare)) process.exit(0)

  for (const [re, registry, why] of PUBLISH) {
    if (re.test(bare)) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason:
              `This publishes to ${registry}, which you cannot take back - ${why}. ` +
              'Confirm the version number and the contents are what you mean to ship.',
          },
        }),
      )
      process.exit(0)
    }
  }
  process.exit(0)
})
