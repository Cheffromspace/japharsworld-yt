Weekly infrastructure check for the YouTube search feature of Jonathan's VRChat world "Everything is OK". You are running headless via `claude -p` on the Optiplex (Linux, home network). Check health, write a report, file findings and make suggestions. This run is read only, apart from the maintenance the rules below allow. No one is watching this run; never wait for input.

**Your rules come first:** read the section "Weekly infra check (Optiplex agent)" in `/opt/japharsworld-yt-relay/claude/monitoring.md` (this machine's checkout of the project's `main`) before anything else. It says what you may and may not do and how to report on GitHub; where it differs from this prompt, it wins. Read the rest of that file too (monitoring notes).

## Architecture
- **Linode** (reach with `ssh linode-check`, a non-root account): `japharsworld-yt.service` (the YouTube search API, served at yt.japharsworld.com behind `caddy.service`), `bgutil-pot.service` (localhost-only PO-token provider for yt-dlp), `japharsworld-yt-exporter.service` (Prometheus exporter for Grafana Cloud), `alloy.service` (ships metrics/logs to Grafana Cloud), `mediamtx.service` (Jonathan's RTMP/RTSP desktop streaming). The Channels monitor (curated 24/7 live-stream list, Discord alerts) also lives here; find how it runs (timer, cron or script).
- **Optiplex** (this machine, home network, Comcast residential IP to get past YouTube's bot wall): `japharsworld-yt-relay.service`, an outbound-only worker that long-polls yt.japharsworld.com and never listens, plus `alloy.service`. Nothing on the home network accepts inbound connections, by design: never change that. The video flash-detection pre-scan (accessibility feature) is meant to run on the Optiplex; report whether it exists and where.
- **Grafana Cloud** holds the metrics/logs/dashboards (latency, play-to-picture, search, Tunelio credit use, VRChat world stats, whatever exists). Query it via its HTTP API with `$GRAFANA_URL` and `$GRAFANA_TOKEN` (read-only) if set; otherwise rely on local checks and say so.
- tunelio.dev (Pro plan) provides HD YouTube media; Jonathan wants credit use as lean as possible.
- Priority: the world must never feel janky. Hangs, slow loads and play-to-picture latency matter most.
- Previous reports are in `~/yt-infra-check/reports/`. Read the most recent one first and compare against it.

## Checks (Optiplex locally, Linode over SSH)
Uptime/reboots, load, memory, swap, disk usage and growth; state of every unit listed above; restarts and crash loops this week; error/warning counts and notable new errors in logs since the last report; TLS expiry on yt.japharsworld.com; a live end-to-end test search with response time, and whether it was served through the Optiplex relay or fell back; relay long-poll health (reconnects, queue/backlog, latency); bgutil-pot and yt-dlp health (bot-wall/PO-token errors, yt-dlp version age); whether Alloy and the exporter are actually delivering to Grafana Cloud; pending security updates (report only); Grafana alerts fired this week and week-over-week trends (latency, error rate, hangs, Tunelio credits, flash-scan backlog/timing, Channels monitor findings such as dead or non-live channels).

## Security (both hosts, last 7 days, read only)
Compare with the security baseline (path at the end of this prompt; local, never in the repo) and with last week's security report. If the baseline is missing, say so and list what you found as a proposed baseline, without writing the baseline file.
- SSH logins: accepted logins (user, key fingerprint, source IP); failed and invalid-user attempts (counts, top source IPs), against last week. Linode: `journalctl -u ssh` / `/var/log/auth.log`; Optiplex: the same (it has no `lastb`).
- `authorized_keys` of every account and the accounts that can log in (a real shell in `/etc/passwd`), against the baseline.
- sshd hardening still in force: `sudo -n sshd -T` shows `passwordauthentication no`, `kbdinteractiveauthentication no`, `permitrootlogin prohibit-password`.
- Linode fail2ban: `sudo -n fail2ban-client status sshd` (currently and total banned).
- Listening ports (`ss -tlnp`, with `sudo -n` on the Optiplex) and `sudo -n ufw status verbose`, against the baseline.
- systemd units and timers (`systemctl list-unit-files`, `systemctl list-timers --all`) and crontabs (`/etc/cron*`, `crontab -l`) new or changed this week; files changed under `/etc` in the last 7 days (`find /etc -newermt '-7 days' -type f`; paths only).
- The env files (`/etc/japharsworld-yt*.env`) still owned by root with mode 0600: `stat` only, never read their contents.
- Pending security updates and `/var/run/reboot-required`.
- Caddy on the Linode: requests for scanner paths (`/wp-*`, `/.env`, `/.git`, `*.php`, …) and status counts, from its journal.
- MediaMTX on the Linode: publish or authentication failures from its journal.

Write the details to the security report (path at the end of this prompt). They never go in the public report, the issue #33 comment, other issues or the Discord summary text: the public report gets one line, "Security: green/yellow/red, details in the local report". The wrapper attaches the security report to the Discord post. Anything red (a login you can't account for, a key or account not in the baseline, sshd hardening off, a new listening port, an env file readable by others, a reboot pending for a security update) makes the summary's first line start with "SECURITY:". A red security item is filed as a GitHub issue only as "Security finding on <host>, see the local report of <date>", with no details.

## Changes: maintenance only
The only change allowed is the journal vacuum or logrotate that the rules section allows, on the Optiplex only, above its disk threshold (the Linode is read only: a full disk there is a finding). Always use `sudo -n` (never prompt). No restarts, even of a crashed service, and even though `sudo -n -l` may still list restart commands: report it as a finding instead. Everything else you'd want done (restarts, config edits, package updates, reboots, deleting caches or data, firewall/router/network/port changes, anything exposing the home network, the channel list, credentials, Tunelio settings, git pushes, world uploads) becomes an issue for the coordinator to triage, as the rules section describes.

## Output
The report date is given at the end of this prompt (Chicago time); use it for the file names, not the UTC date.
1. Write the full report to `~/yt-infra-check/reports/<date>.md`. Sections: status at a glance (green/yellow/red per component), what changed since last week, issues found (with their issue numbers), maintenance done (command, disk before/after), suggestions ranked by impact on visitor experience, anything that needs Jonathan.
2. File new findings, and comment on existing and recovered ones, as the rules section says. Then post the full report as a comment on the standing issue (`gh issue comment 33 --body-file ~/yt-infra-check/reports/<date>.md`). The repo is public: follow the rules section's list of what never goes in. If `gh` fails, say so in the summary and carry on.
3. Write a short Discord summary (max 1,800 characters: overall status emoji, one line per component, new or recovered issues, top suggestion, and the link to this week's comment) to `~/yt-infra-check/reports/<date>.summary.txt`. Write it last: the wrapper treats a missing summary as a failed run. Do not post it yourself; the wrapper script sends it with the full report attached. Never put secrets or webhook URLs in either file.
4. Final message: 2–3 lines. Keep everything concise; no padding when everything's green.
