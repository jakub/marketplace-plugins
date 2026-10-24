#!/bin/bash
# The non-seat control: runs `claude` interactively in a tmux pane and records what a human would see
# when an MCP server elicits input. Usage:
#   bash tty-control.sh <output-dir>
# <output-dir> must be new or empty. It gets server.jsonl (server.mjs's log), mcp.json (the generated
# --mcp-config), form-dialog.txt and url-dialog.txt (`tmux capture-pane -p` after each request), and
# final-pane.txt. server.mjs runs with no ELICIT_GATE, so it elicits two seconds after the handshake.
#
# CLAUDE_BIN names the claude binary (default `claude`). The session is a plain tty session, not a
# seat, so the Elicitation hook of the flow plugin, if installed, must exit without declining. Every
# wait is bounded. On a timeout the script prints the pane and exits 1. A trap kills the tmux session
# and removes the scratch project directory.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
[ $# -eq 1 ] || { echo "usage: bash tty-control.sh <output-dir>" >&2; exit 2; }
if [ -e "$1" ] && [ -n "$(ls -A "$1")" ]; then echo "tty-control: $1 is not empty" >&2; exit 1; fi
mkdir -p "$1"
OUT=$(cd "$1" && pwd)
CLAUDE_BIN=${CLAUDE_BIN:-claude}
NODE_BIN=$(command -v node)
SESSION="elicit-tty-$$"
LOG="$OUT/server.jsonl"
PROJECT=$(mktemp -d "${TMPDIR:-/tmp}/elicit-tty.XXXXXX")

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -rf -- "$PROJECT"
}
trap cleanup EXIT

command -v tmux >/dev/null || { echo "tty-control: tmux is not installed" >&2; exit 1; }

"$NODE_BIN" --input-type=module - "$OUT/mcp.json" "$HERE/server.mjs" "$LOG" "$NODE_BIN" <<'JS'
import { writeFileSync } from 'node:fs'
const [file, server, log, node] = process.argv.slice(2)
writeFileSync(file, JSON.stringify({
  mcpServers: { elicit: { command: node, args: [server], env: { ELICIT_LOG: log } } },
}, null, 2) + '\n')
JS

pane() { tmux capture-pane -p -t "$SESSION" 2>/dev/null || true; }

fail() {
  echo "tty-control: $1" >&2
  echo "---- pane ----" >&2
  pane >&2
  echo "---- server log tail ----" >&2
  tail -n 5 "$LOG" >&2 2>/dev/null || true
  exit 1
}

# wait_for <what> <seconds> <fixed-string> [trust]
# Polls the server log for the fixed string. With a fourth argument it also presses Enter on a
# folder-trust prompt, once, because a fresh scratch directory raises one before the session starts.
wait_for() {
  local what=$1 secs=$2 needle=$3 trust=${4:-} pressed=0 i
  for ((i = 0; i < secs * 2; i++)); do
    if [ -f "$LOG" ] && grep -qF -- "$needle" "$LOG"; then return 0; fi
    if [ -n "$trust" ] && [ "$pressed" -eq 0 ] && pane | grep -qiE 'trust (the files|this folder)'; then
      tmux send-keys -t "$SESSION" Enter
      pressed=1
    fi
    tmux has-session -t "$SESSION" 2>/dev/null || fail "claude exited before $what"
    sleep 0.5
  done
  fail "timed out after ${secs}s waiting for $what"
}

tmux new-session -d -s "$SESSION" -x 140 -y 50 -c "$PROJECT" \
  "$CLAUDE_BIN" --mcp-config "$OUT/mcp.json" --strict-mcp-config

wait_for "the form elicitation to be sent" 120 '"method":"elicitation/create","id":1000' trust
sleep 2
pane > "$OUT/form-dialog.txt"
tmux send-keys -t "$SESSION" Escape

wait_for "the url elicitation to be sent" 30 '"mode":"url"'
sleep 2
pane > "$OUT/url-dialog.txt"
tmux send-keys -t "$SESSION" Escape

wait_for "the summary line" 45 '"kind":"summary"'
pane > "$OUT/final-pane.txt"
echo "tty-control: done. $(grep -F '"kind":"summary"' "$LOG" | tail -n 1)"
echo "tty-control: output in $OUT"
