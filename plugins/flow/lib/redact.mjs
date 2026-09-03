// Making what git and gh said safe to quote.
//
// Every executor here ends up putting a failed command's own words into a refusal, a JSON verdict
// or a journalled stop detail. The string that reaches those places started life next to a remote
// URL, and a remote URL is the one thing in a clone that routinely carries a credential:
// https://user:ghp_token@github.com/owner/repo and its scp-like cousin are both spellings people
// really configure. So nothing quotes a command's output directly; it goes through a redactor
// built for the remote that run is working against.
//
// scripts/issue-claim.mjs and scripts/land-gates.mjs each had one of these. They were not the
// same one: the claim's registered the spellings git rewrites a remote into and kept a backstop
// for the scp-like userinfo, the gate's matched the configured string alone and scrubbed after
// substituting rather than before. Neither difference was chosen, and the weaker copy sat in the
// executor whose output gets journalled, so this is the stronger one, once.

// Userinfo in a URL, as in https://user:token@host/owner/repo. Git 2.55 redacts this from its own
// error text, but that is behaviour rather than a promise, and every string this guards is on its
// way into JSON a stage journals.
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi
// The same thing in the scp-like spelling, which has no scheme in front of its userinfo:
// user:ghp_token@github.com:jakub/demo.git. This takes everything up to the @ and not only a run
// with a colon in it, because git rewrites what it prints and the colon does not survive. Handed
// that remote, git reads the first colon as the host separator, tries to reach a host called
// user, and reports
// `fatal: 'ghp_token@github.com:jakub/demo.git' does not appear to be a git repository`: the
// token is now sitting where the ssh user goes, with no colon left to recognise it by. The
// lookahead keeps this to something shaped like a remote, an @ followed by a host and a colon,
// and the bias is deliberate. Cutting the user out of git@github.com:owner/repo costs a reader
// nothing, and the identity is printed beside it anyway.
const SCP_USERINFO = /[^\s@/'"]*@(?=[^\s@/'"]+:)/g

/** The pattern backstop on its own, for output built without a remote to compare against. */
export const scrubUserinfo = (text) => String(text || '').replace(USERINFO, '$1').replace(SCP_USERINFO, '')

/**
 * Every spelling of one configured remote a message can turn up carrying. git does not always
 * echo the URL as it was configured: `git push` reports
 * `error: failed to push some refs to 'github.com:jakub/demo.git'` for a remote written
 * git@github.com:jakub/demo.git, having dropped the userinfo on the way, and matching only the
 * configured string leaves that line unredacted. So the userinfo-stripped forms are registered
 * too: host:path for the scp-like spelling, and scheme://host/path and host/path for a URL.
 */
const remoteSpellings = (url) => {
  const raw = String(url ?? '').trim()
  if (raw === '') return []
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*:\/\/)(?:[^/@\s]*@)?(.+)$/i)
  if (scheme !== null) return [raw, `${scheme[1]}${scheme[2]}`, scheme[2]]
  const scp = raw.match(/^[^/\s]*@(.+)$/)
  return scp === null ? [raw] : [raw, scp[1]]
}

/**
 * Redact git's own words before quoting them. Pattern matching alone is not enough: git quotes
 * the remote it was handed in messages like
 * `fatal: 'user@host' does not appear to be a git repository`, and a shape it reads as a local
 * path keeps whatever was in it. So the redactor is built from the URLs actually configured on
 * origin, and from the spellings git rewrites them into, and swaps those exact strings for the
 * safe identity, which needs no guessing about which run of characters is a secret. The two
 * userinfo patterns stay behind it as a backstop for URLs that reach the output some other way.
 *
 * The userinfo goes first and the spellings second, which is the only order that works. A line
 * reading `'ghp_token@github.com:jakub/demo.git'` loses its colon the moment the host and path
 * become the identity, and the scp pattern then has nothing left to recognise.
 *
 * @param {string[]|string} rawUrls every URL configured on origin, fetch and push
 * @param {string} identity the printable identity to put in their place
 */
export const makeRedactor = (rawUrls, identity) => {
  const urls = Array.isArray(rawUrls) ? rawUrls : [rawUrls]
  // Longest first, so a stripped spelling cannot take the tail of a longer one and leave its head
  // standing in the output.
  const spellings = [...new Set(urls.flatMap(remoteSpellings))]
    .filter((spelling) => spelling !== '')
    .sort((a, b) => b.length - a.length)
  return (text) => {
    let out = scrubUserinfo(text)
    for (const spelling of spellings) out = out.split(spelling).join(identity)
    return out
  }
}

/** The first line of what a command said, capped. What a refusal quotes after redacting it. */
export const firstLine = (text) => String(text || '').trim().split('\n')[0].slice(0, 200)
