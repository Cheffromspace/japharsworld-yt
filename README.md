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
  it matches what's on the screen. Captions come from the first source in a chain that answers
  (`src/captionchain.js`): a relay worker's yt-dlp on a residential connection (free, and YouTube's json3 carries
  the start of every word in auto-generated tracks), yt-dlp on this server when `CAPTION_LOCAL_YTDLP=on` (or
  without a Tunelio key), then Tunelio's `/transcript` (6 credits per track, segment timing only). Every answer
  has the same shape: `lines` (cue timing, as before) and `chunks` (readable lines of about 42 characters, broken
  at sentences, clauses and pauses, each with the time and position of every word; `src/blocks.js`), plus
  `words: "real" | "estimated"` and `via`. Results are cached 7 days per video and track; the picker's track
  numbers mean the same thing whichever source learned the list. YouTube's machine translations are not offered,
  tracks in scripts the world cannot draw (`CAPTION_SCRIPTS`) are left out, and Tunelio's silent English
  substitute for a missing language is detected and answered as unavailable. The free sources are warmed when a
  video is played; Tunelio is asked only when someone turns captions on.

## API

| Path | Returns |
|---|---|
| `GET /v1/<shard>/s?l=<lang>&q=<…> → <query>` | JSON: `results[]` (`t`, `id`, `title`, `channel`, `length`, `seconds`, `views`, `age`, `live`, `cc`, `desc` = up to 240 characters of the description), `sheet`, `sheetCols`, `sheetRows`, `cellW`, `cellH`, `next` (`-1` = none) |
| `GET /v1/<shard>/<n>` | video: 302 to a Tunelio link or YouTube (from a `UnityPlayer` UA: JSON `t`, `state` = `building`/`ready`/`failed`/`live`/`youtube`, `format`, `quality`, `mb`, `elapsed`, `eta`, `progress`, and the video's `title`, `channel`, `desc` as stored when the results were published, `""` for older tickets; Everything-is-OK#114) · sheet: JPEG, cell *i* = result *i*, row-major · page: JSON like a search |
| `GET /v1/<shard>/q` · `/v1/<shard>/q/<720|1080|auto>` | JSON `quality` (the room's playback quality for search videos), `pick` (`720p`/`1080p`/`auto`), `default`, `options`; the second form picks it (kept `QUALITY_HOURS`, 12; `auto` clears it: with playback plans on, 1080p when Tunelio is fast, else 720p). The tablet's ticket status carries it as `room` |
| `GET /hls/<token>.m3u8` · `/hls/<token>/<360p|720p|1080p>.m3u8` | adaptive playlists a played ticket redirects to when its plan is adaptive (`ADAPTIVE_HLS`, src/adaptive.js); the tablet's ticket status then carries `plan` (`lower`/`direct`/`adaptive`/`start`: adaptive from a 360p first rung, `ADAPTIVE_START`), and for `adaptive`/`start` also `rung` (the highest build the session's players were actually given: `360p`/`720p`/`1080p`, `null` before any; a fallback counts as what it is) and `top` (`pending`/`served`/`failed`), because AVPro reports the top variant's size from the start. A rung still building is held up to `ADAPTIVE_HOLD_SECONDS` (1; 8 stalled AVPro's picture every 8 s, 2026-10-23), then 404 |
| `GET /v1/<shard>/cc/<lang>` | JSON: `t`, `id`, `available`, `source` (`manual`/`auto`/`translated`), `lines` = `[[start, dur, text], …]`, `tracks` = `[{i, code, name, auto}]`, `track` (index shown, `-1` = none), `reason` when unavailable |
| `GET /v1/<shard>/cc/<i>?l=<lang>` | the same for track *i* |
| `GET /v1/<shard>/cc?l=<lang>` | the track list alone (`t`, `id`, `available`, `tracks`, `track: -1`), named in `<lang>`, from the free sources only: it never spends Tunelio credits. The tablet's caption popover opens onto it. `reason: list_unavailable` when no free source is up |
| `GET /healthz` | `{"ok": true, "tunelio": bool, "credits": n, "workers": n, "lastSearchVia": "worker"/"local"/"api", "apiUnitsToday": n}` (credits as last reported by Tunelio) |

