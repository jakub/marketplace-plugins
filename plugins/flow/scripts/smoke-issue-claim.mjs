#!/usr/bin/env node
// Smoke harness for scripts/issue-claim.mjs, the compare-and-set that stops two autonomous runs
// from starting the same issue.
//
// Everything here runs against throwaway repositories under mktemp: one bare repository standing
// in for origin, and clones pointed at it. No network, no GitHub, no fake git. The claim rests on
// what git's own ref update does under contention, so faking git would test nothing.
//
// The failure this file exists to catch is a false win: two runs both told they acquired the
// claim. `git push` exits 0 both when it creates the tag and when the tag already exists at the
// object being pushed, and since every racer pushes the head of main, that second case is the
// ordinary shape of losing. One case below runs the raw git command to show the 0 exit, and two
// more drive the program through that same shape and require it to report a loss.
//
// Forcing the loss deterministically takes a small ambush. A clone gets a
// remote.origin.uploadpack wrapper that counts its invocations and creates the claim tag on the
// bare repository right after the second one. The program reads main on the first, preflights
// the tag on the second and finds it absent, then pushes into a tag that appeared in between.
// That is the race, without the timing.
//
// The concurrent case is the real thing: two child processes started together, several times
// over. Its timing is not controlled, so the loser may lose at the preflight or at the push. The
// invariant asserted is the one that matters either way, exactly one winner, and the run prints
// which path the losers actually took.
//
// The stale clone gets a second bare repository of its own, because proving that case means
// moving origin's main and every other assertion here is written against the first one's head.
// Both clones come off it before the advance, so neither holds the object a claim now hangs on.
// That is where a push fails locally, while building its pack, and looks exactly like a lost
// race. The containment assertions are the other half: comparing the clone's whole `show-ref`
// listing before and after is one check that catches a local branch, a remote-tracking ref, a
// tag or a leftover temporary ref moving.
//
// abandon is the one subcommand that deletes a tag, so it gets two independent guards and a case
// for each. The receipt check reads the tag first, and the --force-with-lease makes the remote
// recheck the same object at delete time. Removing either one is caught: an ambush that swaps the
// tag between the read and the push is what the lease is for, and dropping the read is caught by
// the lease answering `[rejected] (stale info)`.
//
// The replay walks the race a reviewer found end to end. B scans clean, stalls; A acquires,
// publishes, releases; B's late push creates the tag fresh and reads as a clean acquire; B's
// post-acquire recheck finds A's branch; B abandons. The assertions at the end are that the tag
// is gone, A's branch is untouched at the head A pushed, and the issue carries nothing of B's.
//
// Three more failures get their own repositories, because none of them is about the race.
// Release has to reject a branch that is not the issue's own, or the head check authorizes
// nothing and `release 8 main <head-of-main>` drops a live claim. Origin has to fetch from and
// push to one repository, so a clone with a pushurl aimed at a second bare repository is refused
// and neither repository ends up with a tag. And an origin URL carrying a username and a token
// has to leave both out of everything the program prints, which is checked against the whole of
// stdout and stderr rather than the identity field alone. That last one caught a real leak: the
// identity was clean, but git repeats the remote it was handed inside its own error text.
//
// Run: node plugins/flow/scripts/smoke-issue-claim.mjs

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'issue-claim.mjs')

let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad++
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` → ${detail}`}`)
}

// ------------------------------------------------------------- the throwaway repositories
const tmp = mkdtempSync(join(tmpdir(), 'flow-issue-claim-'))
const origin = join(tmp, 'origin.git')   // stands in for the remote everyone races on
const seed = join(tmp, 'seed')           // writes the first commit, then goes away
const a = join(tmp, 'a')                 // the run that wins
const b = join(tmp, 'b')                 // the run that loses
const ambushSame = join(tmp, 'ambush-same')      // loses at the push, "up to date"
const ambushOther = join(tmp, 'ambush-other')    // loses at the push, "rejected"
const gone = join(tmp, 'gone')           // origin points at a path that is not there
const elsewhere = join(tmp, 'elsewhere.git')     // the repository a divergent pushurl points at
const diverged = join(tmp, 'diverged')   // reads from origin, pushes to elsewhere
const creds = join(tmp, 'creds')         // origin URL carries a username and a token

// Isolated from the developer's own git config, with an identity that needs none, and with
// every proxy and credential helper stripped so the one host-shaped URL below fails fast on a
// refused connection instead of reaching anything.
const gitEnv = {
  ...process.env,
  HOME: tmp,
  GIT_CONFIG_GLOBAL: join(tmp, 'no-such-gitconfig'),
  GIT_CONFIG_SYSTEM: join(tmp, 'no-such-gitconfig'),
  GIT_AUTHOR_NAME: 'flow smoke',
  GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
  GIT_COMMITTER_NAME: 'flow smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  GIT_SSH_COMMAND: 'false',
}
for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete gitEnv[key]
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv }).trim()
const tagRef = (issue) => `refs/tags/flow-claim-issue-${issue}`
/** What a bare repository itself holds, read directly rather than through the program. */
const tagIn = (dir, issue) => {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', tagRef(issue)], { encoding: 'utf8', env: gitEnv })
  return r.status === 0 ? r.stdout.trim() : null
}
const tagOnOrigin = (issue) => tagIn(origin, issue)
const dropTag = (issue) => spawnSync('git', ['-C', origin, 'update-ref', '-d', tagRef(issue)], { encoding: 'utf8', env: gitEnv })

execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv })
execFileSync('git', ['init', '-q', '-b', 'main', seed], { env: gitEnv })
writeFileSync(join(seed, 'file.txt'), 'first\n')
git(seed, 'add', 'file.txt')
git(seed, 'commit', '-q', '-m', 'first')
git(seed, 'remote', 'add', 'origin', origin)
git(seed, 'push', '-q', 'origin', 'main')
const mainSha = git(seed, 'rev-parse', 'HEAD')

// A second commit object living on the remote, used as the rival claim's object in the
// "rejected" ambush so that the tag it holds is provably not the one this run would push.
const decoySha = git(seed, 'commit-tree', git(seed, 'rev-parse', 'HEAD^{tree}'), '-m', 'a rival run\'s object')
git(seed, 'push', '-q', 'origin', `${decoySha}:refs/heads/decoy`)

for (const dir of [a, b, ambushSame, ambushOther, gone, diverged, creds]) {
  execFileSync('git', ['clone', '-q', origin, dir], { env: gitEnv })
}
git(gone, 'remote', 'set-url', 'origin', join(tmp, 'no-such-repository.git'))

// A real second repository, so a divergent pushurl is a place a tag could actually land rather
// than a write that fails on its own.
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', elsewhere], { env: gitEnv })
git(diverged, 'config', 'remote.origin.pushurl', elsewhere)

// The credential is fake and the host is a refused port on the loopback, so nothing leaves this
// machine. The string has to be distinctive enough to find anywhere in the program's output.
const PAT = 's3cr3t-PAT-value'
const PAT_USER = 'smokeuser'
git(creds, 'remote', 'set-url', 'origin', `https://${PAT_USER}:${PAT}@127.0.0.1:1/jakub/marketplace-plugins.git`)

