#!/usr/bin/env bash
# Run by japharsworld-yt-relay-update.timer on the Optiplex every 5 minutes (as root).
# Pulls origin/main; restarts the worker when something it runs changed (relay/, src/, packages, its units).
# Once a day also updates the flash-check worker's yt-dlp (when that worker is set up), which the relay worker runs too;
# at once when curl_cffi is missing (#15: yt-dlp's browser impersonation needs it; without it every run warned
# "no impersonate target is available").
# A staging worker (#160) runs this from its own update unit with RELAY_APP, RELAY_BRANCH, RELAY_UNIT and RELAY_SETUP=off
# (deploy/japharsworld-yt-relay-staging-update.service): its own checkout, branch and units only. The shared yt-dlp,
# bgutil, flash-check, Alloy and deploy-marker steps stay with the production worker. Unset = production, as before.
set -euo pipefail
# Wrapped in main() so bash has read the whole script before git reset can rewrite this file.
main() {
APP=${RELAY_APP:-/opt/japharsworld-yt-relay}
BRANCH=${RELAY_BRANCH:-main}
UNIT=${RELAY_UNIT:-japharsworld-yt-relay}
SETUP=${RELAY_SETUP:-on}
VENV=/opt/japharsworld-yt-slotworker-venv
STAMP=/var/lib/japharsworld-yt-slotworker/.ytdlp-updated
if [ "$SETUP" = on ] && [ -x "$VENV/bin/pip" ] && { [ ! -f "$STAMP" ] || [ -n "$(find "$STAMP" -mmin +1440)" ] || ! "$VENV/bin/python" -c 'import curl_cffi' 2>/dev/null; }; then
  before=$("$VENV/bin/yt-dlp" --version)
  # Keeps the bgutil plugin on the version deploy/bgutil-setup.sh pins, once that has run here.
  pin=$( [ -f /etc/systemd/system/bgutil-pot-relay.service ] && echo "bgutil-ytdlp-pot-provider==$(bash "$APP/deploy/bgutil-setup.sh" --version)" || true)
  "$VENV/bin/pip" install -q -U "yt-dlp[default,curl-cffi]" $pin && touch "$STAMP"
  after=$("$VENV/bin/yt-dlp" --version)
  [ "$before" = "$after" ] || echo "yt-dlp $before -> $after"
fi
cd "$APP"
git fetch -q origin "$BRANCH"
current=$(git rev-parse HEAD); target=$(git rev-parse "origin/$BRANCH")
[ "$current" != "$target" ] || exit 0
changed=$(git diff --name-only "$current" "$target")
git reset -q --hard "$target"
chown -R jytrelay:jytrelay "$APP"
if echo "$changed" | grep -qx 'package-lock.json'; then sudo -u jytrelay npm ci --omit=dev --no-audit --no-fund --loglevel=error; fi
if [ "$SETUP" = on ]; then
  units="japharsworld-yt-relay.service japharsworld-yt-relay-update.service japharsworld-yt-relay-update.timer $( [ -f /etc/systemd/system/japharsworld-yt-slotworker.timer ] && echo japharsworld-yt-slotworker.service japharsworld-yt-slotworker.timer ) $( [ -f /etc/systemd/system/bgutil-pot-relay.service ] && echo bgutil-pot-relay.service )"
else
  units="$UNIT.service $UNIT-update.service $UNIT-update.timer"
fi
for unit in $units; do
  cmp -s "deploy/$unit" "/etc/systemd/system/$unit" || { install -m 644 "deploy/$unit" /etc/systemd/system/; systemctl daemon-reload; }
done
# A new bgutil version: plugin and server together (deploy/bgutil-setup.sh restarts the server), once it is set up here.
if [ "$SETUP" = on ] && [ -f /etc/systemd/system/bgutil-pot-relay.service ] && echo "$changed" | grep -qx 'deploy/bgutil-setup.sh'; then
  bash deploy/bgutil-setup.sh "$VENV" bgutil-pot-relay.service || echo "bgutil setup failed"
fi
# Grafana Alloy (claude/monitoring.md), once it has been set up here.
if [ "$SETUP" = on ] && command -v alloy >/dev/null && echo "$changed" | grep -qE '^deploy/alloy'; then bash deploy/alloy-setup.sh optiplex || echo "alloy setup failed"; fi
if echo "$changed" | grep -qE '^(relay/|src/|package(-lock)?\.json$|deploy/japharsworld-yt-relay)'; then
  systemctl restart "$UNIT.service"
  echo "worker restarted on $(git log -1 --format='%h %s')"
  outcome=restarted
else
  outcome=no_restart
  echo "now on $(git rev-parse --short HEAD) (nothing the worker runs changed)"
fi
# Deploy marker for the dashboard; the monitor's docs/-only status commits are skipped.
if [ "$SETUP" = on ] && echo "$changed" | grep -qv '^docs/'; then bash deploy/deploy-record.sh "$outcome" || echo "deploy record failed"; fi
}
main "$@"
