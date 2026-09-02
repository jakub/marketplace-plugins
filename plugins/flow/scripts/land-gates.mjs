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
// rules are all small and all easy to get wrong in the same direction. Check runs and commit
// statuses arrive from two endpoints and spell their outcome in different fields. A read that
// stopped at page one looks exactly like a pull request with no unresolved threads. A
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
// Why `gh pr view` cannot be the source for the checks or the comments. Its --json rollup is a
// GraphQL query for `statusCheckRollup.contexts(first: 100)` and its comments are
// `comments(first: 100)`, and gh pages neither of them (observed on gh 2.98.0). A pull request
// with a hundred green checks and a hundred and first failing one came back a pass, exit 0, with
// nothing in the failed list, and a `## follow-up draft` in the hundred and first comment was
// invisible the same way. A gate that reads the first hundred of anything is a gate a busy pull
// request walks straight past, and it fails green, which is the one direction that matters here.
//
// So all three lists are read over the REST API with `gh api --paginate --slurp`, keyed on the
// head SHA for the checks and on the pull request number for the comments:
// repos/<owner>/<repo>/commits/<head>/check-runs, .../statuses, and
// repos/<owner>/<repo>/issues/<n>/comments. --paginate walks every page; --slurp is what wraps
// them in one outer array, because on its own --paginate prints one JSON document per page and
// two adjacent documents are not JSON. What arrives is therefore an array of pages to flatten. A
// page that failed, or that did not read as a page, is a failed read and never a short list:
// `error` is set and the run exits 4, the same rule the review threads follow. `gh pr view` still
// answers for the pull request's own fields, which are single values with no page size in them.
//
// The two check sources are partitioned differently because they report differently. A check run
// carries `status` - queued, in_progress, completed - beside `conclusion`, so it is pending until
// its status says completed and is bucketed on its conclusion after that; a conclusion left over
// from an earlier attempt says nothing about a run that is going again. A commit status, which is
// how an external reviewer like CodeRabbit reports, has no conclusion at all and carries `state`:
// success, pending, failure, error. Reading one field for both would drop every passing commit
// status into the unknown bucket and stop every land on a repository that has one.
//
// The check-runs endpoint is left on its default filter=latest, which serves the latest attempt of
// each run: an attempt someone has already rerun is not a check anyone is waiting on. The statuses
// endpoint has no such filter and serves every status ever posted for a context, newest first, so
// only the first occurrence of a context counts. A context that failed at 10:00 and passed on a rerun at
// 10:20 is passing, and counting the older entry would stop the land on a failure the repository
// has already superseded.
//
// An entry with no name is unknown however green it looks, because a check nobody can name is not
// a check anyone reviewed. Both endpoints name their own entries - a check run in `name`, a
// commit status in `context` - so nothing joins one list to another here. The version this
// replaced filled in nameless rollup entries from a `gh pr checks` cross-read joined on the
// details url, and that join put a passing name on a failing check twice: once by pairing
// leftovers by position, once on the single build url every context of one provider shared.
// Reading each list from the endpoint that owns it costs one more call and removes the guess.
//
// No checks at all is unknown too, not a pass. Zero check runs and zero commit statuses is the
// state a pull request is in for the first seconds after a fix push, before GitHub has registered
// the runs, and it is indistinguishable from a repository that has no CI at all. Reporting it
// green would make the most common moment of the land the one moment the gate says nothing.
// Whether a repository genuinely has no CI is the human's call.
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
// name splits. Where it splits is decided the same way. The line
// `ci/circleci: build:flaky_test` split at its first colon named the check `ci/circleci`, which
// nothing reported, so it excused nothing and `--accept-flake` refused the line verbatim off the
// allowlist it came from. So a line splits after the longest reported check name it starts with,
// and at its first colon only where no reported name fits.
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
// could only mean the caller misunderstood it.
//
// A name reaches `ci.flaky` once however many jobs carry it. Two failed check runs of one name
// are two jobs, and the allowlist excuses the name, so listing it per entry only made the land
// report say "e2e, e2e failed".
//
// An acceptance is a statement about one job log, so it moves one check run. Two failed entries
// reporting the same name are two jobs, and one log cannot have shown the named test was the sole
// failure of both, so a name carried by more than one failed entry is a refusal that names their
// urls and leaves all of them failed. For the same reason a check takes at most one accepted test:
// a second flag naming a check an earlier flag already claimed is refused rather than counted.
// What is accepted is recorded under `ci.acceptedFlakes`, with the url of the entry it moved so
// the land report can name the job, and again as a `flaky-merged-through` attention item saying it
// was accepted by flag, and the land report has to name every one.
//
// Both copies are read over the contents API, at the base ref and at the head SHA, and never out
// of the local clone. A `git fetch` would write objects, FETCH_HEAD and remote-tracking refs into
// a checkout other sessions share, and reading `origin/<base>` without one silently gates against
// whatever that stale ref happens to point at. A 404 is a proven-absent file and means an empty
// allowlist, which is the ordinary case. Any other failure sets `error`: an allowlist nobody could
// read must never excuse a failing check.
//
// Review threads are paged to exhaustion, and a page the query could not deliver is
// `threads-unreadable` rather than a short list. Thread comments come back as the last 20 rather
// than the first, because the newest reply is what says whether a thread still stands. The merge queue is
// read in a second query rather than folded into the thread query: the two facts have nothing to
// do with each other, and a schema that does not know one field would take down a read of the
// other. An unreadable queue is the string "unknown", never false.
//
// Linked issues are reported as three lists and nothing is decided. `linked` is what GitHub
// parsed. `recovered` is what carries enough intent to act on: the issue number in a
// feat/fix/chore branch name, and a closing phrase in the title or body. `mentions` is every other
// bare #N, which never closes anything - "Part of #6" is a reference, not an instruction.
//
// A closing phrase counts only where it reads as one. `does not fix #17` matches the same regex as
// `fixes #17`, and so does the `Closes #6` this repository writes inside a code fence to document
// the rule, so a phrase with `not`, `n't`, `never`, `no longer` or `without` ahead of it in its own
// sentence is dropped, and so is one inside a fence or a backtick span. The number still lands in
// `mentions`: the pull request points at that issue, it just does not close it. And a recovered
// number the pull request did not link is a question for the human whether or not GitHub parsed
// some other issue. Asking only when `linked` was empty is what let `Closes #6` beside a negated
// phrase about #17 close both.
//
// The head SHA in the output is the value the caller hands to land-merge, and it is why the two
// programs are separate. Everything reported here was read at that commit; a pull request that
// moves afterwards fails land-merge's --match-head-commit instead of landing on gates nobody ran.
//
// This is not a guardrail. It mutates nothing, in the repository or in the clone - `git remote
// get-url origin` and `git rev-parse --abbrev-ref HEAD` are the only two git commands it runs,
// and both only read - so there is nothing here to bypass and no reason to. What it buys is one
// place where the rules live and one shape the stage reads them in.
//
// The pull request resolved from the current branch is proved to belong here before it is used.
// Every other read names the repository derived from origin, but `gh pr view` refuses to resolve
// a branch once --repo is given, so that one read answers from whatever repository gh picked. In
// a fork checkout with an upstream remote it picks upstream, and then the number is upstream's:
// the gates that follow read an origin pull request wearing the same number, pass on it, and hand
// its head to the merge. So the resolution asks for the url and the head branch alongside the
// number, the url has to be that number's pull request under the origin host, owner and
// repository, compared without regard to case, and the head branch has to be the branch this
// clone has checked out. Anything else is a usage refusal naming the mismatch, and the caller
// still has the explicit number argument, which is pinned like everything else. A local branch
// renamed away from the head branch of its own pull request refuses here too. That is the price
// of a mechanical check, it costs one argument, and the refusal says which argument.
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

