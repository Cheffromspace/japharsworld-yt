# japharsworld-yt

YouTube search and captions for the VRChat world **Everything is OK**, served from `https://yt.japharsworld.com`.

VRChat worlds can't build URLs at runtime: Udon can only load URLs baked into the world or typed into a URL field.
This service works within that rule:

- **The search box is the URL.** The world pre-fills `https://yt.japharsworld.com/v1/<shard>/s?l=<lang>&q=<prompt> →`
  and the visitor types after the arrow. Everything up to the last arrow is ignored.
- **Tickets.** The world bakes `https://yt.japharsworld.com/v1/<shard>/<n>` for every shard and `n < POOL`.
  A search binds the next free tickets to its videos, its thumbnail sheet and its next page, and answers with
  ticket numbers. Loading a video ticket is a 302 to the video; no video passes through this server.
- **HD playback (Tunelio).** With `TUNELIO_API_KEY` set, an ordinary video's ticket redirects to a
  [Tunelio](https://tunelio.dev) tunnel link (720p/1080p): a progressive mp4 (full seeking) up to
  `TUNELIO_PROGRESSIVE_MAX_MINUTES` and `TUNELIO_PROGRESSIVE_MAX_MB`, Tunelio's HLS playlist for longer or larger
  videos (and when the mp4 build is refused). Tunelio builds a file on its first request at about 60 MB/s, so a
  1080p file above `TUNELIO_MAX_MB` is made again at `TUNELIO_LOWER_QUALITY` (10 more credits, half the wait).
  One link per video is cached until 20 minutes before it expires (about 6 h), so a room, its late joiners and
  replays share one paid call (10 credits).
- **Start-up latency** (`claude/play-latency.md`). VRChat resolves every URL with its own yt-dlp (20 s socket
  timeout) before AVPro opens it, so a video ticket answers each client differently, by `User-Agent`: the world's
  string downloader (`UnityPlayer/…`) gets JSON build status and starts the build (the tablet *warms* a video a
  second after it is selected); VRChat's resolver (a Chrome-like UA) is held at most `TICKET_RESOLVER_HOLD_SECONDS`
  and then, if the build is still running, answered with a plain page so VRChat hands the URL to AVPro at once;
  the player (anything else) is held until the link is ready, up to `TICKET_PLAYER_HOLD_SECONDS`, then sent to
  youtube.com. `tools/bench-play.mjs` measures all of it. Live streams always go to `youtube.com` (VRChat gets 1080p for live
  itself), and so does everything when Tunelio fails, is out of credits (paused for 10 minutes) or has no key:
  360p, but it plays. Alerts (out of credits, failing, running low) go to `ALERT_WEBHOOK`.
- **Shards.** Each instance picks a shard at random (synced), so instances rarely share tickets.
- **Pinning.** A video ticket that has been played is pinned for `PIN_HOURS` and skipped when tickets are
  handed out, so late joiners loading the synced ticket get the same video.
- **Captions.** `GET /v1/<shard>/cc/<lang>` returns captions for the video last played in that shard, in the
  visitor's language, plus `tracks`: every caption track the video has (uploader tracks first, then auto
  captions), named in `<lang>`. `GET /v1/<shard>/cc/<i>` returns track *i* of that list (the tablet's picker).
  `lang` is a VRChat client language or `native`. The response carries the ticket `t` so the world can check
  it matches what's on the screen. With Tunelio, captions come from its `/transcript` (6 credits per track,
  cached 7 days, fetched only when someone asks): YouTube's machine translations are not offered, tracks in
  scripts the world cannot draw (`CAPTION_SCRIPTS`) are left out, and Tunelio's silent English substitute for a
  missing language is detected and answered as unavailable. Without a key, yt-dlp is used as before.

## API

| Path | Returns |
|---|---|
| `GET /v1/<shard>/s?l=<lang>&q=<…> → <query>` | JSON: `results[]` (`t`, `id`, `title`, `channel`, `length`, `seconds`, `views`, `age`, `live`, `cc`, `desc` = up to 240 characters of the description), `sheet`, `sheetCols`, `sheetRows`, `cellW`, `cellH`, `next` (`-1` = none) |
| `GET /v1/<shard>/<n>` | video: 302 to a Tunelio link or YouTube (from a `UnityPlayer` UA: JSON `state` = `building`/`ready`/`failed`/`live`/`youtube`, `format`, `quality`, `mb`, `elapsed`, `eta`, `progress`) · sheet: JPEG, cell *i* = result *i*, row-major · page: JSON like a search |
| `GET /v1/<shard>/cc/<lang>` | JSON: `t`, `id`, `available`, `source` (`manual`/`auto`/`translated`), `lines` = `[[start, dur, text], …]`, `tracks` = `[{i, code, name, auto}]`, `track` (index shown, `-1` = none), `reason` when unavailable |
| `GET /v1/<shard>/cc/<i>?l=<lang>` | the same for track *i* (Tunelio captions only) |
| `GET /healthz` | `{"ok": true, "tunelio": bool, "credits": n, "workers": n, "lastSearchVia": "worker"/"local"/"api", "apiUnitsToday": n}` (credits as last reported by Tunelio) |

Errors are JSON `{ "error": code, "message": … }` with codes `empty_query`, `rate_limited`, `youtube_failed`,
`unknown_ticket`, `expired`, `bad_shard`, `nothing_playing`, `captions_failed`; the world shows its own
localized text per code.