const parseJson = (text) => { try { return JSON.parse(text) } catch { return null } }
const claim = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: gitEnv })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json: parseJson(r.stdout ?? '') }
}
const claimAsync = (cwd, ...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('close', (code) => resolve({ code, stdout, stderr, json: parseJson(stdout) }))
})

/**
 * Install the ambush on a clone: an upload-pack wrapper that points issue `issue`'s claim tag at
 * `sha` on the bare repository immediately after its `after`th invocation, creating or moving it.
 *
 * acquire reads main and then preflights the tag, so `after` of 2 lands the rival claim between
 * that preflight and the push. abandon reads the tag once, so `after` of 1 lands a swap between
 * its receipt check and its delete, which is the window the lease exists to close.
 */
const arm = (clone, issue, sha, after = 2) => {
  const counter = join(clone, 'invocations')
  const wrapper = join(clone, 'upload-pack-wrapper.sh')
  writeFileSync(wrapper, [
    '#!/bin/sh',
    `n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)`,
    'n=$((n+1))',
    `printf '%s' "$n" > ${JSON.stringify(counter)}`,
    'git upload-pack "$@"',
    'status=$?',
    `if [ "$n" = ${JSON.stringify(String(after))} ]; then git -C ${JSON.stringify(origin)} update-ref ${JSON.stringify(tagRef(issue))} ${JSON.stringify(sha)}; fi`,
    'exit $status',
    '',
  ].join('\n'))
  chmodSync(wrapper, 0o755)
  git(clone, 'config', 'remote.origin.uploadpack', wrapper)
}

// ------------------------------------------------------------------- a sequential race
console.log('a claim is taken once, and the second run is told it lost')

// A longer issue number is already claimed. An ls-remote pattern is a match rather than an
// equality, so this is what proves the preflight for issue 6 does not read issue 60's tag.
git(seed, 'push', '-q', 'origin', `${mainSha}:${tagRef(60)}`)

const won = claim(a, 'acquire', '6')
check('the first run acquires the claim', won.json?.result === 'acquired' && won.code === 0, `exit ${won.code} ${won.stdout}${won.stderr}`)
check('it reports the tag it created and the object under it', won.json?.tag === 'flow-claim-issue-6' && won.json?.sha === mainSha, won.stdout)
check('it names the repository it claimed on', won.json?.repo === origin, won.stdout)
check('the tag is on the remote, at the head of main', tagOnOrigin(6) === mainSha, String(tagOnOrigin(6)))
check('a claim on issue 60 did not read as a claim on issue 6', won.json?.result === 'acquired', won.stdout)
check('a win says nothing on stderr', won.stderr === '', won.stderr)

const lost = claim(b, 'acquire', '6')
check('the second run is told the claim is held', lost.json?.result === 'held' && lost.code === 3, `exit ${lost.code} ${lost.stdout}${lost.stderr}`)
check('it reports the object the held tag points at', lost.json?.sha === mainSha, lost.stdout)
check('it tells a human to leave it alone', lost.stderr.includes('already claimed'), lost.stderr)
check('the tag on the remote is untouched', tagOnOrigin(6) === mainSha, String(tagOnOrigin(6)))

// The reason the program cannot read the exit code and stop there. Same push the loser would
// make, run raw: git reports success for a tag it did not create.
const rawPush = spawnSync('git', ['-C', b, 'push', '--porcelain', 'origin', `${mainSha}:${tagRef(6)}`], { encoding: 'utf8', env: gitEnv })
const rawLine = rawPush.stdout.split('\n').find((l) => l.includes(tagRef(6))) ?? ''
check('raw git exits 0 when it pushes the same object at a tag it did not create', rawPush.status === 0, `exit ${rawPush.status}`)
check('and only the flag column says so, with =, not *', rawLine.startsWith('=\t') && rawLine.includes('[up to date]'), JSON.stringify(rawLine))

// ------------------------------------------ losing at the push, with the preflight satisfied
console.log('\na claim that appears between the preflight and the push is still a loss')

arm(ambushSame, 61, mainSha)
const ambushedSame = claim(ambushSame, 'acquire', '61')
check('an "up to date" push is reported held, not acquired', ambushedSame.json?.result === 'held' && ambushedSame.code === 3,
  `exit ${ambushedSame.code} ${ambushedSame.stdout}${ambushedSame.stderr}`)
check('and it says the push is what failed to create the ref', String(ambushedSame.json?.detail).includes('did not create the ref'), ambushedSame.stdout)
check('the rival claim is still on the remote', tagOnOrigin(61) === mainSha, String(tagOnOrigin(61)))

arm(ambushOther, 62, decoySha)
const ambushedOther = claim(ambushOther, 'acquire', '62')
check('a rejected push is reported held, not acquired', ambushedOther.json?.result === 'held' && ambushedOther.code === 3,
  `exit ${ambushedOther.code} ${ambushedOther.stdout}${ambushedOther.stderr}`)
