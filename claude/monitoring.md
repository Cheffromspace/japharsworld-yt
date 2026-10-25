# Monitoring: Grafana Cloud

One dashboard and a few alerts for the whole service, on Grafana Cloud's free tier (owner's choice, 2026-10-20).
`/stats` stays as it is; Discord stays the place alerts arrive.

## What goes where

```
Linode                                                  Optiplex
  metrics/exporter.js  127.0.0.1:9464/metrics             Grafana Alloy: host metrics,
    reads metrics.db, monitor.db, /healthz                  japharsworld-yt-* unit states
  Grafana Alloy: scrapes it, host metrics, unit states,       |
    probes https://yt.japharsworld.com/healthz and            |
    the Pages sleep-list.json                                 |
        \______________ remote_write (metrics only) _________/
                                   |
                         Grafana Cloud (Prometheus)
                    dashboard "Everything is OK" + 6 alert rules -> Discord
```

- **Metrics only, no logs.** The privacy policy says logs stay on the server, so journald is not shipped. What leaves
  is the same aggregate counts `/stats` shows (claude/metrics.md), slot keys and verdicts, and host numbers. No video
  IDs, search text or addresses: the exporter's labels are metric keys that already passed `checkedKey`, slot keys,
  categories and verdicts (`test/exporter.test.js` checks no video ID gets out).
- **Counters** (`eiok_events_total{metric,key}`) are every day's rows summed, so `increase()`/`rate()` work. Latency
  and build-time buckets are real histograms (`eiok_search_seconds`, `eiok_build_progressive_seconds`, …).
  The search service flushes its counts once a minute, so the newest minute lags.
- **Series budget:** about 1,000 active series (74 slots × 7, usage keys, host metrics filtered to what the
  dashboard uses). The free tier allows 10,000.

| Metric | From |
|---|---|
| `eiok_events_total`, `eiok_*_seconds_bucket`, `eiok_credits_remaining`, `eiok_home_today{key}` | metrics.db `daily` / `gauges` |
| `eiok_shard_active_hours_total{shard}` (8 series) | metrics.db `hourly` (one row per hour a shard saw a request) |
| `eiok_poll{source,metric}`, `eiok_poll_timestamp_seconds`, `eiok_release_timestamp_seconds{source,version}` (latest 50, value = when) | metrics.db `polls`, `releases` |
| `eiok_deploy_timestamp_seconds{host,commit,outcome}` (value = when) | `deploy/deploy-record.sh`, run by `update.sh` / `relay-update.sh`, via Alloy's textfile collector (`/var/lib/japharsworld-yt-deploy`) on each host |
| `eiok_slot_{hidden,spare,up,height,flash_max,flash_pass,flash_timestamp_seconds}` | monitor.db `slots` + current stream |
| `eiok_flash_checks_total{verdict}`, `eiok_jobs_pending`, `eiok_jobs_oldest_pending_seconds{reason=daily|other}`, `eiok_worker_last_done_timestamp_seconds{runner}` | monitor.db `flash`, `jobs` |
| `eiok_youtube_quota_units{day}`, `eiok_monitor_last_check_timestamp_seconds` | monitor.db `quota`, `checks` |
| `eiok_search_up`, `eiok_relay_workers_online`, `eiok_tunelio_enabled`, `eiok_youtube_api_units_today` | `/healthz` |
| `node_*`, `node_systemd_unit_state`, `probe_success` | Alloy (`deploy/alloy/*.alloy`) |

## Alerts (Grafana, to Discord)

Only what the services can't say about themselves, plus three the owner asked for on 2026-10-23 (home cap, home
worker, credits pace). Each sends a "resolved" message too (the contact point has resolved messages on). The services'
own Discord alerts send a matching all-clear since 2026-10-23: VRChat login, no search worker, Tunelio down / key /
credits (`alert.resolve`, src/alert.js), and the monitor's quota and API warnings (`discord.resolve`). Notices with no
failed state (credits low, Data API quota, plan renewals, reports) have none.

