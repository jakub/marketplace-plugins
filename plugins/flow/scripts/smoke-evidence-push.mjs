#!/usr/bin/env node
// Smoke for scripts/evidence-push.mjs, run as a child process the way an agent runs it.
//
// Git is real: the world is a bare origin at git@github.com:jakub/demo.git, reached through a
// GIT_SSH_COMMAND shim that serves it from disk, and a clone of it. The bare repository logs every
// ref update, so its reflog shows whether any update to flow-evidence was not a fast-forward. A
// `git` wrapper first on the executor's PATH records every git command it runs before handing it
// to the real git, so each push's arguments can be checked for a force. The ssh shim can plant a
// rival commit on flow-evidence the moment a push connects, after the executor's fetch and before
// origin answers, which is exactly a concurrent run winning the race. A reference-transaction hook
// in origin can do the same just after origin commits this run's push, and can kill receive-pack
// before it reports, so the push's answer is lost after it landed; and the shim can fail origin's
// reads after a push, so a landed commit cannot be confirmed. GitHub is a fake `gh` that
// answers from a JSON state file and the bare repository, records every call, and fails any call
// not pinned to github.com/jakub/demo or made with GH_REPO or GH_HOST in its environment.
//
// Run: node plugins/flow/scripts/smoke-evidence-push.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXECUTOR = join(dirname(fileURLToPath(import.meta.url)), 'evidence-push.mjs')
let bad = 0
let checks = 0
const check = (name, ok, detail = '') => {
  checks += 1
  if (!ok) bad += 1
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${ok || !detail ? '' : ` -> ${detail}`}`)
}

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
const ZERO = /^0+$/

const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_GH_STATE
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
const argv = process.argv.slice(2)
st.calls.push(argv)
const save = () => fs.writeFileSync(file, JSON.stringify(st))
const out = (text) => { save(); process.stdout.write(text); process.exit(0) }
const fail = (m, counted = true) => { if (counted) st.unpinned = (st.unpinned || 0) + 1; save(); process.stderr.write('fake gh: ' + m + '\\n'); process.exit(1) }
if (process.env.GH_REPO || process.env.GH_HOST) fail('GH_REPO or GH_HOST reached gh')
const at = (flag) => argv[argv.indexOf(flag) + 1]
if (argv[0] === 'repo' && argv[1] === 'view') {
  if (argv[2] !== (st.host || 'github.com') + '/jakub/demo') fail('unpinned: ' + argv.join(' '))
  const fields = String(at('--json')).split(',')
  const all = { visibility: st.visibility, nameWithOwner: st.nameWithOwner || 'jakub/demo' }
  out(JSON.stringify(Object.fromEntries(fields.filter((f) => f in all).map((f) => [f, all[f]]))))
}
if (argv[0] === 'api') {
  if (at('--hostname') !== (st.host || 'github.com')) fail('api off the pin: ' + argv.join(' '))
  const m = String(argv.find((a) => a.startsWith('repos/'))).match(/^repos\\/jakub\\/demo\\/contents\\/([^?]+)\\?ref=([0-9a-f]+)$/)
  if (!m || at('--jq') !== '.sha') fail('unexpected api ' + argv.join(' '))
  // Over 1 MB, GitHub's contents API answers only the raw or object media type.
  if (at('-H') !== 'Accept: application/vnd.github.object+json') fail('contents read without the object media type: ' + argv.join(' '))
  const path = m[1].split('/').map(decodeURIComponent).join('/')
  st.contents.push({ path, ref: m[2] })
  if (st.contentsLie) out('f'.repeat(40) + '\\n')
  try {
    out(require('node:child_process').execFileSync(process.env.FAKE_REAL_GIT, ['--git-dir', st.origin, 'rev-parse', '--verify', m[2] + ':' + path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() + '\\n')
  } catch { fail('Not Found (HTTP 404)', false) }
}
fail('unexpected ' + argv.join(' '))
`

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-evidence-push-')))
const ident = { GIT_AUTHOR_NAME: 'h', GIT_AUTHOR_EMAIL: 'h@example.invalid', GIT_COMMITTER_NAME: 'h', GIT_COMMITTER_EMAIL: 'h@example.invalid' }
const baseEnv = { ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: join(tmp, 'none'), GIT_CONFIG_SYSTEM: join(tmp, 'none'), GIT_TERMINAL_PROMPT: '0' }
for (const key of ['GH_REPO', 'GH_HOST', 'FLOW_GH_HOSTS', ...Object.keys(ident)]) delete baseEnv[key]

/** One workspace: a bare origin, a clone with a configured user, the ssh shim, the git wrapper and a fake gh. */
const makeWorld = (state = {}) => {
  const workspace = join(tmp, 'ws')
  const base = join(workspace, '.base')
  const origin = join(base, 'jakub', 'demo.git')
  const repo = join(workspace, 'demo')
  const bin = join(workspace, '.bin')
  for (const d of [join(base, 'jakub'), bin]) mkdirSync(d, { recursive: true })
  const log = join(workspace, 'git.log')
  const race = join(workspace, 'race')
  const failReads = join(workspace, 'fail-reads')
  const hookMode = join(workspace, 'hook-mode')
  const preMode = join(workspace, 'pre-mode')
  writeFileSync(log, '')
  writeFileSync(race, '0')
  // A rival run's commit on flow-evidence: origin's tree plus one file, parented on origin's tip.
  const rival = join(bin, 'rival.sh')
  writeFileSync(rival, `#!/bin/sh
set -e
export GIT_AUTHOR_NAME=rival GIT_AUTHOR_EMAIL=r@example.invalid GIT_COMMITTER_NAME=rival GIT_COMMITTER_EMAIL=r@example.invalid SMOKE_RIVAL=1
unset GIT_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_QUARANTINE_PATH GIT_INDEX_FILE
G="${REAL_GIT} --git-dir=${origin}"
idx=${workspace}/rival.index
rm -f "$idx"
tip=$($G rev-parse --verify --quiet refs/heads/flow-evidence || true)
if [ -n "$tip" ]; then GIT_INDEX_FILE=$idx $G read-tree "$tip"; else GIT_INDEX_FILE=$idx $G read-tree --empty; fi
k=$(cat ${workspace}/rivals 2>/dev/null || echo 0); k=$((k + 1)); echo $k > ${workspace}/rivals
blob=$(printf 'rival %s' $k | $G hash-object -w --stdin)
GIT_INDEX_FILE=$idx $G update-index --add --cacheinfo 100644 "$blob" "pr-99/rival-$k.png"
tree=$(GIT_INDEX_FILE=$idx $G write-tree)
if [ -n "$tip" ]; then c=$($G commit-tree "$tree" -p "$tip" -m "rival $k"); else c=$($G commit-tree "$tree" -m "rival $k"); fi
$G update-ref refs/heads/flow-evidence "$c"
echo "$c" >> ${workspace}/rival-commits
`)
  const ssh = join(bin, 'ssh')
  writeFileSync(ssh, `#!/bin/sh
cd ${base} || exit 1
for a; do last=$a; done
case "$last" in
  git-receive-pack*)
    if [ -f ${workspace}/drop-push ]; then echo 'fatal: smoke: the connection dropped' >&2; exit 1; fi
    if [ -f ${failReads} ]; then : > ${workspace}/pushed; echo 0 > ${workspace}/reads; fi
    n=$(cat ${race})
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > ${race}; ${rival} >/dev/null || exit 1; fi ;;
  git-upload-pack*)
    if [ -f ${workspace}/pushed ]; then
      k=$(($(cat ${workspace}/reads) + 1)); echo $k > ${workspace}/reads
      want=$(cat ${failReads})
      if [ "$want" = all ] || [ "$want" = "$k" ]; then echo 'fatal: smoke: origin is unreachable' >&2; exit 1; fi
    fi ;;
esac
exec /bin/sh -c "$last"
`)
  // Each push's exit code goes to push-exits and its stdout (the porcelain status) to push-out, so
  // a case can tell a lost answer from a clean one and read how a rejection was worded.
  writeFileSync(join(bin, 'git'), `#!/bin/sh
{ for a; do printf '%s\\037' "$a"; done; printf '\\n'; } >> ${log}
case " $* " in
  *" push "*) if [ -f ${workspace}/remote-failure ]; then
    # What git prints when receive-pack took the pack but never reported on the ref.
    for a; do last=$a; done
    printf 'To origin\n!\t%s\t[remote failure] (remote failed to report status)\nDone\n' "$last" | tee -a ${workspace}/push-out
    echo 1 >> ${workspace}/push-exits; exit 1
  fi ;;
esac
case " $* " in
  *" rev-list "*) if [ -f ${workspace}/fail-rev-list ]; then echo 'fatal: smoke: rev-list failed' >&2; exit 128; fi ;;
  *" push "*) out=$(${REAL_GIT} "$@"); s=$?; printf '%s\\n' "$out"; printf '%s\\n' "$out" >> ${workspace}/push-out; echo $s >> ${workspace}/push-exits; exit $s ;;
esac
exec ${REAL_GIT} "$@"
`)
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  for (const f of [rival, ssh, join(bin, 'git'), join(bin, 'gh')]) chmodSync(f, 0o755)
  const env = { ...baseEnv, GIT_SSH_COMMAND: ssh, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: join(workspace, '.gh.json'), FAKE_REAL_GIT: REAL_GIT }
  const hostEnv = { ...baseEnv, ...ident, GIT_SSH_COMMAND: ssh }
  const git = (dir, ...args) => execFileSync(REAL_GIT, ['-C', dir, ...args], { encoding: 'utf8', env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const og = (...args) => execFileSync(REAL_GIT, ['--git-dir', origin, ...args], { encoding: 'utf8', env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  execFileSync(REAL_GIT, ['init', '-q', '--bare', '-b', 'main', origin], { env: hostEnv })
  og('config', 'core.logAllRefUpdates', 'always')
  // One-shot, armed by writing hook-mode: once origin commits an update to flow-evidence, `rival`
  // fast-forwards a rival commit on top and `kill` kills receive-pack before it reports.
  const hook = join(origin, 'hooks', 'reference-transaction')
  writeFileSync(hook, `#!/bin/sh
[ "$1" = committed ] || exit 0
[ -z "$SMOKE_RIVAL" ] || exit 0
[ -f ${hookMode} ] || exit 0
grep -q ' refs/heads/flow-evidence$' || exit 0
mode=$(cat ${hookMode}); rm -f ${hookMode}
case "$mode" in *rival*) ${rival} >/dev/null 2>&1 ;; esac
case "$mode" in *kill*) kill -9 $PPID ;; esac
exit 0
`)
  chmodSync(hook, 0o755)
  // Armed by writing pre-mode: `rival` (one-shot) advances flow-evidence after origin advertised
  // its refs and received this push, so origin itself rejects the stale old value; `decline`
  // (until removed) refuses every push without moving anything.
  const preReceive = join(origin, 'hooks', 'pre-receive')
  writeFileSync(preReceive, `#!/bin/sh
cat >/dev/null
[ -f ${preMode} ] || exit 0
case "$(cat ${preMode})" in
  rival) rm -f ${preMode}; ${rival} >/dev/null 2>&1; exit 0 ;;
  decline) echo 'smoke: declined by policy' >&2; exit 1 ;;
esac
exit 0
`)
  chmodSync(preReceive, 0o755)
  execFileSync(REAL_GIT, ['init', '-q', '-b', 'main', repo], { env: hostEnv })
  git(repo, 'config', 'user.name', 'Configured User')
  git(repo, 'config', 'user.email', 'configured@example.invalid')
  writeFileSync(join(repo, 'README'), 'demo\n')
  git(repo, 'add', 'README')
  git(repo, 'commit', '-q', '-m', 'first')
  git(repo, 'remote', 'add', 'origin', 'git@github.com:jakub/demo.git')
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  writeFileSync(env.FAKE_GH_STATE, JSON.stringify({ calls: [], contents: [], origin, visibility: 'PUBLIC', ...state }))
  return { workspace, origin, repo, env, git, og, log, race, failReads, hookMode, preMode }
}

const w = makeWorld()
const files = join(tmp, 'files')
mkdirSync(join(files, 'one'), { recursive: true })
mkdirSync(join(files, 'two'), { recursive: true })
const file = (rel, content = rel) => { const p = join(files, rel); writeFileSync(p, content); return p }
const state = () => JSON.parse(readFileSync(w.env.FAKE_GH_STATE, 'utf8'))
const setState = (patch) => writeFileSync(w.env.FAKE_GH_STATE, JSON.stringify({ ...state(), ...patch }))
const gitLog = () => readFileSync(w.log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\x1f').slice(0, -1))
const lastPushExit = () => Number(readFileSync(join(w.workspace, 'push-exits'), 'utf8').trim().split('\n').at(-1))
const pushesIn = (lines) => lines.filter((args) => args.includes('push'))
const tipOf = () => { try { return w.og('rev-parse', '--verify', '--quiet', 'refs/heads/flow-evidence') } catch { return null } }
const blobAt = (rev, path) => { try { return w.og('rev-parse', '--verify', '--quiet', `${rev}:${path}`) } catch { return null } }
const run = (args, extra = {}) => {
  const logBefore = gitLog().length
  const callsBefore = state().calls.length
  const contentsBefore = state().contents.length
  // The timeout turns a hang, such as a blocking open, into a failed check instead of a stuck suite.
  const r = spawnSync(process.execPath, [EXECUTOR, ...args], { encoding: 'utf8', env: { ...w.env, ...extra }, timeout: 60_000 })
  let json = null
  try { json = JSON.parse(r.stdout) } catch {}
  const st = state()
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr, pushes: pushesIn(gitLog().slice(logBefore)), calls: st.calls.slice(callsBefore), contents: st.contents.slice(contentsBefore), st }
}
const push = (pr, paths, extra) => run([w.repo, '--pr', String(pr), ...paths], extra)
const detail = (r) => `${r.code} ${JSON.stringify(r.json)} ${r.stderr}`

console.log('the first push creates flow-evidence as an orphan root')
let first
{
  const headBefore = w.git(w.repo, 'rev-parse', 'HEAD')
  const a = file('one/a.png', 'png a v1')
  const r = push(7, [a])
  first = r.json?.commit
  check('exit 0, ok, on flow-evidence', r.code === 0 && r.json?.ok === true && r.json.branch === 'flow-evidence', detail(r))
  check('origin\'s flow-evidence is the commit', tipOf() === first, `${tipOf()} ${first}`)
  check('the commit has no parent', first && w.og('rev-list', '--parents', '-n', '1', first).split(' ').length === 1)
  check('pr-7/a.png holds the file\'s blob', r.json?.files?.[0]?.path === 'pr-7/a.png' && blobAt(first, 'pr-7/a.png') === r.json.files[0].blob && r.json.files[0].blob === w.git(w.repo, 'hash-object', a), JSON.stringify(r.json?.files))
  check('the tree holds only that file', first && w.og('ls-tree', '-r', '--name-only', first) === 'pr-7/a.png')
  check('the message is "evidence: #7 a.png", with no trailers', first && w.og('log', '-1', '--format=%B', first) === 'evidence: #7 a.png')
  check('author and committer are the repository\'s configured user', first && w.og('log', '-1', '--format=%an <%ae>|%cn <%ce>', first) === 'Configured User <configured@example.invalid>|Configured User <configured@example.invalid>')
  const url = `https://raw.githubusercontent.com/jakub/demo/${first}/pr-7/a.png`
  check('a PUBLIC repository gets a raw.githubusercontent.com URL pinned to the commit', r.json?.files?.[0]?.url === url, r.json?.files?.[0]?.url)
  check('and markdown ![a](url)', r.json?.files?.[0]?.markdown === `![a](${url})`, r.json?.files?.[0]?.markdown)
  check('one push, one contents read-back at the commit', r.pushes.length === 1 && r.contents.length === 1 && r.contents[0].path === 'pr-7/a.png' && r.contents[0].ref === first, JSON.stringify(r.contents))
  check('the checkout\'s HEAD, index and status are untouched', w.git(w.repo, 'rev-parse', 'HEAD') === headBefore && w.git(w.repo, 'status', '--porcelain') === '' && spawnSync(REAL_GIT, ['-C', w.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/flow-evidence']).status !== 0)
  check('no gh call off the pin', !r.st.unpinned, JSON.stringify(r.calls))
}

console.log('a second push fast-forwards and keeps the first file')
let second
{
  const b = file('one/b.png', 'png b v1')
  const r = push(7, [b])
  second = r.json?.commit
  check('exit 0, ok', r.code === 0 && r.json?.ok === true, detail(r))
  check('its parent is the first commit', second && w.og('rev-parse', `${second}^`) === first)
  check('pr-7/a.png is still there, and pr-7/b.png joins it', second && w.og('ls-tree', '-r', '--name-only', second) === 'pr-7/a.png\npr-7/b.png')
  check('origin is at the second commit', tipOf() === second)
}

console.log('a same-named file replaces the old one, and the old URL still pins the old blob')
{
  const oldBlob = blobAt(first, 'pr-7/a.png')
  const a2 = file('two/a.png', 'png a v2')
  const r = push(7, [a2])
  const c = r.json?.commit
  check('exit 0, ok', r.code === 0 && r.json?.ok === true, detail(r))
  check('pr-7/a.png now holds the new blob', c && blobAt(c, 'pr-7/a.png') === r.json.files[0].blob && r.json.files[0].blob !== oldBlob)
  check('the first commit still holds the old one', blobAt(first, 'pr-7/a.png') === oldBlob)
  check('and pr-7/b.png survives', c && blobAt(c, 'pr-7/b.png') === blobAt(second, 'pr-7/b.png'))
}

console.log('two files in one push read back one at a time')
{
  const r = push(8, [file('one/c d.png', 'png c'), file('one/e.webp', 'webp e')])
  const c = r.json?.commit
  check('exit 0, ok', r.code === 0 && r.json?.ok === true, detail(r))
  check('one contents read-back per file, each at the commit', r.contents.length === 2 && r.contents.every((x) => x.ref === c) && r.contents.map((x) => x.path).join() === 'pr-8/c d.png,pr-8/e.webp', JSON.stringify(r.contents))
  check('the message joins the basenames with ", "', c && w.og('log', '-1', '--format=%B', c) === 'evidence: #8 c d.png, e.webp')
  check('a space is percent-encoded in the URL', r.json?.files?.[0]?.url === `https://raw.githubusercontent.com/jakub/demo/${c}/pr-8/c%20d.png`, r.json?.files?.[0]?.url)
}

console.log('a concurrent update between fetch and push is retried on the new tip')
{
  const before = tipOf()
  writeFileSync(w.race, '1')
  const r = push(9, [file('one/f.png', 'png f')])
  const c = r.json?.commit
  const rival = readFileSync(join(w.workspace, 'rival-commits'), 'utf8').trim().split('\n').at(-1)
  check('exit 0, ok after the retry', r.code === 0 && r.json?.ok === true, detail(r))
  check('two pushes went out', r.pushes.length === 2, JSON.stringify(r.pushes))
  check('the rival commit landed on the old tip', w.og('rev-parse', `${rival}^`) === before)
  check('and this run\'s commit sits on the rival, so both survive', c && w.og('rev-parse', `${c}^`) === rival && tipOf() === c)
  check('the rival\'s file and this run\'s are both in the tree', c && blobAt(c, 'pr-99/rival-1.png') !== null && blobAt(c, 'pr-9/f.png') !== null)
}

console.log('three lost races refuse')
{
  writeFileSync(w.race, '5')
  const r = push(10, [file('one/g.png', 'png g')])
  writeFileSync(w.race, '0')
  check('exit 1, ok false, naming the three attempts', r.code === 1 && r.json?.ok === false && r.json.reason.includes('each of 3 pushes'), detail(r))
  check('exactly three pushes went out', r.pushes.length === 3, String(r.pushes.length))
  check('and none of them landed', blobAt(tipOf(), 'pr-10/g.png') === null && r.contents.length === 0)
}

console.log('the URL shape follows the visibility')
for (const visibility of ['PRIVATE', 'INTERNAL']) {
  setState({ visibility })
  const r = push(11, [file(`one/${visibility.toLowerCase()}.jpg`, visibility)])
  const c = r.json?.commit
  const url = `https://github.com/jakub/demo/raw/${c}/pr-11/${visibility.toLowerCase()}.jpg`
  check(`${visibility}: a github.com /raw/ URL pinned to the commit`, r.code === 0 && r.json?.files?.[0]?.url === url && r.json.files[0].markdown === `![${visibility.toLowerCase()}](${url})`, detail(r))
}
setState({ visibility: 'PUBLIC' })

console.log('an enterprise host allowlisted through FLOW_GH_HOSTS gets its own /raw/ URLs')
{
  const host = 'github.internal.example'
  w.git(w.repo, 'remote', 'set-url', 'origin', `git@${host}:jakub/demo.git`)
  setState({ host })
  for (const visibility of ['PUBLIC', 'PRIVATE']) {
    setState({ visibility })
    const name = `ghe-${visibility.toLowerCase()}.png`
    const r = push(14, [file(`one/${name}`, name)], { FLOW_GH_HOSTS: host })
    const c = r.json?.commit
    const url = `https://${host}/jakub/demo/raw/${c}/pr-14/${name}`
    check(`${visibility}: ${url.replace(c, '<commit>')}`, r.code === 0 && r.json?.files?.[0]?.url === url && r.json.files[0].markdown === `![ghe-${visibility.toLowerCase()}](${url})`, detail(r))
    check(`${visibility}: neither github.com nor raw.githubusercontent.com appears`, r.code === 0 && !/github\.com|githubusercontent/.test(r.stdout ?? JSON.stringify(r.json)), JSON.stringify(r.json))
    check(`${visibility}: every gh call pinned to ${host}`, !r.st.unpinned && r.calls.length > 0, JSON.stringify(r.calls))
  }
  w.git(w.repo, 'remote', 'set-url', 'origin', 'git@github.com:jakub/demo.git')
  setState({ host: 'github.com', visibility: 'PUBLIC' })
}

console.log('characters that would end a markdown link are percent-encoded')
{
  const names = ['shot).png', 'a(b.png', "it's.png", 'wow!.png', 'star*.png']
  const want = { 'shot).png': 'shot%29.png', 'a(b.png': 'a%28b.png', "it's.png": 'it%27s.png', 'wow!.png': 'wow%21.png', 'star*.png': 'star%2A.png' }
  mkdirSync(join(files, 'odd'), { recursive: true })
  const r = push(15, names.map((n) => file(`odd/${n}`, n)))
  const c = r.json?.commit
  check('exit 0, ok, every file read back', r.code === 0 && r.json?.ok === true && r.contents.length === names.length && r.contents.map((x) => x.path).join('|') === names.map((n) => `pr-15/${n}`).join('|'), detail(r))
  for (const [i, n] of names.entries()) {
    const f = r.json?.files?.[i]
    const url = `https://raw.githubusercontent.com/jakub/demo/${c}/pr-15/${want[n]}`
    const dest = f?.markdown?.slice(f.markdown.indexOf('](') + 2, -1)
    check(`${n}: the URL holds ${want[n]}`, f?.url === url, f?.url)
    check(`${n}: the markdown destination is that URL, with no raw parenthesis`, dest === url && !/[()]/.test(dest) && f.markdown.endsWith(`](${url})`), f?.markdown)
  }
}

console.log('a lost push answer, with a rival commit fast-forwarded on top, still counts as landed')
{
  writeFileSync(w.hookMode, 'rival kill')
  const before = tipOf()
  const r = push(16, [file('one/lost.png', 'png lost')])
  const c = r.json?.commit
  const rival = readFileSync(join(w.workspace, 'rival-commits'), 'utf8').trim().split('\n').at(-1)
  check('one push went out, and it landed', r.pushes.length === 1 && c && w.og('rev-parse', `${c}^`) === before, `${r.pushes.length} ${detail(r)}`)
  check('and its answer was lost: the push exited non-zero', lastPushExit() !== 0, String(lastPushExit()))
  check('origin moved on to a rival commit on top of it', tipOf() === rival && w.og('rev-parse', `${rival}^`) === c, `${tipOf()} ${rival}`)
  check('exit 0, ok, with the original commit, read back at it', r.code === 0 && r.json?.ok === true && r.contents.length === 1 && r.contents[0].ref === c, detail(r))
}

console.log('a read-back fetch that fails after a push landed under a rival refuses with landed: unknown')
{
  writeFileSync(w.hookMode, 'rival')
  writeFileSync(w.failReads, '2')
  const before = tipOf()
  const r = push(17, [file('one/unread.png', 'png unread')])
  for (const f of [w.failReads, join(w.workspace, 'pushed'), join(w.workspace, 'reads')]) rmSync(f, { force: true })
  const landed = w.og('rev-parse', `${tipOf()}^`)
  check('the push itself answered cleanly', lastPushExit() === 0, String(lastPushExit()))
  check('the push landed, under a rival commit', w.og('rev-parse', `${landed}^`) === before && blobAt(landed, 'pr-17/unread.png') !== null)
  check('exit 1, ok false, landed: "unknown", carrying the landed commit', r.code === 1 && r.json?.ok === false && r.json.landed === 'unknown' && r.json.commit === landed, detail(r))
  check('and the read that failed is the fetch', r.json?.reason?.includes('git fetch origin flow-evidence failed'), r.json?.reason)
  check('and no contents read-back ran', r.contents.length === 0, JSON.stringify(r.contents))
}

console.log('a lost push answer with origin unreadable refuses with landed: unknown')
{
  writeFileSync(w.hookMode, 'kill')
  writeFileSync(w.failReads, 'all')
  const r = push(18, [file('one/dark.png', 'png dark')])
  for (const f of [w.failReads, join(w.workspace, 'pushed'), join(w.workspace, 'reads')]) rmSync(f, { force: true })
  const pushed = r.pushes[0]?.at(-1)?.split(':')[0]
  check('one push went out, and origin holds it', r.pushes.length === 1 && tipOf() === pushed, `${r.pushes.length} ${tipOf()} ${pushed}`)
  check('and its answer was lost: the push exited non-zero', lastPushExit() !== 0, String(lastPushExit()))
  check('exit 1, ok false, landed: "unknown", commit is the attempted commit', r.code === 1 && r.json?.ok === false && r.json.landed === 'unknown' && r.json.commit === pushed, detail(r))
}

console.log('a rival that lands after the advertisement is retried, whatever git calls the rejection')
{
  const before = tipOf()
  writeFileSync(w.preMode, 'rival')
  const r = push(19, [file('one/late.png', 'png late')])
  const c = r.json?.commit
  const rival = readFileSync(join(w.workspace, 'rival-commits'), 'utf8').trim().split('\n').at(-1)
  const exits = readFileSync(join(w.workspace, 'push-exits'), 'utf8').trim().split('\n').slice(-2).map(Number)
  check('two pushes went out, the first refused by origin itself', r.pushes.length === 2 && exits[0] !== 0 && exits[1] === 0, `${r.pushes.length} ${exits}`)
  check('the rival landed on the old tip', w.og('rev-parse', `${rival}^`) === before)
  check('exit 0, ok, with this run\'s commit on top of the rival', r.code === 0 && r.json?.ok === true && c && w.og('rev-parse', `${c}^`) === rival && tipOf() === c, detail(r))
  const k = readFileSync(join(w.workspace, 'rivals'), 'utf8').trim()
  check('both files are on origin', c && blobAt(c, `pr-99/rival-${k}.png`) !== null && blobAt(c, 'pr-19/late.png') !== null)
  const said = readFileSync(join(w.workspace, 'push-out'), 'utf8').split('\n').filter((l) => l.startsWith('!\t'))
  console.log(`    first push: ${JSON.stringify(said.at(-1))}`)
  check('the first push was a remote rejection, not a client-side non-fast-forward', /\[remote rejected\]/.test(said.at(-1) ?? '') && !/non-fast-forward|fetch first/.test(said.at(-1) ?? ''), JSON.stringify(said))
}

console.log('a remote rejection that leaves the tip alone refuses without a retry')
{
  const before = tipOf()
  writeFileSync(w.preMode, 'decline')
  const r = push(20, [file('one/declined.png', 'png declined')])
  rmSync(w.preMode, { force: true })
  check('exit 1, ok false, "did not land"', r.code === 1 && r.json?.ok === false && r.json.reason.includes('did not land'), detail(r))
  check('exactly one push went out', r.pushes.length === 1, String(r.pushes.length))
  check('origin unmoved', tipOf() === before)
}

console.log('refusals before any push')
{
  const good = file('one/ok.png', 'png ok')
  const svg = file('one/x.svg', '<svg/>')
  const big = file('one/big.png', '')
  truncateSync(big, 10 * 1024 * 1024 + 1)
  const atLimit = file('two/limit.png', '')
  truncateSync(atLimit, 10 * 1024 * 1024)
  const link = join(files, 'one', 'link.png')
  symlinkSync(good, link)
  const dupA = file('one/dup.png', 'dup 1')
  const dupB = file('two/dup.png', 'dup 2')
  for (const [name, paths, text] of [
    ['a rejected extension', [good, svg], 'is not one of'],
    ['a file over 10 MiB', [good, big], 'over the 10 MiB limit'],
    ['a duplicate basename', [dupA, dupB], 'two files are named dup.png'],
    ['a symlink', [link], 'symlink'],
    ['a missing file', [join(files, 'none.png')], 'does not open'],
    ['a directory', [join(files, 'one.png')], ''],
    ['a FIFO with no writer', [join(files, 'pipe.png')], 'is not a regular file'],
  ]) {
    if (name === 'a directory') mkdirSync(join(files, 'one.png'))
    if (name === 'a FIFO with no writer') execFileSync('mkfifo', [join(files, 'pipe.png')])
    const tip = tipOf()
    const r = push(12, paths)
    check(`${name}: exit 1, ok false${text ? `, ${text}` : ''}`, r.code === 1 && r.json?.ok === false && r.json.reason.includes(text), detail(r))
    check(`${name}: no push, no gh call, origin unmoved`, r.pushes.length === 0 && r.calls.length === 0 && tipOf() === tip, `${r.pushes.length} ${JSON.stringify(r.calls)}`)
  }
  const r = push(12, [atLimit])
  check('a file of exactly 10 MiB is accepted', r.code === 0 && r.json?.ok === true, detail(r))
}

console.log('usage exits 2')
for (const [name, args] of [
  ['no --pr', [w.repo, file('one/u.png')]],
  ['a PR number of 0', [w.repo, '--pr', '0', file('one/u.png')]],
  ['a PR number that is not a number', [w.repo, '--pr', 'x7', file('one/u.png')]],
  ['no files', [w.repo, '--pr', '7']],
]) {
  const r = run(args)
  check(`${name}: exit 2 with the usage line, nothing run`, r.code === 2 && r.stderr.includes('usage: evidence-push.mjs') && r.pushes.length === 0 && r.calls.length === 0, detail(r))
}

console.log('the pin and the read-back')
{
  const r = push(13, [file('one/h.png', 'png h')], { GH_REPO: 'someone/evil', GH_HOST: 'evil.example' })
  check('GH_REPO and GH_HOST in the environment never reach gh', r.code === 0 && !r.st.unpinned, detail(r))
  setState({ contentsLie: true })
  const lie = push(13, [file('one/i.png', 'png i')])
  setState({ contentsLie: false })
  check('a contents read-back naming another blob refuses, carrying the pushed commit', lie.code === 1 && lie.json?.ok === false && lie.json.reason.includes('does not serve') && lie.json.commit === tipOf(), detail(lie))
  setState({ nameWithOwner: 'jakub/renamed' })
  const tip = tipOf()
  const renamed = push(13, [file('one/j.png', 'png j')])
  setState({ nameWithOwner: 'jakub/demo' })
  check('a repository GitHub names otherwise refuses before any push', renamed.code === 1 && renamed.json?.reason?.includes('jakub/renamed') && renamed.pushes.length === 0 && tipOf() === tip, detail(renamed))
  w.git(w.repo, 'remote', 'set-url', 'origin', 'git@gitlab.example:jakub/demo.git')
  const off = push(13, [file('one/k.png', 'png k')])
  w.git(w.repo, 'remote', 'set-url', 'origin', 'git@github.com:jakub/demo.git')
  check('a non-GitHub origin refuses before any gh call or push', off.code === 1 && off.json?.reason?.includes('gitlab.example') && off.calls.length === 0 && off.pushes.length === 0, detail(off))
}

console.log('a tracked hooks path never runs, on the push or on any ref update')
{
  // A pull request's checkout can track its own hooks (husky's .husky/, say) under a hooksPath
  // the repository's config already names. Plant one for each hook a run could reach.
  const hooks = join(w.repo, '.githooks')
  mkdirSync(hooks, { recursive: true })
  const ran = join(w.workspace, 'hook-ran')
  for (const h of ['pre-push', 'reference-transaction', 'post-checkout', 'post-index-change']) {
    writeFileSync(join(hooks, h), `#!/bin/sh\necho ${h} >> ${ran}\nexit 0\n`)
    chmodSync(join(hooks, h), 0o755)
  }
  w.git(w.repo, 'config', 'core.hooksPath', '.githooks')
  const r = push(24, [file('one/hookless.png', 'png hookless')])
  w.git(w.repo, 'config', '--unset', 'core.hooksPath')
  rmSync(hooks, { recursive: true, force: true })
  check('exit 0, ok', r.code === 0 && r.json?.ok === true, detail(r))
  let said = ''
  try { said = readFileSync(ran, 'utf8') } catch {}
  check('no hook from the tracked hooks path ran', said === '', JSON.stringify(said))
}

console.log('a push that gets no answer while origin stays unmoved is unknown, never "did not land"')
{
  writeFileSync(join(w.workspace, 'drop-push'), '')
  const before = tipOf()
  const r = push(25, [file('one/dropped.png', 'png dropped')])
  rmSync(join(w.workspace, 'drop-push'))
  const tried = r.pushes[0]?.at(-1)?.split(':')[0]
  check('one push went out, and origin is unmoved', r.pushes.length === 1 && tipOf() === before, `${r.pushes.length} ${tipOf()}`)
  check('exit 1, ok false, landed: "unknown", commit is the attempted commit', r.code === 1 && r.json?.ok === false && r.json.landed === 'unknown' && r.json.commit === tried && !r.json.reason.includes('did not land'), detail(r))
}

console.log('a "[remote failure]" push with origin unmoved is unknown, never "did not land"')
{
  writeFileSync(join(w.workspace, 'remote-failure'), '')
  const before = tipOf()
  const r = push(26, [file('one/unreported.png', 'png unreported')])
  rmSync(join(w.workspace, 'remote-failure'))
  const tried = r.pushes[0]?.at(-1)?.split(':')[0]
  check('one push went out, and origin is unmoved', r.pushes.length === 1 && tipOf() === before, `${r.pushes.length} ${tipOf()}`)
  check('exit 1, ok false, landed: "unknown", commit is the attempted commit', r.code === 1 && r.json?.ok === false && r.json.landed === 'unknown' && r.json.commit === tried && !r.json.reason.includes('did not land'), detail(r))
}

console.log('push.followTags never publishes a tag along with the evidence')
{
  // An annotated tag on origin's current tip, which the next commit descends from, and the config
  // that would push it with the branch.
  const tip = tipOf()
  w.git(w.repo, 'tag', '-a', '-m', 'unpublished', 'smoke-unpublished', tip)
  w.git(w.repo, 'config', 'push.followTags', 'true')
  const r = push(23, [file('one/tagless.png', 'png tagless')])
  w.git(w.repo, 'config', '--unset', 'push.followTags')
  w.git(w.repo, 'tag', '-d', 'smoke-unpublished')
  check('exit 0, ok, the new commit descends from the tagged tip', r.code === 0 && r.json?.ok === true && w.og('rev-parse', `${tipOf()}^`) === tip, detail(r))
  check('origin holds no tag', w.og('for-each-ref', 'refs/tags') === '', w.og('for-each-ref', 'refs/tags'))
}

console.log('the fetch writes a ref of its own, never the shared tracking ref, and deletes it')
{
  // Linked worktrees share refs/remotes, so a rival run's fetch could rewind a shared ref between
  // this run's fetch and its read. Plant one at an unrelated commit. A declined push updates no
  // tracking ref itself, so only this run's two fetches could move it.
  const main = w.git(w.repo, 'rev-parse', 'main')
  w.git(w.repo, 'update-ref', 'refs/remotes/origin/flow-evidence', main)
  writeFileSync(w.preMode, 'decline')
  const logBefore = gitLog().length
  const r = push(20, [file('one/own-ref.png', 'png own ref')])
  rmSync(w.preMode)
  check('exit 1, "did not land"', r.code === 1 && r.json?.reason?.includes('did not land'), detail(r))
  check('refs/remotes/origin/flow-evidence still names the planted commit', w.git(w.repo, 'rev-parse', 'refs/remotes/origin/flow-evidence') === main)
  const fetches = gitLog().slice(logBefore).filter((args) => args.includes('fetch'))
  const dests = fetches.map((args) => args.at(-1))
  check('each fetch lands in its own refs/flow-evidence-push/ ref, with an empty --refmap', fetches.length === 2 && dests.every((a) => /^\+refs\/heads\/flow-evidence:refs\/flow-evidence-push\/\d+-[0-9a-f]{12}$/.test(a)) && dests[0] !== dests[1] && fetches.every((args) => args.includes('--refmap=')), JSON.stringify(fetches))
  w.git(w.repo, 'update-ref', '-d', 'refs/remotes/origin/flow-evidence')
}

console.log('a read-back git cannot answer refuses with landed: unknown, never "not landed"')
{
  writeFileSync(join(w.workspace, 'fail-rev-list'), '')
  const r = push(21, [file('one/unsure.png', 'png unsure')])
  rmSync(join(w.workspace, 'fail-rev-list'))
  check('the push itself answered cleanly, and origin holds it', lastPushExit() === 0 && blobAt(tipOf(), 'pr-21/unsure.png') !== null, String(lastPushExit()))
  check('exit 1, ok false, landed: "unknown", carrying the pushed commit', r.code === 1 && r.json?.ok === false && r.json.landed === 'unknown' && r.json.commit === tipOf(), detail(r))
  check('and the reason says git could not answer', r.json?.reason?.includes('git could not say whether'), r.json?.reason)
  check('and no contents read-back ran', r.contents.length === 0, JSON.stringify(r.contents))
}

console.log('a lost push answer git cannot place refuses with landed: unknown after one push')
{
  writeFileSync(w.hookMode, 'kill')
  writeFileSync(join(w.workspace, 'fail-rev-list'), '')
  const r = push(22, [file('one/unplaced.png', 'png unplaced')])
  rmSync(join(w.workspace, 'fail-rev-list'))
  const pushed = r.pushes[0]?.at(-1)?.split(':')[0]
  check('one push went out, origin holds it, and its answer was lost', r.pushes.length === 1 && tipOf() === pushed && lastPushExit() !== 0, `${r.pushes.length} ${lastPushExit()}`)
  check('exit 1, ok false, landed: "unknown", commit is the attempted commit', r.code === 1 && r.json?.ok === false && r.json.landed === 'unknown' && r.json.commit === pushed, detail(r))
}

console.log('no forced update was ever sent')
{
  const pushes = pushesIn(gitLog())
  const forced = pushes.filter((args) => args.some((a) => /^--force/.test(a) || a === '-f' || a === '--mirror' || a === '--delete' || a === '-d' || /^\+/.test(a) || a.startsWith(':')))
  check(`none of the ${pushes.length} pushes carries a force flag or a + refspec`, pushes.length > 0 && forced.length === 0, JSON.stringify(forced))
  check('every push names exactly <sha>:refs/heads/flow-evidence', pushes.every((args) => args.filter((a) => a.includes(':')).length === 1 && /^[0-9a-f]{40}:refs\/heads\/flow-evidence$/.test(args.at(-1))), JSON.stringify(pushes))
  const entries = readFileSync(join(w.origin, 'logs', 'refs', 'heads', 'flow-evidence'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(0, 2))
  const rewinds = entries.filter(([from, to]) => !ZERO.test(from) && spawnSync(REAL_GIT, ['--git-dir', w.origin, 'merge-base', '--is-ancestor', from, to]).status !== 0)
  check(`origin's reflog for flow-evidence (${entries.length} updates) holds only fast-forwards`, entries.length >= 8 && rewinds.length === 0, JSON.stringify(rewinds))
}

console.log('no fetch ref outlives its run')
{
  const left = w.git(w.repo, 'for-each-ref', '--format=%(refname)', 'refs/flow-evidence-push')
  check('refs/flow-evidence-push/ is empty after every case', left === '', left)
  const named = gitLog().filter((args) => args.some((a) => a.includes('refs/remotes/')))
  check('no git call names a refs/remotes/ ref', named.length === 0, JSON.stringify(named))
}

rmSync(tmp, { recursive: true, force: true })
if (bad > 0) {
  console.log(`smoke-evidence-push: ${bad} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`smoke-evidence-push: ${checks} checks pass`)