// Single values only. statusCheckRollup and comments used to be here, and both were served as the
// first 100 of a list gh does not page.
const PR_FIELDS = 'number,title,body,state,headRefName,headRefOid,baseRefName,url,isDraft,' +
  'isCrossRepository,mergeable,mergeStateStatus,autoMergeRequest,closingIssuesReferences'

const FLAKES_PATH = '.github/known-flakes.txt'

// gh's own rendering of a 404 response, as in `gh: Not Found (HTTP 404)`. By the time the
// allowlist is read, `gh pr view` has already succeeded against this repository, so a 404 on a
// path inside it is the file being absent at that ref and nothing else.
const HTTP_404 = /\(HTTP 404\)|\bNot Found\b/

// A check run's conclusion, read only once its status says the run completed. REST serves these
// lowercase and GraphQL served them upper, so every token is uppercased before it is looked up.
// A conclusion in neither set, `stale` among them, is unknown, and unknown stops the land.
const RUN_SUCCESS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const RUN_FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'])
// A commit status has one field and these are all four of its values.
const STATUS_BUCKET = { SUCCESS: 'success', PENDING: 'pending', FAILURE: 'failed', ERROR: 'failed' }

const BRANCH_ISSUE = /^(feat|fix|chore)\/issue-(\d+)-/
const CLOSING_PHRASE = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi
// A fenced block or a backtick span. Text in one is an example of a closing phrase, not a closing
// phrase, and the land stage's own documentation is full of them.
const CODE_SPAN = /```[\s\S]*?```|`[^`\n]*`/g
// What turns a closing phrase into its opposite, anywhere earlier in the same sentence.
const NEGATION = /\b(?:not|never|no longer|without)\b|n['\u2019]t\b/i
const SENTENCE_END = /[.!?\n]/
const BARE_ISSUE = /(^|[^\w#])#(\d+)\b/g
const FOLLOW_UP_DRAFT = /^##\s*follow-up draft/im

const USAGE = `land-gates.mjs [--accept-flake <check-name>:<test_name>]... [<pull-request-number>]

