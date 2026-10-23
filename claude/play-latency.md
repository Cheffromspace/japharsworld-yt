# Play latency and player feedback (2026-10-19, design)

Goal (owner): pressing Play → video playing with as little delay as possible, and never leaving people guessing.

## Measurements (desktop PC, 2026-10-19 evening)

Path today for a search result: tablet → VizVid `PlayUrl(ticket)` → VRChat runs its yt-dlp on the ticket → service answers `302` only after Tunelio has **built** the file → yt-dlp follows → AVPro opens the Tunelio link.

| Step | Measured |
|---|---|
| Tunelio build, progressive mp4 (15 min – 2 h video) | 10–21 s cold (`/create` ~1–2 s + first byte); 0.3 s warm |
| Tunelio build, HLS | 15–33 s cold, and it is a **second** build (progressive after HLS: 0.5 s; HLS after progressive: 10–26 s) |
| VRChat's yt-dlp (fork 2026.08.19) | socket timeout **20 s**, no retry; adds ~3 s of its own; UA is a random Chrome string |
| yt-dlp timeout → VRChat hands the raw ticket to AVPro | AVPro follows the 302 and waits on the same build again |
| Warm ticket, end to end | ~5–6 s (yt-dlp ~3 s + AVPro ~2–3 s) ← the target |
| Worst case tonight | 1 h video, 3.5 GB progressive: 58 s from Play to picture |

Service logs: a Play produces 2–3 ticket hits at once (yt-dlp HEAD+GET), then one per AVPro/VizVid retry.

