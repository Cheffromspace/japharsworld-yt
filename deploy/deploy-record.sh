#!/usr/bin/env bash
# Records the deploy that just happened for the Grafana dashboard's deploy markers (claude/monitoring.md), as root:
#   bash deploy/deploy-record.sh <outcome>     (run from the checkout; outcome: restarted, no_restart, rolled_back)
# Writes a Prometheus text file that Alloy's textfile collector on this host picks up; Alloy adds the host label.
# One series per deployed commit (value = when), so annotations can use the value as the time.
set -euo pipefail
DIR=/var/lib/japharsworld-yt-deploy
install -d -m 755 "$DIR"
commit=$(git rev-parse --short HEAD)
tmp=$(mktemp "$DIR/.deploy.XXXXXX")
cat > "$tmp" <<EOT
# HELP eiok_deploy_timestamp_seconds When main was last deployed on this host (update.sh / relay-update.sh).
# TYPE eiok_deploy_timestamp_seconds gauge
eiok_deploy_timestamp_seconds{commit="$commit",outcome="${1:-unknown}"} $(date +%s)
EOT
chmod 644 "$tmp"
mv -f "$tmp" "$DIR/deploy.prom"