check('it reports the rival\'s object, not the one it tried to push', ambushedOther.json?.sha === decoySha, ambushedOther.stdout)
check('the rival claim still points at its original object', tagOnOrigin(62) === decoySha, String(tagOnOrigin(62)))

// -------------------------------------------------------------------- a stale clone
// Its own bare repository, because this case has to move origin's main and every assertion
// elsewhere is written against the first one's head. Both clones are taken before the advance,
// so neither holds the object a claim now hangs on. That is an ordinary checkout somebody left
// open overnight, and before the catch-up fetch it could never take a claim: the push failed
// locally with `fatal: bad object` while building its pack, which read as a lost race.
console.log('\na clone that has not fetched since origin moved can still take a claim')

const staleOrigin = join(tmp, 'stale-origin.git')
const staleSeed = join(tmp, 'stale-seed')
const stale = join(tmp, 'stale')
const staleTwin = join(tmp, 'stale-twin')
const advancer = join(tmp, 'advancer')

execFileSync('git', ['init', '-q', '--bare', '-b', 'main', staleOrigin], { env: gitEnv })
execFileSync('git', ['init', '-q', '-b', 'main', staleSeed], { env: gitEnv })
writeFileSync(join(staleSeed, 'file.txt'), 'first\n')
git(staleSeed, 'add', 'file.txt')
git(staleSeed, 'commit', '-q', '-m', 'first')
git(staleSeed, 'remote', 'add', 'origin', staleOrigin)
git(staleSeed, 'push', '-q', 'origin', 'main')
for (const dir of [stale, staleTwin, advancer]) execFileSync('git', ['clone', '-q', staleOrigin, dir], { env: gitEnv })

writeFileSync(join(advancer, 'file.txt'), 'second\n')
git(advancer, 'add', 'file.txt')
git(advancer, 'commit', '-q', '-m', 'second')
git(advancer, 'push', '-q', 'origin', 'main')
const advancedSha = git(staleOrigin, 'rev-parse', 'refs/heads/main')

const holdsObject = (dir, sha) => spawnSync('git', ['-C', dir, 'cat-file', '-e', `${sha}^{commit}`], { env: gitEnv }).status === 0
const refsOf = (dir) => {
  const r = spawnSync('git', ['-C', dir, 'show-ref'], { encoding: 'utf8', env: gitEnv })
  return (r.stdout ?? '').split('\n').filter((l) => l !== '').sort().join('\n')
}
const branchStatus = (dir) => git(dir, 'status', '--porcelain=v1', '--branch')

check('the fixture is genuinely stale: the clone lacks origin\'s current main object', !holdsObject(stale, advancedSha), 'the clone already had it')
const refsBefore = refsOf(stale)
const statusBefore = branchStatus(stale)

const staleClaim = claim(stale, 'acquire', '13')
check('the stale clone acquires the claim', staleClaim.json?.result === 'acquired' && staleClaim.code === 0,
  `exit ${staleClaim.code} ${staleClaim.stdout}${staleClaim.stderr}`)
check('the tag on the remote points at origin\'s current main head', tagIn(staleOrigin, 13) === advancedSha,
  `${tagIn(staleOrigin, 13)} wanted ${advancedSha}`)
check('and it reports that same object as the claim\'s', staleClaim.json?.sha === advancedSha, staleClaim.stdout)

// The catch-up fetch is read-only as far as this clone is concerned. show-ref covers local
// branches, remote-tracking refs, tags and the temporary ref together, so comparing the whole
// listing before and after is one assertion that catches any of them moving.
check('not one ref in the clone changed, including the temporary fetch ref', refsOf(stale) === refsBefore,
  `before:\n${refsBefore}\nafter:\n${refsOf(stale)}`)
check('no FETCH_HEAD was written', !existsSync(join(stale, '.git', 'FETCH_HEAD')), 'FETCH_HEAD exists')
check('the branch is where it was, and still reads as behind', branchStatus(stale) === statusBefore, `${statusBefore} became ${branchStatus(stale)}`)
check('the clone now holds the object it pushed', holdsObject(stale, advancedSha), 'the object is still missing')

// One concurrent round between two stale clones, which is the only shape where both racers run
// the fetch. Later rounds would prove less, because the first one leaves the object behind.
const [staleFirst, staleSecond] = await Promise.all([
  claimAsync(stale, 'acquire', '14'),
  claimAsync(staleTwin, 'acquire', '14'),
])
const staleResults = [staleFirst, staleSecond].map((r) => r.json?.result ?? `unparseable(${r.code})`)
const staleShown = `${staleFirst.code}:${staleFirst.stdout.trim()} | ${staleSecond.code}:${staleSecond.stdout.trim()}`
check('two stale clones racing: exactly one acquires', staleResults.filter((r) => r === 'acquired').length === 1, staleShown)
check('and the other is held, not unknown', staleResults.filter((r) => r === 'held').length === 1, staleShown)
check('and the winner\'s tag is origin\'s current main head', tagIn(staleOrigin, 14) === advancedSha, String(tagIn(staleOrigin, 14)))

// staleTwin fetches for the first time during that round, while origin already carries issue
// 13's claim tag on the commit being fetched. Tag auto-following would drag other runs' claim
// tags into a working clone, so this is the behavioural half of the --no-tags check.
const localClaimTags = (dir) => {
  const r = spawnSync('git', ['-C', dir, 'tag', '--list', 'flow-claim-issue-*'], { encoding: 'utf8', env: gitEnv })
  return (r.stdout ?? '').split('\n').filter((l) => l.trim() !== '')
}
check('no claim tag was dragged into either clone by the fetch',
  localClaimTags(stale).length === 0 && localClaimTags(staleTwin).length === 0,
  JSON.stringify([...localClaimTags(stale), ...localClaimTags(staleTwin)]))

// ------------------------------------------------------------------- a concurrent race
console.log('\ntwo runs started together: exactly one wins, never both')

