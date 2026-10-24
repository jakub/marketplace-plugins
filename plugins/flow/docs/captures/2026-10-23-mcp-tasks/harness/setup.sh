#!/bin/bash
# Builds the capture working directory the other scripts expect, from this checkout. Usage:
#   bash setup.sh <capture-dir> [base-sha]
# <capture-dir> must be new or empty. It gets repo/ (a throwaway git repository with one commit), bin/ (the fake
# codex and claude, with state/ and calls/ baked in), state/, calls/, base/ (`git archive <base-sha> plugins/flow`),
# and mcp-a/b/c.json plus prompt-a/b/b2/c/d.txt. Those last eight are this directory's committed files with the
# author's absolute paths replaced; the committed copies stay as the record of the launch settings.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(git -C "$HERE" rev-parse --show-toplevel)
[ $# -ge 1 ] || { echo "usage: bash setup.sh <capture-dir> [base-sha]" >&2; exit 2; }
BASE=${2:-b92afec8e0fd65a64762db29828f5b1f22cc5d0b}
if [ -e "$1" ] && [ -n "$(ls -A "$1")" ]; then echo "setup: $1 is not empty" >&2; exit 1; fi
mkdir -p "$1"
C=$(cd "$1" && pwd)
NODE_DIR=$(dirname "$(command -v node)")
git -C "$ROOT" cat-file -e "$BASE^{commit}" || { echo "setup: base $BASE is not in $ROOT; fetch it first" >&2; exit 1; }

mkdir -p "$C/repo" "$C/state" "$C/base"
git -C "$C/repo" init -q
echo capture > "$C/repo/a.txt"
git -C "$C/repo" add a.txt
git -C "$C/repo" -c user.name=capture -c user.email=capture@example.invalid commit -q -m "capture repo"

node "$HERE/make-fake.mjs" "$ROOT/plugins/flow/scripts/smoke-delegate.mjs" "$C/bin" "$C/state" "$C/calls"
git -C "$ROOT" archive "$BASE" plugins/flow | tar -x -C "$C/base"

# The committed mcp-*.json and prompt-*.txt name the capture directory, the checkout and the node directory of the
# machine they were taken on. Read those three off mcp-a.json and replace them everywhere.
node --input-type=module - "$HERE" "$C" "$ROOT" "$NODE_DIR" <<'EOF'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
const [here, capture, root, nodeDir] = process.argv.slice(2)
const env = JSON.parse(readFileSync(join(here, 'mcp-a.json'), 'utf8')).mcpServers.flowtasks.env
const oldCapture = dirname(env.FLOW_CAPTURE_LOG)
const oldRoot = oldCapture.replace(/\/\.flow-scratch\/capture$/, '')
const oldNode = env.PATH.split(':').find((d) => d !== `${oldCapture}/bin` && d !== '/usr/bin' && d !== '/bin')
if (oldRoot === oldCapture || !oldNode) throw new Error('mcp-a.json does not have the expected paths')
// The tee ran from the capture directory then; it runs from this directory now. The capture directory goes
// before the checkout because it contains it.
const fix = (s) => s
  .replaceAll(`${oldCapture}/tee.mjs`, join(here, 'tee.mjs'))
  .replaceAll(oldCapture, capture)
  .replaceAll(oldRoot, root)
  .replaceAll(oldNode, nodeDir)
const walk = (v) => typeof v === 'string' ? fix(v) : Array.isArray(v) ? v.map(walk)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v
for (const name of readdirSync(here)) {
  if (/^mcp-.*\.json$/.test(name)) writeFileSync(join(capture, name), JSON.stringify(walk(JSON.parse(readFileSync(join(here, name), 'utf8')))) + '\n')
  else if (/^prompt-.*\.txt$/.test(name)) writeFileSync(join(capture, name), fix(readFileSync(join(here, name), 'utf8')))
}
EOF
echo "setup: $C ready (checkout $ROOT, base $BASE, node $NODE_DIR)"
