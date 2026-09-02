#!/usr/bin/env node
// The compare-and-set that stops two autonomous runs from starting the same issue.
//
// A claim is one lightweight tag on the origin remote, refs/tags/flow-claim-issue-<N>. Creating
// a ref is the one operation git's wire protocol makes atomic for us. The client sends the old
// value it saw in the ref advertisement, and receive-pack refuses the update if the remote has
// moved since; for a create that old value is all zeroes, so exactly one of any number of
// racing pushers gets to be the one that creates the tag. Every other racer is told no.
//
// Why this parses the porcelain output instead of reading the exit code. Two different things
// exit 0: creating the tag, and pushing an object at a tag that already points at that same
// object. The second one is a loss. Both racers push the head of refs/heads/main, so "the tag
// already exists and already points at what you were about to push" is the ordinary shape of
// losing this race, and git calls it "up to date" and reports success. Only the flag column
// separates them. `*` means git created a new ref and nothing else means that, so the flag
// column is the verdict and the exit code is a second opinion. The `[new tag]` text on the same
// line is human summary, not contract.
//
// The object under the tag has to be one this clone holds, because a push builds its pack here
// before the remote decides anything. A clone that has not fetched since origin's main moved
// does not hold it, and git stops at `fatal: bad object <sha>`. That looked exactly like a lost
// race and left an ordinary stale checkout unable to ever take a claim. So acquire checks for
// the object first and, only when it is missing, fetches refs/heads/main into a ref of its own
// under refs/flow-claim/ and pushes what it fetched. That fetch is read-only remote traffic: no
// local branch moves, refs/remotes/origin/* keeps whatever it had, FETCH_HEAD is not written,
// no tags come down, and the worktree and index are untouched.
//
// The classifier is strict on purpose, because the two ways of being wrong do not cost the
// same. Call a win a loss and you leave a tag nobody owns and a run that never starts: a human
// breaks the tag and an hour is gone. Call a loss a win and you start a second autonomous run
// on an issue someone else is already working. So anything that is not exactly one `*` line for
// our ref is not a win, and the program then re-reads the remote. Tag present means someone
// holds it, and that someone might be us, and we stand down anyway, because the tag carries no
// owner and both racers pushed the same object so its SHA cannot tell us apart. Tag absent
// means the result is honestly unknown, which is operational trouble rather than a lost race.
//
// Why release verifies the branch head before it deletes anything. The tag names an issue, not
// an owner: it points at main's head, which says nothing about who pushed it. The only evidence
// of ownership is the work, so release demands two things of the caller's branch. It has to be
// named for this issue, matching feat/issue-<N>-, fix/issue-<N>- or chore/issue-<N>-, because a
// caller who can hand over any branch can release any claim: `release 8 main <head-of-main>`
// would otherwise pass on every repository that has a main branch and drop issue 8's live claim.
// And it has to read back on the remote at exactly the head the caller says it pushed. Branch
// wrong for the issue, branch missing, branch moved, remote unreadable: the tag stays in all
// four. A tag outliving an ambiguous state is the recovery object. It is what keeps a second run
// from starting while a human works out what happened.
//
// Two limitations are accepted rather than fixed, and both end with a human. The first is a lost
// push response, above: win the race, lose the answer, and the re-read cannot tell our own tag
// from a rival's, so we stand down and the claim needs breaking by hand. The second is a
// generation race between two releasers on one issue. Both can pass the branch check, both can
// reach the delete, and a claim taken by a third run in between the two deletes is what the
// second delete removes. That successor then believes it holds a claim that is gone. Every claim
// on an issue points at the head of main, so its SHA cannot say which generation it belongs to,
// and pinning the delete to an object would not separate them while main sits still. At this
// trust level the cost is bounded, two runs on one issue, and the recovery is a human reading
// the issue. Making claims tell their generations apart means giving each one its own object,
// which would change what every racer pushes and with it the race this program is built on. That
// is a bigger change than any round so far has asked for, and it is the one that would close it.
//
// abandon is the third subcommand, and the one that needs the most care, because it deletes a
// tag. It exists for a run that acquired a claim and then, rechecking while holding it, found a
// live run already on the issue: it has to put the claim back without having published anything.
// Its authorization is a receipt. The caller passes the SHA its own acquire reported, and
// abandon refuses unless the tag is on the remote at exactly that object. The delete then names
// the same SHA again in a --force-with-lease, so the remote itself rechecks and rejects with
// `[rejected] (stale info)` if the tag moved or vanished in between. A tag at any other object
// stays put.
//
// What that receipt is worth, stated plainly so nobody later mistakes abandon for an ownership
// proof: the SHA is public, and anyone can read it with ls-remote, so it is evidence and not a
// secret. It rules out abandoning a claim taken against a different head of main, which is the
// case that matters once main moves. It does not separate two claims taken seconds apart while
// main sat still, so abandon inherits the same generation race as release, for the same reason.
// abandon is not a stale-tag breaker and must never become one. A tag nobody can produce a
// matching receipt for is a job for a human, who can read the issue first.
//
// Reading the remote and writing to it have to be the same repository, so both subcommands
// refuse when `git remote get-url origin` and `git remote get-url --push origin` disagree, or
// when either names more than one URL. A pushurl set on origin would otherwise put the claim tag
// somewhere no read of this program ever looks, which reads as an acquire that never holds.
//
// Nothing this program prints carries a credential. A remote URL can hold userinfo, as in
// https://user:token@host/owner/repo, and the identity goes into JSON that the stage journals.
// So the identity is always parsed down to host and path, never passed through, and a shape that
// will not parse becomes the literal unparseable-origin rather than the bytes that came back.
// Quoting git is the other half of that, and it needs more than a pattern, because git repeats
// the remote it was handed word for word: `fatal: 'user@host' does not appear to be a git
// repository`. So every message from git goes through a redactor built from the URLs configured
// on origin, which swaps those exact strings for the safe identity before anything is printed.
//
// Nothing here overwrites a ref, and nothing here breaks a stale tag on its own. There is no
// bare --force in any spelling, no -f, and no + refspec, because each of those turns the single
// atomic operation this program rests on into an overwrite, which is the same as having no claim
// at all. The one --force-with-lease, in abandon, is the opposite of that: it names the exact
// object the tag has to hold and the remote refuses the delete otherwise, which is a stricter
// delete than the unpinned one release performs, not a weaker one. git-guard allows the lease by
// spelling, `--force(?!-with-lease)`, and its denial message names it as the thing to use.
// Release could take a receipt and a lease too, and does not, only because that would change its
// arguments and its documented idempotency. That is an open item, not an oversight. A tag left
// behind by a crashed run is still a job for a human running
// `git push origin :refs/tags/flow-claim-issue-<N>`, who can read the issue first and decide.
//
// A cooperative guardrail, not a security boundary, the same as scripts/land-merge.mjs. At one
// uid a model with a shell can push whatever it likes. What this buys is that the ordinary path
// cannot start a duplicate run by accident.
//
// claim is the fourth subcommand and the only one that composes the other three. The issue stage
// used to run this procedure by hand, nine prose steps deep, and every step was a place for a
// model to skip a scan or branch off a stale origin/main. It is one command now, and one JSON
// line back: read the issue and refuse unless it is open, carries ready-for-agent and carries
// none of the blocking labels; digest the acceptance criteria; scan for a run already live;
// acquire; scan again while holding the tag; add the worktree at the object the acquire
// verified; push the branch; move the labels; release.
//
// Everything up to the acquire is a read. A closed issue, a missing label, a title with no slug
// in it, a worktree path already on disk: all of them are decided before anything is written, so
// a refusal there has changed nothing anywhere.
//
// The order of the last three steps is the part worth explaining, because the obvious order is
// the wrong one. The branch reaches origin before the labels move. A pushed branch is the marker
// every other run scans for, since the pre-scan asks the server for refs/heads/<kind>/issue-N-*,
// and that ref is what keeps a second run out once the claim tag is gone. No scan anywhere reads
// a label. Move the labels first and a crash in between leaves an issue wearing in-progress with
// no branch behind it, which stops nothing and tells a human nothing about whether work started.
//
// So a failure after the acquire splits at the push. Before it, this run has published nothing:
// the worktree comes out, the branch it just created is deleted while it still points at the
// base commit, the tag is abandoned on its receipt, and the caller gets a refusal that is true.
// After it, the branch is on origin where every other run can see it, and giving the tag back
// would understate what this run has already done. That case exits 4, unknown, naming the branch
// and the tag and leaving both alone. A label that did not move is a minute of a human's time.
// A second autonomous run on the same issue is not.
//
// Every remote interaction is an argv array, never a shell string, so there is no quoting to
// get wrong. stdout is always exactly one JSON object, one line, including for refusals; the
// only exception is --help. stderr carries a sentence for a human whenever the result is not a
// win. Exit codes: 0 acquired, released, abandoned or claimed, 2 usage or refusal, 3 held by
// someone else, 4 unknown.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCAL_GIT_TIMEOUT_MS = 5_000
const REMOTE_GIT_TIMEOUT_MS = 30_000
const PUSH_TIMEOUT_MS = 60_000
// A stale clone's catch-up fetch carries real history, unlike every other remote call here.
const FETCH_TIMEOUT_MS = 120_000
// A worktree add writes a whole checkout, so it costs nearer a clone than a ref read.
const WORKTREE_TIMEOUT_MS = 60_000
const GH_TIMEOUT_MS = 60_000

