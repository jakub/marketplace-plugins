#!/usr/bin/env node
// Smoke harness for scripts/lint-actions.mjs, the nightly lint's deterministic executor.
//
// The executor is a top-level script with no export seam, so it is driven as a child process.
// Everything git is real. Each case gets a bare repository standing in for origin and a clone
// beside it under mktemp, and the origin is host-qualified, git@github.com:jakub/demo.git, served
// through a GIT_SSH_COMMAND script that ignores the host and runs upload-pack or receive-pack
// against the bare repository on disk, the way scripts/smoke-issue-claim-verb.mjs does it. That is
// the only origin shape the clear-orphan verb accepts, because every gh call it makes is pinned to
// the host, owner and repository origin parses to, and a hostless origin is a refusal.
//
// Everything GitHub is a fake `gh` placed first on PATH: a node script that answers `issue view`,
// `api` over the open pull requests, `issue edit` and `issue comment` from a per-case JSON state
// file and appends every call it was handed to that same file. The fake refuses any call that is
// not pinned to github.com/jakub/demo, so a case that succeeds has proved the pin on every call,
// and a case that sets GH_REPO in the executor's environment proves the pin beats the ambient
// redirect. The fake applies an `issue edit` to its copy of the issue unless the case sets
// applyEdit false, because the executor reads the issue back to confirm the labels moved. One
// hook: plantOnPullsRead makes the fake push a branch to origin during the Nth pull-request read,
// which is how a rival arriving between the free checks and the claim tag is reproduced.
//
// The clear-orphan verb is the subject. Every refusal it can make gets a case that plants the one
// live signal and asserts no `issue edit` reached the fake and no claim tag was left on origin.
// The clean case asserts the labels moved, the comment landed, and the tag went back. The
// pre-existing verbs get a single refusal each, so the harness proves it can drive them at all.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXECUTOR = resolve(HERE, "lint-actions.mjs");
const HOUR = 3_600_000;
const ISSUE = "7";
const TAG_REF = `refs/tags/flow-claim-issue-${ISSUE}`;
const PIN = "github.com/jakub/demo";

