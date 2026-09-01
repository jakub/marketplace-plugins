#!/usr/bin/env bash
# Install (or refresh) flow's scheduled jobs as systemd user timers. Idempotent:
# re-running overwrites the launcher and units with the plugin's current templates
# and re-enables the timers. `status` prints what is installed and when it next runs.
# `install` writes nothing at all until a candidate launcher has proved it resolves the
# installed plugin, so a failed install leaves a working one alone.
#
#   install-cron.sh install    write launcher + units, daemon-reload, enable --now
#   install-cron.sh status     timers, last result per job, newest report per job
#   install-cron.sh run <job> [flags…]  run one job now in the foreground (timer env).
#                              Flags after <job> go to flow-cron.mjs - notably --dry-run,
#                              which prints the command instead of spending a real session.
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
  # Every check that does not need a launcher runs before the first write, so a machine
  # that fails one is left exactly as it was found.
  systemctl --user show-environment >/dev/null 2>&1 || { echo "no running systemd user manager; these timers need one - skipping install" >&2; exit 1; }
  command -v claude >/dev/null || { echo "claude is not on PATH; the jobs run as headless Claude sessions - install Claude Code first" >&2; exit 1; }
  command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
  need=("$tpl/flow-cron.launcher" "$root/scripts/flow-cron.mjs")
  for j in $jobs; do need+=("$tpl/flow-$j.service" "$tpl/flow-$j.timer" "$root/skills/flow/cron/$j.md"); done
  for f in "${need[@]}"; do [ -r "$f" ] || { echo "missing or unreadable: $f; $root is not a complete flow install" >&2; exit 1; }; done

  # The launcher is the only thing that can prove the plugin resolves, and proving it
  # means running it. So write a CANDIDATE beside the final path, dry-run both jobs
  # through the candidate, and promote it with a rename only once both pass: a failure
  # here arms nothing and leaves a launcher that already worked untouched. The trap
  # removes the candidate on the failure exit below and on an interrupt mid-dry-run.
  mkdir -p "$(dirname "$launcher")"
  candidate="$launcher.candidate.$$"
  trap 'rm -f "$candidate"' EXIT
  install -m 0755 "$tpl/flow-cron.launcher" "$candidate"
  # Nothing is armed before this passes: a persistent timer that is overdue fires the
  # moment it is enabled.
  for j in $jobs; do
    "$candidate" "$j" --dry-run >/dev/null || {
      printf '%s\n' \
        "launcher dry-run failed for $j; nothing was installed - the candidate launcher is deleted, no units, no env file, no timer enabled, and a launcher that was already there is untouched." \
        "The jobs are Claude-hosted (each one is a headless claude -p session), so flow@jakub has to be installed at Claude USER scope no matter which host you conduct the pipeline from: the launcher reads $HOME/.claude/plugins/installed_plugins.json for a user-scope entry and nothing else." \
        "Fix: claude plugin install flow@jakub --scope user   (then re-run this installer)" >&2
      exit 1
    }
  done
  mv -f "$candidate" "$launcher"

  mkdir -p "$units_dir" "$state/reports" "$HOME/.config/flow"
  # Persist the config the units need: systemctl does not carry the installer's env.
  env_file="$HOME/.config/flow/cron.env"
  {
    echo "FLOW_WORKSPACE=${FLOW_WORKSPACE:-$HOME/code}"
    echo "FLOW_STATE=$state"
    echo "FLOW_MODEL=${FLOW_MODEL:-sonnet}"
    echo "FLOW_CRON_TIMEOUT_MIN=${FLOW_CRON_TIMEOUT_MIN:-40}"
  } > "$env_file"
  chmod 0600 "$env_file"
  for j in $jobs; do
    install -m 0644 "$tpl/flow-$j.service" "$units_dir/flow-$j.service"
    install -m 0644 "$tpl/flow-$j.timer" "$units_dir/flow-$j.timer"
  done
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
      "$(systemctl --user show "flow-$j.service" -p Result --value 2>/dev/null || echo n/a)" \
      "${newest:-none}"
  done
  ;;
run)
  job="${2:?usage: install-cron.sh run <lint|doc-sweep> [--dry-run]}"
  # Everything after the job name belongs to flow-cron.mjs. Dropping it would silently
  # swallow flags like --dry-run, turning a rehearsal into a real headless session.
  shift 2
  if [ -x "$launcher" ]; then exec "$launcher" "$job" "$@"; else CLAUDE_PLUGIN_ROOT="$root" exec node "$root/scripts/flow-cron.mjs" "$job" "$@"; fi
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
  echo "removed timers, units, and launcher; reports in $state/reports and $HOME/.config/flow/cron.env were kept"
  ;;
*)
  echo "usage: install-cron.sh <install|status|run <job> [--dry-run]|uninstall>" >&2; exit 2 ;;
esac
