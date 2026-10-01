// The one parse of an origin remote into the host, owner and repository every executor pins its
// gh calls to, and the policy over it.
//
// gh sends the credential it holds for a host to whichever host it is pinned to, and the host
// comes from .git/config, a file any branch or hook can rewrite. So the repository gets no vote on
// which hosts are worth a token: github.com, plus FLOW_GH_HOSTS in the environment of whoever runs
// the executor. A port is refused because gh's --hostname and --repo carry a bare host, so gh and
// git would reach different endpoints. A query or a fragment is refused rather than stripped: no
// repository URL needs one and a credential often is one. No refusal quotes the remote. The
// allowlist refusal names the host, which is its whole content, and only once the host has been
// shown to be a hostname and nothing else (an scp host ends at the colon, so it can hold an @, a ?
// or a # and a token with them).

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const SCP_LIKE = /^(?:([^@\s/]+)@)?([^:/\s]+):(.+)$/
const SCP_USER = /^[a-z0-9._+-]+$/i

const QUOTE_NOTE = '(it is not quoted, because a remote can carry a credential)'
const REFUSALS = {
  absent: (purpose) => `this directory has no readable origin remote, so there is no repository to ${purpose}`,
  unreadable: (purpose) => `the origin remote of this directory does not read as a URL naming a host, an owner and a repository, so there is no repository to ${purpose} ${QUOTE_NOTE}`,
  query: () => `the origin remote of this directory carries a query string or a fragment, which no repository URL needs and a credential often is, so it is refused unread ${QUOTE_NOTE}`,
  port: (purpose) => `the origin remote of this directory names a port, which gh's --hostname and --repo cannot carry, so gh and git would reach different endpoints and there is no repository to ${purpose} ${QUOTE_NOTE}`,
  path: (purpose) => `the origin remote of this directory does not name exactly one host, owner and repository, so there is no repository to ${purpose} ${QUOTE_NOTE}`,
  host: (purpose, host) => `the origin remote of this directory names the host ${JSON.stringify(host)}, which is not one flow may hand to gh, so there is no repository to ${purpose}. ` +
    'gh sends the credential it holds for a host to whichever host it is pinned to, and that pin would come from this repository\'s own config; ' +
    'set FLOW_GH_HOSTS in the environment to a comma-separated list of hostnames to widen it',
}

/** github.com plus the comma-separated FLOW_GH_HOSTS, lowercased. Never read from the repository. */
export const allowedHostsFrom = (env) =>
  new Set(['github.com', ...String(env?.FLOW_GH_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)])

const ownerRepo = (path) => {
  const parts = String(path).split('/').filter(Boolean)
  const repo = parts[1]?.replace(/\.git$/, '')
  return parts.length === 2 && repo ? { owner: parts[0], repo } : null
}

/** { host, owner, repo } or { problem }, and never any part of the input in a problem. */
const parseRemote = (url) => {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (raw === '') return { problem: 'absent' }
  let host
  let path
  if (SCHEME.test(raw)) {
    let parsed
    try { parsed = new URL(raw) } catch { return { problem: 'unreadable' } }
    if (parsed.search !== '' || parsed.hash !== '') return { problem: 'query' }
    // new URL() drops a port that is the scheme's default, which is the endpoint gh reaches anyway.
    if (parsed.port !== '') return { problem: 'port' }
    host = parsed.hostname
    path = parsed.pathname
    if (host === '') return { problem: 'path' }
  } else {
    const scp = raw.match(SCP_LIKE)
    if (scp === null) return { problem: 'unreadable' }
    host = scp[2]
    path = scp[3]
    if (!HOSTNAME.test(host) || (scp[1] !== undefined && !SCP_USER.test(scp[1]))) return { problem: 'unreadable' }
    if (/[?#]/.test(path)) return { problem: 'query' }
    // The scp form has no port syntax, so git@host:2222/owner/repo.git is a port written where git
    // reads a path; an owner made only of digits (git@host:12345/repo.git) still parses as one.
    const ported = path.match(/^\d+\/(.+)$/)
    if (ported !== null && ownerRepo(ported[1]) !== null) return { problem: 'port' }
  }
  if (!HOSTNAME.test(host)) return { problem: 'unreadable' }
  const named = ownerRepo(path)
  return named === null ? { problem: 'path' } : { host, ...named }
}

/**
 * The repository an executor is about to act on: `{ identity: { host, owner, repo, slug, full } }`,
 * or `{ problem, refusal }` where problem is absent, unreadable, query, port, path or host.
 * `purpose` is the verb the refusal names ('claim an issue on', 'merge in', 'act on').
 */
export function identityOfRemote(url, { purpose, allowedHosts = new Set(['github.com']) }) {
  const shape = parseRemote(url)
  if (shape.problem !== undefined) return { problem: shape.problem, refusal: REFUSALS[shape.problem](purpose) }
  if (!allowedHosts.has(shape.host.toLowerCase())) return { problem: 'host', refusal: REFUSALS.host(purpose, shape.host) }
  const { host, owner, repo } = shape
  return { identity: { host, owner, repo, slug: `${owner}/${repo}`, full: `${host}/${owner}/${repo}` } }
}

/**
 * Whether a pull request url GitHub answered with is `number` of `identity`, the second lock after
 * --repo. null when it is; else { code, host, owner, repo } with code absent, unreadable or
 * elsewhere (and where it points). Host, owner and repo compare case-insensitively.
 */
export function prUrlMismatch(url, identity, number) {
  const none = { host: '', owner: '', repo: '' }
  const raw = typeof url === 'string' ? url.trim() : ''
  if (raw === '') return { code: 'absent', ...none }
  let parsed = null
  try { parsed = new URL(raw) } catch {}
  const parts = parsed === null ? [] : parsed.pathname.split('/').filter(Boolean)
  if (parts.length !== 4 || parts[2].toLowerCase() !== 'pull' || parts[3] !== String(number)) return { code: 'unreadable', ...none }
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
  const [owner, repo] = parts
  if (!same(parsed.hostname, identity.host) || !same(owner, identity.owner) || !same(repo, identity.repo)) {
    return { code: 'elsewhere', host: parsed.hostname, owner, repo }
  }
  return null
}