Re-derives every fact flow's land gates inspect and prints one JSON object on stdout: the pull
request, its head and base, open pull requests stacked on this branch, the check runs and commit
statuses on the head partitioned against the base branch's known-flakes allowlist, unresolved
review threads, linked issues, a follow-up draft comment, and whether an auto-merge or a merge
queue is armed. With no argument the pull request is resolved from the current branch.

The check runs, the commit statuses and the top-level comments are read over the REST API with
\`gh api --paginate --slurp\`, so every one of them is gated however many there are. \`gh pr view\`
answers for the pull request's own fields alone: its --json rollup and comments stop at the first
100 and page nothing after them, which is a pass on a pull request whose 101st check failed.

Both copies of ${FLAKES_PATH} are read over the GitHub contents API, at the base ref and at the
head SHA. A line in that file is one entry: a line that equals a check name this pull request
reported moves that whole check from failed to flaky, and any other line splits into
check-name:test_name, which moves nothing and is reported as a job log worth reading. A line
splits after the longest reported check name it starts with, and at its first colon only where no
reported name fits, which is what keeps a commit status context like \`ci/circleci: build\`
readable on both sides of the colon.

--accept-flake is how a check-name:test_name entry moves anything. It takes one entry in that
exact spelling, and it is the caller's statement that they read the job log and that the named
test was the only failure in that check. The named check moves from failed to flaky, it is
recorded under ci.acceptedFlakes, and it is reported as a flaky-merged-through attention item
that says it was accepted by flag. The land report has to name every entry accepted this way.
Repeat the flag for a second check. It is refused when the entry is not on the base branch's
allowlist, when the check it names is not currently failing, when it names a bare check name,
which the allowlist already moves on its own, when more than one failed check reports the name it
gives, because one job log cannot speak for two jobs, and when a second flag names a check an
earlier one already claimed.

With no argument the pull request gh resolves from the current branch has to be one of this
repository's: its url has to name that number under the host, owner and repository the origin
remote gives, and its head branch has to be the branch checked out here. Anything else is a
refusal, and the number can always be passed explicitly instead.

It mutates nothing, in the repository or in the clone: \`git remote get-url origin\` and, on the run
that was given no number, \`git rev-parse --abbrev-ref HEAD\` are the only git commands it runs.
Exit 0 when nothing stops the land, 1 when something does, 2 on a usage error or a refusal, 4 when
a read failed and the answer is genuinely unknown.
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

/**
 * Whether the pull request gh resolved from the current branch is one of `identity`'s. Returns
 * null when it is, and the mismatch as a sentence when it is not.
 *
 * The url is the whole proof, because it is the only thing in that answer that names a
 * repository. It has to be the given number's pull request path under the origin host, owner and
 * repository. Host, owner and repository are compared lowercased: GitHub serves them in whatever
 * case they were registered, and a remote may spell them another way, so case is not a mismatch.
 * The number is compared as text, since it is what the rest of the run gates on.
 */
const resolvedElsewhere = (view, number, identity) => {
  const raw = nonEmpty(view?.url)
  if (raw === null) {
    return `gh resolved #${number} from the current branch and reported no url for it, so there is nothing ` +
      `to show it is a pull request of ${identity.full}; pass the number explicitly to gate it`
  }
  let parsed = null
  try { parsed = new URL(raw) } catch { parsed = null }
  const segments = parsed === null ? [] : parsed.pathname.split('/').filter((part) => part !== '')
  if (segments.length !== 4 || segments[2].toLowerCase() !== 'pull' || segments[3] !== String(number)) {
    return `gh resolved #${number} from the current branch and its url ${raw} is not the url of that pull ` +
      `request, so there is nothing to show it is one of ${identity.full}; pass the number explicitly to gate it`
  }
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
  if (!same(parsed.hostname, identity.host) || !same(segments[0], identity.owner) || !same(segments[1], identity.repo)) {
    return `gh resolved #${number} from the current branch and it belongs to ` +
      `${parsed.hostname}/${segments[0]}/${segments[1]}, not to ${identity.full}, which is the repository the ` +
      'origin remote of this directory names. That is what a fork checkout with an upstream remote looks like; ' +
      'pass the number explicitly to gate a pull request of the repository origin names'
  }
  return null
}

