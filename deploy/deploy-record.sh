#!/usr/bin/env bash
# Records the deploy that just happened for the Grafana dashboard's deploy markers (claude/monitoring.md), as root:
#   bash deploy/deploy-record.sh <outcome>     (run from the checkout; outcome: restarted, no_restart, rolled_back)
# Appends to a log here and rewrites a Prometheus text file from its last 30 deploys, which Alloy's textfile collector
# on this host picks up (Alloy adds the host label). One series per deployed commit, value = when, so the dashboard
# marks each deploy at its own time and lists the history, not only the last one. The first run seeds the log from
# git's reflog (deploys before this existed; outcome "earlier"), skipping the monitor's "Channels status" commits.
set -euo pipefail
DIR=/var/lib/japharsworld-yt-deploy
LOG=$DIR/deploys.log
install -d -m 755 "$DIR"
if [ ! -f "$LOG" ]; then
  git log -g -n 300 --date=unix --format='%gd %h %s' HEAD 2>/dev/null \
    | grep -v ' Channels status:' | sed -n 's/^HEAD@{\([0-9]*\)} \([0-9a-f]*\) .*/\1 \2 earlier/p' | head -n 30 | tac > "$LOG" || true
fi
echo "$(date +%s) $(git rev-parse --short HEAD) ${1:-unknown}" >> "$LOG"
tail -n 200 "$LOG" > "$LOG.tmp" && mv -f "$LOG.tmp" "$LOG"
tmp=$(mktemp "$DIR/.deploy.XXXXXX")
{
  echo '# HELP eiok_deploy_timestamp_seconds Deploys of main on this host, the last 30 (value = when; update.sh / relay-update.sh).'
  echo '# TYPE eiok_deploy_timestamp_seconds gauge'
  # Newest first, one line per commit (a commit deployed twice keeps its latest time and outcome).
  tac "$LOG" | awk '!seen[$2]++' | head -n 30 | awk '{ printf "eiok_deploy_timestamp_seconds{commit=\"%s\",outcome=\"%s\"} %s\n", $2, $3, $1 }'
  echo '# HELP eiok_deploy_current 1 for the commit this host runs now.'
  echo '# TYPE eiok_deploy_current gauge'
  echo "eiok_deploy_current{commit=\"$(git rev-parse --short HEAD)\"} 1"
} > "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$DIR/deploy.prom"
