# japharsworld-yt

YouTube search and captions for the VRChat world **Everything is OK**, served from `https://yt.japharsworld.com`.

VRChat worlds can't build URLs at runtime: Udon can only load URLs baked into the world or typed into a URL field.
This service works within that rule:

- **The search box is the URL.** The world pre-fills `https://yt.japharsworld.com/v1/<shard>/s?l=<lang>&q=<prompt> →`
  and the visitor types after the arrow. Everything up to the last arrow is ignored.
- **Tickets.** The world bakes `https://yt.japharsworld.com/v1/<shard>/<n>` for every shard and `n < POOL`.
  A search binds the next free tickets to its videos, its thumbnail sheet and its next page, and answers with
  ticket numbers. Loading a video ticket is a 302 to `youtube.com/watch?v=…`; each visitor's VRChat resolves
  the video itself, so no video passes through this server.
- **Shards.** Each instance picks a shard at random (synced), so instances rarely share tickets.
- **Pinning.** A video ticket that has been played is pinned for `PIN_HOURS` and skipped when tickets are
  handed out, so late joiners loading the synced ticket get the same video.
- **Captions.** `GET /v1/<shard>/cc/<lang>` returns captions for the video last played in that shard, in the
  visitor's language: the uploader's subtitles, else the original auto captions, else YouTube's translation.
  `lang` is a VRChat client language or `native`. The response carries the ticket `t` so the world can check
  it matches what's on the screen.

## API

| Path | Returns |
|---|---|
| `GET /v1/<shard>/s?l=<lang>&q=<…> → <query>` | JSON: `results[]` (`t`, `id`, `title`, `channel`, `length`, `seconds`, `views`, `age`, `live`, `cc`), `sheet`, `sheetCols`, `sheetRows`, `cellW`, `cellH`, `next` (`-1` = none) |
| `GET /v1/<shard>/<n>` | video: 302 to YouTube · sheet: JPEG, cell *i* = result *i*, row-major · page: JSON like a search |
| `GET /v1/<shard>/cc/<lang>` | JSON: `t`, `id`, `available`, `source` (`manual`/`auto`/`translated`), `lines` = `[[start, dur, text], …]` |
| `GET /healthz` | `{"ok": true}` |

Errors are JSON `{ "error": code, "message": … }` with codes `empty_query`, `rate_limited`, `youtube_failed`,
`unknown_ticket`, `expired`, `bad_shard`, `nothing_playing`, `captions_failed`; the world shows its own
localized text per code.

Changing `SHARDS` or `POOL` changes the baked URLs: the world must be re-uploaded with regenerated URLs.

## Status / kill switch

`docs/status.json` is published on GitHub Pages
(`https://cheffromspace.github.io/japharsworld-yt/status.json`), a trusted domain every visitor can read
even without "Allow Untrusted URLs". Set `"search": false` and a `message` to hide search in the world
during an outage.

## Channels link monitor

`monitor/` is a separate small Python service (systemd timer every 15 minutes) that keeps the world's Channels tab
working: it checks every slot's 24/7 stream, swaps restarted streams into the slot playlists, runs the flash check
(through a worker on the owner's PC), and publishes `docs/sleep-list.json` and `docs/sleep-thumbs.jpg`.
See [monitor/README.md](monitor/README.md).

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
