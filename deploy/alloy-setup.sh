#!/usr/bin/env bash
# Grafana Cloud monitoring (claude/monitoring.md): installs Grafana Alloy and its config, as root. Safe to re-run
# (once it is installed, update.sh and relay-update.sh re-run it when deploy/alloy* changes).
#   bash deploy/alloy-setup.sh linode      on the Linode   (/opt/japharsworld-yt)
#   bash deploy/alloy-setup.sh optiplex    on the Optiplex (/opt/japharsworld-yt-relay)
# Credentials go in /etc/japharsworld-yt-alloy.env (root only). Alloy stays stopped until they are filled in.
set -euo pipefail
main() {
ROLE=${1:-}
case "$ROLE" in linode|optiplex) ;; *) echo "usage: alloy-setup.sh linode|optiplex"; exit 2 ;; esac
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
ENVF=/etc/japharsworld-yt-alloy.env

if ! command -v alloy >/dev/null 2>&1; then
  apt-get install -y -qq gpg curl >/dev/null
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://apt.grafana.com/gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/grafana.gpg
  chmod 644 /etc/apt/keyrings/grafana.gpg   # apt reads it as _apt
  echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" > /etc/apt/sources.list.d/grafana.list
  apt-get update -qq
  apt-get install -y -qq alloy >/dev/null
fi

if [ ! -f "$ENVF" ]; then
  cat > "$ENVF" <<EOT
# Grafana Cloud (claude/monitoring.md). From grafana.com > your stack > Prometheus > Details:
#   the remote write URL (ends /api/prom/push) and the instance ID (a number, the username).
GRAFANA_PROM_URL=
GRAFANA_PROM_USER=
# An access policy token with metrics:write only (grafana.com > Access Policies).
GRAFANA_CLOUD_TOKEN=
EOT
fi
chown root:root "$ENVF"; chmod 600 "$ENVF"

install -d -m 755 /var/lib/japharsworld-yt-deploy   # deploy markers (deploy/deploy-record.sh, textfile collector)
install -m 644 "$HERE/alloy/$ROLE.alloy" /etc/alloy/config.alloy
# The Debian package reads /etc/default/alloy; point it at our env file too.
mkdir -p /etc/systemd/system/alloy.service.d
cat > /etc/systemd/system/alloy.service.d/japharsworld-yt.conf <<EOT
[Service]
EnvironmentFile=$ENVF
EOT
systemctl daemon-reload

if grep -q '^GRAFANA_CLOUD_TOKEN=.\+' "$ENVF" && grep -q '^GRAFANA_PROM_URL=.\+' "$ENVF"; then
  systemctl enable -q alloy
  systemctl restart alloy
  echo "Alloy ($ROLE): $(systemctl is-active alloy). Logs: journalctl -u alloy"
else
  systemctl disable -q --now alloy 2>/dev/null || true
  echo "Alloy installed but stopped: fill in $ENVF, then: bash $HERE/alloy-setup.sh $ROLE"
fi
}
main "$@"
