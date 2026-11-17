// Prometheus exporter for Grafana Cloud (claude/monitoring.md), run by japharsworld-yt-exporter.service.
//   GET http://127.0.0.1:9464/metrics   (loopback only; Grafana Alloy on this host scrapes it and ships it out)
//
// Reads what is already recorded at scrape time: the metrics database (read only), the link monitor's database
// (read only) and the search service's /healthz. Labels are metric keys, slot keys and verdicts that already passed
// the privacy checks in src/metrics.js; never video IDs, queries or addresses.
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { METRICS, MS_BUCKETS, S_BUCKETS, REPORT_WHO, REPORT_KINDS, OUTCOME_WHO, OUTCOME_PLATFORMS, OUTCOME_FRAME_SECONDS, dayOf } from '../src/metrics.js';
import { REFUSAL_CLASSES as FLASH_REFUSALS } from '../src/refusal.js';

// Daily bucket counters exported as Prometheus histograms (le in seconds), so histogram_quantile works.
// metric → [exported name, bucket bounds, bound units per second]
const HISTOGRAMS = {
  search_ms: ['eiok_search_seconds', MS_BUCKETS, 1000], tunelio_create_ms: ['eiok_tunelio_create_seconds', MS_BUCKETS, 1000],
  ticket_hold_ms: ['eiok_ticket_hold_seconds', MS_BUCKETS, 1000],
  build_s_progressive: ['eiok_build_progressive_seconds', S_BUCKETS, 1], build_s_hls: ['eiok_build_hls_seconds', S_BUCKETS, 1],
  home_start_s: ['eiok_home_start_seconds', S_BUCKETS, 1],
};

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const fmt = (v) => (v === Infinity ? '+Inf' : Number.isFinite(v) ? String(v) : 'NaN');

class Out {
  constructor() { this.families = new Map(); }
  add(name, type, help, labels, value) {
    if (value == null || Number.isNaN(Number(value))) return;
    const f = this.families.get(name) ?? { type, help, rows: [] };
    this.families.set(name, f);
    const l = Object.entries(labels ?? {}).filter(([, v]) => v != null).map(([k, v]) => `${k}="${esc(v)}"`).join(',');
    f.rows.push(`${name}${l ? `{${l}}` : ''} ${fmt(Number(value))}`);
  }
  text() {
    const out = [];
    for (const [name, f] of this.families) {
      const base = f.type === 'histogram' ? name.replace(/_bucket$|_count$/, '') : name;
      if (!out.includes(`# TYPE ${base} ${f.type}`)) out.push(`# HELP ${base} ${f.help}`, `# TYPE ${base} ${f.type}`);
      out.push(...f.rows);
    }
    return `${out.join('\n')}\n`;
  }
}