const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const file = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(file, "utf8"));
const argv = process.argv.slice(2);
st.calls.push(argv);
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const out = (v) => { process.stdout.write(JSON.stringify(v)); save(); process.exit(0); };
const fail = (m) => { process.stderr.write("fake gh: " + m + "\\n"); save(); process.exit(1); };
const [group, verb, ...rest] = argv;
const pinned = () => { const i = rest.indexOf("--repo"); return i !== -1 && rest[i + 1] === ${JSON.stringify(PIN)}; };
// The under-tag invariant, checked from the fake's side: the second liveness scan and the edit
// happen only while this issue's claim tag is on origin. An executor that took the tag late, or
// took it and gave it straight back, fails here whatever its verdict says.
const requireTagHeld = (when) => {
  const held = execFileSync("git", ["-C", st.repo, "ls-remote", "--tags", "origin", "refs/tags/flow-claim-issue-7"], { encoding: "utf8", env: { ...process.env, GIT_SSH_COMMAND: st.ssh } }).trim() !== "";
  if (!held) fail(when + " without the claim tag held on origin");
};
if (group === "api") {
  const h = argv.indexOf("--hostname");
  if (h === -1 || argv[h + 1] !== "github.com") fail("api call without --hostname github.com: " + argv.join(" "));
  const endpoint = argv[argv.length - 1];
  if (!endpoint.startsWith("repos/jakub/demo/pulls?state=open")) fail("api call to an unexpected endpoint: " + endpoint);
  if (!argv.includes("--paginate") || !argv.includes("--slurp")) fail("api call without --paginate --slurp");
  st.pullsReads = (st.pullsReads || 0) + 1;
  if (st.pullsReads >= 2) requireTagHeld("second pull-request read");
  if (st.plantOnPullsRead === st.pullsReads) {
    execFileSync("git", ["-C", st.repo, "push", "--quiet", "origin", "main:refs/heads/feat/issue-7-rival"], { env: { ...process.env, GIT_SSH_COMMAND: st.ssh } });
  }
  out([st.prs]);
}
if (group === "issue" && !pinned()) fail("issue call without the repository pin: " + argv.join(" "));
if (group === "issue" && verb === "view") {
  if (st.viewFails) fail("issue view failed");
  const fields = rest[rest.indexOf("--json") + 1].split(",");
  out(Object.fromEntries(fields.map((f) => [f, st.issue[f]])));
}
if (group === "issue" && verb === "edit") {
  if (st.expectTag !== false) requireTagHeld("issue edit");
  if (st.partialEdit === "add-only") { const add = rest.indexOf("--add-label"); if (add !== -1) st.issue.labels.push({ name: rest[add + 1] }); fail("issue edit: the add landed and the remove failed"); }
  if (st.editFails) fail("issue edit failed");
  if (st.buryOnEdit) st.issue.labels = st.issue.labels.filter((l) => l.name !== "in-progress").concat([{ name: "wontfix" }]);
  if (st.labelOnEdit && !st.labelOnEditDone) { st.issue.labels.push({ name: st.labelOnEdit }); st.labelOnEditDone = true; }
  if (st.applyEdit !== false) {
    const rm = rest.indexOf("--remove-label"), add = rest.indexOf("--add-label");
    if (rm !== -1) st.issue.labels = st.issue.labels.filter((l) => l.name !== rest[rm + 1]);
    if (add !== -1) st.issue.labels.push({ name: rest[add + 1] });
  }
  out({});
}
if (group === "issue" && verb === "comment") out({});
fail("unexpected call " + argv.join(" "));
`;

const gitEnv = (ssh) => ({ ...process.env, GIT_SSH_COMMAND: ssh, GIT_TERMINAL_PROMPT: "0" });
const git = (w, ...args) => execFileSync("git", ["-C", w.repo, "-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", ...args], { encoding: "utf8", env: gitEnv(w.ssh), stdio: ["ignore", "pipe", "pipe"] }).trim();
const tagOnOrigin = (w) => execFileSync("git", ["-C", w.repo, "ls-remote", "--tags", "origin", TAG_REF], { encoding: "utf8", env: gitEnv(w.ssh) }).trim() !== "";

// A world: a host-qualified origin served locally, a clone with main pushed, a fake gh, a state file.
const world = (issue = {}, extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "flow-lint-actions-"));
  const base = join(dir, "base");
  const origin = join(base, "jakub", "demo.git");
  const repo = join(dir, "repo");
  mkdirSync(join(base, "jakub"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
  const ssh = join(dir, "ssh");
  writeFileSync(ssh, `#!/bin/sh\ncd ${base} || exit 1\nfor a; do last=$a; done\nexec /bin/sh -c "$last"\n`);
  chmodSync(ssh, 0o755);
  const w = { dir, origin, repo, ssh };
  git(w, "remote", "add", "origin", "git@github.com:jakub/demo.git");
  git(w, "commit", "--quiet", "--allow-empty", "-m", "init");
  git(w, "push", "--quiet", "-u", "origin", "main");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const state = join(dir, "gh-state.json");
  writeFileSync(state, JSON.stringify({
    issue: { number: 7, state: "OPEN", labels: [{ name: "in-progress" }, { name: "enhancement" }], updatedAt: new Date(Date.now() - 7 * HOUR).toISOString(), ...issue },
    prs: [],
    calls: [],
    repo, ssh,
    ...extra,
  }));
  return { ...w, bin, state };
};

const run = (w, args, envExtra = {}) => {
  const r = spawnSync(process.execPath, [EXECUTOR, ...args], {
    encoding: "utf8",
    env: { ...gitEnv(w.ssh), PATH: `${w.bin}:${process.env.PATH}`, FAKE_GH_STATE: w.state, FLOW_WORKSPACE: w.dir, ...envExtra },
  });
  let verdict = null;
  try { verdict = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* usage errors print no JSON */ }
  return { code: r.status, verdict, stderr: r.stderr, state: JSON.parse(readFileSync(w.state, "utf8")) };
};
const edits = (state) => state.calls.filter((c) => c[0] === "issue" && c[1] === "edit");
const comments = (state) => state.calls.filter((c) => c[0] === "issue" && c[1] === "comment");
const labelsOf = (state) => state.issue.labels.map((l) => l.name).sort();
const done = (w) => rmSync(w.dir, { recursive: true, force: true });

