#!/usr/bin/env bash
# Read-only worktree audit. Classifies every git worktree of a repo by size, merge
# state, uncommitted work, remote/PR state, and the most recent Claude Code session
# that operated in it, then emits a TSV sorted by size with a suggested bucket.
# Never deletes anything: the nightly lint acts on the `safe` bucket under standing
# permission, everything else is a human decision.
#
# Buckets:
#   hold-wip               tracked uncommitted changes — never prune
#   hold-open-pr           branch has an open PR — keep until land
#   verify-recent-session  a session touched it in the last 4 days — check first
#   safe                   clean, pushed (or nothing to push), PR merged/closed
#   review                 none of the above fit (no remote, no PR, old)
#
# Usage: worktree-audit.sh [repo-path]   (defaults to the current repo)
#
# Ported from Lauren Tan's pstack (MIT, see ../NOTICE): Linux stat, Claude Code
# transcript layout, and squash-merge-aware bucketing.
set -u

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$repo" ] && { echo "not in a git repo; pass a repo path" >&2; exit 1; }
cd "$repo" || exit 1

# Main worktree is the first entry; everything else is a candidate.
main_wt=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')

git fetch origin main --quiet 2>/dev/null || echo "warn: could not fetch origin/main; MERGED column may be stale" >&2

# PR state by branch, fetched once. Empty if gh is unavailable.
prs=$(mktemp)
gh pr list --state all --limit 1000 --json number,state,headRefName 2>/dev/null > "$prs" || echo "[]" > "$prs"

# Claude Code keeps per-project transcripts under ~/.claude/projects/<slug>/ where
# the slug is the absolute path with every "/" replaced by "-".
slug=$(printf '%s' "$main_wt" | sed 's#/#-#g')
transcripts="$HOME/.claude/projects/$slug"
now=$(date +%s)

printf "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_SESSION\tBUCKET\tWORKTREE\n"

git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r wt; do
	[ "$wt" = "$main_wt" ] && continue

	size=$(du -sh "$wt" 2>/dev/null | awk '{print $1}')
	head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
	head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD 2>/dev/null || echo 0)
	age=$([ "$head_ts" -gt 0 ] 2>/dev/null && echo "$(( (now - head_ts) / 86400 ))d" || echo "?")

	# Squash merges leave no ancestry, so PR state is the real signal; this only
	# catches fast-forward/rebase merges.
	git merge-base --is-ancestor "$head" origin/main 2>/dev/null && merged=YES || merged=no

	# Tracked edits are WIP; untracked-only is disposable scratch.
	porcelain=$(git -C "$wt" status --porcelain 2>/dev/null)
	if [ -z "$porcelain" ]; then dirty=clean
	elif printf '%s\n' "$porcelain" | grep -qv '^??'; then
		dirty="wip:$(printf '%s\n' "$porcelain" | grep -cv '^??')"
	else dirty="scratch:$(printf '%s\n' "$porcelain" | grep -c '^??')"; fi

	branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
	if [ -z "$branch" ]; then remote=detached
	elif git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
		[ "$(git -C "$wt" rev-parse "origin/$branch" 2>/dev/null)" = "$head" ] \
			&& remote=pushed \
			|| remote="ahead$(git -C "$wt" rev-list --count "origin/$branch..HEAD" 2>/dev/null)"
	else remote=no-remote; fi

	pr=$([ -n "$branch" ] && jq -r --arg b "$branch" \
		'.[] | select(.headRefName==$b) | "#\(.number)/\(.state)"' "$prs" 2>/dev/null | head -1)
	[ -z "$pr" ] && pr="-"

	# Most recent session whose transcript mentions this worktree path. Match the
	# path followed by "/" or a quote so trawl-issue-49 does not match trawl-issue-490.
	last="-"; last_ts=0
	if [ -d "$transcripts" ]; then
		f=$(rg -l --glob '*.jsonl' -e "${wt}/" -e "${wt}\"" "$transcripts" 2>/dev/null \
			| xargs -r stat -c '%Y %n' 2>/dev/null | sort -rn | head -1)
		if [ -n "$f" ]; then last_ts=${f%% *}
			last=$(date -d "@$last_ts" '+%Y-%m-%d' 2>/dev/null); fi
	fi
	recent=$([ "$last_ts" -gt 0 ] 2>/dev/null && [ $(( (now - last_ts) / 86400 )) -le 4 ] && echo yes || echo no)

	case "$dirty" in wip:*) bucket=hold-wip ;; *)
		case "$pr" in *OPEN*) bucket=hold-open-pr ;; *)
			if [ "$recent" = yes ]; then bucket=verify-recent-session
			else case "$remote" in
				ahead*|no-remote) bucket=review ;;   # unpushed commits would be lost
				*) if [ "$merged" = YES ] || [ "$pr" != "-" ]; then bucket=safe
				   else bucket=review; fi ;;
			esac; fi ;;
		esac ;;
	esac

	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
		"$size" "$age" "$merged" "$dirty" "$remote" "$pr" "$last" "$bucket" "$wt"
done | sort -t$'\t' -k1,1 -rh

rm -f "$prs"