const ISSUE_CONCURRENT = 7
const ITERATIONS = 5
let lostAtPreflight = 0
let lostAtPush = 0
for (let i = 1; i <= ITERATIONS; i++) {
  dropTag(ISSUE_CONCURRENT)
  const [first, second] = await Promise.all([
    claimAsync(a, 'acquire', String(ISSUE_CONCURRENT)),
    claimAsync(b, 'acquire', String(ISSUE_CONCURRENT)),
  ])
  const results = [first, second].map((r) => r.json?.result ?? `unparseable(${r.code})`)
  const acquired = results.filter((r) => r === 'acquired')
  const held = results.filter((r) => r === 'held')
  const shown = `${first.code}:${first.stdout.trim()} | ${second.code}:${second.stdout.trim()}`
  check(`round ${i}: exactly one run acquires`, acquired.length === 1, shown)
  check(`round ${i}: the other is held, and exits 3`, held.length === 1 &&
    [first, second].every((r) => (r.json?.result === 'acquired' ? r.code === 0 : r.code === 3)), shown)
  check(`round ${i}: the tag on the remote is the winner's object`, tagOnOrigin(ISSUE_CONCURRENT) === mainSha, String(tagOnOrigin(ISSUE_CONCURRENT)))
  for (const r of [first, second]) {
    if (r.json?.result !== 'held') continue
    if (String(r.json.detail).includes('already there before')) lostAtPreflight++
    else lostAtPush++
  }
}
console.log(`  (of ${ITERATIONS} losers, ${lostAtPreflight} lost at the preflight and ${lostAtPush} at the push)`)
dropTag(ISSUE_CONCURRENT)

// ------------------------------------------------------------------------- releasing
console.log('\nrelease refuses until the branch proves the work was pushed')

const ISSUE_RELEASE = 8
const BRANCH = 'feat/issue-8-thing'
const takenBack = claim(a, 'acquire', String(ISSUE_RELEASE))
check('the claim is taken', takenBack.json?.result === 'acquired' && takenBack.code === 0, takenBack.stdout + takenBack.stderr)

const noBranch = claim(a, 'release', String(ISSUE_RELEASE), BRANCH, mainSha)
check('release with no branch on the remote is refused', noBranch.json?.result === 'refused' && noBranch.code === 2, `exit ${noBranch.code} ${noBranch.stdout}`)
check('and names the missing branch as the reason', noBranch.json?.reason === 'branch-absent', noBranch.stdout)
check('and the claim tag survives the refusal', tagOnOrigin(ISSUE_RELEASE) === mainSha, String(tagOnOrigin(ISSUE_RELEASE)))
check('and it says the tag stays', noBranch.stderr.includes('claim tag stays'), noBranch.stderr)

