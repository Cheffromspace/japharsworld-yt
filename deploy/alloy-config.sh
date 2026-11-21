#!/usr/bin/env bash
# Installs an Alloy config and keeps the one before when the new one doesn't work (Everything-is-OK#967): Alloy is
# every metric a host sends, so a config it can't load would blind the host's alerts at once (eiok-optiplex-silent or
# eiok-linode-silent would be the only sign). Called by deploy/alloy-setup.sh, as root.
#   bash deploy/alloy-config.sh <new config> <installed config> [restart]
# 1. `alloy fmt` must read the new file (syntax); otherwise nothing is touched.
# 2. The installed file is kept as <installed>.prev, the new one put in place.
# 3. With "restart": Alloy is restarted and must stay active through three looks ALLOY_SETTLE seconds apart (an unknown
#    block or argument stops Alloy at its first load; systemd's restarts make it flap between failed and activating).
#    If it doesn't, the .prev file goes back, Alloy is restarted on it, and the script fails.
set -uo pipefail
NEW=$1 CONF=$2 RESTART=${3:-}
SETTLE=${ALLOY_SETTLE:-8}
if ! alloy fmt "$NEW" >/dev/null 2>&1; then
  echo "alloy fmt can't read $NEW: $CONF left as it was"
  exit 1
fi
[ -f "$CONF" ] && cp -p "$CONF" "$CONF.prev"
install -m 644 "$NEW" "$CONF"
[ "$RESTART" = restart ] || exit 0
up() {
  for _ in 1 2 3; do sleep "$SETTLE"; systemctl is-active --quiet alloy || return 1; done
}
systemctl restart alloy
if up; then
  echo "Alloy: active with $NEW"
  exit 0
fi
if [ -f "$CONF.prev" ]; then
  install -m 644 "$CONF.prev" "$CONF"
  systemctl restart alloy
  echo "Alloy did not stay up with $NEW: the previous config is back (alloy $(systemctl is-active alloy)). See journalctl -u alloy"
else
  echo "Alloy did not stay up with $NEW and there was no previous config. See journalctl -u alloy"
fi
exit 1
