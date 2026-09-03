#!/usr/bin/env node
// Deterministic executor for the nightly lint's destructive actions. The headless
// model never runs `git worktree remove` or `git branch -D` itself (git-guard denies
// them in cron mode); it asks this script, which re-derives every safety condition
// from fresh git/gh state and refuses unless all of them hold. The model's judgment
// picks candidates; this code decides.
//
//   lint-actions.mjs remove-worktree <repo> <worktree-path> [--check]
//   lint-actions.mjs delete-branch  <repo> <branch> [--check]
//   lint-actions.mjs clear-orphan   <repo> <issue-number> [--check]
//
// --check runs every gate and reports the verdict without acting.
//
// Prints one JSON verdict on stdout: {action, target, ok, reason}. Exit 0 only when
// the action was performed. Fail closed: any fetch/query failure is a refusal.
//
// clear-orphan is the one verb that mutates GitHub rather than git: it moves an orphaned
// `in-progress` claim back to `ready-for-agent` and comments on the issue. The model
// could spell that `gh issue edit` itself (the verb is on the lint's allowlist for the
// other label moves), so the prompt routes this move here and this code re-derives the
// liveness checks and the grace window instead of trusting the model's reading of them.
import { execFileSync } from "node:child_process";

// Unattended: ssh must never prompt (a prompt is a 40-minute hang, then a dead job).
const ENV = { ...process.env, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=10" };

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const [action, repo, target] = argv.filter((a) => a !== "--check");
const usage = "usage: lint-actions.mjs <remove-worktree|delete-branch|clear-orphan> <repo> <target>";
if (!repo || !target || !["remove-worktree", "delete-branch", "clear-orphan"].includes(action)) {
  console.error(usage);
  process.exit(2);
}

const out = (ok, reason) => {
  console.log(JSON.stringify({ action, repo, target, ok, reason }));
  process.exit(ok ? 0 : 1);
};
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: ENV }).trim();
const tryGit = (...args) => { try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; } };

// Fail closed on stale refs: every decision below is made against a fresh fetch.
try { execFileSync("git", ["-C", repo, "fetch", "origin", "--prune", "--quiet"], { encoding: "utf8", timeout: 60_000, env: ENV }); }
catch { out(false, "fetch origin failed; refusing to act on possibly stale refs"); }

// A merged or closed PR whose head matches this exact tip proves the commits are
// recorded on the remote (GitHub keeps PR head refs even after branch deletion).
const prsFor = (branch) => {
  try {
    return JSON.parse(execFileSync("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,headRefOid"], { encoding: "utf8", cwd: repo, timeout: 60_000 }));
  } catch { out(false, "gh pr list failed; refusing to act without PR state"); }
};

// Two independent questions, both of which must answer yes before a branch dies.
//
// SAFETY (tipJustification): are the commits recoverable after the delete? Yes when the
// remote can reproduce the tip - same-tip remote branch, merged/closed PR head at this
// tip, or ancestry of origin/main (pre-squash merges). An OPEN PR refuses outright:
// content aside, an active run owns that branch.
//
// WARRANT (deathWarrant): is the branch actually dead? Safety alone is not a reason to
// delete: a pushed spike with no PR is perfectly recoverable AND perfectly alive. Only a
// merged/closed PR or a tip already in origin/main proves the work landed or was
// abandoned on purpose. A prompt-level gate holds only as long as the model remembers it,
// so the gate lives here.
// Branches that are infrastructure, not work: never deletable regardless of state.
// `flow-evidence` carries PR evidence captures that outlive every PR pointing at them.
const PROTECTED = new Set(["main", "master", "flow-evidence"]);

