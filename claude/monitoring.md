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
credits, YouTube refusing the home relay (`yt_refused`: 3 or more bot/rate/PO-token refusals within 15 min, all-clear
after an hour without one, src/refusal.js; since 2026-10-25) (`alert.resolve`, src/alert.js), and the monitor's quota and API warnings (`discord.resolve`). Notices with no
failed state (credits low, Data API quota, plan renewals, reports) have none.

| Alert | Fires when |
|---|---|
| Home relay near its daily cap | today's home relay MB ≥ 90 % of `HOME_DAILY_MB`, 5 min |
| Home relay has no worker | no media worker connected for 15 min (only while `HOME_RELAY=on`; the gauge isn't set otherwise) |
| Home sent over 100 GB today / 2,000 GB this month (no ISP cap, owner 2026-10-27: unusual volume, not a limit) | `eiok_transfer_bytes{host="home"}`: the Optiplex's bytes sent (every interface but `lo`), reported on each relay poll and counted in metrics.db (`transfer`), Chicago days and months, 5 min |
| Linode sent over 700 GB this month | `eiok_transfer_bytes{host="linode",period="month"}`: the Linode's bytes sent, of its 1 TB monthly transfer, 5 min |
| Credits run out before renewal | the last 3 days' credit spend per day × days to the 1st > credits left, for 1 h |
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
| Disk almost full | under 10 % free on `/`, 15 min |

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

`infra-check/hypercare.mjs` and the `yt-hypercare` user timer (world #208, owner 2026-10-26; it replaced the
coordinator's 30-minute loop). Every hour at :17, read only and without Claude, it checks the last hour: the search
service and Caddy active on the Linode and the public `/healthz` answering 200; the Linode's `/` use; in the search
service's journal the 5xx answers, error and `*_failed` events, `youtube_error` and `backoff` events, `captions_via`
with zero tracks against with tracks, `home_evict` and `home_over_cap`; fail2ban's currently banned sshd count; on the
Optiplex the relay worker, `bgutil-pot-relay` and the flash worker's timer active and its last run successful.
MediaMTX is its own project (media-mtx) and not checked here (owner, 2026-10-28, #38). The journal is counted on the Linode with `awk` over `ssh linode-check`, so no log line,
video ID or address reaches the Optiplex. Limits per hour are in `LIMITS` (from the 48 h before 2026-10-26: no 5xx
or backoff at all), each overridable as `HYPERCARE_<NAME>` in the same `.env`. The disk limit is 88 %, Grafana's
critical level: hypercare reads `df` once an hour, so a passing minute at 80 % (2026-10-27 22:17, before a home cache
eviction) is left to Grafana's 15-minute 80 % warning.

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
