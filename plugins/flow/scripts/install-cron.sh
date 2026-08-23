#!/usr/bin/env bash
# Install (or refresh) flow's scheduled jobs as systemd user timers. Idempotent:
# re-running overwrites the launcher and units with the plugin's current templates
# and re-enables the timers. `status` prints what is installed and when it next runs.
#
#   install-cron.sh install    write launcher + units, daemon-reload, enable --now
#   install-cron.sh status     timers, last result per job, newest report per job
#   install-cron.sh run <job>  start one job now in the foreground (same env as the timer)
#   install-cron.sh uninstall  disable timers and remove launcher + units
set -eu

root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
tpl="$root/skills/flow/templates/systemd"
units_dir="$HOME/.config/systemd/user"
launcher="$HOME/.local/libexec/flow-cron"
state="${FLOW_STATE:-$HOME/.local/state/flow}"
jobs="lint doc-sweep"

case "${1:-status}" in
install)
  command -v claude >/dev/null || { echo "claude is not on PATH; install Claude Code first" >&2; exit 1; }
  command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
  [ -f "$HOME/.claude/plugins/installed_plugins.json" ] || { echo "no installed_plugins.json; install flow@jakub first" >&2; exit 1; }
  mkdir -p "$(dirname "$launcher")" "$units_dir" "$state/reports"
  install -m 0755 "$tpl/flow-cron.launcher" "$launcher"
  for j in $jobs; do
    install -m 0644 "$tpl/flow-$j.service" "$units_dir/flow-$j.service"
    install -m 0644 "$tpl/flow-$j.timer" "$units_dir/flow-$j.timer"
  done
  systemctl --user daemon-reload
  for j in $jobs; do systemctl --user enable --now "flow-$j.timer"; done
  echo "installed: $launcher, $units_dir/flow-{lint,doc-sweep}.{service,timer}; reports in $state/reports"
  systemctl --user list-timers --no-pager 'flow-*'
  ;;
status)
  echo "launcher: $([ -x "$launcher" ] && echo "$launcher" || echo "not installed")"
  systemctl --user list-timers --all --no-pager 'flow-*' 2>/dev/null || true
  for j in $jobs; do
    printf '%s: last result %s; newest report %s\n' "$j" \
      "$(systemctl --user show "flow-$j.service" -p Result --value 2>/dev/null || echo n/a)" \
      "$(ls -1t "$state/reports/$j-"*.md 2>/dev/null | head -1 || echo none)"
  done
  ;;
run)
  job="${2:?usage: install-cron.sh run <lint|doc-sweep>}"
  if [ -x "$launcher" ]; then exec "$launcher" "$job"; else CLAUDE_PLUGIN_ROOT="$root" exec node "$root/scripts/flow-cron.mjs" "$job"; fi
  ;;
uninstall)
  for j in $jobs; do systemctl --user disable --now "flow-$j.timer" 2>/dev/null || true; rm -f "$units_dir/flow-$j.service" "$units_dir/flow-$j.timer"; done
  rm -f "$launcher"
  systemctl --user daemon-reload
  echo "removed timers, units, and launcher; reports in $state/reports were kept"
  ;;
*)
  echo "usage: install-cron.sh <install|status|run <job>|uninstall>" >&2; exit 2 ;;
esac
