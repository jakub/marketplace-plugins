#!/usr/bin/env node
// Smoke harness for scripts/lint-actions.mjs, the nightly lint's deterministic executor.
//
// The executor is a top-level script with no export seam, so it is driven as a child process.
// Everything git is real: each case gets a bare repository standing in for origin and a clone
// beside it under mktemp, and the executor's own `fetch origin --prune` runs against that bare
// repository. Everything GitHub is a fake `gh` placed first on PATH: a node script that answers
// `issue view`, `pr list`, `issue edit` and `issue comment` from a per-case JSON state file and
// appends every call it was handed to that same file. The fake applies an `issue edit` to its
// copy of the issue unless the case sets applyEdit false, because the executor reads the issue
// back to confirm the labels moved and a case wants to see what happens when they did not.
//
// The clear-orphan verb is the subject. Every refusal it can make gets a case that plants the
// one live signal (a branch on origin, a local branch, a worktree, the claim tag, an open PR, a
// fresh update, a missing label) and asserts no `issue edit` reached the fake. The one clean
// case asserts the labels moved and the comment was posted. The pre-existing verbs get a
// single refusal each, so the harness proves it can drive them at all.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXECUTOR = resolve(HERE, "lint-actions.mjs");
const HOUR = 3_600_000;

const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(file, "utf8"));
const argv = process.argv.slice(2);
st.calls.push(argv);
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const out = (v) => { process.stdout.write(JSON.stringify(v)); save(); process.exit(0); };
const fail = (m) => { process.stderr.write("fake gh: " + m + "\\n"); save(); process.exit(1); };
const [group, verb, ...rest] = argv;
if (group === "issue" && verb === "view") {
  if (st.viewFails) fail("issue view failed");
  const fields = rest[rest.indexOf("--json") + 1].split(",");
  out(Object.fromEntries(fields.map((f) => [f, st.issue[f]])));
}
if (group === "pr" && verb === "list") out(st.prs);
if (group === "issue" && verb === "edit") {
  if (st.editFails) fail("issue edit failed");
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

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A world: bare origin, a clone with one commit on main pushed, a fake gh on PATH, a state file.
const world = (issue = {}, extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "flow-lint-actions-"));
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "--bare", "--quiet", "-b", "main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, repo], { stdio: "ignore" });
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "init");
  git(repo, "push", "--quiet", "-u", "origin", "main");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const state = join(dir, "gh-state.json");
  writeFileSync(state, JSON.stringify({
    issue: { number: 7, state: "OPEN", labels: [{ name: "in-progress" }, { name: "enhancement" }], updatedAt: new Date(Date.now() - 7 * HOUR).toISOString(), ...issue },
    prs: [],
    calls: [],
    ...extra,
  }));
  return { dir, origin, repo, bin, state };
};