Errors are JSON `{ "error": code, "message": … }` with codes `empty_query`, `rate_limited`, `youtube_failed`,
`unknown_ticket`, `expired`, `bad_shard`, `bad_quality`, `nothing_playing`, `captions_failed`; the world shows its own
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

## Home relay playback

A relay worker with ffmpeg (`relay/media.js`) can also serve videos from the home connection (owner, 2026-10-23:
Tunelio first while the credits allow, home for longer videos, with a daily cap). Off unless `HOME_RELAY=on`.

**When a play goes home** (`src/server.js` `homeWhy`), for PC players, and for `.m3u8` tickets (the world's Android
build, which opens HLS) when `HOME_ANDROID=on`; never for an Android player on a plain ticket (it can't open HLS behind
one, f331bcc) and never for live streams:
1. a home session for the video is already there (late joiners, replays, a tablet warm),
2. Tunelio is off or paused (no key, out of credits),
3. the video is `HOME_LONG_MINUTES` (30) or longer: Tunelio's build time grows with the file and fails at ~115 s,
   while home starts in seconds whatever the length,
4. today's Tunelio spend is past the credit pacer's allowance (`src/adaptive.js` `Pacer`),
5. Tunelio's build failed (before youtube.com's 360p), or a Tunelio call timed out in the last
   `TUNELIO_SUSPECT_SECONDS` (120; `tunelio_slow`): `/create` normally answers in under 2 s and gives up after
   `TUNELIO_CREATE_TIMEOUT_SECONDS` (6), and when it doesn't answer it rarely does on the next try either
   (2026-10-23: two 12 s timeouts in a row, 48 s from pick to picture),
6. on a `.m3u8` ticket with `HOME_ANDROID=on`: Tunelio's HLS build is AV1 (read from its init segment), which the
   Quest 2 can't decode; home is always H.264 + AAC. Counted as `adaptive`/`android_av1` whether or not the flag is on.
   A higher rung of an adaptive master that turns out AV1 is answered, for a Quest player, with the best H.264 rung
   below it (`android_av1_rung`), so the play tops out lower instead of failing at the step up.

Only while a worker that announced `caps=media` is online and today's `HOME_DAILY_BUILDS` / `HOME_DAILY_MB` aren't used
up (YouTube may flag an IP that downloads a lot). Otherwise, or when the first segments don't arrive within
`HOME_READY_SECONDS`, the play takes the Tunelio path as before.

**How:** the server sends the worker `{kind: "media", videoId, quality, token}`. The worker has yt-dlp resolve the
H.264 + AAC stream URLs (they only work from the IP that resolved them), and ffmpeg reads them through a local proxy
that fetches 10 MB pieces with the URL's `&range=` parameter, as yt-dlp does (YouTube throttles a plain read to about
real time), and cuts 4 s MPEG-TS segments without re-encoding. It PUTs each segment and the growing playlist to `/relay/media/<token>/<file>` (relay token) and answers
the job once the first ones are up. Players get `302` to `/home/<token>/index.m3u8` (absolute links, starts at 0); the
resolver gets the "not a video" page. VizVid shows a playlist that is still growing as a live stream with no seek bar
for the whole play, so when the first 8 segments are all the same length (an encode with evenly spaced keyframes, like
long mixes) the worker uploads the whole playlist, `#EXT-X-ENDLIST` included, at once, and a segment asked for before
it arrives is held up to `HOME_SEGMENT_HOLD_SECONDS` (20). Other videos (keyframes at scene cuts) get the growing
playlist: no seek bar on the first play, one for replays and late joiners once the upload is done. Media Foundation
opens a growing playlist as live, at its end, with the clock from 0 (2026-10-23, Everything-is-OK#111: picture ~7 min
ahead of the captions), so a player is held up to `HOME_SETTLE_SECONDS` (10) when the upload rate says the rest is due
by then, and gets the finished playlist (`home`/`settled`; `home_first_segment` logs where each session's first
player started). Sessions are saved
next to their files and reloaded on restart (a deploy doesn't cut plays off, and the worker retries its uploads through
it); the day's use is saved too. Files are kept `HOME_KEEP_HOURS`, oldest finished first out above `HOME_MAX_GB`.

