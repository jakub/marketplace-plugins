#!/bin/bash
# Arm (d): Codex 0.164.0 (legacy client) against the PR's server and the base server, through the tee.
# Usage: CAPTURE_DIR=<dir> bash arm-d.sh <pr|base>     (or: bash arm-d.sh <pr|base> <dir>)
# CODEX_DISABLE_SERVERS: space-separated names of your own Codex MCP servers to switch off for the run, so the
# model cannot pick one. The take in this directory ran with "openaiDeveloperDocs node_repl". Unset by default.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(git -C "$HERE" rev-parse --show-toplevel)
C=${2:-${CAPTURE_DIR:-}}
which=${1:-}
if [ -z "$C" ] || { [ "$which" != pr ] && [ "$which" != base ]; }; then echo "usage: CAPTURE_DIR=<dir> bash arm-d.sh <pr|base>" >&2; exit 2; fi
[ -d "$C" ] || { echo "arm-d.sh: $C is not a directory" >&2; exit 2; }
C=$(cd "$C" && pwd)  # the server reads its paths from the environment, so the path has to be absolute
NODE_DIR=$(dirname "$(command -v node)")
if [ "$which" = pr ]; then MAIN=$ROOT/plugins/flow/delegate/main.mjs; else MAIN=$C/base/plugins/flow/delegate/main.mjs; fi
DISABLE=()
for server in ${CODEX_DISABLE_SERVERS:-}; do DISABLE+=(-c "mcp_servers.$server.enabled=false"); done
rm -f "$C/arm-d-$which.jsonl"
timeout 240 codex exec --skip-git-repo-check -C "$C/repo" --dangerously-bypass-approvals-and-sandbox --json -o "$C/arm-d-$which.last.txt" \
  ${DISABLE[@]+"${DISABLE[@]}"} \
  -c 'mcp_servers.flowtasks.command="node"' -c "mcp_servers.flowtasks.args=[\"$HERE/tee.mjs\"]" \
  -c "mcp_servers.flowtasks.env={FLOW_CAPTURE_LOG=\"$C/arm-d-$which.jsonl\",FLOW_CAPTURE_ARM=\"d-$which\",FLOW_CAPTURE_MAIN=\"$MAIN\",FLOW_CAPTURE_HOST=\"codex\",FLOW_DELEGATION_STATE_DIR=\"$C/state\",PATH=\"$C/bin:$NODE_DIR:/usr/bin:/bin\"}" \
  "$(cat "$C/prompt-d.txt")" </dev/null > "$C/arm-d-$which.out" 2>&1
rc=$?
echo "exit $rc"
exit $rc
