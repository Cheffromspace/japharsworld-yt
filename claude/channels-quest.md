# Channels on Quest (Everything-is-OK#145): design, 2026-10-24

Status: proposal; the owner confirms the scope before code.

## Problem

Each of the 74 Channels slots bakes `https://www.youtube.com/playlist?list=PL…`: the owner's unlisted playlist, whose
first item the link monitor keeps pointed at the slot's stream. PC resolves it with VRChat's yt-dlp. Quest hands the
raw URL to AVPro, which fails (`OpenExtractor -10000`). Quest needs a baked service URL that answers with HLS.

The monitor's DB (`slots`, 2026-10-24) has 71 slots of kind `live`, 3 `video` and 1 `removed`. In practice this
feature is live streams.

## Endpoint

`GET https://yt.japharsworld.com/v1/ch/<key>.m3u8`, where `key` is the slot's stable key from `channels.json`.

- **Player** (AVPro, Quest): `302` to an HLS playlist for the slot's current video, or a status error.
- **Tablet** (`UnityPlayer` UA): JSON `{ v, key, state: building|ready|failed, plan, live, title, channel, error? }`,
  like a ticket status call.
- **Current video:** `slots.current_video` from `/var/lib/japharsworld-yt-monitor/monitor.db` (read-only; the
  playlist's first item, kept up to date by the monitor's swaps), else the video in the slot's baked `url`. A slot
  that is `auto_hidden` or `removed` answers `failed` with `error: "channel_down"`.

## How each kind resolves

| Kind | Resolves to | Plays as |
|---|---|---|
| Single video (`kind=video`) | its video ID | a search `.m3u8` ticket does today: Tunelio HLS, or home with HOME_ANDROID |
| Playlist (every slot) | `current_video` (its first item), then by that video's kind | as for that video |
| Channel (`/channel/<id>/live`, not baked today) | the channel's live video (the monitor's Live-tab lookup) | live |
| Live (`kind=live`, 71 slots) | its video ID | live HLS, below |

## Live: what it needs, and is it feasible now

YouTube's live HLS manifest and its segments only work from the IP address that resolved them, and Tunelio doesn't do
live. Since 7dab634 (staging 2026-10-28; 05319a1 on main and prod) a `.m3u8` ticket for a live stream gets a 302 to the
watch link, so VRChat on the Quest resolves YouTube's live HLS itself, and Quest plays live that way today. The
**home live relay** below is an alternative, not the only route:

- The Optiplex worker resolves the live manifest (yt-dlp). ffmpeg copies it (`-c copy`: H.264 + AAC, 720p, no
  re-encode) into a sliding-window HLS stream (the last 6 segments) and uploads it to the Linode as home VOD plays do
  now. The Linode serves `/home/<token>/index.m3u8` as a live playlist.
- **One session per slot, shared by every viewer.** It stops when no player has fetched the playlist for 60 s.
- **Cost:** home upload of about 1.5–2 GB an hour per watched channel (2.5–4 Mbit/s), for as long as anyone watches.
  It needs its own cap, separate from HOME_DAILY_MB, plus a limit on the number of live channels at once.
- **Work:** a live mode in `relay/media.js`; a live session kind in `src/home.js` (no end, idle stop, no cache); the
  `/v1/ch/` route; tests. About a day, then a Quest check (AVPro live HLS through ExoPlayer, and whether the latency
  and stalls are acceptable).

**Feasible, but not today.** Today's walk also showed open problems with home on Quest:

- the MPEG-TS warnings (`PesReader: Unexpected start code prefix`);
- the worker refusing a second stream with "busy" (since then `RELAY_MEDIA_MAX` is 4 streams at once, owner
  2026-10-25; `relay/worker.js`).

`HOME_ANDROID_GROWING` is on in prod since 2026-10-27 (75cf8e7, decisions.md 2026-10-27). Re-check the PesReader
warnings before live channels lean on home.

## What the world bakes

74 URLs, one per slot including the hidden spares, built from `channels.json` keys:
`https://yt.japharsworld.com/v1/ch/<key>.m3u8`.

- **Example:** `https://yt.japharsworld.com/v1/ch/lofi-sleep-chill.m3u8`.
- **Android build only.** PC keeps today's playlist URLs.
- **Adding a slot later** needs a re-upload, as it does today. Swaps inside a slot don't, because the key stays the same.

## If live isn't in this release

- **Recommended:** the Android build shows the Channels tab with a localized notice, "Channels play on PC for now",
  and no rows. Every slot is live, so hiding individual rows would leave the tab empty anyway.
- **Alternative:** remove the tab from the Android build.

The `.m3u8` URLs can still be baked now. The service would then answer `error: "channel_unavailable"` until live
exists, so turning it on later needs no re-upload.

## Owner decisions

1. Live through the home connection: yes or no, with an hourly or daily cap and a limit on channels at once.
2. This release: the notice (recommended) or no tab, and whether to bake the `/v1/ch/` URLs now.