const run = (w, ...args) => {
  const r = spawnSync(process.execPath, [EXECUTOR, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${w.bin}:${process.env.PATH}`, FAKE_GH_STATE: w.state },
  });
  let verdict = null;
  try { verdict = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* usage errors print no JSON */ }
  return { code: r.status, verdict, stderr: r.stderr, state: JSON.parse(readFileSync(w.state, "utf8")) };
};
const edits = (state) => state.calls.filter((c) => c[0] === "issue" && c[1] === "edit");
const comments = (state) => state.calls.filter((c) => c[0] === "issue" && c[1] === "comment");
const labelsOf = (state) => state.issue.labels.map((l) => l.name).sort();

const cases = [];
const it = (name, fn) => cases.push({ name, fn });

it("clears an orphan: labels move and the comment lands", () => {
  const w = world();
  const r = run(w, "clear-orphan", w.repo, "7");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.verdict.ok, true);
  assert.match(r.verdict.reason, /^cleared \(in-progress for 7h/);
  assert.deepEqual(labelsOf(r.state), ["enhancement", "ready-for-agent"]);
  assert.equal(edits(r.state).length, 1);
  assert.equal(comments(r.state).length, 1);
  assert.match(comments(r.state)[0].at(-1), /flow nightly lint/);
  rmSync(w.dir, { recursive: true, force: true });
});

it("--check reports the verdict and edits nothing", () => {
  const w = world();
  const r = run(w, "clear-orphan", w.repo, "7", "--check");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.verdict.reason, /^check only: would clear/);
  assert.equal(edits(r.state).length, 0);
  assert.equal(comments(r.state).length, 0);
  rmSync(w.dir, { recursive: true, force: true });
});

const refuses = (name, setup, pattern) => it(name, () => {
  const w = setup();
  const r = run(w, "clear-orphan", w.repo, "7");
  assert.equal(r.code, 1, `expected a refusal, got exit ${r.code}: ${r.stderr}`);
  assert.equal(r.verdict.ok, false);
  assert.match(r.verdict.reason, pattern);
  assert.equal(edits(r.state).length, 0, "a refusal must not edit the issue");
  assert.equal(comments(r.state).length, 0, "a refusal must not comment");
  rmSync(w.dir, { recursive: true, force: true });
});

refuses("refuses a claim younger than the grace window", () => world({ updatedAt: new Date(Date.now() - HOUR).toISOString() }), /younger than six hours/);
refuses("refuses an issue without in-progress", () => world({ labels: [{ name: "ready-for-agent" }] }), /does not carry in-progress/);
refuses("refuses a closed issue", () => world({ state: "CLOSED" }), /not OPEN/);
refuses("refuses when a branch for the issue is on origin", () => {
  const w = world();
  git(w.repo, "push", "--quiet", "origin", "main:refs/heads/feat/issue-7-widget");
  git(w.repo, "branch", "-r", "-D", "origin/feat/issue-7-widget"); // the executor's own fetch must find it, not a stale local copy
  return w;
}, /live branch: origin\/feat\/issue-7-widget/);
refuses("refuses when a local branch for the issue exists", () => {
  const w = world();
  git(w.repo, "branch", "fix/issue-7-widget");
  return w;
}, /live branch: fix\/issue-7-widget/);
refuses("refuses when a worktree for the issue exists", () => {
  const w = world();
  git(w.repo, "worktree", "add", "--quiet", "--detach", join(w.dir, "repo-issue-7-widget"));
  return w;
}, /live worktree: .*repo-issue-7-widget/);
refuses("refuses when the claim tag is on origin", () => {
  const w = world();
  git(w.repo, "push", "--quiet", "origin", "HEAD:refs/tags/flow-claim-issue-7");
  return w;
}, /claim tag flow-claim-issue-7 is on origin/);
refuses("refuses when an open PR heads a branch for the issue", () => world({}, { prs: [{ number: 41, headRefName: "chore/issue-7-widget" }] }), /open PR #41 on chore\/issue-7-widget/);
refuses("refuses when gh cannot read the issue", () => world({}, { viewFails: true }), /gh issue view failed/);
refuses("does not match another issue's branch by prefix", () => {
  const w = world();
  git(w.repo, "branch", "feat/issue-71-widget"); // 71 is not 7
  const r = run(w, "clear-orphan", w.repo, "7", "--check");
  assert.equal(r.code, 0, `issue 71's branch must not count as issue 7's: ${r.verdict?.reason}`);
  // Now make it refuse for real so the shared assertions hold: plant issue 7's own branch.
  git(w.repo, "branch", "feat/issue-7-widget");
  return w;
}, /live branch: feat\/issue-7-widget/);

it("reports unknown when the edit does not read back", () => {
  const w = world({}, { applyEdit: false });
  const r = run(w, "clear-orphan", w.repo, "7");
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /did not read back/);
  assert.equal(comments(r.state).length, 0, "no comment on an unconfirmed move");
  rmSync(w.dir, { recursive: true, force: true });
});

it("refuses a non-numeric issue argument", () => {
  const w = world();
  const r = run(w, "clear-orphan", w.repo, "seven");
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /positive integer/);
  rmSync(w.dir, { recursive: true, force: true });
});

it("still drives the older verbs: delete-branch refuses a checked-out branch", () => {
  const w = world();
  const r = run(w, "delete-branch", w.repo, "main");
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /checked out in a worktree/);
  rmSync(w.dir, { recursive: true, force: true });
});

it("still drives the older verbs: remove-worktree refuses the main worktree", () => {
  const w = world();
  const r = run(w, "remove-worktree", w.repo, w.repo);
  assert.equal(r.code, 1);
  assert.match(r.verdict.reason, /main worktree/);
  rmSync(w.dir, { recursive: true, force: true });
});

it("unknown verb is a usage error with no JSON", () => {
  const w = world();
  const r = run(w, "clear-issue", w.repo, "7");
  assert.equal(r.code, 2);
  assert.equal(r.verdict, null);
  rmSync(w.dir, { recursive: true, force: true });
});

let failed = 0;
for (const { name, fn } of cases) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.message).split("\n").join("\n     ")}`); }
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
