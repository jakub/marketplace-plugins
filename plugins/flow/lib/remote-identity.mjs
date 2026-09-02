// The one parse of an origin remote the land executors share.
//
// scripts/land-gates.mjs and scripts/land-merge.mjs both have to answer the same question before
// they call gh: which host, owner and repository does origin name, and is the URL a shape safe to
// build an API path out of at all. They carried byte-identical copies of this function for a
// while, differing only in the word each refusal used for what it was refusing to do, and two
// copies of a security decision are two copies to keep in step. This is that decision, once.
//
// `purpose` is that word, and it is the only thing a caller varies: 'gate' in land-gates, 'merge
// in' in land-merge. It reaches nothing but the English of the refusal.
//
// scripts/issue-claim.mjs does not use the parse, and the comment at its own parser says why: a
// claim runs its git-only verbs against a bare repository at a filesystem path, so it needs a
// hostless origin to come back parsed rather than refused. Refusing one is exactly what the land
// executors want, since they have nothing to do without a host to pin gh to. It does import
// allowedHostsFrom, because the set of hosts flow may hand a credential to is one list and not
// three.
//
// Where the allowlist lives, and why it is not in the repository. Every call these executors make
// carries whatever credential gh holds for the host it is pinned to, GH_ENTERPRISE_TOKEN and the
// stored keyring entry included. The host comes from .git/config, which is an ordinary file: a
// branch, a merged pull request, a hook or anything else that can write the clone can point
// origin at a host of its choosing, and the gate that holds the token would then hand it over.
// So the repository does not get a vote. The default list is github.com alone, and it is widened
// only by FLOW_GH_HOSTS in the environment of whoever runs the executor.

// The refusals never quote the remote they refused, because the remote is exactly the string that
// can hold a credential, so each one describes it instead. The host is the one exception, in the
// allowlist refusal alone: naming it is the whole content of that refusal, and a hostname is not
// a secret.
const REMOTE_ABSENT = (purpose) =>
  `this directory has no readable origin remote, so there is no repository to ${purpose}`
const REMOTE_UNREADABLE = (purpose) =>
  'the origin remote of this directory does not read as a URL naming a host, an owner and ' +
  `a repository, so there is no repository to ${purpose} (it is not quoted here, because a remote can carry a credential)`
const REMOTE_QUERY =
  'the origin remote of this directory carries a query string or a fragment, which no repository ' +
  'URL needs and a credential often is, so it is refused unread (it is not quoted here, for the same reason)'
const REMOTE_PATH = (purpose) =>
  'the path of the origin remote does not name exactly one owner and one repository, so there is ' +
  `no repository to ${purpose} (it is not quoted here, because a remote can carry a credential)`
const REMOTE_PORT = (purpose) =>
  'the origin remote of this directory names a port, which the gh pin cannot carry: --hostname ' +
  'and --repo take a bare host, so gh would reach the default port of that name while git talks ' +
  `to the one configured, and there is no repository to ${purpose} that both agree on ` +
  '(the remote is not quoted here, because it can carry a credential)'
const REMOTE_HOST = (purpose, host) =>
  `the origin remote of this directory names the host ${JSON.stringify(host)}, which is not one ` +
  `flow may hand to gh, so there is no repository to ${purpose}: gh sends the credential it holds ` +
  'for a host to whichever host it is pinned to, and that pin would come from this repository\'s ' +
  'own config. Set FLOW_GH_HOSTS in the environment to a comma-separated list to widen it ' +
  '(the rest of the remote is not quoted here, because it can carry a credential)'

/** The one host every flow executor may reach with no configuration at all. */
export const DEFAULT_ALLOWED_HOST = 'github.com'

/**
 * The hosts an executor may hand to gh: github.com, plus whatever FLOW_GH_HOSTS names. Read from
 * the environment of the person or job running the executor, never from the repository, for the
 * reason at the top of this file. Entries are split on commas, trimmed and lowercased, since
 * hostnames are case-insensitive and a list written by hand picks up spaces. An entry that is not
 * a hostname matches nothing, which is the same as not writing it.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {Set<string>}
 */
export function allowedHostsFrom(env) {
  const named = String(env?.FLOW_GH_HOSTS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '')
  return new Set([DEFAULT_ALLOWED_HOST, ...named])
}

