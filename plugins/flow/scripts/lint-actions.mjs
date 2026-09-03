#!/usr/bin/env node
// Deterministic executor for the nightly lint's destructive actions. The headless
// model never runs `git worktree remove` or `git branch -D` itself (git-guard denies
// them in cron mode); it asks this script, which re-derives every safety condition
// from fresh git/gh state and refuses unless all of them hold. The model's judgment
// picks candidates; this code decides.
//
//   lint-actions.mjs remove-worktree <repo> <worktree-path> [--check]
//   lint-actions.mjs delete-branch  <repo> <branch> [--check]
//   lint-actions.mjs clear-orphan       <repo> <issue-number> [--check]
//   lint-actions.mjs demote-unready     <repo> <issue-number> <failed contract point...> [--check]
//   lint-actions.mjs triage-unlabelled  <repo> <issue-number> [--check]
//
// --check runs every gate and reports the verdict without acting.
//
// Prints one JSON verdict on stdout: {action, target, ok, reason}. Exit 0 only when
// the action was performed. Fail closed: any fetch/query failure is a refusal.
//
// The three label verbs are the lint's whole authority over GitHub: its allowlist grants no
// `gh issue edit`, so a label moves only through one of these fixed transitions, each of which
// re-derives its preconditions from fresh state. Every gh call is pinned to the repository
// origin's URL parses to, through the claim executor's identity reader, because an ambient
// GH_REPO or a second remote would otherwise let a clean repository authorize a label move in
// another one. The two transitions a claim could race hold the issue's claim tag on origin,
// taken through the claim executor's acquire, while the checks repeat and the edit lands and is
// read back; a run that already holds the tag makes the verb stand down, and a run arriving while
// the verb holds it stands down itself. The read-back is the last read before the tag goes back.
import { execFileSync } from "node:child_process";
import { issueClaim, repoIdentity } from "./issue-claim.mjs";
import { allowedHostsFrom, hostIsAllowed } from "../lib/remote-identity.mjs";

// Unattended: ssh must never prompt (a prompt is a 40-minute hang, then a dead job).
const ENV = { ...process.env, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=10" };

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const [action, repo, target] = argv.filter((a) => a !== "--check");
const usage = "usage: lint-actions.mjs <remove-worktree|delete-branch|clear-orphan|demote-unready|triage-unlabelled> <repo> <target> [reason...]";
if (!repo || !target || !["remove-worktree", "delete-branch", "clear-orphan", "demote-unready", "triage-unlabelled"].includes(action)) {
  console.error(usage);
  process.exit(2);
}

const out = (ok, reason) => {
  console.log(JSON.stringify({ action, repo, target, ok, reason }));
  process.exit(ok ? 0 : 1);
};
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: ENV }).trim();
const tryGit = (...args) => { try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; } };
// The same read with a ceiling. A remote that accepts the connection and then stalls would
// otherwise hold the executor until something outside kills it, and a kill skips every cleanup.
const tryGitWithin = (timeoutMs, ...args) => { try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: ENV, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; } };

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

