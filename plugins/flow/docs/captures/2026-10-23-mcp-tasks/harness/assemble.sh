#!/bin/bash
# Copies the capture into the worktree's docs tree for the commit. Usage: bash assemble.sh
set -eu
C=/home/jakub/code/marketplace-plugins/.flow-worktrees/marketplace-plugins-issue-34-feat-flow-serve-flow-delegate-jobs-as/.flow-scratch/capture
D=/home/jakub/code/marketplace-plugins/.flow-worktrees/marketplace-plugins-issue-34-feat-flow-serve-flow-delegate-jobs-as/plugins/flow/docs/captures/2026-10-23-mcp-tasks
mkdir -p $D/harness $D/takes/36eb98f $D/takes/b993d39
cp $C/README.md $C/HEAD.txt $C/arm-a.jsonl $C/arm-a.out $C/arm-b.jsonl $C/arm-b.out $C/arm-c.jsonl $C/arm-c.out \
   $C/arm-d-pr.jsonl $C/arm-d-pr.last.txt $C/arm-d-base.jsonl $C/arm-d-base.last.txt $C/arm-e.md $D/
cp $C/../smoke-all-final.log $D/smoke-all.log
cp $C/tee.mjs $C/drive.mjs $C/make-fake.mjs $C/doctor-probe.mjs $C/arm-d.sh $C/run-all.sh $C/assemble.sh \
   $C/prompt-a.txt $C/prompt-b.txt $C/prompt-b2.txt $C/prompt-c.txt $C/prompt-d.txt \
   $C/mcp-a.json $C/mcp-b.json $C/mcp-c.json $C/settings-plain.json $D/harness/
# The takes of arms (a) to (d) at the two heads before the final one.
cp $C/takes/arm-a.jsonl $C/takes/arm-b.jsonl $C/takes/arm-c.jsonl $C/takes/arm-d-pr.jsonl $C/takes/arm-d-base.jsonl $D/takes/36eb98f/
cp $C/takes/b993d39/arm-a.jsonl $C/takes/b993d39/arm-b.jsonl $C/takes/b993d39/arm-c.jsonl $C/takes/b993d39/arm-d-pr.jsonl $C/takes/b993d39/arm-d-base.jsonl $D/takes/b993d39/
# The tee redacts prompt, requestPreview, output, text and message values on the wire; the envelope's summary line
# and the model-turn logs quote the request too, so the copied files get the same redaction here.
find $D -maxdepth 1 -type f \( -name "arm-*" \) -exec sed -i -E 's/FLOW_FAKE_MODE=[a-z]+ say hello/<redacted prompt>/g' {} +
find $D/takes -type f -exec sed -i -E 's/FLOW_FAKE_MODE=[a-z]+ say hello/<redacted prompt>/g' {} +
echo "== secret scan of the capture (expect only this script, which holds the patterns)"
grep -rIl -E 'sk-ant|ghp_|ghs_|xoxb|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH) PRIVATE' $D || true
du -sh $D