const EXIT_OK = 0
const EXIT_REFUSED = 2
const EXIT_HELD = 3
const EXIT_UNKNOWN = 4

const SHA = /^[0-9a-f]{40}$/
// Deliberately narrow. Flow's branches look like feat/issue-6-thing, and a name outside this
// set is a caller mistake worth refusing rather than a ref worth constructing.
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const MAIN_REF = 'refs/heads/main'

// The claim verb's vocabulary. The heading is matched as this exact string, in this casing.
const AC_HEADING = '## Acceptance Criteria'
const KINDS = new Set(['feat', 'fix', 'chore'])
const READY_LABEL = 'ready-for-agent'
const BLOCKING_LABELS = ['needs-human', 'needs-info', 'needs-rebase']
// Long enough to read, short enough that the branch and the sibling directory both stay typable.
const SLUG_MAX = 40

/**
 * The branch names that authorize releasing issue N's claim. The number is interpolated from a
 * validated integer, so there is nothing in it that a regular expression reads as syntax.
 */
const branchForIssue = (issue) => new RegExp(`^(feat|fix|chore)/issue-${issue}-`)

const USAGE = `issue-claim.mjs claim <issue-number> [--kind feat|fix|chore]
issue-claim.mjs acquire <issue-number>
issue-claim.mjs release <issue-number> <branch> <expected-head-sha>
issue-claim.mjs abandon <issue-number> <acquired-sha>

claim is the whole start-of-run procedure as one command, and the one most callers want. It
reads the issue and refuses unless it is open, carries ${READY_LABEL} and carries no blocking
label; digests the "${AC_HEADING}" section; scans this clone's worktrees, origin's branches
for the issue and open pull requests for a run already live; acquires the tag; scans again
while holding it; adds a worktree at the object the acquire verified, on branch
<kind>/issue-<N>-<slug>; pushes it; assigns the issue and moves ${READY_LABEL} to in-progress;
and releases the tag. The kind comes from --kind, or from a bug or documentation label, or is
feat. Exits 0 claimed, 2 refused, 3 held, 4 unknown, and prints one JSON line either way.

A claim refusal names one of: usage, issue-closed, not-ready, blocked, no-acceptance-criteria,
bad-slug, live-run, worktree-path, outside-parent, acquire-refused, worktree-add, push. An
unknown names one of: issue-unreadable, repo-unreadable, scan-unreadable, acquire-unknown,
issue-edit, release. Everything before the acquire is a read, so a refusal there changed
nothing; after it, a failure before the branch reaches origin gives the tag back, and a failure
after it leaves the branch and the tag standing for a human to finish or unwind.

acquire takes the claim on an issue by creating refs/tags/flow-claim-issue-<N> on origin, at
the head of refs/heads/main. Creating a ref is atomic on the remote, so exactly one racer wins.
Exits 0 when it created the tag, 3 when someone already holds it, 4 when the outcome could not
be established, 2 on a usage error or a refusal.

release gives the claim back. The branch has to be named for the issue being released, matching
feat/issue-<N>-, fix/issue-<N>- or chore/issue-<N>-, and refs/heads/<branch> on origin has to
read back at exactly <expected-head-sha>. Anything else keeps the tag, because a tag outliving
an ambiguous state is what stops a second run from starting.

abandon puts a claim back for a run that acquired it and then found a live run on the issue,
before publishing anything of its own. It takes the SHA that acquire reported, refuses unless
the tag is on origin at exactly that object, and deletes it under a --force-with-lease pinned to
the same SHA, so the remote rechecks too. A tag at any other object stays: this is not a way to
break a stale claim, and a claim nobody holds a receipt for is a job for a human.

All four refuse when origin's fetch and push URLs disagree. Nothing here overwrites a ref or
breaks a stale tag, and nothing it prints carries a credential from a remote URL.
`

/** Run git and report its exit code, rather than swallowing failures into null. */
const runGit = (args, cwd, timeoutMs) => {
  try {
    const stdout = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout: String(stdout), stderr: '' }
  } catch (error) {
    // A killed child has a null status. That maps to 1, which is neither the 0 nor the 2 that
    // `ls-remote --exit-code` uses, so a timeout reads as unknown and never as a decision.
    return {
      code: error?.status ?? 1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || error?.message || error),
    }
  }
}

// Userinfo in a URL, as in https://user:token@host/owner/repo. Git 2.55 redacts this from its own
// error text, but that is behaviour rather than a promise, and every string below is on its way
// into JSON the stage journals.
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi
const scrubUserinfo = (text) => String(text || '').replace(USERINFO, '$1')

/**
 * Redact git's own words before quoting them. Pattern matching alone is not enough: git quotes
 * the remote it was handed, verbatim, in messages like
 * `fatal: 'user@host' does not appear to be a git repository`, and a shape it reads as a local
 * path keeps whatever was in it. So the redactor is built from the URLs actually configured on
 * origin and swaps those exact strings for the safe identity, which needs no guessing about
 * which run of characters is a secret. The userinfo pattern stays behind it as a backstop for
 * URLs that reach the output some other way.
 */
const makeRedactor = (rawUrls, identity) => (text) => {
  let out = String(text || '')
  for (const url of rawUrls) {
    if (url !== '') out = out.split(url).join(identity)
  }
  return scrubUserinfo(out)
}

const firstLine = (text) => String(text || '').trim().split('\n')[0].slice(0, 200)

