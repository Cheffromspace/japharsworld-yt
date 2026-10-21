#!/usr/bin/env bash
# Run by japharsworld-yt-relay-update.timer on the Optiplex every 5 minutes (as root).
# Pulls origin/main; restarts the worker when something it runs changed (relay/, src/, packages, its units).
# Once a day also updates the flash-check worker's yt-dlp (when that worker is set up).
set -euo pipefail
# Wrapped in main() so bash has read the whole script before git reset can rewrite this file.
main() {
APP=/opt/japharsworld-yt-relay
VENV=/opt/japharsworld-yt-slotworker-venv
STAMP=/var/lib/japharsworld-yt-slotworker/.ytdlp-updated
if [ -x "$VENV/bin/pip" ] && { [ ! -f "$STAMP" ] || [ -n "$(find "$STAMP" -mmin +1440)" ]; }; then
  before=$("$VENV/bin/yt-dlp" --version)
  "$VENV/bin/pip" install -q -U "yt-dlp[default]" && touch "$STAMP"
  after=$("$VENV/bin/yt-dlp" --version)
  [ "$before" = "$after" ] || echo "yt-dlp $before -> $after"
fi
cd "$APP"
git fetch -q origin main
current=$(git rev-parse HEAD); target=$(git rev-parse origin/main)
[ "$current" != "$target" ] || exit 0
changed=$(git diff --name-only "$current" "$target")
git reset -q --hard "$target"
chown -R jytrelay:jytrelay "$APP"
if echo "$changed" | grep -qx 'package-lock.json'; then sudo -u jytrelay npm ci --omit=dev --no-audit --no-fund --loglevel=error; fi
for unit in japharsworld-yt-relay.service japharsworld-yt-relay-update.service japharsworld-yt-relay-update.timer     $( [ -f /etc/systemd/system/japharsworld-yt-slotworker.timer ] && echo japharsworld-yt-slotworker.service japharsworld-yt-slotworker.timer ); do
  cmp -s "deploy/$unit" "/etc/systemd/system/$unit" || { install -m 644 "deploy/$unit" /etc/systemd/system/; systemctl daemon-reload; }
done
# Grafana Alloy (claude/monitoring.md), once it has been set up here.
if command -v alloy >/dev/null && echo "$changed" | grep -qE '^deploy/alloy'; then bash deploy/alloy-setup.sh optiplex || echo "alloy setup failed"; fi
if echo "$changed" | grep -qE '^(relay/|src/|package(-lock)?\.json$|deploy/japharsworld-yt-relay)'; then
  systemctl restart japharsworld-yt-relay.service
  echo "worker restarted on $(git log -1 --format='%h %s')"
else
  echo "now on $(git rev-parse --short HEAD) (nothing the worker runs changed)"
fi
}
main "$@"