Conclusions:
- The build dominates. HLS does not help start time (owner's "use HLS sooner" idea is withdrawn by the data); keep progressive unless Tunelio refuses it (413) or the video is very long.
- Holding the ticket past ~17 s is the worst outcome: yt-dlp dies at 20 s and the wait starts over.
- 720p vs 1080p build time: see benchmark below.

## Latency plan

Service (`japharsworld-yt`):
1. **Per-client ticket answers** (by User-Agent; the string downloader is `UnityPlayer/…`, AVPro is Media Foundation, yt-dlp is Chrome-like):
   - string downloader → `200 JSON {state: building|ready|failed, format, etaSeconds, elapsed}` and start the build (**warm**). No 302.
   - yt-dlp → `302` to the Tunelio link when ready; while building, hold at most `TICKET_HOLD_SECONDS` (12) and then **fail fast** with a tiny HTML page (yt-dlp: "unsupported", ~1 s) so VRChat hands the URL to AVPro at once instead of after 20 s.
   - AVPro → hold until ready (cap 90 s → youtube.com fallback).
2. **Warm on select**: the tablet loads the ticket as a string ~1 s after a row is selected (debounced; nothing if the row is unselected first). The build starts while the visitor reads the title and reaches for Play. Cost: 10 credits per selected-but-never-played video (links are cached, so re-selecting is free). Switchable (`WARM_ON_SELECT`).
3. **Progressive first**: drop the blocking `checkProgressive` from the ticket route; it moves into the build job. HLS only on 413 or over `TUNELIO_PROGRESSIVE_MAX_MINUTES`.
4. ETA: a running average of build seconds per minute of video (per format) feeds `etaSeconds`.

World (watch branch):

5. The tablet becomes a VizVid listener (`core._AddListener(this, "_OnVideoBeginLoad" | "_OnVideoError" | "_onVideoReady" | "_onVideoStart")`) instead of polling `IsLoading`.
6. Warm request + state polling (string loads every 2 s while building, stops at ready) drive the feedback below.

## Feedback plan

One stage model, shown the same on the Watch strip, the Screen card and the wall screen (the wall line matters most: people are in bed, not holding the tablet). Localized (16 languages), dims with the room.

| Stage | Trigger | Tablet | Wall screen |
|---|---|---|---|
| Pressed | Play now tapped | button → "Starting…" at once; row stays lit with a spinner; Play/Queue disabled | title appears with "Starting…" |
| Preparing | warm JSON `building` | "Preparing HD · about 15 s" + thin bar advancing on the ETA (never reaches the end early) | same line + bar |
| Connecting | warm `ready`, player still loading | "Starting playback…" | same |
| Retrying | `_OnVideoError` | "Didn't start — trying again (2 of 3)" | same |
| Failed | retries exhausted | "Couldn't play this one. Try another, or Sync." | same, fades after 20 s |
| Playing | `_onVideoStart` | title, transport | message fades |
| Stuck | nothing after 90 s | "Taking longer than usual…" with Sync offered | same |

Queue: "Added to the queue · N ahead" for 3 s, no bar.

## Benchmarks and monitoring (owner, 2026-10-19: "collect benchmarks, author reusable utilities, monitoring metrics")

- `tools/bench-play.mjs` (service repo): for a list of video IDs or a search, measures `/create`, cold and warm first byte for progressive and HLS at 720p/1080p, writes `bench/<date>.json` + a markdown table. Reusable after any Tunelio or routing change.
- `Tools/bench-resolve.ps1` (world repo): runs VRChat's own yt-dlp against tickets and a local hold server; reports the resolver timeout and per-ticket resolve time.
- Service metrics (daily buckets, privacy rules unchanged): `ticket_client` (ytdlp/avpro/string/other), `ticket_hold_ms`, `ticket_fastfail`, `build_ms` by format and length bucket, `warm` / `warm_played` (credit waste ratio), `play_start_ms` is not measurable server-side; the world could report it later through a join-style ping (counts only).
- `/stats` gets a "Playback" section: p50/p95 build time, fast-fail rate, warm waste.

## Open questions

1. Warm on select (10 credits per abandoned selection) — on, off, or only after a 1.5 s dwell?
2. If 720p builds much faster than 1080p: 720p for long videos (say > 1 h)? Or a quality switch on the tablet?
3. "about 15 s" ETA text, or just the bar?
4. Should the wall screen show the loading line for Channels streams too (they take 3–5 s, usually fine)?

## Built (2026-10-19 night)

Service (`japharsworld-yt` main `c26a68f`, auto-deploys): per-client ticket answers (UnityPlayer UA → JSON build status + warm; Chrome-like UA = VRChat's resolver → 302 when ready, else held ≤ `TICKET_RESOLVER_HOLD_SECONDS` (12) then a plain HTML page so VRChat hands the URL to AVPro; anything else = the player → held until ready, ≤ `TICKET_PLAYER_HOLD_SECONDS` (90) then youtube.com). Builds are one job per video with an ETA learned per MB. **Build time follows file size, not length** (~17 ms/MB: 220 MB in 4 s, 915 MB in 16 s, 3.5 GB in 58 s; a 2 GB progressive build failed with 503 after 115 s): a 1080p file above `TUNELIO_MAX_MB` (1500) is made again at 720p (10 more credits), above `TUNELIO_PROGRESSIVE_MAX_MB` (1800) it is HLS. Search results carry `desc` (240 chars). Metrics: `ticket_client`, `ticket_hold_ms`, `ticket_fastfail`, `ticket_timeout`, `build`, `build_s_progressive/hls`, `build_length`, `build_size`, `build_quality`, `warm`, `warm_played` → /stats "Playback" line and a "Start-up" line in the daily Discord report. Tool: `tools/bench-play.mjs`. 84 tests.

World (`watch` branch, uncommitted): phrases 150–156 (16 languages, labels rendered; Android atlases NOT yet rebuilt). New `EverythingIsOKPlayFeedback` (on the YouTube URL object; a VizVid listener) paints the stage + bar on both Play now buttons, the strip (bar along its top, stage where the live controls sit), the Screen card (seek row) and the wall screen (title, stage, bar; dims with the room). `EverythingIsOKYouTubeSearch`: warm on select after a 1 s dwell (rapid tapping warms nothing; each row at most once per search), status polling every string-load gap (5.2 s) while it builds, the selected result's description left of the buttons (owner: "a teeny shot of dopamine"). `EverythingIsOKTablet.PlayFromList` starts the feedback (Channels too; the old dots are gone). ClientSim check: stages, bar and wall line render (screenshots in the session). Local PC Build & Test dispatched 2026-10-20 ~03:45Z; result pending when this was written.

Owner answers: warm after 1 s dwell; bar only (no ETA text); loading line on the wall for Channels too; 720p question settled by the size rule above.

## TEST upload (2026-10-20, 00:xx–02:xx CDT)

- Android text variants / label atlases rebuilt (4161 labels, 17 pages) for phrases 150–156; scene saved.
- PC TEST upload: SUCCESS (wrld_471c100d-251f-4526-a1b3-5de45b36cc17).
- Android: target switched, `Tools/test-upload.ps1 -Platform Android` requested at ~23:40 CDT; the editor bridge stayed unreachable for 2 h+ (an Android build after an atlas rebuild re-imports many textures; it may also have stalled or hit a dialog). Result unknown when this was written — check `Logs/test-upload/` (`result-*.txt`, `active.json`) and `SessionWork/2026-10-19/play-latency/test-upload-android.log`. If `active.json` remains with no result: Everything is OK > Publish > Recover interrupted test upload, then rerun. Switch the build target back to StandaloneWindows64 afterwards.

## Next (owner, 2026-10-19 late): mini-player bar + expanded player

Agreed design: a ~44 px status/mini-player bar at the bottom of every tablet page (idle: carries the search status lines; loaded: play/pause · title · time or live dot · chevron; loading: title + stage + bar along the top edge). Tap → expanded player overlay (~65 % of the page height) with everything from the Screen page (transport, seek, repeat/shuffle/sync/next, volume, screen brightness, captions picker + style gear, paste-a-link); the Screen tab leaves the rail; the Watch tab's now-playing strip goes; the Play buttons go back to plain "Play now" + bar; the selected search row expands to show the description (bottom Description text and the top status line removed). To build next session.

## Slower builds (2026-10-21) and the speed probe

Grafana (aggregate metrics, no logs) for 10-21: progressive builds of 500–1000 MB at 1080p (the ~20-minute videos)
took 30–40, 60–90 and 90–120 s, about 8–30 MB/s against the ~60 MB/s measured on 10-19; two more failed at ~02:00
CDT. Small files still built in under 8 s and `/create` stayed under 2 s, so the time is Tunelio's build. A build
past ~100 s (12 s resolver hold + 90 s player hold) ends in youtube.com at 360p: 4 of 10 plays that day. The one HLS
build (3 GB, 720p, over 3 h) took 40–50 s, still the old speed: worth re-checking "HLS doesn't help" against data.
To see whether this is a trend, the service runs a speed probe (`src/probe.js`, claude/metrics.md): Grafana
panels "Tunelio probe: time to start" and "build speed". Hourly at first, every 20 minutes from 10-21, hourly again
from 2026-10-23 (YT#19: ~720 credits a day at 20 minutes, more than playback's 80–450).

Serving from the Optiplex was set aside the same day (owner: "I can't get IP banned"): it would download every played
video from the home IP that also carries the search relay. Home upload measured ~55 Mbps from the desktop on the same
connection, so bandwidth was not the obstacle. (Taken up again 2026-10-23, below: an IP flag only adds YouTube's
sign-in wall for logged-out viewers on that connection, and a daily cap keeps the downloads modest.)

## Playtests and playback plans (2026-10-22, 00:00–02:45 UTC)

Measured with the owner in the TEST world, VRChat's log read live (vrchat-client MCP) and the test bridge driving
plays. Play → picture at 720p progressive: 6 s cached or small, 8–16 s typical cold. VRChat's own overhead is fixed:
yt-dlp ~3–4 s to start and reach the service (4–5 s when it follows the 302), AVPro 2–4 s to open. Answering the
resolver at once instead of holding it would save only ~0.5–1 s: not done.

720p vs 1080p (11 fresh 12–30 min videos, back to back, during a slow period of 4–6 MB/s): 1080p files are
1.5–3× larger and take that much longer; 3 of 11 1080p builds failed at Tunelio's ~115 s limit, no 720p build did.
Owner: 720p acceptable, 1080p noticeably better; goal p50 ≤ 20 s, p95 < 45 s Play → picture.

Tunelio speed swings with the hour, not the video: the same 997 MB file built at 15 MB/s (10-21 04:35 UTC) and
82 MB/s (10-22 00:44); YouTube served the "slow" videos as fast as any. Built files stay cached at Tunelio ≥ 2.5 h,
< 16 h. /create's reported size can repeat across qualities when two are created close together.

Adaptive HLS (720p + 1080p in one master playlist, src/adaptive.js) on PC AVPro (Media Foundation): starts on 720p,
asks for 1080p ~2 s in, retries a missing variant (≈50 tries in 3 s, then every ~6 s) and picks it up once it exists.
But the picture froze silently (clock running, no error) in 2 of 4 switches, with segments and timestamps aligned.
So the mid-video switch was turned off (ADAPTIVE_SWITCH=off). For player-by-player tests the VRPlayer TEST world
bakes fixed slot URLs /hls-test/7e570000000000NN.m3u8, filled from this service (src/slots.js). Since 2026-10-23
(YT#21) the slots, `/hls-test` and `/ops/slots` are a standing player test kit, not temporary code.

Bug found and fixed: AVPro resolves relative playlist links against the ticket URL after the redirect, so every
video over 3 hours whose HLS build outlasted the resolver hold failed until VizVid's retry (fe6612a: absolute links,
plain HLS builds served through our copy of the playlist).

Live at the time (shard 3 only, ADAPTIVE_HLS=on, ADAPTIVE_SHARDS=3; since widened to all shards, see below): the "Auto" plan, 1080p progressive when /create's 1080p size
and the median speed of the last builds (2 h, probe included) predict ≤ 10 s, else 720p; a room pick of 720p/1080p
overrides. Everywhere else: 720p progressive (default since aa05f52).

## Live state and the 360p first rung (2026-10-22 evening)

Live on the Linode (env file, read 2026-10-23 14:50 UTC): `ADAPTIVE_HLS=on`, `ADAPTIVE_SWITCH=off`,
`ADAPTIVE_START=360p`, no `ADAPTIVE_SHARDS` (= all shards), `HOME_RELAY=on`. Owner, 2026-10-23 (#103): turn the
switch back on service-wide and test it on PC and Quest clients; `ADAPTIVE_SWITCH=on` since ~15:00 UTC that day.

Owner: start on 360p to cut time to picture. YouTube's own 360p (VRChat's free youtube.com path) can't be a rung of our
playlist (single mp4, googlevideo link bound to the visitor's IP), so the rung is Tunelio's 360p HLS build (Tunelio docs
list 144p–1080p as `quality`). `ADAPTIVE_START=360p` (off by default): when the 720p HLS build is predicted to take more
than `ADAPTIVE_START_SECONDS` (10), the plan is `start`: the player waits only for the 360p build, the master lists
360p, 720p, 1080p, and both upper builds start on the first master load. 30 credits instead of 20.
Cost estimate from 10-19..10-22 daily build buckets: 1–16 builds a day over ~10 s → 10–160 credits a day, below the
speed probe's ~520–720. Not yet measured: a real 360p /create (size, build time) and whether AVPro steps 360p → 720p →
1080p without the freeze seen 10-22.

2026-10-23 (#104/#91), PC: 360p → 720p at +7 s → 1080p at +17 s stuttered in that window; 360p → 1080p at +11 s didn't.
Owner: one switch. The master of a start play listed only 360p and 1080p (6d1e54e); the 720p HLS build was still made
and stood in under the 1080p link when the 1080p failed, was AV1 on a Quest, or wasn't built 30 s after the first
master load. `ADAPTIVE_START_MID=on` lists the 720p again.

fjords2 (GEmzhBA5nkE, 1080p 580 MB, forced `start`, 18:40 UTC): 360p HLS 22.6 s, 720p HLS 77.8 s; the 1080p wasn't
there at 30 s, so the 720p was served under the 1080p link, AVPro switched at +91 s and stayed on 720p (a VOD variant
playlist is read once). Owner: step up twice instead, so big videos reach 1080p. Now the master's first load predicts
the 1080p HLS build (its /create has answered by then): ready within `ADAPTIVE_START_STEP_SECONDS` (30) → 360p, 1080p;
slower or unknown → 360p, 720p, 1080p (`adaptive`/`start_one_step`, `start_mid`; log `adaptive_start_rungs`). The
unlisted 720p still stands in for a failed or (Quest) AV1 1080p.

Same play, during the 360p phase: d4's 2 s frame diffs showed an identical pair about every 8 s, none after the
switch. The service side lines up with that: the 1080p variant was asked for every 8.03 s, each time held
`ADAPTIVE_HOLD_SECONDS` (8) and answered 404 (18:40:51, :59, 18:41:07, …; rI9x6DvOaao's play showed the same
pattern for 84 s). Segments come straight from Tunelio, so the service sees nothing of them. Not yet known whether the held
request is what stalls Media Foundation's 360p playback.

The first real retest of that (rI9x6DvOaao, 18:29 UTC) got `adaptive`. The plan predicted 12.4 s for a 613 MB 1080p;
the builds took 33 s (720p HLS, 170 MB) and 84 s (1080p). The median of the last five build speeds had come from
3FJctU--OxI played again, which Tunelio already had: 456–751 MB in 0.5–2 s, "46–1600 MB/s". Builds under 3 s or over
120 MB/s no longer teach the estimate (src/playback.js `cachedBuild`; `tunelio_link` logs `cached: true`). For tests
that need a given plan, `node tools/ops.mjs plan --id <video> --mode start` forces it (README, player test kit).

The fb404f1 deploy then showed the other half: a restart dropped the recent speeds and the learned rates, and the
restart seed (the probe's builds of the last 2 h) held nothing usable (only pair rows), so the plans fell back to the
priors (~33 MB/s at HLS: 580 MB ≈ 20 s, one switch) on a day of 3–7 MB/s. Now the recent speeds and learned rates are
kept in `build-speeds.json` next to metrics.db and loaded on start (speeds and rates only, no video IDs), and a start
master with fewer than two measured builds to go on lists the 720p (`Playback.measured()`).

A deploy restart (19:22:29 UTC, 39a4b34) dropped the adaptive sessions and their in-flight builds: the player's
upper-rung requests became instant 404s, so it would have stayed at its first rung for the rest of the video.
Now `playback-live.json` (the paid /create links, ready and in-flight builds) and `adaptive-live.json` (sessions,
forced test plans) are kept next to metrics.db and loaded on start; in-flight builds start again on the same link
(no new credits). That play (dahs-TRr9os) had already lost its 720p and 1080p four seconds earlier: both failed after
62.87 s, as Croatia's 1080p did (62.875 s), so something cuts builds off at a fixed ~60 s (status logged since 39a4b34).

## Home relay playback (2026-10-22/23)

Owner: add the home connection to the serving chain, "as part of our adaptive credit spending, preferring Tunelio",
"slightly for longer videos", with a daily cap. Built as `src/home.js` + `relay/media.js` (README, "Home relay
playback").

A URL yt-dlp resolves at home is bound to the home IP, so the media has to pass through the Linode. Download + merge +
upload of whole files from the desktop (same connection), 2026-10-22 ~22:00 CDT: 720p 55–207 MB in 10–24 s, 1080p
226–522 MB in 27–57 s; download 8–27 MB/s, upload ~12.6 MB/s (scp). Tunelio probes the same evening: 6–14 s typical
at 720p, 3–84 s at 1080p (7–61 MB/s).

Streaming instead of whole files: ffmpeg copies YouTube's streams into 4–5 s TS segments as they download; the worker
uploads each one and the growing playlist. VRPlayer TEST, desktop client, 2026-10-23 03:30 UTC (playlist growing at
1.5× real time on purpose): VizVid and bare AVPro both opened the EVENT playlist at seg0, picture in ~2 s, re-read the
playlist every few seconds and played 13 minutes with no missing segment and no error. Not yet seen: whether players
show a seek bar and duration while the playlist is open; Quest (Android can't take HLS behind a ticket anyway).

YouTube throttles one long read of a stream URL to about real time: ffmpeg reading the URLs directly got 0.1 MB/s, with
`-request_size 10000000` (range requests, as yt-dlp makes) 13.6 MB/s. Local end to end with the real worker: first
segments 3.8 s after the play (yt-dlp 3.2 s), a 21.7-minute 720p video (216 MB, 260 segments) in 9.3 s.

`-request_size` is only in ffmpeg development builds (the Optiplex has 8.0.1), and on the Optiplex a 10 MB Range
header got 403 (small ones 206) while the same piece as `&range=a-b` in the URL, yt-dlp's way, got 200 at 19.8 MB/s. So
the worker runs a local proxy (relay/media.js `rangeProxy`) that ffmpeg reads from. One video's fresh URLs answered
403 for a minute or two during rapid testing, then 200; the proxy retries a piece three times. On the Optiplex
(uploads only counted): ready 2.9 s at 720p, 6.2 s at 1080p; 216 MB in 9.2 s, 260 MB (1080p) in 10.3 s.

In VRChat (PC, VizVid, Everything is OK TEST, 2026-10-23 ~06:00 UTC), production chain through the Optiplex: a 6 h
lofi mix, Play → picture 12 s; while the playlist grew VizVid showed only elapsed time (live-style, no seek bar), and
kept that for the whole play after ENDLIST arrived; a replay of the finished playlist had the seek bar (0:00 / 6:10:57)
and started in ~3 s. Publishing the whole playlist up front (predicted) works only for evenly spaced keyframes: the
mix was 4388 × 5.071733 s, but four ordinary 20-minute videos had segments of 0.1–8.6 s (scene-cut keyframes), so the
prediction is used only when the first 8 segments are identical (the mix: predicted exactly, 4389 segments).

Stream URLs fresh from yt-dlp often answer 403 at first, from Node as well as ffmpeg (six videos on the Optiplex: 200
after 0.1–2.6 s, one after 22 s); yt-dlp itself never noticed (its first request came later). The proxy retries for up
to 30 s.

Daily cap (YT#24, 2026-10-23): one 6 h mix is ~2.5 GB, so 10 GB a day went in a few long videos; owner: 50 GB a day
(`HOME_DAILY_MB` default 50000).

A deploy (06:03, another session's commit) restarted the service and cut off the home streams, which were in memory
only; sessions are now saved with their files and reloaded.
