#!/usr/bin/env bash
# Daily S3 backup (metrics/backup.js, Everything-is-OK#585): install the units and the root-only env file, as root.
#   bash /opt/japharsworld-yt/deploy/backup-setup.sh            install/refresh; the timer stays as it was
#   bash /opt/japharsworld-yt/deploy/backup-setup.sh --enable   also start the daily timer (needs the owner's go)
#   bash /opt/japharsworld-yt/deploy/backup-setup.sh --disable  stop it, and set its state file aside so Grafana's
#                                                               eiok-backup-missing doesn't fire for a planned stop
#   systemctl start japharsworld-yt-backup                      one run now; journalctl -u japharsworld-yt-backup
# claude/backup.md has the manual re-run of one day and the keyless local test.
# update.sh re-runs it (without flags) when its files change and the units are already installed.
set -euo pipefail
main() {
APP=/opt/japharsworld-yt
ENVF=/etc/japharsworld-yt-backup.env
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
umask 077
if [ ! -f "$ENVF" ]; then
  cat > "$ENVF" <<EOT
# Daily S3 backup secrets (root only, mode 600). See claude/backup.md in the repo. Never commit these.
# The private bucket and its region; objects go under <prefix>/<yyyy>/<mm>/<dd>/.
BACKUP_S3_BUCKET=
BACKUP_S3_REGION=us-east-1
BACKUP_S3_PREFIX=eiok
# The IAM user that can only s3:PutObject under that prefix (created by the owner in the IAM console).
BACKUP_AWS_ACCESS_KEY_ID=
BACKUP_AWS_SECRET_ACCESS_KEY=
# Optional, off (owner, #591: skipped for now). Grafana Cloud Prometheus query URL (…/api/prom), its user (instance ID) and an access-policy token with metrics:read
# only. Empty = the Grafana-only summary is skipped.
BACKUP_PROM_URL=
BACKUP_PROM_USER=
BACKUP_PROM_TOKEN=
# tickets.db holds search results (video IDs, titles, under room numbers), kept with no time limit, which
# public/privacy.html doesn't list for S3: off unless the owner decides otherwise and the privacy page says so.
BACKUP_TICKETS=off
EOT
fi
chown root:root "$ENVF"; chmod 600 "$ENVF"
umask 022
install -m 644 "$APP/deploy/japharsworld-yt-backup.service" "$APP/deploy/japharsworld-yt-backup.timer" /etc/systemd/system/
systemctl daemon-reload
case "${1:-}" in
  --enable) systemctl enable -q --now japharsworld-yt-backup.timer ;;
  --disable)
    systemctl disable -q --now japharsworld-yt-backup.timer
    STATE=/var/lib/japharsworld-yt/backup-state.json
    [ ! -f "$STATE" ] || mv -f "$STATE" "$STATE.disabled" ;;
esac
echo "Backup timer: $(systemctl is-enabled japharsworld-yt-backup.timer 2>/dev/null || true), $(systemctl is-active japharsworld-yt-backup.timer 2>/dev/null || true). Env file: $ENVF (600). Logs: journalctl -u japharsworld-yt-backup"
}
main "$@"