// ------------------------------------------------------------------------ the label verbs
//
// clear-orphan: an open `in-progress` issue with no other lifecycle label, no live branch,
// worktree, or open PR, and a last update older than the grace window, goes back to
// `ready-for-agent`. The window exists because a running issue stage looks exactly like an orphan
// in the minutes between its label move and its branch reaching origin. demote-unready: an open
// `ready-for-agent` issue with no other lifecycle label that failed the contract goes to
// `needs-triage`, with the failed point in the comment. triage-unlabelled: an open issue with no
// lifecycle label at all gets `needs-triage`. A second lifecycle label on the issue refuses every
// verb, since moving such an issue would hand a blocked or buried issue to an agent.
//
// The first two hold the claim tag: the checks run once for free and once more under the tag,
// where no flow run can move the issue. gh's add and remove are two mutations, and either can
// land while the other fails, so a failed edit is read back rather than assumed unmoved: the
// original tuple means nothing moved and the tag goes back; the intended tuple means it landed;
// anything else is a partial move or someone else's and the tag stays for a human, reported as
// retained. On success the tag goes back straight after the read-back, before the comment.
const LABEL_VERBS = {
  "clear-orphan":      { require: "in-progress",     add: "ready-for-agent", remove: "in-progress",     holdTag: true,  grace: true,  liveness: true,  past: "cleared" },
  "demote-unready":    { require: "ready-for-agent", add: "needs-triage",    remove: "ready-for-agent", holdTag: true,  grace: false, liveness: true,  past: "demoted", reasonArg: true },
  "triage-unlabelled": { require: null,              add: "needs-triage",    remove: null,              holdTag: false, grace: false, liveness: false, past: "triaged" },
};
if (action in LABEL_VERBS) {
  const spec = LABEL_VERBS[action];
  const GRACE_MS = 6 * 60 * 60 * 1000;
  const LIFECYCLE = ["needs-triage", "agent-found", "ready-for-agent", "in-progress", "needs-info", "needs-human", "needs-rebase", "wontfix", "deferred"];
  if (!/^[1-9]\d*$/.test(target)) out(false, "issue number must be a positive integer");
  const n = target;
  const TAG_REF = `refs/tags/flow-claim-issue-${n}`;
  const reason = spec.reasonArg ? argv.filter((a) => a !== "--check").slice(3).join(" ").trim() : "";
  if (spec.reasonArg && reason === "") out(false, `${action} needs the failed contract point after the issue number`);

  const identity = repoIdentity(repo);
  if (identity.problem) out(false, `origin is unusable (${identity.problem}${identity.detail ? `: ${identity.detail}` : ""}); refusing to call gh unpinned`);
  const slug = identity.slug;
  if (slug.problem) out(false, `the origin remote ${slug.problem}, so no gh call here can be pinned to it`);
  if (slug.host === "") out(false, "the origin remote names no host, so gh cannot be pinned to it and would resolve a repository of its own");
  if (!hostIsAllowed(slug.host, allowedHostsFrom(process.env))) out(false, `origin host ${JSON.stringify(slug.host)} is not github.com and not in FLOW_GH_HOSTS, so gh must not be handed a credential for it`);
  const repoPin = ["--repo", `${slug.host}/${slug.owner}/${slug.repo}`];
  const ghEnv = { ...ENV };
  delete ghEnv.GH_REPO;
  delete ghEnv.GH_HOST;
  const gh = (...args) => { try { return execFileSync("gh", args, { encoding: "utf8", cwd: repo, env: ghEnv, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }); } catch { return null; } };
  const parse = (raw) => { try { return JSON.parse(raw); } catch { return undefined; } };
  const branchRe = new RegExp(`^(feat|fix|chore)/issue-${n}-`);
  const patterns = ["feat", "fix", "chore"].map((k) => `refs/heads/${k}/issue-${n}-*`);
  const lifecycleOf = (labels) => labels.filter((l) => LIFECYCLE.includes(l));
  const sameSet = (a, b) => a.length === b.length && a.every((l) => b.includes(l));
  const wanted = spec.require ? [spec.require] : [];
  const final = [spec.add];

  // Every read returns a verdict object and never exits, so the caller can give the claim tag
  // back before it reports.
  const readIssue = () => {
    const raw = gh("issue", "view", n, ...repoPin, "--json", "number,state,labels,updatedAt");
    if (raw === null) return { fail: "gh issue view failed; refusing to act without issue state" };
    const issue = parse(raw);
    if (!issue || typeof issue !== "object" || !Array.isArray(issue.labels)) return { fail: "gh issue view returned something that is not an issue" };
    return { state: issue.state, labels: issue.labels.map((l) => l.name), updatedAt: issue.updatedAt };
  };
  const issueGate = () => {
    const r = readIssue();
    if (r.fail) return r;
    if (r.state !== "OPEN") return { fail: `issue is ${r.state}, not OPEN` };
    const lc = lifecycleOf(r.labels);
    if (!sameSet(lc, wanted)) {
      return { fail: wanted.length
        ? `issue carries lifecycle labels [${lc.join(", ")}] and ${action} needs ${wanted[0]} alone; a blocked, buried, or double-labelled issue is a human's to settle`
        : `issue carries lifecycle labels [${lc.join(", ")}]; ${action} is for an issue with none` };
    }
    if (!spec.grace) return { ageMs: null };
    const updated = Date.parse(r.updatedAt);
    if (!Number.isFinite(updated)) return { fail: "issue updatedAt is unreadable" };
    const ageMs = Date.now() - updated;
    if (ageMs < GRACE_MS) return { fail: `issue was updated ${Math.round(ageMs / 60_000)} minutes ago; a claim younger than six hours may be a running stage whose branch is not yet on origin` };
    return { ageMs };
  };
  const liveness = () => {
    if (!spec.liveness) return {};
    const local = tryGitWithin(5_000, "for-each-ref", "--format=%(refname:short)", ...patterns);
    if (local === null) return { fail: "git for-each-ref failed; refusing to act without this clone's branch state" };
    const localHit = local.split("\n").filter(Boolean).find((r) => branchRe.test(r));
    if (localHit) return { live: `local branch ${localHit}` };
    const worktrees = tryGitWithin(5_000, "worktree", "list", "--porcelain", "-z");
    if (worktrees === null) return { fail: "git worktree list failed; refusing to act without worktree state" };
    const wt = worktrees.split("\0").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)).find((p) => p.includes(`-issue-${n}-`));
    if (wt) return { live: `worktree ${wt}` };
    // origin is asked directly: a clone whose fetch refspec covers only main never mirrors the
    // issue branch under refs/remotes/origin/, and a fetch alone would read as "no branch".
    const remote = tryGitWithin(60_000, "ls-remote", "--heads", "origin", ...patterns);
    if (remote === null) return { fail: "git ls-remote origin failed or timed out; refusing to act without origin's branch state" };
    const remoteHit = remote.split("\n").map((l) => l.split("\t")[1]).find((r) => r && branchRe.test(r.replace(/^refs\/heads\//, "")));
    if (remoteHit) return { live: `branch ${remoteHit} on origin` };
    // Every open pull request, paged to exhaustion: a fork PR keeps its head in the fork, so
    // nothing on origin advertises it, and a fixed --limit drops the oldest on a busy repository.
    const prsRaw = gh("api", "--hostname", slug.host, "--paginate", "--slurp", `repos/${slug.owner}/${slug.repo}/pulls?state=open&per_page=100`);
    if (prsRaw === null) return { fail: "gh api over the open pull requests failed; refusing to act without PR state" };
    const pages = parse(prsRaw);
    if (!Array.isArray(pages) || !pages.every((p) => Array.isArray(p))) return { fail: "gh api --paginate --slurp over the open pull requests printed something that is not an array of pages" };
    const pr = pages.flat().find((p) => branchRe.test(String(p?.head?.ref ?? "")));
    if (pr) return { live: `open PR #${pr.number} on ${pr.head.ref}` };
    return {};
  };
  const claimVerb = (...argv) => {
    const r = issueClaim({ argv, cwd: repo, env: process.env });
    const j = parse(String(r.stdout || "").trim().split("\n").pop() || "");
    return j && typeof j === "object" ? j : { result: "unknown", detail: `issue-claim ${argv[0]} printed no JSON (exit ${r.code})` };
  };

  const gate = issueGate();
  if (gate.fail) out(false, gate.fail);
  const pre = liveness();
  if (pre.fail) out(false, pre.fail);
  if (pre.live) out(false, `live: ${pre.live}`);
  const why = action === "clear-orphan" ? `in-progress for ${Math.round(gate.ageMs / 3_600_000)}h with no branch, worktree, claim tag, or open PR`
    : action === "demote-unready" ? `ready-for-agent contract not met: ${reason}`
    : "open with no lifecycle label";
  if (check) {
    // --check runs every gate, and for a tag-holding verb the tag is one of them: a held tag would
    // refuse the real run at acquire, so the check reads it directly rather than take it.
    if (spec.holdTag) {
      const tag = tryGitWithin(60_000, "ls-remote", "--tags", "origin", TAG_REF);
      if (tag === null) out(false, "git ls-remote origin failed or timed out; refusing to report without the claim tag state");
      if (tag !== "") out(false, `claim tag flow-claim-issue-${n} is held on origin; a held claim is a human's to settle`);
    }
    out(true, `check only: would ${spec.past === "cleared" ? "clear" : spec.past === "demoted" ? "demote" : "triage"} (${why})`);
  }

  let receipt = null;
  if (spec.holdTag) {
    const acq = claimVerb("acquire", n);
    if (acq.result === "held") out(false, `claim tag flow-claim-issue-${n} is held on origin; a held claim is a human's to settle (${acq.detail || "no detail"})`);
    if (acq.result !== "acquired" || typeof acq.sha !== "string") out(false, `could not take the claim tag to serialize with the issue stage: ${acq.detail || acq.reason || acq.result}`);
    receipt = acq.sha;
  }
  const giveBack = () => {
    if (receipt === null) return true;
    const back = claimVerb("abandon", n, receipt);
    return back.result === "abandoned" ? true : (back.detail || back.result);
  };
  const settle = (ok, why) => {
    const b = giveBack();
    if (b !== true) out(false, `${why}; and the claim tag could not be given back (${b}), retained: claim-tag`);
    out(ok, why);
  };
  const keep = (why) => out(false, receipt !== null ? `${why}, so the claim tag is kept for a human to settle, retained: claim-tag` : `${why}; a human checks it`);

  // Under the tag (or, for a verb no claim can race, straight away): anything that throws in
  // here still reaches abandon; a tag left behind by an exception would be a lock nobody holds
  // and nobody reports.
  try {
    if (spec.holdTag) {
      const gate2 = issueGate();
      if (gate2.fail) settle(false, `under the claim tag: ${gate2.fail}`);
      const live2 = liveness();
      if (live2.fail) settle(false, `under the claim tag: ${live2.fail}`);
      if (live2.live) settle(false, `under the claim tag, live: ${live2.live}`);
    }
    const editArgs = ["issue", "edit", n, ...repoPin];
    if (spec.remove) editArgs.push("--remove-label", spec.remove);
    editArgs.push("--add-label", spec.add);
    const edited = gh(...editArgs) !== null;

    const back = readIssue();
    if (back.fail) keep("the issue could not be read back after the edit, so its state is unknown");
    const lc = lifecycleOf(back.labels);
    const landed = back.state === "OPEN" && sameSet(lc, final);
    if (!landed) {
      if (back.state === "OPEN" && sameSet(lc, wanted)) {
        if (!edited) settle(false, "gh issue edit failed and the read-back confirms nothing moved");
        keep("the edit was accepted but the read-back shows the labels unchanged");
      }
      keep(`after the edit the issue reads ${back.state} with lifecycle labels [${lc.join(", ")}] instead of OPEN with ${spec.add} alone; ${edited ? "something else moved it in the same window" : "the edit failed part way"}`);
    }
    // Landed. The read-back was the last read; the tag goes back now, before anything else
    // touches the network, so no later call widens the window between the read and the release.
    const b = giveBack();
    if (b !== true) out(false, `${spec.past} (${why}); but the claim tag could not be given back (${b}), retained: claim-tag`);
    const body = action === "clear-orphan" ? `Cleared an orphaned \`in-progress\` claim back to \`ready-for-agent\`: ${why}.`
      : action === "demote-unready" ? `Moved \`ready-for-agent\` back to \`needs-triage\`: ${reason}`
      : "Added \`needs-triage\`: open issue with no lifecycle label.";
    const commented = gh("issue", "comment", n, ...repoPin, "--body", `${body}\n\n- flow nightly lint`) !== null;
    out(true, `${spec.past} (${why})${commented ? "" : "; the comment failed, labels moved"}`);
  } catch (e) {
    settle(false, `unexpected failure under the claim tag: ${String(e?.message || e).slice(0, 200)}`);
  }
}