/** JSON from a command's stdout, or null when it printed something else. */
const parseJson = (text) => {
  if (typeof text !== 'string') return null
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : null
  } catch { return null }
}

/**
 * A printable identity that cannot carry a credential, whatever the remote looks like. Unlike
 * land-merge, an unparseable remote is not fatal here: nothing in this program calls GitHub, so
 * the identity is for the reader and the log, and a local path remote (a bare repository on
 * disk, which is what the smoke uses) is a legitimate origin. What is fatal is passing the raw
 * URL through, so every branch below ends at a host and path, a bare local path, or a fixed
 * placeholder. Nothing returns the input.
 *
 * This is stricter than land-merge's regular expressions, which keep whatever follows the repo
 * name: they read https://host/owner/repo.git?redirect=1 as owner/repo.git?redirect=1. Handing
 * a scheme to a real URL parser drops the userinfo, the query and the fragment by construction
 * rather than by a character class, which is the property this needs.
 */
const safeIdentity = (remote) => {
  const raw = String(remote ?? '').trim()
  if (raw === '') return 'unparseable-origin'

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      const path = url.pathname.replace(/^\/+/, '')
      // file:///srv/repo.git and friends: no host, so what is left is a filesystem path.
      if (url.hostname === '') return path === '' ? 'unparseable-origin' : `/${path}`
      const repo = path.replace(/\.git$/, '')
      return repo === '' ? url.hostname : `${url.hostname}/${repo}`
    } catch { return 'unparseable-origin' }
  }

  // scp-like, with or without a user in front: [user@]host:path.
  const scp = raw.match(/^(?:[^@\s]+@)?([^@:/\s]+):(.+)$/)
  if (scp !== null) return `${scp[1]}/${scp[2].replace(/^\/+/, '').replace(/\.git$/, '')}`

  // A local filesystem path: no scheme, no scp colon, and no userinfo to strip.
  if (!raw.includes('@')) return raw
  return 'unparseable-origin'
}

/**
 * The repository this run reads from and writes to, which have to be the same one. Git reads
 * from remote.origin.url and pushes to remote.origin.pushurl when that is set, so a divergent
 * pushurl would put the claim tag in a repository no read here ever looks at. Both lists are
 * read with --all, because either key can be multi-valued and a second push URL means the tag
 * lands in two places.
 *
 * Returns the safe identity string, or a typed problem for the caller to refuse on.
 */
const repoIdentity = (cwd) => {
  const fetchRead = runGit(['remote', 'get-url', '--all', 'origin'], cwd, LOCAL_GIT_TIMEOUT_MS)
  const pushRead = runGit(['remote', 'get-url', '--push', '--all', 'origin'], cwd, LOCAL_GIT_TIMEOUT_MS)
  const urls = (read) => read.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '')
  if (fetchRead.code !== 0 || pushRead.code !== 0) return { problem: 'no-origin' }
  const fetchUrls = urls(fetchRead)
  const pushUrls = urls(pushRead)
  if (fetchUrls.length === 0) return { problem: 'no-origin' }
  if (fetchUrls.length > 1 || pushUrls.length > 1) {
    return {
      problem: 'push-fetch-mismatch',
      detail: `origin names ${fetchUrls.length} fetch URL(s) and ${pushUrls.length} push URL(s), and a claim can only be taken on one repository ` +
        `(fetch ${fetchUrls.map((u) => safeIdentity(u)).join(', ')}; push ${pushUrls.map((u) => safeIdentity(u)).join(', ')})`,
    }
  }
  if (fetchUrls[0] !== pushUrls[0]) {
    return {
      problem: 'push-fetch-mismatch',
      detail: `origin fetches from ${safeIdentity(fetchUrls[0])} and pushes to ${safeIdentity(pushUrls[0])}, ` +
        'so the claim tag would land where no read of this program looks',
    }
  }
  const identity = safeIdentity(fetchUrls[0])
  return { identity, redact: makeRedactor([...fetchUrls, ...pushUrls], identity) }
}

/**
 * The SHA `git ls-remote` advertised for exactly this ref. An ls-remote pattern is a match, not
 * an equality, and an annotated tag also advertises a peeled `<ref>^{}` line, so the ref name on
 * the line has to be compared rather than assumed.
 */
const shaOfRef = (stdout, ref) => {
  for (const line of String(stdout).split('\n')) {
    const [sha, name] = line.split('\t')
    if (name === ref && SHA.test(sha)) return sha
  }
  return null
}

/** Whether this clone already holds a commit, so a push can build a pack that names it. */
const hasObject = (cwd, sha) =>
  runGit(['cat-file', '-e', `${sha}^{commit}`], cwd, LOCAL_GIT_TIMEOUT_MS).code === 0

/**
 * Read one ref off origin. `--exit-code` gives 0 for present and 2 for absent, and anything
 * else (128 for an unreachable remote, 1 for a killed child) is an operational unknown rather
 * than an answer about who holds the claim.
 */
const readRef = (cwd, ref, redact) => {
  const read = runGit(['ls-remote', '--exit-code', 'origin', ref], cwd, REMOTE_GIT_TIMEOUT_MS)
  if (read.code === 0) {
    const sha = shaOfRef(read.stdout, ref)
    return sha === null
      ? { state: 'unknown', detail: `\`git ls-remote origin ${ref}\` matched something, but advertised no line for that exact ref` }
      : { state: 'present', sha }
  }
  if (read.code === 2) return { state: 'absent' }
  return { state: 'unknown', detail: `\`git ls-remote origin ${ref}\` failed: ${firstLine(redact(read.stderr)) || `exit ${read.code}`}` }
}

/**
 * The flag column and summary that `git push --porcelain` printed for one ref. Status lines are
 * `<flag>\t<from>:<to>\t<summary>`; the leading `To <url>` line and the trailing `Done` have no
 * tab and are skipped. More than one line for our ref, or none, is not a verdict.
 *
 * Observed on git 2.55.0, for refs/tags/flow-claim-issue-<N>:
 *   `*` `[new tag]`                  the ref was created, and only the creator sees this
 *   `=` `[up to date]`               the tag already pointed at the object we pushed: a loss
 *   `!` `[rejected] (already exists)` the tag existed at another object: a loss
 *   `-` `[deleted]`                  the delete refspec ran, whether or not the tag was there
 */
const pushStatus = (stdout, ref) => {
  let found = null
  let seen = 0
  for (const line of String(stdout).split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const pair = parts[1]
    if (pair.slice(pair.lastIndexOf(':') + 1) !== ref) continue
    seen += 1
    found = { flag: parts[0], summary: (parts[2] ?? '').trim() }
  }
  return seen === 1 ? found : null
}

const describeStatus = (status, redact) =>
  status === null ? 'no status line for that ref' : `${JSON.stringify(status.flag)} ${redact(status.summary) || '(no summary)'}`

const line = (payload, code, human) => ({
  code,
  stdout: `${JSON.stringify(payload)}\n`,
  stderr: human ? `issue-claim: ${human}\n` : '',
})

/**
 * The origin both subcommands need, or the refusal that stops the run before it touches the
 * remote. Reading git's remote config is local, so a refusal here has pushed nothing and read
 * nothing.
 */
