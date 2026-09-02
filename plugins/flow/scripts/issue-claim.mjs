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
// from a rival's, so we stand down and the claim needs breaking by hand. Standing down is not the
// same as having left nothing, though, and the caller cannot work out which it was from a
// sentence of English. So every held and every unknown carries observed: pre-push when the hold
// or the failure was read before any push went out, post-push when a push was attempted and its
// outcome is ambiguous. Only a post-push result can have left a tag on the remote. The second is a
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
// the remote it was handed: `fatal: 'user@host' does not appear to be a git repository`. So every
// message from git goes through a redactor built from the URLs configured on origin, which swaps
// those exact strings for the safe identity before anything is printed. Not word for word,
// though, which is the part that took a second look. git rewrites a remote before it prints it,
// two ways. A failed push reports `error: failed to push some refs to 'github.com:jakub/demo.git'`
// for a remote configured as git@github.com:jakub/demo.git, dropping the userinfo. And handed
// user:ghp_token@github.com:jakub/demo.git it reads the first colon as the host separator, fails
// to reach a host called user, and prints the rest, token included, as the repository it could
// not find. So the redactor also holds the userinfo-stripped spelling of every configured URL,
// and scrubs an scp-like userinfo run wherever it appears, before the spellings are swapped.
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
// acquire; scan again while holding the tag; read the issue again while holding it; add the
// worktree at the object the acquire verified; push the branch; move the labels; confirm they
// moved; release.
//
// Everything up to the acquire is a read. A closed issue, a missing label, a title with no slug
// in it, a worktree path already on disk: all of them are decided before anything is written, so
// a refusal there has changed nothing anywhere.
//
// That read is stale the moment it is taken, which is why the issue is read twice more. Once
// while the tag is held and before the worktree is added, because a human can close the issue,
// pull the ready label or add a blocker in the seconds since the first read, and this is the last
// point at which standing down costs one tag and nothing else. Once after the labels move,
// because gh exiting 0 says the request was accepted rather than that the issue now reads the way
// the next run needs it to; that one cannot be undone, so a disagreement there is an unknown that
// keeps the branch and the tag.
//
// Three things the claim asks of the outside world are pinned rather than trusted. Every gh call
// names the repository origin's URL parsed to, because gh otherwise picks a default out of
// remote.<name>.gh-resolved or, in a clone with several GitHub remotes, out of a preference over
// remote names in which upstream beats origin: on a fork clone that reads and labels one
// repository while the tag and the branch land on another. An origin with no host to name, a bare
// repository at a filesystem path, cannot be pinned at all and is refused rather than handed to
// gh to resolve. The pull request scan is `gh api --paginate --slurp` over
// repos/<owner>/<repo>/pulls rather than `gh pr list --limit 100`, because a fork's head branch
// lives in the fork and no ref under refs/heads/* on origin advertises it, so the branch scan does
// not cover the same run, and because a hundredth open pull request is a bound nobody chose;
// --slurp is what makes the pages one JSON document instead of one array printed per page. And
// the boundary a worktree has to stay inside is
// compared as real paths: /safe/repo/.git can be a symlink to /outside/repo.git, git answers
// `.git` when asked for the common directory, and the lexical comparison that used to sit here
// read a path under the parent while every write through it landed outside.
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
// What a refusal has to be worth, since the stage reads this JSON line and never the stderr. It
// has to mean one thing: nothing this run made is left anywhere. The first version could not
// promise that, because it returned refused whatever the cleanup did, so `abandon: "unknown"`
// could sit beside `reason: "live-run"` with the tag still on origin and the stage would read a
// clean stand-down. Every result but a win now carries two more fields. `phase` says how far the
// run got: pre-acquire, nothing was written; acquired, the claim tag may be on origin; published,
// the branch reached origin, which is the marker every other run scans for. `retained` lists what
// may still exist, drawn from claim-tag, worktree, local-branch and remote-branch, and an
// artifact only leaves that list when this run read it back as positively gone or kept it on
// purpose. The rule is then mechanical: refused when retained is empty, and otherwise an unknown
// that keeps its original reason and names under `cleanup` the step that would not confirm. phase
// also separates the two scans, which used to share their reason codes with nothing to tell them
// apart: live-run before the acquire mutated nothing, live-run after it may have left the tag.
//
// The acquire is the one step whose phase claim cannot work out for itself, which is what the
// observed field above is for. A hold acquire read before pushing is a rival's tag and this run
// is clean: held, pre-acquire, nothing retained. A hold it read after its own push might be its
// own tag, so calling that a clean stand-down would say nothing is left while a tag of ours sits
// on origin blocking every later claim on the issue; it comes back as an unknown at phase
// acquired, retaining the tag, under its own reason acquire-ambiguous rather than a shared one.
// The unknowns split the same way and used to not: the read of main failing, the preflight tag
// read failing and the catch-up fetch failing all happen before any push, and reporting those as
// a tag that may exist sent an issue to manual recovery over a remote that was briefly down.
//
// A non-zero push is not proof that nothing was published. receive-pack can update the ref and
// the client can still exit non-zero, on a dropped connection or a hook that fails after the
// update, so the push-failure path re-reads refs/heads/<branch> on origin before it undoes
// anything. At the head this run pushed, the branch was published and only the answer was lost:
// the tag, the worktree and the branch all stay and the result is an unknown at phase published.
// Absent, nothing reached origin and the ordinary unwind runs. Unreadable is an unknown too, with
// everything kept, because deleting a branch that might be on origin is how the marker that keeps
// the next run out disappears.
//
// The local branch scan and the guarded branch delete are one defect seen from two sides. A
// worktree add can exit non-zero after creating both the directory and the branch, which is what
// a failing post-checkout hook does on git 2.55, and the cleanup used to take the worktree out
// and leave the branch. Every retry then met `a branch named ... already exists` forever, and no
// scan anywhere looked at local branches. So the unwind deletes the branch while it still points
// at the base this run cut it at, and only when this run is the one that created it, and the scan
// reads this clone's branches for the issue as well: a stale one is either a live run in this
// clone or the wreckage of a dead one, and both are a human's call rather than something to write
// over. That delete is a compare-and-delete, `git update-ref -d <ref> <base>`, so git itself
// refuses it if the branch moved; reading the head and then running `git branch -D` left a window
// between the two commands, and what falls into it is a rival's work.
//
// The worktree has no equivalent lease and is not getting one. Between the path check and the
// `git worktree add`, a foreign process could in principle create a directory at exactly the
// derived path, and the unwind after a failed add would then remove it as this run's; the claim
// tag serializes flow's own runs and the path is derived from the issue number, so the only way
// to reach that is a process outside flow choosing this path, which is out of scope here.
//
// Every remote interaction is an argv array, never a shell string, so there is no quoting to
// get wrong. stdout is always exactly one JSON object, one line, including for refusals; the
// only exception is --help. stderr carries a sentence for a human whenever the result is not a
// win. Exit codes: 0 acquired, released, abandoned or claimed, 2 usage or refusal, 3 held by
// someone else, 4 unknown.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Only the allowlist, not the parse. The comment at remoteSlug says why this file parses an
// origin of its own; which hosts flow may hand a credential to is one list all the same, and a
// second copy of it is a second thing to keep in step.
import { allowedHostsFrom, hostIsAllowed, isHostname, isScpUser } from '../lib/remote-identity.mjs'

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
const IN_PROGRESS_LABEL = 'in-progress'
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
label; digests the "${AC_HEADING}" section; scans this clone's worktrees and branches, origin's
branches for the issue and open pull requests for a run already live; acquires the tag; scans
again while holding it; adds a worktree at the object the acquire verified, on branch
<kind>/issue-<N>-<slug>; pushes it; assigns the issue and moves ${READY_LABEL} to in-progress;
and releases the tag. The kind comes from --kind, or from a bug or documentation label, or is
feat. Exits 0 claimed, 2 refused, 3 held, 4 unknown, and prints one JSON line either way.