/**
 * Which bucket one entry belongs in, by the rules of the endpoint it came from.
 *
 * A check run is pending until its status says `completed`, and only then does its conclusion
 * mean anything: a run that is going again still carries the conclusion of the attempt before it.
 * A commit status has no status field and no conclusion, only `state`.
 */
const bucketOf = (entry) => {
  if (entry.kind === 'check-run') {
    if (upper(entry.status) !== 'COMPLETED') return 'pending'
    const token = upper(entry.conclusion)
    if (RUN_SUCCESS.has(token)) return 'success'
    if (RUN_FAILED.has(token)) return 'failed'
    return 'unknown'
  }
  return STATUS_BUCKET[upper(entry.state)] ?? 'unknown'
}

/**
 * Split one allowlist entry into the check it names and the test inside it, or null when it names
 * no test.
 *
 * The first colon is the wrong place to split whenever the check's own name has one. CircleCI
 * reports its contexts as `ci/circleci: build`, so `ci/circleci: build:flaky_test` became the
 * check `ci/circleci` and the test `build:flaky_test`, which named nothing this pull request
 * reported: no candidate was recorded, and the flag refused the line in the spelling the
 * allowlist itself used. So the longest reported check name the entry starts with, followed by a
 * colon, decides the split, and the first colon is only the fallback. Longest and not first,
 * because a repository can report `suite` and `suite:slow` both, and then `suite:slow:test_x` is
 * the second one's test rather than the first one's `slow:test_x`.
 */
