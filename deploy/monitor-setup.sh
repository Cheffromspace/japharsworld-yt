#!/usr/bin/env bash
# Channels link monitor: one-time setup on the server, as root. Safe to re-run (update.sh re-runs it when monitor files change).
#   bash /opt/japharsworld-yt/deploy/monitor-setup.sh
set -euo pipefail
main() {
APP=/opt/japharsworld-yt
VENV=/opt/japharsworld-yt-monitor-venv
DATA=/var/lib/japharsworld-yt-monitor
ENVF=/etc/japharsworld-yt-monitor.env
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
id jyt >/dev/null 2>&1 || { echo "Run deploy/bootstrap.sh first (it creates the jyt user)."; exit 1; }
command -v ffmpeg >/dev/null || apt-get install -y -qq ffmpeg >/dev/null

[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q -U pip
"$VENV/bin/pip" install -q -r "$APP/monitor/requirements.txt"

install -d -o jyt -g jyt -m 700 "$DATA"
if [ ! -f "$ENVF" ]; then
  cat > "$ENVF" <<EOT
# Channels link monitor settings (secrets: root only). See monitor/README.md.
DATA_DIR=$DATA
CHANNELS=$APP/monitor/channels.json
OVERRIDES=$APP/monitor/overrides.json
YTDLP=/opt/japharsworld-yt-venv/bin/yt-dlp
YTDLP_ARGS="--js-runtimes node"
COOKIES=$DATA/cookies.txt
GIT_SSH_KEY=$DATA/deploy_key
PUBLISH=1
# YouTube Data API key (reads; no expiry). Google Cloud > Credentials > API key, restricted to YouTube Data API v3.
YT_API_KEY=
# OAuth grant for playlist swaps (from Tools/youtube-slots/token.json in the world repo).
YT_CLIENT_ID=
YT_CLIENT_SECRET=
YT_REFRESH_TOKEN=
DISCORD_WEBHOOK=
DISCORD_MENTION=
EOT
  chmod 600 "$ENVF"
fi

if [ ! -f "$DATA/deploy_key" ]; then
  ssh-keygen -q -t ed25519 -N "" -C "slotmon@$(hostname)" -f "$DATA/deploy_key"
  chown jyt:jyt "$DATA/deploy_key" "$DATA/deploy_key.pub"
  echo "New deploy key. Add it to github.com/Cheffromspace/japharsworld-yt > Settings > Deploy keys, with write access:"
  cat "$DATA/deploy_key.pub"
fi

install -m 755 "$APP/deploy/slotmon" /usr/local/bin/slotmon
install -m 755 "$APP/deploy/slotmon-remote" /usr/local/bin/slotmon-remote
for unit in japharsworld-yt-monitor.service japharsworld-yt-monitor.timer; do
  install -m 644 "$APP/deploy/$unit" /etc/systemd/system/
done
systemctl daemon-reload
systemctl enable -q --now japharsworld-yt-monitor.timer
slotmon seed "$APP/monitor/seed/2026-10-17.json"
echo "Monitor timer: $(systemctl is-active japharsworld-yt-monitor.timer). Logs: journalctl -u japharsworld-yt-monitor"
}
main "$@"
