#!/usr/bin/env node
// Every fact flow's land gates inspect, re-derived from GitHub and the local clone, printed once
// as JSON with a verdict.
//
// This is the read-only half of the land. scripts/land-merge.mjs is the other half, and it is the
// one that mutates. This program merges nothing, retargets nothing, resolves no thread, closes no
// issue and reruns no job. It reads, it sorts what it read into a closed list of stop codes, and
// it exits. What to do about a stop stays with the stage, because that is where the human is.
//
// Why this is code rather than the stage's prose. The land gates are six or seven readings whose
// rules are all small and all easy to get wrong in the same direction. A check rollup mixes
// CheckRuns with commit statuses and the two spell their outcome in different fields. A thread
// query that stopped at page one looks exactly like a pull request with no unresolved threads. A
// flake allowlist read from the pull request instead of from the base lets a branch approve its
// own failures. Every one of those mistakes reads as green, and the reader who makes them is a
// model that has just been told the work is finished. So the rules live here, applied the same
// way every time, and the stage reads a verdict instead of a screenful of JSON.
//
// Stops and attention are two different things on purpose. A stop is a fact that means this pull
// request does not merge right now: it is not open, it is a draft, CI is not green, a reviewer
// thread is still open, someone armed an auto-merge. Attention is a fact that needs an action or
// a decision but is not a reason to refuse: open pull requests based on this branch have to be
// retargeted first, a follow-up draft has to be filed or dropped, a flake entry that exists only
// on the pull request side is part of the diff under review, and an ambiguous set of linked
// issues is a question for the human. Folding those into stops would mean the stage routinely
// merges over its own stop list, and a stop list that gets overridden every run stops meaning
// anything.
//
// Unknown is its own state and it outranks stop. A gh or git read that failed sets `error`, and
// the exit code is 4 whatever else was found, because "I could not read the threads" and "there
// are no unresolved threads" are the same shape from the caller's side and must never be the same
// exit code. Where a stop code fits the failed read, it is added too: an unreadable thread page is
// `threads-unreadable`, an unreadable merge queue is `merge-queue`. Where none fits, the error
// alone makes the verdict `stop`. Exit codes: 0 pass, 1 stop, 2 usage or refusal, 4 unknown.
//
// The check partition, and why it reads two fields. A CheckRun reports `conclusion` with `status`
// alongside it; a commit status, which is how external reviewers like CodeRabbit report, has no
// conclusion at all and reports `state`. Reading only `conclusion` would drop every passing
// commit status into the unknown bucket and stop every land on a repository that has one, so the
// verdict token is the conclusion when there is one and the state otherwise, with a null token
// falling back to a non-terminal `status` to catch a run still in progress.
//
// An entry with no name is unknown however green it looks, because a check nobody can name is not
// a check anyone reviewed. The two kinds of entry spell their name in different fields as well as
// their outcome: a CheckRun has `name` and `detailsUrl`, a commit status has `context` and
// `targetUrl`, so both fields are read and most commit statuses name themselves. What is left
// nameless is looked up in a `gh pr checks` cross-read, which renders both kinds through one
// formatter, and the join is the details url, on one condition. The url has to identify a single
// check on both sides, meaning exactly one rollup entry and exactly one cross-read entry carry
// it. Equal cardinality is not identity, and neither is a shared url.
//
// Two reads of the same pull request come back in no guaranteed order, so pairing leftovers by
// position is a coin toss that can put a passing name on a failing check. Joining on a url that
// two checks share is the same coin toss, and a status provider that links every context it
// reports to the one build page deals it every run: two nameless rollup entries, [FAILURE,
// SUCCESS], both linking to that build, and a cross-read naming `known-flake` and `e2e`, both
// linking to it too. Whichever name the failure took decided whether the allowlist excused it,
// and either way `e2e`'s failure was never reported. So a url that more than one entry carries
// on either side joins nothing, every entry carrying it stays unknown, and unknown stops the
// land.
//
// That cross-read is optional - an older gh with no --json on this subcommand is not a failed
// gate - and its output is parsed whatever the exit code is, because `gh pr checks` exits
// non-zero when checks are failing or pending, which is exactly when this program most wants to
// read it.
//
// An empty rollup is unknown too, not a pass. Zero checks is the state a pull request is in for
// the first seconds after a fix push, before GitHub has registered the runs, and it is
// indistinguishable from a repository that has no CI at all. Reporting it green would make the
// most common moment of the land the one moment the gate says nothing. Whether a repository
// genuinely has no CI is the human's call.
//
// Known flakes are read from the base branch and never from the pull request. The pull request's
// copy of .github/known-flakes.txt is part of what is under review, so an entry that exists only
// there moves nothing and is reported as `flakes-added-on-pr` for a human to look at. A bare check
// name in the base copy moves that check from failed to flaky. A `check-name:test_name` entry
// moves nothing, because only the job log can say whether that one test was the sole failure, and
// this program does not read job logs; the entry is surfaced under `flakeCandidates` so the stage
// knows there is a log worth reading. Which of the two a line is cannot be decided by the first
// colon, because a commit status context like `ci/circleci: build` has one: a line that equals a
// check name reported on this pull request is a bare entry, and only a line that matches no check
// name splits.
//
// `--accept-flake check-name:test_name` is the one way such an entry moves anything, and it is a
// statement rather than a reading: whoever passes the flag is saying they read the job log and
// that the named test was the only failure in that check. Without it the per-test path could
// never end anywhere useful, because the stage requires a `pass` before it merges and the
// executor could only ever report `ci-failed` with a candidate beside it. The flag accepts only
// what the base branch already declared, in that exact `check:test` spelling, and only for a
// check that is failing right now; anything else is a usage refusal naming the flag, because a
// flag that can invent an allowlist entry is not an override, it is the allowlist. A bare check
// name is refused too - the allowlist moves those on its own, so a bare name through the flag
// could only mean the caller misunderstood it. What is accepted is recorded under
// `ci.acceptedFlakes` and again as a `flaky-merged-through` attention item saying it was accepted
// by flag, and the land report has to name every one.
//
// Both copies are read over the contents API, at the base ref and at the head SHA, and never out
// of the local clone. A `git fetch` would write objects, FETCH_HEAD and remote-tracking refs into
// a checkout other sessions share, and reading `origin/<base>` without one silently gates against
// whatever that stale ref happens to point at. A 404 is a proven-absent file and means an empty
// allowlist, which is the ordinary case. Any other failure sets `error`: an allowlist nobody could
// read must never excuse a failing check.
//
// Review threads are paged to exhaustion, and a page the query could not deliver is
// `threads-unreadable` rather than a short list. Comments come back as the last 20 rather than the
// first, because the newest reply is what says whether a thread still stands. The merge queue is
// read in a second query rather than folded into the thread query: the two facts have nothing to
// do with each other, and a schema that does not know one field would take down a read of the
// other. An unreadable queue is the string "unknown", never false.
//
// Linked issues are reported as three lists and nothing is decided. `linked` is what GitHub
// parsed. `recovered` is what carries enough intent to act on: the issue number in a
// feat/fix/chore branch name, and a closing phrase in the title or body. `mentions` is every other
// bare #N, which never closes anything - "Part of #6" is a reference, not an instruction.
//
// The head SHA in the output is the value the caller hands to land-merge, and it is why the two
// programs are separate. Everything reported here was read at that commit; a pull request that
// moves afterwards fails land-merge's --match-head-commit instead of landing on gates nobody ran.
//
// This is not a guardrail. It mutates nothing, in the repository or in the clone - `git remote
// get-url origin` is the only git command it runs - so there is nothing here to bypass and no
// reason to. What it buys is one place where the rules live and one shape the stage reads them in.
//
// Nothing printed carries a credential. A remote URL can hold userinfo, as in
// https://user:token@host/owner/repo, and git quotes the remote it was handed word for word in
// its errors, so every message quoted from git or gh goes through a redactor built from the
// configured origin URL, with a userinfo pattern behind it as a backstop.
//
// The remote itself is parsed as a URL and never scanned with a regex that trims a suffix. A
// credential travels in a query string as often as in userinfo, and
// https://host/owner/repo.git?access_token=... under a suffix-stripping regex yields the repo
// name `repo.git?access_token=...`, which is then the `--repo` argument, the contents-API path,
// the redactor's own replacement text and `identity.slug` in a stop detail, so the token lands in
// the JSON the stage journals. So owner and repo come from `new URL().pathname` and nowhere else,
// a remote carrying a query or a fragment is refused unread, and every refusal about the remote
// describes it instead of quoting it.