writeFileSync(join(a, 'work.txt'), 'the work\n')
git(a, 'add', 'work.txt')
git(a, 'commit', '-q', '-m', 'the work')
const workSha = git(a, 'rev-parse', 'HEAD')
git(a, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`)

const wrongHead = claim(a, 'release', String(ISSUE_RELEASE), BRANCH, mainSha)
check('release against a head the branch is not at is refused', wrongHead.json?.result === 'refused' && wrongHead.code === 2, `exit ${wrongHead.code} ${wrongHead.stdout}`)
check('and reports the head it actually found', wrongHead.json?.reason === 'head-mismatch' && wrongHead.json?.found === workSha, wrongHead.stdout)
check('and the claim tag survives that refusal too', tagOnOrigin(ISSUE_RELEASE) === mainSha, String(tagOnOrigin(ISSUE_RELEASE)))

const badSha = claim(a, 'release', String(ISSUE_RELEASE), BRANCH, 'HEAD')
check('release with something that is not a SHA is refused', badSha.json?.reason === 'usage' && badSha.code === 2, `exit ${badSha.code} ${badSha.stdout}`)
check('and the claim tag survives that too', tagOnOrigin(ISSUE_RELEASE) === mainSha, String(tagOnOrigin(ISSUE_RELEASE)))

// The head check alone authorizes nothing, because any branch whose head the caller can read
// would satisfy it. main is the case that matters: it exists, its head is public, and passing
// its real head would sail through a check that only compares SHAs.
console.log('\nrelease only accepts the branch belonging to the issue it is releasing')

const mainBypass = claim(a, 'release', String(ISSUE_RELEASE), 'main', mainSha)
check('release of issue 8 against main, at main\'s real head, is refused', mainBypass.json?.result === 'refused' && mainBypass.code === 2,
  `exit ${mainBypass.code} ${mainBypass.stdout}`)
check('and the reason is that the branch is not the issue\'s', mainBypass.json?.reason === 'branch-not-for-issue', mainBypass.stdout)
check('and issue 8\'s claim survives the bypass', tagOnOrigin(ISSUE_RELEASE) === mainSha, String(tagOnOrigin(ISSUE_RELEASE)))

// A branch that exists on the remote, at exactly the head being passed, and still refused. Only
// the issue number in its name is wrong, so nothing but the new rule can be stopping it.
git(a, 'push', '-q', 'origin', `${workSha}:refs/heads/feat/issue-9-thing`)
const wrongIssue = claim(a, 'release', String(ISSUE_RELEASE), 'feat/issue-9-thing', workSha)
check('another issue\'s branch cannot release this issue\'s claim', wrongIssue.json?.reason === 'branch-not-for-issue' && wrongIssue.code === 2,
  `exit ${wrongIssue.code} ${wrongIssue.stdout}`)
check('and issue 8\'s claim survives that too', tagOnOrigin(ISSUE_RELEASE) === mainSha, String(tagOnOrigin(ISSUE_RELEASE)))

const prefixCollision = claim(a, 'release', String(ISSUE_RELEASE), 'feat/issue-80-thing', workSha)
check('issue 80\'s branch cannot release issue 8, despite the shared prefix', prefixCollision.json?.reason === 'branch-not-for-issue',
  prefixCollision.stdout)
check('and issue 8\'s claim survives that as well', tagOnOrigin(ISSUE_RELEASE) === mainSha, String(tagOnOrigin(ISSUE_RELEASE)))

// The rule has to let the right branch through, or every case above passes for the wrong reason.
// Issue 9 holds no claim, so this is the documented no-op, and what it proves is that fix/ and
// the matching issue number are accepted.
git(a, 'push', '-q', 'origin', `${workSha}:refs/heads/fix/issue-9-thing`)
const rightBranchOtherIssue = claim(a, 'release', '9', 'fix/issue-9-thing', workSha)
check('the issue\'s own branch is accepted, on any of feat, fix and chore', rightBranchOtherIssue.json?.result === 'released' && rightBranchOtherIssue.code === 0,
  `exit ${rightBranchOtherIssue.code} ${rightBranchOtherIssue.stdout}`)
check('and issue 8\'s claim is untouched by a release of issue 9', tagOnOrigin(ISSUE_RELEASE) === mainSha, String(tagOnOrigin(ISSUE_RELEASE)))

console.log('\nrelease gives the claim back once the branch reads back as pushed')
const released = claim(a, 'release', String(ISSUE_RELEASE), BRANCH, workSha)
check('the claim is released', released.json?.result === 'released' && released.code === 0, `exit ${released.code} ${released.stdout}${released.stderr}`)
check('the tag is gone from the remote', tagOnOrigin(ISSUE_RELEASE) === null, String(tagOnOrigin(ISSUE_RELEASE)))
check('and a release says nothing on stderr', released.stderr === '', released.stderr)

// A second release of work nobody has moved is the same answer, because the delete is confirmed
// by re-reading the remote rather than by the push's own report. A later run that pushed new
// work to this branch would move its head, and this call would be a head-mismatch refusal.
const again = claim(a, 'release', String(ISSUE_RELEASE), BRANCH, workSha)
check('releasing an already-released claim is the same answer', again.json?.result === 'released' && again.code === 0, `exit ${again.code} ${again.stdout}`)

// -------------------------------------------------------------------------- abandon
// abandon is for the run that acquired a claim and then, rechecking while holding it, found a
// live run already on the issue. It has published nothing, so it has no branch to prove anything
// with, and the only evidence it has is the SHA its own acquire reported.
console.log('\nabandon gives back a claim the caller just took, and nothing else')

const ISSUE_ABANDON = 15
const nothingToGiveBack = claim(a, 'abandon', String(ISSUE_ABANDON), mainSha)
check('abandon with no tag on the remote is refused', nothingToGiveBack.json?.reason === 'tag-absent' && nothingToGiveBack.code === 2,
  `exit ${nothingToGiveBack.code} ${nothingToGiveBack.stdout}`)

const toAbandon = claim(a, 'acquire', String(ISSUE_ABANDON))
check('the claim is taken', toAbandon.json?.result === 'acquired' && toAbandon.code === 0, `exit ${toAbandon.code} ${toAbandon.stdout}`)
const receipt = String(toAbandon.json?.sha)

// decoySha is a real commit on the remote, so this is a well-formed receipt for a different
// object, not a malformed argument. It is the shape a stale abandon would arrive in.
const wrongReceipt = claim(a, 'abandon', String(ISSUE_ABANDON), decoySha)
check('abandon with a receipt that is not the tag\'s object is refused', wrongReceipt.json?.reason === 'receipt-mismatch' && wrongReceipt.code === 2,
  `exit ${wrongReceipt.code} ${wrongReceipt.stdout}`)
check('and it reports the object the tag actually holds', wrongReceipt.json?.found === receipt, wrongReceipt.stdout)
check('and the claim survives the wrong receipt', tagOnOrigin(ISSUE_ABANDON) === receipt, String(tagOnOrigin(ISSUE_ABANDON)))
check('and it says abandon is not a way to break someone else\'s claim', wrongReceipt.stderr.includes('not a way to break'), wrongReceipt.stderr)

const badReceipt = claim(a, 'abandon', String(ISSUE_ABANDON), 'HEAD')
check('abandon with something that is not a SHA is refused', badReceipt.json?.reason === 'usage' && badReceipt.code === 2,
  `exit ${badReceipt.code} ${badReceipt.stdout}`)
check('and the claim survives that too', tagOnOrigin(ISSUE_ABANDON) === receipt, String(tagOnOrigin(ISSUE_ABANDON)))

const abandoned = claim(a, 'abandon', String(ISSUE_ABANDON), receipt)
check('abandon with the acquire\'s own receipt succeeds', abandoned.json?.result === 'abandoned' && abandoned.code === 0,
  `exit ${abandoned.code} ${abandoned.stdout}${abandoned.stderr}`)
check('and the tag is gone from the remote', tagOnOrigin(ISSUE_ABANDON) === null, String(tagOnOrigin(ISSUE_ABANDON)))
check('and a clean abandon says nothing on stderr', abandoned.stderr === '', abandoned.stderr)

// Unlike release, abandon is not idempotent, and that is deliberate: the receipt has to match a
// tag that is there, so a second call has nothing to give back and says so.
const abandonTwice = claim(a, 'abandon', String(ISSUE_ABANDON), receipt)
check('abandoning twice is refused, not a second success', abandonTwice.json?.reason === 'tag-absent' && abandonTwice.code === 2,
  `exit ${abandonTwice.code} ${abandonTwice.stdout}`)

// The read above is not the whole guard. Between the receipt check and the delete, the tag can
// change, and the lease is what catches that: it names the receipt again so the remote rechecks
// and answers `[rejected] (stale info)`. Without it, this case deletes a claim it never owned.
const ISSUE_LEASE = 17
const ambushAbandon = join(tmp, 'ambush-abandon')
execFileSync('git', ['clone', '-q', origin, ambushAbandon], { env: gitEnv })
const leaseClaim = claim(ambushAbandon, 'acquire', String(ISSUE_LEASE))
check('a claim is taken for the lease case', leaseClaim.json?.result === 'acquired', leaseClaim.stdout)
arm(ambushAbandon, ISSUE_LEASE, decoySha, 1)
const leaseRefused = claim(ambushAbandon, 'abandon', String(ISSUE_LEASE), String(leaseClaim.json?.sha))
check('a tag swapped after the receipt check is not deleted', tagOnOrigin(ISSUE_LEASE) === decoySha, String(tagOnOrigin(ISSUE_LEASE)))
check('and the caller is told the outcome is unknown, not abandoned', leaseRefused.json?.result === 'unknown' && leaseRefused.code === 4,
  `exit ${leaseRefused.code} ${leaseRefused.stdout}`)
check('and it reports the object now sitting there', leaseRefused.json?.found === decoySha, leaseRefused.stdout)
dropTag(ISSUE_LEASE)

// ------------------------------------------------- the duplicate run the recheck closes
// The race a reviewer walked through. B finishes its scan and finds the issue clear, then stalls
// before its push. A takes the claim, publishes, and releases. B's delayed push now creates the
// tag fresh and reads as a clean acquire, because there is nothing left on the remote to argue
// with. Rechecking after the acquire is what catches it, and that recheck is race-free because B
// holds the tag while it runs: every new contender is blocked, and any earlier winner released
// only after its branch was visible. abandon is how B backs out.
console.log('\nthe replay: a contender that scanned clean, acquired late, and backed out')

const ISSUE_REPLAY = 16
const REPLAY_BRANCH = `feat/issue-${ISSUE_REPLAY}-thing`
const remoteRefsSeenBy = (dir) => {
  const r = spawnSync('git', ['-C', dir, 'ls-remote', 'origin'], { encoding: 'utf8', env: gitEnv })
  return (r.stdout ?? '').split('\n').map((l) => l.split('\t')[1]).filter((x) => x !== undefined && x !== '')
}
// What the stage's server-side scan for one issue sees: the claim tag, and any branch named for
// the issue. Asking the server is the point; a stale clone's own refs would not do.
const scanForIssue = (dir, issue) => remoteRefsSeenBy(dir)
  .filter((ref) => ref === tagRef(issue) || new RegExp(`^refs/heads/(feat|fix|chore)/issue-${issue}-`).test(ref))
const shaOfRemoteRef = (dir, ref) => {
  const r = spawnSync('git', ['-C', dir, 'ls-remote', 'origin', ref], { encoding: 'utf8', env: gitEnv })
  const match = (r.stdout ?? '').split('\n').map((l) => l.split('\t')).find((p) => p[1] === ref)
  return match ? match[0] : null
}

// 1. B scans, and the issue is clear. B then stalls before its push.
check('B\'s pre-acquire scan finds the issue clear', scanForIssue(b, ISSUE_REPLAY).length === 0, JSON.stringify(scanForIssue(b, ISSUE_REPLAY)))

// 2. A runs the whole protocol while B is stalled: acquire, publish, release.
const aAcquire = claim(a, 'acquire', String(ISSUE_REPLAY))
check('A acquires the claim', aAcquire.json?.result === 'acquired' && aAcquire.code === 0, aAcquire.stdout)
writeFileSync(join(a, 'replay.txt'), 'A did the work\n')
git(a, 'add', 'replay.txt')
git(a, 'commit', '-q', '-m', 'A did the work')
const aBranchSha = git(a, 'rev-parse', 'HEAD')
git(a, 'push', '-q', 'origin', `HEAD:refs/heads/${REPLAY_BRANCH}`)
const aRelease = claim(a, 'release', String(ISSUE_REPLAY), REPLAY_BRANCH, aBranchSha)
check('A publishes its branch and releases the claim', aRelease.json?.result === 'released' && aRelease.code === 0, aRelease.stdout)
check('so the claim tag is gone before B\'s push lands', tagOnOrigin(ISSUE_REPLAY) === null, String(tagOnOrigin(ISSUE_REPLAY)))

// 3. B's delayed push. Nothing is left to collide with, so B genuinely acquires. This is the
//    duplicate run: on B's stale scan alone, it would now start work A already finished.
const bAcquire = claim(b, 'acquire', String(ISSUE_REPLAY))
check('B\'s delayed acquire succeeds, because the tag is absent again', bAcquire.json?.result === 'acquired' && bAcquire.code === 0, bAcquire.stdout)
check('and B holds a fresh claim on the remote', tagOnOrigin(ISSUE_REPLAY) === bAcquire.json?.sha, String(tagOnOrigin(ISSUE_REPLAY)))

// 4. The recheck B performs while holding the tag. It finds A's branch, which B's first scan
//    could not have seen because A had not pushed it yet.
const bRecheck = scanForIssue(b, ISSUE_REPLAY)
check('B\'s post-acquire recheck finds A\'s branch', bRecheck.includes(`refs/heads/${REPLAY_BRANCH}`), JSON.stringify(bRecheck))
check('and the only claim tag it sees is B\'s own', bRecheck.filter((r) => r === tagRef(ISSUE_REPLAY)).length === 1, JSON.stringify(bRecheck))

// 5. B backs out with the receipt its own acquire handed it.
const bAbandon = claim(b, 'abandon', String(ISSUE_REPLAY), String(bAcquire.json?.sha))
check('B abandons the claim it just took', bAbandon.json?.result === 'abandoned' && bAbandon.code === 0,
  `exit ${bAbandon.code} ${bAbandon.stdout}${bAbandon.stderr}`)
check('the claim tag is gone', tagOnOrigin(ISSUE_REPLAY) === null, String(tagOnOrigin(ISSUE_REPLAY)))
check('A\'s branch is untouched, at the head A pushed', shaOfRemoteRef(b, `refs/heads/${REPLAY_BRANCH}`) === aBranchSha,
  String(shaOfRemoteRef(b, `refs/heads/${REPLAY_BRANCH}`)))

// 6. B's whole remote footprint was the tag, and the tag is gone. B pushed no branch of its own,
//    which is the local half of "B never assigned, labelled or commented": its sequence ended at
//    abandon, so nothing downstream of the recheck ever ran.
const afterReplay = scanForIssue(b, ISSUE_REPLAY)
check('the issue is left holding A\'s branch and nothing of B\'s',
  afterReplay.length === 1 && afterReplay[0] === `refs/heads/${REPLAY_BRANCH}`, JSON.stringify(afterReplay))

// ---------------------------------------------------------- unreachable and unreadable
console.log('\nan unreachable remote is unknown: never held, never acquired')

const unreachable = claim(gone, 'acquire', '6')
check('acquire against a remote that is not there is unknown', unreachable.json?.result === 'unknown' && unreachable.code === 4,
  `exit ${unreachable.code} ${unreachable.stdout}${unreachable.stderr}`)
check('it does not claim the issue is held', unreachable.json?.result !== 'held', unreachable.stdout)
check('it does not claim the issue was acquired', unreachable.json?.result !== 'acquired', unreachable.stdout)
check('it pushed nothing: the remote still has no such tag', tagOnOrigin(6) === mainSha, String(tagOnOrigin(6)))
check('it tells a human not to start work on it', unreachable.stderr.includes('Do not start work'), unreachable.stderr)

// The identity is derived the way land-merge derives it: the host is kept, so two forks with the
// same owner/name on different hosts do not read as one repository. Port 1 on the loopback is a
// refused connection, so this reaches nothing.
git(gone, 'remote', 'set-url', 'origin', 'https://127.0.0.1:1/jakub/marketplace-plugins.git')
const hostQualified = claim(gone, 'acquire', '6')
check('a host URL remote is reported host-qualified', hostQualified.json?.repo === '127.0.0.1/jakub/marketplace-plugins', hostQualified.stdout)
check('and an unreachable host is still unknown', hostQualified.json?.result === 'unknown' && hostQualified.code === 4, `exit ${hostQualified.code} ${hostQualified.stdout}`)

const noRemote = join(tmp, 'no-remote')
mkdirSync(noRemote)
execFileSync('git', ['init', '-q', '-b', 'main', noRemote], { env: gitEnv })
const remoteless = claim(noRemote, 'acquire', '6')
check('a directory with no origin remote is refused', remoteless.json?.reason === 'no-origin' && remoteless.code === 2, `exit ${remoteless.code} ${remoteless.stdout}`)

// ------------------------------------------------- reading and writing one repository
console.log('\na remote that reads from one repository and pushes to another is refused')

const ISSUE_DIVERGED = 11
const divergedAcquire = claim(diverged, 'acquire', String(ISSUE_DIVERGED))
check('acquire refuses a divergent pushurl', divergedAcquire.json?.result === 'refused' && divergedAcquire.code === 2,
  `exit ${divergedAcquire.code} ${divergedAcquire.stdout}`)
check('and names the mismatch', divergedAcquire.json?.reason === 'push-fetch-mismatch', divergedAcquire.stdout)
check('nothing landed in the repository it reads from', tagOnOrigin(ISSUE_DIVERGED) === null, String(tagOnOrigin(ISSUE_DIVERGED)))
check('and nothing landed in the one it would have pushed to', tagIn(elsewhere, ISSUE_DIVERGED) === null, String(tagIn(elsewhere, ISSUE_DIVERGED)))

const divergedRelease = claim(diverged, 'release', String(ISSUE_DIVERGED), 'feat/issue-11-thing', workSha)
check('release refuses a divergent pushurl too', divergedRelease.json?.reason === 'push-fetch-mismatch' && divergedRelease.code === 2,
  `exit ${divergedRelease.code} ${divergedRelease.stdout}`)
const divergedAbandon = claim(diverged, 'abandon', String(ISSUE_DIVERGED), workSha)
check('abandon refuses a divergent pushurl as well', divergedAbandon.json?.reason === 'push-fetch-mismatch' && divergedAbandon.code === 2,
  `exit ${divergedAbandon.code} ${divergedAbandon.stdout}`)

// A pushurl equal to the fetch URL is not a divergence, so the check has to let it through.
git(diverged, 'config', 'remote.origin.pushurl', origin)
const convergedAcquire = claim(diverged, 'acquire', String(ISSUE_DIVERGED))
check('a pushurl equal to the fetch URL is not a mismatch', convergedAcquire.json?.result === 'acquired' && convergedAcquire.code === 0,
  `exit ${convergedAcquire.code} ${convergedAcquire.stdout}`)
dropTag(ISSUE_DIVERGED)

// Two push URLs means the tag lands in two repositories, which is the same problem.
git(diverged, 'config', '--add', 'remote.origin.pushurl', elsewhere)
const twoPushUrls = claim(diverged, 'acquire', String(ISSUE_DIVERGED))
check('two push URLs on origin is refused', twoPushUrls.json?.reason === 'push-fetch-mismatch' && twoPushUrls.code === 2,
  `exit ${twoPushUrls.code} ${twoPushUrls.stdout}`)
check('and still nothing landed anywhere', tagOnOrigin(ISSUE_DIVERGED) === null && tagIn(elsewhere, ISSUE_DIVERGED) === null, 'a tag landed')

// ------------------------------------------------------------- credentials in a remote URL
console.log('\nnothing it prints carries a credential out of the remote URL')

const leaky = claim(creds, 'acquire', '12')
const leakyOutput = leaky.stdout + leaky.stderr
check('the identity is host and path, with the userinfo dropped', leaky.json?.repo === '127.0.0.1/jakub/marketplace-plugins', leaky.json?.repo)
check('the token appears nowhere in stdout or stderr', !leakyOutput.includes(PAT), 'the token was printed')
check('the username appears nowhere either', !leakyOutput.includes(PAT_USER), 'the username was printed')

// The same URL with a query string on the end, which is where the land-merge regexes safeIdentity
// replaced would have kept ?redirect=1 in the identity. There is no second parser to fall back to
// here: every URL with a scheme goes through new URL(), and a query lands in .search, which
// safeIdentity never reads. So this takes the same branch as the case above and answers the same.
git(creds, 'remote', 'set-url', 'origin', `https://${PAT_USER}:${PAT}@127.0.0.1:1/jakub/marketplace-plugins.git?redirect=1`)
const leakyOdd = claim(creds, 'acquire', '12')
const leakyOddOutput = leakyOdd.stdout + leakyOdd.stderr
check('a query string is dropped from the identity, not carried into it', leakyOdd.json?.repo === '127.0.0.1/jakub/marketplace-plugins', leakyOdd.json?.repo)
check('and still prints no token', !leakyOddOutput.includes(PAT) && !leakyOddOutput.includes(PAT_USER), 'a credential was printed')

// A shape nothing can parse becomes a fixed placeholder rather than the bytes that came back.
git(creds, 'remote', 'set-url', 'origin', `${PAT_USER}@${PAT}`)
const unparseable = claim(creds, 'acquire', '12')
check('an unparseable origin reports the placeholder', unparseable.json?.repo === 'unparseable-origin', unparseable.json?.repo)
check('and prints none of the raw value', !(unparseable.stdout + unparseable.stderr).includes(PAT), 'the raw value was printed')

// -------------------------------------------------------------------------- usage
console.log('\nthings it refuses before touching the remote')

const notANumber = claim(a, 'acquire', 'twelve')
check('an issue number that is not a number exits 2', notANumber.json?.reason === 'usage' && notANumber.code === 2, `exit ${notANumber.code} ${notANumber.stdout}`)
const zero = claim(a, 'acquire', '0')
check('issue 0 exits 2', zero.json?.reason === 'usage' && zero.code === 2, `exit ${zero.code} ${zero.stdout}`)
const negative = claim(a, 'acquire', '-3')
check('a negative issue number exits 2', negative.json?.reason === 'usage' && negative.code === 2, `exit ${negative.code} ${negative.stdout}`)
const twoArgs = claim(a, 'acquire', '6', '--force')
check('a second argument to acquire exits 2', twoArgs.json?.reason === 'usage' && twoArgs.code === 2, `exit ${twoArgs.code} ${twoArgs.stdout}`)
const noSubcommand = claim(a)
check('no subcommand exits 2', noSubcommand.json?.reason === 'usage' && noSubcommand.code === 2, `exit ${noSubcommand.code} ${noSubcommand.stdout}`)
const notASubcommand = claim(a, 'break')
check('a subcommand that is not acquire or release exits 2', notASubcommand.json?.reason === 'usage' && notASubcommand.code === 2, `exit ${notASubcommand.code} ${notASubcommand.stdout}`)
const shortRelease = claim(a, 'release', '8', BRANCH)
check('release without a head SHA exits 2', shortRelease.json?.reason === 'usage' && shortRelease.code === 2, `exit ${shortRelease.code} ${shortRelease.stdout}`)
const badBranch = claim(a, 'release', '8', '--all', workSha)
check('a branch name that is not a branch name exits 2', badBranch.json?.reason === 'usage' && badBranch.code === 2, `exit ${badBranch.code} ${badBranch.stdout}`)
const help = claim(a, '--help')
check('--help exits 0 with the usage text', help.code === 0 && help.stdout.includes('issue-claim.mjs acquire'), `exit ${help.code}`)

// Read from the source, not from behaviour: a bare force flag added later would make the one
// atomic operation this program rests on into an overwrite, and no case above would necessarily
// fail. The comments discuss force flags on purpose, and one of them quotes git-guard's
// `--force(?!-with-lease)` pattern, so these read code with the comments removed.
console.log('\nnothing in the source overwrites a ref')
const sourceText = readFileSync(SCRIPT, 'utf8')
const codeOnly = sourceText
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n')
const argvTokens = [...codeOnly.matchAll(/'([^'\n]*)'/g)].map((m) => m[1])
const bareForce = [...codeOnly.matchAll(/--force(?!-with-lease)/g)].map((m) => m[0])
check('no bare --force anywhere in the code', bareForce.length === 0, JSON.stringify(bareForce))
check('no -f argv token', !argvTokens.includes('-f'), "found '-f'")
check('no + refspec anywhere in the code', !/[`']\+refs\//.test(codeOnly), 'found a + refspec')
// The one lease is a compare-and-delete, not a force: it pins the delete to the tag ref and the
// receipt the caller was handed. An unpinned lease, or one pinned to anything else, would turn
// abandon into a stale-tag breaker, which is the thing its header says it must never become.
// Anchored on the opening quote, so this counts argv tokens and not the usage text, which
// describes the lease in a sentence.
const leases = [...codeOnly.matchAll(/[`'](--force-with-lease[^`'\s]*)/g)].map((m) => m[1])
check('the only lease is abandon\'s, pinned to the claim ref and the receipt',
  leases.length === 1 && leases[0] === '--force-with-lease=${ref}:${receipt}', JSON.stringify(leases))
