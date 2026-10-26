#!/usr/bin/env bash
# Weekly YT Search infra check: runs Claude Code headless (it reports on GitHub; its rules are in claude/monitoring.md,
# "Weekly infra check"), then posts the summary to Discord. The code runs from the relay worker's checkout of main
# (/opt/japharsworld-yt-relay/infra-check; owner 2026-10-26: a push deploys it), the data stays in ~/yt-infra-check.
set -uo pipefail

KIT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"   # this script's folder: prompt.md
BASE="$HOME/yt-infra-check"      # .env, reports/, logs/, security-baseline.md (never in the repo)
ENV_FILE="$BASE/.env"            # CLAUDE_CODE_OAUTH_TOKEN, DISCORD_WEBHOOK_URL, optional GRAFANA_URL/GRAFANA_TOKEN
DATE="$(TZ=America/Chicago date +%F)"
REPORT="$BASE/reports/$DATE.md"
SUMMARY="$BASE/reports/$DATE.summary.txt"
# Security details (IP addresses, key fingerprints, ports) stay on this machine, as does the baseline they are
# compared with: the repo and issue #33 are public. Discord gets the file attached.
SECURITY="$BASE/reports/$DATE.security.md"
BASELINE="$BASE/security-baseline.md"
LOG="$BASE/logs/$DATE.json"

mkdir -p "$BASE/reports" "$BASE/logs"
# One run at a time: a manual start during the timer's run would write the same report (#32).
exec 9>"$BASE/.lock"
flock -n 9 || { echo "another infra check is running"; exit 0; }
# A summary left by an earlier run today would make a failed run look like a success.
rm -f "$SUMMARY" "$SECURITY"
set -a; source "$ENV_FILE"; set +a

discord() {  # discord "<message>" [file] [second file]
  local msg="$1" file="${2:-}" file2="${3:-}"
  local payload; payload="$(jq -n --arg c "$msg" '{content: $c, allowed_mentions: {parse: []}}')"
  if [[ -n "$file" && -f "$file" ]]; then
    local extra=()
    [[ -n "$file2" && -f "$file2" ]] && extra=(-F "files[1]=@$file2")
    curl -fsS -m 30 -F "payload_json=$payload" -F "files[0]=@$file" "${extra[@]}" "$DISCORD_WEBHOOK_URL" >/dev/null
  else
    curl -fsS -m 30 -H 'Content-Type: application/json' -d "$payload" "$DISCORD_WEBHOOK_URL" >/dev/null
  fi
}

cd "$BASE"
# The report date is Chicago's, passed in: on its own the agent once filed a run under the UTC date (#32).
timeout 45m claude -p "$(cat "$KIT/prompt.md")

Report date: $DATE (America/Chicago). Report: $REPORT. Summary: $SUMMARY. Security report: $SECURITY. Security baseline: $BASELINE." \
  --allowedTools "Bash,Read,Write" \
  --permission-prompts none \
  --output-format json > "$LOG" 2>"$BASE/logs/$DATE.stderr"
rc=$?

result="$(jq -r '.result // empty' "$LOG" 2>/dev/null)"

if [[ $rc -ne 0 || ! -f "$SUMMARY" ]]; then
  if grep -qiE 'not logged in|login|authenticat|token expired|oauth' "$LOG" "$BASE/logs/$DATE.stderr" 2>/dev/null; then
    discord "🔑 **YT Search infra check couldn't run: Claude Code login expired.** On the Optiplex run \`claude setup-token\`, then update CLAUDE_CODE_OAUTH_TOKEN in ~/yt-infra-check/.env and \`systemctl --user start yt-infra-check\`."
  else
    discord "🔴 **YT Search infra check failed** (exit $rc). ${result:0:1500}
Logs: ~/yt-infra-check/logs/$DATE.*"
  fi
  exit 1
fi

discord "$(head -c 1900 "$SUMMARY")" "$REPORT" "$SECURITY"
# Keep 26 weeks of reports/logs
find "$BASE/reports" "$BASE/logs" -type f -mtime +182 -delete
