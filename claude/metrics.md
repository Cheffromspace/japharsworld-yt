# Metrics

Usage numbers for the VRChat world **Everything is OK**, reported to the owner. Privacy is a hard rule: **only counts per day
(per hour at most) are stored, never per-person events.**

## What is collected

### From the search service (`src/metrics.js`, inside `japharsworld-yt`)

Counted in memory and written to SQLite every minute and at shutdown (SIGTERM). One row per day, metric and key
(`daily` table); days are calendar days in `METRICS_TZ` (default `America/Chicago`).

| Metric | Key | What |
|---|---|---|
| `search` / `search_lang` | – / VRChat language (16 codes) | searches with a query |
| `search_source` | `worker` `local` `api` | where the search ran (relay worker, the Linode, Data API) |
| `search_fail` | HTTP status (`429`, `502`) | failed searches |
| `search_ms` | latency bucket (ms upper bound) | for p50/p95; buckets merge across restarts |
| `more` / `more_fail` | – / status | "More results" loads |
| `play` | – | videos played, **once per room**: the first load of a video in a shard counts; the other players in the instance, late joiners and replays don't, until 3 hours after it was counted (held in memory only) |
| `play_route` | `tunelio-progressive` `tunelio-hls` `youtube-live` `youtube-fallback` | |
| `play_fallback` | `disabled` `paused` `tunelio_failed` | why a video went to YouTube at 360p |
| `play_length` | `lt10m` `lt1h` `lt3h` `longer` `live` `unknown` | length bucket of the played video |
| `tunelio_create_ms` | latency bucket | Tunelio `/create` |
| `cc_list` / `cc_list_lang` | – / VRChat language or `native` | "Show captions" (list loads) |
| `cc_track` / `cc_track_lang` | – / track language (`en`, `pt-BR`, `zh-Hans`) | tracks picked on the tablet |
| `cc_unavailable` | reason (`no_captions`, `no_track_in_language`, `temporarily_unavailable`, `nothing_playing`, `failed`, …) | "not available" answers |
| `credits` | `playback` (10 per successful `/create`), `captions` (6 per `/transcript`) | Tunelio credits spent |
| `join` / `join_lang` | – / VRChat language | the bare search address the world loads once after join (answered `400 empty_query`). Only visitors who **allow untrusted URLs** send it: the closest thing to a per-language join count |

`gauges`: `credits_remaining` (the last `X-Credits-Remaining` seen each day).
`hourly`: `shard`, one row per hour and shard (0–7) that saw any request. Instances pick a shard at random, so the
number of rows in an hour roughly counts busy instances; two instances on one shard count once (a lower bound).

### From the poller (`metrics/poll.js`, `japharsworld-yt-metrics.timer`)

About every 15 minutes (`OnUnitActiveSec`, randomized: VRChat asks not to poll on the clock):

- **VRChat** `GET /api/1/worlds/{id}` for production (`wrld_63bed747…`, `EverythingIsOKPublish.WorldId`) and TEST
  (`wrld_471c100d…`): `visits`, `favorites`, `occupants`, `publicOccupants`, `privateOccupants`, `popularity`, `heat`,
  `capacity`, `version`, `updated_at`; and from the world's public instance list, occupants summed per access type
  (`occupants_public` / `_friends` / `_invite` / `_group`) plus the number of instances. Instance IDs are read in memory
  and dropped.
- **VRChat group** `GET /api/1/groups/{id}`: `memberCount`, `onlineMemberCount`, when `VRCHAT_GROUP_ID` is set.

About every minute (`japharsworld-yt-occupants.timer`, `poll.js occupants`; owner, 2026-10-21): one request, the
production world only, keeping `occupants`, `publicOccupants`, `privateOccupants` and `visits` (and a new `version` as a
release). About 5,800 poll rows a day, kept 90 days like the rest.

- **Tunelio** `GET /credits` (free): balance and plan, every pass. Tunelio has no API for the wallet funds that
  auto-renew pays from, so the poller watches what it can (see Reports).
- **Releases** (`releases` table): each world's `version` the first time it is seen, at VRChat's `updated_at` (the
  upload time), and once a day the world repo's GitHub release tags (`vYYYY.MM.DD[.N]`) at their publish time.

Once a day:

- **GitHub** for `GITHUB_REPOS` (default `Cheffromspace/japharsworld-yt,Cheffromspace/Everything-is-OK`): stars, forks,
  watchers, release download totals; with `GITHUB_TOKEN` also traffic (views, unique visitors, clones, unique cloners)
  per day, since GitHub keeps only 14 days. Without a token the private world repo is skipped.

Poll rows: `polls` (one row per poll, source and metric) for 90 days; `poll_daily` (min / max / last per day) forever.

### Read, not copied

- **Channels monitor**: per-slot uptime, restarts and flash-check results, and which slots are down now, are read from
  its own database (`/var/lib/japharsworld-yt-monitor/monitor.db`, read only) when a report or `/stats` is built.

