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
| `eiok_flash_checks_total{verdict}`, `eiok_jobs_pending`, `eiok_jobs_oldest_pending_seconds`, `eiok_worker_last_done_timestamp_seconds{runner}` | monitor.db `flash`, `jobs` |
| `eiok_youtube_quota_units{day}`, `eiok_monitor_last_check_timestamp_seconds` | monitor.db `quota`, `checks` |
| `eiok_search_up`, `eiok_relay_workers_online`, `eiok_tunelio_enabled`, `eiok_youtube_api_units_today` | `/healthz` |
| `node_*`, `node_systemd_unit_state`, `probe_success` | Alloy (`deploy/alloy/*.alloy`) |

## Alerts (Grafana, to Discord)

Only what the services can't say about themselves; their own Discord alerts are unchanged.

| Alert | Fires when |
|---|---|
| Linode sends nothing | no `eiok_search_up` from the Linode for 10 min (server, Alloy or exporter down) |
| Optiplex sends nothing | no host metrics from the Optiplex for 15 min |
| Search service down | `/healthz` unanswered on the Linode for 5 min |
| yt.japharsworld.com unreachable | the public `/healthz` probe fails for 10 min (Caddy, TLS, DNS) |
| Flash checks waiting | a resolution/flash job has waited over 2 h (the in-app "stalled" alert is at 36 h) |
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
