#!/usr/bin/env bash
# Metrics (claude/metrics.md): one-time setup on the server, as root. Safe to re-run (update.sh runs it when its files change).
#   bash /opt/japharsworld-yt/deploy/metrics-setup.sh
set -euo pipefail
main() {
APP=/opt/japharsworld-yt
MAIN=/etc/japharsworld-yt.env
ENVF=/etc/japharsworld-yt-metrics.env
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }

# The search service's side: where the counters go, and the /stats token.
restart=0
grep -q '^METRICS_DB=' "$MAIN" || { echo 'METRICS_DB=/var/lib/japharsworld-yt/metrics.db' >> "$MAIN"; restart=1; }
grep -q '^STATS_TOKEN=' "$MAIN" || { echo "STATS_TOKEN=$(openssl rand -hex 24)" >> "$MAIN"; restart=1; }

if [ ! -f "$ENVF" ]; then
  cat > "$ENVF" <<EOT
# Metrics poller secrets (root only). See claude/metrics.md in the repo.
# VRChat account (cookie login with TOTP 2FA). The poller keeps the two cookies below up to date itself.
VRCHAT_USERNAME=
VRCHAT_PASSWORD=
VRCHAT_TOTP_SECRET=
VRCHAT_AUTH_COOKIE=
VRCHAT_2FA_COOKIE=
# The group whose member counts are recorded (grp_...). Empty = none.
VRCHAT_GROUP_ID=
# Contact for the User-Agent VRChat asks for ("app/version contact").
METRICS_CONTACT=
# GitHub fine-grained token, read only: Metadata + Administration (traffic) on the two repos. Empty = public numbers only.
GITHUB_TOKEN=
EOT
fi
chown root:root "$ENVF"; chmod 600 "$ENVF"

for unit in japharsworld-yt-metrics.service japharsworld-yt-metrics.timer japharsworld-yt-occupants.service japharsworld-yt-occupants.timer japharsworld-yt-exporter.service japharsworld-yt-security.service japharsworld-yt-security.timer; do
  install -m 644 "$APP/deploy/$unit" /etc/systemd/system/
done
systemctl daemon-reload
systemctl enable -q --now japharsworld-yt-metrics.timer japharsworld-yt-occupants.timer
# Security counters (metrics/security.js) into Alloy's textfile folder; the folder deploy-record.sh uses.
install -d -m 755 /var/lib/japharsworld-yt-deploy
systemctl enable -q --now japharsworld-yt-security.timer
# The Prometheus exporter for Grafana Cloud (claude/monitoring.md); loopback only.
systemctl enable -q japharsworld-yt-exporter.service
systemctl restart japharsworld-yt-exporter.service
[ "$restart" = 0 ] || systemctl restart japharsworld-yt.service
echo "Metrics timer: $(systemctl is-active japharsworld-yt-metrics.timer), exporter: $(systemctl is-active japharsworld-yt-exporter). Logs: journalctl -u japharsworld-yt-metrics"
}
main "$@"