## What is deliberately not collected

- No visitor names, VRChat user IDs, instance IDs or member lists.
- No IP addresses (they stay in memory for the one-minute rate limit, as before).
- No search text, video IDs, ticket numbers, per-video viewing history or caption text.
- No per-person events: nothing records that *someone* did *something* at a time, only how many times per day.

This is enforced in code, not just by habit: every metric has a fixed key check (`METRICS` in `src/metrics.js`: a VRChat
language code, a status number, a bucket, a fixed reason list, a track-language pattern). Anything else is counted as
`other`. `test/metrics.test.js` ("privacy") sends a query, a pasted link, an IP in `X-Forwarded-For` and a deliberately
misbehaving caption backend through the real server, then scans every cell of every table for them.

The service's journal logs (`journalctl -u japharsworld-yt`) are separate and unchanged; this database adds nothing to them.

## Where it is stored

- `/var/lib/japharsworld-yt/metrics.db` (SQLite, WAL), owned by `jyt`. Written by the search service and the poller.
- `/etc/japharsworld-yt-metrics.env` (root, 0600): VRChat username, password, TOTP secret and the two session cookies
  (`VRCHAT_AUTH_COOKIE`, `VRCHAT_2FA_COOKIE`, kept current by the poller), `VRCHAT_GROUP_ID`, `METRICS_CONTACT`, `GITHUB_TOKEN`.
- `/var/lib/japharsworld-yt-metrics/state.json` (root, 0700 dir): VRChat back-off and login-failure times.
- `/etc/japharsworld-yt.env`: `METRICS_DB`, `STATS_TOKEN` (added by `deploy/metrics-setup.sh`).

The poller starts as root only to read and refresh the VRChat session in the root-only file, then drops to `jyt` before
it opens any database (`CapabilityBoundingSet=CAP_SETUID CAP_SETGID`, `ProtectSystem=strict`).

## VRChat rules followed

From VRChat's Creator Guidelines ("API usage") and the community docs (vrchat.community):
`User-Agent: EverythingIsOK-metrics/1.0 <METRICS_CONTACT>`; 3 requests per poll, 2 s apart, about every 15 minutes, plus
1 request about every minute for the production world's counts, neither on the clock (randomized); on `429` it stops and waits at least `Retry-After` (30 min, doubling to 6 h); the session cookie is reused,
and a login happens only when it stops working. A failed login alerts Discord (at most every 6 h) and is not retried for
6 h. It only reads public world and group data for the owner's own world and group; it never acts for another user.

## Reports

- **Daily**, the first poll after midnight America/Chicago (`METRICS_REPORT_HOUR`, 0; the poller runs every ~15 min), to `ALERT_WEBHOOK` via `makeAlert`:
  yesterday's VRChat visits/favorites Δ and peak occupants, searches, plays, joins, source mix and failure rate,
  latency, play routes, captions, credits spent with the run-out forecast (at the plan period's average daily spend;
  the period starts on `TUNELIO_RENEWS_DAY`, 17 here), languages seen, releases that day, Channels slots down.
- **Tunelio plan** (as it happens): a plan that changes to `trial` (lapsed: auto-renew found too little in the wallet),
  a credit refresh (renewal went through). Around the renewal day: reminders 3 days and 1 day before to check the
  wallet, and a warning the day after when no refresh was seen.
- **Weekly**, Mondays: the week to Sunday against the week before.
- **TEST world** (stats and TEST uploads) stays out of Discord. It is still polled and stored (and on `/stats`); each
  daily report also writes a `test_world_daily` line to the poller's journal (`journalctl -u japharsworld-yt-metrics`).
- **Grafana Cloud** dashboard and alerts: claude/monitoring.md.
- By hand: `sudo node /opt/japharsworld-yt/metrics/poll.js report [--day 2026-10-18] [--weekly] [--send]`.

## Stats page

`https://yt.japharsworld.com/stats?token=$STATS_TOKEN` (or `Authorization: Bearer`): tiles, inline SVG charts (30 days;
`?days=` up to 365), the last week's breakdown, the releases (with visits/day and peak occupants for the 7 days before
and after each production upload) and the Channels table. No scripts, trackers or CDNs.
`/stats.json` is the same data; `/stats/export.csv` exports every daily table (`daily`, `gauges`, `poll_daily`, and
active instances per hour). Without `STATS_TOKEN` the routes answer 404.

## Turning it off

- Everything: `systemctl disable --now japharsworld-yt-metrics.timer`, set `METRICS_DB=` (empty) in
  `/etc/japharsworld-yt.env` and `systemctl restart japharsworld-yt`. The search service then counts nothing.
- Only VRChat: empty the `VRCHAT_*` lines in `/etc/japharsworld-yt-metrics.env` (no requests are made without them).
- Only the stats page: remove `STATS_TOKEN` and restart the service.
- Delete the data: `rm /var/lib/japharsworld-yt/metrics.db*`.
