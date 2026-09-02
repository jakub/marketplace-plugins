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
// scripts/issue-claim.mjs does not use this, and the comment at its own parser says why: a claim
// runs its git-only verbs against a bare repository at a filesystem path, so it needs a hostless
// origin to come back parsed rather than refused. Refusing one is exactly what the land
// executors want, since they have nothing to do without a host to pin gh to.

// The refusals never quote the remote they refused, because the remote is exactly the string that
// can hold a credential, so each one describes it instead.
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

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
// git@host:owner/repo.git and host:owner/repo, the two spellings new URL() cannot parse.
const SCP_LIKE = /^(?:[^@\s/]+@)?([^:/\s]+):(.+)$/

/**
 * The repository an executor is about to act on, derived from the origin remote. Returns
 * `{ identity: { host, owner, repo, slug, full } }` or `{ refusal }`, and never any part of the
 * input, because the refusal is printed.
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
 * @param {string} url the configured origin URL
 * @param {{purpose: string}} options the verb the refusals name, 'gate' or 'merge in'
 */
export function identityOfRemote(url, { purpose }) {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (raw === '') return { refusal: REMOTE_ABSENT(purpose) }

  const fromPath = (host, path) => {
    const segments = String(path).split('/').filter((part) => part !== '')
    if (segments.length !== 2) return { refusal: REMOTE_PATH(purpose) }
    const owner = segments[0]
    const repo = segments[1].replace(/\.git$/, '')
    if (host === '' || owner === '' || repo === '') return { refusal: REMOTE_PATH(purpose) }
    return { identity: { host, owner, repo, slug: `${owner}/${repo}`, full: `${host}/${owner}/${repo}` } }
  }

  if (SCHEME.test(raw)) {
    let parsed
    try { parsed = new URL(raw) } catch { return { refusal: REMOTE_UNREADABLE(purpose) } }
    if (parsed.search !== '' || parsed.hash !== '') return { refusal: REMOTE_QUERY }
    // The pathname is left percent-encoded on purpose: decodeURIComponent throws on a lone %, and
    // nothing downstream needs the decoded form of an owner or a repository name.
    return fromPath(parsed.hostname, parsed.pathname)
  }

  const scp = raw.match(SCP_LIKE)
  if (scp === null) return { refusal: REMOTE_UNREADABLE(purpose) }
  const [, host, path] = scp
  if (path.includes('?') || path.includes('#')) return { refusal: REMOTE_QUERY }
  return fromPath(host, path)
}
