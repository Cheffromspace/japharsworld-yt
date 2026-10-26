#!/usr/bin/env bash
# Run by japharsworld-yt-update.timer every 5 minutes (as root).
# Deploys origin/main if it moved; rolls back if the new version fails its health check.
# Once a day also updates yt-dlp, the usual fix when YouTube changes something.
# Commits that only touch docs/, the link monitor, the metrics poller/exporter, Alloy, the search relay worker, public/
# pages (re-read on change), tests, tools, design notes or this script (the monitor publishes docs/ itself) don't restart
# the search service. A restart drops held players and Tunelio builds in flight (2026-10-21: plays during a deploy fell
# back to youtube.com), so it waits until /healthz reports nothing busy: up to 3 min per run, deferred to later runs
# for at most 30 min, then it restarts anyway.
set -euo pipefail
# Wrapped in main() so bash has read the whole script before git reset can rewrite this file.
main() {
APP=/opt/japharsworld-yt
VENV=/opt/japharsworld-yt-venv
PORT=$(sed -n 's/^PORT=//p' /etc/japharsworld-yt.env 2>/dev/null || echo 8790)
STAMP=/var/lib/japharsworld-yt/.ytdlp-updated
DEFER=/var/lib/japharsworld-yt/.deploy-deferred

healthy() { for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
busy() { curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -o '"busy":[0-9]*' | cut -d: -f2 || true; }

if [ ! -f "$STAMP" ] || [ -n "$(find "$STAMP" -mmin +1440)" ]; then
  before=$("$VENV/bin/yt-dlp" --version)
  "$VENV/bin/pip" install -q -U "yt-dlp[default]" && touch "$STAMP"
  after=$("$VENV/bin/yt-dlp" --version)
  [ "$before" = "$after" ] || echo "yt-dlp $before -> $after"
fi

cd "$APP"
git fetch -q origin main
current=$(git rev-parse HEAD); target=$(git rev-parse origin/main)
if [ "$current" = "$target" ]; then
  [ -x /opt/japharsworld-yt-monitor-venv/bin/python ] || bash deploy/monitor-setup.sh
  [ -f /etc/systemd/system/japharsworld-yt-exporter.service ] && [ -f /etc/systemd/system/japharsworld-yt-occupants.timer ] && [ -f /etc/systemd/system/japharsworld-yt-security.timer ] || bash deploy/metrics-setup.sh
  exit 0
fi

echo "deploying $(git log -1 --format='%h %s' "$target")"
changed=$(git diff --name-only "$current" "$target")
# The monitor's own "Channels status" commits (docs/ only) are not deploys worth a marker on the dashboard.
record() { echo "$changed" | grep -qv '^docs/' || return 0; bash deploy/deploy-record.sh "$1" || echo "deploy record failed"; }
lock_changed=$(echo "$changed" | grep -x 'package-lock.json' || true)
service_changed=$(echo "$changed" | grep -v -E '^(docs/|monitor/|relay/|deploy/monitor-setup\.sh$|deploy/slotmon(-remote)?$|deploy/japharsworld-yt-monitor\.|deploy/relay-|deploy/slotworker-|deploy/bgutil-(setup\.sh|pot-relay\.service)$|deploy/bootstrap\.sh$|deploy/japharsworld-yt-slotworker|deploy/japharsworld-yt-relay|metrics/|deploy/metrics-setup\.sh$|deploy/japharsworld-yt-(metrics|exporter|occupants|security).|deploy/alloy|deploy/update\.sh$|deploy/deploy-record\.sh$|public/|test/|tools/|bench/|claude/|grafana/|infra-check/|README\.md$|CLAUDE\.md$|deploy-now\.cmd$|\.gitignore$)' || true)
monitor_setup_changed=$(echo "$changed" | grep -E '^(monitor/requirements\.txt|monitor/seed/|deploy/monitor-setup\.sh|deploy/slotmon|deploy/japharsworld-yt-monitor\.)' || true)
metrics_setup_changed=$(echo "$changed" | grep -E '^(deploy/metrics-setup\.sh|deploy/japharsworld-yt-(metrics|exporter|occupants|security).)' || true)
exporter_changed=$(echo "$changed" | grep -E '^(metrics/exporter\.js|src/metrics\.js)$' || true)
alloy_changed=$(echo "$changed" | grep -E '^deploy/alloy' || true)
if [ -n "$service_changed" ]; then
  for i in $(seq 1 36); do n=$(busy); [ "${n:-0}" -gt 0 ] || break; sleep 5; done
  if [ "${n:-0}" -gt 0 ]; then
    [ -f "$DEFER" ] || touch "$DEFER"
    if [ -z "$(find "$DEFER" -mmin +30)" ]; then echo "search service busy ($n plays/builds in flight); deploy deferred"; exit 0; fi
    echo "search service still busy after 30 min; restarting anyway"
  fi
fi
rm -f "$DEFER"
git reset -q --hard "$target"
if [ -n "$monitor_setup_changed" ] || [ ! -x /opt/japharsworld-yt-monitor-venv/bin/python ]; then
  bash deploy/monitor-setup.sh || echo "monitor setup failed"
fi
# The metrics poller (metrics/) runs from this checkout on its own timer, so its code needs no restart here.
if [ -n "$metrics_setup_changed" ] || [ ! -f /etc/systemd/system/japharsworld-yt-exporter.service ] || [ ! -f /etc/systemd/system/japharsworld-yt-occupants.timer ] || [ ! -f /etc/systemd/system/japharsworld-yt-security.timer ]; then
  bash deploy/metrics-setup.sh || echo "metrics setup failed"
elif [ -n "$exporter_changed" ]; then
  systemctl try-restart japharsworld-yt-exporter.service
fi
# Grafana Alloy is installed by hand once (claude/monitoring.md); after that its config follows main.
if [ -n "$alloy_changed" ] && command -v alloy >/dev/null; then
  bash deploy/alloy-setup.sh linode || echo "alloy setup failed"
fi
if [ -z "$service_changed" ]; then record no_restart; echo "now on $(git rev-parse --short HEAD) (no search service change; not restarted)"; exit 0; fi

[ -z "$lock_changed" ] || npm ci --omit=dev --no-audit --no-fund --loglevel=error
for unit in japharsworld-yt.service bgutil-pot.service japharsworld-yt-update.service japharsworld-yt-update.timer; do
  cmp -s "deploy/$unit" "/etc/systemd/system/$unit" || { install -m 644 "deploy/$unit" /etc/systemd/system/; systemctl daemon-reload; }
done
systemctl restart japharsworld-yt.service
if healthy; then record restarted; echo "now on $(git rev-parse --short HEAD)"; exit 0; fi

echo "health check failed; rolling back to $(git rev-parse --short "$current")"
git reset -q --hard "$current"
[ -z "$lock_changed" ] || npm ci --omit=dev --no-audit --no-fund --loglevel=error
systemctl restart japharsworld-yt.service
record rolled_back
healthy && echo "rolled back" || echo "STILL DOWN after rollback"
exit 1
}
main "$@"
