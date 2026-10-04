// Adding flow's lines to a repository's common .git/info/exclude. The issue claim keeps
// `/.flow-worktrees/` and `/.flow-scratch/` there, and seat open keeps `/.flow-worktrees/` there
// before it adds a review worktree, so neither checkout's worktrees show in the canonical
// checkout's status. Both use this one copy, because a copy of write discipline like this drifts
// (see AGENTS.md). It imports node built-ins alone.
import { closeSync, constants, fstatSync, openSync, readFileSync, writeSync } from 'node:fs'

/**
 * Append to the exclude file each of lines that it does not already hold as a whole line, creating
 * the file 0600 when it is missing; its directory must exist. The open refuses a symlink
 * (O_NOFOLLOW), and the file it opened must be a regular file with one link, so the append never
 * lands in another file through a link. O_APPEND puts the write at the end whatever else wrote
 * there. Throws when the file cannot be opened or is not a real, unshared file.
 */
export function ensureExcluded(exclude, lines) {
  const fd = openSync(exclude, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1) throw new Error(`${exclude} is not a real, unshared file`)
    const text = readFileSync(fd, 'utf8')
    const have = text.split(/\r?\n/)
    const missing = lines.filter((line) => !have.includes(line))
    if (missing.length > 0) writeSync(fd, `${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.map((line) => `${line}\n`).join('')}`)
  } finally { closeSync(fd) }
}