import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const READ_TIMEOUT_MS = 60_000
const GIT_TIMEOUT_MS = 5_000

const EXIT_PASS = 0
const EXIT_STOP = 1
const EXIT_USAGE = 2
const EXIT_UNKNOWN = 4

// A thread page is 100 threads. Twenty pages is 2000 threads on one pull request, which is not a
// pull request anyone is landing; past that the paging is looping and the read is unreadable.
const MAX_THREAD_PAGES = 20
const THREAD_BODY_LIMIT = 400

const SHA = /^[0-9a-f]{40}$/
const PR_NUMBER = /^[0-9]+$/

const PR_FIELDS = 'number,title,body,state,headRefName,headRefOid,baseRefName,url,isDraft,' +
  'isCrossRepository,mergeable,mergeStateStatus,autoMergeRequest,closingIssuesReferences,' +
  'statusCheckRollup,comments'

const FLAKES_PATH = '.github/known-flakes.txt'

// gh's own rendering of a 404 response, as in `gh: Not Found (HTTP 404)`. By the time the
// allowlist is read, `gh pr view` has already succeeded against this repository, so a 404 on a
// path inside it is the file being absent at that ref and nothing else.
const HTTP_404 = /\(HTTP 404\)|\bNot Found\b/

const CHECK_SUCCESS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const CHECK_FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'])
// Non-terminal, whether it arrives as a CheckRun status, a commit status state, or a bucket.
const CHECK_PENDING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'])

// `gh pr checks --json bucket` collapses the vocabulary above; this maps it back so a cross-read
// entry with a bucket and no state can still classify.
const BUCKET_TOKEN = { pass: 'SUCCESS', fail: 'FAILURE', pending: 'PENDING', skipping: 'SKIPPED', cancel: 'CANCELLED' }

