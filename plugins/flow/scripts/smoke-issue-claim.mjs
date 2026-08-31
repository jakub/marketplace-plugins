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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 * Install the ambush on a clone: an upload-pack wrapper that creates `tag` at `sha` on the bare
 * repository immediately after its second invocation. The program's second read is the tag
 * preflight, so it sees an absent tag and then pushes into a tag that exists.
 */
const arm = (clone, issue, sha) => {
  const counter = join(clone, 'invocations')
  const wrapper = join(clone, 'upload-pack-wrapper.sh')
  writeFileSync(wrapper, [
    '#!/bin/sh',
    `n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)`,
    'n=$((n+1))',
    `printf '%s' "$n" > ${JSON.stringify(counter)}`,
    'git upload-pack "$@"',
    'status=$?',
    `if [ "$n" = "2" ]; then git -C ${JSON.stringify(origin)} update-ref ${JSON.stringify(tagRef(issue))} ${JSON.stringify(sha)}; fi`,
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

// The strict parser rejects this shape because of the query string, so the answer comes from the
// sanitizing fallback instead. Same identity, same absence of the token.
git(creds, 'remote', 'set-url', 'origin', `https://${PAT_USER}:${PAT}@127.0.0.1:1/jakub/marketplace-plugins.git?redirect=1`)
const leakyOdd = claim(creds, 'acquire', '12')
const leakyOddOutput = leakyOdd.stdout + leakyOdd.stderr
check('a URL the strict parser rejects still reports host and path', leakyOdd.json?.repo === '127.0.0.1/jakub/marketplace-plugins', leakyOdd.json?.repo)
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

// Read from the source, not from behaviour: a force flag added later would make the one atomic
// operation this program rests on into an overwrite, and no case above would necessarily fail.
console.log('\nnothing in the source can force-push or break a tag')
const source = readFileSync(SCRIPT, 'utf8')
const argvTokens = [...source.matchAll(/'([^'\n]*)'/g)].map((m) => m[1])
const forceTokens = argvTokens.filter((t) => /^(--force(-with-lease)?(=.*)?|-f|\+refs\/.*)$/.test(t))
check('no --force, -f or + refspec appears as an argv token', forceTokens.length === 0, JSON.stringify(forceTokens))
check('no force-with-lease anywhere in the file', !source.includes('force-with-lease'), 'found force-with-lease')
check('the push refspecs are a plain create and a plain delete', /`\$\{mainSha\}:\$\{ref\}`/.test(source) && /`:\$\{ref\}`/.test(source), 'refspec shapes changed')

rmSync(tmp, { recursive: true, force: true })
console.log(bad === 0 ? '\nissue claim: ALL PASS' : `\nissue claim: ${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
