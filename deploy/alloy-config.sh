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
# A failure is one line in the update script's journal ("alloy setup failed") and is not tried again until another
# deploy/alloy* change: after fixing the cause, run `bash deploy/alloy-setup.sh <linode|optiplex|staging>` by hand
# (claude/monitoring.md, Setup).
set -uo pipefail
NEW=$1 CONF=$2 RESTART=${3:-}
SETTLE=${ALLOY_SETTLE:-8}
if ! alloy fmt "$NEW" >/dev/null 2>&1; then
  echo "alloy fmt can't read $NEW: $CONF left as it was"
  exit 1
fi
if [ -f "$CONF" ] && ! cp -p "$CONF" "$CONF.prev"; then
  echo "could not keep $CONF as $CONF.prev: nothing changed"
  exit 1
fi
# Through a file beside it and a rename, so a failed copy (a full disk) leaves the installed config whole, never a
# part-written one for Alloy's next start to load.
put() { install -m 644 "$1" "$CONF.new" && mv -f "$CONF.new" "$CONF" || { rm -f "$CONF.new"; return 1; }; }
if ! put "$NEW"; then
  echo "could not install $NEW as $CONF: Alloy not restarted"
  exit 1
fi
[ "$RESTART" = restart ] || exit 0
up() {
  for _ in 1 2 3; do sleep "$SETTLE"; systemctl is-active --quiet alloy || return 1; done
}
systemctl restart alloy
if up; then
  echo "Alloy: active with $NEW"
  exit 0
fi
if [ -f "$CONF.prev" ] && put "$CONF.prev"; then
  systemctl restart alloy
  echo "Alloy did not stay up with $NEW: the previous config is back (alloy $(systemctl is-active alloy)). See journalctl -u alloy"
elif [ -f "$CONF.prev" ]; then
  echo "Alloy did not stay up with $NEW, and putting $CONF.prev back failed: $CONF is still the new one. Copy $CONF.prev over it by hand, then systemctl restart alloy"
else
  echo "Alloy did not stay up with $NEW and there was no previous config. See journalctl -u alloy"
fi
exit 1
