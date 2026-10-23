# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Backend for the VRChat world **Everything is OK** (`https://yt.japharsworld.com`): YouTube search, playback redirects,
captions and usage metrics, plus a separate Python Channels link monitor. README.md is the user-facing spec (API, relay,
setup); `claude/` holds the design docs: `metrics.md`, `monitoring.md` (Grafana Cloud) and `play-latency.md`
(ticket hold timings and why, measured build times, the world-side feedback design).

## Commands

```sh
npm install
npm test                                   # node --test test/*.test.js
node --test test/server.test.js            # one file
node --test --test-name-pattern="privacy" test/metrics.test.js   # one test
node src/server.js                         # http://127.0.0.1:8790 (data/ for SQLite files)
cd monitor && python -m unittest test_slotmon   # the Python link monitor's tests
node tools/grafana.mjs build              # regenerate the reviewed copies in grafana/*.json
node tools/grafana.mjs push               # create/update dashboard + alert rules in Grafana Cloud (needs .env)
node tools/bench-play.mjs                  # playback start-up latency benchmark
node tools/ops.mjs state                  # live service state without SSH (STATS_TOKEN in .env); `events --event a,b`, `slots`, `refill`
```

Node >= 22.13, ESM, no build step, no linter, no TypeScript. Only two dependencies (`youtubei.js`, `sharp`); SQLite is
the built-in `node:sqlite` (`DatabaseSync`). Keep it that way unless asked.

## Deploying = pushing to `main`

There is no CI. `japharsworld-yt-update.timer` on the Linode pulls `main` every 5 minutes, restarts the service and
rolls back if `/healthz` fails (`deploy/update.sh`). The Optiplex relay pulls `main` too (`deploy/relay-update.sh`).
So a push to `main` is a production deploy: run `npm test` first. The Linode's monitor also commits `docs/`
("Channels status: …") to `main` on its own, so always `git pull --rebase origin main` before pushing
(`deploy-now.cmd` does pull, test, push).

`deploy/update.sh` decides what to restart from the changed paths: commits touching only `docs/`, `monitor/`,
`relay/`, `metrics/` or the related `deploy/` files do not restart the search service. When adding a new file
or unit, check those regexes in `update.sh`.

## Architecture

Three hosts: the **Linode** (search service, metrics poller/exporter, link monitor, Alloy), the owner's **Optiplex**
at home (relay worker, slot flash-check worker, Alloy; outbound connections only), and **GitHub Pages** (`docs/`:
`status.json` kill switch, `sleep-list.json`, `sleep-thumbs.jpg`). Shell access: `ssh linode` (root) and
`ssh jonflatt@192.168.1.4` (the Optiplex, Ubuntu 26.04; sudo needs the owner's password, so service restarts and
`/etc/japharsworld-yt-relay.env` edits go through the owner or the 5-minute update timer).

**Core constraint:** VRChat worlds can't build URLs at runtime. The world bakes `/v1/<shard>/<n>` for every shard and
`n < POOL`, and the search box itself is a URL (`/v1/<shard>/s?l=…&q=<prefill> → <typed>`). Changing `SHARDS` or `POOL`
(or any URL shape) breaks the uploaded world, which needs a re-upload. Error codes are a contract too: the world
localizes them.

Search service (`src/`):
- `server.js` `createApp({...})` wires everything and takes every collaborator (store, youtube, captions, playback,
  tunelio, relay, api, metrics, alert, log) as an injectable option; tests replace them with fakes and run the real
  HTTP server on port 0. Follow that pattern rather than mocking modules.
- `store.js`: SQLite ticket pools. Searches bind the next free tickets round-robin to videos, the thumbnail sheet
  (`sheet.js`, sharp) and the next page; played video tickets are pinned for `PIN_HOURS` so late joiners get the same video.
- `search.js`: fallback chain relay worker (`relay.js`, long-poll job queue for the Optiplex `relay/worker.js`) →
  local InnerTube (`youtube.js`) → YouTube Data API (`dataapi.js`, quota-limited) → `502 youtube_failed`.
- `playback.js` + `tunelio.js`: a video ticket redirects to a paid Tunelio HD link (progressive mp4 or HLS, quality
  chosen by size/length) or falls back to youtube.com. It answers differently by `User-Agent` (`clientKind`:
  world downloader gets JSON build status, VRChat's yt-dlp resolver is held briefly, the player is held until ready).
  Links are cached per video to share one paid call.
- Captions: `transcripts.js` (Tunelio, credits, fetched only on demand) or `captions.js` (yt-dlp, when no Tunelio key).
- `metrics.js` / `stats.js`: daily counters flushed to `metrics.db` every minute; `/stats` HTML/JSON/CSV.
- `alert.js`: Discord webhook with per-key rate limiting.
- All settings come from env vars in `config.js` (documented in `deploy/japharsworld-yt.env.example`).

Elsewhere:
- `metrics/`: `poll.js` (systemd timer: VRChat, Tunelio, GitHub numbers; daily/weekly Discord reports via `report.js`)
  and `exporter.js` (Prometheus endpoint on 127.0.0.1:9464 reading `metrics.db` and the monitor's DB, scraped by
  Grafana Alloy, `deploy/alloy/*.alloy`). Dashboard and alert rules are generated in code by `tools/grafana.mjs`;
  `grafana/*.json` are build outputs, never edit them or the Grafana UI by hand.
- `monitor/`: separate Python service (`slotmon`) for the world's Channels tab; see `monitor/README.md`.
  `monitor/channels.json` is a copy from the world repo.
- `data/` is gitignored scratch (ad-hoc e2e/probe scripts and logs).

## Privacy is enforced in code

Metrics store only per-day (at most per-hour) counts: no IPs, search text, video IDs, ticket numbers or VRChat
user/instance IDs, and no raw logs leave the server (`/ops/events` gives the token holder recent events through a field
allowlist, `src/ops.js`, IDs masked). Every metric key passes a fixed check (`METRICS` / `checkedKey` in
`src/metrics.js`, otherwise `other`). `test/metrics.test.js` ("privacy") and `test/exporter.test.js` scan the stored
and exported data for leaked values. A new metric needs a key check and must keep those tests passing; anything
that changes what is collected must also update `claude/metrics.md` and `public/privacy.html`.

## Conventions

- Comments explain *why* and record measured facts with dates (e.g. "~17 ms per MB, 2026-10-19"); match that.
- Logs are one JSON object per line (`logJson({ event: … })`).
- Commit messages: `Area: what changed (why)`, plain sentences.
- Owner rule (2026-10-23): when the player test kit changes (test slots, refill limits or link lifetime, `/hls-test`,
  how to get a given play plan, `/ops/events` fields), also update the Everything is OK e2e-test skill:
  `../Everything is OK/.claude/skills/e2e-test/quest.md` and the `slot` line in `desktop-client.md`.