const resolveOrigin = (command, cwd, facts) => {
  const resolved = repoIdentity(cwd)
  if (resolved.problem === 'no-origin') {
    const detail = `this directory has no readable origin remote, so there is no remote to ${command} a claim on`
    return { refusal: line({ command, result: 'refused', reason: 'no-origin', ...facts, detail }, EXIT_REFUSED, detail) }
  }
  if (resolved.problem === 'push-fetch-mismatch') {
    return {
      refusal: line({ command, result: 'refused', reason: 'push-fetch-mismatch', ...facts, detail: resolved.detail }, EXIT_REFUSED,
        `${resolved.detail}. Nothing was read and nothing was pushed. Settle remote.origin.pushurl before claiming anything here.`),
    }
  }
  return { repo: resolved.identity, redact: resolved.redact }
}

// ------------------------------------------------------------------------------------ acquire

const acquire = ({ argv, cwd }) => {
  const usage = (detail) => line({ command: 'acquire', result: 'refused', reason: 'usage', detail }, EXIT_REFUSED, `${detail}.\n\n${USAGE}`)
  if (argv.length !== 1) return usage('acquire expects one argument, the issue number')
  const issue = Number(argv[0])
  if (!Number.isInteger(issue) || issue <= 0) return usage(`${JSON.stringify(argv[0])} is not an issue number`)

  const tag = `flow-claim-issue-${issue}`
  const ref = `refs/tags/${tag}`
  const origin = resolveOrigin('acquire', cwd, { issue, tag, ref })
  if (origin.refusal) return origin.refusal
  const repo = origin.repo
  const redact = origin.redact
  const base = { command: 'acquire', repo, issue, tag, ref }
  const held = (sha, detail) => line({ ...base, result: 'held', sha, detail }, EXIT_HELD,
    `issue #${issue} is already claimed on ${repo} (${ref} at ${sha.slice(0, 12)}). ${detail}. Leave it alone; the run that holds it releases it, or a human breaks the tag.`)
  const unknown = (detail) => line({ ...base, result: 'unknown', detail }, EXIT_UNKNOWN,
    `could not establish whether issue #${issue} is claimed on ${repo}. ${detail}. Do not start work on the strength of this; find out what the remote actually holds.`)

  // The object the claim hangs on. Every racer resolves the same head of main, which is exactly
  // why the "up to date" case below exists and has to be read as a loss.
  const mainRead = runGit(['ls-remote', 'origin', MAIN_REF], cwd, REMOTE_GIT_TIMEOUT_MS)
  if (mainRead.code !== 0) {
    // The remote could not be read at all. Operationally unknown, not a lost race: nothing has
    // been learned about the tag, and nothing has been pushed.
    return unknown(`\`git ls-remote origin ${MAIN_REF}\` failed: ${firstLine(redact(mainRead.stderr)) || `exit ${mainRead.code}`}`)
  }
  const mainSha = shaOfRef(mainRead.stdout, MAIN_REF)
  if (mainSha === null) {
    const detail = `origin on ${repo} advertises no ${MAIN_REF}, so there is no object to hang a claim on`
    return line({ ...base, result: 'refused', reason: 'no-main-branch', detail }, EXIT_REFUSED, detail)
  }

  // Preflight. Cheap, and it keeps the common "someone claimed this an hour ago" case from
  // touching the remote's refs at all. It is not the lock: the lock is the push.
  const before = readRef(cwd, ref, redact)
  if (before.state === 'present') return held(before.sha, 'the tag was already there before this run pushed anything')
  if (before.state === 'unknown') return unknown(before.detail)

  // A push builds its pack locally, so the object on the left of the refspec has to be one this
  // clone holds. A clone that has not fetched since origin's main moved does not hold it, and
  // git fails with `fatal: bad object <sha>` before the remote decides anything. That came back
  // as a `!` line, which the classifier read as a loss and the re-read turned into unknown, so
  // an ordinary stale checkout could never take a claim. Fetching the object first is the fix.
  const tempRef = `refs/flow-claim/fetch-${issue}`
  const dropTempRef = () => runGit(['update-ref', '-d', tempRef], cwd, LOCAL_GIT_TIMEOUT_MS)
  let source = mainSha
  let fetched = false
  if (!hasObject(cwd, mainSha)) {
    // Read-only remote traffic that lands in one ref of our own and nothing else. --refmap=
    // switches off the opportunistic remote-tracking update, so refs/remotes/origin/main keeps
    // whatever it had and `git status` says exactly what it said before this ran. --no-tags
    // keeps other claim tags out of the local repository, and --no-write-fetch-head leaves
    // FETCH_HEAD alone for whatever else shares this clone. No local branch, index or file in
    // the worktree is touched either way.
    dropTempRef()
    const fetch = runGit(
      ['fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', 'origin', `${MAIN_REF}:${tempRef}`],
      cwd, FETCH_TIMEOUT_MS,
    )
    if (fetch.code !== 0) {
      dropTempRef()
      return unknown(`\`git fetch origin ${MAIN_REF}\` failed, so this clone does not hold the object a claim would ` +
        `hang on: ${firstLine(redact(fetch.stderr)) || `exit ${fetch.code}`}`)
    }
    const resolved = runGit(['rev-parse', '--verify', '--quiet', `${tempRef}^{commit}`], cwd, LOCAL_GIT_TIMEOUT_MS)
    const got = resolved.code === 0 ? resolved.stdout.trim() : ''
    if (!SHA.test(got)) {
      dropTempRef()
      return unknown(`${MAIN_REF} was fetched but did not resolve to a commit locally, so there is no object to hang a claim on`)
    }
    // The tag points at what this clone actually holds. If origin's main moved between the
    // ls-remote above and this fetch, the fetched object is the newer one, and pushing the
    // advertised SHA would fail the same way all over again. Every racer still resolves main,
    // so the same-object case the classifier exists for is unchanged.
    source = got
    fetched = true
  }

  // The compare-and-set. A plain create refspec: no leading +, no --force in any spelling. If
  // the tag appeared between the preflight and here, receive-pack refuses this and says so.
  const push = runGit(['push', '--porcelain', 'origin', `${source}:${ref}`], cwd, PUSH_TIMEOUT_MS)
  const status = pushStatus(push.stdout, ref)

  // The only win. `*` is git's documented flag for a ref it created, and a create of a tag ref
  // is what the remote serialises. Everything else, including the 0 exit of "up to date", falls
  // through to the re-read below.
  const outcome = () => {
    if (push.code === 0 && status !== null && status.flag === '*') {
      return line({ ...base, result: 'acquired', sha: source }, EXIT_OK, '')
    }

    // Not a win. It might be a rival's tag, it might be our own tag from a push whose response
    // was lost, and from here those are indistinguishable, because both racers push the same
    // object. Standing down on both is the safe direction.
    const after = readRef(cwd, ref, redact)
    const why = `the push did not create the ref (git said ${describeStatus(status, redact)}, exit ${push.code})`
    if (after.state === 'present') return held(after.sha, why)
    if (after.state === 'absent') {
      return unknown(`${why}, and ${ref} is not on the remote either. ` +
        `git's stderr was: ${firstLine(redact(push.stderr)) || '(empty)'}`)
    }
    return unknown(`${why}, and the re-read could not settle it: ${after.detail}`)
  }

  // The temp ref is what keeps the fetched object referenced across the push, so it goes only
  // after the outcome is decided.
  const result = outcome()
  if (fetched) dropTempRef()
  return result
}

// ------------------------------------------------------------------------------------ release