const BRANCH_ISSUE = /^(feat|fix|chore)\/issue-(\d+)-/
const CLOSING_PHRASE = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi
const BARE_ISSUE = /(^|[^\w#])#(\d+)\b/g
const FOLLOW_UP_DRAFT = /^##\s*follow-up draft/im

const USAGE = `land-gates.mjs [--accept-flake <check-name>:<test_name>]... [<pull-request-number>]

Re-derives every fact flow's land gates inspect and prints one JSON object on stdout: the pull
request, its head and base, open pull requests stacked on this branch, the check rollup partitioned
against the base branch's known-flakes allowlist, unresolved review threads, linked issues, a
follow-up draft comment, and whether an auto-merge or a merge queue is armed. With no argument the
pull request is resolved from the current branch.

Both copies of ${FLAKES_PATH} are read over the GitHub contents API, at the base ref and at the
head SHA. A line in that file is one entry: a line that equals a check name this pull request
reported moves that whole check from failed to flaky, and any other line splits on its first colon
into check-name:test_name, which moves nothing and is reported as a job log worth reading. The
name-first rule is what keeps a commit status context like \`ci/circleci: build\` readable.

--accept-flake is how a check-name:test_name entry moves anything. It takes one entry in that
exact spelling, and it is the caller's statement that they read the job log and that the named
test was the only failure in that check. The named check moves from failed to flaky, it is
recorded under ci.acceptedFlakes, and it is reported as a flaky-merged-through attention item
that says it was accepted by flag. The land report has to name every entry accepted this way.
Repeat the flag for more than one entry. It is refused when the entry is not on the base
branch's allowlist, when the check it names is not currently failing, and when it names a bare
check name, which the allowlist already moves on its own.

It mutates nothing, in the repository or in the clone: \`git remote get-url origin\` is the only
git command it runs. Exit 0 when nothing stops the land, 1 when something does, 2 on a usage error
or a refusal, 4 when a read failed and the answer is genuinely unknown.
`

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          comments(last: 20) { nodes { author { login } body path url } }
        }
      }
    }
  }
}`

// Deliberately a second query. isInMergeQueue and Repository.mergeQueue are newer than the thread
// fields, and a host whose schema lacks one must not cost us the read of the other.
const QUEUE_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $base: String!) {
  repository(owner: $owner, name: $repo) {
    mergeQueue(branch: $base) { id }
    pullRequest(number: $pr) { isInMergeQueue }
  }
}`

const parseJson = (text) => {
  if (typeof text !== 'string') return null
  try { return JSON.parse(text) } catch { return null }
}

const parseObject = (text) => {
  const value = parseJson(text)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

const firstLine = (text) => String(text || '').trim().split('\n')[0].slice(0, 200)

const nonEmpty = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

const upper = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '')

const truncate = (text, limit) => {
  const s = String(text ?? '')
  return s.length <= limit ? s : `${s.slice(0, limit)}...`
}

// Userinfo in a URL. Recent git redacts this from its own error text, but that is behaviour and
// not a promise, and every string below is on its way into JSON the stage journals.
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi
const scrubUserinfo = (text) => String(text ?? '').replace(USERINFO, '$1')

/**
 * Swap the configured origin URL for the safe identity before quoting anything a command said.
 * Pattern matching alone is not enough: git repeats the remote it was handed verbatim, as in
 * `fatal: 'user@host' does not appear to be a git repository`, and that spelling has no scheme
 * for the userinfo pattern to anchor on.
 */
const makeRedactor = (rawUrl, identity) => (text) => {
  let out = String(text ?? '')
  const raw = String(rawUrl ?? '').trim()
  if (raw !== '') out = out.split(raw).join(identity)
  return scrubUserinfo(out)
}

// Why the refusals below never quote the remote they refused: the remote is exactly the string
// that can hold the credential, so a message about it describes it instead.
const REMOTE_ABSENT = 'this directory has no readable origin remote, so there is no repository to gate'
const REMOTE_UNREADABLE = 'the origin remote of this directory does not read as a URL naming a host, an owner and ' +
  'a repository, so there is no repository to gate (it is not quoted here, because a remote can carry a credential)'
const REMOTE_QUERY = 'the origin remote of this directory carries a query string or a fragment, which no repository ' +
  'URL needs and a credential often is, so it is refused unread (it is not quoted here, for the same reason)'
const REMOTE_PATH = 'the path of the origin remote does not name exactly one owner and one repository, so there is ' +
  'no repository to gate (it is not quoted here, because a remote can carry a credential)'

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
// git@host:owner/repo.git and host:owner/repo, the two spellings new URL() cannot parse.
const SCP_LIKE = /^(?:[^@\s/]+@)?([^:/\s]+):(.+)$/

/**
 * The repository to gate, derived from the origin remote. Returns { identity } or { refusal }.
 *
 * A scheme URL is parsed with new URL() and owner and repo come from its pathname alone. The
 * regex this replaced stripped a `.git` suffix off the whole string and then took what followed
 * the last slash, so https://host/owner/repo.git?access_token=sekret yielded the repository name
 * `repo.git?access_token=sekret`, and that string went on to be the --repo argument, the
 * contents-API path and identity.slug in a journalled stop detail. A query or a fragment is a
 * refusal now rather than something to strip, because no remote that names a repository has one.
 *
 * The scp-like form has no scheme for new URL() to work with and is still how most people spell
 * a GitHub remote, so it keeps a regex, with the same owner/repo rule applied to its path.
 *
 * Not shared with scripts/land-merge.mjs: these executors are invoked one at a time by path, and
 * a module between them would be a third file to keep in step.
 */
const identityOfRemote = (url) => {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (raw === '') return { refusal: REMOTE_ABSENT }

  const fromPath = (host, path) => {
    const segments = String(path).split('/').filter((part) => part !== '')
    if (segments.length !== 2) return { refusal: REMOTE_PATH }
    const owner = segments[0]
    const repo = segments[1].replace(/\.git$/, '')
    if (host === '' || owner === '' || repo === '') return { refusal: REMOTE_PATH }
    return { identity: { host, owner, repo, slug: `${owner}/${repo}`, full: `${host}/${owner}/${repo}` } }
  }

  if (SCHEME.test(raw)) {
    let parsed
    try { parsed = new URL(raw) } catch { return { refusal: REMOTE_UNREADABLE } }
    if (parsed.search !== '' || parsed.hash !== '') return { refusal: REMOTE_QUERY }
    // The pathname is left percent-encoded on purpose: decodeURIComponent throws on a lone %, and
    // nothing downstream needs the decoded form of an owner or a repository name.
    return fromPath(parsed.hostname, parsed.pathname)
  }

  const scp = raw.match(SCP_LIKE)
  if (scp === null) return { refusal: REMOTE_UNREADABLE }
  const [, host, path] = scp
  if (path.includes('?') || path.includes('#')) return { refusal: REMOTE_QUERY }
  return fromPath(host, path)
}