const splitEntry = (line, names) => {
  let matched = null
  for (const name of names) {
    if (!line.startsWith(`${name}:`)) continue
    if (matched === null || name.length > matched.length) matched = name
  }
  const colon = matched === null ? line.indexOf(':') : matched.length
  if (colon < 0) return null
  const check = line.slice(0, colon).trim()
  const test = line.slice(colon + 1).trim()
  return check === '' || test === '' ? null : { check, test }
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
    const split = splitEntry(line, names)
    // A line with no colon at all is a check name this pull request did not report, which is an
    // ordinary allowlist entry for a check that is not running today. A line that has a colon and
    // still splits into nothing, like `suite:`, is neither and is dropped.
    if (split === null) { if (!line.includes(':')) bare.add(line); continue }
    if (!tests.has(split.check)) tests.set(split.check, [])
    tests.get(split.check).push(split.test)
  }
  return { bare, tests, lines }
}

/**
 * Blank out every backtick-quoted region, keeping the length so every index still points into the
 * original string. A closing phrase quoted as an example is text about closing an issue.
 */
const maskCode = (text) => text.replace(CODE_SPAN, (span) => span.replace(/[^\n]/g, ' '))

/** Whether anything from the start of this sentence up to `at` negates what follows it. */
const isNegated = (text, at) => {
  let from = 0
  for (let i = at - 1; i >= 0; i--) {
    if (SENTENCE_END.test(text[i])) { from = i + 1; break }
  }
  return NEGATION.test(text.slice(from, at))
}