const release = ({ argv, cwd }) => {
  const usage = (detail) => line({ command: 'release', result: 'refused', reason: 'usage', detail }, EXIT_REFUSED, `${detail}.\n\n${USAGE}`)
  if (argv.length !== 3) return usage('release expects three arguments: the issue number, the branch, and the head SHA you pushed it at')
  const issue = Number(argv[0])
  if (!Number.isInteger(issue) || issue <= 0) return usage(`${JSON.stringify(argv[0])} is not an issue number`)
  const branch = argv[1]
  if (typeof branch !== 'string' || !BRANCH_NAME.test(branch)) return usage(`${JSON.stringify(branch)} is not a branch name this will build a ref from`)
  const expected = argv[2]
  if (typeof expected !== 'string' || !SHA.test(expected)) return usage(`${JSON.stringify(expected)} is not a 40-character lowercase SHA`)

  const tag = `flow-claim-issue-${issue}`
  const ref = `refs/tags/${tag}`
  const branchRef = `refs/heads/${branch}`

  // The branch has to belong to this issue. Without it the head check alone authorizes nothing:
  // any branch the caller can name and read the head of would do, and `release 8 main <head>`
  // would drop issue 8's live claim on any repository with a main branch. This runs before any
  // git call at all, so a caller who gets it wrong has touched nothing.
  if (!branchForIssue(issue).test(branch)) {
    const detail = `${JSON.stringify(branch)} is not a branch for issue #${issue}; releasing #${issue} needs a branch named ` +
      `feat/issue-${issue}-, fix/issue-${issue}- or chore/issue-${issue}-`
    return line({ command: 'release', result: 'refused', reason: 'branch-not-for-issue', issue, tag, ref, branch: branchRef, detail },
      EXIT_REFUSED, `${detail}. The claim tag stays where it is.`)
  }

  const origin = resolveOrigin('release', cwd, { issue, tag, ref, branch: branchRef })
  if (origin.refusal) return origin.refusal
  const repo = origin.repo
  const redact = origin.redact
  const base = { command: 'release', repo, issue, tag, ref, branch: branchRef, expected }
  const keptTag = 'The claim tag stays where it is. Only a human breaks a claim, after looking at the issue.'
  const refuse = (reason, detail, extra = {}) => line({ ...base, ...extra, result: 'refused', reason, detail }, EXIT_REFUSED, `${detail}. ${keptTag}`)
  const unknown = (detail, extra = {}) => line({ ...base, ...extra, result: 'unknown', detail }, EXIT_UNKNOWN,
    `${detail}. Look at ${ref} on ${repo} before doing anything else.`)

  // The whole proof of ownership. The tag points at main's head and names nobody, so the branch
  // reading back at exactly the head the caller pushed is the only thing that says this claim is
  // the caller's to give up. Every failure here keeps the tag.
  const branchRead = runGit(['ls-remote', 'origin', branchRef], cwd, REMOTE_GIT_TIMEOUT_MS)
  if (branchRead.code !== 0) {
    return refuse('branch-unreadable',
      `\`git ls-remote origin ${branchRef}\` failed, so the branch cannot be checked against ${expected.slice(0, 12)}: ${firstLine(redact(branchRead.stderr)) || `exit ${branchRead.code}`}`)
  }
  const found = shaOfRef(branchRead.stdout, branchRef)
  if (found === null) {
    return refuse('branch-absent', `origin on ${repo} has no ${branchRef}, so there is no pushed work to prove this claim was released cleanly`, { found: null })
  }
  if (found !== expected) {
    return refuse('head-mismatch',
      `${branchRef} on ${repo} is at ${found.slice(0, 12)} and the caller said ${expected.slice(0, 12)}, so the branch moved or this is not the run that pushed it`,
      { found })
  }

  // Delete refspec, which needs no force for a tag. This is idempotent by construction: git
  // reports `[deleted]` whether or not the tag was there, which is why absence is confirmed by
  // re-reading the remote rather than inferred from the push.
  const push = runGit(['push', '--porcelain', 'origin', `:${ref}`], cwd, PUSH_TIMEOUT_MS)
  const status = pushStatus(push.stdout, ref)
  const after = readRef(cwd, ref, redact)
  if (after.state === 'absent') {
    return line({ ...base, result: 'released', found }, EXIT_OK, '')
  }
  if (after.state === 'present') {
    return unknown(`${ref} is still on ${repo} at ${after.sha.slice(0, 12)} after the delete (git said ${describeStatus(status, redact)}, exit ${push.code})`, { found })
  }
  return unknown(`the delete ran (git said ${describeStatus(status, redact)}, exit ${push.code}) but ${after.detail}`, { found })
}

// ------------------------------------------------------------------------------------ abandon

const abandon = ({ argv, cwd }) => {
  const usage = (detail) => line({ command: 'abandon', result: 'refused', reason: 'usage', detail }, EXIT_REFUSED, `${detail}.\n\n${USAGE}`)
  if (argv.length !== 2) return usage('abandon expects two arguments: the issue number and the SHA your acquire reported')
  const issue = Number(argv[0])
  if (!Number.isInteger(issue) || issue <= 0) return usage(`${JSON.stringify(argv[0])} is not an issue number`)
  const receipt = argv[1]
  if (typeof receipt !== 'string' || !SHA.test(receipt)) return usage(`${JSON.stringify(receipt)} is not a 40-character lowercase SHA`)

  const tag = `flow-claim-issue-${issue}`
  const ref = `refs/tags/${tag}`
  const origin = resolveOrigin('abandon', cwd, { issue, tag, ref })
  if (origin.refusal) return origin.refusal
  const repo = origin.repo
  const redact = origin.redact
  const base = { command: 'abandon', repo, issue, tag, ref, receipt }
  const keptTag = 'The claim tag stays where it is. abandon gives back a claim this run just took, ' +
    'and it is not a way to break someone else\'s; that is a human\'s call, after reading the issue.'
  const refuse = (reason, detail, extra = {}) => line({ ...base, ...extra, result: 'refused', reason, detail }, EXIT_REFUSED, `${detail}. ${keptTag}`)
  const unknown = (detail, extra = {}) => line({ ...base, ...extra, result: 'unknown', detail }, EXIT_UNKNOWN,
    `${detail}. Look at ${ref} on ${repo} before doing anything else.`)

  // The receipt check. A tag that is absent, or at any object other than the one this caller's
  // acquire reported, is not this caller's to delete, and nothing is touched.
  const before = readRef(cwd, ref, redact)
  if (before.state === 'unknown') {
    // Not knowing is not a refusal. The run is still holding a claim it could not give back,
    // and that needs a human, not a caller that shrugs and moves on.
    return unknown(`the state of ${ref} on ${repo} could not be read, so the receipt could not be checked: ${before.detail}`)
  }
  if (before.state === 'absent') {
    return refuse('tag-absent', `${ref} is not on ${repo}, so there is no claim here to give back`, { found: null })
  }
  if (before.sha !== receipt) {
    return refuse('receipt-mismatch',
      `${ref} on ${repo} is at ${before.sha.slice(0, 12)} and the receipt says ${receipt.slice(0, 12)}, ` +
      'so this claim is not the one this run took',
      { found: before.sha })
  }

  // A compare-and-delete. --force-with-lease is the opposite of a force here: it names the object
  // the tag has to hold, and the remote rejects with `[rejected] (stale info)` if the tag moved or
  // vanished between the read above and this push. That closes the window the read alone leaves
  // open, and it is why this delete is stricter than the unpinned one release performs.
  const push = runGit(
    ['push', '--porcelain', `--force-with-lease=${ref}:${receipt}`, 'origin', `:${ref}`],
    cwd, PUSH_TIMEOUT_MS,
  )
  const status = pushStatus(push.stdout, ref)
  const after = readRef(cwd, ref, redact)
  if (after.state === 'absent') return line({ ...base, result: 'abandoned' }, EXIT_OK, '')
  if (after.state === 'present') {
    // The lease refused, or something put a tag back. Either way this run no longer knows whose
    // claim is on the remote, and guessing would be how a live claim gets deleted.
    return unknown(`${ref} is still on ${repo} at ${after.sha.slice(0, 12)} after the delete ` +
      `(git said ${describeStatus(status, redact)}, exit ${push.code})`, { found: after.sha })
  }
  return unknown(`the delete ran (git said ${describeStatus(status, redact)}, exit ${push.code}) but ${after.detail}`)
}