const deathWarrant = (branch, tip) => {
  if (PROTECTED.has(branch)) return { deny: `${branch} is a protected branch` };
  const pr = prsFor(branch).find((p) => p.state === "MERGED" || p.state === "CLOSED");
  if (pr) return { why: `PR #${pr.number} is ${pr.state}` };
  if (tryGit("merge-base", "--is-ancestor", tip, "refs/remotes/origin/main") !== null) {
    return { why: "tip is already in origin/main" };
  }
  return { deny: "no merged or closed PR and the tip is not in origin/main; the branch is recoverable but not demonstrably dead - a human decides" };
};

const tipJustification = (branch, tip) => {
  const prs = prsFor(branch);
  if (prs.some((p) => p.state === "OPEN")) return { deny: `branch has an open PR (#${prs.find((p) => p.state === "OPEN").number})` };
  const remoteTip = tryGit("rev-parse", `refs/remotes/origin/${branch}`);
  if (remoteTip === tip) return { why: `origin/${branch} is at this tip` };
  if (remoteTip && tryGit("rev-list", "--count", `refs/remotes/origin/${branch}..${tip}`) === "0") return { why: `no commits beyond origin/${branch}` };
  const pr = prs.find((p) => (p.state === "MERGED" || p.state === "CLOSED") && p.headRefOid === tip);
  if (pr) return { why: `PR #${pr.number} (${pr.state}) head is this tip` };
  if (tryGit("merge-base", "--is-ancestor", tip, "refs/remotes/origin/main") !== null) return { why: "tip is an ancestor of origin/main" };
  return { deny: "tip is not reproducible from the remote (no matching remote branch, PR head, or main ancestry)" };
};

