# Channels link monitor (`slotmon`)

Keeps the **Channels** tab of the VRChat world *Everything is OK* working without world uploads.
The world bakes one link per slot: the slot's unlisted playlist on the owner's YouTube account (VRChat plays its first item),
or the stream URL when the slot has no playlist yet. Every 15 minutes the monitor checks each slot's stream. When one goes
down, it hides the row and looks for a replacement on the same channel. A replacement goes in as the playlist's first item
only after it passes the flash check and plays at 720p or better. All of it is logged to SQLite.

Publishes to GitHub Pages (`docs/` on `main`), committing only when something changed:
- `docs/sleep-list.json`: `{ "notice": "...", "slots": { "<key>": { "hidden", "title", "channel", "order", "category" } } }`,
  written as differences from what the world baked. Owner edits go in `monitor/overrides.json`.
- `docs/sleep-thumbs.jpg`: cell *i* = slot *i* (10 columns of 192×108 from the top left), exactly the baked size (2048×1024 for up to 90 slots).

## Where things run

| | Linode (`slotmon run`, systemd timer) | Optiplex worker (systemd timer) |
|---|---|---|
| Live status, viewers, start time, title, channel | Data API if `YT_API_KEY`/OAuth is set, else the watch page HTML | |
| Find a replacement (`/channel/<id>/live`, the Live tab) | yes (page HTML, no quota) | |
| Resolution + flash check | only with `cookies.txt` (YouTube bot-walls the datacenter IP) | yes: yt-dlp (updated daily) + ffmpeg |
| Playlist swaps, `sleep-list.json`, thumbnails, Discord | yes | |

Jobs (resolution + flash) are queued for every new stream, for each candidate replacement, and once a day for each slot's stream.
The Optiplex worker claims them over SSH (`slotmon claim --runner optiplex`), runs them and sends the results back (`slotmon submit`).
A flash fail is sent at once and the rest of the run carries on; a claim never reported is handed out again after 1 h.
Its key in the Linode's `/root/.ssh/authorized_keys` is `restrict,command="/usr/local/bin/slotmon-remote"`, so it can do nothing else.
A flash fail hides the slot at once, empties its playlist so nothing plays, and pings Discord (urgent).
While no worker is running, replacements wait hidden, and the daily summary says the checks are stalled.

Rules for replacements: live; no ASMR or Yellow Brick Cinema in the title/channel; the same 24/7 stream restarted (same
channel, similar title) is accepted at any age; any other stream must be marked 24/7 (or radio/live cam) and have run 40 h;
720p or better; passes the flash check. `kind: video` slots in `overrides.json` (the three DJ Grossman 12-hour noise uploads)
are only checked for availability.

Quota: a check is 2 units (videos.list); a swap is about 103 (insert + delete + 2 lists); the daily playlist check is about 66.
Past 8,000 units it alerts; past 9,000 only swaps and flash-fail removals spend units. HTML checks cost nothing.

## Deploy (Linode, as root)

The repo deploys itself: `japharsworld-yt-update.timer` pulls `main` every 5 minutes and runs `deploy/monitor-setup.sh`
when monitor files change. Commits that touch only `docs/` or `monitor/` don't restart the search service.
On the first deploy (or by hand: `bash /opt/japharsworld-yt/deploy/monitor-setup.sh`) it creates
`/opt/japharsworld-yt-monitor-venv`, `/var/lib/japharsworld-yt-monitor` (database, Pages clone, deploy key, cookies),
`/etc/japharsworld-yt-monitor.env` (settings and secrets, root only), `/usr/local/bin/slotmon`, the 15-minute timer, and loads the seed.

Secrets go in `/etc/japharsworld-yt-monitor.env`:

1. **Deploy key** (publishing): setup prints `deploy_key.pub`. Add it under GitHub repo > Settings > Deploy keys with
   **Allow write access**. Until then the files are only written to `/var/lib/japharsworld-yt-monitor/out/`.