check('the push refspecs are a plain create and a plain delete',
  /`\$\{source\}:\$\{ref\}`/.test(sourceText) && /`:\$\{ref\}`/.test(sourceText), 'refspec shapes changed')
// The catch-up fetch writes one ref, and it is ours. A + here, or a destination under
// refs/heads or refs/remotes, would make a read-only catch-up into something that edits the
// clone the human is working in.
check('the fetch refspec is unforced and lands under refs/flow-claim',
  /`\$\{MAIN_REF\}:\$\{tempRef\}`/.test(sourceText) && /const tempRef = `refs\/flow-claim\//.test(sourceText), 'fetch refspec shape changed')
// abandon's delete has to survive the hook layer as well as the remote. git-guard denies force
// pushes by spelling, `--force(?!-with-lease)`, so the lease is allowed by design rather than by
// luck. If that pattern is ever tightened to cover every force spelling, abandon breaks at the
// hook and nothing else here would notice, so the guard is driven with the real command.
const guardVerdict = (command) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'hooks', 'scripts', 'git-guard.mjs')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', env: gitEnv,
  })
  return /"permissionDecision"\s*:\s*"deny"/.test(r.stdout ?? '') ? 'deny' : 'allow'
}
const leaseCommand = `git push --porcelain --force-with-lease=${tagRef(15)}:${'a'.repeat(40)} origin :${tagRef(15)}`
check('git-guard allows abandon\'s lease delete', guardVerdict(leaseCommand) === 'allow', guardVerdict(leaseCommand))
check('and still denies a bare force-push, so that is not a permissive guard',
  guardVerdict('git push --force origin main') === 'deny' && guardVerdict('git push -f origin main') === 'deny',
  'git-guard stopped denying bare force')
check('the fetch cannot move a remote-tracking ref or write FETCH_HEAD',
  argvTokens.includes('--refmap=') && argvTokens.includes('--no-write-fetch-head') && argvTokens.includes('--no-tags'),
  'a fetch containment flag went missing')

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nissue claim: ALL PASS' : `\nissue claim: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