Changing `SHARDS` or `POOL` changes the baked URLs: the world must be re-uploaded with regenerated URLs.

## Status / kill switch

`docs/status.json` is published on GitHub Pages
(`https://cheffromspace.github.io/japharsworld-yt/status.json`), a trusted domain every visitor can read
even without "Allow Untrusted URLs". Set `"search": false` and a `message` to hide search in the world
during an outage.

## Search relay

YouTube answers many InnerTube searches from the Linode (a datacenter IP) with `403`. Each search therefore tries, in order:

1. **A relay worker at home** (the owner's Optiplex, residential IP): `relay/worker.js`, waited for up to `RELAY_WAIT_MS` (8 s).
2. **The Linode itself**, as before, retrying once with a fresh InnerTube session after a 403.
3. **The YouTube Data API**, only when `YOUTUBE_API_KEY` is set: `search.list` + one `videos.list`, 101 of 10,000 quota
   units a day (resets at midnight Pacific), mapped to the same result fields.
4. Otherwise `502 youtube_failed`, as before.

**Nothing at home accepts connections.** The worker only makes outbound HTTPS requests to this server. It holds 3 long
polls open on `GET /relay/next?worker=<name>&version=<sha>` (answered `204` after 25 s, or `200 {"job": …}`), runs the
job and posts `{id, ok, page: {videos, cont}, error}` to `POST /relay/done`. Both routes need
`Authorization: Bearer $RELAY_TOKEN` (`401` otherwise); without `RELAY_TOKEN` the relay is off. Jobs are
`{id, kind: "search", query, limit}` and `{id, kind: "more", cont}`. A worker counts as online when it polled in the
last 30 s. "More results" for a worker's page goes to the same worker, which keeps continuations for 30 minutes
(at most 2000); if that worker is gone, the ticket answers `410 expired`.

Every search logs `{"event": "search", "via": "worker"|"local"|"api", "ms": …}`; each failed step logs `youtube_error`
with its `via`. Alerts (`ALERT_WEBHOOK`): no search worker for 10 minutes and search fell back to the Data API (each at
most hourly), Data API quota above 80 % (daily).

Worker setup on the Optiplex (Debian/Ubuntu, as root; safe to re-run; the token is the one in `/etc/japharsworld-yt.env`):

```sh
curl -fsSL https://raw.githubusercontent.com/Cheffromspace/japharsworld-yt/main/deploy/relay-setup.sh | sudo RELAY_TOKEN=... bash
```

It runs `japharsworld-yt-relay.service` as user `jytrelay` from `/opt/japharsworld-yt-relay` (settings in
`/etc/japharsworld-yt-relay.env`: `RELAY_URL`, `RELAY_TOKEN`, `WORKER_NAME`), and `japharsworld-yt-relay-update.timer`
pulls `main` every 5 minutes and restarts the worker when `relay/`, `src/` or the packages changed. Logs:
`journalctl -u japharsworld-yt-relay -f`. Commits that only touch `relay/` don't restart the Linode service.

## Channels link monitor

`monitor/` is a separate small Python service (systemd timer every 15 minutes) that keeps the world's Channels tab
working: it checks every slot's 24/7 stream, swaps restarted streams into the slot playlists, runs the flash check
(through a worker on the owner's Optiplex), and publishes `docs/sleep-list.json` and `docs/sleep-thumbs.jpg`.
See [monitor/README.md](monitor/README.md).

## Metrics

Usage counts for the owner: per day (per hour at most), never per person. No IPs, search text, video IDs, ticket numbers or
VRChat user/instance IDs are stored. Details, what is deliberately not collected, and how to turn it off:
[claude/metrics.md](claude/metrics.md).

- **The search service** (`src/metrics.js`) counts searches (by language, source, failures, latency), "more results",
  plays (by route and length), captions, Tunelio credits spent, join pings (the bare search URL the world loads after join)
  and active shards per hour. Counts are written to `/var/lib/japharsworld-yt/metrics.db` every minute and at shutdown.
- **The poller** (`metrics/poll.js`, `japharsworld-yt-metrics.timer`, about every 15 minutes) records the VRChat world
  (production and TEST) and group numbers, and once a day Tunelio's balance and GitHub stars, downloads and traffic. Its
  secrets are in `/etc/japharsworld-yt-metrics.env` (root only).
- **Reports**: a daily Discord summary just after midnight America/Chicago (the day just ended) and a weekly one on Mondays (`ALERT_WEBHOOK`).
- **`GET /stats`** (HTML with inline SVG charts), `/stats.json` and `/stats/export.csv`, behind `STATS_TOKEN`
  (`?token=` or `Authorization: Bearer`).

Setup is automatic on deploy (`deploy/metrics-setup.sh`). Tests: `npm test` (`test/metrics.test.js`,
`test/vrchat.test.js`, `test/report.test.js`).

## Server

One-time setup on a Debian/Ubuntu box, as root (safe to re-run; leaves MediaMTX and other services alone):

```sh
curl -fsSL https://raw.githubusercontent.com/Cheffromspace/japharsworld-yt/main/deploy/bootstrap.sh | bash
```

After that, `japharsworld-yt-update.timer` deploys `main` every 5 minutes, rolls back if the new version
fails its health check, and updates yt-dlp daily.

Settings live in `/etc/japharsworld-yt.env`. Logs: `journalctl -u japharsworld-yt -f`.

## Development

```sh
npm install
npm test
node src/server.js   # http://127.0.0.1:8790
```
