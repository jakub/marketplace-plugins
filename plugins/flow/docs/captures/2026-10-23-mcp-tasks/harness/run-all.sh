#!/bin/bash
# Re-takes capture arms (a) to (d) against this checkout's server at its current head. Earlier takes move to takes/.
# Usage: CAPTURE_DIR=<dir> bash run-all.sh     (or: bash run-all.sh <dir>; <dir> comes from setup.sh)
# Stops at the first arm whose driver exits non-zero and exits 1 naming it.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(git -C "$HERE" rev-parse --show-toplevel)
C=${1:-${CAPTURE_DIR:-}}
[ -n "$C" ] && [ -d "$C/repo" ] || { echo "usage: CAPTURE_DIR=<dir from setup.sh> bash run-all.sh" >&2; exit 2; }
C=$(cd "$C" && pwd)  # children run from other directories, so the path has to be absolute
export CAPTURE_DIR=$C
fail() { echo "arm $1 failed (exit $2); see $C/arm-$1.out" >&2; exit 1; }

PREV=$(sed -n "s/^head: //p" "$C/HEAD.txt" 2>/dev/null | cut -c1-7); T=$C/takes/${PREV:-unknown}
for f in "$C"/arm-*.jsonl "$C"/arm-*.out "$C"/arm-*.last.txt; do [ -e "$f" ] && { mkdir -p "$T"; mv "$f" "$T/"; }; done
[ -d "$C/state" ] && mv "$C/state" "$C/state-debug-$(date +%s)"
{
  echo "head: $(git -C "$ROOT" rev-parse HEAD)"
  echo "tree: $(git -C "$ROOT" status --porcelain | wc -l) dirty paths"
  echo "claude: $(claude --version)"
  echo "codex: $(codex --version)"
  echo "node: $(node --version)"
  echo "taken: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$C/HEAD.txt"
cat "$C/HEAD.txt"
echo "== arm a"; node "$HERE/drive.mjs" a "$C/mcp-a.json" "$C/repo" mcp__flowtasks__delegate_to_codex "$C/prompt-a.txt" 1 > "$C/arm-a.out" 2>&1 || fail a $?; grep -c . "$C/arm-a.jsonl"
echo "== arm b"; node "$HERE/drive.mjs" b "$C/mcp-b.json" "$C/repo" "mcp__flowtasks__delegate_to_codex,TaskStop" "$C/prompt-b.txt" 1 "$C/prompt-b2.txt" > "$C/arm-b.out" 2>&1 || fail b $?; grep -c . "$C/arm-b.jsonl"
echo "== arm c"; node "$HERE/drive.mjs" c "$C/mcp-c.json" "$C/repo" "Agent,mcp__flowtasks__delegate_to_codex" "$C/prompt-c.txt" 1 > "$C/arm-c.out" 2>&1 || fail c $?; grep -c . "$C/arm-c.jsonl"
echo "== arm d pr"; bash "$HERE/arm-d.sh" pr || fail d-pr $?; grep -c . "$C/arm-d-pr.jsonl"
echo "== arm d base"; bash "$HERE/arm-d.sh" base || fail d-base $?; grep -c . "$C/arm-d-base.jsonl"
echo "== results"; grep -h "RESULT:\|EXIT" "$C/arm-a.out" "$C/arm-b.out" "$C/arm-c.out" | cut -c1-120
