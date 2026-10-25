#!/usr/bin/env bash
# bgutil PO-token provider for yt-dlp (YouTube wants a proof-of-origin token on caption and stream requests; without
# one it refuses more often). Two parts: the yt-dlp plugin in a venv, and the token server on 127.0.0.1:4416 that the
# plugin finds by default. As root. Safe to re-run; rebuilds the server only when the version changes.
#   bash deploy/bgutil-setup.sh <venv> [unit]     e.g. on the Optiplex (YouTube risk fix 4, owner 2026-10-25):
#   sudo bash /opt/japharsworld-yt-relay/deploy/bgutil-setup.sh /opt/japharsworld-yt-slotworker-venv bgutil-pot-relay.service
#   bash deploy/bgutil-setup.sh --version          the pinned version (deploy/relay-update.sh keeps the plugin on it)
# The Linode's bootstrap.sh calls it without a unit and installs deploy/bgutil-pot.service (user jyt) itself.
set -euo pipefail
main() {
BGUTIL_VERSION=2.0.2
BGUTIL=/opt/bgutil-pot
if [ "${1:-}" = --version ]; then echo "$BGUTIL_VERSION"; return; fi
VENV=${1:?usage: bgutil-setup.sh <venv> [unit]}
UNIT=${2:-}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
[ -x "$VENV/bin/pip" ] || { echo "No venv at $VENV."; exit 1; }
for c in git node npm; do command -v "$c" >/dev/null || { echo "Needs $c."; exit 1; }; done

say "bgutil yt-dlp plugin $BGUTIL_VERSION ($VENV)"
"$VENV/bin/pip" install -q "bgutil-ytdlp-pot-provider==$BGUTIL_VERSION"

say "bgutil PO-token server $BGUTIL_VERSION ($BGUTIL, 127.0.0.1:4416)"
if [ "$(cat "$BGUTIL/.version" 2>/dev/null)" != "$BGUTIL_VERSION" ]; then
  rm -rf "$BGUTIL"
  git clone -q --single-branch --branch "$BGUTIL_VERSION" https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$BGUTIL"
  (cd "$BGUTIL/server" && npm ci --no-audit --no-fund --loglevel=error && npx tsc)
  echo "$BGUTIL_VERSION" > "$BGUTIL/.version"
  [ -z "$UNIT" ] || ! systemctl is-active -q "$UNIT" || systemctl restart "$UNIT"
fi

if [ -n "$UNIT" ]; then
  say "systemd unit $UNIT"
  install -m 644 "$HERE/$UNIT" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now "$UNIT"
  for i in $(seq 1 20); do curl -fsS http://127.0.0.1:4416/ping 2>/dev/null && break; sleep 1; done
  echo
fi
}
main "$@"
