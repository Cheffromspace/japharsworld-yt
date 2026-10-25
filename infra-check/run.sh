#!/usr/bin/env bash
# Weekly YT Search infra check: runs Claude Code headless (it reports on GitHub; its rules are in claude/monitoring.md,
# "Weekly infra check"), then posts the summary to Discord.
set -uo pipefail

BASE="$HOME/yt-infra-check"
ENV_FILE="$BASE/.env"            # CLAUDE_CODE_OAUTH_TOKEN, DISCORD_WEBHOOK_URL, optional GRAFANA_URL/GRAFANA_TOKEN
DATE="$(TZ=America/Chicago date +%F)"
REPORT="$BASE/reports/$DATE.md"
SUMMARY="$BASE/reports/$DATE.summary.txt"
LOG="$BASE/logs/$DATE.json"

mkdir -p "$BASE/reports" "$BASE/logs"
# One run at a time: a manual start during the timer's run would write the same report (#32).
exec 9>"$BASE/.lock"
flock -n 9 || { echo "another infra check is running"; exit 0; }
# A summary left by an earlier run today would make a failed run look like a success.
rm -f "$SUMMARY"
set -a; source "$ENV_FILE"; set +a

discord() {  # discord "<message>" [file]
  local msg="$1" file="${2:-}"
  local payload; payload="$(jq -n --arg c "$msg" '{content: $c, allowed_mentions: {parse: []}}')"
  if [[ -n "$file" && -f "$file" ]]; then
    curl -fsS -m 30 -F "payload_json=$payload" -F "files[0]=@$file" "$DISCORD_WEBHOOK_URL" >/dev/null
  else
    curl -fsS -m 30 -H 'Content-Type: application/json' -d "$payload" "$DISCORD_WEBHOOK_URL" >/dev/null
  fi
}

cd "$BASE"
# The report date is Chicago's, passed in: on its own the agent once filed a run under the UTC date (#32).
timeout 45m claude -p "$(cat "$BASE/prompt.md")

Report date: $DATE (America/Chicago). Report: $REPORT. Summary: $SUMMARY." \
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

discord "$(head -c 1900 "$SUMMARY")" "$REPORT"
# Keep 26 weeks of reports/logs
find "$BASE/reports" "$BASE/logs" -type f -mtime +182 -delete