/**
 * Read every issue number the pull request points at, split three ways. Nothing is decided here:
 * the stage asks the human about every `recovered` candidate, and a `mentions` entry never closes
 * anything on its own.
 *
 * A closing phrase is only one where it reads as one. `does not fix #17` matches the same regex as
 * `fixes #17`, and so does a `Closes #6` written inside a code fence to document the rule, so a
 * phrase with a negation ahead of it in its own sentence is dropped, and so is one inside backticks.
 * Dropped means dropped from `recovered` only: the number stays in `mentions`, because the pull
 * request does point at that issue, it just does not close it.
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

  // The ranges a closing phrase covers, so the same #N is not also counted as a bare mention. Only
  // a phrase that counted claims its range; a negated or quoted one falls through to the mentions.
  const text = `${String(title ?? '')}\n${String(body ?? '')}`
  const prose = maskCode(text)
  const claimed = []
  for (const match of prose.matchAll(CLOSING_PHRASE)) {
    if (isNegated(prose, match.index)) continue
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
    // refuses to do that once the repository is named explicitly. That leaves this the one read
    // that answers from a repository nobody pinned, so the url and the head branch come back with
    // the number and the answer is proved to be this clone's before anything is gated on it.
    const current = ghJson(['pr', 'view', '--json', 'number,url,headRefName'], null)
    const n = Number(current?.number)
    if (!Number.isInteger(n) || n <= 0) {
      return refuse(`no pull request number was given and none resolves from the current branch of ${cwd}.\n\n${USAGE}`)
    }
    const elsewhere = resolvedElsewhere(current, n, identity)
    if (elsewhere !== null) return refuse(redact(elsewhere))
    const branch = (() => {
      const read = runGit(['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], GIT_TIMEOUT_MS)
      return read.code === 0 ? read.stdout.trim() : ''
    })()
    // `HEAD` is what a detached checkout answers, and it names no branch for gh to have resolved.
    if (branch === '' || branch === 'HEAD') {
      return refuse(`the current branch of ${cwd} did not read back as a branch name, so the pull request gh ` +
        'resolved from it cannot be shown to be this branch\'s; pass the number explicitly to gate it')
    }
    const resolvedRef = nonEmpty(current.headRefName)
    if (resolvedRef !== branch) {
      return refuse(redact(`gh resolved #${n} from the current branch and reports its head branch as ` +
        `${resolvedRef ?? 'nothing readable'}, which is not ${branch}, the branch checked out in ${cwd}; ` +
        'pass the number explicitly to gate it'))
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
  // Every page of both check sources, off the head SHA. `gh pr view --json statusCheckRollup`
  // stops at the first 100 entries and pages nothing after them, so a hundred and first failing
  // check used to leave this program reporting a pass.
  const readPages = (path, what) => {
    const result = runGh(['api', '--hostname', identity.host, '--paginate', '--slurp', path], READ_TIMEOUT_MS)
    if (result.code !== 0) {
      noteFailure(`${what}: ${redact(firstLine(result.stderr)) || `exit ${result.code}`}`)
      return null
    }
    const pages = parseJson(result.stdout)
    if (!Array.isArray(pages)) {
      noteFailure(`${what} printed something this could not read as an array of pages`)
      return null
    }
    return pages
  }

  const entries = []
  // False as soon as any part of either read failed. It is what separates "this pull request has
  // no checks", which is a stop the human decides about, from "the checks could not be read",
  // which is already an error and exits 4 on its own.
  let checksReadable = false
  if (headSha !== null && SHA.test(headSha)) {
    checksReadable = true
    const commitPath = (kind) => `repos/${identity.owner}/${identity.repo}/commits/${headSha}/${kind}?per_page=100`

    const runPages = readPages(commitPath('check-runs'), '`gh api` over the check runs')
    if (runPages === null) checksReadable = false
    else {
      for (const page of runPages) {
        // Each page of this endpoint is an object with the runs inside it, not a bare array.
        if (!Array.isArray(page?.check_runs)) {
          noteFailure('`gh api` over the check runs returned a page with no check_runs array in it')
          checksReadable = false
          break
        }
        for (const run of page.check_runs) {
          entries.push({
            kind: 'check-run',
            name: nonEmpty(run?.name),
            url: nonEmpty(run?.details_url) ?? nonEmpty(run?.html_url) ?? null,
            status: run?.status ?? null,
            conclusion: run?.conclusion ?? null,
          })
        }
      }
    }

    const statusPages = readPages(commitPath('statuses'), '`gh api` over the commit statuses')
    if (statusPages === null) checksReadable = false
    else {
      // Newest first, so the first entry of a context is the one that counts and every later one
      // is a superseded run of the same check. A nameless status is kept as it comes: it is
      // unknown, and one unknown does not stand in for another.
      const seen = new Set()
      for (const page of statusPages) {
        if (!Array.isArray(page)) {
          noteFailure('`gh api` over the commit statuses returned a page that is not a list of statuses')
          checksReadable = false
          break
        }
        for (const status of page) {
          const context = nonEmpty(status?.context)
          if (context !== null) {
            if (seen.has(context)) continue
            seen.add(context)
          }
          entries.push({
            kind: 'status',
            name: context,
            url: nonEmpty(status?.target_url) ?? null,
            state: status?.state ?? null,
          })
        }
      }
    }
  }

  const reportedNames = new Set(entries.map((entry) => entry.name).filter((name) => name !== null))

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
    // Once per name, not once per entry: two failed check runs of one name are two jobs, and the
    // allowlist excuses the name they share.
    if (baseFlakes.bare.has(entry.name)) {
      if (!ci.flaky.includes(entry.name)) ci.flaky.push(entry.name)
      continue
    }
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
    // Failed entries grouped by name, not a set of the names. GitHub serves two CheckRuns of one
    // name against two jobs without complaint, and an acceptance is a statement about one job log.
    const failing = new Map()
    for (const entry of ci.failed) {
      if (!failing.has(entry.name)) failing.set(entry.name, [])
      failing.get(entry.name).push(entry)
    }
    const accepted = []
    const claimedBy = new Map()
    for (const value of acceptFlakes) {
      // The flag's value is split by the same rule as the file's lines, so a line copied out of
      // the allowlist is accepted in the spelling it was written in even when the check's own
      // name holds a colon. A value that is itself a reported check name is a bare name, whatever
      // colons it contains.
      const split = reportedNames.has(value) ? null : splitEntry(value, reportedNames)
      const entry = split === null ? undefined : declared.get(`${split.check}:${split.test}`)
      if (entry === undefined) {
        return refuse(split !== null
          ? `--accept-flake ${value} is not an entry of ${FLAKES_PATH} on ${baseRef}; the flag accepts only what ` +
            'the repository already declared flaky, in that exact check-name:test_name spelling'
          : `--accept-flake ${value} names no test. A bare check name on the allowlist moves its check on its own, ` +
            'so the flag takes a check-name:test_name entry and nothing else')
      }
      const failures = failing.get(entry.check) ?? []
      if (failures.length === 0) {
        return refuse(`--accept-flake ${value} names ${entry.check}, which is not among the failed checks of ` +
          `#${prNumber}; the flag accepts a failure and there is none to accept`)
      }
      if (failures.length > 1) {
        return refuse(`--accept-flake ${value} names ${entry.check}, and ${failures.length} failed checks of ` +
          `#${prNumber} report that name (${failures.map((f) => f.link ?? 'no job url').join(', ')}). One job log ` +
          `cannot show ${entry.test} was the only failure in all of them, so the acceptance is ambiguous and every ` +
          'one of them stays failed')
      }
      const earlier = claimedBy.get(entry.check)
      if (earlier !== undefined) {
        return refuse(`--accept-flake ${earlier} and --accept-flake ${value} both name ${entry.check}, and at most ` +
          'one test can have been the only failure in one check; pass the one the job log shows and nothing else')
      }
      claimedBy.set(entry.check, value)
      accepted.push({ ...entry, failure: failures[0] })
    }
    const moved = new Set()
    for (const { check, test, failure } of accepted) {
      acceptedChecks.add(check)
      moved.add(failure)
      // The url goes on the record so the land report can name the job whose log was read.
      ci.acceptedFlakes.push({ check, test, link: failure.link })
    }
    ci.failed = ci.failed.filter((entry) => !moved.has(entry))
    for (const check of acceptedChecks) if (!ci.flaky.includes(check)) ci.flaky.push(check)
  }

  if (checksReadable && entries.length === 0) {
    stop('ci-unknown', `#${prNumber} reported no checks at all, which is also how a pull request looks in the ` +
      'seconds after a push, before GitHub registers its check runs: no check runs and no commit statuses ' +
      `on ${headSha}`)
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
  // Every recovered candidate is a question, whether or not GitHub parsed a link of its own. The
  // rule this replaced asked only when `linked` was empty, so `Closes #6` beside a stray phrase
  // pointing at #17 closed both without anyone being asked which.
  const strays = linkedIssues.recovered.filter((n) => !linkedIssues.linked.includes(n))
  const noLink = linkedIssues.linked.length === 0
  if (strays.length > 0 || (noLink && linkedIssues.mentions.length > 0)) {
    const candidates = [...strays, ...(noLink ? linkedIssues.mentions : [])]
    attend('linked-issues-ambiguous', (noLink
      ? 'GitHub parsed no closing link'
      : `GitHub parsed ${linkedIssues.linked.map((n) => `#${n}`).join(', ')} and the text points at more`) +
      `; candidates are ${candidates.map((n) => `#${n}`).join(', ')}. ` +
      'Ask the human which to close, with an explicit close-none')
  }

  // Every page of the top-level comments, for the same reason as the checks: `gh pr view --json
  // comments` served the first 100 and paged nothing, so a draft filed after a long review was
  // never seen. The url kept is html_url, the one a human can open; `url` is the API's own.
  const findFollowUpDraft = (pages) => {
    for (const page of pages) {
      if (!Array.isArray(page)) {
        noteFailure('`gh api` over the top-level comments returned a page that is not a list of comments')
        return null
      }
      for (const comment of page) {
        if (typeof comment?.body === 'string' && FOLLOW_UP_DRAFT.test(comment.body)) {
          return {
            id: comment?.id ?? null,
            url: scrubUserinfo(comment?.html_url ?? comment?.url ?? '') || null,
            body: comment.body,
          }
        }
      }
    }
    return null
  }
  const commentPages = readPages(`repos/${identity.owner}/${identity.repo}/issues/${prNumber}/comments?per_page=100`,
    '`gh api` over the top-level comments')
  const followUpDraft = commentPages === null ? null : findFollowUpDraft(commentPages)
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