**The worker's cache** (`relay/cache.js`, owner 2026-10-23: "be aggressive, the Optiplex has lots of disk"): every
stream that finishes whole stays on the Optiplex too, one folder per video and quality, least recently used out above
`RELAY_CACHE_GB` (40; 0 = off; in the worker's env file). A later home job for it, after the Linode's copy expired, is
uploaded from that disk without yt-dlp or YouTube: faster, and no download from the home IP. Those uploads carry
`x-media-cached: 1`, so the server counts them as `home`/`cache_hit` and `home_today`/`cache_mb`, not against
`HOME_DAILY_BUILDS`/`HOME_DAILY_MB` (which exist for YouTube downloads). It lives in systemd's `CacheDirectory`,
`/var/cache/japharsworld-yt-relay/media`, or `RELAY_CACHE_DIR`. The Optiplex's root volume is 100 GB of a 954 GB disk
(the rest is unallocated in `ubuntu-vg`, 2026-10-23); a bigger cache wants its own volume mounted there (below). The
server's daily cap is checked before the job, so once it is reached even a cached video isn't asked for.

    sudo lvcreate -L 500G -n media ubuntu-vg && sudo mkfs.ext4 -L jyt-media /dev/ubuntu-vg/media
    echo 'LABEL=jyt-media /var/cache/japharsworld-yt-relay ext4 defaults,noatime 0 2' | sudo tee -a /etc/fstab
    sudo systemctl stop japharsworld-yt-relay && sudo mkdir -p /var/cache/japharsworld-yt-relay && sudo mount /var/cache/japharsworld-yt-relay
    echo RELAY_CACHE_GB=450 | sudo tee -a /etc/japharsworld-yt-relay.env && sudo systemctl start japharsworld-yt-relay

Fresh stream URLs often answer `403` for a while before they work (0.1–2.6 s, once 22 s, 2026-10-23); the worker's
proxy keeps asking every second for up to 30 s, so a start can take up to `HOME_READY_SECONDS` (40).

Measured 2026-10-23 on the Optiplex (ffmpeg 8.0.1, uploads only counted): first segments 2.9 s after the job at 720p
(yt-dlp 2.4 s), 6.2 s at 1080p; a 22-minute 720p video (216 MB) in 9.2 s. Uploads from home run ~12.6 MB/s.
`/ops/state` shows `home` (workers, today's use, sessions).

The worker needs ffmpeg on the Optiplex (`relay-setup.sh` installs the distro's); without it the worker doesn't
announce `media`. `RELAY_MEDIA=off` in `/etc/japharsworld-yt-relay.env` turns it off at home.

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

Without SSH: `GET /ops/state` (builds in flight and recently finished, holds, relay workers, the speed probe, the
deployed commit) and `GET /ops/events?event=a,b&minutes=&limit=` (the service's recent log events, kept in memory
since the last restart), behind `STATS_TOKEN`. Both are read only and redacted (`src/ops.js`): an allowlist of fields,
so video IDs, ticket numbers, shards and User-Agents stay on the server. `node tools/ops.mjs state | events --event
tunelio_link,build_failed` reads them with `STATS_TOKEN` from `.env`.

Player test kit (kept on purpose, 2026-10-23): `/hls-test/<hex>.m3u8` serves test playlists and slots from
`<db dir>/hls-test/`, `/hls-test/<hex>/<file>` hand-copied segments and playlists (a missing segment is held up to 10 s).
The VRPlayer TEST world bakes slots 01–11 (`/hls-test/7e570000000000NN.m3u8`; what each holds is listed in
`src/slots.js`; 08–11 are the Quest audio master variations). The slots are refilled with
`POST /ops/slots/refill[?id=<video>&force=1]` (20 credits, `SLOT_REFILLS_PER_DAY` a day, refused while the links
still have 2 hours left) and read with `GET /ops/slots`: `node tools/ops.mjs refill` starts one and waits for the
builds, `node tools/ops.mjs slots` shows what the slots hold and when they expire. Test plans: `POST
/ops/plan?id=<video>&mode=<start|adaptive|direct|lower|clear>&minutes=<1-240>` (`node tools/ops.mjs plan --id <video>
--mode start`; `GET /ops/plan` lists them) gives that video's plays the plan whatever the prediction, the room's pick
or the pacer say, so a test can play the 360p `start` plan on demand. The plan is held in memory, and a restart clears it.

## Development

```sh
npm install
npm test
node src/server.js   # http://127.0.0.1:8790
```
