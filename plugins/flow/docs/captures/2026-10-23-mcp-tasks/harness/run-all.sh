#!/bin/bash
# Re-takes capture arms (a) to (d) against the worktree's server at its current head. Earlier takes move to takes/.
# Usage: bash run-all.sh
set -u
C=/home/jakub/code/marketplace-plugins/.flow-worktrees/marketplace-plugins-issue-34-feat-flow-serve-flow-delegate-jobs-as/.flow-scratch/capture
WT=/home/jakub/code/marketplace-plugins/.flow-worktrees/marketplace-plugins-issue-34-feat-flow-serve-flow-delegate-jobs-as
PREV=$(sed -n "s/^head: //p" $C/HEAD.txt 2>/dev/null | cut -c1-7); T=$C/takes/${PREV:-unknown}; mkdir -p $T
for f in $C/arm-*.jsonl $C/arm-*.out $C/arm-*.last.txt; do [ -e "$f" ] && mv "$f" $T/; done
[ -d $C/state ] && mv $C/state $C/state-debug-$(date +%s)
{
  echo "head: $(git -C $WT rev-parse HEAD)"
  echo "tree: $(git -C $WT status --porcelain | wc -l) dirty paths"
  echo "claude: $(claude --version)"
  echo "codex: $(codex --version)"
  echo "node: $(node --version)"
  echo "taken: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > $C/HEAD.txt
cat $C/HEAD.txt
echo "== arm a"; node $C/drive.mjs a $C/mcp-a.json $C/repo mcp__flowtasks__delegate_to_codex $C/prompt-a.txt 1 > $C/arm-a.out 2>&1; grep -c . $C/arm-a.jsonl
echo "== arm b"; node $C/drive.mjs b $C/mcp-b.json $C/repo "mcp__flowtasks__delegate_to_codex,TaskStop" $C/prompt-b.txt 1 $C/prompt-b2.txt > $C/arm-b.out 2>&1; grep -c . $C/arm-b.jsonl
echo "== arm c"; node $C/drive.mjs c $C/mcp-c.json $C/repo "Agent,mcp__flowtasks__delegate_to_codex" $C/prompt-c.txt 1 > $C/arm-c.out 2>&1; grep -c . $C/arm-c.jsonl
echo "== arm d pr"; bash $C/arm-d.sh pr; grep -c . $C/arm-d-pr.jsonl
echo "== arm d base"; bash $C/arm-d.sh base; grep -c . $C/arm-d-base.jsonl
echo "== results"; grep -h "RESULT:\|EXIT" $C/arm-a.out $C/arm-b.out $C/arm-c.out | cut -c1-120