/** The verdict token for one check entry: its conclusion, or the state a commit status uses. */
const tokenOf = (entry) => upper(entry.conclusion) || upper(entry.state)

const bucketOf = (entry) => {
  const token = tokenOf(entry)
  if (CHECK_SUCCESS.has(token)) return 'success'
  if (CHECK_FAILED.has(token)) return 'failed'
  if (CHECK_PENDING.has(token)) return 'pending'
  if (token === '' && CHECK_PENDING.has(upper(entry.status))) return 'pending'
  return 'unknown'
}

/**
 * Parse .github/known-flakes.txt. One entry per line: a bare check name, or check-name:test_name
 * for a single flaky test inside a suite check. Blank lines and # comments are not entries.
 *
 * `names` is every check name this pull request reported, and it decides which of the two a line
 * is. Splitting on the first colon unconditionally mangles a commit status context that contains
 * one - `ci/circleci: build` became the check `ci/circleci` and the test `build`, matched nothing,
 * and quietly excused no failure it was written to excuse. A line that equals a reported check
 * name is that check; only a line matching no name splits.
 */
const parseFlakes = (text, names = new Set()) => {
  const bare = new Set()
  const tests = new Map()
  const lines = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    lines.push(line)
    if (names.has(line)) { bare.add(line); continue }
    const colon = line.indexOf(':')
    if (colon < 0) { bare.add(line); continue }
    const check = line.slice(0, colon).trim()
    const test = line.slice(colon + 1).trim()
    if (check === '' || test === '') continue
    if (!tests.has(check)) tests.set(check, [])
    tests.get(check).push(test)
  }
  return { bare, tests, lines }
}

/** How many entries of a list carry each url, so a url shared by two of them can be recognized. */
const urlCounts = (items) => {
  const counts = new Map()
  for (const item of items) {
    if (item.url === null || item.url === undefined) continue
    counts.set(item.url, (counts.get(item.url) ?? 0) + 1)
  }
  return counts
}

/**
 * Give the nameless rollup entries their names from the `gh pr checks` cross-read. The details
 * url is the only join key, and it joins only where it identifies a single check on both sides.
 *
 * Two ways of getting this wrong both end with a passing name on a failing check. Pairing the
 * leftovers by position is one: with a rollup of one FAILURE and one SUCCESS, both nameless, and
 * a cross-read naming `unit` and `e2e`, the counts agreed and the failure took whichever name
 * came first. Joining on a url that more than one check carries is the other, and status
 * providers that link every context they report to the one build url produce it as a matter of
 * course: two nameless entries, [FAILURE, SUCCESS], both linking to that build, a cross-read
 * naming `known-flake` and `e2e`, and the failure takes `known-flake`, is excused by the
 * allowlist, and `e2e`'s failure is never reported at all. Equal cardinality is not identity, and
 * neither is a shared url.
 *
 * So a url is a join key only when exactly one rollup entry and exactly one cross-read entry
 * carry it. Everything else keeps a null name and is reported unknown, which stops the land.
 */
const nameFromCrossRead = (entries, checks) => {
  const nameless = entries.filter((entry) => entry.name === null)
  if (nameless.length === 0 || checks.length === 0) return
  const known = new Set(entries.map((entry) => entry.name).filter((name) => name !== null))
  const inRollup = urlCounts(entries)
  const inCrossRead = urlCounts(checks)

  for (const entry of nameless) {
    if (entry.url === null) continue
    if (inRollup.get(entry.url) !== 1 || inCrossRead.get(entry.url) !== 1) continue
    // A cross-read name another rollup entry already carries is not a name for this one either.
    const match = checks.find((check) => check.url === entry.url && check.name !== null && !known.has(check.name))
    if (match === undefined) continue
    entry.name = match.name
    if (tokenOf(entry) === '') entry.state = match.state
  }
}

/**
 * Read every issue number the pull request points at, split three ways. Nothing is decided here:
 * the stage asks the human when `recovered` turns up candidates and `linked` is empty, and a
 * `mentions` entry never closes anything on its own.
 */
const readLinkedIssues = ({ closing, headRef, title, body }) => {
  const linked = []
  for (const ref of Array.isArray(closing) ? closing : []) {
    const n = Number(ref?.number)
    if (Number.isInteger(n) && n > 0 && !linked.includes(n)) linked.push(n)
  }

  const recovered = []
  const add = (n) => {
    if (Number.isInteger(n) && n > 0 && !linked.includes(n) && !recovered.includes(n)) recovered.push(n)
  }
  const branchMatch = String(headRef ?? '').match(BRANCH_ISSUE)
  if (branchMatch !== null) add(Number(branchMatch[2]))

  // The ranges a closing phrase covers, so the same #N is not also counted as a bare mention.
  const text = `${String(title ?? '')}\n${String(body ?? '')}`
  const claimed = []
  for (const match of text.matchAll(CLOSING_PHRASE)) {
    add(Number(match[2]))
    claimed.push([match.index, match.index + match[0].length])
  }

  const mentions = []
  for (const match of text.matchAll(BARE_ISSUE)) {
    const at = match.index + match[1].length
    if (claimed.some(([from, to]) => at >= from && at < to)) continue
    const n = Number(match[2])
    if (Number.isInteger(n) && n > 0 && !linked.includes(n) && !recovered.includes(n) && !mentions.includes(n)) {
      mentions.push(n)
    }
  }
  return { linked, recovered, mentions }
}