function openRo(path) {
  if (!path || !existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

// Usage counters: every day summed, so they only ever grow (use increase()/rate() in Grafana).
export function metricsDbSeries(db, o, now = Date.now()) {
  const totals = db.prepare("SELECT metric, key, SUM(value) v FROM daily GROUP BY metric, key").all();
  const hist = {};
  for (const r of totals) {
    if (HISTOGRAMS[r.metric]) { (hist[r.metric] ??= {})[r.key] = r.v; continue; }
    if (METRICS[r.metric]?.[0] !== 'daily' || r.metric === 'play_outcome') continue; // play_outcome has its own labelled series below
    o.add('eiok_events_total', 'counter', 'Usage counts from the search service, all days summed (claude/metrics.md).', { metric: r.metric, key: r.key }, r.v);
  }
  for (const [metric, [name, bounds, perSecond]] of Object.entries(HISTOGRAMS)) {
    const b = hist[metric] ?? {};
    let seen = 0;
    for (const le of [...bounds, Infinity]) {
      seen += b[le === Infinity ? 'inf' : String(le)] ?? 0;
      o.add(`${name}_bucket`, 'histogram', `${metric} from the daily buckets.`, { le: le === Infinity ? '+Inf' : String(le / perSecond) }, seen);
    }
    o.add(`${name}_count`, 'histogram', `${metric} from the daily buckets.`, {}, seen);
  }
  // From 0, so increase() sees the first one: no search has ever failed on prod (2026-10-31), so this series didn't
  // exist, and a counter that first appears at 1 shows no increase, which would hide the first 502s from eiok-search-502.
  if (!totals.some((r) => r.metric === 'search_fail' && r.key === '502')) {
    o.add('eiok_events_total', 'counter', 'Usage counts from the search service, all days summed (claude/metrics.md).', { metric: 'search_fail', key: '502' }, 0);
  }
  // The same for eiok-captions-empty: a result first seen on a new series would show no increase.
  for (const key of ['none', 'tracks']) {
    if (!totals.some((r) => r.metric === 'cc_outcome' && r.key === key)) {
      o.add('eiok_events_total', 'counter', 'Usage counts from the search service, all days summed (claude/metrics.md).', { metric: 'cc_outcome', key }, 0);
    }
  }
  // And for eiok-captions-failing: neither of these had ever counted by 2026-10-31.
  for (const key of ['temporarily_unavailable', 'failed']) {
    if (!totals.some((r) => r.metric === 'cc_unavailable' && r.key === key)) {
      o.add('eiok_events_total', 'counter', 'Usage counts from the search service, all days summed (claude/metrics.md).', { metric: 'cc_unavailable', key }, 0);
    }
  }
  // Unhandled promise rejections the service survived (src/server.js catchRejections), from 0 for the same reason. No
  // alert rule reads it yet.
  if (!totals.some((r) => r.metric === 'unhandled_rejection')) {
    o.add('eiok_events_total', 'counter', 'Usage counts from the search service, all days summed (claude/metrics.md).', { metric: 'unhandled_rejection', key: '' }, 0);
  }
  // The world's video reports (world #353), by who and kind, every pair from 0 so increase() sees the first report.
  const reports = Object.fromEntries(totals.filter((r) => r.metric === 'video_report').map((r) => [r.key, r.v]));
  for (const who of REPORT_WHO) for (const kind of REPORT_KINDS) {
    o.add('eiok_video_report_total', 'counter', 'Video reports from the world (Tester tab problems, Resync presses), all days summed.', { who, kind }, reports[`${who}:${kind}`] ?? 0);
  }
  // The speed probe's paced read of its own link (src/probe.js, Everything-is-OK#361), from 0 so increase() sees the first.
  const drop = Object.fromEntries(totals.filter((r) => r.metric === 'tunelio_drop').map((r) => [r.key, r.v]));
  o.add('eiok_tunelio_probe_read_minutes_total', 'counter', 'Minutes the probe read a Tunelio link at playback speed, all days summed.', {}, drop.minutes ?? 0);
  o.add('eiok_tunelio_probe_cuts_total', 'counter', 'Connections cut during that read, all days summed.', {}, drop.cut ?? 0);
  o.add('eiok_tunelio_probe_reopen_fail_total', 'counter', 'Reopens at the byte reached that failed (status, wrong offset, or no first byte in 10 s), all days summed.', {}, drop.reopen_fail ?? 0);
  o.add('eiok_tunelio_probe_open_fail_total', 'counter', 'Reads that never started: all three first opens failed the same way, all days summed.', {}, drop.open_fail ?? 0);
  // Play outcomes (world #274): labelled counts, only those seen (448 possible; a count's very first play doesn't show in
  // increase()), and a first-frame histogram per who and platform, from 0.
  const outcomes = totals.filter((r) => r.metric === 'play_outcome' && r.key !== 'other').map((r) => [...r.key.split(':'), r.v]);
  for (const [who, platform, plan, outcome, v] of outcomes) {
    o.add('eiok_play_outcome_total', 'counter', 'Play outcomes from the world, all days summed: first frame within f<n> seconds, or how it failed.', { who, platform, plan, outcome }, v);
  }
  for (const who of OUTCOME_WHO) for (const platform of OUTCOME_PLATFORMS) {
    const frames = (name) => outcomes.filter((x) => x[0] === who && x[1] === platform && x[3] === name).reduce((sum, x) => sum + x[4], 0);
    const help = 'Seconds from a video starting to load to its first frame, from the world (world #274).';
    let seen = 0;
    for (const s of OUTCOME_FRAME_SECONDS) {
      seen += frames(`f${s}`);
      o.add('eiok_play_first_frame_seconds_bucket', 'histogram', help, { who, platform, le: String(s) }, seen);
    }
    seen += frames('fmax');
    o.add('eiok_play_first_frame_seconds_bucket', 'histogram', help, { who, platform, le: '+Inf' }, seen);
    o.add('eiok_play_first_frame_seconds_count', 'histogram', help, { who, platform }, seen);
  }
  const credits = db.prepare("SELECT value, at FROM gauges WHERE metric = 'credits_remaining' ORDER BY day DESC, at DESC LIMIT 1").get();
  if (credits) o.add('eiok_credits_remaining', 'gauge', 'Tunelio credits left (search service, last seen).', {}, credits.value);
  for (const r of db.prepare(`SELECT key, value FROM gauges WHERE metric = 'home_today'
      AND day = (SELECT MAX(day) FROM gauges WHERE metric = 'home_today')`).all()) {
    o.add('eiok_home_today', 'gauge', 'Home relay today (mb, builds, cap_mb) and media workers connected, set every minute.', { key: r.key }, r.value);
  }
  // Bytes each host sent today and this month (Chicago days, like every daily row), for the transfer alerts: Grafana
  // Cloud keeps 14 days, too little for a month-to-date increase() (src/net.js).
  const today = dayOf(now);
  for (const host of ['linode', 'home']) {
    const sum = (where, arg) => db.prepare(`SELECT COALESCE(SUM(value), 0) v FROM daily WHERE metric = 'transfer' AND key = ? AND ${where}`).get(host, arg).v;
    o.add('eiok_transfer_bytes', 'gauge', 'Bytes sent by the host (linode, home) today and this month, from metrics.db.', { host, period: 'today' }, sum('day = ?', today) * 1e6);
    o.add('eiok_transfer_bytes', 'gauge', 'Bytes sent by the host (linode, home) today and this month, from metrics.db.', { host, period: 'month' }, sum('day LIKE ?', `${today.slice(0, 7)}-%`) * 1e6);
  }
  // Rooms: one row per (hour, shard) that saw a request, so increase() over an hour = the shards active in it.
  for (const r of db.prepare("SELECT key, COUNT(*) n FROM hourly WHERE metric = 'shard' GROUP BY key").all()) {
    o.add('eiok_shard_active_hours_total', 'counter', 'Hours each shard (room) saw a request, all days summed.', { shard: r.key }, r.n);
  }
  // Latest poll per source and metric: VRChat worlds (prod/test), group, Tunelio, GitHub.
  const polls = db.prepare(`SELECT p.source, p.metric, p.value, p.ts FROM polls p
    JOIN (SELECT source, metric, MAX(ts) ts FROM polls GROUP BY source, metric) m USING (source, metric, ts)`).all();
  const lastPoll = {};
  for (const p of polls) {
    o.add('eiok_poll', 'gauge', 'Latest value the metrics poller recorded (VRChat, group, Tunelio, GitHub, domain expiry in epoch seconds).', { source: p.source, metric: p.metric }, p.value);
    lastPoll[p.source] = Math.max(lastPoll[p.source] ?? 0, p.ts);
  }
  for (const [source, ts] of Object.entries(lastPoll)) o.add('eiok_poll_timestamp_seconds', 'gauge', 'When the poller last recorded this source.', { source }, ts / 1000);
  // One series per release, value = when: the dashboard marks each one at that time, including uploads from before
  // the exporter existed (the latest 50 are enough).
  for (const r of db.prepare('SELECT source, version, at FROM releases ORDER BY at DESC LIMIT 50').all()) {
    o.add('eiok_release_timestamp_seconds', 'gauge', 'Releases seen (world uploads, GitHub tags), the latest 50; value = when.', { source: r.source, version: r.version }, r.at / 1000);
  }
}

// Channels link monitor (monitor/slotmon): per slot, the flash checks, the job queue and the workers.
export function monitorDbSeries(db, o, now = Date.now()) {
  const slots = db.prepare(`SELECT s.key, s.kind, s.category, s.auto_hidden, s.auto_reason, s.baked_hidden,
      st.height, st.flash_verdict, st.flash_max, st.flash_at, st.last_status, st.last_seen
    FROM slots s LEFT JOIN streams st ON st.video_id = COALESCE(s.current_video, s.baked_video)
    WHERE s.idx IS NOT NULL AND s.kind IN ('live', 'video') ORDER BY s.idx`).all();
  for (const s of slots) {
    const l = { slot: s.key, kind: s.kind, category: s.category ?? '' };
    o.add('eiok_slot_hidden', 'gauge', '1 when the monitor hid the slot (down, flash fail, waiting for a check).', { ...l, reason: s.auto_hidden ? (s.auto_reason ?? 'hidden').split(':')[0].slice(0, 40) : '' }, s.auto_hidden ? 1 : 0);
    o.add('eiok_slot_spare', 'gauge', '1 for a slot the world does not show: a baked spare or hidden in overrides.json (shown spares are 0).', l, s.baked_hidden ? 1 : 0);
    o.add('eiok_slot_up', 'gauge', '1 when the slot\'s stream was live (or the video available) at the last check.', l,
      s.last_status == null ? null : (s.last_status === 'live' || (s.kind === 'video' && s.last_status === 'video')) ? 1 : 0);
    o.add('eiok_slot_height', 'gauge', 'Vertical resolution of the slot\'s current stream at its last probe.', l, s.height);
    o.add('eiok_slot_flash_max', 'gauge', 'Most flashes in any 1 s at the last flash check (fails above 3).', l, s.flash_max);
    o.add('eiok_slot_flash_pass', 'gauge', '1 = the last flash check passed, 0 = failed.', l, s.flash_verdict == null ? null : s.flash_verdict === 'pass' ? 1 : 0);
    o.add('eiok_slot_flash_timestamp_seconds', 'gauge', 'When the slot\'s current stream was last flash-checked.', l, s.flash_at);
  }
  // YouTube refusals the flash worker met (owner, 2026-10-26: monitor/slotmon/probe.py refusal_class), as the search
  // service's yt_refusal <where>:<class> with where = flash, so the dashboard and eiok-flash-refusals see them. Only
  // the class leaves the monitor DB; anything else in detail is dropped.
  // Every class from 0, so the series exist before the first refusal and the rule has data to evaluate.
  const refused = Object.fromEntries(db.prepare("SELECT detail, COUNT(*) n FROM events WHERE kind = 'yt_refusal' GROUP BY detail").all().map((r) => [r.detail, r.n]));
  for (const cls of FLASH_REFUSALS) {
    o.add('eiok_events_total', 'counter', 'Usage counts from the search service, all days summed (claude/metrics.md).', { metric: 'yt_refusal', key: `flash:${cls}` }, refused[cls] ?? 0);
  }
  for (const r of db.prepare('SELECT verdict, COUNT(*) n FROM flash GROUP BY verdict').all()) {
    o.add('eiok_flash_checks_total', 'counter', 'Flash checks run, by verdict.', { verdict: r.verdict ?? 'none' }, r.n);
  }
  const q = db.prepare('SELECT COUNT(*) n, MIN(created) oldest FROM jobs WHERE done IS NULL').get();
  o.add('eiok_jobs_pending', 'gauge', 'Resolution + flash jobs waiting for a worker.', {}, q.n);
  // By reason (owner, 2026-10-25): the 14:00 UTC daily batch (~60 jobs) takes ~3.5 h at 6 jobs a run, so it alerts
  // later than new/candidate/manual checks.
  const ages = db.prepare(`SELECT CASE WHEN reason = 'daily' THEN 'daily' ELSE 'other' END reason, MIN(created) oldest
    FROM jobs WHERE done IS NULL GROUP BY 1`).all();
  for (const reason of ['daily', 'other']) {
    const oldest = ages.find((a) => a.reason === reason)?.oldest;
    o.add('eiok_jobs_oldest_pending_seconds', 'gauge', 'Age of the oldest waiting job, daily batch or other (0 when none).', { reason }, oldest ? Math.max(0, now / 1000 - oldest) : 0);
  }
  for (const r of db.prepare('SELECT runner, MAX(done) done FROM jobs WHERE done IS NOT NULL AND runner IS NOT NULL GROUP BY runner').all()) {
    o.add('eiok_worker_last_done_timestamp_seconds', 'gauge', 'When each worker (optiplex, pc, linode) last finished a job.', { runner: r.runner }, r.done);
  }
  const last = db.prepare("SELECT MAX(ts) ts FROM checks WHERE source IS NULL OR source NOT LIKE 'seed%'").get();
  o.add('eiok_monitor_last_check_timestamp_seconds', 'gauge', 'When the monitor last checked a slot.', {}, last?.ts);
  const quota = db.prepare('SELECT day, SUM(units) u FROM quota GROUP BY day ORDER BY day DESC LIMIT 1').get();
  if (quota) o.add('eiok_youtube_quota_units', 'gauge', 'YouTube Data API units used on the latest Pacific day (alerts past 8,000).', { day: quota.day }, quota.u);
}

// Live state from the search service itself.
export function healthSeries(h, o) {
  o.add('eiok_search_up', 'gauge', '1 when the search service answered /healthz.', {}, h?.ok ? 1 : 0);
  if (!h?.ok) return;
  o.add('eiok_relay_workers_online', 'gauge', 'Search relay workers (the Optiplex) long-polling right now.', {}, h.workers);
  o.add('eiok_tunelio_enabled', 'gauge', '1 when Tunelio playback is on.', {}, h.tunelio ? 1 : 0);
  o.add('eiok_youtube_api_units_today', 'gauge', 'YouTube Data API units the search service used today.', {}, h.apiUnitsToday);
}

// The daily S3 backup's own record (metrics/backup.js, Everything-is-OK#585): when a day last landed. Left out until the
// first backup, so Grafana's eiok-backup-missing stays quiet where backups are off.
export function backupSeries(path, o) {
  let s;
  try { s = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
  if (!Number.isFinite(s?.lastSuccessMs)) return;
  o.add('eiok_backup_last_success_timestamp_seconds', 'gauge', 'When the daily S3 backup last uploaded a day (metrics/backup.js).', {}, Math.floor(s.lastSuccessMs / 1000));
}

// The cap the running service enforces, asked of the service itself, so it follows HOME_DAILY_BUILDS across an env edit
// and restart with no change here and no restart of the service to start reporting it (the env file as the exporter
// loaded it would go stale: an edit restarts only the search service). Only this number leaves the answer.
export function homeCapSeries(state, o) {
  o.add('eiok_home_today', 'gauge', 'Home relay today (mb, builds, cap_mb) and media workers connected, set every minute.', { key: 'cap_builds' }, state?.home?.cap?.builds);
}

// The search service's own memory from its cgroup. memory.current is no use for pressure: it is mostly page cache,
// which the kernel reclaims at the limit (2026-10-31: 296 MB current, 175 MB of it file; anon 107 + swap 150 = 257 MB;
// 160,904 "max" events and no OOM kill). memory.max is read live, so it follows MemoryMax and `systemctl set-property`.
// A cgroup that is missing (service restarting) or has no limit ("max") leaves its series out.
export function serviceMemorySeries(dir, o) {
  const read = (file) => { try { return readFileSync(join(dir, file), 'utf8'); } catch { return ''; } };
  const help = 'Search service memory that cannot be dropped: anon in RAM and swapped out (its cgroup, bytes).';
  o.add('eiok_service_memory_bytes', 'gauge', help, { kind: 'anon' }, read('memory.stat').match(/^anon (\d+)$/m)?.[1]);
  o.add('eiok_service_memory_bytes', 'gauge', help, { kind: 'swap' }, read('memory.swap.current').match(/^\d+/)?.[0]);
  o.add('eiok_service_memory_limit_bytes', 'gauge', 'The search service\'s memory.max (MemoryMax), bytes.', {}, read('memory.max').match(/^\d+/)?.[0]);
}

export async function render({ metricsDb, monitorDb, healthUrl, opsUrl, statsToken, cgroupDir, backupState, now = Date.now(), fetchImpl = fetch }) {
  const o = new Out();
  for (const [name, path, fn] of [['metrics', metricsDb, metricsDbSeries], ['monitor', monitorDb, monitorDbSeries]]) {
    let db, ok = false;
    try {
      db = openRo(path);
      if (db) { fn(db, o, now); ok = true; }
    } catch (err) {
      console.error(JSON.stringify({ event: 'exporter_db_failed', db: name, message: String(err?.message ?? err).slice(0, 200) }));
    } finally { db?.close(); }
    o.add('eiok_exporter_db_ok', 'gauge', '1 when the exporter could read this database.', { db: name }, ok ? 1 : 0);
  }
  let health = null;
  if (healthUrl) {
    try { const r = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(3000) }); health = r.ok ? await r.json() : null; } catch { health = null; }
  }
  healthSeries(health, o);
  if (backupState) backupSeries(backupState, o);
  if (health?.ok && opsUrl && statsToken) {
    try {
      const r = await fetchImpl(opsUrl, { headers: { authorization: `Bearer ${statsToken}` }, signal: AbortSignal.timeout(3000) });
      if (r.ok) homeCapSeries(await r.json(), o);
    } catch { /* left out; eiok-alert-inputs-missing fires if it stays out */ }
  }
  if (cgroupDir) serviceMemorySeries(cgroupDir, o);
  return o.text();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const e = process.env;
  const port = Number.parseInt(e.EXPORTER_PORT ?? '9464', 10);
  const opts = {
    metricsDb: e.METRICS_DB ?? '/var/lib/japharsworld-yt/metrics.db',
    monitorDb: e.MONITOR_DB ?? '/var/lib/japharsworld-yt-monitor/monitor.db',
    healthUrl: `http://127.0.0.1:${e.PORT ?? 8790}/healthz`,
    backupState: e.BACKUP_STATE ?? '/var/lib/japharsworld-yt/backup-state.json',
    opsUrl: `http://127.0.0.1:${e.PORT ?? 8790}/ops/state`,
    statsToken: e.STATS_TOKEN ?? '',
    cgroupDir: '/sys/fs/cgroup/system.slice/japharsworld-yt.service',
  };
  http.createServer(async (req, res) => {
    if (req.url !== '/metrics') { res.writeHead(404).end(); return; }
    try {
      const body = await render(opts);
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(body);
    } catch (err) {
      res.writeHead(500).end(String(err?.message ?? err));
    }
  }).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'exporter_listening', port })));
}
