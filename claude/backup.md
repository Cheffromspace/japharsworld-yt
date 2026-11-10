# Daily backup to S3 (Everything-is-OK#585)

Grafana Cloud's free tier keeps metrics and logs for 14 days, the per-play events live only in the journal (which
rotates), and the Linode was wiped once (10-26). `metrics/backup.js` copies what is needed for analysis over time to a
private S3 bucket once a day. Owner, 2026-11-06: "s3 is perfect"; the goal (#591): "service metrics, deploys, VRC
trends; compare releases to usage, errors".

## What lands, and where

`japharsworld-yt-backup.timer` runs at 01:30 America/Chicago (the reporting day has just ended), as `jyt`. For every
reporting day not yet backed up (yesterday; after missed nights up to `BACKUP_MAX_DAYS`, default 3, oldest first) it PUTs

| Object | What |
|---|---|
| `eiok/<yyyy>/<mm>/<dd>/events.jsonl.gz` | that Chicago day's log events of the search service and the metrics poller (`BACKUP_UNITS`), one JSON object per line, redacted (below): plays, routes, builds and their failures, Tunelio links, home sessions, captions, video reports, poller passes and their errors |
| `eiok/<yyyy>/<mm>/<dd>/deploys.log` | the Linode's deploy record, `<unix seconds> <short commit> <outcome>` per line, its last 200 (`deploy/deploy-record.sh`; the Optiplex keeps its own, not backed up) |
| `eiok/<yyyy>/<mm>/<dd>/metrics.db.gz` | a consistent snapshot of `metrics.db` (`VACUUM INTO` from a read-only connection; the DB is in WAL mode), with the newest day of a nightly run only |
| `eiok/<yyyy>/<mm>/<dd>/grafana.json.gz` | hourly `avg`/`max` of the Grafana-only series (`PROM_SERIES`: host CPU, memory, disk, network, failed units, probes, service memory). **Off**: needs `BACKUP_PROM_TOKEN` (owner, #591: skipped for now) |
| `eiok/<yyyy>/<mm>/<dd>/tickets.db.gz` | **off** (`BACKUP_TICKETS`; see Privacy) |
| `eiok/<yyyy>/<mm>/<dd>/manifest.json` | written last: the day's window in UTC, each file's size and sha256, event counts (lines, events, IP/secret/ID replacements), notes (skipped parts, a journal that starts late) |

A day with a manifest is complete. `metrics.db` holds `daily` and `hourly` counters, `gauges`, `poll_daily`
(min/max/last per day) and `releases` with no expiry, and `polls` (every poller reading) for 90 days only
(`recordPoll keepDays`). So the newest snapshot holds all counters and releases, and the daily snapshots are what keep
the raw poller rows past 90 days.

A day with no events at all is a failure, not an empty backup (the service logs thousands a day: 14,252 on 11-05): the
journal could not be read or no longer holds it.

## Privacy (owner's defaults, #591)

- Events pass `redact()` from `src/ops.js`, the same field allowlist as `/ops/events`: no video IDs, ticket numbers,
  shards or User-Agents; ID-shaped tokens and URL query strings inside messages are masked. Then `scrub()` replaces
  anything shaped like an IPv4/IPv6 address, a token (`key=…`, `token: …`, `"password":"…"`, `Bearer …`, 32+ character
  runs, AWS key IDs) or a video ID glued to `_`/`-`, and counts what it replaced in the manifest. Error codes such as
  `ERR_STREAM_PREMATURE_CLOSE` or `AccessDenied` stay readable. 24 h of prod events (14,252, 2026-11-06) held no IP or
  token before either step.
- `tickets.db` holds search results (video IDs, titles); `public/privacy.html` keeps those "for up to a day", so it is
  not backed up.
- `metrics.db` holds counts only (claude/metrics.md). `deploys.log` holds commits of this public repo.
- `public/privacy.html` says a daily backup goes to the owner's private, encrypted S3 storage.

## AWS setup

Done 2026-11-06 with the owner's go (#591), in the owner's account:
- Bucket `eiok-backup-<random>` (the name is in the Linode's env file, not here), us-east-1: SSE-S3 default
  encryption; all four public-access blocks; object ownership "bucket owner enforced" (ACLs off); a bucket policy
  denying requests without TLS (`aws:SecureTransport`); versioning on.
- Lifecycle: `eiok/` to Glacier Instant Retrieval after 90 days (objects under 128 KB stay in Standard, S3's default
  minimum); noncurrent versions expire after 30 days; incomplete multipart uploads abort after 7 days.

The owner's part (a Do card): IAM user `eiok-backup-writer` with one inline policy, `s3:PutObject` on
`arn:aws:s3:::<bucket>/eiok/*` with `s3:x-amz-server-side-encryption = AES256`. No list, read or delete: a leaked key can
add objects, and versioning keeps what it overwrites for 30 days. The job therefore keeps its own record of what landed
(`/var/lib/japharsworld-yt/backup-state.json`). The owner creates its access key and pastes it into
`/etc/japharsworld-yt-backup.env` (root, 600; `deploy/backup-setup.sh` writes the empty file), so the secret never
passes through a Claude session, the repo or a log. The key lives on prod only.

## Running it

```sh
bash /opt/japharsworld-yt/deploy/backup-setup.sh            # units + env file; the timer stays as it was
bash /opt/japharsworld-yt/deploy/backup-setup.sh --enable   # start the daily timer (owner's go)
bash /opt/japharsworld-yt/deploy/backup-setup.sh --disable  # stop it; sets the state file aside (no missing-backup alert)
systemctl start japharsworld-yt-backup                      # one run now (whatever is due)
journalctl -u japharsworld-yt-backup                        # backup_day / backup_failed / backup_gap lines
```

Re-run one ended day, with the same user, journal access and env files as the timer (as root):

```sh
systemd-run --wait --pipe -p User=jyt -p Group=jyt -p SupplementaryGroups=systemd-journal \
  -p EnvironmentFile=/etc/japharsworld-yt.env -p EnvironmentFile=/etc/japharsworld-yt-backup.env \
  /usr/bin/node /opt/japharsworld-yt/metrics/backup.js --day 2026-11-05
```

A `--day` re-run never uploads DB snapshots (they are taken now, not as of that day) and never moves the state back. It
refuses a day that hasn't ended, and a day whose journal starts more than 2 h late (rotated: it would overwrite a good
copy) unless `--force` is added.

Keyless test (staging; the key lives on prod only): `BACKUP_LOCAL_DIR=<folder>` writes the same objects under that folder
instead of S3, with its own state file there, and no Discord post. Add `-p Environment=BACKUP_LOCAL_DIR=/var/lib/japharsworld-yt/backup-test`
to the `systemd-run` line above (drop the backup env file), then check the folder as in *Restore* below.

Without a bucket and key or a local folder the job logs `backup_off` and exits 0.

## Missing-backup check

- A failed run (a day, or anything around it) posts to Discord (`DISCORD_WEBHOOK`, kind `backup_failed`) and the day is
  tried again at the next run.
- The exporter reports `eiok_backup_last_success_timestamp_seconds` from the state file (absent until the first
  backup), and the Grafana rule `eiok-backup-missing` fires when no day has landed for 30 hours.

## Restore / load into a notebook

Download with an identity that can read the bucket (the owner's; the writer key cannot), e.g.
`aws s3 cp --recursive s3://<bucket>/eiok/2026/11/ ./eiok-2026-11/`. Objects past 90 days are in Glacier Instant
Retrieval: same command, a per-GB retrieval fee.

```python
import gzip, json, sqlite3, shutil, pandas as pd

# metrics.db: the newest snapshot holds all counters and releases
with gzip.open('eiok-2026-11/05/metrics.db.gz') as src, open('metrics.db', 'wb') as dst: shutil.copyfileobj(src, dst)
db = sqlite3.connect('metrics.db')
assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
daily = pd.read_sql('SELECT day, metric, key, value FROM daily', db)

# events: one JSON object per line, across days
import glob
events = pd.DataFrame(json.loads(l) for f in sorted(glob.glob('eiok-2026-11/*/events.jsonl.gz')) for l in gzip.open(f, 'rt'))
events['at'] = pd.to_datetime(events['at'])

# deploys: the newest file holds the last 200
deploys = pd.read_csv('eiok-2026-11/05/deploys.log', sep=' ', names=['ts', 'commit', 'outcome'])
deploys['at'] = pd.to_datetime(deploys.ts, unit='s', utc=True)
```

To put `metrics.db` back on a rebuilt Linode: stop the search service, the poller and the exporter, `gunzip` the
newest snapshot to `/var/lib/japharsworld-yt/metrics.db` (owner `jyt`), remove any `-wal`/`-shm` next to it, start them.

## Lining up releases against usage and errors

Everything is keyed by time, so a release or deploy is a point on the same axis as the counters and the events.
Days are America/Chicago (`daily.day`, `hourly.hour`, the backup folders); `releases.at`, `deploys.log` and the events'
`at` are UTC: convert once.

- **Markers.** `releases` (`source` = `world:prod`, `world:test` or a GitHub repo; `version`; `at` = VRChat's upload
  time or the tag time, in ms) and `deploys.log` (service commits; `outcome` = `restarted`, `no_restart`, `rolled_back`).
- **Usage.** `daily`/`hourly` counters: `join` (arrivals), `search`, `play`, `play_platform` (PC/Quest; PC is low before
  the #586 deploy), `play_route`, `ticket_client`; the poller's `poll_daily` (`world:prod` visits, favorites,
  occupants). Normalize by `join` or occupants so a busy weekend doesn't look like a better release.
- **Errors.** Counters: `search_fail`, `play_fallback`, `ticket_timeout`, `ticket_too_long`, `ticket_daily_limit`,
  `cc_unavailable`, `yt_refusal`, `video_report` (testers' and visitors' problem reports, Resync presses, stall reloads).
  Events: `build_failed`, `play` with `via=youtube` and its `reason`, `home_*` failures, `captions_source_failed`,
  `relay_paused`, and the poller's `*_error` events.
- **Compare windows, not points.** For each release, take the same span before and after (7 days each, or the hours up
  to the next release), the rate per join or per play in each, and the change. Weekday mix matters: compare the same
  weekdays when the spans are short. Skip days a deploy rolled back, and mark days the owner tested heavily (the TEST
  world uses the same service).

```python
rel = pd.read_sql("SELECT source, version, at FROM releases WHERE source = 'world:prod' ORDER BY at", db)
rel['day'] = pd.to_datetime(rel['at'], unit='ms', utc=True).dt.tz_convert('America/Chicago').dt.strftime('%Y-%m-%d')
d = daily.pivot_table(index='day', columns='metric', values='value', aggfunc='sum').fillna(0)
d['fallback_per_play'] = d.get('play_fallback', 0) / d['play'].where(d['play'] > 0)
for _, r in rel.iterrows():
    before = d.loc[(d.index < r.day)].tail(7); after = d.loc[(d.index > r.day)].head(7)
    print(r.version, 'plays/join', (before.play.sum() / before.join.sum()).round(2), '→', (after.play.sum() / after.join.sum()).round(2),
          'fallbacks/play', before.fallback_per_play.mean().round(3), '→', after.fallback_per_play.mean().round(3))
```