Every claim result but a win carries phase and retained, because the caller reads the JSON and
not the stderr. phase is pre-acquire (nothing was written), acquired (the claim tag may be on
origin) or published (the branch reached origin). retained lists what may still exist, from
claim-tag, worktree, local-branch and remote-branch, and it is empty only when this run read
every one of them back as gone. So a result is refused only when retained is empty: anything
left standing is an unknown that keeps its reason and names the cleanup step that would not
confirm under cleanup. A live-run result puts what the scan saw under found, grouped as
worktrees, localBranches, remoteBranches and pullRequests.

A claim refusal names one of: usage, no-origin, push-fetch-mismatch, origin-unparseable,
origin-host-not-allowed,
issue-closed, not-ready, blocked, no-acceptance-criteria, bad-slug, live-run, worktree-path,
outside-parent, acquire-refused, worktree-add, push. An unknown names one of those, or one of:
issue-unreadable, repo-unreadable, scan-unreadable, acquire-unknown, acquire-ambiguous,
acquire-not-created, issue-edit, issue-edit-unconfirmed, release. Everything before the
acquire is a read, so a refusal there changed nothing; after it, a failure before the branch
reaches origin gives the tag back when the remote lets it, and a failure after it leaves the
branch and the tag standing for a human to finish or unwind.

The issue is read three times: before the acquire, again while the tag is held, and once more
after the labels move. The second read is what stops a run relabelling an issue a human closed
or blocked in between. The third has to find the issue open, carrying in-progress, without
ready-for-agent, without any blocking label, and assigned to the login gh reports for @me, which
it reads once; anything else is issue-edit-unconfirmed and keeps the branch and the tag. Every gh
call names the repository origin's URL parsed to, so a fork clone cannot read and label one
repository while the tag and the branch land on another, and an origin with no host to name is
refused rather than left for gh to resolve.

That host has to be github.com, or one named in FLOW_GH_HOSTS in this program's own environment,
as a comma-separated list of hostnames. gh sends the credential it holds for a host to whichever
host it is pinned to, and the pin comes from .git/config, a file this repository can rewrite, so
the list of hosts worth a token is read from the environment and never from the repository. An
origin that names a port is refused for a related reason: gh's --hostname and --repo take a bare
host, so the issue would be read and labelled on one endpoint while the tag and the branch went
to another. The three git-only verbs take neither check, because they never call gh.

held means the tag was on origin before this run pushed anything, so it is a rival's and this run
left nothing. A tag that turned up only after this run's own push is a different answer, because
it might be this run's own tag from a push whose response was lost: that is acquire-ambiguous, an
unknown at phase acquired retaining claim-tag, and it needs a human to read the tag before the
issue can be claimed again. acquire-unknown splits on the same fact, at phase pre-acquire when
the acquire failed before pushing and at phase acquired when it failed after. A push that failed
with no tag on the remote afterwards proves the tag was not created, and no more than that:
origin refusing it, a hook in this clone refusing it and a transport that dropped it read the
same from here. That is acquire-not-created, at phase pre-acquire with nothing retained.

acquire takes the claim on an issue by creating refs/tags/flow-claim-issue-<N> on origin, at
the head of refs/heads/main. Creating a ref is atomic on the remote, so exactly one racer wins.
Exits 0 when it created the tag, 3 when someone already holds it, 4 when the outcome could not
be established, 2 on a usage error or a refusal. A held or unknown result also carries observed:
pre-push when the hold or the failure was read before any push went out, post-push when a push
was attempted and its outcome is ambiguous, and absent when a push was attempted and the re-read
positively found no tag, which is what a remote refusing tag creation looks like. Only post-push
can have left a tag behind.

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
const scrubUserinfo = (text) => String(text || '').replace(USERINFO, '$1').replace(SCP_USERINFO, '')

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
 */
const makeRedactor = (rawUrls, identity) => {
  // Longest first, so a stripped spelling cannot take the tail of a longer one and leave its head
  // standing in the output.
  const spellings = [...new Set(rawUrls.flatMap(remoteSpellings))]
    .filter((spelling) => spelling !== '')
    .sort((a, b) => b.length - a.length)
  return (text) => {
    let out = scrubUserinfo(text)
    for (const spelling of spellings) out = out.split(spelling).join(identity)
    return out
  }
}

const firstLine = (text) => String(text || '').trim().split('\n')[0].slice(0, 200)

/**
 * The line where git said what went wrong. Taking the first line is wrong for anything that
 * reports progress on stderr: a failed `git worktree add` opens with
 * `Preparing worktree (new branch 'feat/issue-7-x')` and the `fatal: a branch named ... already
 * exists` arrives two lines later, so a refusal built from the first line names nothing at all.
 * Prefer the line git marked as the failure, and fall back to the last thing it said rather than
 * the first, because progress lines come first and complaints come last.
 */
const gitComplaint = (text) => {
  const lines = String(text || '').split('\n').map((raw) => raw.trim()).filter((raw) => raw !== '')
  const named = lines.find((raw) => raw.startsWith('fatal:') || raw.startsWith('error:'))
  return (named ?? lines[lines.length - 1] ?? '').slice(0, 200)
}

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
 * the land executors, an unparseable remote is not fatal here: acquire, release and abandon are
 * git alone and work on any remote git can push to, so for them the identity is for the reader
 * and the log and a bare repository on disk is a legitimate origin. Only the claim, which calls
 * gh, needs a remote it can pin an API call to, and it refuses on its own. What is fatal is
 * passing the raw URL through, so every branch below ends at a host and path, a bare local path,
 * or a fixed placeholder. Nothing returns the input.
 *
 * Not ../lib/remote-identity.mjs, which land-gates and land-merge share: that one answers a
 * refusal where this answers a string, so it cannot serve a verb that goes on working against
 * the remote it could not name. https://host/owner/repo.git?redirect=1 and a bare repository at
 * a filesystem path are both refusals there and both still acquire here. Handing a scheme to a
 * real URL parser is the part both do the same way, and it is what drops the userinfo, the query
 * and the fragment by construction rather than by a character class.
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
      if (!isHostname(url.hostname)) return 'unparseable-origin'
      const repo = path.replace(/\.git$/, '')
      return repo === '' ? url.hostname : `${url.hostname}/${repo}`
    } catch { return 'unparseable-origin' }
  }

  // scp-like, with or without a user in front: [user@]host:path. There is no scheme here for a
  // URL parser to drop a query or a fragment by construction, and everything after the colon is
  // otherwise taken whole, so git@github.com:owner/repo.git?access_token=sekret would print the
  // token. A remote that names a repository carries neither, so both are unparseable rather than
  // something to strip and go on using.
  const scp = raw.match(/^(?:([^@\s]+)@)?([^@:/\s]+):(.+)$/)
  if (scp !== null) {
    // The host first. This function exists to print, and the scp-like form ends its host at the
    // colon that opens the path, so a ? or a # in front of that colon is part of the host as far
    // as the regex is concerned and would be printed with it.
    if (!isHostname(scp[2])) return 'unparseable-origin'
    // The user is not checked here, unlike remoteSlug and the shared parse. Nothing prints it, and
    // this function has to keep describing a remote that carries a credential: git is handed
    // user:ghp_sekrettoken@github.com:jakub/demo.git often enough, and the useful answer for the
    // log is github.com/jakub/demo rather than a refusal to say anything at all.
    if (scp[3].includes('?') || scp[3].includes('#')) return 'unparseable-origin'
    return `${scp[2]}/${scp[3].replace(/^\/+/, '').replace(/\.git$/, '')}`
  }

  // A local filesystem path: no scheme, no scp colon, and no userinfo to strip.
  if (!raw.includes('@')) return raw
  return 'unparseable-origin'
}

