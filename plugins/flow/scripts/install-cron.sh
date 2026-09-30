#!/usr/bin/env bash
# Install (or refresh) flow's scheduled jobs as systemd user timers. Idempotent: re-running
# overwrites the launcher and units with this plugin's templates and re-enables the timers.
#
#   install-cron.sh install              write the launcher, env file and units; enable the timers
#   install-cron.sh status               timers, last result per job, newest report per job
#   install-cron.sh run <job> [flags...] run one job now in the foreground from $CLAUDE_PLUGIN_ROOT,
#                                        else from the plugin this script is in. Flags go to
#                                        flow-cron.mjs: --dry-run prints the command and starts
#                                        no session, so dropping it would spend a real one.
#   install-cron.sh uninstall            disable the timers, remove the launcher and units
set -eu

root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
tpl="$root/skills/flow/templates/systemd"
units_dir="$HOME/.config/systemd/user"
launcher="$HOME/.local/libexec/flow-cron"
state="${FLOW_STATE:-$HOME/.local/state/flow}"
jobs="lint doc-sweep"

case "${1:-status}" in
install)
  systemctl --user show-environment >/dev/null 2>&1 || { echo "no running systemd user manager; these timers need one" >&2; exit 1; }
  # Probe for node and claude under the PATH the launcher runs with, not this shell's. The
  # launcher hardcodes its PATH, so a binary found only on the installer's PATH (a mise or nvm
  # shim, say) passes an ambient check and is an ENOENT at the first timer fire. The PATH is read
  # from the template so the two never drift, and probed in a subshell so this shell's is intact.
  launcher_path=$(sed -n 's/^[[:space:]]*export PATH="\(.*\)"[[:space:]]*$/\1/p' "$tpl/flow-cron.launcher" | tail -n1)
  [ -n "$launcher_path" ] || { echo "could not read the runtime PATH from $tpl/flow-cron.launcher" >&2; exit 1; }
  launcher_path=${launcher_path//\$HOME/$HOME}
  for bin in node claude; do
    ( PATH="$launcher_path"; command -v "$bin" >/dev/null 2>&1 ) || { echo "$bin is not on the launcher's runtime PATH ($launcher_path); the timers fire under that PATH, not your shell's, so put $bin (or a link to it) in one of those directories" >&2; exit 1; }
  done
  install -D -m 0755 "$tpl/flow-cron.launcher" "$launcher"
  # Nothing is armed until the launcher resolves the plugin for both jobs: an overdue persistent
  # timer fires the moment it is enabled.
  for j in $jobs; do
    "$launcher" "$j" --dry-run >/dev/null || {
      echo "launcher dry-run failed for $j; no unit written, no timer enabled. The launcher reads flow@jakub from $HOME/.claude/plugins/installed_plugins.json at Claude user scope, whichever host runs the pipeline. Fix: claude plugin install flow@jakub --scope user, then re-run this." >&2
      exit 1
    }
  done
  mkdir -p "$units_dir" "$state/reports" "$HOME/.config/flow"
  # systemctl does not carry the installer's env, so the units read it from this file.
  env_file="$HOME/.config/flow/cron.env"
  {
    echo "FLOW_WORKSPACE=${FLOW_WORKSPACE:-$HOME/code}"
    echo "FLOW_STATE=$state"
    # flow-cron.mjs owns the model default, so persist a model only when one was asked for.
    if [ -n "${FLOW_MODEL:-}" ]; then echo "FLOW_MODEL=$FLOW_MODEL"; fi
    echo "FLOW_CRON_TIMEOUT_MIN=${FLOW_CRON_TIMEOUT_MIN:-40}"
  } > "$env_file"
  chmod 0600 "$env_file"
  for j in $jobs; do install -m 0644 "$tpl/flow-$j.service" "$tpl/flow-$j.timer" "$units_dir/"; done
  systemctl --user daemon-reload
  for j in $jobs; do systemctl --user enable --now "flow-$j.timer"; done
  echo "installed: $launcher, $units_dir/flow-{lint,doc-sweep}.{service,timer}, $env_file; reports in $state/reports"
  systemctl --user list-timers --no-pager 'flow-*'
  ;;
status)
  echo "launcher: $([ -x "$launcher" ] && echo "$launcher" || echo "not installed")"
  systemctl --user list-timers --all --no-pager 'flow-*' 2>/dev/null || true
  for j in $jobs; do
    newest=$(find "$state/reports" -maxdepth 1 -name "$j-*.md" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
    printf '%s: last result %s; newest report %s\n' "$j" \
      "$(systemctl --user show "flow-$j.service" -p Result --value 2>/dev/null || echo n/a)" "${newest:-none}"
  done
  ;;
run)
  job="${2:?usage: install-cron.sh run <lint|doc-sweep> [--dry-run]}"
  shift 2
  CLAUDE_PLUGIN_ROOT="$root" exec node "$root/scripts/flow-cron.mjs" "$job" "$@"
  ;;
uninstall)
  for j in $jobs; do
    systemctl --user disable --now "flow-$j.timer" 2>/dev/null || true
    systemctl --user stop "flow-$j.service" 2>/dev/null || true   # a mid-run job dies with its unit
    rm -f "$units_dir/flow-$j.service" "$units_dir/flow-$j.timer"
  done
  rm -f "$launcher"
  systemctl --user daemon-reload
  for j in $jobs; do
    systemctl --user is-active --quiet "flow-$j.service" 2>/dev/null && echo "warn: flow-$j.service is still active" >&2 || true
  done
  echo "removed timers, units and launcher; reports in $state/reports and $HOME/.config/flow/cron.env were kept"
  ;;
*)
  echo "usage: install-cron.sh <install|status|run <job> [--dry-run]|uninstall>" >&2; exit 2 ;;
esac
