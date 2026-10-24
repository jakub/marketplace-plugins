#!/bin/bash
# Arm (d): Codex 0.164.0 (legacy client) against the PR's server and the base server, through the tee.
# Usage: bash arm-d.sh <pr|base>
set -u
C=/home/jakub/code/marketplace-plugins/.flow-worktrees/marketplace-plugins-issue-34-feat-flow-serve-flow-delegate-jobs-as/.flow-scratch/capture
WT=/home/jakub/code/marketplace-plugins/.flow-worktrees/marketplace-plugins-issue-34-feat-flow-serve-flow-delegate-jobs-as
which=$1
if [ "$which" = pr ]; then MAIN=$WT/plugins/flow/delegate/main.mjs; else MAIN=$C/base/plugins/flow/delegate/main.mjs; fi
rm -f $C/arm-d-$which.jsonl
timeout 240 codex exec --skip-git-repo-check -C $C/repo --dangerously-bypass-approvals-and-sandbox --json -o $C/arm-d-$which.last.txt \
  -c 'mcp_servers.openaiDeveloperDocs.enabled=false' -c 'mcp_servers.node_repl.enabled=false' \
  -c 'mcp_servers.flowtasks.command="node"' -c "mcp_servers.flowtasks.args=[\"$C/tee.mjs\"]" \
  -c "mcp_servers.flowtasks.env={FLOW_CAPTURE_LOG=\"$C/arm-d-$which.jsonl\",FLOW_CAPTURE_ARM=\"d-$which\",FLOW_CAPTURE_MAIN=\"$MAIN\",FLOW_CAPTURE_HOST=\"codex\",FLOW_DELEGATION_STATE_DIR=\"$C/state\",PATH=\"$C/bin:/home/jakub/.local/share/mise/installs/node/26.10.0/bin:/usr/bin:/bin\"}" \
  "$(cat $C/prompt-d.txt)" </dev/null > $C/arm-d-$which.out 2>&1
echo "exit $?"
