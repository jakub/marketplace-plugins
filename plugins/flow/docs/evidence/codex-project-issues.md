# Codex project issue workflow verification

Observed on 2026-09-08 UTC with Codex CLI and App Server 0.153.4, Claude Code 2.1.263, and Flow source version 0.37.2. The implementation does not bump the plugin version.

## Behavior and evidence

| Requirement | Reproducible check | Observed result |
| --- | --- | --- |
| Start Flow in the existing Codex project's directory | `node plugins/flow/scripts/smoke-codex-app-workspace.mjs` | Real plugin installation in a disposable home. Two App Server threads connected separate Flow MCP processes in their respective Git roots. No model turns. |
| Install the PATH entrypoint once, then select the manifest's exact version | `node plugins/flow/scripts/smoke-delegate-entrypoint.mjs` | Install, upgrade before any maintenance hook, rollback, local slots, separate Codex homes, eight concurrent installers, protocol epochs, uninstall, home aliases, stale-anchor uninstall recovery, actionable permission failures, and invalid-state cases passed. |
| Preserve MCP transport and process behavior | Same entrypoint smoke | Cwd, arguments, stdin, and direct SIGTERM handling passed. |
| Refuse authority from unrelated directories or inherited project variables | `node plugins/flow/scripts/smoke-delegation.mjs` | Nested worktrees accepted. Sibling worktrees, symlink escapes, home and nonrepository launches, subdirectory widening, and hostile Git/project environment overrides rejected. Full suite passed. |
| Keep issue claims exclusive while moving worktrees inside the repository | `node plugins/flow/scripts/smoke-issue-claim.mjs` and `node plugins/flow/scripts/smoke-issue-claim-verb.mjs` | Real Git concurrency suite passed. Claim verb suite passed 387 checks, including read-only planning and invalid container/metadata paths. |
| Keep lint cleanup compatible with nested issue worktrees | `node plugins/flow/scripts/smoke-lint-actions.mjs` | 41 checks passed. |
| Preserve Claude delegation and Codex hook behavior | `node plugins/flow/scripts/smoke-claude-delegation.mjs` and `node plugins/flow/scripts/smoke-codex-hooks.mjs` | Both suites passed. |
| Ship the bundle corresponding to the reviewed source | Build and conformance commands below | Bundle drift was byte-identical. Charter, stages, and manifests passed. |

## Captured completion lines

```text
Codex app workspace: ALL PASS (codex-cli 0.153.4; Flow 0.37.2; two isolated project threads; no model turns)
delegate entrypoint: ALL PASS
smoke-delegation: ALL PASS
smoke-claude-delegation: ALL PASS
issue claim verb: ALL PASS (387 checks)
issue claim: ALL PASS
41/41 passed
```

Run these from the repository root after installing the locked build dependencies with `npm --prefix plugins/flow/deps ci`:

```sh
npm --prefix plugins/flow/deps run build
node plugins/flow/scripts/smoke-bundle-drift.mjs
node plugins/flow/scripts/smoke-charter-conformance.mjs
node plugins/flow/scripts/smoke-stage-conformance.mjs
node scripts/smoke-plugin-manifests.mjs
```

The App Server check needs an installed Codex executable. The delegation runtime needs Linux, cgroup v2, and a working systemd user manager. Child-process tests ran with normal host execution after the agent sandbox refused process startup. All installation tests used disposable homes.

## Validation limits

This is mechanism-level verification, not a claim that an entire real GitHub issue ran from invocation to PR inside the native app. A separate live Claude writer probe successfully wrote inside a nested worktree and received a denial for a direct write into the canonical checkout. The orchestrator checked both the created file and the absence of the forbidden file. That probe used the installed delegation runtime; the committed tests cover the changed source and startup configuration.

The first installation must finish before the first Flow MCP launch. Codex starts MCP before SessionStart, so the hook maintains an existing installation and cannot bootstrap that earlier launch. Setup runs the installer once; ordinary issue invocations need no shell launcher or new session.

Filesystem checks reject unsafe paths and avoid redirecting installer writes through renamed ancestors. They do not claim isolation from an arbitrary process running as the same Unix user.

## Review record

Three native implementation seats used Astra medium. Two independent Opus high seats reviewed the immutable range from `807dd96c0bdf1dfd426049d8231b2d530a029070` to `f91433ad052bd6157d2908c497979f038db3014a`. Each read the production changes, tests, and documentation, with generated bundle hunks checked against their source. The orchestrator ran the executable checks separately.

The review fixes add home-alias support, explicit uninstall recovery after the old cache disappears, actionable permission and child-directory errors, distinct bundle-startup failure reporting, and preservation of `unknown/repo-unreadable` after claim setup fails. The claim regression failed at all four injected read failures before the fix, then passed with confirmed tag cleanup and no worktree, branch, or issue mutation.

The strict ownership and group/world-write policy remains a documented setup prerequisite. Cache installations and upgrades need a restrictive host umask such as `022`. The installer does not silently change existing file permissions. Generic delegation continues to honor the project's authorized root; the issue stage is responsible for assigning each writer its exact nested worktree. A hypothetical future edit that omits the required dispatcher epoch bump is outside this initial implementation. Unknown registration files deliberately retain the shared launcher during uninstall. The final review verdicts are recorded on the PR.
