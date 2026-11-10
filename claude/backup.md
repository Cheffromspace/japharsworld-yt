# Daily backup to S3 (Everything-is-OK#585)

Grafana Cloud's free tier keeps metrics and logs for 14 days, the per-play events live only in the journal (which
rotates), and the Linode was wiped once (10-26). `metrics/backup.js` copies what is needed for analysis over time to a
private S3 bucket once a day. Owner, 2026-11-06: "s3 is perfect".

## What lands, and where

`japharsworld-yt-backup.timer` runs at 01:30 America/Chicago (the reporting day has just ended), as `jyt`. For every
reporting day not yet backed up (yesterday; after missed nights up to `BACKUP_MAX_DAYS`, default 3, oldest first) it PUTs

| Object | What |
|---|---|
| `eiok/<yyyy>/<mm>/<dd>/events.jsonl.gz` | the search service's log events of that Chicago day, one JSON object per line, redacted (below) |
| `eiok/<yyyy>/<mm>/<dd>/grafana.json.gz` | hourly `avg` and `max` of the Grafana-only series (`PROM_SERIES`: host CPU, load, memory, disk, network, failed units for both hosts; public probes; search up, relay workers, service memory, home today). Only with `BACKUP_PROM_TOKEN` |
| `eiok/<yyyy>/<mm>/<dd>/metrics.db.gz` | a consistent snapshot of `metrics.db` (`VACUUM INTO` from a read-only connection; the DB is in WAL mode), newest day of a run only |
| `eiok/<yyyy>/<mm>/<dd>/tickets.db.gz` | the same for `tickets.db`, only with `BACKUP_TICKETS=on` (off: see Privacy) |
| `eiok/<yyyy>/<mm>/<dd>/manifest.json` | written last: the day's window in UTC, each file's size and sha256, event counts (lines, events, IP/secret replacements), notes (skipped parts) |

A day with a manifest is complete. `metrics.db` keeps every daily counter forever, so the latest snapshot holds all of
history; older snapshots are only for going back. Poller rows older than 90 days are pruned in the live DB
(`recordPoll keepDays`), so the snapshots are where they survive.

The 1-day step caveat in metrics.md applies to the Grafana summary: counters there are per-hour `avg/max` of rates, and
a counter reset (10-26) shows as a dip, not a negative.

## Privacy

- Events pass `redact()` from `src/ops.js`, the same field allowlist as `/ops/events`: no video IDs, ticket numbers,
  shards or User-Agents; ID-shaped tokens and URL query strings inside messages are masked. Then `scrub()` replaces
  anything shaped like an IPv4/IPv6 address or a token (`key=`, `token=`, `Bearer …`, 32+ character runs) and counts
  it in the manifest. 24 h of prod events (14,252, 2026-11-06) held no IP or token before either step.
- `tickets.db` holds search results (video IDs, titles); `public/privacy.html` keeps those "for up to a day", so it is
  not backed up unless the owner decides otherwise and the page says so (`BACKUP_TICKETS=on`). Owner card: world #591.
- `metrics.db` holds counts only (claude/metrics.md).
- `public/privacy.html` says a daily backup goes to the owner's private, encrypted S3 storage.

## AWS setup (owner's go, world #591)

- Bucket `eiok-backup-<random>`, us-east-1: SSE-S3 default encryption; all four public-access blocks; object ownership
  "bucket owner enforced" (ACLs off); a bucket policy denying requests without TLS (`aws:SecureTransport`); versioning on.
- Lifecycle: `eiok/` to Glacier Instant Retrieval after 90 days; noncurrent versions expire after 30 days; incomplete
  multipart uploads abort after 7 days.
- IAM user `eiok-backup-writer`, one inline policy: `s3:PutObject` on `arn:aws:s3:::<bucket>/eiok/*` with
  `s3:x-amz-server-side-encryption = AES256`. No list, read or delete: a leaked key can add objects, and versioning keeps
  what it overwrites for 30 days. The job therefore keeps its own record of what landed
  (`/var/lib/japharsworld-yt/backup-state.json`).
- The access key is created by the owner in the IAM console and pasted into `/etc/japharsworld-yt-backup.env` (root,
  600; `deploy/backup-setup.sh` writes the empty file), so it never passes through a Claude session, the repo or a log.

## Running it

```sh
bash /opt/japharsworld-yt/deploy/backup-setup.sh            # units + env file; the timer stays as it was
bash /opt/japharsworld-yt/deploy/backup-setup.sh --enable   # start the daily timer (owner's go)
systemctl start japharsworld-yt-backup                      # one run now (what is due)
sudo -u jyt -g jyt sh -c 'set -a; . /etc/japharsworld-yt.env; . /etc/japharsworld-yt-backup.env; node /opt/japharsworld-yt/metrics/backup.js --day 2026-11-05'  # re-run one day (as root, to read the env files)
journalctl -u japharsworld-yt-backup                        # backup_day / backup_failed / backup_gap lines
```

Without a bucket and key the job logs `backup_off` and exits 0. Journald must still hold the day: re-runs further back
than its retention get a short `events.jsonl.gz`.

## Missing-backup check

- A failed run posts to Discord (`DISCORD_WEBHOOK`, `backup_failed`) and retries the day at the next run.
- The exporter reports `eiok_backup_last_success_timestamp_seconds` from the state file (absent until the first
  backup), and the Grafana rule `eiok-backup-missing` fires when no day has landed for 30 hours.

## Restore / load into a notebook

Download with an identity that can read the bucket (the owner's; the writer key cannot), e.g.
`aws s3 cp --recursive s3://<bucket>/eiok/2026/11/ ./eiok-2026-11/`. Objects past 90 days are in Glacier Instant
Retrieval: same command, a per-GB retrieval fee.

```python
import gzip, json, sqlite3, shutil, pandas as pd

# metrics.db: the newest snapshot holds all daily counters
with gzip.open('eiok-2026-11/05/metrics.db.gz') as src, open('metrics.db', 'wb') as dst: shutil.copyfileobj(src, dst)
db = sqlite3.connect('metrics.db')
assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
daily = pd.read_sql('SELECT day, metric, key, value FROM daily', db)

# events: one JSON object per line
events = pd.DataFrame(json.loads(l) for l in gzip.open('eiok-2026-11/05/events.jsonl.gz', 'rt'))
plays = events[events.event == 'play']

# Grafana-only series: {series: {name: {avg|max: [{labels, values: [[unix, value], …]}]}}}
g = json.load(gzip.open('eiok-2026-11/05/grafana.json.gz', 'rt'))
```

To put `metrics.db` back on a rebuilt Linode: stop the search service, the poller and the exporter, `gunzip` the
newest snapshot to `/var/lib/japharsworld-yt/metrics.db` (owner `jyt`), remove any `-wal`/`-shm` next to it, start them.
