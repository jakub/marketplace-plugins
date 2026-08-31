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
// and a delete that checked the object would be no safer. Deleting under a compare-and-set would
// need a lease flag, which is a force flag, and this program has none. At this trust level the
// cost is bounded, two runs on one issue, and the recovery is a human reading the issue.
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
// Nothing here force-pushes, in any spelling, and nothing here breaks a stale tag on its own.
// Either one would turn the single atomic operation this program rests on into an overwrite,
// which is the same as having no claim at all. A tag left behind by a crashed run is a job for
// a human running `git push origin :refs/tags/flow-claim-issue-<N>`, who can read the issue
// first and decide.
//
// A cooperative guardrail, not a security boundary, the same as scripts/land-merge.mjs. At one
// uid a model with a shell can push whatever it likes. What this buys is that the ordinary path
// cannot start a duplicate run by accident.
//
// Every remote interaction is an argv array, never a shell string, so there is no quoting to
// get wrong. stdout is always exactly one JSON object, one line, including for refusals; the
// only exception is --help. stderr carries a sentence for a human whenever the result is not a
// win. Exit codes: 0 acquired or released, 2 usage or refusal, 3 held by someone else,
// 4 unknown.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LOCAL_GIT_TIMEOUT_MS = 5_000
const REMOTE_GIT_TIMEOUT_MS = 30_000
const PUSH_TIMEOUT_MS = 60_000

const EXIT_OK = 0
const EXIT_REFUSED = 2
const EXIT_HELD = 3
const EXIT_UNKNOWN = 4

const SHA = /^[0-9a-f]{40}$/
// Deliberately narrow. Flow's branches look like feat/issue-6-thing, and a name outside this
// set is a caller mistake worth refusing rather than a ref worth constructing.
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const MAIN_REF = 'refs/heads/main'

/**
 * The branch names that authorize releasing issue N's claim. The number is interpolated from a
 * validated integer, so there is nothing in it that a regular expression reads as syntax.
 */
const branchForIssue = (issue) => new RegExp(`^(feat|fix|chore)/issue-${issue}-`)

const USAGE = `issue-claim.mjs acquire <issue-number>
issue-claim.mjs release <issue-number> <branch> <expected-head-sha>

acquire takes the claim on an issue by creating refs/tags/flow-claim-issue-<N> on origin, at
the head of refs/heads/main. Creating a ref is atomic on the remote, so exactly one racer wins.
Exits 0 when it created the tag, 3 when someone already holds it, 4 when the outcome could not
be established, 2 on a usage error or a refusal.

release gives the claim back. The branch has to be named for the issue being released, matching
feat/issue-<N>-, fix/issue-<N>- or chore/issue-<N>-, and refs/heads/<branch> on origin has to
read back at exactly <expected-head-sha>. Anything else keeps the tag, because a tag outliving
an ambiguous state is what stops a second run from starting.

Both subcommands refuse when origin's fetch and push URLs disagree. Nothing here force-pushes or
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

  // The compare-and-set. A plain create refspec: no leading +, no --force in any spelling. If
  // the tag appeared between the preflight and here, receive-pack refuses this and says so.
  const push = runGit(['push', '--porcelain', 'origin', `${mainSha}:${ref}`], cwd, PUSH_TIMEOUT_MS)
  const status = pushStatus(push.stdout, ref)

  // The only win. `*` is git's documented flag for a ref it created, and a create of a tag ref
  // is what the remote serialises. Everything else, including the 0 exit of "up to date", falls
  // through to the re-read below.
  if (push.code === 0 && status !== null && status.flag === '*') {
    return line({ ...base, result: 'acquired', sha: mainSha }, EXIT_OK, '')
  }

  // Not a win. It might be a rival's tag, it might be our own tag from a push whose response was
  // lost, and from here those are indistinguishable, because both racers push the same object.
  // Standing down on both is the safe direction.
  const after = readRef(cwd, ref, redact)
  const why = `the push did not create the ref (git said ${describeStatus(status, redact)}, exit ${push.code})`
  if (after.state === 'present') return held(after.sha, why)
  if (after.state === 'absent') {
    return unknown(`${why}, and ${ref} is not on the remote either. ` +
      `git's stderr was: ${firstLine(redact(push.stderr)) || '(empty)'}`)
  }
  return unknown(`${why}, and the re-read could not settle it: ${after.detail}`)
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

/**
 * Decide and act. Takes the argument vector and a working directory and returns a
 * { code, stdout, stderr } result instead of exiting, so a caller can drive it in process.
 *
 * @param {object} args
 * @param {string[]} args.argv the argument vector after the script name
 * @param {string} args.cwd the directory whose origin remote this run claims on
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function issueClaim({ argv, cwd }) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { code: EXIT_OK, stdout: USAGE, stderr: '' }
  }
  const [subcommand, ...rest] = argv
  if (subcommand === 'acquire') return acquire({ argv: rest, cwd })
  if (subcommand === 'release') return release({ argv: rest, cwd })
  const detail = argv.length === 0
    ? 'expected a subcommand, acquire or release'
    : `${JSON.stringify(subcommand)} is not a subcommand; expected acquire or release`
  return line({ command: null, result: 'refused', reason: 'usage', detail }, EXIT_REFUSED, `${detail}.\n\n${USAGE}`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const result = issueClaim({ argv: process.argv.slice(2), cwd: process.cwd() })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.code)
}
