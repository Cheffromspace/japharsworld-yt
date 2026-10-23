#!/usr/bin/env bash
# Search relay worker setup for the owner's Optiplex (Debian/Ubuntu), as root. Safe to re-run.
#   sudo RELAY_TOKEN=... bash deploy/relay-setup.sh        (or curl the raw file | sudo RELAY_TOKEN=... bash)
# Installs Node 22 if needed, clones the repo to /opt/japharsworld-yt-relay, runs relay/worker.js as user "jytrelay"
# and a 5-minute update timer. The worker only makes outbound HTTPS requests; nothing here opens a port.
set -euo pipefail
main() {
REPO="${REPO:-https://github.com/Cheffromspace/japharsworld-yt.git}"
APP=/opt/japharsworld-yt-relay
ENVF=/etc/japharsworld-yt-relay.env
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
command -v apt-get >/dev/null || { echo "This script expects Debian/Ubuntu (apt)."; exit 1; }

say "Box"
. /etc/os-release; echo "OS: $PRETTY_NAME   CPU: $(nproc)   RAM: $(free -m | awk '/Mem:/{print $2}') MB   Disk free: $(df -h / | awk 'NR==2{print $4}')"

say "Packages"
export DEBIAN_FRONTEND=noninteractive
need=""; for p in git curl ca-certificates ffmpeg; do dpkg -s "$p" >/dev/null 2>&1 || need="$need $p"; done
[ -z "$need" ] || { apt-get update -qq; apt-get install -y -qq $need >/dev/null; }
node_ok() { command -v node >/dev/null && command -v npm >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }
# The distro's Node when it is new enough (Ubuntu 26.04 ships 22.22), NodeSource otherwise.
if ! node_ok && apt-cache policy nodejs | grep -qE 'Candidate: (22\.(1[3-9]|[2-9][0-9])|2[3-9]\.|[3-9][0-9]\.)'; then
  say "Node (distro)"
  apt-get install -y -qq nodejs npm >/dev/null
fi
if ! node_ok; then
  say "Node 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node --version)"

say "User and app ($REPO)"
id jytrelay >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin jytrelay
if [ -d "$APP/.git" ]; then git -C "$APP" fetch -q origin && git -C "$APP" reset -q --hard origin/main
else git clone -q "$REPO" "$APP"; fi
git config --system --get-all safe.directory | grep -qx "$APP" || git config --system --add safe.directory "$APP"
chown -R jytrelay:jytrelay "$APP"
(cd "$APP" && sudo -u jytrelay HOME="$APP" npm ci --omit=dev --no-audit --no-fund --loglevel=error)

say "Settings ($ENVF)"
if [ ! -f "$ENVF" ]; then
  [ -n "${RELAY_TOKEN:-}" ] || { echo "First run: pass RELAY_TOKEN=... (the same value as in /etc/japharsworld-yt.env on the Linode)."; exit 1; }
  umask 077
  printf 'RELAY_URL=%s\nRELAY_TOKEN=%s\nWORKER_NAME=%s\n' "${RELAY_URL:-https://yt.japharsworld.com}" "$RELAY_TOKEN" "${WORKER_NAME:-optiplex}" > "$ENVF"
elif [ -n "${RELAY_TOKEN:-}" ]; then
  sed -i "s|^RELAY_TOKEN=.*|RELAY_TOKEN=$RELAY_TOKEN|" "$ENVF"
fi
chown root:root "$ENVF"; chmod 600 "$ENVF"
sed 's/^RELAY_TOKEN=.*/RELAY_TOKEN=(set)/' "$ENVF"

say "systemd units"
for unit in japharsworld-yt-relay.service japharsworld-yt-relay-update.service japharsworld-yt-relay-update.timer; do
  install -m 644 "$APP/deploy/$unit" /etc/systemd/system/
done
systemctl daemon-reload
systemctl enable japharsworld-yt-relay.service && systemctl restart japharsworld-yt-relay.service
systemctl enable --now japharsworld-yt-relay-update.timer
sleep 3
systemctl --no-pager --lines=5 status japharsworld-yt-relay.service || true

say "Done"
echo "Logs:   journalctl -u japharsworld-yt-relay -f"
echo "Check:  curl -s https://yt.japharsworld.com/healthz   (workers should be 1)"
}
main "$@"