// -------------------------------------------------------------------------------------- claim

/** The bare label names on an issue read, whatever shape gh handed back. */
const labelNames = (labels) => (Array.isArray(labels) ? labels : [])
  .map((label) => (typeof label === 'string' ? label : String(label?.name ?? '')))
  .filter((name) => name !== '')

/**
 * The exact bytes of the acceptance criteria section: from the first byte of the heading line
 * through the byte before the next `## ` heading, or the end of the body. Taken as written, with
 * no trimming and no normalising, because the digest is what the run is judged against later and
 * a whitespace fix in the issue is a change the stage is supposed to notice.
 *
 * The heading has to be that string in that casing. A body that writes `## Acceptance criteria`
 * has no section here, and the run stops rather than digest a heading it guessed at. The one
 * concession is a carriage return: GitHub hands back CRLF bodies, so the match ignores a
 * trailing \r while the digest keeps it.
 *
 * Returns null when the heading is absent.
 */
const acceptanceCriteria = (body) => {
  const text = String(body ?? '')
  let offset = 0
  let start = -1
  for (const raw of text.split('\n')) {
    const bare = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (start < 0) {
      if (bare === AC_HEADING) start = offset
    } else if (bare.startsWith('## ')) {
      return text.slice(start, offset)
    }
    offset += raw.length + 1
  }
  return start < 0 ? null : text.slice(start)
}

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

/**
 * A branch-safe slug from an issue title. Everything outside [a-z0-9] becomes a hyphen, runs
 * collapse, and the ends are trimmed, so a title made entirely of punctuation produces the empty
 * string and the caller refuses rather than build `feat/issue-8-`. The cut back to a hyphen
 * boundary keeps the last word whole instead of ending a branch mid-syllable; a first word longer
 * than the limit has no boundary to cut at and gets truncated where it falls.
 */
const slugify = (title) => {
  const flat = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (flat.length <= SLUG_MAX) return flat
  const cut = flat.slice(0, SLUG_MAX)
  const boundary = cut.lastIndexOf('-')
  return (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/-+$/, '')
}

/**
 * The kind an issue's labels ask for. `bug` wins outright; `documentation` only names a chore
 * when nothing on the issue claims it is a feature, because an issue labelled both is a feature
 * that happens to touch docs. Everything else is a feat, which is also what an unlabelled issue
 * gets. `--kind` overrides all of it.
 */
const kindFromLabels = (labels) => {
  if (labels.includes('bug')) return 'fix'
  if (labels.includes('documentation') && !labels.includes('enhancement')) return 'chore'
  return 'feat'
}

/** The worktrees this clone has registered, as { path, branch } in the order git listed them. */
const parseWorktrees = (stdout) => {
  const entries = []
  let current = null
  for (const raw of String(stdout).split('\n')) {
    const text = raw.trimEnd()
    if (text.startsWith('worktree ')) {
      current = { path: text.slice('worktree '.length), branch: null }
      entries.push(current)
      continue
    }
    if (current !== null && text.startsWith('branch ')) current.branch = text.slice('branch '.length)
  }
  return entries
}

const shortBranch = (ref) => (typeof ref === 'string' && ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref)

/** One sentence naming what a scan turned up, in the order it found it. */
const describeHits = (hits) => hits.map((hit) => {
  if (hit.where === 'worktree') return `a worktree at ${hit.path}${hit.branch ? ` on ${hit.branch}` : ''}`
  if (hit.where === 'remote-branch') return `${hit.ref} on origin at ${String(hit.sha).slice(0, 12)}`
  return `pull request #${hit.number} from ${hit.headRefName}`
}).join('; ')

