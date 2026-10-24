#!/bin/bash
# Copies a finished take from the capture working directory into this checkout's docs tree for the commit: the
# arm outputs, HEAD.txt, arm-e.md and smoke-all.log when present, and every takes/<head>/. The harness files and
# README.md are not copied; they live in the docs tree already.
# Usage: CAPTURE_DIR=<dir> bash assemble.sh     (or: bash assemble.sh <dir>)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(git -C "$HERE" rev-parse --show-toplevel)
C=${1:-${CAPTURE_DIR:-}}
[ -n "$C" ] && [ -f "$C/HEAD.txt" ] || { echo "usage: CAPTURE_DIR=<dir with a finished take> bash assemble.sh" >&2; exit 2; }
C=$(cd "$C" && pwd)
D=$ROOT/plugins/flow/docs/captures/2026-10-23-mcp-tasks
mkdir -p "$D/takes"
cp "$C/HEAD.txt" "$C"/arm-a.jsonl "$C"/arm-a.out "$C"/arm-b.jsonl "$C"/arm-b.out "$C"/arm-c.jsonl "$C"/arm-c.out \
   "$C"/arm-d-pr.jsonl "$C"/arm-d-pr.out "$C"/arm-d-pr.last.txt "$C"/arm-d-base.jsonl "$C"/arm-d-base.out "$C"/arm-d-base.last.txt "$D/"
for extra in arm-e.md smoke-all.log; do [ -f "$C/$extra" ] && cp "$C/$extra" "$D/"; done
for t in "$C"/takes/*/; do [ -d "$t" ] && cp -r "$t" "$D/takes/"; done
# The tee redacts prompt, requestPreview, output, text and message values on the wire; the envelope's summary line
# and the model-turn logs quote the request too, so the copied files get the same redaction here.
find "$D" -maxdepth 1 -type f -name "arm-*" -exec sed -i -E 's/FLOW_FAKE_MODE=[a-z]+ say hello/<redacted prompt>/g' {} +
find "$D/takes" -type f -exec sed -i -E 's/FLOW_FAKE_MODE=[a-z]+ say hello/<redacted prompt>/g' {} +
echo "== secret scan of the capture"
# A match anywhere but this script (which holds the patterns) fails the assembly, so a capture that
# picked up a credential never reaches the docs tree silently. grep exits 1 on no match, 2 on an error.
if matches=$(grep -rIl -E 'sk-ant|ghp_|ghs_|xoxb|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH) PRIVATE' --exclude=assemble.sh "$D"); then
  printf 'secret scan matched:\n%s\n' "$matches" >&2; exit 1
else
  status=$?; [ "$status" -eq 1 ] || { echo "secret scan failed to run (grep exit $status)" >&2; exit "$status"; }
fi
du -sh "$D"
