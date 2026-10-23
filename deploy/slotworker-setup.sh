#!/usr/bin/env bash
# Channels flash-check worker on the Optiplex (Debian/Ubuntu), as root, after deploy/relay-setup.sh. Safe to re-run.
#   sudo bash /opt/japharsworld-yt-relay/deploy/slotworker-setup.sh
# Installs ffmpeg and python3-venv, yt-dlp in /opt/japharsworld-yt-slotworker-venv, an SSH key for the Linode and the
# 20-minute timer. Prints the line to add to the Linode's /root/.ssh/authorized_keys: the key may only run
# /usr/local/bin/slotmon-remote (claim/submit for runner "optiplex").
set -euo pipefail
main() {
APP=/opt/japharsworld-yt-relay
VENV=/opt/japharsworld-yt-slotworker-venv
STATE=/var/lib/japharsworld-yt-slotworker
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
[ -d "$APP/.git" ] && id jytrelay >/dev/null 2>&1 || { echo "Run deploy/relay-setup.sh first."; exit 1; }

say "Packages"
export DEBIAN_FRONTEND=noninteractive
need=""; for p in ffmpeg python3-venv openssh-client; do dpkg -s "$p" >/dev/null 2>&1 || need="$need $p"; done
[ -z "$need" ] || { apt-get update -qq; apt-get install -y -qq $need >/dev/null; }
ffmpeg -hide_banner -version | head -1

say "yt-dlp ($VENV)"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q -U pip "yt-dlp[default,curl-cffi]"
"$VENV/bin/yt-dlp" --version

say "SSH key ($STATE)"
install -d -m 700 -o jytrelay -g jytrelay "$STATE" "$STATE/.ssh" "$STATE/cache"
[ -f "$STATE/id_ed25519" ] || sudo -u jytrelay ssh-keygen -q -t ed25519 -N "" -C "slotworker@$(hostname)" -f "$STATE/id_ed25519"

say "systemd units"
for unit in japharsworld-yt-slotworker.service japharsworld-yt-slotworker.timer; do install -m 644 "$APP/deploy/$unit" /etc/systemd/system/; done
systemctl daemon-reload
systemctl enable --now japharsworld-yt-slotworker.timer

say "Done"
echo "Add this line to /root/.ssh/authorized_keys on the Linode:"
echo "restrict,command=\"/usr/local/bin/slotmon-remote\" $(cat "$STATE/id_ed25519.pub")"
echo "Run once now: systemctl start japharsworld-yt-slotworker; journalctl -u japharsworld-yt-slotworker -n 20"
}
main "$@"