/**
 * The owner and repository at the end of a path, and nothing else from it. `exact` is for a
 * scheme URL and an scp-like remote, where anything but two segments is a remote this cannot
 * name a repository from; a local filesystem path is allowed the directories above it.
 */
const slugFromPath = (path, exact) => {
  const parts = String(path).split('/').filter((part) => part !== '')
  if (exact ? parts.length !== 2 : parts.length < 2) return null
  const owner = parts[parts.length - 2]
  const repo = parts[parts.length - 1].replace(/\.git$/, '')
  return repo === '' ? null : { owner, repo }
}

/**
 * The host, owner and repository the origin URL names, or a typed problem the caller refuses on.
 * This is the parse ../lib/remote-identity.mjs performs for the land executors, for the same
 * reason: left to itself gh resolves a default repository from remote.<name>.gh-resolved or, in a
 * clone with several GitHub remotes, from a preference over remote names where upstream beats
 * origin. On a fork clone that default is the upstream, and an unpinned call reads and labels the
 * wrong issue. It is not that module, because a hostless origin has to come back parsed here,
 * with an empty host and the owner and repository read off the path: the claim turns that into a
 * refusal naming the missing host, and the three git-only verbs act on it. The shared parse
 * refuses a hostless remote as unreadable, which is the right answer for a land and the wrong one
 * for an acquire.
 *
 * A scheme URL goes through new URL() and the owner and repository come from its pathname alone,
 * so a query string or a fragment is refused outright rather than carried into an API path. The
 * scp-like form has no scheme for new URL() to work with and is still how most people spell a
 * GitHub remote, so it keeps a regular expression over the part after the colon, and refuses a
 * query or a fragment there by hand: nothing drops them for it, and
 * git@github.com:owner/repo.git?access_token=sekret otherwise names a repository called
 * `repo.git?access_token=sekret` that goes on to be a --repo argument and a journalled field.
 * A port is refused in both spellings. gh takes a bare host in --hostname and in
 * --repo host/owner/repo, so an origin of https://github.com:8443/owner/repo would have the tag
 * and the branch pushed to 8443 while the issue was read and labelled on 443. new URL() drops a
 * port that is the scheme's default, so https://host:443/owner/repo is not refused, which is
 * right: gh reaches exactly that endpoint. The scp-like form has no port syntax at all, so
 * git@host:2222/owner/repo.git is a port written where git reads a path, and it is recognised as
 * one only when the rest of the path names exactly one owner and one repository, which leaves an
 * owner made entirely of digits parsing as an owner.
 *
 * A local filesystem path has no host, and the last two components stand in for the owner and the
 * repository. The claim refuses that shape rather than call gh unpinned, but the identity is
 * still worth reading, because acquire, release and abandon are git alone and work there.
 *
 * No branch returns any part of the input, because the problem string is printed.
 */
// The one problem string that is about the port. It reads on from "the origin remote of this
// directory", the way every other problem here does.
const PORT_PROBLEM = 'names a port, and the --hostname and --repo pins gh takes carry a bare host, ' +
  'so gh would reach the default port of that name while git talks to the one configured'