const cases = [];
const it = (name, fn) => cases.push({ name, fn });

it("clears an orphan: labels move, the comment lands, the tag goes back", () => {
  const w = world();
  const r = run(w, ["clear-orphan", w.repo, ISSUE]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.verdict.ok, true);
  assert.match(r.verdict.reason, /^cleared \(in-progress for 7h/);
  assert.deepEqual(labelsOf(r.state), ["enhancement", "ready-for-agent"]);
  assert.equal(edits(r.state).length, 1);
  assert.equal(comments(r.state).length, 1);
  assert.match(comments(r.state)[0].at(-1), /flow nightly lint/);
  assert.equal(tagOnOrigin(w), false, "the claim tag must be given back");
  done(w);
});

it("the pin beats an ambient GH_REPO", () => {
  const w = world();
  const r = run(w, ["clear-orphan", w.repo, ISSUE], { GH_REPO: "evil/other", GH_HOST: "example.invalid" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.verdict.ok, true);
  for (const c of r.state.calls.filter((c) => c[0] === "issue")) assert.ok(c.includes(PIN), `unpinned: ${c.join(" ")}`);
  done(w);
});

it("--check reports the verdict, edits nothing, takes no tag", () => {
  const w = world();
  const r = run(w, ["clear-orphan", w.repo, ISSUE, "--check"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.verdict.reason, /^check only: would clear/);
  assert.equal(edits(r.state).length, 0);
  assert.equal(tagOnOrigin(w), false);
  done(w);
});

const refuses = (name, setup, pattern) => it(name, () => {
  const w = setup();
  const r = run(w, ["clear-orphan", w.repo, ISSUE]);
  assert.equal(r.code, 1, `expected a refusal, got exit ${r.code}: ${r.stderr}`);
  assert.equal(r.verdict.ok, false);
  assert.match(r.verdict.reason, pattern);
  assert.equal(edits(r.state).length, 0, "a refusal must not edit the issue");
  assert.equal(comments(r.state).length, 0, "a refusal must not comment");
  if (!w.keepsTag) assert.equal(tagOnOrigin(w), false, "a refusal must not leave a claim tag of its own");
  done(w);
});

refuses("refuses a claim younger than the grace window", () => world({ updatedAt: new Date(Date.now() - HOUR).toISOString() }), /younger than six hours/);
refuses("refuses an issue without in-progress", () => world({ labels: [{ name: "ready-for-agent" }] }), /lifecycle labels \[ready-for-agent\] and clear-orphan needs in-progress alone/);
refuses("refuses a closed issue", () => world({ state: "CLOSED" }), /not OPEN/);
refuses("refuses a blocked issue", () => world({ labels: [{ name: "in-progress" }, { name: "needs-human" }] }), /needs clear-orphan.*in-progress alone|lifecycle labels \[in-progress, needs-human\]/);
refuses("refuses a buried issue", () => world({ labels: [{ name: "in-progress" }, { name: "wontfix" }] }), /lifecycle labels \[in-progress, wontfix\]/);
refuses("refuses a double-labelled issue", () => world({ labels: [{ name: "in-progress" }, { name: "ready-for-agent" }] }), /lifecycle labels \[in-progress, ready-for-agent\]/);
refuses("refuses when a branch for the issue is on origin", () => {
  const w = world();
  git(w, "push", "--quiet", "origin", "main:refs/heads/feat/issue-7-widget");
  git(w, "branch", "-r", "-D", "origin/feat/issue-7-widget");
  return w;
}, /live: branch refs\/heads\/feat\/issue-7-widget on origin/);
refuses("sees an origin branch a narrow fetch refspec never mirrors", () => {
  const w = world();
  git(w, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  git(w, "push", "--quiet", "origin", "main:refs/heads/fix/issue-7-widget");
  return w;
}, /live: branch refs\/heads\/fix\/issue-7-widget on origin/);
refuses("refuses when a local branch for the issue exists", () => {
  const w = world();
  git(w, "branch", "fix/issue-7-widget");
  return w;
}, /live: local branch fix\/issue-7-widget/);
refuses("refuses when a worktree for the issue exists", () => {
  const w = world();
  git(w, "worktree", "add", "--quiet", "--detach", join(w.dir, "repo-issue-7-widget"));
  return w;
}, /live: worktree .*repo-issue-7-widget/);
refuses("refuses when the claim tag is held on origin", () => {
  const w = world();
  git(w, "push", "--quiet", "origin", "HEAD:" + TAG_REF);
  w.keepsTag = true;
  return w;
}, /claim tag flow-claim-issue-7 is held on origin/);
refuses("refuses when an open PR (from a fork, no branch on origin) heads the issue's branch", () => world({}, { prs: [{ number: 41, head: { ref: "chore/issue-7-widget" } }] }), /live: open PR #41 on chore\/issue-7-widget/);
refuses("refuses when gh cannot read the issue", () => world({}, { viewFails: true }), /gh issue view failed/);
refuses("refuses a rival that publishes between the free checks and the tag", () => {
  const w = world({}, { plantOnPullsRead: 1 });
  return w;
}, /under the claim tag, live: branch refs\/heads\/feat\/issue-7-rival on origin/);
refuses("does not match another issue's branch by prefix", () => {
  const w = world();
  git(w, "branch", "feat/issue-71-widget");
  const r = run(w, ["clear-orphan", w.repo, ISSUE, "--check"]);
  assert.equal(r.code, 0, `issue 71's branch must not count as issue 7's: ${r.verdict?.reason}`);
  git(w, "branch", "feat/issue-7-widget");
  return w;
}, /live: local branch feat\/issue-7-widget/);

it("refuses a hostless origin rather than call gh unpinned", () => {
  const w = world();
  git(w, "remote", "set-url", "origin", w.origin);
  const r = run(w, ["clear-orphan", w.repo, ISSUE]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /names no host/);
  assert.equal(r.state.calls.length, 0, "no gh call may be made against a hostless origin");
  done(w);
});

it("an accepted no-op gives the tag back so the orphan is not stranded", () => {
  const w = world({}, { applyEdit: false });
  const r = run(w, ["clear-orphan", w.repo, ISSUE]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /accepted but the read-back shows the labels unchanged; nothing moved/);
  assert.doesNotMatch(r.verdict.reason, /retained/);
  assert.equal(comments(r.state).length, 0, "no comment on an unconfirmed move");
  assert.equal(tagOnOrigin(w), false, "the original tuple proves nothing moved; the tag goes back");
  done(w);
});

it("refuses a repository outside the workspace root", () => {
  const w = world();
  mkdirSync(join(w.dir, "elsewhere"));
  const r = run(w, ["clear-orphan", w.repo, ISSUE], { FLOW_WORKSPACE: join(w.dir, "elsewhere") });
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /not a direct child of the workspace/);
  assert.equal(r.state.calls.length, 0, "no gh call on a repository outside the workspace");
  done(w);
});

it("refuses to run under the cron without a workspace root", () => {
  const w = world();
  const r = run(w, ["clear-orphan", w.repo, ISSUE], { FLOW_CRON_JOB: "lint", FLOW_WORKSPACE: "" });
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /FLOW_WORKSPACE is not/);
  assert.equal(r.state.calls.length, 0);
  done(w);
});

it("keeps the tag when a human buries the issue in the same window", () => {
  const w = world({}, { buryOnEdit: true });
  const r = run(w, ["clear-orphan", w.repo, ISSUE]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /lifecycle labels \[ready-for-agent, wontfix\]|lifecycle labels \[wontfix, ready-for-agent\]/);
  assert.match(r.verdict.reason, /retained: claim-tag/);
  assert.equal(comments(r.state).length, 0);
  assert.equal(tagOnOrigin(w), true);
  done(w);
});

it("names a retained claim tag when origin refuses to give it back", () => {
  const w = world();
  const hook = join(w.origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do case \"$new\" in 0000000000000000000000000000000000000000) exit 1;; esac; done\nexit 0\n");
  chmodSync(hook, 0o755);
  const r = run(w, ["clear-orphan", w.repo, ISSUE]);
  assert.equal(r.code, 1, "a stuck tag is not a clean success");
  assert.match(r.verdict.reason, /retained: claim-tag/);
  assert.deepEqual(labelsOf(r.state), ["enhancement", "ready-for-agent"], "the labels did move; the verdict says so");
  assert.equal(tagOnOrigin(w), true);
  done(w);
});

it("--check refuses when the claim tag is held", () => {
  const w = world();
  git(w, "push", "--quiet", "origin", "HEAD:" + TAG_REF);
  const r = run(w, ["clear-orphan", w.repo, ISSUE, "--check"]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /claim tag flow-claim-issue-7 is held/);
  assert.equal(edits(r.state).length, 0);
  done(w);
});

it("a failed edit that moved nothing gives the tag back", () => {
  const w = world({}, { editFails: true });
  const r = run(w, ["clear-orphan", w.repo, ISSUE]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /gh issue edit failed and the read-back confirms nothing moved/);
  assert.deepEqual(labelsOf(r.state), ["enhancement", "in-progress"]);
  assert.equal(tagOnOrigin(w), false);
  done(w);
});

it("a failed edit that landed half way keeps the tag", () => {
  const w = world({}, { partialEdit: "add-only" });
  const r = run(w, ["clear-orphan", w.repo, ISSUE]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /the edit failed part way.*retained: claim-tag/);
  assert.deepEqual(labelsOf(r.state), ["enhancement", "in-progress", "ready-for-agent"]);
  assert.equal(comments(r.state).length, 0);
  assert.equal(tagOnOrigin(w), true);
  done(w);
});

it("demote-unready moves a failing ready issue to needs-triage with the reason", () => {
  const w = world({ labels: [{ name: "ready-for-agent" }, { name: "bug" }] });
  const seen = JSON.parse(readFileSync(w.state, "utf8")).issue.updatedAt;
  const r = run(w, ["demote-unready", w.repo, ISSUE, "--seen", seen, "no", "acceptance", "criteria", "heading"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.verdict.reason, /^demoted \(ready-for-agent contract not met: no acceptance criteria heading\)/);
  assert.deepEqual(labelsOf(r.state), ["bug", "needs-triage"]);
  assert.match(comments(r.state)[0].at(-1), /no acceptance criteria heading/);
  assert.equal(tagOnOrigin(w), false);
  done(w);
});

it("demote-unready refuses without a reason and without the ready label", () => {
  const w = world({ labels: [{ name: "ready-for-agent" }] });
  const seen0 = JSON.parse(readFileSync(w.state, "utf8")).issue.updatedAt;
  const noReason = run(w, ["demote-unready", w.repo, ISSUE, "--seen", seen0]);
  assert.equal(noReason.code, 1);
  assert.match(noReason.verdict.reason, /needs the failed contract point/);
  const w2 = world();
  const seen2 = JSON.parse(readFileSync(w2.state, "utf8")).issue.updatedAt;
  const notReady = run(w2, ["demote-unready", w2.repo, ISSUE, "--seen", seen2, "whatever"]);
  assert.equal(notReady.code, 1);
  assert.match(notReady.verdict.reason, /needs ready-for-agent alone/);
  assert.equal(edits(notReady.state).length, 0);
  done(w); done(w2);
});

it("demote-unready refuses a ready issue with a live branch", () => {
  const w = world({ labels: [{ name: "ready-for-agent" }] });
  git(w, "branch", "feat/issue-7-started");
  const seen = JSON.parse(readFileSync(w.state, "utf8")).issue.updatedAt;
  const r = run(w, ["demote-unready", w.repo, ISSUE, "--seen", seen, "stale"]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /live: local branch feat\/issue-7-started/);
  done(w);
});

it("triage-unlabelled adds needs-triage to an unlabelled issue and takes no tag", () => {
  const w = world({ labels: [{ name: "bug" }] }, { expectTag: false });
  const seen = JSON.parse(readFileSync(w.state, "utf8")).issue.updatedAt;
  const r = run(w, ["triage-unlabelled", w.repo, ISSUE, "--seen", seen]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.verdict.reason, /^triaged \(open with no lifecycle label\)/);
  assert.deepEqual(labelsOf(r.state), ["bug", "needs-triage"]);
  assert.equal(comments(r.state).length, 1);
  assert.equal(tagOnOrigin(w), false);
  done(w);
});

it("triage-unlabelled refuses an issue that already carries a lifecycle label", () => {
  const w = world({ labels: [{ name: "wontfix" }] }, { expectTag: false });
  const seen = JSON.parse(readFileSync(w.state, "utf8")).issue.updatedAt;
  const r = run(w, ["triage-unlabelled", w.repo, ISSUE, "--seen", seen]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /is for an issue with none/);
  assert.equal(edits(r.state).length, 0);
  done(w);
});

it("demote-unready refuses an issue that moved since the lint read it", () => {
  const w = world({ labels: [{ name: "ready-for-agent" }] });
  const r = run(w, ["demote-unready", w.repo, ISSUE, "--seen", "2026-01-01T00:00:00Z", "stale judgment"]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /moved since the lint read it/);
  assert.equal(edits(r.state).length, 0);
  assert.equal(tagOnOrigin(w), false);
  done(w);
});

it("the two prep-racing verbs refuse without --seen", () => {
  const w = world({ labels: [{ name: "ready-for-agent" }] });
  const d = run(w, ["demote-unready", w.repo, ISSUE, "reason"]);
  assert.equal(d.code, 1);
  assert.match(d.verdict.reason, /needs --seen/);
  const w2 = world({ labels: [{ name: "bug" }] }, { expectTag: false });
  const t = run(w2, ["triage-unlabelled", w2.repo, ISSUE]);
  assert.equal(t.code, 1);
  assert.match(t.verdict.reason, /needs --seen/);
  done(w); done(w2);
});

it("triage-unlabelled leaves a conflicting tuple for a human when prep labels the issue in the same window", () => {
  const w = world({ labels: [{ name: "bug" }] }, { expectTag: false, labelOnEdit: "ready-for-agent" });
  const seen = JSON.parse(readFileSync(w.state, "utf8")).issue.updatedAt;
  const r = run(w, ["triage-unlabelled", w.repo, ISSUE, "--seen", seen]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /something else moved it in the same window; a human checks it/);
  assert.equal(edits(r.state).length, 1, "no second edit: a label on the read-back is not proof this verb added it");
  assert.deepEqual(labelsOf(r.state), ["bug", "needs-triage", "ready-for-agent"]);
  assert.equal(comments(r.state).length, 0);
  done(w);
});

it("refuses a linked worktree of an outside repository placed under the workspace", () => {
  const w = world();
  const outside = join(w.dir, "outside");
  mkdirSync(outside);
  const upstream = join(outside, "upstream");
  execFileSync("git", ["init", "--quiet", "-b", "main", upstream]);
  execFileSync("git", ["-C", upstream, "-c", "user.name=s", "-c", "user.email=s@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "init"]);
  execFileSync("git", ["-C", upstream, "remote", "add", "origin", "git@github.com:jakub/demo.git"]);
  const linked = join(w.dir, "linked");
  execFileSync("git", ["-C", upstream, "worktree", "add", "--quiet", "--detach", linked]);
  const r = run(w, ["clear-orphan", linked, ISSUE]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /is a linked worktree of .*upstream, not a repository of its own/);
  assert.equal(r.state.calls.length, 0);
  done(w);
});

it("refuses a non-numeric issue argument", () => {
  const w = world();
  const r = run(w, ["clear-orphan", w.repo, "seven"]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /positive integer/);
  done(w);
});

it("still drives the older verbs: delete-branch refuses a checked-out branch", () => {
  const w = world();
  const r = run(w, ["delete-branch", w.repo, "main"]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /checked out in a worktree/);
  done(w);
});

it("still drives the older verbs: remove-worktree refuses the main worktree", () => {
  const w = world();
  const r = run(w, ["remove-worktree", w.repo, w.repo]);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /main worktree/);
  done(w);
});

it("unknown verb is a usage error with no JSON", () => {
  const w = world();
  const r = run(w, ["clear-issue", w.repo, ISSUE]);
  assert.equal(r.code, 2);
  assert.equal(r.verdict, null);
  done(w);
});

let failed = 0;
for (const { name, fn } of cases) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.message).split("\n").join("\n     ")}`); }
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