const claim = ({ argv, cwd, runGh }) => {
  const usage = (detail) => line({ command: 'claim', result: 'refused', reason: 'usage', detail }, EXIT_REFUSED, `${detail}.\n\n${USAGE}`)

  let issueArg = null
  let kindArg = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--kind') {
      if (kindArg !== null) return usage('--kind was given twice')
      kindArg = argv[i + 1]
      i += 1
      if (kindArg === undefined) return usage('--kind needs a value, one of feat, fix or chore')
      if (!KINDS.has(kindArg)) return usage(`${JSON.stringify(kindArg)} is not a kind; expected feat, fix or chore`)
      continue
    }
    if (issueArg !== null) return usage(`${JSON.stringify(arg)} is an extra argument; claim takes one issue number and an optional --kind`)
    issueArg = arg
  }
  if (issueArg === null) return usage('claim expects one argument, the issue number')
  const issue = Number(issueArg)
  if (!Number.isInteger(issue) || issue <= 0) return usage(`${JSON.stringify(issueArg)} is not an issue number`)

  const tag = `flow-claim-issue-${issue}`
  const ref = `refs/tags/${tag}`
  const origin = resolveOrigin('claim', cwd, { issue, tag, ref })
  if (origin.refusal) return origin.refusal
  const repo = origin.repo
  const redact = origin.redact
  const base = { command: 'claim', repo, issue, tag, ref }
  const refuse = (reason, detail, extra = {}, human = null) =>
    line({ ...base, ...extra, result: 'refused', reason, detail }, EXIT_REFUSED, human ?? `${detail}. Nothing was claimed and nothing was changed.`)
  const unknown = (reason, detail, extra = {}, human = null) =>
    line({ ...base, ...extra, result: 'unknown', reason, detail }, EXIT_UNKNOWN, human ?? `${detail}. Find out what the remote actually holds before running this again.`)
  const failureOf = (what, run) => `${what} failed: ${firstLine(redact(run.stderr)) || `exit ${run.code}`}`

  // ---- the issue itself. Three refusals, in the order the stage states them.
  const view = runGh(['issue', 'view', String(issue), '--json', 'number,title,state,labels,assignees,body,url'], { cwd })
  if (view.code !== 0) return unknown('issue-unreadable', failureOf(`\`gh issue view ${issue}\``, view))
  const found = parseJson(view.stdout)
  if (found === null) return unknown('issue-unreadable', `\`gh issue view ${issue}\` printed something this could not read as a JSON object`)

  const state = String(found.state ?? '').toUpperCase()
  if (state !== 'OPEN') {
    return refuse('issue-closed', `issue #${issue} on ${repo} is ${state || 'in no state this could read'}, and a claim is only taken on an open issue`)
  }
  const labels = labelNames(found.labels)
  if (!labels.includes(READY_LABEL)) {
    return refuse('not-ready', `issue #${issue} does not carry ${READY_LABEL}, so nobody has validated the spec this run would work from`)
  }
  const blocking = BLOCKING_LABELS.filter((label) => labels.includes(label))
  if (blocking.length > 0) {
    return refuse('blocked', `issue #${issue} carries ${blocking.join(', ')} beside ${READY_LABEL}, so the ready label is stale and only a human clears the blocker`, { blocking })
  }

  const section = acceptanceCriteria(found.body)
  if (section === null) {
    return refuse('no-acceptance-criteria', `issue #${issue} has no line that is exactly "${AC_HEADING}", so there is nothing to judge the run against`)
  }
  const acDigest = sha256(section)

  // ---- the names. Everything but --kind is derived, so two runs on one issue build the same
  // branch and the same path and the scans below can recognise each other's work.
  const kind = kindArg ?? kindFromLabels(labels)
  const slug = slugify(found.title)
  if (slug === '') {
    return refuse('bad-slug', `the title of issue #${issue} has no letters or digits in it, so there is no slug to name a branch after`)
  }
  const branch = `${kind}/issue-${issue}-${slug}`
  const topRead = runGit(['rev-parse', '--show-toplevel'], cwd, LOCAL_GIT_TIMEOUT_MS)
  const repoRoot = topRead.code === 0 ? topRead.stdout.trim() : ''
  if (repoRoot === '') {
    return unknown('repo-unreadable', `\`git rev-parse --show-toplevel\` gave no repository root for this directory: ${firstLine(redact(topRead.stderr)) || `exit ${topRead.code}`}`)
  }
  const parent = dirname(repoRoot)
  const worktree = join(parent, `${basename(repoRoot)}-issue-${issue}-${slug}`)
  const names = { kind, branch, worktree, acDigest, title: found.title ?? null, url: found.url ?? null }

  // ---- is a run already live? All three places one leaves a mark: this clone's worktrees, the
  // issue's branches on the server, and open pull requests. The server is asked for the branches
  // rather than this clone, because a clone's refs are only as fresh as its last fetch and the
  // branch is the marker that outlives the claim tag.
  const scan = () => {
    const hits = []
    const listed = runGit(['worktree', 'list', '--porcelain'], cwd, LOCAL_GIT_TIMEOUT_MS)
    if (listed.code !== 0) return { problem: failureOf('`git worktree list --porcelain`', listed) }
    for (const entry of parseWorktrees(listed.stdout)) {
      const name = shortBranch(entry.branch)
      const byPath = basename(entry.path).includes(`-issue-${issue}-`)
      if (byPath || (typeof name === 'string' && branchForIssue(issue).test(name))) {
        hits.push({ where: 'worktree', path: entry.path, branch: entry.branch })
      }
    }

    const patterns = ['feat', 'fix', 'chore'].map((k) => `refs/heads/${k}/issue-${issue}-*`)
    const remote = runGit(['ls-remote', 'origin', ...patterns], cwd, REMOTE_GIT_TIMEOUT_MS)
    if (remote.code !== 0) return { problem: failureOf('`git ls-remote origin` with the three issue patterns', remote) }
    for (const text of remote.stdout.split('\n')) {
      const [sha, name] = text.split('\t')
      if (!SHA.test(sha ?? '') || typeof name !== 'string' || !name.startsWith('refs/heads/')) continue
      if (branchForIssue(issue).test(shortBranch(name))) hits.push({ where: 'remote-branch', ref: name, sha })
    }

    // A bounded read: a repository with more than 100 open pull requests can hide one from this.
    // The remote branch scan above is the one that cannot miss, and it covers the same run.
    const prs = runGh(['pr', 'list', '--state', 'open', '--json', 'number,headRefName,title,url', '--limit', '100'], { cwd })
    if (prs.code !== 0) return { problem: failureOf('`gh pr list --state open`', prs) }
    const open = parseJson(prs.stdout)
    if (!Array.isArray(open)) return { problem: '`gh pr list --state open` printed something this could not read as a JSON array' }
    for (const pr of open) {
      if (branchForIssue(issue).test(String(pr?.headRefName ?? ''))) {
        hits.push({ where: 'pull-request', number: pr?.number ?? null, headRefName: pr?.headRefName ?? null, title: pr?.title ?? null, url: pr?.url ?? null })
      }
    }
    return { hits }
  }

  const first = scan()
  if (first.problem) return unknown('scan-unreadable', `the scan for a run already working issue #${issue} could not be completed: ${first.problem}`, names)
  if (first.hits.length > 0) {
    return refuse('live-run', `issue #${issue} already has a run on it`, { ...names, live: first.hits },
      `issue #${issue} already has a run on it: ${describeHits(first.hits)}. Nothing was claimed. Look at that run before starting another.`)
  }

  // ---- the path this run would write to. Checked before the first mutation, because a worktree
  // add that fails after the claim is a tag to give back and a half-made directory to clear up.
  if (existsSync(worktree)) {
    return refuse('worktree-path', `${worktree} already exists, so there is nowhere to put this run's worktree`, names)
  }
  try {
    accessSync(parent, constants.W_OK)
  } catch {
    return refuse('worktree-path', `${parent} is not writable, so the worktree beside this repository cannot be created`, names)
  }
  // The boundary check the stage states. A repository that is itself a linked worktree of
  // something outside this directory's parent passes everything else and then fails at
  // `git worktree add`, after the claim, because git writes the new registration into that
  // out-of-bounds common directory.
  const commonRead = runGit(['rev-parse', '--git-common-dir'], cwd, LOCAL_GIT_TIMEOUT_MS)
  const common = commonRead.code === 0 ? resolve(cwd, commonRead.stdout.trim()) : ''
  if (common === '') {
    return unknown('repo-unreadable', `\`git rev-parse --git-common-dir\` gave no git directory for this repository: ${firstLine(redact(commonRead.stderr)) || `exit ${commonRead.code}`}`, names)
  }
  if (common !== parent && !common.startsWith(parent + sep)) {
    return refuse('outside-parent', `this repository's git directory is ${common}, outside ${parent}, so a worktree added here would register itself out of bounds`, names)
  }

  // ---- the claim. Everything above was a read.
  const acquired = acquire({ argv: [String(issue)], cwd })
  const receipt = parseJson(acquired.stdout)
  const verdict = receipt?.result
  if (verdict === 'held') {
    const holder = String(receipt.sha ?? '')
    return line({ ...base, ...names, result: 'held', sha: receipt.sha ?? null, detail: receipt.detail ?? null }, EXIT_HELD,
      `issue #${issue} is already claimed on ${repo} (${ref}${SHA.test(holder) ? ` at ${holder.slice(0, 12)}` : ''}). ` +
      'Leave it alone; the run that holds it releases it, or a human breaks the tag.')
  }
  if (verdict === 'refused') {
    return refuse('acquire-refused', `the claim on issue #${issue} was refused (${receipt.reason ?? 'no reason'}): ${receipt.detail ?? 'no detail'}`, names)
  }
  if (verdict !== 'acquired' || !SHA.test(String(receipt.sha ?? ''))) {
    return unknown('acquire-unknown', `the claim on issue #${issue} could not be taken: ${receipt?.detail ?? acquired.stdout.trim()}`, names)
  }
  const baseSha = receipt.sha
  const claimed = { ...names, base: baseSha }

  const giveBack = () => parseJson(abandon({ argv: [String(issue), baseSha], cwd }).stdout)?.result ?? 'unknown'
  const afterGiveBack = (result) => result === 'abandoned'
    ? 'The claim tag was given back, so nothing of this run is left anywhere.'
    : `The claim tag could NOT be given back (abandon said ${result}), so ${ref} on ${repo} needs a human.`

  // ---- the second scan, the one that catches a contender who scanned before this run took the
  // tag and is still on its way to claiming. Race-free by construction: holding the tag blocks
  // every new contender, and any earlier winner released only after its branch reached origin.
  const second = scan()
  if (second.problem) {
    const gave = giveBack()
    return unknown('scan-unreadable', `the second scan for a live run on issue #${issue} could not be completed: ${second.problem}`, { ...claimed, abandon: gave },
      `the second scan for a live run on issue #${issue} could not be completed: ${second.problem}. ${afterGiveBack(gave)}`)
  }
  if (second.hits.length > 0) {
    const gave = giveBack()
    return refuse('live-run', `issue #${issue} already has a run on it, found while holding the claim`, { ...claimed, live: second.hits, abandon: gave },
      `issue #${issue} already has a run on it: ${describeHits(second.hits)}. ${afterGiveBack(gave)} Look at that run before starting another.`)
  }

  // ---- the worktree, at the object the acquire verified on the remote. Never at this clone's
  // own origin/main, which is as old as its last fetch.
  const added = runGit(['worktree', 'add', worktree, '-b', branch, baseSha], cwd, WORKTREE_TIMEOUT_MS)
  if (added.code !== 0) {
    // An add that failed part way can still leave a registration and a directory behind, and
    // both would refuse the next run at the worktree-path check. remove without --force, then
    // prune: the checkout is seconds old and has nothing in it worth forcing past, and a remove
    // that does refuse leaves the path for a human rather than deleting work nobody expected.
    runGit(['worktree', 'remove', worktree], cwd, WORKTREE_TIMEOUT_MS)
    runGit(['worktree', 'prune'], cwd, LOCAL_GIT_TIMEOUT_MS)
    const gave = giveBack()
    const detail = `\`git worktree add ${worktree} -b ${branch}\` failed: ${firstLine(redact(added.stderr)) || `exit ${added.code}`}`
    return refuse('worktree-add', detail, { ...claimed, abandon: gave }, `${detail}. ${afterGiveBack(gave)}`)
  }

  // Nothing is committed between the branch creation and this push, so the head is the base. The
  // release below re-reads origin and refuses unless the remote branch is exactly this object,
  // which is what proves the push landed; a local rev-parse would only prove what git did here.
  const head = baseSha
  const pushed = runGit(['push', '-u', 'origin', branch], worktree, PUSH_TIMEOUT_MS)
  if (pushed.code !== 0) {
    runGit(['worktree', 'remove', worktree], cwd, WORKTREE_TIMEOUT_MS)
    runGit(['worktree', 'prune'], cwd, LOCAL_GIT_TIMEOUT_MS)
    // The branch goes too, but only while it still points at the base this run created it at, so
    // a name that turned out to belong to someone else is left alone. Without this the retry
    // after the abandon walks into `a branch named ... already exists` and needs a human for a
    // branch nobody ever published.
    const local = runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd, LOCAL_GIT_TIMEOUT_MS)
    if (local.code === 0 && local.stdout.trim() === baseSha) runGit(['branch', '-D', branch], cwd, LOCAL_GIT_TIMEOUT_MS)
    const gave = giveBack()
    const detail = `\`git push -u origin ${branch}\` failed: ${firstLine(redact(pushed.stderr)) || `exit ${pushed.code}`}`
    return refuse('push', detail, { ...claimed, head, abandon: gave }, `${detail}. ${afterGiveBack(gave)}`)
  }

  // ---- past here the branch is on origin, where every other run's scan can see it, and the tag
  // is no longer the only thing keeping a second run out. Nothing below gives it back.
  const published = { ...claimed, head }
  const stuck = (reason, detail) => unknown(reason, detail, published,
    `${detail}. ${branch} is on ${repo} at ${head.slice(0, 12)} and ${ref} is still there; finish or unwind this by hand, and do not re-run the claim.`)

  const edited = runGh(['issue', 'edit', String(issue), '--add-assignee', '@me', '--remove-label', READY_LABEL, '--add-label', 'in-progress'], { cwd })
  if (edited.code !== 0) {
    return stuck('issue-edit', failureOf(`\`gh issue edit ${issue}\``, edited))
  }

  const released = parseJson(release({ argv: [String(issue), branch, head], cwd }).stdout)
  if (released?.result !== 'released') {
    return stuck('release', `the claim on issue #${issue} could not be released (${released?.result ?? 'no result'}: ${released?.detail ?? 'no detail'})`)
  }

  return line({ command: 'claim', result: 'claimed', issue, title: found.title ?? null, kind, branch, worktree, base: baseSha, head, acDigest, url: found.url ?? null }, EXIT_OK, '')
}