/** Whether a parsed host is on the list. Hostnames are case-insensitive, so the compare is too. */
export function hostIsAllowed(host, allowedHosts) {
  const hosts = allowedHosts instanceof Set ? allowedHosts : new Set([DEFAULT_ALLOWED_HOST])
  return hosts.has(String(host).toLowerCase())
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
// git@host:owner/repo.git and host:owner/repo, the two spellings new URL() cannot parse. The user
// is captured rather than skipped, because both halves are checked before either is used.
const SCP_LIKE = /^(?:([^@\s/]+)@)?([^:/\s]+):(.+)$/
// The scp-like spelling has no place to put a port, so `git@host:2222/owner/repo.git` is a port
// written into a form that cannot hold one. See the note in identityOfRemote.
const SCP_PORT = /^(\d+)\/(.+)$/

// A hostname: labels of letters, digits and hyphens, joined by dots, no label starting or ending
// in a hyphen, and nothing else. Deliberately narrow. An IPv6 literal, which new URL() hands back
// bracketed as [::1], does not match and is refused, which is fail-closed and no loss: nobody
// reaches a GitHub host that way.
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i
// The ssh user in front of it, git in every remote anyone writes by hand. Same idea, plus the
// underscore and the plus a few forges use.
const SCP_USER = /^[a-z0-9._+-]+$/i

/**
 * Whether a string is a hostname and nothing else. This is what stands between a remote and a
 * refusal that names its host. The scp-like form ends the host at the colon that opens the path
 * and has no other delimiter, so `[^:/\s]+` counted a second @, a ? and a # as part of the host:
 * git@ghp_sekret?x@github.com:owner/repo.git parsed with the host ghp_sekret?x@github.com, and the
 * allowlist refusal below prints the host it refuses. The token went to stderr and into whatever
 * journalled it. So the host is matched against this before any diagnostic can name it, and one
 * that fails is an unreadable remote, described and never quoted.
 */
export function isHostname(host) {
  return typeof host === 'string' && host !== '' && HOSTNAME.test(host)
}

/** Whether a string is an ssh user and nothing else. The other half of an scp-like remote. */
export function isScpUser(user) {
  return typeof user === 'string' && user !== '' && SCP_USER.test(user)
}

/** The owner and repository a path names, or null when it does not name exactly those two. */
const namesRepo = (path) => {
  const segments = String(path).split('/').filter((part) => part !== '')
  if (segments.length !== 2) return null
  const owner = segments[0]
  const repo = segments[1].replace(/\.git$/, '')
  return owner === '' || repo === '' ? null : { owner, repo }
}

/**
 * The repository an executor is about to act on, derived from the origin remote. Returns
 * `{ identity: { host, owner, repo, slug, full } }` or `{ refusal }`, and never any part of the
 * input beyond the host of an allowlist refusal, because the refusal is printed.
 *
 * A scheme URL is parsed with new URL() and owner and repo come from its pathname alone. The
 * regex this replaced stripped a `.git` suffix off the whole string and then took what followed
 * the last slash, so https://host/owner/repo.git?access_token=sekret yielded the repository name
 * `repo.git?access_token=sekret`, and that string went on to be the --repo argument, the
 * contents-API path, and the identity a refusal or a journalled stop detail quotes. A query or a
 * fragment is a refusal now rather than something to strip, because no remote that names a
 * repository has one.
 *
 * The scp-like form has no scheme for new URL() to work with and is still how most people spell
 * a GitHub remote, so it keeps a regex, with the same owner/repo rule applied to its path and the
 * query and fragment refused by hand, since nothing drops them for it.
 *
 * A port is a refusal in both spellings. gh takes a bare host in --hostname and in
 * --repo host/owner/repo and has nowhere to put a port, so an origin of
 * https://github.com:8443/owner/repo would have git pushing to 8443 while every gh call read 443:
 * two servers, one verdict, and nothing in the output saying so. new URL() drops a port that is
 * the scheme's default, so https://host:443/owner/repo parses with no port and is not refused,
 * which is right, since gh reaches exactly that endpoint. The scp-like form has no port syntax at
 * all, so `git@host:2222/owner/repo.git` is a port somebody wrote where git reads a path; it is
 * recognised only when the rest of the path names exactly one owner and one repository, which
 * keeps an owner made entirely of digits (`git@github.com:12345/repo.git`) parsing as an owner.
 *
 * The host then has to be on the allowlist. Everything above this line is about reading the
 * remote; this is about which hosts are worth a credential, and it is the last check because a
 * remote that will not parse has no host to judge.
 *
 * @param {string} url the configured origin URL
 * @param {{purpose: string, allowedHosts?: Set<string>}} options the verb the refusals name,
 *   'gate' or 'merge in', and the hosts gh may be pinned to; the default is github.com alone
 */
export function identityOfRemote(url, { purpose, allowedHosts }) {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (raw === '') return { refusal: REMOTE_ABSENT(purpose) }

  const fromPath = (host, path) => {
    const named = namesRepo(path)
    if (named === null || host === '') return { refusal: REMOTE_PATH(purpose) }
    if (!hostIsAllowed(host, allowedHosts)) return { refusal: REMOTE_HOST(purpose, host) }
    const { owner, repo } = named
    return { identity: { host, owner, repo, slug: `${owner}/${repo}`, full: `${host}/${owner}/${repo}` } }
  }

  if (SCHEME.test(raw)) {
    let parsed
    try { parsed = new URL(raw) } catch { return { refusal: REMOTE_UNREADABLE(purpose) } }
    if (parsed.search !== '' || parsed.hash !== '') return { refusal: REMOTE_QUERY }
    if (parsed.port !== '') return { refusal: REMOTE_PORT(purpose) }
    // Belt and braces. new URL() already rejects most of what the scp-like branch has to catch by
    // hand, but the host is about to be printable and one grammar for both branches is one rule to
    // reason about. A hostless URL, file:///srv/repo.git, keeps falling through to the path
    // refusal, which is the honest thing to say about it.
    if (parsed.hostname !== '' && !isHostname(parsed.hostname)) return { refusal: REMOTE_UNREADABLE(purpose) }
    // The pathname is left percent-encoded on purpose: decodeURIComponent throws on a lone %, and
    // nothing downstream needs the decoded form of an owner or a repository name.
    return fromPath(parsed.hostname, parsed.pathname)
  }

  const scp = raw.match(SCP_LIKE)
  if (scp === null) return { refusal: REMOTE_UNREADABLE(purpose) }
  const [, user, host, path] = scp
  // First, before anything can print the host or judge it. See isHostname.
  if (!isHostname(host)) return { refusal: REMOTE_UNREADABLE(purpose) }
  if (user !== undefined && !SCP_USER.test(user)) return { refusal: REMOTE_UNREADABLE(purpose) }
  if (path.includes('?') || path.includes('#')) return { refusal: REMOTE_QUERY }
  const ported = path.match(SCP_PORT)
  if (ported !== null && namesRepo(ported[2]) !== null) return { refusal: REMOTE_PORT(purpose) }
  return fromPath(host, path)
}
