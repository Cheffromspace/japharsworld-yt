# Monitoring: Grafana Cloud

One dashboard and a few alerts for the whole service, on Grafana Cloud's free tier (owner's choice, 2026-10-20).
`/stats` stays as it is; Discord stays the place alerts arrive.

## What goes where

```
Linode                                                  Optiplex
  metrics/exporter.js  127.0.0.1:9464/metrics             Grafana Alloy: host metrics,
    reads metrics.db, monitor.db, /healthz                  japharsworld-yt-* unit states
  Grafana Alloy: scrapes it, host metrics, unit states,       |
    probes https://yt.japharsworld.com/healthz,               |
    https://eiok.cc/healthz and the Pages sleep-list.json     |
        \______________ remote_write (metrics only) _________/
                                   |
                         Grafana Cloud (Prometheus)
                    dashboard "Everything is OK" + 19 alert rules -> Discord
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
| `eiok_home_today{key="cap_builds"}` | the running service's `/ops/state` (`home.cap.builds`), with `STATS_TOKEN` from the exporter's env; only that number |
| `eiok_service_memory_bytes{kind=anon\|swap}`, `eiok_service_memory_limit_bytes` | the search service's cgroup (`memory.stat`, `memory.swap.current`, `memory.max`), read at scrape time |
| `eiok_shard_active_hours_total{shard}` (8 series) | metrics.db `hourly` (one row per hour a shard saw a request) |
| `eiok_poll{source,metric}`, `eiok_poll_timestamp_seconds`, `eiok_release_timestamp_seconds{source,version}` (latest 50, value = when) | metrics.db `polls`, `releases` |
| `eiok_deploy_timestamp_seconds{host,commit,outcome}` (value = when) | `deploy/deploy-record.sh`, run by `update.sh` / `relay-update.sh`, via Alloy's textfile collector (`/var/lib/japharsworld-yt-deploy`) on each host |
| `eiok_slot_{hidden,spare,up,height,flash_max,flash_pass,flash_timestamp_seconds}` | monitor.db `slots` + current stream |
| `eiok_flash_checks_total{verdict}`, `eiok_jobs_pending`, `eiok_jobs_oldest_pending_seconds{reason=daily|other}`, `eiok_worker_last_done_timestamp_seconds{runner}` | monitor.db `flash`, `jobs` |
| `eiok_youtube_quota_units{day}`, `eiok_monitor_last_check_timestamp_seconds` | monitor.db `quota`, `checks` |
| `eiok_search_up`, `eiok_relay_workers_online`, `eiok_tunelio_enabled`, `eiok_youtube_api_units_today` | `/healthz` |
| `node_*`, `node_systemd_unit_state`, `probe_success` | Alloy (`deploy/alloy/*.alloy`) |
| `node_systemd_service_restart_total{host,name}` | Alloy's systemd collector with `enable_restarts` on every host: systemd's `NRestarts`, the restarts a unit's `Restart=` made (Everything-is-OK#967) |
| `namedprocess_namegroup_memory_bytes{groupname,memtype}` | Alloy's process exporter on the Optiplex only: resident and swapped bytes of each relay worker process alone (`track_children = false`: not its yt-dlp and ffmpeg children), group `relay` (production) and `relay-staging`, matched on the command line joined with spaces as process-exporter v0.8.7 does (`/usr/bin/node /opt/japharsworld-yt-relay/relay/worker.js`). Collected only: no rule reads it until a day of readings is in (Everything-is-OK#967, #968). No command line or user name leaves the machine |

## Alerts (Grafana, to Discord)

Only what the services can't say about themselves, plus three the owner asked for on 2026-10-23 (home cap, home
worker, credits pace). Each sends a "resolved" message too (the contact point has resolved messages on). The services'
own Discord alerts send a matching all-clear since 2026-10-23: VRChat login, no search worker, Tunelio down / key /
credits, YouTube refusing the home relay (`yt_refused`: 3 or more bot/rate/PO-token refusals within 15 min, all-clear
after an hour without one, src/refusal.js; since 2026-10-25) (`alert.resolve`, src/alert.js), and the monitor's quota and API warnings (`discord.resolve`). Notices with no
failed state (credits low, Data API quota, plan renewals, reports) have none.

| Alert | Fires when |
|---|---|
| Home relay MB near its daily cap | today's home relay MB ≥ 75 % of `HOME_DAILY_MB` as the service reports it, 5 min |
| Home relay builds near their daily cap | today's home builds ≥ 90 % of `HOME_DAILY_BUILDS` as the service reports it, 5 min |
| Linode CPU over 80 % | under 20 % idle across its vCPUs, 15 min |
| Search service memory near its limit | anon + swap > 90 % of the live `memory.max`, page cache not counted, 15 min |
| Searches failing (502) | 2 or more `search_fail` 502 in 15 min |
| Alert inputs missing | `cap_builds`, the memory limit, `days_to_renewal`, `cc_outcome`, the search service's or home worker's restart counter, the production worker's memory, `video_fail` `captions` or `http_5xx` `ticket` absent for 30 min, so those alerts would be silently blind |
| Home relay has no worker | no media worker connected for 15 min (only while `HOME_RELAY=on`; the gauge isn't set otherwise) |
| Home sent over 100 GB today / 2,000 GB this month (no ISP cap, owner 2026-10-27: unusual volume, not a limit) | `eiok_transfer_bytes{host="home"}`: the Optiplex's bytes sent (every interface but `lo`), reported on each relay poll and counted in metrics.db (`transfer`), Chicago days and months, 5 min |
| Linode sent over 700 GB this month | `eiok_transfer_bytes{host="linode",period="month"}`: the Linode's bytes sent, of its 1 TB monthly transfer, 5 min |
| Credits run out before renewal | the last 3 days' credit spend per day × `eiok_poll{source="tunelio_plan",metric="days_to_renewal"}` (from `TUNELIO_RENEWS_DAY`) > credits left, for 1 h. Prod's counted spend only |
| Linode sends nothing | no `eiok_search_up` from the Linode for 10 min (server, Alloy or exporter down) |
| Optiplex sends nothing | no host metrics from the Optiplex for 15 min |
| Search service down | `/healthz` unanswered on the Linode for 5 min |
| yt.japharsworld.com unreachable | the public `/healthz` probe fails for 10 min (Caddy, TLS, DNS) |
| eiok.cc unreachable | the same for `https://eiok.cc/healthz`, the short domain of the world's Quest search box (owner, 2026-10-25) |
| TLS certificate expiring | under 14 days left on either probe's certificate (`probe_ssl_earliest_cert_expiry`), 1 h. Caddy renews at 30, so this means renewal is failing |
| Domain expires within 30 days / 7 days | `eiok_poll{source="domain:<name>",metric="expires"}` (epoch seconds, from RDAP) minus now, 1 h. The 7-day rule is labelled `severity: critical`, the others `warning`. Domains: eiok.cc, japharsworld.com |
| Domain expiry check failing | a domain's last good RDAP answer is over 3 days old, or there never was one, 1 h. Without it a broken check would hide an expiry |
| Flash checks waiting | a new, candidate or manual resolution/flash job has waited over 2 h, or the 14:00 UTC daily batch over 5 h (owner, 2026-10-25: at 6 jobs a run its ~60 jobs take ~3.5 h); the in-app "stalled" alert is at 36 h |
| Searches not served by the home relay | the home worker is online (`eiok_relay_workers_online > 0`), but over half of the last 30 min's searches (at least 3) came from the Linode or the Data API, 5 min: a worker that answers but is refused, which `no_worker` misses (owner, 2026-10-25) |
| Captions falling back to Tunelio | over 6 h, Tunelio answered more caption fetches (at least 3) than the home relay and local yt-dlp together, 30 min. Not "estimated timing above real": manual tracks never carry word timing, and that held on normal days (10-24: 104 estimated, 71 real) |
| Tunelio open or reopen failed | `increase(eiok_tunelio_probe_reopen_fail_total[6h]) + increase(eiok_tunelio_probe_open_fail_total[6h]) > 0`, at once: the speed probe could not resume a cut link at the byte reached (another status, the wrong offset, or no first byte in 10 s), which would turn a reset into a visible freeze, or all three first opens of a read failed that way, which can mean Tunelio stopped honouring Range. The cause can be the Linode's own network, because any fetch error counts. The cut rate is only a panel until there is a baseline (Everything-is-OK#361) |
| No video has caption tracks | over 6 h, 5 or more distinct videos had no tracks and none had any (`cc_outcome`, world #428), at once: a silent total failure. Stays after hypercare's own check of this ends. A partial failure, with some tracks still coming through, doesn't fire |
| Caption lookups failing | caption requests answered `temporarily_unavailable` or `failed` in **3 or more different half-hours** of the last 6 h (a subquery at the half-hour marks, so up to 30 min late), at once: the sources stopped answering, which `cc_outcome` never sees. One room's burst for one stuck video fills one half-hour (two if it crosses a mark) and stays quiet; it doesn't depend on other videos being fetched. In quiet hours one room asking about the same stuck video across more than an hour can still fire it. Pushed within 6 h of failures in 3 half-hours, it fires at once (Everything-is-OK#967, below; until the per-video count of stage 2 is live) |
| Video builds failing at Tunelio | 3 or more different videos in 1 h whose Tunelio build failed or timed out after `/create` accepted it (`video_fail` `build`), and no build succeeded in that hour (`build` `ok`), at once (#967) |
| Home relay plays failing | 3 or more different videos failed at home in 1 h (`video_fail` `home`) and no home session got ready, at once (#967) |
| Many Channels plays refused | 10 or more Channels answers `unavailable` in 1 h (slots the list hides), at once (#967, hypercare's limit of #863) |
| Channels status unreadable | 1 or more Channels plays refused in 1 h because the monitor's status can't be read (`channel` `unreadable`), at once: every Quest Channels play is refused meanwhile (#967, hypercare's CHMON of #863) |
| Requests answered 5xx (critical) | any request answered 5xx that the service didn't mean to give, in 15 min (`http_5xx`, by route: a route that threw), at once; one alert per route. The by-design 5xx answers (search and captions 502, a broken home upload, a hidden Channels slot) are not counted (#967) |
| Service crashed and restarted (critical) | `japharsworld-yt.service` (Linode) or `japharsworld-yt-relay.service` (Optiplex) was restarted by systemd in the last 15 min (`node_systemd_service_restart_total` rose), at once; one alert per unit, naming it and the host (#967, #968) |
| (Home worker memory: no rule yet) | the series is collected (`namedprocess_namegroup_memory_bytes`, group `relay`); the rule comes after a day of readings, because the run that crashed on 2026-11-21 peaked at the 1G cap and a threshold set now could fire at once (#967, #968) |
| Metrics poller stale | no pass reached the `tunelio_plan` write for over an hour, 5 min; the timer is 15 min, the widest gap seen 18 min. That write is mid-pass, so a pass failing after it (daily sources, domains, reports) doesn't show |
| Disk almost full | under 10 % free on `/`, 15 min |

**What replaced the hourly hypercare's journal counts** (Everything-is-OK#967; the owner, 2026-11-21: "I say we also
stop the hypercare loop and fold anything useful into grafana"). Hypercare's 20 cards (2026-10-26 to 11-21) were 2
early signs of a real home-cache problem, 1 partly real one whose text named nothing real, 12 false alarms with a
written cause (our own checks and sweeps, provider timeouts on warm-ups, quiet-traffic caption samples, one stuck
video) and 5 never explained; none described an outage visitors felt. On 2026-11-21 one livestream archive YouTube had
not finished processing, in one room, fired both Grafana's "Caption lookups failing" (16:14Z) and hypercare's error
count (#966), while the real fault in the same minutes, the home worker crashing out of memory (#968), had no alarm.
- Grafana sees only exported counters, and no counter carries a video (privacy, and cardinality). So the service
  counts different videos itself: `video_fail` (src/videofail.js) counts a video once per kind and window, keeping the
  IDs in memory only, each dropped by its own timer when its window ends (6 h for captions, 1 h for builds and home),
  as the privacy page promises. The builds and home rules also need the thing to have stopped working in the hour (no
  build ok, no home session ready), so a few failing videos among many that work don't fire them. The accepted gap: a
  partial failure (some videos failing, others working) fires neither. A restart forgets the IDs, so a video can count
  twice across one. Until that counter is live (stage 2, a deploy), captions count half-hours: failures in 3 different
  half-hours of 6 h. A first version (stage 1, not pushed) asked "unless a caption fetch worked in 2 h", which the
  verifier showed would fire on the day's one stuck video from 17:55Z to 22:10Z had nobody else fetched captions.
- Until stage 2's exporter sends `build` `ok`, `home` `ready` and `channel` `unavailable` from 0, a series that has
  never counted on production starts at its first event, and `increase()` sees only the second one on: the builds,
  home and Channels rules start counting from each such series' second event (and a missing `ok`/`ready` series reads
  as "nothing worked", toward firing).
- Builds count a video whose build `/create` accepted and then failed or timed out (`build_failed`: 524, 503, no
  answer; warm-ups included). A provider refusing a video (`tunelio_failed`, e.g. its 409 "not ready") isn't counted:
  the service alerts on its own when Tunelio fails (5xx, 401, 402: src/playback.js). `build` `ok` counts cached links
  too, unlike hypercare's `built`.
- Crashes: systemd restarts the search service in 3 s and the worker in 5 s (`RestartSec`), between two 60 s scrapes,
  so `node_systemd_unit_state`, `eiok_search_up` and `eiok_relay_workers_online` (a worker counts as online for 30 s
  after its last poll, src/relay.js) all miss one; on 2026-11-21 the worker was down about 5 s at 16:12Z. The
  counter is systemd's own `NRestarts`, through Alloy's `enable_restarts`. Whether a deploy's `systemctl restart`
  moves it is checked on the staging VPS before the rule is pushed (systemd's docs don't say); if it does, the rule gets
  a guard on the deploy markers (`eiok_deploy_timestamp_seconds`).
- The worker's memory: its unit caps it at `MemoryMax=1G` and had hit that limit 35k times
  (deploy/japharsworld-yt-relay.service); on 2026-11-21 V8 gave up at about 743 MB of heap, and 28 minutes after the
  restart the unit stood at 1.07 GB (cgroup, page cache included). Alloy collects the worker process's resident and
  swapped bytes; the rule waits for a day of readings (the coordinator tracks it on #968).
- A broken Alloy config would blind a whole host, so `deploy/alloy-setup.sh` installs it through
  `deploy/alloy-config.sh`: `alloy fmt` must read it, the install must work, and if Alloy doesn't stay active on it
  (three looks 8 s apart) the previous config goes back and the setup fails. That failure is one line in update.sh's
  or relay-update.sh's journal ("alloy setup failed") and is not tried again until another `deploy/alloy*` change:
  after fixing the cause, run `bash deploy/alloy-setup.sh <linode|optiplex|staging>` on that host by hand. A config
  that loads but whose component finds nothing (a matcher that matches no process) stays up; only "Alert inputs
  missing" shows that.
- Known limits: a cached Tunelio link counts as a build that worked (`build` `ok`), so one cached replay in the hour
  quiets the builds rule; "Service crashed and restarted" says "stopped on its own" because a deploy's
  `systemctl restart` is expected not to move NRestarts (the worker's counter read 1 after the 2026-11-21 crash, after
  a run that began with the 11-17 deploy), proven on the staging VPS before the rule is pushed.
- What hypercare checked that Grafana already had: the units and `/healthz` (search down, public down, home worker),
  disk, the silent caption failure (`eiok-captions-empty` is the same rule), SSH, YouTube refusals. Dropped: hypercare
  watching itself (ssh, journal), `backoff` (no such event is written any more), home cache evictions and over-cap
  (eviction is the cache working; the home volume rule covers it filling).
- A visitor request answered 5xx because a route threw (500), which only hypercare counted (from the journal, 3 an
  hour), is `eiok-server-errors` at the first one: `http_5xx` by route, with the 5xx answers the service gives on
  purpose left out (src/server.js `BY_DESIGN_5XX`), so one cause raises one alert. Live only with the production deploy
  that carries the counter (a search-service restart) and the rule push after it; until then nothing counts it.

**eiok.cc** (owner, 2026-10-25) is the short domain for the Quest search box (README, "Compact search address"). Caddy
serves it from the same site block as yt.japharsworld.com, with its own Let's Encrypt certificate, renewed by Caddy.
The domain itself is the owner's to renew (auto-renew, several years ahead), because the public world bakes it.
- Alloy probes `https://eiok.cc/healthz`, which also covers its certificate.
- The metrics poller (`metrics/poll.js` `domainPass`) asks RDAP once a day for each domain's registration expiry, and
  retries hourly when RDAP fails. It uses the registries' servers from IANA's bootstrap file:
  `tld-rdap.verisign.com/cc/v1` (`rdap.verisign.com/cc` answers 400) and `rdap.verisign.com/com/v1`.
- On 2026-10-25, eiok.cc expired 2027-10-25 (registered for one year, at Cloudflare) and japharsworld.com 2027-06-14.

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
   DISCORD_CRITICAL_WEBHOOK=https://discord.com/api/webhooks/...  # optional: the critical channel (below)
   ```
   then `node tools/grafana.mjs push`. It creates the folder, the dashboard (`/d/everything-is-ok`), the Discord
   contact point and the alert rules, and is safe to re-run. To send alerts elsewhere, change
   `GRAFANA_DISCORD_WEBHOOK` and push again. (`GRAFANA_TOKEN` in the same file is the write-only token Alloy uses.)

**Critical channel** (world #195, owner 2026-10-26, card #234): a separate Discord channel, with its own sound and the
@mention, for critical alerts only; warnings stay where they are. One env var, `DISCORD_CRITICAL_WEBHOOK`, in each
sender's own env file; unset, that sender posts everything to its usual webhook as before:
- Grafana (the repo's `.env` where `tools/grafana.mjs push` runs): every `severity=critical` rule goes to the contact
  point "Everything is OK Discord critical" (search or public address down, an unknown SSH login, keys/sshd/ufw
  changed, sshd hardening off, the Linode disk at 88 %, a domain within 48 hours). The Channels mass outage and the domain
  within 7 days are plain warnings on the usual channel: no ping, no triage (owner, #246).
- The Channels monitor (`/etc/japharsworld-yt-monitor.env` on the Linode): nothing for now (its mass outage is a plain
  alert on the usual channel, #246); a send marked critical would go there.
- Severe-alert triage (`~/yt-infra-check/.env` on the Optiplex): every SEVERE post.
- Hypercare (the same `.env`): the "Fix:" findings (owner tasks) and their recoveries.
The weekly report and the search service's own alerts (`ALERT_WEBHOOK`) stay on the usual channel.

**Tonight board** (world #248, owner 2026-10-26): `/d/everything-is-ok-tonight`, "Everything is OK · Tonight", pushed with
the ops dashboard (`tonight()` in `tools/grafana.mjs`, `grafana/tonight.json`). "How cozy is it right now": the vibe word
from occupancy (0 quiet, 1–3 cozy, 4+ lively), people and rooms, the range's new visits and favorites, plays by length,
Channels vs searches, captions, languages, Quest vs PC, the night's occupancy curve and "stayed past 03:00". Existing
aggregates only (counts, no IDs); panels from the service's counters say they include the owner's testing. Tokyo Night
accents, no red, refresh 1 min, the last 12 h. The vibe, heat and stayed-past-03:00 tiles are Canvas panels drawing
line icons from the service's Pages (`docs/icons/*.svg`), coloured through their stroke, instead of emoji.

## Changing things

- **Dashboard or alerts:** edit `tools/grafana.mjs`, `node tools/grafana.mjs build` (refreshes the reviewed copies in
  `grafana/`), then `push`. Edits made in the Grafana UI are overwritten by the next push.
- **Alloy config:** edit `deploy/alloy/<host>.alloy`. Once Alloy is installed, the Linode's `update.sh` and the
  Optiplex's `relay-update.sh` re-run `alloy-setup.sh` when `deploy/alloy*` changes. Check a config first with
  `alloy validate deploy/alloy/linode.alloy` (and `alloy fmt`).
- **New exporter metric:** `metrics/exporter.js` and `test/exporter.test.js`; `update.sh` restarts the exporter when
  `metrics/exporter.js` or `src/metrics.js` changes.
- **Graph line colours** (#868, 2026-11-17): every line on "Everything is OK" has a Tokyo Night colour by what it means
  (`lineColours` in `tools/grafana.mjs`: failures red, warnings amber, healthy green, the rest neutrals), so a line's
  name must be known when the dashboard builds. A new key in a `oneOf(...)` list in `src/metrics.js` needs the same key
  in `KEYS` in `tools/grafana.mjs` (`test/grafana.test.js` fails until it is there). For the speed probe the test
  reads `src/probe.js`: it fails when the two formats or the default `pairQualities` differ from `KEYS.probe`, and when
  the code holds any `tunelio:` source literal other than the two templates (`tunelio:${format}`,
  `tunelio:pair${…}`); a source named some other way (built from a variable, set in another file) it cannot see. A
  key added mid-list moves the colours of the lines after it in that panel; a panel passing 18 lines (the palette's
  size) switches to the other assignment, so every line in it can change colour. Limits: a failure, warning or healthy
  line whose colour family has run out wears a neutral colour of its own (unique, but not its meaning colour), and in
  Home relay (29 lines) such lines repeat their own family's colours. A line nobody listed draws in shades of blue
  picked by series order, stable only while the same series come back. The four no-state stats are solid #24283b
  tiles (#866).

## Weekly infra check (Optiplex agent)

A headless Claude Code run on the Optiplex every Thursday at 06:52 Chicago time (`infra-check/`: `run.sh`,
`prompt.md`, the user timer and the sudoers files; installed in `~/yt-infra-check`, see `infra-check/README.md`). It
checks both hosts and Grafana Cloud and reports on GitHub. **These rules are the agent's instructions** (owner,
2026-10-25). It runs on another machine and can't see this PC's memory or sessions, so anything it must follow goes
here, not in a session's memory. The prompt tells it to read this section from the Optiplex's checkout of `main`
(`/opt/japharsworld-yt-relay/claude/monitoring.md`, updated every 5 minutes).

**What it may do.** Read only: status, logs, metrics, `/healthz`, one test search, Grafana's API, and its own past
reports. The only change it may make is the maintenance its sudoers rule allows, on the **Optiplex only** (the
Linode's rule is read only, owner 2026-10-26: a full Linode disk is a finding), and only when `/` is **85 % used or
more**: `journalctl --vacuum-size=500M`, then `logrotate -f /etc/logrotate.conf` if that wasn't
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
5. **Owner task** (owner, 2026-10-26, world #216): when something needs the owner (a restart, a reboot, a config
   edit, a decision, anything it may not do itself), it also files one `owner-task` issue in the private
   `Cheffromspace/Everything-is-OK`, which lands on the owner's "Your tasks" board (user project 4). First search the
   open ones (`gh issue list -R Cheffromspace/Everything-is-OK --label owner-task --state open`) and comment on a
   duplicate instead. Every comment it posts on an `owner-task` issue ends with the line `<!-- coordinator -->`:
   agents and the owner post from the same GitHub account, and the coordinator's board watcher counts an unmarked
   comment as the owner's (coordinator, 2026-10-26). The issue follows that repo's `.github/ISSUE_TEMPLATE/owner-task.md`: one small job per issue,
   a title starting with a verb, **Why / Time / Where / Do first** up front, numbered checkboxes with at most one
   copyable block each, **Done when**, and "close this issue when done". It links the public finding in this repo,
   which stays as it is. Create it with `gh issue create -R Cheffromspace/Everything-is-OK --label owner-task
   --project "Your tasks" --title … --body-file …`; if `--project` fails (the Optiplex's `gh` token has no `project`
   scope as of 2026-10-26), create it without `--project` and say so in the report. A security finding gets at most a
   card titled "Security finding on <host>, see the local report of <date>", with no details. No secrets, tokens or
   webhook URLs there either.
6. **Security updates card** (owner, 2026-11-19, Everything-is-OK#906 and #914: "Can we make sure that future pending
   security updates go on a task card on my board?"; before this the check only reported them, and a card came only
   with a red item such as a reboot pending for a security update): every week a host (Linode or Optiplex) has any
   pending security update, or `/var/run/reboot-required`, it files one `owner-task` card for that host (item 5's
   format and `gh` command), titled "Install security updates on <host> (<date>)". Pending updates alone are yellow in
   the report; the card is filed either way.
   - **One card per host, one per job.** Search the open `owner-task` issues for "Install security updates on <host>"
     first. If one is open, it comments there with this week's count, ending with `<!-- coordinator -->`, and files no
     new card. A pending reboot goes on the same card, never on a second one, and a reboot pending for a security
     update is not also filed as a "Security finding" card. The red "Security finding on <host>" card stays for every
     other red security item.
   - **Count only.** The card says "N security updates pending" (`apt list --upgradable 2>/dev/null | grep -c security`,
     which needs no sudo on either host). No package names, versions or CVEs on GitHub (they stay in the local
     security report), and no IP addresses or account names. When the updates are installed but a reboot is still
     pending, the card says so and keeps only the reboot and check steps.
   - **Say what usually happens** (coordinator, 2026-11-19, from the Linode's config): `unattended-upgrades` runs daily
     on the Linode (`APT::Periodic::Unattended-Upgrade "1"`), so a pending security update is often installed by
     itself within a day, and the owner's real job is usually the reboot. The card says that plainly, near the top.
     If the same update is still pending a week later (last week's local security report lists it, or an open card
     from last week is still there with a count), the card or its comment says `unattended-upgrades` may be failing
     and points at `/var/log/unattended-upgrades/` (no names, just that it is the same update).
   - **Steps on the card: security updates only, never a plain `apt-get upgrade -y`** (the Linode holds 58 other
     upgrades back on purpose, among them nodesource's Node and apt.grafana.com's Alloy). The command is
     `unattended-upgrade -v`, which installs only the origins the host allows (noble, noble-security, ESM apps and
     infra security; `/etc/apt/apt.conf.d/50unattended-upgrades` on the Linode, read 2026-11-19 17:52Z). Why/Time/Where/Do
     first up front, numbered checkboxes with one copyable block each. Linode, as root (`ssh linode`): (1)
     `ssh linode 'unattended-upgrade -v'`; (2) check for a reboot with `ssh linode 'ls /var/run/reboot-required'`
     ("No such file" means none: skip step 3); (3) only if that file exists, `ssh linode reboot`, warned as "search is
     down about 2 minutes, pick a quiet moment"; (4) the check that ends it: `ssh linode 'ls /var/run/reboot-required;
     systemctl is-active japharsworld-yt japharsworld-yt-exporter alloy caddy bgutil-pot fail2ban'`.
   - **The Optiplex** is the same on that machine with `sudo` (`sudo unattended-upgrade -v`, `ls /var/run/reboot-required`,
     `sudo reboot`, check `ls /var/run/reboot-required; systemctl is-active japharsworld-yt-relay bgutil-pot-relay
     alloy`), warned as "the relay worker is down for a minute; searches fall back to the Linode meanwhile" (the wording and the
     minute are not measured, coordinator 2026-11-19). Before it
     names that command the check reads the Optiplex's own `/etc/apt/apt.conf.d/50unattended-upgrades` (allowed
     origins) and `20auto-upgrades`: the Linode's facts are not assumed there. If the security origins are not allowed
     there, the card gives no install command, says that, and tells the owner to ask the coordinator.
   - **Done when:** `apt list --upgradable 2>/dev/null | grep -c security` prints 0 on that host (security updates only:
     other held-back upgrades don't count), there is no `/var/run/reboot-required` and the check's units all say
     `active`. Then "close this issue when done", as item 5 says.
   - **It stays read only.** It never installs, upgrades or reboots anything itself; the card is the whole action.

**Public repo:** reports and issues are public. No secrets, tokens or webhook URLs, no IP addresses or SSH account
names, no visitor data (search text, video IDs from visitors' plays, VRChat user or instance IDs). Counts and
timings are fine. The security checks (`infra-check/prompt.md`, owner 2026-10-26) keep their details (logins, source
IPs, key fingerprints, ports, ufw rules) in the local `reports/<date>.security.md`, compared with the local
`security-baseline.md`; GitHub gets only "Security: green/yellow/red, details in the local report", and a red item
an issue without details. A red item makes the Discord summary start with "SECURITY:".

**Its sudoers rules** (`infra-check/sudoers-*`, copies of what is installed) allow only read-only security commands
(`sshd -T`, `ufw status verbose`; `fail2ban-client status sshd` on the Linode, `ss -tlnp` on the Optiplex), plus the
two maintenance commands on the Optiplex.
The copies installed on 2026-10-24 also allowed service restarts. The
rule above forbids those either way; the owner reinstalls the narrowed files.

## Hourly hypercare (Optiplex timer)

**Retired 2026-11-21 (the timer was disabled at 17:04:04Z, Everything-is-OK#967); kept until the removal commit.** What it
checked moved to the Grafana rules above ("What replaced the hourly hypercare's journal counts"); don't install or
re-enable it.

`infra-check/hypercare.mjs` and the `yt-hypercare` user timer (world #208, owner 2026-10-26; it replaced the
coordinator's 30-minute loop). Every hour at :17, read only and without Claude, it checks the last hour: the search
service and Caddy active on the Linode and the public `/healthz` answering 200; the Linode's `/` use; in the search
service's journal the 5xx answers on request lines (Channels 503s apart, below), Tunelio build timeouts (below), error and `*_failed` events, `youtube_error` and `backoff` events, `captions_via`
(lookups in the hour, and distinct videos with and without tracks over 6 hours), `home_evict` and `home_over_cap`; fail2ban's currently banned sshd count; on the
Optiplex the relay worker, `bgutil-pot-relay` and the flash worker's timer active and its last run successful.
MediaMTX is its own project (media-mtx) and not checked here (owner, 2026-10-28, #38). The journal is counted on the Linode with `awk` over `ssh linode-check`, so no log line,
video ID or address reaches the Optiplex. Limits per hour are in `LIMITS` (from the 48 h before 2026-10-26: no 5xx
or backoff at all), each overridable as `HYPERCARE_<NAME>` in the same `.env`. The disk limit is 88 %, Grafana's
critical level: hypercare reads `df` once an hour, so a passing minute at 80 % (2026-10-27 22:17, before a home cache
eviction) is left to Grafana's 15-minute 80 % warning. Captions fire only at 5 or more distinct videos with no tracks and no
video with tracks over 6 hours (world #401): many videos have no captions, and replays ask again.

Channels (Everything-is-OK#863, folding in #521): since the production deploy of 2026-11-17 a slot the published list
hides answers `503 channel_unavailable` on purpose (#776), so a `route channel` 503 request line is not counted as a
5xx; the deploy's own three hidden-slot checks had filed a false 5xx card (#862). Those 503s are counted apart
(`ch503`, limit `CH503` 10 an hour: production saw at most 5 channel requests and 3 channel 503s in any hour from
2026-11-10 to 11-18, and one visitor on a stale list retries about six loads, so 9 stays quiet) and a burst files
"Many Channels plays were refused". Any other 5xx on that route (a 500 from a throw) still counts as a 5xx. The real
fault behind the same 503, a monitor status the service can't read (every Quest Channels play is refused meanwhile),
is counted from the service's `channel_refused` lines with `why` `status_unreadable` or `status_missing` (`chmon`,
limit `CHMON` 1: those lines are written once a minute at most, so one visitor's retries are one line), and files
"The search service can't read the Channels monitor's status". A hide (`hidden_by_monitor`, `hidden_by_owner`) is not
counted. Both run where hypercare reads, production's journal only; Grafana has no rule on channel answers.

Build timeouts (Everything-is-OK#904; the coordinator's call, 2026-11-20). The 5xx count used to take every journal
line with `"status":5xx`, event lines too. A `build_failed` with status 524 (Tunelio's answer when a build runs past
about 125 s; the service's own probe waits 150 s) was therefore filed as "The search service answered 5xx" (#903,
2026-11-19: 3 in an hour) and counted again as an error event: #931 and #932 (2026-11-20) were the same six lines.
Both bursts were tablet warm-ups of long videos at 720p HLS, and both hours also had builds that worked. Since then:
- `s5` counts request lines only: the server's `{"at","route","status","ms"}` line, which has a `route` and no `event`.
  Event lines can carry a `route` (`youtube_error`, `forced_limit`, `error`), and several carry an upstream status.
- A `build_failed` with status 524 is counted only as `timeouts`, not as an error event, so one burst files one card
  at most. "Video builds are timing out at Tunelio" fires at `BUILD524` (3) timeouts in the hour **when no new Tunelio
  build succeeded in that hour**: no `tunelio_link` line without `cached` (Tunelio building nothing). Home builds
  (`home_ready`) and the speed probe's own builds are not counted as built. A cached link (the
  service's guess from the speed, `cachedBuild` in src/playback.js: under 3 s or over 120 MB/s) only shows Tunelio
  serving a file it already had, so it does not count. 7 event lines with status 524 were seen in the 7 days before
  2026-11-17, and 3 and 6 timeouts in one hour in the two bursts. Replayed over the hours behind #903 and #931/#932, the new count files nothing:
  each hour had a fresh link.
- **Accepted gap:** builds partly timing out while others still succeed raise no hypercare card. The dashboard's
  "failed builds" series (`eiok_events_total{metric="build",key="failed"}`) still shows them; Grafana has no rule on it.
  `built` ignores the format too: one mp4 (progressive) link that built quiets an hour in which every HLS build
  timed out, and a Quest tablet's warm-up of a .m3u8 ticket builds HLS unless the video is long or its HLS build
  failed (with `QUEST_MP4` on, the Quest's Unity player itself always gets the mp4, src/server.js, #584).
  So Tunelio's HLS builds failing for a whole hour while its mp4 builds work raise no card either. The 11-20 hour was
  quieted by just such a link (a 720p mp4), so this gap covers "every Quest HLS warm-up failing", not only "a few".
  A `build_failed` with any other status (503, or 0 for no answer) is still an error event, as before (pinned by a test).
- Event lines that left every hypercare count with this change (they had counted only through the old 5xx match, and
  only when their status was 5xx):
  - `build_retry` (a progressive build asked again after a 503): the build still ends in a `build_failed` or
    `tunelio_link` line, which is counted (observed in code, src/playback.js `#build`).
  - `channel_upstream` (the answer from the Channels upstream): written only where `CHANNELS_UPSTREAM` is set (it
    defaults to off, src/config.js), and a 503 there is a hidden slot by design (observed in code). Whether production
    sets it was not read on the host (inferred off: Everything-is-OK#519's comment of 2026-11-05 says it "is set only
    on staging", and production's monitor database wins even if it were set). Re-check:
    `ssh linode 'grep -c CHANNELS_UPSTREAM= /etc/japharsworld-yt.env'`.
  - `tunelio_probe` with `ok: false` (the speed probe's own `/create` or its own build failed, src/probe.js): a
    dashboard panel only, no alert
    (observed in code: tools/grafana.mjs has no rule on it). A visitor's failed `/create` is a `tunelio_error`, still
    an error event, and raises the service's own "Tunelio is failing" Discord alert at 5xx (src/playback.js).
  - `tunelio_drop_open` / `tunelio_drop_reopen`: Grafana's `eiok-tunelio-reopen-fail` rule watches the same failures
    through `eiok_tunelio_probe_open_fail_total` and `eiok_tunelio_probe_reopen_fail_total` (observed in code).
  Re-check which log lines carry a status (the line after each call too, since `build_failed`'s status is on the next
  line): `grep -nE "this\.log\(|logJson\(|log\(JSON" -A1 src/*.js | grep status`.

Grafana's `eiok-captions-empty` (world #428) has the same rule, so a silent failure, where every lookup answers
`no_captions` with no error, stays watched after hypercare ends, and `eiok-captions-failing` covers every source throwing. It is a slow one: replayed over 121 runs of real
traffic (2026-10-26 to 10-31) such a failure takes a median of 6 h and at most 20 h to fire, and a run of quiet hours
longer. A partial failure, with some tracks still coming through, never fires. `captions_source_failed` is seen only
through hypercare's errors check, among all error events at 5 an hour; the exporter doesn't count it. If the worker
fails and Tunelio answers instead, Grafana's `eiok-captions-paid` can fire. Hypercare ends itself after 7 clean days
(below), and the rest of its detection ends with it.

All normal: one JSON log line (`"event":"hypercare"`, counts only) in its user journal, nothing else. Something new:
one Discord post to the weekly check's webhook, pinging `DISCORD_MENTION_ID`, and one issue per finding in the private
`Cheffromspace/Everything-is-OK` (an open issue with the same title gets a comment instead). Findings the owner has
to act on (a unit down, `/healthz` failing, the disk at 80 %) are `owner-task` cards in that
repo's template, titled "Fix: …" with the copyable commands; the rest are "Hypercare: …" issues for an agent. Still
abnormal 6 hours later: Discord again and a comment. Gone: a quiet Discord line and a "recovered" comment; it never
closes an issue. Every comment ends with `<!-- coordinator -->`. Its state is `~/yt-infra-check/hypercare-state.json`.
`node /opt/japharsworld-yt-relay/infra-check/hypercare.mjs --dry-run` runs the real checks and prints what it would
post and file.

It ends itself (world #236, owner 2026-10-26): it counts consecutive clean runs in the state file (`clean`,
`cleanSince`), and any finding starts the count again. After 168 clean runs that also span 7 days by the clock (167 h from the first to the last), it posts one
Discord line and a comment on world #208, then runs `systemctl --user disable --now yt-hypercare.timer`. To turn it
back on: `systemctl --user enable --now yt-hypercare.timer` (the saved count was reset when it ended, so another 7 days).

## Severe alert triage (Optiplex agent)

The same headless Claude Code on the Optiplex, woken by a critical Grafana alert (owner, 2026-10-26;
`infra-check/triage.mjs`, `triage-prompt.md` and the `yt-infra-triage` user timer). The home network stays
outbound-only, so nothing calls in: every 2 minutes the timer asks Grafana Cloud's alertmanager (the weekly check's
read-only `GRAFANA_TOKEN`) for firing, unsilenced alerts labelled `severity=critical` and `project=everything-is-ok`.
A new one gets one triage run (all new alerts of a poll share it), each alert at most once per 6 hours, at most 6 runs
a day. Past the cap, or when Claude can't run (an expired login, a timeout), the alert still goes to Discord with
"Triage couldn't run: …", so it is never swallowed. It holds the weekly check's lock: while that runs, the triage waits
for the first poll after it. A planned change gets a Grafana silence first, which keeps it out of triage too.

**The rules are the weekly check's,** read only and stricter: no maintenance either, only evidence (`ssh linode-check`
with its read-only sudo, local checks, Grafana's API), a diagnosis and a suggested next step for the owner or the
coordinator. It writes `~/yt-infra-check/reports/<date>-<hhmm>-triage-<rule>.md` (local) and a short note that
`triage.mjs` posts to Discord as "SEVERE: <alert>, firing since …" with the report attached. A non-security alert
also gets a GitHub issue under the weekly "New finding" rule (or a comment on the open one); **a security alert goes
nowhere in the public repo,** and its note carries no addresses, keys, ports or account names (those stay in the
attachment). A next step that needs the owner also gets the weekly "Owner task" card; for a security alert that card
is only "Security finding on <host>, see the local report of <date>".

The critical rules (`tools/grafana.mjs`, 2026-10-26): `eiok-search-down`, `eiok-public-down`, `eiok-short-down`
(owner: "search service much more critical"), `eiok-ssh-unknown-login`, `eiok-security-change`,
`eiok-sshd-not-hardened`, `eiok-linode-disk-88` (80 % is a warning; 70 %/80 % until 2026-10-27, when a full home
cache at `HOME_MAX_GB=12` put `/` at ~76 %), `eiok-domain-expiry-critical` (48 hours; the 7-day one is a warning
since #246); the mass Channels outage warning is the monitor's own since 2026-10-29 (`eiok-channels-mass-down` retired). With `GRAFANA_DISCORD_MENTION` in
the repo's local `.env` the contact point pings the owner on these (firing only), and `DISCORD_MENTION_ID` in
`~/yt-infra-check/.env` makes every "SEVERE:" triage post ping them; both IDs stay out of the repo. A rule raised to critical is triaged
from its next firing. Test the path with `node /opt/japharsworld-yt-relay/infra-check/triage.mjs --synthetic
security|down --dry-run` on the Optiplex: a made-up alert through the same run, nothing recorded, no GitHub writes,
and the Discord text printed instead of posted.