/**
 * Decide and act. Takes the argument vector, a working directory and a gh runner, and returns a
 * { code, stdout, stderr } result instead of exiting, so a caller can drive it in process.
 *
 * gh is injected the way scripts/land-merge.mjs injects it, as a plain function across the
 * module boundary, which is what lets the smoke answer GitHub reads from a state object without
 * an environment variable that selects the binary this program trusts. The three git-only
 * subcommands never call it.
 *
 * @param {object} args
 * @param {string[]} args.argv the argument vector after the script name
 * @param {string} args.cwd the directory whose origin remote this run claims on
 * @param {(ghArgs: string[], options: {cwd: string}) => {code: number, stdout: string, stderr: string}} [args.runGh]
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function issueClaim({ argv, cwd, runGh }) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { code: EXIT_OK, stdout: USAGE, stderr: '' }
  }
  const [subcommand, ...rest] = argv
  if (subcommand === 'claim') return claim({ argv: rest, cwd, runGh })
  if (subcommand === 'acquire') return acquire({ argv: rest, cwd })
  if (subcommand === 'release') return release({ argv: rest, cwd })
  if (subcommand === 'abandon') return abandon({ argv: rest, cwd })
  const detail = argv.length === 0
    ? 'expected a subcommand, one of claim, acquire, release or abandon'
    : `${JSON.stringify(subcommand)} is not a subcommand; expected claim, acquire, release or abandon`
  return line({ command: null, result: 'refused', reason: 'usage', detail }, EXIT_REFUSED, `${detail}.\n\n${USAGE}`)
}

// The production gh, resolved once from PATH and remembered as an absolute path, exactly as
// scripts/land-merge.mjs resolves it and for the same reason: at one uid this is cooperative,
// and what the one-time resolution buys is that a PATH change mid-run cannot swap the binary out
// from under a claim that is half done. There is no variable whose only job is to pick this
// binary. GH_REPO and GH_HOST come out of the child environment because every call here means
// the repository this working directory is in, and an ambient redirect would read the issue from
// one repository and label another.
const resolveGh = () => {
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'gh')
    try { accessSync(candidate, constants.X_OK); return candidate } catch {}
  }
  return 'gh'
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const ghBin = resolveGh()
  const ghEnv = { ...process.env }
  delete ghEnv.GH_REPO
  delete ghEnv.GH_HOST
  const runGh = (ghArgs, options) => {
    try {
      const stdout = execFileSync(ghBin, ghArgs, {
        encoding: 'utf8', timeout: GH_TIMEOUT_MS, cwd: options.cwd, env: ghEnv, stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { code: 0, stdout: String(stdout), stderr: '' }
    } catch (error) {
      return { code: error?.status ?? 1, stdout: String(error?.stdout || ''), stderr: String(error?.stderr || error?.message || error) }
    }
  }
  const result = issueClaim({ argv: process.argv.slice(2), cwd: process.cwd(), runGh })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.code)
}
