# Channels on Quest (Everything-is-OK#145): design proposal, 2026-10-24

Status: proposal for the owner, no code yet.

## The problem

The Channels tab bakes one URL per slot (`monitor/channels.json`): the slot's unlisted playlist on the owner's account
(`https://www.youtube.com/playlist?list=PL…`, whose first item the monitor keeps on a live stream), or the stream's
watch URL for a slot without one. On PC, VRChat's yt-dlp resolves those. On Quest the world hands the raw youtube.com
URL to AVPro, which fails (`AndroidVideoMedia OpenExtractor -10000`, TEST 3737730). A Quest player needs an HLS
URL it can open, and the world can't build one at runtime, so it has to be baked: one service URL per slot.

## Entry kinds

| Kind | Today | What playing it needs |
|---|---|---|
| Playlist (every visible slot) | unlisted playlist, first item a 24/7 **live** stream | the current item, then as for that item |
| Live stream (a slot without a playlist) | watch URL of a live stream | live HLS (below) |
| Channel (`/channel/<id>/live`) | not used; the monitor uses it to find replacements | the channel's current live stream, then live HLS |
| A VOD in a playlist (not used today) | – | the same as a search `.m3u8` ticket: Tunelio HLS, or home (#105) |

So in practice the whole feature is live streams: every Channels slot is a 24/7 stream by the list's own rule.

## Proposed URL

`https://yt.japharsworld.com/v1/ch/<key>.m3u8`, one per slot `key` (stable by design: the status file and the monitor
already refer to slots by key), hidden spares included so the status file can switch them on without a re-upload.
Example: `/v1/ch/lofi-sleep-chill.m3u8`.

- **Player** (AVPro on Quest): `302` to an HLS playlist for the slot's current video.
- **Tablet** (`UnityPlayer` user agent, as for tickets): JSON status `{ state, plan, title, channel, live: true }`.
- **Video lookup:** the slot's current video ID read from the monitor's DB (`/var/lib/japharsworld-yt-monitor/monitor.db`,
  read-only), falling back to the slot's baked URL. A swapped stream needs no re-upload.
- **PC** keeps today's youtube.com URLs, which work.

Adding these URLs changes the baked URL set, so it needs a world re-upload, like any URL shape change.

## Live HLS: the options

YouTube's live HLS manifest and its segments are bound to the IP address that resolved them (`ip=` in the URL), like
the VOD stream URLs behind the home relay. So:

- **A. Home live relay (recommended).** The Optiplex worker runs yt-dlp for the live manifest, and ffmpeg copies it
  (`-c copy`, no re-encode, H.264 + AAC) into a sliding-window HLS stream: the last ~6 segments, older ones deleted.
  The worker uploads each segment and the playlist to `/relay/media/<token>/`, as it does for VOD home plays, and the
  Linode serves `/home/<token>/index.m3u8` as a live playlist (no ENDLIST, which is correct here).
  - **One session per slot**, shared by every viewer. It stops when no player has fetched the playlist for ~60 s.
  - **Cost:** home upload for as long as anyone watches: about 1.5–2 GB an hour at 720p (2.5–4 Mbit/s). It should
    count against `HOME_DAILY_MB` (50 GB/day today), or get its own cap.
  - **Limits:** the worker's media slots (`mediaMax`) are shared with VOD home plays. Two live channels plus a long VOD
    would refuse the next one ("busy", as on 2026-10-24), so it may need its own limit or a second worker.
  - **Work:** a live mode in `relay/media.js` (sliding window, no whole-playlist prediction, restart on a manifest
    error); a live session kind in `src/home.js` (no ended state, idle stop, no disk cache); the `/v1/ch/` route. About
    a day plus a Quest check.
- **B. The Linode fetches the live stream itself.** Linode IPs get YouTube's bot checks, which is why search and
  home already go through the Optiplex. Not recommended.
- **C. Redirect the Quest to a manifest resolved elsewhere.** It is IP-locked, so it fails on the visitor's IP. Not possible.
- **D. Tunelio.** Doesn't do live (the service already skips `data.live`).

## Questions for the owner

1. Live through the home connection (option A), with what cap: per day, and the number of live channels at once?
2. Which slots: all of them, or a Quest subset?
3. When the cap is reached, or no worker is online: show "Channels unavailable on Quest right now" (a status error
   code the world localizes), or fall back to the raw URL as today?
