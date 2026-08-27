// Wire formats, owned by the adapters. Not a registered hook: this is the helper the
// hook scripts share so lib/hook-policy.mjs can stay free of event names, output
// shapes, and harness envelopes. If Claude and Codex ever diverge on the accepted
// PreToolUse deny shape, the fork happens here without touching policy.

/** The PreToolUse deny result both harnesses accept today. */
export const preToolDeny = (reason) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
})

/** Extract every target path from Codex's apply_patch command envelope. */
export function applyPatchPaths(command) {
  // CRLF tolerated: stray \r must read as line endings, not as proof of tampering,
  // or one Windows-shaped envelope denies every edit in the session.
  const lines = String(command).split(/\r?\n/)
  const paths = []
  const begins = lines.filter((line) => line === '*** Begin Patch').length
  const ends = lines.filter((line) => line === '*** End Patch').length
  let malformed = begins !== 1 || ends !== 1 ||
    lines.indexOf('*** Begin Patch') >= lines.indexOf('*** End Patch')

  for (const line of lines) {
    const file = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
    const move = line.match(/^\*\*\* Move to: (.+)$/)
    if (file || move) {
      const path = (file || move)[1].trim()
      if (!path || path.includes('\0')) malformed = true
      else paths.push(path)
    } else if (/^\*\*\* /.test(line) && !/^\*\*\* (?:Begin Patch|End Patch|End of File)$/.test(line)) {
      // Every directive the grammar defines is handled above. Anything else styled as
      // a directive is a future or malformed one, and it must not carry an uninspected
      // path - so the whole envelope is refused, not just the line.
      malformed = true
    }
  }

  if (paths.length === 0) malformed = true
  return { paths: [...new Set(paths)], complete: !malformed }
}