/**
 * Gather the land gates and report. Pure of process globals: it takes the argument vector, the
 * environment, the working directory and injected gh and git runners, and returns a
 * { code, stdout, stderr } result instead of exiting, which is what lets the smoke drive it in
 * process with a fake gh across the module boundary.
 *
 * There is no FLOW_CRON_JOB refusal here, unlike its merging sibling. Reading the gates changes
 * nothing, so an unattended job may do it; `env` is taken for the runners' sake and for that
 * absence to be a deliberate line rather than an omission.
 *
 * @param {object} args
 * @param {string[]} args.argv the argument vector after the script name
 * @param {Record<string,string|undefined>} args.env
 * @param {string} args.cwd the clone whose origin remote names the repository
 * @param {(ghArgs: string[], timeoutMs: number) => {code: number, stdout: string, stderr: string}} args.runGh
 * @param {(gitArgs: string[], timeoutMs: number) => {code: number, stdout: string, stderr: string}} args.runGit
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function landGates({ argv, env, cwd, runGh, runGit }) {
  void env
  const refuse = (reason) => ({ code: EXIT_USAGE, stdout: '', stderr: `land-gates: ${reason}\n` })

  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    return { code: EXIT_PASS, stdout: USAGE, stderr: '' }
  }

  // --accept-flake is repeatable and its values are checked against the base branch's allowlist
  // further down, once there is one to check against. Only the shape is decided here.
  const acceptFlakes = []
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    if (arg === '--accept-flake' || arg.startsWith('--accept-flake=')) {
      const value = arg === '--accept-flake'
        ? (i + 1 < argv.length ? String(argv[++i]) : '')
        : arg.slice('--accept-flake='.length)
      if (value.trim() === '') {
        return refuse(`--accept-flake takes one check-name:test_name entry and was given nothing.\n\n${USAGE}`)
      }
      if (!acceptFlakes.includes(value.trim())) acceptFlakes.push(value.trim())
      continue
    }
    positional.push(arg)
  }
  if (positional.length > 1) {
    return refuse(`expected at most one argument, the pull request number.\n\n${USAGE}`)
  }

  const originUrl = (() => {
    const read = runGit(['-C', cwd, 'remote', 'get-url', 'origin'], GIT_TIMEOUT_MS)
    return read.code === 0 ? read.stdout.trim() : ''
  })()
  const remote = identityOfRemote(originUrl)
  // The refusal describes the remote and never quotes it, and nothing has been built from it yet,
  // so a remote refused here reaches no output at all.
  if (remote.identity === undefined) return refuse(remote.refusal)
  const identity = remote.identity
  const redact = makeRedactor(originUrl, identity.full)

  const failures = []
  const noteFailure = (what) => { failures.push(what) }
  const ghJson = (ghArgs, what) => {
    const result = runGh(ghArgs, READ_TIMEOUT_MS)
    const value = result.code === 0 ? parseJson(result.stdout) : null
    if (value === null && what !== null) {
      noteFailure(`${what}${result.code === 0 ? ' gave no readable JSON' : `: ${redact(firstLine(result.stderr)) || `exit ${result.code}`}`}`)
    }
    return value
  }

  // ------------------------------------------------------------------------------ 1. the number
  let prNumber
  if (positional.length === 1) {
    const raw = positional[0].trim()
    if (!PR_NUMBER.test(raw) || Number(raw) <= 0) {
      return refuse(`${JSON.stringify(positional[0])} is not a pull request number.\n\n${USAGE}`)
    }
    prNumber = Number(raw)
  } else {
    // No --repo here on purpose: gh resolves the pull request from the current branch, and it
    // refuses to do that once the repository is named explicitly.
    const current = ghJson(['pr', 'view', '--json', 'number'], null)
    const n = Number(current?.number)
    if (!Number.isInteger(n) || n <= 0) {
      return refuse(`no pull request number was given and none resolves from the current branch of ${cwd}.\n\n${USAGE}`)
    }
    prNumber = n
  }

  // -------------------------------------------------------------------- 2. the pull request itself
  const view = ghJson(['pr', 'view', String(prNumber), '--repo', identity.full, '--json', PR_FIELDS], `\`gh pr view ${prNumber}\``)
  if (view === null) {
    return {
      code: EXIT_UNKNOWN, stdout: '',
      stderr: `land-gates: ${failures[0]}, so nothing about #${prNumber} could be gated\n`,
    }
  }

  const stops = []
  const attention = []
  const stop = (code, detail) => { stops.push({ code, detail }) }
  const attend = (code, detail) => { attention.push({ code, detail }) }

  const state = nonEmpty(view.state)
  if (state !== 'OPEN') stop('not-open', `#${prNumber} is ${state ?? 'in an unreadable state'} on GitHub, and only an open pull request lands`)
  if (view.isDraft !== false) {
    stop('draft', view.isDraft === true
      ? `#${prNumber} is a draft; mark it ready for review before it lands`
      : `the draft status of #${prNumber} did not read back as a boolean, so it cannot be shown ready`)
  }

  const headRef = nonEmpty(view.headRefName)
  const headSha = nonEmpty(view.headRefOid)
  if (headSha === null || !SHA.test(headSha)) {
    // A stop code and a failed read at once. The stop names what is wrong, and the failed read is
    // what sets the exit code, because this is a value that did not arrive rather than a fact
    // about the pull request.
    const detail = `the head of #${prNumber} did not read back as a 40-character lowercase SHA ` +
      `(found ${JSON.stringify(view.headRefOid ?? null)}), so there is no commit to pin the merge to`
    stop('head-unreadable', detail)
    noteFailure(detail)
  }
  const baseRef = nonEmpty(view.baseRefName)

  // ---------------------------------------------------------------- 3-4. the stacked-chain guard
  const repoView = ghJson(['repo', 'view', identity.full, '--json', 'defaultBranchRef'], '`gh repo view`')
  const defaultBranch = nonEmpty(repoView?.defaultBranchRef?.name)
  let baseIsDefault = null
  if (defaultBranch !== null && baseRef !== null) {
    baseIsDefault = baseRef === defaultBranch
    if (!baseIsDefault) {
      stop('stacked-on-non-default', `#${prNumber} targets ${baseRef} and the default branch is ${defaultBranch}; ` +
        'land the parent first or retarget this one')
    }
  }

  const children = []
  if (headRef !== null) {
    const list = ghJson(['pr', 'list', '--repo', identity.full, '--state', 'open', '--base', headRef,
      '--json', 'number,title,url'], `\`gh pr list --base ${headRef}\``)
    for (const child of Array.isArray(list) ? list : []) {
      children.push({ number: child?.number ?? null, title: child?.title ?? null, url: scrubUserinfo(child?.url ?? '') || null })
    }
    if (children.length > 0) {
      attend('children', `${children.length} open pull request(s) are based on ${headRef} ` +
        `(${children.map((c) => `#${c.number}`).join(', ')}); retarget them before this one lands`)
    }
  }

  // ------------------------------------------------------------------------------ 5. the CI gate
  const rollup = Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : []
  // A CheckRun carries name/detailsUrl; a commit status carries context/targetUrl. Reading both
  // pairs is what lets a CodeRabbit status name itself instead of waiting on the cross-read.
  const entries = rollup.map((raw) => ({
    name: nonEmpty(raw?.name) ?? nonEmpty(raw?.context),
    url: nonEmpty(raw?.detailsUrl) ?? nonEmpty(raw?.targetUrl) ?? null,
    conclusion: raw?.conclusion ?? null,
    status: raw?.status ?? null,
    state: raw?.state ?? null,
  }))

  // Parsed whatever gh's exit code was: `gh pr checks` exits non-zero on failing or pending
  // checks, which is precisely when a nameless rollup entry most needs a name.
  const checksRead = runGh(['pr', 'checks', String(prNumber), '--repo', identity.full, '--json', 'name,state,bucket,link'], READ_TIMEOUT_MS)
  const checksJson = parseJson(checksRead.stdout)
  const crossRead = Array.isArray(checksJson)
    ? checksJson.map((check) => ({
      name: nonEmpty(check?.name),
      url: nonEmpty(check?.link) ?? null,
      state: nonEmpty(check?.state) ?? BUCKET_TOKEN[String(check?.bucket ?? '').toLowerCase()] ?? null,
    }))
    : []
  nameFromCrossRead(entries, crossRead)

  const reportedNames = new Set([
    ...entries.map((entry) => entry.name),
    ...crossRead.map((check) => check.name),
  ].filter((name) => name !== null))

  // The allowlist that governs is the base branch's copy. The pull request's own copy is part of
  // the diff under review, so it is read only to report what the branch added to it. Both come
  // from the contents API at an explicit ref, so nothing here touches the clone and no stale
  // remote-tracking ref can stand in for the base branch.
  const readFlakes = (ref, what) => {
    const path = `repos/${identity.owner}/${identity.repo}/contents/${FLAKES_PATH}?ref=${encodeURIComponent(ref)}`
    const result = runGh(['api', '--hostname', identity.host, path], READ_TIMEOUT_MS)
    if (result.code === 0) {
      const body = parseObject(result.stdout)
      // An empty file comes back as empty content with encoding "base64"; a file over the API's
      // inline size limit comes back as empty content with encoding "none", and that is a file
      // this program could not read rather than an empty allowlist. So the encoding decides.
      if (typeof body?.content === 'string' && body.encoding === 'base64') {
        return Buffer.from(body.content, 'base64').toString('utf8')
      }
      noteFailure(`${what} gave no readable file contents`)
      return null
    }
    if (HTTP_404.test(result.stderr) || HTTP_404.test(result.stdout)) return ''
    noteFailure(`${what}: ${redact(firstLine(result.stderr)) || `exit ${result.code}`}`)
    return null
  }

  let baseFlakes = parseFlakes('', reportedNames)
  // Whether the base copy was read at all, which is what --accept-flake is validated against. An
  // allowlist nobody could read has already set `error` and the run exits 4; refusing the flag
  // against an empty parse on top of that would blame the caller for a failed read.
  let baseFlakesReadable = false
  if (baseRef !== null) {
    const baseText = readFlakes(baseRef, `\`gh api\` for ${FLAKES_PATH} on ${baseRef}`)
    baseFlakesReadable = baseText !== null
    baseFlakes = parseFlakes(baseText, reportedNames)
  }
  let prFlakeLines = []
  if (headSha !== null && SHA.test(headSha)) {
    // A fork's head commit is reachable in the base repository through refs/pull, and where it is
    // not the read is a 404 and the pull request side reads empty. That is a missing comparison,
    // not a failed gate.
    prFlakeLines = parseFlakes(readFlakes(headSha, `\`gh api\` for ${FLAKES_PATH} at the head`), reportedNames).lines
  }
  const flakesAddedOnPr = prFlakeLines.filter((line) => !baseFlakes.lines.includes(line))
  if (flakesAddedOnPr.length > 0) {
    attend('flakes-added-on-pr', `${FLAKES_PATH} gained ${flakesAddedOnPr.length} entry(s) on this branch ` +
      `(${flakesAddedOnPr.join(', ')}); the base copy is what this gate applied`)
  }

  const ci = { success: [], pending: [], flaky: [], failed: [], unknown: [], flakeCandidates: {}, acceptedFlakes: [], flakesAddedOnPr }
  for (const entry of entries) {
    if (entry.name === null) { ci.unknown.push({ name: null, link: entry.url }); continue }
    const bucket = bucketOf(entry)
    if (bucket === 'success') { ci.success.push(entry.name); continue }
    if (bucket === 'pending') { ci.pending.push(entry.name); continue }
    if (bucket === 'unknown') { ci.unknown.push({ name: entry.name, link: entry.url }); continue }
    if (baseFlakes.bare.has(entry.name)) { ci.flaky.push(entry.name); continue }
    ci.failed.push({ name: entry.name, link: entry.url })
    const candidates = baseFlakes.tests.get(entry.name)
    if (candidates !== undefined) ci.flakeCandidates[entry.name] = candidates
  }

  // ------------------------------------------------------------------------ 5b. --accept-flake
  // Validated in full before anything moves, so two entries of one check do not make the second
  // flag refuse a check the first already moved.
  const flakyByBare = [...ci.flaky]
  const acceptedChecks = new Set()
  if (acceptFlakes.length > 0 && baseFlakesReadable) {
    const declared = new Map()
    for (const [check, tests] of baseFlakes.tests) {
      for (const test of tests) declared.set(`${check}:${test}`, { check, test })
    }
    const failing = new Set(ci.failed.map((entry) => entry.name))
    const accepted = []
    for (const value of acceptFlakes) {
      const entry = declared.get(value)
      if (entry === undefined) {
        return refuse(value.includes(':')
          ? `--accept-flake ${value} is not an entry of ${FLAKES_PATH} on ${baseRef}; the flag accepts only what ` +
            'the repository already declared flaky, in that exact check-name:test_name spelling'
          : `--accept-flake ${value} names no test. A bare check name on the allowlist moves its check on its own, ` +
            'so the flag takes a check-name:test_name entry and nothing else')
      }
      if (!failing.has(entry.check)) {
        return refuse(`--accept-flake ${value} names ${entry.check}, which is not among the failed checks of ` +
          `#${prNumber}; the flag accepts a failure and there is none to accept`)
      }
      accepted.push(entry)
    }
    for (const { check, test } of accepted) {
      acceptedChecks.add(check)
      ci.acceptedFlakes.push({ check, test })
    }
    ci.failed = ci.failed.filter((entry) => !acceptedChecks.has(entry.name))
    for (const check of acceptedChecks) if (!ci.flaky.includes(check)) ci.flaky.push(check)
  }

  if (entries.length === 0) {
    const said = firstLine(checksRead.stderr)
    stop('ci-unknown', `#${prNumber} reported no checks at all, which is also how a pull request looks in the ` +
      'seconds after a push, before GitHub registers its check runs: no checks reported' +
      (said === '' ? '' : ` (\`gh pr checks\` said: ${redact(said)})`))
  }
  if (ci.pending.length > 0) stop('ci-pending', `${ci.pending.length} check(s) have not finished: ${ci.pending.join(', ')}`)
  if (ci.failed.length > 0) {
    stop('ci-failed', `${ci.failed.length} check(s) failed: ${ci.failed.map((c) => c.name).join(', ')}`)
  }
  if (ci.unknown.length > 0) {
    stop('ci-unknown', `${ci.unknown.length} check(s) could not be read as pass or fail: ` +
      ci.unknown.map((c) => c.name ?? '(unnamed)').join(', '))
  }
  if (flakyByBare.length > 0) {
    attend('flaky-merged-through', `${flakyByBare.join(', ')} failed and ${FLAKES_PATH} on ${baseRef} lists it as flaky; ` +
      'note it in the land report')
  }
  for (const { check, test } of ci.acceptedFlakes) {
    attend('flaky-merged-through', `${check} failed and ${FLAKES_PATH} on ${baseRef} lists ${test} as flaky inside it; ` +
      `accepted by flag as --accept-flake ${check}:${test}, which is the caller's statement that the job log shows ` +
      'that test was the only failure. Name it in the land report')
  }
  for (const [check, tests] of Object.entries(ci.flakeCandidates)) {
    // The accepted ones already have their own item, and it says more than this one would.
    if (acceptedChecks.has(check)) continue
    attend('flaky-merged-through', `${check} failed and ${FLAKES_PATH} lists only ${tests.join(', ')} as flaky inside it; ` +
      'read the job log before merging through, and pass --accept-flake to merge on what it says')
  }

  // ------------------------------------------------------------------------- 6. review threads
  const graphql = (query, vars) => {
    const args = ['api', 'graphql', '--hostname', identity.host, '-f', `query=${query}`]
    for (const [key, value] of Object.entries(vars)) {
      args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`)
    }
    return runGh(args, READ_TIMEOUT_MS)
  }

  const threads = { total: 0, unresolved: [] }
  let threadsReadable = true
  let cursor = null
  for (let pageIndex = 0; pageIndex < MAX_THREAD_PAGES; pageIndex++) {
    const vars = { owner: identity.owner, repo: identity.repo, pr: prNumber }
    if (cursor !== null) vars.cursor = cursor
    const result = graphql(THREADS_QUERY, vars)
    const body = result.code === 0 ? parseObject(result.stdout) : null
    const threadPage = body?.data?.repository?.pullRequest?.reviewThreads
    if (threadPage == null || !Array.isArray(threadPage.nodes)) {
      threadsReadable = false
      noteFailure(`the review-thread query failed: ${redact(firstLine(result.stderr)) || `exit ${result.code}`}`)
      break
    }
    for (const node of threadPage.nodes) {
      threads.total++
      if (node?.isResolved === true) continue
      const comments = Array.isArray(node?.comments?.nodes) ? node.comments.nodes : []
      const last = comments[comments.length - 1] ?? {}
      threads.unresolved.push({
        id: node?.id ?? null,
        path: nonEmpty(last.path) ?? nonEmpty(comments[0]?.path) ?? null,
        url: scrubUserinfo(last.url ?? '') || null,
        author: nonEmpty(last.author?.login) ?? null,
        lastBody: truncate(last.body ?? '', THREAD_BODY_LIMIT),
        isOutdated: node?.isOutdated ?? null,
      })
    }
    if (threadPage.pageInfo?.hasNextPage !== true) { cursor = null; break }
    cursor = nonEmpty(threadPage.pageInfo?.endCursor)
    if (cursor === null) {
      threadsReadable = false
      noteFailure('the review-thread query reported another page and gave no cursor to read it with')
      break
    }
    if (pageIndex === MAX_THREAD_PAGES - 1) {
      threadsReadable = false
      noteFailure(`the review-thread query is still paging after ${MAX_THREAD_PAGES} pages`)
    }
  }
  if (!threadsReadable) {
    stop('threads-unreadable', `the review threads of #${prNumber} could not be read to the end, and a truncated ` +
      'read looks exactly like a clean one')
  } else if (threads.unresolved.length > 0) {
    stop('threads-unresolved', `${threads.unresolved.length} review thread(s) are unresolved: ` +
      threads.unresolved.map((t) => t.path ?? t.id ?? '(no path)').join(', '))
  }

  // ------------------------------------------------------------------------------- 7. the arming
  const autoMerge = view.autoMergeRequest != null
  if (autoMerge) {
    stop('auto-merge-armed', `#${prNumber} has auto-merge armed, so it will land out of sight; that is the human's call, not this run's`)
  }

  let mergeQueue = 'unknown'
  if (baseRef !== null) {
    const queueResult = graphql(QUEUE_QUERY, { owner: identity.owner, repo: identity.repo, pr: prNumber, base: baseRef })
    const queueBody = queueResult.code === 0 ? parseObject(queueResult.stdout) : null
    const repository = queueBody?.data?.repository
    if (repository == null) {
      noteFailure(`the merge-queue query failed: ${redact(firstLine(queueResult.stderr)) || `exit ${queueResult.code}`}`)
    } else {
      mergeQueue = repository.mergeQueue != null || repository.pullRequest?.isInMergeQueue === true
    }
  }
  if (mergeQueue === true) {
    stop('merge-queue', `${identity.slug} uses a merge queue on ${baseRef}, and this stage performs an immediate merge`)
  } else if (mergeQueue === 'unknown') {
    stop('merge-queue', `the merge-queue status of ${baseRef ?? 'the base branch'} could not be read, and unknown is not "no queue"`)
  }

  // ------------------------------------------------------- 8-9. linked issues and the follow-up
  const linkedIssues = readLinkedIssues({
    closing: view.closingIssuesReferences,
    headRef,
    title: view.title,
    body: view.body,
  })
  if (linkedIssues.linked.length === 0 && (linkedIssues.recovered.length > 0 || linkedIssues.mentions.length > 0)) {
    attend('linked-issues-ambiguous', 'GitHub parsed no closing link; candidates are ' +
      `${[...linkedIssues.recovered, ...linkedIssues.mentions].map((n) => `#${n}`).join(', ')}. ` +
      'Ask the human which to close, with an explicit close-none')
  }

  let followUpDraft = null
  for (const comment of Array.isArray(view.comments) ? view.comments : []) {
    if (typeof comment?.body === 'string' && FOLLOW_UP_DRAFT.test(comment.body)) {
      followUpDraft = { id: comment?.id ?? null, url: scrubUserinfo(comment?.url ?? '') || null, body: comment.body }
      break
    }
  }
  if (followUpDraft !== null) {
    attend('follow-up-draft', 'the pull request carries a `## follow-up draft` comment; file it or drop it before the land closes')
  }

  const error = failures.length > 0 ? failures.join('; ') : null
  const verdict = stops.length === 0 && error === null ? 'pass' : 'stop'
  const payload = {
    command: 'land-gates',
    pr: prNumber,
    url: scrubUserinfo(view.url ?? '') || null,
    title: view.title ?? null,
    state,
    isDraft: view.isDraft ?? null,
    isCrossRepository: view.isCrossRepository ?? null,
    head: { ref: headRef, sha: headSha },
    // `default` is here because the stage retargets this pull request's children onto it, and a
    // stage that hard-codes a branch name is wrong on every repository that named it something
    // else. Null when `gh repo view` could not be read.
    base: { ref: baseRef, isDefault: baseIsDefault, default: defaultBranch },
    stacked: { children },
    ci,
    threads,
    linkedIssues,
    followUpDraft,
    arming: { autoMerge, mergeQueue },
    ...(error === null ? {} : { error }),
    attention,
    stops,
    verdict,
  }

  const code = error !== null ? EXIT_UNKNOWN : (stops.length === 0 ? EXIT_PASS : EXIT_STOP)
  const stderr = code === EXIT_PASS ? ''
    : `land-gates: #${prNumber} ${code === EXIT_UNKNOWN ? `is unknown (${error})` : `stops on ${stops.map((s) => s.code).join(', ')}`}\n`
  return { code, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr }
}

// ------------------------------------------------------------------------------- CLI entry
//
// The production runner resolves a real gh from PATH once, at startup, and remembers the absolute
// path, the same as scripts/land-merge.mjs: a PATH change mid-run cannot swap the binary, and no
// environment variable selects the gh this program trusts. GH_REPO and GH_HOST come off the child
// environment because every call already pins the repository derived from origin.

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
  const run = (bin, args, timeoutMs, childEnv) => {
    try {
      const stdout = execFileSync(bin, args, {
        encoding: 'utf8', timeout: timeoutMs, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { code: 0, stdout: String(stdout), stderr: '' }
    } catch (error) {
      return { code: error?.status ?? 1, stdout: String(error?.stdout || ''), stderr: String(error?.stderr || error?.message || error) }
    }
  }
  const result = landGates({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    runGh: (args, timeoutMs) => run(ghBin, args, timeoutMs, ghEnv),
    runGit: (args, timeoutMs) => run('git', args, timeoutMs, process.env),
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.code)
}