const remoteSlug = (remote) => {
  const raw = String(remote ?? '').trim()
  if (raw === '') return { problem: 'is empty' }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url = null
    try { url = new URL(raw) } catch { return { problem: 'does not read as a URL' } }
    if (url.search !== '' || url.hash !== '') {
      return { problem: 'carries a query string or a fragment, and an API path must never be built out of one' }
    }
    if (url.port !== '') return { problem: PORT_PROBLEM }
    if (url.hostname !== '' && !isHostname(url.hostname)) return { problem: 'does not read as a URL' }
    // file:///srv/repo.git and friends: no host, so what is left is a filesystem path.
    const named = slugFromPath(url.pathname, url.hostname !== '')
    if (named === null) return { problem: 'does not name exactly one owner and one repository' }
    return { host: url.hostname, ...named }
  }

  // scp-like, with or without a user in front: [user@]host:owner/repo.
  const scp = raw.match(/^(?:([^@\s]+)@)?([^@:/\s]+):(.+)$/)
  if (scp !== null) {
    // The host is checked before anything else reads it, because the caller's refusal names it.
    // Ending the host at the path colon and nowhere else meant a # or a ? in front of that colon
    // counted as part of the host, and git@github.com#sekret:owner/repo.git put that word into a
    // refusal and into the journal. A host that is not a hostname is an unreadable remote instead.
    if (!isHostname(scp[2])) return { problem: 'does not read as a URL' }
    if (scp[1] !== undefined && !isScpUser(scp[1])) return { problem: 'does not read as a URL' }
    if (scp[3].includes('?') || scp[3].includes('#')) {
      return { problem: 'carries a query string or a fragment, and an API path must never be built out of one' }
    }
    const ported = scp[3].match(/^\d+\/(.+)$/)
    if (ported !== null && slugFromPath(ported[1], true) !== null) return { problem: PORT_PROBLEM }
    const named = slugFromPath(scp[3], true)
    if (named === null) return { problem: 'does not name exactly one owner and one repository' }
    return { host: scp[2], ...named }
  }

  if (raw.includes('@')) return { problem: 'does not read as a URL' }
  const named = slugFromPath(raw, false)
  if (named === null) return { problem: 'names no directory inside another one, so there is no owner and repository to read out of it' }
  return { host: '', ...named }
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
  // The raw URL stops here. What leaves is the safe identity, a redactor built from the raw URLs,
  // and the host, owner and repository parsed out of one, so no caller downstream holds a string
  // that could carry a credential into its output.
  return {
    identity,
    redact: makeRedactor([...fetchUrls, ...pushUrls], identity),
    slug: remoteSlug(fetchUrls[0]),
  }
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
  return { repo: resolved.identity, redact: resolved.redact, slug: resolved.slug }
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
  // observed says whether this run had pushed anything when it learned what it is reporting, and
  // whether a tag of its own can be on the remote. pre-push: the hold or the failure was read
  // before any push was attempted. post-push: a push went out and its outcome is ambiguous, so a
  // tag might be there. absent: a push went out, failed, and the re-read positively found no tag,
  // which is what a remote that refuses tag creation looks like. The caller cannot recover any of
  // that from the detail string, and it decides whether a stand-down is clean.
  const held = (sha, observed, detail) => line({ ...base, result: 'held', sha, observed, detail }, EXIT_HELD,
    `issue #${issue} is already claimed on ${repo} (${ref} at ${sha.slice(0, 12)}). ${detail}. Leave it alone; the run that holds it releases it, or a human breaks the tag.`)
  const unknown = (observed, detail) => line({ ...base, result: 'unknown', observed, detail }, EXIT_UNKNOWN,
    `could not establish whether issue #${issue} is claimed on ${repo}. ${detail}. Do not start work on the strength of this; find out what the remote actually holds.`)

  // The object the claim hangs on. Every racer resolves the same head of main, which is exactly
  // why the "up to date" case below exists and has to be read as a loss.
  const mainRead = runGit(['ls-remote', 'origin', MAIN_REF], cwd, REMOTE_GIT_TIMEOUT_MS)
  if (mainRead.code !== 0) {
    // The remote could not be read at all. Operationally unknown, not a lost race: nothing has
    // been learned about the tag, and nothing has been pushed.
    return unknown('pre-push', `\`git ls-remote origin ${MAIN_REF}\` failed: ${firstLine(redact(mainRead.stderr)) || `exit ${mainRead.code}`}`)
  }
  const mainSha = shaOfRef(mainRead.stdout, MAIN_REF)
  if (mainSha === null) {
    const detail = `origin on ${repo} advertises no ${MAIN_REF}, so there is no object to hang a claim on`
    return line({ ...base, result: 'refused', reason: 'no-main-branch', detail }, EXIT_REFUSED, detail)
  }

  // Preflight. Cheap, and it keeps the common "someone claimed this an hour ago" case from
  // touching the remote's refs at all. It is not the lock: the lock is the push.
  const before = readRef(cwd, ref, redact)
  if (before.state === 'present') return held(before.sha, 'pre-push', 'the tag was already there before this run pushed anything')
  if (before.state === 'unknown') return unknown('pre-push', before.detail)

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
      return unknown('pre-push', `\`git fetch origin ${MAIN_REF}\` failed, so this clone does not hold the object a claim would ` +
        `hang on: ${firstLine(redact(fetch.stderr)) || `exit ${fetch.code}`}`)
    }
    const resolved = runGit(['rev-parse', '--verify', '--quiet', `${tempRef}^{commit}`], cwd, LOCAL_GIT_TIMEOUT_MS)
    const got = resolved.code === 0 ? resolved.stdout.trim() : ''
    if (!SHA.test(got)) {
      dropTempRef()
      return unknown('pre-push', `${MAIN_REF} was fetched but did not resolve to a commit locally, so there is no object to hang a claim on`)
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
    if (after.state === 'present') return held(after.sha, 'post-push', why)
    if (after.state === 'absent') {
      // The remote positively does not hold the tag. That proves the tag was not created and
      // nothing more: a pre-receive hook refusing anything under refs/tags/ is the ordinary
      // cause, a pre-push hook in this clone and a transport that dropped the push look the same
      // from here. Reporting it as post-push had the caller retain a claim tag this run had just
      // proved absent and send a human hunting it.
      return unknown('absent', `${why}, and ${ref} is not on the remote either, so the tag was not created. ` +
        `git said: ${gitComplaint(redact(push.stderr)) || '(nothing)'}`)
    }
    return unknown('post-push', `${why}, and the re-read could not settle it: ${after.detail}`)
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

/** The bare assignee logins on an issue read, whatever shape gh handed back. */
const assigneeLogins = (assignees) => (Array.isArray(assignees) ? assignees : [])
  .map((who) => (typeof who === 'string' ? who : String(who?.login ?? '')))
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
 * Returns null when the heading is absent, and when nothing but blank lines sits under it.
 */
const acceptanceCriteria = (body) => {
  const text = String(body ?? '')
  // A heading with nothing under it is not a section. `## Acceptance Criteria` as the last line
  // of a body, or with the next `## ` heading directly beneath it, leaves a run nothing to be
  // judged against, so it reads the same as a heading that was never written.
  const withContent = (section) =>
    section.split('\n').slice(1).some((raw) => raw.trim() !== '') ? section : null
  let offset = 0
  let start = -1
  for (const raw of text.split('\n')) {
    const bare = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (start < 0) {
      if (bare === AC_HEADING) start = offset
    } else if (bare.startsWith('## ')) {
      return withContent(text.slice(start, offset))
    }
    offset += raw.length + 1
  }
  return start < 0 ? null : withContent(text.slice(start))
}

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

/**
 * A branch-safe slug from an issue title. Everything outside [a-z0-9] becomes a hyphen, runs
 * collapse, and the ends are trimmed. The cut back to a hyphen boundary keeps the last word whole
 * instead of ending a branch mid-syllable; a first word longer than the limit has no boundary to
 * cut at and gets truncated where it falls.
 *
 * A title with nothing in [a-z0-9] collapses to the empty string, and the claim used to refuse it
 * as bad-slug: an issue titled 修复登录 could never be claimed at all, which is a rule about the
 * language a title is written in and not about anything a branch name needs. A branch name has to
 * be deterministic, so that two runs on one issue build the same one and each can see the other's
 * work, and safe in a ref. t-<first 12 hex of the sha256 of the title> is both, and it sits inside
 * the (feat|fix|chore)/issue-N- shape the release verb matches on. Twelve hex is 48 bits, which is
 * plenty for telling apart the titles of one repository's issues, and the issue number in front of
 * it is what actually identifies the branch.
 *
 * A title that is empty once trimmed has nothing to hash and nothing to read, so it still comes
 * back empty and the caller still refuses.
 */
const slugify = (title) => {
  const text = String(title ?? '').trim()
  const flat = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (flat === '') return text === '' ? '' : `t-${sha256(text).slice(0, 12)}`
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

/**
 * Whether a path is still a worktree of this clone, read back rather than inferred from the exit
 * code of the remove that was supposed to take it away. `absent` is the only answer that lets a
 * caller drop the worktree from its retained list, so a list that will not read is `unknown` and
 * the path stays on the list.
 */
const worktreeState = (cwd, path) => {
  if (existsSync(path)) return 'present'
  const listed = runGit(['worktree', 'list', '--porcelain'], cwd, LOCAL_GIT_TIMEOUT_MS)
  if (listed.code !== 0) return 'unknown'
  return parseWorktrees(listed.stdout).some((entry) => entry.path === path) ? 'present' : 'absent'
}

/**
 * The object a local branch points at, as one of present, absent or unknown. This asks
 * for-each-ref rather than `rev-parse --verify`, because rev-parse answers in its exit code and
 * that code is not one this program can read: 1 is both "no such ref" and, through runGit, a
 * child that was killed on its timeout. for-each-ref exits 0 either way and says what it found in
 * its output, so absent is a ref list that came back and did not have the branch in it. That
 * matters because absent is the answer that lets a caller call a cleanup done.
 *
 * The refname is compared rather than assumed, since a for-each-ref pattern also matches a ref
 * whose name continues after a slash: refs/heads/feat/issue-7-x matches refs/heads/feat/issue-7-x/2.
 */
const localBranchHead = (cwd, branch) => {
  const ref = `refs/heads/${branch}`
  const read = runGit(['for-each-ref', '--format=%(objectname)\t%(refname)', ref], cwd, LOCAL_GIT_TIMEOUT_MS)
  if (read.code !== 0) return { state: 'unknown' }
  const sha = shaOfRef(read.stdout, ref)
  return sha === null ? { state: 'absent' } : { state: 'present', sha }
}

/** One sentence naming what a scan turned up, in the order it found it. */
const describeHits = (hits) => hits.map((hit) => {
  if (hit.where === 'worktree') return `a worktree at ${hit.path}${hit.branch ? ` on ${hit.branch}` : ''}`
  if (hit.where === 'local-branch') return `${hit.ref} in this clone at ${String(hit.sha).slice(0, 12)}`
  if (hit.where === 'remote-branch') return `${hit.ref} on origin at ${String(hit.sha).slice(0, 12)}`
  return `pull request #${hit.number} from ${hit.headRefName}`
}).join('; ')

/**
 * The same hits grouped by where they were found, which is the shape the caller reads. A stale
 * local branch and a rival's pull request both mean stop, but they are different problems and one
 * of them the caller can clear itself, so the JSON keeps them apart.
 */
const groupHits = (hits) => ({
  worktrees: hits.filter((hit) => hit.where === 'worktree'),
  localBranches: hits.filter((hit) => hit.where === 'local-branch'),
  remoteBranches: hits.filter((hit) => hit.where === 'remote-branch'),
  pullRequests: hits.filter((hit) => hit.where === 'pull-request'),
})

const claim = ({ argv, cwd, env, runGh }) => {
  const usage = (detail) => line({ command: 'claim', result: 'refused', reason: 'usage', phase: 'pre-acquire', retained: [], cleanup: null, detail },
    EXIT_REFUSED, `${detail}.\n\n${USAGE}`)

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
  // resolveOrigin is shared with the three older subcommands, so the claim shape rides in as
  // facts rather than being bolted onto a refusal every caller has to know about.
  const origin = resolveOrigin('claim', cwd, { issue, tag, ref, phase: 'pre-acquire', retained: [], cleanup: null })
  if (origin.refusal) return origin.refusal
  const repo = origin.repo
  const redact = origin.redact
  const base = { command: 'claim', repo, issue, tag, ref }

  /** What a retained artifact is, named where a human has to go and look for it. */
  const whereItIs = {
    'claim-tag': () => `${ref} on ${repo}`,
    worktree: () => worktree,
    'local-branch': () => `${branch} in this clone`,
    'remote-branch': () => `${branch} on ${repo}`,
  }
  const leftovers = (retained) => retained.length === 0
    ? 'Nothing of this run is left anywhere.'
    : `This run may have left ${retained.map((what) => `${what} (${whereItIs[what]()})`).join(', ')} behind; settle that by hand before running this again.`

  /**
   * One shape for every result but a win. The caller reads this line and not the stderr, so
   * "refused" has to mean nothing of this run is left anywhere: a non-empty retained list turns a
   * refusal into an unknown, keeping the reason that was true and adding the cleanup that was
   * not. `want` is therefore what the run would have said had the cleanup gone through.
   */
  const settle = (want, reason, detail, { phase, retained = [], cleanup = null, extra = {}, human = null }) => {
    const result = retained.length === 0 ? want : 'unknown'
    return line({ ...base, ...extra, result, reason, phase, retained, cleanup, detail },
      result === 'refused' ? EXIT_REFUSED : EXIT_UNKNOWN,
      human ?? `${detail}. ${leftovers(retained)}`)
  }
  // The two pre-acquire shapes. Everything above the acquire is a read, so there is nothing to
  // leave behind and the phase is fixed. Every call site below the acquire uses settle directly
  // and has to name its own phase.
  const refuse = (reason, detail, extra = {}, human = null) =>
    settle('refused', reason, detail, { phase: 'pre-acquire', extra, human: human ?? `${detail}. Nothing was claimed and nothing was changed.` })
  const unknown = (reason, detail, extra = {}, human = null) =>
    settle('unknown', reason, detail, { phase: 'pre-acquire', extra, human: human ?? `${detail}. Find out what the remote actually holds before running this again.` })
  const failureOf = (what, run) => `${what} failed: ${firstLine(redact(run.stderr)) || `exit ${run.code}`}`

  // gh picks a default repository of its own whenever a command does not name one, out of
  // remote.<name>.gh-resolved or, in a clone with several GitHub remotes, out of a preference
  // over remote names where upstream beats origin. Deleting GH_REPO and GH_HOST from the child
  // environment does not close that route. On a fork clone an unpinned call would then read and
  // label the upstream issue while this run's tag and branch land on origin, so every gh call
  // below names the repository origin's URL parsed to. `gh api` takes no --repo, so its pin is
  // the owner and repository inside the endpoint path together with --hostname.
  //
  // An origin with no host, a bare repository at a filesystem path, has nothing to pin to, and
  // running the gh calls unpinned there is worse than not running them. The tag and the branch go
  // to the path, while gh resolves a GitHub repository of its own and the issue edit lands in it:
  // one claim, two repositories, and nothing in the result says so. The stripped environment does
  // not close that, because gh-resolved and the remote-name preference are read from the clone.
  // So a hostless origin is refused here, before the first gh call. acquire, release and abandon
  // are git alone and still work against one.
  const ghRepo = origin.slug
  if (ghRepo.problem) {
    return refuse('origin-unparseable',
      `the origin remote of this directory ${ghRepo.problem}, so no gh call here can be pinned to the repository this run's tag and branch would land on`)
  }
  if (ghRepo.host === '') {
    return refuse('origin-unparseable',
      'the origin remote of this directory names no host, so gh cannot be pinned to it and would resolve a repository of its own: ' +
      'the claim tag and the branch would land on this origin while the issue edit went somewhere else')
  }
  // Which hosts are worth a credential is read from this program's environment and never from
  // the repository: .git/config is a file a branch can rewrite, and gh hands whatever token it
  // holds for a host to whichever host it is pinned to.
  if (!hostIsAllowed(ghRepo.host, allowedHostsFrom(env))) {
    return refuse('origin-host-not-allowed',
      `the origin remote of this directory names the host ${JSON.stringify(ghRepo.host)}, which is not one flow may hand to gh: ` +
      'gh sends the credential it holds for a host to whichever host it is pinned to, and that pin would come from this ' +
      "repository's own config. Set FLOW_GH_HOSTS in the environment to a comma-separated list of hostnames to widen it")
  }
  const repoPin = ['--repo', `${ghRepo.host}/${ghRepo.owner}/${ghRepo.repo}`]
  const hostPin = ['--hostname', ghRepo.host]

  /** The issue as gh hands it back, or the sentence saying why it could not be read. */
  const readIssue = () => {
    const view = runGh(['issue', 'view', String(issue), ...repoPin, '--json', 'number,title,state,labels,assignees,body,url'], { cwd })
    if (view.code !== 0) return { problem: failureOf(`\`gh issue view ${issue}\``, view) }
    const parsed = parseJson(view.stdout)
    if (parsed === null) return { problem: `\`gh issue view ${issue}\` printed something this could not read as a JSON object` }
    return { issue: parsed, state: String(parsed.state ?? '').toUpperCase(), labels: labelNames(parsed.labels) }
  }

  /**
   * The three conditions a claim needs of an issue, in the order the stage states them. They run
   * twice on every claim: once before anything is written, and once while the tag is held, since
   * a human can close the issue, pull the ready label or add a blocker in the seconds in between
   * and the second read is the last point at which standing down costs nothing but the tag.
   */
  const readiness = (read) => {
    if (read.state !== 'OPEN') {
      return { reason: 'issue-closed', detail: `issue #${issue} on ${repo} is ${read.state || 'in no state this could read'}, and a claim is only taken on an open issue` }
    }
    if (!read.labels.includes(READY_LABEL)) {
      return { reason: 'not-ready', detail: `issue #${issue} does not carry ${READY_LABEL}, so nobody has validated the spec this run would work from` }
    }
    const blocking = BLOCKING_LABELS.filter((label) => read.labels.includes(label))
    if (blocking.length > 0) {
      return {
        reason: 'blocked',
        detail: `issue #${issue} carries ${blocking.join(', ')} beside ${READY_LABEL}, so the ready label is stale and only a human clears the blocker`,
        extra: { blocking },
      }
    }
    return null
  }

  // ---- the issue itself. Three refusals, in the order the stage states them.
  const firstRead = readIssue()
  if (firstRead.problem) return unknown('issue-unreadable', firstRead.problem)
  const found = firstRead.issue
  const labels = firstRead.labels
  const wrong = readiness(firstRead)
  if (wrong !== null) return refuse(wrong.reason, wrong.detail, wrong.extra ?? {})

  const section = acceptanceCriteria(found.body)
  if (section === null) {
    return refuse('no-acceptance-criteria',
      `issue #${issue} has no line that is exactly "${AC_HEADING}" with anything written under it, so there is nothing to judge the run against`)
  }
  const acDigest = sha256(section)

  // ---- the names. Everything but --kind is derived, so two runs on one issue build the same
  // branch and the same path and the scans below can recognise each other's work.
  const kind = kindArg ?? kindFromLabels(labels)
  const slug = slugify(found.title)
  if (slug === '') {
    return refuse('bad-slug', `the title of issue #${issue} is empty, so there is nothing to name a branch after`)
  }
  const branch = `${kind}/issue-${issue}-${slug}`
  const topRead = runGit(['rev-parse', '--show-toplevel'], cwd, LOCAL_GIT_TIMEOUT_MS)
  const repoRoot = topRead.code === 0 ? topRead.stdout.trim() : ''
  if (repoRoot === '') {
    return unknown('repo-unreadable', `\`git rev-parse --show-toplevel\` gave no repository root for this directory: ${firstLine(redact(topRead.stderr)) || `exit ${topRead.code}`}`)
  }
  // The boundary a worktree has to stay inside, canonicalized before anything is compared against
  // it. A lexical resolve is not a boundary: /safe/repo/.git can be a symlink to
  // /outside/repo.git, `git rev-parse --git-common-dir` answers `.git`, and that resolves to a
  // path under the parent while every write through it lands outside. realpathSync is what makes
  // the two strings comparable, and a path that will not resolve is refused rather than compared.
  const canonical = (path) => { try { return realpathSync(path) } catch { return '' } }
  const canonicalRoot = canonical(repoRoot)
  const parent = canonicalRoot === '' ? '' : canonical(dirname(canonicalRoot))
  if (parent === '') {
    return refuse('outside-parent',
      'the real path of this repository, or of the directory above it, could not be resolved, so there is no boundary to keep a worktree inside')
  }
  const worktree = join(parent, `${basename(canonicalRoot)}-issue-${issue}-${slug}`)
  const names = { kind, branch, worktree, acDigest, title: found.title ?? null, url: found.url ?? null }

  // ---- is a run already live? The four places one leaves a mark: this clone's worktrees, this
  // clone's branches for the issue, the issue's branches on the server, and open pull requests.
  // The server is asked for the branches as well as this clone, because a clone's remote refs are
  // only as fresh as its last fetch and the pushed branch is the marker that outlives the claim
  // tag. The local branch read is the other half: it catches a run working in this clone, and it
  // catches a branch stranded by a run that died before it published, which is the wreckage a
  // human has to look at rather than something to write over.
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
    const local = runGit(['for-each-ref', '--format=%(objectname)\t%(refname)', ...patterns], cwd, LOCAL_GIT_TIMEOUT_MS)
    if (local.code !== 0) return { problem: failureOf('`git for-each-ref` over this clone\'s branches for the issue', local) }
    for (const text of local.stdout.split('\n')) {
      const [sha, name] = text.split('\t')
      if (!SHA.test(sha ?? '') || typeof name !== 'string' || !name.startsWith('refs/heads/')) continue
      if (branchForIssue(issue).test(shortBranch(name))) hits.push({ where: 'local-branch', ref: name, sha })
    }

    const remote = runGit(['ls-remote', 'origin', ...patterns], cwd, REMOTE_GIT_TIMEOUT_MS)
    if (remote.code !== 0) return { problem: failureOf('`git ls-remote origin` with the three issue patterns', remote) }
    for (const text of remote.stdout.split('\n')) {
      const [sha, name] = text.split('\t')
      if (!SHA.test(sha ?? '') || typeof name !== 'string' || !name.startsWith('refs/heads/')) continue
      if (branchForIssue(issue).test(shortBranch(name))) hits.push({ where: 'remote-branch', ref: name, sha })
    }

    // Every open pull request, because the branch scan above does not cover the same ground. A
    // pull request opened from a fork keeps its head branch in the fork, so nothing under
    // refs/heads/* on origin advertises it, and `gh pr list --limit 100` drops the oldest of them
    // on a repository busier than that. --paginate walks the pages to exhaustion, and on its own
    // it prints each page as its own JSON array, one after another: two adjacent arrays are not a
    // JSON document, so the parse failed and every claim on a repository with more than a hundred
    // open pull requests came back scan-unreadable. --slurp is what wraps the pages in one outer
    // array, and what arrives here is therefore an array of pages to flatten.
    const endpoint = `repos/${ghRepo.owner}/${ghRepo.repo}/pulls?state=open&per_page=100`
    const prs = runGh(['api', ...hostPin, '--paginate', '--slurp', endpoint], { cwd })
    if (prs.code !== 0) return { problem: failureOf('`gh api` over the open pull requests', prs) }
    const pages = parseJson(prs.stdout)
    if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
      return { problem: '`gh api --paginate --slurp` over the open pull requests printed something this could not read as an array of pages' }
    }
    const open = pages.flat()
    for (const pr of open) {
      const headRef = String(pr?.head?.ref ?? '')
      if (branchForIssue(issue).test(headRef)) {
        hits.push({ where: 'pull-request', number: pr?.number ?? null, headRefName: headRef, title: pr?.title ?? null, url: pr?.html_url ?? null })
      }
    }
    return { hits }
  }

  const first = scan()
  if (first.problem) return unknown('scan-unreadable', `the scan for a run already working issue #${issue} could not be completed: ${first.problem}`, names)
  if (first.hits.length > 0) {
    return refuse('live-run', `issue #${issue} already has a run on it`, { ...names, found: groupHits(first.hits) },
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
  const commonRaw = commonRead.code === 0 ? resolve(cwd, commonRead.stdout.trim()) : ''
  if (commonRaw === '') {
    return unknown('repo-unreadable', `\`git rev-parse --git-common-dir\` gave no git directory for this repository: ${firstLine(redact(commonRead.stderr)) || `exit ${commonRead.code}`}`, names)
  }
  // git answers `.git` for the common directory of an ordinary clone, and a `.git` that is a
  // symlink to a directory outside the parent resolves to a path inside it until the links are
  // followed. So both sides of this comparison are real paths.
  const common = canonical(commonRaw)
  if (common === '') {
    return refuse('outside-parent', 'this repository\'s git directory does not resolve to a real path, so whether a worktree added here would register itself out of bounds cannot be established', names)
  }
  if (common !== parent && !common.startsWith(parent + sep)) {
    return refuse('outside-parent', `this repository's git directory is ${common}, outside ${parent}, so a worktree added here would register itself out of bounds`, names)
  }

  // ---- the claim. Everything above was a read.
  const acquired = acquire({ argv: [String(issue)], cwd })
  const receipt = parseJson(acquired.stdout)
  const verdict = receipt?.result
  // Whether the acquire had pushed anything when it decided what to report, and whether a tag of
  // its own can be on the remote. Only acquire knows it, and it decides the phase: a hold or a
  // failure read before the push leaves nothing of this run anywhere, one read after it may have
  // left the tag, and absent is a push that went out and was then proved to have created no tag.
  // Anything but those exact strings is read as post-push, so a receipt this could not parse
  // keeps the tag on the retained list.
  const observed = receipt?.observed === 'pre-push' || receipt?.observed === 'absent' ? receipt.observed : 'post-push'
  if (verdict === 'held' && observed === 'pre-push') {
    // Someone else's tag, read before this run pushed anything, so nothing of ours is out there.
    const holder = String(receipt.sha ?? '')
    return line({ ...base, ...names, result: 'held', phase: 'pre-acquire', retained: [], cleanup: null, sha: receipt.sha ?? null, detail: receipt.detail ?? null }, EXIT_HELD,
      `issue #${issue} is already claimed on ${repo} (${ref}${SHA.test(holder) ? ` at ${holder.slice(0, 12)}` : ''}). ` +
      'Leave it alone; the run that holds it releases it, or a human breaks the tag.')
  }
  if (verdict === 'held') {
    // A tag that appeared while this run's own push was in flight. acquire stands down on it
    // because it cannot tell a rival's tag from its own whose response was lost, and both racers
    // push the same object, so the SHA cannot separate them either. Reporting that as a clean
    // hold would tell the caller this run left nothing while its tag may be blocking every later
    // claim on the issue. It is an unknown, and the tag is retained.
    return settle('unknown', 'acquire-ambiguous',
      `the claim tag for issue #${issue} was on ${repo} after this run's own push, and whose it is cannot be established: ${receipt.detail ?? 'no detail'}`,
      { phase: 'acquired', retained: ['claim-tag'], extra: names })
  }
  if (verdict === 'refused') {
    return refuse('acquire-refused', `the claim on issue #${issue} was refused (${receipt.reason ?? 'no reason'}): ${receipt.detail ?? 'no detail'}`, names)
  }
  if (verdict !== 'acquired' || !SHA.test(String(receipt.sha ?? ''))) {
    // Several of the acquire's unknowns happen before it pushes anything: the read of main
    // failing, the preflight tag read failing, the catch-up fetch failing. Nothing was attempted
    // in those, so there is no tag to retain and no recovery for a human to do. Only an unknown
    // that came after the push may have left one.
    const detail = `the claim on issue #${issue} could not be taken: ${receipt?.detail ?? acquired.stdout.trim()}`
    if (observed === 'absent') {
      // The push went out, failed, and the re-read found no tag on the remote. There is nothing
      // to retain and nothing for a human to unwind, and reporting it as an ordinary post-push
      // unknown sent one looking for a tag this run had just proved does not exist. What it does
      // not establish is who said no. A protected tag pattern on origin, a pre-push hook in this
      // clone and a transport that never delivered the push are one answer from here, so the
      // reason names the fact rather than the culprit: the tag was not created.
      return settle('unknown', 'acquire-not-created', detail, {
        phase: 'pre-acquire',
        retained: [],
        extra: names,
        human: `${detail}. The tag was not created; origin, a local hook, or the transport refused the push. ${leftovers([])}`,
      })
    }
    return observed === 'pre-push'
      ? settle('unknown', 'acquire-unknown', detail, { phase: 'pre-acquire', retained: [], extra: names })
      : settle('unknown', 'acquire-unknown', detail, { phase: 'acquired', retained: ['claim-tag'], extra: names })
  }
  const baseSha = receipt.sha
  const claimed = { ...names, base: baseSha }

  /**
   * Give the tag back, and say whether the remote agrees it is gone. abandon refusing with
   * tag-absent is a positive answer, since it read the remote and found no tag; every other answer
   * leaves the tag on the retained list, because a claim tag whose state nobody knows is exactly
   * what stops the next run.
   */
  const giveBack = () => {
    const said = parseJson(abandon({ argv: [String(issue), baseSha], cwd }).stdout)
    const result = said?.result ?? 'unknown'
    return { result, gone: result === 'abandoned' || (result === 'refused' && said?.reason === 'tag-absent') }
  }

  /**
   * Undo what this run made, and report honestly what would not go. Nothing leaves the retained
   * list on the strength of a command's exit code: the worktree, the branch and the tag are each
   * read back afterwards, and whatever does not come back positively gone stays on the list and
   * turns the caller's refusal into an unknown.
   */
  const unwind = ({ worktreeAdded, branchCreated }) => {
    const retained = []
    const cleanup = []
    if (worktreeAdded) {
      // remove without --force, then prune: the checkout is seconds old and holds nothing worth
      // forcing past, and a remove that does refuse leaves the path for a human rather than
      // deleting work nobody expected.
      runGit(['worktree', 'remove', worktree], cwd, WORKTREE_TIMEOUT_MS)
      runGit(['worktree', 'prune'], cwd, LOCAL_GIT_TIMEOUT_MS)
      if (worktreeState(cwd, worktree) !== 'absent') { retained.push('worktree'); cleanup.push('worktree-remove') }
    }
    if (branchCreated) {
      // A compare-and-delete, not a read followed by a delete. `git update-ref -d <ref> <old>`
      // takes the object the ref has to hold and git refuses the delete if it holds anything
      // else, so a name that turned out to belong to someone else is left alone even when it
      // changed hands between the two commands. Reading the head first and then running
      // `git branch -D` left exactly that window open, and what falls into it is a rival's work.
      runGit(['update-ref', '-d', `refs/heads/${branch}`, baseSha], cwd, LOCAL_GIT_TIMEOUT_MS)
      if (localBranchHead(cwd, branch).state !== 'absent') { retained.push('local-branch'); cleanup.push('local-branch-delete') }
    }
    const gave = giveBack()
    if (!gave.gone) { retained.push('claim-tag'); cleanup.push('abandon') }
    return { retained, cleanup: cleanup.length === 0 ? null : cleanup.join(', '), abandon: gave.result }
  }

  // ---- the second scan, the one that catches a contender who scanned before this run took the
  // tag and is still on its way to claiming. Race-free by construction: holding the tag blocks
  // every new contender, and any earlier winner released only after its branch reached origin.
  const second = scan()
  if (second.problem) {
    const swept = unwind({ worktreeAdded: false, branchCreated: false })
    return settle('unknown', 'scan-unreadable', `the second scan for a live run on issue #${issue} could not be completed: ${second.problem}`,
      { phase: 'acquired', retained: swept.retained, cleanup: swept.cleanup, extra: { ...claimed, abandon: swept.abandon } })
  }
  if (second.hits.length > 0) {
    const swept = unwind({ worktreeAdded: false, branchCreated: false })
    return settle('refused', 'live-run', `issue #${issue} already has a run on it, found while holding the claim`, {
      phase: 'acquired',
      retained: swept.retained,
      cleanup: swept.cleanup,
      extra: { ...claimed, found: groupHits(second.hits), abandon: swept.abandon },
      human: `issue #${issue} already has a run on it: ${describeHits(second.hits)}. ${leftovers(swept.retained)} Look at that run before starting another.`,
    })
  }

  // ---- the issue, read again while the tag is held. The read that authorized this run happened
  // before the acquire, and a human can close the issue, pull the ready label or add a blocker in
  // the seconds between the two. Without this, such a run pushes a branch, relabels a closed or
  // blocked issue and reports itself claimed. This is the last point where standing down costs
  // one tag and nothing else, so it goes here rather than after the worktree add.
  const again = readIssue()
  const changed = again.problem === undefined ? readiness(again) : null
  if (again.problem !== undefined || changed !== null) {
    const swept = unwind({ worktreeAdded: false, branchCreated: false })
    const detail = changed === null
      ? `issue #${issue} could not be read again while this run held the claim: ${again.problem}`
      : `${changed.detail}, and it changed while this run held the claim`
    return settle(changed === null ? 'unknown' : 'refused', changed === null ? 'issue-unreadable' : changed.reason, detail, {
      phase: 'acquired',
      retained: swept.retained,
      cleanup: swept.cleanup,
      extra: { ...claimed, ...(changed?.extra ?? {}), abandon: swept.abandon },
    })
  }

  // ---- the worktree, at the object the acquire verified on the remote. Never at this clone's
  // own origin/main, which is as old as its last fetch.
  const added = runGit(['worktree', 'add', worktree, '-b', branch, baseSha], cwd, WORKTREE_TIMEOUT_MS)
  if (added.code !== 0) {
    // An add that failed part way can still leave a registration, a directory and the new branch
    // behind. All three would refuse the next run, the branch forever, so the unwind takes all
    // three and says which of them it could not confirm gone.
    const swept = unwind({ worktreeAdded: true, branchCreated: true })
    const detail = `\`git worktree add ${worktree} -b ${branch}\` failed (exit ${added.code}): ${gitComplaint(redact(added.stderr)) || 'git said nothing'}`
    return settle('refused', 'worktree-add', detail,
      { phase: 'acquired', retained: swept.retained, cleanup: swept.cleanup, extra: { ...claimed, abandon: swept.abandon } })
  }

  // Nothing is committed between the branch creation and this push, so the head is the base. The
  // release below re-reads origin and refuses unless the remote branch is exactly this object,
  // which is what proves the push landed; a local rev-parse would only prove what git did here.
  const head = baseSha
  const branchRef = `refs/heads/${branch}`
  const pushed = runGit(['push', '-u', 'origin', branch], worktree, PUSH_TIMEOUT_MS)
  if (pushed.code !== 0) {
    const detail = `\`git push -u origin ${branch}\` failed (exit ${pushed.code}): ${gitComplaint(redact(pushed.stderr)) || 'git said nothing'}`
    const everything = ['claim-tag', 'worktree', 'local-branch', 'remote-branch']
    // A non-zero push is not proof that nothing was published: receive-pack can update the ref
    // and the answer can still be lost on the way back. Ask the remote what it holds before
    // undoing anything, because the branch on origin is what keeps the next run out.
    const remote = readRef(cwd, branchRef, redact)
    if (remote.state === 'present' && remote.sha === head) {
      return settle('unknown', 'push',
        `${detail}, but ${branchRef} on ${repo} is at ${head.slice(0, 12)}, so the branch was published and only the answer was lost`, {
          phase: 'published',
          retained: everything,
          extra: { ...claimed, head },
          human: `${detail}, but ${branchRef} is on ${repo} at ${head.slice(0, 12)}, so this run published after all. ` +
            `Nothing was given back and ${ref} is still there; finish or unwind this by hand, and do not re-run the claim.`,
        })
    }
    if (remote.state === 'unknown') {
      return settle('unknown', 'push',
        `${detail}, and ${branchRef} on ${repo} could not be read afterwards, so whether the branch was published is not known: ${remote.detail}`,
        { phase: 'acquired', retained: everything, extra: { ...claimed, head } })
    }
    if (remote.state === 'present') {
      // A branch under this run's name at some other object: a rival took the name between the
      // second scan and this push. This run published nothing, and that branch is not its to take
      // away. So it is reported under found, where the caller reads what the scans saw, and never
      // under retained, which is the list a human is told to clear by hand. Naming someone else's
      // branch there is how their work gets deleted.
      const swept = unwind({ worktreeAdded: true, branchCreated: true })
      const rival = { where: 'remote-branch', ref: branchRef, sha: remote.sha }
      return settle('unknown', 'push',
        `${detail}, and ${branchRef} on ${repo} is at ${remote.sha.slice(0, 12)} rather than the ${head.slice(0, 12)} this run pushed`, {
          phase: 'acquired',
          retained: swept.retained,
          cleanup: swept.cleanup,
          extra: { ...claimed, head, found: groupHits([rival]), abandon: swept.abandon },
          human: `${detail}, and ${branchRef} is on ${repo} at ${remote.sha.slice(0, 12)}, which is not the object this run pushed. ` +
            `${leftovers(swept.retained)} That branch belongs to whoever pushed it and is not this run's to touch.`,
        })
    }
    // Absent: nothing of this run reached origin, so the ordinary unwind runs.
    const swept = unwind({ worktreeAdded: true, branchCreated: true })
    return settle('refused', 'push', detail,
      { phase: 'acquired', retained: swept.retained, cleanup: swept.cleanup, extra: { ...claimed, head, abandon: swept.abandon } })
  }

  // ---- past here the branch is on origin, where every other run's scan can see it, and the tag
  // is no longer the only thing keeping a second run out. Nothing below gives it back.
  const published = { ...claimed, head }
  const stuck = (reason, detail) => settle('unknown', reason, detail, {
    phase: 'published',
    retained: ['claim-tag', 'worktree', 'local-branch', 'remote-branch'],
    extra: published,
    human: `${detail}. ${branch} is on ${repo} at ${head.slice(0, 12)} and ${ref} is still there; finish or unwind this by hand, and do not re-run the claim.`,
  })

  const edited = runGh(['issue', 'edit', String(issue), ...repoPin, '--add-assignee', '@me', '--remove-label', READY_LABEL, '--add-label', IN_PROGRESS_LABEL], { cwd })
  if (edited.code !== 0) {
    return stuck('issue-edit', failureOf(`\`gh issue edit ${issue}\``, edited))
  }

  // gh exiting 0 says the request was accepted, not that the issue now reads the way the next run
  // needs it to. A label the repository does not have, an automation that puts the ready label
  // straight back, a human closing the issue mid-edit: each of those leaves a claimed run whose
  // issue does not say a run is on it. The branch is already on origin and none of this can be
  // undone, so the honest answer names the branch and the tag and keeps both.
  //
  // The confirmation asks for the whole state the next reader needs, and not a subset of it. Open,
  // in-progress, no ready-for-agent, no blocking label, and assigned. Two of those are recent: an
  // issue reading back OPEN and in-progress and needs-human passed the old check, though that is
  // the exact state readiness refuses on the way in and a human adding a blocker mid-edit is
  // ordinary; and the assignment was never checked at all, so `--add-assignee` silently doing
  // nothing read as a confirmed claim.
  //
  // GitHub resolves `@me` server-side, so the login has to be asked for rather than assumed. It
  // is one read, pinned to the host origin names, and a login that cannot be read is itself an
  // unconfirmed edit: an assignee list nobody can compare against confirms nothing.
  const me = runGh(['api', ...hostPin, '--jq', '.login', 'user'], { cwd })
  const login = me.code === 0 ? me.stdout.trim() : ''
  const confirmed = readIssue()
  const assigned = confirmed.problem === undefined ? assigneeLogins(confirmed.issue.assignees) : []
  const stillBlocked = confirmed.problem === undefined ? BLOCKING_LABELS.filter((label) => confirmed.labels.includes(label)) : []
  const moved = confirmed.problem === undefined && login !== '' && confirmed.state === 'OPEN' &&
    confirmed.labels.includes(IN_PROGRESS_LABEL) && !confirmed.labels.includes(READY_LABEL) &&
    stillBlocked.length === 0 && assigned.includes(login)
  if (!moved) {
    if (confirmed.problem !== undefined) {
      return stuck('issue-edit-unconfirmed', `\`gh issue edit ${issue}\` reported success and the issue could not be read back to confirm it: ${confirmed.problem}`)
    }
    if (login === '') {
      return stuck('issue-edit-unconfirmed',
        `\`gh issue edit ${issue}\` reported success and ${failureOf('`gh api user`', me)}, so there is no login to check the assignment against`)
    }
    return stuck('issue-edit-unconfirmed',
      `\`gh issue edit ${issue}\` reported success and issue #${issue} reads back as ${confirmed.state || 'no state at all'} carrying ` +
      `${confirmed.labels.join(', ') || 'no labels'} and assigned to ${assigned.join(', ') || 'nobody'}, so the assignment and the label move are not confirmed`)
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
 * subcommands never call it, which is why it is optional. claim is the exception: it reads and
 * labels the issue over gh, so a claim with no runner is refused in the dispatcher rather than
 * thrown out of the middle of the run, where the caller would get a stack trace in place of the
 * JSON line it parses.
 *
 * @param {object} args
 * @param {string[]} args.argv the argument vector after the script name
 * @param {string} args.cwd the directory whose origin remote this run claims on
 * @param {Record<string,string|undefined>} [args.env] read for FLOW_GH_HOSTS alone, the allowlist
 *   of hosts gh may be pinned to; an absent environment is the default list, github.com only
 * @param {(ghArgs: string[], options: {cwd: string}) => {code: number, stdout: string, stderr: string}} [args.runGh] required by claim, unused by the other three
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function issueClaim({ argv, cwd, env, runGh }) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { code: EXIT_OK, stdout: USAGE, stderr: '' }
  }
  const [subcommand, ...rest] = argv
  if (subcommand === 'claim' && typeof runGh !== 'function') {
    const detail = 'claim was called with no gh runner, and it reads and labels the issue over gh before it writes ' +
      'anything, so there is nothing it can do without one; acquire, release and abandon are git alone and take none'
    return line({ command: 'claim', result: 'refused', reason: 'usage', phase: 'pre-acquire', retained: [], cleanup: null, detail },
      EXIT_REFUSED, `${detail}. Nothing was read and nothing was pushed.`)
  }
  if (subcommand === 'claim') return claim({ argv: rest, cwd, env, runGh })
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
  const result = issueClaim({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, runGh })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.code)
}
