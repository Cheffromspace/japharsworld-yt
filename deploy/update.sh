#!/usr/bin/env bash
# Run by japharsworld-yt-update.timer every 5 minutes (as root).
# Deploys origin/main if it moved; rolls back if the new version fails its health check.
# Once a day also updates yt-dlp, the usual fix when YouTube changes something.
set -euo pipefail
APP=/opt/japharsworld-yt
VENV=/opt/japharsworld-yt-venv
PORT=$(sed -n 's/^PORT=//p' /etc/japharsworld-yt.env 2>/dev/null || echo 8790)
STAMP=/var/lib/japharsworld-yt/.ytdlp-updated

healthy() { for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

if [ ! -f "$STAMP" ] || [ -n "$(find "$STAMP" -mmin +1440)" ]; then
  before=$("$VENV/bin/yt-dlp" --version)
  "$VENV/bin/pip" install -q -U "yt-dlp[default]" && touch "$STAMP"
  after=$("$VENV/bin/yt-dlp" --version)
  [ "$before" = "$after" ] || echo "yt-dlp $before -> $after"
fi

cd "$APP"
git fetch -q origin main
current=$(git rev-parse HEAD); target=$(git rev-parse origin/main)
[ "$current" = "$target" ] && exit 0

echo "deploying $(git log -1 --format='%h %s' "$target")"
lock_changed=$(git diff --name-only "$current" "$target" -- package-lock.json)
git reset -q --hard "$target"
[ -z "$lock_changed" ] || npm ci --omit=dev --no-audit --no-fund --loglevel=error
for unit in japharsworld-yt.service bgutil-pot.service japharsworld-yt-update.service japharsworld-yt-update.timer; do
  cmp -s "deploy/$unit" "/etc/systemd/system/$unit" || { install -m 644 "deploy/$unit" /etc/systemd/system/; systemctl daemon-reload; }
done
systemctl restart japharsworld-yt.service
if healthy; then echo "now on $(git rev-parse --short HEAD)"; exit 0; fi

echo "health check failed; rolling back to $(git rev-parse --short "$current")"
git reset -q --hard "$current"
[ -z "$lock_changed" ] || npm ci --omit=dev --no-audit --no-fund --loglevel=error
systemctl restart japharsworld-yt.service
healthy && echo "rolled back" || echo "STILL DOWN after rollback"
exit 1
