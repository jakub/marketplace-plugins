// Making what git and gh said safe to quote. A remote URL is the one thing in a clone that
// routinely carries a credential, and git repeats the remote it was handed in its own errors, so
// nothing an executor prints quotes a command's output without passing it through here.

// Userinfo in a URL (https://user:token@host/...), which git's own redaction is not a promise of.
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi
// The scp-like spelling. Everything up to the @ goes, not only a run with a colon: handed
// user:ghp_token@github.com:jakub/demo.git, git reports `'ghp_token@github.com:jakub/demo.git' does
// not appear to be a git repository`, with the token where the ssh user goes and no colon left.
const SCP_USERINFO = /[^\s@/'"]*@(?=[^\s@/'"]+:)/g

/** The userinfo patterns alone, for text built without a remote to compare against. */
export const scrubUserinfo = (text) => String(text || '').replace(USERINFO, '$1').replace(SCP_USERINFO, '')

/** One configured remote, plus the userinfo-stripped spellings git rewrites it into when it prints. */
const remoteSpellings = (url) => {
  const raw = String(url ?? '').trim()
  if (raw === '') return []
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*:\/\/)(?:[^/@\s]*@)?(.+)$/i)
  if (scheme !== null) return [raw, `${scheme[1]}${scheme[2]}`, scheme[2]]
  const scp = raw.match(/^[^/\s]*@(.+)$/)
  return scp === null ? [raw] : [raw, scp[1]]
}

/**
 * A redactor for the URLs configured on origin: every spelling of them becomes `identity`. The
 * userinfo patterns run first, because stripping the spellings first can remove the colon the scp
 * pattern recognises a credential by; the spellings go longest first, so a short one cannot take
 * the tail of a longer one and leave its head standing.
 */
export const makeRedactor = (rawUrls, identity) => {
  const spellings = [...new Set((Array.isArray(rawUrls) ? rawUrls : [rawUrls]).flatMap(remoteSpellings))]
    .filter(Boolean).sort((a, b) => b.length - a.length)
  return (text) => spellings.reduce((out, spelling) => out.split(spelling).join(identity), scrubUserinfo(text))
}

/** The first line of what a command said, capped: what a refusal quotes after redacting it. */
export const firstLine = (text) => String(text || '').trim().split('\n')[0].slice(0, 200)