| Alert | Fires when |
|---|---|
| Home relay near its daily cap | today's home relay MB ≥ 90 % of `HOME_DAILY_MB`, 5 min |
| Home relay has no worker | no media worker connected for 15 min (only while `HOME_RELAY=on`; the gauge isn't set otherwise) |
| Home sent over 50 GB today / 500 GB this month | `eiok_transfer_bytes{host="home"}`: the Optiplex's bytes sent (every interface but `lo`), reported on each relay poll and counted in metrics.db (`transfer`), Chicago days and months, 5 min |
| Linode sent over 700 GB this month | `eiok_transfer_bytes{host="linode",period="month"}`: the Linode's bytes sent, of its 1 TB monthly transfer, 5 min |
| Credits run out before renewal | the last 3 days' credit spend per day × days to the 1st > credits left, for 1 h |
| Linode sends nothing | no `eiok_search_up` from the Linode for 10 min (server, Alloy or exporter down) |
| Optiplex sends nothing | no host metrics from the Optiplex for 15 min |
| Search service down | `/healthz` unanswered on the Linode for 5 min |
| yt.japharsworld.com unreachable | the public `/healthz` probe fails for 10 min (Caddy, TLS, DNS) |
| Flash checks waiting | a new, candidate or manual resolution/flash job has waited over 2 h, or the 14:00 UTC daily batch over 5 h (owner, 2026-10-25: at 6 jobs a run its ~60 jobs take ~3.5 h); the in-app "stalled" alert is at 36 h |
| Disk almost full | under 10 % free on `/`, 15 min |

## Setup (once)

1. **Grafana Cloud:** sign up at grafana.com (free), create a stack. Under the stack's **Prometheus > Details** note the
   remote write URL and the instance ID (username). Under **Access Policies** create a policy with `metrics:write`
   and a token for it.
2. **Linode** (as root): `bash /opt/japharsworld-yt/deploy/alloy-setup.sh linode`, put the URL, ID and token in
   `/etc/japharsworld-yt-alloy.env`, run the same command again. The exporter is already running
   (`systemctl status japharsworld-yt-exporter`; `curl -s 127.0.0.1:9464/metrics | head`).
3. **Optiplex** (as root): `bash /opt/japharsworld-yt-relay/deploy/alloy-setup.sh optiplex`, same env file
   (the same token is fine), run again.
4. **Dashboard and alerts** (any machine with the repo): in the stack create a service account (Editor role) and a
   token, and put the settings in the repo's `.env` (gitignored; real environment variables win):
   ```sh
   GRAFANA_URL=https://calmcanoe396.grafana.net
   GRAFANA_SA_TOKEN=glsa_...
   GRAFANA_DISCORD_WEBHOOK=https://discord.com/api/webhooks/...   # for now the same channel as ALERT_WEBHOOK
   ```
   then `node tools/grafana.mjs push`. It creates the folder, the dashboard (`/d/everything-is-ok`), the Discord
   contact point and the alert rules, and is safe to re-run. To send alerts elsewhere, change
   `GRAFANA_DISCORD_WEBHOOK` and push again. (`GRAFANA_TOKEN` in the same file is the write-only token Alloy uses.)

## Changing things

- **Dashboard or alerts:** edit `tools/grafana.mjs`, `node tools/grafana.mjs build` (refreshes the reviewed copies in
  `grafana/`), then `push`. Edits made in the Grafana UI are overwritten by the next push.
- **Alloy config:** edit `deploy/alloy/<host>.alloy`. Once Alloy is installed, the Linode's `update.sh` and the
  Optiplex's `relay-update.sh` re-run `alloy-setup.sh` when `deploy/alloy*` changes. Check a config first with
  `alloy validate deploy/alloy/linode.alloy` (and `alloy fmt`).
- **New exporter metric:** `metrics/exporter.js` and `test/exporter.test.js`; `update.sh` restarts the exporter when
  `metrics/exporter.js` or `src/metrics.js` changes.

## Weekly infra check (Optiplex agent)

A headless Claude Code run on the Optiplex every Thursday at 06:52 Chicago time (`infra-check/`: `run.sh`,
`prompt.md`, the user timer and the sudoers files; installed in `~/yt-infra-check`, see `infra-check/README.md`). It
checks both hosts and Grafana Cloud and reports on GitHub. **These rules are the agent's instructions** (owner,
2026-10-25). It runs on another machine and can't see this PC's memory or sessions, so anything it must follow goes
here, not in a session's memory. The prompt tells it to read this section from the Optiplex's checkout of `main`
(`/opt/japharsworld-yt-relay/claude/monitoring.md`, updated every 5 minutes).

**What it may do.** Read only: status, logs, metrics, `/healthz`, one test search, Grafana's API, and its own past
reports. The only change it may make is the maintenance its sudoers rule allows, and only when a host's `/` is
**85 % used or more**: `journalctl --vacuum-size=500M`, then `logrotate -f /etc/logrotate.conf` if that wasn't
enough. It logs each with the command, the disk use before and after, and what was lost (journal history before a
date).

**What it never does,** even where its sudo rule would allow it: deploys, git commits or pushes, config or unit edits,
service restarts, reboots, package installs or upgrades, deleting data, caches or media, channel list or credential
changes, Tunelio settings, world uploads. A crashed service is a finding, not something to restart. Anything it
wants done becomes an issue for the coordinator (the Everything is OK coordinating session) to triage.

**Where it reports** (`Cheffromspace/japharsworld-yt`, with `gh` on the Optiplex):
1. **Weekly report:** a comment on the standing issue #33 "Weekly infra check" (`area:monitoring`, `infra-check`;
   never closed), with the full report. The Discord post from `run.sh` stays the short summary.
2. **New finding** (something broken, degraded or trending the wrong way that no open issue covers): first search the
   open issues (`gh issue list --label infra-check --state open`, and `gh issue list --search "<key words>"` by title)
   for a duplicate. If one exists, comment there with this week's numbers. Otherwise open an issue titled with the
   symptom, labelled `infra-check` plus one area label (`area:monitoring`, `area:flash-check`, … from
   `gh label list`), with the evidence, since when, and a suggested fix. The weekly comment links it.
3. **Recovered:** when an earlier finding has recovered, comment on its issue ("recovered as of <date>: <numbers>").
   **It never closes an issue**; the coordinator does.
4. Suggestions that aren't findings (cost savings, tuning) go in the weekly comment, not in new issues, unless they
   need a decision from the owner.

**Public repo:** reports and issues are public. No secrets, tokens or webhook URLs, no IP addresses or SSH account
names, no visitor data (search text, video IDs from visitors' plays, VRChat user or instance IDs). Counts and
timings are fine.

**Its sudoers rules** (`infra-check/sudoers-*`) allow only the two maintenance commands. The copies installed on
2026-10-24 also allowed service restarts (on the Linode including the owner's mediamtx). The rule above forbids those
either way; the owner reinstalls the narrowed files.
