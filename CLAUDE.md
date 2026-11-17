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

## Deploying: a push to `main` is production

**A push to `main` is a production deploy and needs the owner's explicit go for that push.** Green tests are not a go.
`japharsworld-yt-update.timer` on the Linode fetches `main` every 5 minutes and runs `deploy/update.sh`, and the
Optiplex relay pulls `main` too (`deploy/relay-update.sh`). GitHub Actions (`.github/workflows/test.yml`) runs `npm test`
on every push and pull request to `main` and `staging`, but nothing waits for it: a red run does not stop a deploy.

Before any push:

1. Work on a branch. Changes are tried first on the `staging` branch and its server, which deploys that branch with the
   same script (`DEPLOY_BRANCH`); `node tools/ops.mjs --staging …` reads it. `staging` is `main` plus what is being
   tested (owner, Everything-is-OK#712): a change goes to `staging` first and reaches `main` by merge, never by
   cherry-pick, and `main`'s own commits reach `staging` by merge too. The branches last converged on 2026-11-10 (#700).
2. Run `npm test` (offline). The link monitor's Python tests are separate: `cd monitor && python -m unittest test_slotmon`.
3. Report your claims, one per line, each with its evidence. An independent verifier checks every batch before any push.
4. `main` moves only on the owner's go. The Linode's monitor commits `docs/` ("Channels status: …") to `main` on its
   own, so merge `origin/main` in just before that push (never rebase or cherry-pick: that copies commits and the
   branches drift apart again).

What a deploy does (`deploy/update.sh`): it decides what to restart from the changed paths. Commits touching only
`docs/`, `monitor/`, `relay/`, `metrics/`, `public/`, `test/`, `tools/`, `claude/`, `grafana/`, `infra-check/`,
`README.md`, `CLAUDE.md`, `.gitignore`, `.github/` or the related `deploy/` files don't restart the search service; anything else
does (`src/`, the packages, the env example, a new file at the root). A restart drops held players and builds in
flight, so it waits while the service is busy (up to 30 minutes); then `/healthz` is checked for 20 s, and a failure
rolls back to the commit before. When adding a file or unit, check those regexes in `update.sh`.

`node tools/grafana.mjs push` overwrites the shared Grafana dashboards and alert rules by uid. Never run it from a
branch that is behind the other (`staging` is ahead of `main` while changes are tested, and a push from the one behind
puts old rules back), and only on the coordinator's say-so. `build` only rewrites `grafana/*.json`.

The work log, decisions and role rules live in the private world repo, `Cheffromspace/Everything-is-OK`
(`NEXT-SESSION.md`, `docs/decisions.md`, `docs/roles/`). Issues are filed there too, because this repo is public.

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
  Grafana Alloy, `deploy/alloy/*.alloy`), and `backup.js` (daily timer: redacted events, the deploy record and a
  `metrics.db` snapshot to a private S3 bucket; claude/backup.md). Dashboard and alert rules are generated in code by `tools/grafana.mjs`;
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