if (action === "remove-worktree") {
  const list = tryGit("worktree", "list", "--porcelain", "-z");
  if (list === null) out(false, "not a git repo");
  const paths = list.split("\0").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  if (paths[0] === target) out(false, "refusing to remove the main worktree");
  if (!paths.includes(target)) out(false, "path is not a registered worktree of this repo");

  const inWt = (...args) => { try { return execFileSync("git", ["-C", target, ...args], { encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; } };
  const status = inWt("status", "--porcelain");
  if (status === null) out(false, "cannot read worktree status");
  if (status !== "") out(false, "worktree is not clean (tracked or untracked files present)");

  const branch = inWt("symbolic-ref", "--quiet", "--short", "HEAD");
  const tip = inWt("rev-parse", "HEAD");
  if (!tip) out(false, "cannot resolve worktree HEAD");
  const v = branch ? tipJustification(branch, tip) : (tryGit("merge-base", "--is-ancestor", tip, "refs/remotes/origin/main") !== null ? { why: "detached tip is an ancestor of origin/main" } : { deny: "detached tip is not an ancestor of origin/main" });
  if (v.deny) out(false, v.deny);
  if (check) out(true, `check only: would remove (${v.why})`);

  try { git("worktree", "remove", target); } catch (e) { out(false, `git worktree remove refused: ${String(e.stderr || e.message).trim().slice(0, 200)}`); }
  git("worktree", "prune");
  out(true, `removed (${v.why})`);
}

if (action === "delete-branch") {
  const tip = tryGit("rev-parse", `refs/heads/${target}`);
  if (!tip) out(false, "branch does not exist");
  const co = tryGit("worktree", "list", "--porcelain", "-z") || "";
  if (co.split("\0").includes(`branch refs/heads/${target}`)) out(false, "branch is checked out in a worktree");
  const w = deathWarrant(target, tip);
  if (w.deny) out(false, w.deny);
  const v = tipJustification(target, tip);
  if (v.deny) out(false, v.deny);
  if (check) out(true, `check only: would delete (${w.why}; ${v.why})`);
  try { git("branch", "-D", target); } catch (e) { out(false, `git branch -D refused: ${String(e.stderr || e.message).trim().slice(0, 200)}`); }
  out(true, `deleted (${w.why}; ${v.why})`);
}

// An orphaned claim is an open `in-progress` issue with no live branch, worktree, claim tag,
// or open PR, whose last update is older than the grace window. The window exists because a
// running issue stage looks exactly like an orphan in the minutes between its label move and
// its branch reaching origin; anything younger is left for the next night. A claim tag on
// origin is never cleared from here: a held tag means a run may still own the issue, and the
// issue stage says a stale tag is a human's to settle with the branch and PR state it guards.
if (action === "clear-orphan") {
  const GRACE_MS = 6 * 60 * 60 * 1000;
  if (!/^[1-9]\d*$/.test(target)) out(false, "issue number must be a positive integer");
  const n = target;
  const gh = (...args) => { try { return execFileSync("gh", args, { encoding: "utf8", cwd: repo, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }); } catch { return null; } };
  const parse = (raw, what) => { try { return JSON.parse(raw); } catch { out(false, `${what} returned unparseable JSON`); } };

  const issueRaw = gh("issue", "view", n, "--json", "number,state,labels,updatedAt");
  if (issueRaw === null) out(false, "gh issue view failed; refusing to act without issue state");
  const issue = parse(issueRaw, "gh issue view");
  const labels = (issue.labels || []).map((l) => l.name);
  if (issue.state !== "OPEN") out(false, `issue is ${issue.state}, not OPEN`);
  if (!labels.includes("in-progress")) out(false, "issue does not carry in-progress");
  const updated = Date.parse(issue.updatedAt);
  if (!Number.isFinite(updated)) out(false, "issue updatedAt is unreadable");
  const ageMs = Date.now() - updated;
  if (ageMs < GRACE_MS) out(false, `issue was updated ${Math.round(ageMs / 60_000)} minutes ago; a claim younger than six hours may be a running stage whose branch is not yet on origin`);

  const branchRe = new RegExp(`^(feat|fix|chore)/issue-${n}-`);
  const refs = (tryGit("for-each-ref", "--format=%(refname:short)", "refs/heads/", "refs/remotes/origin/") || "").split("\n").filter(Boolean);
  const live = refs.filter((r) => branchRe.test(r.replace(/^origin\//, "")));
  if (live.length) out(false, `live branch: ${live.join(", ")}`);
  const worktrees = (tryGit("worktree", "list", "--porcelain", "-z") || "").split("\0").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  const wt = worktrees.find((p) => p.includes(`-issue-${n}-`));
  if (wt) out(false, `live worktree: ${wt}`);
  const tag = tryGit("ls-remote", "--tags", "origin", `refs/tags/flow-claim-issue-${n}`);
  if (tag === null) out(false, "git ls-remote failed; refusing to act without the claim tag state");
  if (tag !== "") out(false, `claim tag flow-claim-issue-${n} is on origin; a held claim is a human's to settle`);
  const prsRaw = gh("pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName");
  if (prsRaw === null) out(false, "gh pr list failed; refusing to act without PR state");
  const pr = parse(prsRaw, "gh pr list").find((p) => branchRe.test(p.headRefName || ""));
  if (pr) out(false, `open PR #${pr.number} on ${pr.headRefName}`);

  const why = `in-progress for ${Math.round(ageMs / 3_600_000)}h with no branch, worktree, claim tag, or open PR`;
  if (check) out(true, `check only: would clear (${why})`);
  if (gh("issue", "edit", n, "--remove-label", "in-progress", "--add-label", "ready-for-agent") === null) out(false, "gh issue edit failed");
  const afterRaw = gh("issue", "view", n, "--json", "labels");
  const after = afterRaw === null ? null : (parse(afterRaw, "gh issue view").labels || []).map((l) => l.name);
  if (!after || after.includes("in-progress") || !after.includes("ready-for-agent")) out(false, "label edit did not read back as ready-for-agent without in-progress; issue state unknown, a human checks it");
  const commented = gh("issue", "comment", n, "--body", `Cleared an orphaned \`in-progress\` claim back to \`ready-for-agent\`: ${why}.\n\n- flow nightly lint`) !== null;
  out(true, `cleared (${why})${commented ? "" : "; the comment failed, labels moved"}`);
}
