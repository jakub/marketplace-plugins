// The state directory and the path containment test, shared by the delegation server and the seat
// hooks. A hook runs on every tool call, so this file imports node built-ins only: the hook fast
// path must never import delegate/jobs.mjs and pay for its dependency graph.
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

/** How long an ended job's directory is kept before it is pruned. */
export const RETENTION_MS = 14 * 86_400_000

export const stateDir = () => process.env.FLOW_DELEGATION_STATE_DIR
  || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'flow')

export const inside = (root, path) => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