2. **Discord**: `DISCORD_WEBHOOK=https://discord.com/api/webhooks/...`, and optionally `DISCORD_MENTION=<@your id>` (no alert pings it since #246). `MASS_DOWN` (default 8) or more shown slots down or hidden at once is one plain alert, at most once in 24 h and with no all-clear. Single channel events (down, back up, candidate, replaced, a swap that failed) go to the journal only, and the daily summary lists the day's replacements and failures (owner, 2026-10-29). A flash fail on a playing slot still alerts at once. `DISCORD_CRITICAL_WEBHOOK` (world #195) is for sends marked critical, none today.
3. **YouTube API key** (optional, more exact start times, saves page loads): `YT_API_KEY=`.
4. **OAuth** (playlist swaps): `YT_CLIENT_ID`, `YT_CLIENT_SECRET` (from `client_secret.json`) and `YT_REFRESH_TOKEN`
   (from `token.json`, written by the world repo's `Tools/youtube-slots`). Publish the Google OAuth app to production
   first; a Testing app's refresh token expires after 7 days.
5. **Cookies** (optional): `/var/lib/japharsworld-yt-monitor/cookies.txt` (a throwaway Google account, owned by `jyt`, mode 600)
   lets the Linode run flash checks itself.

After editing the env file: `systemctl start japharsworld-yt-monitor` (one pass now) and `slotmon alert-test`.

## Optiplex worker (owner's home server)

After `deploy/relay-setup.sh` (the search relay):

```sh
sudo bash /opt/japharsworld-yt-relay/deploy/slotworker-setup.sh
```

That installs ffmpeg, yt-dlp (`/opt/japharsworld-yt-slotworker-venv`, updated daily by the relay's update timer) with the
bgutil PO-token plugin and its server (`bgutil-pot-relay.service` on 127.0.0.1:4416, `deploy/bgutil-setup.sh`; the relay
worker's captions and media use the same yt-dlp), and
`japharsworld-yt-slotworker.timer` (every 20 minutes, user `jytrelay`, outbound SSH only), creates its SSH key in
`/var/lib/japharsworld-yt-slotworker/` and prints the restricted line for the Linode's `/root/.ssh/authorized_keys`.
Log: `journalctl -u japharsworld-yt-slotworker`. Run once now: `systemctl start japharsworld-yt-slotworker`.

Heights come from the full yt-dlp with VRChat's format selector. For **live streams** they match VRChat's own yt-dlp
(1080p, checked 2026-10-19); for ordinary uploads they can differ (YouTube serves different clients different
formats: VRChat got 360p for the pink-noise upload, the Optiplex 1080p). The 720p rule only applies to live slots,
so `video` heights in `slotmon status` are informational.

## PC worker (owner's PC, retired)

The Windows worker still works (runner `pc`) if the Optiplex is ever unavailable:

```bat
monitor\pc-worker-setup.cmd
```
That installs ffmpeg (`imageio-ffmpeg` into `monitor/.deps`) and adds the Task Scheduler entry "Everything is OK slot worker",
which runs every 20 minutes without a window while you're logged in. It uses `~/.ssh/mediamtx_vps` and VRChat's yt-dlp.
Log: `monitor/data/worker.log`. Remove the entry with `schtasks /Delete /TN "Everything is OK slot worker" /F`.

## Day to day

```sh
slotmon status                 # every slot: stream, height, flash peak, last status, hidden by the monitor?
slotmon report --days 14       # baseline: uptime per slot, restarts, resolution changes, flash results
slotmon queue <videoId> --slot <key>   # flash-check a stream by hand
slotmon publish --thumbs       # publish now, with a fresh thumbnail sheet
journalctl -u japharsworld-yt-monitor -n 50
```

- **Changing the list:** edit `Assets/EverythingIsOK/Channels/channels.json` in the world repo, copy it to `monitor/channels.json`
  here, and push. The world preflight (`Tools/channels-monitor/preflight.cmd`) warns when the two differ.
- **Showing a spare, renaming, recategorising, notices:** `monitor/overrides.json`, then push. Takes effect on the next pass.
- **A title that follows the stream** (for a channel whose 24/7 stream keeps changing, #793): give the slot
  `"title_from": "stream"` in `overrides.json` (exactly that value; any other value, or none, is ignored and the slot
  keeps its fixed title). The published title is then the first part of the stored title of the stream the slot plays
  (`streams.title` of `slots.current_video`), cleaned for the list (owner, 2026-11-15: "First part only"); the code is
  `slotmon/titles.py`. Cleaning removes emoji and pictographs, control and format characters (a soft hyphen without
  splitting the word; ZWNJ/ZWJ stay between letters; a bidi control between two words becomes a space), a third
  combining mark in a row on one letter, `<` and `>` (and tags like `<b>`), and live markers only where they stand as
  markers, also in fullwidth or styled letters: `24/7`, `Live Now:`, the all-caps `LIVE`, "live" beside 24/7 or alone in
  brackets or between separators, and a `Live:` label ("Long Live the Night", "live music" and "live.com" stay). Where
  something was removed, no separator is left doubled or at an end and no bracket or quote pair is left empty.
  Parts are split at `· • | ｜ ¦ 丨 ⋆ ‖ ／` wherever they stand and at `- – — ~ / ｰ` only with spaces round them ("Lo-Fi",
  "study/relax" stay whole), never inside a bracket or quote pair ("Night Train (Tokyo – Osaka)" is one part); commas,
  colons and the katakana `・` never split. The first part with a word in it is used, unless it is bare (one token under
  4 units like "A" or "4K", or no letter at all like "2024"): then the next part. It is cut at 64 units (a wide CJK
  character counts two) after a whole word, or inside a run of CJK with no space, and back to before a bracket or quote
  the cut would leave open; a bracket or quote the title itself left unpaired is dropped. 64 is just above the most one
  tablet line held in the seed titles (62), so the row's own one-line cut still applies to a long one. E.g. "🔴 Lonely
  Lakeside Campfire · LIVE 24/7 · Boundary Waters Fire Crackling for Sleep 🔥" becomes "Lonely Lakeside Campfire". With
  no stored title, one that cleans to nothing or only to bare parts, one with a banned word anywhere in it
  (`BANNED_WORDS`, the replacement rule's list), or an error in the title code (logged as `title_from <key>: …`; the pass
  goes on), the slot's `title` in `overrides.json` is used, else the baked one. It changes after a swap has stuck (not
  while a candidate waits for its flash check), after the daily playlist read follows a hand edit, and when the channel
  edits its title (every status check stores it again). Only the published title follows; the channel line and the
  Discord/summary labels keep their baked text. Known limits, left on purpose: `<3` loses its `<` ("I <3 rain" →
  "I 3 rain"); an all-caps LIVE is taken as the marker even where it is a word ("LIVE MUSIC all night" → "MUSIC all
  night"); styled letters outside a marker (𝐂𝐚𝐦𝐩𝐟𝐢𝐫𝐞) pass through and the row font may not draw them; an ANSI escape
  leaves its text behind ("Rain\x1b[31mRed" → "Rain 31mRed"; YouTube titles can't hold one).
- **Retiring a slot** (a stream down for days with no replacement; slot order is frozen, so never remove it): in `overrides.json`
  give it `"hidden": true, "kind": "unmanaged", "retired": "<date>: <reason>"`. It leaves the checks, the replacement search,
  the daily summary, the mass-outage count and Grafana; drop the entry to bring it back. Five retired 2026-10-29 (owner).
- **A slot the monitor hid** comes back by itself when its stream is live again (outages), or after a swap. A flash-fail hide
  stays until you clear it: `sqlite3 /var/lib/japharsworld-yt-monitor/monitor.db "UPDATE slots SET auto_hidden=0, auto_reason=NULL WHERE key='...'"`
  (only once the stream is replaced or rechecked).

Tests: `cd monitor && python -m unittest test_slotmon`.
