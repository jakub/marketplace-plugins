# babysit reference

The edge cases and CLI recipes behind `SKILL.md`. Read the section you hit instead of carrying all of this in every round.

## Triage edge cases

- **`grounded-unresolved` findings.** Give each one bounded investigation: one seat, one named question, and a repro or a code-path trace as the finish condition. Journal its original basis and the result separately. A failed repro doesn't prove the concern false, so an inconclusive result goes to the user.
- **Behavior-finding tests.** Fix a behavior finding from a test that fails for the claimed reason on the current pre-fix head, and keep that test as the regression guard. A red for some other reason proves nothing about the fix, so a setup failure, such as a port the sandbox blocks, isn't a red. Run the test in a lane that can run it, usually you or a native writer; when no lane can, fix on code-path evidence, journal the red as not run, and don't call the fix validated. A docs or design finding gets no artificial test.
- **External claims.** Ground a ruling about behavior outside the repo, such as a library limit or a protocol event, in pinned source or a probe, never in memory, whether you accept or reject the finding.
- **Protected-topic exclusions.** The one exception to "never reject a protected-topic finding yourself" is the user's own answer recorded in the prep journal: quote it and link it, and only when its exclusion matches this finding's input class exactly, caller, access and trust assumptions included. A missing, ambiguous or changed-premise match goes to the user. An agent-written Risk line and a past dismissal of something similar settle nothing.
- **Repeated findings.** A finding raised again gets the prior reason unless it brings new evidence: a materially different reachable path, a different consequence, a different broken obligation, or a refuted premise. Another reviewer repeating the same repro isn't new evidence. A user-settled decision settles the choice it names, not every implementation of it.
- **Expanding scope.** A remedy that changes the approved responsibility, the supported behavior or the trust posture goes to the user before anyone writes it, even for a real finding. A guardrail that takes on more shell semantics is one; extracting a helper isn't.
- **Attribution note.** Every comment or reply on the PR opens with the charter's attribution note using the public name of the model that wrote it (as the harness reports it) and the user's GitHub login (`gh api user --jq .login`). If the harness names no model, name the harness. Never guess. Keep the attribution inside the callout and the reply outside it, with no signature or second attribution. Check the whole reply, quotes included, for secrets and private details before posting.

## Show it: capture, mark up and publish

Put an annotated before/after image inline whenever a round changes something a browser renders, and whenever a criterion's evidence is a browser test or a visible state: in the evidence ledger row for a criterion, and in the thread reply for a fix a reviewer asked for. The image shows the evidence; it isn't the evidence. Keep the committed test's pointer beside it, because `issue` inv.4 needs one a stranger can re-run.

1. **Capture a matched pair.** The before is the PR's base, or the pre-fix head for a fix. The after is the head you're about to push. Take both from the same browser test, each head in its own worktree, with the same data, viewport, theme, device scale and clock, so the only pixels that move are the change. Both images must be the same size, so screenshot the viewport or one element, not a full page whose height the change can move: `markup.mjs` refuses a pair that differs. A Playwright test that already reaches the state is the best source. When the PR adds the view, take the before from the closest base state at the same size (such as the parent route) and say so in the legend, or show no image and say why in the ledger row. Capture only synthetic data, never the user's dev stack, because the image is published.
2. **Mark it up.** Run:
   ```bash
   node <plugin-root>/scripts/markup.mjs --before b.png --after a.png --out <name>.png --spec spec.json --legend
   ```
   The spec numbers and labels each change with boxes in after-image pixels: `{"title": "...", "annotations": [{"n": 1, "box": [x, y, w, h], "label": "..."}]}`. `--auto` boxes the pixel diff for a first look, but label every box before publishing. Exit 3 means Playwright didn't resolve: read why. A refusal of a tracked or planted install is the trust check working, so never point into the checkout; pass `--playwright <package.json>` at an install outside the checkout, which a PR from outside the repo's writers always needs. Open the output and inspect it. In T3 Code when `antigravity` is enabled, pair visual or UI diffs with a `Neon 4 med/high` visual QA pass inspecting the rendered before/after image directly.
3. **Publish it.** Run:
   ```bash
   node <plugin-root>/scripts/evidence-push.mjs <worktree> --pr <N> <file>...
   ```
   It commits the images to `flow-evidence` (never merged, rewritten or deleted) and prints SHA-pinned URLs with ready markdown. Paste the markdown and the legend table into the ledger row or reply. On a public repo the image is world-readable, so check every pixel for secrets, tokens in URLs, real hostnames and personal data before running it.

A later round that changes the same view makes its image stale: capture the pair again. When nothing visible changed, show nothing. When a criterion is visual but no image could make it readable, say so in its ledger row.

## GitHub rate limits

`gh pr view`, `gh pr checks` and the thread mutations use GraphQL, and every session and watcher on the account shares one GraphQL budget. When a read fails, run `gh api rate_limit --jq .resources.graphql`. If `remaining` is near 0, gather through REST, which has its own rate limit, and page every list:

- `gh api repos/<owner>/<repo>/pulls/<n>` for the PR and its head SHA;
- `gh api --paginate repos/<owner>/<repo>/issues/<n>/comments` for top-level comments;
- `gh api --paginate repos/<owner>/<repo>/pulls/<n>/reviews` for review bodies;
- `gh api --paginate repos/<owner>/<repo>/pulls/<n>/comments` for review comments;
- `gh api --paginate repos/<owner>/<repo>/commits/<sha>/check-runs` and `gh api --paginate repos/<owner>/<repo>/commits/<sha>/statuses` for checks.

REST can't tell you whether a thread is resolved, and resolving is GraphQL only, so wait for `reset` before you resolve or call the PR clean. In T3 Code, "Stopped watching, could not read it" usually means this budget ran out: check it before you watch again, and never watch again in a tight loop.
