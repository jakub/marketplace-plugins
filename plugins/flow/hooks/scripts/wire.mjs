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

/**
 * The PreToolUse ask result. Claude only: Codex reads an unsupported `ask` as a hook failure and
 * runs the command anyway (observed on Codex CLI 0.149.1, still true on 0.152.0), which is why
 * publish-guard-codex.mjs denies where publish-guard.mjs asks. Never return this to Codex.
 */
export const preToolAsk = (reason) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: reason,
  },
})

/**
 * The hook call on stdin, or null when there is nothing usable there.
 *
 * Every hook script in this directory opened with its own copy of this, in two different idioms,
 * and each one decided for itself what an unparseable body meant. Null is the one answer, and the
 * caller still decides: a guard exits 0 and blocks nothing, because refusing on a body this could
 * not read would turn a harness change into a session that cannot run commands.
 */
export async function readHookInput() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try { return JSON.parse(raw) } catch { return null }
}

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
